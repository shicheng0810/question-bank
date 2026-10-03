import {validateSnapshotContinuationReceipt} from './snapshot-continuation.js';
import { isQuestionKey, isUuid } from "../question/index.js";
import { AppDataValidationError, canonicalBytes, utf8ByteLength } from "./canonical.js";
import { APP_DATA_DB_SCHEMA_VERSION, APP_DATA_LIMITS } from "./constants.js";
import { validateAlias } from "./identity.js";
import { validateExportManifest } from "./export-manifest.js";
import { validateBankRevisionRecord } from "./content-records.js";
import { decodeCursor } from "./cursor.js";

const DIGEST_RE = /^[0-9a-f]{64}$/;
const DECIMAL_RE = /^(0|[1-9][0-9]{0,19})$/;
const DB_NAME_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const POLLUTION_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const META_KEYS = new Set([
  "clientStreamId", "clientSeq", "clockHighWaterMs", "appliedPullCursor", "serverLogEpoch", "schemaVersion",
  "projectionVersion", "projectionInvalidationRevision", "projectionAppliedRevision", "syncCoordinatorLease"
]);
const PROFILE_STATES = new Set(["staged", "ready", "locked", "quarantined", "deleting", "deleted"]);
const MIGRATION_STATES = new Set(["DISCOVERED", "RAW_SAVED", "TRANSFORMED", "VERIFIED", "COMMITTED", "QUARANTINED"]);

/** @param {string} code @param {string} path @param {string} message @returns {never} */
function fail(code, path, message) { throw new AppDataValidationError(code, path, message); }

/** @param {unknown} value @param {string} path @returns {Record<string, unknown>} */
function object(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("type", path, "must be a plain object");
  if (Object.getPrototypeOf(value) !== Object.prototype) fail("prototype", path, "must use Object.prototype");
  const record = /** @type {Record<string, unknown>} */ (value);
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== "string") fail("symbol", path, "symbol keys are not JSON");
    if (POLLUTION_KEYS.has(key)) fail("prototype_pollution", `${path}.${key}`, "prototype-pollution key is forbidden");
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) fail("accessor", `${path}.${key}`, "accessors are not JSON");
    if (!descriptor.enumerable) fail("non_enumerable", `${path}.${key}`, "non-enumerable fields cannot be silently omitted");
  }
  return record;
}

/** @param {Record<string, unknown>} value @param {readonly string[]} allowed @param {readonly string[]} required @param {string} path */
function fields(value, allowed, required, path) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail("unknown_field", `${path}.${key}`, "unknown field is not permitted by the frozen contract");
  for (const key of required) if (!Object.hasOwn(value, key)) fail("required", `${path}.${key}`, "required field is missing");
}

/** @param {unknown} value @param {string} path @returns {string} */
function string(value, path) {
  if (typeof value !== "string") fail("type", path, "must be a string");
  if (utf8ByteLength(value) > APP_DATA_LIMITS.maxStringUtf8Bytes) fail("utf8_limit", path, "string exceeds the configured UTF-8 limit");
  return value;
}

/** @param {unknown} value @param {string} path @returns {string} */
function nonEmptyString(value, path) {
  const result = string(value, path);
  if (result.length === 0) fail("range", path, "must be non-empty");
  return result;
}

/** @param {unknown} value @param {string} path @returns {number} */
function integer(value, path) {
  if (!Number.isSafeInteger(value)) fail("safe_integer", path, "must be a safe integer");
  return /** @type {number} */ (value);
}

