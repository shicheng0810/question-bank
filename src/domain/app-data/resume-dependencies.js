import {validateSnapshotBaselineShape, assertSnapshotContinuationState, snapshotContinuationProofKey} from './snapshot-continuation.js';
import { isUuid } from "../question/index.js";
import {
  AppDataValidationError,
  canonicalBytes,
  canonicalContentBytes,
  sha256Hex
} from "./canonical.js";
import { APP_DATA_CONTENT_LIMITS } from "./constants.js";
import {
  validateAnswerEvent,
  validateAttemptScope,
  validateResumeDraft
} from "./core-records.js";
import { validateChunkManifest, validateResumeReference } from "./content-records.js";

const DIGEST_RE = /^[0-9a-f]{64}$/;
const MAX_DEPENDENCY_BUNDLES = 32;
const MAX_ANCESTOR_EDGES = 32;

/** @typedef {import("./contracts").ResumeState} ResumeState */
/** @typedef {import("./contracts").ResumeReference} ResumeReference */
/** @typedef {import("./contracts").ChunkManifest} ChunkManifest */
/** @typedef {import("./contracts").AnswerEventRecord} AnswerEventRecord */
/** @typedef {import("./contracts").ResumeAttemptBinding} ResumeAttemptBinding */
/** @typedef {{state: ResumeState, reference: ResumeReference, manifest: ChunkManifest|undefined, events: AnswerEventRecord[], expectedAttempt: ResumeAttemptBinding, stateBytes: Uint8Array, scopeBytes: Uint8Array, referenceBytes: Uint8Array, manifestBytes: Uint8Array|undefined, expectedBytes: Uint8Array, eventsBytes: Uint8Array}} CapturedBundle */

/** @param {string} code @param {string} path @param {string} message @returns {never} */
function fail(code, path, message) {
  throw new AppDataValidationError(code, path, message);
}

/** @param {unknown} value @param {string} path @returns {Record<string, unknown>} */
function plainObject(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("type", path, "must be a plain object");
  if (Object.getPrototypeOf(value) !== Object.prototype) fail("prototype", path, "must use Object.prototype");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") fail("symbol", path, "symbol keys are not JSON");
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, "value")) fail("accessor", `${path}.${key}`, "accessors are not JSON");
    if (!descriptor.enumerable) fail("non_enumerable", `${path}.${key}`, "non-enumerable fields are not permitted");
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {Record<string, unknown>} value @param {readonly string[]} allowed @param {readonly string[]} required @param {string} path */
function exactFields(value, allowed, required, path) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail("unknown_field", `${path}.${key}`, "unknown field is not permitted");
  for (const key of required) if (!Object.hasOwn(value, key)) fail("required", `${path}.${key}`, "required field is missing");
}

/** @param {unknown} value @param {string} path @returns {string} */
function uuid(value, path) {
  if (!isUuid(value)) fail("uuid", path, "must be a canonical lowercase UUID");
  return /** @type {string} */ (value);
}
/** @param {unknown} value @param {string} path @returns {string} */
function digest(value, path) {
  if (typeof value !== "string" || !DIGEST_RE.test(value)) fail("digest", path, "must be a lowercase SHA-256 hex digest");
  return value;
}
/** @param {unknown} value @param {string} path @returns {number} */
function nonNegativeInteger(value, path) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail("range", path, "must be a non-negative safe integer");
  return /** @type {number} */ (value);
}
/** @param {unknown} value @param {string} path @param {number} max @returns {unknown[]} */
function boundedArray(value, path, max) {
  if (!Array.isArray(value)) fail("type", path, "must be an array");
  if (Object.getPrototypeOf(value) !== Array.prototype) fail("prototype", path, "array must use Array.prototype");
  if (value.length > max) fail("array_limit", path, "array exceeds the configured item limit");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) fail("array_hole", `${path}[${index}]`, "array holes/accessors are not permitted");
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) fail("array_property", path, "arrays may not have non-index properties");
  }
  return /** @type {unknown[]} */ (value);
}

