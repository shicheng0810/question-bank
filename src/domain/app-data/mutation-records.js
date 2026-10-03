import { isQuestionKey, isUuid } from "../question/index.js";
import { AppDataValidationError, assertUtf8Within, canonicalBytes, sha256Hex, utf8ByteLength } from "./canonical.js";
import { APP_DATA_LIMITS, APP_DATA_PROTOCOL_VERSION } from "./constants.js";
import { validateBankRevisionRecord, validateContentReference } from "./content-records.js";
import { validateAnswerEvent as validateCoreAnswerEvent } from "./core-records.js";
import { validateHistorySnapshotPayload } from './history-snapshot-records.js';

const DIGEST_RE = /^[0-9a-f]{64}$/;
const KINDS = ["attempt_manifest", "attempt_scope", "answer_event", "resume_state", "user_state", "bank_revision", "content_manifest", "entity_tombstone", "history_snapshot"];
const POLLUTION_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/** @param {string} code @param {string} path @param {string} message @returns {never} */
function fail(code, path, message) { throw new AppDataValidationError(code, path, message); }
/** @param {unknown} value @param {string} path @returns {Record<string, any>} */
function object(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("type", path, "must be a plain object");
  if (Object.getPrototypeOf(value) !== Object.prototype) fail("prototype", path, "must use Object.prototype");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") fail("symbol", path, "symbol keys are not JSON");
    const name = /** @type {string} */ (key);
    if (POLLUTION_KEYS.has(name)) fail("prototype_pollution", `${path}.${name}`, "prototype-pollution key is forbidden");
    const descriptor = descriptors[name];
    if (!descriptor) fail("descriptor", `${path}.${name}`, "missing property descriptor");
    if (!("value" in descriptor)) fail("accessor", `${path}.${name}`, "accessors are not JSON");
    if (!descriptor.enumerable) fail("non_enumerable", `${path}.${name}`, "non-enumerable fields cannot be silently omitted");
  }
  return /** @type {Record<string, any>} */ (value);
}
/** @param {Record<string, unknown>} value @param {readonly string[]} allowed @param {readonly string[]} required @param {string} path */
function fields(value, allowed, required, path) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail("unknown_field", `${path}.${key}`, "unknown field is not permitted by the frozen contract");
  for (const key of required) if (!Object.hasOwn(value, key)) fail("required", `${path}.${key}`, "required field is missing");
}
/** @param {unknown} value @param {string} path @returns {number} */
function integer(value, path) { if (!Number.isSafeInteger(value)) fail("safe_integer", path, "must be a safe integer"); return /** @type {number} */ (value); }
/** @param {unknown} value @param {string} path @returns {boolean} */
function bool(value, path) { if (typeof value !== "boolean") fail("type", path, "must be a boolean"); return value; }
/** @param {unknown} value @param {string} path @returns {string} */
function uuid(value, path) { if (!isUuid(value)) fail("uuid", path, "must be a canonical lowercase UUID"); return /** @type {string} */ (value); }
/** @param {unknown} value @param {string} path @returns {string} */
function digest(value, path) { if (typeof value !== "string" || !DIGEST_RE.test(value)) fail("digest", path, "must be a lowercase SHA-256 hex digest"); return value; }
/** @param {unknown} value @param {string} path @returns {string} */
function text(value, path) { if (typeof value !== "string") fail("type", path, "must be a string"); if (utf8ByteLength(value) > APP_DATA_LIMITS.maxStringUtf8Bytes) fail("utf8_limit", path, "string exceeds the configured UTF-8 limit"); return value; }
/** @param {unknown} value @param {string} path @returns {string} */
function questionKey(value, path) { if (!isQuestionKey(value)) fail("question_key", path, "must be a bankUid/questionUid key"); return value; }
/** @param {unknown} value @param {string} path @returns {number} */
function timestamp(value, path) { return integer(value, path); }
/** @template T @param {(value: unknown) => T} validator @param {unknown} value @param {string} path @returns {T} */
function validateAt(validator, value, path) {
  try { return validator(value); } catch (error) {
    if (error instanceof AppDataValidationError) throw new AppDataValidationError(error.code, path + error.path.slice(1), error.message);
    throw error;
  }
}
/** @param {string} actual @param {string} expected */
function entityMatch(actual, expected) { if (actual !== expected) fail("entity_key", "$.entityKey", `must equal ${expected}`); }