/** @param {unknown} value @param {string} path @returns {number} */
function nonNegative(value, path) {
  const result = integer(value, path);
  if (result < 0) fail("range", path, "must be non-negative");
  return result;
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

/** @param {unknown} value @param {string} path @returns {string} */
function decimal(value, path) {
  if (typeof value !== "string" || !DECIMAL_RE.test(value)) fail("decimal", path, "must be a non-negative decimal string");
  return value;
}

/** @param {unknown} value @param {string} path */
function jsonValue(value, path) {
  try { canonicalBytes(value); } catch (error) {
    if (error instanceof AppDataValidationError) throw new AppDataValidationError(error.code, path + error.path.slice(1), error.message);
    throw error;
  }
}

/** @param {Record<string, unknown>} value @param {string} path */
function smallBudget(value, path) { jsonValue(value, path); }

/** @param {unknown} value @param {string} path */
function cursorString(value, path) {
  try { decodeCursor(value); } catch (error) {
    if (error instanceof AppDataValidationError) throw new AppDataValidationError(error.code, path + error.path.slice(1), error.message);
    throw error;
  }
}

/** @param {unknown} value @param {string} path */
function validateSyncLeaseShape(value, path) {
  const record = object(value, path);
  fields(record, ["ownerTabId", "fence", "expiresAt"], ["ownerTabId", "fence", "expiresAt"], path);
  uuid(record.ownerTabId, `${path}.ownerTabId`);
  if (integer(record.fence, `${path}.fence`) < 1) fail("range", `${path}.fence`, "must be positive");
  integer(record.expiresAt, `${path}.expiresAt`);
  return record;
}

/** @param {unknown} value @returns {import("./contracts").MetaRecord} */
export function validateMetaRecord(value) {
  const record = object(value, "$");
  fields(record, ["key", "value"], ["key", "value"], "$");
  if (typeof record.key !== "string" || !META_KEYS.has(record.key)) fail("enum", "$.key", "unknown meta key");
  switch (record.key) {
    case "clientStreamId":
    case "serverLogEpoch": uuid(record.value, "$.value"); break;
    case "clientSeq":
    case "clockHighWaterMs":
    case "projectionInvalidationRevision":
    case "projectionAppliedRevision": nonNegative(record.value, "$.value"); break;
    case "appliedPullCursor": cursorString(record.value, "$.value"); break;
    case "schemaVersion": if (record.value !== 1 && record.value !== APP_DATA_DB_SCHEMA_VERSION) fail("version", "$.value", "unsupported database schemaVersion"); break;
    case "projectionVersion": if (record.value !== 1) fail("version", "$.value", "only projectionVersion 1 is supported"); break;
    case "syncCoordinatorLease": validateSyncLeaseShape(record.value, "$.value"); break;
  }
  smallBudget(record, "$");
  return /** @type {import("./contracts").MetaRecord} */ (value);
}

/** @param {unknown} value @returns {import("./contracts").SyncCoordinatorLease} */
export function validateSyncCoordinatorLease(value) {
  const result = validateSyncLeaseShape(value, "$");
  smallBudget(result, "$");
  return /** @type {import("./contracts").SyncCoordinatorLease} */ (value);
}

/** @param {unknown} invalidationRecord @param {unknown} appliedRecord @returns {import("./contracts").ProjectionMeta} */
export function validateProjectionMeta(invalidationRecord, appliedRecord) {
  const invalidation = validateMetaRecord(invalidationRecord);
  const applied = validateMetaRecord(appliedRecord);
  if (invalidation.key !== "projectionInvalidationRevision") fail("key", "$.invalidationRecord.key", "must be projectionInvalidationRevision");
  if (applied.key !== "projectionAppliedRevision") fail("key", "$.appliedRecord.key", "must be projectionAppliedRevision");
  if (/** @type {number} */ (applied.value) > /** @type {number} */ (invalidation.value)) fail("invariant", "$.appliedRecord.value", "applied revision cannot exceed invalidation revision");
  return { invalidationRevision: invalidation.value, appliedRevision: applied.value };
}

/** @param {unknown} value @param {string} path @returns {import("./contracts").VerificationJournal} */
export function validateVerificationJournal(value, path = "$") {
  const record = object(value, path);
  fields(record, ["jobId", "schemaVersion", "contentDigest", "recordCount", "verifiedAt"], ["jobId", "schemaVersion", "contentDigest", "recordCount", "verifiedAt"], path);
  uuid(record.jobId, `${path}.jobId`);
  if (record.schemaVersion !== 1) fail("version", `${path}.schemaVersion`, "only verification schemaVersion 1 is supported");
  digest(record.contentDigest, `${path}.contentDigest`);
  nonNegative(record.recordCount, `${path}.recordCount`);
  nonEmptyString(record.verifiedAt, `${path}.verifiedAt`);
  smallBudget(record, path);
  return /** @type {import("./contracts").VerificationJournal} */ (value);
}

/** @param {unknown} value @returns {import("./contracts").ProfileRegistryRecord} */
export function validateProfileRegistryRecord(value) {
  const record = object(value, "$");
  fields(record, ["profileId", "dbName", "ownerKind", "accountId", "accountGeneration", "state", "schemaVersion", "importJobId", "verification", "lastVerifiedAt"], ["profileId", "dbName", "ownerKind", "state", "schemaVersion"], "$");
  uuid(record.profileId, "$.profileId");
  const dbName = nonEmptyString(record.dbName, "$.dbName");
  if (!DB_NAME_RE.test(dbName)) fail("identifier", "$.dbName", "dbName must be a generated safe database name");
  if (record.ownerKind !== "guest" && record.ownerKind !== "account") fail("enum", "$.ownerKind", "ownerKind must be guest or account");
  if (record.ownerKind === "guest") {
    if (Object.hasOwn(record, "accountId") || Object.hasOwn(record, "accountGeneration")) fail("invariant", "$.ownerKind", "guest profiles cannot carry account identity");
  } else {
    if (!Object.hasOwn(record, "accountId") || !Object.hasOwn(record, "accountGeneration")) fail("required", "$", "account profiles require accountId and accountGeneration");
    nonEmptyString(record.accountId, "$.accountId");
    if (utf8ByteLength(/** @type {string} */ (record.accountId)) > 512) fail("utf8_limit", "$.accountId", "accountId exceeds 512 UTF-8 bytes");
    uuid(record.accountGeneration, "$.accountGeneration");
  }
  if (!PROFILE_STATES.has(/** @type {string} */ (record.state))) fail("enum", "$.state", "invalid profile state");
  if (record.schemaVersion !== 1 && record.schemaVersion !== APP_DATA_DB_SCHEMA_VERSION) fail("version", "$.schemaVersion", "unsupported database schemaVersion");
  if (Object.hasOwn(record, "importJobId")) uuid(record.importJobId, "$.importJobId");
  if (Object.hasOwn(record, "verification")) validateVerificationJournal(record.verification, "$.verification");
  if (Object.hasOwn(record, "lastVerifiedAt")) {
    nonEmptyString(record.lastVerifiedAt, "$.lastVerifiedAt");
    if (!Object.hasOwn(record, "verification")) fail("invariant", "$.lastVerifiedAt", "lastVerifiedAt requires verification");
    if (record.lastVerifiedAt !== /** @type {{verifiedAt:string}} */ (record.verification).verifiedAt) fail("invariant", "$.lastVerifiedAt", "lastVerifiedAt must equal verification.verifiedAt");
  }
  if (Object.hasOwn(record, "verification") && Object.hasOwn(record, "importJobId") && record.importJobId !== /** @type {{jobId:string}} */ (record.verification).jobId) fail("invariant", "$.importJobId", "importJobId must match verification.jobId");
  if (record.state === "ready" && !Object.hasOwn(record, "verification")) fail("verification", "$.verification", "ready requires a verification journal");
  smallBudget(record, "$");
  return /** @type {import("./contracts").ProfileRegistryRecord} */ (value);
}

/** @param {unknown} value @returns {import("./contracts").ActiveProfilePointer} */
export function validateActiveProfilePointer(value) {
  const record = object(value, "$");
  fields(record, ["key", "activeProfileId", "activationRevision"], ["key", "activeProfileId", "activationRevision"], "$");
  if (record.key !== "activeProfile") fail("enum", "$.key", "key must be activeProfile");
  uuid(record.activeProfileId, "$.activeProfileId");
  if (integer(record.activationRevision, "$.activationRevision") < 1) fail("range", "$.activationRevision", "activationRevision must be positive");
  smallBudget(record, "$");
  return /** @type {import("./contracts").ActiveProfilePointer} */ (value);
}

/** @param {unknown} value */
function validateContentChunkRecordHead(value) {
  const record = object(value, "$");
  fields(record, ["contentDigest", "chunkIndex", "bytes"], ["contentDigest", "chunkIndex", "bytes"], "$");
  digest(record.contentDigest, "$.contentDigest");
  const chunkIndex = integer(record.chunkIndex, "$.chunkIndex");
  if (chunkIndex < 0 || chunkIndex > 199) fail("range", "$.chunkIndex", "chunkIndex must be 0..199");
  const bytes = /** @type {Uint8Array} */ (record.bytes);
  if (bytes === null || typeof bytes !== "object" || Object.getPrototypeOf(bytes) !== Uint8Array.prototype) fail("chunk", "$.bytes", "bytes must be a native Uint8Array");
  for (const name of ["buffer", "byteLength", "length"]) {
    const descriptor = Object.getOwnPropertyDescriptor(bytes, name);
    if (descriptor) fail("chunk", "$.bytes", "bytes may not shadow native typed-array accessors");
  }
  const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
  const tagGetter = /** @type {((this: Uint8Array) => string | undefined) | undefined} */ (Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)?.get);
  const bufferGetter = /** @type {((this: Uint8Array) => ArrayBuffer) | undefined} */ (Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get);
  const byteLengthGetter = /** @type {((this: Uint8Array) => number) | undefined} */ (Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get);
  const lengthGetter = /** @type {((this: Uint8Array) => number) | undefined} */ (Object.getOwnPropertyDescriptor(typedArrayPrototype, "length")?.get);
  if (!tagGetter || !bufferGetter || !byteLengthGetter || !lengthGetter) fail("chunk", "$.bytes", "native typed-array accessors are unavailable");
  let buffer;
  let byteLength;
  let length;
  try {
    // Use the intrinsic tag getter directly so an own Symbol.toStringTag
    // accessor is never invoked.  Re-prototyped Uint16/Uint8Clamped arrays
    // retain their internal brand and are rejected here.
    if (tagGetter.call(bytes) !== "Uint8Array") fail("chunk", "$.bytes", "bytes must be a native Uint8Array");
    // Calling the intrinsic accessors is the brand check.  A plain object
    // inheriting Uint8Array.prototype (or a re-prototyped other typed array)
    // reaches this point but must become our stable validation error rather
    // than leaking the native TypeError.
    buffer = bufferGetter.call(bytes);
    byteLength = byteLengthGetter.call(bytes);
    length = lengthGetter.call(bytes);
  } catch {
    fail("chunk", "$.bytes", "bytes must be a live native Uint8Array");
  }
  if (!(buffer instanceof ArrayBuffer) || Object.getPrototypeOf(buffer) !== ArrayBuffer.prototype) fail("chunk", "$.bytes", "bytes must use a non-shared ArrayBuffer");
  if (byteLength < 1 || byteLength > APP_DATA_LIMITS.maxContentChunkBytes) fail("chunk", "$.bytes", "bytes must be 1..512 KiB");
  return { record, bytes, length };
}

