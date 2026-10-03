import { isUuid } from "../question/index.js";
import { AppDataValidationError, assertUtf8Within, canonicalBytes, utf8ByteLength } from "./canonical.js";
import { APP_DATA_LIMITS, APP_DATA_PROTOCOL_VERSION } from "./constants.js";
import { decodeCursor } from "./cursor.js";
import { validateMutation, validateMutationPayload } from "./mutation-records.js";

const DIGEST_RE = /^[0-9a-f]{64}$/;
const DECIMAL_RE = /^(0|[1-9][0-9]{0,19})$/;
const CAS_KINDS = new Set(["attempt_manifest", "resume_state", "user_state", "bank_revision"]);
const MUTATION_KINDS = new Set([
  "attempt_manifest", "attempt_scope", "answer_event", "resume_state",
  "user_state", "bank_revision", "content_manifest", "entity_tombstone", "history_snapshot"
]);
const POLLUTION_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/** @param {string} code @param {string} path @param {string} message @returns {never} */
function fail(code, path, message) { throw new AppDataValidationError(code, path, message); }

/** @param {unknown} value @param {string} path @returns {Record<string, any>} */
function object(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("type", path, "must be a plain object");
  if (Object.getPrototypeOf(value) !== Object.prototype) fail("prototype", path, "must use Object.prototype");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const rawKey of Reflect.ownKeys(descriptors)) {
    if (typeof rawKey !== "string") fail("symbol", path, "symbol keys are not JSON");
    if (POLLUTION_KEYS.has(rawKey)) fail("prototype_pollution", `${path}.${rawKey}`, "prototype-pollution key is forbidden");
    const descriptor = descriptors[rawKey];
    if (!descriptor || !("value" in descriptor)) fail("accessor", `${path}.${rawKey}`, "accessors are not JSON");
    if (!descriptor.enumerable) fail("non_enumerable", `${path}.${rawKey}`, "non-enumerable fields cannot be silently omitted");
  }
  return /** @type {Record<string, any>} */ (value);
}

/** @param {Record<string, unknown>} value @param {readonly string[]} allowed @param {readonly string[]} required @param {string} path */
function fields(value, allowed, required, path) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail("unknown_field", `${path}.${key}`, "unknown field is not permitted by the frozen contract");
  for (const key of required) if (!Object.hasOwn(value, key)) fail("required", `${path}.${key}`, "required field is missing");
}

/** @param {unknown} value @param {string} path @returns {unknown[]} */
function array(value, path) {
  if (!Array.isArray(value)) fail("type", path, "must be an array");
  if (Object.getPrototypeOf(value) !== Array.prototype) fail("prototype", path, "must use Array.prototype");
  if (value.length > APP_DATA_LIMITS.maxArrayItems) fail("array_limit", path, "array exceeds configured item limit");
  for (let i = 0; i < value.length; i++) {
    if (!Object.hasOwn(value, i)) fail("array_hole", `${path}[${i}]`, "array holes are not JSON");
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !("value" in descriptor)) fail("accessor", `${path}[${i}]`, "array accessors are not JSON");
    if (!descriptor.enumerable) fail("non_enumerable", `${path}[${i}]`, "non-enumerable array elements are not JSON");
  }
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length" || (typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key))) continue;
    fail("array_property", path, "arrays may not have non-index properties");
  }
  return value;
}

