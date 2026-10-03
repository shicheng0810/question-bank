import { APP_DATA_CONTENT_LIMITS, APP_DATA_LIMITS, CANONICAL_FORMAT } from "./constants.js";

const encoder = new TextEncoder();
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/** A stable, machine-readable AppData validation error. */
export class AppDataValidationError extends Error {
  /** @param {string} code @param {string} path @param {string} message */
  constructor(code, path, message) {
    super(message);
    this.name = "AppDataValidationError";
    this.code = code;
    this.path = path;
  }
}

/** @param {string} code @param {string} path @param {string} message @returns {never} */
function fail(code, path, message) {
  throw new AppDataValidationError(code, path, message);
}

/** @param {string} value */
export function utf8ByteLength(value) {
  if (typeof value !== "string") fail("type", "$", "UTF-8 length requires a string");
  return encoder.encode(value).byteLength;
}

/** @param {string} value @param {string} path @param {CanonicalLimits} limits */
function boundedString(value, path, limits) {
  const bytes = utf8ByteLength(value);
  if (bytes > limits.maxStringUtf8Bytes) fail("utf8_limit", path, "string exceeds the configured UTF-8 limit");
  return bytes;
}

/** @param {string} key */
function isArrayIndex(key) {
  if (key === "0") return true;
  if (!/^[1-9][0-9]*$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index < 0xffffffff && String(index) === key;
}

/**
 * Compute the exact UTF-8 length of JSON.stringify(string) without first
 * allocating the escaped representation. This keeps a 100 MiB content value
 * with many control characters from briefly becoming a several-hundred-MiB
 * temporary string before the fixed budget can reject it.
 * @param {string} value @returns {number}
 */
function jsonStringUtf8Length(value) {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) { bytes += 2; continue; }
    if (code < 0x20) { bytes += 6; continue; }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; index += 1; continue; }
      bytes += 6;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) { bytes += 6; continue; }
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else bytes += 3;
  }
  return bytes;
}

class CanonicalWriter {
  constructor() {
    /** @type {string[]} */
    this.parts = [];
    this.bytes = 0;
  }

  /** @param {string} part @param {string} path @param {CanonicalLimits} limits */
  append(part, path, limits) {
    const partBytes = utf8ByteLength(part);
    if (partBytes > limits.maxCanonicalUtf8Bytes - this.bytes) fail("utf8_limit", path, "canonical JSON exceeds the total AppData bound");
    this.parts.push(part);
    this.bytes += partBytes;
  }

  /** @returns {Uint8Array} */
  finish() {
    return encoder.encode(this.parts.join(""));
  }
}