/** Public inputs keep the complete own-key check.
 * @param {unknown} value @returns {import("./contracts").ContentChunkRecord} */
export function validateContentChunkRecord(value) {
  const { record, bytes, length } = validateContentChunkRecordHead(value);
  // The branded live Uint8Array has exactly length integer-index own keys;
  // integer-index exotic invariants keep them enumerable data properties.
  // Any custom string or symbol therefore increases this count.
  if (Reflect.ownKeys(bytes).length !== length) fail("chunk", "$.bytes", "bytes may not have custom properties");
  const header = { contentDigest: record.contentDigest, chunkIndex: record.chunkIndex };
  smallBudget(header, "$");
  return /** @type {import("./contracts").ContentChunkRecord} */ (value);
}

// Internal module export only; deliberately not exported by app-data/index.js.
// Callers obtain either a fresh private native IDB value, or an inaccessible
// native Uint8Array copy recorded by ownedWriteInput after strict preflight.
// Neither native deserialization nor native constructor+set copies custom keys.
// Public/unknown arrays must continue through the complete own-key validator.
/** @param {unknown} value @returns {import("./contracts").ContentChunkRecord} */
export function validateContentChunkRecordForFreshNativeRead(value) {
  const { record } = validateContentChunkRecordHead(value);
  smallBudget({ contentDigest: record.contentDigest, chunkIndex: record.chunkIndex }, "$");
  return /** @type {import("./contracts").ContentChunkRecord} */ (value);
}