/** @param {unknown} value @param {string} path */
function version(value, path) { if (value !== APP_DATA_PROTOCOL_VERSION) fail("version", path, `only protocol version ${APP_DATA_PROTOCOL_VERSION} is supported`); }
/** @param {unknown} value @param {string} path */
function string(value, path) {
  if (typeof value !== "string") fail("type", path, "must be a string");
  if (utf8ByteLength(value) > APP_DATA_LIMITS.maxStringUtf8Bytes) fail("utf8_limit", path, "string exceeds the configured UTF-8 limit");
  return value;
}
/** @param {unknown} value @param {string} path */
function uuid(value, path) { if (typeof value !== "string" || !isUuid(value)) fail("uuid", path, "must be a canonical lowercase UUID"); return value; }
/** @param {unknown} value @param {string} path */
function digest(value, path) { if (typeof value !== "string" || !DIGEST_RE.test(value)) fail("digest", path, "must be a lowercase SHA-256 hex digest"); return value; }
/** @param {unknown} value @param {string} path */
function decimal(value, path) { if (typeof value !== "string" || !DECIMAL_RE.test(value)) fail("cursor", path, "must be a non-negative decimal string"); return value; }
/** @param {unknown} value @param {string} path */
function positiveDecimal(value, path) { const result = decimal(value, path); if (result === "0") fail("range", path, "must be a positive decimal string"); return result; }
/** @param {unknown} value @param {string} path @returns {number} */
function safeInteger(value, path) { if (!Number.isSafeInteger(value)) fail("safe_integer", path, "must be a safe integer"); return /** @type {number} */ (value); }
/** @param {unknown} value @param {string} path */
function boolean(value, path) { if (typeof value !== "boolean") fail("type", path, "must be a boolean"); return value; }

/** @template T @param {(value: unknown) => T} validator @param {unknown} value @param {string} path @returns {T} */
function validateAt(validator, value, path) {
  try { return validator(value); }
  catch (error) {
    if (error instanceof AppDataValidationError) throw new AppDataValidationError(error.code, path + error.path.slice(1), error.message);
    throw error;
  }
}

/** @param {string} left @param {string} right @returns {number} */
function compareDecimal(left, right) {
  const a = left.replace(/^0+/, "") || "0";
  const b = right.replace(/^0+/, "") || "0";
  return a.length === b.length ? (a === b ? 0 : a < b ? -1 : 1) : (a.length < b.length ? -1 : 1);
}
/** @param {string} value @returns {string} */
function incrementDecimal(value) { return (BigInt(value) + 1n).toString(); }

/** @param {unknown} value @returns {import("./contracts").ChangeLogRecord} */
export function validateChangeLogRecord(value) {
  const record = object(value, "$");
  fields(record, ["serverSeq", "accountGeneration", "kind", "entityKey", "payloadDigest", "payload", "serverRevision"], ["serverSeq", "accountGeneration", "kind", "entityKey", "payloadDigest", "payload"], "$");
  positiveDecimal(record.serverSeq, "$.serverSeq");
  uuid(record.accountGeneration, "$.accountGeneration");
  if (typeof record.kind !== "string" || !MUTATION_KINDS.has(record.kind)) fail("kind", "$.kind", "unknown frozen v2 mutation kind");
  const entityKey = string(record.entityKey, "$.entityKey");
  digest(record.payloadDigest, "$.payloadDigest");
  validateAt((payload) => validateMutationPayload(record.kind, entityKey, payload), record.payload, "$.payload");
  if (CAS_KINDS.has(record.kind)) {
    if (!Object.hasOwn(record, "serverRevision")) fail("required", "$.serverRevision", "CAS change records require serverRevision");
    if (safeInteger(record.serverRevision, "$.serverRevision") < 1) fail("range", "$.serverRevision", "serverRevision must be positive");
  } else if (Object.hasOwn(record, "serverRevision")) {
    fail("unknown_field", "$.serverRevision", "immutable change records may not carry serverRevision");
  }
  // The payload validator's budget does not include this server-assigned
  // wrapper.  Keep the ordinary record cap at the public ChangeLog boundary.
  canonicalBytes(record);
  return /** @type {import("./contracts").ChangeLogRecord} */ (value);
}