/** @param {unknown} value */
export function validateMutation(value) {
  const record = object(value, "$");
  fields(record, ["protocolVersion", "mutationId", "clientStreamId", "clientSeq", "kind", "entityKey", "payload", "payloadDigest"], ["protocolVersion", "mutationId", "clientStreamId", "clientSeq", "kind", "entityKey", "payload", "payloadDigest"], "$");
  if (record.protocolVersion !== APP_DATA_PROTOCOL_VERSION) fail("version", "$.protocolVersion", `only protocol version ${APP_DATA_PROTOCOL_VERSION} is supported`);
  uuid(record.mutationId, "$.mutationId"); uuid(record.clientStreamId, "$.clientStreamId");
  if (integer(record.clientSeq, "$.clientSeq") < 1) fail("range", "$.clientSeq", "must be positive");
  const entityKey = text(record.entityKey, "$.entityKey"); if (!entityKey || utf8ByteLength(entityKey) > 512) fail("range", "$.entityKey", "must be 1..512 UTF-8 bytes");
  validateMutationPayload(record.kind, record.entityKey, record.payload); digest(record.payloadDigest, "$.payloadDigest");
  assertUtf8Within(new TextDecoder().decode(canonicalBytes(record)), APP_DATA_LIMITS.maxMutationUtf8Bytes, "mutation");
  return /** @type {import("./contracts").MutationEnvelope} */ (record);
}

/** @param {unknown} value */
export function validateMutationRecord(value) {
  const record = object(value, "$");
  fields(record, ["protocolVersion", "mutationId", "clientStreamId", "clientSeq", "kind", "entityKey", "payload", "payloadDigest", "createdAt", "accountGeneration"], ["protocolVersion", "mutationId", "clientStreamId", "clientSeq", "kind", "entityKey", "payload", "payloadDigest", "createdAt"], "$");
  validateMutation({ protocolVersion: record.protocolVersion, mutationId: record.mutationId, clientStreamId: record.clientStreamId, clientSeq: record.clientSeq, kind: record.kind, entityKey: record.entityKey, payload: record.payload, payloadDigest: record.payloadDigest });
  timestamp(record.createdAt, "$.createdAt");
  if (Object.hasOwn(record, "accountGeneration")) uuid(record.accountGeneration, "$.accountGeneration");
  canonicalBytes(record);
  return /** @type {import("./contracts").MutationRecord} */ (value);
}

/** @param {unknown} value */
export function validateConflictRecord(value) {
  const record = object(value, "$");
  fields(record, ["conflictId", "entityKey", "status", "mutation", "currentRevision"], ["conflictId", "entityKey", "status", "mutation"], "$");
  uuid(record.conflictId, "$.conflictId");
  const entityKey = text(record.entityKey, "$.entityKey"); if (!entityKey) fail("range", "$.entityKey", "entityKey must not be empty");
  if (record.status !== "open" && record.status !== "resolved") fail("enum", "$.status", "invalid conflict status");
  validateMutation(record.mutation);
  if (record.mutation.entityKey !== entityKey) fail("entity_key", "$.entityKey", "conflict entityKey must match embedded mutation");
  if (Object.hasOwn(record, "currentRevision") && integer(record.currentRevision, "$.currentRevision") < 0) fail("range", "$.currentRevision", "must be non-negative");
  canonicalBytes(record);
  return /** @type {import("./contracts").ConflictRecord} */ (value);
}

/** @param {unknown} value @returns {Record<string, any>} */
function payloadObject(value) {
  const r = object(value, "$.payload");
  if (r.schemaVersion !== 1) fail("schema_version", "$.payload.schemaVersion", "mutation payload schemaVersion must be 1");
  return r;
}