/** @param {unknown} value @param {string} path @returns {import("./contracts").ResumeAttemptBinding} */
export function validateResumeAttemptBinding(value, path = "$") {
  const record = plainObject(value, path);
  exactFields(record, ["attemptId", "writerStreamId", "scopeDigest", "scopeCount", "parentAttemptId"], ["attemptId", "writerStreamId", "scopeDigest", "scopeCount"], path);
  const attemptId = uuid(record.attemptId, `${path}.attemptId`);
  uuid(record.writerStreamId, `${path}.writerStreamId`);
  digest(record.scopeDigest, `${path}.scopeDigest`);
  if (nonNegativeInteger(record.scopeCount, `${path}.scopeCount`) < 1) fail("range", `${path}.scopeCount`, "scopeCount must be positive");
  if (Object.hasOwn(record, "parentAttemptId")) {
    const parent = uuid(record.parentAttemptId, `${path}.parentAttemptId`);
    if (parent === attemptId) fail("invariant", `${path}.parentAttemptId`, "parentAttemptId cannot equal attemptId");
  }
  return /** @type {import("./contracts").ResumeAttemptBinding} */ (value);
}

/** @param {unknown} value @param {string} path @returns {import("./contracts").ResumeState} */
export function validateResumeState(value, path = "$") {
  const record = plainObject(value, path);
  exactFields(record, [...(record.schemaVersion === 2 ? ["snapshotBaseline"] : []), "schemaVersion", "attemptId", "writerStreamId", "localRevision", "baseRevision", "scopeDigest", "questionDrafts", "submittedEventIds", "position", "effectiveElapsedMs", "scope"], ["schemaVersion", "attemptId", "writerStreamId", "localRevision", "baseRevision", "scopeDigest", "questionDrafts", "submittedEventIds", "position", "effectiveElapsedMs", "scope"], path);
  if (record.schemaVersion !== 1 && record.schemaVersion !== 2) fail("version", `${path}.schemaVersion`, "unsupported resume schemaVersion");
  if (record.schemaVersion === 2) validateSnapshotBaselineShape(record.snapshotBaseline);
  const attemptId = uuid(record.attemptId, `${path}.attemptId`); uuid(record.writerStreamId, `${path}.writerStreamId`);
  if (nonNegativeInteger(record.localRevision, `${path}.localRevision`) < 1) fail("range", `${path}.localRevision`, "localRevision must be positive");
  nonNegativeInteger(record.baseRevision, `${path}.baseRevision`); digest(record.scopeDigest, `${path}.scopeDigest`);
  const scope = validateAttemptScope(boundedArray(record.scope, `${path}.scope`, APP_DATA_CONTENT_LIMITS.maxArrayItems), attemptId, /** @type {unknown[]} */ (record.scope).length);
  const drafts = boundedArray(record.questionDrafts, `${path}.questionDrafts`, APP_DATA_CONTENT_LIMITS.maxArrayItems);
  const scopeRows = new Map(scope.map((/** @type {import("./contracts").AttemptScopeRecord} */ row) => [row.questionKey, row]));
  const draftKeys = new Set();
  for (let index = 0; index < drafts.length; index += 1) {
    const draft = validateResumeDraft(drafts[index], `${path}.questionDrafts[${index}]`);
    if (draftKeys.has(draft.questionKey)) fail("duplicate", `${path}.questionDrafts[${index}].questionKey`, "questionDrafts must be unique");
    draftKeys.add(draft.questionKey);
    if (draft.inheritedFrom?.attemptId === attemptId) fail("invariant", `${path}.questionDrafts[${index}].inheritedFrom.attemptId`, "inherited parent cannot equal current attempt");
    const row = scopeRows.get(draft.questionKey);
    if (!row) fail("invariant", `${path}.questionDrafts[${index}].questionKey`, "draft question is not in scope");
    if (row.questionRevision !== draft.questionRevision) fail("invariant", `${path}.questionDrafts[${index}].questionRevision`, "draft revision does not match scope");
  }
  const submitted = boundedArray(record.submittedEventIds, `${path}.submittedEventIds`, APP_DATA_CONTENT_LIMITS.maxArrayItems);
  const submittedIds = new Set();
  for (let index = 0; index < submitted.length; index += 1) {
    const eventId = uuid(submitted[index], `${path}.submittedEventIds[${index}]`);
    if (submittedIds.has(eventId)) fail("duplicate", `${path}.submittedEventIds[${index}]`, "submittedEventIds must be unique");
    submittedIds.add(eventId);
  }
  const position = nonNegativeInteger(record.position, `${path}.position`);
  if (position >= scope.length) fail("range", `${path}.position`, "position must be within scope");
  nonNegativeInteger(record.effectiveElapsedMs, `${path}.effectiveElapsedMs`);
  // ResumeState is the large-content record: ordinary DTO limits do not
  // apply, but the fixed qb-canonical-v1 content limits still do.
  canonicalContentBytes(record);
  return /** @type {import("./contracts").ResumeState} */ (value);
}