/** @param {unknown} value @returns {import("./contracts").MutationReceipt} */
export function validateMutationReceipt(value) {
  const record = object(value, "$");
  fields(record, ["mutationId", "payloadDigest", "status", "serverSeq", "currentRevision", "error"], ["mutationId", "payloadDigest", "status"], "$");
  uuid(record.mutationId, "$.mutationId"); digest(record.payloadDigest, "$.payloadDigest");
  if (record.status !== "accepted" && record.status !== "duplicate" && record.status !== "conflict" && record.status !== "missing_dependency") fail("enum", "$.status", "invalid mutation receipt status");
  if (record.status === "accepted" || record.status === "duplicate") {
    if (!Object.hasOwn(record, "serverSeq")) fail("required", "$.serverSeq", "accepted and duplicate receipts require serverSeq");
    positiveDecimal(record.serverSeq, "$.serverSeq");
    if (Object.hasOwn(record, "error")) fail("unknown_field", "$.error", "accepted and duplicate receipts may not carry error");
  } else if (record.status === "conflict") {
    if (Object.hasOwn(record, "serverSeq")) fail("unknown_field", "$.serverSeq", "conflict receipts may not carry serverSeq");
    if (!Object.hasOwn(record, "error")) fail("required", "$.error", "conflict receipts require error");
    if (record.error !== "conflict") fail("enum", "$.error", "conflict receipts require error=conflict");
  } else {
    if (Object.hasOwn(record, "serverSeq")) fail("unknown_field", "$.serverSeq", "missing_dependency receipts may not carry serverSeq");
    if (Object.hasOwn(record, "currentRevision")) fail("unknown_field", "$.currentRevision", "missing_dependency receipts may not carry currentRevision");
    if (!Object.hasOwn(record, "error")) fail("required", "$.error", "missing_dependency receipts require error");
    if (record.error !== "missing_dependency") fail("enum", "$.error", "missing_dependency receipts require its stable error category");
  }
  if (Object.hasOwn(record, "currentRevision") && safeInteger(record.currentRevision, "$.currentRevision") < 0) fail("range", "$.currentRevision", "currentRevision must be non-negative");
  if (record.status !== "missing_dependency" && record.status !== "conflict" && Object.hasOwn(record, "error")) fail("unknown_field", "$.error", "error is only valid on classified failure receipts");
  return /** @type {import("./contracts").MutationReceipt} */ (value);
}

/** @param {unknown} value @returns {import("./contracts").PushRequest} */
export function validatePushRequest(value) {
  const record = object(value, "$");
  fields(record, ["protocolVersion", "accountGeneration", "mutations"], ["protocolVersion", "accountGeneration", "mutations"], "$");
  version(record.protocolVersion, "$.protocolVersion"); uuid(record.accountGeneration, "$.accountGeneration");
  const mutations = array(record.mutations, "$.mutations");
  if (mutations.length > APP_DATA_LIMITS.maxPushMutations) fail("array_limit", "$.mutations", "push has too many mutations");
  const ids = new Set(); const streamSeqs = new Set();
  mutations.forEach((item, index) => {
    const mutation = /** @type {import("./contracts").MutationEnvelope} */ (validateAt(validateMutation, item, `$.mutations[${index}]`));
    if (ids.has(mutation.mutationId)) fail("duplicate", "$.mutations", "mutationId must be unique in a push");
    ids.add(mutation.mutationId);
    const streamSeq = `${mutation.clientStreamId}:${mutation.clientSeq}`;
    if (streamSeqs.has(streamSeq)) fail("duplicate", "$.mutations", "clientStreamId/clientSeq must be unique in a push");
    streamSeqs.add(streamSeq);
  });
  assertUtf8Within(new TextDecoder().decode(canonicalBytes(record)), APP_DATA_LIMITS.maxPushUtf8Bytes, "push request");
  return /** @type {import("./contracts").PushRequest} */ (value);
}