/** @param {unknown} value @returns {import("./contracts").UserStateRecord} */
export function validateUserStateRecord(value) {
  const record = object(value, "$");
  fields(record, ["questionKey", "field", "value", "starredKey", "serverRevision"], ["questionKey", "field", "value"], "$");
  if (!isQuestionKey(record.questionKey)) fail("question_key", "$.questionKey", "must be a bankUid/questionUid key");
  if (record.field !== "starred") fail("enum", "$.field", "only starred user state is supported");
  if (typeof record.value !== "boolean") fail("type", "$.value", "starred value must be boolean");
  if (Object.hasOwn(record, "starredKey") && record.starredKey !== (record.value ? 1 : 0)) fail("invariant", "$.starredKey", "starredKey must match value");
  if (Object.hasOwn(record, "serverRevision")) nonNegative(record.serverRevision, "$.serverRevision");
  smallBudget(record, "$");
  return /** @type {import("./contracts").UserStateRecord} */ (value);
}

/** @param {unknown} value @returns {import("./contracts").OutboxRecord} */
export function validateOutboxRecord(value) {
  const record = object(value, "$");
  fields(record, ["mutationId", "nextAttemptAt", "attemptCount"], ["mutationId", "nextAttemptAt", "attemptCount"], "$");
  uuid(record.mutationId, "$.mutationId"); integer(record.nextAttemptAt, "$.nextAttemptAt"); nonNegative(record.attemptCount, "$.attemptCount");
  smallBudget(record, "$");
  return /** @type {import("./contracts").OutboxRecord} */ (value);
}