/** @param {string} entityKey @param {unknown} payload @returns {import("./contracts").AttemptManifestPayload} */
function validateAttemptManifestPayload(entityKey, payload) {
  const r = payloadObject(payload);
  fields(r, ["schemaVersion", "attemptId", "writerStreamId", "startedAt", "scopeDigest", "scopeCount", "status", "baseRevision", "parentAttemptId"], ["schemaVersion", "attemptId", "writerStreamId", "startedAt", "scopeDigest", "scopeCount", "status", "baseRevision"], "$.payload");
  uuid(r.attemptId, "$.payload.attemptId"); uuid(r.writerStreamId, "$.payload.writerStreamId"); timestamp(r.startedAt, "$.payload.startedAt"); digest(r.scopeDigest, "$.payload.scopeDigest");
  if (integer(r.scopeCount, "$.payload.scopeCount") < 1 || integer(r.baseRevision, "$.payload.baseRevision") < 0) fail("range", "$.payload", "invalid attempt manifest revision/count");
  if (r.status !== "active" && r.status !== "completed") fail("enum", "$.payload.status", "invalid attempt status");
  if (Object.hasOwn(r, "parentAttemptId")) { uuid(r.parentAttemptId, "$.payload.parentAttemptId"); if (r.parentAttemptId === r.attemptId) fail("invariant", "$.payload.parentAttemptId", "parentAttemptId cannot equal attemptId"); }
  entityMatch(entityKey, `attempt:${r.attemptId}`); return finishPayload("attempt_manifest", /** @type {import("./contracts").AttemptManifestPayload} */ (r));
}

/** @param {string} entityKey @param {unknown} payload @returns {import("./contracts").AttemptScopePayload} */
function validateAttemptScopePayload(entityKey, payload) {
  const r = payloadObject(payload);
  fields(r, ["schemaVersion", "attemptId", "scopeDigest", "reference", "baseRevision"], ["schemaVersion", "attemptId", "scopeDigest", "reference", "baseRevision"], "$.payload");
  uuid(r.attemptId, "$.payload.attemptId"); digest(r.scopeDigest, "$.payload.scopeDigest"); validateContentReference(r.reference, "$.payload.reference");
  if (r.baseRevision !== 0) fail("invariant", "$.payload.baseRevision", "attempt scope baseRevision must be exactly zero");
  entityMatch(entityKey, `attempt:${r.attemptId}`); return finishPayload("attempt_scope", /** @type {import("./contracts").AttemptScopePayload} */ (r));
}

/** @param {string} entityKey @param {unknown} payload @returns {import("./contracts").AnswerEventMutationPayload} */
function validateAnswerEventPayload(entityKey, payload) {
  const r = payloadObject(payload);
  fields(r, ["schemaVersion", "event"], ["schemaVersion", "event"], "$.payload");
  const event = validateAt(validateCoreAnswerEvent, r.event, "$.payload.event");
  entityMatch(entityKey, `event:${event.eventId}`); return finishPayload("answer_event", /** @type {import("./contracts").AnswerEventMutationPayload} */ (r));
}

/** @param {string} entityKey @param {unknown} payload @returns {import("./contracts").ResumeStatePayload} */
function validateResumeStatePayload(entityKey, payload) {
  const r = payloadObject(payload);
  fields(r, ["schemaVersion", "attemptId", "writerStreamId", "contentDigest", "chunkManifestDigest", "localRevision", "baseRevision"], ["schemaVersion", "attemptId", "writerStreamId", "contentDigest", "chunkManifestDigest", "localRevision", "baseRevision"], "$.payload");
  uuid(r.attemptId, "$.payload.attemptId"); uuid(r.writerStreamId, "$.payload.writerStreamId"); digest(r.contentDigest, "$.payload.contentDigest"); digest(r.chunkManifestDigest, "$.payload.chunkManifestDigest");
  if (integer(r.localRevision, "$.payload.localRevision") < 1 || integer(r.baseRevision, "$.payload.baseRevision") < 0) fail("range", "$.payload", "invalid resume revision");
  entityMatch(entityKey, `attempt:${r.attemptId}`); return finishPayload("resume_state", /** @type {import("./contracts").ResumeStatePayload} */ (r));
}

