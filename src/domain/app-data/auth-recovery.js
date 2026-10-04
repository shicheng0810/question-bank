import { isUuid } from "../question/index.js";
import { AppDataValidationError, canonicalBytes, utf8ByteLength } from "./canonical.js";
import { APP_DATA_LIMITS, APP_DATA_PROTOCOL_VERSION } from "./constants.js";

const DIGEST_RE = /^[0-9a-f]{64}$/;
const DECIMAL_RE = /^(0|[1-9][0-9]{0,19})$/;
const SAFE_NAME_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const POLLUTION_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const IMPORT_STATUSES = new Set(["DISCOVERING", "RAW_SAVED", "TRANSFORMED", "VERIFIED", "COMMITTED", "QUARANTINED", "ABANDONED"]);

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

/** @param {unknown} value @param {string} path @returns {string} */
function opaque(value, path) {
  if (typeof value !== "string") fail("type", path, "must be a string");
  if (value.length === 0) fail("range", path, "must be non-empty");
  if (utf8ByteLength(value) > APP_DATA_LIMITS.maxStringUtf8Bytes) fail("utf8_limit", path, "string exceeds the configured UTF-8 limit");
  return value;
}

/** @param {unknown} value @param {string} path @returns {string} */
function text(value, path) {
  if (typeof value !== "string") fail("type", path, "must be a string");
  if (utf8ByteLength(value) > APP_DATA_LIMITS.maxStringUtf8Bytes) fail("utf8_limit", path, "string exceeds the configured UTF-8 limit");
  return value;
}

/** @param {unknown} value @param {string} path @returns {number} */
function nonNegativeInteger(value, path) {
  if (!Number.isSafeInteger(value)) fail("safe_integer", path, "must be a safe integer");
  const result = /** @type {number} */ (value);
  if (result < 0) fail("range", path, "must be non-negative");
  return result;
}

/** @param {unknown} value @param {string} path @returns {string} */
function uuid(value, path) {
  if (typeof value !== "string" || !isUuid(value)) fail("uuid", path, "must be a canonical lowercase UUID");
  return value;
}

/** @param {unknown} value @param {string} path @returns {string} */
function digest(value, path) {
  if (typeof value !== "string" || !DIGEST_RE.test(value)) fail("digest", path, "must be a lowercase SHA-256 hex digest");
  return value;
}

/** @param {unknown} value @param {string} path @returns {string} */
function decimal(value, path) {
  if (typeof value !== "string" || !DECIMAL_RE.test(value)) fail("cursor", path, "must be a canonical non-negative decimal string");
  return value;
}

/** @param {unknown} value @param {string} path @returns {string} */
function safeName(value, path) {
  const result = text(value, path);
  if (!SAFE_NAME_RE.test(result)) fail("identifier", path, "must be a bounded safe identifier");
  return result;
}

/** @param {unknown} value @param {string} path */
function protocolVersion(value, path) {
  if (value !== APP_DATA_PROTOCOL_VERSION) fail("version", path, `only protocol version ${APP_DATA_PROTOCOL_VERSION} is supported`);
}

/** @param {unknown} value @param {string} path */
function assertBudget(value, path = "$") {
  try { canonicalBytes(value); }
  catch (error) {
    if (error instanceof AppDataValidationError) throw new AppDataValidationError(error.code, path + error.path.slice(1), error.message);
    throw error;
  }
}

/** @param {string} value @param {string} path @returns {number} */
function base64UrlValue(value, path) {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) fail("base64url", path, "must use unpadded base64url characters");
  if (value.length % 4 === 1) fail("base64url", path, "base64url length is not decodable");
  let buffer = 0;
  let bits = 0;
  let byteCount = 0;
  for (const character of value) {
    const code = character.charCodeAt(0);
    const digit = code >= 65 && code <= 90 ? code - 65
      : code >= 97 && code <= 122 ? code - 97 + 26
        : code >= 48 && code <= 57 ? code - 48 + 52
          : character === "-" ? 62 : 63;
    buffer = (buffer << 6) | digit;
    bits += 6;
    while (bits >= 8) {
      bits -= 8;
      byteCount += 1;
    }
  }
  if (bits > 0 && (buffer & ((1 << bits) - 1)) !== 0) fail("base64url", path, "base64url has non-zero unused tail bits");
  if (byteCount < 32 || byteCount > 64) fail("base64url", path, "decoded capability must be 32..64 bytes");
  return byteCount;
}