/** @param {unknown} value @param {string} path @returns {import("./contracts").ParentResumeDependency} */
export function validateParentResumeDependency(value, path = "$") {
  const record = plainObject(value, path);
  exactFields(record, ["state", "reference", "manifest", "events", "expectedAttempt"], ["state", "reference", "events", "expectedAttempt"], path);
  validateResumeState(record.state, `${path}.state`);
  validateResumeReference(record.reference, `${path}.reference`);
  if (record.manifest !== undefined) validateChunkManifest(record.manifest, `${path}.manifest`);
  const events = boundedArray(record.events, `${path}.events`, APP_DATA_CONTENT_LIMITS.maxArrayItems);
  const ids = new Set();
  for (let index = 0; index < events.length; index += 1) {
    const event = validateAnswerEvent(events[index], `${path}.events[${index}]`);
    if (ids.has(event.eventId)) fail("duplicate", `${path}.events[${index}].eventId`, "eventId must be unique");
    ids.add(event.eventId);
  }
  validateResumeAttemptBinding(record.expectedAttempt, `${path}.expectedAttempt`);
  return /** @type {import("./contracts").ParentResumeDependency} */ (value);
}

/**
 * Validate context bundle shapes. This is not a storage or authorization
 * proof; dependency hashing/relationships are performed only for bundles
 * reachable from the root resume payload.
 * @param {unknown} value @param {string} path @returns {import("./contracts").ResumeValidationContext}
 */
export function validateResumeValidationContext(value, path = "$") {
  const record = plainObject(value, path);
  exactFields(record, ["parents", "snapshotProofs"], ["parents"], path);
  const parents = boundedArray(record.parents, `${path}.parents`, MAX_DEPENDENCY_BUNDLES);
  for (let index = 0; index < parents.length; index += 1) validateParentResumeDependency(parents[index], `${path}.parents[${index}]`);
  return /** @type {import("./contracts").ResumeValidationContext} */ (value);
}

/** @param {unknown} value @param {string} path @param {{used:number}} budget @returns {{value: unknown, bytes: Uint8Array}} */
function captureValue(value, path, budget) {
  // canonicalContentBytes performs descriptor-first validation and never
  // executes getters.  Do not deep-copy the caller object before this bound
  // is known: decode only the bounded canonical bytes into our owned value.
  const bytes = canonicalContentBytes(value);
  budget.used += bytes.byteLength;
  if (budget.used > APP_DATA_CONTENT_LIMITS.maxCanonicalUtf8Bytes) fail("dependency_limit", path, "resume dependency snapshot exceeds 100 MiB");
  const owned = JSON.parse(new TextDecoder().decode(bytes));
  return { value: owned, bytes };
}