/** @param {unknown} value @returns {import("./contracts").PushResponse} */
export function validatePushResponse(value) {
  const record = object(value, "$");
  fields(record, ["protocolVersion", "generation", "logEpoch", "receipts", "serverHighWater"], ["protocolVersion", "generation", "logEpoch", "receipts", "serverHighWater"], "$");
  version(record.protocolVersion, "$.protocolVersion"); uuid(record.generation, "$.generation"); uuid(record.logEpoch, "$.logEpoch");
  const receipts = array(record.receipts, "$.receipts");
  if (receipts.length > 100) fail("array_limit", "$.receipts", "push response has too many receipts");
  const ids = new Set(); receipts.forEach((item, index) => {
    const receipt = /** @type {import("./contracts").MutationReceipt} */ (validateAt(validateMutationReceipt, item, `$.receipts[${index}]`));
    if (ids.has(receipt.mutationId)) fail("duplicate", "$.receipts", "receipt mutationId must be unique");
    ids.add(receipt.mutationId);
  });
  const highWater = decimal(record.serverHighWater, "$.serverHighWater");
  for (const item of receipts) {
    const receipt = /** @type {import("./contracts").MutationReceipt} */ (item);
    if (Object.hasOwn(receipt, "serverSeq") && compareDecimal(/** @type {string} */ (receipt.serverSeq), highWater) > 0) fail("range", "$.receipts", "receipt serverSeq cannot exceed serverHighWater");
  }
  assertUtf8Within(new TextDecoder().decode(canonicalBytes(record)), APP_DATA_LIMITS.maxPushResponseUtf8Bytes, "push response");
  return /** @type {import("./contracts").PushResponse} */ (value);
}

/** @param {unknown} value @returns {import("./contracts").PullRequest} */
export function validatePullRequest(value) {
  const record = object(value, "$");
  fields(record, ["protocolVersion", "after", "until", "limit"], ["protocolVersion", "after", "limit"], "$");
  version(record.protocolVersion, "$.protocolVersion");
  const after = decodeCursor(string(record.after, "$.after"));
  const until = Object.hasOwn(record, "until") ? decodeCursor(string(record.until, "$.until")) : undefined;
  if (until && (until.accountGeneration !== after.accountGeneration || until.logEpoch !== after.logEpoch)) fail("cursor_context", "$.until", "until must use the after cursor generation and log epoch");
  if (until && compareDecimal(until.serverSeq, after.serverSeq) < 0) fail("cursor_order", "$.until", "until cannot precede after");
  const limit = safeInteger(record.limit, "$.limit"); if (limit < 1 || limit > APP_DATA_LIMITS.maxPullChanges) fail("range", "$.limit", "must be within the pull page limit");
  return /** @type {import("./contracts").PullRequest} */ (value);
}

/** @param {unknown} value @returns {import("./contracts").PullResponse} */
export function validatePullResponse(value) {
  const record = object(value, "$");
  fields(record, ["protocolVersion", "changes", "nextCursor", "highWater", "hasMore", "generation", "logEpoch"], ["protocolVersion", "changes", "nextCursor", "highWater", "hasMore", "generation", "logEpoch"], "$");
  version(record.protocolVersion, "$.protocolVersion"); uuid(record.generation, "$.generation"); uuid(record.logEpoch, "$.logEpoch");
  const highWater = decimal(record.highWater, "$.highWater");
  const next = decodeCursor(string(record.nextCursor, "$.nextCursor"));
  if (next.accountGeneration !== record.generation || next.logEpoch !== record.logEpoch) fail("cursor_context", "$.nextCursor", "nextCursor context must match response");
  boolean(record.hasMore, "$.hasMore");
  const changes = array(record.changes, "$.changes");
  if (changes.length > APP_DATA_LIMITS.maxPullChanges) fail("array_limit", "$.changes", "pull response has too many changes");
  let previous = "0";
  for (let index = 0; index < changes.length; index++) {
    const change = /** @type {import("./contracts").ChangeLogRecord} */ (validateAt(validateChangeLogRecord, changes[index], `$.changes[${index}]`));
    if (change.accountGeneration !== record.generation) fail("generation", `$.changes[${index}].accountGeneration`, "change generation must match response");
    if (compareDecimal(change.serverSeq, previous) <= 0) fail("sequence", `$.changes[${index}].serverSeq`, "changes must be strictly increasing");
    if (compareDecimal(change.serverSeq, highWater) > 0) fail("range", `$.changes[${index}].serverSeq`, "change serverSeq cannot exceed highWater");
    previous = change.serverSeq;
  }
  if (changes.length === 0) {
    if (next.serverSeq !== highWater || record.hasMore) fail("page_relation", "$", "an empty page must end at highWater with hasMore=false");
  } else {
    if (next.serverSeq !== previous || record.hasMore !== compareDecimal(previous, highWater) < 0) fail("page_relation", "$", "nextCursor and hasMore do not match the returned page");
  }
  assertUtf8Within(new TextDecoder().decode(canonicalBytes(record)), APP_DATA_LIMITS.maxPullUtf8Bytes, "pull response");
  return /** @type {import("./contracts").PullResponse} */ (value);
}

