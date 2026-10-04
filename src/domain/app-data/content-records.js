import { isUuid } from "../question/index.js";
import { AppDataValidationError, canonicalBytes, utf8ByteLength } from "./canonical.js";
import { APP_DATA_CONTENT_LIMITS, APP_DATA_LIMITS } from "./constants.js";

const DIGEST_RE = /^[0-9a-f]{64}$/;
const MAX_CONTENT_BYTES = 100 * 1024 * 1024;
const MAX_CHUNKS = 200;
const MAX_MANIFEST_BYTES = 128 * 1024;

/** @param {string} code @param {string} path @param {string} message @returns {never} */
function fail(code, path, message) { throw new AppDataValidationError(code, path, message); }
/** @param {unknown} value @param {string} path @returns {Record<string, any>} */
function object(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("type", path, "must be a plain object");
  if (Object.getPrototypeOf(value) !== Object.prototype) fail("prototype", path, "must use Object.prototype");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") fail("symbol", path, "symbol keys are not JSON");
    const name = String(key);
    const descriptor = descriptors[name];
    if (!descriptor) fail("accessor", `${path}.${name}`, "accessors are not JSON");
    if (!Object.hasOwn(descriptor, "value")) fail("accessor", `${path}.${name}`, "accessors are not JSON");
    if (!descriptor.enumerable) fail("non_enumerable", `${path}.${name}`, "non-enumerable fields are not permitted");
  }
  return /** @type {Record<string, any>} */ (value);
}
/** @param {Record<string, any>} value @param {string[]} allowed @param {string[]} required @param {string} path */
function fields(value, allowed, required, path) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail("unknown_field", `${path}.${key}`, "unknown field is not permitted");
  for (const key of required) if (!Object.hasOwn(value, key)) fail("required", `${path}.${key}`, "required field is missing");
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
function digest(value, path) {
  if (typeof value !== "string" || !DIGEST_RE.test(value)) fail("digest", path, "must be a lowercase SHA-256 hex digest");
  return value;
}
/** @param {unknown} value @param {string} path @returns {string} */
function uuid(value, path) {
  if (!isUuid(value)) fail("uuid", path, "must be a canonical lowercase UUID");
  return value;
}
/** @param {unknown} value @param {string} path @param {number} [maximum] @returns {string} */
function text(value, path, maximum = APP_DATA_LIMITS.maxStringUtf8Bytes) {
  if (typeof value !== "string") fail("type", path, "must be a string");
  const result = /** @type {string} */ (value);
  const bytes = utf8ByteLength(result);
  if (bytes > maximum) fail("utf8_limit", path, "string exceeds the configured UTF-8 limit");
  return result;
}
/** @param {unknown} value @param {string} path @param {number} [maximum] @returns {string} */
function nonEmptyText(value, path, maximum = APP_DATA_LIMITS.maxStringUtf8Bytes) {
  const result = text(value, path, maximum);
  if (result.length === 0) fail("range", path, "must be non-empty");
  return result;
}

/** Apply the ordinary small-DTO budget after shape validation.  canonicalBytes
 * uses the already accepted bounded writer, so an over-limit escaped string is
 * rejected before JSON.stringify can allocate the oversized representation. */
/** @param {unknown} value @param {string} path */
function assertSmallDtoBudget(value, path) {
  try {
    canonicalBytes(value);
  } catch (error) {
    if (error instanceof AppDataValidationError) {
      throw new AppDataValidationError(error.code, path + error.path.slice(1), error.message);
    }
    throw error;
  }
}
/** @param {unknown} value @param {string} path @returns {string} */
function staticReference(value, path) {
  const result = nonEmptyText(value, path, 2048);
  if (/[\\%:?#\u0000-\u001f\u007f]/u.test(result)) fail("path", path, "staticRef contains a forbidden unencoded path character");
  for (let index = 0; index < result.length; index += 1) {
    const code = result.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = result.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail("path", path, "staticRef may not contain an unpaired surrogate");
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) fail("path", path, "staticRef may not contain an unpaired surrogate");
  }
  if (result.startsWith("/") || result.endsWith("/")) fail("path", path, "staticRef must be root-relative without leading or trailing slash");
  for (const segment of result.split("/")) if (segment.length === 0 || segment === "." || segment === "..") fail("path", path, "staticRef contains an empty or traversal segment");
  return result;
}
/** @param {unknown} value @param {string} path @param {number} maximum @returns {any[]} */
function array(value, path, maximum) {
  if (!Array.isArray(value)) fail("type", path, "must be an array");
  if (Object.getPrototypeOf(value) !== Array.prototype) fail("prototype", path, "array must use Array.prototype");
  if (value.length > maximum) fail("array_limit", path, "array exceeds the configured item limit");
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor) fail("array_hole", `${path}[${index}]`, "array holes/accessors are not permitted");
    if (!Object.hasOwn(descriptor, "value")) fail("array_hole", `${path}[${index}]`, "array holes/accessors are not permitted");
    if (!descriptor.enumerable) fail("non_enumerable", `${path}[${index}]`, "non-enumerable array elements are not permitted");
  }
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) fail("array_property", path, "arrays may not have non-index properties");
  }
  return value;
}