/** @param {unknown} value @returns {import("./contracts").LegacyEvidence} */
export function validateLegacyEvidence(value) {
  const record = object(value, "$");
  fields(record, ["sourceId", "sourceDigest", "sourceOrigin", "namespace", "rawFormat", "rawBytes", "disposition"], ["sourceId", "sourceDigest", "sourceOrigin", "namespace", "rawFormat", "rawBytes", "disposition"], "$");
  for (const name of ["sourceId", "sourceOrigin", "namespace", "rawFormat"]) nonEmptyString(record[name], `$.${name}`);
  digest(record.sourceDigest, "$.sourceDigest"); nonNegative(record.rawBytes, "$.rawBytes");
  if (!["mapped", "unknown", "quarantined"].includes(/** @type {string} */ (record.disposition))) fail("enum", "$.disposition", "invalid legacy disposition");
  smallBudget(record, "$");
  return /** @type {import("./contracts").LegacyEvidence} */ (value);
}

/** @param {unknown} value @returns {import("./contracts").LegacyRawRecord} */
export function validateLegacyRawRecord(value) {
  const record = object(value, "$");
  fields(record, ["sourceId", "sourceDigest", "sourceOrigin", "namespace", "rawFormat", "rawBytes", "disposition", "chunkIndex", "raw"], ["sourceId", "sourceDigest", "sourceOrigin", "namespace", "rawFormat", "rawBytes", "disposition", "chunkIndex", "raw"], "$");
  validateLegacyEvidence({ sourceId: record.sourceId, sourceDigest: record.sourceDigest, sourceOrigin: record.sourceOrigin, namespace: record.namespace, rawFormat: record.rawFormat, rawBytes: record.rawBytes, disposition: record.disposition });
  nonNegative(record.chunkIndex, "$.chunkIndex"); string(record.raw, "$.raw"); smallBudget(record, "$");
  return /** @type {import("./contracts").LegacyRawRecord} */ (value);
}

