import { isUuid } from "../question/index.js";
import { APP_DATA_EXCHANGE_SCHEMA_VERSION, APP_DATA_LIMITS } from "./constants.js";
import { AppDataValidationError, canonicalBytes, utf8ByteLength } from "./canonical.js";

const DIGEST_RE = /^[0-9a-f]{64}$/;
const DECIMAL_RE = /^(0|[1-9][0-9]{0,19})$/;
const COVERAGE_KEYS = ["facts", "attempts", "drafts", "mutations", "outbox", "conflicts", "tombstones", "legacy", "content"];
const SAFE_PATH_RE = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;

/** @param {string} code @param {string} path @param {string} message @returns {never} */
function fail(code, path, message) { throw new AppDataValidationError(code, path, message); }
/** @param {unknown} value @param {string} path */
function object(value, path) { if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail("type", path, "must be a plain object"); return /** @type {Record<string, unknown>} */ (value); }
/** @param {Record<string, unknown>} value @param {string[]} required @param {string[]} optional @param {string} path */
function exact(value, required, optional, path) { const allowed = new Set([...required, ...optional]); for (const key of Reflect.ownKeys(value)) { if (typeof key !== "string" || !allowed.has(key)) fail("unknown_field", `${path}.${String(key)}`, "unknown field"); } for (const key of required) if (!Object.hasOwn(value, key)) fail("required", `${path}.${key}`, "required field is missing"); }
/** @param {unknown} value @param {string} path */
function text(value, path) { if (typeof value !== "string" || value.length === 0 || utf8ByteLength(value) > APP_DATA_LIMITS.maxStringUtf8Bytes) fail("string", path, "must be a bounded non-empty string"); return value; }
/** @param {unknown} value @param {string} path */
function uuid(value, path) { if (typeof value !== "string" || !isUuid(value)) fail("uuid", path, "must be a canonical lowercase UUID"); return value; }
/** @param {unknown} value @param {string} path */
function digest(value, path) { if (typeof value !== "string" || !DIGEST_RE.test(value)) fail("digest", path, "must be a lowercase SHA-256 digest"); return value; }
/** @param {unknown} value @param {string} path */
function decimal(value, path) { if (typeof value !== "string" || !DECIMAL_RE.test(value)) fail("decimal", path, "must be a non-negative decimal string"); return value; }
/** @param {unknown} value @param {string} path @returns {number} */
function nonNegative(value, path) { const number = /** @type {number} */ (value); if (!Number.isSafeInteger(number) || number < 0) fail("integer", path, "must be a non-negative safe integer"); return number; }

/** @param {unknown} value @param {string} path */
function section(value, path) {
  const item = object(value, path); exact(item, ["path", "count", "utf8Bytes", "sha256"], [], path);
  const file = text(item.path, `${path}.path`);
  if (utf8ByteLength(file) > 256 || !SAFE_PATH_RE.test(file) || file.split("/").some((part) => part === "." || part === "..")) fail("path", `${path}.path`, "must be a unique safe relative archive path");
  nonNegative(item.count, `${path}.count`); nonNegative(item.utf8Bytes, `${path}.utf8Bytes`); digest(item.sha256, `${path}.sha256`);
  return file;
}

/** @param {unknown} value @returns {import("./contracts").ExportManifest} */
export function validateExportManifest(value) {
  canonicalBytes(value);
  const record = object(value, "$");
  const sync = ["accountGeneration", "serverLogEpoch", "exportCut", "throughServerSeq"];
  exact(record, ["format", "schemaVersion", "exportId", "appVersion", "sourceProfileHint", "sections", "legacySourceDigests", "complete", "partial", "coverage", "partialReasons"], [...sync, 'storeSetVersion'], "$");
  if (Object.hasOwn(record, 'storeSetVersion') && record.storeSetVersion !== 1 && record.storeSetVersion !== 2) fail('version', '$.storeSetVersion', 'unsupported portable store layout');
  if (record.format !== "qb-appdata-v2") fail("format", "$.format", "unsupported export format");
  if (record.schemaVersion !== APP_DATA_EXCHANGE_SCHEMA_VERSION) fail("version", "$.schemaVersion", "only exchange schema version 2 is supported");
  uuid(record.exportId, "$.exportId");
  if (typeof record.appVersion !== "string" || record.appVersion.length === 0 || utf8ByteLength(record.appVersion) > 128) fail("string", "$.appVersion", "appVersion must be 1..128 UTF-8 bytes");
  if (typeof record.sourceProfileHint !== "string" || utf8ByteLength(record.sourceProfileHint) > 256) fail("string", "$.sourceProfileHint", "source profile hint must be a bounded string");
  if (!Array.isArray(record.sections) || record.sections.length === 0 || record.sections.length > APP_DATA_LIMITS.maxArrayItems) fail("sections", "$.sections", "sections must be a non-empty bounded array");
  const paths = new Set(); for (let i = 0; i < record.sections.length; i += 1) { const file = section(record.sections[i], `$.sections[${i}]`); if (paths.has(file)) fail("duplicate", `$.sections[${i}].path`, "section path must be unique"); paths.add(file); }
  if (!Array.isArray(record.legacySourceDigests)) fail("type", "$.legacySourceDigests", "must be an array");
  const digests = new Set(); for (let i = 0; i < record.legacySourceDigests.length; i += 1) { const item = digest(record.legacySourceDigests[i], `$.legacySourceDigests[${i}]`); if (digests.has(item)) fail("duplicate", `$.legacySourceDigests[${i}]`, "legacy source digest duplicated"); digests.add(item); }
  if (typeof record.complete !== "boolean" || typeof record.partial !== "boolean" || record.complete === record.partial) fail("invariant", "$", "exactly one of complete and partial must be true");
  const coverage = object(record.coverage, "$.coverage"); exact(coverage, COVERAGE_KEYS, [], "$.coverage"); for (const key of COVERAGE_KEYS) if (typeof coverage[key] !== "boolean") fail("type", `$.coverage.${key}`, "coverage flag must be boolean");
  if (!Array.isArray(record.partialReasons)) fail("type", "$.partialReasons", "must be an array");
  const reasons = new Set(); for (let i = 0; i < record.partialReasons.length; i += 1) { const reason = text(record.partialReasons[i], `$.partialReasons[${i}]`); if (utf8ByteLength(reason) > 128) fail("string", `$.partialReasons[${i}]`, "partial reason is too long"); if (reasons.has(reason)) fail("duplicate", `$.partialReasons[${i}]`, "partial reason duplicated"); reasons.add(reason); }
  const allCovered = COVERAGE_KEYS.every((key) => coverage[key] === true);
  if (record.complete && (!allCovered || reasons.size !== 0)) fail("invariant", "$", "complete manifest must cover every category and have no partial reasons");
  if (record.partial && reasons.size === 0) fail("required", "$.partialReasons", "partial manifest must explain omissions");
  const present = sync.map((key) => Object.hasOwn(record, key));
  if (present.some(Boolean) && !present.every(Boolean)) fail("invariant", "$", "cloud cut fields must be all present or all absent");
  if (present.every(Boolean)) { uuid(record.accountGeneration, "$.accountGeneration"); uuid(record.serverLogEpoch, "$.serverLogEpoch"); decimal(record.exportCut, "$.exportCut"); decimal(record.throughServerSeq, "$.throughServerSeq"); if (record.exportCut !== record.throughServerSeq) fail("invariant", "$.throughServerSeq", "throughServerSeq must equal exportCut"); }
  return /** @type {import("./contracts").ExportManifest} */ (value);
}

export { COVERAGE_KEYS };
