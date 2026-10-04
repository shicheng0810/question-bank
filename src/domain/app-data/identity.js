import { isQuestionKey } from "../question/index.js";
import { ALIAS_KEY_PATH } from "./constants.js";
import { AppDataValidationError, canonicalBytes, utf8ByteLength } from "./canonical.js";

const MAX_SOURCE_ORIGIN_BYTES = 2_048;
const MAX_NAMESPACE_BYTES = 256;
const MAX_ALIAS_COMPONENT_BYTES = 512;
const DIGEST_RE = /^[0-9a-f]{64}$/;

/** @param {string} code @param {string} path @param {string} message @returns {never} */
function fail(code, path, message) { throw new AppDataValidationError(code, path, message); }
/** @param {unknown} value @param {string} path @param {number} maximum @returns {string} */
function text(value, path, maximum = MAX_ALIAS_COMPONENT_BYTES) {
  if (typeof value !== "string" || value.length === 0 || utf8ByteLength(value) > maximum) fail("alias_component", path, `must be non-empty and at most ${maximum} UTF-8 bytes`);
  return value;
}
/** @param {string} value @param {string} path */
function questionKey(value, path) { if (!isQuestionKey(value)) fail("question_key", path, "must be a bankUid/questionUid key"); return value; }

/** A source namespace is opaque data; only URL-origin syntax is interpreted. @param {string} sourceOrigin @param {string} namespace @returns {string} */
export function makeSourceKey(sourceOrigin, namespace) {
  const origin = text(sourceOrigin, "$.sourceOrigin", MAX_SOURCE_ORIGIN_BYTES);
  const name = text(namespace, "$.namespace", MAX_NAMESPACE_BYTES);
  let parsed;
  try { parsed = new URL(origin); } catch { fail("origin", "$.sourceOrigin", "must be a valid origin URL"); }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.origin !== origin || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) fail("origin", "$.sourceOrigin", "must be an explicit http(s) origin without credentials or path");
  return JSON.stringify([origin, name]);
}

/** @param {string} rawId @param {string} runtimeId @returns {string} */
export function makeLegacyId(rawId, runtimeId) { return JSON.stringify([text(rawId, "$.legacyRawId"), text(runtimeId, "$.legacyRuntimeId")]); }

/** @param {unknown} value @returns {import("./contracts").QuestionAliasRecord} */
export function validateAlias(value) {
  canonicalBytes(value);
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail("type", "$", "alias must be a plain object");
  const record = /** @type {Record<string, unknown>} */ (value);
  const allowed = ["sourceOrigin", "namespace", "sourceKey", "legacyRevision", "legacyId", "legacyRawId", "legacyRuntimeId", "mappingStatus", "candidates", "newQuestionKey"];
  for (const key of Object.keys(record)) if (!allowed.includes(key)) fail("unknown_field", `$.${key}`, "unknown alias field");
  for (const key of ["sourceOrigin", "namespace", "sourceKey", "legacyRevision", "legacyId", "legacyRawId", "legacyRuntimeId", "mappingStatus", "candidates"]) if (!Object.hasOwn(record, key)) fail("required", `$.${key}`, "required alias field is missing");
  const sourceOrigin = text(record.sourceOrigin, "$.sourceOrigin", MAX_SOURCE_ORIGIN_BYTES);
  const namespace = text(record.namespace, "$.namespace", MAX_NAMESPACE_BYTES);
  if (record.sourceKey !== makeSourceKey(sourceOrigin, namespace)) fail("source_key", "$.sourceKey", "sourceKey must equal JSON.stringify([sourceOrigin, namespace])");
  const legacyRawId = text(record.legacyRawId, "$.legacyRawId");
  const legacyRuntimeId = text(record.legacyRuntimeId, "$.legacyRuntimeId");
  if (record.legacyId !== makeLegacyId(legacyRawId, legacyRuntimeId)) fail("legacy_id", "$.legacyId", "legacyId must equal JSON.stringify([legacyRawId, legacyRuntimeId])");
  const revision = text(record.legacyRevision, "$.legacyRevision");
  if (revision.startsWith("unknown:")) { if (!DIGEST_RE.test(revision.slice(8))) fail("legacy_revision", "$.legacyRevision", "unknown revision must include a source digest"); }
  const status = record.mappingStatus;
  if (status !== "mapped" && status !== "unknown" && status !== "quarantined") fail("mapping_status", "$.mappingStatus", "invalid mapping status");
  if (!Array.isArray(record.candidates)) fail("type", "$.candidates", "candidates must be an array");
  const candidates = record.candidates;
  const seen = new Set();
  for (let i = 0; i < candidates.length; i += 1) { const candidate = questionKey(candidates[i], `$.candidates[${i}]`); if (seen.has(candidate)) fail("duplicate", `$.candidates[${i}]`, "candidate is duplicated"); seen.add(candidate); }
  if (status === "mapped") {
    if (!Object.hasOwn(record, "newQuestionKey")) fail("required", "$.newQuestionKey", "mapped alias requires a target");
    if (typeof record.newQuestionKey !== "string") fail("type", "$.newQuestionKey", "mapped alias target must be a string");
    const target = questionKey(record.newQuestionKey, "$.newQuestionKey");
    if (candidates.length !== 1 || candidates[0] !== target) fail("mapping", "$.candidates", "mapped alias needs exactly its deterministic target");
  } else if (Object.hasOwn(record, "newQuestionKey")) fail("mapping", "$.newQuestionKey", "unknown/quarantined alias cannot claim a target");
  return /** @type {import("./contracts").QuestionAliasRecord} */ (value);
}

export { ALIAS_KEY_PATH };