/** @param {unknown} value @returns {import("./contracts").LegacyAggregateRecord} */
export function validateLegacyAggregateRecord(value) {
  const record = object(value, "$");
  fields(record, ["sourceId", "sourceDigest", "sourceOrigin", "namespace", "rawFormat", "rawBytes", "disposition", "legacyQuestionId", "aggregate", "mappingStatus"], ["sourceId", "sourceDigest", "sourceOrigin", "namespace", "rawFormat", "rawBytes", "disposition", "legacyQuestionId", "aggregate", "mappingStatus"], "$");
  validateLegacyEvidence({ sourceId: record.sourceId, sourceDigest: record.sourceDigest, sourceOrigin: record.sourceOrigin, namespace: record.namespace, rawFormat: record.rawFormat, rawBytes: record.rawBytes, disposition: record.disposition });
  string(record.legacyQuestionId, "$.legacyQuestionId"); jsonValue(record.aggregate, "$.aggregate");
  if (!["mapped", "unknown", "quarantined"].includes(/** @type {string} */ (record.mappingStatus))) fail("enum", "$.mappingStatus", "invalid mapping status");
  smallBudget(record, "$");
  return /** @type {import("./contracts").LegacyAggregateRecord} */ (value);
}

/** @param {unknown} value @returns {import("./contracts").MigrationJournalRecord} */
export function validateMigrationJournalRecord(value) {
  const record = object(value, "$");
  fields(record, ["migrationId", "status", "counts", "checkpoint", "errors"], ["migrationId", "status", "counts"], "$");
  uuid(record.migrationId, "$.migrationId");
  if (!MIGRATION_STATES.has(/** @type {string} */ (record.status))) fail("enum", "$.status", "invalid local migration status");
  jsonValue(record.counts, "$.counts");
  if (Object.hasOwn(record, "checkpoint")) jsonValue(record.checkpoint, "$.checkpoint");
  if (Object.hasOwn(record, "errors")) jsonValue(record.errors, "$.errors");
  smallBudget(record, "$");
  return /** @type {import("./contracts").MigrationJournalRecord} */ (value);
}

/** @param {unknown} value @returns {import("./contracts").ImportReceiptRecord} */
export function validateImportReceiptRecord(value) {
  const record = object(value, "$");
  fields(record, ["sourceId", "sourceRecordId", "provenance", "importedAt"], ["sourceId", "sourceRecordId", "provenance", "importedAt"], "$");
  string(record.sourceId, "$.sourceId"); string(record.sourceRecordId, "$.sourceRecordId"); jsonValue(record.provenance, "$.provenance"); integer(record.importedAt, "$.importedAt");
  smallBudget(record, "$");
  const provenance = record.provenance;
  if(record.sourceId === "qb-snapshot-continuation-receipt-v1" || provenance !== null && typeof provenance === "object" && "format" in provenance && provenance.format === "qb-snapshot-continuation-receipt-v1") validateSnapshotContinuationReceipt(record);
  return /** @type {import("./contracts").ImportReceiptRecord} */ (value);
}

/** @param {unknown} value @returns {import("./contracts").CheckpointRecord} */
export function validateCheckpointRecord(value) {
  const record = object(value, "$");
  fields(record, ["checkpointId", "createdAt", "manifest"], ["checkpointId", "createdAt", "manifest"], "$");
  uuid(record.checkpointId, "$.checkpointId"); integer(record.createdAt, "$.createdAt"); validateExportManifest(record.manifest);
  smallBudget(record, "$");
  return /** @type {import("./contracts").CheckpointRecord} */ (value);
}