/** @param {unknown} value @param {string} path @returns {string} */
function statusReceipt(value, path) {
  const result = text(value, path);
  base64UrlValue(result, path);
  return result;
}

/** @param {unknown} value @returns {import("./contracts").SessionCredentialV2} */
export function validateSessionCredentialV2(value) {
  const record = object(value, "$");
  fields(record, ["version", "sub", "accountGeneration", "issuedAt", "expiresAt"], ["version", "sub", "accountGeneration", "issuedAt", "expiresAt"], "$");
  if (record.version !== 2) fail("version", "$.version", "only credential version 2 is supported");
  opaque(record.sub, "$.sub"); uuid(record.accountGeneration, "$.accountGeneration");
  const issuedAt = nonNegativeInteger(record.issuedAt, "$.issuedAt");
  const expiresAt = nonNegativeInteger(record.expiresAt, "$.expiresAt");
  if (expiresAt <= issuedAt) fail("range", "$.expiresAt", "expiresAt must be greater than issuedAt");
  assertBudget(record);
  return /** @type {import("./contracts").SessionCredentialV2} */ (value);
}

/** @param {unknown} value @returns {import("./contracts").InternalSessionClaim} */
export function validateInternalSessionClaim(value) {
  const record = object(value, "$");
  fields(record, ["sub", "accountGeneration", "sessionExpiresAt", "requestId"], ["sub", "accountGeneration", "sessionExpiresAt", "requestId"], "$");
  opaque(record.sub, "$.sub"); uuid(record.accountGeneration, "$.accountGeneration");
  nonNegativeInteger(record.sessionExpiresAt, "$.sessionExpiresAt"); uuid(record.requestId, "$.requestId");
  assertBudget(record);
  return /** @type {import("./contracts").InternalSessionClaim} */ (value);
}

/** @param {unknown} value @returns {import("./contracts").GenerationClaim} */
export function validateGenerationClaim(value) {
  const record = object(value, "$");
  fields(record, ["accountId", "accountGeneration", "status", "protocolVersion"], ["accountId", "accountGeneration", "status", "protocolVersion"], "$");
  opaque(record.accountId, "$.accountId"); uuid(record.accountGeneration, "$.accountGeneration");
  if (!["ACTIVE", "DELETING", "DELETED", "QUARANTINED"].includes(record.status)) fail("enum", "$.status", "invalid generation status");
  protocolVersion(record.protocolVersion, "$.protocolVersion"); assertBudget(record);
  return /** @type {import("./contracts").GenerationClaim} */ (value);
}

/** @param {unknown} value @returns {import("./contracts").AuthBootstrapResponse} */
export function validateAuthBootstrapResponse(value) {
  const record = object(value, "$");
  fields(record, ["ok", "accountId", "accountGeneration", "status", "protocolVersion", "legacyImportState"], ["ok", "accountId", "accountGeneration", "status", "protocolVersion", "legacyImportState"], "$");
  if (record.ok !== true) fail("enum", "$.ok", "must be true for a successful auth response");
  opaque(record.accountId, "$.accountId"); uuid(record.accountGeneration, "$.accountGeneration");
  if (record.status !== "ACTIVE") fail("enum", "$.status", "successful bootstrap must be ACTIVE");
  protocolVersion(record.protocolVersion, "$.protocolVersion");
  if (!["pending", "sealed", "quarantined"].includes(record.legacyImportState)) fail("enum", "$.legacyImportState", "invalid legacy import state");
  assertBudget(record);
  return /** @type {import("./contracts").AuthBootstrapResponse} */ (value);
}

/** @param {unknown} value @param {string} path @returns {Record<string, any>} */
function validateOldEpoch(value, path) {
  const record = object(value, path);
  fields(record, ["status", "value"], ["status"], path);
  if (record.status === "absent" || record.status === "unverified") {
    if (Object.hasOwn(record, "value")) fail("unknown_field", `${path}.value`, "this oldEpoch status may not carry value");
  } else if (record.status === "present") {
    if (!Object.hasOwn(record, "value")) fail("required", `${path}.value`, "present oldEpoch requires value");
    nonNegativeInteger(record.value, `${path}.value`);
  } else fail("enum", `${path}.status`, "invalid oldEpoch status");
  return record;
}