/** @param {unknown} state @param {unknown} reference @param {unknown} manifest @param {unknown} events @param {unknown} expectedAttempt @param {string} path @param {{used:number}} budget @returns {CapturedBundle} */
function captureBundleValues(state, reference, manifest, events, expectedAttempt, path, budget) {
  const stateCapture = captureValue(state, `${path}.state`, budget);
  const validState = validateResumeState(stateCapture.value, `${path}.state`);
  const referenceCapture = captureValue(reference, `${path}.reference`, budget);
  const validReference = validateResumeReference(referenceCapture.value, `${path}.reference`);
  let validManifest;
  let manifestBytes;
  if (manifest !== undefined) {
    const manifestCapture = captureValue(manifest, `${path}.manifest`, budget);
    validManifest = validateChunkManifest(manifestCapture.value, `${path}.manifest`);
    manifestBytes = manifestCapture.bytes;
  }
  const eventsCapture = captureValue(events, `${path}.events`, budget);
  const eventValues = boundedArray(eventsCapture.value, `${path}.events`, APP_DATA_CONTENT_LIMITS.maxArrayItems);
  const validEvents = [];
  const eventIds = new Set();
  for (let index = 0; index < eventValues.length; index += 1) {
    const event = validateAnswerEvent(eventValues[index], `${path}.events[${index}]`);
    if (eventIds.has(event.eventId)) fail("duplicate", `${path}.events[${index}].eventId`, "eventId must be unique");
    eventIds.add(event.eventId);
    validEvents.push(event);
  }
  const expectedCapture = captureValue(expectedAttempt, `${path}.expectedAttempt`, budget);
  const validExpected = validateResumeAttemptBinding(expectedCapture.value, `${path}.expectedAttempt`);
  return {
    state: validState,
    reference: validReference,
    manifest: validManifest,
    events: /** @type {AnswerEventRecord[]} */ (validEvents),
    expectedAttempt: validExpected,
    stateBytes: stateCapture.bytes,
    scopeBytes: canonicalContentBytes(validState.scope),
    referenceBytes: referenceCapture.bytes,
    manifestBytes,
    expectedBytes: expectedCapture.bytes,
    eventsBytes: eventsCapture.bytes
  };
}

/** @param {CapturedBundle} captured @param {ResumeAttemptBinding} expected @param {string} path */
function validateBundleRelationships(captured, expected, path) {
  if (captured.state.attemptId !== expected.attemptId) fail("attempt_id", `${path}.state.attemptId`, "resume state attempt does not match expected attempt");
  if (captured.state.writerStreamId !== expected.writerStreamId) fail("writer_stream_id", `${path}.state.writerStreamId`, "resume state writer does not match expected attempt");
  if (captured.state.scopeDigest !== expected.scopeDigest || captured.state.scope.length !== expected.scopeCount) fail("scope", path, "resume state scope binding does not match expected attempt");
  if (captured.reference.attemptId !== captured.state.attemptId || captured.reference.writerStreamId !== captured.state.writerStreamId || captured.reference.localRevision !== captured.state.localRevision || captured.reference.baseRevision !== captured.state.baseRevision) fail("reference", `${path}.reference`, "resume reference does not match state");
}

/** @param {CapturedBundle} captured @returns {Map<string, AnswerEventRecord>} */
function eventMap(captured) {
  return new Map(captured.events.map((/** @type {import("./contracts").AnswerEventRecord} */ event) => [event.eventId, event]));
}