/** @param {unknown} value @returns {import("./contracts").EntityTombstoneRecord} */
export function validateEntityTombstoneRecord(value) {
  const record = object(value, "$");
  fields(record, ["entityKey", "entityKind", "entityId", "status", "accountGeneration", "sourceMutationId", "serverSeq"], ["entityKey", "entityKind", "entityId", "status"], "$");
  if (record.entityKind !== "bank" && record.entityKind !== "attempt" && record.entityKind !== 'history_snapshot') fail("enum", "$.entityKind", "invalid tombstone entity kind");
  uuid(record.entityId, "$.entityId");
  if (record.entityKey !== `${record.entityKind}:${record.entityId}`) fail("entity_key", "$.entityKey", "entityKey must match kind and id");
  if (record.status !== "pending" && record.status !== "confirmed") fail("enum", "$.status", "invalid tombstone status");
  if (Object.hasOwn(record, "accountGeneration")) uuid(record.accountGeneration, "$.accountGeneration");
  if (Object.hasOwn(record, "sourceMutationId")) uuid(record.sourceMutationId, "$.sourceMutationId");
  if (record.status === "confirmed") {
    if (!Object.hasOwn(record, "accountGeneration") || !Object.hasOwn(record, "serverSeq")) fail("required", "$", "confirmed tombstones require accountGeneration and serverSeq");
    decimal(record.serverSeq, "$.serverSeq");
  } else if (Object.hasOwn(record, "serverSeq")) fail("invariant", "$.serverSeq", "pending tombstones cannot carry serverSeq");
  smallBudget(record, "$");
  return /** @type {import("./contracts").EntityTombstoneRecord} */ (value);
}

/** @param {unknown} value @returns {import("./contracts").WriterLease} */
export function validateLease(value) {
  const record = object(value, "$");
  fields(record, ["attemptId", "ownerTabId", "fence", "expiresAt"], ["attemptId", "ownerTabId", "fence", "expiresAt"], "$");
  uuid(record.attemptId, "$.attemptId"); uuid(record.ownerTabId, "$.ownerTabId"); if (integer(record.fence, "$.fence") < 1) fail("range", "$.fence", "fence must be positive"); integer(record.expiresAt, "$.expiresAt");
  smallBudget(record, "$");
  return /** @type {import("./contracts").WriterLease} */ (value);
}

/** @param {unknown} value @returns {import("./contracts").WriterLeaseRecord} */
export function validateWriterLeaseRecord(value) {
  const record = object(value, "$");
  fields(record, ["attemptId", "ownerTabId", "fence", "expiresAt", "exportExcluded"], ["attemptId", "ownerTabId", "fence", "expiresAt", "exportExcluded"], "$");
  validateLease({ attemptId: record.attemptId, ownerTabId: record.ownerTabId, fence: record.fence, expiresAt: record.expiresAt });
  if (record.exportExcluded !== true) fail("invariant", "$.exportExcluded", "writer lease records must be excluded from export/import/reset");
  smallBudget(record, "$");
  return /** @type {import("./contracts").WriterLeaseRecord} */ (value);
}

export const LOCAL_STORE_VALIDATORS = Object.freeze({
  meta: validateMetaRecord,
  bank_revisions: validateBankRevisionRecord,
  content_chunks: validateContentChunkRecord,
  question_aliases: validateAlias,
  user_state: validateUserStateRecord,
  outbox: validateOutboxRecord,
  legacy_raw: validateLegacyRawRecord,
  legacy_aggregates: validateLegacyAggregateRecord,
  migration_journal: validateMigrationJournalRecord,
  import_receipts: validateImportReceiptRecord,
  checkpoints: validateCheckpointRecord,
  entity_tombstones: validateEntityTombstoneRecord,
  writer_leases: validateWriterLeaseRecord
});

export const LOCAL_STORE_RECORD_VALIDATORS = LOCAL_STORE_VALIDATORS;