/** @param {unknown} value @param {string} path @returns {Record<string, any>} */
function validateDeletionSources(value, path) {
  const record = object(value, path);
  fields(record, ["status", "sourceManifestDigest"], ["status"], path);
  if (record.status === "clear" || record.status === "deleted") {
    if (!Object.hasOwn(record, "sourceManifestDigest")) fail("required", `${path}.sourceManifestDigest`, "verified deletion source result requires digest");
    digest(record.sourceManifestDigest, `${path}.sourceManifestDigest`);
  } else if (record.status === "unverified") {
    if (Object.hasOwn(record, "sourceManifestDigest")) fail("unknown_field", `${path}.sourceManifestDigest`, "unverified deletion sources may not carry digest");
  } else fail("enum", `${path}.status`, "invalid deletion source status");
  return record;
}

/** @param {unknown} value @returns {import("./contracts").CutoverEvidence} */
export function validateCutoverEvidence(value) {
  const record = object(value, "$");
  fields(record, ["outcome", "sub", "cutoverId", "evidenceDigest", "oldEpoch", "deletionSources"], ["outcome", "sub", "cutoverId", "evidenceDigest", "oldEpoch", "deletionSources"], "$");
  if (!["new_after_verified_cutover", "legacy_verified", "quarantined"].includes(record.outcome)) fail("enum", "$.outcome", "invalid cutover outcome");
  opaque(record.sub, "$.sub"); safeName(record.cutoverId, "$.cutoverId"); digest(record.evidenceDigest, "$.evidenceDigest");
  const oldEpoch = validateOldEpoch(record.oldEpoch, "$.oldEpoch");
  const deletionSources = validateDeletionSources(record.deletionSources, "$.deletionSources");
  if (record.outcome === "new_after_verified_cutover" && (oldEpoch.status !== "absent" || deletionSources.status !== "clear")) fail("invariant", "$", "new cutover requires absent old epoch and clear deletion sources");
  if (record.outcome === "legacy_verified" && !["absent", "present"].includes(oldEpoch.status)) fail("invariant", "$.oldEpoch", "legacy cutover requires a verified old epoch");
  if (["new_after_verified_cutover", "legacy_verified"].includes(record.outcome) && deletionSources.status !== "clear") fail("invariant", "$.deletionSources", "verified cutover requires clear deletion sources");
  assertBudget(record);
  return /** @type {import("./contracts").CutoverEvidence} */ (value);
}

/** @param {unknown} value @returns {import("./contracts").LegacyImportJobIntent} */
export function validateLegacyImportJob(value) {
  const record = object(value, "$");
  fields(record, ["jobId", "targetGeneration", "sourceId", "status", "leaseFence", "sourceManifestDigest"], ["jobId", "targetGeneration", "sourceId", "status", "leaseFence"], "$");
  uuid(record.jobId, "$.jobId"); uuid(record.targetGeneration, "$.targetGeneration"); opaque(record.sourceId, "$.sourceId");
  if (typeof record.status !== "string" || !IMPORT_STATUSES.has(record.status)) fail("enum", "$.status", "invalid import-job status");
  if (nonNegativeInteger(record.leaseFence, "$.leaseFence") < 1) fail("range", "$.leaseFence", "leaseFence must be positive");
  const requiresDigest = ["RAW_SAVED", "TRANSFORMED", "VERIFIED", "COMMITTED"].includes(record.status);
  if (requiresDigest && !Object.hasOwn(record, "sourceManifestDigest")) fail("required", "$.sourceManifestDigest", "this import phase requires source manifest digest");
  if (Object.hasOwn(record, "sourceManifestDigest")) digest(record.sourceManifestDigest, "$.sourceManifestDigest");
  assertBudget(record);
  return /** @type {import("./contracts").LegacyImportJobIntent} */ (value);
}

/** Alias retaining the explicit intent name for new consumers. */
export const validateLegacyImportJobIntent = validateLegacyImportJob;

/** @param {unknown} value @returns {import("./contracts").AccountDeleteRequest} */
export function validateAccountDeleteRequest(value) {
  const record = object(value, "$");
  fields(record, ["operationId", "statusReceipt"], ["operationId", "statusReceipt"], "$");
  uuid(record.operationId, "$.operationId"); statusReceipt(record.statusReceipt, "$.statusReceipt");
  assertBudget(record);
  return /** @type {import("./contracts").AccountDeleteRequest} */ (value);
}