/** @typedef {{maxDepth:number,maxObjectKeys:number,maxArrayItems:number,maxStringUtf8Bytes:number,maxCanonicalUtf8Bytes:number}} CanonicalLimits */
/** @param {unknown} value @param {string} path @param {number} depth @param {WeakSet<object>} active @param {CanonicalWriter} writer @param {CanonicalLimits} limits */
function encodeNode(value, path, depth, active, writer, limits) {
  if (depth > limits.maxDepth) fail("depth_limit", path, "value exceeds configured nesting depth");
  if (value === null) { writer.append("null", path, limits); return; }
  if (typeof value === "boolean") { writer.append(value ? "true" : "false", path, limits); return; }
  if (typeof value === "string") {
    boundedString(value, path, limits);
    const encodedLength = jsonStringUtf8Length(value);
    if (encodedLength > limits.maxCanonicalUtf8Bytes - writer.bytes) fail("utf8_limit", path, "canonical JSON exceeds the total AppData bound");
    writer.append(JSON.stringify(value), path, limits);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("finite_number", path, "must be a finite number");
    writer.append(JSON.stringify(Object.is(value, -0) ? 0 : value), path, limits);
    return;
  }
  if (typeof value !== "object" || value === null) fail("type", path, "value is not JSON data");
  if (active.has(value)) fail("cycle", path, "cyclic values are not JSON data");
  active.add(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) fail("prototype", path, "array must use Array.prototype");
    const descriptors = /** @type {Record<string, PropertyDescriptor>} */ (Object.getOwnPropertyDescriptors(value));
    const lengthDescriptor = descriptors.length;
    if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, "value") || typeof lengthDescriptor.value !== "number") {
      fail("descriptor", path, "array length must be a data property");
    }
    const length = lengthDescriptor.value;
    if (!Number.isSafeInteger(length) || length > limits.maxArrayItems) fail("array_limit", path, "array exceeds configured item limit");
    for (const key of Reflect.ownKeys(descriptors)) {
      if (key === "length") continue;
      if (typeof key !== "string" || !isArrayIndex(key) || Number(key) >= length) fail("array_property", path, "arrays may not have non-index properties");
      const descriptor = descriptors[key];
      if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) fail("accessor", `${path}[${key}]`, "array elements must be enumerable data properties");
    }
    writer.append("[", path, limits);
    for (let index = 0; index < length; index += 1) {
      if (index > 0) writer.append(",", path, limits);
      const key = String(index);
      const descriptor = descriptors[key];
      if (!descriptor) fail("array_hole", `${path}[${index}]`, "array holes are not JSON");
      encodeNode(descriptor.value, `${path}[${index}]`, depth + 1, active, writer, limits);
    }
    writer.append("]", path, limits);
  } else {
    if (Object.getPrototypeOf(value) !== Object.prototype) fail("prototype", path, "object must use Object.prototype");
    const descriptors = /** @type {Record<string, PropertyDescriptor>} */ (Object.getOwnPropertyDescriptors(value));
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length > limits.maxObjectKeys) fail("object_limit", path, "object exceeds configured key limit");
    const names = [];
    for (const key of keys) {
      if (typeof key !== "string") fail("symbol", path, "symbol keys are not JSON");
      if (FORBIDDEN_KEYS.has(key)) fail("prototype_pollution", `${path}.${key}`, "prototype-pollution key is forbidden");
      const descriptor = descriptors[key];
      if (!descriptor || !Object.hasOwn(descriptor, "value")) fail("accessor", `${path}.${key}`, "accessors are not JSON");
      if (!descriptor.enumerable) fail("non_enumerable", `${path}.${key}`, "non-enumerable fields cannot be silently omitted");
      boundedString(key, `${path}.${key}`, limits);
      names.push(key);
    }
    names.sort();
    writer.append("{", path, limits);
    for (let index = 0; index < names.length; index += 1) {
      const key = names[index];
      if (typeof key !== "string") fail("descriptor", path, "object key must be a string");
      if (index > 0) writer.append(",", path, limits);
      const descriptor = descriptors[key];
      if (!descriptor || !Object.hasOwn(descriptor, "value")) fail("accessor", `${path}.${key}`, "accessors are not JSON");
      // Object keys are JSON strings too. Preflight the escaped key and its
      // separator before JSON.stringify so a control-heavy key cannot create
      // a large temporary escaped string after the fixed content budget has
      // already been exceeded.
      const encodedKeyLength = jsonStringUtf8Length(key);
      const remaining = limits.maxCanonicalUtf8Bytes - writer.bytes;
      if (encodedKeyLength + 1 > remaining) fail("utf8_limit", `${path}.${key}`, "canonical JSON exceeds the total AppData bound");
      writer.append(`${JSON.stringify(key)}:`, `${path}.${key}`, limits);
      encodeNode(descriptor.value, `${path}.${key}`, depth + 1, active, writer, limits);
    }
    writer.append("}", path, limits);
  }
  active.delete(value);
}

/** Canonical UTF-8 JSON bytes for qb-canonical-v1. Unicode is not normalized. @param {unknown} value @returns {Uint8Array} */
export function canonicalBytes(value) {
  const writer = new CanonicalWriter();
  encodeNode(value, "$", 0, new WeakSet(), writer, APP_DATA_LIMITS);
  return writer.finish();
}

/** Canonical UTF-8 bytes for large content using the same qb-canonical-v1
 * ordering/escaping rules as canonicalBytes, with fixed 100 MiB/100000/1000
 * content limits. Callers cannot supply alternate limits. @param {unknown} value @returns {Uint8Array} */
export function canonicalContentBytes(value) {
  const writer = new CanonicalWriter();
  encodeNode(value, "$", 0, new WeakSet(), writer, APP_DATA_CONTENT_LIMITS);
  return writer.finish();
}

/** @param {Uint8Array} bytes */
export async function sha256Hex(bytes) {
  if (!(bytes instanceof Uint8Array)) fail("type", "$", "sha256Hex requires Uint8Array");
  if (!globalThis.crypto?.subtle) throw new Error("WebCrypto subtle.digest is required for AppData digests");
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const result = await globalThis.crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(result), (octet) => octet.toString(16).padStart(2, "0")).join("");
}

/** @param {unknown} value */
export async function canonicalDigest(value) { return sha256Hex(canonicalBytes(value)); }

/** @param {string} value @param {number} maximum @param {string} label */
export function assertUtf8Within(value, maximum, label = "value") {
  const bytes = utf8ByteLength(value);
  if (!Number.isSafeInteger(maximum) || maximum < 0) fail("limit", "$", "maximum must be a non-negative safe integer");
  if (bytes > maximum) fail("utf8_limit", "$", `${label} is ${bytes} UTF-8 bytes; maximum is ${maximum}`);
  return bytes;
}

export { CANONICAL_FORMAT };