/** @param {Uint8Array} left @param {Uint8Array} right @returns {boolean} */
function sameBytes(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

/** @param {CapturedBundle} captured @param {Set<string>} missing @param {string} path */
function validateEventRelations(captured, missing, path) {
  const scopeRows = new Map(captured.state.scope.map((/** @type {import("./contracts").AttemptScopeRecord} */ row) => [row.questionKey, row]));
  const events = eventMap(captured);
  const localMissing = new Set();
  const submitIndex = new Map();
  for (const id of captured.state.submittedEventIds) {
    const event = events.get(id);
    if (!event) { localMissing.add(`submit_event\u0000${id}`); continue; }
    if (event.kind !== "answer_submitted") fail("event_kind", `${path}.events`, "submittedEventIds may reference only submit events");
    if (event.attemptId !== captured.state.attemptId) fail("attempt_id", `${path}.events`, "submit event belongs to another attempt");
    const row = scopeRows.get(event.questionKey);
    if (!row || row.questionRevision !== event.questionRevision) fail("scope", `${path}.events`, "submit event is not for a scope question revision");
    const key = `${event.questionKey}\u0000${event.questionRevision}`;
    const values = submitIndex.get(key) ?? [];
    values.push(event);
    submitIndex.set(key, values);
  }
  for (const entry of localMissing) missing.add(entry);
  for (const [index, draft] of captured.state.questionDrafts.entries()) {
    if (!draft.submitted) continue;
    if (draft.inheritedFrom) continue;
    const matches = submitIndex.get(`${draft.questionKey}\u0000${draft.questionRevision}`) ?? [];
    if (matches.length === 0) {
      if (localMissing.size > 0) continue;
      fail("invariant", `${path}.state.questionDrafts[${index}]`, "submitted draft lacks a listed submit event");
    }
    const draftBytes = canonicalContentBytes(draft.input);
    const matchingEvents = matches.filter((/** @type {AnswerEventRecord} */ event) => event.kind === "answer_submitted" && sameBytes(canonicalContentBytes(event.answer), draftBytes));
    if (matchingEvents.length === 0) {
      if (localMissing.size > 0) continue;
      fail("invariant", `${path}.state.questionDrafts[${index}].input`, "submitted draft input differs from submit events");
    }
    if (!draft.assisted && matchingEvents.some((/** @type {AnswerEventRecord} */ event) => event.assisted)) fail("invariant", `${path}.state.questionDrafts[${index}].assisted`, "draft cannot downgrade assisted submit");
  }
}

/** @typedef {{bundle: CapturedBundle, attempts: Set<string>, maxDepth: number, drafts: Map<string, import("./contracts").ResumeDraft>}} BundleProof */

/** @param {CapturedBundle} captured @param {Set<string>} missing @param {Map<string, CapturedBundle>} bundles @param {Map<string, BundleProof>} memo @param {Set<string>} visiting @param {Set<string>} pathAttempts @param {number} depth @returns {Promise<BundleProof>} */
async function verifyBundle(captured, missing, bundles, memo, visiting, pathAttempts, depth) {
  const path = `$[${captured.reference.contentDigest}]`;
  const digestKey = captured.reference.contentDigest;
  if (depth > MAX_ANCESTOR_EDGES) fail("dependency_limit", path, "resume dependency graph exceeds 32 ancestor edges");
  const cached = memo.get(digestKey);
  if (cached) {
    for (const attempt of cached.attempts) if (pathAttempts.has(attempt)) fail("dependency_cycle", path, "resume dependency repeats an ancestor attempt");
    if (depth + cached.maxDepth > MAX_ANCESTOR_EDGES) fail("dependency_limit", path, "resume dependency graph exceeds 32 ancestor edges");
    return cached;
  }
  if (visiting.has(digestKey)) fail("dependency_cycle", path, "resume dependency contains a digest cycle");
  if (pathAttempts.has(captured.state.attemptId)) fail("dependency_cycle", path, "resume dependency repeats an ancestor attempt");
  visiting.add(digestKey);
  const nextPathAttempts = new Set(pathAttempts);
  nextPathAttempts.add(captured.state.attemptId);
  let maxDepth = 0;
  try {
    validateBundleRelationships(captured, captured.expectedAttempt, path);
    const scopeDigest = await sha256Hex(captured.scopeBytes);
    if (scopeDigest !== captured.state.scopeDigest) fail("digest", `${path}.state.scopeDigest`, "scopeDigest does not match scope bytes");
    const contentDigest = await sha256Hex(captured.stateBytes);
    if (contentDigest !== captured.reference.contentDigest) fail("digest", `${path}.reference.contentDigest`, "contentDigest does not match resume bytes");
    if (captured.manifest === undefined) missing.add(`manifest\u0000${captured.reference.chunkManifestDigest}`);
    else {
      const manifestDigest = await sha256Hex(/** @type {Uint8Array} */ (captured.manifestBytes));
      if (manifestDigest !== captured.reference.chunkManifestDigest) fail("digest", `${path}.reference.chunkManifestDigest`, "manifestDigest does not match manifest bytes");
      if (captured.manifest.contentDigest !== contentDigest || captured.manifest.totalBytes !== captured.stateBytes.byteLength || captured.manifest.chunkCount !== captured.manifest.chunks.length) fail("invariant", `${path}.manifest`, "manifest does not describe resume bytes");
      let offset = 0;
      for (let index = 0; index < captured.manifest.chunks.length; index += 1) {
        const chunk = captured.manifest.chunks[index];
        if (!chunk) fail("invariant", `${path}.manifest.chunks[${index}]`, "manifest chunk is missing");
        const bytes = captured.stateBytes.slice(offset, offset + chunk.byteLength);
        const chunkDigest = await sha256Hex(bytes);
        if (chunkDigest !== chunk.sha256) fail("digest", `${path}.manifest.chunks[${index}].sha256`, "chunk digest does not match resume bytes");
        offset += chunk.byteLength;
      }
      if (offset !== captured.stateBytes.byteLength) fail("invariant", `${path}.manifest.totalBytes`, "manifest chunks do not cover the complete resume bytes");
    }
    validateEventRelations(captured, missing, path);
    for (const draft of captured.state.questionDrafts) {
      if (!draft.inheritedFrom) continue;
      if (captured.expectedAttempt.parentAttemptId !== draft.inheritedFrom.attemptId) fail("invariant", `${path}.state.questionDrafts`, "inherited draft parent does not match expectedAttempt");
      const parentDigest = draft.inheritedFrom.resumeContentDigest;
      const parent = bundles.get(parentDigest);
      if (!parent) { missing.add(`parent_resume\u0000${parentDigest}`); continue; }
      if (parent.state.attemptId !== draft.inheritedFrom.attemptId) fail("attempt_id", `${path}.state.questionDrafts`, "inherited draft parent attempt does not match parent resume");
      const parentProof = await verifyBundle(parent, missing, bundles, memo, visiting, nextPathAttempts, depth + 1);
      if (1 + parentProof.maxDepth > maxDepth) maxDepth = 1 + parentProof.maxDepth;
      const parentDraft = parentProof.drafts.get(draft.questionKey);
      if (!parentDraft || parentDraft.questionRevision !== draft.questionRevision || !sameBytes(canonicalContentBytes(parentDraft.input), canonicalContentBytes(draft.input)) || parentDraft.submitted !== draft.submitted) fail("invariant", `${path}.state.questionDrafts`, "inherited draft differs from parent resume");
      if ((parentDraft.assisted && !draft.assisted) || (parentDraft.showKeys && !draft.showKeys)) fail("invariant", `${path}.state.questionDrafts`, "inherited draft downgrades parent assistance state");
    }
    const proofAttempts = new Set(/** @type {string[]} */ ([captured.state.attemptId]));
    for (const draft of captured.state.questionDrafts) {
      if (!draft.inheritedFrom) continue;
      const parent = bundles.get(draft.inheritedFrom.resumeContentDigest);
      const parentProof = parent ? memo.get(draft.inheritedFrom.resumeContentDigest) : undefined;
      if (parentProof) for (const attempt of parentProof.attempts) proofAttempts.add(attempt);
    }
    const draftIndex = new Map(captured.state.questionDrafts.map((/** @type {import("./contracts").ResumeDraft} */ draft) => [draft.questionKey, draft]));
    const proof = { bundle: captured, attempts: proofAttempts, maxDepth, drafts: draftIndex };
    memo.set(digestKey, proof);
    return proof;
  } finally {
    visiting.delete(digestKey);
  }
}

/**
 * Verify a complete resume payload and its optional parent snapshots.  The
 * result proves only payload/hash relationships; it does not prove storage,
 * account identity, generation, lease, or activation state.
 * @param {unknown} state
 * @param {unknown} reference
 * @param {unknown} manifest
 * @param {unknown} events
 * @param {unknown} expectedAttempt
 * @param {unknown} [context]
 * @returns {Promise<import("./contracts").ResumeValidationResult>}
 */
export async function validateResumeDependencies(state, reference, manifest, events, expectedAttempt, context = undefined) {
  const budget = { used: 0 };
  /** @type {unknown[]} */
  let parents = [];
  /** @type {unknown[]} */
  let snapshotProofs = [];
  if (context !== undefined) {
    const contextShape = plainObject(context, "$.context");
    snapshotProofs = boundedArray(contextShape.snapshotProofs ?? [], "$.context.snapshotProofs", 33);
    exactFields(contextShape, ["parents", "snapshotProofs"], ["parents"], "$.context");
    const parentDescriptor = Object.getOwnPropertyDescriptor(contextShape, "parents");
    if (!parentDescriptor || !Object.hasOwn(parentDescriptor, "value")) fail("accessor", "$.context.parents", "accessors are not JSON");
    if (!Array.isArray(parentDescriptor.value)) fail("type", "$.context.parents", "must be an array");
    if (parentDescriptor.value.length > MAX_DEPENDENCY_BUNDLES) fail("dependency_limit", "$.context.parents", "resume dependency graph accepts at most 32 parent bundles");
    parents = boundedArray(parentDescriptor.value, "$.context.parents", MAX_DEPENDENCY_BUNDLES);
  }
  const root = captureBundleValues(state, reference, manifest, events, expectedAttempt, "$.root", budget);
  const bundles = new Map();
  for (let index = 0; index < parents.length; index += 1) {
    const parentDescriptor = Object.getOwnPropertyDescriptor(parents, String(index));
    if (!parentDescriptor || !Object.hasOwn(parentDescriptor, "value")) fail("array_hole", `$.context.parents[${index}]`, "array holes/accessors are not permitted");
    const parentRecord = plainObject(parentDescriptor.value, `$.context.parents[${index}]`);
    exactFields(parentRecord, ["state", "reference", "manifest", "events", "expectedAttempt"], ["state", "reference", "events", "expectedAttempt"], `$.context.parents[${index}]`);
    const captured = captureBundleValues(parentRecord.state, parentRecord.reference, parentRecord.manifest, parentRecord.events, parentRecord.expectedAttempt, `$.context.parents[${index}]`, budget);
    const digestKey = captured.reference.contentDigest;
    if (bundles.has(digestKey)) fail("duplicate", `$.context.parents[${index}].reference.contentDigest`, "duplicate parent bundle contentDigest");
    bundles.set(digestKey, captured);
  }
  const missing = new Set();
  const memo = new Map();
  await verifyBundle(root, missing, bundles, memo, new Set(), new Set(), 0);
  for (const proof of memo.values()) {
    const state = proof.bundle.state; if (state.schemaVersion !== 2) continue;
    if (proof.bundle.expectedAttempt.parentAttemptId || state.localRevision === 1 && proof.bundle.events.length) fail("snapshot_native_parent", "$.snapshotBaseline", "snapshot continuation initialization must not have parents or events");
    const baselineProof = snapshotProofs.find(candidate => snapshotContinuationProofKey(candidate) === state.snapshotBaseline.continuationKey);
    if (!baselineProof) missing.add(`snapshot_baseline\u0000${state.snapshotBaseline.continuationKey}`);
    else assertSnapshotContinuationState(state, baselineProof);
  }
  if (missing.size > 0) {
    const values = [...missing].map((entry) => {
      const [kind, identifier] = entry.split("\u0000");
      return { kind, [kind === "submit_event" ? "eventId" : "digest"]: identifier };
    }).sort((left, right) => {
      const a = `${left.kind}:${left.eventId ?? left.digest}`;
      const b = `${right.kind}:${right.eventId ?? right.digest}`;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    return { status: "missing_dependency", missing: /** @type {import("./contracts").ResumeMissingDependency[]} */ (values) };
  }
  return { status: "payload_verified", state: /** @type {import("./contracts").ResumeState} */ (root.state) };
}

export const RESUME_DEPENDENCY_LIMITS = Object.freeze({ maxParentBundles: MAX_DEPENDENCY_BUNDLES, maxAncestorEdges: MAX_ANCESTOR_EDGES });