/** @param {unknown} value @param {string} path @returns {import("./contracts").ContentReference} */
export function validateContentReference(value, path = "$") {
  const record = object(value, path);
  fields(record, ["contentDigest", "manifestDigest", "chunkCount", "totalBytes"], ["contentDigest", "manifestDigest", "chunkCount", "totalBytes"], path);
  digest(record.contentDigest, `${path}.contentDigest`);
  digest(record.manifestDigest, `${path}.manifestDigest`);
  const chunkCount = nonNegative(record.chunkCount, `${path}.chunkCount`);
  const totalBytes = nonNegative(record.totalBytes, `${path}.totalBytes`);
  if (chunkCount > MAX_CHUNKS) fail("range", `${path}.chunkCount`, "chunkCount exceeds 200");
  if (totalBytes > MAX_CONTENT_BYTES) fail("range", `${path}.totalBytes`, "totalBytes exceeds 100 MiB");
  if ((chunkCount === 0) !== (totalBytes === 0)) fail("invariant", path, "zero-byte references require zero chunks and vice versa");
  return /** @type {import("./contracts").ContentReference} */ (value);
}

/** @param {unknown} value @param {string} path @returns {import("./contracts").ChunkManifest} */
export function validateChunkManifest(value, path = "$") {
  const record = object(value, path);
  fields(record, ["schemaVersion", "contentDigest", "totalBytes", "chunkCount", "chunks"], ["schemaVersion", "contentDigest", "totalBytes", "chunkCount", "chunks"], path);
  if (record.schemaVersion !== 1) fail("version", `${path}.schemaVersion`, "only manifest schemaVersion 1 is supported");
  digest(record.contentDigest, `${path}.contentDigest`);
  const totalBytes = nonNegative(record.totalBytes, `${path}.totalBytes`);
  if (totalBytes > MAX_CONTENT_BYTES) fail("range", `${path}.totalBytes`, "totalBytes exceeds 100 MiB");
  const chunkCount = nonNegative(record.chunkCount, `${path}.chunkCount`);
  if (chunkCount > MAX_CHUNKS) fail("range", `${path}.chunkCount`, "chunkCount exceeds 200");
  const chunks = array(record.chunks, `${path}.chunks`, MAX_CHUNKS);
  if (chunks.length !== chunkCount) fail("invariant", `${path}.chunkCount`, "chunkCount must equal chunks.length");
  let sum = 0;
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = object(chunks[index], `${path}.chunks[${index}]`);
    fields(chunk, ["chunkIndex", "byteLength", "sha256"], ["chunkIndex", "byteLength", "sha256"], `${path}.chunks[${index}]`);
    if (integer(chunk.chunkIndex, `${path}.chunks[${index}].chunkIndex`) !== index) fail("invariant", `${path}.chunks[${index}].chunkIndex`, "chunkIndex must be continuous from zero");
    const byteLength = integer(chunk.byteLength, `${path}.chunks[${index}].byteLength`);
    if (byteLength < 1 || byteLength > APP_DATA_LIMITS.maxContentChunkBytes) fail("range", `${path}.chunks[${index}].byteLength`, "chunk byteLength must be 1..512 KiB");
    digest(chunk.sha256, `${path}.chunks[${index}].sha256`);
    sum += byteLength;
    if (sum > MAX_CONTENT_BYTES) fail("range", `${path}.chunks`, "chunk bytes exceed 100 MiB");
  }
  if (chunkCount === 0 && totalBytes !== 0) fail("invariant", path, "empty chunks require totalBytes zero");
  if (chunkCount > 0 && totalBytes === 0) fail("invariant", path, "non-empty chunks require positive totalBytes");
  if (sum !== totalBytes) fail("invariant", `${path}.totalBytes`, "totalBytes must equal chunk byteLength sum");
  const canonical = canonicalBytes(value);
  if (canonical.byteLength > MAX_MANIFEST_BYTES) fail("manifest_limit", path, "canonical manifest exceeds 128 KiB");
  return /** @type {import("./contracts").ChunkManifest} */ (value);
}