/** @param {string} entityKey @param {unknown} payload @returns {import("./contracts").UserStatePayload} */
function validateUserStatePayload(entityKey, payload) {
  const r = payloadObject(payload);
  fields(r, ["schemaVersion", "questionKey", "field", "value", "baseRevision"], ["schemaVersion", "questionKey", "field", "value", "baseRevision"], "$.payload");
  questionKey(r.questionKey, "$.payload.questionKey"); if (r.field !== "starred") fail("enum", "$.payload.field", "only starred user state is supported"); bool(r.value, "$.payload.value");
  if (integer(r.baseRevision, "$.payload.baseRevision") < 0) fail("range", "$.payload.baseRevision", "must be non-negative"); entityMatch(entityKey, `user_state:${r.questionKey}:starred`); return finishPayload("user_state", /** @type {import("./contracts").UserStatePayload} */ (r));
}

/** @param {string} entityKey @param {unknown} payload @returns {import("./contracts").BankRevisionPayload} */
function validateBankRevisionPayload(entityKey, payload) {
  const r = payloadObject(payload);
  fields(r, ["schemaVersion", "bankUid", "revision", "metadata", "contentManifest", "baseRevision"], ["schemaVersion", "bankUid", "revision", "metadata", "contentManifest", "baseRevision"], "$.payload");
  validateBankRevisionRecord({ bankUid: r.bankUid, revision: r.revision, metadata: r.metadata, contentManifest: r.contentManifest }, "$.payload");
  if (r.contentManifest.kind === "unavailable") fail("invariant", "$.payload.contentManifest", "unavailable bank content cannot be sent as a mutation");
  if (integer(r.baseRevision, "$.payload.baseRevision") < 0) fail("range", "$.payload.baseRevision", "must be non-negative"); entityMatch(entityKey, `bank:${r.bankUid}`); return finishPayload("bank_revision", /** @type {import("./contracts").BankRevisionPayload} */ (r));
}

/** @param {string} entityKey @param {unknown} payload @returns {import("./contracts").ContentManifestPayload} */
function validateContentManifestPayload(entityKey, payload) {
  const r = payloadObject(payload);
  fields(r, ["schemaVersion", "reference"], ["schemaVersion", "reference"], "$.payload"); validateContentReference(r.reference, "$.payload.reference"); entityMatch(entityKey, `content:${r.reference.contentDigest}`); return finishPayload("content_manifest", /** @type {import("./contracts").ContentManifestPayload} */ (r));
}

/** @param {string} entityKey @param {unknown} payload @returns {import("./contracts").EntityTombstonePayload} */
function validateEntityTombstonePayload(entityKey, payload) {
  const r = payloadObject(payload);
  fields(r, ["schemaVersion", "entityKind", "entityId"], ["schemaVersion", "entityKind", "entityId"], "$.payload");
  if (r.entityKind !== "bank" && r.entityKind !== "attempt" && r.entityKind !== 'history_snapshot') fail("enum", "$.payload.entityKind", "invalid tombstone entity kind");
  uuid(r.entityId, "$.payload.entityId"); entityMatch(entityKey, `${r.entityKind}:${r.entityId}`); return finishPayload("entity_tombstone", /** @type {import("./contracts").EntityTombstonePayload} */ (r));
}

/** @type {{ [K in import("./contracts").MutationKind]: (entityKey: string, payload: unknown) => import("./contracts").MutationPayloadByKind[K] }} */
const VALIDATE_PAYLOADS = {
  history_snapshot: (entityKey, payload) => { const record = validateHistorySnapshotPayload(payload); entityMatch(entityKey, `history_snapshot:${record.snapshotId}`); return record; },
  attempt_manifest: validateAttemptManifestPayload,
  attempt_scope: validateAttemptScopePayload,
  answer_event: validateAnswerEventPayload,
  resume_state: validateResumeStatePayload,
  user_state: validateUserStatePayload,
  bank_revision: validateBankRevisionPayload,
  content_manifest: validateContentManifestPayload,
  entity_tombstone: validateEntityTombstonePayload
};