/** @param {unknown} response @param {unknown} request @param {unknown} expectedLogEpoch @returns {import("./contracts").PushResponse} */
export function validatePushAcknowledgement(response, request, expectedLogEpoch) {
  const validRequest = validatePushRequest(request);
  const validResponse = validatePushResponse(response);
  uuid(expectedLogEpoch, "$.expectedLogEpoch");
  if (validResponse.generation !== validRequest.accountGeneration) fail("generation", "$.generation", "push response generation does not match request");
  if (validResponse.logEpoch !== expectedLogEpoch) fail("epoch", "$.logEpoch", "push response log epoch does not match expected epoch");
  const mutations = new Map(validRequest.mutations.map((mutation) => [mutation.mutationId, mutation]));
  const seen = new Set();
  for (const receipt of validResponse.receipts) {
    const mutation = mutations.get(receipt.mutationId);
    if (!mutation) fail("unknown_mutation", "$.receipts", "response contains a receipt for an unknown mutation");
    if (seen.has(receipt.mutationId)) fail("duplicate", "$.receipts", "response contains a duplicate receipt");
    seen.add(receipt.mutationId);
    if (receipt.payloadDigest !== mutation.payloadDigest) fail("digest", `$.receipts.${receipt.mutationId}.payloadDigest`, "receipt payloadDigest does not match request");
  }
  if (seen.size !== validRequest.mutations.length) fail("missing_receipt", "$.receipts", "response must contain exactly one receipt per request mutation");
  return validResponse;
}

/** @param {unknown} response @param {unknown} request @returns {import("./contracts").PullResponse} */
export function validatePullPage(response, request) {
  const validRequest = validatePullRequest(request);
  const validResponse = validatePullResponse(response);
  const after = decodeCursor(validRequest.after);
  if (validResponse.generation !== after.accountGeneration) fail("generation", "$.generation", "pull response generation does not match request cursor");
  if (validResponse.logEpoch !== after.logEpoch) fail("epoch", "$.logEpoch", "pull response log epoch does not match request cursor");
  const highWater = validResponse.highWater;
  if (validRequest.until) {
    const until = decodeCursor(validRequest.until);
    if (highWater !== until.serverSeq) fail("fixed_until", "$.highWater", "fixed until page must preserve the requested highWater");
  } else if (compareDecimal(highWater, after.serverSeq) < 0) {
    fail("cursor_order", "$.highWater", "server highWater cannot be behind after");
  }
  if (validResponse.changes.length > validRequest.limit) fail("array_limit", "$.changes", "page exceeds requested limit");
  if (validResponse.changes.length === 0) {
    if (after.serverSeq !== highWater || decodeCursor(validResponse.nextCursor).serverSeq !== highWater || validResponse.hasMore) fail("page_relation", "$", "empty page is valid only at highWater");
    return validResponse;
  }
  let expected = incrementDecimal(after.serverSeq);
  for (const change of validResponse.changes) {
    if (change.serverSeq !== expected) fail("sequence", "$.changes", "pull page must begin after after and remain contiguous");
    expected = incrementDecimal(expected);
  }
  const lastChange = validResponse.changes[validResponse.changes.length - 1];
  if (!lastChange) fail("page_relation", "$.changes", "non-empty page lost its last change");
  const last = lastChange.serverSeq;
  if (decodeCursor(validResponse.nextCursor).serverSeq !== last) fail("page_relation", "$.nextCursor", "nextCursor must equal the last change");
  if (!validResponse.hasMore && last !== highWater) fail("page_relation", "$.hasMore", "a page before highWater must advertise hasMore");
  return validResponse;
}