/** @param {unknown} value @param {string} path @returns {import("./contracts").BankMetadata} */
export function validateBankMetadata(value, path = "$") {
  const record = object(value, path);
  fields(record, ["title", "questionCount", "visibility"], ["title", "questionCount", "visibility"], path);
  nonEmptyText(record.title, `${path}.title`, 512);
  const questionCount = nonNegative(record.questionCount, `${path}.questionCount`);
  if (questionCount > 5000) fail("range", `${path}.questionCount`, "questionCount exceeds 5000");
  if (!["public", "private", "protected"].includes(record.visibility)) fail("enum", `${path}.visibility`, "invalid bank visibility");
  return /** @type {import("./contracts").BankMetadata} */ (value);
}

/** @param {unknown} value @param {string} path @returns {import("./contracts").ContentManifest} */
export function validateContentManifest(value, path = "$") {
  const record = object(value, path);
  if (record.kind === "public_static") {
    fields(record, ["kind", "staticRef", "contentDigest"], ["kind", "staticRef", "contentDigest"], path);
    staticReference(record.staticRef, `${path}.staticRef`);
    digest(record.contentDigest, `${path}.contentDigest`);
    assertSmallDtoBudget(record, path);
    return /** @type {import("./contracts").ContentManifest} */ (value);
  }
  if (record.kind === "private_chunks" || record.kind === "protected_cipher") {
    fields(record, ["kind", "reference"], ["kind", "reference"], path);
    validateContentReference(record.reference, `${path}.reference`);
    assertSmallDtoBudget(record, path);
    return /** @type {import("./contracts").ContentManifest} */ (value);
  }
  if (record.kind === "unavailable") {
    fields(record, ["kind", "reason"], ["kind", "reason"], path);
    nonEmptyText(record.reason, `${path}.reason`);
    assertSmallDtoBudget(record, path);
    return /** @type {import("./contracts").ContentManifest} */ (value);
  }
  fail("enum", `${path}.kind`, "invalid content manifest kind");
}

/** @param {unknown} value @param {string} path @returns {import("./contracts").BankRevisionRecord} */
export function validateBankRevisionRecord(value, path = "$") {
  const record = object(value, path);
  fields(record, ["bankUid", "revision", "metadata", "contentManifest"], ["bankUid", "revision", "metadata", "contentManifest"], path);
  uuid(record.bankUid, `${path}.bankUid`);
  digest(record.revision, `${path}.revision`);
  const metadata = validateBankMetadata(record.metadata, `${path}.metadata`);
  const contentManifest = validateContentManifest(record.contentManifest, `${path}.contentManifest`);
  if (contentManifest.kind !== "unavailable") {
    const expected = { public: "public_static", private: "private_chunks", protected: "protected_cipher" }[metadata.visibility];
    if (contentManifest.kind !== expected) fail("invariant", `${path}.contentManifest.kind`, "content manifest kind must match metadata visibility");
  }
  // This is deliberately separate from the nested contentManifest budget:
  // the complete bank revision DTO has its own ordinary 3 MiB ceiling.
  assertSmallDtoBudget(record, path);
  return /** @type {import("./contracts").BankRevisionRecord} */ (value);
}

/** @param {unknown} value @param {string} path @returns {import("./contracts").ResumeReference} */
export function validateResumeReference(value, path = "$") {
  const record = object(value, path);
  fields(record, ["schemaVersion", "attemptId", "writerStreamId", "contentDigest", "chunkManifestDigest", "localRevision", "baseRevision"], ["schemaVersion", "attemptId", "writerStreamId", "contentDigest", "chunkManifestDigest", "localRevision", "baseRevision"], path);
  if (record.schemaVersion !== 1) fail("version", `${path}.schemaVersion`, "only resume reference schemaVersion 1 is supported");
  uuid(record.attemptId, `${path}.attemptId`);
  uuid(record.writerStreamId, `${path}.writerStreamId`);
  digest(record.contentDigest, `${path}.contentDigest`);
  digest(record.chunkManifestDigest, `${path}.chunkManifestDigest`);
  if (integer(record.localRevision, `${path}.localRevision`) < 1) fail("range", `${path}.localRevision`, "localRevision must be positive");
  nonNegative(record.baseRevision, `${path}.baseRevision`);
  return /** @type {import("./contracts").ResumeReference} */ (value);
}

export const CONTENT_RECORD_LIMITS = Object.freeze({ maxContentBytes: MAX_CONTENT_BYTES, maxChunks: MAX_CHUNKS, maxManifestBytes: MAX_MANIFEST_BYTES, maxChunkBytes: APP_DATA_LIMITS.maxContentChunkBytes, maxContentCanonicalBytes: APP_DATA_CONTENT_LIMITS.maxCanonicalUtf8Bytes });
