import { isUuid } from "../question/index.js";
import { AppDataValidationError } from "./canonical.js";
import { APP_DATA_PROTOCOL_VERSION } from "./constants.js";

const DECIMAL_RE = /^(0|[1-9][0-9]{0,19})$/;
const POLLUTION_KEYS = new Set(["__proto__", "prototype", "constructor"]);

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

/** @param {unknown} value @param {string} path */
function validateVersion(value, path) { if (value !== APP_DATA_PROTOCOL_VERSION) fail("version", path, `only protocol version ${APP_DATA_PROTOCOL_VERSION} is supported`); }

/** @param {unknown} value @param {string} path */
function validateSequence(value, path) {
  if (typeof value !== "string" || !DECIMAL_RE.test(value)) fail("cursor", path, "must be a non-negative decimal string");
}

/** @param {unknown} value @returns {import("./contracts").SyncCursor} */
export function validateCursor(value) {
  const record = object(value, "$");
  fields(record, ["protocolVersion", "accountGeneration", "logEpoch", "serverSeq"], ["protocolVersion", "accountGeneration", "logEpoch", "serverSeq"], "$");
  validateVersion(record.protocolVersion, "$.protocolVersion");
  if (!isUuid(record.accountGeneration)) fail("uuid", "$.accountGeneration", "must be a canonical lowercase UUID");
  if (!isUuid(record.logEpoch)) fail("uuid", "$.logEpoch", "must be a canonical lowercase UUID");
  validateSequence(record.serverSeq, "$.serverSeq");
  return /** @type {import("./contracts").SyncCursor} */ (value);
}

/** @param {unknown} value @returns {string} */
export function encodeCursor(value) {
  const record = validateCursor(value);
  return `v2.${record.accountGeneration}.${record.logEpoch}.${record.serverSeq}`;
}

/** @param {unknown} encoded @returns {import("./contracts").SyncCursor} */
export function decodeCursor(encoded) {
  if (typeof encoded !== "string") fail("cursor", "$.after", "cursor must be a string");
  const parts = encoded.split(".");
  if (parts.length !== 4 || parts[0] !== "v2") fail("cursor", "$.after", "cursor has an unknown version or invalid shape");
  return validateCursor({ protocolVersion: 2, accountGeneration: parts[1], logEpoch: parts[2], serverSeq: parts[3] });
}