/** Public payload-only shape/budget validator.  It has no transport or
 * session dependency; envelope validation adds the separate 16 KiB gate.
 * @template {import("./contracts").MutationKind} K
 * @param {K} kind
 * @param {string} entityKey
 * @param {unknown} payload
 * @returns {import("./contracts").MutationPayloadByKind[K]}
 */
export function validateMutationPayload(kind, entityKey, payload) {
  if (!KINDS.includes(kind)) fail("kind", "$.kind", "unknown frozen v2 mutation kind");
  return VALIDATE_PAYLOADS[kind](entityKey, payload);
}

/** @type {{ [K in import("./contracts").MutationKind]: (record: import("./contracts").MutationPayloadByKind[K]) => import("./contracts").MutationPayloadByKind[K] }} */
const FINISH_PAYLOADS = {
  history_snapshot: record => { canonicalBytes(record); return record; },
  attempt_manifest: finishAttemptManifestPayload,
  attempt_scope: finishAttemptScopePayload,
  answer_event: finishAnswerEventPayload,
  resume_state: finishResumeStatePayload,
  user_state: finishUserStatePayload,
  bank_revision: finishBankRevisionPayload,
  content_manifest: finishContentManifestPayload,
  entity_tombstone: finishEntityTombstonePayload
};

/** @template {import("./contracts").MutationKind} K @param {K} kind @param {import("./contracts").MutationPayloadByKind[K]} record @returns {import("./contracts").MutationPayloadByKind[K]} */
function finishPayload(kind, record) {
  return FINISH_PAYLOADS[kind](record);
}
/** @param {import("./contracts").AttemptManifestPayload} record @returns {import("./contracts").AttemptManifestPayload} */
function finishAttemptManifestPayload(record) {
  canonicalBytes(record);
  return record;
}
/** @param {import("./contracts").AttemptScopePayload} record @returns {import("./contracts").AttemptScopePayload} */
function finishAttemptScopePayload(record) {
  canonicalBytes(record);
  return record;
}
/** @param {import("./contracts").AnswerEventMutationPayload} record @returns {import("./contracts").AnswerEventMutationPayload} */
function finishAnswerEventPayload(record) {
  canonicalBytes(record);
  return record;
}
/** @param {import("./contracts").ResumeStatePayload} record @returns {import("./contracts").ResumeStatePayload} */
function finishResumeStatePayload(record) {
  canonicalBytes(record);
  return record;
}
/** @param {import("./contracts").UserStatePayload} record @returns {import("./contracts").UserStatePayload} */
function finishUserStatePayload(record) {
  canonicalBytes(record);
  return record;
}
/** @param {import("./contracts").BankRevisionPayload} record @returns {import("./contracts").BankRevisionPayload} */
function finishBankRevisionPayload(record) {
  canonicalBytes(record);
  return record;
}
/** @param {import("./contracts").ContentManifestPayload} record @returns {import("./contracts").ContentManifestPayload} */
function finishContentManifestPayload(record) {
  canonicalBytes(record);
  return record;
}
/** @param {import("./contracts").EntityTombstonePayload} record @returns {import("./contracts").EntityTombstonePayload} */
function finishEntityTombstonePayload(record) {
  canonicalBytes(record);
  return record;
}

/** @param {unknown} mutation */
export function mutationDigestInput(mutation) {
  const valid = validateMutation(mutation);
  return { protocolVersion: valid.protocolVersion, kind: valid.kind, entityKey: valid.entityKey, payload: valid.payload };
}
/** @param {unknown} mutation */
export async function computeMutationDigest(mutation) {
  const input = mutationDigestInput(mutation);
  const bytes = canonicalBytes(input);
  return sha256Hex(bytes);
}
/** @param {unknown} mutation */
export async function verifyMutationDigest(mutation) {
  let expected;
  let bytes;
  try {
    const valid = validateMutation(mutation);
    expected = valid.payloadDigest;
    const input = mutationDigestInput(valid);
    bytes = canonicalBytes(input);
  } catch (error) {
    if (error instanceof AppDataValidationError) return false;
    throw error;
  }
  // Keep the actual WebCrypto await outside the shape-error catch: a crypto
  // failure is an execution failure and must never be downgraded to false.
  const computed = await sha256Hex(bytes);
  return computed === expected;
}