/** @param {unknown} value @returns {import("./contracts").AccountDeletionCapabilityRequest} */
export function validateDeletionCapabilityRequest(value) {
  const record = object(value, "$");
  fields(record, ["accountId", "operationId", "statusReceipt"], ["accountId", "operationId", "statusReceipt"], "$");
  opaque(record.accountId, "$.accountId"); uuid(record.operationId, "$.operationId"); statusReceipt(record.statusReceipt, "$.statusReceipt");
  assertBudget(record);
  return /** @type {import("./contracts").AccountDeletionCapabilityRequest} */ (value);
}

/** @param {unknown} value @returns {import("./contracts").AccountDeletionResponse} */
export function validateAccountDeletionResponse(value) {
  const record = object(value, "$");
  fields(record, ["operationId", "status", "failedSourceCategory", "retryAfter"], ["operationId", "status"], "$");
  uuid(record.operationId, "$.operationId");
  if (record.status === "pending") {
    if (Object.hasOwn(record, "failedSourceCategory")) fail("unknown_field", "$.failedSourceCategory", "pending response may not include failedSourceCategory");
    if (Object.hasOwn(record, "retryAfter")) nonNegativeInteger(record.retryAfter, "$.retryAfter");
  } else if (record.status === "retryable_failed") {
    if (!Object.hasOwn(record, "failedSourceCategory")) fail("required", "$.failedSourceCategory", "retryable failure requires failedSourceCategory");
    if (!Object.hasOwn(record, "retryAfter")) fail("required", "$.retryAfter", "retryable failure requires retryAfter");
    safeName(record.failedSourceCategory, "$.failedSourceCategory"); nonNegativeInteger(record.retryAfter, "$.retryAfter");
  } else if (record.status === "complete") {
    if (Object.hasOwn(record, "failedSourceCategory")) fail("unknown_field", "$.failedSourceCategory", "complete response may not include failedSourceCategory");
    if (Object.hasOwn(record, "retryAfter")) fail("unknown_field", "$.retryAfter", "complete response may not include retryAfter");
  } else fail("enum", "$.status", "invalid deletion status");
  assertBudget(record);
  return /** @type {import("./contracts").AccountDeletionResponse} */ (value);
}

/** @param {unknown} value @param {string} path @returns {string} */
function pageUrl(value, path) {
  const result = text(value, path);
  if (!result.startsWith("/") || result.startsWith("//")) fail("path", path, "must be a single-slash API-relative URL");
  if (/[\\\u0000-\u0020\u007f#]/u.test(result)) fail("path", path, "pageUrl contains a forbidden raw URL character");
  for (let i = 0; i < result.length; i += 1) {
    if (result[i] === "%" && !/^[0-9A-Fa-f]{2}$/.test(result.slice(i + 1, i + 3))) fail("path", path, "pageUrl contains an invalid percent escape");
  }
  let parsed;
  try { parsed = new URL(result, "https://api.invalid"); }
  catch { fail("path", path, "pageUrl must parse as an API-relative URL"); }
  if (parsed.origin !== "https://api.invalid") fail("path", path, "pageUrl must not change API origin");
  return result;
}

/** @param {unknown} value @returns {import("./contracts").CursorReset} */
export function validateCursorReset(value) {
  const record = object(value, "$");
  fields(record, ["reason", "generation", "logEpoch", "earliestAvailableSeq", "resetExportId", "exportCut", "manifestDigest", "pageUrl", "expiresAt"], ["reason", "generation", "logEpoch", "earliestAvailableSeq", "resetExportId", "exportCut", "manifestDigest", "pageUrl", "expiresAt"], "$");
  safeName(record.reason, "$.reason"); uuid(record.generation, "$.generation"); uuid(record.logEpoch, "$.logEpoch"); decimal(record.earliestAvailableSeq, "$.earliestAvailableSeq"); uuid(record.resetExportId, "$.resetExportId"); decimal(record.exportCut, "$.exportCut"); digest(record.manifestDigest, "$.manifestDigest"); pageUrl(record.pageUrl, "$.pageUrl"); nonNegativeInteger(record.expiresAt, "$.expiresAt");
  assertBudget(record);
  return /** @type {import("./contracts").CursorReset} */ (value);
}
