// ../../task-11/report-release-integration/node_modules/idb/build/index.js
var instanceOfAny = (object7, constructors) => constructors.some((c) => object7 instanceof c);
var idbProxyableTypes;
var cursorAdvanceMethods;
function getIdbProxyableTypes() {
  return idbProxyableTypes || (idbProxyableTypes = [
    IDBDatabase,
    IDBObjectStore,
    IDBIndex,
    IDBCursor,
    IDBTransaction
  ]);
}
function getCursorAdvanceMethods() {
  return cursorAdvanceMethods || (cursorAdvanceMethods = [
    IDBCursor.prototype.advance,
    IDBCursor.prototype.continue,
    IDBCursor.prototype.continuePrimaryKey
  ]);
}
var transactionDoneMap = /* @__PURE__ */ new WeakMap();
var transformCache = /* @__PURE__ */ new WeakMap();
var reverseTransformCache = /* @__PURE__ */ new WeakMap();
function promisifyRequest(request) {
  const promise = new Promise((resolve, reject) => {
    const unlisten = () => {
      request.removeEventListener("success", success);
      request.removeEventListener("error", error);
    };
    const success = () => {
      resolve(wrap(request.result));
      unlisten();
    };
    const error = () => {
      reject(request.error);
      unlisten();
    };
    request.addEventListener("success", success);
    request.addEventListener("error", error);
  });
  reverseTransformCache.set(promise, request);
  return promise;
}
function cacheDonePromiseForTransaction(tx) {
  if (transactionDoneMap.has(tx))
    return;
  const done = new Promise((resolve, reject) => {
    const unlisten = () => {
      tx.removeEventListener("complete", complete);
      tx.removeEventListener("error", error);
      tx.removeEventListener("abort", error);
    };
    const complete = () => {
      resolve();
      unlisten();
    };
    const error = () => {
      reject(tx.error || new DOMException("AbortError", "AbortError"));
      unlisten();
    };
    tx.addEventListener("complete", complete);
    tx.addEventListener("error", error);
    tx.addEventListener("abort", error);
  });
  transactionDoneMap.set(tx, done);
}
var idbProxyTraps = {
  get(target, prop, receiver) {
    if (target instanceof IDBTransaction) {
      if (prop === "done")
        return transactionDoneMap.get(target);
      if (prop === "store") {
        return receiver.objectStoreNames[1] ? void 0 : receiver.objectStore(receiver.objectStoreNames[0]);
      }
    }
    return wrap(target[prop]);
  },
  set(target, prop, value) {
    target[prop] = value;
    return true;
  },
  has(target, prop) {
    if (target instanceof IDBTransaction && (prop === "done" || prop === "store")) {
      return true;
    }
    return prop in target;
  }
};
function replaceTraps(callback) {
  idbProxyTraps = callback(idbProxyTraps);
}
function wrapFunction(func) {
  if (getCursorAdvanceMethods().includes(func)) {
    return function(...args) {
      func.apply(unwrap(this), args);
      return wrap(this.request);
    };
  }
  return function(...args) {
    return wrap(func.apply(unwrap(this), args));
  };
}
function transformCachableValue(value) {
  if (typeof value === "function")
    return wrapFunction(value);
  if (value instanceof IDBTransaction)
    cacheDonePromiseForTransaction(value);
  if (instanceOfAny(value, getIdbProxyableTypes()))
    return new Proxy(value, idbProxyTraps);
  return value;
}
function wrap(value) {
  if (value instanceof IDBRequest)
    return promisifyRequest(value);
  if (transformCache.has(value))
    return transformCache.get(value);
  const newValue = transformCachableValue(value);
  if (newValue !== value) {
    transformCache.set(value, newValue);
    reverseTransformCache.set(newValue, value);
  }
  return newValue;
}
var unwrap = (value) => reverseTransformCache.get(value);
function openDB(name, version, { blocked, upgrade, blocking, terminated } = {}) {
  const request = indexedDB.open(name, version);
  const openPromise = wrap(request);
  if (upgrade) {
    request.addEventListener("upgradeneeded", (event) => {
      upgrade(wrap(request.result), event.oldVersion, event.newVersion, wrap(request.transaction), event);
    });
  }
  if (blocked) {
    request.addEventListener("blocked", (event) => blocked(
      // Casting due to https://github.com/microsoft/TypeScript-DOM-lib-generator/pull/1405
      event.oldVersion,
      event.newVersion,
      event
    ));
  }
  openPromise.then((db) => {
    if (terminated)
      db.addEventListener("close", () => terminated());
    if (blocking) {
      db.addEventListener("versionchange", (event) => blocking(event.oldVersion, event.newVersion, event));
    }
  }).catch(() => {
  });
  return openPromise;
}
var readMethods = ["get", "getKey", "getAll", "getAllKeys", "count"];
var writeMethods = ["put", "add", "delete", "clear"];
var cachedMethods = /* @__PURE__ */ new Map();
function getMethod(target, prop) {
  if (!(target instanceof IDBDatabase && !(prop in target) && typeof prop === "string")) {
    return;
  }
  if (cachedMethods.get(prop))
    return cachedMethods.get(prop);
  const targetFuncName = prop.replace(/FromIndex$/, "");
  const useIndex = prop !== targetFuncName;
  const isWrite = writeMethods.includes(targetFuncName);
  if (
    // Bail if the target doesn't exist on the target. Eg, getAll isn't in Edge.
    !(targetFuncName in (useIndex ? IDBIndex : IDBObjectStore).prototype) || !(isWrite || readMethods.includes(targetFuncName))
  ) {
    return;
  }
  const method = async function(storeName, ...args) {
    const tx = this.transaction(storeName, isWrite ? "readwrite" : "readonly");
    let target2 = tx.store;
    if (useIndex)
      target2 = target2.index(args.shift());
    return (await Promise.all([
      target2[targetFuncName](...args),
      isWrite && tx.done
    ]))[0];
  };
  cachedMethods.set(prop, method);
  return method;
}
replaceTraps((oldTraps) => ({
  ...oldTraps,
  get: (target, prop, receiver) => getMethod(target, prop) || oldTraps.get(target, prop, receiver),
  has: (target, prop) => !!getMethod(target, prop) || oldTraps.has(target, prop)
}));
var advanceMethodProps = ["continue", "continuePrimaryKey", "advance"];
var methodMap = {};
var advanceResults = /* @__PURE__ */ new WeakMap();
var ittrProxiedCursorToOriginalProxy = /* @__PURE__ */ new WeakMap();
var cursorIteratorTraps = {
  get(target, prop) {
    if (!advanceMethodProps.includes(prop))
      return target[prop];
    let cachedFunc = methodMap[prop];
    if (!cachedFunc) {
      cachedFunc = methodMap[prop] = function(...args) {
        advanceResults.set(this, ittrProxiedCursorToOriginalProxy.get(this)[prop](...args));
      };
    }
    return cachedFunc;
  }
};
async function* iterate(...args) {
  let cursor = this;
  if (!(cursor instanceof IDBCursor)) {
    cursor = await cursor.openCursor(...args);
  }
  if (!cursor)
    return;
  cursor = cursor;
  const proxiedCursor = new Proxy(cursor, cursorIteratorTraps);
  ittrProxiedCursorToOriginalProxy.set(proxiedCursor, cursor);
  reverseTransformCache.set(proxiedCursor, unwrap(cursor));
  while (cursor) {
    yield proxiedCursor;
    cursor = await (advanceResults.get(proxiedCursor) || cursor.continue());
    advanceResults.delete(proxiedCursor);
  }
}
function isIteratorProp(target, prop) {
  return prop === Symbol.asyncIterator && instanceOfAny(target, [IDBIndex, IDBObjectStore, IDBCursor]) || prop === "iterate" && instanceOfAny(target, [IDBIndex, IDBObjectStore]);
}
replaceTraps((oldTraps) => ({
  ...oldTraps,
  get(target, prop, receiver) {
    if (isIteratorProp(target, prop))
      return iterate;
    return oldTraps.get(target, prop, receiver);
  },
  has(target, prop) {
    return isIteratorProp(target, prop) || oldTraps.has(target, prop);
  }
}));

// src/domain/app-data/constants.js
var APP_DATA_DB_SCHEMA_VERSION = 2;
var APP_DATA_EXCHANGE_SCHEMA_VERSION = 2;
var APP_DATA_PROTOCOL_VERSION = 2;
var APP_DATA_LIMITS = Object.freeze({
  maxDepth: 32,
  maxObjectKeys: 1e3,
  maxArrayItems: 5e3,
  maxStringUtf8Bytes: 1048576,
  maxCanonicalUtf8Bytes: 3 * 1024 * 1024,
  maxMutationUtf8Bytes: 16 * 1024,
  maxPushMutations: 100,
  maxPushUtf8Bytes: 256 * 1024,
  maxPushResponseUtf8Bytes: 64 * 1024,
  maxPullChanges: 200,
  maxPullUtf8Bytes: 512 * 1024,
  maxContentChunkBytes: 512 * 1024,
  maxPrivateBankUtf8Bytes: 3 * 1024 * 1024,
  maxPrivateBankQuestions: 5e3,
  maxPrivateBanks: 15
});
var APP_DATA_CONTENT_LIMITS = Object.freeze({
  maxDepth: 32,
  maxObjectKeys: 1e3,
  maxArrayItems: 1e5,
  maxStringUtf8Bytes: 100 * 1024 * 1024,
  maxCanonicalUtf8Bytes: 100 * 1024 * 1024
});
var ALIAS_KEY_PATH = Object.freeze(["sourceKey", "legacyRevision", "legacyId"]);

// src/domain/app-data/canonical.js
var encoder = new TextEncoder();
var FORBIDDEN_KEYS = /* @__PURE__ */ new Set(["__proto__", "prototype", "constructor"]);
var AppDataValidationError = class extends Error {
  /** @param {string} code @param {string} path @param {string} message */
  constructor(code, path, message) {
    super(message);
    this.name = "AppDataValidationError";
    this.code = code;
    this.path = path;
  }
};
function fail(code, path, message) {
  throw new AppDataValidationError(code, path, message);
}
function utf8ByteLength(value) {
  if (typeof value !== "string") fail("type", "$", "UTF-8 length requires a string");
  return encoder.encode(value).byteLength;
}
function boundedString(value, path, limits) {
  const bytes = utf8ByteLength(value);
  if (bytes > limits.maxStringUtf8Bytes) fail("utf8_limit", path, "string exceeds the configured UTF-8 limit");
  return bytes;
}
function isArrayIndex(key2) {
  if (key2 === "0") return true;
  if (!/^[1-9][0-9]*$/.test(key2)) return false;
  const index = Number(key2);
  return Number.isSafeInteger(index) && index < 4294967295 && String(index) === key2;
}
function jsonStringUtf8Length(value) {
  let bytes = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) {
      bytes += 2;
      continue;
    }
    if (code < 32) {
      bytes += 6;
      continue;
    }
    if (code >= 55296 && code <= 56319) {
      const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
      if (next >= 56320 && next <= 57343) {
        bytes += 4;
        index += 1;
        continue;
      }
      bytes += 6;
      continue;
    }
    if (code >= 56320 && code <= 57343) {
      bytes += 6;
      continue;
    }
    if (code <= 127) bytes += 1;
    else if (code <= 2047) bytes += 2;
    else bytes += 3;
  }
  return bytes;
}
var CanonicalWriter = class {
  constructor() {
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
};
function encodeNode(value, path, depth, active, writer, limits) {
  if (depth > limits.maxDepth) fail("depth_limit", path, "value exceeds configured nesting depth");
  if (value === null) {
    writer.append("null", path, limits);
    return;
  }
  if (typeof value === "boolean") {
    writer.append(value ? "true" : "false", path, limits);
    return;
  }
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
    const descriptors = (
      /** @type {Record<string, PropertyDescriptor>} */
      Object.getOwnPropertyDescriptors(value)
    );
    const lengthDescriptor = descriptors.length;
    if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, "value") || typeof lengthDescriptor.value !== "number") {
      fail("descriptor", path, "array length must be a data property");
    }
    const length = lengthDescriptor.value;
    if (!Number.isSafeInteger(length) || length > limits.maxArrayItems) fail("array_limit", path, "array exceeds configured item limit");
    for (const key2 of Reflect.ownKeys(descriptors)) {
      if (key2 === "length") continue;
      if (typeof key2 !== "string" || !isArrayIndex(key2) || Number(key2) >= length) fail("array_property", path, "arrays may not have non-index properties");
      const descriptor = descriptors[key2];
      if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) fail("accessor", `${path}[${key2}]`, "array elements must be enumerable data properties");
    }
    writer.append("[", path, limits);
    for (let index = 0; index < length; index += 1) {
      if (index > 0) writer.append(",", path, limits);
      const key2 = String(index);
      const descriptor = descriptors[key2];
      if (!descriptor) fail("array_hole", `${path}[${index}]`, "array holes are not JSON");
      encodeNode(descriptor.value, `${path}[${index}]`, depth + 1, active, writer, limits);
    }
    writer.append("]", path, limits);
  } else {
    if (Object.getPrototypeOf(value) !== Object.prototype) fail("prototype", path, "object must use Object.prototype");
    const descriptors = (
      /** @type {Record<string, PropertyDescriptor>} */
      Object.getOwnPropertyDescriptors(value)
    );
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length > limits.maxObjectKeys) fail("object_limit", path, "object exceeds configured key limit");
    const names = [];
    for (const key2 of keys) {
      if (typeof key2 !== "string") fail("symbol", path, "symbol keys are not JSON");
      if (FORBIDDEN_KEYS.has(key2)) fail("prototype_pollution", `${path}.${key2}`, "prototype-pollution key is forbidden");
      const descriptor = descriptors[key2];
      if (!descriptor || !Object.hasOwn(descriptor, "value")) fail("accessor", `${path}.${key2}`, "accessors are not JSON");
      if (!descriptor.enumerable) fail("non_enumerable", `${path}.${key2}`, "non-enumerable fields cannot be silently omitted");
      boundedString(key2, `${path}.${key2}`, limits);
      names.push(key2);
    }
    names.sort();
    writer.append("{", path, limits);
    for (let index = 0; index < names.length; index += 1) {
      const key2 = names[index];
      if (typeof key2 !== "string") fail("descriptor", path, "object key must be a string");
      if (index > 0) writer.append(",", path, limits);
      const descriptor = descriptors[key2];
      if (!descriptor || !Object.hasOwn(descriptor, "value")) fail("accessor", `${path}.${key2}`, "accessors are not JSON");
      const encodedKeyLength = jsonStringUtf8Length(key2);
      const remaining = limits.maxCanonicalUtf8Bytes - writer.bytes;
      if (encodedKeyLength + 1 > remaining) fail("utf8_limit", `${path}.${key2}`, "canonical JSON exceeds the total AppData bound");
      writer.append(`${JSON.stringify(key2)}:`, `${path}.${key2}`, limits);
      encodeNode(descriptor.value, `${path}.${key2}`, depth + 1, active, writer, limits);
    }
    writer.append("}", path, limits);
  }
  active.delete(value);
}
function canonicalBytes(value) {
  const writer = new CanonicalWriter();
  encodeNode(value, "$", 0, /* @__PURE__ */ new WeakSet(), writer, APP_DATA_LIMITS);
  return writer.finish();
}
function canonicalContentBytes(value) {
  const writer = new CanonicalWriter();
  encodeNode(value, "$", 0, /* @__PURE__ */ new WeakSet(), writer, APP_DATA_CONTENT_LIMITS);
  return writer.finish();
}
async function sha256Hex(bytes) {
  if (!(bytes instanceof Uint8Array)) fail("type", "$", "sha256Hex requires Uint8Array");
  if (!globalThis.crypto?.subtle) throw new Error("WebCrypto subtle.digest is required for AppData digests");
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const result = await globalThis.crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(result), (octet) => octet.toString(16).padStart(2, "0")).join("");
}
async function canonicalDigest(value) {
  return sha256Hex(canonicalBytes(value));
}
function assertUtf8Within(value, maximum, label = "value") {
  const bytes = utf8ByteLength(value);
  if (!Number.isSafeInteger(maximum) || maximum < 0) fail("limit", "$", "maximum must be a non-negative safe integer");
  if (bytes > maximum) fail("utf8_limit", "$", `${label} is ${bytes} UTF-8 bytes; maximum is ${maximum}`);
  return bytes;
}

// src/domain/question/index.js
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
var QUESTION_KEY_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
function isUuid(value) {
  return typeof value === "string" && UUID_RE.test(value);
}
function isQuestionKey(value) {
  return typeof value === "string" && QUESTION_KEY_RE.test(value);
}
function isOptionId(value) {
  return typeof value === "string" && /^opt_[A-Za-z0-9_-]{16,128}$/.test(value);
}

// src/domain/app-data/content-records.js
var DIGEST_RE = /^[0-9a-f]{64}$/;
var MAX_CONTENT_BYTES = 100 * 1024 * 1024;
var MAX_CHUNKS = 200;
var MAX_MANIFEST_BYTES = 128 * 1024;
function fail2(code, path, message) {
  throw new AppDataValidationError(code, path, message);
}
function object(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail2("type", path, "must be a plain object");
  if (Object.getPrototypeOf(value) !== Object.prototype) fail2("prototype", path, "must use Object.prototype");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key2 of Reflect.ownKeys(descriptors)) {
    if (typeof key2 !== "string") fail2("symbol", path, "symbol keys are not JSON");
    const name = String(key2);
    const descriptor = descriptors[name];
    if (!descriptor) fail2("accessor", `${path}.${name}`, "accessors are not JSON");
    if (!Object.hasOwn(descriptor, "value")) fail2("accessor", `${path}.${name}`, "accessors are not JSON");
    if (!descriptor.enumerable) fail2("non_enumerable", `${path}.${name}`, "non-enumerable fields are not permitted");
  }
  return (
    /** @type {Record<string, any>} */
    value
  );
}
function fields(value, allowed, required, path) {
  for (const key2 of Object.keys(value)) if (!allowed.includes(key2)) fail2("unknown_field", `${path}.${key2}`, "unknown field is not permitted");
  for (const key2 of required) if (!Object.hasOwn(value, key2)) fail2("required", `${path}.${key2}`, "required field is missing");
}
function integer(value, path) {
  if (!Number.isSafeInteger(value)) fail2("safe_integer", path, "must be a safe integer");
  return (
    /** @type {number} */
    value
  );
}
function nonNegative(value, path) {
  const result = integer(value, path);
  if (result < 0) fail2("range", path, "must be non-negative");
  return result;
}
function digest(value, path) {
  if (typeof value !== "string" || !DIGEST_RE.test(value)) fail2("digest", path, "must be a lowercase SHA-256 hex digest");
  return value;
}
function uuid(value, path) {
  if (!isUuid(value)) fail2("uuid", path, "must be a canonical lowercase UUID");
  return value;
}
function text(value, path, maximum = APP_DATA_LIMITS.maxStringUtf8Bytes) {
  if (typeof value !== "string") fail2("type", path, "must be a string");
  const result = (
    /** @type {string} */
    value
  );
  const bytes = utf8ByteLength(result);
  if (bytes > maximum) fail2("utf8_limit", path, "string exceeds the configured UTF-8 limit");
  return result;
}
function nonEmptyText(value, path, maximum = APP_DATA_LIMITS.maxStringUtf8Bytes) {
  const result = text(value, path, maximum);
  if (result.length === 0) fail2("range", path, "must be non-empty");
  return result;
}
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
function staticReference(value, path) {
  const result = nonEmptyText(value, path, 2048);
  if (/[\\%:?#\u0000-\u001f\u007f]/u.test(result)) fail2("path", path, "staticRef contains a forbidden unencoded path character");
  for (let index = 0; index < result.length; index += 1) {
    const code = result.charCodeAt(index);
    if (code >= 55296 && code <= 56319) {
      const next = result.charCodeAt(index + 1);
      if (!(next >= 56320 && next <= 57343)) fail2("path", path, "staticRef may not contain an unpaired surrogate");
      index += 1;
    } else if (code >= 56320 && code <= 57343) fail2("path", path, "staticRef may not contain an unpaired surrogate");
  }
  if (result.startsWith("/") || result.endsWith("/")) fail2("path", path, "staticRef must be root-relative without leading or trailing slash");
  for (const segment of result.split("/")) if (segment.length === 0 || segment === "." || segment === "..") fail2("path", path, "staticRef contains an empty or traversal segment");
  return result;
}
function array(value, path, maximum) {
  if (!Array.isArray(value)) fail2("type", path, "must be an array");
  if (Object.getPrototypeOf(value) !== Array.prototype) fail2("prototype", path, "array must use Array.prototype");
  if (value.length > maximum) fail2("array_limit", path, "array exceeds the configured item limit");
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor) fail2("array_hole", `${path}[${index}]`, "array holes/accessors are not permitted");
    if (!Object.hasOwn(descriptor, "value")) fail2("array_hole", `${path}[${index}]`, "array holes/accessors are not permitted");
    if (!descriptor.enumerable) fail2("non_enumerable", `${path}[${index}]`, "non-enumerable array elements are not permitted");
  }
  for (const key2 of Reflect.ownKeys(value)) {
    if (key2 === "length") continue;
    if (typeof key2 !== "string" || !/^(0|[1-9][0-9]*)$/.test(key2) || Number(key2) >= value.length) fail2("array_property", path, "arrays may not have non-index properties");
  }
  return value;
}
function validateContentReference(value, path = "$") {
  const record = object(value, path);
  fields(record, ["contentDigest", "manifestDigest", "chunkCount", "totalBytes"], ["contentDigest", "manifestDigest", "chunkCount", "totalBytes"], path);
  digest(record.contentDigest, `${path}.contentDigest`);
  digest(record.manifestDigest, `${path}.manifestDigest`);
  const chunkCount = nonNegative(record.chunkCount, `${path}.chunkCount`);
  const totalBytes = nonNegative(record.totalBytes, `${path}.totalBytes`);
  if (chunkCount > MAX_CHUNKS) fail2("range", `${path}.chunkCount`, "chunkCount exceeds 200");
  if (totalBytes > MAX_CONTENT_BYTES) fail2("range", `${path}.totalBytes`, "totalBytes exceeds 100 MiB");
  if (chunkCount === 0 !== (totalBytes === 0)) fail2("invariant", path, "zero-byte references require zero chunks and vice versa");
  return (
    /** @type {import("./contracts").ContentReference} */
    value
  );
}
function validateChunkManifest(value, path = "$") {
  const record = object(value, path);
  fields(record, ["schemaVersion", "contentDigest", "totalBytes", "chunkCount", "chunks"], ["schemaVersion", "contentDigest", "totalBytes", "chunkCount", "chunks"], path);
  if (record.schemaVersion !== 1) fail2("version", `${path}.schemaVersion`, "only manifest schemaVersion 1 is supported");
  digest(record.contentDigest, `${path}.contentDigest`);
  const totalBytes = nonNegative(record.totalBytes, `${path}.totalBytes`);
  if (totalBytes > MAX_CONTENT_BYTES) fail2("range", `${path}.totalBytes`, "totalBytes exceeds 100 MiB");
  const chunkCount = nonNegative(record.chunkCount, `${path}.chunkCount`);
  if (chunkCount > MAX_CHUNKS) fail2("range", `${path}.chunkCount`, "chunkCount exceeds 200");
  const chunks = array(record.chunks, `${path}.chunks`, MAX_CHUNKS);
  if (chunks.length !== chunkCount) fail2("invariant", `${path}.chunkCount`, "chunkCount must equal chunks.length");
  let sum = 0;
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = object(chunks[index], `${path}.chunks[${index}]`);
    fields(chunk, ["chunkIndex", "byteLength", "sha256"], ["chunkIndex", "byteLength", "sha256"], `${path}.chunks[${index}]`);
    if (integer(chunk.chunkIndex, `${path}.chunks[${index}].chunkIndex`) !== index) fail2("invariant", `${path}.chunks[${index}].chunkIndex`, "chunkIndex must be continuous from zero");
    const byteLength = integer(chunk.byteLength, `${path}.chunks[${index}].byteLength`);
    if (byteLength < 1 || byteLength > APP_DATA_LIMITS.maxContentChunkBytes) fail2("range", `${path}.chunks[${index}].byteLength`, "chunk byteLength must be 1..512 KiB");
    digest(chunk.sha256, `${path}.chunks[${index}].sha256`);
    sum += byteLength;
    if (sum > MAX_CONTENT_BYTES) fail2("range", `${path}.chunks`, "chunk bytes exceed 100 MiB");
  }
  if (chunkCount === 0 && totalBytes !== 0) fail2("invariant", path, "empty chunks require totalBytes zero");
  if (chunkCount > 0 && totalBytes === 0) fail2("invariant", path, "non-empty chunks require positive totalBytes");
  if (sum !== totalBytes) fail2("invariant", `${path}.totalBytes`, "totalBytes must equal chunk byteLength sum");
  const canonical = canonicalBytes(value);
  if (canonical.byteLength > MAX_MANIFEST_BYTES) fail2("manifest_limit", path, "canonical manifest exceeds 128 KiB");
  return (
    /** @type {import("./contracts").ChunkManifest} */
    value
  );
}
function validateBankMetadata(value, path = "$") {
  const record = object(value, path);
  fields(record, ["title", "questionCount", "visibility"], ["title", "questionCount", "visibility"], path);
  nonEmptyText(record.title, `${path}.title`, 512);
  const questionCount = nonNegative(record.questionCount, `${path}.questionCount`);
  if (questionCount > 5e3) fail2("range", `${path}.questionCount`, "questionCount exceeds 5000");
  if (!["public", "private", "protected"].includes(record.visibility)) fail2("enum", `${path}.visibility`, "invalid bank visibility");
  return (
    /** @type {import("./contracts").BankMetadata} */
    value
  );
}
function validateContentManifest(value, path = "$") {
  const record = object(value, path);
  if (record.kind === "public_static") {
    fields(record, ["kind", "staticRef", "contentDigest"], ["kind", "staticRef", "contentDigest"], path);
    staticReference(record.staticRef, `${path}.staticRef`);
    digest(record.contentDigest, `${path}.contentDigest`);
    assertSmallDtoBudget(record, path);
    return (
      /** @type {import("./contracts").ContentManifest} */
      value
    );
  }
  if (record.kind === "private_chunks" || record.kind === "protected_cipher") {
    fields(record, ["kind", "reference"], ["kind", "reference"], path);
    validateContentReference(record.reference, `${path}.reference`);
    assertSmallDtoBudget(record, path);
    return (
      /** @type {import("./contracts").ContentManifest} */
      value
    );
  }
  if (record.kind === "unavailable") {
    fields(record, ["kind", "reason"], ["kind", "reason"], path);
    nonEmptyText(record.reason, `${path}.reason`);
    assertSmallDtoBudget(record, path);
    return (
      /** @type {import("./contracts").ContentManifest} */
      value
    );
  }
  fail2("enum", `${path}.kind`, "invalid content manifest kind");
}
function validateBankRevisionRecord(value, path = "$") {
  const record = object(value, path);
  fields(record, ["bankUid", "revision", "metadata", "contentManifest"], ["bankUid", "revision", "metadata", "contentManifest"], path);
  uuid(record.bankUid, `${path}.bankUid`);
  digest(record.revision, `${path}.revision`);
  const metadata = validateBankMetadata(record.metadata, `${path}.metadata`);
  const contentManifest = validateContentManifest(record.contentManifest, `${path}.contentManifest`);
  if (contentManifest.kind !== "unavailable") {
    const expected = { public: "public_static", private: "private_chunks", protected: "protected_cipher" }[metadata.visibility];
    if (contentManifest.kind !== expected) fail2("invariant", `${path}.contentManifest.kind`, "content manifest kind must match metadata visibility");
  }
  assertSmallDtoBudget(record, path);
  return (
    /** @type {import("./contracts").BankRevisionRecord} */
    value
  );
}
function validateResumeReference(value, path = "$") {
  const record = object(value, path);
  fields(record, ["schemaVersion", "attemptId", "writerStreamId", "contentDigest", "chunkManifestDigest", "localRevision", "baseRevision"], ["schemaVersion", "attemptId", "writerStreamId", "contentDigest", "chunkManifestDigest", "localRevision", "baseRevision"], path);
  if (record.schemaVersion !== 1) fail2("version", `${path}.schemaVersion`, "only resume reference schemaVersion 1 is supported");
  uuid(record.attemptId, `${path}.attemptId`);
  uuid(record.writerStreamId, `${path}.writerStreamId`);
  digest(record.contentDigest, `${path}.contentDigest`);
  digest(record.chunkManifestDigest, `${path}.chunkManifestDigest`);
  if (integer(record.localRevision, `${path}.localRevision`) < 1) fail2("range", `${path}.localRevision`, "localRevision must be positive");
  nonNegative(record.baseRevision, `${path}.baseRevision`);
  return (
    /** @type {import("./contracts").ResumeReference} */
    value
  );
}
var CONTENT_RECORD_LIMITS = Object.freeze({ maxContentBytes: MAX_CONTENT_BYTES, maxChunks: MAX_CHUNKS, maxManifestBytes: MAX_MANIFEST_BYTES, maxChunkBytes: APP_DATA_LIMITS.maxContentChunkBytes, maxContentCanonicalBytes: APP_DATA_CONTENT_LIMITS.maxCanonicalUtf8Bytes });

// src/domain/app-data/history-snapshot-records.js
var DIGEST = /^[0-9a-f]{64}$/;
var MAX_SCOPE = APP_DATA_LIMITS.maxArrayItems;
var fail3 = (code, path) => {
  throw new AppDataValidationError(code, path, "Invalid imported history snapshot");
};
function exact(value, keys, path) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail3("type", path);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.length) fail3("fields", path);
  for (const key2 of Reflect.ownKeys(descriptors)) {
    if (typeof key2 !== "string" || !keys.includes(key2) || !Object.hasOwn(descriptors[key2], "value") || !descriptors[key2].enumerable) fail3("fields", path);
  }
  for (const key2 of keys) if (!Object.hasOwn(value, key2)) fail3("required", `${path}.${key2}`);
  return value;
}
function integer2(value, path) {
  if (!Number.isSafeInteger(value) || value < 0) fail3("range", path);
  return value;
}
function text2(value, path, max = 128) {
  if (typeof value !== "string" || !value.length || utf8ByteLength(value) > max) fail3("text", path);
  return value;
}
function uuid2(value, path) {
  if (!isUuid(value)) fail3("uuid", path);
  return value;
}
function digest2(value, path) {
  if (typeof value !== "string" || !DIGEST.test(value)) fail3("digest", path);
  return value;
}
function array2(value, path, max = MAX_SCOPE) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max) fail3("array", path);
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d || !Object.hasOwn(d, "value") || !d.enumerable) fail3("array", path);
  }
  if (Reflect.ownKeys(value).length !== value.length + 1) fail3("array", path);
  return value;
}
async function deriveHistorySnapshotId(accountGeneration, source) {
  uuid2(accountGeneration, "$.accountGeneration");
  validateHistorySnapshotSource(source);
  const hash2 = await sha256Hex(canonicalBytes(["qb-history-snapshot-v1", accountGeneration, source.namespace, source.deviceNamespace, source.recordId, source.conversionVersion]));
  const chars = hash2.slice(0, 32).split("");
  chars[12] = "8";
  chars[16] = (8 + (parseInt(chars[16], 16) & 3)).toString(16);
  const s = chars.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
function validateHistorySnapshotSource(value, path = "$.source") {
  const source = exact(value, ["namespace", "deviceNamespace", "recordId", "digest", "conversionVersion"], path);
  if (source.namespace !== "legacy_account" && source.namespace !== "legacy_device") fail3("enum", `${path}.namespace`);
  if (source.namespace === "legacy_account") {
    if (source.deviceNamespace !== null) fail3("invariant", `${path}.deviceNamespace`);
  } else text2(source.deviceNamespace, `${path}.deviceNamespace`);
  text2(source.recordId, `${path}.recordId`);
  digest2(source.digest, `${path}.digest`);
  if (source.conversionVersion !== 1) fail3("version", `${path}.conversionVersion`);
  return source;
}
function validateHistorySnapshotSummary(value, path = "$.summary") {
  exact(value, ["correct", "answered", "total"], path);
  for (const key2 of ["correct", "answered", "total"]) integer2(value[key2], `${path}.${key2}`);
  return value;
}
function header(record, path) {
  if (record.schemaVersion !== 1) fail3("version", `${path}.schemaVersion`);
  uuid2(record.snapshotId, `${path}.snapshotId`);
  uuid2(record.accountGeneration, `${path}.accountGeneration`);
  validateHistorySnapshotSource(record.source, `${path}.source`);
  integer2(record.recordedAt, `${path}.recordedAt`);
  validateHistorySnapshotSummary(record.summary, `${path}.summary`);
}
function validateHistorySnapshotPayload(value, path = "$.payload") {
  const record = exact(value, ["schemaVersion", "snapshotId", "accountGeneration", "source", "recordedAt", "summary", "scopeCount", "reference", "baseRevision"], path);
  header(record, path);
  integer2(record.scopeCount, `${path}.scopeCount`);
  if (record.scopeCount > MAX_SCOPE || record.baseRevision !== 0) fail3("range", path);
  validateContentReference(record.reference, `${path}.reference`);
  if (record.reference.totalBytes > APP_DATA_LIMITS.maxCanonicalUtf8Bytes) fail3("utf8_limit", `${path}.reference`);
  canonicalBytes(record);
  return record;
}
function validateImportedHistorySnapshot(value, path = "$") {
  const record = exact(value, ["schemaVersion", "type", "snapshotId", "accountGeneration", "source", "recordedAt", "summary", "scope", "answers"], path);
  header(record, path);
  if (record.type !== "imported_history_snapshot") fail3("enum", `${path}.type`);
  const seen = /* @__PURE__ */ new Set();
  for (const [i, entry] of array2(record.scope, `${path}.scope`).entries()) {
    const p = `${path}.scope[${i}]`;
    exact(entry, ["legacyQuestionId", "questionKey", "questionRevision", "equivalentSourceRefs"], p);
    text2(entry.legacyQuestionId, `${p}.legacyQuestionId`);
    if (seen.has(entry.legacyQuestionId)) fail3("duplicate", p);
    seen.add(entry.legacyQuestionId);
    if (!isQuestionKey(entry.questionKey)) fail3("question_key", p);
    digest2(entry.questionRevision, `${p}.questionRevision`);
    const refs = array2(entry.equivalentSourceRefs, `${p}.equivalentSourceRefs`);
    if (!refs.length) fail3("range", p);
    let prior2 = "";
    let representative = false;
    for (const ref of refs) {
      exact(ref, ["questionKey", "questionRevision", "bankRevision"], p);
      if (!isQuestionKey(ref.questionKey) || ref.questionKey <= prior2) fail3("order", p);
      prior2 = ref.questionKey;
      digest2(ref.questionRevision, p);
      digest2(ref.bankRevision, p);
      if (ref.questionKey === entry.questionKey && ref.questionRevision === entry.questionRevision) representative = true;
    }
    if (!representative) fail3("invariant", p);
  }
  const answers = /* @__PURE__ */ new Set();
  for (const [i, answer] of array2(record.answers, `${path}.answers`).entries()) {
    const p = `${path}.answers[${i}]`;
    exact(answer, ["legacyQuestionId", "savedInput"], p);
    if (!seen.has(answer.legacyQuestionId) || answers.has(answer.legacyQuestionId)) fail3("invariant", p);
    answers.add(answer.legacyQuestionId);
    const input = exact(answer.savedInput, ["selectedIndex", "selectedSet", "fillInputs", "submitted", "showKeys"], `${p}.savedInput`);
    if (input.selectedIndex !== null) integer2(input.selectedIndex, p);
    const selection = /* @__PURE__ */ new Set();
    for (const n of array2(input.selectedSet, p)) {
      integer2(n, p);
      if (selection.has(n)) fail3("duplicate", p);
      selection.add(n);
    }
    for (const s of array2(input.fillInputs, p)) if (typeof s !== "string" || utf8ByteLength(s) > 65536) fail3("text", p);
    if (typeof input.submitted !== "boolean" || typeof input.showKeys !== "boolean") fail3("type", p);
  }
  canonicalBytes(record);
  return record;
}
async function validateHistorySnapshotBinding(payload, body, { accountGeneration }) {
  validateHistorySnapshotPayload(payload);
  validateImportedHistorySnapshot(body);
  uuid2(accountGeneration, "$.accountGeneration");
  if (payload.accountGeneration !== accountGeneration || body.accountGeneration !== accountGeneration) fail3("generation", "$");
  for (const field of ["snapshotId", "recordedAt"]) if (payload[field] !== body[field]) fail3("binding", `$.${field}`);
  for (const field of ["source", "summary"]) if (new TextDecoder().decode(canonicalBytes(payload[field])) !== new TextDecoder().decode(canonicalBytes(body[field]))) fail3("binding", `$.${field}`);
  if (payload.scopeCount !== body.scope.length || payload.snapshotId !== await deriveHistorySnapshotId(accountGeneration, payload.source)) fail3("binding", "$");
  const bytes = canonicalBytes(body);
  if (payload.reference.totalBytes !== bytes.byteLength || payload.reference.contentDigest !== await sha256Hex(bytes)) fail3("content_digest", "$.reference");
  return body;
}

// src/domain/app-data/core-records.js
var DIGEST_RE2 = /^[0-9a-f]{64}$/;
function fail4(code, path, message) {
  throw new AppDataValidationError(code, path, message);
}
function plainObject(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail4("type", path, "must be a plain object");
  if (Object.getPrototypeOf(value) !== Object.prototype) fail4("prototype", path, "must use Object.prototype");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key2 of Reflect.ownKeys(descriptors)) {
    if (typeof key2 !== "string") fail4("symbol", path, "symbol keys are not JSON");
    const descriptor = descriptors[key2];
    if (!descriptor || !Object.hasOwn(descriptor, "value")) fail4("accessor", `${path}.${key2}`, "accessors are not JSON");
    if (!descriptor.enumerable) fail4("non_enumerable", `${path}.${key2}`, "non-enumerable fields are not permitted");
  }
  return (
    /** @type {Record<string, unknown>} */
    value
  );
}
function exactFields(value, allowed, required, path) {
  for (const key2 of Object.keys(value)) if (!allowed.includes(key2)) fail4("unknown_field", `${path}.${key2}`, "unknown field is not permitted");
  for (const key2 of required) if (!Object.hasOwn(value, key2)) fail4("required", `${path}.${key2}`, "required field is missing");
}
function validateAttemptBinding(value, path = "$") {
  const record = plainObject(value, path);
  exactFields(record, ["attemptId", "parentAttemptId"], ["attemptId"], path);
  const attemptId = uuid3(record.attemptId, `${path}.attemptId`);
  if (Object.hasOwn(record, "parentAttemptId")) {
    const parentAttemptId = uuid3(record.parentAttemptId, `${path}.parentAttemptId`);
    if (parentAttemptId === attemptId) fail4("invariant", `${path}.parentAttemptId`, "parentAttemptId cannot equal attemptId");
  }
  return (
    /** @type {import("./contracts").AttemptContextBinding} */
    value
  );
}
function text3(value, path) {
  if (typeof value !== "string") fail4("type", path, "must be a string");
  if (utf8ByteLength(value) > APP_DATA_LIMITS.maxStringUtf8Bytes) fail4("utf8_limit", path, "string exceeds the configured UTF-8 limit");
  return value;
}
function opaqueText(value, path) {
  if (typeof value !== "string" || value.length === 0) fail4("range", path, "must be a non-empty string");
  if (utf8ByteLength(value) > 128) fail4("utf8_limit", path, "opaque identifier exceeds 128 UTF-8 bytes");
  return value;
}
function safeInteger(value, path) {
  if (!Number.isSafeInteger(value)) fail4("safe_integer", path, "must be a safe integer");
  return (
    /** @type {number} */
    value
  );
}
function nonNegativeInteger(value, path) {
  const result = safeInteger(value, path);
  if (result < 0) fail4("range", path, "must be non-negative");
  return result;
}
function booleanValue(value, path) {
  if (typeof value !== "boolean") fail4("type", path, "must be a boolean");
  return value;
}
function uuid3(value, path) {
  if (!isUuid(value)) fail4("uuid", path, "must be a canonical lowercase UUID");
  return value;
}
function questionKey(value, path) {
  if (!isQuestionKey(value)) fail4("question_key", path, "must be a bankUid/questionUid key");
  return value;
}
function digest3(value, path) {
  if (typeof value !== "string" || !DIGEST_RE2.test(value)) fail4("digest", path, "must be a lowercase SHA-256 hex digest");
  return value;
}
function arrayValue(value, path, maximum = APP_DATA_LIMITS.maxArrayItems) {
  if (!Array.isArray(value)) fail4("type", path, "must be an array");
  if (Object.getPrototypeOf(value) !== Array.prototype) fail4("prototype", path, "array must use Array.prototype");
  if (value.length > maximum) fail4("array_limit", path, "array exceeds the configured item limit");
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, "value")) fail4("array_hole", `${path}[${index}]`, "array holes/accessors are not permitted");
    if (!descriptor.enumerable) fail4("non_enumerable", `${path}[${index}]`, "non-enumerable array elements are not permitted");
  }
  for (const key2 of Reflect.ownKeys(value)) {
    if (key2 === "length") continue;
    if (typeof key2 !== "string" || !/^(0|[1-9][0-9]*)$/.test(key2) || Number(key2) >= value.length) fail4("array_property", path, "arrays may not have non-index properties");
  }
  return (
    /** @type {unknown[]} */
    value
  );
}
function assertSmallRecordBudget(value, path) {
  try {
    canonicalBytes(value);
  } catch (error) {
    if (error instanceof AppDataValidationError) throw new AppDataValidationError(error.code, path + error.path.slice(1), error.message);
    throw error;
  }
}
function validatedArray(values, path, validator) {
  for (let index = 0; index < values.length; index += 1) validator(values[index], `${path}[${index}]`);
  return values;
}
function uniqueOptionIds(value, path) {
  const values = arrayValue(value, path);
  const seen = /* @__PURE__ */ new Set();
  for (let index = 0; index < values.length; index += 1) {
    if (!isOptionId(values[index])) fail4("option_id", `${path}[${index}]`, "must be a revision-bound opt_ identifier");
    const option = (
      /** @type {string} */
      values[index]
    );
    if (seen.has(option)) fail4("duplicate", `${path}[${index}]`, "optionId must be unique");
    seen.add(option);
  }
  return (
    /** @type {string[]} */
    values
  );
}
function validateAnswerInput(value, path = "$") {
  const record = plainObject(value, path);
  if (record.kind === "choice") {
    exactFields(record, ["kind", "selectedOptionIds"], ["kind", "selectedOptionIds"], path);
    uniqueOptionIds(record.selectedOptionIds, `${path}.selectedOptionIds`);
    assertSmallRecordBudget(value, path);
    return (
      /** @type {import("./contracts").ChoiceInput} */
      value
    );
  }
  if (record.kind === "fill") {
    exactFields(record, ["kind", "fields"], ["kind", "fields"], path);
    const values = arrayValue(record.fields, `${path}.fields`);
    const seen = /* @__PURE__ */ new Set();
    validatedArray(values, `${path}.fields`, (entry, entryPath) => {
      const field = plainObject(entry, entryPath);
      exactFields(field, ["fieldId", "value"], ["fieldId", "value"], entryPath);
      const fieldId = opaqueText(field.fieldId, `${entryPath}.fieldId`);
      text3(field.value, `${entryPath}.value`);
      if (seen.has(fieldId)) fail4("duplicate", `${entryPath}.fieldId`, "fieldId must be unique");
      seen.add(fieldId);
    });
    assertSmallRecordBudget(value, path);
    return (
      /** @type {import("./contracts").FillInput} */
      value
    );
  }
  fail4("enum", `${path}.kind`, "input kind must be choice or fill");
}
function validateGradeAtTime(value, path = "$") {
  const record = plainObject(value, path);
  if (record.status === "ungraded") {
    exactFields(record, ["status"], ["status"], path);
    return (
      /** @type {import("./contracts").UngradedAtTime} */
      value
    );
  }
  if (record.status !== "graded") fail4("enum", `${path}.status`, "grade status must be graded or ungraded");
  exactFields(record, ["status", "correct", "score", "maxScore"], ["status", "correct", "score", "maxScore"], path);
  const correct = booleanValue(record.correct, `${path}.correct`);
  const score = record.score;
  const maxScore = record.maxScore;
  if (typeof score !== "number" || !Number.isFinite(score)) fail4("finite_number", `${path}.score`, "score must be finite");
  if (typeof maxScore !== "number" || !Number.isFinite(maxScore)) fail4("finite_number", `${path}.maxScore`, "maxScore must be finite");
  if (maxScore <= 0 || score < 0 || score > maxScore) fail4("range", path, "graded score must satisfy 0 <= score <= maxScore and maxScore > 0");
  void correct;
  assertSmallRecordBudget(value, path);
  return (
    /** @type {import("./contracts").GradedAtTime} */
    value
  );
}
function validateEquivalentRef(value, path) {
  const record = plainObject(value, path);
  exactFields(record, ["questionKey", "questionRevision"], ["questionKey", "questionRevision"], path);
  questionKey(record.questionKey, `${path}.questionKey`);
  digest3(record.questionRevision, `${path}.questionRevision`);
  return (
    /** @type {import("./contracts").EquivalentSourceRef} */
    value
  );
}
function validateAttemptRecord(value, path = "$") {
  const record = plainObject(value, path);
  exactFields(record, ["attemptId", "status", "startedAt", "scopeDigest", "scopeCount", "position", "effectiveElapsedMs", "localRevision", "actionSeq", "writerStreamId", "parentAttemptId"], ["attemptId", "status", "startedAt", "scopeDigest", "scopeCount", "position", "effectiveElapsedMs", "localRevision", "actionSeq", "writerStreamId"], path);
  uuid3(record.attemptId, `${path}.attemptId`);
  if (record.status !== "active" && record.status !== "completed") fail4("enum", `${path}.status`, "attempt status must be active or completed");
  nonNegativeInteger(record.startedAt, `${path}.startedAt`);
  digest3(record.scopeDigest, `${path}.scopeDigest`);
  const scopeCount = nonNegativeInteger(record.scopeCount, `${path}.scopeCount`);
  if (scopeCount < 1) fail4("range", `${path}.scopeCount`, "scopeCount must be at least one");
  const position = nonNegativeInteger(record.position, `${path}.position`);
  if (position >= scopeCount) fail4("range", `${path}.position`, "position must be within the scope");
  nonNegativeInteger(record.effectiveElapsedMs, `${path}.effectiveElapsedMs`);
  nonNegativeInteger(record.localRevision, `${path}.localRevision`);
  nonNegativeInteger(record.actionSeq, `${path}.actionSeq`);
  uuid3(record.writerStreamId, `${path}.writerStreamId`);
  if (Object.hasOwn(record, "parentAttemptId")) {
    uuid3(record.parentAttemptId, `${path}.parentAttemptId`);
    if (record.parentAttemptId === record.attemptId) fail4("invariant", `${path}.parentAttemptId`, "parentAttemptId cannot equal attemptId");
  }
  assertSmallRecordBudget(value, path);
  return (
    /** @type {import("./contracts").AttemptRecord} */
    value
  );
}
function validateAttemptScopeRecord(value, path = "$") {
  const record = plainObject(value, path);
  exactFields(record, ["attemptId", "ordinal", "questionKey", "questionRevision", "displayOrdinal", "equivalentSourceRefs"], ["attemptId", "ordinal", "questionKey", "questionRevision", "displayOrdinal", "equivalentSourceRefs"], path);
  uuid3(record.attemptId, `${path}.attemptId`);
  const ordinal = nonNegativeInteger(record.ordinal, `${path}.ordinal`);
  const displayOrdinal = nonNegativeInteger(record.displayOrdinal, `${path}.displayOrdinal`);
  if (displayOrdinal !== ordinal) fail4("invariant", `${path}.displayOrdinal`, "displayOrdinal must equal ordinal");
  const key2 = questionKey(record.questionKey, `${path}.questionKey`);
  const revision = digest3(record.questionRevision, `${path}.questionRevision`);
  const refs = arrayValue(record.equivalentSourceRefs, `${path}.equivalentSourceRefs`);
  if (refs.length < 1) fail4("range", `${path}.equivalentSourceRefs`, "at least the representative source is required");
  const seen = /* @__PURE__ */ new Set();
  let previous = "";
  validatedArray(refs, `${path}.equivalentSourceRefs`, (entry, entryPath) => {
    const ref = validateEquivalentRef(entry, entryPath);
    if (ref.questionKey < previous) fail4("order", `${entryPath}.questionKey`, "equivalentSourceRefs must be sorted by questionKey");
    previous = ref.questionKey;
    if (seen.has(ref.questionKey)) fail4("duplicate", `${entryPath}.questionKey`, "source questionKey must be unique");
    seen.add(ref.questionKey);
  });
  if (!seen.has(key2) || !refs.some((entry) => {
    const ref = (
      /** @type {import("./contracts").EquivalentSourceRef} */
      entry
    );
    return ref.questionKey === key2 && ref.questionRevision === revision;
  })) fail4("invariant", `${path}.equivalentSourceRefs`, "references must include the representative question and revision");
  assertSmallRecordBudget(value, path);
  return (
    /** @type {import("./contracts").AttemptScopeRecord} */
    value
  );
}
function validateAttemptScope(value, expectedAttemptId, expectedScopeCount) {
  const rows = arrayValue(value, "$", APP_DATA_CONTENT_LIMITS.maxArrayItems);
  try {
    canonicalContentBytes(value);
  } catch (error) {
    if (error instanceof AppDataValidationError) throw error;
    throw error;
  }
  if (rows.length < 1) fail4("range", "$", "scope must not be empty");
  if (expectedScopeCount !== void 0 && rows.length !== expectedScopeCount) fail4("count", "$", "scope length must equal expected scopeCount");
  const attemptId = expectedAttemptId;
  const keys = /* @__PURE__ */ new Set();
  const sourceKeys = /* @__PURE__ */ new Set();
  for (let index = 0; index < rows.length; index += 1) {
    const row = validateAttemptScopeRecord(rows[index], `$[${index}]`);
    if (index !== row.ordinal) fail4("ordinal", `$[${index}].ordinal`, "scope ordinals must be contiguous from zero");
    if (attemptId !== void 0 && row.attemptId !== attemptId) fail4("attempt_id", `$[${index}].attemptId`, "scope row has the wrong attemptId");
    if (index > 0 && row.attemptId !== /** @type {import("./contracts").AttemptScopeRecord} */
    rows[0].attemptId) fail4("attempt_id", `$[${index}].attemptId`, "all scope rows must have one attemptId");
    if (keys.has(row.questionKey)) fail4("duplicate", `$[${index}].questionKey`, "questionKey must be unique within scope");
    keys.add(row.questionKey);
    for (const source of row.equivalentSourceRefs) {
      if (sourceKeys.has(source.questionKey)) fail4("duplicate", `$[${index}].equivalentSourceRefs`, "a source questionKey may occur only once across scope rows");
      sourceKeys.add(source.questionKey);
    }
  }
  return (
    /** @type {import("./contracts").AttemptScopeRecord[]} */
    value
  );
}
function validateDraftShape(value, path) {
  const record = plainObject(value, path);
  exactFields(record, ["attemptId", "questionKey", "questionRevision", "input", "localRevision", "dirty", "submitted", "showKeys", "assisted", "writerStreamId", "fence", "inheritedFrom"], ["attemptId", "questionKey", "questionRevision", "input", "localRevision", "dirty", "submitted", "showKeys", "assisted", "writerStreamId", "fence"], path);
  uuid3(record.attemptId, `${path}.attemptId`);
  questionKey(record.questionKey, `${path}.questionKey`);
  digest3(record.questionRevision, `${path}.questionRevision`);
  validateAnswerInput(record.input, `${path}.input`);
  nonNegativeInteger(record.localRevision, `${path}.localRevision`);
  booleanValue(record.dirty, `${path}.dirty`);
  booleanValue(record.submitted, `${path}.submitted`);
  booleanValue(record.showKeys, `${path}.showKeys`);
  booleanValue(record.assisted, `${path}.assisted`);
  uuid3(record.writerStreamId, `${path}.writerStreamId`);
  if (nonNegativeInteger(record.fence, `${path}.fence`) < 1) fail4("range", `${path}.fence`, "fence must be positive");
  if (Object.hasOwn(record, "inheritedFrom")) {
    const inherited = plainObject(record.inheritedFrom, `${path}.inheritedFrom`);
    exactFields(inherited, ["attemptId", "resumeContentDigest"], ["attemptId", "resumeContentDigest"], `${path}.inheritedFrom`);
    uuid3(inherited.attemptId, `${path}.inheritedFrom.attemptId`);
    digest3(inherited.resumeContentDigest, `${path}.inheritedFrom.resumeContentDigest`);
    if (inherited.attemptId === record.attemptId) fail4("invariant", `${path}.inheritedFrom.attemptId`, "inherited parent cannot be the current attempt");
  }
  assertSmallRecordBudget(value, path);
  return (
    /** @type {import("./contracts").DraftRecord} */
    value
  );
}
function validateResumeDraftShape(value, path) {
  const record = plainObject(value, path);
  exactFields(record, ["questionKey", "questionRevision", "input", "localRevision", "submitted", "showKeys", "assisted", "inheritedFrom"], ["questionKey", "questionRevision", "input", "localRevision", "submitted", "showKeys", "assisted"], path);
  questionKey(record.questionKey, `${path}.questionKey`);
  digest3(record.questionRevision, `${path}.questionRevision`);
  validateAnswerInput(record.input, `${path}.input`);
  nonNegativeInteger(record.localRevision, `${path}.localRevision`);
  booleanValue(record.submitted, `${path}.submitted`);
  booleanValue(record.showKeys, `${path}.showKeys`);
  booleanValue(record.assisted, `${path}.assisted`);
  if (Object.hasOwn(record, "inheritedFrom")) {
    const inherited = plainObject(record.inheritedFrom, `${path}.inheritedFrom`);
    exactFields(inherited, ["attemptId", "resumeContentDigest"], ["attemptId", "resumeContentDigest"], `${path}.inheritedFrom`);
    uuid3(inherited.attemptId, `${path}.inheritedFrom.attemptId`);
    digest3(inherited.resumeContentDigest, `${path}.inheritedFrom.resumeContentDigest`);
  }
  assertSmallRecordBudget(value, path);
  return (
    /** @type {import("./contracts").ResumeDraft} */
    value
  );
}
function validateDraftRecord(value, path = "$", legacyExpectedAttemptId) {
  const record = validateDraftShape(value, path);
  const inherited = record.inheritedFrom;
  if (legacyExpectedAttemptId !== void 0 && inherited !== void 0 && inherited.attemptId === legacyExpectedAttemptId) {
    fail4("invariant", `${path}.inheritedFrom.attemptId`, "inherited parent cannot be the current attempt");
  }
  return record;
}
function validateDraftForAttempt(value, context, path = "$") {
  const binding2 = validateAttemptBinding(context, `${path}.context`);
  const record = validateDraftShape(value, path);
  if (record.attemptId !== binding2.attemptId) fail4("attempt_id", `${path}.attemptId`, "draft has the wrong current attemptId");
  validateInheritedParentBinding(record, binding2, path);
  return record;
}
function validateResumeDraft(value, path = "$", legacyCurrentAttemptId) {
  const record = validateResumeDraftShape(value, path);
  const inherited = record.inheritedFrom;
  if (legacyCurrentAttemptId !== void 0 && inherited !== void 0 && inherited.attemptId === legacyCurrentAttemptId) {
    fail4("invariant", `${path}.inheritedFrom.attemptId`, "inherited parent cannot be the current attempt");
  }
  return record;
}
function validateInheritedParentBinding(record, binding2, path) {
  const inherited = record.inheritedFrom;
  if (inherited === void 0) return;
  const parent = inherited.attemptId;
  if (binding2.parentAttemptId === void 0) fail4("invariant", `${path}.inheritedFrom.attemptId`, "inherited parent requires the containing attempt's parentAttemptId");
  if (parent !== binding2.parentAttemptId) fail4("invariant", `${path}.inheritedFrom.attemptId`, "inherited parent does not match the containing attempt's parentAttemptId");
}
function validateAnswerEvent(value, path = "$") {
  const record = plainObject(value, path);
  const base = ["eventId", "attemptId", "questionKey", "writerStreamId", "actionSeq", "kind", "occurredAt", "questionRevision", "assisted"];
  for (const key2 of ["eventId", "attemptId", "writerStreamId"]) uuid3(record[key2], `${path}.${key2}`);
  questionKey(record.questionKey, `${path}.questionKey`);
  if (nonNegativeInteger(record.actionSeq, `${path}.actionSeq`) < 1) fail4("range", `${path}.actionSeq`, "actionSeq must be positive");
  nonNegativeInteger(record.occurredAt, `${path}.occurredAt`);
  digest3(record.questionRevision, `${path}.questionRevision`);
  const assisted = booleanValue(record.assisted, `${path}.assisted`);
  if (record.kind === "answer_submitted") {
    exactFields(record, [...base, "answer", "gradeAtTime", "graderVersion", "gradingBasisDigest"], [...base, "answer", "gradeAtTime", "graderVersion", "gradingBasisDigest"], path);
    validateAnswerInput(record.answer, `${path}.answer`);
    validateGradeAtTime(record.gradeAtTime, `${path}.gradeAtTime`);
    opaqueText(record.graderVersion, `${path}.graderVersion`);
    digest3(record.gradingBasisDigest, `${path}.gradingBasisDigest`);
    void assisted;
    assertSmallRecordBudget(value, path);
    return (
      /** @type {import("./contracts").SubmitAnswerEvent} */
      value
    );
  }
  if (record.kind === "redo") {
    exactFields(record, [...base, "redoOfEventId"], [...base, "redoOfEventId"], path);
    uuid3(record.redoOfEventId, `${path}.redoOfEventId`);
    assertSmallRecordBudget(value, path);
    return (
      /** @type {import("./contracts").RedoEvent} */
      value
    );
  }
  if (record.kind === "hint") {
    exactFields(record, [...base, "hintKind"], [...base, "hintKind"], path);
    opaqueText(record.hintKind, `${path}.hintKind`);
    if (assisted !== true) fail4("invariant", `${path}.assisted`, "hint events must have assisted=true");
    assertSmallRecordBudget(value, path);
    return (
      /** @type {import("./contracts").HintEvent} */
      value
    );
  }
  fail4("enum", `${path}.kind`, "event kind must be answer_submitted, redo, or hint");
}

// src/domain/app-data/snapshot-continuation.js
var fail5 = (code) => {
  throw new AppDataValidationError(code, "$.snapshotBaseline", "Invalid snapshot continuation");
};
var same = (a, b) => new TextDecoder().decode(canonicalBytes(a)) === new TextDecoder().decode(canonicalBytes(b));
var proofs = /* @__PURE__ */ new WeakMap();
function exact2(value, keys) {
  canonicalBytes(value);
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail5("snapshot_fields");
  const record = (
    /** @type {Record<string,unknown>} */
    value
  );
  if (Object.keys(record).sort().join() !== [...keys].sort().join()) fail5("snapshot_fields");
  return record;
}
function uuid4(value) {
  if (!isUuid(value)) fail5("snapshot_identity");
  return (
    /** @type {UUID} */
    value
  );
}
function digest4(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) fail5("snapshot_identity");
  return value;
}
function integer3(value) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail5("snapshot_receipt");
  return value;
}
function freezeOwned(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeOwned(child);
    Object.freeze(value);
  }
}
function capturedProof(proof) {
  return proof !== null && typeof proof === "object" ? proofs.get(proof) : void 0;
}
function validateSnapshotBaselineShape(value) {
  const record = exact2(value, ["format", "accountGeneration", "snapshotId", "snapshotReference", "continuationKey"]);
  if (record.format !== "qb-snapshot-baseline-v1") fail5("snapshot_baseline");
  return {
    format: record.format,
    accountGeneration: uuid4(record.accountGeneration),
    snapshotId: uuid4(record.snapshotId),
    snapshotReference: validateContentReference(record.snapshotReference),
    continuationKey: digest4(record.continuationKey)
  };
}
async function deriveSnapshotContinuationKey(generation, snapshotId, contentDigest) {
  return sha256Hex(canonicalBytes(["qb-snapshot-continue-v1", uuid4(generation), uuid4(snapshotId), digest4(contentDigest)]));
}
function questionInputShape(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail5("snapshot_question_dependency");
  const record = (
    /** @type {Record<string,unknown>} */
    value
  );
  for (const key2 of ["questionKey", "questionRevision", "type", "choices", "optionIds", "blanks"]) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key2);
    if (descriptor && (!Object.hasOwn(descriptor, "value") || !descriptor.enumerable)) fail5("snapshot_question_dependency");
  }
  if (typeof record.questionKey !== "string" || typeof record.questionRevision !== "string") fail5("snapshot_question_dependency");
  const type = record.type ?? "choice", choices = record.choices ?? [], ids = record.optionIds ?? [], blanks = record.blanks ?? [];
  if (type !== "choice" && type !== "fill") fail5("snapshot_input");
  if (!Array.isArray(choices) || !Array.isArray(ids) || !Array.isArray(blanks)) fail5("snapshot_input");
  const optionIds = validateAnswerInput({ kind: "choice", selectedOptionIds: ids });
  if (optionIds.kind !== "choice") fail5("snapshot_input");
  return { questionKey: record.questionKey, questionRevision: record.questionRevision, type, choices, optionIds: optionIds.selectedOptionIds, blanks };
}
function snapshotPrefillInput(saved, question) {
  const q = questionInputShape(question), choices = q.choices, ids = q.optionIds;
  if (saved.selectedIndex !== null && (!Number.isSafeInteger(saved.selectedIndex) || saved.selectedIndex < 0 || saved.selectedIndex >= choices.length) || saved.selectedSet.some((n) => !Number.isSafeInteger(n) || n < 0 || n >= choices.length)) fail5("snapshot_input");
  if (q.type === "fill") {
    if (saved.selectedIndex !== null || saved.selectedSet.length || saved.fillInputs.length > q.blanks.length) fail5("snapshot_input");
    return validateAnswerInput({ kind: "fill", fields: saved.fillInputs.map((value, index) => ({ fieldId: `blank-${index}`, value })) });
  }
  if (saved.fillInputs.length || ids.length !== choices.length) fail5("snapshot_input");
  const indexes = saved.selectedSet.length ? saved.selectedSet : saved.selectedIndex === null ? [] : [saved.selectedIndex];
  return validateAnswerInput({ kind: "choice", selectedOptionIds: indexes.map((index) => {
    const optionId = ids[index];
    if (optionId === void 0) fail5("snapshot_input");
    return optionId;
  }) });
}
async function validateSnapshotContinuationBaseline(baseline, { owner, readSnapshot, resolveQuestion, isTombstoned }) {
  const checkedBaseline = validateSnapshotBaselineShape(baseline);
  const owned = validateSnapshotBaselineShape(
    /** @type {unknown} */
    JSON.parse(new TextDecoder().decode(canonicalBytes(checkedBaseline)))
  );
  if (owner.ownerKind !== "account" || owner.accountGeneration !== owned.accountGeneration) fail5("snapshot_owner");
  if (typeof readSnapshot !== "function" || typeof resolveQuestion !== "function" || typeof isTombstoned !== "function") fail5("snapshot_missing_dependency");
  if (await isTombstoned("history_snapshot", owned.snapshotId)) fail5("snapshot_tombstone");
  const snapshot = await readSnapshot(owned.snapshotId);
  if (!snapshot) fail5("snapshot_missing_dependency");
  const body = (
    /** @type {Snapshot} */
    await validateHistorySnapshotBinding(snapshot.record, snapshot.body, { accountGeneration: owner.accountGeneration })
  );
  const record = (
    /** @type {import('./contracts').HistorySnapshotPayload} */
    snapshot.record
  );
  if (body.snapshotId !== owned.snapshotId || !same(record.reference, owned.snapshotReference) || owned.continuationKey !== await deriveSnapshotContinuationKey(owned.accountGeneration, owned.snapshotId, owned.snapshotReference.contentDigest)) fail5("snapshot_binding");
  const captured = (
    /** @type {Snapshot} */
    JSON.parse(new TextDecoder().decode(canonicalBytes(body)))
  );
  validateImportedHistorySnapshot(captured);
  const inputs = /* @__PURE__ */ new Map();
  for (const row of captured.scope) {
    let representative;
    for (const ref of row.equivalentSourceRefs) {
      const bankUid = ref.questionKey.split("/")[0];
      if (bankUid === void 0) fail5("snapshot_question_dependency");
      if (await isTombstoned("bank", bankUid)) fail5("snapshot_tombstone");
      const q = questionInputShape(await resolveQuestion(ref));
      if (q.questionKey !== ref.questionKey || q.questionRevision !== ref.questionRevision) fail5("snapshot_question_dependency");
      if (ref.questionKey === row.questionKey) representative = q;
    }
    if (representative === void 0) fail5("snapshot_question_dependency");
    const answer = captured.answers.find((answer2) => answer2.legacyQuestionId === row.legacyQuestionId);
    if (answer) inputs.set(row.questionKey, snapshotPrefillInput(answer.savedInput, representative));
  }
  freezeOwned(owned);
  const proof = Object.freeze({ status: "snapshot_baseline_verified", baseline: owned });
  proofs.set(proof, { baseline: owned, body: captured, inputs });
  return proof;
}
function assertSnapshotContinuationState(state, proof) {
  canonicalContentBytes(state);
  const checked = capturedProof(proof);
  if (!checked || !same(state.snapshotBaseline, checked.baseline)) fail5("snapshot_missing_dependency");
  if (state.scope.length !== checked.body.scope.length) fail5("snapshot_scope");
  for (const [index, row] of state.scope.entries()) assertSnapshotContinuationScope(row, index, proof);
  for (const draft of state.questionDrafts) assertSnapshotContinuationDraft(draft, state.localRevision, proof);
  if (state.localRevision === 1 && (state.submittedEventIds.length || state.questionDrafts.length !== checked.inputs.size)) fail5("snapshot_initial_events");
  return proof;
}
function validateSnapshotContinuationReceipt(value) {
  const record = exact2(value, ["sourceId", "sourceRecordId", "provenance", "importedAt"]);
  const p = exact2(record.provenance, ["format", "generation", "snapshotId", "snapshotContentDigest", "attemptId", "commandId"]);
  if (p.format !== "qb-snapshot-continuation-receipt-v1" || record.sourceId !== p.format) fail5("snapshot_receipt");
  return { sourceId: p.format, sourceRecordId: digest4(record.sourceRecordId), importedAt: integer3(record.importedAt), provenance: {
    format: p.format,
    generation: uuid4(p.generation),
    snapshotId: uuid4(p.snapshotId),
    snapshotContentDigest: digest4(p.snapshotContentDigest),
    attemptId: uuid4(p.attemptId),
    commandId: uuid4(p.commandId)
  } };
}
async function assertSnapshotContinuationReceipt(value, baseline, { attemptId, commandId }) {
  const receipt = validateSnapshotContinuationReceipt(value), b = validateSnapshotBaselineShape(baseline), p = receipt.provenance;
  if (receipt.sourceRecordId !== b.continuationKey || receipt.sourceRecordId !== await deriveSnapshotContinuationKey(p.generation, p.snapshotId, p.snapshotContentDigest) || p.generation !== b.accountGeneration || p.snapshotId !== b.snapshotId || p.snapshotContentDigest !== b.snapshotReference.contentDigest || p.attemptId !== attemptId || p.commandId !== commandId || p.commandId !== await deriveSnapshotContinuationCommandId(b.continuationKey)) fail5("snapshot_receipt_binding");
  return receipt;
}
function assertSnapshotContinuationScope(row, index, proof) {
  const checked = capturedProof(proof), source = checked?.body.scope[index];
  if (!source || row.ordinal !== index || row.displayOrdinal !== index || row.questionKey !== source.questionKey || row.questionRevision !== source.questionRevision || !same(row.equivalentSourceRefs, source.equivalentSourceRefs.map(({ bankRevision, ...ref }) => ref))) fail5("snapshot_scope");
}
function assertSnapshotContinuationDraft(draft, localRevision, proof) {
  const checked = capturedProof(proof);
  if (!checked) fail5("snapshot_missing_dependency");
  const source = checked.body.scope.find((row) => row.questionKey === draft.questionKey);
  const answer = checked.body.answers.find((answer2) => answer2.legacyQuestionId === source?.legacyQuestionId);
  if (!source || draft.inheritedFrom) fail5("snapshot_native_parent");
  if (answer?.savedInput.showKeys && (!draft.assisted || localRevision === 1 && !draft.showKeys)) fail5("snapshot_assistance_downgrade");
  if (localRevision === 1 && (draft.submitted || !same(draft.input, checked.inputs.get(draft.questionKey)))) fail5("snapshot_initial_draft");
}
async function continuationUuid(tag, key2) {
  const hex = (await sha256Hex(canonicalBytes([tag, digest4(key2)]))).slice(0, 32);
  if (!/^[0-9a-f]{32}$/.test(hex)) fail5("snapshot_identity");
  const variant = (8 + (parseInt(hex.charAt(16), 16) & 3)).toString(16);
  return uuid4(`${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20)}`);
}
async function deriveSnapshotContinuationCommandId(key2) {
  return continuationUuid("qb-snapshot-continuation-command-v1", key2);
}
function snapshotContinuationProofKey(proof) {
  return capturedProof(proof)?.baseline.continuationKey;
}

// src/domain/app-data/identity.js
var MAX_SOURCE_ORIGIN_BYTES = 2048;
var MAX_NAMESPACE_BYTES = 256;
var MAX_ALIAS_COMPONENT_BYTES = 512;
var DIGEST_RE3 = /^[0-9a-f]{64}$/;
function fail6(code, path, message) {
  throw new AppDataValidationError(code, path, message);
}
function text4(value, path, maximum = MAX_ALIAS_COMPONENT_BYTES) {
  if (typeof value !== "string" || value.length === 0 || utf8ByteLength(value) > maximum) fail6("alias_component", path, `must be non-empty and at most ${maximum} UTF-8 bytes`);
  return value;
}
function questionKey2(value, path) {
  if (!isQuestionKey(value)) fail6("question_key", path, "must be a bankUid/questionUid key");
  return value;
}
function makeSourceKey(sourceOrigin, namespace) {
  const origin = text4(sourceOrigin, "$.sourceOrigin", MAX_SOURCE_ORIGIN_BYTES);
  const name = text4(namespace, "$.namespace", MAX_NAMESPACE_BYTES);
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    fail6("origin", "$.sourceOrigin", "must be a valid origin URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:" || parsed.origin !== origin || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) fail6("origin", "$.sourceOrigin", "must be an explicit http(s) origin without credentials or path");
  return JSON.stringify([origin, name]);
}
function makeLegacyId(rawId, runtimeId) {
  return JSON.stringify([text4(rawId, "$.legacyRawId"), text4(runtimeId, "$.legacyRuntimeId")]);
}
function validateAlias(value) {
  canonicalBytes(value);
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail6("type", "$", "alias must be a plain object");
  const record = (
    /** @type {Record<string, unknown>} */
    value
  );
  const allowed = ["sourceOrigin", "namespace", "sourceKey", "legacyRevision", "legacyId", "legacyRawId", "legacyRuntimeId", "mappingStatus", "candidates", "newQuestionKey"];
  for (const key2 of Object.keys(record)) if (!allowed.includes(key2)) fail6("unknown_field", `$.${key2}`, "unknown alias field");
  for (const key2 of ["sourceOrigin", "namespace", "sourceKey", "legacyRevision", "legacyId", "legacyRawId", "legacyRuntimeId", "mappingStatus", "candidates"]) if (!Object.hasOwn(record, key2)) fail6("required", `$.${key2}`, "required alias field is missing");
  const sourceOrigin = text4(record.sourceOrigin, "$.sourceOrigin", MAX_SOURCE_ORIGIN_BYTES);
  const namespace = text4(record.namespace, "$.namespace", MAX_NAMESPACE_BYTES);
  if (record.sourceKey !== makeSourceKey(sourceOrigin, namespace)) fail6("source_key", "$.sourceKey", "sourceKey must equal JSON.stringify([sourceOrigin, namespace])");
  const legacyRawId = text4(record.legacyRawId, "$.legacyRawId");
  const legacyRuntimeId = text4(record.legacyRuntimeId, "$.legacyRuntimeId");
  if (record.legacyId !== makeLegacyId(legacyRawId, legacyRuntimeId)) fail6("legacy_id", "$.legacyId", "legacyId must equal JSON.stringify([legacyRawId, legacyRuntimeId])");
  const revision = text4(record.legacyRevision, "$.legacyRevision");
  if (revision.startsWith("unknown:")) {
    if (!DIGEST_RE3.test(revision.slice(8))) fail6("legacy_revision", "$.legacyRevision", "unknown revision must include a source digest");
  }
  const status = record.mappingStatus;
  if (status !== "mapped" && status !== "unknown" && status !== "quarantined") fail6("mapping_status", "$.mappingStatus", "invalid mapping status");
  if (!Array.isArray(record.candidates)) fail6("type", "$.candidates", "candidates must be an array");
  const candidates = record.candidates;
  const seen = /* @__PURE__ */ new Set();
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = questionKey2(candidates[i], `$.candidates[${i}]`);
    if (seen.has(candidate)) fail6("duplicate", `$.candidates[${i}]`, "candidate is duplicated");
    seen.add(candidate);
  }
  if (status === "mapped") {
    if (!Object.hasOwn(record, "newQuestionKey")) fail6("required", "$.newQuestionKey", "mapped alias requires a target");
    if (typeof record.newQuestionKey !== "string") fail6("type", "$.newQuestionKey", "mapped alias target must be a string");
    const target = questionKey2(record.newQuestionKey, "$.newQuestionKey");
    if (candidates.length !== 1 || candidates[0] !== target) fail6("mapping", "$.candidates", "mapped alias needs exactly its deterministic target");
  } else if (Object.hasOwn(record, "newQuestionKey")) fail6("mapping", "$.newQuestionKey", "unknown/quarantined alias cannot claim a target");
  return (
    /** @type {import("./contracts").QuestionAliasRecord} */
    value
  );
}

// src/domain/app-data/export-manifest.js
var DIGEST_RE4 = /^[0-9a-f]{64}$/;
var DECIMAL_RE = /^(0|[1-9][0-9]{0,19})$/;
var COVERAGE_KEYS = ["facts", "attempts", "drafts", "mutations", "outbox", "conflicts", "tombstones", "legacy", "content"];
var SAFE_PATH_RE = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;
function fail7(code, path, message) {
  throw new AppDataValidationError(code, path, message);
}
function object2(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail7("type", path, "must be a plain object");
  return (
    /** @type {Record<string, unknown>} */
    value
  );
}
function exact3(value, required, optional, path) {
  const allowed = /* @__PURE__ */ new Set([...required, ...optional]);
  for (const key2 of Reflect.ownKeys(value)) {
    if (typeof key2 !== "string" || !allowed.has(key2)) fail7("unknown_field", `${path}.${String(key2)}`, "unknown field");
  }
  for (const key2 of required) if (!Object.hasOwn(value, key2)) fail7("required", `${path}.${key2}`, "required field is missing");
}
function text5(value, path) {
  if (typeof value !== "string" || value.length === 0 || utf8ByteLength(value) > APP_DATA_LIMITS.maxStringUtf8Bytes) fail7("string", path, "must be a bounded non-empty string");
  return value;
}
function uuid5(value, path) {
  if (typeof value !== "string" || !isUuid(value)) fail7("uuid", path, "must be a canonical lowercase UUID");
  return value;
}
function digest5(value, path) {
  if (typeof value !== "string" || !DIGEST_RE4.test(value)) fail7("digest", path, "must be a lowercase SHA-256 digest");
  return value;
}
function decimal(value, path) {
  if (typeof value !== "string" || !DECIMAL_RE.test(value)) fail7("decimal", path, "must be a non-negative decimal string");
  return value;
}
function nonNegative2(value, path) {
  const number = (
    /** @type {number} */
    value
  );
  if (!Number.isSafeInteger(number) || number < 0) fail7("integer", path, "must be a non-negative safe integer");
  return number;
}
function section(value, path) {
  const item = object2(value, path);
  exact3(item, ["path", "count", "utf8Bytes", "sha256"], [], path);
  const file = text5(item.path, `${path}.path`);
  if (utf8ByteLength(file) > 256 || !SAFE_PATH_RE.test(file) || file.split("/").some((part) => part === "." || part === "..")) fail7("path", `${path}.path`, "must be a unique safe relative archive path");
  nonNegative2(item.count, `${path}.count`);
  nonNegative2(item.utf8Bytes, `${path}.utf8Bytes`);
  digest5(item.sha256, `${path}.sha256`);
  return file;
}
function validateExportManifest(value) {
  canonicalBytes(value);
  const record = object2(value, "$");
  const sync = ["accountGeneration", "serverLogEpoch", "exportCut", "throughServerSeq"];
  exact3(record, ["format", "schemaVersion", "exportId", "appVersion", "sourceProfileHint", "sections", "legacySourceDigests", "complete", "partial", "coverage", "partialReasons"], [...sync, "storeSetVersion"], "$");
  if (Object.hasOwn(record, "storeSetVersion") && record.storeSetVersion !== 1 && record.storeSetVersion !== 2) fail7("version", "$.storeSetVersion", "unsupported portable store layout");
  if (record.format !== "qb-appdata-v2") fail7("format", "$.format", "unsupported export format");
  if (record.schemaVersion !== APP_DATA_EXCHANGE_SCHEMA_VERSION) fail7("version", "$.schemaVersion", "only exchange schema version 2 is supported");
  uuid5(record.exportId, "$.exportId");
  if (typeof record.appVersion !== "string" || record.appVersion.length === 0 || utf8ByteLength(record.appVersion) > 128) fail7("string", "$.appVersion", "appVersion must be 1..128 UTF-8 bytes");
  if (typeof record.sourceProfileHint !== "string" || utf8ByteLength(record.sourceProfileHint) > 256) fail7("string", "$.sourceProfileHint", "source profile hint must be a bounded string");
  if (!Array.isArray(record.sections) || record.sections.length === 0 || record.sections.length > APP_DATA_LIMITS.maxArrayItems) fail7("sections", "$.sections", "sections must be a non-empty bounded array");
  const paths = /* @__PURE__ */ new Set();
  for (let i = 0; i < record.sections.length; i += 1) {
    const file = section(record.sections[i], `$.sections[${i}]`);
    if (paths.has(file)) fail7("duplicate", `$.sections[${i}].path`, "section path must be unique");
    paths.add(file);
  }
  if (!Array.isArray(record.legacySourceDigests)) fail7("type", "$.legacySourceDigests", "must be an array");
  const digests2 = /* @__PURE__ */ new Set();
  for (let i = 0; i < record.legacySourceDigests.length; i += 1) {
    const item = digest5(record.legacySourceDigests[i], `$.legacySourceDigests[${i}]`);
    if (digests2.has(item)) fail7("duplicate", `$.legacySourceDigests[${i}]`, "legacy source digest duplicated");
    digests2.add(item);
  }
  if (typeof record.complete !== "boolean" || typeof record.partial !== "boolean" || record.complete === record.partial) fail7("invariant", "$", "exactly one of complete and partial must be true");
  const coverage = object2(record.coverage, "$.coverage");
  exact3(coverage, COVERAGE_KEYS, [], "$.coverage");
  for (const key2 of COVERAGE_KEYS) if (typeof coverage[key2] !== "boolean") fail7("type", `$.coverage.${key2}`, "coverage flag must be boolean");
  if (!Array.isArray(record.partialReasons)) fail7("type", "$.partialReasons", "must be an array");
  const reasons = /* @__PURE__ */ new Set();
  for (let i = 0; i < record.partialReasons.length; i += 1) {
    const reason = text5(record.partialReasons[i], `$.partialReasons[${i}]`);
    if (utf8ByteLength(reason) > 128) fail7("string", `$.partialReasons[${i}]`, "partial reason is too long");
    if (reasons.has(reason)) fail7("duplicate", `$.partialReasons[${i}]`, "partial reason duplicated");
    reasons.add(reason);
  }
  const allCovered = COVERAGE_KEYS.every((key2) => coverage[key2] === true);
  if (record.complete && (!allCovered || reasons.size !== 0)) fail7("invariant", "$", "complete manifest must cover every category and have no partial reasons");
  if (record.partial && reasons.size === 0) fail7("required", "$.partialReasons", "partial manifest must explain omissions");
  const present = sync.map((key2) => Object.hasOwn(record, key2));
  if (present.some(Boolean) && !present.every(Boolean)) fail7("invariant", "$", "cloud cut fields must be all present or all absent");
  if (present.every(Boolean)) {
    uuid5(record.accountGeneration, "$.accountGeneration");
    uuid5(record.serverLogEpoch, "$.serverLogEpoch");
    decimal(record.exportCut, "$.exportCut");
    decimal(record.throughServerSeq, "$.throughServerSeq");
    if (record.exportCut !== record.throughServerSeq) fail7("invariant", "$.throughServerSeq", "throughServerSeq must equal exportCut");
  }
  return (
    /** @type {import("./contracts").ExportManifest} */
    value
  );
}

// src/domain/app-data/resume-dependencies.js
var DIGEST_RE5 = /^[0-9a-f]{64}$/;
var MAX_DEPENDENCY_BUNDLES = 32;
var MAX_ANCESTOR_EDGES = 32;
function fail8(code, path, message) {
  throw new AppDataValidationError(code, path, message);
}
function plainObject2(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail8("type", path, "must be a plain object");
  if (Object.getPrototypeOf(value) !== Object.prototype) fail8("prototype", path, "must use Object.prototype");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key2 of Reflect.ownKeys(descriptors)) {
    if (typeof key2 !== "string") fail8("symbol", path, "symbol keys are not JSON");
    const descriptor = descriptors[key2];
    if (!descriptor || !Object.hasOwn(descriptor, "value")) fail8("accessor", `${path}.${key2}`, "accessors are not JSON");
    if (!descriptor.enumerable) fail8("non_enumerable", `${path}.${key2}`, "non-enumerable fields are not permitted");
  }
  return (
    /** @type {Record<string, unknown>} */
    value
  );
}
function exactFields2(value, allowed, required, path) {
  for (const key2 of Object.keys(value)) if (!allowed.includes(key2)) fail8("unknown_field", `${path}.${key2}`, "unknown field is not permitted");
  for (const key2 of required) if (!Object.hasOwn(value, key2)) fail8("required", `${path}.${key2}`, "required field is missing");
}
function uuid6(value, path) {
  if (!isUuid(value)) fail8("uuid", path, "must be a canonical lowercase UUID");
  return (
    /** @type {string} */
    value
  );
}
function digest6(value, path) {
  if (typeof value !== "string" || !DIGEST_RE5.test(value)) fail8("digest", path, "must be a lowercase SHA-256 hex digest");
  return value;
}
function nonNegativeInteger2(value, path) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail8("range", path, "must be a non-negative safe integer");
  return (
    /** @type {number} */
    value
  );
}
function boundedArray(value, path, max) {
  if (!Array.isArray(value)) fail8("type", path, "must be an array");
  if (Object.getPrototypeOf(value) !== Array.prototype) fail8("prototype", path, "array must use Array.prototype");
  if (value.length > max) fail8("array_limit", path, "array exceeds the configured item limit");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) fail8("array_hole", `${path}[${index}]`, "array holes/accessors are not permitted");
  }
  for (const key2 of Reflect.ownKeys(descriptors)) {
    if (key2 === "length") continue;
    if (typeof key2 !== "string" || !/^(0|[1-9][0-9]*)$/.test(key2) || Number(key2) >= value.length) fail8("array_property", path, "arrays may not have non-index properties");
  }
  return (
    /** @type {unknown[]} */
    value
  );
}
function validateResumeAttemptBinding(value, path = "$") {
  const record = plainObject2(value, path);
  exactFields2(record, ["attemptId", "writerStreamId", "scopeDigest", "scopeCount", "parentAttemptId"], ["attemptId", "writerStreamId", "scopeDigest", "scopeCount"], path);
  const attemptId = uuid6(record.attemptId, `${path}.attemptId`);
  uuid6(record.writerStreamId, `${path}.writerStreamId`);
  digest6(record.scopeDigest, `${path}.scopeDigest`);
  if (nonNegativeInteger2(record.scopeCount, `${path}.scopeCount`) < 1) fail8("range", `${path}.scopeCount`, "scopeCount must be positive");
  if (Object.hasOwn(record, "parentAttemptId")) {
    const parent = uuid6(record.parentAttemptId, `${path}.parentAttemptId`);
    if (parent === attemptId) fail8("invariant", `${path}.parentAttemptId`, "parentAttemptId cannot equal attemptId");
  }
  return (
    /** @type {import("./contracts").ResumeAttemptBinding} */
    value
  );
}
function validateResumeState(value, path = "$") {
  const record = plainObject2(value, path);
  exactFields2(record, [...record.schemaVersion === 2 ? ["snapshotBaseline"] : [], "schemaVersion", "attemptId", "writerStreamId", "localRevision", "baseRevision", "scopeDigest", "questionDrafts", "submittedEventIds", "position", "effectiveElapsedMs", "scope"], ["schemaVersion", "attemptId", "writerStreamId", "localRevision", "baseRevision", "scopeDigest", "questionDrafts", "submittedEventIds", "position", "effectiveElapsedMs", "scope"], path);
  if (record.schemaVersion !== 1 && record.schemaVersion !== 2) fail8("version", `${path}.schemaVersion`, "unsupported resume schemaVersion");
  if (record.schemaVersion === 2) validateSnapshotBaselineShape(record.snapshotBaseline);
  const attemptId = uuid6(record.attemptId, `${path}.attemptId`);
  uuid6(record.writerStreamId, `${path}.writerStreamId`);
  if (nonNegativeInteger2(record.localRevision, `${path}.localRevision`) < 1) fail8("range", `${path}.localRevision`, "localRevision must be positive");
  nonNegativeInteger2(record.baseRevision, `${path}.baseRevision`);
  digest6(record.scopeDigest, `${path}.scopeDigest`);
  const scope = validateAttemptScope(
    boundedArray(record.scope, `${path}.scope`, APP_DATA_CONTENT_LIMITS.maxArrayItems),
    attemptId,
    /** @type {unknown[]} */
    record.scope.length
  );
  const drafts = boundedArray(record.questionDrafts, `${path}.questionDrafts`, APP_DATA_CONTENT_LIMITS.maxArrayItems);
  const scopeRows = new Map(scope.map((row) => [row.questionKey, row]));
  const draftKeys = /* @__PURE__ */ new Set();
  for (let index = 0; index < drafts.length; index += 1) {
    const draft = validateResumeDraft(drafts[index], `${path}.questionDrafts[${index}]`);
    if (draftKeys.has(draft.questionKey)) fail8("duplicate", `${path}.questionDrafts[${index}].questionKey`, "questionDrafts must be unique");
    draftKeys.add(draft.questionKey);
    if (draft.inheritedFrom?.attemptId === attemptId) fail8("invariant", `${path}.questionDrafts[${index}].inheritedFrom.attemptId`, "inherited parent cannot equal current attempt");
    const row = scopeRows.get(draft.questionKey);
    if (!row) fail8("invariant", `${path}.questionDrafts[${index}].questionKey`, "draft question is not in scope");
    if (row.questionRevision !== draft.questionRevision) fail8("invariant", `${path}.questionDrafts[${index}].questionRevision`, "draft revision does not match scope");
  }
  const submitted = boundedArray(record.submittedEventIds, `${path}.submittedEventIds`, APP_DATA_CONTENT_LIMITS.maxArrayItems);
  const submittedIds = /* @__PURE__ */ new Set();
  for (let index = 0; index < submitted.length; index += 1) {
    const eventId = uuid6(submitted[index], `${path}.submittedEventIds[${index}]`);
    if (submittedIds.has(eventId)) fail8("duplicate", `${path}.submittedEventIds[${index}]`, "submittedEventIds must be unique");
    submittedIds.add(eventId);
  }
  const position = nonNegativeInteger2(record.position, `${path}.position`);
  if (position >= scope.length) fail8("range", `${path}.position`, "position must be within scope");
  nonNegativeInteger2(record.effectiveElapsedMs, `${path}.effectiveElapsedMs`);
  canonicalContentBytes(record);
  return (
    /** @type {import("./contracts").ResumeState} */
    value
  );
}
function captureValue(value, path, budget) {
  const bytes = canonicalContentBytes(value);
  budget.used += bytes.byteLength;
  if (budget.used > APP_DATA_CONTENT_LIMITS.maxCanonicalUtf8Bytes) fail8("dependency_limit", path, "resume dependency snapshot exceeds 100 MiB");
  const owned = JSON.parse(new TextDecoder().decode(bytes));
  return { value: owned, bytes };
}
function captureBundleValues(state, reference, manifest, events, expectedAttempt, path, budget) {
  const stateCapture = captureValue(state, `${path}.state`, budget);
  const validState = validateResumeState(stateCapture.value, `${path}.state`);
  const referenceCapture = captureValue(reference, `${path}.reference`, budget);
  const validReference = validateResumeReference(referenceCapture.value, `${path}.reference`);
  let validManifest;
  let manifestBytes;
  if (manifest !== void 0) {
    const manifestCapture = captureValue(manifest, `${path}.manifest`, budget);
    validManifest = validateChunkManifest(manifestCapture.value, `${path}.manifest`);
    manifestBytes = manifestCapture.bytes;
  }
  const eventsCapture = captureValue(events, `${path}.events`, budget);
  const eventValues = boundedArray(eventsCapture.value, `${path}.events`, APP_DATA_CONTENT_LIMITS.maxArrayItems);
  const validEvents = [];
  const eventIds = /* @__PURE__ */ new Set();
  for (let index = 0; index < eventValues.length; index += 1) {
    const event = validateAnswerEvent(eventValues[index], `${path}.events[${index}]`);
    if (eventIds.has(event.eventId)) fail8("duplicate", `${path}.events[${index}].eventId`, "eventId must be unique");
    eventIds.add(event.eventId);
    validEvents.push(event);
  }
  const expectedCapture = captureValue(expectedAttempt, `${path}.expectedAttempt`, budget);
  const validExpected = validateResumeAttemptBinding(expectedCapture.value, `${path}.expectedAttempt`);
  return {
    state: validState,
    reference: validReference,
    manifest: validManifest,
    events: (
      /** @type {AnswerEventRecord[]} */
      validEvents
    ),
    expectedAttempt: validExpected,
    stateBytes: stateCapture.bytes,
    scopeBytes: canonicalContentBytes(validState.scope),
    referenceBytes: referenceCapture.bytes,
    manifestBytes,
    expectedBytes: expectedCapture.bytes,
    eventsBytes: eventsCapture.bytes
  };
}
function validateBundleRelationships(captured, expected, path) {
  if (captured.state.attemptId !== expected.attemptId) fail8("attempt_id", `${path}.state.attemptId`, "resume state attempt does not match expected attempt");
  if (captured.state.writerStreamId !== expected.writerStreamId) fail8("writer_stream_id", `${path}.state.writerStreamId`, "resume state writer does not match expected attempt");
  if (captured.state.scopeDigest !== expected.scopeDigest || captured.state.scope.length !== expected.scopeCount) fail8("scope", path, "resume state scope binding does not match expected attempt");
  if (captured.reference.attemptId !== captured.state.attemptId || captured.reference.writerStreamId !== captured.state.writerStreamId || captured.reference.localRevision !== captured.state.localRevision || captured.reference.baseRevision !== captured.state.baseRevision) fail8("reference", `${path}.reference`, "resume reference does not match state");
}
function eventMap(captured) {
  return new Map(captured.events.map((event) => [event.eventId, event]));
}
function sameBytes(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) if (left[index] !== right[index]) return false;
  return true;
}
function validateEventRelations(captured, missing, path) {
  const scopeRows = new Map(captured.state.scope.map((row) => [row.questionKey, row]));
  const events = eventMap(captured);
  const localMissing = /* @__PURE__ */ new Set();
  const submitIndex = /* @__PURE__ */ new Map();
  for (const id of captured.state.submittedEventIds) {
    const event = events.get(id);
    if (!event) {
      localMissing.add(`submit_event\0${id}`);
      continue;
    }
    if (event.kind !== "answer_submitted") fail8("event_kind", `${path}.events`, "submittedEventIds may reference only submit events");
    if (event.attemptId !== captured.state.attemptId) fail8("attempt_id", `${path}.events`, "submit event belongs to another attempt");
    const row = scopeRows.get(event.questionKey);
    if (!row || row.questionRevision !== event.questionRevision) fail8("scope", `${path}.events`, "submit event is not for a scope question revision");
    const key2 = `${event.questionKey}\0${event.questionRevision}`;
    const values = submitIndex.get(key2) ?? [];
    values.push(event);
    submitIndex.set(key2, values);
  }
  for (const entry of localMissing) missing.add(entry);
  for (const [index, draft] of captured.state.questionDrafts.entries()) {
    if (!draft.submitted) continue;
    if (draft.inheritedFrom) continue;
    const matches = submitIndex.get(`${draft.questionKey}\0${draft.questionRevision}`) ?? [];
    if (matches.length === 0) {
      if (localMissing.size > 0) continue;
      fail8("invariant", `${path}.state.questionDrafts[${index}]`, "submitted draft lacks a listed submit event");
    }
    const draftBytes = canonicalContentBytes(draft.input);
    const matchingEvents = matches.filter((event) => event.kind === "answer_submitted" && sameBytes(canonicalContentBytes(event.answer), draftBytes));
    if (matchingEvents.length === 0) {
      if (localMissing.size > 0) continue;
      fail8("invariant", `${path}.state.questionDrafts[${index}].input`, "submitted draft input differs from submit events");
    }
    if (!draft.assisted && matchingEvents.some((event) => event.assisted)) fail8("invariant", `${path}.state.questionDrafts[${index}].assisted`, "draft cannot downgrade assisted submit");
  }
}
async function verifyBundle(captured, missing, bundles, memo, visiting, pathAttempts, depth) {
  const path = `$[${captured.reference.contentDigest}]`;
  const digestKey = captured.reference.contentDigest;
  if (depth > MAX_ANCESTOR_EDGES) fail8("dependency_limit", path, "resume dependency graph exceeds 32 ancestor edges");
  const cached = memo.get(digestKey);
  if (cached) {
    for (const attempt of cached.attempts) if (pathAttempts.has(attempt)) fail8("dependency_cycle", path, "resume dependency repeats an ancestor attempt");
    if (depth + cached.maxDepth > MAX_ANCESTOR_EDGES) fail8("dependency_limit", path, "resume dependency graph exceeds 32 ancestor edges");
    return cached;
  }
  if (visiting.has(digestKey)) fail8("dependency_cycle", path, "resume dependency contains a digest cycle");
  if (pathAttempts.has(captured.state.attemptId)) fail8("dependency_cycle", path, "resume dependency repeats an ancestor attempt");
  visiting.add(digestKey);
  const nextPathAttempts = new Set(pathAttempts);
  nextPathAttempts.add(captured.state.attemptId);
  let maxDepth = 0;
  try {
    validateBundleRelationships(captured, captured.expectedAttempt, path);
    const scopeDigest = await sha256Hex(captured.scopeBytes);
    if (scopeDigest !== captured.state.scopeDigest) fail8("digest", `${path}.state.scopeDigest`, "scopeDigest does not match scope bytes");
    const contentDigest = await sha256Hex(captured.stateBytes);
    if (contentDigest !== captured.reference.contentDigest) fail8("digest", `${path}.reference.contentDigest`, "contentDigest does not match resume bytes");
    if (captured.manifest === void 0) missing.add(`manifest\0${captured.reference.chunkManifestDigest}`);
    else {
      const manifestDigest = await sha256Hex(
        /** @type {Uint8Array} */
        captured.manifestBytes
      );
      if (manifestDigest !== captured.reference.chunkManifestDigest) fail8("digest", `${path}.reference.chunkManifestDigest`, "manifestDigest does not match manifest bytes");
      if (captured.manifest.contentDigest !== contentDigest || captured.manifest.totalBytes !== captured.stateBytes.byteLength || captured.manifest.chunkCount !== captured.manifest.chunks.length) fail8("invariant", `${path}.manifest`, "manifest does not describe resume bytes");
      let offset = 0;
      for (let index = 0; index < captured.manifest.chunks.length; index += 1) {
        const chunk = captured.manifest.chunks[index];
        if (!chunk) fail8("invariant", `${path}.manifest.chunks[${index}]`, "manifest chunk is missing");
        const bytes = captured.stateBytes.slice(offset, offset + chunk.byteLength);
        const chunkDigest = await sha256Hex(bytes);
        if (chunkDigest !== chunk.sha256) fail8("digest", `${path}.manifest.chunks[${index}].sha256`, "chunk digest does not match resume bytes");
        offset += chunk.byteLength;
      }
      if (offset !== captured.stateBytes.byteLength) fail8("invariant", `${path}.manifest.totalBytes`, "manifest chunks do not cover the complete resume bytes");
    }
    validateEventRelations(captured, missing, path);
    for (const draft of captured.state.questionDrafts) {
      if (!draft.inheritedFrom) continue;
      if (captured.expectedAttempt.parentAttemptId !== draft.inheritedFrom.attemptId) fail8("invariant", `${path}.state.questionDrafts`, "inherited draft parent does not match expectedAttempt");
      const parentDigest = draft.inheritedFrom.resumeContentDigest;
      const parent = bundles.get(parentDigest);
      if (!parent) {
        missing.add(`parent_resume\0${parentDigest}`);
        continue;
      }
      if (parent.state.attemptId !== draft.inheritedFrom.attemptId) fail8("attempt_id", `${path}.state.questionDrafts`, "inherited draft parent attempt does not match parent resume");
      const parentProof = await verifyBundle(parent, missing, bundles, memo, visiting, nextPathAttempts, depth + 1);
      if (1 + parentProof.maxDepth > maxDepth) maxDepth = 1 + parentProof.maxDepth;
      const parentDraft = parentProof.drafts.get(draft.questionKey);
      if (!parentDraft || parentDraft.questionRevision !== draft.questionRevision || !sameBytes(canonicalContentBytes(parentDraft.input), canonicalContentBytes(draft.input)) || parentDraft.submitted !== draft.submitted) fail8("invariant", `${path}.state.questionDrafts`, "inherited draft differs from parent resume");
      if (parentDraft.assisted && !draft.assisted || parentDraft.showKeys && !draft.showKeys) fail8("invariant", `${path}.state.questionDrafts`, "inherited draft downgrades parent assistance state");
    }
    const proofAttempts = /* @__PURE__ */ new Set(
      /** @type {string[]} */
      [captured.state.attemptId]
    );
    for (const draft of captured.state.questionDrafts) {
      if (!draft.inheritedFrom) continue;
      const parent = bundles.get(draft.inheritedFrom.resumeContentDigest);
      const parentProof = parent ? memo.get(draft.inheritedFrom.resumeContentDigest) : void 0;
      if (parentProof) for (const attempt of parentProof.attempts) proofAttempts.add(attempt);
    }
    const draftIndex = new Map(captured.state.questionDrafts.map((draft) => [draft.questionKey, draft]));
    const proof = { bundle: captured, attempts: proofAttempts, maxDepth, drafts: draftIndex };
    memo.set(digestKey, proof);
    return proof;
  } finally {
    visiting.delete(digestKey);
  }
}
async function validateResumeDependencies(state, reference, manifest, events, expectedAttempt, context = void 0) {
  const budget = { used: 0 };
  let parents = [];
  let snapshotProofs = [];
  if (context !== void 0) {
    const contextShape = plainObject2(context, "$.context");
    snapshotProofs = boundedArray(contextShape.snapshotProofs ?? [], "$.context.snapshotProofs", 33);
    exactFields2(contextShape, ["parents", "snapshotProofs"], ["parents"], "$.context");
    const parentDescriptor = Object.getOwnPropertyDescriptor(contextShape, "parents");
    if (!parentDescriptor || !Object.hasOwn(parentDescriptor, "value")) fail8("accessor", "$.context.parents", "accessors are not JSON");
    if (!Array.isArray(parentDescriptor.value)) fail8("type", "$.context.parents", "must be an array");
    if (parentDescriptor.value.length > MAX_DEPENDENCY_BUNDLES) fail8("dependency_limit", "$.context.parents", "resume dependency graph accepts at most 32 parent bundles");
    parents = boundedArray(parentDescriptor.value, "$.context.parents", MAX_DEPENDENCY_BUNDLES);
  }
  const root = captureBundleValues(state, reference, manifest, events, expectedAttempt, "$.root", budget);
  const bundles = /* @__PURE__ */ new Map();
  for (let index = 0; index < parents.length; index += 1) {
    const parentDescriptor = Object.getOwnPropertyDescriptor(parents, String(index));
    if (!parentDescriptor || !Object.hasOwn(parentDescriptor, "value")) fail8("array_hole", `$.context.parents[${index}]`, "array holes/accessors are not permitted");
    const parentRecord = plainObject2(parentDescriptor.value, `$.context.parents[${index}]`);
    exactFields2(parentRecord, ["state", "reference", "manifest", "events", "expectedAttempt"], ["state", "reference", "events", "expectedAttempt"], `$.context.parents[${index}]`);
    const captured = captureBundleValues(parentRecord.state, parentRecord.reference, parentRecord.manifest, parentRecord.events, parentRecord.expectedAttempt, `$.context.parents[${index}]`, budget);
    const digestKey = captured.reference.contentDigest;
    if (bundles.has(digestKey)) fail8("duplicate", `$.context.parents[${index}].reference.contentDigest`, "duplicate parent bundle contentDigest");
    bundles.set(digestKey, captured);
  }
  const missing = /* @__PURE__ */ new Set();
  const memo = /* @__PURE__ */ new Map();
  await verifyBundle(root, missing, bundles, memo, /* @__PURE__ */ new Set(), /* @__PURE__ */ new Set(), 0);
  for (const proof of memo.values()) {
    const state2 = proof.bundle.state;
    if (state2.schemaVersion !== 2) continue;
    if (proof.bundle.expectedAttempt.parentAttemptId || state2.localRevision === 1 && proof.bundle.events.length) fail8("snapshot_native_parent", "$.snapshotBaseline", "snapshot continuation initialization must not have parents or events");
    const baselineProof = snapshotProofs.find((candidate) => snapshotContinuationProofKey(candidate) === state2.snapshotBaseline.continuationKey);
    if (!baselineProof) missing.add(`snapshot_baseline\0${state2.snapshotBaseline.continuationKey}`);
    else assertSnapshotContinuationState(state2, baselineProof);
  }
  if (missing.size > 0) {
    const values = [...missing].map((entry) => {
      const [kind, identifier] = entry.split("\0");
      return { kind, [kind === "submit_event" ? "eventId" : "digest"]: identifier };
    }).sort((left, right) => {
      const a = `${left.kind}:${left.eventId ?? left.digest}`;
      const b = `${right.kind}:${right.eventId ?? right.digest}`;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    return { status: "missing_dependency", missing: (
      /** @type {import("./contracts").ResumeMissingDependency[]} */
      values
    ) };
  }
  return { status: "payload_verified", state: (
    /** @type {import("./contracts").ResumeState} */
    root.state
  ) };
}
var RESUME_DEPENDENCY_LIMITS = Object.freeze({ maxParentBundles: MAX_DEPENDENCY_BUNDLES, maxAncestorEdges: MAX_ANCESTOR_EDGES });

// src/domain/app-data/cursor.js
var DECIMAL_RE2 = /^(0|[1-9][0-9]{0,19})$/;
var POLLUTION_KEYS = /* @__PURE__ */ new Set(["__proto__", "prototype", "constructor"]);
function fail9(code, path, message) {
  throw new AppDataValidationError(code, path, message);
}
function object3(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail9("type", path, "must be a plain object");
  if (Object.getPrototypeOf(value) !== Object.prototype) fail9("prototype", path, "must use Object.prototype");
  const record = (
    /** @type {Record<string, unknown>} */
    value
  );
  for (const key2 of Reflect.ownKeys(record)) {
    if (typeof key2 !== "string") fail9("symbol", path, "symbol keys are not JSON");
    if (POLLUTION_KEYS.has(key2)) fail9("prototype_pollution", `${path}.${key2}`, "prototype-pollution key is forbidden");
    const descriptor = Object.getOwnPropertyDescriptor(record, key2);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) fail9("accessor", `${path}.${key2}`, "accessors are not JSON");
    if (!descriptor.enumerable) fail9("non_enumerable", `${path}.${key2}`, "non-enumerable fields cannot be silently omitted");
  }
  return record;
}
function fields2(value, allowed, required, path) {
  for (const key2 of Object.keys(value)) if (!allowed.includes(key2)) fail9("unknown_field", `${path}.${key2}`, "unknown field is not permitted by the frozen contract");
  for (const key2 of required) if (!Object.hasOwn(value, key2)) fail9("required", `${path}.${key2}`, "required field is missing");
}
function validateVersion(value, path) {
  if (value !== APP_DATA_PROTOCOL_VERSION) fail9("version", path, `only protocol version ${APP_DATA_PROTOCOL_VERSION} is supported`);
}
function validateSequence(value, path) {
  if (typeof value !== "string" || !DECIMAL_RE2.test(value)) fail9("cursor", path, "must be a non-negative decimal string");
}
function validateCursor(value) {
  const record = object3(value, "$");
  fields2(record, ["protocolVersion", "accountGeneration", "logEpoch", "serverSeq"], ["protocolVersion", "accountGeneration", "logEpoch", "serverSeq"], "$");
  validateVersion(record.protocolVersion, "$.protocolVersion");
  if (!isUuid(record.accountGeneration)) fail9("uuid", "$.accountGeneration", "must be a canonical lowercase UUID");
  if (!isUuid(record.logEpoch)) fail9("uuid", "$.logEpoch", "must be a canonical lowercase UUID");
  validateSequence(record.serverSeq, "$.serverSeq");
  return (
    /** @type {import("./contracts").SyncCursor} */
    value
  );
}
function decodeCursor(encoded) {
  if (typeof encoded !== "string") fail9("cursor", "$.after", "cursor must be a string");
  const parts = encoded.split(".");
  if (parts.length !== 4 || parts[0] !== "v2") fail9("cursor", "$.after", "cursor has an unknown version or invalid shape");
  return validateCursor({ protocolVersion: 2, accountGeneration: parts[1], logEpoch: parts[2], serverSeq: parts[3] });
}

// src/domain/app-data/local-records.js
var DIGEST_RE6 = /^[0-9a-f]{64}$/;
var DECIMAL_RE3 = /^(0|[1-9][0-9]{0,19})$/;
var DB_NAME_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
var POLLUTION_KEYS2 = /* @__PURE__ */ new Set(["__proto__", "prototype", "constructor"]);
var META_KEYS = /* @__PURE__ */ new Set([
  "clientStreamId",
  "clientSeq",
  "clockHighWaterMs",
  "appliedPullCursor",
  "serverLogEpoch",
  "schemaVersion",
  "projectionVersion",
  "projectionInvalidationRevision",
  "projectionAppliedRevision",
  "syncCoordinatorLease"
]);
var PROFILE_STATES = /* @__PURE__ */ new Set(["staged", "ready", "locked", "quarantined", "deleting", "deleted"]);
var MIGRATION_STATES = /* @__PURE__ */ new Set(["DISCOVERED", "RAW_SAVED", "TRANSFORMED", "VERIFIED", "COMMITTED", "QUARANTINED"]);
function fail10(code, path, message) {
  throw new AppDataValidationError(code, path, message);
}
function object4(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail10("type", path, "must be a plain object");
  if (Object.getPrototypeOf(value) !== Object.prototype) fail10("prototype", path, "must use Object.prototype");
  const record = (
    /** @type {Record<string, unknown>} */
    value
  );
  for (const key2 of Reflect.ownKeys(record)) {
    if (typeof key2 !== "string") fail10("symbol", path, "symbol keys are not JSON");
    if (POLLUTION_KEYS2.has(key2)) fail10("prototype_pollution", `${path}.${key2}`, "prototype-pollution key is forbidden");
    const descriptor = Object.getOwnPropertyDescriptor(record, key2);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) fail10("accessor", `${path}.${key2}`, "accessors are not JSON");
    if (!descriptor.enumerable) fail10("non_enumerable", `${path}.${key2}`, "non-enumerable fields cannot be silently omitted");
  }
  return record;
}
function fields3(value, allowed, required, path) {
  for (const key2 of Object.keys(value)) if (!allowed.includes(key2)) fail10("unknown_field", `${path}.${key2}`, "unknown field is not permitted by the frozen contract");
  for (const key2 of required) if (!Object.hasOwn(value, key2)) fail10("required", `${path}.${key2}`, "required field is missing");
}
function string(value, path) {
  if (typeof value !== "string") fail10("type", path, "must be a string");
  if (utf8ByteLength(value) > APP_DATA_LIMITS.maxStringUtf8Bytes) fail10("utf8_limit", path, "string exceeds the configured UTF-8 limit");
  return value;
}
function nonEmptyString(value, path) {
  const result = string(value, path);
  if (result.length === 0) fail10("range", path, "must be non-empty");
  return result;
}
function integer4(value, path) {
  if (!Number.isSafeInteger(value)) fail10("safe_integer", path, "must be a safe integer");
  return (
    /** @type {number} */
    value
  );
}
function nonNegative3(value, path) {
  const result = integer4(value, path);
  if (result < 0) fail10("range", path, "must be non-negative");
  return result;
}
function uuid7(value, path) {
  if (!isUuid(value)) fail10("uuid", path, "must be a canonical lowercase UUID");
  return (
    /** @type {string} */
    value
  );
}
function digest7(value, path) {
  if (typeof value !== "string" || !DIGEST_RE6.test(value)) fail10("digest", path, "must be a lowercase SHA-256 hex digest");
  return value;
}
function decimal2(value, path) {
  if (typeof value !== "string" || !DECIMAL_RE3.test(value)) fail10("decimal", path, "must be a non-negative decimal string");
  return value;
}
function jsonValue(value, path) {
  try {
    canonicalBytes(value);
  } catch (error) {
    if (error instanceof AppDataValidationError) throw new AppDataValidationError(error.code, path + error.path.slice(1), error.message);
    throw error;
  }
}
function smallBudget(value, path) {
  jsonValue(value, path);
}
function cursorString(value, path) {
  try {
    decodeCursor(value);
  } catch (error) {
    if (error instanceof AppDataValidationError) throw new AppDataValidationError(error.code, path + error.path.slice(1), error.message);
    throw error;
  }
}
function validateSyncLeaseShape(value, path) {
  const record = object4(value, path);
  fields3(record, ["ownerTabId", "fence", "expiresAt"], ["ownerTabId", "fence", "expiresAt"], path);
  uuid7(record.ownerTabId, `${path}.ownerTabId`);
  if (integer4(record.fence, `${path}.fence`) < 1) fail10("range", `${path}.fence`, "must be positive");
  integer4(record.expiresAt, `${path}.expiresAt`);
  return record;
}
function validateMetaRecord(value) {
  const record = object4(value, "$");
  fields3(record, ["key", "value"], ["key", "value"], "$");
  if (typeof record.key !== "string" || !META_KEYS.has(record.key)) fail10("enum", "$.key", "unknown meta key");
  switch (record.key) {
    case "clientStreamId":
    case "serverLogEpoch":
      uuid7(record.value, "$.value");
      break;
    case "clientSeq":
    case "clockHighWaterMs":
    case "projectionInvalidationRevision":
    case "projectionAppliedRevision":
      nonNegative3(record.value, "$.value");
      break;
    case "appliedPullCursor":
      cursorString(record.value, "$.value");
      break;
    case "schemaVersion":
      if (record.value !== 1 && record.value !== APP_DATA_DB_SCHEMA_VERSION) fail10("version", "$.value", "unsupported database schemaVersion");
      break;
    case "projectionVersion":
      if (record.value !== 1) fail10("version", "$.value", "only projectionVersion 1 is supported");
      break;
    case "syncCoordinatorLease":
      validateSyncLeaseShape(record.value, "$.value");
      break;
  }
  smallBudget(record, "$");
  return (
    /** @type {import("./contracts").MetaRecord} */
    value
  );
}
function validateVerificationJournal(value, path = "$") {
  const record = object4(value, path);
  fields3(record, ["jobId", "schemaVersion", "contentDigest", "recordCount", "verifiedAt"], ["jobId", "schemaVersion", "contentDigest", "recordCount", "verifiedAt"], path);
  uuid7(record.jobId, `${path}.jobId`);
  if (record.schemaVersion !== 1) fail10("version", `${path}.schemaVersion`, "only verification schemaVersion 1 is supported");
  digest7(record.contentDigest, `${path}.contentDigest`);
  nonNegative3(record.recordCount, `${path}.recordCount`);
  nonEmptyString(record.verifiedAt, `${path}.verifiedAt`);
  smallBudget(record, path);
  return (
    /** @type {import("./contracts").VerificationJournal} */
    value
  );
}
function validateProfileRegistryRecord(value) {
  const record = object4(value, "$");
  fields3(record, ["profileId", "dbName", "ownerKind", "accountId", "accountGeneration", "state", "schemaVersion", "importJobId", "verification", "lastVerifiedAt"], ["profileId", "dbName", "ownerKind", "state", "schemaVersion"], "$");
  uuid7(record.profileId, "$.profileId");
  const dbName = nonEmptyString(record.dbName, "$.dbName");
  if (!DB_NAME_RE.test(dbName)) fail10("identifier", "$.dbName", "dbName must be a generated safe database name");
  if (record.ownerKind !== "guest" && record.ownerKind !== "account") fail10("enum", "$.ownerKind", "ownerKind must be guest or account");
  if (record.ownerKind === "guest") {
    if (Object.hasOwn(record, "accountId") || Object.hasOwn(record, "accountGeneration")) fail10("invariant", "$.ownerKind", "guest profiles cannot carry account identity");
  } else {
    if (!Object.hasOwn(record, "accountId") || !Object.hasOwn(record, "accountGeneration")) fail10("required", "$", "account profiles require accountId and accountGeneration");
    nonEmptyString(record.accountId, "$.accountId");
    if (utf8ByteLength(
      /** @type {string} */
      record.accountId
    ) > 512) fail10("utf8_limit", "$.accountId", "accountId exceeds 512 UTF-8 bytes");
    uuid7(record.accountGeneration, "$.accountGeneration");
  }
  if (!PROFILE_STATES.has(
    /** @type {string} */
    record.state
  )) fail10("enum", "$.state", "invalid profile state");
  if (record.schemaVersion !== 1 && record.schemaVersion !== APP_DATA_DB_SCHEMA_VERSION) fail10("version", "$.schemaVersion", "unsupported database schemaVersion");
  if (Object.hasOwn(record, "importJobId")) uuid7(record.importJobId, "$.importJobId");
  if (Object.hasOwn(record, "verification")) validateVerificationJournal(record.verification, "$.verification");
  if (Object.hasOwn(record, "lastVerifiedAt")) {
    nonEmptyString(record.lastVerifiedAt, "$.lastVerifiedAt");
    if (!Object.hasOwn(record, "verification")) fail10("invariant", "$.lastVerifiedAt", "lastVerifiedAt requires verification");
    if (record.lastVerifiedAt !== /** @type {{verifiedAt:string}} */
    record.verification.verifiedAt) fail10("invariant", "$.lastVerifiedAt", "lastVerifiedAt must equal verification.verifiedAt");
  }
  if (Object.hasOwn(record, "verification") && Object.hasOwn(record, "importJobId") && record.importJobId !== /** @type {{jobId:string}} */
  record.verification.jobId) fail10("invariant", "$.importJobId", "importJobId must match verification.jobId");
  if (record.state === "ready" && !Object.hasOwn(record, "verification")) fail10("verification", "$.verification", "ready requires a verification journal");
  smallBudget(record, "$");
  return (
    /** @type {import("./contracts").ProfileRegistryRecord} */
    value
  );
}
function validateActiveProfilePointer(value) {
  const record = object4(value, "$");
  fields3(record, ["key", "activeProfileId", "activationRevision"], ["key", "activeProfileId", "activationRevision"], "$");
  if (record.key !== "activeProfile") fail10("enum", "$.key", "key must be activeProfile");
  uuid7(record.activeProfileId, "$.activeProfileId");
  if (integer4(record.activationRevision, "$.activationRevision") < 1) fail10("range", "$.activationRevision", "activationRevision must be positive");
  smallBudget(record, "$");
  return (
    /** @type {import("./contracts").ActiveProfilePointer} */
    value
  );
}
function validateContentChunkRecordHead(value) {
  const record = object4(value, "$");
  fields3(record, ["contentDigest", "chunkIndex", "bytes"], ["contentDigest", "chunkIndex", "bytes"], "$");
  digest7(record.contentDigest, "$.contentDigest");
  const chunkIndex = integer4(record.chunkIndex, "$.chunkIndex");
  if (chunkIndex < 0 || chunkIndex > 199) fail10("range", "$.chunkIndex", "chunkIndex must be 0..199");
  const bytes = (
    /** @type {Uint8Array} */
    record.bytes
  );
  if (bytes === null || typeof bytes !== "object" || Object.getPrototypeOf(bytes) !== Uint8Array.prototype) fail10("chunk", "$.bytes", "bytes must be a native Uint8Array");
  for (const name of ["buffer", "byteLength", "length"]) {
    const descriptor = Object.getOwnPropertyDescriptor(bytes, name);
    if (descriptor) fail10("chunk", "$.bytes", "bytes may not shadow native typed-array accessors");
  }
  const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
  const tagGetter = (
    /** @type {((this: Uint8Array) => string | undefined) | undefined} */
    Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)?.get
  );
  const bufferGetter = (
    /** @type {((this: Uint8Array) => ArrayBuffer) | undefined} */
    Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get
  );
  const byteLengthGetter = (
    /** @type {((this: Uint8Array) => number) | undefined} */
    Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get
  );
  const lengthGetter = (
    /** @type {((this: Uint8Array) => number) | undefined} */
    Object.getOwnPropertyDescriptor(typedArrayPrototype, "length")?.get
  );
  if (!tagGetter || !bufferGetter || !byteLengthGetter || !lengthGetter) fail10("chunk", "$.bytes", "native typed-array accessors are unavailable");
  let buffer;
  let byteLength;
  let length;
  try {
    if (tagGetter.call(bytes) !== "Uint8Array") fail10("chunk", "$.bytes", "bytes must be a native Uint8Array");
    buffer = bufferGetter.call(bytes);
    byteLength = byteLengthGetter.call(bytes);
    length = lengthGetter.call(bytes);
  } catch {
    fail10("chunk", "$.bytes", "bytes must be a live native Uint8Array");
  }
  if (!(buffer instanceof ArrayBuffer) || Object.getPrototypeOf(buffer) !== ArrayBuffer.prototype) fail10("chunk", "$.bytes", "bytes must use a non-shared ArrayBuffer");
  if (byteLength < 1 || byteLength > APP_DATA_LIMITS.maxContentChunkBytes) fail10("chunk", "$.bytes", "bytes must be 1..512 KiB");
  return { record, bytes, length };
}
function validateContentChunkRecord(value) {
  const { record, bytes, length } = validateContentChunkRecordHead(value);
  if (Reflect.ownKeys(bytes).length !== length) fail10("chunk", "$.bytes", "bytes may not have custom properties");
  const header2 = { contentDigest: record.contentDigest, chunkIndex: record.chunkIndex };
  smallBudget(header2, "$");
  return (
    /** @type {import("./contracts").ContentChunkRecord} */
    value
  );
}
function validateUserStateRecord(value) {
  const record = object4(value, "$");
  fields3(record, ["questionKey", "field", "value", "starredKey", "serverRevision"], ["questionKey", "field", "value"], "$");
  if (!isQuestionKey(record.questionKey)) fail10("question_key", "$.questionKey", "must be a bankUid/questionUid key");
  if (record.field !== "starred") fail10("enum", "$.field", "only starred user state is supported");
  if (typeof record.value !== "boolean") fail10("type", "$.value", "starred value must be boolean");
  if (Object.hasOwn(record, "starredKey") && record.starredKey !== (record.value ? 1 : 0)) fail10("invariant", "$.starredKey", "starredKey must match value");
  if (Object.hasOwn(record, "serverRevision")) nonNegative3(record.serverRevision, "$.serverRevision");
  smallBudget(record, "$");
  return (
    /** @type {import("./contracts").UserStateRecord} */
    value
  );
}
function validateOutboxRecord(value) {
  const record = object4(value, "$");
  fields3(record, ["mutationId", "nextAttemptAt", "attemptCount"], ["mutationId", "nextAttemptAt", "attemptCount"], "$");
  uuid7(record.mutationId, "$.mutationId");
  integer4(record.nextAttemptAt, "$.nextAttemptAt");
  nonNegative3(record.attemptCount, "$.attemptCount");
  smallBudget(record, "$");
  return (
    /** @type {import("./contracts").OutboxRecord} */
    value
  );
}
function validateLegacyEvidence(value) {
  const record = object4(value, "$");
  fields3(record, ["sourceId", "sourceDigest", "sourceOrigin", "namespace", "rawFormat", "rawBytes", "disposition"], ["sourceId", "sourceDigest", "sourceOrigin", "namespace", "rawFormat", "rawBytes", "disposition"], "$");
  for (const name of ["sourceId", "sourceOrigin", "namespace", "rawFormat"]) nonEmptyString(record[name], `$.${name}`);
  digest7(record.sourceDigest, "$.sourceDigest");
  nonNegative3(record.rawBytes, "$.rawBytes");
  if (!["mapped", "unknown", "quarantined"].includes(
    /** @type {string} */
    record.disposition
  )) fail10("enum", "$.disposition", "invalid legacy disposition");
  smallBudget(record, "$");
  return (
    /** @type {import("./contracts").LegacyEvidence} */
    value
  );
}
function validateLegacyRawRecord(value) {
  const record = object4(value, "$");
  fields3(record, ["sourceId", "sourceDigest", "sourceOrigin", "namespace", "rawFormat", "rawBytes", "disposition", "chunkIndex", "raw"], ["sourceId", "sourceDigest", "sourceOrigin", "namespace", "rawFormat", "rawBytes", "disposition", "chunkIndex", "raw"], "$");
  validateLegacyEvidence({ sourceId: record.sourceId, sourceDigest: record.sourceDigest, sourceOrigin: record.sourceOrigin, namespace: record.namespace, rawFormat: record.rawFormat, rawBytes: record.rawBytes, disposition: record.disposition });
  nonNegative3(record.chunkIndex, "$.chunkIndex");
  string(record.raw, "$.raw");
  smallBudget(record, "$");
  return (
    /** @type {import("./contracts").LegacyRawRecord} */
    value
  );
}
function validateLegacyAggregateRecord(value) {
  const record = object4(value, "$");
  fields3(record, ["sourceId", "sourceDigest", "sourceOrigin", "namespace", "rawFormat", "rawBytes", "disposition", "legacyQuestionId", "aggregate", "mappingStatus"], ["sourceId", "sourceDigest", "sourceOrigin", "namespace", "rawFormat", "rawBytes", "disposition", "legacyQuestionId", "aggregate", "mappingStatus"], "$");
  validateLegacyEvidence({ sourceId: record.sourceId, sourceDigest: record.sourceDigest, sourceOrigin: record.sourceOrigin, namespace: record.namespace, rawFormat: record.rawFormat, rawBytes: record.rawBytes, disposition: record.disposition });
  string(record.legacyQuestionId, "$.legacyQuestionId");
  jsonValue(record.aggregate, "$.aggregate");
  if (!["mapped", "unknown", "quarantined"].includes(
    /** @type {string} */
    record.mappingStatus
  )) fail10("enum", "$.mappingStatus", "invalid mapping status");
  smallBudget(record, "$");
  return (
    /** @type {import("./contracts").LegacyAggregateRecord} */
    value
  );
}
function validateMigrationJournalRecord(value) {
  const record = object4(value, "$");
  fields3(record, ["migrationId", "status", "counts", "checkpoint", "errors"], ["migrationId", "status", "counts"], "$");
  uuid7(record.migrationId, "$.migrationId");
  if (!MIGRATION_STATES.has(
    /** @type {string} */
    record.status
  )) fail10("enum", "$.status", "invalid local migration status");
  jsonValue(record.counts, "$.counts");
  if (Object.hasOwn(record, "checkpoint")) jsonValue(record.checkpoint, "$.checkpoint");
  if (Object.hasOwn(record, "errors")) jsonValue(record.errors, "$.errors");
  smallBudget(record, "$");
  return (
    /** @type {import("./contracts").MigrationJournalRecord} */
    value
  );
}
function validateImportReceiptRecord(value) {
  const record = object4(value, "$");
  fields3(record, ["sourceId", "sourceRecordId", "provenance", "importedAt"], ["sourceId", "sourceRecordId", "provenance", "importedAt"], "$");
  string(record.sourceId, "$.sourceId");
  string(record.sourceRecordId, "$.sourceRecordId");
  jsonValue(record.provenance, "$.provenance");
  integer4(record.importedAt, "$.importedAt");
  smallBudget(record, "$");
  const provenance = record.provenance;
  if (record.sourceId === "qb-snapshot-continuation-receipt-v1" || provenance !== null && typeof provenance === "object" && "format" in provenance && provenance.format === "qb-snapshot-continuation-receipt-v1") validateSnapshotContinuationReceipt(record);
  return (
    /** @type {import("./contracts").ImportReceiptRecord} */
    value
  );
}
function validateCheckpointRecord(value) {
  const record = object4(value, "$");
  fields3(record, ["checkpointId", "createdAt", "manifest"], ["checkpointId", "createdAt", "manifest"], "$");
  uuid7(record.checkpointId, "$.checkpointId");
  integer4(record.createdAt, "$.createdAt");
  validateExportManifest(record.manifest);
  smallBudget(record, "$");
  return (
    /** @type {import("./contracts").CheckpointRecord} */
    value
  );
}
function validateEntityTombstoneRecord(value) {
  const record = object4(value, "$");
  fields3(record, ["entityKey", "entityKind", "entityId", "status", "accountGeneration", "sourceMutationId", "serverSeq"], ["entityKey", "entityKind", "entityId", "status"], "$");
  if (record.entityKind !== "bank" && record.entityKind !== "attempt" && record.entityKind !== "history_snapshot") fail10("enum", "$.entityKind", "invalid tombstone entity kind");
  uuid7(record.entityId, "$.entityId");
  if (record.entityKey !== `${record.entityKind}:${record.entityId}`) fail10("entity_key", "$.entityKey", "entityKey must match kind and id");
  if (record.status !== "pending" && record.status !== "confirmed") fail10("enum", "$.status", "invalid tombstone status");
  if (Object.hasOwn(record, "accountGeneration")) uuid7(record.accountGeneration, "$.accountGeneration");
  if (Object.hasOwn(record, "sourceMutationId")) uuid7(record.sourceMutationId, "$.sourceMutationId");
  if (record.status === "confirmed") {
    if (!Object.hasOwn(record, "accountGeneration") || !Object.hasOwn(record, "serverSeq")) fail10("required", "$", "confirmed tombstones require accountGeneration and serverSeq");
    decimal2(record.serverSeq, "$.serverSeq");
  } else if (Object.hasOwn(record, "serverSeq")) fail10("invariant", "$.serverSeq", "pending tombstones cannot carry serverSeq");
  smallBudget(record, "$");
  return (
    /** @type {import("./contracts").EntityTombstoneRecord} */
    value
  );
}
function validateLease(value) {
  const record = object4(value, "$");
  fields3(record, ["attemptId", "ownerTabId", "fence", "expiresAt"], ["attemptId", "ownerTabId", "fence", "expiresAt"], "$");
  uuid7(record.attemptId, "$.attemptId");
  uuid7(record.ownerTabId, "$.ownerTabId");
  if (integer4(record.fence, "$.fence") < 1) fail10("range", "$.fence", "fence must be positive");
  integer4(record.expiresAt, "$.expiresAt");
  smallBudget(record, "$");
  return (
    /** @type {import("./contracts").WriterLease} */
    value
  );
}
function validateWriterLeaseRecord(value) {
  const record = object4(value, "$");
  fields3(record, ["attemptId", "ownerTabId", "fence", "expiresAt", "exportExcluded"], ["attemptId", "ownerTabId", "fence", "expiresAt", "exportExcluded"], "$");
  validateLease({ attemptId: record.attemptId, ownerTabId: record.ownerTabId, fence: record.fence, expiresAt: record.expiresAt });
  if (record.exportExcluded !== true) fail10("invariant", "$.exportExcluded", "writer lease records must be excluded from export/import/reset");
  smallBudget(record, "$");
  return (
    /** @type {import("./contracts").WriterLeaseRecord} */
    value
  );
}
var LOCAL_STORE_VALIDATORS = Object.freeze({
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

// src/domain/app-data/mutation-records.js
var DIGEST_RE7 = /^[0-9a-f]{64}$/;
var KINDS = ["attempt_manifest", "attempt_scope", "answer_event", "resume_state", "user_state", "bank_revision", "content_manifest", "entity_tombstone", "history_snapshot"];
var POLLUTION_KEYS3 = /* @__PURE__ */ new Set(["__proto__", "prototype", "constructor"]);
function fail11(code, path, message) {
  throw new AppDataValidationError(code, path, message);
}
function object5(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail11("type", path, "must be a plain object");
  if (Object.getPrototypeOf(value) !== Object.prototype) fail11("prototype", path, "must use Object.prototype");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key2 of Reflect.ownKeys(descriptors)) {
    if (typeof key2 !== "string") fail11("symbol", path, "symbol keys are not JSON");
    const name = (
      /** @type {string} */
      key2
    );
    if (POLLUTION_KEYS3.has(name)) fail11("prototype_pollution", `${path}.${name}`, "prototype-pollution key is forbidden");
    const descriptor = descriptors[name];
    if (!descriptor) fail11("descriptor", `${path}.${name}`, "missing property descriptor");
    if (!("value" in descriptor)) fail11("accessor", `${path}.${name}`, "accessors are not JSON");
    if (!descriptor.enumerable) fail11("non_enumerable", `${path}.${name}`, "non-enumerable fields cannot be silently omitted");
  }
  return (
    /** @type {Record<string, any>} */
    value
  );
}
function fields4(value, allowed, required, path) {
  for (const key2 of Object.keys(value)) if (!allowed.includes(key2)) fail11("unknown_field", `${path}.${key2}`, "unknown field is not permitted by the frozen contract");
  for (const key2 of required) if (!Object.hasOwn(value, key2)) fail11("required", `${path}.${key2}`, "required field is missing");
}
function integer5(value, path) {
  if (!Number.isSafeInteger(value)) fail11("safe_integer", path, "must be a safe integer");
  return (
    /** @type {number} */
    value
  );
}
function bool(value, path) {
  if (typeof value !== "boolean") fail11("type", path, "must be a boolean");
  return value;
}
function uuid8(value, path) {
  if (!isUuid(value)) fail11("uuid", path, "must be a canonical lowercase UUID");
  return (
    /** @type {string} */
    value
  );
}
function digest8(value, path) {
  if (typeof value !== "string" || !DIGEST_RE7.test(value)) fail11("digest", path, "must be a lowercase SHA-256 hex digest");
  return value;
}
function text6(value, path) {
  if (typeof value !== "string") fail11("type", path, "must be a string");
  if (utf8ByteLength(value) > APP_DATA_LIMITS.maxStringUtf8Bytes) fail11("utf8_limit", path, "string exceeds the configured UTF-8 limit");
  return value;
}
function questionKey3(value, path) {
  if (!isQuestionKey(value)) fail11("question_key", path, "must be a bankUid/questionUid key");
  return value;
}
function timestamp(value, path) {
  return integer5(value, path);
}
function validateAt(validator, value, path) {
  try {
    return validator(value);
  } catch (error) {
    if (error instanceof AppDataValidationError) throw new AppDataValidationError(error.code, path + error.path.slice(1), error.message);
    throw error;
  }
}
function entityMatch(actual, expected) {
  if (actual !== expected) fail11("entity_key", "$.entityKey", `must equal ${expected}`);
}
function validateMutation(value) {
  const record = object5(value, "$");
  fields4(record, ["protocolVersion", "mutationId", "clientStreamId", "clientSeq", "kind", "entityKey", "payload", "payloadDigest"], ["protocolVersion", "mutationId", "clientStreamId", "clientSeq", "kind", "entityKey", "payload", "payloadDigest"], "$");
  if (record.protocolVersion !== APP_DATA_PROTOCOL_VERSION) fail11("version", "$.protocolVersion", `only protocol version ${APP_DATA_PROTOCOL_VERSION} is supported`);
  uuid8(record.mutationId, "$.mutationId");
  uuid8(record.clientStreamId, "$.clientStreamId");
  if (integer5(record.clientSeq, "$.clientSeq") < 1) fail11("range", "$.clientSeq", "must be positive");
  const entityKey = text6(record.entityKey, "$.entityKey");
  if (!entityKey || utf8ByteLength(entityKey) > 512) fail11("range", "$.entityKey", "must be 1..512 UTF-8 bytes");
  validateMutationPayload(record.kind, record.entityKey, record.payload);
  digest8(record.payloadDigest, "$.payloadDigest");
  assertUtf8Within(new TextDecoder().decode(canonicalBytes(record)), APP_DATA_LIMITS.maxMutationUtf8Bytes, "mutation");
  return (
    /** @type {import("./contracts").MutationEnvelope} */
    record
  );
}
function validateMutationRecord(value) {
  const record = object5(value, "$");
  fields4(record, ["protocolVersion", "mutationId", "clientStreamId", "clientSeq", "kind", "entityKey", "payload", "payloadDigest", "createdAt", "accountGeneration"], ["protocolVersion", "mutationId", "clientStreamId", "clientSeq", "kind", "entityKey", "payload", "payloadDigest", "createdAt"], "$");
  validateMutation({ protocolVersion: record.protocolVersion, mutationId: record.mutationId, clientStreamId: record.clientStreamId, clientSeq: record.clientSeq, kind: record.kind, entityKey: record.entityKey, payload: record.payload, payloadDigest: record.payloadDigest });
  timestamp(record.createdAt, "$.createdAt");
  if (Object.hasOwn(record, "accountGeneration")) uuid8(record.accountGeneration, "$.accountGeneration");
  canonicalBytes(record);
  return (
    /** @type {import("./contracts").MutationRecord} */
    value
  );
}
function validateConflictRecord(value) {
  const record = object5(value, "$");
  fields4(record, ["conflictId", "entityKey", "status", "mutation", "currentRevision"], ["conflictId", "entityKey", "status", "mutation"], "$");
  uuid8(record.conflictId, "$.conflictId");
  const entityKey = text6(record.entityKey, "$.entityKey");
  if (!entityKey) fail11("range", "$.entityKey", "entityKey must not be empty");
  if (record.status !== "open" && record.status !== "resolved") fail11("enum", "$.status", "invalid conflict status");
  validateMutation(record.mutation);
  if (record.mutation.entityKey !== entityKey) fail11("entity_key", "$.entityKey", "conflict entityKey must match embedded mutation");
  if (Object.hasOwn(record, "currentRevision") && integer5(record.currentRevision, "$.currentRevision") < 0) fail11("range", "$.currentRevision", "must be non-negative");
  canonicalBytes(record);
  return (
    /** @type {import("./contracts").ConflictRecord} */
    value
  );
}
function payloadObject(value) {
  const r = object5(value, "$.payload");
  if (r.schemaVersion !== 1) fail11("schema_version", "$.payload.schemaVersion", "mutation payload schemaVersion must be 1");
  return r;
}
function validateAttemptManifestPayload(entityKey, payload) {
  const r = payloadObject(payload);
  fields4(r, ["schemaVersion", "attemptId", "writerStreamId", "startedAt", "scopeDigest", "scopeCount", "status", "baseRevision", "parentAttemptId"], ["schemaVersion", "attemptId", "writerStreamId", "startedAt", "scopeDigest", "scopeCount", "status", "baseRevision"], "$.payload");
  uuid8(r.attemptId, "$.payload.attemptId");
  uuid8(r.writerStreamId, "$.payload.writerStreamId");
  timestamp(r.startedAt, "$.payload.startedAt");
  digest8(r.scopeDigest, "$.payload.scopeDigest");
  if (integer5(r.scopeCount, "$.payload.scopeCount") < 1 || integer5(r.baseRevision, "$.payload.baseRevision") < 0) fail11("range", "$.payload", "invalid attempt manifest revision/count");
  if (r.status !== "active" && r.status !== "completed") fail11("enum", "$.payload.status", "invalid attempt status");
  if (Object.hasOwn(r, "parentAttemptId")) {
    uuid8(r.parentAttemptId, "$.payload.parentAttemptId");
    if (r.parentAttemptId === r.attemptId) fail11("invariant", "$.payload.parentAttemptId", "parentAttemptId cannot equal attemptId");
  }
  entityMatch(entityKey, `attempt:${r.attemptId}`);
  return finishPayload(
    "attempt_manifest",
    /** @type {import("./contracts").AttemptManifestPayload} */
    r
  );
}
function validateAttemptScopePayload(entityKey, payload) {
  const r = payloadObject(payload);
  fields4(r, ["schemaVersion", "attemptId", "scopeDigest", "reference", "baseRevision"], ["schemaVersion", "attemptId", "scopeDigest", "reference", "baseRevision"], "$.payload");
  uuid8(r.attemptId, "$.payload.attemptId");
  digest8(r.scopeDigest, "$.payload.scopeDigest");
  validateContentReference(r.reference, "$.payload.reference");
  if (r.baseRevision !== 0) fail11("invariant", "$.payload.baseRevision", "attempt scope baseRevision must be exactly zero");
  entityMatch(entityKey, `attempt:${r.attemptId}`);
  return finishPayload(
    "attempt_scope",
    /** @type {import("./contracts").AttemptScopePayload} */
    r
  );
}
function validateAnswerEventPayload(entityKey, payload) {
  const r = payloadObject(payload);
  fields4(r, ["schemaVersion", "event"], ["schemaVersion", "event"], "$.payload");
  const event = validateAt(validateAnswerEvent, r.event, "$.payload.event");
  entityMatch(entityKey, `event:${event.eventId}`);
  return finishPayload(
    "answer_event",
    /** @type {import("./contracts").AnswerEventMutationPayload} */
    r
  );
}
function validateResumeStatePayload(entityKey, payload) {
  const r = payloadObject(payload);
  fields4(r, ["schemaVersion", "attemptId", "writerStreamId", "contentDigest", "chunkManifestDigest", "localRevision", "baseRevision"], ["schemaVersion", "attemptId", "writerStreamId", "contentDigest", "chunkManifestDigest", "localRevision", "baseRevision"], "$.payload");
  uuid8(r.attemptId, "$.payload.attemptId");
  uuid8(r.writerStreamId, "$.payload.writerStreamId");
  digest8(r.contentDigest, "$.payload.contentDigest");
  digest8(r.chunkManifestDigest, "$.payload.chunkManifestDigest");
  if (integer5(r.localRevision, "$.payload.localRevision") < 1 || integer5(r.baseRevision, "$.payload.baseRevision") < 0) fail11("range", "$.payload", "invalid resume revision");
  entityMatch(entityKey, `attempt:${r.attemptId}`);
  return finishPayload(
    "resume_state",
    /** @type {import("./contracts").ResumeStatePayload} */
    r
  );
}
function validateUserStatePayload(entityKey, payload) {
  const r = payloadObject(payload);
  fields4(r, ["schemaVersion", "questionKey", "field", "value", "baseRevision"], ["schemaVersion", "questionKey", "field", "value", "baseRevision"], "$.payload");
  questionKey3(r.questionKey, "$.payload.questionKey");
  if (r.field !== "starred") fail11("enum", "$.payload.field", "only starred user state is supported");
  bool(r.value, "$.payload.value");
  if (integer5(r.baseRevision, "$.payload.baseRevision") < 0) fail11("range", "$.payload.baseRevision", "must be non-negative");
  entityMatch(entityKey, `user_state:${r.questionKey}:starred`);
  return finishPayload(
    "user_state",
    /** @type {import("./contracts").UserStatePayload} */
    r
  );
}
function validateBankRevisionPayload(entityKey, payload) {
  const r = payloadObject(payload);
  fields4(r, ["schemaVersion", "bankUid", "revision", "metadata", "contentManifest", "baseRevision"], ["schemaVersion", "bankUid", "revision", "metadata", "contentManifest", "baseRevision"], "$.payload");
  validateBankRevisionRecord({ bankUid: r.bankUid, revision: r.revision, metadata: r.metadata, contentManifest: r.contentManifest }, "$.payload");
  if (r.contentManifest.kind === "unavailable") fail11("invariant", "$.payload.contentManifest", "unavailable bank content cannot be sent as a mutation");
  if (integer5(r.baseRevision, "$.payload.baseRevision") < 0) fail11("range", "$.payload.baseRevision", "must be non-negative");
  entityMatch(entityKey, `bank:${r.bankUid}`);
  return finishPayload(
    "bank_revision",
    /** @type {import("./contracts").BankRevisionPayload} */
    r
  );
}
function validateContentManifestPayload(entityKey, payload) {
  const r = payloadObject(payload);
  fields4(r, ["schemaVersion", "reference"], ["schemaVersion", "reference"], "$.payload");
  validateContentReference(r.reference, "$.payload.reference");
  entityMatch(entityKey, `content:${r.reference.contentDigest}`);
  return finishPayload(
    "content_manifest",
    /** @type {import("./contracts").ContentManifestPayload} */
    r
  );
}
function validateEntityTombstonePayload(entityKey, payload) {
  const r = payloadObject(payload);
  fields4(r, ["schemaVersion", "entityKind", "entityId"], ["schemaVersion", "entityKind", "entityId"], "$.payload");
  if (r.entityKind !== "bank" && r.entityKind !== "attempt" && r.entityKind !== "history_snapshot") fail11("enum", "$.payload.entityKind", "invalid tombstone entity kind");
  uuid8(r.entityId, "$.payload.entityId");
  entityMatch(entityKey, `${r.entityKind}:${r.entityId}`);
  return finishPayload(
    "entity_tombstone",
    /** @type {import("./contracts").EntityTombstonePayload} */
    r
  );
}
var VALIDATE_PAYLOADS = {
  history_snapshot: (entityKey, payload) => {
    const record = validateHistorySnapshotPayload(payload);
    entityMatch(entityKey, `history_snapshot:${record.snapshotId}`);
    return record;
  },
  attempt_manifest: validateAttemptManifestPayload,
  attempt_scope: validateAttemptScopePayload,
  answer_event: validateAnswerEventPayload,
  resume_state: validateResumeStatePayload,
  user_state: validateUserStatePayload,
  bank_revision: validateBankRevisionPayload,
  content_manifest: validateContentManifestPayload,
  entity_tombstone: validateEntityTombstonePayload
};
function validateMutationPayload(kind, entityKey, payload) {
  if (!KINDS.includes(kind)) fail11("kind", "$.kind", "unknown frozen v2 mutation kind");
  return VALIDATE_PAYLOADS[kind](entityKey, payload);
}
var FINISH_PAYLOADS = {
  history_snapshot: (record) => {
    canonicalBytes(record);
    return record;
  },
  attempt_manifest: finishAttemptManifestPayload,
  attempt_scope: finishAttemptScopePayload,
  answer_event: finishAnswerEventPayload,
  resume_state: finishResumeStatePayload,
  user_state: finishUserStatePayload,
  bank_revision: finishBankRevisionPayload,
  content_manifest: finishContentManifestPayload,
  entity_tombstone: finishEntityTombstonePayload
};
function finishPayload(kind, record) {
  return FINISH_PAYLOADS[kind](record);
}
function finishAttemptManifestPayload(record) {
  canonicalBytes(record);
  return record;
}
function finishAttemptScopePayload(record) {
  canonicalBytes(record);
  return record;
}
function finishAnswerEventPayload(record) {
  canonicalBytes(record);
  return record;
}
function finishResumeStatePayload(record) {
  canonicalBytes(record);
  return record;
}
function finishUserStatePayload(record) {
  canonicalBytes(record);
  return record;
}
function finishBankRevisionPayload(record) {
  canonicalBytes(record);
  return record;
}
function finishContentManifestPayload(record) {
  canonicalBytes(record);
  return record;
}
function finishEntityTombstonePayload(record) {
  canonicalBytes(record);
  return record;
}
function mutationDigestInput(mutation) {
  const valid = validateMutation(mutation);
  return { protocolVersion: valid.protocolVersion, kind: valid.kind, entityKey: valid.entityKey, payload: valid.payload };
}
async function verifyMutationDigest(mutation) {
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
  const computed = await sha256Hex(bytes);
  return computed === expected;
}

// src/domain/app-data/sync-wire.js
var DIGEST_RE8 = /^[0-9a-f]{64}$/;
var DECIMAL_RE4 = /^(0|[1-9][0-9]{0,19})$/;
var CAS_KINDS = /* @__PURE__ */ new Set(["attempt_manifest", "resume_state", "user_state", "bank_revision"]);
var MUTATION_KINDS = /* @__PURE__ */ new Set([
  "attempt_manifest",
  "attempt_scope",
  "answer_event",
  "resume_state",
  "user_state",
  "bank_revision",
  "content_manifest",
  "entity_tombstone",
  "history_snapshot"
]);
var POLLUTION_KEYS4 = /* @__PURE__ */ new Set(["__proto__", "prototype", "constructor"]);
function fail12(code, path, message) {
  throw new AppDataValidationError(code, path, message);
}
function object6(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail12("type", path, "must be a plain object");
  if (Object.getPrototypeOf(value) !== Object.prototype) fail12("prototype", path, "must use Object.prototype");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const rawKey of Reflect.ownKeys(descriptors)) {
    if (typeof rawKey !== "string") fail12("symbol", path, "symbol keys are not JSON");
    if (POLLUTION_KEYS4.has(rawKey)) fail12("prototype_pollution", `${path}.${rawKey}`, "prototype-pollution key is forbidden");
    const descriptor = descriptors[rawKey];
    if (!descriptor || !("value" in descriptor)) fail12("accessor", `${path}.${rawKey}`, "accessors are not JSON");
    if (!descriptor.enumerable) fail12("non_enumerable", `${path}.${rawKey}`, "non-enumerable fields cannot be silently omitted");
  }
  return (
    /** @type {Record<string, any>} */
    value
  );
}
function fields5(value, allowed, required, path) {
  for (const key2 of Object.keys(value)) if (!allowed.includes(key2)) fail12("unknown_field", `${path}.${key2}`, "unknown field is not permitted by the frozen contract");
  for (const key2 of required) if (!Object.hasOwn(value, key2)) fail12("required", `${path}.${key2}`, "required field is missing");
}
function string2(value, path) {
  if (typeof value !== "string") fail12("type", path, "must be a string");
  if (utf8ByteLength(value) > APP_DATA_LIMITS.maxStringUtf8Bytes) fail12("utf8_limit", path, "string exceeds the configured UTF-8 limit");
  return value;
}
function uuid9(value, path) {
  if (typeof value !== "string" || !isUuid(value)) fail12("uuid", path, "must be a canonical lowercase UUID");
  return value;
}
function digest9(value, path) {
  if (typeof value !== "string" || !DIGEST_RE8.test(value)) fail12("digest", path, "must be a lowercase SHA-256 hex digest");
  return value;
}
function decimal3(value, path) {
  if (typeof value !== "string" || !DECIMAL_RE4.test(value)) fail12("cursor", path, "must be a non-negative decimal string");
  return value;
}
function positiveDecimal(value, path) {
  const result = decimal3(value, path);
  if (result === "0") fail12("range", path, "must be a positive decimal string");
  return result;
}
function safeInteger2(value, path) {
  if (!Number.isSafeInteger(value)) fail12("safe_integer", path, "must be a safe integer");
  return (
    /** @type {number} */
    value
  );
}
function validateAt2(validator, value, path) {
  try {
    return validator(value);
  } catch (error) {
    if (error instanceof AppDataValidationError) throw new AppDataValidationError(error.code, path + error.path.slice(1), error.message);
    throw error;
  }
}
function validateChangeLogRecord(value) {
  const record = object6(value, "$");
  fields5(record, ["serverSeq", "accountGeneration", "kind", "entityKey", "payloadDigest", "payload", "serverRevision"], ["serverSeq", "accountGeneration", "kind", "entityKey", "payloadDigest", "payload"], "$");
  positiveDecimal(record.serverSeq, "$.serverSeq");
  uuid9(record.accountGeneration, "$.accountGeneration");
  if (typeof record.kind !== "string" || !MUTATION_KINDS.has(record.kind)) fail12("kind", "$.kind", "unknown frozen v2 mutation kind");
  const entityKey = string2(record.entityKey, "$.entityKey");
  digest9(record.payloadDigest, "$.payloadDigest");
  validateAt2((payload) => validateMutationPayload(record.kind, entityKey, payload), record.payload, "$.payload");
  if (CAS_KINDS.has(record.kind)) {
    if (!Object.hasOwn(record, "serverRevision")) fail12("required", "$.serverRevision", "CAS change records require serverRevision");
    if (safeInteger2(record.serverRevision, "$.serverRevision") < 1) fail12("range", "$.serverRevision", "serverRevision must be positive");
  } else if (Object.hasOwn(record, "serverRevision")) {
    fail12("unknown_field", "$.serverRevision", "immutable change records may not carry serverRevision");
  }
  canonicalBytes(record);
  return (
    /** @type {import("./contracts").ChangeLogRecord} */
    value
  );
}
function validateMutationReceipt(value) {
  const record = object6(value, "$");
  fields5(record, ["mutationId", "payloadDigest", "status", "serverSeq", "currentRevision", "error"], ["mutationId", "payloadDigest", "status"], "$");
  uuid9(record.mutationId, "$.mutationId");
  digest9(record.payloadDigest, "$.payloadDigest");
  if (record.status !== "accepted" && record.status !== "duplicate" && record.status !== "conflict" && record.status !== "missing_dependency") fail12("enum", "$.status", "invalid mutation receipt status");
  if (record.status === "accepted" || record.status === "duplicate") {
    if (!Object.hasOwn(record, "serverSeq")) fail12("required", "$.serverSeq", "accepted and duplicate receipts require serverSeq");
    positiveDecimal(record.serverSeq, "$.serverSeq");
    if (Object.hasOwn(record, "error")) fail12("unknown_field", "$.error", "accepted and duplicate receipts may not carry error");
  } else if (record.status === "conflict") {
    if (Object.hasOwn(record, "serverSeq")) fail12("unknown_field", "$.serverSeq", "conflict receipts may not carry serverSeq");
    if (!Object.hasOwn(record, "error")) fail12("required", "$.error", "conflict receipts require error");
    if (record.error !== "conflict") fail12("enum", "$.error", "conflict receipts require error=conflict");
  } else {
    if (Object.hasOwn(record, "serverSeq")) fail12("unknown_field", "$.serverSeq", "missing_dependency receipts may not carry serverSeq");
    if (Object.hasOwn(record, "currentRevision")) fail12("unknown_field", "$.currentRevision", "missing_dependency receipts may not carry currentRevision");
    if (!Object.hasOwn(record, "error")) fail12("required", "$.error", "missing_dependency receipts require error");
    if (record.error !== "missing_dependency") fail12("enum", "$.error", "missing_dependency receipts require its stable error category");
  }
  if (Object.hasOwn(record, "currentRevision") && safeInteger2(record.currentRevision, "$.currentRevision") < 0) fail12("range", "$.currentRevision", "currentRevision must be non-negative");
  if (record.status !== "missing_dependency" && record.status !== "conflict" && Object.hasOwn(record, "error")) fail12("unknown_field", "$.error", "error is only valid on classified failure receipts");
  return (
    /** @type {import("./contracts").MutationReceipt} */
    value
  );
}

// src/domain/app-data/index.js
function fail13(code, path, message) {
  throw new AppDataValidationError(code, path, message);
}
function validateProfileRegistry(value) {
  return validateProfileRegistryRecord(value);
}
function validateActiveProfilePointer2(value) {
  return validateActiveProfilePointer(value);
}
function validateExportManifest2(value) {
  return validateExportManifest(value);
}
var STORE_RECORD_VALIDATORS = Object.freeze({
  history_snapshots: validateHistorySnapshotPayload,
  meta: validateMetaRecord,
  bank_revisions: validateBankRevisionRecord,
  content_chunks: validateContentChunkRecord,
  question_aliases: validateAlias,
  attempts: validateAttemptRecord,
  attempt_scope: validateAttemptScopeRecord,
  drafts: validateDraftRecord,
  answer_events: validateAnswerEvent,
  user_state: validateUserStateRecord,
  mutations: validateMutationRecord,
  outbox: validateOutboxRecord,
  conflicts: validateConflictRecord,
  legacy_raw: validateLegacyRawRecord,
  legacy_aggregates: validateLegacyAggregateRecord,
  migration_journal: validateMigrationJournalRecord,
  import_receipts: validateImportReceiptRecord,
  checkpoints: validateCheckpointRecord,
  entity_tombstones: validateEntityTombstoneRecord,
  writer_leases: validateWriterLeaseRecord
});
var ix = (name, keyPath, unique = false) => ({ name, keyPath, unique });
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key2 of Reflect.ownKeys(value)) deepFreeze(value[key2]);
  }
  return value;
}
var APP_DATA_STORES = deepFreeze({
  history_snapshots: { keyPath: "snapshotId", indexes: [ix("recordedAt", "recordedAt"), ix("accountGeneration", "accountGeneration")] },
  meta: { keyPath: "key", indexes: [] },
  bank_revisions: { keyPath: ["bankUid", "revision"], indexes: [ix("bankUid", "bankUid")] },
  content_chunks: { keyPath: ["contentDigest", "chunkIndex"], indexes: [ix("contentDigest", "contentDigest")] },
  question_aliases: { keyPath: ALIAS_KEY_PATH, indexes: [ix("sourceKey", "sourceKey"), ix("mappingStatus", "mappingStatus"), ix("newQuestionKey", "newQuestionKey")] },
  attempts: { keyPath: "attemptId", indexes: [ix("status", "status"), ix("startedAt", "startedAt")] },
  attempt_scope: { keyPath: ["attemptId", "ordinal"], indexes: [ix("attemptId", "attemptId")] },
  drafts: { keyPath: ["attemptId", "questionKey"], indexes: [ix("attemptId", "attemptId")] },
  answer_events: { keyPath: "eventId", indexes: [ix("attemptId", "attemptId"), ix("questionKey", "questionKey"), ix("attemptAction", ["attemptId", "writerStreamId", "actionSeq"], true)] },
  user_state: { keyPath: ["questionKey", "field"], indexes: [ix("starredKey", "starredKey"), ix("serverRevision", "serverRevision")] },
  mutations: { keyPath: "mutationId", indexes: [ix("streamSequence", ["clientStreamId", "clientSeq"], true)] },
  outbox: { keyPath: "mutationId", indexes: [ix("nextAttemptAt", "nextAttemptAt")] },
  conflicts: { keyPath: "conflictId", indexes: [ix("entityKey", "entityKey"), ix("status", "status")] },
  legacy_raw: { keyPath: ["sourceId", "sourceDigest", "chunkIndex"], indexes: [ix("sourceId", "sourceId")] },
  legacy_aggregates: { keyPath: ["sourceId", "namespace", "legacyQuestionId"], indexes: [ix("mappingStatus", "mappingStatus")] },
  migration_journal: { keyPath: "migrationId", indexes: [ix("status", "status")] },
  import_receipts: { keyPath: ["sourceId", "sourceRecordId"], indexes: [] },
  checkpoints: { keyPath: "checkpointId", indexes: [ix("createdAt", "createdAt")] },
  entity_tombstones: { keyPath: "entityKey", indexes: [ix("entityKind", "entityKind"), ix("accountGeneration", "accountGeneration")] },
  writer_leases: { keyPath: "attemptId", indexes: [ix("expiresAt", "expiresAt")] }
});
function validateStoreRecord(storeName, value, context) {
  if (typeof storeName !== "string" || !Object.hasOwn(STORE_RECORD_VALIDATORS, storeName)) fail13("store", "$.store", "unknown AppData store");
  if (storeName === "drafts" && context !== void 0) {
    const draftValidator = (
      /** @type {(value: unknown, context: import("./contracts").AttemptContextBinding) => import("./contracts").AppDataStoreRecords[K]} */
      validateDraftForAttempt
    );
    return draftValidator(value, context);
  }
  const validator = (
    /** @type {(value: unknown) => import("./contracts").AppDataStoreRecords[K]} */
    STORE_RECORD_VALIDATORS[
      /** @type {keyof typeof STORE_RECORD_VALIDATORS} */
      storeName
    ]
  );
  return validator(value);
}

// src/storage/idb/transaction.js
function storageError(code, message, cause) {
  const error = new Error(message);
  error.name = "StorageError";
  error.code = code;
  if (cause !== void 0) error.cause = cause;
  return error;
}
function isThenable(value) {
  if (typeof value !== "object" && typeof value !== "function" || value === null) return false;
  return typeof value.then === "function";
}
function abortQuietly(transaction) {
  try {
    transaction.abort();
  } catch {
  }
}
function observeRequest(value, requests) {
  if (!isThenable(value)) return value;
  const request = Promise.resolve(value);
  request.catch(() => {
  });
  requests.add(request);
  return value;
}
var READ_METHODS = ["get", "getAll", "getKey", "getAllKeys", "count"];
var WRITE_METHODS = ["put", "add", "delete", "clear"];
function indexFacade(index, requests) {
  return Object.freeze(Object.fromEntries(READ_METHODS.map((name) => [name, (...args) => observeRequest(index[name](...args), requests)])));
}
function storeFacade(store, requests) {
  const allowed = [...READ_METHODS, ...WRITE_METHODS];
  return Object.freeze({
    ...Object.fromEntries(allowed.map((name) => [name, (...args) => observeRequest(store[name](...args), requests)])),
    index: (name) => indexFacade(store.index(name), requests)
  });
}
function transactionFacade(transaction, requests) {
  return Object.freeze({
    abort: () => transaction.abort(),
    store: transaction.store === void 0 ? void 0 : storeFacade(transaction.store, requests),
    objectStore: (name) => storeFacade(transaction.objectStore(name), requests)
  });
}
async function runIdbTransaction(controller, storeNames, mode, work) {
  controller.assertOpen();
  if (typeof work !== "function") throw storageError("INVALID", "transaction work must be a function");
  let tx;
  try {
    tx = controller.db.transaction(storeNames, mode);
  } catch (cause) {
    throw storageError("STORAGE_UNAVAILABLE", "unable to create IndexedDB transaction", cause);
  }
  controller.track(tx);
  const requests = /* @__PURE__ */ new Set();
  try {
    let result;
    try {
      result = work(transactionFacade(tx, requests));
      if (isThenable(result)) {
        Promise.resolve(result).catch(() => {
        });
        throw storageError("INVALID", "transaction work must not return a thenable");
      }
    } catch (cause) {
      abortQuietly(tx);
      try {
        await tx.done;
      } catch {
      }
      throw cause;
    }
    try {
      await Promise.all(requests);
    } catch (cause) {
      abortQuietly(tx);
      try {
        await tx.done;
      } catch {
      }
      throw storageError("ABORTED", "an IndexedDB request did not complete", cause);
    }
    try {
      await tx.done;
    } catch (cause) {
      throw storageError("ABORTED", "IndexedDB transaction did not complete", cause);
    }
    return result;
  } finally {
    controller.untrack(tx);
  }
}

// src/storage/profiles/control-schema.js
var CONTROL_STORES = Object.freeze(["profiles", "meta"]);
var UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
var OWN = Object.prototype.hasOwnProperty;
function profileError(code, message, cause) {
  return storageError(code, message, cause);
}
function plain(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) {
    throw profileError("CORRUPT", `${label} must be a plain data record`);
  }
  for (const name of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !OWN.call(descriptor, "value")) throw profileError("CORRUPT", `${label}.${name} must be a data property`);
  }
  return (
    /** @type {Record<string, unknown>} */
    value
  );
}
function exactFields3(value, required, optional, label) {
  const allowed = /* @__PURE__ */ new Set([...required, ...optional]);
  if (Object.keys(value).some((key2) => !allowed.has(key2)) || required.some((key2) => !OWN.call(value, key2))) {
    throw profileError("CORRUPT", `${label} has an unsupported shape`);
  }
}
function snapshotOwner(value) {
  const owner = plain(value, "owner");
  if (owner.ownerKind === "guest") {
    exactFields3(owner, ["ownerKind", "guestId"], [], "owner");
    if (!UUID_V4.test(
      /** @type {string} */
      owner.guestId
    )) throw profileError("INVALID", "guestId must be a UUIDv4");
    return Object.freeze({ ownerKind: "guest", guestId: (
      /** @type {string} */
      owner.guestId
    ) });
  }
  if (owner.ownerKind === "account") {
    exactFields3(owner, ["ownerKind", "accountId", "accountGeneration"], [], "owner");
    if (typeof owner.accountId !== "string" || owner.accountId.length === 0 || new TextEncoder().encode(owner.accountId).byteLength > 512 || !UUID_V4.test(
      /** @type {string} */
      owner.accountGeneration
    )) {
      throw profileError("INVALID", "account owner must have a bounded accountId and accountGeneration");
    }
    return Object.freeze({ ownerKind: "account", accountId: owner.accountId, accountGeneration: owner.accountGeneration });
  }
  throw profileError("INVALID", "ownerKind must be guest or account");
}
function sameOwner(left, right) {
  return left?.ownerKind === right?.ownerKind && (left?.ownerKind === "guest" ? left.guestId === right.guestId : left?.accountId === right?.accountId && left?.accountGeneration === right?.accountGeneration);
}
function controlDbName(controlId, namespace = "test") {
  if (!UUID_V4.test(
    /** @type {string} */
    controlId
  )) throw profileError("INVALID", "controlId must be a UUIDv4");
  if (!["test", "production"].includes(namespace)) throw profileError("INVALID", "invalid profile namespace");
  return `${namespace === "production" ? "qb-v2" : "qb-b1a-test"}-control-${controlId}`;
}
function assertBusinessDbName(dbName) {
  const prefix = typeof dbName === "string" && dbName.startsWith("qb-v2-business-") ? "qb-v2-business-" : "qb-b1a-test-business-";
  if (typeof dbName !== "string" || !dbName.startsWith(prefix) || !UUID_V4.test(dbName.slice(prefix.length))) throw profileError("CORRUPT", "business dbName is not a generated profile name");
  return dbName;
}
function validateProfileJournalPair(profile, journal, options = {}) {
  let checkedProfile;
  try {
    checkedProfile = validateProfileRegistry(profile);
  } catch (cause) {
    throw profileError("CORRUPT", "stored profile is invalid", cause);
  }
  const checkedJournal = plain(journal, "fresh journal");
  const phase = checkedJournal.phase;
  const base = ["key", "kind", "profileId", "jobId", "dbName", "owner", "phase"];
  const optional = ["failure", "manifest", "verification", "cleanupCommitment"];
  exactFields3(checkedJournal, base, optional, "fresh journal");
  if (checkedJournal.key !== `fresh:${checkedProfile.profileId}` || !["b1a-fresh-creation", "qb-v2-staged-restore"].includes(checkedJournal.kind) || checkedJournal.profileId !== checkedProfile.profileId || !UUID_V4.test(checkedJournal.jobId) || checkedJournal.dbName !== checkedProfile.dbName) throw profileError("CORRUPT", "fresh journal identity disagrees with profile");
  const owner = snapshotOwner(checkedJournal.owner);
  if (checkedProfile.ownerKind !== owner.ownerKind || owner.ownerKind === "account" && (checkedProfile.accountId !== owner.accountId || checkedProfile.accountGeneration !== owner.accountGeneration)) throw profileError("CORRUPT", "profile and journal owner disagree");
  assertBusinessDbName(checkedProfile.dbName);
  if (!["allocated", "creating", "created", "completed", "quarantined"].includes(
    /** @type {string} */
    phase
  )) throw profileError("CORRUPT", "fresh journal phase is invalid");
  if (checkedJournal.failure !== void 0) validateFailure(checkedJournal.failure);
  if (phase === "completed") {
    if (checkedProfile.state !== "ready" || checkedJournal.manifest === void 0 || checkedJournal.verification === void 0) throw profileError("CORRUPT", "completed journal must pair with a ready profile");
    const manifest = validateManifest(checkedJournal.manifest);
    if (checkedJournal.cleanupCommitment !== void 0) {
      validateCleanupCommitment(checkedJournal.cleanupCommitment);
      if (manifest.format !== "qb-v2-native-manifest-v2") throw profileError("CORRUPT", "cleanup commitment requires native V2 terminal");
    }
    if (checkedJournal.kind === "qb-v2-staged-restore" !== ["qb-v2-restored-manifest-v1", "qb-v2-native-manifest-v2"].includes(manifest.format)) throw profileError("CORRUPT", "journal and manifest kinds differ");
    let verification;
    try {
      verification = validateVerificationJournal(checkedJournal.verification);
    } catch (cause) {
      throw profileError("CORRUPT", "completed journal verification is invalid", cause);
    }
    assertIsoVerifiedAt(verification.verifiedAt);
    const profileVerification = checkedProfile.verification;
    if (checkedProfile.schemaVersion !== 1 || checkedProfile.importJobId !== checkedJournal.jobId || !profileVerification || profileVerification.jobId !== verification.jobId || profileVerification.schemaVersion !== verification.schemaVersion || profileVerification.contentDigest !== verification.contentDigest || profileVerification.recordCount !== verification.recordCount || profileVerification.verifiedAt !== verification.verifiedAt || checkedProfile.lastVerifiedAt !== verification.verifiedAt || verification.jobId !== checkedJournal.jobId || verification.schemaVersion !== 1 || verification.recordCount !== manifest.stores.reduce((sum, row) => sum + row.recordCount, 0)) throw profileError("CORRUPT", "completed journal verification disagrees with profile");
    return { profile: checkedProfile, journal: checkedJournal, owner, phase, manifest, verification };
  }
  const expectedState = phase === "quarantined" ? "quarantined" : "staged";
  if (checkedJournal.manifest !== void 0 || checkedJournal.verification !== void 0 || checkedJournal.cleanupCommitment !== void 0 || checkedProfile.state !== expectedState || checkedProfile.importJobId !== checkedJournal.jobId || !options.allowStaged) throw profileError("CORRUPT", "non-completed journal/profile pair is invalid");
  return { profile: checkedProfile, journal: checkedJournal, owner, phase, manifest: null, verification: null };
}
function validateCleanupCommitment(value) {
  const v = plain(value, "cleanup commitment");
  exactFields3(v, ["format", "jobId", "bindingDigest", "initialInventory"], ["prepareAnchor"], "cleanup commitment");
  if (v.format !== "qb-s1-cleanup-commitment-v1" || !UUID_V4.test(v.jobId) || !/^[0-9a-f]{64}$/.test(v.bindingDigest)) throw profileError("CORRUPT", "cleanup commitment identity");
  if (v.initialInventory !== null) validateCleanupInventory(v.initialInventory);
  if (v.prepareAnchor !== void 0) {
    const a = validateCleanupPrepareAnchor(v.prepareAnchor);
    if (a.jobId !== v.jobId || a.bindingDigest !== v.bindingDigest || v.initialInventory !== null && a.inventoryRoot !== v.initialInventory.sha256) throw profileError("CORRUPT", "prepare anchor differs from terminal commitment");
  }
  return v;
}
function validateCleanupPrepareAnchor(value) {
  const a = plain(value, "cleanup prepare anchor");
  exactFields3(a, ["format", "jobId", "bindingDigest", "inventoryRoot"], [], "cleanup prepare anchor");
  if (a.format !== "qb-s1-cleanup-prepare-anchor-v1" || !UUID_V4.test(a.jobId) || ![a.bindingDigest, a.inventoryRoot].every((x) => typeof x === "string" && /^[0-9a-f]{64}$/.test(x))) throw profileError("CORRUPT", "prepare anchor");
  return a;
}
function validateCleanupInventory(value) {
  const v = plain(value, "cleanup inventory");
  exactFields3(v, ["frameCount", "recordCount", "bytes", "encodedBytes", "sha256", "frames"], [], "cleanup inventory");
  if (!Number.isSafeInteger(v.frameCount) || v.frameCount < 1 || v.frameCount > 32 || !Number.isSafeInteger(v.recordCount) || v.recordCount < 0 || v.recordCount > 2e5 || !Number.isSafeInteger(v.bytes) || v.bytes < 0 || v.bytes > 8 * 1024 * 1024 || !Number.isSafeInteger(v.encodedBytes) || v.encodedBytes < 0 || v.encodedBytes > 8 * 1024 * 1024 || !/^[0-9a-f]{64}$/.test(v.sha256) || !Array.isArray(v.frames) || v.frames.length !== v.frameCount) throw profileError("CORRUPT", "cleanup inventory budget");
  let count = 0, bytes = 0;
  for (let index = 0; index < v.frames.length; index++) {
    const f = plain(v.frames[index], "cleanup frame descriptor");
    exactFields3(f, ["index", "count", "bytes", "sha256"], [], "cleanup frame descriptor");
    if (f.index !== index || !Number.isSafeInteger(f.count) || f.count < 0 || !Number.isSafeInteger(f.bytes) || f.bytes < 1 || f.bytes > 512 * 1024 || !/^[0-9a-f]{64}$/.test(f.sha256)) throw profileError("CORRUPT", "cleanup descriptor");
    count += f.count;
    bytes += f.bytes;
  }
  if (count !== v.recordCount || bytes !== v.encodedBytes) throw profileError("CORRUPT", "cleanup descriptor aggregate");
  return v;
}
function validateFailure(value) {
  const failure = plain(value, "fresh journal.failure");
  exactFields3(failure, ["phase", "code", "observedAt"], [], "fresh journal.failure");
  if (!["create", "inspect", "finalize"].includes(
    /** @type {string} */
    failure.phase || ""
  ) || typeof failure.code !== "string" || !/^[A-Z0-9_]{1,80}$/.test(failure.code) || typeof failure.observedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(failure.observedAt) || !Number.isFinite(Date.parse(failure.observedAt)) || new Date(failure.observedAt).toISOString() !== failure.observedAt) throw profileError("CORRUPT", "fresh journal.failure is invalid");
}
function assertIsoVerifiedAt(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw profileError("CORRUPT", "completed verification timestamp is invalid");
  }
  return value;
}
function validateManifest(value) {
  const manifest = plain(value, "manifest");
  const native = manifest.format === "qb-v2-native-manifest-v2";
  exactFields3(manifest, native ? ["format", "businessSchemaVersion", "keyOrder", "rowEncoding", "stores"] : ["format", "businessSchemaVersion", "stores"], [], "manifest");
  const expected = Object.keys(APP_DATA_STORES).filter((name) => manifest.businessSchemaVersion !== 1 || name !== "history_snapshots").sort();
  const restored = native || manifest.format === "qb-v2-restored-manifest-v1";
  if (native && (manifest.keyOrder !== "indexeddb-primary-key-v1" || manifest.rowEncoding !== "canonical-ndjson-v1")) throw profileError("CORRUPT", "native manifest encoding is invalid");
  if (!restored && manifest.format !== "qb-b1a-fresh-manifest-v1" || ![1, 2].includes(manifest.businessSchemaVersion) || !Array.isArray(manifest.stores) || manifest.stores.length !== expected.length) throw profileError("CORRUPT", "fresh manifest header is invalid");
  manifest.stores.forEach((entry, index) => {
    const row = plain(entry, `manifest.stores[${index}]`);
    exactFields3(row, restored ? ["name", "recordCount", "sha256"] : ["name", "recordCount"], [], `manifest.stores[${index}]`);
    if (row.name !== expected[index] || !Number.isSafeInteger(row.recordCount) || row.recordCount < 0 || !restored && row.recordCount !== 0 || restored && !/^[0-9a-f]{64}$/.test(row.sha256)) throw profileError("CORRUPT", "fresh manifest store counts are invalid");
  });
  return manifest;
}

// src/domain/question/content-identity.js
var IDENTITY_KEYS = /* @__PURE__ */ new Set([
  "id",
  "source",
  "banks",
  "bankUid",
  "questionUid",
  "questionKey",
  "questionRevision",
  "optionIds",
  "provenance"
]);
function snapshotContent(value) {
  canonicalContentBytes(value);
  return structuredClone(value);
}
function invalidQuestion(message) {
  throw new TypeError(`question content ${message}`);
}
function isStringMatrix(value) {
  return Array.isArray(value) && value.every((row) => Array.isArray(row) && row.every((entry) => typeof entry === "string"));
}
function validateQuestionSemantics(snapshot) {
  const image = snapshot.image;
  return validateQuestionSemanticFields(snapshot, Boolean(image && (typeof image === "string" || Array.isArray(image) && image.length > 0)));
}
function validateQuestionSemanticFields(snapshot, hasMedia) {
  if (typeof hasMedia !== "boolean") invalidQuestion("media predicate must be boolean");
  const type = snapshot.type;
  const hasAnswer = Object.hasOwn(snapshot, "answer");
  const hasAnswers = Object.hasOwn(snapshot, "answers");
  if (hasAnswer && hasAnswers) invalidQuestion("answer and answers cannot both be present");
  const hasText = typeof snapshot.question === "string" && snapshot.question.trim().length > 0;
  if (!hasText && !hasMedia) invalidQuestion("requires question text or media");
  if (type === "fill") {
    if (!isStringMatrix(snapshot.blanks) || !snapshot.blanks.some((row) => row.some((entry) => entry.trim().length > 0))) {
      invalidQuestion("fill blanks must contain a non-blank string");
    }
    if (Object.hasOwn(snapshot, "answer_sets") && !isStringMatrix(snapshot.answer_sets)) {
      invalidQuestion("fill answer_sets must be a string matrix");
    }
    return "fill";
  }
  if (type !== void 0 && type !== "choice") invalidQuestion("type must be choice or fill");
  const choices = snapshot.choices;
  if (!Array.isArray(choices) || choices.length < 2 || choices.some((entry) => typeof entry !== "string")) {
    invalidQuestion("choice choices must contain at least two strings");
  }
  if (hasAnswer === hasAnswers) invalidQuestion("choice requires exactly one of answer or answers");
  const isIndex = (value) => Number.isInteger(value) && value >= 0 && value < choices.length;
  if (hasAnswer && !isIndex(
    /** @type {number} */
    snapshot.answer
  )) invalidQuestion("choice answer index is invalid");
  if (hasAnswers && (!Array.isArray(snapshot.answers) || snapshot.answers.length === 0 || snapshot.answers.some((entry) => !isIndex(entry)))) {
    invalidQuestion("choice answers indexes are invalid");
  }
  return "choice";
}
function projectContent(snapshot) {
  const projection2 = {};
  for (const key2 of Object.keys(snapshot)) {
    if (!IDENTITY_KEYS.has(key2)) projection2[key2] = snapshot[key2];
  }
  return projection2;
}
async function deriveContent(question) {
  const captured = snapshotContent(question);
  if (captured === null || typeof captured !== "object" || Array.isArray(captured) || Object.getPrototypeOf(captured) !== Object.prototype) {
    throw new TypeError("question content must be a plain object");
  }
  const snapshot = (
    /** @type {Record<string,unknown>} */
    captured
  );
  const kind = validateQuestionSemantics(snapshot);
  const projection2 = projectContent(snapshot);
  const questionRevision = await sha256Hex(canonicalContentBytes({
    projectionVersion: 1,
    content: projection2
  }));
  const choices = kind === "choice" ? (
    /** @type {string[]} */
    snapshot.choices
  ) : [];
  const optionIds = await Promise.all(choices.map(async (_choice, index) => {
    const digest11 = await sha256Hex(canonicalContentBytes({
      optionIdentityVersion: 1,
      questionRevision,
      index
    }));
    return `opt_${digest11}`;
  }));
  return { projection: projection2, questionRevision, optionIds };
}

// src/domain/question/bank-content.js
var fail14 = (code, path, message) => {
  throw new AppDataValidationError(code, path, message);
};
async function validateBankContent(input) {
  const bytes = canonicalContentBytes(input);
  const content = JSON.parse(new TextDecoder().decode(bytes));
  if (!content || Array.isArray(content) || Object.keys(content).sort().join(",") !== "bankUid,format,metadata,questions,schemaVersion" || content.format !== "qb-bank-content-v2" || content.schemaVersion !== 1 || !isUuid(content.bankUid)) fail14("bank_content", "$", "invalid registered bank wrapper");
  const metadata = validateBankMetadata(content.metadata);
  if (metadata.visibility === "protected") fail14("protected_plaintext", "$.metadata.visibility", "protected content accepts ciphertext only");
  if (!Array.isArray(content.questions) || content.questions.length !== metadata.questionCount || content.questions.length > 5e3) fail14("bank_content", "$.questions", "question count does not match bounded metadata");
  if (metadata.visibility === "private" && bytes.byteLength > 3 * 1024 * 1024) fail14("bank_content_limit", "$", "private bank exceeds 3 MiB");
  const keys = /* @__PURE__ */ new Set();
  const questionRefs = [];
  for (let i = 0; i < content.questions.length; i++) {
    const q = content.questions[i];
    const path = `$.questions[${i}]`;
    if (!q || Array.isArray(q) || q.bankUid !== content.bankUid || !isUuid(q.questionUid) || !isQuestionKey(q.questionKey) || q.questionKey !== `${content.bankUid}/${q.questionUid}` || keys.has(q.questionKey)) fail14("registered_identity", path, "invalid or duplicate registered question identity");
    if (q.type !== void 0 && !["choice", "fill"].includes(q.type)) fail14("unsupported_type", path, "only registered choice/fill content is supported");
    keys.add(q.questionKey);
    const derived = await deriveContent(q);
    if (q.questionRevision !== derived.questionRevision || !Array.isArray(q.optionIds) || q.optionIds.length !== derived.optionIds.length || q.optionIds.some((id, index) => id !== derived.optionIds[index])) fail14("question_revision", path, "registered content revision/options do not match complete content");
    questionRefs.push({ questionKey: q.questionKey, questionRevision: q.questionRevision });
  }
  return { content, bytes, contentDigest: await sha256Hex(bytes), questionRefs };
}
var PROTECTED_BANK_V2_FORMAT = "qb-protected-bank-envelope-v2";
function protectedBankV2Aad(envelope) {
  return canonicalBytes({ format: PROTECTED_BANK_V2_FORMAT, version: 2, bankUid: envelope.bankUid, indexDigest: envelope.indexDigest });
}
async function validateProtectedBankEnvelopeV2(input) {
  const bytes = canonicalContentBytes(input);
  if (bytes.length > 3 * 1024 * 1024) fail14("protected_cipher_limit", "$", "stored envelope exceeds 3 MiB");
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!value || Object.keys(value).sort().join(",") !== "bankUid,cipher,ciphertext_b64,compression,format,indexDigest,iv_b64,kdf,questionRefs,salt_b64,version" || value.format !== PROTECTED_BANK_V2_FORMAT || value.version !== 2 || !isUuid(value.bankUid) || value.cipher !== "AES-GCM-256" || value.compression !== "none" || !/^[0-9a-f]{64}$/.test(value.indexDigest || "") || !value.kdf || Object.keys(value.kdf).sort().join(",") !== "hash,iterations,name" || value.kdf.name !== "PBKDF2" || value.kdf.hash !== "SHA-256" || !Number.isSafeInteger(value.kdf.iterations) || value.kdf.iterations < 6e5 || value.kdf.iterations > 1e6 || !Array.isArray(value.questionRefs) || value.questionRefs.length > 5e3) fail14("protected_cipher_v2", "$", "invalid explicit v2 envelope");
  const keys = /* @__PURE__ */ new Set();
  for (const ref of value.questionRefs) {
    if (!ref || Object.keys(ref).sort().join(",") !== "questionKey,questionRevision" || !isQuestionKey(ref.questionKey) || !ref.questionKey.startsWith(`${value.bankUid}/`) || !/^[0-9a-f]{64}$/.test(ref.questionRevision || "") || keys.has(ref.questionKey)) fail14("protected_index", "$.questionRefs", "invalid or duplicate encrypted question declaration");
    keys.add(ref.questionKey);
  }
  for (
    const [key2, length] of
    /** @type {[string,number|null][]} */
    [["salt_b64", 16], ["iv_b64", 12], ["ciphertext_b64", null]]
  ) {
    if (typeof value[key2] !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value[key2])) fail14("protected_cipher_v2", `$.${key2}`, "invalid base64");
    const decoded = atob(value[key2]);
    if (btoa(decoded) !== value[key2] || length !== null && decoded.length !== length || length === null && decoded.length < 16) fail14("protected_cipher_v2", `$.${key2}`, "invalid cryptographic field");
  }
  if (await sha256Hex(canonicalBytes(value.questionRefs)) !== value.indexDigest) fail14("protected_index_digest", "$.indexDigest", "encrypted index digest mismatch");
  return { envelope: value, bytes, contentDigest: await sha256Hex(bytes), questionRefs: value.questionRefs, aad: protectedBankV2Aad(value), proofClass: "declared-encrypted-index-shape-and-digest" };
}

// src/storage/sync/protocol.js
var syncError = (code) => Object.assign(new Error(code), { code });
function mutationWire(record) {
  validateMutationRecord(record);
  const { protocolVersion, mutationId, clientStreamId, clientSeq, kind, entityKey, payload, payloadDigest } = record;
  return structuredClone(validateMutation({ protocolVersion, mutationId, clientStreamId, clientSeq, kind, entityKey, payload, payloadDigest }));
}
function validateSyncReceipt(value) {
  canonicalBytes(value);
  validateImportReceiptRecord(value);
  const p = value.provenance;
  const fields6 = "entityKey,format,generation,kind,logEpoch,payloadDigest,serverRevision";
  if (Object.keys(p || {}).sort().join() !== fields6 || !isUuid(p.generation) || !isUuid(p.logEpoch) || value.sourceId !== `qb-sync-v2:${p.generation}:${p.logEpoch}`) throw syncError("SYNC_RECEIPT_CORRUPT");
  if (p.format !== "qb-sync-entity-v1" || !["bank_revision", "attempt_manifest", "resume_state", "user_state"].includes(p.kind) || typeof p.entityKey !== "string" || value.sourceRecordId !== `entity:${p.kind}:${p.entityKey}` || !Number.isSafeInteger(p.serverRevision) || p.serverRevision < 1 || typeof p.payloadDigest !== "string" || !/^[0-9a-f]{64}$/.test(p.payloadDigest)) throw syncError("SYNC_RECEIPT_CORRUPT");
  const validEntity = p.kind === "bank_revision" ? p.entityKey.startsWith("bank:") && isUuid(p.entityKey.slice(5)) : p.kind === "user_state" ? p.entityKey.startsWith("user_state:") && p.entityKey.endsWith(":starred") && isQuestionKey(p.entityKey.slice(11, -8)) : p.entityKey.startsWith("attempt:") && isUuid(p.entityKey.slice(8));
  if (!validEntity) throw syncError("SYNC_RECEIPT_CORRUPT");
  return value;
}
async function validateSyncChangeReceipt(value) {
  canonicalBytes(value);
  validateImportReceiptRecord(value);
  const owned = structuredClone(value), p = owned.provenance;
  if (Object.keys(p || {}).sort().join() !== "change,format,generation,logEpoch" || p.format !== "qb-sync-change-v1" || !isUuid(p.generation) || !isUuid(p.logEpoch)) throw syncError("SYNC_CHANGE_CORRUPT");
  validateChangeLogRecord(p.change);
  if (p.change.accountGeneration !== p.generation || owned.sourceId !== `qb-sync-v2:${p.generation}:${p.logEpoch}` || owned.sourceRecordId !== `change:${p.change.serverSeq}`) throw syncError("SYNC_CHANGE_CORRUPT");
  const digest11 = await sha256Hex(canonicalBytes({ protocolVersion: 2, kind: p.change.kind, entityKey: p.change.entityKey, payload: p.change.payload }));
  if (digest11 !== p.change.payloadDigest) throw syncError("SYNC_CHANGE_DIGEST");
  return owned;
}

// ../../task-11/report-release-integration/node_modules/@noble/hashes/_u64.js
var fromNumH = (n) => n / 2 ** 32 | 0;
var fromNumL = (n) => n >>> 0;
function setU64FromNum(view, byteOffset, n, isLE) {
  const h = fromNumH(n);
  const l = fromNumL(n);
  view.setUint32(byteOffset, isLE ? l : h, isLE);
  view.setUint32(byteOffset + 4, isLE ? h : l, isLE);
}

// ../../task-11/report-release-integration/node_modules/@noble/hashes/utils.js
function isBytes(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array" && "BYTES_PER_ELEMENT" in a && a.BYTES_PER_ELEMENT === 1;
}
var atitle = (title) => title ? `"${title}" ` : "";
function anumber(n, title = "") {
  if (typeof n !== "number")
    throw new TypeError(atitle(title) + "expected number, got " + typeof n);
  if (!Number.isSafeInteger(n) || n < 0)
    throw new RangeError(atitle(title) + "expected integer >= 0, got " + n);
  return n;
}
function abytes(value, length, title = "") {
  if (isBytes(value) && (length === void 0 || value.length === length))
    return value;
  if (length !== void 0)
    anumber(length, "length");
  const bytes = isBytes(value);
  const ofLen = length !== void 0 ? ` of length ${length}` : "";
  const got = bytes ? `length=${value.length}` : `type=${typeof value}`;
  const message = atitle(title) + "expected Uint8Array" + ofLen + ", got " + got;
  if (!bytes)
    throw new TypeError(message);
  throw new RangeError(message);
}
var aobject = (value, label) => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError((label === "object" ? "" : `"${label}" `) + "expected object, got type=" + typeof value);
};
var aopts = (value, label) => {
  aobject(value, label);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null)
    throw new TypeError(`"${label}" expected plain object`);
  if (Object.hasOwn(value, "__proto__"))
    throw new TypeError(`"${label}.__proto__" is not allowed`);
};
function aexists(instance, checkFinished = true) {
  if (instance.destroyed)
    throw new Error("hash was destroyed");
  if (checkFinished && instance.finished)
    throw new Error("digest() was already called");
}
function aoutput(out, instance) {
  abytes(out, void 0, "output");
  const min = instance.outputLen;
  if (!(out.length >= min)) {
    throw new RangeError('"output" expected length >= ' + min);
  }
}
function clean(...arrays) {
  for (let i = 0; i < arrays.length; i++) {
    arrays[i].fill(0);
  }
}
function createView(arr) {
  return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
}
function rotr(word, shift) {
  return word << 32 - shift | word >>> shift;
}
function checkOpts(defaults, opts, title = "opts") {
  aopts(defaults, "defaults");
  if (opts !== void 0)
    aopts(opts, title);
  const merged = Object.assign(/* @__PURE__ */ Object.create(null), defaults, opts);
  return merged;
}
function createHasher(hashCons, info = {}) {
  if (typeof hashCons !== "function")
    throw new TypeError('"hashCons" expected function, got type=' + typeof hashCons);
  info = checkOpts({}, info, "info");
  const hashC = (msg, opts) => hashCons(opts).update(msg).digest();
  const tmp = hashCons(void 0);
  hashC.outputLen = tmp.outputLen;
  hashC.blockLen = tmp.blockLen;
  hashC.canXOF = tmp.canXOF;
  hashC.create = (opts) => hashCons(opts);
  Object.assign(hashC, info);
  return Object.freeze(hashC);
}
var oidNist = (suffix) => ({
  // Current NIST hashAlgs suffixes used here fit in one DER subidentifier octet.
  // Larger suffix values would need base-128 OID encoding and a different length byte.
  oid: Uint8Array.from([6, 9, 96, 134, 72, 1, 101, 3, 4, 2, suffix])
});

// ../../task-11/report-release-integration/node_modules/@noble/hashes/_md.js
function Chi(a, b, c) {
  return a & b ^ ~a & c;
}
function Maj(a, b, c) {
  return a & b ^ a & c ^ b & c;
}
var HashMD = class {
  blockLen;
  outputLen;
  canXOF = false;
  padOffset;
  isLE;
  // For partial updates less than block size
  buffer;
  view;
  finished = false;
  length = 0;
  pos = 0;
  destroyed = false;
  constructor(blockLen, outputLen, padOffset, isLE) {
    this.blockLen = blockLen;
    this.outputLen = outputLen;
    this.padOffset = padOffset;
    this.isLE = isLE;
    this.buffer = new Uint8Array(blockLen);
    this.view = createView(this.buffer);
  }
  update(data) {
    aexists(this);
    abytes(data);
    const { view, buffer, blockLen } = this;
    const len = data.length;
    let processed = false;
    for (let pos = 0; pos < len; ) {
      const take = Math.min(blockLen - this.pos, len - pos);
      if (take === blockLen) {
        const dataView = createView(data);
        for (; blockLen <= len - pos; pos += blockLen)
          this.process(dataView, pos);
        processed = true;
        continue;
      }
      buffer.set(pos === 0 && take === len ? data : data.subarray(pos, pos + take), this.pos);
      this.pos += take;
      pos += take;
      if (this.pos === blockLen) {
        this.process(view, 0);
        this.pos = 0;
        processed = true;
      }
    }
    this.length += data.length;
    if (processed)
      this.roundClean();
    return this;
  }
  digestInto(out) {
    aexists(this);
    aoutput(out, this);
    this.finished = true;
    const { buffer, view, blockLen, isLE } = this;
    let { pos } = this;
    buffer[pos++] = 128;
    buffer.fill(0, pos);
    if (this.padOffset > blockLen - pos) {
      this.process(view, 0);
      buffer.fill(0);
    }
    setU64FromNum(view, blockLen - 8, this.length * 8, isLE);
    this.process(view, 0);
    this.roundClean();
    const oview = out === buffer ? view : createView(out);
    const len = this.outputLen;
    const outLen = len / 4;
    const state = this.get();
    if (len % 4 || outLen > state.length)
      throw new Error("invalid outputLen");
    for (let i = 0; i < outLen; i++)
      oview.setUint32(4 * i, state[i], isLE);
  }
  digest() {
    const { buffer, outputLen } = this;
    this.digestInto(buffer);
    const res = buffer.slice(0, outputLen);
    this.destroy();
    return res;
  }
  _cloneIntoMeta(to) {
    const { buffer, length, finished, destroyed, pos } = this;
    to.destroyed = destroyed;
    to.finished = finished;
    to.length = length;
    to.pos = pos;
    if (pos)
      to.buffer.set(buffer);
    return to;
  }
  clone() {
    return this._cloneInto();
  }
};
var SHA256_IV = /* @__PURE__ */ Uint32Array.from([
  1779033703,
  3144134277,
  1013904242,
  2773480762,
  1359893119,
  2600822924,
  528734635,
  1541459225
]);

// ../../task-11/report-release-integration/node_modules/@noble/hashes/sha2.js
var SHA256_K = /* @__PURE__ */ Uint32Array.from([
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
]);
var SHA256_W = /* @__PURE__ */ new Uint32Array(64);
var SHA2_32B = class extends HashMD {
  // We cannot use array here since array allows indexing by variable
  // which means optimizer/compiler cannot use registers.
  // Numeric initializers matter: starting the fields as `undefined` changes
  // V8's field representation and makes sha256 3x slower (measured).
  A = 0;
  B = 0;
  C = 0;
  D = 0;
  E = 0;
  F = 0;
  G = 0;
  H = 0;
  constructor(outputLen, IV) {
    super(64, outputLen, 8, false);
    this.A = IV[0] | 0;
    this.B = IV[1] | 0;
    this.C = IV[2] | 0;
    this.D = IV[3] | 0;
    this.E = IV[4] | 0;
    this.F = IV[5] | 0;
    this.G = IV[6] | 0;
    this.H = IV[7] | 0;
  }
  get() {
    const { A, B, C, D, E, F, G, H } = this;
    return [A, B, C, D, E, F, G, H];
  }
  // prettier-ignore
  set(A, B, C, D, E, F, G, H) {
    this.A = A | 0;
    this.B = B | 0;
    this.C = C | 0;
    this.D = D | 0;
    this.E = E | 0;
    this.F = F | 0;
    this.G = G | 0;
    this.H = H | 0;
  }
  _cloneInto(to) {
    (to ||= new this.constructor()).set(...this.get());
    return this._cloneIntoMeta(to);
  }
  process(view, offset) {
    for (let i = 0; i < 16; i++, offset += 4)
      SHA256_W[i] = view.getUint32(offset, false);
    for (let i = 16; i < 64; i++) {
      const W15 = SHA256_W[i - 15];
      const W2 = SHA256_W[i - 2];
      const s0 = rotr(W15, 7) ^ rotr(W15, 18) ^ W15 >>> 3;
      const s1 = rotr(W2, 17) ^ rotr(W2, 19) ^ W2 >>> 10;
      SHA256_W[i] = s1 + SHA256_W[i - 7] + s0 + SHA256_W[i - 16] | 0;
    }
    let { A, B, C, D, E, F, G, H } = this;
    for (let i = 0; i < 64; i++) {
      const sigma1 = rotr(E, 6) ^ rotr(E, 11) ^ rotr(E, 25);
      const T1 = H + sigma1 + Chi(E, F, G) + SHA256_K[i] + SHA256_W[i] | 0;
      const sigma0 = rotr(A, 2) ^ rotr(A, 13) ^ rotr(A, 22);
      const T2 = sigma0 + Maj(A, B, C) | 0;
      H = G;
      G = F;
      F = E;
      E = D + T1 | 0;
      D = C;
      C = B;
      B = A;
      A = T1 + T2 | 0;
    }
    A = A + this.A | 0;
    B = B + this.B | 0;
    C = C + this.C | 0;
    D = D + this.D | 0;
    E = E + this.E | 0;
    F = F + this.F | 0;
    G = G + this.G | 0;
    H = H + this.H | 0;
    this.set(A, B, C, D, E, F, G, H);
  }
  roundClean() {
    clean(SHA256_W);
  }
  destroy() {
    this.destroyed = true;
    this.set(0, 0, 0, 0, 0, 0, 0, 0);
    clean(this.buffer);
  }
};
var _SHA256 = class extends SHA2_32B {
  constructor() {
    super(32, SHA256_IV);
  }
};
var sha256 = /* @__PURE__ */ createHasher(
  () => new _SHA256(),
  /* @__PURE__ */ oidNist(1)
);

// do-worker/src/account-public-registry.generated.js
var publicRegistryJson = '[{"bankUid":"be8fe87d-7ec8-4bdd-a33a-a5d6b16d35e4","contentManifest":{"contentDigest":"a19d1135fe58e9733a0f745d7900f2a5ab9d013a91ea981e00c4c917ae6d5912","kind":"public_static","staticRef":"banks/v2/239-airframe-elec.a19d1135fe58e9733a0f745d7900f2a5ab9d013a91ea981e00c4c917ae6d5912.json"},"metadata":{"questionCount":34,"title":"Aircraft Electrical","visibility":"public"},"publicContentReference":{"chunkCount":1,"contentDigest":"a19d1135fe58e9733a0f745d7900f2a5ab9d013a91ea981e00c4c917ae6d5912","manifestDigest":"e69896376aab18ace13884eb9e7008741b389cf88e0685e178e476a6c973554e","totalBytes":239733},"questionsrefs":[{"questionKey":"be8fe87d-7ec8-4bdd-a33a-a5d6b16d35e4/3b675d4c-50ee-4d67-bf31-fbab5d9232d6","questionRevision":"9e58a13277a81f1795747cb9d8ddaaded8639900e94aad1a6930074f7017d752"},{"questionKey":"be8fe87d-7ec8-4bdd-a33a-a5d6b16d35e4/651cd1db-3db4-45ee-8d18-302cda67ddbc","questionRevision":"37d5999be0be08cdb9d9858406f8b1c5deb1f754b232d386d5233314cae5a2ae"},{"questionKey":"be8fe87d-7ec8-4bdd-a33a-a5d6b16d35e4/22d37ddb-3671-4a39-811d-3066fc9f9889","questionRevision":"aacb7305629cf531fe0f8dfbe6d62922fbc2e235602e9a08d4de38d45ad0159a"},{"questionKey":"be8fe87d-7ec8-4bdd-a33a-a5d6b16d35e4/39063c51-ea10-4a4a-8cc5-4a6cf1865ed0","questionRevision":"4be9a9dc45c94cac4f762c251aeb647af8c7510594a264773e7ba0e1ddd8ac3d"},{"questionKey":"be8fe87d-7ec8-4bdd-a33a-a5d6b16d35e4/293343ba-1c20-43fb-ad55-da180b911d2a","questionRevision":"e91832e836545ba5b8dfdb5ad858282948b61edc1ee0802648dde87487ebd224"},{"questionKey":"be8fe87d-7ec8-4bdd-a33a-a5d6b16d35e4/fc65061d-4af9-4578-9a38-8747ef713441","questionRevision":"7ab58496c9fee8bd03a6f857db58801eba0ccf27099333a3ce54b4f36907ec15"},{"questionKey":"be8fe87d-7ec8-4bdd-a33a-a5d6b16d35e4/c519dbac-6d0b-4b89-98fa-6e3d556bba3c","questionRevision":"2a8fdc87b06548aa30fdf6d957bc2877908bc5af8a33d25fe4bbd4f106b3de22"},{"questionKey":"be8fe87d-7ec8-4bdd-a33a-a5d6b16d35e4/51dec7e6-a70a-494b-8386-9bd6c5e60916","questionRevision":"6f93bbeab2a8846662cfe82806b9a0e4f4892096fb058c0bea428b7e7b094330"},{"questionKey":"be8fe87d-7ec8-4bdd-a33a-a5d6b16d35e4/27a2d9db-626c-44c0-92fa-69d70f7b519a","questionRevision":"552bd6e7581ab67a0799087ab3f51531fd50d0bc8abcece0d913bf345a6bd0c5"},{"questionKey":"be8fe87d-7ec8-4bdd-a33a-a5d6b16d35e4/1c8e28e4-87a6-48b6-8958-78ee6951dad3","questionRevision":"594a92281a3942d9f0c570763d90de8b5553f1fcbd5bb0adc9c834b09e95aee7"},{"questionKey":"be8fe87d-7ec8-4bdd-a33a-a5d6b16d35e4/c7c0f1eb-f9fe-4f31-8b32-60058d0be156","questionRevision":"a72952727c2a1c3f875c8eebab509510ecd1058066221123ad3b3c33b08ff3ea"},{"questionKey":"be8fe87d-7ec8-4bdd-a33a-a5d6b16d35e4/c155f6b6-e779-47b4-be0c-47f81b5f15ac","questionRevision":"4aeaea7f363d9b8e59ae00ed6ee2cce4dc0e3852b9970c7e75fbd437e4d7dbea"},{"questionKey":"be8fe87d-7ec8-4bdd-a33a-a5d6b16d35e4/41ed791e-50d2-40dd-a776-f78f5286ffa6","questionRevision":"9cc49a088c15279029835e454771479b8980bfa47329deb5110161931eef2132"},{"questionKey":"be8fe87d-7ec8-4bdd-a33a-a5d6b16d35e4/9d9625cd-bad1-4562-b56c-e9177bdafe68","questionRevision":"c5aae1d9061624dae0a3cd293e09854110a4a5dbcf0cebdb60ec05de0f43f460"},{"questionKey":"be8fe87d-7ec8-4bdd-a33a-a5d6b16d35e4/af4885d3-5a17-4f5b-9afc-2cee1effa65c","questionRevision":"7c60276edd7028f7daa0b5f3559347c7d9266add52dafd1714b666fa639a7b45"},{"questionKey":"be8fe87d-7ec8-4bdd-a33a-a5d6b16d35e4/2c3aeba4-97b1-4040-bd0c-72ebe04af48a","questionRevision":"451dece7ef6d80a304f56f572112e1c88c02e04df4ff457e1ec9b2e9c80ff88c"},{"questionKey":"be8fe87d-7ec8-4bdd-a33a-a5d6b16d35e4/00cdf912-be5c-45e7-86f7-7feeb038812a","questionRevision":"6f9d069a141348db0b9aa692f149073ad9ad54edf7f5b3ea130f276b294dd484"},{"questionKey":"be8fe87d-7ec8-4bdd-a33a-a5d6b16d35e4/0f890e9a-0857-4a20-a244-374639fce722","questionRevision":"d510396948a289c8656f850d759267dbe6f533663c634c18f7ea46c48de855cf"},{"questionKey":"be8fe87d-7ec8-4bdd-a33a-a5d6b16d35e4/753cd9ad-81d5-48a8-bc71-8013b1fe6b09","questionRevision":"1bda3168bd76f90c36dc7fdd8c7476c87b16e024817a5a7ef9b4c25f9c16fc82"},{"questionKey":"be8fe87d-7ec8-4bdd-a33a-a5d6b16d35e4/7ca78879-757b-4308-88b0-d7cb819426b6","questionRevision":"ad9441f25f577e19e035b90cf7b8c2195b847215bc03123faddc94d95a080ae9"},{"questionKey":"be8fe87d-7ec8-4bdd-a33a-a5d6b16d35e4/03ca92ba-c435-4b7b-bc5e-07ecf3b606bf","questionRevision":"3afc8eeccff2c66ce9ce882075385cbf220a9c597c5612ee027c4f166d0d96a2"},{"questionKey":"be8fe87d-7ec8-4bdd-a33a-a5d6b16d35e4/0824ca85-be3c-4d4b-aa59-23de50d75547","questionRevision":"8bf6492ad7fd9b370f66fe6885684a5081a1765c837a45775761aabb53a841be"},{"questionKey":"be8fe87d-7ec8-4bdd-a33a-a5d6b16d35e4/11baf704-7b74-4a8d-adb1-68e7f8e90d8d","questionRevision":"5a8f8e7cf9ad2d2f80bb3f823ae80ec1ab3a6aef4a13dd954bb9191f15f56fd9"},{"questionKey":"be8fe87d-7ec8-4bdd-a33a-a5d6b16d35e4/b65b7168-8209-4081-9688-c83f40c0d2dc","questionRevision":"8f58ea26c8bb93a7c7689f65e322e8c891f2595a1186e03b6713ac01774af8ce"},{"questionKey":"be8fe87d-7ec8-4bdd-a33a-a5d6b16d35e4/acefd9e1-6b89-4504-9944-9e5c5ed2e698","questionRevision":"7826891b32835e727c660da71ff74bdf95792847cd97f3f1f022b7bdc7ff5128"},{"questionKey":"be8fe87d-7ec8-4bdd-a33a-a5d6b16d35e4/488046af-ff3f-46d2-badc-b59bd53cdde4","questionRevision":"3a1495bad82f1cac9b4856957679e0cceab54a585b355265a19ab8c1047290ad"},{"questionKey":"be8fe87d-7ec8-4bdd-a33a-a5d6b16d35e4/058070d5-fbf4-4773-a4f1-e0073a758d3d","questionRevision":"8f1cab9dbee0a14d201575fbf9939c3e73f36c69b6c136947d03eab392ec643b"},{"questionKey":"be8fe87d-7ec8-4bdd-a33a-a5d6b16d35e4/90306976-e21b-4548-934f-6b5aab5f46bc","questionRevision":"f5505401b35eeb264ea5a6693a4fc77a79d4591bdbcd536b7c86b19a94f571d0"},{"questionKey":"be8fe87d-7ec8-4bdd-a33a-a5d6b16d35e4/86450e6c-5807-43f2-a582-a23e6f4dccb8","questionRevision":"49906eb419384635be97314b415116322a4b1eab29009f8dccd0bf52586e90b8"},{"questionKey":"be8fe87d-7ec8-4bdd-a33a-a5d6b16d35e4/182a7cec-23a7-4f46-ad79-06255eee5a16","questionRevision":"41ece43054e2c8b30fc446eda3bad8507e842433eb73501f277eab3089af5990"},{"questionKey":"be8fe87d-7ec8-4bdd-a33a-a5d6b16d35e4/dbe7bd16-c5b7-4318-a447-70bf4477afdf","questionRevision":"15243082437349f247465ab2700aae515f4f69cdaf60eae526c26b20da130de0"},{"questionKey":"be8fe87d-7ec8-4bdd-a33a-a5d6b16d35e4/bab49e02-eb78-4569-8388-c1afd328f1b0","questionRevision":"613947a26adb2400af6b9d8b0e714a82aba55281b6cb018889cc26808f7bcd29"},{"questionKey":"be8fe87d-7ec8-4bdd-a33a-a5d6b16d35e4/4916438f-71d9-457d-b909-46001343fe66","questionRevision":"44b28ca7087685495f394fd5e70b7e4f3c952cf124ec747bb9bf4f465dccf4dd"},{"questionKey":"be8fe87d-7ec8-4bdd-a33a-a5d6b16d35e4/1ebb6f26-3f9f-4579-b13d-30b5c7b0436e","questionRevision":"3c2301bd2395d21e47610ad9c3426bae9c154b0a194a787b0d3f43e4132c0354"}],"revision":"a19d1135fe58e9733a0f745d7900f2a5ab9d013a91ea981e00c4c917ae6d5912"},{"bankUid":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b","contentManifest":{"contentDigest":"b69beb00cd3a2dbada9626efdb42cebbdb7bd75a75b1b3dea9aaf56fc26efa91","kind":"public_static","staticRef":"banks/v2/205-finishes.b69beb00cd3a2dbada9626efdb42cebbdb7bd75a75b1b3dea9aaf56fc26efa91.json"},"metadata":{"questionCount":112,"title":"Finishes","visibility":"public"},"publicContentReference":{"chunkCount":1,"contentDigest":"b69beb00cd3a2dbada9626efdb42cebbdb7bd75a75b1b3dea9aaf56fc26efa91","manifestDigest":"7a3bd250898984c4e8e710eb030dc9c9249f2e984c06d89d089b42f7b72e0208","totalBytes":99160},"questionsrefs":[{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/1e98207b-bcfe-4a58-a669-9090e48ea50e","questionRevision":"0640a06079ef43fed01824d81b009f8f7fc855d531b4bf7f116d66c4abf44d9d"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/24813eaf-7efd-4ecd-aa20-461e933ee685","questionRevision":"3df7f0b8eb18ff18378be2f1a4b043ae06d021226b0f47845f0f77fd75591c8e"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/86474807-6d89-48b6-a1b2-db17fa64ed6b","questionRevision":"b9dd2d198b98311af928baa9142710c78e4568172a950f5550206dc26b82c23a"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/44c19cb4-2284-4f50-bdd8-b4bce780ed80","questionRevision":"568e629318926bb8db80a4a1930f38319871a782de0fb99f2ebd04cc3918e2a1"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/6d226a18-a830-440c-8758-f715a9784e88","questionRevision":"7560c391bd08340ae4b19a8b50ba995f11c2d36e78c6bb9241db56cbc3161cd9"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/d5327338-3881-4ddc-bb56-12869b613352","questionRevision":"2d8b0ede0a0e8492df4aba71e9016d57f2ad7375960049d0b4176cb3d8cdbd7b"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/9ba5b3c4-e2be-4a9c-99a1-89af5bfb90dd","questionRevision":"f90e218de4d5d98008043d737474f1b71005778b37c5f5fe42c2f2d80741311f"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/4682c304-0dfc-4c49-bef8-03e091bd4d39","questionRevision":"c4e9e570e4427ff0aad644859c8b8e256d50fd16caa0cd74811cb334ff2c9c1b"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/6bd65cf4-1ff1-4d56-a07f-d66c446b2e82","questionRevision":"e30d5c3ed2a9f02dedcd865902c2e8fcfb83033d2b23406a7c778a7c75a62560"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/0489b270-f667-4d3d-bf14-6abd717d69f5","questionRevision":"def4430deade78b49aa6b30a8357a2bd37db6b776ee307bf7cacea9a0240b189"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/b06ff80f-ed79-404b-99dc-e872ab7e900a","questionRevision":"a1f9eeff78579d7f3b86398a2d0a7b0028fca53124dbfb11486159dd85c219e5"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/b39ae433-dd0d-4273-80af-a7b7ed7e579f","questionRevision":"7033d16eddbe311e6f0082bfa8fd1e58abf2c7fb4f23b9d149d59ea4398fec6c"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/96c8a996-6279-4584-b935-55108db82641","questionRevision":"8487f7801d3fedb463340c040121194fe9295f87270f628bd315cca81f17142b"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/4df7b0dd-8ce6-4c30-a520-41019030f953","questionRevision":"001363ee5d9318e30a7864d39e218606a35527116ef025bd914e9e77300b0f98"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/2d59c872-9b4d-4384-8082-ebf60c2ee4f9","questionRevision":"b0cbcb00c7c591bfa9055404a5b4f909a3b1ce02f9fc405261540ab198654241"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/b74b2ecc-8bd4-4ee5-8acc-7a1b86851070","questionRevision":"3441fd177bb5e59cc44df6fe070c832f69c13f9dfb59c4abb83587745affd51f"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/866d7307-7565-4dce-9afc-d930306ad3f7","questionRevision":"a92dadf8bf85a2f952ec0f6fc6a270773da98a347429a3ec2998502b9c0c8a8c"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/9dcc7519-48fb-49ac-89f7-3422604a0a4f","questionRevision":"e970bac3021eb74a2eae28c184707a917917b0de20b64712ff199a2a4c9168b8"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/971c59bf-c659-493e-89a9-17b1c8affef0","questionRevision":"1ffc1940131837945fa21aa4fab0d054a6a3c400de59e6956f6292b1795e1e9a"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/3e20553e-1dd2-4fb0-9f66-6956a0a18207","questionRevision":"1642017f64df421716c6ae446c54e00b3efe47ba86e7652a887954cd66993769"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/2564946b-6358-408d-ba32-f6ec5068037c","questionRevision":"4f9ee6a897179dc682b3a514fdbba702f63b14711c3063923d740ab5a9d7d085"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/4e8e436f-29c6-4e93-a014-e35e56dad2b6","questionRevision":"c7a240110a0b60b32d5990e26c6eb321b9cc78f232ad7fcfa1db74d3378afb5b"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/f42ea9f0-a894-4fd6-9c7b-7997b87bd6a9","questionRevision":"2c2afa8eb8e6df778e931e6e6cb3d0aae30b202f70d515389d35072a0cef3f7b"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/bf0d7ec0-7224-48e6-8621-bfe2cd8983af","questionRevision":"a397fb9c00670d151f1d613cfc70a3b28b4f30494c558b048d331c67e4999549"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/7e5786d9-1ea5-42e5-8d2c-f288357f337c","questionRevision":"408d2230c2f5f2c2108a1092957e2d353d2af6b4c415c5d13587bbfcd8afceb7"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/7d3beb9b-6e92-45e3-b449-79756bd2aa93","questionRevision":"f87d164f8afdae3e4af8c76eec4d26f719cbe2ad341670b2958117be8dfabaef"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/c84df202-8060-4edb-9408-6b3d2e714311","questionRevision":"9dd3aaa2c10cf376f6eb6aa7190ac7d03de27f410418f439c64f7ad7a7fa033e"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/60dcfaea-f021-439e-ba06-4a7f7c106fb0","questionRevision":"30724d1b7da73fef63c706489a420587a31a88e02ed868d1da2120099afb75b0"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/df35b53d-f414-413a-9616-d557a198f624","questionRevision":"170e8fa956343acc6cb6a3cd346a37a09c10f108600f15094b98cbfb9766b979"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/a26e685f-2b4a-42ec-a5ed-c537d276823b","questionRevision":"5dc05ba5e3577e6dfadeba3848206437cd0f77f43bd15b5f5f67899aaf2bfd61"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/a0974e4e-1408-4aba-91af-01bdb0109407","questionRevision":"ebb11ed09260245b56253a0d5ac34e79e57a786860025a3394078c4296b455e8"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/01c71d74-aa33-4d45-93cb-5ec425a8179e","questionRevision":"dd66f1435239f25c23066082c4631b4c6ff4ce0be7ec45af44c68b03c1f66720"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/306f3cf0-dae4-4f6a-8e1f-1b1649928f75","questionRevision":"dcb90e9f4b7bc1b66353bfeb6c2e5643a4d3b5e9a894a3c6a4b9cab6c35ee211"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/fc79d9ac-5ea9-43b4-9604-2dcd5681d487","questionRevision":"a7edb85b834b3f1d991b6a5702d0eef0734945a574d274f78ea6795ea2584ebd"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/e04f8281-4e8e-4b16-9722-31a4eedaf522","questionRevision":"773ae1260b45b31707e1dc9b08e4ea20b8b977704922752870344bfc870bf4fd"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/d39f5a36-91ae-4a86-bea7-098ae3582763","questionRevision":"cc4f8476b8698a6b9e4062da5bccf2a855787940d681a23f74bd2be32aa968b8"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/a717b865-b77f-4c3b-b454-e9237a626af5","questionRevision":"2084bef87ff4b888f9ab911d0f564c43ff0d5bc46dbef9a07e6bdbf6329b1250"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/e3074169-875b-46c7-acdf-8c6945ad1674","questionRevision":"9c07fd27d031fcbf131e2822d0160174c780dc80f00d3b87c6ec8094624d3f46"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/b0b6d707-8225-4c92-b691-0e5ef7dce395","questionRevision":"e909c9e2a0bb7435db6b2dbc9d3235f5d05e6c4334255ca195b4f868a3223092"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/de776160-8a69-45a9-9bf9-9a6a43a5e444","questionRevision":"b2233ae25534f5d93e350a4782d6a26cacc6d6c962c8dabcbdeaf98e093eedf7"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/562e5493-50f2-4cc8-9b78-f5792498f1a5","questionRevision":"754d29c2c95855a9b0c036b954c21b6c71288b2f821d30cfcdf37a641dcf840d"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/4802faf5-a84b-4428-8da6-96b1f6ab3bf4","questionRevision":"b7d71ddbcf91ea506d8c13e4689103b53bf1f0a0fc6e6d91b3dbbdc963f549b6"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/34bd758a-e24e-4fd3-8fa9-98f95448743a","questionRevision":"98cadcea603dfb12b625cef568bb3618506a7819ace7a6041bd0f08a6f85d450"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/0ebdf397-1108-4641-8afe-b8d6c65f73c0","questionRevision":"20109ded2ecd82d909e45a5f2c90e8fa7c171956825a5919df088888f8394c29"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/770f4c1f-f217-43c3-83f3-9ab45c6c5c93","questionRevision":"d9b7a4ecc4193df66d73960d8cc9d55d7f14ffff9020f9aa510446095b5def3b"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/ec46d090-99e4-4653-8104-8146bf191457","questionRevision":"640d162c8aab3da1b837a31aea41befd1b90920e79381ab5d8cda1a0c177cb17"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/5898913d-4e12-42b9-97ec-f26d99e1c677","questionRevision":"b987c7df3ca749ab46ee2dc7008de0b76a9e18832b3a8349cf2eae44cf40513d"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/de356bb4-61f4-44e2-aeda-1a15f2d4ee60","questionRevision":"f44f4f212997f00823ef78f6586c3adf0803d13cabae488dbfa075d185b9a73a"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/f95254ad-98d0-4504-aaff-5b5f2ab2bdec","questionRevision":"efc839304fcc9938096d7c77b36d3a3067def63ad0d3019b3196a3ed12d4220e"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/a28c4aad-ee3f-4f4c-a228-6931c4ae3234","questionRevision":"e02e27b1f4e439f2dd48b83e78fa245fe838190c99c71cfce03434289b566832"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/df531b37-a984-4344-8f99-4ef5e5f97478","questionRevision":"8c8b8b8ba4f1df4889b8c3e2004b1fbdd6d3eb25a9f5146250ea7dbba7a3f49a"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/3e9b2d3a-acfc-4c6c-8adc-2ec58ee476c4","questionRevision":"30c0d34adaa94f1c40f922e2ed0e91d9b277289afe1b3e8478026dc394000be3"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/273ab09a-47b8-4d82-8cc4-bbf5afae87c0","questionRevision":"5520f788920c09093a384511af5076ae490cf93e2e6df0b78aa142a14049617a"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/b583b48e-8c78-478e-893b-0d22bc37b064","questionRevision":"6f2afcc2047645f30091966952eab80e922fd2245d4590b741b507fe0595e953"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/06eae651-1ac0-4484-805d-c105f0ca926c","questionRevision":"ae34ebd9db7632fdd26343c3e85bcb67814489e859c010597d3c7bf9378e2ea6"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/f3750dd4-5953-4757-9844-9f6549c83361","questionRevision":"dc5efcc894cf60f6a38165e89e8f947973461492a4bb93a936cf51bc7a8d1e51"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/dd759e2d-205b-4300-bc08-9f4a8b660bc3","questionRevision":"909107dcdf45187e1c1958d6fbf947125b306fdd5e34c07bb9fa0949b7887c9d"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/f78def32-7601-49bf-966b-b38f500f561f","questionRevision":"23e2551a4fca53af303105a605986ae9782e14cc336165e21283e8b1db5908da"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/48d3ff2c-3656-4ef3-822b-b1b2a19e57a4","questionRevision":"5c12acc81bf4c99b5a0e01766f370b1a85e8d6d786b28c2bc5655de2b99b284d"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/919e95ed-af41-4246-b027-06ed14583cd6","questionRevision":"12645c6771ad13c4707dce67bc8e6aad9e310a9de39e97a83fed449a5b27e7fd"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/0c622192-4d96-4ecd-ada6-74f980bdf8ab","questionRevision":"adbd9ffb3b6d85a941819b5880e229b1b52616b75949a09cc03ebd9888a6d9ee"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/b1c3d63c-aca0-44ff-a0c4-a33b8088fabf","questionRevision":"b9a3b2fb4229538909264031d97961d21561fd3b8d669d481efab08611a3149f"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/fd77cf40-2bb4-4fc9-a6ed-cd79523bbfe3","questionRevision":"6daa8d5bad94992dcdfbecaad825c8c5da9acb66a3e72fadb16ac3b080482eac"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/874d369a-1592-40d4-956b-9f6cbc1b5f87","questionRevision":"91421cec1e020ecd67c636a6a3e9780dfe7b513a81d7d5cbf6263d0c84f6a1af"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/c91eae40-0196-4ae5-ac5d-b2000a8c9774","questionRevision":"21307c71f0bba4d73ab5f052eb76e851157e082edda3fdb5dc7a9c01612773f7"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/8d72c7aa-1747-4bc3-8e99-6da43cc1c398","questionRevision":"ea5ceb9a70d4b3d2364821ca36bf78beb240fd10a755c68fa52c992e9905fcb8"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/93ae8c9f-2444-44c4-85e5-dff91b8a2d12","questionRevision":"7071427e95d17f817b820a7b062a20ed8bc95467b282cb97131149222fe797ee"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/05aa265a-9285-4b05-a435-33272e0a4167","questionRevision":"27abed0a953fa66fa1946f72efe85f5a11459ec50a89811a932979cf248f0e17"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/9db42681-2d8a-49d3-a2a9-87b761da940e","questionRevision":"1801aff79f663b45935f80d9ec902f212d8c3a1518bfbd57c205f944728cf631"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/6c74d975-73d1-4c4d-b64e-d7d0b7b691bc","questionRevision":"f79c24378b0c6e36a0f9e63094df7e50804cb86a12690cd40a9191c772b49e5f"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/6a25ed16-e8ca-400c-ac70-dfb1e20342a2","questionRevision":"b9641fc2d5387f9ac7eb51fabaf065efebdaf980b5423b5458a376041d7c3d79"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/fb4ac887-2dd3-4b9e-939b-281fa1d1a7e4","questionRevision":"aeb87c3ab435e184f5c91f8f01bdac5abba5a238506580a246a89c961c8937d9"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/42d27424-612f-4e35-908a-84835e533bf7","questionRevision":"be36644fb586bc715dc183464329fca4b927449a3d3af19ec235bc8db0c32409"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/9e4f2d81-30e4-468e-a0fc-c716534215f2","questionRevision":"f7b848d056bbbec3a4574560229ad41cede8e6017040453730b12f296295d65c"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/caf73ec7-5fc9-43eb-b91f-64bbcc2d7c5b","questionRevision":"4a94bc4c81ae3768af9ad7ec16f7c09df98bef4d17ea07bdb71df40ed1e5de7d"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/7442b061-7b42-42e0-a9c6-80e186054d0f","questionRevision":"dfe3256b42d8f7c2ac52688445b05af25241446a9bcda2dafbd36fa920b73643"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/bf092183-5e7b-4674-8c2d-b1427ebc702b","questionRevision":"cce910b3f25ca3d1657168d3ead5643c109a7169f7554e209fbd4396f6a3b27f"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/ee930e10-c7a5-4f86-9619-cf86e5913241","questionRevision":"5bf7f243f36e11c677b4baa22b7d592ba17e634c914d61075e6396ab3f9abf0e"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/53fd1cd2-b1dd-4763-baf8-5e24b1f7294e","questionRevision":"814ee2ad805ef0d537e3eaef43f1a5d9549599ad845d7805621be92a5ddecacb"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/0bb9ff1a-2879-487a-9a3f-f02a3a6a3258","questionRevision":"0e2fdb3da74141086d1b9fe309f437c1b2b0fe7dc0d0cb52ec99957eebbbee44"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/ef5e14b5-999f-42db-8f74-6ed99f3142ba","questionRevision":"72eb202a68fd865fe7c611ab554d10a6d661bd57cb31605fb441ce9013daef38"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/41ffef54-dbe8-44de-ba42-a12401aa8280","questionRevision":"e3409831d70152e845a017bdf966fcf152120962265098ae00eefc3f22a95774"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/ea64af0a-a00f-4aef-a7d0-da0cb97fe474","questionRevision":"e157b7fde400bd15e9096b58b912b6c565615426db29465cb238fee9b8aa12d3"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/f80dcb59-8307-43a4-9961-b1b31297bb9c","questionRevision":"bbc54a0fb607d361485658980e23ae57a2bb5bcf412da611ce5f4fd751d678b7"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/727587e8-bbd2-4af3-acff-e3c88b906be8","questionRevision":"8671b3606fcb198a86b2560bc6372d88ba8f6ad83ce8146ed706f36315189bc5"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/37f97573-843e-47d7-864c-579609840665","questionRevision":"a1878ab270d4cbed4497fbd78b11230b2b8f372c662ee2e9546fd59602324a45"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/ef2838d0-2e66-460d-b5bc-2bacc14db6f7","questionRevision":"75efefc9976ed883ea67a9697064c84c99ac4f7f7c0d968f5c1c37e4e6e64fa3"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/483560d2-e48a-4f28-8196-d263363af7eb","questionRevision":"fd6007537601993214560d45b6730bef46c721f6e161b2db453abf2082c4ba98"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/072c34c6-4bf2-4b12-9d0b-db22a0f55c1a","questionRevision":"44ef9971b4ea40440ace25cdb364fd35009e5df224721ba4c26bb4f34d39f129"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/eef0d8ab-80ff-4b02-9485-62992b6e74f3","questionRevision":"eb84305683585b09231e1c21a21e0285a816d505333f16daa801da10eae0c5c4"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/4b82c007-39eb-4898-9009-c609c2416d00","questionRevision":"85ed81f7599077c1b11c37fa7ed6061da4754888acfd6afa57fad109212a2664"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/bdd58660-865a-4f36-82a9-a1162145de34","questionRevision":"242528857b4d647df5ddf5e44a5338e2062ba08cd4cd128a1b1971e4b2be2f36"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/cd9eab19-c45d-4e05-87dc-ecbc7b45c56a","questionRevision":"cc26e9d186cd8a6bd570654e81a1f3ff3a4220a07ebc274e7603d56240cc1335"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/4b02faa4-f74e-4a4c-85e4-258dd1e85d2e","questionRevision":"6af9b515bb5fce66b7023fc02e2fdb5e28eb9695ef6216b498562552e85cabaf"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/3903ed7f-6458-40da-a834-ea9c2e394f4c","questionRevision":"2a9aa9d60b0a85c7520f20ff33a8503deaf6164c5ba04a737c6e5d7f7f246952"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/4aa40423-ea66-47c4-8823-68725c2b36b5","questionRevision":"3437ec030e0ffb80d4190833a99f0690a1d2513ac660ec08bfb87f31f95a1dce"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/b986e9a4-c0e7-47b4-a587-a03de1f65e44","questionRevision":"39f3d2f82a772b1f0631ac220bc60bf2a1fc16ff4059710d6b8c2bf9aed5e2d4"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/391e0929-4182-48a2-b8c6-fb72acdc07cc","questionRevision":"546b9d02bbf56a0be54583a234789294d1717ddcb4658e2514a5b5e65a9145a4"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/5fc91159-53c1-41ce-bcca-7548519f0474","questionRevision":"8d3d8eeb78358feda9fac0c2324573a9bd640176be539f7de4274726c60702af"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/8d4eae54-9f97-4bc6-afa7-4290a8c7ece9","questionRevision":"ded790ea06c6c5263b91e4f3d9d9165e26c7da567b3e3d8fd9f6f954ae476b84"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/506609a0-6e62-4976-ada2-2fe8c452ad79","questionRevision":"68a040052906955813b9003bebbac5f9ff7408b7cf0c1953549bfde33b4e1867"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/f07507ac-91ef-4b2d-aa1f-ee7852177e16","questionRevision":"825eeec3f683c2bb648c5841b412a19e827dbc74090c30d2741d341e8b6a2022"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/f4b0307b-f55a-4875-8656-b79408daf04e","questionRevision":"7101bfc7fb16a5487302449311c5911cbebb8aed3a4940b806a4d13668caa4e0"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/be7fa495-4016-466a-a3eb-559ffd86d323","questionRevision":"d3b59c014087b2562c5d0cb2bede45ec382191b346a5d9a5fb23c7dfc517c3e6"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/bfc12f38-9420-454b-9a5d-c47f1124a412","questionRevision":"1aaa59080e0be367dbbe4fbd99660e8a5d33e931be811e53e42925fd93c9a329"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/1cd83d26-d7d4-49a2-9caf-5be1063bc246","questionRevision":"27bb2bedfc957c3a0a707459130e086e9452994a24a5734af3b6f48858ff2c7c"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/d8ae1b80-d849-4ebd-b29c-2ccec96d7fb2","questionRevision":"e150290822496ca1177c0fa5f7a37697b38fac8aade7414e89a125c8823f4cb5"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/d8b368f1-cef8-4da0-9580-faa4017785ab","questionRevision":"cce260c89c54933b55bed7f67ef30446692c5c4cc5dcd26e2e3be869730db86a"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/0c4d5b6a-ebe5-43b0-afa4-cefc6e24db8b","questionRevision":"f85062d26067c9ccdd75f6dbc6b4f6a7d48b4f098a905ad5fa2dc04ef2bfb71d"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/3e49653f-eba2-4a78-8ddc-fa0e8834fd3b","questionRevision":"3c4a109965abb8b5e02db901359a92c063a74875a9ee31aa3d7fbd49bf502418"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/6d4c6180-0e35-4bca-967d-079127e95b8a","questionRevision":"867a43de47ede6e85e653361c75952161bec67303c70ae5bc1882e4786a53d5c"},{"questionKey":"2fb8d2be-46a4-435c-9cfd-d6c9f416300b/2daa6ddf-859f-4899-a104-5f8323a1e4c8","questionRevision":"5a8cdfae5fa85bc3a2de01e747409f07c2a08557d658d782bf8739ab67810b4a"}],"revision":"b69beb00cd3a2dbada9626efdb42cebbdb7bd75a75b1b3dea9aaf56fc26efa91"},{"bankUid":"73c3ae5c-d627-4ece-b096-ee04309e9ea3","contentManifest":{"contentDigest":"e52ad725d8b56a2b36a1f90c4692e4d33ff8e317abe30566c88916788fd87af5","kind":"public_static","staticRef":"banks/v2/215-helicopter.e52ad725d8b56a2b36a1f90c4692e4d33ff8e317abe30566c88916788fd87af5.json"},"metadata":{"questionCount":29,"title":"Helicopter","visibility":"public"},"publicContentReference":{"chunkCount":1,"contentDigest":"e52ad725d8b56a2b36a1f90c4692e4d33ff8e317abe30566c88916788fd87af5","manifestDigest":"04136e6eb1256cc04ae7c779ff2639e5221c31e2bb1270844bcd11c5f55ffc9f","totalBytes":22986},"questionsrefs":[{"questionKey":"73c3ae5c-d627-4ece-b096-ee04309e9ea3/590ee667-8be4-4ef4-9779-cfae62c98f3d","questionRevision":"78d3fe90e39443b0cc034a66ff0153757a1838fa955873946d45df3cfe434a1c"},{"questionKey":"73c3ae5c-d627-4ece-b096-ee04309e9ea3/c26b7645-596b-4ad5-a4bf-dbc069c82a25","questionRevision":"e0e8b7dce8e4ec0348cac6e435f43bbf5a4f368e3757d821184b948ce13d7a22"},{"questionKey":"73c3ae5c-d627-4ece-b096-ee04309e9ea3/8f128da3-e8ac-47e5-b5d2-521337f109fd","questionRevision":"66959002d8ccc6ccd66dfc4f10b924e28f4e88decfa4043182e8e500e6b97c97"},{"questionKey":"73c3ae5c-d627-4ece-b096-ee04309e9ea3/4be46b5d-e153-4e0c-9852-14e02709cb14","questionRevision":"abb472191743ff8e978a552635a042feff2a6e32126b9ab3e3bbd06d81401bce"},{"questionKey":"73c3ae5c-d627-4ece-b096-ee04309e9ea3/7e831984-3549-4797-927f-066b6b2d5b8c","questionRevision":"8ae193e2817eda6d3506ee81a42d90df07b56e2582bf030ae914fb4a4c42bf58"},{"questionKey":"73c3ae5c-d627-4ece-b096-ee04309e9ea3/ca59031e-52f7-485e-bfef-aa51ccbcb9bb","questionRevision":"1d4ca1fb2ac53e69bb9cdedeacf2605dc7bd95fc5a6f7b87035bfc0479f6fd9f"},{"questionKey":"73c3ae5c-d627-4ece-b096-ee04309e9ea3/6a962b74-f83f-48da-a601-4f01c9b9ea5b","questionRevision":"4e987ee4e7c97059b04c85d4c4658102c4e9b7c702ba61aa76d3ade8759b2897"},{"questionKey":"73c3ae5c-d627-4ece-b096-ee04309e9ea3/de61dbc9-1318-474f-8eea-455bae22fe02","questionRevision":"522a1bcc2702871a45d3e1ab87a857b4cc64cf4a928133800f40e39bef65e2a8"},{"questionKey":"73c3ae5c-d627-4ece-b096-ee04309e9ea3/16c2c843-f206-4bad-b77f-baf5ffa430dc","questionRevision":"3ad86c1cfd8d7c02c76e4ac9f8cabef7b332c7092ecb59a85ca1d681d2fc49c5"},{"questionKey":"73c3ae5c-d627-4ece-b096-ee04309e9ea3/d62ff69d-8cae-4922-ac11-4f97c1c1333c","questionRevision":"d5b5f041b297903a9bf350b1aadd17e2075ee0479315c9cdd7c6104084c4aed9"},{"questionKey":"73c3ae5c-d627-4ece-b096-ee04309e9ea3/fe8ac55d-4919-49c2-8462-eccb1db03355","questionRevision":"50cecec80207763e9420834fefcf5e7be776c9867ba86aa71251a68059a61582"},{"questionKey":"73c3ae5c-d627-4ece-b096-ee04309e9ea3/c3549f34-67e5-4892-929b-27f365cfef09","questionRevision":"c38dfc37db4552e21f7c69053392d3c7c915a0715ecd1144fd8d61cace8643aa"},{"questionKey":"73c3ae5c-d627-4ece-b096-ee04309e9ea3/c9a017dd-b930-4076-a111-3345579b3fb6","questionRevision":"d6e08db9530d1554bd22e2fc449aeafbaa9faa1dc36780489112325d07e8a27d"},{"questionKey":"73c3ae5c-d627-4ece-b096-ee04309e9ea3/c5149541-c232-4d60-9276-345dc1deceee","questionRevision":"877591030d3aca2aa37a442b64607913a1499ab73668be42b93a9506c2420c54"},{"questionKey":"73c3ae5c-d627-4ece-b096-ee04309e9ea3/d7d940a3-9371-4fcd-8369-575d982c5f95","questionRevision":"07e6ae6a0fa31a926ec9bcc5edf1ae8d4d7e0ec5a29b4528d7ac18f8f3e81f53"},{"questionKey":"73c3ae5c-d627-4ece-b096-ee04309e9ea3/d21d4d91-3d4f-428e-aee6-36fbaa7c1910","questionRevision":"282fd833159bf2ecbef12cad777c6565edb18fff68a102e1f58bd69cb8624b2f"},{"questionKey":"73c3ae5c-d627-4ece-b096-ee04309e9ea3/670b6efc-19b1-4ddb-9cd3-f2a7605d92e2","questionRevision":"48c7f9d50095e2bbf06afede62e0ac7d780181bc5a2588573077234c711c1aff"},{"questionKey":"73c3ae5c-d627-4ece-b096-ee04309e9ea3/beb0efe9-f488-4f21-84d9-731756986757","questionRevision":"b7ce591f7e8361af43f147cd369d7c4a308d5ce4ebb09c01bcc69e4cf0ae520e"},{"questionKey":"73c3ae5c-d627-4ece-b096-ee04309e9ea3/8431c2ec-2df6-4591-8139-0c49e3e93478","questionRevision":"f2adaca42905c8bdd5c4124978c95ef3f6f742cd5801ed3418ff125e843b67ef"},{"questionKey":"73c3ae5c-d627-4ece-b096-ee04309e9ea3/d2b14cd0-f6ef-4c88-80f3-0fe245abc257","questionRevision":"96f2b6332cafe510a5b65d4461c6b3aa5e058b716cd44467c3a12859a884e75a"},{"questionKey":"73c3ae5c-d627-4ece-b096-ee04309e9ea3/8e0ccffc-c1d1-438c-82eb-6e1116e49f79","questionRevision":"b3921dd2f51d767ec990e8e81dbdfdb4b0663db5acb35ab1e0610b323025d17e"},{"questionKey":"73c3ae5c-d627-4ece-b096-ee04309e9ea3/90f5a9cc-b6ca-47a2-b9be-0edbef2a3448","questionRevision":"822390c2b39194c280baf624165ac426c08aa0ed1a1275caf780d2bc736828dc"},{"questionKey":"73c3ae5c-d627-4ece-b096-ee04309e9ea3/b5572a35-3373-4502-aa16-be5192934a4e","questionRevision":"e0a6e48d5a42e39db09af008023bf052274c43faf03b801e71d5c9ba26ae108e"},{"questionKey":"73c3ae5c-d627-4ece-b096-ee04309e9ea3/e7aaae07-72e8-4c21-85fc-617ca6b79ed9","questionRevision":"c398270856b9b06c18b99bc2397b7219fd9870f3cacbdc4fcc0adb6320a8033b"},{"questionKey":"73c3ae5c-d627-4ece-b096-ee04309e9ea3/e9db20d9-a400-4023-b94d-85af63b53f00","questionRevision":"30c8d53063a31d44dee7c034f2b6427e2a5e79d618f791fe1f9fe01efab89091"},{"questionKey":"73c3ae5c-d627-4ece-b096-ee04309e9ea3/c3d7e505-d4b5-4963-9dac-82b33fefa519","questionRevision":"b6172e0f70e1d7c778c638870d90723e4abe832822b36c1e94b40f6cbc05602c"},{"questionKey":"73c3ae5c-d627-4ece-b096-ee04309e9ea3/6d12fec6-9240-42e1-88f6-bc06cb6e303f","questionRevision":"a43886ee4ca6635a17ffac94967e81d295e96a82664d6d9503c173786ad63d7b"},{"questionKey":"73c3ae5c-d627-4ece-b096-ee04309e9ea3/f9c92974-b0fc-4b29-a286-c778d5e88561","questionRevision":"cc1f1091e28b1816a14a7a0e70a48213d0a9f60274014dd5990ca98ec1295136"},{"questionKey":"73c3ae5c-d627-4ece-b096-ee04309e9ea3/66cdfa9b-8d3d-420f-a2f7-0524170d287c","questionRevision":"165b40b6403daaecfc3b857261a553df93693a81e1cad7586a5f2b63aac60f86"}],"revision":"e52ad725d8b56a2b36a1f90c4692e4d33ff8e317abe30566c88916788fd87af5"},{"bankUid":"35a68cb2-b871-4d37-9447-190c396eaf99","contentManifest":{"contentDigest":"6ce382b1d2fbcdcc548ec265e4dbdf0de661c262b4473d710718dcc18fa763ba","kind":"public_static","staticRef":"banks/v2/general.6ce382b1d2fbcdcc548ec265e4dbdf0de661c262b4473d710718dcc18fa763ba.json"},"metadata":{"questionCount":1139,"title":"General Question Banks","visibility":"public"},"publicContentReference":{"chunkCount":34,"contentDigest":"6ce382b1d2fbcdcc548ec265e4dbdf0de661c262b4473d710718dcc18fa763ba","manifestDigest":"636444ed465f53d699fe9f8debdad70c95c94db43d1d81a5a4ef28df80e91a95","totalBytes":17739534},"questionsrefs":[{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/53f05bb0-b4b3-4175-87b2-277850215481","questionRevision":"d2dcdc48d867adb6f0ebb71b5c5d03c1a673d40a2076969a1180ab355c9536fe"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/a822fabd-5a5b-418f-8b88-5bacfcdbb411","questionRevision":"43b18c81fc82ae0827cf4ec9fe29b70354f9fe1819de4afc48d08f57047c8f4b"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/b9b24753-f3bb-4f04-aa38-63c86b2507fa","questionRevision":"f8c3c448f6834854654d9b3f62d06561ce8ab0a69d81c99980b3ac8f9261e4c8"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/5bac1fc3-2276-4861-9da8-48032ce8fc63","questionRevision":"de4a0a77700f33de88e5235ec203dc53067e4cf941bfe27544c4bb5b0747fc93"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/10348936-a6a7-4f38-970f-ec9bf00604ed","questionRevision":"c0eec37afc8984081a388b7c810b01ca3b101875318d17bd112669311d3bda70"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/5ce7c5d4-fa29-46a2-b2c1-a09eac2b2abb","questionRevision":"af472df8c7e4d485b1427724a1c689a13b34c1dce395585eb63f59b631bc0fa4"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/adc68ae9-7046-46e6-82ba-c5b8a0a767da","questionRevision":"e0375d2d55d64b9ec1d38539f409438b4b7b3340d622570cacca047f38669e0d"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/26a04dc1-7bd4-4c28-a4eb-2c82fb11e47b","questionRevision":"a65e85c25b90c7b6444571c6674e0d80c94e5f08128d8f0a51c9b09e033171fe"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/eadbe4af-3b05-4553-87c4-909fac844315","questionRevision":"a8abcfb9f44ec7333b81fd48f395ad219ef014b11f4732ceeb93b025be8ef272"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/f5880dde-59fc-417c-9e50-14bbb8ffa3cf","questionRevision":"0d985f6684fef395e651e06a681961075c6aa83cadda232d652366b26403e3b1"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/1fa81fcb-c75f-489b-b3bf-43d21c7d4020","questionRevision":"1c6cff6e5e4a47b079e6acdd5ce5124283f29528d6d7aad58d64111c95e6dd24"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/79513641-b12e-42ff-a348-878aa09a6222","questionRevision":"90a0ec02fec70ede06538de7827eab5a242876d829144706f76128c431b25770"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/58b674d1-8a38-4e34-baf9-7036441c51b6","questionRevision":"939deeb5ce4af8abf3f83c4fd6cce2cb067afcde6d2d54be10cbe83dead9c2e0"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/b37f9d0d-686e-4de0-a878-57b4c9615809","questionRevision":"731f37e25f0de2742194c43ef02d85c1339e2c148cf90c96e33dd13fe0aab77b"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/d4a1de00-9bc5-445c-9ce0-5dfe03506035","questionRevision":"555136420e81b9c6a3b48125a1ab8ee13b66d7933a34ab4a3d86e3efac754052"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/45bc2242-3e09-4db4-82ba-8de9560c383c","questionRevision":"74223445831e5d328a6e5d547f1b3108edd2da7fddba26253c6f476619a70d80"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/ebe45a34-9d20-4f1e-9938-3c1d09d23962","questionRevision":"59a7db75a36be823be0981b837e842f3c94d705ea7a9cc4e2a871bcdce6e3a7c"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/3ba72a83-92c5-4d28-835d-6e00af4f0121","questionRevision":"6d44d38f14cca29f7a26dc2b1a9c57ee6f568ee5b9acfd1978b3981469bb2d5e"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/61a39fa3-e45f-4d8c-9143-f0cd3ed666e8","questionRevision":"8e21090ba7678608c58c6e7dc82257ab4aa9c009f663b446a26a6218d66ecc12"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/90cd57f9-fcc4-4378-b057-5fe535e4f9b2","questionRevision":"1c6083edf4d2934bf02df1e894fdb243a92e9293ff686c01fa5ccbc90d872ac4"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/120a7b7e-91b4-4a03-b279-f5d5f7cb6b85","questionRevision":"48f14c5fda721f5fb3565385cb428133be70a5f0f77804d38efe4c9078e67dfc"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/16544b54-1dd3-496f-9753-0e94b53bf47e","questionRevision":"6171add513f298ca6ef742350a29a82817711cee22696e4f0cd27add157e2df6"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/d1df2bc2-ad62-416a-af0a-520ccc0374f5","questionRevision":"b524266165ac6ac18d0f0d7e9fe4e9b31cc7f088a6f61d6631ca55559804125f"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/0378f5fd-cfdd-4559-b657-ead8924490a6","questionRevision":"981777783b3654ec86e1ca540f1da9aace5c5edb0dd8fd1d5b7d61fa60a7df22"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/dd7999e7-d3d5-4bec-81cb-4ce30c1510d2","questionRevision":"63904e6ff397ec3b3f75458d9610fac68fc7c481e84de9d96e1a3f71cbcdfe12"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/afaf3bad-5c1f-4448-96de-37296b0ff133","questionRevision":"d3d746864d93ca93a81a100971be3368426020703413ca5141801574e9c51527"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/63adea8a-6679-4529-ab33-85be2e13762d","questionRevision":"e5427f71be05af510b3bc1f9b896c6c1bbcd5e16d3079e3048e247317dfab045"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/fe3ada5d-0a16-4198-a4a6-653a60369e1c","questionRevision":"2db38c9969899cbd0c5458a9ec135666fd29df8eed212efa079e0e564794427d"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/a1aa38be-b7b8-42be-934d-d8f0748cd9a7","questionRevision":"7df90d10aaa54dd9ae1ab60f643e9aa3a0aa8677e22d09dcf44ff98960ed549d"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/2afc06b5-2e11-44bb-92bc-f76bdcf90676","questionRevision":"756c4dbc56ada62c41ab713173bc91729465d25d975599e9175801399424dc57"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/4ed1ff05-87a0-4751-8761-fa3d05c22d47","questionRevision":"17aec0527968567c69fef3b1e0f1537595142551b92ac23c3fc2f7c35ff13697"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/1314e9b6-7fa1-4197-ae55-de611d0e44c2","questionRevision":"3df0c0631c84ee9480400ae12aba8d79c6075fb8bc98220e2441da5bbb2fcb58"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/be7d9846-df64-463f-b479-6f1ab97c0295","questionRevision":"90a6f8b590895274f4cfd3500bb716067525f10fc3e1f049a361e284331901e3"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/f5e76044-2045-4c96-8e7c-f1f60ca5257c","questionRevision":"f6afb2cafc4a3cdb321881a2738ca67900f2bf5f1e50df699614399747c26ecb"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/cc618b60-5f41-44d0-92a9-dcc79a64837b","questionRevision":"f11473a4208efca782a2449001fe28f9a74a86a151a2e701d51591d2a2095dc3"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/6461ca52-03e3-4ea9-a6e5-1cf4fef210bc","questionRevision":"8433138172dc08ea91ac8d3afe838093896f1ed476e3ae369bd2616e228c5981"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/53b91d18-bd49-44a3-8aa1-39a40bb55271","questionRevision":"299340da9f9f323c34847b9b57052147fe1032987ed708da9382f54ede97b9a2"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/f0fc13a2-c2a3-4bd4-9df8-bdc22ac1b20d","questionRevision":"7cd13157a065ae5f165e8d25655b1023bd41bce610b85cc88678c471926e3c8d"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/05e1e106-70bc-4dd2-8210-a0055db21ac6","questionRevision":"0e0711d6af692b6c88990699957c51a11fcde1e11485871d6251cd8f69ec7c53"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/16346910-fe29-4010-98bd-67b4072f7c13","questionRevision":"58e49aa428b0997d6a2e9552c9bd2d0673abdea96f7dc5ff1b5151a418a8b295"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/4e6ceb6b-9d25-4ae6-a462-805a9a245cec","questionRevision":"4224c1cd0ff9b68d4233d2d82d0528d34b05fd1cf50986b2c559f1cca59a73c1"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/19aabc20-303a-4f3b-884c-f7a4988aad84","questionRevision":"932d2ae8f3e73802f6d4607aff6a4cbf4f4e14fc83ca3434ac4d91cde34b147f"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/26d7605f-09b2-46bf-8523-fc4d4edcdb80","questionRevision":"b4674a835e983973c07bc6f487db15fd3838d8aab5d6f3bde191241e6e282e0b"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/85832039-87bd-4bfc-b89e-7b880780fd37","questionRevision":"6397b85f4fc439f7d284384daab43972e3175df3dbc41f58ff07a3a7b59ac771"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/d9b49565-2ce2-4347-828c-ec314770c3df","questionRevision":"e8f6adc4d65e9855c1f5618ca9a79c3f13e8e839661999521cad4b89984c7478"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/444c7152-7145-4f57-8b6f-6f5cc39a8520","questionRevision":"c39bd1124de1b52ba02e36d1f9b9cf816f21f8f3901596ebf1183017186a3d75"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/db7aba48-0a8a-4a66-9a0b-d5853b504d3a","questionRevision":"ee99c09142a8f45959f1423cf95cbc8d8b73ee5b4b2b601614b0f573ac9b0827"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/27eb9012-e320-4867-883b-c15d46b8c686","questionRevision":"14ebd6f82d26cba0c624b5ab4e835080d0846da6543fd13d5fb74097c5adc234"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/79c71fa4-cd98-4fa9-9ac3-ae02fa2b520f","questionRevision":"65e3659a7881e92ec1c864e3b9be4900ac52af99c97678bb4b771a306c21ebfc"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/f98b3d54-f09c-4294-b9e4-b7ddf150230b","questionRevision":"2606e8dc965d9ff4b307d60e5eccd551efc19075d2f8435dfac6df4a2cc50b21"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/d5dc113a-2a2d-41cc-905e-211e69369ce2","questionRevision":"bff262cb3d73a5a4548fd8675042d22cc92b4794a195c38553d676266f1c06b9"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/f20f2723-b23f-49f9-9e7d-108d864d663c","questionRevision":"800e24e6788abd0238d4132c888e7528ec7ec2d0abdee2f7b6c00b0e2b736b07"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/44125ff4-1408-4caf-be2c-0ede3a578bf2","questionRevision":"5cb632f236fa4838cf32fb1fe4639bb52bf65eb490a2b730575746bb9a82581d"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/714fd3db-78d5-4460-8588-9bba27b25b52","questionRevision":"87c80ab1dc19c2786d917122ffa102faf526b8c34b52b318386176482c6eba0e"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/34561a86-30bb-4e5d-a134-0c86292bcde6","questionRevision":"3792d1b1bfa80ac53ab85598f2afad33d4bdf9f30e09f4a6dc9a509adc02baf3"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/dc90dafb-4cdd-4f9e-ac82-39e11e30cf0c","questionRevision":"c17b71bde4979e0e5e95e03f3f0c5cc4ba705598bf88a69b688ad9df7faf2360"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/a2450ba8-47a1-4219-a962-d50bb7d77a38","questionRevision":"5697f39c2c33c5ce835371a7ab62bca63904678f5abc9c3212626de61ec41431"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/5acc4a38-81a8-4f54-a8f6-e8141edb3cb9","questionRevision":"72776e7eef21f77ff4c2cb9cd74ee656b2be43e7060e668620ad1f2c900ecdd6"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/3b3e9076-4347-4feb-8e39-a6abed5cc96a","questionRevision":"df29e4b08ac40c02244e00db32a48d75cc164e3c07ebea72d1f6ffb6b530c8d8"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/6362fc53-0e3a-4bab-b81f-652d3ac2f3d2","questionRevision":"94d580daccd2a0d47aa79cb876befca82464d7b2782ee4226b74733c5246e34a"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/c2cb2f52-1d3b-43d2-8555-f8ec66afc3a0","questionRevision":"16e044143cafa89a2a26739499aa9efc8ca17d4ce8e30d3348cde013f7430928"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/3c8c0782-7751-4f06-9486-67d4037d9526","questionRevision":"78b1af67ca2fd1fe5383d371477f9df3dfa977a33bf82151ea1e57494c6ef321"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/78669142-a082-4fa9-b729-9018c812a6ab","questionRevision":"38267a45b5e1193c5460ae82b7000e6c42d202239ca0c0210944600cf0880174"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/4f13cc80-84ca-48fb-897d-c514a838025b","questionRevision":"81d6e032ac5565cac1f054b533021a52d72d4d685e459f2daadf6f83861cdb21"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/ccbafd05-af70-41d0-b317-863ccffdb8d4","questionRevision":"af6c4608813afa1668c1f82f7e28b5bf65be29a460780a96f444c5b78f1897a5"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/dd7a773d-69ef-4cf6-869d-a97f06d3a75c","questionRevision":"888ae30375d97637d4ec6dd57b2b4f595b77f98dcdd8d096545d3c1ff0784dd1"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/a097292c-cb1e-4f2b-9d29-602b864ba802","questionRevision":"b64c046690490679c7522ba31dafb77f5b34f795ff510e259a44f2828f934ba8"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/d5fb8fe2-4196-40d1-8bcb-59ff2ab75ffd","questionRevision":"8cdf82f76fb4ae51cf2eea0691bf2eee124fb19598e9647ded8f12711b8b116d"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/3bf760f5-2e1e-417d-8372-4b8e3ca60967","questionRevision":"e65279009a20cd7a592cd543901cb82420d4d4d7f97af1386263a2b06253260d"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/8156f487-471a-4d4d-a896-5f3f0eeb7f81","questionRevision":"8f54b5a3dc9ca52a29c9470f0df336e64840b6c4297dcef2e20270e7954a3b56"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/0f98106f-bd17-4e66-880a-c0cf7766f831","questionRevision":"ad1c87bd13983e7bd9ba222a705156fc9668b5a46af6a3fc31e1026ec15b2aad"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/f708df89-d021-4a8b-868a-dbd549c9bf62","questionRevision":"36594cc14c431cfc6c762acbfe1012cc1c97479c5b0fa7d8e5a3396bd5323e49"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/add98d87-94df-4d32-989f-f9fa8f0f0b8b","questionRevision":"1d8ca79629db5a0309b17422bc720aea09de2833c49167cb7bf461ba1c0827aa"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/690534ca-9eee-4eb1-a340-6a464adb0230","questionRevision":"19828c96c837c479612ee007cbccf4918a838308808bc09c03ccc848380995e1"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/828055be-01c4-43b6-9eee-d05df1e0b30c","questionRevision":"baa5dd2a2684b235124107706585b6b27ae503cf81c99635784bb670e7701d02"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/a1ab11fe-5bea-4af6-8476-2ca3e32d7ff0","questionRevision":"bc7c9060b4e1c7fd2698c80de60e7fe65650f28b71d9c69ff5a764df5cf56e86"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/2d88d7b8-aa6d-4c17-a117-0924fb5f65aa","questionRevision":"291350c56cc0b717ed1ccfdf761dc931e2e6c79ed29f48e47700ab8c68c554ad"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/fdb22302-2a1f-4374-abdb-b4e224335f61","questionRevision":"4024887565547d2c0a9a77c8e04c62c92fcaff1dd38892bbf6c321f4a2b84a4c"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/a719d9af-3b9a-49b4-8556-3cc5eb70528d","questionRevision":"c0d68e1b96e07350b8f009dad8a8b75919375623c65cbf2fb93c108d62c201df"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/e80c7a97-c24c-4046-b65a-5daca424acc0","questionRevision":"d18d5ba0b6cb02c667de74665ad8369a06a972a3a0a74e22499c6e7ee8e7ea36"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/80976234-4968-4ae5-8f4b-45cd40ab45f9","questionRevision":"9b9f96095b1d5e44970cc76626b0f8b68478eb0f23a802a66210096f55c934de"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/622c5b30-14b8-4ae3-9cc3-45d39f131f4f","questionRevision":"883782adacddf7732db875d2f1c8e18b8bbddc48ff26c65d6c618285de3fb53c"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/e78c4824-ac47-473a-91b0-bc6944d7e3dc","questionRevision":"fce916d9548e7bd494906048482cd4e82b21b5016e377349c0d93c08fe1fad66"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/3e691c21-2db6-42ae-87da-8d209dd36391","questionRevision":"db36dfca50198f42894dddb8263b952835c4fe49e0dd506254077705cbc9a8ea"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/b2b8aa29-5c8d-4d90-b145-36c37d0630bd","questionRevision":"9e023b829e6543fbd6209bf52a86e840946b6005219f122debc38e3aa5dcedd2"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/60176868-9cc9-4544-82ca-d8318662008a","questionRevision":"a64455ea12fbfc915c105982cb633bf54a7a1d028b418b09dfa8eab21ee50dc9"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/52c6ca92-a369-48f4-b945-d730f81b441c","questionRevision":"746615e3f9d57739fa8d993e3a1fc626dc04856198dfde8ef1a741e79e453715"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/8d753b65-84da-4060-8884-43f68b054b52","questionRevision":"d1297c9c22d5a11409ba7c117bea6b8911b67939f9118f13a0941976402abdd6"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/8170dd0c-0957-4619-82ec-f171b6128cf3","questionRevision":"b4396977384973ed015a5a0d1b29f85c80e08896a87b9bd80fb7a41a829a45eb"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/c8bda376-3416-4879-95d5-08e09eb2bdea","questionRevision":"0bb17b6814238a38a076e917504c800603c2a94b4673b4da37f21fad5b106dc7"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/8d757d6b-5eb4-47dc-8421-ebc7b6bbed1d","questionRevision":"6c10681590bbc1d79dce10dcd436f6ef76037137005eb9ef4748c8519db95844"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/fbb21245-f475-47b5-893f-478f34195bd7","questionRevision":"af9006b4fda1907aa3620b7d6fa54daba8bcab42e2dffdfd3a6685ae88a1716d"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/9185d8a9-6747-4239-a6d3-15bf3d7a4d08","questionRevision":"e64934d7641469e15a3ae73a5f747453062568b98e522f5dae6b6e3d571f5629"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/78f45aa4-6e46-4d7f-8c38-91b88cf449bd","questionRevision":"40b324511950ec41f1c1f2e4ed0962568b3771f75b95d3367c774e35f181487e"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/8af9ee66-95a7-40f1-9ef5-bf12da15c78f","questionRevision":"2fc7d670e66ebce587567c5dbb6528277c744c5d372ab45f4fdc69b0ddd617dc"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/2edafa53-9e86-40ef-bc8e-e43a1b3962fe","questionRevision":"68331f69b44a5ab29f81b187c14025063e358a487a19f8d111cf95cde7cedabe"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/563e4d72-28dd-4ddc-be3f-c0cb8e017d4e","questionRevision":"af4b79e5f6d3065dd0177de4b1e4f5b37d637f86581463b67da8729da6f47cc3"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/b05ad947-6607-48a6-8506-0bcf85a25231","questionRevision":"4f1a93077b8bafd5860656d8eae419f800510d113d6544643652bfbde70782ff"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/172540c8-6ac3-48b8-aa18-b2ed2b95c61e","questionRevision":"4b3229aaecae6e3984b352788a35d1eb0c9159e699f4ae836f33b6038c1ee1a6"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/b41555ca-0039-48f5-b84d-5e68651a0dc4","questionRevision":"3aa52f62b29cf7fab7dd45089168c1351b5027b099e0c53f5672bf63068b40f3"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/4ae1815f-0407-43be-ad98-829a25367684","questionRevision":"bd78f6bbf19efe484a7b978c7be040158b9228eaab0f6df4b1793f26a3d9d068"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/df94f75a-9aeb-4ef5-8490-22bcff4d2d89","questionRevision":"5e8e8a0afe06625e7d6065b53f332e55e274d91bf506db6b92356333458bbc74"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/5da5cfd9-fb46-4523-a34b-305ad2105588","questionRevision":"15c47392011565b5545695de34bdd6234bd91b7972259a1dd9d1ee903205c169"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/9d86c81d-ceff-4ac7-94f4-c61e4a9d7fcc","questionRevision":"daaeb31dca3aa5e130122060893e260a933037c26594c83c10ad6d06f918a05a"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/8e29806b-9799-4d60-b5cb-f18774f965d8","questionRevision":"b7810d06e8ac5572afcf4f78fbff4be78cd199bb06b15dcac1f8954344cbd5b2"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/e9f25085-0dc1-4c7d-bc49-eee236287569","questionRevision":"6cbb5cc7d87e02165097f179ef20a862314a87b15f99ea979fa2374325a8aebc"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/4d162d4b-da56-4134-9b7e-87eb2a12ffdf","questionRevision":"c536e2937c2f7c7da8c5a6880fe7656d701fde6c3e534fe7623fb32e36c730e8"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/5d3fc9a6-0eda-4a88-a4ca-925b1bb32a5f","questionRevision":"89772616280dfcb2d9448b9c9311cdb996f55e1b94e9536187b1353dc7236a99"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/86000168-4147-4a19-b80c-b36a00ebe034","questionRevision":"d5c0a4a112134e371ad0333f5c850b4d1ec0d3a353c9f0bf9db83c27d4307433"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/6c4a2bc5-8e73-4f6c-9bab-9b08bb71af08","questionRevision":"15fc72d012d8ea0d5966337b0c56a7fe82d2216652340e9338dd1d6656db1c28"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/5c107b40-8361-407d-802c-0188332e36cb","questionRevision":"4c8384eaf3448dc4765f58753bb0862510437071ba4443024788bfa479360805"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/17dc7dad-ec91-4945-a9ca-34bb7d5045ce","questionRevision":"a1df0d6bbe12f7760cf6462aac0ba0aa6f3e8e523a2039cdd0dfdd8348c472b1"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/0759816f-55da-4a04-ae9c-48c53d0c5d7c","questionRevision":"abea534318adb7d2301139a2f3144587548f54fd27947bd2c345ada4940a5319"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/819c6168-17df-45fa-ac60-9fef2e4a8fde","questionRevision":"b72e13f7fed32978bc6a882c59e10c635d0f22e89e8ccfeef1952f88d60a9121"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/6129d786-0c87-4d28-a50a-1bacf0934884","questionRevision":"134a42706e1888d8ddbc8e7793bf34e2d662fdda454d894a6899ad0597315bb1"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/ff4c5cb5-de2a-4700-bfbb-393ca7c7f029","questionRevision":"1d630f46ff4994d3c37420682b1c3b6954e6a0793e886a28b5599bd57a19f4e4"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/435c9c18-e4db-4068-93cc-a1a7f8b236fe","questionRevision":"3d31bef385f83d2ac475fcc4c4624f159a24c63cb93164b055a3eb19f9f92b35"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/0ef69534-17ef-4ecb-8d3b-8cdb21d73192","questionRevision":"7f59ebdf77586956ecbda3bdc40891badf736694fb4b5bab3b50b60da78f7026"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/a4bea235-7adb-4bf3-b3e9-c5f1d20f12f3","questionRevision":"3d67f57a699670fb0e4cd155824e1b8ef2706cb7ba31900e480f68a42bd4c30c"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/2db0b46a-0cd9-467b-bce4-046432a5b2a6","questionRevision":"329d85356200e89b074aad2be6f3a3748a6ab735561ffb2bc8442c11e04a083f"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/fde63aa4-d315-4b40-96d0-cf439b8e9d82","questionRevision":"e9c2d36fc9821aef03f4e4c535762daac1626d148b18c98c269fe335859f36e8"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/0eede951-eb26-4310-a6f5-d44b04a2f20c","questionRevision":"3a5ea5603a7f4504a4b37524b8e2ca4ddc22441d7d7334805e02465ef7ce34e9"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/a5941a91-7937-4c88-9641-ec2127fe4fe7","questionRevision":"7a6020e99422a9e8cd4850e4525067d3363393f507d12bd25d08f54a71f45dbb"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/9812aecd-dc63-49a1-a125-3360d642f9ac","questionRevision":"53ce499045609551b92a919c4521c8980be78a1f0d22755fcbc771bdea355d6c"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/12ce563a-e1e6-47f9-8ac9-98cbd0cfa634","questionRevision":"7a4d578110a821846e605662141c0a180b2444fb4bc0fb0cf7cb3554193392df"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/a748bbe0-a73e-4a36-aa00-90b782c692f9","questionRevision":"11d3ac781e26efa7cf5dce36315ba78d12b20e39a925664051f34f2c6aeb4b51"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/14c13e84-40d8-4f3f-9790-f6f562014425","questionRevision":"d99cb61f3b7daecb0b8a24127297c5253a76a97c0bcc6282263b317f35234d48"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/bc0543ac-b5eb-4eab-9cef-cb8a9c129969","questionRevision":"275c2cf788fb31996a0cf63a33e22e0bafb85449a26959465b80e8ed7f6f94d4"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/f499a38b-9a21-4c10-b399-8b6a6f4b1401","questionRevision":"f0efe3269d5a95fbb6c0e5d6e9828825e7ed5b1268773a42d4979a8e17355af5"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/5dad7349-275e-4650-98e9-0c4b8f5a77ab","questionRevision":"908335f1d0376f6b279407422d1f0ac0c32e3cbd9127ee35a7ce95f8d272b613"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/13f7ca51-eaa7-43d2-8f91-6457cd99dd03","questionRevision":"fc718b749cd4e576be37ed67e88b95fbac2499ed740d87b44a62d969a14a5a6c"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/74211d1d-e148-4497-9763-688794d53059","questionRevision":"9ec5cdfc0fec4d878074fed4b3c2d00dc636427734075f37a938a1791a350575"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/6bb2975f-3acd-40aa-9520-6c2b61e1fbcd","questionRevision":"a065f2e69abf3454fa2f86d6b790536fc073b9304bf0b88bea709732c673b7db"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/8434a970-5597-4a77-a44d-2e88fffa1eb1","questionRevision":"56df97af5d8e8e17b8cd177d8f343dc38c7246a113fc3a44c123dae60cd0989b"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/95fa92fd-d7dd-449c-8d91-7fb74b58534a","questionRevision":"6edcc44dd4ae0f9b06600c15ef68d80c04390c719db6b4eab773905290dc5f29"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/db1edce7-51fe-4df5-9964-3fd99c5b90c7","questionRevision":"3008d0e71d74a629ea890529632420f43e338bf4b9b0da102a3f342b50a7bfd9"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/1408e43c-9c3f-43a5-8095-1e2e32662ece","questionRevision":"90b92baec6eb4215cc44df70b363c10de84558a2c044f813f195f6fe38c902a0"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/0faf967d-ffff-47bb-af64-742006a9ddbf","questionRevision":"64c8a2f57894919229126dcf434f10b6a0850b3a7f028ce280c175649946fe87"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/88495737-9581-4dfa-8eb6-4f12d0f98a34","questionRevision":"95d85150e3f944c9dad82c83b5c3f510bb26f6884cf4db7f11fb907596547596"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/f984946c-3ada-4dbf-bd78-e80cee5713c8","questionRevision":"bece7ed2cc9abad01c9065a457dc555197c6656d9666e889caaaf1341486a38b"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/72af26ab-8a13-4c21-b782-0f911e222a32","questionRevision":"6ef122c47a3ed15202e766bb0784bb2426ba8c7daf56aa4489e865c87656783f"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/30e27530-40c7-4082-aba3-c26953725222","questionRevision":"e620578504546779704c97bde89dc7e112e891fba38a7c3fcb1488f0f3d2c503"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/34da11ef-32b9-44a2-9505-60320b4d4977","questionRevision":"e7209fae3ab9ba2601d9a3a0927557050115ac5ecdc9f87b6e744126fc108ef4"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/03957e95-3864-49f7-ae13-3231e42b98e4","questionRevision":"a2e9122169ede9714ef55b3232c2213392771d4d1fa8cd4d055f1bb253a161b8"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/8ed5fa87-1f3b-4f85-ab90-50e786a931d3","questionRevision":"587f75a21ab9473a1d22b829c78ba68609d209362e0d743739a0b7248cdf0af7"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/ce14271f-0411-4ae3-a26f-83ad5f907094","questionRevision":"b2987669d78b23d7638d2339418eab5a2735f3d44b898ab03e4199456b548e8f"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/61232c53-45a1-4dfe-a9b5-06faa9353fb4","questionRevision":"9c0e0dff0f16e46e807b8ec3de0a5cedca6bb87ec85b54bef382e9d546065b9d"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/71e83d8a-b15f-4e8c-9215-637971aa840e","questionRevision":"bf3a86591067440cb50415bb324d9b6e993a75e32c8499ba2a7295d54bcfee2c"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/47b93146-ba25-4647-9407-95a89cf3255b","questionRevision":"07ec38708016d4e071ebec08c515f0a3f0be58af25551baacb7938b6ca61ea02"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/235fa5fc-87d3-4053-a9af-a4d7d017615a","questionRevision":"3df615989cb4e832c64e1f3615428fa9e61ef4b0b203a9f936dbce0738a0a48b"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/8333129b-508a-4efc-9047-bf6cd0c72d27","questionRevision":"0e912c27fbf7568c6f9d9c6f06f97ed87d6855d0a0cebf38e92f67cda0e19f5a"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/43c12ded-0ed1-4286-b229-c0cb5ca44b98","questionRevision":"746530f5c4017874acd9dbb1aaafdb2027ecc902c8f23fbfbefc9b4a4d4f3083"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/793b83d0-88c3-468c-b20d-c5e3e67b5cd2","questionRevision":"20b933c56e935ccb2558b05566efa5444841a21a8b4361421fad12b79a4eaf3d"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/8fbd7e28-8f06-420c-962f-7b794f5b2d47","questionRevision":"9f7713d742a7791597bf6a65afc731bbc9a7c051cb3b4049a07e180977dea6ef"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/033a7d05-ab0f-43da-815d-1f766101a295","questionRevision":"50dbf80c7c1cea345608a2003ba3770b662806f8d264554bd88e12b64bd8e326"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/acc91b9c-aa2f-4ed2-b3da-b0a67c7c546a","questionRevision":"1a83f4f52b2bf0f188c11e03d1cbb6a065e9b3e64b8f1956a3d8f69bbb4b256d"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/110f683b-089f-4f71-8282-fbc7b947ce4a","questionRevision":"54a55613e4c50a3dea36e848a488192df48aeb0002c01b1906cd5eec06dd14ee"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/134241cb-4982-45dd-a9f8-02a18f60efc1","questionRevision":"acfaf377ff6c2e2f1306b4bb9116a28a0e2fbe4bee4ae245de4279e315613043"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/e9824a6e-52f6-4c33-8a93-efb58ea22fdf","questionRevision":"51d095ce37c84d43365c89c42f47cf746aa6d4919335fbec0e3156c5c0b51202"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/8cd33fec-381c-4ed8-b3cf-577c6a571cd3","questionRevision":"7206deab4ab0be7f11c6c0915060895f71f056556f815fb27dc3d11703f88f7d"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/8ad69b04-fef0-4d0d-a9e2-02d661def6a3","questionRevision":"1e0d8812c3b9dfb19bc1f257d4586af8d26265435141218ff3ece49db3517817"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/4653a208-325f-479c-b363-3afc1395fe46","questionRevision":"57981ffb5fd62ad8b467bf85b1de78beab6a42cf95c2975461b424ecbe01d7ba"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/6f82bb95-0b52-4941-b2b9-8fc0b818cb56","questionRevision":"255786ab3cf0d5811da75442eb630c28e73622cf255c8bda302b18124df7a1e0"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/377056d3-51a1-45f8-ae10-77b1848704e8","questionRevision":"6e50762538de7ab1254d6d980172911a1ce55466bcaf255eec6452c40203f487"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/6834dbf1-106c-4e10-9282-2e940638e959","questionRevision":"a797af333b42db5a15ca327e200492bf2484e6b781ec04a7b0da106de064981b"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/9b789524-e2eb-414e-9f8a-1e8a1acb3c29","questionRevision":"894ed6a16065879165259e1f4a99d1019437e00db3bf46ad9d6cc3a41b9223ea"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/380c7a69-711b-45a8-9b3a-8a417798e21f","questionRevision":"430d06480d97eea3b3980b5138cf8cd7ec7ff4c355284608558fc183cd25054f"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/fe67027f-074a-45d5-91f5-f7d05cf47877","questionRevision":"5e22854487ad41241e9244f50e2e7bd5421e7ec0a885b18b17a72bc81eb9807d"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/9bb7198d-978e-456c-b245-392392b626bf","questionRevision":"c7d55dd7386b2cb3904c7fd7be7cdb3edd9826c5375a1cc90967148609bd2f10"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/d7b57b62-b41b-4b57-843c-605f10db9ecd","questionRevision":"09a575bdcc8818d225bba7adf4077cba54db59ec7388ea0f3ba89f54da16ed74"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/cbf8c14f-d340-4142-a76d-723b5c0c6bd0","questionRevision":"6f95f5bc27df223c802274e2cc9c0212b2992d76d713f8814e6f80d35ac58e4e"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/21b3c64c-4757-4435-be0b-28822e8cde77","questionRevision":"2b260fb865542d03d2a9bc64c5ca9896c58bb5d91bae3957318e52b159b9cf44"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/2caf9a22-68d6-40be-a9b1-55f65c950f4a","questionRevision":"3232171bde31f31305cd21d2c1ad05497df68c704b4b213565df4fa24a4c09e0"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/e43feaa5-fe98-492f-a410-5367b8271dad","questionRevision":"7d6ac75102c24300142a1d0492aaf106a67e7b83a5a94297decfb5c1f74fa8df"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/d43824d1-7deb-4f98-b7cc-5fce77826aa6","questionRevision":"8799a6a837310f1a7e8b805f574e9d8046e5786f350484badb5c0ad81f48d283"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/182b0c2c-21ca-4239-9a44-94705f9e3e52","questionRevision":"34ecbd3e7539c750ae70cc856fc2be9725a50a2ac94cff1865310d469765cc5c"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/2254ec65-b73e-451d-9852-8903be35e6fb","questionRevision":"fe3ed374ea49accb7527135b896fe3b6f9c3d1d858fbfc1507a9873777e25171"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/116531aa-1250-4bbc-9b06-aa0a7607c604","questionRevision":"9862fdaa77b381fe1b594d57836411da1a72b6fc84964921abbb3fbea1903a1e"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/88bc17f7-847e-4d0a-8392-7bd9dd89508f","questionRevision":"319f72110480618114bfd693b98e5240681c3bc41965881d08bcc64fe1b2146b"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/9fef4d40-c174-4b99-bfe0-7f825fa27d59","questionRevision":"3a30c0e00a477a6ff526bbde94820ee92ca7689d0b0458caae43b5966cf188fc"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/2c03077c-518f-465b-b15d-778241b36738","questionRevision":"b4cf5bbd0c62ced81a15b960e2f63603e5b84d2884805c96ff429622dda6f85a"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/6557da7d-88e7-41d4-94ac-f71ca68e4254","questionRevision":"3323d59ff75973882c7714af672e2b59c8ee8adb23008063d073340342da22c5"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/1c2d4688-6566-4dc9-b38f-2b45d021f472","questionRevision":"d7f2e82b62f0b98fdacb225f8e9236fcafd48b71d8a668790cd459f1d954d999"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/fccb21fc-1d77-46ee-b222-6b0b40ee46b1","questionRevision":"8be798127b7ae00cebbd28c88cdb160acaa92178fb37c8076c6e993fbe8fe577"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/7dcf5b6c-5015-4b61-b386-2ac1b7a101ae","questionRevision":"d6743af9813bcdb4d92d631998cac54959c1669c90597d8077f4f2238bf3920c"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/8afad838-52bf-4b97-a093-efd322d333c3","questionRevision":"d9a63ed7f88efa6431421bd590291ca7b20ed242e90e1230a118bc40f7c1469e"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/d6f2fffe-9db0-41dd-b485-008ee1aef9aa","questionRevision":"8a81d2354c6400f4a0d243907d578ee145ea83ab562e08b3709e73fc3bc5f297"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/9169ac44-7a78-415f-914b-5fcfa3d1eeeb","questionRevision":"d76ab6040dbc7b6aa79bb94331d962c5f14f526de9d3152594100df72b51b96a"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/5927e5b9-e61f-4d42-986e-7bb6c832f168","questionRevision":"893687a5a58683256782015b79d4f288db2375c6ad1ce8bbe56f256da2f43dea"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/ca0a81ee-0204-4b88-89bf-3f016091ca18","questionRevision":"dfde8528c5421a70cbadcbe66e3f1e76c17e38e59d0aeb6a9ba72b488cb3950e"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/0de6a108-4384-4c54-99b6-b8658d176e1c","questionRevision":"43dfaa9c8a4fc3dea7611fcb869e879a974eba9acea94714f67a7017d221a007"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/8dc17a24-d1f0-4989-a69c-6d19770b35d8","questionRevision":"14394c755fc7da84f5a5fd7d6322efb1ee05be75d091e57c8e313d11d41d323f"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/e80ba8cd-f4c2-41b9-88a6-15719ee25bcb","questionRevision":"a89cbbb083b324ae54cf2ad38d1fe22ed32abb23bbd5ab50e85911a9365be75d"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/79724001-079a-4350-9144-f14525dd409e","questionRevision":"446e39755ef0350b0a4caf5285e5300c75164e47afd184b53f69214dcd7a9701"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/dac83913-20f4-4ffd-bb07-8235843c3fb6","questionRevision":"53dfe6de25a1a0dc0b412d3f3d2cf25ff04c29cd0578064bc42e705dffad9d4d"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/4547496b-a7b3-43eb-9e63-1daae7be797c","questionRevision":"e5744c079c68a111f6c60aa0a9b42c7a7cd48e2af03ad88c12a2e6c81eec7a0f"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/9702b4fc-2363-4fed-bac3-3d56c4164d24","questionRevision":"8c12e7e859c6e2aa29b9064da46ac83a8f341fa601d1f9d7a525eb567ac216ce"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/aecedd5e-7bee-428f-8265-8dbe439edc50","questionRevision":"1cc283b83f0b3f23296e2b11831d311cb8f3a4862dc5d7cb80d4d76970d8fe59"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/5749df0e-fd1e-4428-93e9-b891ee818adc","questionRevision":"a40c2b17acf82a215799f930dd9f02afdb5cd50c50b6de4248cd8da82aa5e030"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/36d0243d-c0c0-46ab-98c8-cb301c27c418","questionRevision":"377cf3670083b716c8aeb5b2d67607aac78371bceb26de39ce8a74b21682db39"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/e44475a9-3f5c-402f-9043-2159cabc747c","questionRevision":"e2ade3e4db4f9a10486c0462b20db88343e78fa8f240a35f11f0b4e872bd8ab9"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/c6665ade-9894-4c03-a4d8-99224a0f05eb","questionRevision":"791998d5e566c50b985ec59f565c8c2dc093015461897da490af787781b2a3ce"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/dcf96201-1762-412b-856f-3b2eab314adb","questionRevision":"1c57063b38693ee30a4285dfb93feb2c7ec7af6bdf92c56a084263dafe0d7b74"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/b707008b-c1e9-4bf6-9078-36e266623916","questionRevision":"3bdbd51d9ade29381419adb2646240353c834aa563523d99cc1713d3b29594f8"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/55f7e4c0-9101-4c33-bd36-1a77820ca7ae","questionRevision":"da4221f6ddc64c647854164d917573e794db29ecde5aa35e157dabdc4cb7f937"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/d0187d72-0c36-4154-b8b0-fe5a0815ad63","questionRevision":"1d1b11e2c3fd5716fff2a1ac50b10080eb9e454418d6e3e3d23fd25d2323b233"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/b0dbfca4-cc3c-4045-8f35-95d2e71db469","questionRevision":"0acc2373cff2b0ae8df9928fa314ad176571b598927520603a02bb6af17192ad"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/c1408f75-dc66-49ea-a744-ec0db37f4faf","questionRevision":"42a3ee23d9473a79ce139785c405f60bf7624d7c2e1e72e71e6fa2cc2986700a"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/d4a41b22-4cbe-4e25-82e4-241a359eff22","questionRevision":"2df2232512a8ff947a0ef76ce4fd84441de5d2c7ffaf10a78b082464b9256efa"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/f97a7017-b6c1-400c-bf5e-958392e0e014","questionRevision":"7959a9eb8befe8575fcf8413b71e1e56a0a6cee436628f249c314bdd931a8028"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/83cff1a8-0d7f-49c3-8dc3-3a3abe483c70","questionRevision":"c555fc1c7f4751a2ca37440f194a64f42481e3ba0c65e422b0e01aea5253d443"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/4fd42586-e765-4394-a933-7c430d75f068","questionRevision":"f2cbf30ad1ed34ee91a2d91f4f3349449589d5e8dc4fce6a4e2547a4d117bbc4"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/ef35ad9e-c656-4359-b0a2-b42046629ab0","questionRevision":"5cebce1610af7ce508f5d90587d80872f14dc67f913d48602921e9ef6ba940c8"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/e402cd23-d6ba-441a-876d-651df516a09c","questionRevision":"f77acd4a78a03b0593d7948f55466172a9df3efac6365a93759140b127aa6ee8"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/48b13d52-c671-4374-94e7-f16fd504ce00","questionRevision":"85cbd2e325d65758e05258026bbff919150065be18c85bdcec9d8bad835f8068"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/43d38e47-16c4-4c4c-8f14-78b4ff97869d","questionRevision":"12ad9904a03b2064e7cd82cfe2f42820045889ebf425ff930b4b3bb5e3ac869d"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/6d62f196-4932-44b8-b9cc-e54af8e47bc5","questionRevision":"073de43c1a34d05ab834c7ec242a71d0a8b5e369d2e7283b2f66b535c93222dc"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/8aa598ef-1c04-4757-987e-2dde2a88f024","questionRevision":"0f0d4d5d2979593a13d8e59c11a9fcbb7bb34af200aa176872e01cb05963aa01"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/2039acf1-776d-4612-9e71-519e1dd6a83a","questionRevision":"2533cca92f5eddcaa683c7ecf7bd2f0f32c90211d0122b1ab3ba3390ab582841"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/292e10e9-e94f-45f3-9bcb-69cd186b0db4","questionRevision":"5b3f4838e60c65e27867398a239642fc5fbc0e4289ded6b9faa76c891d85b106"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/3e98ad3a-0787-4494-baac-a9badec1c678","questionRevision":"d458633a81c5718f65de3d5c2a88879b3db79267515d53afdd2d6a3889c41d82"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/a20207c9-60f0-4a7f-a66c-63c59f361f22","questionRevision":"bb97539240c69eaff801ba9feecc82dcf4b0828841c3276b6c3ae6bd1a9b16e8"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/ff942b1d-1068-437a-95ac-a481bfa009d6","questionRevision":"c6c6f89b8353e3c8c5acfc21eee0ab43b7a4810135c2f98afe22464dcd985cdf"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/4e022711-3243-4394-b296-a417bc37c4c7","questionRevision":"8d042058cfd09e89dafe28b426d76975daf957e36195b19fe22fd479cbf6b2c6"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/d7d7a81c-46c0-4bfd-bcf3-b0a5cb90379d","questionRevision":"f6ae71224390396b1f68bd52f02260fa32d5bb79bd5c75517825d7cf4628e995"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/2a65f790-e894-4936-882a-6d00af4f0948","questionRevision":"db3216e9299b4a45c66fca201bf828838108c9a4819fa8194dc198e804167a33"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/18ae4fdb-3750-4084-bcfa-ce22571c8d33","questionRevision":"64320ff26534cba741fcf9f811109f22e16f942358eafc507d5052d79359c8c1"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/3747bb04-0243-4978-a757-4044123c1058","questionRevision":"0400228dbbb1006aa967459378282be404c9a0cee22048dd48a7b3eea6bfd90d"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/34a22831-a46e-430e-9dfb-c72bbe4b36b4","questionRevision":"c0f230b9f1bd25c220a3b4c977d97fbb9ca20d719b0649c1c23dd0630d2eb1d0"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/e57276a7-9b6f-446e-9869-3a492353c5ee","questionRevision":"d17b4ec6be7b4efa03c10a6e5a859b22b7bf4c5f2185720f6ddb9847bc1c5586"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/84011265-6a92-4844-b206-089bebcc65df","questionRevision":"4e848988774f4f8993ede65cd05d12392d67ca84dad94404c82f658bcdb37878"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/38a17bf0-6bac-4238-9796-701bc79c87a5","questionRevision":"98521a46c4915c5aed47691d6c7f68f47502d601328b9698fb7aac79790533c1"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/fbaa9082-7556-44fd-a2e5-99c95e310cb8","questionRevision":"e43be279d214e95e530cc36b1f97a34504e6db8c4c5eda081454c184102466b3"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/5875b3fc-ca9a-481b-9adc-b828f7323232","questionRevision":"d7a5e35ce4312e70320e405264ae132242170f11bad447b64b65cc9d0404abe3"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/5c726095-b662-447d-98b5-8ca4ed7d050d","questionRevision":"356b0250190289373a144abf320e8fd6fe7e12574530ae0c1de4202a840ec161"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/20dfd155-fdb3-438a-89bb-9e9b59e50418","questionRevision":"85be0ae865b1925aeb08bb8876f1ab8b11ea75fc8b8c5307ff3c4ec2ea2d3ced"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/0374b20e-dbb8-493d-8844-2bd23f552b0f","questionRevision":"9db144d3eb63481c6e9ac2064cf9d988660a0d25515567157a914d42fd26a2c5"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/d2948568-17ff-4e35-9037-ed480785d35e","questionRevision":"be7211d721a9481e91ccc00d10332dae78af8c69c2443f08a92b6edb57a8f2fe"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/2b091819-208b-437c-a21b-d954e33c21bf","questionRevision":"c95bd62d36037287996392f4478607ed08619bbe83ba9bc7aeef25478bae1aba"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/cc0fb699-65a0-42ab-b868-0de5fa753997","questionRevision":"04f80cfaa964b602497febbfa481b5cbb6fcf2b60ec6e90810c757f1a5369081"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/7c6940f0-f8ca-4d13-8ac1-0a7d56891b40","questionRevision":"31e59cda46c05570e8fce3c3d9f3e2e5c24cea09d6bb8e83ff7633b224b46e35"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/2cd1d5d0-00a0-42dc-82aa-26f9ce5e99c9","questionRevision":"4e9bf327df84b9b31ddd2011f4c54883467b9829feb01437e9d6279c08f49a8d"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/5b63f3ff-0cea-4be0-ae5f-2ae4d36a7d3a","questionRevision":"01188a9365af06cb6f2d51e2b51eaa1f4c44d8e745ec37cddc5ba414aa129c61"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/d09be252-eb7f-48b8-b498-b0f07c3ff462","questionRevision":"ae41f4bb5276687f4b3b231990f3639d16e6456fa66835760d1ee3766e9f61c5"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/51727225-e00a-4d2e-b01d-d9e473cab86f","questionRevision":"0be5ea0b1312448317c204aeb579fe63f8ac0b42575670c3cc32d0acf6ecd19e"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/42fc756a-6cd8-414f-a6d6-200e9839d1d4","questionRevision":"01e4324144d7b0169e6793c5686bf6d3c3d2048794ab1e04b4b84ee5a17c3b55"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/51d7a76b-0cd9-4b7c-bacc-580fdc6d4ba4","questionRevision":"b79180cda564df6cf31c22c08bd7e0645b9eba9f658c19ddac3f7e26579e436e"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/d421b6a7-75e3-44fd-8cc5-58228024d2f3","questionRevision":"a0fc49d6ab3bf27dde4fbc6ebba2883885e4c5c7c9079f6280ed186a33cbabe0"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/7d0e06ac-16a7-4b25-92e5-ee61bee79b20","questionRevision":"3983f90a62e26abba0429aa476356741afa47c74d7bf10859d0634874183afc0"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/5ce2137f-20ce-4063-a30d-4fe7c29b168b","questionRevision":"9978b3b36f5e4622bc616a0e5d51aa63b0fef302d070c344ac59795ee32f6934"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/ceb3bb17-3cf0-464e-9d8b-e1963da1a7d4","questionRevision":"04f5bdc2e20f34e61f7387461c8377fc9e45366b015ecd1441175c42a9de3b24"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/84c61927-cc4b-43ac-af17-e077d2899e7f","questionRevision":"96bc1cb8a8b14e649ae2eebf4bd5815ab5c96f17a7c53d072bc48c2da5c6f7c5"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/43deadb3-fd24-4d1f-82d3-e7797068f736","questionRevision":"082c482fae62b02a836a56d1c25cf5b5e49ccefc7faf5d06be1f9251ae8b9ce3"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/cd0617ad-f259-4e71-9242-ea25bc720c15","questionRevision":"5867ad5358adba74ac8ecb061e72a3387808a9a02b0908899808e643fa4ba5a8"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/91f8a283-209b-4f93-8ac6-e250cbba9166","questionRevision":"dd039bb27e94f89476c51f47d71539d6f34531d8fa51baf1b62b526a550fb721"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/80cda393-c9d9-461e-a7af-3e7fef684d82","questionRevision":"991960f05503646115bc08e78cd6cd69d81b87112ac873d0a4161dc9f579e066"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/56a05986-9958-4bb9-9503-9bdc59ddd7f2","questionRevision":"8814eed9c782d2b4b0898727b4d97e6d7216dd7c5e24ab8737b66c2b8a407b58"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/77247019-147a-40dd-8b23-b51b5fce38f3","questionRevision":"4775b192e7e37aaf30aba870e1218ff8624d7a24ac1b473e6c0d142552536a34"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/e6632fb6-d2b4-4356-8d42-97eb99fe0db3","questionRevision":"bf48a4500adff4b8346b935262cd31c5432c5b46c6c5bfbb60adbfa6e109438f"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/e9e5af12-e8cf-4147-83bf-5654972bb8f5","questionRevision":"ebb672fe2007f3de2948eb8a04e240b083d9a498c2f0de0ef7ef7fbcad532bdb"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/69d51a29-c1a2-4549-9955-c92b687e6e47","questionRevision":"b47ab2ac41e96c0b6a44807953da909ba0d16323d9346ae5f2270b50f4bbe33d"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/e683b430-34b1-4330-ab17-77ff9ee03a7a","questionRevision":"fb7f1d1f35fa808624ed3842e6ee8065111d4d247a23541594a0695b4d77d4f8"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/5538b7f7-493b-4bff-a539-9739b5b6080b","questionRevision":"740ec75fa1589deaa6c7f2db663cde23169e90734c2584f85a5fbb26870c5b16"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/eda5a49a-c45e-4e65-b4e7-26018835bf00","questionRevision":"e78ff9ec1e8af60dd0bbeeb0656031f03d1ea35a7876b92a6d46f32c05a49528"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/162009e0-2def-4eab-a4be-9e6d27a55f99","questionRevision":"0e6302dd8a1f2ac85f4f7df1a1fb73909a4878b592aff625b9aa596040469154"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/dade9bf7-3a1e-4687-84d3-5b3c43e413f0","questionRevision":"850fe668446a3db98eb58389a960ae445f0549ab9914157c72f8532a9b6a42dc"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/262f7877-388c-413d-82d7-fc56be4e4339","questionRevision":"934e1c125245a3fe0ba67dec2beb229460584183f4ba24d42cc8d3931f10386e"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/5c7f9201-3f71-44b5-bbee-223fe2d08c41","questionRevision":"4934b0e56e4051a431fffac319510d827a0ea757b72593a55cc22f84b9efe425"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/773e1a29-9d81-4a1b-96be-45c062617f58","questionRevision":"c3fb1a2a4184a8daec3cf0254381e0bd2aa7336b9ececbd01f0b6fe08c76c207"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/0a04d93d-dc27-4073-8807-06dcb205e5a3","questionRevision":"2a6989a6e2e5be79ab426ab72d0227fe8f9137febbd0d4ea9383a731367d5e7d"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/0617e45e-58b0-4e72-a921-ba1e1ad053ff","questionRevision":"a82cc4ca5060c0b121ad668ac38ff1e0d9ecf1723b7c3bc04e6b28a625071352"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/950253a4-08c2-4227-b3be-194bcb5c796d","questionRevision":"70f8fe183facc7e9c326d5f793cab71b01e18ba6ef66a68d07430b76e3425e63"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/c09ffb46-98d8-45cb-8239-67c31c31b49b","questionRevision":"5442062cc1dbd3fee02184aac6b230f46713bacc2f6888248eae98315b4f30dd"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/2a558ccc-c296-4ea0-a7d4-26bb24a80b92","questionRevision":"4ad2a3733ff7d95cf20963a0a886e9685c94e32c4e8856eb1c99a3cb4443b63a"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/055e4bbe-3d2a-4179-98c7-a07ed5370d69","questionRevision":"68073cd9fde6f747e550b27a4b98bd50b4615637a86645be4352f95faffd8d09"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/85af2738-144b-4db3-8832-cc86b1b67a8c","questionRevision":"f6dcc4ea2ff7638f825312de8ed04a4ae0574b8dff153cb22bfda8533552a963"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/6de33667-1c85-4744-ac32-928129cb7dc4","questionRevision":"541ed07d00ce31a0878de23d9a915e9db616cd993e0f90e4e7d38bce917fefd5"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/ea6a1fb4-568e-45f2-bbec-4a3093bb25df","questionRevision":"45bf1a577866a7efbd7daf67b383485fbe5c2a22fad0fd40925ecce6ae493e8a"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/a9c78634-ee4b-412c-bfbc-9936da1d774d","questionRevision":"5c917ac19816f1b427b942af045984f43a0b22df6ebb1cf4bbff4da8547c3c30"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/56864dff-e793-47ba-b9ed-6b70bd1ee9d5","questionRevision":"9ef2d3c3693c485c3acba65ac72578d32cc3d8f7a1a4f9848884d0e964b225ca"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/d10150c6-7b33-4354-a392-14cb78c24326","questionRevision":"ce38d937f5e62bd98091c05da991c344a17bf7f7d2f1dc1c53eb7b0eda0ddfab"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/524bd469-ec72-438a-8068-b71b50e256f5","questionRevision":"f4610a2d923d570876d9973f979ea646ce9d62644cc14d932dff378f5f81b0dc"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/6cc676e7-ccbc-4f12-a054-356acf2e04f5","questionRevision":"27ea0bbf85a5b6c6fea543a960bd5d7e32a90fe5eae77fcb25916f995f85cf87"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/e4ffc344-d3ce-402e-a0cb-e22e56a7924c","questionRevision":"89ada5596b6782ca2aeb299053996977299f25ae6b9b536fb8172dc14ad9f7c5"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/1b82d4b6-3fbf-42cd-9454-681363b321c6","questionRevision":"a9c0bc6f2ad7c4929076b0c1242288dd81a31ce6a93aff590c47c1a5fafca30c"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/162cca86-29b8-4ee6-8906-fd7ca00d3c67","questionRevision":"5ded6708eaf96eabfb2c54ac1f3a247300eb9c7d6e04829e1345761368b2636b"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/ffdad0c4-0568-401c-8d12-e1a65163ddb7","questionRevision":"9a484466f6b41bd2c27c1651778188f163a842b61c9b3321db61640483cb7f57"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/c8c1230b-c50c-41e9-a4c0-878b24cc0579","questionRevision":"267211cd2ca8be85659efb193f6e175ed59c3569fe4c7b3895a4d2a7845e92f3"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/3ad9a309-8a8e-4927-9fc5-8822c519db92","questionRevision":"0c60c439a512854e771a89445d4242965f7469ce31c80cc7d003929b2e64b4cb"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/19b07427-1be3-4156-a978-bf4116b77781","questionRevision":"064c85d4091060faffd8746140d464a280662fd5e8db7a20635f08edff487a0a"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/29986a3f-cd1e-445f-b3cf-1a805c5e1a4b","questionRevision":"1be117d84da90e6cc0d9e692f860e82e643872b0f20b0958ca40e4d4e4bb6c3a"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/0a808239-0415-4265-a0b5-e3cf050a4f58","questionRevision":"22b8a14819ba57319cb097d0d22bc11d2918cf6b99fbe879fbd6d21bb87dc894"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/2152d159-d648-4645-a305-e179440c09f9","questionRevision":"eebebd9b148515d73f1cbe1db20f38096ce287f02d1320c329437d41c0a08e70"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/68894188-494d-49e2-b0ee-57724afc72d8","questionRevision":"0f683cb13a43fe43bc3d2cff8fa0fc9b874ef67f0e51ab09c4c48476098d514e"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/797b3d52-8961-4f26-8df2-3729f7f2d007","questionRevision":"a21d55f97b215a81a5ae0e35b4482f612f454d3c1c3c8482772587fc77e6792f"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/9c368138-e1c4-43b7-a2c2-e6236fc42908","questionRevision":"bd99780fd43636546a6b2d7590177c02d53dd0f66d027b10232fff2f3a8fde31"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/711a2f28-5b8e-4caf-88cb-1f70f76a9bcf","questionRevision":"fbabc4199e90ec4d366f49cfb498a68e81ae82f76c1fda9a8ab32248960419a9"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/b1305460-6ed3-4043-a263-c0051cdf8e88","questionRevision":"7f1736132fa3ec933b925300e6009b7152b1a4833e8cf092b904fb33d3bc81ed"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/c87bf08a-27e7-4099-828a-956ffa635706","questionRevision":"89ffac51359b1d627632c35fb6df068c4a45bef72327c70e71d92a33e6b52341"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/7c7a7403-b8d1-4875-afa6-ef22c454260b","questionRevision":"cb4e58f7484858e003d37011ae1895d83a2bed20e7b6a410e121d5a0fb7645c8"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/5baf980a-9b39-4376-9a51-ec577612489a","questionRevision":"c357f5388c331f5fb554e1dad32a43e488ad6ddd829010ca1774fd0d7a0af83f"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/8dcb350a-a86e-4ec7-bcfe-e3207a1fc851","questionRevision":"feedc36ed2a297670a6a2725282650f4ce46ceed44b0e6041a6a2d1e1321335d"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/105e483b-a528-405f-bb0f-6ffa789d2d24","questionRevision":"7e3d2a6525197452046267e9f24d98a078cffe16010e16744bf5460eb09a6642"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/9dba2574-71cf-4456-8953-54171593c95e","questionRevision":"addaa18c49cc49ad978f46e765dd7b930e61269a439f9ee14bd7cafd13f7395a"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/a1914e0a-e0cd-41c4-8981-196c0b057c36","questionRevision":"105b5635f0991d7ff1acf3a5302753a2a4c97f2642f2a6f339f9c4d448bc2add"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/48eb153e-95de-4cb9-a909-21029aeb3d87","questionRevision":"5239852709c8499fd30e67ecb73f61646421bfeaf8994be6266330cdce56699a"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/5f68e156-af58-4153-9590-04f1eb224c68","questionRevision":"699a46bd0eecd7419f740dfa27e98c19d4a326ae1edb93283286a1900f253002"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/42da3190-9c7b-4c83-98f7-01f569bc89c1","questionRevision":"2f9f310083fb414987e3939afad295ad36317d0c8f5f35bd55faa09afa4c6c44"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/3aabb44d-b641-493e-9b98-ca4ce313e746","questionRevision":"ee1db521ae7c972f1f4541bb64156a04f382918f9b6565c94506d108d7cdb53f"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/6d944558-cef8-4d1f-842c-caa93d605023","questionRevision":"d08352cea885bf4e7837f9c2bf90d479ac37bab8b78c726b8b5ce926b79a5b77"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/6470fc00-cffd-4ae6-bb2e-b433aeeeaafc","questionRevision":"2a6a2427fd93a9f43d5eeb5c856827c90e32201939b8372fb3944500f8904e38"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/588e5d7e-47e7-4092-9f1a-6c39ef908006","questionRevision":"b4ebff28ab9314e56aca348c807e355f8a40b1b36cb07330f903b82399fd3cb5"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/41bbd00a-b1b9-48e9-b6fa-d7a352ad5580","questionRevision":"17ea04a3b28c4f733ba5a537f9585eb33da3ad2ade07ac93aa5ebb6f91afef44"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/ca4dcd97-2faa-4cb3-8b03-d93322f6dedc","questionRevision":"939162050b4df9d6dd09af241e941566ebf0412724243c6c0f6894c98d471e35"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/db3dd5d1-090b-4a35-baa1-a31865805908","questionRevision":"cddfc208d228f2f5fec0fa8074f872cc5a5b904bae0b14e93087a75be355065d"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/a2ee5355-eae0-4cd3-87ea-29db9c8dffb0","questionRevision":"6914aa0f3ac634356552c2b31a9d64ec8000c406a5eb992ff17d8d9ea7360c4a"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/b52cefdd-1cea-4d69-a877-a61465af85ed","questionRevision":"48f700767b08188c11b0a4049ff6b363a3f24b7cbf441ffdc64d9d376b8b28d3"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/801fb434-8461-4229-b0df-659e331448fc","questionRevision":"357392e6e303e7c767fb16d87436f887157539934e5a0d5dacbaf94dc4b83d50"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/573cae07-9108-43da-bd6c-c251bcaf4d13","questionRevision":"b5a7ab86769b757d9b3856c255c319d6a4699745cfa93579bd835772df390907"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/fecb3d8a-b6cc-4d05-b077-46c8c851070d","questionRevision":"705543f93695fad68abcfd3f1e932ea37109181609475f823a8ed59af0924881"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/c4218012-fb1a-4389-9c1f-5d7addd56be6","questionRevision":"151f81eda98ed2086d8e44a7f711ccb593f66b0040b206300eb5fffb13426f45"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/79cf0829-d0b2-479c-84a6-cf1d8f587f95","questionRevision":"22b33ebfd52778a90e76380e2670e40cc0024b8e33fc306355f883e3526a2adf"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/e9160a17-21be-4d89-bb85-0493b502b7f1","questionRevision":"b98eef77e526a93d9715e09cba1917cbed3283aa0c4429b59d53a206f910569a"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/807b41a1-4423-4543-879c-fdac419bcf0c","questionRevision":"0820c1a84d6be91ad62e483e3885045607a952a693892ea9abfde546c82d2222"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/c8ea39ce-502a-4a0e-874f-9e67baf9899f","questionRevision":"19bfa5c62db2c801cb703b9d6c496ccfc0f90fabd2e3e3c79b58cf23bb1d9eb9"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/501832be-25da-4791-80eb-ac20a27513a5","questionRevision":"a1a1b1c8d1e03b5302be8bdf52f24480755fdf8c1c854ee7488476786f87d494"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/82c2a8a1-4c10-4b8e-b192-bd6b0b84d54d","questionRevision":"124586312d964bd7b728a48a4c1af0b43ce92cf71f1e149231ce04d2bc8b170d"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/defa4611-0705-4504-8e4b-e344ecc057cb","questionRevision":"24a57704957881dbe88b3580c2c877caf760994a71396bcf7d9e31a0e4e1757e"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/f7741704-d828-4f6b-93e1-b0df681a8bc0","questionRevision":"8f908406f12e7e4506245a42a9d00cca956fde983b2068c2c8fea402ce34cbbe"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/2a1e1e22-0a7c-4897-9f7e-2184a2add505","questionRevision":"5a335b5ac1f07ff20119bb90fe3e842503e162263f486aff5f7463b4c4f81519"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/36fd8ff7-d83e-46bf-b1b5-e8e28d38faf8","questionRevision":"34bdc3413e94f7889a5bf352a874e8d914cc0fbb2e83d1b7257775ac733a5dc9"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/29993309-9048-4267-97c4-8ceaeeade346","questionRevision":"ced9d35f005dc1b5d5f47058927605939099e5dc885c4a520e2d43c4de9733ce"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/c8393c5b-252b-4dcf-bf79-4d36683983ac","questionRevision":"36515ec27dd4ed7336a8ca2f3f54f3aced294c30a225c913af3fe5dea15a9bfb"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/9c845029-43f9-4e3f-8266-06149b44f953","questionRevision":"eedad04f4c2e68341ce9f50b0d24ff00f8a5984b69486bf37390ebf9ba15e6a8"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/38465044-4451-492c-9e8a-7ecfa8bd39cd","questionRevision":"4c8b7039fbaa0c49cef4298e758e7ddd95b60459982b9eb79c22c910ea342d90"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/82917924-ab94-4751-b600-1e808b299dae","questionRevision":"0791feb3cebfd9ea4c527e9a43681b34ad48dcb1911efff38bb840fd45904b73"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/5e23f54a-6ae4-4ca6-bed1-d26bca1dadd8","questionRevision":"4a88208e267a4436dd8b9ceebc775879d271f2c9599d1ccf635b7bea3c6a8920"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/35f30b71-16e1-4425-b5d6-398e037f6380","questionRevision":"c05192edceb14bf63fcf376d03d2d4c386eceec3d86083af9e7bfbc306d40958"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/41fd6e35-e308-4576-9922-71f680824b20","questionRevision":"4bbf6e6f5691ca5ffdc72e00b3c29d52573573d72fe7decd34a0cbf24a64b61d"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/e11d470c-661c-4f02-be73-c6fb3604eac1","questionRevision":"32e0444bcc6b36a0039b0ee63fd841ab70e64cde07602baa9ae8f75f94d7028c"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/f1080f59-2f2e-4658-9bb1-096c68aa1ab8","questionRevision":"46a10f8c783bfb281da9fdfa0628ab0ce3f0db708491a8fc8c5fbe1044c6bc77"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/386338a5-d8c0-4215-972e-12d5e2c736f9","questionRevision":"5913517a8ddab7b9648d5d571bcb969410d247cd83c8df9ddbb3ad764a8a11d3"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/2232bb9e-7e07-4d6d-98bb-9bccc1bfebab","questionRevision":"ddd6f0ddcb9ee3424cca418a9459443dfcaaaea5865297e936a470c83ad9becd"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/6c38965b-288f-4097-878e-c6f20c5b5de8","questionRevision":"e1cb13be9dcfe86b956f28f9edc20ae9d192e0eb9c7d26246254c2d33cea7e34"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/ed1167eb-26e9-4227-8112-9bfa5c2aa50e","questionRevision":"0f56b3f54ad99c96a36f8855fe0e36b0f68f4ced894033a04802cb22beefefbd"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/fe9e331b-0469-41a8-9657-ff7aff91109b","questionRevision":"fa1e93a274f242beef981d2f20e2c6587dc3abeaf2ebb69957b3820454e1ecfb"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/dc5e1c53-1e0c-4828-af81-a4f37047d781","questionRevision":"b9dc051eb7cf3ed1f8278831b9623d004b2593e18e283bd48ad0c0c09c4245c3"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/5cd236af-aad9-4d83-bbf9-b2907022eaf8","questionRevision":"b31427cef1a907a23dad0024f75e84ce0cdce25eb3bf872cdcc3d07677fb5a75"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/1006f10c-93dd-429b-9da4-e1255e7b78ae","questionRevision":"af3bf104ab8b51a441ba289fe988050fa2ce93c94bb7a07d6217b54dcc5c45e5"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/1f1447a5-0932-4451-9fdc-5a7049f786b3","questionRevision":"4ed5f575c36e4fd38f8897a35e760756b0c97111aecc9ff043314294c49aefd3"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/26f8194b-2926-4733-89da-9da1a4dd4609","questionRevision":"e67485071bf143050ff65156fb6ed5c7059e63717138d7f7db83edcc699e0584"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/a3bf48e2-4d5d-40b9-a71c-f5a20b8a1afa","questionRevision":"565963a4683cddacd34c3eab4430fa8eb752c0febe4ec111b91eb84a01279076"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/5dacf3a5-b376-4296-ab82-0ebe1626146b","questionRevision":"91efd7ed69675467c9aad709958c861e1db2983c9fd1d7480f58ee0f02e5286c"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/fa9710b2-1f6c-458f-99f6-2e84976a6c4b","questionRevision":"97ab1d7560f6c0c4921a785ee0f13e3e487c0b0c7b40227eb961e0b844508488"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/c03afd85-4676-4fcc-a3f6-2f1d7b605b88","questionRevision":"feb1f68d33837309eee26af1787490aeaae51833ccd6904384cda29431cd202f"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/2a5042ea-d9f5-45d6-a6c3-b532447de6cf","questionRevision":"79a973cbc10c3d8c1976c646c77e3808a18a25a16218d6c96af36de412e7f41c"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/d6144a80-340c-4774-ba5e-5d27b6710ad8","questionRevision":"ab50c62691620dc57cc8a4c3f44ba5e6010e9d48b2f10600b7c2e1c80b1f90ce"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/6abbc8b1-fdb8-411f-bab2-87a0b2671fb7","questionRevision":"7e1377868ac53b6da5d62f25e1294dae0d500dfa86ae909ad235f89e35f61c09"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/9fdf8458-892b-4838-8624-3620d1c83077","questionRevision":"1cf501b01d0a5cd4d42f4bb294ee3505465dd209c7c3ee0142637ac1a620fc97"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/882aed91-8be6-4baa-a79e-0187cd96011a","questionRevision":"c0edb365d3806d54b7ed661d91b81922fd8b54c348f770d1537711fc89c63ce3"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/00674ba7-dda6-4d89-9a25-639f5bc69991","questionRevision":"26d98f5b30aa79263371de16dd1c63d23fdaf56a5b7b027d962872f8a56e2407"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/f6e38364-88a1-4eb5-8499-04ccd2a70db7","questionRevision":"63e4829216b517c711c3424896495c9aa71d868c5cf2dcec82db0ca19b7d0475"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/d52a40a7-b93e-4dc6-944e-0fd89d453b2b","questionRevision":"4c93ba7e4112ba52256c26dcda1632969a3cd1c89909bf186f665b433217f58a"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/b1d7d44f-531f-4bec-b73d-982289747850","questionRevision":"1532206fe170f2bc5c77a2c537705abcc9e05dbdbfbea7695dd5c070403bdc25"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/da49fc45-9e12-4fce-9719-4e51ed998418","questionRevision":"c9db919e394594d5d07057f1791c1f3f42fa3eac2cf307dc39cea338179d0590"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/32c6cbaf-7a02-408b-9803-38c0b65b0b94","questionRevision":"7aac3ff3197839ba30b6c52b03a7f47d0a6762f7b2fd9e3a5486bf1e3fba2c20"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/461796bb-34ab-4160-a7b0-1304fc5db8f6","questionRevision":"9903257e93b5b608b199e22ad3dd27d6290a9755f8e249e47dc83d11810d27c9"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/482d56f1-ff39-4d26-bb98-ad807fba53d2","questionRevision":"46eec3b4e762a5edac766540890a2548bdfe88869aa658d7fc264e66945f78c6"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/e3c66fdb-82ba-4e1e-b962-9d5d40abdcbf","questionRevision":"fbe1d795eee422a5df22491d2e2a2ad4a0b6e261337594b065362f0212a1ba53"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/af23932c-6e1f-41a2-9259-55b4443167d8","questionRevision":"df63da443c9aeb90a51cb10f479fd488843d36529a36fadebf2edb0c1ac678af"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/1fefeea7-9a62-449a-b031-8657118759cc","questionRevision":"13b4fec1033ff4aefe5852e8c91eb54ef94ec845fe837cf671448ad2e7f70a5c"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/415ad0f3-ee8f-4f47-822a-9b435a93516e","questionRevision":"184552d2aea24cfe6ebcd67535847015fe68624b30d72069705669086a93102b"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/5122e12d-f5de-4670-832b-f5852fac1763","questionRevision":"28f6ad8dffdd73cdae0163e68b7b6f6c286ecd299ab26009c5e6fa5f92b9275c"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/91e5b990-1fc9-470b-a087-69f15b364b6d","questionRevision":"9e42f8e1fd7056eccac4efac93fbb217d6b8e4bf2c3b8703610fa8c2582b7e2c"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/6a1a5f54-b504-47c4-94e7-00cd2ef52f0d","questionRevision":"7d7759aef1bc76e0c676de56548d7d6efd4dfabcdf6dc1eafe96aba9f944e8ab"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/e59df7d5-8b37-4411-a300-2c35fe2bb120","questionRevision":"192f787015b842523e2f374393791c9fd731319bb1f16e4ddaa7b3aa2621c248"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/1d227d9c-d235-43c4-8112-e31b09642d7f","questionRevision":"0708f16baba2f0ca9319e7a201fc327825615cbbcacc6541c99308129210851c"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/bd8f8b2e-5a14-4fb4-bca9-32af4833e41f","questionRevision":"77b0dd4e25652e5b08797373b95bd57b30475755dd7cb99063111033ce52e09f"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/112e5b60-9c5c-46c0-8052-518fe0f958bf","questionRevision":"90ae09ef6f94dad9620422357e977723a8ce0b156f8cb56311a595460a152525"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/ce65fecb-cc2f-45d5-bfb7-19269350685d","questionRevision":"e5d431e802fb747c154f6ed58f2ccda471bc8799b0cf7056cb49df45081753b2"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/1a5ed85c-47e1-4a73-88b4-0a0a9ecf5e53","questionRevision":"c1fb5ba60a2f75401ca198d0672d0263987839fe316fedd7cffb85a410a3aec8"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/ac6319d9-57dd-4016-80b3-02adcd8fb6d4","questionRevision":"8e9e71895a2df943ecddad2d86c65691fdc12672cdf86d35a973b794082c4c29"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/df387596-509d-4344-a381-311ab42ae45d","questionRevision":"4444972966d3fd639f6a450e9d09c16f71c4bfef2c4c3384bedc58116bf12685"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/fc073def-8789-4dcf-9010-a69adb01c191","questionRevision":"30b3e1aad980087a38e7f4191f5ffc8877d6458caee4f8668ef84354f4d790fd"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/cd15cf5c-d504-41e4-a70e-6c5329dc3889","questionRevision":"b553a5e235c45c33cdfd4130336660074a13fd6f386be3e3ed51826bbd523e6b"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/99925fac-001a-4722-ae9c-2fcf0c55a301","questionRevision":"4f91885bf5e17ba8ff254058433db12955ed88752b04f2d2aa097d850d26f061"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/26309034-cf22-4358-a604-50039a37e324","questionRevision":"46d03a57f85289d6bef5d2502b8d7b5d10615ad43a3e15de2edd3478224ec4ba"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/483a52f7-1a97-4103-a5c5-e751a1c3fc20","questionRevision":"5a08a056563947fcb472abbe90af93a88a5587a4c474fe189e031f3ab11b3142"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/46b0a81f-2840-4345-a321-46dfe875d86e","questionRevision":"17bd7ea46371d8c6ca13b475c702e036a12d7e595663a4bfb4de05cb78db9f3e"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/8dd12c23-091b-45a8-9431-67fa2a6466f9","questionRevision":"4987225635bed1fa5dce94609a0d4a3f7c7049a5d139fff098d1c59b6661acd3"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/906d8793-70e5-4a59-a312-f48f6911835a","questionRevision":"259d19b58c908cdd3d8f6516a937d9b1e8e821d2547c2366989d299567e97c73"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/68939424-6bce-45e7-8c73-3cfe3ac5f37d","questionRevision":"849948d5660818d747e889b09891a38fdc19bebb9f3493d78a8d38c1173bf8c6"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/7d7b3f36-2a27-46ab-88e3-eda305e313c4","questionRevision":"e1bba44e07eb2d9d14be9744639c23ec0729b6f1e84f16806c9f1443c1a60c65"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/cc50f0f4-45ca-4b10-9323-f1d8cd538adb","questionRevision":"847f2511c256cc7898308310c911dbb87901afeee368544c058911359465d50e"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/446172df-44ed-43b8-8045-91450bb05c41","questionRevision":"1ac8faf64cf7ff56001dbd5425c18e1cdd5b1745a5b2d4c67eefe75ae750970a"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/cb9c9c9c-1b93-4cfb-9f73-f75c6ca1300c","questionRevision":"f7dc01d3e60b43602fd8644b4fffd0fcb39a56245cd7cfcda006d164f96981b8"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/1c3c15d6-bc29-454e-bcd7-f7c91f3f23d0","questionRevision":"8569e9c93ed231d9b4d651829d7615dc356b7eb1bef3187b6bc440577bc06785"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/aaa4e636-12db-4e85-a4c4-01f6ae89bac3","questionRevision":"53a0e3792795a7b84aeea4892af262261118f1b39ca7a242207f69ad600deb8b"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/bd0e8a96-bd3b-4bf5-bc13-c2d128a1de88","questionRevision":"db1ca8762b77fd2a1885d2decb4e82dc98a86d57e2f3e7b2ee3c32192f63274a"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/24e9f606-d21c-4971-a827-3ebb8a1ff5d8","questionRevision":"b8582bf49cb64892fa9f8c8710e44b84d0b24871f4e5022498803193fcaf2966"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/3a57da98-dca2-498f-baed-ba64580b4de4","questionRevision":"6c4225a4c7f4eae3764a35ccdec4d57a698f3d32cafbc71491755caa6d83349f"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/1bc97e0a-3718-4945-858b-3ef20a487af3","questionRevision":"6c0057d2682a04cb1a918b098089e64da4f3911ec0e604ce7fd8494c55f6bd11"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/9571b42c-0942-4793-b3b6-a7fbc87a34c3","questionRevision":"990a5108f75e91709be3c91828b311efd7cd2351c39008b0b590b52765151c00"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/a4def6b4-5d2d-427f-ad6c-44bd27933f12","questionRevision":"2215d80e01c7a099a360633d3c02510f242a17b406798417ff148662ea3e69bd"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/3ed3c0af-1322-4b15-84f6-88ac8c5ab439","questionRevision":"2241c5b874aa1f78669bc998d44d9cf87e39400d22c77a09d5f6becd6f908a66"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/5715b008-9c54-4dc6-bc74-1c84e2ba9d02","questionRevision":"298a21fbd4553bb7af67052c68dd33bfc05b028b38e8faaa8cadb9b124c7940b"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/d0783df5-7cd2-4e7b-ad50-f6c5abfbfb50","questionRevision":"f3eda8b42b6d25af26d23277b8fd486b9335eadaf5623a9194842b2953af5ae4"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/7023c7cb-2c56-4b15-a045-1fee170341f6","questionRevision":"14bf10dadafc80e9805fc2e2124d5b868d6fa366078386961bf1e092d363df0f"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/0b02841c-a908-4928-9bb4-75c516e0bfe2","questionRevision":"a70df7efec2589c59e0ba60799ec0d875bf1308b7fc972e9e39ff8761d268bff"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/f8ddaa60-0d88-4cce-b33c-4e9bdcc4e04a","questionRevision":"4584edc2fc7a02af4d203f3f49e76c306e672b676dbe0e88436bf7e6cbc694cd"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/5eb034b3-525d-4fb2-9c6f-20fa3f6848b0","questionRevision":"0bd82b169be303f3715ab2cbda6b7b5f3398df772071ce24609e5abb71a594ef"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/2a27bdbf-726f-4fa8-a288-728de6f1c83e","questionRevision":"0a579d7a515cfad05aca4fa30a7cc2183a853c68a0cd173831acf3bd12fecc64"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/1c5d9116-237b-4354-8440-afb666e5b92c","questionRevision":"f3d4bff780667840c1b6454576b198338abc6688d79aa2996470477224757d27"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/e865ee0f-b9aa-4763-9d4f-24bce4bf1625","questionRevision":"c960fb38b12a6518015a63465bdbfb5c74c531eca5293e46ea3a4e088075af00"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/2ce257cc-ed97-46cb-b932-5143fefe8943","questionRevision":"4c8e5c527fc890a9f0a167f161309166f302a3aef44091ad29175b087eab0992"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/7ff457ea-b86f-4755-b4cc-0ce5d6282b40","questionRevision":"428e462a2eb7e5e1881bb86b64819f5ab2bbd1620eb35c567206c26ebfcaa884"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/c90242a0-5666-4558-9278-fba8c857244e","questionRevision":"26ed0f4dd3f1017a65ac334284312108cb0f8cbd0a72bc244ca92f1fa14e3ed8"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/6d7633ad-223f-423e-b08f-776711b68aee","questionRevision":"6a312bd4dbb8ccacf2eb80cb9e529af696275f8b92c179e20f2a03549ee791d5"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/585841ff-a5a5-4fc2-875a-5076f0b4e89a","questionRevision":"5072792179d75a761b938c929fbd558c7dd9b7ccae822ae635e3b3253dd8e6c2"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/d9cd2b69-817f-4e20-a7b9-2b28995bf76f","questionRevision":"da50a02c41978c89c4d1a4b6b69efa7a3a2efc6d14fcef91e9ebc3c35a9ae939"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/239d8f66-7777-4d75-af6d-3522595dd237","questionRevision":"98ed53835b3b6a49594608bc17f9eb1e1a85a76ccfb5a75984d64152e50878e6"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/06672b20-0bf9-4fd7-bde9-b8bd0cf14caa","questionRevision":"4188b73c990415aa5ea6f9816271f984add8843d490baa8538488b359cf58f2c"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/766270f0-9d34-46a6-9f93-ad2dbcd8e056","questionRevision":"4f2d092fc1bace3502d228d89efb87d9e503a68a0ecdffb67e080334141a2564"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/a09651a2-f8bb-4632-8468-6f03d46775fa","questionRevision":"aeaea10afd6c513b0b22f5a64a9be711a99efb22d8ac98f2106198e6cc6e1d71"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/b97864ae-81e4-4919-b9f0-7f84b8e1ca87","questionRevision":"5f78c5ee3ac695beb03525e27f8c5711171835ea402fa7335446a9bb04a8aa14"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/4ea56691-d325-44bb-b850-34e7aad1b207","questionRevision":"8424991f72aa79f0257990f04253009f7f18c45b5e7f4b1c71ef286918631b2c"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/027711ba-569a-48b2-9541-cdd5f704f22d","questionRevision":"aee0bdc7822b7c4b14f84909d6afba2616ceb49661ebcc14b6bf6410b7e8907e"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/b1c3f7f0-631a-4f2f-9953-58946de0bb2b","questionRevision":"0000392a180a91dd5dd18131023a58775ad2df404e4cbe1918a02fb299d33a8c"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/af4b1b4d-dedf-475a-9635-691fcf6cbe10","questionRevision":"b521a95331d8f22020baa730288b916f376f9856d64b8d916af8091d142a8cb6"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/7556afec-cc8d-4589-b62f-2cadb25601d2","questionRevision":"eb4e50cf1c53983913a55027552951a0491b3778c508c703cf6bd5099514facd"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/58edfb8d-0538-46dd-93e5-f38f202b819b","questionRevision":"f02803b1148303ca7199de8af68fc449b853567be64c80498109e035fe80c800"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/5fa66b59-0901-463d-bcaa-5272fcad7abb","questionRevision":"66b4d00992313716243baaf0dab39316cb72b6f836fcf058eaf1d75d35d4cf76"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/520a7225-07d0-4785-973b-166b6de0a733","questionRevision":"fa73bd82fff9b1f96ed287b7e7436aa25c033b2b83eeaa3cbf154ba2b1ba6db9"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/8cb7426d-73ac-4f03-b5cb-a672a0d33c71","questionRevision":"1f502245e5f74b4db4387b39520f281a0120401942083eda2eb7d51ba1c065df"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/cd87eb41-8cf8-4ea7-a136-7e0f77290aa5","questionRevision":"f2e962ee6e920097488ab52efbab7305d5bb26b01e65ff332f3fc4624fb6608c"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/69d29912-c06e-46ca-9dbd-74812aecaa77","questionRevision":"30e21f44d4a348014ef739fdf6f5de10368762f87922b5ab50d8316f9598399c"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/36eb8862-8e82-4bc3-82b4-cb30ccd366e7","questionRevision":"a59f7334b0eb5fc3fd2fbe07f2ba4b407d6354e695d581a53a4762fee2741161"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/962c5a41-72c7-4f77-a055-60771571026c","questionRevision":"b75799199e0c37e82a29fe0337e7fcb9c7274ec6937ea9c8ae4a1e123998c307"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/4e9ae1c3-c7c5-4be6-92f5-473b1696b07a","questionRevision":"93bc29b843212610c5b7df41f48bcde456747878f80e6024f0340ea1c725c58f"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/fa42f9b0-55df-43bf-bab6-2a0accf06406","questionRevision":"9fea3d9627933cfbfbe7d5442d9b1c5f5828c7fed62984ef8ee4b5f0ce054fe7"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/a98ba0d2-1c88-45c9-9dfa-424cb5db6fb1","questionRevision":"fa0c92b8bb3fad296acd7efe48a6b8c114cd03e5325b6cb3e6d3210df2b264b8"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/b4afd5a8-98f6-42a4-8ff0-c6dd40fe6c43","questionRevision":"123494312de403c2522774ec49039bce0a17e14c5af4e8f1c5165c810a73a537"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/6e05e764-e60d-41c4-bea0-c4c85862be58","questionRevision":"4ac58b2ce7872d54cbb76cbd941ca830c016ba2def988008e21a674a797b6fbd"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/f77c9a12-dedf-42fb-9746-1300fba20e09","questionRevision":"68b1d63dbceb53eb873256fe7a5b21d1cd484374a1a4eaba3c4f1222b1dac572"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/ab485256-30cf-4ba4-a894-fd69f8b8420a","questionRevision":"1475117f2e4e83e42ee78d36c6b30788db50f21f77b2addd1c3c4f3b1ecacc45"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/1928f694-6841-4745-bb94-ebb4675f8e67","questionRevision":"882ebc9551f50b271b2544036d8595b690d736ae45ff03d67ec3544a07426385"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/0829df5d-881e-4ac3-a2b7-59822660940d","questionRevision":"97e434f74fef888dfa48b723c8cd017b14ac4b24fc2e3e38fe9fb5f7426d2385"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/1a2b1493-32ce-4cca-8afe-3fec22893f03","questionRevision":"c9bd43df0a38441a1c383b7625604126122eb4a8bf29b2e3c23478ff6dc41cb6"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/aab62644-4c92-49c9-99ca-32ea9690a3ff","questionRevision":"0441501b07f7d81b4a4c2e748c8e551ff042202efa535d4fa5812ecbdcc27973"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/30d0595b-03f4-480b-9a41-a8b9a36e8d25","questionRevision":"e566083f0b8ac549f7672cbe6d2696a1e8f401514f505a9b5d0e089caebc43bd"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/c20da53e-1164-4eae-b785-8c6bcadbbf56","questionRevision":"bca4d7b77edcc034fdb2e135eac2f2cfed5e8a0c56dd00e932723500d4b9980d"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/1076ad04-298d-4a37-8b43-e7f63f31ccb1","questionRevision":"275aa4490e2c32a7dac78b3cfe7dcd9b4189e06f3dde16fe3b898bb7d0a9ca0f"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/4c259cb4-e73d-4386-be81-58dda207d3fb","questionRevision":"fa0e0dfc0c04a148d7e01e195400b2d8b3edbdc572392cc5bc930e28d6cfab77"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/ff5818c5-4f0e-4c23-9168-979f1c6eb0d8","questionRevision":"1ab80a3782da182f1e9a79bcb8050785d9456d2e3b1fabef57fb9d2492403abd"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/031a1963-de85-4d2c-a247-9722b4caf905","questionRevision":"641f773d83e1b2751b7aefc4f2549cef174098e5d830b2c95e64f81c24f28237"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/a8f7c7bd-67af-4b0c-a3d1-4d926eb0f689","questionRevision":"4ba8c28cd120a33be6e18ccf23333c59c2bca37491b7c60044618bd72cf6228c"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/d6a19924-dded-4a2d-95f0-61ae75248597","questionRevision":"0957394955e40a77ef5cf1404185e8755c2b90e38539c2f96c5ac52ce1b80484"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/8e7a3b78-13b6-4335-ab5a-36b8c1bdc6b9","questionRevision":"571dc76cdd4cd2f662fa48d288b14e1f69254b1aa8c08ff2319050dafce075f8"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/993d90fe-e796-4e64-9d4a-7a2cd09c8319","questionRevision":"ba0790c0fb29db14d6da6ca537f31fcd95383c387758a4bf0a84e735cf1ccefa"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/729c94a8-54c0-425b-bc6e-d431ee081498","questionRevision":"6f4cc8017bc85005fb0e670fa4c3f64795c04340f916bd965fa06dff9747c6e1"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/963f9fdb-9003-4391-af4a-37b87d11f6e0","questionRevision":"c3bef0724b7b35bce3fda5ea59c1d8b6a56e4924567481fbf977897f5e304bc4"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/b662dbb4-6906-432c-9199-bd7c14089b80","questionRevision":"d86a9d7458c04ccd0b4ceb9335a7ed2f2781d205118de62904588ef32312bd62"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/f5579112-dbb6-46da-915f-96cee8299db4","questionRevision":"7f8e548e53889de2a35370cb8451363f37709cf9d2b7af6b51d6c47774816f7d"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/a66b5d5a-403f-4825-9739-5676971dc9d1","questionRevision":"289733730fd95b668a95604e0c448ef164b9cb7659f259db730a296aba0b2a9b"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/22d1e58b-3ee3-4382-80a7-589abbd6cd98","questionRevision":"b69640d0f69dd4f5e926d90b53580c36644ebd721fb25d7680004c25ef1745ef"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/db025321-5bc7-431f-a313-85fc570c9add","questionRevision":"a54bf8c02ea87c096dcb15994a2aa13bfcde89ec96b5c469197e360f8803a92e"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/4cdcca08-6ab1-4648-84e5-4a4455c10f9c","questionRevision":"c79410a5dba01ea33898659d9e0645129990d94fcc4960e1ac4830d90b0588a4"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/09d9379d-630f-4222-84f5-bb3881af267d","questionRevision":"a7c1906dd3b0063306bff2136ba65413aa1b108e7385f632e4894730f1e550ec"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/7e42ab57-0ee0-4aa2-88c2-8b2fbc69bfcb","questionRevision":"1a271b3896607a1502e9aff37382736d3e81bee7be3efe68cf86c6651b26f1ed"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/0896f4ff-c9c5-407d-b2e6-37be621d8571","questionRevision":"945a3d21cf37219040f9e3bc5c1fa03c021a18a69de18c038289734526af8b01"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/5a912fef-5aa2-4fb9-bfaf-6378d8bb1a3e","questionRevision":"9b5d120bdca09320891cdcdade5a470646934ad3bbd230e6cb33ffe605ea0afb"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/0e6bb3d6-9903-4b33-8125-2ebdf34e44fe","questionRevision":"56e9d3348a210b189e6cba58c53356c879835dc086960877fc8fea46df389f8a"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/058ee206-976a-4045-8a72-4eca2d430ac9","questionRevision":"837da248c6a957a5a108f909a3bc2f23ab7ebabf5c730098ae760d4be81357e6"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/1af11e94-5ad8-43b3-990b-2d7b5e71bc51","questionRevision":"d46498a929955264997f49ff008a4590d6e011f93df49e25655006871924c8f2"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/9a206dd6-f22d-44ed-a6cc-2a87e02b10f2","questionRevision":"5596934740390529f57ad0ee4bb354fd33898ce81ec6dbf034fd009b555553e2"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/ff60a84b-09bb-46f6-b4fe-c42121aa85e2","questionRevision":"bd0f25425d26198909ba1f0c1be5c92a1e1383b0fb9e138f8fa595d900bf0ce4"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/54b200f3-8b4b-40b8-8bee-f7c4a227700c","questionRevision":"5e24d9824d5b69d7e992597c441b726392a16c12b5531d404d8ae5336af80ca2"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/e6a1fa6a-d451-44a9-94c6-cc051b588ad4","questionRevision":"65cb52fb24ea31854fdcb6a8e76419dc99459a45cd95cd21f0fd84d1d5fe1d23"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/dc01cc8c-5dd5-4f59-8671-d80562e203b7","questionRevision":"94328d924274fff0b8d9cf9dec0cb445c0277e0cd21c80f437e5b842ecb06604"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/bb43e9f0-acd4-4071-a21c-2e9202c51029","questionRevision":"f038c951d6d10368330a17219e786a308ed289c215e9392d2c3dc4a0efc02faa"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/ca57e3ce-b447-45f6-840f-bc20b265651c","questionRevision":"60d6f4cf1dfbbe9308a8a58179424c59b09b676fc2b2a64c6fb668907f0037b7"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/f04e604e-4671-424f-bfd1-7f9f0cbdab57","questionRevision":"bf27bd4bc4da8fd0308ce282201b8ed5cb73c4e4601e4a5b8f03854300127440"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/0c22ebe3-3bca-487a-b4d4-711b2a71ce1f","questionRevision":"77b83482349ebf59ae3034bef4b546fc455ca814e1b902ebad9163153ba80f85"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/55851ac5-b389-40bf-9e7b-4469d741c1d9","questionRevision":"3d7b70c4e90f7ebe4bf81f5920b60ce48bf666d7f46beee41233f01058fa5389"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/15f8cb2d-3c16-4b59-9876-8b795a021902","questionRevision":"18499a2f4771b3daff7a0340e52b4555d92a437cdf7752902d41e62b08f9235a"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/096a8455-8a38-41da-ac58-08585533ad2f","questionRevision":"64759f630b00b65e22b1d16a9ecece96de925f8d2c4582669b058cb1a3dfb62b"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/e74ad599-d34c-4ce4-9000-0985a62dea79","questionRevision":"c3b45e3e7a83a1cd21c139e19ad8df1efd5416de934f3a499a5469a427878105"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/3d45c60d-6764-430b-8dd9-d6faaf685afd","questionRevision":"796e83ec5c23a55dbf18b45198169144d6700f46c4c6083f4b248ff2e8981cc4"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/11b966cf-7394-4de7-9baf-0359ed5349f7","questionRevision":"4658cc6654233ca0b40dcec994ed80bbca78f841a9975ebd4005f844fa6eb6b0"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/52017d67-b348-49cf-94d5-65f4c250d9d8","questionRevision":"40441cca99077232239b6b70411bd316fb0c27bb8accefffd7a43ad0e23593d3"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/1e03b848-55c5-47e7-9e05-28614d6f3e92","questionRevision":"3ef5372200fecb63980a494fa36ee955ad8c1b65ce9191e914fa7de6ef27521e"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/495154bf-4d31-4ffa-be1e-fd4e9cadb24b","questionRevision":"9809018bb2d45a18773ad45eb77723976210ce9bcee0d1683dbd06fa0f55ba43"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/026e0067-d0d9-4158-90a6-0bd2fd5ca0e8","questionRevision":"d1f541a7a56849813f1089e4ea17d426edbe6bd48d439716d73ad5beb11a3145"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/39ee0af5-83cc-49e5-bad0-d167f88ebac3","questionRevision":"ea37d2e56ef86874b406145bb74958b54b34dc6cd88ae35c6492e727566c374e"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/ac376de1-3329-445b-a341-931abbd53c77","questionRevision":"e9c746d405c476628c21bdd4ae39b2a1973d67a1e4ff86cfd4f422a5761d7d25"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/c8d776e2-54b7-4a0a-b5a1-4e1b4170dfbe","questionRevision":"b9a1a88733dabf94bd6380f6cfdb07d2fd433892466478b7ffec595890d2f8b3"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/06714617-3da7-4262-bbb6-3c750f849356","questionRevision":"e0013edb7a69c014c1fb442dcd663130e76a0e187a492e9f821f26c97dc25673"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/3637e1af-206d-4491-885b-9ddef3170853","questionRevision":"0ce828f462a4d685980873fb641a50be9b49e202dceec88586f52395cef26df5"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/b04f7580-3a29-47c8-a706-d946566d8d01","questionRevision":"6afe6c32f73c48f4a5fd41cb9abe0ee89ae3096a770bc16b40e82d7cca2ee689"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/c03fde22-0fc5-4300-9c5a-670c79052ef2","questionRevision":"89b274eb5ee7ad49c80175a2a3cf5dd358afa7e18c1d55f760676be485e70347"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/b95cc8db-50b8-456c-9001-0be3e4fc8838","questionRevision":"78b873f8b2f8aab423b4c32a7fa20558bca45e5b66bd04b4f671ca55e6db28ef"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/8f305bad-01b5-4a4e-a372-e11ac3efd165","questionRevision":"12e671ef9668ba54b18613de1dacb071b4d478c6cc9966ca9077a1e902bf175b"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/23ec9610-b697-4713-817e-5cbe46d161bf","questionRevision":"6e118ba7e86efacfb7152c31bc406610e61480c01a0a45988890190a44cd2113"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/571e2539-9e84-4714-a99b-2af361097971","questionRevision":"d1f44934f61d4d7a68cffb034dcbbd8cae009b59f04f80c2d1b31669e79cd3a8"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/59c7a436-573b-4be1-994f-57bae5b3caef","questionRevision":"24215bd8f5b9e69acd2b33b5f549eed4ade6056c69a353eb1ea64adaf170bdcf"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/2d689eb4-846f-4900-bfab-e7165e67ff65","questionRevision":"2d50fafa170dbdf0752fc5e11a18b12b7a353f657cc7a394b9510636899004cc"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/f86ad8f9-c976-464b-8cd6-c10638265bd2","questionRevision":"949a9c164c33501d05b4582899eae6d8b143f80b675f12357d9b7d11d8c19c16"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/3aa89d0e-f6a3-4189-bcf1-4b487aaeae5b","questionRevision":"677b9a10fe286424ab223ec634aaff3c86c39a56c6a7451f996f28721782a66b"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/1a91a01e-6296-457f-b07d-3dc29c57eb58","questionRevision":"ab4e1c9abe59b8499163c0abbfbf6c59e8a5bc0312dfe39f9b38e854b0ae73fc"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/a6c9d325-cb35-43af-9e11-9256a9d0a371","questionRevision":"a2f129f74eede9aac02feaaba642db42bd632a9c65519a67200d6ccc21a0f2bb"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/2ab3f637-fc2d-4177-8688-7d76a786a25b","questionRevision":"ef16723cb2a857807a2d1040c2454010a4e28c1c0e4a3444b542c787ae343f45"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/0903c002-25f6-4b85-be02-791bd88c611c","questionRevision":"b590ff459a7bab1edff56f5fb58ac088e14efa305132734fbf39bf92c9c21d0f"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/58d8c9ec-da49-4c35-b78a-b813609102fb","questionRevision":"822144d7496c4170bb8c0062b107388c8c312f10975946be3177ca8988bb1732"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/22c4bdb0-6f07-4f57-9ebc-7305f157b10c","questionRevision":"494df626e5ce5a82feddc7802acf645d3a5427f5ef98ce7ff73582ae3c9ea2a1"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/cd934a1d-71bd-456a-9cf0-fb7a4517269f","questionRevision":"c7f0cc66c9483e480e784783e6a7a241b52edaf1beb8764891d60269c80b1a49"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/ba7f9840-b0a0-4404-b91a-512c6bbde2b0","questionRevision":"250ec7f080dba2b1b5c8c4f20bd27cbbc34684fdbb572afed45299c264c390f7"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/964b550b-b9e3-4153-b628-d610c21b00d4","questionRevision":"4fa438d588a4c5d3cbc4ca7266e20db0d033139feb20fafebffd43d0fe0713c9"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/bfd372ce-5528-40f0-9575-15288218c4fd","questionRevision":"27655fb10faffd26b5fb51f50e88aa14a9997ba71a5e89c5a5820a76daaaa29b"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/30fec863-3b23-40b2-b251-6b18ef2dbe48","questionRevision":"cf0d9818e642de551de1d5d2225eaa292a0d9302f4aaf17330a9ba20ede7becd"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/551bf923-afbd-4897-8077-38f7cc89c790","questionRevision":"3c69934dfc8ae35e0d8a01010c21116e11809854aa1d5160a4393786e8c71101"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/a8decf68-ee95-48af-9c65-e12050a8a1eb","questionRevision":"9fdbdb02bf77790e211e416374f6b229cbd1f7a66721eb2684fba7c0d1d3e601"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/20f322d2-849c-4035-b733-0f14a07483a0","questionRevision":"35ecc136c33e297a0f3d8c7b415ac42e6d617400c5430e59a21993149557fbb1"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/8f6986b2-4a43-41f7-8604-9ef60140ac82","questionRevision":"ea68f182d0d8dce513bb98ab91faceaacae30b8ab16f71310a70d1a6c754ecd2"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/747d0847-259f-4d2b-bcdc-5cfcd124ef4e","questionRevision":"708a8e7eaafa23e4959516f3c475ea7b765b1150bf674af0ed18991a4b0241ca"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/e77ab8ee-1d58-416b-907e-341040e85c13","questionRevision":"aa05a0474f22308c0d8b8ceaf0b34172a1c8899ac80a9fee5e20bf0183b046a1"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/272b9a44-51f4-4218-aa29-c77d51a85470","questionRevision":"1a476081358296b6f86ef5a05cafdf12a007a0d5f960cf6bffa17ab2caba007d"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/5067d265-b120-4c68-9ad3-aa342d247618","questionRevision":"5f741b82907132df8dfdf34c7a288690e82427f3e3ac23d7c6e2fde8547e110d"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/111c623d-98ed-4864-8a8a-706cccb12bf4","questionRevision":"db574075274904fb6879b59a113bdc63df0e330d406708d9f3fc22b7e317704d"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/d635a59a-0208-4a7e-8726-81740bd79056","questionRevision":"29060df1f332d4f0dc32529f48909a98726f17c2ae4422b2c6e729847858dd79"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/062f52c8-5727-4bc0-a69a-8832451f41e4","questionRevision":"216a81b825469c788b270daedf0c65834555c3eec573bcede9fd641683a84730"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/470b6274-4463-4035-928d-ca4ec93584c9","questionRevision":"fac1edd3c89908849cad5a35140d658156f001ca8f646f41fa07a2a5b13574e0"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/ff81c6d0-3b8d-4300-b8ba-21b93a56b171","questionRevision":"f1e6adf57839fc8502fd78416513e1408263b2289c7302200278d2beedf4bba1"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/e7d6bc99-f731-4534-aaae-5a7f6f1a986c","questionRevision":"807a90fe5434e9447349f22110a9a65ffd37f06986f33a4ca86b3afabed1fc10"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/9181c30f-845d-4818-a833-03565c2fd024","questionRevision":"3c28452722ef7d853eae04d03f4fe537aabe73a3168e6d1195d6ff234b5770e2"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/8ba2d1f0-2b1a-4d5f-9604-70a6dd21e141","questionRevision":"c465c19f682e2229f717f3a8c877dd2db1bb683732b07519dde600f53d5adfcf"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/71df7830-2e41-440b-bb77-fd5fb1f7522b","questionRevision":"1cf05730c62290d6f21855fc825d5e61d8f791de8514dbd774e25c3546883b89"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/62c5602f-c864-4c5e-90fb-b0350866843b","questionRevision":"27c926b39ad0e104ac7878d66129d507a789a44e22ec387ed9b07f39e4571a45"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/405515a3-13ec-4ef8-ad4f-b01e8534c3b2","questionRevision":"add6cdbc9ae388195c30aaecad53ae2ad3d6b9095e65add2265ee4f03fe1b2f8"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/7fb25118-2e5f-4a22-9fe1-dcb7a7ea6b00","questionRevision":"ff86ff191e2465fcb7707692bd5a0eaa3baa7ea3521aba8754f528e6ba52e1ef"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/47aebad9-0f64-4877-ba05-a82da8e82ecb","questionRevision":"3f6cf90cc811012ba7f9df6d0ad621af79126110ab0ea5be51f61c7c35488365"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/1342a207-40b5-42a1-857f-9c0777536ad7","questionRevision":"fbdbcdb19587d21c238f2c6e28214601efee5b02ab1f8c393952785dcfae96cd"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/dfcdad9a-254c-4d58-942f-3fe585e43850","questionRevision":"f62118e2405cb5f9975ce0624589f7b1d39ec3137d79df41b8a027839cefd032"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/d3dc4e71-2531-4a63-baf8-50825e1d5808","questionRevision":"0b6db481d14ab804f40bea96a186181e084cd3c830ed162608104ed1ca060b65"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/bc7b222a-08ce-4bb0-a0dd-b56e23a8945a","questionRevision":"3f599cfe71289a49e9b6e55f09aa9f828ed0a1a0c6710a126483e71dda401fe1"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/3ba91a88-36a7-4d21-93d3-5911e33c0f76","questionRevision":"5f058b49c48a7a5a34ea4d52985b70a78cd6b0791f9ff6c716ad55ea9a2fe938"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/289ec9b1-0b3f-4f4e-b24a-2a2acb1c2c73","questionRevision":"ed907dfd595d9a955399e299a057574cd1285769bc8961fb20b730c64b40e6fb"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/f12120f9-a389-4cae-8c14-32fb1937dcbf","questionRevision":"ca4441c5c16ea4f5038c9b13cb76cea481efc762ee699916286c319cb6cfa03c"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/29949ccf-6445-4ba5-ab14-6162b7cc1517","questionRevision":"981f988d6b9d47e81b4d7070b0a8c2d5b954453b3e2907fbc253f21454c1a58c"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/e9795a83-02dd-42f7-b521-5abc82dec3b5","questionRevision":"650b3094995c9a9daec0606e42b1de929ac27ee15a77ac9665e02a9cadd6d45b"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/f05f7294-b2d4-4d7c-a545-e78f2c942a39","questionRevision":"8ad8ae07ff36b014ff1ca511d2d4c1f75b3c4e5909b7864c9b235bc54c9ff7ea"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/7336328f-8f97-409b-8dad-53e1b2898bf1","questionRevision":"739cf5604488b4074ca93623e95c8b721cb6ee57a61a67acd78258725bcb1ff1"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/18a8d6da-dd43-480c-adca-f8fe288dff03","questionRevision":"57c359fbec68a3bbd5f40fbf5598ff29cb9b023a258b34cd41740cd6a1587d7d"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/1a270529-65e7-4086-ab49-70fcaf6869b4","questionRevision":"3444f587067129a51ae8e68fd7850045eccf496c1aeb5c951ecb698032d4c17c"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/2cd0c19d-5c0b-45e6-93d5-f6471364a0fb","questionRevision":"e4a570401bf18565fc68a7e2768f98087d467e87f05f1b99508271168f17bb20"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/1a0c9217-625e-492d-a132-9f4cd8ff54e6","questionRevision":"45703af6a9841f14185aaf1c2e5407454e79978f6e8577ca88b39bdabe9af97e"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/c367fd32-506c-4077-b056-ce8c508eb8d8","questionRevision":"925f5c8bace2e300036fd54f620279a90041e95f11be8c4d4d87a8be733691e5"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/082d96cd-fec3-43a3-ab7f-c4165c605ec8","questionRevision":"cc33557dfbe3aee15462e901fdbc2a405827300f92f9a8f3afd8b3f455837802"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/631d41ff-bc7b-4bbb-9b6d-f2e7fd68eb35","questionRevision":"b3b6e949125bdb1195b42ed5cf7e62386d5d49fda99c873a6fd80ca4f88dc061"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/fcf51e4e-5cb7-4111-9306-063f4f86ad6c","questionRevision":"e8355a053a7d97bed832925a4fe057e9f4863b7db4ce589ed694db1f4bf68541"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/bd5455bc-55a6-42ef-95f1-89926b72dea6","questionRevision":"6511ea4230245daae5222d37ff6ea451771ff30e3ee9b313e718809b3268ee3e"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/c44b30ba-e5ab-41d9-939d-7920bda7afdf","questionRevision":"8b97bbc5d2c0d6470d4420d16491b6ad82533473539c6f9dfa5bab7a1d2b058e"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/1af880b4-9507-487d-bb71-2dff2b2da097","questionRevision":"666a88272a60490aa174c4cfbfb6ce9ebdc6278952e0fc10a19be99168005a89"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/99da86df-c0a5-44c0-83f4-b54ddab68142","questionRevision":"ac8a959fec37a080399babdcf25eee513528fbccd97c3749c5db08236a705a34"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/8b19c36c-487c-4f44-8d33-9e3bbcd78322","questionRevision":"5a0e2464f0619bb87b3251297925a5fdf6ed2d7c12d2c0030e729661cafd7603"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/51543b3d-45ec-45bc-8c7c-e9128b67ec4f","questionRevision":"4f8fa1453fc333c1579593c0dd3b976580ecf86fb5320713b148f642b77e8c0b"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/2d3f679c-6dd2-46ea-bd5c-1965ca1f6844","questionRevision":"cd1948f1d4c3bd20458cc1f46e57100c82e22d383858a6683fe3f5f3d670389e"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/c6936241-72c5-48bb-9e11-d59c2161de35","questionRevision":"1f8d71e97971eaba89cbb4cb801c2de47014843dca21c1140fb6f7ad8fbcc98e"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/737364ba-1c26-4b4c-b7b1-5bb10f8b97c4","questionRevision":"1150a7260c2030c8fab233a3ab238fb314b68bebbe218f4b97a3fd5d43d63882"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/10de6ddb-d52b-40b0-96ab-98418394770b","questionRevision":"a9cedd14b4f4521bc8eaa6296c0895ca68c3c6801584e7a2494d8088a6cd279c"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/df2ea2dd-5ff4-467a-91d5-eeb1da631453","questionRevision":"80b5439bf3083391873e8571a4e62ed44ab36044be3ab2f8ae19ae25bb850e84"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/a10b325e-a44b-46e5-8f1e-59305cb77e6e","questionRevision":"3df332ebe7f893fb04e8003f6c70f30f114c920b663129ea13016b871f6c9686"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/b411a87b-a481-4bf2-ae69-762e7f9abf2b","questionRevision":"c98d0a81c67c72ef04533fe41efed3415929b15f6fe84f3ffd9dbe8e9ab62a5c"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/e6c3f51e-b5e2-4ab0-b2fc-154c817b5825","questionRevision":"bb6a4a8e0f7d0bc7cb667263a20e59f609038a27e5f40cb540a417bbf1fd8256"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/e9fd3b75-0b1b-4b07-b1c4-ec457eeb1c74","questionRevision":"4feb9968f882017f64cabb2b15f23c467b2369de1c37716af3213e405225a541"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/4d185149-b0f0-4388-829f-4e58043a2299","questionRevision":"2c21dfcb57fcdf3e0fadeeaeaa6f110414fc2acc103fbb5a842a29c5fa61fc81"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/16204ae6-90c1-4386-a182-787125cbd8e9","questionRevision":"174832e5b5425e95802762b98dcd7b8eecd0cf993b22a427085440c562b3ac2b"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/4d0fbc29-ca4e-4e7c-aa92-c12a0b7c6530","questionRevision":"913dbedacd5f125f8cb4b4823fc7a1efb1afa037e6a13b59afea2edb316d4a80"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/1ace38bc-a1ea-4df3-99ee-5466f0b942da","questionRevision":"657b5992f52654aac1e87d66545be4c0283fa1cd7bfa58dfc5a52224d20d0b92"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/36063a4b-a4f0-4398-ad63-da3115dcd22b","questionRevision":"916c62a1a7e4223af7169be2c0ae51a4a0fc6890bd857d0047e60895b6b042b5"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/446b03c7-a86b-46c0-9bf0-c6d9442842dd","questionRevision":"604f5ba49f4cf3d55f1ee89c50bfb1234b62f8b3cbac4c6c3c406437cd483e59"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/d238339f-6d73-420f-896d-1fbbd13e6cd1","questionRevision":"a08e51c46917571e9b876d1edc5879ddd248f52aa4ab0c0be2859ab47d660003"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/06cc5b5e-64d6-4f71-8f73-a3d8e5aacb79","questionRevision":"204de735f818313464abb179dfaf3ee09cef146296b76a6ec2ed05b0e619c7cc"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/dfc03bee-c91d-45ba-92b4-d0c2e094aa25","questionRevision":"5bf34b1fb38c966a9f4027679cb23ffefecaf0f55fd42b4b177a31921cc81874"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/f33abcfa-a60a-4d59-a0c6-1a58fa832e62","questionRevision":"bf56ad35d66626fb45761a5473702e021f9a09cd1d327d7d738e7344aa0de825"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/b8f0524b-e032-4158-b04d-8688d979b21a","questionRevision":"faa75088ce6c61aadb700dbd52d42e7037b62aa1b9d21a6733f424907b7e12b7"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/bf89b8b9-2df6-4a8c-9a51-7a9d6b2e043e","questionRevision":"ef82a5d6e82a96dec508f61b8fcb27545bd2e124795aa8f2c3e7e433a1edebb0"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/8e732808-8070-4d96-9ca5-d0bf063c483f","questionRevision":"6aa4352341094efb973bb6b04330b58905f005a511dec17f08123920ad4ab3fa"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/43e658d5-3b9b-49bd-81db-494b22b0a734","questionRevision":"fec198c5f2072371b8ac0594f67f972c1c77ae524b8979dd362b69df0f5d5064"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/e7246361-61be-45d6-81ea-5fa555d3f1e4","questionRevision":"a210e67635af15ef2c49afc0d409d5c87b807823387deb9532b619b93716b51d"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/67182f49-8713-45c8-adcc-222136a80c04","questionRevision":"3ed197f2265060eecda339395b1ef94cddfec64acb9d15b79a5af16617b98452"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/14c44ee5-1cce-491c-9ba3-7b182ffc0086","questionRevision":"034b95c64c350ae590f6644b630169dca6348e1336523d3f5b2b58638bbf1aed"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/c5d05dab-6b42-4599-9f91-dc382003785f","questionRevision":"6f2766d6c04c13410ad3bedab7018d124632772f6efe625b397961bdf2c5c8d6"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/e2b0dfa6-3a2f-445c-bdba-190899380dae","questionRevision":"cba6563afc9a5e368fde2cd93c1ccfaf01acc1bf96ca134d2f1c221da60c29a5"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/5867f366-cf3b-4b4a-aa73-91f4bb8681f7","questionRevision":"ec2ad6b46e00714a04b1d363ebb95039a647f3c6f1aa26b8eb9e3bed75105bfb"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/393c9383-4af6-498c-a173-e23e896f0d38","questionRevision":"7d8940aaab335eb549461220a5fc49b6a12f9a7b01d6c21389f5175c874c17ce"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/827af8a1-c718-434c-9207-2fd437474620","questionRevision":"7334ba0f5c46d9b20c414dde872124fb667ed89916b63a2471f939500f965627"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/0cdad4cb-52c1-43b2-9beb-f4bd15c414ee","questionRevision":"15a936dd0f4fd5367b32a2c287963a4fec3245978c1778b60ad0a8ea5639b941"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/e0397825-a469-4b75-9ef0-5b12b4675711","questionRevision":"93e77ab68c76c40bd0d25887038316ce34ddb8a9f70f66aefab0c23dac7f981b"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/70ad1db4-071d-4296-a180-f15ab9888450","questionRevision":"0589ceb1384f841452582bf9cc6e56ef41964b9bc4b065598652d038628bcd08"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/fea15e12-6a06-4d39-ae63-b9dd4cad0caf","questionRevision":"80beae0d33423099bc5598952e0930f44993b70659746745c55770c7b2785dc0"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/6575a6f5-f3f4-4c6d-8193-502ce6c92f01","questionRevision":"825a830ecc4ff2bb0d75bd1227247b3a0ea2d6f36d160a62d09e44b9dccac52e"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/88ab4a5d-709e-499a-bc4c-b576191034ab","questionRevision":"8a24f7b13d8cd86455aaa488ec259a8613ea840a24e81a3b0c1653af54a3bcf7"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/e615792a-f21f-43ed-936a-2f2d9046d476","questionRevision":"abe71987928f9d0b7c73f3df6f8396ae79c2d2f00744d371594d2933577198ed"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/712a8513-4762-4668-af7d-30b9d75582c1","questionRevision":"1d862503902f50ef2baa873ca943bf8727973d76098ffaafb8130047bd74bd10"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/50041fde-cb45-44e0-8f3e-10d994ff5aad","questionRevision":"014b0ae6fac90d3ec968c0a9bcbab0c5d2f68cf52bd09f83433a6c7f482dcb51"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/03a94095-be7d-4fb8-b60b-be3c78ed595f","questionRevision":"9850fd72ea3f9b14422397041759f4b4b839fbcb83c31ad351ab48360444fa49"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/81347464-2d64-4269-b18d-c5c170827b4c","questionRevision":"fca8696de877c9f595ab9011ff21f053dafb1971a21cdef3305c44a40337d9b1"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/1c195236-8f4e-4672-bcbc-1a5c5036b2ef","questionRevision":"f654a994cdc3937ff839d63819fa1a24d4743a87f0ed6790ce983f68cdcfdaf9"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/9f029feb-42e5-405a-b814-29a84cdcb1ab","questionRevision":"57c7385d95dc40ccfe1f9d46b0ba1fdf32fa05927876827dbe3b7111c262be2b"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/b875dce8-d013-4aba-8a2f-580e3fc805eb","questionRevision":"ae3545a64b1a2414e2cdde6c657da32f9bbd01e6d52a5f0edfd28ef3f16ef32e"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/b3d83aa1-01fb-4a39-9eb7-2201954cf67f","questionRevision":"f80d3453154b65748740044ed6822bebfeb0c4f6e33b3588c592a263d73ff992"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/0846648d-e685-4a04-bb75-194470919620","questionRevision":"5096126eb67aee3b9a4edfba19e652ad7c0d180ce99284ad730313e7d42fb10a"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/bb35b9eb-0858-4bd3-9924-5df908953890","questionRevision":"544d829673fa5c3ceab8f3daf8a10d409426013ef3393589a8363d9732a64100"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/8ec3e9b3-413e-4945-a928-9e6516d7cd2e","questionRevision":"f879bead395c6e34482719c39c012f4d37f25b0af61550f005cd0dfd0caa1fa8"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/131565e2-13a3-4053-bddf-387343e5aa8a","questionRevision":"2065f9de83ea1716a36cc64cb7cf03950ad271651d5b27b9065463e25cf6eb79"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/2a19672d-9a37-4211-8d73-53323fbccd3a","questionRevision":"74a15ec080eedd34011a863250c74df0d4fc54981b120d83a9c8098f99428dda"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/77d0362a-f31f-427f-9498-82983764e1f0","questionRevision":"366bdce25870260ba97c8dc796ce3c994bbe78c7996e44a9955f8e19c1e820a5"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/073f5c04-c175-4cec-adfb-399f40b01884","questionRevision":"a8f78df75cf595f310649ffa8ee81a7ba08a08d7afa8a4473fbdc1fa3ffec8af"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/fc4a0f9f-0f3e-4893-adb7-f7e6b9548372","questionRevision":"02ae15cae4de9893adc19227d2756a935b43d37f6457961e56aff8452aad07b3"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/8d15c864-f301-4e4c-a180-97c71d0285d4","questionRevision":"ea56d62bd60afab74c029b620f17e6830302dcb8cb405a85bdfa6ce590f38fdb"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/a058b5a9-9bef-4574-8724-1b327c12870f","questionRevision":"50efbac30a2323f971d28b94ada80aca5e387791b4b38a7d41daa7c3aa6374bc"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/da3f9d84-b3f9-4149-bf0a-93953cb565e4","questionRevision":"918acee67bdee62c15377058c59a129348d2d8ef372da673b552105f1b56df89"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/7e8b19c1-942d-4e19-8d02-666ba2e87bb4","questionRevision":"8556d5bb12ea5e848de57899ad5318e9fae2e932d7f09bc73804e09f19ba8433"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/3a85dc56-e21b-4387-aa2d-2fb0d3186fb1","questionRevision":"c6d48a8f7ecc776df314e4532f43d622c1b2e01b7804dc5ea40206a33bea598d"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/40b42910-6390-4485-91bc-53fb6bc4cce6","questionRevision":"a061f1d1c9629ff0dbf7f08684d3a75b9705944489eafa698427367fdb45aba7"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/f4c5bc0e-a26d-4e53-93f7-83217df76f17","questionRevision":"f6cb5c3e40dcfa67204494f74905d2ecd87576577e61c0d43dd4cdfac95e9210"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/a99ab980-8ba2-45ef-b8ef-98775501142e","questionRevision":"2c947dde8550f1e750d26d6faa0977ca1450225fc26459e970db7b4282edef40"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/1e8ad7af-51a4-4cd2-a514-8846a479816d","questionRevision":"18e787f0f00d31a9c7946934fc88bb3476bbac21c0e69331372b1476a806e5a7"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/bc5ef437-9e70-4e16-b397-8b44cd14e616","questionRevision":"13445de20506c2ab4eca42fb57671a5bbc1d3fad4882eb172dddc3118eec4e51"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/32e20a58-4cd0-470a-a782-8f83aac25e96","questionRevision":"488408e8564c0ffed8102b2f7296d9e9d42aacf8d7bfe7967e139405a738ea8c"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/45098865-5aa2-40cf-8a71-f2358ea95c6f","questionRevision":"309f8ea062bfe5b5378b91172c60bf3ac3f9633145a9d9b4462b681aa6684f04"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/d4b4ed87-2c7c-4079-b9b9-b3d893447347","questionRevision":"501a6eb5bbbc4aeeab58f7e5a4df6c2355ea91613546b0f864adee7fc0f95d08"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/e1e942ca-4444-4389-89f1-d9c8c943bf10","questionRevision":"183ac37314b22ee9748b808ff2536da82ace536e2b6770c00ee41999c3752c36"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/6dbdbf78-6c57-48f2-86c2-74e9a5398a19","questionRevision":"0efd4a7632c47db95d34eb0245a30d76114f567c65523b3c8d3cc7257a2d0ac0"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/6218ffd7-42a5-4d04-910a-c4546e617b68","questionRevision":"f2e3c7170862fdc43180fd47a69429eeea8c998138b7cdc17f3c1136758460f3"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/b71934fa-1138-47e7-9aa8-edcee5734b51","questionRevision":"aa7ae2ab2c00a881e36f4946882d8556cfe7ba11f5848d474fd4f4d7f399c1fd"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/42a2a007-829d-4771-a84e-bb1622486395","questionRevision":"34abdfa23e9a4df23ca556edfbc8b291de916c3835025419ef9147491b2f0be0"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/7b21b4bb-054a-44d3-83ff-04b1c53ea11a","questionRevision":"c6149a4b271c03218d84cdadbacbb83d113d833d52bfc8af362b78bdcc9130dd"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/c65e4372-dcba-4f12-a044-70ea2fbb4810","questionRevision":"defbd862e38a6fde2317c33f9af5c3d7fca77f56a24fb26c03a06ffe57c0a6ee"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/1ab3e6e3-f813-437d-8b4b-11c20c76e96a","questionRevision":"412635f8d49013be75bc9431268d133e0ef5e30897bec1db1b11b7608339ab2f"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/48650122-f442-4cd0-9955-3f8998d11c4e","questionRevision":"44e151d348ef9e483c132088a8042d5891faef720344c1b79c3b04cda1e25c86"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/8c243a69-46fb-491b-9557-ab5c507df30d","questionRevision":"3b9d9978cad5ee4427e9435346d3f92d0b36eedb8474e6eaf8f966df311f82c5"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/20d4bed0-8457-4eea-939a-bebc77cd392f","questionRevision":"5fb32bcaeb0951b30b47efc10d5f229ced6f816737727b5e571d71fe0f9756b2"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/500ca97b-ccf5-434a-b68a-867108e600b7","questionRevision":"92a0d73a2218d1d9391a62a94d11325a40d37663c64a887cbe0fc0e0d5d5155e"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/3d45e5d0-26f2-4cd9-9785-c0bcc85576ff","questionRevision":"e3afb015bdc3ecd79da11a716b9fc2a1f0872a0a3ddb70801cf2db582dff7986"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/e636eae1-9c2a-4e05-b5cf-7f9e01b9746b","questionRevision":"03d47a0f5bc87952d1ce6be1d245b6bd3e5b0956486d130247554c0eca916bb2"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/a99af4df-03b6-435d-b0e7-df7b0b782898","questionRevision":"f9bd752dcdafde46ba43a32527fc8a188924750b0eeca86920364be5906134c7"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/6b27245b-cbc2-401f-859c-584193cdada8","questionRevision":"e8a3e64a1395af707330ebf6690f675c6451fdc728d066ea423fb4d73303ca56"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/c717016b-42f8-4ad1-9ae0-0e3337b17547","questionRevision":"6355c2d23241442faa0aa27a0ee4b839abe4d12dad7fe05c56dece0364f06068"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/4622861a-1f7e-4468-b4f5-0caab8a5046e","questionRevision":"17a11edae5f96a30928f049c6e343d6350d70f22289108780ca10fc60542fe54"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/a63d251e-c69b-4e81-b885-e37e44cbbfef","questionRevision":"4fb3532546b3c0570be15ee2f4b77251d57fef3c5a67e5a459f66be59fd1d22e"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/89148ab1-21d9-42bc-8b1b-47ac56a4e2d4","questionRevision":"eaa8c27c832a6b7570f64eb2014775dfba8a82966d09bb56871c8f3b1db60cd7"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/6df5b072-b529-42f7-b954-2fc09dd9d496","questionRevision":"bc76ba28565c235163aa4c0ac40fd86aacd1f4cdb02092ef01d57a2c0f542a8b"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/1c00cc06-537b-4c1b-a8c7-0a7751ad91df","questionRevision":"6ec3b754109e3504e65ae770f98d19c7f0b084b388f9989503573e9ece8dba63"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/96a2bb36-eea4-437f-8a32-ec05b74d4058","questionRevision":"b9a50cba8c47174e0159006d94a7bde97a9501c47cd7a976716caccbd8355ed6"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/e8dee63c-3a57-4403-9c89-b10f066605c4","questionRevision":"d5d459d5d5512b914d3a15792ac88de525346aa9e4a77caf1f43dfd6b31ae977"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/fa6fcde9-4dcc-4a89-9045-6dc5e6049918","questionRevision":"0a516b15b141b18820fe68a74dc7a3c6383e236ed03dc3805c45603e21f1bccf"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/29f2067b-334a-409c-ac11-dc436d603f40","questionRevision":"ccdfdae52ec8a2893b16a37b5bd10d025fb5b4d62ec49dd109ae9298365ae6f8"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/da3c05e8-d881-4e14-b6e3-355a4e537f75","questionRevision":"0c9e14cc918cf9fb3d70bbc13c08e5baa68461f26df77a17b2fde883b5275cba"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/268789fb-8604-4381-aedb-192e947a9857","questionRevision":"e65caa9c2ebfdec7d1e0df1d9b65f399be4a2c375f4c501b5006a40d60ed9ee6"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/e0129b4a-11e3-41d8-ada8-aefc5fb71b46","questionRevision":"4fba0b10972f5fd9940de73e96a01425fcd1b5d00f49404abc8b970f64b69e43"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/9b085aba-9bfa-4119-a321-425903702ba2","questionRevision":"26f607483f617397860562cd1a79695f5555617b909233614b59663bc4d25159"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/64276989-ce1f-496a-ba92-39ee015d98a9","questionRevision":"5fbf785e4528e4afd056e92357fd299c9bf1ba994b6d8e9cd88aec464a76351c"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/2c5d7fca-895b-4066-954e-616f07229cf9","questionRevision":"f882c585c6fa419da5356abb10fe79e6a1b5378589ecab747138738365c4bd62"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/341edd6d-29c6-465f-b55d-62ea5065f9c5","questionRevision":"e3c3327de18c5c7c4b22201b5879775bed372d57993cb674dfff8277d289e138"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/9c3adf28-c0b2-414c-8c10-54296816a422","questionRevision":"02fb74c0a7c2d8c10736b6e3d41866464a7d0152816ed9fe5a7a5830a563c5cd"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/bc922aed-87c1-475b-b78a-1c7f5399471a","questionRevision":"a0a921d6944779355d87b0e7a19abeff23d23f4ed2dceb084eb585b5c185e1c1"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/7e1ebdfe-b1fc-4b8c-be9d-fd25bd673f39","questionRevision":"d83aa3d776f6c2fa40bc6fe544f392b839a3ee8cc30e88bbe3cc8dd2346dfa72"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/eeca134c-cc87-404a-b7cc-2cd34917e42c","questionRevision":"9dda784831d172c25a9a6dd4df903ba88647c25a1f19e58a6327eee8990b17f4"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/b28de69d-fb01-46f7-b4f4-2f05a97f23f8","questionRevision":"5b0689bfd1e02cb8aa5c47949b825fb6500555b7446c08c7dbb775049892061b"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/179251c3-fa88-418d-9e28-5b996cee508b","questionRevision":"7f89f4c820ca2600c25b92f4809f8960145cf354af0716c3e705f10dff06c10c"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/f1cae487-6bb5-4521-a4c4-4c7ed92635d7","questionRevision":"2c6d1239b3061206663ea71c9446e8600d9d595ab96adcc20635edde957e414f"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/7170c8e4-5a57-41dc-bd68-440a29e2817a","questionRevision":"695bf06d7e15bb1667d333b408c62e4e36ca6bd069f0b20a1093f270923ab578"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/b8f4dee4-45c3-48ed-817b-7bf6687209b0","questionRevision":"23b0ce961bd0d7180b6fe17ff632e9a745c6a8269c957bca1f6f8e898477284c"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/01e5b12d-f149-4ab7-b4ea-bc7d212580c9","questionRevision":"18cb562e07b576d682fb7737a7c7b0494d5f6cb83c674e00d3ed47ffbe304fb2"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/7209cad7-d692-406f-b3c7-ede2a1626135","questionRevision":"73120144544e76072528a22fc6ef5aadda5417f2b09566888d1f7de8f0570edd"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/49950cf3-5786-43d6-8e4e-babe96d5fdb4","questionRevision":"47eae8b1f3c01b2864132e83c8db3fe13f1303544593883c5cf1ec4b072c4d86"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/765dd38d-a06b-4a91-aebe-bd5d4facb5a2","questionRevision":"c8fd4b6d81c34f7f4a509af5f527a0115491e77e9e8cb67d4ee3898f7d7408ad"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/005b9bb6-5035-4ea6-ae2b-3360809d8c0d","questionRevision":"28e16e424b46f46d1ce501de0b46891931ce114ed865c13d6feec3d6567490f0"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/f68769d7-d3bc-4be6-8920-bd1c705a50a8","questionRevision":"172ac086e1b170807d5265f3715726415b1a2487131fbda0bbd62b08bb0d07e1"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/4729c842-ef2f-4aa1-aeed-50bcddcc5bd3","questionRevision":"be19890e17ef58742b09dc75618ee44d5cc63308c4f3915c135f259719be3fa9"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/ded00c0f-8471-48de-8f33-2334bba0f153","questionRevision":"049fdbe67a3ff66e564b185bed64f0ea1ae623767ee4c1fbe2d9672f2a052725"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/4010d595-cb3d-47ca-8e8b-d65414fb835f","questionRevision":"d13060c9016e007e92e9ebcf588cd56596bee911a6c10edeccaff781cc0bfbc1"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/6fccab57-8e83-4cc3-95b6-812a3fc6e568","questionRevision":"5363c32b3be1a34c3a50d3453fcba2e52496002a349a0bbb474d5785bd36367d"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/c42a677a-5b7a-4e67-84eb-79ac9621a4f0","questionRevision":"5feb07f2fdb868381de83abcf6796faee7599b59543ec40096b16e74b2a425a5"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/40fe9172-b982-42ac-9ade-12213b19a6c0","questionRevision":"b74883da051a602e1aa9d5a7844d552857125004dfa010b0e55a943202c3afdc"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/85bdd446-e2c7-46be-93b8-c43df54550e9","questionRevision":"bebe717611a420a07d336898f7db4de4fd8f80f0f31e0899fccd7683318ae53d"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/eb028f13-acab-48a4-9966-352ad18da1f4","questionRevision":"87ca2edf45f8e0e7dcd278e80b05596f7b75673efc71665445855a0e15b490b2"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/62d19ea6-7e31-4458-953e-5c886c0be1c6","questionRevision":"c351d4bde59eec96aa3f6126a18c9ec818970a68ee982d10c6988ee862c243a7"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/df2bbe47-5b42-4734-a757-d35fa8fc8c81","questionRevision":"b9cb18de3279b6c56b8a64b2da5b89b660233eced888ff2836ddbe10958f3c3a"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/4e41570b-ca85-4034-8b28-0194c813c5c1","questionRevision":"042735b550216ff2b97b90dd277762a46ff29078cebbc2595793d05971902acd"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/3cb3a880-eebd-460d-a8d8-025d37e14dcd","questionRevision":"bd27a10bc9e5a346daa4012d48325e04282c9a908f39ef158165eb4ba56662bf"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/85ec22bb-4644-49d9-a924-b873ba86b25e","questionRevision":"57353eef7da3e2da608a48bed04ac6cf9fc77e754147a54e751f1db2ed322188"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/ee181bc0-6b2a-468b-aae2-06fad2335710","questionRevision":"37bb8de269d603eba8de339e284149949dd0e2452ea7c3decb298aae8bf6c467"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/e293c8b4-24c8-4b6b-a947-7dcb96d78924","questionRevision":"87c65fab690cca3d231f66725f9a584c10f5473d314033911dd89a2c98724491"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/a073cc1b-b8b2-4bba-9d2c-48cfa5f21d18","questionRevision":"5c020a17d95c4648122038b74436e50154db00f15af1cebc6c01bfa35e3e4eb0"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/be02003b-9f80-4aaf-a4cc-f93511c8231a","questionRevision":"39695634cdb7086fbd070739cdb3459f407e82637af6feb05be094f52ccedad5"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/6ceffea2-8230-43ba-8472-71dc80db037c","questionRevision":"77e52d35a7f48f32e5160f9fa3431f77ae32c12993f3dcc6aada38c545acfc65"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/dd72b0b2-8138-44c9-b53b-1003a38fb62c","questionRevision":"500594df98b44b94f5af2b4c8623e0aa0adbe1298e9ef84fcbf4fd4f05205efd"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/6841b4d2-793d-496f-9c21-1e3d93977ab3","questionRevision":"7a26443944ee9fa7e4ebe0568de0f9538cecb701482185cd4ccc13e8813efcd8"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/7bca623c-0d0a-4fe1-bfc6-6486030d74a0","questionRevision":"0031cac9d787df89230b94bed6ec1945e0027f1fd2ba6d91b0e80c1bd1af9684"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/6b44220e-0692-4459-a004-b119e3ae43b9","questionRevision":"0ffc06166e7a402aa32115cee9137e9244ad6919cfe5a0103dd411a35b47190a"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/d0ebc4e5-e457-4ca4-b84d-e2a7764c9040","questionRevision":"44fbe89208872fea7d76458e9ebf502bf2728eb437c321294b18da03fc0594a8"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/f5c9ded0-1cd8-4261-a03e-925038db9fff","questionRevision":"2607b41d4bd1141e5a8a6bbe1ce458704c7da1c40f20c217307f25e46b7a83c0"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/0ef5048c-4583-4d0a-a579-559ba3073f83","questionRevision":"980ee2a3da97f0740509536004ba35ec4493eb82f01ff0d295c8b10c6892d3d9"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/3bd6038b-a6b1-47fa-a6f5-beef1eac7d01","questionRevision":"a50fdba31b8dfde8ad94b5c0a73405203526166b41bca0a24e86c679aafcf076"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/48854f04-a68f-4124-8c8c-460b32da77ee","questionRevision":"30bed9cdf72ebaff3369018aefa78681a074ac64b4817c92b7ef6f1437625b79"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/4013926e-8fc3-4e60-90f0-6bbfb91907c8","questionRevision":"49e5ec692283d26e9aab48207552585871122815f1bdd04fe9c46687175a24da"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/46a34c80-cd19-4e10-b36b-ab1893142230","questionRevision":"21e753ffa987b64c35ea487d68985222408b8b17ffa2be7103a32c744415eca1"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/d189d2ce-42c3-4724-a243-e68a1422bff7","questionRevision":"6297beb29d648d5562e76292ed3d97e21be34825509b6a6a9928ddf79be46d50"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/a0f780d5-9b19-47ae-bb29-de6c6ba404ce","questionRevision":"df870cae8d4f91286b435c9284ce4e07ed37f2c1e58ccf5325eb284876c0f621"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/10353206-71dd-4da9-8318-e752556bfa04","questionRevision":"9495b0c9de1d6240ed6a2976361052fa67bc8043e319a1d3d6c685f48a3f2606"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/839e7b1b-4cc5-4024-a060-0f316c3c6239","questionRevision":"ce397c0429469148154ebe4b01a95a667a51b76a52f97d57a83030cf9605d316"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/d71c5ad8-ccb1-458b-a2ae-aa7070045047","questionRevision":"db89696473a22093e224f0c8940e9d9723138429bf651802d3b1c99a7e860a66"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/8f69becd-7e1f-44b9-b93b-53db111b5e53","questionRevision":"7b3ddb6282ba166edc57032ef575ce5420198ff23a0e0504fff074900dcdd143"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/d2936d14-30d9-4cad-8c0d-dbc3465f7812","questionRevision":"20fc041e846f5c1d8e4f6fe162d7b1603066b88d2dcea1ccc8f6b3729222062c"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/762bb0e3-485b-4e5e-aa18-f88036f7f30e","questionRevision":"df24dd0eb168f77730c8023340adbaab292f7164b53074316c2d354afdd32b4f"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/5404d86c-4f7f-4f33-8574-acbce4e9160a","questionRevision":"80371e3cf6fcb7feb68ffb31db76a8b1c63f3c2801a04827808c6417410213da"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/b7a9dbc4-e001-4c18-94f8-965197e66fc2","questionRevision":"2b89f242e691690f893ba80e17715381b62ca0bd68618900137441723c12652e"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/75259e0f-d983-4133-8d02-68bb367de69c","questionRevision":"51e2d09e2881afeba7336c5d2cc0bf0fe04f44a35f1399c898e32c229709e27b"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/8ed0558b-c512-4f9d-a4a0-f06e110d165c","questionRevision":"b928fecc87c6573cdf01f72e2befe601fa472d5f58b4addb72e5c7e152dffbbb"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/4101b648-87b1-48eb-91be-a649f130c6b0","questionRevision":"67ed98bf4d0f9616b32ec3a8378df458992ec685fa83796367ea844500bc9ccb"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/3b22cebe-9914-4fe2-bd7a-62f9fcee1dc5","questionRevision":"aef48abfba5a6980afd4a188061a26fe216c843047aa2b999592838293841d7e"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/6646cab1-c79a-4834-98bf-6842c94a5574","questionRevision":"341da1c7e6b09fa9c1840345eb0e1a0c59d2deebfc3b998c41edbe71504964b5"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/8c0975d7-f8c8-4e83-9ff9-ecf28506da13","questionRevision":"3a62fe615b3641eb24cb037d95dc237320534e92b7cd53d270f5473714e59988"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/ba0571d6-71b4-4a50-8042-1a18d790ce33","questionRevision":"9c769360a49789d4e348d50db7fedd1bdb5005503864d0737f09434f33863d8e"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/e098c1f5-cced-4197-9fc0-e18050642647","questionRevision":"1c8eaff82a6de749c9dbdb3a347ec93f986c5304c3f044698aa5edd4d12fe86b"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/2e7d31a6-d7ae-4199-a3b2-7ba3172b8d75","questionRevision":"a9840309903b7354a0ef7b1d550f714826cdaca019e112df337c8e629f773941"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/349d6bda-ec5f-4d60-885f-50bd9bb616cd","questionRevision":"d77ce10744d33ebf02e3b20b9c943eb54f4ab47ac3256fd14c12c76c213c1de6"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/40d74b1b-0c6f-408c-87ad-0fca1e054221","questionRevision":"e5d72908a450854034b637dc5275eac9e46e6509d0c847ffa99662d08fe1def6"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/9d317fac-2ab8-4430-8000-73f44dc85d58","questionRevision":"ee64c48ed5f3803a6474d0ed201fbc835a5fd9803619c46193762ba93bf29786"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/439a0193-30bb-4787-8ed9-da43822160f4","questionRevision":"ae4f76bb22a1d12d79eb75c4d7b1cd0488bc6e8fc8b1d556fe90009aa86529b5"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/ed08f975-7c46-4105-b6f3-62932ae30c2e","questionRevision":"11f39284da76276ff14efb451423aac4e3fa7db8d154ce0a9d2a8b8ab4b22510"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/fda7a5c1-eb59-4344-8afa-8ee8fd260469","questionRevision":"85e46674df7200f6a26fde5057d538a23626d89a545d48faabe1174ecb58c20b"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/86583ac9-f777-4ef4-823f-56688b835581","questionRevision":"6658a8f202d24b36373d93345395eb12fe36a5fe6ed7d593cdc78def70635ddd"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/3c601bda-5454-400b-8bd0-dd2fcd465190","questionRevision":"c79ebb1a703ca3c4f8cffe6e2bf0a4deac8a440fda16a1f8e8d32310dc08e7b6"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/776391b9-ce69-4008-996e-e07ef583ba21","questionRevision":"16bed8f23122712434b35619ce45640c97d011e44eb59d08b7d05320e1de2c68"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/608c04d3-b23b-453c-9f26-81a970d506e7","questionRevision":"0b3aff9971ecd546f931c7567bb1226fb8401949a82af3d925e75da4b9822cca"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/97d17b5a-ab30-4f20-96e1-b847269b3c1a","questionRevision":"a45b99d7d04c75e173b98c5eebd84073fd9a8dab754e1951f22721d86c08699d"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/fa482648-b12c-494e-8fca-8e65a9dc6a1a","questionRevision":"a0f23048960ae36df0de0e563423bb83b23dfceeac76d87d316e06ebf5d54815"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/5ecf725d-e05b-40d6-8f0d-7fee1bd64b37","questionRevision":"dd1f77e3aff40d8f59a35d2dfe693317b6963e56d637f02e491969d6611b9c65"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/26ac2457-bf5d-439e-972f-78fec2b0dd4b","questionRevision":"c541921f39e2cedd60e4af3b2c82ce9dd1e5143e0a65028e038481a8ceeaa52b"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/dc2ec9d9-385a-433d-937b-72bf6f1aca1a","questionRevision":"cb729d39fed938519a9f8e92417a6a785b4558067401ce6e1157633721cfede8"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/4cfb205f-e372-4c6a-abdc-2ca8b2f9e891","questionRevision":"2b6e8c6fbd06b8c7966384da3567d4efd70b6f50f933be66fde91109ba6e089a"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/fc6ab94f-7565-4a21-8672-cc35019bbc9f","questionRevision":"67d02dda0ad850f873ad4052bc7fd45a07616edc709b3714672ed760de50a105"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/7623c4a8-46ef-4ce8-931a-7ecb336f3ba5","questionRevision":"7529c70d24a2dee6dd349683aec06c20070ddbc47839db27beb12a837502532c"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/999b5d38-f674-4082-8618-e058e3ae7e5e","questionRevision":"6455a55398ec70d57f1ed937d2b5c26d5d49228555f8247a600e6eda5ddebc0d"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/0fd64756-55d4-438a-a0e7-9b69aaa2c86d","questionRevision":"93cc605b5dedd32e1b23fd2cee85939eb80afdb83ef03fe5da874b3a4162b87c"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/fe6d207d-0056-45b1-a9c7-9d3d4dcd424f","questionRevision":"b948967595aaba0c1aef7b835a17f346e333bad6ad1c6754ab480bd1c4191405"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/4489f8ab-d2ce-4ceb-84f4-de9e11ed7df4","questionRevision":"af436a06b6c9ede4507672401f79166e7b070dba883053afdb1bae20cf83c961"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/c1d1cf54-8b92-4392-9e1a-4924e4f3c9c1","questionRevision":"3ce2f6edb3daf7a321d94d257c9a05c30dc010887f3dfcfe8d72b822a279266c"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/1efb31db-de28-4c4b-873d-022741682b17","questionRevision":"3855bf81eb9725036ceb4f4913b6c621d6f9b19bfb5a2aaab80dc70f1a9320b8"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/21f544ae-33b9-4db9-ac88-ab54de6a2360","questionRevision":"546a38165884e44066dd066a6ea0a6f02e8291a303f47eca45e8b4a6347d5b7b"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/bdeca65f-725c-4ecf-ab0f-8cd0cb20982f","questionRevision":"45654c995bd8afaf37820e826bf6cea84695d9acb663b4b48a807e038eb597dc"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/4f75d7ba-8f7c-4525-a814-c1b1494ce89d","questionRevision":"3c1959f961c3aa79107da150435d7a3beaf7e7b42f7297289fa8df84a3e30123"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/47c103c2-7487-4afb-8696-712e6436c240","questionRevision":"d9a91130d410735ee537ee1dff0bf3dbb79fc240a7e7147ecd1c18078a124a74"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/f9212c22-abca-4ecb-8a02-51083905f32e","questionRevision":"cded76e1b247a37a80e55da382a30462a3bc765c9b942bd641d1a6cdda702611"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/2006678b-038f-459c-9fe4-5274b3c3e8e0","questionRevision":"4195282520d0d5e91056978d1418cef8fb588ab999ca19692bc028f6f4e5b54d"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/164404d8-4458-47c5-b6f5-ff2143a97d0f","questionRevision":"a01d6fa2df906447bf812733125f9c9ba8b832c51c3ec3d0848a303e77f1cc16"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/e8686ddc-1c7b-490a-ab68-a9fed5296e5c","questionRevision":"6c5653cb494dc71dfd56632a0e41dcd41bd457df298694b75adae04e2e1767db"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/4d67d9e7-5d05-4c5e-b24c-fd1eaa180898","questionRevision":"0f9c6fbca899a9cadd6179328d701aba23fb1ebbaa0d569c4de7aa5c25366d18"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/9a121e16-49e8-4826-ad32-fc21f698dd9e","questionRevision":"89889ab5e6b86eaa90618bf4e3f4e74f8211831d108aeae1cae3fe75c8a28856"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/8544d321-31ee-4ce4-95a4-27c577388451","questionRevision":"d9d013df9e386190c7ed53bbfb371a6dff45eac62a26f2263d178f28bc69482f"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/419e5a18-092a-4a18-a984-08f594ea41b0","questionRevision":"8110aea6cf8b10ceed89bee2d94bbc5dd2bfff87eb78e02d987941962bd8c24c"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/6bcf122a-91c6-4277-9b16-d693e06f6443","questionRevision":"5f48cd49213030cac3a3914b8c1683ede39a794ea0ff951810712d225773a755"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/08147c15-e3d9-4f2a-9517-cf7496fb8f10","questionRevision":"f4c0efc316c60c03871897d2e655515d41a3abd2a1e54261c4184fe9c5b96647"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/7389edf5-19ab-4794-9fe3-a4b03f34ce34","questionRevision":"9725f585ae8ea2e02fad8fe09bbac96c60161bd74ca5a7dffc777c5c05a24606"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/371dcdbb-0a2e-43bd-ad61-7255bef91c07","questionRevision":"a10620ae164edc78a1d7e7bb5db04f3207798a3d3237fcef0883e27cc2223d5a"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/11982ed3-5ba4-42f0-8b15-432ff505791d","questionRevision":"b5d54850ae6a9ff9d8f854ae458cf9904341338d5b9baa95b5f7e30a11adf016"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/e480792f-ef45-4507-a084-06029351395e","questionRevision":"e722df9e89e360ac33eea02c9c001b0a64ec69d505bfa4db81caeac4fb3feca4"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/ccfe7c1d-dec8-4f83-ab39-9e6a1150df2a","questionRevision":"152373dd63fece844dc3856ca74030955f21018c2a242ba48f4f03cb581a4df6"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/310b8db3-6146-4066-ab7c-11d5d9150c84","questionRevision":"b2915b67f914263a35966c48630d745d33e34493315d9f4cf195f21f02cc1476"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/384a740a-0c57-4987-8275-6b8634f9a6b6","questionRevision":"c4c44ef8d41bc2897ebd46226dfc0a51555c67cb4dbf90fcf01e10e3b4b16871"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/c313553f-16de-4f07-8079-cdea4cbc321b","questionRevision":"1f05f237b9073bb3c9918227e2ca161aa342d82bae19d113f8edb8629e087101"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/e911f514-9b52-425a-b58c-26a3d86c83e5","questionRevision":"f49a4e3c522db7b1b6b928e9e4445fa78a5269b7eca787f866112796fefa818b"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/ac1dea2d-1bfa-46ac-ae7c-7b6dcdec0278","questionRevision":"93141ab4eb5ca8e1d78c7bd149652afdc5de11b847dada8fc08905408e77c89b"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/416b501b-f4fe-436f-b143-b8a57d12aeff","questionRevision":"dfad1351ce00a3236109c7bb658fbec337061986811243933a94d691a005bf06"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/36c04d92-9f14-456f-9b55-5a9f3109af4b","questionRevision":"7a4439c7c4459615645541132d40f3c6103becce18b266ce0bc994256db40de4"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/9f206c83-9a82-4b3e-8dbe-7e4cbd1a6416","questionRevision":"0e0b65c3f1157cc8e3c528b2b3d490131bb9389e7557b7b5a75471a9f3056aba"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/61b191cf-4692-4daa-9cbe-a84909a99c18","questionRevision":"5a3619e595dbac8a945bf8820e3a81b8b19df61882514cf757a8444f98475981"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/f445228a-5cc3-449e-b965-3fc881164121","questionRevision":"52c639bd1e3dadd8f8d39dcdc891a381eae13e2805f8f05cfaed57057afc9ebf"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/cfcb73fc-4a74-438b-885e-54374c9d9721","questionRevision":"aee846fbba1d43b9e496c8523928b3a275cf25609ea2116e412b01be65d22402"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/9e46e29b-bc33-461a-94e4-8fbaffcc8f26","questionRevision":"2e28bfff161c02d84b0ea960dd6457a06680ea6805da4ff814e5b9983f1e4922"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/6c977823-49dc-4086-aec4-c6843dcd8f72","questionRevision":"02a0f98dbbe532ecd1ea67d35564f46d55d24ff7de2187f29d1fd21d3375cf37"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/dac4ca04-0f5d-4c8f-893c-dc0626b2f0ec","questionRevision":"4ee12e3f2a5740e78117987a845a9b6550ac573515195547698e968d1a5f6ccf"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/8d5f982d-9c70-45f3-85e0-7d64d3817a69","questionRevision":"aba430e93ba9d097a602334d90edd6edd22bceb1790bab4c5c54987204c6459f"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/ab58eee1-50c3-4cd0-a4e9-6c7eb1aa3db5","questionRevision":"bb702b1783b5358e3ac0e26d8af614f7196bbf57e9be5ab9f82924a9a1dc3e8b"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/c8619f37-7db9-45db-b523-85c641fe308b","questionRevision":"26754a77d6eda57cae49a2196cd3771d15231858018f4f9341eb800c81f06bef"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/7a57f541-3c9c-4226-bcd4-0e363c5d1c87","questionRevision":"28b491cb982626965848241149dd4090429f618d6ef05460516db5ff763a84f5"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/78f7fc8c-e763-4243-9777-a3d6d6e8ecf6","questionRevision":"fbb1fc6e37763165d86b8a103dc68bcd0f05b219fe7bbf0a3aa2a274ba59c723"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/73f477b5-484c-4e77-8263-e5ba2aaef272","questionRevision":"4246bcd04371e35abe61104763406df5c3491cf09df9a524bb6935a86378c3a5"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/98f73f33-caa9-4bba-9edd-fb6669c1e9e6","questionRevision":"1e0a468ca8b95bbb97ba04b1c8e58b6da636c068cd401f4bab27e0677aebd2b0"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/71b41116-a987-46bd-99ef-4745ab7c4474","questionRevision":"f8d96186c249c75ef35f75c07f6a1705dea0c1eec726b84d94bc4fcb863f5a57"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/5d5ef049-ecb7-4c8a-9bba-a29a56cc0f85","questionRevision":"1ddc82fe08708515f82949785b184bd706fb81bf620e976783d26c6abe494c64"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/47a942d7-ab6d-4fe2-af78-5159e536de86","questionRevision":"a9d00c4297e231e0175b6545008b36783ace9c8d2dce0f525fe4d7d42d7379ae"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/19cd1710-314e-4bc9-bafe-9cf4f9dc912b","questionRevision":"2a050bec5aa1699b19d4aa08c1ff09b12aeb56bb15bf00aabe4518f6e58983ad"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/366de1dd-3747-464c-b2f4-d128d174898c","questionRevision":"db063c4b855f77b73f79fde0dcab12d09174c4a7d414018533e455bc2564bc67"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/45916598-fd7e-4bcb-9e34-fcf28949ac10","questionRevision":"0edee8933d2adacdca2f93b91bf033f7f3f366914c06d8531e5ca737c1f726ee"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/497a7d17-764a-4388-9d66-e4c6c1d70789","questionRevision":"190b9dd529cda8c0a39cdb0798d8c048332f2bda1789a0e24b3c330cca2f8a5f"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/79c4b1c3-278c-427a-9ea2-60b4f5977052","questionRevision":"3987f29d56ac635d987f0a06179543a2f31d35b79219f654516462b24dc2b322"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/8943e968-7137-4c18-8dbd-36e6616e65dc","questionRevision":"72cb769972f630eb92c85754fa97f44eb7fa4b26612b25d73e889631365dcb02"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/537f6524-85bf-40b6-b4fc-62b659a49ce4","questionRevision":"1ceb9117b24d94fc3613a2cf0c773df87d9342c0da6b9362d033b66843dc8956"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/e9b05621-6f45-4f12-ae99-edd728545229","questionRevision":"7dddd407905ddabfe91f02f7ad88c3d677c7453380b35bf8e2af11e05cf43f92"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/28d22fd3-b2c4-4aa0-add3-255ba0e4c872","questionRevision":"86a5be11850bc79984810536a5fe3853f466d5e515a3d6e3770f2d7e1a621dea"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/a8980d9c-1b1a-46c1-874f-cfef47f20632","questionRevision":"e417fa8a47b193d06887c62e258c507239a38c80ec02ff18ae35135e2c8befc4"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/8b15d0d7-847c-4c1f-aed6-355bfae96efc","questionRevision":"e1bb1f0d99bdd92da6b0dd5caa1804a6c762e35153136599c966a88621249274"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/dba460fe-ffc6-4f95-98ef-5d61d97668f3","questionRevision":"9c41986866944c3f7d6864ff8c8383d654aefe95a8544c4f17eca3ab02874e5e"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/7d6f13fa-6586-4d52-a3b7-15289eba3e75","questionRevision":"8b69890acfbd34227086b1abe1de52834ebd05b517c337b11a4fcd01c150142c"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/8eaf116f-7abc-4b03-9ec9-5a01b788bc98","questionRevision":"d4e63759762d81ed9c45999cf433348cf2d6482bf498c1c1d44d316f41161c6e"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/70df6f19-7780-46d2-bfb4-d62a32021875","questionRevision":"4e173aed9e22471fb9aae6ac7844ed768bae8a3d6d424b5a9f118d059e78c5de"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/9a15e337-9847-430d-b27d-4270eeaf2bc6","questionRevision":"3664af298114a59505c234d54e602eeac03246235a2d1badd23fa244fed742bd"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/36f463c5-0a05-494b-9717-c9f22c246857","questionRevision":"0c13e8a6a3679f3c6818c0b0299e607201756d5a3ac16cb101ac583ab8ad185e"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/76697907-d64f-4148-b03b-4fc085dccb35","questionRevision":"07d1493a76e0f17c86c3e3dbd0d2f9fe4b3f96f7cbbe9bd89842a4dfddf89d1b"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/f84902d5-0ddf-499c-8bfc-7db67c9e5b2e","questionRevision":"ea27b5bfd990972c1bc33e13bbfdbf28adffeeb134846a2061a6398082e5d62c"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/55860792-8789-47a4-a457-3501f1998efc","questionRevision":"82d9e4c560a37ffe99178a6c2ceace58e52005b142e4874bbb3c67f0a7c2f3d8"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/d2fa4174-44bc-4ace-bbb9-13809f844385","questionRevision":"e0e5da9cab13fa97030e24ed54df33bb3a16abd9bbb7819a8543b8fb91f8c2aa"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/11f4763c-4e55-448e-8588-98ce19ce0070","questionRevision":"5980c67828d0a17e42fd3b55b526e02f6d5e1d73386f83740f9bfcc2a9326e59"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/1c020110-1fe8-4f2e-9c6b-493a3a20915f","questionRevision":"d259eb74392be5410bf4e848fcc426e434d853a3201e0278093a5422c0766732"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/05d96631-3901-47e7-acd1-1c151ef5d4f8","questionRevision":"122459698e85bcf871cf91e5b4aacdc8a899fc144122f0860d0a99fc4b12fb4c"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/9961003d-e0a8-4b6c-a84f-df592e4c7083","questionRevision":"04e075907c44ced125fdde6f1d526d2a257cc7d2a7c1d36c14b6234869e49e1b"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/bc9946dc-a664-41e5-85f8-eb1e5c42d412","questionRevision":"f476c44ae10d985e1ece12e35c4af9dc034d00a37e373f143e2de5685ee53ffa"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/a93c660e-5ad2-4b8e-ae3a-75ccc135f33e","questionRevision":"72498953a3ee43a6719aab28ed1d5c41ddbd3ea6212cb8f7a709a6d3f2b241e7"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/1ad88e80-9939-47e4-834b-8a402c1f4695","questionRevision":"1d43a9a0bd81ae445848e9169f93b438276759c9a55c1e98a04fc2f5d93e327a"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/d1536b64-e729-464f-b4cd-74912a0215c6","questionRevision":"b1c4b7f8d534a615e787fd18285bff8a807e13946c14762647581fb2c1da9358"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/f9fa5700-0c08-424d-80e5-cdff972e96ad","questionRevision":"c77539ebf7f09b9e26713d344fe9c6b589fac7cad60b4610d17a7eedb80c5170"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/f8785ed0-db5e-4fd1-8fd0-abe7e7eae851","questionRevision":"3460537d066cb7fde4ee4c352b8ded27f78ab9e70b2e170b0d953a4ab4300849"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/265c51ff-de9a-4ddd-ab37-e8d1b158daf2","questionRevision":"a29cb7cd9196a26e4b83f98b1a882389ef48593eae20270283b19541bdc1d84b"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/32045acf-0a83-443f-89a6-b9312b218063","questionRevision":"3673df2930c2a5055e50579760578107d49e04f8b40bf8a6ea0a4a8a5150852d"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/56693af6-a0aa-4bfb-a785-59f61c2d75ca","questionRevision":"f4186513ea10611e18c1680baa0fd8cadf3e9a8207340434dd33be0aee706621"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/60726b3f-c023-4e2d-b382-8623855f9810","questionRevision":"a5ea33b5856b45a545b1b3249448bb48f4e21aed9020dd276c959ad38a1500a8"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/b5982db4-fa53-48af-adb3-b74cba26d287","questionRevision":"4f47cc7775ed7c44813b8483152e55e67f5d5570e0052cb17fbcdc5ee3c0216d"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/2e4d68cd-6c61-43bc-8a83-b219aec944fc","questionRevision":"7efb80f4473b7d8a6e9e8b41f34f682ca8bd29277cc35ff1fa246a0c8466c697"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/8ae263e2-03c6-46c5-997f-612ceb6a87a1","questionRevision":"fa36205ce47ac8d84f0a5e902522de8b26eb80fa2b158a0d1f9209a6bde02326"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/692d4fcc-09f0-4ddd-98b9-79870bce9e2c","questionRevision":"389a011a0dff69ea06b6a70203b9e162cf61b448566ac4122d59dcf57d64eb10"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/660cfe67-ce88-4e28-ad4a-c48de9de4273","questionRevision":"8920a714d4c22bff355886cb5fcc7a658c928d6c5b496c74bdb501002fd3efef"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/5ca9faf6-2708-4c81-9ca2-a7b99c47bf83","questionRevision":"9899df973fc3d0787d4b6716b63b68b59327863d6859e770523a8c781238de81"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/49562588-5515-4b1a-8ef6-764199f99c6b","questionRevision":"269a64fa98b476af56d7b0c44f8b88296aa226df6e79ed1a5fa804e13aee860f"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/65a71415-8460-481c-aea4-bc432cf9aa5b","questionRevision":"72de7c66fa4eeb3a28e67184c25bafa263cdcf9f231628950945fb61ea0a6393"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/f370a251-ce65-4173-98c5-11903adfab51","questionRevision":"6fc1d167ba33bd38c90d925603472ebdb7e68cae4652805832e58997de58daa1"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/5ac529c6-d8d4-42a6-9a54-0ba8a1cd31d1","questionRevision":"299815d789491ab2b2714532133287745176365d8c458e5b0b0598b0726a7288"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/0e9b9d7b-2e62-4aa1-bad8-29de088c2464","questionRevision":"fade09bc16405454ce1e5e0265e56316fb5fea8a951f8a5fc2f0eebf7b4e5b62"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/d965e4a2-010d-4ae5-bb4d-e135bfce3afe","questionRevision":"91760b7e714801ca9baaaf15052261c98107833792e8d4f00c9023108944c76f"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/b154d186-3131-4910-a754-1076e1cdc64d","questionRevision":"61ee0f99a3f6b88efe575f92dde3001e4a9115b00135e80c66262ffd8ea9664b"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/74f4136e-54de-4dc4-a48d-03737fbd6970","questionRevision":"1506a31e9032335f835ad6e773f715a6f8429b4da7a71e256ce0d67c8982808c"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/04ed1552-4d3b-4b76-84cb-30437a1e8193","questionRevision":"1d9d18a3ac112cb1cebade8077765ef6d2bbe5c634eaa0fa6e48b14f6a6b6196"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/a4f1b083-da30-402c-a483-2aeca0bed041","questionRevision":"9e0d37f4cde53d84702b6e3dce580fd8d416590fc3895c3d9415d19012926c10"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/07dea178-62f1-4c6c-bbd5-634b5b5de945","questionRevision":"37edb569cac78c2d805f7af9f12d4828345a556c643cd80377e1f5577aaca124"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/e377d06c-d26b-4726-b051-74951b1cc5d2","questionRevision":"77aac4f22966561a86b233353c351e89ff9c7505d7d0c054099badca9effa3a6"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/afdab2e9-2e1b-4b78-81fc-14e468bafc46","questionRevision":"7e0d1e610219ff75974303190d530b9372fff418d5fe0cf90f94c8e14e888e91"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/353ea1cd-f560-4938-817f-620f2886fd94","questionRevision":"47d5ed861a597f2233dd4254f4c247af1c8d4a6b308fd92a1d24c8cf22bcccdf"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/f84bb64e-3a25-4260-a023-11a1bd2c30d8","questionRevision":"f12eebb178fba261d038ae5ba23aef5b2a35e2fccd755d55a119425942efe896"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/9a858f0f-90d1-4a22-ae3b-a48bca77f3a3","questionRevision":"3f0337d8ec62045e5f25d9cbafd28d5e1fb808c6547dc22616497623858c0bd4"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/1eb16e20-c23d-4b91-882d-314426787aea","questionRevision":"75afb1b5873cfbb507d06c04fea238457ca02181c7684a2ad8db9852fd0cdc76"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/8f5991c2-2efe-49db-924d-8659a463e1d7","questionRevision":"df50b1c3deb2613486fa612c33cb14517d69fbf6d75c5ec881667bb046d37ace"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/dd973263-5420-4c10-bff0-89db080c4b54","questionRevision":"de70d0189651b915f4cdfd89de6f4c321b1da30b64e2e46ff9584921ed78f755"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/7c06260e-0373-4e09-9564-0b2c55034653","questionRevision":"457af3242c0f653c149eabf1eb9a0f016e8e7bdb0d0aa5e17c3bf10e79f7aa8b"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/10714980-7000-461f-ad66-2f795571c527","questionRevision":"a25931f216e40c45b08832e104603e9b47632d3d8e80ee5504dacf32e517e7c6"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/1130d0e1-b221-4bcf-95a5-e29eefc5ff87","questionRevision":"c93be0cc60360b4478199db18a1c912b7cb01c5e481aefde5ffe2497464a8873"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/e86d500f-a255-46fb-91e7-74afc0545128","questionRevision":"780baa94d76519ace252396d7875274bb05145d9579325c51176bef25e639e77"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/4b6357e0-9c92-4e96-aa88-b961a02e1d10","questionRevision":"6298cda633b38b2f25d272a56630c371259d028bae6665ea7a50c44891afbe68"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/fc537cd4-b1a9-4c10-8452-3333fab7f06d","questionRevision":"5c70ef24284af89d92657a535cda2d883b440316c7781474be8c3316116b38bd"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/b738e65f-6ec1-4d35-8af8-14fdb07a7459","questionRevision":"ba7addb9466c07e3a03069cddcb509739c0a32ca750d7607e9daaf95dc7357cc"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/e40b7667-a756-4719-98ca-455f01e535ac","questionRevision":"0971579d2e47171fd9ea74497514b9f704a9df43028f71ba105c40058911acff"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/13db018c-94e3-4ec3-8b3f-6b08285c55d1","questionRevision":"5ac21d71c79c0e438a663967f932900c13cea8dae3b564f0b4dd34f5b7d222e0"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/2d0ea6f7-2197-4028-862b-b0789b035f7b","questionRevision":"391b7e4a5cfaf1ed685f36f20d14bf9a801915e0c2f06abd656b67f6515edcc7"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/8c650379-3e4a-4419-971c-44da42a0b135","questionRevision":"a900798c8fe626acbc6c9e74dade0d4d8445a6bab3a28e1143cda928d43beb8c"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/30d669b8-13f7-454a-895d-975485383927","questionRevision":"e58a640228ed800062b5d35c374d0e6b5c09101e9d8de9aa88697a54aca85594"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/becdf278-6376-4a4c-97a7-0db0ffda13e3","questionRevision":"c958767d74e1ce9a728f0e834f69034a6bb4e106304fb313d9cf2d7467f8d852"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/16b9d5b0-1988-4b1d-ae83-3b8cf533f9b8","questionRevision":"d7cc538b57370c932b4f538aa9d9be639ee3b45e5370fd879ee6f3a8fb9a7964"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/91fe303a-de94-4ca1-997c-23dacb59c8af","questionRevision":"0cf5fafb9e075e2d4eb3ab782b85cb969e6acc6bd5df8fe3951dd09bf8b87c3f"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/8020da22-0cc8-44f5-9aef-2f5673e2b8d7","questionRevision":"3d819891cfcce59da223acd17d51a9f0f02260144c04d03b91c0ac7d07cafedd"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/99cd8c98-f230-4b7a-b765-42b26ede277f","questionRevision":"a055bf6c91c10a1d553d0f128210890b44f76cf9322463764ffbcd389d7bc260"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/103311d4-7879-4c74-be46-be312b427741","questionRevision":"8046dcde16c533b8b488bae30952ddc701f85e5c9bb9d24b34de3f8859f298aa"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/be28b2db-c848-4e2d-b17f-f8d89167b4ee","questionRevision":"6d9a5599d93b5421570991045913db7a397517f2284f6398384a7ac6db33cdfb"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/7febe8d4-04f5-480a-b820-c433113c88b1","questionRevision":"db95bce27968ece29d15d3abe565ba0a0dac746cca43cea99fb6914d6cef70bf"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/1796f59a-0ec5-40a7-b3d2-50a7dfb8aca9","questionRevision":"d9f5adeea705ecc9266da82aa0407ba5833196276f51f9c49212c6e078698a29"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/9c9f84b8-483c-4366-92d3-4a2f98d1de07","questionRevision":"c131596fdfe18db4d5628715afff17afc696ed9c7adcb663bc7acf45f909def6"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/1ee8cf8a-1f36-407e-b532-785b70efb20b","questionRevision":"15f3e98c43d25374b5b5ff42f5efe21f84ae9f3a8b13cc069045b78ffed04819"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/a065f63e-dc7c-4a39-8f00-19013a7e66c8","questionRevision":"5a3229b038eb1662aece1550008266d77345b49cbdcf40ce82047369e5f21183"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/9d232684-006b-4b7e-be19-e121494e9218","questionRevision":"380379d4df6e3bcc511b2f70ce6e7310bb458e0de275fe88b871aa868a1b093a"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/bbf32903-a265-4648-b985-58f1aba02887","questionRevision":"13e46febbfb0739cd265ae327957d491149741bea6d45dc5819dfe4c51ddf2f7"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/5fdeb702-ff2a-4ec9-b46f-e34d8adee41c","questionRevision":"a5804dc7f48e71a71977e332d49756b941c073703b2c4593f3bc94ade896842e"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/b1c726c4-ead7-4501-9707-34eaa0f1ad18","questionRevision":"c314fd9b8662ce47bc35edbbed07d7587f993c8df93035ae501a4aee110f9686"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/0bc87c88-b450-4b0d-8e03-2469548abd2b","questionRevision":"81a1ca51dac97447945f974f06f938828beecccdffd250a4d3d41995120d2498"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/91e33f89-9e33-4df8-a7ab-bc953ece6763","questionRevision":"a12ca684df97307b5d1a1cd6838023a934e3dc408c49b8a4939025dc01186d0d"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/8b4f911f-359c-4f02-ab02-9fc59a6314d6","questionRevision":"62e0451aa01ee654a4a92cf1909cf2ddd9575c804f750787a614e1805e48aa06"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/fcf03a37-01ce-4499-8cdb-b8e6edfc85c8","questionRevision":"92f04c83ea906525445438708169e8d33b64099990e4408204ed04954091637f"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/87130acb-198c-4f6f-8c9f-84c69474334f","questionRevision":"bfd67632cb474643ad3fb957d399f3e2c4f8fb255d6ca4fd43fa99a79e0b248b"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/9ca05ccb-f454-4405-9c64-837b88d46083","questionRevision":"19a06b78a7ccc69088478435549bf96d24a50846724a5c8aea4a6bb97e8b78dc"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/d66214c7-dba8-4ec2-af09-677b848353e3","questionRevision":"d9233992bfc0191ad69435ad3abeaf841abe56c31a13c2f1612da67b70152db3"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/cb8ed045-ab6f-4271-8bec-e5153d571112","questionRevision":"5f9773413d2d44bdd4c42bd3ac542cd90d10d11ad9b4c1bc820d77d57b424611"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/7043e42c-8dac-40d1-bd08-bab013ee9598","questionRevision":"ce9991040a1c9b66891ee170d643e615fdc068a4edf8b116c39957c1b2214914"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/4344d1dc-9ef6-4f58-8a72-f09c98a77122","questionRevision":"6f16b15a5e1c353e2133b77e14b94348066347de074d28dfe5bf1c7461f86b3f"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/0f6f4b83-8f53-42d3-8c17-33a6aa68a0fb","questionRevision":"e73f154453f24d7f4ebc6b1b8ddcd205cdf0bc5fe9e69efe0e3ef95dde095a19"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/f5d8ebe7-bf9e-4695-b38d-6ca2c3ce0e06","questionRevision":"d6857d8d36691bfe248f18e728c8e2d29371972ad86a0600e3ae3b22dcf6813c"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/83b7f708-99c0-4594-8fe0-f9643e41370c","questionRevision":"ca7e0f75401e0e70b1076f298c48de4220cba297a52434af79aec7c721770bf2"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/d60239d6-bb47-49e5-8228-dce13af65179","questionRevision":"157e3d0f8834aed73825a16c615fd7c1716a717a0e99472b15f6e1dc5ba1f720"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/6de5effe-ea0f-4cf5-970f-b18e14824ef6","questionRevision":"6db934ebd460cbb9f1c0ddb5648b817eeaf032bc3882470e6cfc1c06a7f67959"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/1400584f-c6cf-4e69-afe3-49176c61b026","questionRevision":"64904d5cf9b97764734c0f68ce61c3bbce2077b90ec6c1f430ba996f5cbca62d"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/a9e1c6f9-3517-48f6-b2a0-384cbb4e05e1","questionRevision":"79a79f1dbef6b1750d9103357fecd15f43e119fa83451e068ffca147316c0a5c"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/19f3cf3b-4ab9-4604-9fc3-a2f7d6efc716","questionRevision":"57bcdf86d54c312efe3702fdc78447782bc3af59f98696464f221a09138ca79c"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/a1d6bcd6-f215-4f1c-90c1-42e6809aa1a1","questionRevision":"d48d75eb61b302771d670091d8198717f73f50f627b90bcdebbd8d9b2f1316ea"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/3d815d6c-7df2-4d2c-9268-5200af2fbed6","questionRevision":"43768bda6d0231636b06197b122995deb49ff0e3d6755261120e77aadaf1f53a"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/de01d84d-000e-40f5-97e6-9679cf463fec","questionRevision":"12819fbcf34e44473a6d3e7d583ad4d769f0d5983f7f89638e6dce9531f58aef"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/043efc0c-80a1-488e-a298-c4305c8b426b","questionRevision":"9bb9c16d477e17baf71798eae2e111292f41cceb0c2feaa81a180425f555c9ef"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/2d513cff-faac-429a-9d03-da12640d9746","questionRevision":"ae3e84bd828f8b97eaf97b4b0eadc6386381b488069a97ffcc0fb50c939b650d"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/9f77c012-6ae9-45f2-9ba5-d87a47fa0bc7","questionRevision":"8ab15d423ae84f7caf46d345dc87ab7b67ea1890dc8c78fe9f19e7412dbdf42a"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/95c92170-ae4c-4864-82f4-b36c00b1c764","questionRevision":"7f0da98ffe4afafa1d78951b937566d55b4079a335e00154873c09087c6d4226"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/01ff81bb-a633-4adc-a875-c3f6ba898402","questionRevision":"9a5d9563172c47a277e1eea068f29ea753bf3a0087fa3cfe4372c6fc3b16fd12"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/a1e17e0c-e71b-4cc9-a97c-d9ea336344a8","questionRevision":"18a71766fb6c7155c490b6f7874027c9c1b552cfca7f7a66ce360a24c939f5ac"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/57e3056d-00b3-458f-84fb-7c6ac9f2640b","questionRevision":"8468f19be79ceb87ac9555b432fea41462a825c85ae9ddc2e283f2c2bd80ce5b"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/4954ec52-6316-4f8b-8d66-333a21eb876f","questionRevision":"8064725a811c3a9af371736414f5e3e3300abf3840f3f85d1618289eabacb6f4"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/ea107efc-079f-4706-9809-535860be695d","questionRevision":"10e4b27ab874d584119901ca557ab70f19c50508717aea9bc255078fa9e6b5bf"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/977bc797-45dc-4b43-8bba-2e01f719708f","questionRevision":"e262509c5c21054dbd121af6ced09475d7e00737a342b830b8204d018dbbcf5b"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/1ff5a448-8b58-484b-83f5-78227f036d48","questionRevision":"f68a22635e78aafdaef55e1af718b3f3a7944a51dbc4c0a01529f5aef78c64da"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/24a8b602-5aaa-4945-8ecd-8e0551751365","questionRevision":"3d5444b0720f29e71cb78cdfb0054a3bf4aad10dc87af05f6f5bf5a0abc2e49d"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/cc6b8400-fcf1-49ee-b6e2-df995c9659f5","questionRevision":"214d44d20d7f5c5029248b33168b6206259d7a642bfc6bb022b22b4d6b36279b"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/d525a413-7511-4717-ba47-c43bff2ca8fc","questionRevision":"5a83cbdf05e85d38d2565420daa2f5ad59af5af5a76dfbb9c633acd8a673b685"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/c68659ad-f7de-4616-b7f8-c267442f5bf7","questionRevision":"3779f548f03f23533e176bbe55d83dd5f40ab99442865cd5040280c1637c72df"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/44542767-705f-490d-9442-ecdacaae7b96","questionRevision":"0bc25231705360674ee9c8b216f08ae22199d4747659ee2c4401e1e2f3c7d959"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/0fde6bac-3d3e-477b-808d-242d9dde58f8","questionRevision":"0ea00f246b06ff646d23094ce6585df1c4b42b825736bc76ba88e96923ef079e"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/8ef635d3-bb12-4e3d-9dff-51aa6668933d","questionRevision":"b3c8a6cdf0fb2112393663bce7edd4040bfc5a76f78c508db2f99f267be55e67"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/7d209553-61e2-48b3-b41d-2b6b4b7aee27","questionRevision":"72394e670084311c170b59c56a6d0f5ce3b85defdc47eb525d5f73b9ee56ced9"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/5198ccb7-efc8-49b5-8544-d00123cbe552","questionRevision":"f74e641ee167b6f7d7c54b1b31b42ad91da125a12e59ba32072b79c28025bf64"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/81685f22-0f17-420b-ae24-da4ae8453394","questionRevision":"81daa9260ba0a6e6f66ae8c8c1ef9fff1a2465c8332b3960c07e4609b16c2fa0"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/d32d8aa9-c57e-4786-9de2-59ff025eb903","questionRevision":"56cb85f7a4eadf787cd727e3a3b52c40ccc9f3fcd691a757f9238b23228f2a64"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/51608ac2-d726-4db1-a257-22463d34e8dd","questionRevision":"283f7197da884afe4c79b7e89b6c41a2e2d0e40e479f4960b1a55081964ce944"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/bb9e9cf8-c195-4535-beb8-d0022de83d88","questionRevision":"6aef732ceecb263698a970395245b37dafbb9a5ba3dbf051f71c2fdd0af938cc"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/bd76606b-6053-441b-966e-2142c138b6b3","questionRevision":"aa24dbb0243d8b72eb6b42febc633aa01d4286e16ce46c47e547c4edb2dc45c2"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/5ac289fb-81f9-4555-aced-1c597dd48d34","questionRevision":"4c925d6799c144f21a9497446a538f4cda144e0c1659511a9c8d104a0bc58265"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/1a966896-4156-460e-b12a-f4cf09745723","questionRevision":"8e3c613c4f31727ccd8ee9960584f45c6e2a6b4a11ae15eb059fd60eda9f6992"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/f8373a8c-6959-4f04-bbb1-c2eef7d2c701","questionRevision":"96699406981edf5220e3d3b052c53ec0304deddeede66ef283aaacf3cae23990"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/980d715a-a625-4591-9320-225cfaaecbae","questionRevision":"3b8cf741deca0e899d1b3cdcf926e6f26a23c37bd5d0281b3bb108a50c6e7643"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/3b4a79d3-abfe-4468-9226-1fb158159aa9","questionRevision":"a3023033812e7fc1aef07f4115224efe9c902f7bd5c6746c7a1c2ceeba6961fd"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/7f200d92-c86b-4544-92b4-50258d358b6a","questionRevision":"3a1495bad82f1cac9b4856957679e0cceab54a585b355265a19ab8c1047290ad"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/362306f0-ca38-4ff1-8ab1-e3089672043b","questionRevision":"ebe67dfcdb1671a4f261910599ccabf1a314f05a26edb44b268bfc9e122037b8"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/556d924b-30a4-4e00-abc3-0009af6330de","questionRevision":"e8e8b5ef812f17500868cfec709bd62d72c294119af5eb640a723cd6e668145b"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/f56a7aea-b2e3-4688-b6b2-f93175de66f8","questionRevision":"49906eb419384635be97314b415116322a4b1eab29009f8dccd0bf52586e90b8"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/f4c5e49d-2ee2-43b2-a19f-1b056b5061d3","questionRevision":"05ba7f9d507fc3d118c7376244794a462ca905d662e909bd333f008080a5f06d"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/73767482-a939-48f4-9631-e941ecc50396","questionRevision":"94a2153a502b7ea98dfe29d574035633a3b3942d2bc8f7e337dd38c0e724f7fc"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/eda10689-2e83-464d-87d3-4dd5f7ef5c6e","questionRevision":"8019ba8dfd55d3585d34a984ca3270f004fe1123d3c1bb74443180653939accb"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/b40e6a86-13c8-4c15-bb56-0148d368714f","questionRevision":"57464e2804e6d64c5e800f47b876612f88854e1438a6d5d1ee1ac5c3c127d262"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/9b4aef84-fa66-484e-885d-6464b1423cad","questionRevision":"3c2301bd2395d21e47610ad9c3426bae9c154b0a194a787b0d3f43e4132c0354"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/83b3d01f-a850-4ec5-8f3e-60ac16c2438f","questionRevision":"d428ac5512dd9a4d9afea3675a6bd110dc0bc08774ec10ef0cc049a96b028c23"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/4c4532bf-283c-40b9-80e3-b4376038b67c","questionRevision":"8065d31b436996f61a3811376ecb824eb4343297008ba612107e08e37ef3290d"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/aaff9978-5c1f-4f31-86f9-67206806a5dc","questionRevision":"ff0f5e86bf0513bd858f031fa1d25707564d92679da7a60a791a3895f3b2c1ae"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/24139729-7f4d-45ef-8664-4e6076c1bc2f","questionRevision":"387c36bb03d1e681f8b17541de20f1fd4c6eb9cc5104a32135b210199ebeb034"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/ffc7b1c2-7715-415f-8616-3e841d0b98ab","questionRevision":"8d6d9893d3d5acc0f1433548d4708e6b0585491a1c7ed969cd11249100e9f394"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/0b9ec5c2-72da-44ae-a1a3-a239751fa193","questionRevision":"d4501f1cac452aa5f96053008eca3848f86cf50fd60f47d3d66dfe665ce7fcfe"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/8cc2e5d8-7682-4a80-a4dc-29e7e466c647","questionRevision":"6e7739d669456de8e89ee986a995552d821d8fcdf78c6362426b0a90a5374365"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/e2d56385-97a6-4a3c-b7aa-30c0177c330c","questionRevision":"63bc8a32a604d096d7d5bd4ffd623792fd2ef9f6bbef172321c7e550ed3cf634"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/048e40c7-0637-4743-994b-709e12229d29","questionRevision":"a9a71c11134d32004429f4bd92be58ffac57f511f45dcf4a2c06141abc53739f"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/a667cf0f-324d-4dfd-a244-1da66fb1746d","questionRevision":"ce76849d030bad3fec33ca533816a18823a87ec5191a4e6216a7abd2b9b0be7f"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/331c53f9-5a94-43df-af99-be57b7ba8287","questionRevision":"843c5af821e4e00b63b77ec72d2169a2ff1601786be4a7bce23ac6ddab0488b9"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/c394308b-b4da-46d1-9231-2c35ea1ad8ce","questionRevision":"0c1c8b4244e3f62f5dab267da635168437e8a0b2cfb7a6c1bdfdc258c47c50da"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/4f18bdef-d0dd-4361-8e35-5382d8d33d25","questionRevision":"553ca18b485457e95009009487e4dc9b938cbfff2b25b89779e751b1ff67266b"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/9d0f1a0f-afee-4609-85e4-2872493f499c","questionRevision":"3f93fedfae0dcdfe572926c4c25dab360d17f8a17fcf2243df3986f0d21fab08"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/ca6bfb91-0307-41ae-99c5-3ac5df6066a2","questionRevision":"f522def31a1d4cd5a17520097f730cad19960b2aad95cc5b70d7b40f2dc9b71b"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/03220ae8-3249-4503-bceb-de3722074b22","questionRevision":"1ec7f16ecbcb71a1b5e56012e267df481761044a63ae86455f38b443def40307"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/d014902a-799f-4233-8500-2c88ad628b59","questionRevision":"4ab896be56ff94d68a997687ce9ffb536e355140fd2922e325b1298a02698ec9"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/fb433778-4aca-4d3d-8528-4b4cb57ab0c4","questionRevision":"e258a3020d4b2726730043b2ef1014394745b3a69fe6d233be9eaa5bb8e4b606"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/a8c3d4f6-47cc-42c1-9778-541685514cb2","questionRevision":"85166d05330ed6169ac3a5b7d463cfd1c9e077db013eea3aaa83e5488e0f3a52"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/d1d073f5-f478-4e04-949f-a2990727bc05","questionRevision":"4be452942a87ae9457bd6f537c961f3c50bcad5c04076c828d4a20aa53144c38"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/c072fd70-641e-4e09-8530-257e30c2398c","questionRevision":"c1c71468181f24811e006212702236025deff0176bdacf4fc88244e7e45b48b1"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/493c36d0-8167-40f3-a972-4dcbdbfd49a2","questionRevision":"284e130b8ac01a2137417f774cab82a5c509a612dd07275fa489817d7545097c"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/fb47b360-02c7-4932-a450-df4fadb49dc3","questionRevision":"af2b27a0f366a2e4a262c78e5459f94d867085282c004bb2ddb7a9a55f8f26bf"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/9e54a737-173a-4170-a371-862971327f60","questionRevision":"d051fa84a364e4433cb503cc353a976bd105f24a1a2db3714bb2bd358edbd129"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/00a91919-34f0-44ca-8baf-6519e854f2ae","questionRevision":"52e9c9e2f978807c2bc6fb62d56d77731c5e67f666db5f15e389ed44ca6c0c7b"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/b9291813-88e9-4071-8021-7e803cedb0dd","questionRevision":"93ecad50f1924086c61fea6916daa4bd3277041c2e910d9d6aa24d4256281246"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/b5f0c54e-f20d-42c8-b9ff-b1585b199422","questionRevision":"7e64ac6574cc1385ad4b51a890a251a2fdfc3d29158995a831054ec2734859bf"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/6a22104f-a7e0-4558-9e9c-c975fc4416cd","questionRevision":"8ce49d958970589ef608a2c56cf21fffefe780237d79bf977dc287eefe225c37"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/1d6a1768-fd93-4922-82be-3da595b5bcdd","questionRevision":"007f8cd3689ae200fa7791a9ecd0019c82fb18deff840d5322225249445e5772"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/ef3ebfb5-4c0a-4bf9-9236-cdf9147764da","questionRevision":"87cec5584e75caf4635a64cd81c3a40c50a82a8098a2aa502214b76582d9ac00"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/8c583ce3-940c-46b1-9f30-b5b2b30779e2","questionRevision":"f12028b1b030c78264d519c49c7d53f287592e14f9f70332da06a89d4c941d11"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/7e4d3133-4c6c-4650-8670-ca6183578bc0","questionRevision":"30218a35576a844d72a9d8ff9cc5b3c7eecdea4697e214aca75f353bff0463c2"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/dc01add3-3c8f-4d8d-aab8-b3f5abbf8657","questionRevision":"b802cd1fec2c77522a87e63b698e7681091463ac301d61fd3a05948bada5cb2e"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/e83e7fef-c57c-4e7f-b1f3-38e5f84ae49c","questionRevision":"5afeef0e599fa22d8657f8196c549068cc74af1e1af17d1451d8c8a879fdc84a"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/c1e78cf5-bf22-4c80-88ce-f611dbd50ebe","questionRevision":"4075053b5d21b2ab7bfe7b4ab8f7ca3bfc8af5cdcc3415232f9b7139d2e78ea6"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/ba123fd1-1a87-4f2c-8229-cd99644757d8","questionRevision":"dfa9114612e142418fe4e19abe4bf06884720463511fd5bfa7eb54b4c231f05d"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/53ca61b3-6bbd-4964-8a78-f9ef6ae52f6a","questionRevision":"ff6ddb9af850a59b6c9bfcf8f839b9f2a36e8b04ed24d946248e17ce864c6c9e"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/769cfb5d-c9e3-46e4-be3a-7b2131dfd217","questionRevision":"d97a9cfdda1cef6c0ccb7c559c9a1cf61f230582621c4e3c3ea35c69bcaac017"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/6ab3dd87-f66d-42f1-9f38-df1c759b2e9b","questionRevision":"49fcb56fe9b2807af3022b3ba851db65ca64ebbb22a4652ca739d5d42d870e99"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/f70ea803-4b02-4287-91f4-e5dc933ba556","questionRevision":"1e9632290d264fabbcd33afc2648645c6183d5404e60fb55ddeec489952506ba"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/416e0ca5-cf70-4e86-9ddb-166b33b29c18","questionRevision":"d138a1116d2ecba91cf885cb7f6fb1f74b3e246763a238ce1364016183d45fff"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/fbba9224-38d3-4b7f-943f-2c0686e87197","questionRevision":"12a5514584c01a9e06627569e0ecf1483d1f19641d01bb21db40cbb4e628af51"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/26a15488-0d3d-41da-831c-dc6a3cdf6122","questionRevision":"8078d75672ba6cda5a43f8f2c0cf238b1d0d333fbfb3f85ef0fc3129864a6e92"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/277b2b53-de74-4eb9-9474-e1473a4c7171","questionRevision":"e1cdbeef4e1b873f9c55495f35da81038fb416a9c15e076dd457461b7fb45558"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/ffd60ff4-e2a4-47cd-ac49-cf15fc51f0dc","questionRevision":"facbc26d01c5cf1ae4d0804cffbc73f697c94fe2f3d795fa46bae1bf969b2ebc"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/04426885-85a3-483d-aa7d-d5ba83eb6e1d","questionRevision":"95e770a082c2e0156a86756663b8337a325c859366b33dfa8013ebb7a914e258"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/5f43f4af-1366-447b-8ea7-8d025500e48d","questionRevision":"eb865206cb079d1adb19a02c663432a8329f7c88c5d202a903b2c145042b7340"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/526259b3-4645-45c3-bbbe-38be77f1589a","questionRevision":"d2143a0599530ab4c2869c92c6d3d24b4340ae13628ef9ec7f12db71ec853283"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/d3822ec8-08c1-468f-887e-b056af8a4877","questionRevision":"f13beae1dcfb32c21ff592716d882c9d16b3a37d358cc685eba2927e80b98cc0"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/55d9ecc8-faa4-4dbf-b9f1-ded551c422f6","questionRevision":"4c68e4e1ccec522ea3105cde65459383d93c1d7c23929807c316a246748c4608"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/3681fb97-a6d5-44e6-83f4-d896ba619c37","questionRevision":"471b79c9c5908781d0ac275b22895251562bdfdcad46c0d79b88153b35387bb7"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/42159846-750e-45ea-ace6-96af67a3d4bf","questionRevision":"0727c2766797dc20f1ea2a097af30b2da302a180b60be75b48dbef9708843f96"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/c98cf0a7-31a7-448e-97f0-25879992fa08","questionRevision":"c2e53a2b1459ae3e283fd1aed266d2e0c9652a2a04383957abbd50afccf3a5c4"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/3c234093-8be3-40b9-8d53-5d4e3a1d3067","questionRevision":"22d63254db64e30f512821259eba9b6fbd74a923bef14b7443e4cb4b92bdb1a5"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/e13c89fd-61be-4c0c-b149-cc43cf271035","questionRevision":"69d724ae8933c3fa5a49e0273ed7b4a24b6d7009f62ac1844e3404a9400e9ed2"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/026c917e-19a0-463e-8448-55592a746e49","questionRevision":"c22271d0546c59e416975dc3600d6989eb9f115de77b584c1a208191c241e7f0"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/5d9b2ff9-a7e0-405a-9fa9-67c31834e682","questionRevision":"99a3429f181d497fec267fb8b872aad7491946a19059f282c11589066d4a088b"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/0d6aab57-5103-48f2-a823-064434b94c4b","questionRevision":"5ec3401f9775ff95f3ed89f123f010b611d936868ea3f56dc70f1fa2290f0860"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/07182bb4-20d9-4c7b-8938-0adce83f9572","questionRevision":"3557b1983b21000922d8bf189051c5b1106b8ba5e10031ed76f43248c0504fdf"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/769f6308-bdf0-4115-8992-cd753bda6803","questionRevision":"0a99c41f7efc63483151aa38ed61d87e4727977f9e12647262943bdd22fc383b"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/7d3073d4-b4e7-4b97-8259-a3cdd89b242a","questionRevision":"b6514322646d9ee49690549d007e125367f4d459139f86f3b9fb5044dd80730b"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/689d9d73-11d9-4164-ba01-8e63f06a2b17","questionRevision":"71640e13d3946fcf829d196c86c7d0f4befd2b3461a5765c58e23fae7099cd2f"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/8e2e1ca9-88c1-4b3b-a58c-b1493a2f95f8","questionRevision":"dd64246ff8f174c165625ee0b967bf3ed2529c715b33b2f742a5f17ec3e52abe"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/cfc34669-9e90-4b07-aa0e-2d1d176ee725","questionRevision":"82f9a18efa8244220e7b0fce76d37f6acaf030ae1cb4913f23d166e7153b4fbb"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/26fb5252-ef5c-4c01-8e27-c1a3b94052d0","questionRevision":"2c8a0b0ecc967dd4de0e4d9358ab4e83f1286a32d65be073b6eac69bd32c8a52"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/794b4cb5-42bc-492f-b214-19e2acbafdab","questionRevision":"75585a7a18ee30e0f7e7f6c61c2faf43c09ff029a7e85a09081df04cd5985352"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/33432fd6-0870-43cc-a714-2481aee70080","questionRevision":"e76f53c987feb33d76bd7f39e2b1911c0e8686bb713a0f0ce67db23401ae3c66"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/7878cdc5-a1c1-469f-b323-a0c758dbf1eb","questionRevision":"9a24e0690224ab8274f1d343979224bf5e074519913f9c534e2c098580405894"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/af690fcb-12ea-43df-8a19-f97490d34906","questionRevision":"7b5f3d6e9be289f90fca7daa7648c24f7bc9c49ea510fbd1a6e283fbeee935bf"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/f57e8b2f-0ba6-4a81-adff-69255bc69f11","questionRevision":"8feac902da4236b479a7e90b15f2607f0fb7ba6154a1b648e7dc381f11c709b7"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/5ab42a33-d914-481b-9312-8a53388d552f","questionRevision":"e3bf0fc0ba979a6120ae6f45c2ee2189884cd03a376f35fe908a4e1ae05b7b3d"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/28b7a0e4-cb68-4587-b1fc-a090c2df7238","questionRevision":"6a485e6e81cf347e024e782842c2c17aaff593889a84bedb9d20e65212000788"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/260ea685-5f74-423e-bb93-2066c37ca4f2","questionRevision":"6b665c60c7334b15d1d47bbf7948b494730aa6c8b40ceb4600f256db28d7d791"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/e28c0822-06c5-4d2a-bd85-84235f40914b","questionRevision":"7fda9dac3f7ae6cb3da7ce55f5c8fdea4e690779c2bf3065d596e2f686e62b81"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/9020c30f-a93a-4afc-954c-9b7d2f112225","questionRevision":"e8f674ab0be33a454117425e398e2b2784d1df3d0a2dd11f996225c2bba09f9c"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/8529be0a-f6f5-48e1-b6e3-bfdc3d139d44","questionRevision":"d2bd345d3b66ad5d56ea1bfd2808eb953789413c163a4318ec3403b98c6d593b"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/e263ba07-f730-44f2-8b52-9371520b878c","questionRevision":"a372d788e665b6a944d94a58020d8fb7fbd4ccce5c016fc6d19f1dfb1221784d"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/cf1be9ec-66c3-4ab4-ac62-bda4ec521db8","questionRevision":"f6d8ff6a8d7ff5495b6d1fce2b7c2346d43551ac2d1f929762410bbeaae109bf"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/f75d759a-9d19-48ae-acd0-0a3f49ed3384","questionRevision":"9e5fdbf576091d70476bd9d502e8b4c7e2dad70808fb220e69ed52935b06cfe3"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/6d2acd79-c5a9-4e3c-8963-365788309efe","questionRevision":"92600e5e997e29b44bac2dedeea230df47f139f2929ad58c85d0dc05e7976f79"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/454e1125-a994-47d1-bc01-816dd8366e09","questionRevision":"24899e5990e3b9769dee04e7af3f27b627b4ddebe619afd83f843fd47702f6f0"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/8215706e-4005-4ae9-92a5-96703afb9d6c","questionRevision":"b4797926899b3ef0cd223f0c10950a51ccf6b8ec882d1fb27e9c64016a384583"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/316e1307-cd57-4e43-92ea-130c425d71da","questionRevision":"364ca3f9e9015e58416aa72e249e31969fbdc23067595dec0fa55a6ce80079ec"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/42e7b2e6-644d-40f0-9605-8e4c1c68395a","questionRevision":"42ece4ce113f8ddc587b9b692df818300e4e02fa5ff77a9a27a9e00d286773ab"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/562373f7-015e-4eec-b5af-ba9d73c72897","questionRevision":"67d58a0c0a2cf407cb0af3b985762d0771359fa2d6cfe15eedc9c16166e3d3dc"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/2dad3c44-7f73-4555-b610-cc86aa7a88d3","questionRevision":"ef67fac16bdcf5cb1bc2544d4eac21bd52a45fe59cfeb4bba0904b16f63263c5"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/a741ee60-1293-4ca9-a467-98db86a1f4a6","questionRevision":"9773fa5df499aa579801092e47d7cf4928da657cc2da77500d17e12f99e13cac"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/73e04a7b-fafe-4d97-9fa4-ce73d6cf7f38","questionRevision":"da4f05db2e071bf3c825ad8f43aefcf99ddeeeb2c587bb377fc0ad1b9389230a"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/287f57d3-1ae0-4165-aa4e-fc6d0d624578","questionRevision":"e9fdc6c1e89b611177bdbec5d8a4b55a6d12a1f66d3047f5c1e296a18deffcc0"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/041cd0b9-a255-48bb-ae0a-b6c3b0436117","questionRevision":"3169f004c0e0d05d33080c3af8d80e837a44e5c8b6fd2cbc7f6c8dddb45d95d4"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/4f400596-ce1c-4bdd-b6ed-e30630efd17e","questionRevision":"1a77f8379e288d768c72d4521886d4816de6e2114626c98f4b8b5105ecde0c16"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/3186603a-fc83-40a1-9414-232c6e58af7a","questionRevision":"86768f02dcc5d9c86b92394e249fee146d2877486c58857445301a06a35b3591"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/ccedf2a5-f25a-4b9b-abc3-a7629ba2dafb","questionRevision":"f1d48bcba2126d6b9016db8f8bf539772199557cd3de0aa1951c3535fb7d3be5"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/e23e5f0d-186e-488f-bf40-478fef9fa01e","questionRevision":"ce73801a8ec9a59befd1e7b15b5476a66349022f45fa05fc396f03e07728ecd3"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/28e6f5ee-cd14-465c-bc99-ff0f307ff9c4","questionRevision":"0cffffbb898a94223dca7f03d1abcf9aaf7751c4e6f4812f577156b5725ab29a"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/e0412e0e-d817-4525-be15-293e5ae27f72","questionRevision":"a689c9f84a46428a0af816104461859abd594097ebefefe935dacbc90e6c6d54"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/eeec32df-c791-400c-822c-07bf1bb7a3e5","questionRevision":"424124dc9f76878ba218d03954a650517399a57ee0c4aa222fd7c3311f64f1d0"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/f2e71121-98df-4e2b-9170-ca42a0004c11","questionRevision":"bd2a5d10969fd440dc4f9c647237c8d5776a66e6ca2ce6878df4473c5438d09d"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/faa6a293-56b2-427e-a183-a38aabf1bfe0","questionRevision":"742f879c3329b42c08f062cbdfb66ee3342723d066ab37f1ecc393323c72c436"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/5f23241c-7904-4865-b263-df4f166e5d69","questionRevision":"fbb1191a395f568236e2795e4616f8f6902a8bb492e47eb6be9667be40dcd534"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/b46b9efc-533c-4c59-93b9-b7b312a25331","questionRevision":"bc8fc5569ff713e4029494bcf70a9adfacb9cdb71798094d4b9ff378e25d982f"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/fd389999-798a-4f2b-b200-7855a15b3e8f","questionRevision":"2177dd1b516a345de472f12094400972a96a5fd464e43c7a5f467a65b068fda0"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/80406518-1264-462b-86aa-ea62a5c2f600","questionRevision":"3a63bc59eb6d69e629d00da9801227554af1a64e01be9fcc4ee79c740a7aaf6d"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/a11d8320-d2cd-4840-bb66-c104a5589845","questionRevision":"91bd93a018b6b11679740a6a89e82d63eaf68d5db4dd95eb8b67d65b7cd64f78"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/cfb0268b-2ca2-49b6-805b-0b4cf5656fdb","questionRevision":"3597f176676208927f8464ac25ee3e5bcbb5a0373a0ebd729063a0828613abb7"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/b53c738a-f315-4098-9090-da1485d84977","questionRevision":"a5896ce2aafb4ac487b59aa176b969331c5602d0d5d0b4db265ed77c3fed8830"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/226b774e-88ad-4aef-80f0-6c42b64e6f63","questionRevision":"50667deb38385edd15d90eceb3e85cf28bbae8bd65bac8720c134727a0536cbc"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/f63bdeb7-6904-46df-aa75-5ee621daf860","questionRevision":"995069daa59064236795e73a36d68193fac6a40932a7c54f3037ef8079807920"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/6134fd78-9807-4209-acc5-60f139ed757b","questionRevision":"6baa331e1b6069741f02b6fdb132397376c46d49adc577e4331fe170530510fc"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/0c786063-affb-4ffe-b8c7-126fcda97fdb","questionRevision":"908c917320a9d1144f7c6d9a3f72ae5b47b2c20c58f5d7647b944985430a3bf7"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/eba3e2da-7191-4078-b76a-a64c33b6155b","questionRevision":"e31d5b45da1bb7f103a66badb5fb6b26f77422821589bfe69fe4be433cbfd6f8"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/c8e752a6-72d2-4d1b-b953-b42f89e76ebf","questionRevision":"35e23e068186cf7f36ba7a119b6bfde86962eb811bc9d92cbe09d3e1410f5add"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/ac7ade38-5712-4646-9a89-fb6002fb9ce8","questionRevision":"cc458408cd2348d4c6604bf30d8caac83226093a12a7ad5ad0170754c6c37958"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/25359f8b-89b1-4416-a2c0-d8e08893ba34","questionRevision":"7784e32311978cff7ea26d23d14c27a6eac1d7b5c7e0a0a97448c91928ad6024"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/1ae7b64d-e1b7-40b4-b897-567d1d799d98","questionRevision":"a9484d4e52b9e6506cc032045f241caa707c36e42868943db2027427b7124914"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/b4d15fa6-b773-4008-82b3-13531665c49d","questionRevision":"9be56470886bf125de6778143edaa2386650513c375a42fef282d66b1b09b5e9"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/7173b25b-f35b-4d1a-8b37-85a1f4868213","questionRevision":"1ef5bc90fa8cb0258fcc7efcf86a7edd5bbb5f1da2779642b4b1f949e134b266"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/d1b03b6b-959d-4202-8362-c696b3f6cd8a","questionRevision":"6b0fd019b7a256f9087258b645301157c9c4efc8f58d4a9deabf7aaf747401fa"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/78fa5216-b209-4042-ab09-de980d3d17aa","questionRevision":"ce1a867bfc10a1d268b4e9fa7cc206b2e0cb34dafb1547f3f6911ab7a2d0ff51"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/5daa2399-86e9-4c01-9b02-895a951000e9","questionRevision":"73d55251cffc1c87077edee8981ade4e2621b12f7b16119cc38bb1ff0a27f7fe"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/2891ca65-572c-4ad1-bbb4-acfcbd5d6519","questionRevision":"2440c6c7115e63fb3bb7c0d699ee6b60a06470f62dfd3bca5f1683734a3c7577"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/1758664b-d9f4-4814-872e-da5758814d1e","questionRevision":"accd1a658b1c2473eac962d387449a01c8f29ae515ab362ba70f7541d1238bf7"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/86c3df20-22f5-47c4-b044-cb2a5bfb1f1d","questionRevision":"9c778e52a9424ee80e6c9154b0c1a88d16b4f1446db30d063eb350a2a6fc80d1"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/33d7a921-02e0-4085-9e42-5a767361a4e6","questionRevision":"e7074b03a98380e869bd52fcdbe9691b24733fda7945f0c563090b5233b81e99"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/8634269b-4f49-4c20-9112-a7685b227bb5","questionRevision":"1c4cd94821e693a4f2040dafd66d447b4b8f87efe3ded0276c11b9c8b183c036"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/4a4c2925-4dad-4d0e-8481-29c2638eb268","questionRevision":"67b4695641d254796e70a1f17363b540683f8fbb3b4d0bcab1dbfe772bae71aa"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/765a6a77-ca3c-4dac-b6d0-f86f518124da","questionRevision":"9760d1069f9fbe344544b50c98a12440c64d8338729a562a9725a2aaf0eaf715"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/c78c61d4-944b-439a-a63a-08bd32f11c2d","questionRevision":"b5484750bff54e616ed2f79dc9097736f951c0eb4a8afa2d13b9578e1e284d5d"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/a01d624d-40b0-4cbc-ab91-2b71f07f79d1","questionRevision":"999974837c7ee27d08f72a66a2c8f5ddd9a297dceeb45cb20d25cccf230d014b"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/e0dd7c42-5775-4868-8b0e-b6b95f4a5779","questionRevision":"7452f597a2cb87efe08813528e6c180c2cfaae744e1fed64d40538e7d92fa35f"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/86f2bd06-3fda-4135-80e8-0b248dfad486","questionRevision":"91e2431f803c9224e64c215b1896224375b4e358a5403d2c640e51724de6b4e2"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/b21c3406-f98f-407c-9dbe-d641aee7d7cf","questionRevision":"0fb68eb037940fa18d45c57ca0d063bd89768196afb0bfb7fc10ed00e40f49c0"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/54c0e2cb-d180-4e8c-bdfb-00310284b265","questionRevision":"a5583a1eb8d0f01542f0c74fb451161aa9dd28eb82e7fde6491fc9a048ab71ca"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/1b6baac9-d897-47b8-a968-6321a121f627","questionRevision":"d7c457d73e9b27286c1894896a29f60b75b2ada401c91b5ed3f406e2a826a095"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/074d3658-a94b-49bc-a72c-51d1318b262c","questionRevision":"036db4e2686c651b488be5076c6e9914d12519b2c178f18e1168c9fb2b7c9047"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/70c42285-7709-4d8e-9599-0bebe16ab201","questionRevision":"4181f5186a2ae45e0804ed9cc408ce49692deb822ae372eb09040d945233698c"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/328c59e9-abb2-4699-bff6-1e4d4a690d98","questionRevision":"b99fcda1e845df996475933dd96b79f0ef63decc525aba17b71bf065cc89507e"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/1b5294b3-71c0-428f-bcd7-4b69e43d4e67","questionRevision":"f07a581636f3d6915d9b7a94f47b331932fe3172dc57511617d56b83b298b9cc"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/03b1b860-ab78-4d4f-8209-2dcd25727236","questionRevision":"bd3fdb21d25bcd27463e4fb60e21a779960350e6bef7146c8014e569d9464307"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/980a4da3-0ae9-447a-83f6-f8dc16672bbe","questionRevision":"22ad2be80566907c6d2b568f7c1c62a028b95064292fa094cee586c2fb10cdef"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/e96cf5ef-ced8-4e76-b286-92c9609ec8e4","questionRevision":"9a36bdad2b9ab1f7c9432fef476a59b598f924b73ab865aa5d9614b01e226db1"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/40e26de8-c297-4f57-b3ac-058ddf1a07fd","questionRevision":"48912394eab78b3bb0a959c24d989651d1d0990d1b262cbcad66e1a4d109b689"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/f0c6960e-2ad8-4c21-a5b1-749c15f76fc0","questionRevision":"60dae71208815ddb57243aea0f51f884cf9869cebbfc16a019b2448193931414"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/42e62869-4f7c-4a8b-bcd9-129872b0a74c","questionRevision":"b11604b5e7421d1e156e2025f351ce615494cb3611ce90e95120780e209458da"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/4bbdc00b-c0c1-4f1b-8b3a-669ebc304539","questionRevision":"fa0c2e7efb221075e8873cc3eaa20b33c0c3134e6bcd351955a711057f663be3"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/f42deb82-ff03-42e9-b452-bd1ab5f193b7","questionRevision":"cc97e003f0d77c595cc4c8a5841c7ead2d0946bb6de39f316481f7bda6ecd493"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/1b343c1c-1f75-4f55-96bb-c13c1b6de481","questionRevision":"fcce879edb6bfd3397af7789a29ebb9499e7f4e135fb79d58ca45ad6b3f81e35"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/9ebeafb3-f334-47e6-85c1-f69bbd62a4d0","questionRevision":"f2fe4d231981a4ddb3dd98050471e68d81b1ce8b3c859752c7d5a89e5135ff38"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/b12315d0-c803-442e-985d-606911c40dd4","questionRevision":"79b2aa894c5bb8f41dbaa6fbf809148712970b74d02f30b48458ac84ed9f5d9d"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/73843497-7bc6-4d1f-b63f-5ac99dbf5cc0","questionRevision":"837aacb7010a651949a439331f7822f67895933583c654aea2355ad8c9db9572"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/9e2237d9-e1fb-45a7-b95f-2f68bb68a123","questionRevision":"cb19ac066f3ea649c93ee449cf94e6c4d71e5709ea0a3577fdb79fd5e73a4928"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/641183bd-d64b-4fcf-9b83-b9674d8c9de4","questionRevision":"92f89f73c3ce39d24b487b02fd843a21cdf2ae98dae3cd93c0ae4e77231632bd"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/048e45d9-693a-4ca7-ac78-ff40c2b50ef1","questionRevision":"cf28d6c2b7dca11e1269127bbaf95ec7e674f5efa1ef2cd74d0eb9ea2bbd93a9"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/7d0ac348-38ee-4450-ae6a-ff67e642398e","questionRevision":"28f2688bdcbec68ca06d10058e262033957ca59159873530a79ce2a837154df9"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/59ed7e37-9077-4256-959d-cf03ff9ea9e6","questionRevision":"bdb6c4872fe106d6f5a344c371b914566d9f75c2bbfb8dc3eb1946e723cb15c7"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/738e25d3-e00d-419b-9e7f-d9cdd6b11a29","questionRevision":"c2a310de1400363a8f12ca3abeeccc94073e30ae76efae0589cbf73fc2d6ebf9"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/bf82f73b-855b-4dbe-96c1-7f987bd53100","questionRevision":"1ba587b72ac201ab0987d013590473af855fc9c763476bc835299f6068bf2bc0"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/eaad5a3a-520f-4c8c-96bb-ff87e299763d","questionRevision":"19abf5dcb2b81f55949425aaaa09a0929e75481b4320a000a5c1d5e230742b8e"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/6464de82-e705-4da9-b18a-06f1f4df5180","questionRevision":"bb02caeb283f7c16128dc09983649f453d67d40180dbedd9ca4e17bea0415e61"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/ad78da73-4455-4227-a4b1-04a3fcc8b224","questionRevision":"415d1bc030ea8e13ac59664e4ae0ad7b73f45356de60a239a989dd396b562ad1"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/3c09ab89-f3aa-48fe-a71c-7160fa5a3c27","questionRevision":"10fc9b06d03aaa60fb16198f4ab12b443f79d4005d589e844a74485f622ab6c1"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/ebdb55bd-a31d-4a46-b49e-2895ee184fb0","questionRevision":"9a330d4841f629c5502efb76e3e78121dd52611453ee97a56108b632fadd3d94"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/c77c5633-9a87-4f46-a1fa-7990816e7e2d","questionRevision":"311c807c5c94fd7609ff77741f5ca93ecd2eb8382466d4fe9c538443b7f2da67"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/59921779-4562-4596-8ca2-0dd67911278f","questionRevision":"ee5f64df9da34b996f38e8b455e318aa7e60164dc6396c792b9458fa9a04aa27"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/fdc95360-b0f5-41f9-9e1d-66c47fe18e63","questionRevision":"c71fbd429661172ab4062dcb7fd97fc7607e65a252ec268fc21a7f420d8508ca"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/740bd510-d342-4a38-801e-4553197cfa79","questionRevision":"f2fb8fdd74a92ef65e1585c9373bbdb6579b2a01bdb4734e6f9afdef85812ad1"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/4e864c87-f08e-4b60-a50b-e27264742056","questionRevision":"34776ad9909e4b2e82418d151a832609cd8a5086b87f4e03670f167e5c3c83d0"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/1538a04f-23a1-4b76-beaa-27be0d272e1c","questionRevision":"31dd015cbdd2d0e79f88f483332724f6bd72f00e2dca8bf63195cca7b343b496"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/73006cd0-db0b-4a9d-8202-2f7fc9d679d5","questionRevision":"61d9d1f6b5d04c1f4f515e25ebd16baa3a4e82d1a279fc8b192d19e54cbc11bb"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/db11226c-9fc5-4330-8b6b-c3cd1b1eea47","questionRevision":"a1d6f45276bccfdfead4b1fe499f22744a058c626f16b44e8dc134518c5f4f1b"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/21556c50-b973-4ddc-98c2-207da2d46861","questionRevision":"eb4756d1a412b411ab19883833f3e88133757fae8ea7b754d30545ec5d27055a"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/8a1a8b48-ecbe-430d-80dd-d02b676db986","questionRevision":"b45ced9d5770419bd2ad36c2fcb7214c091e1d41eb3d70ba953b10cd2abfe009"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/ec24c4ca-06e4-4da2-9703-6090614fbe67","questionRevision":"dcb839bfe7fa5ec019092606eb622e35a2e8b9b7dd705909212b8b08462e48c7"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/9ade8436-2b53-4097-95b3-37c56b977af5","questionRevision":"55167617987478eb1836b09757f10a0965cc8b78332de5870f410b26c2abb341"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/471400f3-9748-42c2-b1e7-5713e2845830","questionRevision":"aada526a5f57329029f0e34e9ed7ff8ed0c3f328eb0bd01f2942d3a0f7c16b44"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/06a95392-0bde-45d6-ae79-6ec4b2b221d5","questionRevision":"97e11414db38941ceb41cc77498db58df1719bdc2cd26036098d2d23fae51367"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/9338f4c4-8667-4458-805d-6ec09bf573c3","questionRevision":"66b8fea98e53b539fd9cfbda58a22c70a836e9e9dc1972be017974594f36250d"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/a84a56b9-0f1b-49c5-92b1-340a0588f49d","questionRevision":"74f8187925115eb344b7d9efb06a65239ff429366dda163c803bc2eeaa227b09"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/99dfbaef-ada8-4f72-8a7c-62aab7762392","questionRevision":"e59a3be795f0d48996741ef6e385a7b5cb124260abdb6df0d3d14f215184ec3a"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/8b62065a-2425-47e4-a81a-5b0cb4ea56d3","questionRevision":"6b9e7536ed9049d9f0d01c0d001e7ffd3c2aedc64c6f63b7a6a08601775593f2"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/69302093-c3e0-4ecd-8abd-915469e96cb1","questionRevision":"a76b6b5d12df0cd3a758388cefbd121f10ec28a198b5e47b801d81b81cd496e8"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/9290d31f-3841-4028-82a1-8564e92802af","questionRevision":"9e437e65d7381ec223c99302c2f973ced22b07c39d5a385df92510070f42bf2a"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/f4cfbdd7-2aea-405a-9054-224f7818845e","questionRevision":"5fb2f6dbf36e1f249ba87a48ad86e0c90b62c3a9ff06124a6cba1587dee4cb08"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/1699c9e9-f4bd-404f-ab98-805f1a2292e7","questionRevision":"525144f41fd7e023ff115fbd58d66a0689fbdf1727ed862f97e530ec9cc93bb3"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/2326e1ab-a196-44d7-9dc6-7ea7c78b5d46","questionRevision":"e22b305b771f398e087858e048f365366534e4ae7f7ac53611e992597930f04d"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/53e07720-cb1f-4b5c-a2c5-84ff15d18793","questionRevision":"240f9afedb706daaeef93156d24ad44bf879e9d7fd2c04e376b9520947d279b3"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/6bf3d65b-7a6a-4c73-8af7-8de5905f7b99","questionRevision":"cddfe27a43b39ff3bbfbc9994b2ac84ddefc15939ac494832ef45d47fe6132bb"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/523bfdcb-7b39-4167-a262-4e6998de1572","questionRevision":"8bd5e898534c5de038d7f5b14344fbae52773364420d5e1f0ef9dd2d7a044b65"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/4f9d0228-9b2c-44f2-84d1-1b40142cf5ee","questionRevision":"7d8e689cde6b4bcad88a2108ca0593fd2d1a4c7f902751d6e9c3afe064abec02"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/d2e18110-905a-4840-b0d9-710da61b4c5a","questionRevision":"66242334af7b46d9318a2c5124eb69ad370588da08e3619caf6180f6a8ef6e0a"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/67790857-f592-4dab-b712-e8ddbbeba267","questionRevision":"3f10e459301e8b89287dd76177977c7a6932de09a9c83a0eb5df01b60f726651"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/735381cf-ea0b-452a-ab33-24518cbac05e","questionRevision":"d268b9fcd1a760c717eaedb1a11daa10fe5ae1142ce13b17944b0450e2d07838"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/b74ec3c0-4f68-4ed4-8eee-21b68366b9f5","questionRevision":"7c75dbc1ad37dea6d68c30dfdedd9c0cb9fbc0401947d5526278f8b0d21e5756"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/b1ef52fa-d432-4ab4-8109-d66f054af3d2","questionRevision":"ae706f8d820dc3a81de0bc6d5191f3eb5ffb9a5e60dd711bd4962ff18e0ea0a6"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/633f8890-d7f5-477c-a33a-2a919cf05f7b","questionRevision":"b6ccf348c3ea654aaae802882ca85079df04cb8da27bfb700739c1820f6973d7"},{"questionKey":"35a68cb2-b871-4d37-9447-190c396eaf99/96a75b47-5428-40b3-a509-64c4a8f37d78","questionRevision":"2892d9ba266a3ec8eec6a89cfadee5b4fd4aeab6ae33e4f591cfbf7c7c92850e"}],"revision":"6ce382b1d2fbcdcc548ec265e4dbdf0de661c262b4473d710718dcc18fa763ba"},{"bankUid":"08d6b781-19d6-49d1-af05-f7c05031940f","contentManifest":{"contentDigest":"158659be6a1a8c5adcab8cb6d864255ea1e62410e8fb2b462f55ccbb3a0cbc34","kind":"public_static","staticRef":"banks/v2/201-composite.158659be6a1a8c5adcab8cb6d864255ea1e62410e8fb2b462f55ccbb3a0cbc34.json"},"metadata":{"questionCount":35,"title":"Composite","visibility":"public"},"publicContentReference":{"chunkCount":1,"contentDigest":"158659be6a1a8c5adcab8cb6d864255ea1e62410e8fb2b462f55ccbb3a0cbc34","manifestDigest":"194cd65508328e0d8859585003715ecaf518b8acd054ce1f9982d47b95b98013","totalBytes":30535},"questionsrefs":[{"questionKey":"08d6b781-19d6-49d1-af05-f7c05031940f/db0e51d3-3177-40fa-aa57-1ac9ea6d6594","questionRevision":"e06b6e53e47bd7b21f497486a0d1c286277c87055780d25c4ee6fbeac2af2c3e"},{"questionKey":"08d6b781-19d6-49d1-af05-f7c05031940f/e11a1abc-1318-44f2-87a1-b16d42e31c79","questionRevision":"fa877ca65b69839430e61f79af6017b9ca3fbd9d62749c6b40c1ba93e639353d"},{"questionKey":"08d6b781-19d6-49d1-af05-f7c05031940f/e731a573-76b4-425a-ab67-766c0695ede9","questionRevision":"3921955e6595f38863a83524b41734280b9789c04fd0370a3d1431ff50157c20"},{"questionKey":"08d6b781-19d6-49d1-af05-f7c05031940f/ced3ed9a-d2cf-4224-89f0-ad3eee2f1bcc","questionRevision":"552593b7f854c54c6d6085f1e51fa783b78e3b2e531f04c02bc705ffb46fdc5a"},{"questionKey":"08d6b781-19d6-49d1-af05-f7c05031940f/c1966c49-8094-4663-8de6-8f9a1af48b1f","questionRevision":"47d420260ba9a77f6bc223a9f6a74986a6e5781524ce9ff73984d1f95fb85323"},{"questionKey":"08d6b781-19d6-49d1-af05-f7c05031940f/f22f741e-ce73-4b2e-9331-de0bd255cf8d","questionRevision":"2ccd8cf86f9418cf9e2448743af58ad29104a6601c0ff96c54697c4da7f741c6"},{"questionKey":"08d6b781-19d6-49d1-af05-f7c05031940f/c1bf6209-389f-4da6-9490-5517cce7c5ff","questionRevision":"4ce0001c4ce095ec13270402cb208d54ab7bdb7720e3a509beaa472e3e476546"},{"questionKey":"08d6b781-19d6-49d1-af05-f7c05031940f/e5539d75-020b-4c02-8e50-b2d4be6de7f1","questionRevision":"b6d56e464e2109b38073308c8688d05d8c10a0e23c68218f1ff1c37522f8fe36"},{"questionKey":"08d6b781-19d6-49d1-af05-f7c05031940f/31121d20-1b9e-42d5-a7e4-b6bfe3820a09","questionRevision":"a3d3df23164f1160c1fdc9317cdfd082d72cc378d1d6bbdb6d1b901a3c905b2c"},{"questionKey":"08d6b781-19d6-49d1-af05-f7c05031940f/b4dc5322-7e99-49ac-967a-5be7cf803640","questionRevision":"1e7b9e8d8a9d041a3d9b46abc1ad1afb7fce768d02d7f0df6dd27cfb2c44bb63"},{"questionKey":"08d6b781-19d6-49d1-af05-f7c05031940f/b1f98c95-ad7e-4e4e-96ae-bf8aa2a04744","questionRevision":"cc45880ba52348e3edbaf07d2bf6e27bcef8c9e42ca75c5fe64822a927ff55f6"},{"questionKey":"08d6b781-19d6-49d1-af05-f7c05031940f/cbc26979-130a-4e93-bd0c-4e20614d3892","questionRevision":"e325595779bc3b9860e31ee5fd80d8b1012f1c7c25e7f302f4a6c01d9ea96ad3"},{"questionKey":"08d6b781-19d6-49d1-af05-f7c05031940f/80348dc3-b612-49c3-a77c-1394c16e7eb2","questionRevision":"22276ff6d2d5e86f58b79253c72ac5e3307acc42feaca3671020ea4e39d1542e"},{"questionKey":"08d6b781-19d6-49d1-af05-f7c05031940f/7c62a202-8e9f-4844-bd9b-6db79f0aaf5c","questionRevision":"e23a885c967f01d7b79c97b7e747f963475c4b6322051d16c7d3ea36639fc893"},{"questionKey":"08d6b781-19d6-49d1-af05-f7c05031940f/56b0df2d-f908-4041-92e9-61761989e5b2","questionRevision":"310eb105f765fe4b40f16d9ee66df4ad807f67ad284a7aaf4540d7d8955eb7b0"},{"questionKey":"08d6b781-19d6-49d1-af05-f7c05031940f/35c125ee-5e2c-4e3c-b9fb-c0ed99747055","questionRevision":"a78feb04bd94359c62dac5611a7e58d914399b432adc86981f2b6e6ed9923baf"},{"questionKey":"08d6b781-19d6-49d1-af05-f7c05031940f/7cc536e4-9152-4a0c-adc8-f2434356cac8","questionRevision":"64190e8b4f766b2eea753c31c0ae92de1237671f926caecf258ca73c62ea86da"},{"questionKey":"08d6b781-19d6-49d1-af05-f7c05031940f/ebd26bfe-2d38-4351-a3c9-5f888847bea5","questionRevision":"e819800073d0f465c23adc9c866fa51179a8e3f04187b3969cd242844a10abf8"},{"questionKey":"08d6b781-19d6-49d1-af05-f7c05031940f/e9166b96-fbce-4f31-a0ef-013eda685c87","questionRevision":"c5cc00bc087371c3803bb31f61a4ae7943cae7498a455d8944db12f09676d8c1"},{"questionKey":"08d6b781-19d6-49d1-af05-f7c05031940f/51823288-a385-4681-b7ea-6d96bf9ded17","questionRevision":"3bb7b742b81b73aa6f9047c235fe95ef7217f4b3ed646ee0faa113b93d7b8162"},{"questionKey":"08d6b781-19d6-49d1-af05-f7c05031940f/4e9e7971-3592-480a-89fb-a6280bfd08be","questionRevision":"e68d0003280ea472e52c551bbd4929d65d50584e4850b57fd655c4fcdda1715d"},{"questionKey":"08d6b781-19d6-49d1-af05-f7c05031940f/20f19a75-9f3b-4425-9655-a44210b64060","questionRevision":"86e3cad75cbf449b7f9a6767ebf9a8e7929fc256695128db129896624d3b7f5e"},{"questionKey":"08d6b781-19d6-49d1-af05-f7c05031940f/c63b0664-024e-4804-bd81-fb89cbb78440","questionRevision":"73019fdfd1a8a1bad8c739ba4a8853f37e41ea3f005cae081eb9b6e3322d42b0"},{"questionKey":"08d6b781-19d6-49d1-af05-f7c05031940f/632efb86-d882-4d67-b1bf-10b433ff0727","questionRevision":"5279522120e8094faa3492714b9d4b5510cebfe62ecaa179c379ea50b0906083"},{"questionKey":"08d6b781-19d6-49d1-af05-f7c05031940f/ecd139f7-57b0-45cb-a8d0-f0771116ec67","questionRevision":"b9ec79cebc14eb3a0e32fe25ad06a9e319fd199fa2ce30c1ea5af795546dda41"},{"questionKey":"08d6b781-19d6-49d1-af05-f7c05031940f/918d97c0-ff22-439b-8fb3-369b1c63861b","questionRevision":"536854d5479f2388f00a9bc1d0edea052fc3fce99821da8cb214b0aa742a19ce"},{"questionKey":"08d6b781-19d6-49d1-af05-f7c05031940f/34815cc4-2b5b-4ddd-85da-346509824a36","questionRevision":"5d6f6b00cf3ca6c0d887eb77941b3fd4bbaaace1e2701b2c41e74f443231b8d4"},{"questionKey":"08d6b781-19d6-49d1-af05-f7c05031940f/7fb24d17-eef2-43db-861e-ba9ca9de7516","questionRevision":"f0214166f4c6bea1d55414cfd4e652c73e0291d8a3fadd96bf3c6cde7eec1fde"},{"questionKey":"08d6b781-19d6-49d1-af05-f7c05031940f/15ec674f-9dc9-46dc-86da-87ecc66d65c0","questionRevision":"3a38abfb6fe497c206d6eed38a6a2fe4bb8689f2af9005c44298e366c8d213ef"},{"questionKey":"08d6b781-19d6-49d1-af05-f7c05031940f/c9bcec28-c222-4d5c-8733-3769abc6289e","questionRevision":"3e64eae7118006ce1f6822911bd0b25f513d840266eae58d5987a3396250b6e3"},{"questionKey":"08d6b781-19d6-49d1-af05-f7c05031940f/254f9136-b1fa-41fb-9899-6efe95248862","questionRevision":"3bcc34f4fe0e1236c7d4dc1d7581da620097af29052b5ddeb1b229f89126515e"},{"questionKey":"08d6b781-19d6-49d1-af05-f7c05031940f/36b80377-1aa4-440b-a044-be31fddc68c5","questionRevision":"4370978cf1a0e5c0a4b9c6e43c9dd85b518ecd9a6660cc0455fc96f1b864df1f"},{"questionKey":"08d6b781-19d6-49d1-af05-f7c05031940f/36418a36-8d1c-4515-a550-fb70de943f13","questionRevision":"809d77fd57665edf5210aafe5b78a36095473aa05fb9ee11e64a6e71f9f18af3"},{"questionKey":"08d6b781-19d6-49d1-af05-f7c05031940f/f5de4f9a-6970-47ee-9cd7-02db0a6f58bf","questionRevision":"bbdb0cf2af35aa76fc41cd3b886cfbc7f25a40d9266e068f5d13e6935849bde2"},{"questionKey":"08d6b781-19d6-49d1-af05-f7c05031940f/dcc64f6f-4ddc-49ef-a91a-35937484f4c4","questionRevision":"bb28218573c8c1b7052ad69189804524d225627934a894e700b67f8e80bc96d4"}],"revision":"158659be6a1a8c5adcab8cb6d864255ea1e62410e8fb2b462f55ccbb3a0cbc34"},{"bankUid":"7c8ca573-7a7c-4cbe-8769-054719e65394","contentManifest":{"contentDigest":"87fc9eb3e435675e12c53b081f5639344f157c9abda70bcb1843747fd2eed781","kind":"public_static","staticRef":"banks/v2/211-sheet-metal.87fc9eb3e435675e12c53b081f5639344f157c9abda70bcb1843747fd2eed781.json"},"metadata":{"questionCount":246,"title":"Sheet Metal","visibility":"public"},"publicContentReference":{"chunkCount":28,"contentDigest":"87fc9eb3e435675e12c53b081f5639344f157c9abda70bcb1843747fd2eed781","manifestDigest":"49b385ca22c57acecf9c68c842d6e36733a1a1d621b3ec764f689705a0f0eca3","totalBytes":14476938},"questionsrefs":[{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/d8d8fe92-944a-44b0-bb11-fbab41ba8e1d","questionRevision":"aacbeed43c145b78b9f0c0ea9a3f886e22f4f964d6de2f62a73643daf203d7e3"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/581f1e8f-ba56-4889-81e1-1815896f1e04","questionRevision":"591bf2b17078ad198869afdd524f1445df7fb6837dca2e380e76d1523e658821"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/26061e48-3d26-4173-aa4e-32c73ccd69c5","questionRevision":"2f6f374b1f2ece0824ad1a46ad65442f99d48b8121a26d3c430c2fc0e60161c2"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/4c9d233b-1ca1-4554-a7a5-c00ffcd49518","questionRevision":"ed2c5baf79715089a7c789112f21cc928233765c466d81a9811548e54c0cce6e"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/d40cf680-a37c-49ff-bc37-a3a0849a1d1c","questionRevision":"abdbc223a9cbc58649a910c84d1fcc5c27da0d4017c382d826bc425078679654"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/277bba37-d865-445a-849f-565dc812a12f","questionRevision":"a959c05014b8ec00f065b4309e398556480d19f9aec9763fa8872f00a3877b6b"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/a33895c2-08e0-4739-8865-513b89084f17","questionRevision":"cf90cac851488ba80d12151d73cf76a8f0801a67af2798264b3b4bfc0f9279e1"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/d63972fb-8ba4-423d-a7df-b21bfdf995d5","questionRevision":"7317531daf84af4773e0d4115055da913241b0d88e621bbcef8a542d85cd32a4"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/0a37d543-ad54-4e0d-9abd-3f9e8a3b5ffb","questionRevision":"7bf51383fb1d833ec1a1960ef2ef922a4ed870b17dc42efba96c32d4573202c4"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/00b53d8a-9a0e-4325-8b27-935b1de25c05","questionRevision":"8d978ff97373f49f93d88169ab2ceeab125ce909ee901355eaa46f52f7e32f11"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/19f293be-1655-497d-9cec-be77e4cbcf58","questionRevision":"778d78b6c5a1636075577e9a617d0372d28cb23cb1bd11bbc08a15e1de76538a"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/6c78a37a-25e3-4894-b968-bdb7925b8224","questionRevision":"2bbf6d03b4724307ff06ba69e44d190f1fc8543f164756df818969ea195b65ee"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/9eefefa0-6543-44a6-92ed-540732f8f732","questionRevision":"8ef1068b3a4df88a97b815a3e47fcb91cf95a401f41748d1ed0628bf9b421810"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/e55cf3d2-4db0-440a-84e3-1e20414edbf7","questionRevision":"cc4b826767efc346ddacc85ccfe5d19a947308ccacfa1e3f5a8326d8e7534d80"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/d4070f5f-eca9-4480-8b7a-f041213b0dd0","questionRevision":"cd5731b7a0810672877a000ce02f3d7e45135f410472cec2bedb830bb020fd56"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/4c176c59-a02b-404c-b937-9bb43999e7cd","questionRevision":"8cdcaf8fd6c4efc66ffcdcc4b537f0dc91975552c311ccdf1f682caa06bdd76b"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/ec4060f2-27e7-4b38-bfe0-116c4ac31317","questionRevision":"fbb379de5b210fa8276907d8844a1b49f4989754f390c52b4593d5071290361a"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/5a0875f3-92a5-44a9-9b28-bf48d1dc754a","questionRevision":"df41a89e6319fb8d1dfcc6ce4c79f6d68bc94fe804684a8d8c973249821428d3"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/1bb36e94-66d9-48f6-bf02-811e9faa2c0e","questionRevision":"93f5c9b1106578aa043e3040a5ee8a928f5808ca9c396441170529bc777bec65"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/8de5cf73-76dd-4416-8eb6-e0090003ca5c","questionRevision":"b6fe8d879aa91ee3ef2fb9be0c953e6558173cfd321d2324bb9855bfe57af758"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/36105182-783f-4638-afbc-f3f3abdf24c6","questionRevision":"8cedcf6389e92bc9caa533d1f9879cba88755aa2752d983f48561111656253ca"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/0546f681-1f79-411a-97f6-4dc856f29cf4","questionRevision":"0671222b2d80ae269bb3c3c2ce4e4e796845ac3836d625c69172da9e12bc4560"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/4c85bb76-8964-49c8-8d2c-08ce7ccc4b56","questionRevision":"91b11c476ef481f53a2a97bfb23c42a3845fd632baf7a2c27a10cf6714adcd61"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/feb985f1-eecb-4c26-af40-fa6c7632e72d","questionRevision":"ddd6b9060f75060108373b5fcf2293362e039e4d2276626c53317ed3fb3b899e"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/2a601d59-b73b-405b-935f-cfedf191f971","questionRevision":"0ce4e982c5150dfc10a69bd9152068c58fa16c7e5d0c6eb6c665454ce23277f6"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/4255302d-9978-462c-bad7-f2ddfb35a93c","questionRevision":"337d5cc6856720a4f55c56194e28b95fa2ce19706fa333249f8997d1738883a4"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/b16df7e8-155d-47a9-8abe-dcd6087765a4","questionRevision":"240abca0bdbf9b60ca9ce697cae8a6e9e1f61843b885227ac88a7df1e3ccd12d"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/e7f209a2-43e7-4829-8d2c-8fcd5fa925d4","questionRevision":"79bc9a107468571f45c3115cb96e559d2feb2044fc41a7973f2fb1c886188d8e"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/4b6882a8-29c8-46c7-9625-6fde69884c05","questionRevision":"a96f65d07f8bec4ce8c150184c88f506dd7684f268b31dcbbd9af1fd6b9b84ae"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/8073a51e-3445-4d85-a9e3-59a9821c7612","questionRevision":"7515bf346ffe6f1d34bed1bbf93e574bbfbbd25d54e07cceb1ba387d2783b398"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/bfe9af95-234c-4927-8009-5bfc6d34765f","questionRevision":"071db3e981df9e0cf7dc7b24fcf83f21da8c5c3d05585d6598cba6e54d218103"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/d382d239-daff-4e95-b23d-bf04ed029b4b","questionRevision":"3a65129d499aee141a5a303342143d0fcc0d9587d7e8b878de6fc6e622840df7"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/26989e75-7931-4be3-83e5-78b41f81d569","questionRevision":"f4d5fd1962c5231774ee8b8fa2bc97ba8c727150bdc29c94a768cb68dbf6e2f4"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/d7e9c9f6-016b-4a95-9f57-e9cbeb091745","questionRevision":"0a6aa9ff7e60ae3f2b95f3ccd5267caf9391b40dac6160f4e84e83cd7f23cf68"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/2df05750-fc48-4e11-a642-cca77e7fe739","questionRevision":"7a04a22ba0d4cdfc5df260bb98f1e1702fc06253187c4cd107be2db8a9aaf7af"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/b5f314b2-6761-46c7-a679-f92ea7c90bbf","questionRevision":"ed4a4628375df839f170e26f0f977a12fadd5cac2ac021ab9280f685bfe70b88"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/40feed44-3899-4619-b642-0c3b34b042fa","questionRevision":"8a27d6a8c4f2a6d3ab694adcbacc6181ca9e006d315841532bd9105548543658"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/efc52473-08b9-48af-b22a-04eed631112d","questionRevision":"6b063fe38fba2253313d3823ada34fb43979ef04ede89bb5697342d5cf38b861"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/950ad96b-0dd2-47ec-824a-5d64e06a69fb","questionRevision":"1e40364be40981eed82814f14194f489d0a671e072890276dcb524191fc49361"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/014d1fd5-9556-4648-bd3d-5c354bcc4900","questionRevision":"c875f8fef6cd3788623d81d05b694ff38c082a2a3c4cd326530bc5eeba4c9c0c"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/cf246a50-e6d3-41a6-8dff-91f6f32927d2","questionRevision":"94a8c164aa63e1f0c0fda6f717b1c6b83d759ecfb2f4a02321b196e9cdda271e"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/df8432d0-c2dd-4b2c-9c30-06476765f3ef","questionRevision":"e7cdb49e541a423c3be79d1e137ab27a72ae3d40108499384ee830524273f63e"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/15ca25c7-c5fb-4582-91cb-6da97e88a429","questionRevision":"8dbc74f110e5bff4f199501405b470b468520bae0a9af95c94b7e759c980e062"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/9665613d-53ad-4bbd-8092-76f3f584ba9a","questionRevision":"dfa68486f9d651f68837c2752b051bcb1b0f2dba883e680cd91aaa1ad1dba9a5"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/8568aaa5-03f8-4939-b459-ce5ae4b74938","questionRevision":"a043b5d4e8c6e1f94a5d3cc97ebe4a826f64d8cce7f11259cd47d3644c96c340"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/a503da0f-7e08-4c89-8af2-3a01e33e7208","questionRevision":"9cb034deb879c04a80c2b9c738a990ff3cb4da113007f18912441e66d4ed7dc7"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/eb980fa2-edda-47f0-8483-351f406e8f0c","questionRevision":"191b8bbb5e0cad95f45b87a7f21026a70faed576d112ae423812c37b19785410"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/ce3a3acf-ae01-48c4-bb9a-123bbcbbb09a","questionRevision":"c0ddcd33a62da96eec6b191f54207b1080b7e1a646539c8bce0a58feb25e472e"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/af6ceb59-0426-49af-b5f8-f694a0ac5993","questionRevision":"35cb32468f2041a406edb45863429eda0366d527caa3f8fcbbbe6ddbed720e3b"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/bf111323-fbc6-4e3d-a173-5adc938981ed","questionRevision":"06cb92eb29ad21649780c3000d4321d24913fd6ad58fec07c52a0808575ee02c"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/a85bc982-7f58-4172-896d-5aeecbec52dc","questionRevision":"5dfd6ef47b8327c1bd69a5ae34bcb9d4ba0a7f57257733a6521d31121e9f6bd9"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/d80ef2a3-4908-4e6b-92cc-82b6009e54f5","questionRevision":"3ee8e687c150f8f3a5a8149f695b5525e0af3533d8cc2df6c12ca080300d7da0"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/0099f37a-da74-4f58-825a-08aa1d86f03a","questionRevision":"b2c0accff2331eaf4884b7a95bfa94d8023a04906c219f17fd6c101632c647d9"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/d8c37ac3-8b8a-410f-873e-eb44ad19a9dc","questionRevision":"d8f3e042c8ece1bfb63da2e30940b56eba0427a8807cee1460574d072be1f88f"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/6e2e0e46-c6c6-47c3-a770-b2233e787caa","questionRevision":"c466b4335ca0e8ad71cbda895f358c66a31177a19936bf25dcc8952c9f8b806a"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/10dff581-69ee-4379-a3a1-219d413b96b1","questionRevision":"039b5d0a313c3f6c301d0a2e6a2e5c058eebfe3d707ca868445b48e1b0dd3b3b"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/5b74e3b6-ba06-4a81-937d-7ef45d67e46a","questionRevision":"fecbce3a43ee58636e6b67f27b768434e8e8f73fe3c5cc1a5d1d5a03645e2348"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/bb3ab240-e4d0-4e18-b4e2-a52001f12ab3","questionRevision":"5000b38bbab398797c32756fe021da131a8012806697c032593a25f57534bf64"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/26bb42c7-04d1-4e21-be04-f27f2a27a7dc","questionRevision":"c54bf4dbc57ef8936caf79945005fe327753dfb3ed5f65b07b6b7565a6182800"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/d9d0e0b2-f8c9-44ee-9d88-faf81798e64b","questionRevision":"09ea7fe32fdfa88ad3b14e74f4f43af39b20c00c8d29aeeff8e02fc2add2770a"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/8b736215-c6d6-4017-a579-506b18c1473f","questionRevision":"88ac388344d47eb86a0beee989f9bc0950e3b9aa39163ccb6893658728f6993b"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/bf84838c-eccd-4718-babf-a13ad7ac3965","questionRevision":"ad079c1aef5fbac80633c504f7c7728874a926532419adfee30179bb88654b9d"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/c4569baf-964c-4258-9199-b7395ec730cb","questionRevision":"61c5948f72db383465c73295f93bd3c147023decf90460eb9764faa314e8ce72"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/fa7d30cb-aff2-420d-8639-95fa910135ff","questionRevision":"4080470eb3bf994cbded2b31caea460379a1314dddafbb8fd6926da5c9d0cb58"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/7f905ed4-d174-45b9-a29b-9400f9cc58f1","questionRevision":"dc811c25678cb4d286e4f79fe2c003dd1d593222d22c0169ab30fdd0a02d3565"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/80825078-eb2e-4040-9536-219649d1bb4e","questionRevision":"c4149d2349ecb9ae82973499b0c80015dc6abfd3f71267b03a66d39c14f7ebcf"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/fd44d355-f15e-4cf7-8373-2e721f92a6de","questionRevision":"9c2cc01f8ddb73be9ab38468a46f4490a9ebd82c2f3d3e1f44bf3f6800d5f81f"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/e8f07460-6c38-4949-b46a-d4dc05694bb6","questionRevision":"a7d16b47e3153f1dd4d377071f5b0b22cf9c5dfca08b33cf491e1bad92377823"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/aeb14b9e-ee3e-468a-be22-a6aa87362057","questionRevision":"f364c6baded13c13089ab2f362db6360f941ef2086f97dd9c1f2d26125a49a57"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/7d7fb261-225e-46bb-b873-4d16089fe285","questionRevision":"7ce6cbac9e4409ac173f7d7e44707b508559fb2cd6dc8b2f0b8bb702fec08bf8"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/f51dcc24-a481-4cd0-abb2-0c0d3ad21f7c","questionRevision":"c5782141cac1ded3e0c1a62929328c98a546904021f99eae3b770a02562ceebe"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/3cd4f602-80a1-4dad-b602-6b15ca4ec3cb","questionRevision":"5375770d654275b318b545045973908d217858e8e67ae6d80043d3830d707fd8"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/a2bf346d-fcae-4538-9fd3-aa7cc263f9e5","questionRevision":"f10e4470711b88a3d89f22634b161337aaab40c1ce09bb135554b145962cb417"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/b6e88f5b-90cd-4f62-91c7-1ef9ead6671c","questionRevision":"aa5e61810610873127fe48683626bbf82bd83de1a823b985693b2c0cce6a829d"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/876f52e2-1afd-494e-895c-8aa8d5be45d5","questionRevision":"8c29360397f1073f6b0c64d50a36fa80e5430b746d8d396346f5e54523c38ee7"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/ee2da25e-bfe0-4730-9c44-a9b183e5c6dd","questionRevision":"8d03dc87650a4d21e5252446a4ffdad0eb56d32778dc792a2634c185c655c948"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/598f34f8-3056-4022-be54-6fca2715a420","questionRevision":"538fac72371ddf33181d758b307df3d92cad1219ec6601d4a2079605ca469d4e"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/faa7ffb6-d991-4963-8d87-dfb6cb6572f6","questionRevision":"44df5a15400711c2d1313769950cf9c695df443963de2ade3c10182b4042c937"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/3bfb9d9c-d829-4b60-aebe-977767cec4e8","questionRevision":"452f7351f0f3b93fdd119c57f7af7391eb3bbf9f4ffde70e036c8863ebabf322"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/b22693c4-cc15-498b-998a-b894925ea2a4","questionRevision":"b2dc780205c12e6a05c17b9282f8bfe748a6add693840c777f576e7370db2342"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/c8d8449e-2e2c-4d68-a9d4-1c44b4041b8f","questionRevision":"3d27f4c5557b1d2631f0823bc5aeb31e4df1a95680440c2138abb2f2c6b3ca8a"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/d34c92b7-f3d8-4d67-84c1-142ccb124ce5","questionRevision":"cbb5e3d69713a462cbbae11f676d49560f456cfec188f4bb98f1af60b73ac3fd"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/b606f85d-5040-4366-a735-ff97c57a2578","questionRevision":"53e63a8d8b4bfdc981adf14fc4d7428d34cfdb807083fd4a73d006ddc9452b3b"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/d17ad429-ee36-427e-aa1a-2bd1f66b8d86","questionRevision":"85d2cb65353c6d4211768e2118d32737a40c0b861ae9b1fd086262c1e82967f4"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/1827ffbd-6722-494b-8660-f4f8b670e129","questionRevision":"28d7fc0c5a45ba521a45288863e86e75dae6bf3aaabf902f48f5e537836b14db"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/1feaddd3-509a-4cb0-a476-6e5e87ac7813","questionRevision":"7881f5951100f4647699d47e129d0bc5bbfe816be6561efbad3293fc49714e55"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/607bb165-12eb-4dea-8945-27952b7b6ad1","questionRevision":"263487af38cba47ca552779572c68ceff3a1edab44000f41838aa2be11fce389"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/60b6b0a7-9bba-44bb-b606-865eb2049012","questionRevision":"e5e9559aa863e58742e739867f0fdb01dd5a8186746f897447c2236d1652f7dd"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/696f611e-f431-4b37-96a4-503d038c5f32","questionRevision":"a95185ad5ab3ab05b4015646beb303619ffff0d3ede20e4a52a6a9b0fe9a1a3f"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/680e1a92-f937-491e-95bd-4bc6a7ac423c","questionRevision":"3aa73b4a2e062f72c9b686c57647c04f169d1551c06ae8599256c02cdaf76ef1"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/a7ace873-2b84-4591-b03d-a2d78f61334a","questionRevision":"8813ffd60058d0c4cac9f39fe129f91a6d53163b28abca20428ed458b632f9b9"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/2db133a2-2340-45b8-a3c2-3aaa4c86182b","questionRevision":"55eae3a3621f0923d986bb8f213a031c31dbf714def4c39b13900f70e062720d"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/58be8f2e-c61e-4a71-ba66-c0befad84d73","questionRevision":"60f183063d505d0270706202476a61d92c30222c00ca190898e816a32bc78cec"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/48148cdf-b7ce-4d87-91de-7f87645285cb","questionRevision":"d2052c058558328edc7033701dcf113b22825d316f3cb5b619fef0b59c83128d"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/d1379b8e-9a0a-4cd0-8345-0f0f2de100d8","questionRevision":"6ecd74ae565bdc70d933f9b716bfed483e11eb19292021b1decbb4822bf708a8"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/0ff00689-0457-48d6-a925-998811f45da9","questionRevision":"217978f0b5d3bc0d0b5ece3c6ab918e24dd803f6c872f1aa74b43ca5afe744ba"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/842dcef8-ff67-4242-97c9-5826a81ea1f7","questionRevision":"8a6aee290443bdb0daf69a4aa22da23ead403433d740eec4a07d90ddb2c7eab1"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/53a46372-93f0-46f7-9b69-603ae7d86ba9","questionRevision":"adcc293d1337a4915b2d19d74de909e9fbaed09149e30a418f08b60caccb8cd6"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/93bd3f44-1817-4fed-954a-a3e61cb3ee38","questionRevision":"0a0d8e6ecddc87b600ac4f6e23c14ec03d409ad798340d34b67647238a5b0ba9"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/4ad9bdce-d244-49f2-930a-2256bbca8462","questionRevision":"1bb38608384a94c217bcf9b55a74ddb3e892e9014ebeafb5b8f1fcf62a6fb39e"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/7fd515d9-4adb-4b8b-9093-e18490cb8ed9","questionRevision":"7d71758e2d931a7f7a9739a79873213960f3f12300759bbcae0ae0cf3647def8"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/93131049-3a9f-4435-a0a2-a33baaa32cae","questionRevision":"74476ec11a6dc6133cd84975ae4996b40e0e739e2d2ef949818159342c526e53"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/a942b06d-4bba-4bf1-8116-845ff945c603","questionRevision":"eeb2df2340127147ddcec78af5c53500960b8d4816ca5b7ece70c10a8840fbb5"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/388c56c7-24ff-48d5-8309-e47e1bfd8748","questionRevision":"0549aec347e14ac8884e635898672a6712f3935f7b88120c7ad405c02727b1ae"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/5ea26def-6be6-482b-9adb-bc9f76de2f17","questionRevision":"ecfb77fd61b1091967bf36c74941f29864d2ee3edb3dd0570cd1b8bd2d22aaf6"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/90be94df-ecd4-44c7-8b64-0d9c29e9489a","questionRevision":"d87873f00476a675355c0d1003937ca1c5dd63776cb7aef2514bcee438219deb"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/84902ccc-3d31-46bb-91bf-62e8713d9be4","questionRevision":"e04b8cbe556bdbfcb12668e038b306d6f8dd149691e3271a19b6cd067b9b4778"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/48934549-76b2-48a4-af2b-a1a36c9fbc5e","questionRevision":"2ff1142b9b780ec5fac7e2c0e5d42d70b1f8c088483ab6417f9a61183c27c1e7"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/83adc91d-1c00-47cd-8766-c654c66e3a1d","questionRevision":"f7643e1ce7977005ccc91b9955fccbad580786dfdbf508f6df6ec1a0aac83564"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/dfc95f54-fb00-481e-b571-3be2b4843b1a","questionRevision":"225897b8528dd8abae5270af1ae52fae38b25021dd77d1e5096d9d6220491b8d"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/73b1bbd9-6161-4499-9c49-014854bb5836","questionRevision":"e942abd1e16fd00217ea4f0ad95b7cf2fdc5f71a0dcb1450f808836c44c20cb2"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/1e8d68f2-98f1-47f6-b55a-9f2caaae985b","questionRevision":"abe3b2e40cfc69dab05b8aa4ecd7780f0eae21702e3f6304f939110a628ba909"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/2cd81aa3-8d8c-4645-8c35-74b25404a6b6","questionRevision":"4ac52038e6fcce47ee5d5a6c07f6c6dac14b6650eec20b95737e40345fd857b7"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/5d28dd2b-365c-466e-bdc9-5aa4f0ef8bfb","questionRevision":"5ca2b714df2a77be617015e12e3c06aa038715c2b3a3443e8e927e0240389372"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/1982cbbd-7132-47bd-a5ac-400ad00463bb","questionRevision":"6048747bea12d96980c6f396357795dd599f6369b189e5ab85d88d7be7054ab5"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/4642d499-744b-464b-945b-abd06c658f95","questionRevision":"2672b6e3c63aedf8f2614053b15236569e58a2b30a7c052018cbc7edc3483ddb"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/03459616-68a9-4073-92c0-a4908a1459ab","questionRevision":"ab0d558c6b3b624ba5a9f0aa70887292dc4957d4f6006f7edb025d9a26385168"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/8db55896-cbee-4bfa-9740-e4f6154a44a7","questionRevision":"f9136432eabb43d17619842547642436970754a7ddd9639917f0d267130ba6fe"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/8ba67734-7a38-44c5-865d-f736f800515d","questionRevision":"34155f7a9039433c91fda1286e4d0a66e75317efab826e18e7b315360dc04a18"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/956e321e-8168-444b-b4e2-105925585cc9","questionRevision":"b2617bb2e2df796d894bcf8257a1305446d8653496774f23235c34848d73482a"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/df6a5308-f312-40af-998c-7b6f33d5a443","questionRevision":"b363087c5b5949aefc86fedfd78d23ab04105b4d03e7e4117821bd15196b2882"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/ed31c48f-b34a-49f7-bd71-9aa45ed3811c","questionRevision":"a5b1756627734f5747f72e50c31dadbfe7bcbcae51985a940b2dbbeff35e83d1"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/08935dcf-505f-4317-88ed-8cb8147662af","questionRevision":"761e603a18c66c9cb718cf53cd53011ab579f217ba02b6b2deff2c589f2ddcbd"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/92382c99-4ee8-4a8c-ad7a-143ad81fbde9","questionRevision":"b5052d4951b5a92247b313c92fc8a7080ea9276d63e65dd251df4c78817cdf03"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/6dfb1ce9-b7e9-4bd6-a520-8228e8701d19","questionRevision":"3052a675a6bfbcad97d2be811caf3e75727622afb535d866161fadfc30146d81"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/554bdef6-12c1-40cb-96db-202e42c3ac14","questionRevision":"78601df63d4282cc97645e88678bf7a07bae02714abcc35160fc0ff05e821b0b"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/538d4407-253a-44fa-add8-3a8bedb188bb","questionRevision":"42336fa85d03f1c63cbbef2c70ea638e332e53acc63aaafc16f82bfff0b9fbb8"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/ad8bba05-22f7-46e7-8d44-f9cf7ef8e425","questionRevision":"4d20aaa9175bf188046f1e66b7aff0ae93a8a2ddeba94129a3d87ee2ccb0817e"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/d1aca8ce-d441-463e-b5ec-a9d8051d56c2","questionRevision":"f30b1f5edb1e4fb09566bc2782b3e17de4da4107d1a7ca6f651a727f6c0f8417"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/c099dc0c-a475-481a-ae39-d71c6259f5e3","questionRevision":"bfa43fcc66bd12f5505e3cc626db9780130b27a19813f9ebe995d4d5fc0aaee1"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/26aaa578-eae6-4e1d-b191-dd95256287cd","questionRevision":"d1a9b267fc6d35447a1fee6d1e0730605c56b9a1a42929b4e89a30caa0861507"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/b396db85-7aff-49da-8aae-da6d6593eede","questionRevision":"8a3ecd79d7e1fc9a425626c40dadeefa762624aed6e71fab583f7f32d1ba0364"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/5d1bf769-ba52-4bcc-9195-dbd6e913d25c","questionRevision":"5e2c03310b7d2d374fc460f148a613b672177578932e3f74f77de994e17453be"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/83388416-41d5-41c8-b46e-929d175c0ecf","questionRevision":"f30a54d9a8a8c6c66900e9b5ea2c5b3ea3cd28b7c3a46e0378dadf72361bf5e2"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/f76c4e24-fb69-43f2-bde0-94503ffa0170","questionRevision":"23ae27bc692788f8ec45b0a06510c9109c10d63192b86f50b0b1b9a80371aab3"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/6d0d1943-55b3-4612-9cd5-b3939e6540a4","questionRevision":"e152afb841c8e8183e9f2bbe853b8178ea4e469a7d0c789060a71c13511dc56b"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/47da7b44-649b-44b2-b6bd-baefe4ac0aa5","questionRevision":"bd3b435dd0edfa0c3d3a04b68028c36d14566756f7f8260674b866a780c450e8"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/92de9326-be7a-43fc-8313-b334bb856654","questionRevision":"349ca8812313b2fa0c428367547a1a49ca80882684d86566571d5f1040d689e6"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/e1e35e6c-20a1-43b2-8d72-2d2974952f04","questionRevision":"de1635b3ce08ce150da15580740baaa69bc54e312df9efbb0cd32e2006bbd502"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/3ba98463-56c3-446f-8d90-45dd35d02022","questionRevision":"7d58fc4be9b8712bba7c3f84124173c8ff47acc8336a193242615df37419f205"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/9467106b-26c7-4a14-be08-b45616cb6554","questionRevision":"e2a9fd598ed418c6d4272064f203c86dfa6fdf5f3f451da2911db9106a07e0d4"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/ebed03fe-e0b7-4778-8252-7007a49b7e59","questionRevision":"bd659af11c0551880c695f925463dc2894901930de94b06e972539d88830163a"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/3f1e79df-3e26-41b8-9237-f7592e985d1d","questionRevision":"4e93c7480211e9c370013144e0401d2368b20ea3558297192a103c9a102c727d"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/b581eab2-2e60-4c5b-9b79-d45620292012","questionRevision":"d33c0c30c69302b32425fb81ea557cf8ac41ad83c63b9d3a37162b5dc2856e82"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/a8007f9f-e734-429b-9b07-2c889fc21988","questionRevision":"a279ee87b1fa238b8e572400ddc43c60322c23375a23e553b944106579800b7e"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/f53e66d5-b12f-4f11-bab0-2db4698826a5","questionRevision":"fcf54e69bf2473da8193ddd1bac139627ac40a04c756efaf38c135d818b6a138"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/49f278e2-7c97-4503-9cd5-b8df69784f1a","questionRevision":"e4595bdbda42390099f41a1677e8926554000e77a58efa1a3ad920c97f56a479"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/725e147a-d0a2-4ad3-8314-b5d2dd062a61","questionRevision":"6c07c441db1937a22fdc52c4d7cccb49ed6ee86f64b3d8fb90628d9dcba4125a"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/8f47b531-49f6-49b4-8db0-1d295e03b543","questionRevision":"938385b36a0a897e7edf513bff455cb10d34a64dbdd5ed2c591ceec5a741cec6"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/a77d50d4-1993-406c-bd7a-d6633af28ac8","questionRevision":"b5f760194196c1169ace54f882de17a46772a153d6bff03c647423afb0ce18d1"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/4e2d25af-35e4-444e-bb2e-e3fe38ac6c5a","questionRevision":"ab8417add5bf3b52f0f8a1050c06e6341ab416527ff6993739f540fbc4cf5612"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/048db0f3-7a0e-4945-960d-475d2b1fd551","questionRevision":"5103831b5b6e85aba48f17d4db86ca346758412fe2f1e31107401a43e0ee51ba"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/57b60f77-f60a-439b-8c4d-1f21678a4767","questionRevision":"064bcc0cda16433c0a22360e66de03d6af3fb7ef8d1c163678d6e5132ad6d35e"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/e5960370-3443-497d-8b65-804c49c706b2","questionRevision":"03eab1406029116346eb8b06434ff32bbaeefb23d051524219eeac54525a7c0f"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/20197ea2-814e-4445-b5fd-e304e2d9be15","questionRevision":"ed07bffa4b9862fbe343746dde4499103dd4d06aeef5fc7fba33583a12f73e22"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/475b933b-1b8a-42a2-9580-4acfdf771a03","questionRevision":"bbce81e84939d30fa380d46caa9e4591f1ab701a46c79821c787dc9c81829a27"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/6a5c358a-7989-479d-b7de-ea65d1bc584c","questionRevision":"8f17c801104a3b3de38b1a37478d4aa24d9e42d9dc782d6af241faf324c272ba"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/1cc43acf-53b9-4aaa-9799-5fed527c9b87","questionRevision":"69b9c33ca09c9404c0e0efd1c8cc7ebf934ca7ade611447f7cac059ad730d59a"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/dccb9dc4-6d00-4d89-89a5-2eed06e9b241","questionRevision":"8643f9501899469b40f0dd86062036fe3383067b8bfd5631ad7f107e074e4b63"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/c5eba458-74a9-4b70-b4ce-52dbcd8c5ae5","questionRevision":"543e6e5b9fa125e8153401671df8a122c29e2a353947d9d9cade132c2c6ca9b2"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/87ca9987-f013-4762-976a-c46476bfda32","questionRevision":"274a91b13b373e59dcc56e50dc9cf6d0be92034af9406f3435edbd3395f9ab61"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/909eabb7-7d2d-4c45-ac28-a8b1654f5b63","questionRevision":"6141b0e752c8830e96b43619a91d9a5245548cdd5b1deedc1244164fb938b2e6"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/7535f7cf-92b4-4c35-83f4-d97679c56eff","questionRevision":"7dc964d4a5bdfd89164aa7a584a6c12001e3cc5944ba605e7e2a4f3954d20388"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/93adf3bd-6ce5-491b-b21c-21aaa1fb604c","questionRevision":"841befa8c1b547c81094c10922db19dd67ea0561aefb9ce7add3a3d731954abe"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/e3a217df-b15c-4cf6-ad09-1614abfdfc82","questionRevision":"8d4d6d41b93ab4a0c543e9962c11cf52c39647b88b9264f1eb12505771f169c6"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/aa2e4e67-ddb3-41d1-a323-3fa62f4c70fd","questionRevision":"0ebd46c44740d5abf44192c8c2882aac652e1c8ae0e8b765979824270f5d3f50"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/952f172a-95c9-4664-ada7-0d69cac47e12","questionRevision":"a0005a26b71317ad82c04ba32a3510197c7dd6f6bca40be37988ffb6874371a4"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/aa0d4aed-0414-4bc0-8821-c0fb437f95c1","questionRevision":"a6f8d468fc21f1e41c173deada4f4dc96a9137c3d66721665c3f8d26f3eabb72"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/23f3fad5-77ed-47ed-b00b-7cfe0ac78985","questionRevision":"99e5e4e66c3e123dba6075a4420963d243597d2f686dd865b8854facf4161984"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/52c529cb-7d3e-4efb-812b-2d91247d2b4e","questionRevision":"a73ba39a55e6e9de544bd2cb4838308f83b7295b1bd72cf220f644c059c19e15"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/0bdf283a-bef9-4e43-85c2-16f1156d8b14","questionRevision":"b336481b0cd6e7d3c1986afe839dbe800feb25299849d6c1f889aee73488f045"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/e9a57827-886e-41e5-beae-167f342ef721","questionRevision":"4b2547a67519027af496d39bcdc03b02d0499d6837ad1416c301217e5ea55f87"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/a7b94a38-f919-4127-8caa-bab5623403b0","questionRevision":"06c37faf983a6d9fb78c9fe5194651bf484db661284a451117b3598adce608c8"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/13311973-033a-47d1-b535-89bdf7b056e4","questionRevision":"8db3cde236d3b3977675280144a4b56372af08887baba9ff1a5f016eaae5f4be"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/2e9c81eb-197a-4962-bc4a-2d5d72cb0571","questionRevision":"51bbb63dda86dfd6966d1b2b29b7f38f3c4a0a628b2a7557185e6c2cc30c9ec5"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/a95bb946-601c-4b3a-a9e5-0c9ed7f17af0","questionRevision":"bb9d77cb155202a63707d7958dbaffb8f3be519a6c907c36558da6bc305cbead"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/f85e1fe1-ba3f-4c2c-8541-baced00558d4","questionRevision":"1fc382b93a083af03decd4007fb72bcb72a9716e957a549d3d2d587ab7fe63eb"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/699b10db-1ab8-4b47-8c6c-2214b0255e4c","questionRevision":"232333913869d8b0ae2936bd9a8608f87a2a32009ebc8734536831f4af365a43"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/3b871f0f-f7d6-4ac6-bed7-bb2ac5f4537f","questionRevision":"fd0be45b960060f22872b0acdca7d7bc684601a624fddf179e519220a413501f"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/49275d2c-fd83-4ce8-8eeb-ce2fc6cbb3dc","questionRevision":"0e0791bde38dba994ec4042b624558ed551b6be031c43127aa6b5bd6cf347845"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/41775c0f-c6c6-4d43-bc1b-a5e2519fca8c","questionRevision":"495af34e99497c7160369efc9c3a35210ff840d7b2e1cb2c28240a9e2ea39891"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/f54d6aeb-89fd-4142-9101-57ecc41ae61a","questionRevision":"ffab7303c83c5aeb2fa336f1ab4ea588df261a34ebc60226a6ef825c7ee9884e"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/f9a39fcb-bc9a-43c9-b94f-0eb95bc488a4","questionRevision":"97f03d40b0afc338c0d781fd6db54b786f00aed6d2556ce7b2f836b81f35064c"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/029e390d-46fd-44b0-842e-02b1ee6e952a","questionRevision":"23cb1a9e7001e1dfd1692afcbf5adafbb8acae668756d949e18733cb0c18780b"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/3b50a3f4-e957-4d43-beb6-08442249578a","questionRevision":"1e6b5c5164b8f34b633a9d181b180bbdb9f8d1f56c3b420bb06974ef155dd9d8"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/b10f21e5-d753-43de-a29c-f2eb45ca4d68","questionRevision":"fd4413a21ea73b915066216876ef16256957d930098137d16ca8a8d7e3b78698"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/3ab2cb43-6713-4e8e-980c-d02b0d8ee3a0","questionRevision":"55a2a0bd74586ba9b420a50aa28d05721fa8c4beb848050c4f512029d556fbed"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/bdddc6d4-747d-4f17-add1-a9614460379b","questionRevision":"eef8e26f29f5ba0a726a533fd61558eb58bfd81c4b489e2a0623b2af6113fcf7"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/a5e921b6-59c1-49a4-91ed-18bd5c1e1a1d","questionRevision":"b6b0bad793990702c5cda86076eff861f6561cbd40c8af7f09ab5c1c448134a1"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/38e133b3-cb97-40d0-b205-0164c0c7d726","questionRevision":"068abec1e9f86448d8e5d3e51db04452b73838c3863e2b9f434cd7af94450918"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/f7538a7f-00b1-4d7d-85f3-6468c40aef96","questionRevision":"b313718074bd3b2c0009bdd9872ac88919585e604ca12dadeef06fe6d4e3a364"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/4b63470c-c9f0-440c-811d-d532e30953d0","questionRevision":"d3a1f49cbeceee88a90d76f0ca7105afd9c5ed9c47c52ce7c172a14e01f9edab"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/47b46b3b-20a6-4c0b-999a-0184ed977164","questionRevision":"7fb40d73aa9957dfc64d61fa1f2891c37648c0182400684d82322f57685e3629"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/2ad16af5-5401-4abe-b1f8-598bd068bed2","questionRevision":"39aa8ec766dd7303a17e314f654146aa268a9f279b155cba478798896a03c8d4"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/11563bc4-5088-4759-a625-8cf5b1690a88","questionRevision":"bd3b2495603b22b95befac0a107b8ccc9d6c69dd1c1a50e77d2d2a655547e581"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/d901f8a4-d7ea-41ad-959b-334812222e3f","questionRevision":"9074e6882631f7236e7e15747092b530fe643d52b2252d71279f85c31a94348e"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/c86b96df-62d0-4ba3-b873-f519042180b5","questionRevision":"09201b803c6827f8c7ceaa7625a19e4c73441cc7fd1b5a16b0e5a879ef4bbe76"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/4d3cd71f-d0c0-47f8-8e8c-406856127de8","questionRevision":"eb121fb2932d300ac34f3d1ac72e73c5b74d1670cb7480fca69302a1b0645eb1"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/79423927-52b9-46c8-9f97-86cadaeae357","questionRevision":"9b8d7c9a970b99de50ded7553ccadc9b8ef4c6f5003cd6e1851a8e12a1a34c70"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/a1768167-2e8e-4171-9f38-472c59ef61e9","questionRevision":"e37f126a7d45973a0d4324fd3427bff2b5169bf0c35f12a7177971f2ecbf96c7"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/176a9f4c-1b9e-42de-9732-56938a6cbb42","questionRevision":"4781b13f212d4b89fa27af4a7468fe4e9acd1baeba32952d66335d5088e2c22b"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/abeb49ad-a13e-419e-aaee-a5ce90fcca6f","questionRevision":"bfa22368f28081f4d9d93e73517ebd3894179c4ea74a126f0b3c57fd5ce5f352"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/e3494ce0-b090-4b36-a985-29f19877cb43","questionRevision":"6ce1b9b30aaa4243d5d593fa3e4a9ed5a8143ad11d14b83f62b8f6792d9148b1"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/beaae3c0-334c-4401-a30c-388a42d317f3","questionRevision":"5d85a215d486d76c6496e700bf3cbdeb701ebdc76a23e6b669aa4ca2eb8d8ee7"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/44c77e94-1d36-4d29-83e1-458602def1ff","questionRevision":"715921b8b211ba3a7b2a1f9b55a3ce8253110f58b942231f07e19f165b6f7b03"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/7b443bfe-9187-4624-88b6-cf7c55472c73","questionRevision":"8f65f891ccd3de8033b209277b3547698bf82ef9d97247f155d8992659f2a851"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/09ba7fa9-d26f-4525-877d-4abeee326318","questionRevision":"83ddc651553ff718b60548c8c7ee9c9aecdc6652a86c532055e63b55fbf63c96"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/e76f5e26-df3c-4540-a704-332a55d3c8d7","questionRevision":"ff5afc0077e25962a58aabb9229d1202a48a01f97d7df81e6d6559b50376a90e"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/323e454f-f80e-470f-a034-38985d15bbd4","questionRevision":"ced8eb5e4e6d475a66ce074762a46b557cbed131265147193b1172048fd39163"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/2c906b77-51c3-413f-b8f6-18a81dca82b1","questionRevision":"041f01af62d042ef9f5db9289445042956f6a0077fac58e4624d5528c8e22d7d"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/f3a36354-ce27-4b42-8ff1-c9ef6ee4785e","questionRevision":"a1e56a0abc684f88f366fb2cfd3f54f65525b5c7f3a753437852ccc2ba715b43"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/e8aa99bf-4b75-4a0c-98ad-bc3cb18ec634","questionRevision":"bc716f20a3b7b3819fd14e1107031b50956e2bf1274900d3c452cd9f246ef34c"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/7d074734-a1e9-4924-8dc1-8d05247cd122","questionRevision":"06ac46ffe9f3b0cfa51a45d3a182c78d53c77997e2b9519b0438a646d9ba4bc5"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/aac28f29-b469-4d9a-850a-11f9feaa2724","questionRevision":"5225d54482a11d2d4ff92505646b29e6415d904007af3a901e2d50f1a1e760cb"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/2ebe0d81-03f7-478b-ac3e-5905209d04ed","questionRevision":"6c337d321fa1cdcf8a03d9e39188a32eb6fa8430a3bb6a46760558cdbab208bd"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/c3e2bdb5-3785-41eb-a898-47c2bbaba1bb","questionRevision":"cd9f901ea30bad89726124410cfda76bec1163dfa226a33b1580fe4e6783dacb"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/4398b5a7-66d2-472e-8a47-d30317af891b","questionRevision":"8f11b655ccbf1f5e45933841f9b9d1842860e9785f0bae24f5133589dba076ab"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/01796ba0-83e0-4d71-9fbf-aa5f630be5d9","questionRevision":"e58b9676e261457b78257f5a0a16ab422ee93bff36a4429a0464297bfdb88d75"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/2715ce8c-30bb-4a84-bd1d-01bb0e68ce89","questionRevision":"aff93e2d11ec474c382495c2308abf62202eefd933db6889890de6ff743891f3"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/b237bd78-fb41-40c7-89ac-0a84df4a228b","questionRevision":"1ee46102b80b584d7abf109b1a3251d7cf75e17c28faf2cbeae7767d370ec8bc"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/15c75dcb-8f17-4668-8bf5-f41ca5772fda","questionRevision":"f8086d4f9b59792a340ae3f3fa3d45c8d6544e77332fcfd74b361704f189ca48"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/e86b52ce-4ef6-42fa-96c3-7ebf9b285e21","questionRevision":"920f21ca66962573009eda969c7a595a0016400f3b42d473fdaccf2e95b2dc18"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/32979805-d738-43e0-8324-ae5e21aec236","questionRevision":"bc4c15ebb56e90dbcf32592984722e93ad6c964575cb453cccd8dd14848c783a"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/fc81c3e5-063b-4ff6-9a92-3f4f38703143","questionRevision":"8ce976a544fbf93b9dd63af78f2ecd5f6fa6f4e2c713715fe3d4b0f4a03fedcb"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/d216a33d-5466-4c2e-b638-c8d84c59272f","questionRevision":"59f7cbf7c61515b954ac630db162ceb1cb5a51928949c7531dbf0df9a86fb7d4"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/cf1a8fe8-716a-4c6a-ac43-b5abfbafa5f4","questionRevision":"b1b4535438edf30b059472f46d7d395dd8acecbae71f71542654bcbb40e9e62a"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/dbced3f2-f213-415c-95ab-760b935e41eb","questionRevision":"c100789db420cbdfedb4993d3f98f5b483afd662e76736da7351b8fa12f6cb72"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/55572720-a4af-4161-9128-883823926779","questionRevision":"9f2ee6b0a8287ecc81b0a44fc1a369a43e174652b038fd24c367b741fcb1ab31"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/807940f3-c95e-40ae-bb82-24b290d8b742","questionRevision":"58a108a8c324f9b6425c0061b077bb8eb92068d192fb4f34fe2065d153b9349a"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/a2085ce9-aed1-465d-b627-eee195751e1c","questionRevision":"af63474caf37b81cf1320d4fe71e411ca80cc96cbf61d51bfc612e1810c082ce"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/a22f175f-1027-4271-b0a8-7372ffde0284","questionRevision":"9ce208c91564d1f7f2f562cf442aaf9e01afe02baeac85781a7671ee7850fd66"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/2005117f-2008-4da7-9cc5-caeb2bbb544b","questionRevision":"5a8a099c04b6f3063237de28c56852885db5297feac1c5983fadf68de4ea5cbb"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/c8fdfad6-ce82-49b0-bbdf-cbb81ac5b63a","questionRevision":"ab9d864e31e11cd2532ff120345cb4854404d9be614d10113d8a32ca97739a0b"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/2275b752-e0b2-4b1d-830c-e873ea748c14","questionRevision":"0ad2a3951b609ad0d42d258e446ad3fa3a6b40b35c6c3ca853cf0f7ce96e8987"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/115e8c96-14e0-41ac-a01a-32c0d14aa8dd","questionRevision":"7006fcf2594934e3a8a3fb5b8ba33a98a9c59ed3bd00ac41be1b6e54d758f547"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/19a779fa-ca4c-40ab-ad6d-ef011603b376","questionRevision":"b923296ec01080817c647f9598f5c74a3c67e354a414f85b7408dde772ee821a"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/c01d6d37-5a7f-492c-a95a-9a0b8bcc49da","questionRevision":"2096983daf3e5c78a92db32cd6d61b40ad179415ae1f32a14cb399f5ab4fc8de"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/fc09d6a7-a063-43d5-a604-a79aee2ecc62","questionRevision":"dc24dd653e9966109bedc09d3300dfc236d7ad6bcf78a5bd110d1a9e98afa361"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/d69dfd16-4184-40a0-a50c-ba8843251304","questionRevision":"9ae5cd8403db5be23f44a8371650e25ed16ab65572718f2c9cff803a1853446f"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/d3899216-d3a2-4666-a274-b650a81ae6c2","questionRevision":"ba1c9d406b59f573398cd1bac0e10dc61a19082776536796ff8ad673fd33975d"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/feb81f18-afa9-4da5-be25-aa6893f66b63","questionRevision":"be8b74edf4c9a898e9f22b42ea6029a42778b64ee4f7d3dc01e455a2a14fc833"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/27eff040-b145-4954-b66a-a60d314fa168","questionRevision":"5e5d7d6b4c5f7d81e06f58e2d48d811c542a35d6bdb529366efb3fe0b9c682cb"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/0d54b29c-31a1-41f3-81fb-b82299c34523","questionRevision":"57a938f0b90cd439e03cec2967fd77fa1d7df04f51367e56d14eca7f15b04dde"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/aed8be05-8c52-4fec-8187-143f2ece45a3","questionRevision":"b8ea5c3e26a28ee16217d33b057bc871992a8a6caa19f009947d627469001758"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/e3c3180a-6c76-4d68-99dc-10a131f84877","questionRevision":"96afdbf7a2f804dde195233198f665aefd7e564ad575f034b4bcba9b39cc16dd"},{"questionKey":"7c8ca573-7a7c-4cbe-8769-054719e65394/7353e2f2-6b59-470a-89e7-d05e19e7b138","questionRevision":"5437f5f2b691a52190fa2a6fcd6a812582c69dd50cfe8bfc0d7d6aeff0c62673"}],"revision":"87fc9eb3e435675e12c53b081f5639344f157c9abda70bcb1843747fd2eed781"},{"bankUid":"79d93947-1307-45ae-8f19-e25d3bd11051","contentManifest":{"contentDigest":"e411b6c8bb13cfbc6f9839398df24ddb9de1f10b1797905f93e6f345a60f2969","kind":"public_static","staticRef":"banks/v2/231-ice-rain.e411b6c8bb13cfbc6f9839398df24ddb9de1f10b1797905f93e6f345a60f2969.json"},"metadata":{"questionCount":25,"title":"Ice and Rain Protection","visibility":"public"},"publicContentReference":{"chunkCount":1,"contentDigest":"e411b6c8bb13cfbc6f9839398df24ddb9de1f10b1797905f93e6f345a60f2969","manifestDigest":"e6f3bd3b9af411c3360d1fe9a00bf408a40fdedbe7b2eeeb5cedf044ac806723","totalBytes":21216},"questionsrefs":[{"questionKey":"79d93947-1307-45ae-8f19-e25d3bd11051/51d91a99-bf07-410b-8fc5-41c5ab30e163","questionRevision":"0b0839b902331f538298a497839b9bbec90a22a3b0253a4349a9fd711f6105d9"},{"questionKey":"79d93947-1307-45ae-8f19-e25d3bd11051/b6d1083c-dc69-44bd-a48c-99f279599a19","questionRevision":"d88adb878a3049508ca370a026314d776c8dd697cfeec7952f8bc4d084ff97f2"},{"questionKey":"79d93947-1307-45ae-8f19-e25d3bd11051/f245832d-7eae-4734-ba6e-63dc7d373ba2","questionRevision":"fb9ed45c7d4394219981757493e3ce2aec71633611ff81b6f60aecd545ca3e97"},{"questionKey":"79d93947-1307-45ae-8f19-e25d3bd11051/a4792239-3bad-497e-badf-910e9dbb71d2","questionRevision":"1efacf0d27e9b52b45d273fcfcd95ac6329cfc03973a3ffe967a6113912b58b0"},{"questionKey":"79d93947-1307-45ae-8f19-e25d3bd11051/919f47b6-6a9a-487a-ae39-f4784e3d30ec","questionRevision":"f470fc842b83351a65926109435a05fa07526e4268487f89daa60827804c5c77"},{"questionKey":"79d93947-1307-45ae-8f19-e25d3bd11051/37f0946b-b9c5-4ec4-903b-093e6e749593","questionRevision":"8063f7cc70c14b0ea7f51540a0e5ef3c71a12c434914388bc6dfb5a423d5a5fa"},{"questionKey":"79d93947-1307-45ae-8f19-e25d3bd11051/62bd8e44-acb4-41a1-83db-4522b6cee8ae","questionRevision":"4592c8b9dfadf9256e0a01a6437b6f8525005e29c58b17bf6673cd9e7cfc38a6"},{"questionKey":"79d93947-1307-45ae-8f19-e25d3bd11051/15f1332a-c7ae-4bd7-ad54-c6216e400749","questionRevision":"7aa2509e7882d5de7192225eebe11b1e9ef03c5c51c1c4a0978a483dbf581adc"},{"questionKey":"79d93947-1307-45ae-8f19-e25d3bd11051/b927ff62-4509-459c-bbe0-c75bbb8e863b","questionRevision":"c21c4f4e0fbc485e62a55262cf3bbe854c4d703a65b196469ff75a3e16749c01"},{"questionKey":"79d93947-1307-45ae-8f19-e25d3bd11051/3fd775ce-b4e6-4c4c-9b11-2b2585a42ce6","questionRevision":"238265f3f45be1f9e5af81079d6d4702cd5f72fbfbf23fd61a3f6a1a488abe6a"},{"questionKey":"79d93947-1307-45ae-8f19-e25d3bd11051/a6b5374c-b9d8-404c-bc40-a5add6944c1d","questionRevision":"09a09f6f1e566f178b5cf8222f58ae4c880fc705395548cbe376796be0248b38"},{"questionKey":"79d93947-1307-45ae-8f19-e25d3bd11051/8af5102a-b982-4a0f-80a9-3d56438877b3","questionRevision":"4d59e471592a0d83f6dda328390157553c62aba61f3685a06a39465322de4ded"},{"questionKey":"79d93947-1307-45ae-8f19-e25d3bd11051/5202b32d-fd90-4883-997c-2b2b76c1f321","questionRevision":"9f3d26ddb0c1b15f43531837dd2d9aa6f4e3d77f6e1be75cd9b28b97549a1ea1"},{"questionKey":"79d93947-1307-45ae-8f19-e25d3bd11051/cc8b5467-6875-44e8-86b5-220b254d2d6c","questionRevision":"cf2ddf52922816052119b176238547eda97bf669c4e8edbeea381fd9d378467e"},{"questionKey":"79d93947-1307-45ae-8f19-e25d3bd11051/4f51929b-fcf2-4ff1-afb6-70b8874edca1","questionRevision":"f8120dcd4fb15cb5d8839a8b9fe7b018be3298b2ab262f7998c6939d70565021"},{"questionKey":"79d93947-1307-45ae-8f19-e25d3bd11051/74db3138-d0f4-4e31-b42b-9fdec8b3f07e","questionRevision":"49cb245c2efeda91b6e7e80f0fce720ee9a4e12b2d41d9881379ec8023b5c02f"},{"questionKey":"79d93947-1307-45ae-8f19-e25d3bd11051/831e228c-2425-48cf-a525-1a056b9079d5","questionRevision":"f1515560bba731a3697da9bbfe0331e8e19a4ccbc472fb3ef5658b5a04b23e21"},{"questionKey":"79d93947-1307-45ae-8f19-e25d3bd11051/4bca0823-4064-488d-8bf2-e3b2e4e567ba","questionRevision":"e7125946111326dbbfa0eaf72d8a294f6723f304cf0acf61a46866a8ac0ad2ef"},{"questionKey":"79d93947-1307-45ae-8f19-e25d3bd11051/49463585-2957-4341-9455-214540b1c392","questionRevision":"fd9b4a043a81a835c8704b770f10b7f9d265cb758ee4f8e172ce8fb4e536faee"},{"questionKey":"79d93947-1307-45ae-8f19-e25d3bd11051/12d6d88c-64b4-4635-88e3-3a0bffc97285","questionRevision":"1eab9f699d52106bfe1af8604e7a6992b105e14fc558c5de8e9088b35fbaf59b"},{"questionKey":"79d93947-1307-45ae-8f19-e25d3bd11051/be957ca2-fee7-457f-92e9-34f3ec9e0314","questionRevision":"e89274e58c18bf51e29d71b3bc984a11abbd0e1c8d4aae7d39979c0894dc7f5b"},{"questionKey":"79d93947-1307-45ae-8f19-e25d3bd11051/72651278-8973-4758-a9b5-db4405f2d46a","questionRevision":"07cd45e8b337420b40faea6d47324a9525f9348ae1b0910761aeb3beb5a0302e"},{"questionKey":"79d93947-1307-45ae-8f19-e25d3bd11051/a6bff0ac-8348-4b00-b7ff-24e3f605e550","questionRevision":"f6a8980b8df1e43f9f605c3f520187198630cb21c22bc76a797a9db83f4d5def"},{"questionKey":"79d93947-1307-45ae-8f19-e25d3bd11051/fd62b224-b933-4681-a944-dc4861b64f5b","questionRevision":"b6626e23348616a5069d2fe455ab3936a60ad643d0d54e74f6d3d72036d65568"},{"questionKey":"79d93947-1307-45ae-8f19-e25d3bd11051/ce45e8ee-9b54-4a93-9cc6-923d31a3bc57","questionRevision":"853778f08b780fe3f33e642ee000527946a843ffe1c723beb558166cd1d3b53f"}],"revision":"e411b6c8bb13cfbc6f9839398df24ddb9de1f10b1797905f93e6f345a60f2969"},{"bankUid":"ce7a3545-f827-4573-8ded-7e105afc35e3","contentManifest":{"contentDigest":"cb441e8709d69cc8dc0ec32fb5ceebddf9cd33a258964aac8d9f0ff2208e23f9","kind":"public_static","staticRef":"banks/v2/231-fire-pos-warning.cb441e8709d69cc8dc0ec32fb5ceebddf9cd33a258964aac8d9f0ff2208e23f9.json"},"metadata":{"questionCount":64,"title":"Fire Prot/Pos & Warning","visibility":"public"},"publicContentReference":{"chunkCount":1,"contentDigest":"cb441e8709d69cc8dc0ec32fb5ceebddf9cd33a258964aac8d9f0ff2208e23f9","manifestDigest":"f32c8d56ffd0053cc305f64e005d5558bf6ea80086754a357b4e131cd989bc25","totalBytes":63189},"questionsrefs":[{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/10a5eb12-5e18-4885-b385-654a4b0ab79c","questionRevision":"cb4b11e6baf174849736ed571cf1aedfbff11fd4da47d7d71ab5f7df01ab744b"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/44639d13-a9c7-45a2-ba7b-fad5e2297034","questionRevision":"e8a1d930a8133220ff2ef04f0cb08507063c67b84722c588f3d3420ca738cd08"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/5783225f-b626-4017-8e08-7cabbddd03cf","questionRevision":"27b26d327675741cef48ada145bdae76dea255fbee3762c98bfba0d19502b8cb"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/a3e2d6d1-8db7-46b3-97a6-eae18dd205fe","questionRevision":"a8c8ccf6413d94b67eafed530dbaff25cd84b054093d46bb7906bba017078987"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/b0df2e7e-aead-4805-b929-ce81eea11dad","questionRevision":"68f09a260428988877fa8f4901d245b1923d82415f7c632d7dbe12ae1d44eaa8"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/17f5a170-c95e-425a-bb20-b53410752306","questionRevision":"f519e283733c27bb5bef2ce0eecaeb6ac8a9d235499e593d9a930ad8cfeb914e"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/a4fbb787-9bed-42ab-b398-6db4d8f0e201","questionRevision":"980f0ca1de8c911fe0cbef9f01fc64785b17abcc088a4f5348c42886ebf004bc"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/15f28b2f-67e5-4094-a63d-c4a5d408bdb7","questionRevision":"5c21dd2e768c3a615a36c993546737d3069b85101c08b088db92e1f02658d014"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/c3b45f5f-08b5-4e41-9398-b69ebb001b6d","questionRevision":"bb956e2b5020fea47a8073e5b24620bf70ca30683036f1a41042ea662363c65b"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/51064811-60af-455d-ad62-33eec2e526e4","questionRevision":"e4131b85ca59de9bf1835749bf3b4ca724a587677f17e469433b460b47b7e416"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/cf81286c-39e9-4eda-9590-afbb9af79163","questionRevision":"4ec864eb1148ee6d37cf9bf4c0915c4547a03f91cc4fe43f51c690e66d256960"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/467b67cb-64b8-4a02-a8bd-cef4ff789501","questionRevision":"19f01a0eab4ad36fce3c0873c01ba4ed648c3690c9a8438dc2b9e3ea5eda9691"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/369c51a3-8cb1-428d-ba51-174b6309daa8","questionRevision":"8cefaa9f4aa629abe3e4fc442ebebc0ce661d014102d4a0be2d4166f21a0ae14"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/34db1792-d640-44af-abe0-9dce1330e097","questionRevision":"2ebc417e05c3e729bdbd6e4d99243fb588b15edee04c19927145a7762acc6011"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/336ebf10-afa5-43dd-ae4c-e5d26e354c11","questionRevision":"01f592e0769892ebb7c42f53354eda006c4879f0a2220d898d405802945c7bdd"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/feaddf96-d4d3-4118-888e-cffd5ebfd236","questionRevision":"c0f46683bd5c14d88889e560fb390d06803590ddca695e168598d600f568afdf"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/6fdcb797-af49-427e-be55-6fbede92f61b","questionRevision":"87f88ca152db1f6b7e3c6f967ced2e41d07ec754e3e34e469c22c6d0e0a9bba9"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/ccffb8a4-a650-49f0-a460-9dafe5052b56","questionRevision":"296d64d488821e78d2e8bfe7068ca782348cb7785161d3817218e2d8d97ee122"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/fd73bc6f-f11e-4588-ad19-9a54b2f05af6","questionRevision":"8b45e59eeecc64077e1699a9898624066056e9d4218ae632586abbe2233db4a3"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/50f45780-5775-4c68-9231-fb7b8f18a087","questionRevision":"9b609791013ba43a2e88efba2aa1df0f1835186045bfcfffafcd6ec07f5a5244"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/97d0318d-7d16-4fe4-9342-21a3f1020d2e","questionRevision":"bcf7d9a76a33514e9cc3669a60e7e65b4492844d272ed5c1d1f8032a45e9e807"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/ed193c0d-8375-4b71-884e-5f2ba2474c22","questionRevision":"6e0f0e2bb4084d12ea36033e1b2df3e13bb00fbd31643dd65d9aa1e1dea3ec79"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/b4aa24c8-b382-4cd8-9192-c66278a0b0c5","questionRevision":"46981dc513f5afb018f8825abd7e4a7dc5737729829f75ce645e54c152bef83e"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/e8dd00d8-a8cf-4f0e-9d3f-a10fb4750b39","questionRevision":"9583df3c387f8e96f768a6070916f29d3838d220f3d4171c913848cf57d5eb15"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/6710587d-61ad-453e-b0f3-d72ce48245db","questionRevision":"97ab3ce0ce4e2f57d458d22e410ea91f9c2c5ba9c3e5a98a6f252050c64fa0a7"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/c146e2f7-58cf-4d08-a978-5975bbdb5d7f","questionRevision":"e3d3a62573553c8c26fa2d6b3b525bdc75ee3cfda384dd887e9d29c31ba085d6"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/70b4dc9c-41ec-4c80-9fcc-4acfad61bd37","questionRevision":"dc175a7cc028bd1a2f42b5dd57fc067f4a79888b44c4ecd7a269de804fa78271"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/2d23e092-4b82-465f-bd8b-07fbbc2bfeef","questionRevision":"2b9948e4a9ddc8e0b3930bd50c07709c669a615093a5a7e4a4bc803c72387f35"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/4cecb340-e750-49d0-9488-bdb71e67caa5","questionRevision":"8d04be632b299d0f2c9a88d4320d8abcde72c151198d97e35d0d55a5ae3537f6"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/adc67a78-4ace-4ecd-8bf5-ff6c185d0a01","questionRevision":"a2a7f334753f255895d4b013380de146fcb5f4ea728739822c73ce84f14c37c8"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/5762a1d1-2c52-494c-a476-3d75f21482bb","questionRevision":"4c2e7816b0905bea4d52fa7a6246b90baa8b2876ad783c69edbd04960440f6ee"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/150f8baf-6ad4-4ac5-a64d-9cf96cf4b277","questionRevision":"e8573d0e00268ea4c1261bef6ddfc1d523207fb9f90340007d77c56fd1c8e145"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/408afe17-a921-4a85-bb46-3f666d53f6e0","questionRevision":"cedc10bf36e43bd520534e2fdad0443107824795d94a7c0f0b8062b950c87826"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/62f1c75f-7d53-4f1c-acf0-5e1c77d4ca4e","questionRevision":"a5d12a456d3d804277ad3f3ca8f29a728d479eea59f25ef4964fdeb2f231cf88"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/b8ee2ca5-c197-4982-baa8-ea1ec3835469","questionRevision":"80634a63998c846403fbfb32fbb73b351c1d54813a400bcc6a62717e598d08f1"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/f3e5fe2d-14ac-4348-8493-34a3a0ff2acc","questionRevision":"89a45a8873c28dcb647b5aeaa1aa87c6e5eaee5f61c38433100a9fab10c1b144"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/8192b660-23a8-4f27-8b4b-f97cddebb0c8","questionRevision":"b322640ca1a0331ac33fcd20a6c7d1f583865c6b7756c6046bb922156824540e"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/1213cecc-8171-4a0d-9031-ec123ae38d64","questionRevision":"d1ce37a4f48683dca49ac3373e10f427650a607bdb6bfac9b876368ff3aff08a"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/872fe5bb-fb9e-490a-960a-c4146203e4a6","questionRevision":"d0ea4adc98218e075b398b5e297206084ddf64b45ad2ee8e93970bef53bf66fa"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/4d20b638-ef1a-46d0-ae8e-092665c48f28","questionRevision":"63007c6ebc8cd46001aa243167e221f359b4c84b7e6410dae887b5dc312d9223"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/390013bf-313a-4abb-8706-1e8f74ae4044","questionRevision":"42c12c53740a9813be7136c8838c057949eaeeaf9c52cbef0ebfa156d455b0e6"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/00133bd2-bdab-4cd4-af89-d041d274ece1","questionRevision":"95b01aa0c160c0126aebfc183c3af0260efc03b75236beb41e09558dcb13ba0b"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/d4bbf342-61e9-4a59-8ecc-7415fe437484","questionRevision":"29d7ec9a2d18a8fe1b79bef97f1fac4e36add6481a14d7635b00d7ec2edbf89e"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/0405fd15-b3ed-4cac-9896-6e620ec8d2bf","questionRevision":"e4107333950f4cb16dd4f5b81ae282c2b23eb8686b5f45b18b75d2d37d70c14e"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/b6eb06d8-ef07-43e0-ba7f-02403bed7c32","questionRevision":"5e13f08876d9c26e41021d825ff9c46b82771b7d2adf106d47839ad5f1efe594"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/f08d8ffc-ce78-4cfc-b18b-a47995e05c02","questionRevision":"60fa62c889236e2fb218eaa299462d54a9330d33e4c4c639f7f6d72b96d42f59"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/2ff3dc73-e22f-40f4-8d30-a15a037c8180","questionRevision":"1707709aaf57d6467433bca7711167fb577fb759838de4a8380202064bfec249"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/d846e140-d31a-4679-9f5e-799411be07ba","questionRevision":"f702812ab20fe2c69211533d40983d40fe8b1e995c142393a5e8fafc78962f21"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/850fa02b-5fce-4f2b-aeec-f46c678bb26e","questionRevision":"bad0307499b28f8c7aa95a690f6a6b7318296c2acb602bed9b58008c77e3b026"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/5837dd65-c2b9-4d00-a378-32bd8778b188","questionRevision":"223c21da41438c0d5d0ce956e591ba5c82429081c76e0db34710796f29262024"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/0c84370d-414a-48db-93c0-620bfa93e94e","questionRevision":"4840b2025badb1a7a37c63326f3b44fda705b4956d2e5e1390364b9e4d73325f"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/9de7ed7e-ed25-4b02-be13-3c5d768995de","questionRevision":"4aa11f32e64061ca25fed05f72a18047e0da8795f727c4f95c13474f8df4ce65"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/67805fe0-adbf-4374-8403-9899fb2bdc31","questionRevision":"87e96a2e26e6d5ccdd2d4493c3f2a3a3c67438629c9619c27b28aacac43df43c"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/956cd35d-bfad-4ddd-b93d-6d4b8f727064","questionRevision":"860718a9d6644b2436370afab34f0ba8299c1a6f06498d0cf850147e6b6ad216"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/89ce6cc1-fe1f-4cdb-b9e0-178e845c35e0","questionRevision":"4f9708c2a09bf26c45d0be7e04c2fa5475b9f3c8309e107c12e06af2d9d2239c"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/83f41428-f7aa-4492-bb5e-7f7287d1a922","questionRevision":"8d6f89f22407099aea62590ca7a71828e569528dc4f8a359782a748b50c117e9"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/574cf95e-54a5-45db-bd01-e94dcb07ca59","questionRevision":"97f0786f3eed5072b1917096643cbc33d7a6cedbd120bbdc3dbc0cbcd8e3060b"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/a36f98ec-c7d5-47ed-a5ef-883423c8e268","questionRevision":"4e1809dd1e3368e3009034d00ef33b7d7f35cca25a554dd7bc0e0b341c7e5a0e"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/162f4735-5f84-4673-ba44-4bd0324fb172","questionRevision":"606acbcd6b65f332baac36eb783ba641adf24399885b9211f8df8b0e197d45fc"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/40059eab-35db-406b-8028-40337d59e962","questionRevision":"5dbbe43698d7be7ecff5c0cc743a5c9725c3a4adeff44d069b9513554ed01790"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/04b88ef5-5812-4303-bc46-cb7449db73d2","questionRevision":"61be0e8edb92b3a2f4d34aa6ea3082c608124be1c51659f1d40a2602b6472ed9"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/fd24ffd8-6e5e-4cd6-a217-01d2af1a6c83","questionRevision":"cea122e917ad97244b959e14183949f50211b6eb8bde9be5667d07430243a244"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/d74eca0d-59b1-4af5-8489-875b085b6d1b","questionRevision":"b2291ac8dc32da24a6a4c0b3c6fcb01fdbd372630a34421587bdc74778868e51"},{"questionKey":"ce7a3545-f827-4573-8ded-7e105afc35e3/ff4c57f3-3bab-4460-aba2-c6fbfd10b01c","questionRevision":"aaea25872ab963d001ab484121077a1db3791c6f28d41ca7033a463cd5179414"}],"revision":"cb441e8709d69cc8dc0ec32fb5ceebddf9cd33a258964aac8d9f0ff2208e23f9"}]';

// do-worker/src/historical-public-dependencies.generated.js
var historicalPublicRegistry = [{ "bankUid": "de03a471-ca5a-84cf-81c1-2b8107db535e", "revision": "b6625433dfa24d9e64e9e21ab2ee1ffc362153d85650c85b710663411e363303", "metadata": { "title": "211 Sheet Metal", "questionCount": 246, "visibility": "public" }, "contentManifest": { "kind": "public_static", "staticRef": "banks/v2/historical-211-sheet-metal.b6625433dfa24d9e64e9e21ab2ee1ffc362153d85650c85b710663411e363303.json", "contentDigest": "b6625433dfa24d9e64e9e21ab2ee1ffc362153d85650c85b710663411e363303" }, "publicContentReference": { "contentDigest": "b6625433dfa24d9e64e9e21ab2ee1ffc362153d85650c85b710663411e363303", "manifestDigest": "914ccf4aa757800dcdd1186e053fb9895be564e295381a28ac7821cd91069276", "totalBytes": 14476647, "chunkCount": 28 }, "questionsrefs": [{ "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/e444149a-3848-8544-83be-c08b90ebe6d7", "questionRevision": "aacbeed43c145b78b9f0c0ea9a3f886e22f4f964d6de2f62a73643daf203d7e3" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/32c9ae6f-4a4d-8fb0-8451-2ef1481a05e7", "questionRevision": "591bf2b17078ad198869afdd524f1445df7fb6837dca2e380e76d1523e658821" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/29fc5a66-04a7-81c6-8405-424087f29412", "questionRevision": "2f6f374b1f2ece0824ad1a46ad65442f99d48b8121a26d3c430c2fc0e60161c2" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/680ce0e8-4faa-8161-883b-00f25d39b7ff", "questionRevision": "ed2c5baf79715089a7c789112f21cc928233765c466d81a9811548e54c0cce6e" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/e4e47208-c89e-8c1b-80bc-80500f0f4d54", "questionRevision": "abdbc223a9cbc58649a910c84d1fcc5c27da0d4017c382d826bc425078679654" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/ca31dc2f-6db0-86fa-86c7-edf874147d3f", "questionRevision": "a959c05014b8ec00f065b4309e398556480d19f9aec9763fa8872f00a3877b6b" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/43c0d17b-f29c-8f0c-81a4-00c863f8937b", "questionRevision": "cf90cac851488ba80d12151d73cf76a8f0801a67af2798264b3b4bfc0f9279e1" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/75bc2bd1-c6ef-8c6c-854c-377feedd8c30", "questionRevision": "7317531daf84af4773e0d4115055da913241b0d88e621bbcef8a542d85cd32a4" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/c1a02bf1-c63b-8e14-80df-21bff7e69c91", "questionRevision": "7bf51383fb1d833ec1a1960ef2ef922a4ed870b17dc42efba96c32d4573202c4" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/6dccf3f4-24dd-8784-8c01-449a594b6180", "questionRevision": "8d978ff97373f49f93d88169ab2ceeab125ce909ee901355eaa46f52f7e32f11" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/fad2215a-85b9-86d6-85c3-71ba193e84cf", "questionRevision": "778d78b6c5a1636075577e9a617d0372d28cb23cb1bd11bbc08a15e1de76538a" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/ad5a954b-c58c-863b-8ee9-6dc39f172750", "questionRevision": "2bbf6d03b4724307ff06ba69e44d190f1fc8543f164756df818969ea195b65ee" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/df408432-34d1-8c8b-8ac9-c816df096fc8", "questionRevision": "8ef1068b3a4df88a97b815a3e47fcb91cf95a401f41748d1ed0628bf9b421810" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/5ca4e58a-e1f5-8ecd-8049-da30b5efda62", "questionRevision": "cc4b826767efc346ddacc85ccfe5d19a947308ccacfa1e3f5a8326d8e7534d80" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/dd22de05-7b10-8b6b-8305-e0a4636209aa", "questionRevision": "cd5731b7a0810672877a000ce02f3d7e45135f410472cec2bedb830bb020fd56" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/15605e7b-0f67-8309-8daf-58012d06577a", "questionRevision": "8cdcaf8fd6c4efc66ffcdcc4b537f0dc91975552c311ccdf1f682caa06bdd76b" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/91858052-05ea-8545-856a-01f2472e7577", "questionRevision": "fbb379de5b210fa8276907d8844a1b49f4989754f390c52b4593d5071290361a" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/e39a4386-58c1-8bc9-81eb-a2316adc4681", "questionRevision": "df41a89e6319fb8d1dfcc6ce4c79f6d68bc94fe804684a8d8c973249821428d3" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/c3a12150-41bd-8e2f-897e-e013b761b6d0", "questionRevision": "93f5c9b1106578aa043e3040a5ee8a928f5808ca9c396441170529bc777bec65" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/67e4d813-4ab8-8886-896f-c4db31fe06a4", "questionRevision": "b6fe8d879aa91ee3ef2fb9be0c953e6558173cfd321d2324bb9855bfe57af758" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/f29a90b9-4502-8464-8152-736d01bcb0f8", "questionRevision": "8cedcf6389e92bc9caa533d1f9879cba88755aa2752d983f48561111656253ca" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/964cade3-7bfe-86a3-86bd-ad2569444dd6", "questionRevision": "0671222b2d80ae269bb3c3c2ce4e4e796845ac3836d625c69172da9e12bc4560" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/17c6fedd-c0c9-849c-8bc1-0aba80608867", "questionRevision": "91b11c476ef481f53a2a97bfb23c42a3845fd632baf7a2c27a10cf6714adcd61" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/183577ff-ec80-897d-89ad-1cfe7004d81a", "questionRevision": "ddd6b9060f75060108373b5fcf2293362e039e4d2276626c53317ed3fb3b899e" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/cccb5eb7-f89b-8888-8199-928fe3d84222", "questionRevision": "0ce4e982c5150dfc10a69bd9152068c58fa16c7e5d0c6eb6c665454ce23277f6" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/8fa786ce-ca6d-8760-8f32-2e9e3314fcfb", "questionRevision": "337d5cc6856720a4f55c56194e28b95fa2ce19706fa333249f8997d1738883a4" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/e70e8bbc-34d6-8282-8318-fb863496b611", "questionRevision": "240abca0bdbf9b60ca9ce697cae8a6e9e1f61843b885227ac88a7df1e3ccd12d" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/4e6aebdc-453a-850c-86ec-0fc3cb48dca3", "questionRevision": "79bc9a107468571f45c3115cb96e559d2feb2044fc41a7973f2fb1c886188d8e" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/5335d2db-e17a-83f4-8d84-bda77e0f6611", "questionRevision": "a96f65d07f8bec4ce8c150184c88f506dd7684f268b31dcbbd9af1fd6b9b84ae" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/14672ccf-ecc0-86e2-8c83-095863414d89", "questionRevision": "7515bf346ffe6f1d34bed1bbf93e574bbfbbd25d54e07cceb1ba387d2783b398" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/ba5f704e-9910-8b65-8da2-54e6cbfcfc02", "questionRevision": "071db3e981df9e0cf7dc7b24fcf83f21da8c5c3d05585d6598cba6e54d218103" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/b0932f0f-bc66-8ba0-8cea-2432bd462481", "questionRevision": "3a65129d499aee141a5a303342143d0fcc0d9587d7e8b878de6fc6e622840df7" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/abcbfc2d-2839-8aef-8db8-5625b38b03a2", "questionRevision": "f4d5fd1962c5231774ee8b8fa2bc97ba8c727150bdc29c94a768cb68dbf6e2f4" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/de080a0f-bebf-839b-86db-2fb6af4d843e", "questionRevision": "0a6aa9ff7e60ae3f2b95f3ccd5267caf9391b40dac6160f4e84e83cd7f23cf68" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/20e85251-446c-88d3-82b4-cae2c1737731", "questionRevision": "7a04a22ba0d4cdfc5df260bb98f1e1702fc06253187c4cd107be2db8a9aaf7af" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/0eb3be81-0ede-8713-88cb-22187343b102", "questionRevision": "ed4a4628375df839f170e26f0f977a12fadd5cac2ac021ab9280f685bfe70b88" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/e7e9d281-f087-86b2-80c1-a79a26cb96a3", "questionRevision": "8a27d6a8c4f2a6d3ab694adcbacc6181ca9e006d315841532bd9105548543658" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/d07901ee-f3d3-897e-8a53-aeac9b6ca103", "questionRevision": "6b063fe38fba2253313d3823ada34fb43979ef04ede89bb5697342d5cf38b861" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/0e71a36c-7e81-8346-8ac6-294d8db86438", "questionRevision": "1e40364be40981eed82814f14194f489d0a671e072890276dcb524191fc49361" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/d9bdaea8-9600-8573-80c4-357f14d38006", "questionRevision": "c875f8fef6cd3788623d81d05b694ff38c082a2a3c4cd326530bc5eeba4c9c0c" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/c716fb62-d55c-867a-8a84-9afdbbbb2c3b", "questionRevision": "94a8c164aa63e1f0c0fda6f717b1c6b83d759ecfb2f4a02321b196e9cdda271e" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/a66fe9bf-8e38-8752-883e-8992fd3ddd5f", "questionRevision": "e7cdb49e541a423c3be79d1e137ab27a72ae3d40108499384ee830524273f63e" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/901e3f80-76bc-8242-88b2-031f39cecbc4", "questionRevision": "8dbc74f110e5bff4f199501405b470b468520bae0a9af95c94b7e759c980e062" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/542eba53-f676-89fb-8dda-752f543098e8", "questionRevision": "dfa68486f9d651f68837c2752b051bcb1b0f2dba883e680cd91aaa1ad1dba9a5" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/1c5ee819-ff19-841d-8e87-8749f9a8b732", "questionRevision": "a043b5d4e8c6e1f94a5d3cc97ebe4a826f64d8cce7f11259cd47d3644c96c340" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/04796ba1-f90b-8b7d-8400-b18607f4904c", "questionRevision": "9cb034deb879c04a80c2b9c738a990ff3cb4da113007f18912441e66d4ed7dc7" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/dae19644-76ae-8e1a-80ca-eeeaa434415f", "questionRevision": "191b8bbb5e0cad95f45b87a7f21026a70faed576d112ae423812c37b19785410" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/559fe0fc-1047-83ad-8d22-3f61bb2ee38b", "questionRevision": "c0ddcd33a62da96eec6b191f54207b1080b7e1a646539c8bce0a58feb25e472e" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/dba27b7e-1cbb-83c9-8125-f71161298899", "questionRevision": "35cb32468f2041a406edb45863429eda0366d527caa3f8fcbbbe6ddbed720e3b" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/350acfe9-5e88-87ea-86a4-331d94a4e331", "questionRevision": "06cb92eb29ad21649780c3000d4321d24913fd6ad58fec07c52a0808575ee02c" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/039a5216-250f-87c0-8173-266eee70f0fd", "questionRevision": "5dfd6ef47b8327c1bd69a5ae34bcb9d4ba0a7f57257733a6521d31121e9f6bd9" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/7fe87bfc-492c-8bd9-85d3-c6515dd0f548", "questionRevision": "3ee8e687c150f8f3a5a8149f695b5525e0af3533d8cc2df6c12ca080300d7da0" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/2497409d-2457-89e7-8b37-60e1aa9e38e5", "questionRevision": "b2c0accff2331eaf4884b7a95bfa94d8023a04906c219f17fd6c101632c647d9" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/3ef91de1-77a7-82d3-8bed-58c6775df5f0", "questionRevision": "d8f3e042c8ece1bfb63da2e30940b56eba0427a8807cee1460574d072be1f88f" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/cbe3f789-2800-8b89-8f8f-aea76caf6c95", "questionRevision": "c466b4335ca0e8ad71cbda895f358c66a31177a19936bf25dcc8952c9f8b806a" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/4b8f70a4-bd1a-8d64-87ef-177c824dbc9b", "questionRevision": "039b5d0a313c3f6c301d0a2e6a2e5c058eebfe3d707ca868445b48e1b0dd3b3b" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/b814e750-2b5e-86b2-88b6-a60c17d56aa0", "questionRevision": "fecbce3a43ee58636e6b67f27b768434e8e8f73fe3c5cc1a5d1d5a03645e2348" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/c2cfde9d-4cef-863a-8e71-d0ce5e63f402", "questionRevision": "5000b38bbab398797c32756fe021da131a8012806697c032593a25f57534bf64" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/0213a2e3-12d1-86a0-8cc3-9144986a99ac", "questionRevision": "c54bf4dbc57ef8936caf79945005fe327753dfb3ed5f65b07b6b7565a6182800" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/de1ab273-afce-84a9-8259-6a36c9ba0357", "questionRevision": "09ea7fe32fdfa88ad3b14e74f4f43af39b20c00c8d29aeeff8e02fc2add2770a" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/75d22088-c02a-840d-84ac-a138af90850e", "questionRevision": "88ac388344d47eb86a0beee989f9bc0950e3b9aa39163ccb6893658728f6993b" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/6d1aa4d3-8ac7-869d-880b-c83daa86b0b2", "questionRevision": "ad079c1aef5fbac80633c504f7c7728874a926532419adfee30179bb88654b9d" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/8546a6d2-03b9-8367-8582-31fedacdf171", "questionRevision": "61c5948f72db383465c73295f93bd3c147023decf90460eb9764faa314e8ce72" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/a41db3c3-cb8f-8ea4-8c8a-0acdba5bc2cc", "questionRevision": "4080470eb3bf994cbded2b31caea460379a1314dddafbb8fd6926da5c9d0cb58" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/02cf4bcc-103b-8b08-8852-7f18f5b45f50", "questionRevision": "dc811c25678cb4d286e4f79fe2c003dd1d593222d22c0169ab30fdd0a02d3565" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/71436a96-6639-831c-8c37-e1437b49b167", "questionRevision": "c4149d2349ecb9ae82973499b0c80015dc6abfd3f71267b03a66d39c14f7ebcf" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/5db178d5-1168-81f7-8998-a1ac9aaf46bb", "questionRevision": "9c2cc01f8ddb73be9ab38468a46f4490a9ebd82c2f3d3e1f44bf3f6800d5f81f" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/fe71bcea-bc81-8c0e-8660-cfa7ac0946c1", "questionRevision": "a7d16b47e3153f1dd4d377071f5b0b22cf9c5dfca08b33cf491e1bad92377823" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/c78034e3-7cb4-8364-8ca7-713f42a91756", "questionRevision": "f364c6baded13c13089ab2f362db6360f941ef2086f97dd9c1f2d26125a49a57" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/fc4c1889-aaf9-814b-84ed-68cc437fb341", "questionRevision": "7ce6cbac9e4409ac173f7d7e44707b508559fb2cd6dc8b2f0b8bb702fec08bf8" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/1e09f141-ac52-8090-8a32-931e48fdbd95", "questionRevision": "c5782141cac1ded3e0c1a62929328c98a546904021f99eae3b770a02562ceebe" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/9442afaa-b5e7-8ece-88bf-3d4a7ef32a0f", "questionRevision": "5375770d654275b318b545045973908d217858e8e67ae6d80043d3830d707fd8" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/a1cccf3e-1564-8bed-8134-b9524ce4e0cc", "questionRevision": "f10e4470711b88a3d89f22634b161337aaab40c1ce09bb135554b145962cb417" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/3c6a3e44-62f8-8d58-8bb0-2843536b9aa9", "questionRevision": "aa5e61810610873127fe48683626bbf82bd83de1a823b985693b2c0cce6a829d" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/4fadcb28-957e-8520-8e26-e6c63a0b9c4c", "questionRevision": "8c29360397f1073f6b0c64d50a36fa80e5430b746d8d396346f5e54523c38ee7" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/0e441649-9e42-8326-8637-a6389ca10afc", "questionRevision": "8d03dc87650a4d21e5252446a4ffdad0eb56d32778dc792a2634c185c655c948" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/87cac3b9-09b3-8553-80d3-c1988b77790e", "questionRevision": "538fac72371ddf33181d758b307df3d92cad1219ec6601d4a2079605ca469d4e" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/527ea1fd-287d-8692-889f-d18f89ebbab3", "questionRevision": "44df5a15400711c2d1313769950cf9c695df443963de2ade3c10182b4042c937" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/37fd5a01-1875-81d0-8aee-574dc9f4230f", "questionRevision": "452f7351f0f3b93fdd119c57f7af7391eb3bbf9f4ffde70e036c8863ebabf322" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/6cf73f02-3f51-8b73-8e05-f79ade4b5006", "questionRevision": "b2dc780205c12e6a05c17b9282f8bfe748a6add693840c777f576e7370db2342" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/5bbf4c2b-860f-84a2-86f3-69ca90f8cbbf", "questionRevision": "3d27f4c5557b1d2631f0823bc5aeb31e4df1a95680440c2138abb2f2c6b3ca8a" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/701f0df9-0460-8a58-88d1-adc4a52fa3cd", "questionRevision": "cbb5e3d69713a462cbbae11f676d49560f456cfec188f4bb98f1af60b73ac3fd" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/cc99795f-c6f9-86ee-86cc-2d9932ca56cd", "questionRevision": "53e63a8d8b4bfdc981adf14fc4d7428d34cfdb807083fd4a73d006ddc9452b3b" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/338d123b-6e03-8679-8aa0-0b45016c0b5b", "questionRevision": "85d2cb65353c6d4211768e2118d32737a40c0b861ae9b1fd086262c1e82967f4" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/0f6bdd45-786b-8c0f-8e71-86a2347464cd", "questionRevision": "28d7fc0c5a45ba521a45288863e86e75dae6bf3aaabf902f48f5e537836b14db" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/c0c6ed2a-bf60-8602-8223-13eaa4e55e85", "questionRevision": "7881f5951100f4647699d47e129d0bc5bbfe816be6561efbad3293fc49714e55" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/135d3459-b970-81c0-8073-9059e0bbe988", "questionRevision": "263487af38cba47ca552779572c68ceff3a1edab44000f41838aa2be11fce389" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/1cb661d1-7dd6-8ada-8e8c-90b3c2a8d16d", "questionRevision": "e5e9559aa863e58742e739867f0fdb01dd5a8186746f897447c2236d1652f7dd" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/14d32b1e-c390-8c26-8fc9-4959cdc59459", "questionRevision": "a95185ad5ab3ab05b4015646beb303619ffff0d3ede20e4a52a6a9b0fe9a1a3f" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/a8022361-fac6-8b49-8a2b-4fdb306aebaf", "questionRevision": "3aa73b4a2e062f72c9b686c57647c04f169d1551c06ae8599256c02cdaf76ef1" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/af50f0aa-20c5-8af4-8208-b877d6594774", "questionRevision": "8813ffd60058d0c4cac9f39fe129f91a6d53163b28abca20428ed458b632f9b9" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/4ab3ecbe-a44a-8f81-857c-e505764f43f6", "questionRevision": "55eae3a3621f0923d986bb8f213a031c31dbf714def4c39b13900f70e062720d" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/39788d74-074d-8866-8348-3440e6670086", "questionRevision": "60f183063d505d0270706202476a61d92c30222c00ca190898e816a32bc78cec" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/0bd374a8-7db4-80eb-8fbd-1fc9b0fee1a3", "questionRevision": "d2052c058558328edc7033701dcf113b22825d316f3cb5b619fef0b59c83128d" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/25b726a7-83b8-851c-829c-7db6870d1c39", "questionRevision": "6ecd74ae565bdc70d933f9b716bfed483e11eb19292021b1decbb4822bf708a8" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/75b463db-2990-8593-8853-eed263568fad", "questionRevision": "217978f0b5d3bc0d0b5ece3c6ab918e24dd803f6c872f1aa74b43ca5afe744ba" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/c3a9db7b-abaa-82d5-8523-3744b8d68d96", "questionRevision": "8a6aee290443bdb0daf69a4aa22da23ead403433d740eec4a07d90ddb2c7eab1" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/3d9d88f0-ed00-870f-87a8-11edfb18300e", "questionRevision": "adcc293d1337a4915b2d19d74de909e9fbaed09149e30a418f08b60caccb8cd6" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/e1394441-186f-8513-809b-e8c82ec5baac", "questionRevision": "0a0d8e6ecddc87b600ac4f6e23c14ec03d409ad798340d34b67647238a5b0ba9" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/daeb456e-bc6a-8ed1-80ae-918cf2ef2866", "questionRevision": "1bb38608384a94c217bcf9b55a74ddb3e892e9014ebeafb5b8f1fcf62a6fb39e" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/91949c83-0486-8f57-8e2f-b77c7ab3481f", "questionRevision": "7d71758e2d931a7f7a9739a79873213960f3f12300759bbcae0ae0cf3647def8" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/734628bc-b1bc-8105-84cb-e56ca27b219d", "questionRevision": "74476ec11a6dc6133cd84975ae4996b40e0e739e2d2ef949818159342c526e53" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/738bce66-9572-8f9b-8740-b3169542172f", "questionRevision": "eeb2df2340127147ddcec78af5c53500960b8d4816ca5b7ece70c10a8840fbb5" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/fb1b8772-84d1-8bce-8422-5d0f303d765b", "questionRevision": "0549aec347e14ac8884e635898672a6712f3935f7b88120c7ad405c02727b1ae" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/09cc8eaa-3655-858a-85cd-e6159e0ba0c6", "questionRevision": "ecfb77fd61b1091967bf36c74941f29864d2ee3edb3dd0570cd1b8bd2d22aaf6" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/d387f714-8498-8e05-827a-43c14a53c95b", "questionRevision": "d87873f00476a675355c0d1003937ca1c5dd63776cb7aef2514bcee438219deb" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/bfdf15ed-971c-8aad-8fc3-814a3f1fc50d", "questionRevision": "e04b8cbe556bdbfcb12668e038b306d6f8dd149691e3271a19b6cd067b9b4778" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/00fcaee1-acaf-8f54-8cfc-b48c035faeb3", "questionRevision": "2ff1142b9b780ec5fac7e2c0e5d42d70b1f8c088483ab6417f9a61183c27c1e7" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/53b1a304-6a94-841e-84e5-48690d1efda3", "questionRevision": "f7643e1ce7977005ccc91b9955fccbad580786dfdbf508f6df6ec1a0aac83564" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/e2a20b98-7e23-8fb7-8dc5-bce2ffda4df2", "questionRevision": "225897b8528dd8abae5270af1ae52fae38b25021dd77d1e5096d9d6220491b8d" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/21f36de4-9499-8f12-8c25-f94d47192b54", "questionRevision": "e942abd1e16fd00217ea4f0ad95b7cf2fdc5f71a0dcb1450f808836c44c20cb2" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/d4fd4d9e-46d6-86b0-80ea-df762269ffeb", "questionRevision": "abe3b2e40cfc69dab05b8aa4ecd7780f0eae21702e3f6304f939110a628ba909" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/6b7a81ca-be15-8543-8ca6-6deedb83459c", "questionRevision": "4ac52038e6fcce47ee5d5a6c07f6c6dac14b6650eec20b95737e40345fd857b7" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/564cc660-2152-85a2-89c7-c35a78d03461", "questionRevision": "5ca2b714df2a77be617015e12e3c06aa038715c2b3a3443e8e927e0240389372" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/ec5470f7-adfb-88c7-899c-bf7e3c47fec7", "questionRevision": "6048747bea12d96980c6f396357795dd599f6369b189e5ab85d88d7be7054ab5" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/159f0a4d-7119-8bda-842f-3633b7e757e3", "questionRevision": "2672b6e3c63aedf8f2614053b15236569e58a2b30a7c052018cbc7edc3483ddb" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/83abc536-6a24-8e8c-8e93-48b3ee1be97e", "questionRevision": "ab0d558c6b3b624ba5a9f0aa70887292dc4957d4f6006f7edb025d9a26385168" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/52a3b69e-1854-8d9b-889e-893de93f0a10", "questionRevision": "f9136432eabb43d17619842547642436970754a7ddd9639917f0d267130ba6fe" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/2c7da86b-4a8a-8313-8d56-ef4bf2d2a02c", "questionRevision": "34155f7a9039433c91fda1286e4d0a66e75317efab826e18e7b315360dc04a18" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/ed2044c2-3bff-801f-8665-c459fbb678a2", "questionRevision": "b2617bb2e2df796d894bcf8257a1305446d8653496774f23235c34848d73482a" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/d525795e-c207-8629-8ca9-f4ed12429ee6", "questionRevision": "b363087c5b5949aefc86fedfd78d23ab04105b4d03e7e4117821bd15196b2882" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/d31d4656-5e6e-8abb-84a5-b4a1dd180b13", "questionRevision": "a5b1756627734f5747f72e50c31dadbfe7bcbcae51985a940b2dbbeff35e83d1" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/913a1409-f952-8335-8106-58a4b0fa93d8", "questionRevision": "761e603a18c66c9cb718cf53cd53011ab579f217ba02b6b2deff2c589f2ddcbd" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/5972f657-22d0-8bfe-88e0-d3baa414784a", "questionRevision": "b5052d4951b5a92247b313c92fc8a7080ea9276d63e65dd251df4c78817cdf03" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/1fbe767b-b6c9-8bbb-8f67-ccdf51798c33", "questionRevision": "3052a675a6bfbcad97d2be811caf3e75727622afb535d866161fadfc30146d81" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/d38c1dfb-c956-81d8-8529-6da0966a0a2a", "questionRevision": "78601df63d4282cc97645e88678bf7a07bae02714abcc35160fc0ff05e821b0b" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/ecbf98d3-e0ca-8386-849a-ec648438af8e", "questionRevision": "17edbf4bfc84baaa42a71de77485fc7768970d876cf2a46fbdef160acc51d554" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/07d72d91-8b3e-869d-8714-9ae64da5d5b4", "questionRevision": "4d20aaa9175bf188046f1e66b7aff0ae93a8a2ddeba94129a3d87ee2ccb0817e" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/50658e20-a8e2-8c0a-8a97-124b7f139424", "questionRevision": "f30b1f5edb1e4fb09566bc2782b3e17de4da4107d1a7ca6f651a727f6c0f8417" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/1b5b2d93-30a8-80b2-89bc-d3492c5c7548", "questionRevision": "bfa43fcc66bd12f5505e3cc626db9780130b27a19813f9ebe995d4d5fc0aaee1" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/d1cd898d-f472-8819-84f6-97b7336b1302", "questionRevision": "d1a9b267fc6d35447a1fee6d1e0730605c56b9a1a42929b4e89a30caa0861507" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/2d1359dd-5cc8-85ed-84bb-3c8e557b762c", "questionRevision": "8a3ecd79d7e1fc9a425626c40dadeefa762624aed6e71fab583f7f32d1ba0364" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/3621f42c-1995-8bef-843d-b276280b7c4d", "questionRevision": "5e2c03310b7d2d374fc460f148a613b672177578932e3f74f77de994e17453be" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/44f97c3f-94c5-820f-833d-9377e38811cc", "questionRevision": "f30a54d9a8a8c6c66900e9b5ea2c5b3ea3cd28b7c3a46e0378dadf72361bf5e2" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/18d477e9-e5e7-89c0-84e8-81a349bdbd04", "questionRevision": "23ae27bc692788f8ec45b0a06510c9109c10d63192b86f50b0b1b9a80371aab3" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/260da7ad-d5ff-858e-88f8-cdadf2563a49", "questionRevision": "e152afb841c8e8183e9f2bbe853b8178ea4e469a7d0c789060a71c13511dc56b" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/59d67116-0411-876b-8516-df1c28d6fa56", "questionRevision": "bd3b435dd0edfa0c3d3a04b68028c36d14566756f7f8260674b866a780c450e8" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/5d3431ef-87ae-81a3-8888-cb3ab05f3871", "questionRevision": "349ca8812313b2fa0c428367547a1a49ca80882684d86566571d5f1040d689e6" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/78ef1bc9-8e31-825b-8778-5b6a6500f54d", "questionRevision": "de1635b3ce08ce150da15580740baaa69bc54e312df9efbb0cd32e2006bbd502" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/4be58a20-0688-8d89-85e9-6daf63b8653f", "questionRevision": "7d58fc4be9b8712bba7c3f84124173c8ff47acc8336a193242615df37419f205" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/5ea2625c-b442-8004-827b-11eb2800a229", "questionRevision": "e2a9fd598ed418c6d4272064f203c86dfa6fdf5f3f451da2911db9106a07e0d4" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/47494208-54a1-85ce-8253-fa9787445887", "questionRevision": "bd659af11c0551880c695f925463dc2894901930de94b06e972539d88830163a" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/4fe4e1ac-9d7e-8c53-83ec-37a173c24c96", "questionRevision": "4e93c7480211e9c370013144e0401d2368b20ea3558297192a103c9a102c727d" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/c97d39e9-df50-8817-8aa4-1f418cd939b0", "questionRevision": "d33c0c30c69302b32425fb81ea557cf8ac41ad83c63b9d3a37162b5dc2856e82" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/d332e2a2-bcc1-8a4a-8952-e8cd09ad89f5", "questionRevision": "a279ee87b1fa238b8e572400ddc43c60322c23375a23e553b944106579800b7e" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/fece9a75-925a-8e49-84be-82c8da676b51", "questionRevision": "fcf54e69bf2473da8193ddd1bac139627ac40a04c756efaf38c135d818b6a138" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/bd27f23e-a1d1-8fa9-8cb9-d31567259d77", "questionRevision": "e4595bdbda42390099f41a1677e8926554000e77a58efa1a3ad920c97f56a479" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/6ca89e57-d0a7-815e-8c0b-39d6b06cceec", "questionRevision": "6c07c441db1937a22fdc52c4d7cccb49ed6ee86f64b3d8fb90628d9dcba4125a" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/ded503ca-5caf-8e8e-85cc-c23f5e7af914", "questionRevision": "938385b36a0a897e7edf513bff455cb10d34a64dbdd5ed2c591ceec5a741cec6" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/ae106c69-c207-8e4a-8b5d-7dcfd5579311", "questionRevision": "b5f760194196c1169ace54f882de17a46772a153d6bff03c647423afb0ce18d1" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/15d3ef09-7d56-8cd0-8f49-85907f63a9c1", "questionRevision": "ab8417add5bf3b52f0f8a1050c06e6341ab416527ff6993739f540fbc4cf5612" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/ca37468e-8045-8b8e-866a-e73942e3d456", "questionRevision": "5103831b5b6e85aba48f17d4db86ca346758412fe2f1e31107401a43e0ee51ba" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/abf96a4c-d716-8ec8-894d-5ab3d001e1a5", "questionRevision": "064bcc0cda16433c0a22360e66de03d6af3fb7ef8d1c163678d6e5132ad6d35e" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/88dbbb88-7ace-8531-88e9-803cfa0a5292", "questionRevision": "03eab1406029116346eb8b06434ff32bbaeefb23d051524219eeac54525a7c0f" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/ac7bcc7a-f677-8593-857a-10c8fd2c97b8", "questionRevision": "ed07bffa4b9862fbe343746dde4499103dd4d06aeef5fc7fba33583a12f73e22" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/21187692-7aa8-8931-86f4-7771780bdf33", "questionRevision": "bbce81e84939d30fa380d46caa9e4591f1ab701a46c79821c787dc9c81829a27" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/b90ef075-9d1b-87f2-86fe-c0fa21c23e50", "questionRevision": "8f17c801104a3b3de38b1a37478d4aa24d9e42d9dc782d6af241faf324c272ba" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/9bc6d647-ddd1-8544-8f59-a67456ec6bc4", "questionRevision": "69b9c33ca09c9404c0e0efd1c8cc7ebf934ca7ade611447f7cac059ad730d59a" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/9f8b47a3-23c3-86fe-888d-a0865c709933", "questionRevision": "8643f9501899469b40f0dd86062036fe3383067b8bfd5631ad7f107e074e4b63" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/36a31aa9-67e6-85ee-8509-85719bded379", "questionRevision": "543e6e5b9fa125e8153401671df8a122c29e2a353947d9d9cade132c2c6ca9b2" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/9cc69f0f-c554-85d4-8a3e-a8c933185269", "questionRevision": "274a91b13b373e59dcc56e50dc9cf6d0be92034af9406f3435edbd3395f9ab61" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/e56e8604-454c-83d9-8756-4a02f1a9a63d", "questionRevision": "6141b0e752c8830e96b43619a91d9a5245548cdd5b1deedc1244164fb938b2e6" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/c672a520-0dd1-8384-8407-7d73bd812701", "questionRevision": "7dc964d4a5bdfd89164aa7a584a6c12001e3cc5944ba605e7e2a4f3954d20388" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/f7f19f9a-8f56-88c4-89be-5ccc1634bbf6", "questionRevision": "841befa8c1b547c81094c10922db19dd67ea0561aefb9ce7add3a3d731954abe" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/47a1cb79-cec0-8a2a-8a1c-976c7212db5e", "questionRevision": "8d4d6d41b93ab4a0c543e9962c11cf52c39647b88b9264f1eb12505771f169c6" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/58d07e35-6c1e-851d-8c66-348523e41e2a", "questionRevision": "0ebd46c44740d5abf44192c8c2882aac652e1c8ae0e8b765979824270f5d3f50" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/8d2571a6-036b-872b-800e-7f713fa11b95", "questionRevision": "a0005a26b71317ad82c04ba32a3510197c7dd6f6bca40be37988ffb6874371a4" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/7b135247-9df1-8ca8-8e0b-aa064d424f5f", "questionRevision": "a6f8d468fc21f1e41c173deada4f4dc96a9137c3d66721665c3f8d26f3eabb72" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/06d24f5a-b0a1-8334-8ca4-0f2ceda7770a", "questionRevision": "99e5e4e66c3e123dba6075a4420963d243597d2f686dd865b8854facf4161984" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/a8f34d1e-bf04-8dd8-877e-f7094a6feac5", "questionRevision": "a73ba39a55e6e9de544bd2cb4838308f83b7295b1bd72cf220f644c059c19e15" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/2eb911b6-3be9-8af6-8023-c2265078eebd", "questionRevision": "b336481b0cd6e7d3c1986afe839dbe800feb25299849d6c1f889aee73488f045" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/a67ed3a2-cf5c-8587-8cc8-53bf052f80b9", "questionRevision": "4b2547a67519027af496d39bcdc03b02d0499d6837ad1416c301217e5ea55f87" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/51d5910f-f27e-8014-8b1f-1fe6440ac07b", "questionRevision": "06c37faf983a6d9fb78c9fe5194651bf484db661284a451117b3598adce608c8" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/c32d2874-1bff-8fde-874f-e9401529259e", "questionRevision": "8db3cde236d3b3977675280144a4b56372af08887baba9ff1a5f016eaae5f4be" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/c85b8154-fc3d-856c-84eb-12789415b90b", "questionRevision": "51bbb63dda86dfd6966d1b2b29b7f38f3c4a0a628b2a7557185e6c2cc30c9ec5" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/d9ea2bfc-70a4-8d7b-8e1e-762856d4d0dd", "questionRevision": "bb9d77cb155202a63707d7958dbaffb8f3be519a6c907c36558da6bc305cbead" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/5b67de26-43c4-8823-89bc-722946edc495", "questionRevision": "1fc382b93a083af03decd4007fb72bcb72a9716e957a549d3d2d587ab7fe63eb" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/7f64b191-03e4-8ef0-8c62-a19e62efc2c5", "questionRevision": "232333913869d8b0ae2936bd9a8608f87a2a32009ebc8734536831f4af365a43" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/a197b65f-8e83-84f1-8b92-160ab47fe324", "questionRevision": "fd0be45b960060f22872b0acdca7d7bc684601a624fddf179e519220a413501f" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/4c3d8073-b764-8165-8787-36267da36554", "questionRevision": "0e0791bde38dba994ec4042b624558ed551b6be031c43127aa6b5bd6cf347845" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/f2cd6865-366b-8fcc-8810-37b65dbd1fce", "questionRevision": "495af34e99497c7160369efc9c3a35210ff840d7b2e1cb2c28240a9e2ea39891" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/486b22b2-9975-8327-8c02-6a02575c11bb", "questionRevision": "ffab7303c83c5aeb2fa336f1ab4ea588df261a34ebc60226a6ef825c7ee9884e" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/f1610cc4-f548-80a5-806f-3824dc6601c2", "questionRevision": "97f03d40b0afc338c0d781fd6db54b786f00aed6d2556ce7b2f836b81f35064c" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/e2f62592-f6a6-84a6-8b96-89131b938d6c", "questionRevision": "23cb1a9e7001e1dfd1692afcbf5adafbb8acae668756d949e18733cb0c18780b" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/56936201-98ed-8892-8fdb-5c37043fa599", "questionRevision": "1e6b5c5164b8f34b633a9d181b180bbdb9f8d1f56c3b420bb06974ef155dd9d8" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/dcbaa325-ccf8-82d7-8266-42b27268450d", "questionRevision": "fd4413a21ea73b915066216876ef16256957d930098137d16ca8a8d7e3b78698" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/c25c8eb1-6a58-8f60-8ed5-61ef3e275ee0", "questionRevision": "55a2a0bd74586ba9b420a50aa28d05721fa8c4beb848050c4f512029d556fbed" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/e3756e80-6d15-8822-8884-e1da8e2474d8", "questionRevision": "eef8e26f29f5ba0a726a533fd61558eb58bfd81c4b489e2a0623b2af6113fcf7" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/24cb40a6-2be9-81fb-8a2d-4aeffbde2f9e", "questionRevision": "5a7df18e825d043219ffb0cf7fe2eb0c91bb54b6d53c1cd0d9c019eca39c8b84" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/2df15fd3-1ae7-8b7d-8d9a-8850717b78f2", "questionRevision": "e6f3fab53f550e916232e2d968ad2d18123d65708f350d43df1254e8a6d2cbd3" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/0af3ff27-c432-8e4e-86dc-2218237dd9da", "questionRevision": "4873279131ee5a2b33eed59b03af1235bc09c7bb43f7f82de30d0c5efdb83726" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/c63bfb52-78a9-880f-8c7d-4f6f4e0c680b", "questionRevision": "5d67bceb1a94162de2800ef46b3b674a2bb9a56705306518dc0fb620c2278cee" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/fd6e1893-962f-821e-8b9d-189ae81b651a", "questionRevision": "cfb7f267cb647494278bc76ba553be718b982660889b99ce092078aa1616a6e6" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/40dca9a7-9784-86d8-8609-4174d69dd5f2", "questionRevision": "3546df204bfa3b78d292c2efc5570156bf4c99e982a11cf15ed7024930c716c0" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/b051e599-4271-887b-8e94-78cfbe419714", "questionRevision": "bd3b2495603b22b95befac0a107b8ccc9d6c69dd1c1a50e77d2d2a655547e581" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/d88f9460-0df2-8a4b-8958-f6d0c94c2a96", "questionRevision": "9074e6882631f7236e7e15747092b530fe643d52b2252d71279f85c31a94348e" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/96edbf65-7b4c-8aa0-8a20-be92c2bbd3f8", "questionRevision": "09201b803c6827f8c7ceaa7625a19e4c73441cc7fd1b5a16b0e5a879ef4bbe76" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/5ca8c067-05f5-8203-88c7-26efdf87c017", "questionRevision": "eb121fb2932d300ac34f3d1ac72e73c5b74d1670cb7480fca69302a1b0645eb1" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/cdafd3f2-4fcb-8613-867e-1f5a15fb2c36", "questionRevision": "9b8d7c9a970b99de50ded7553ccadc9b8ef4c6f5003cd6e1851a8e12a1a34c70" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/4f9920c9-a7cd-8fed-85cf-10645b2365da", "questionRevision": "e37f126a7d45973a0d4324fd3427bff2b5169bf0c35f12a7177971f2ecbf96c7" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/44813df8-2302-81e5-8d6a-68b5a5873143", "questionRevision": "4781b13f212d4b89fa27af4a7468fe4e9acd1baeba32952d66335d5088e2c22b" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/4ba6dbfc-afb4-8ac5-89ae-036a2203a766", "questionRevision": "bfa22368f28081f4d9d93e73517ebd3894179c4ea74a126f0b3c57fd5ce5f352" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/68935448-6513-885a-8f2f-e20ad12386c2", "questionRevision": "6ce1b9b30aaa4243d5d593fa3e4a9ed5a8143ad11d14b83f62b8f6792d9148b1" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/f6afb586-cdba-8f9f-8367-c1dab26c3758", "questionRevision": "5d85a215d486d76c6496e700bf3cbdeb701ebdc76a23e6b669aa4ca2eb8d8ee7" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/2c5db537-3b3d-8a32-885b-a44dc9a7aeb9", "questionRevision": "715921b8b211ba3a7b2a1f9b55a3ce8253110f58b942231f07e19f165b6f7b03" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/86021b20-ef9e-8e2f-8b32-df0b5cc3714a", "questionRevision": "8f65f891ccd3de8033b209277b3547698bf82ef9d97247f155d8992659f2a851" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/74848c0b-3629-892b-8cff-92d8acd4c80c", "questionRevision": "83ddc651553ff718b60548c8c7ee9c9aecdc6652a86c532055e63b55fbf63c96" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/21d8cdad-4620-8f87-888e-521677c8177f", "questionRevision": "ff5afc0077e25962a58aabb9229d1202a48a01f97d7df81e6d6559b50376a90e" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/93a3ace4-ceb1-8d19-8b43-91214c25dae2", "questionRevision": "ced8eb5e4e6d475a66ce074762a46b557cbed131265147193b1172048fd39163" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/50915fd4-a2bc-8403-88fd-022235f94cf6", "questionRevision": "041f01af62d042ef9f5db9289445042956f6a0077fac58e4624d5528c8e22d7d" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/bbd12570-b61b-8a17-84d6-1f6838e78f8b", "questionRevision": "a1e56a0abc684f88f366fb2cfd3f54f65525b5c7f3a753437852ccc2ba715b43" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/82e8c3df-2901-8699-8dc7-b097136c52bb", "questionRevision": "bc716f20a3b7b3819fd14e1107031b50956e2bf1274900d3c452cd9f246ef34c" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/a2e13a18-d929-8501-8bd7-d79f82730ee7", "questionRevision": "06ac46ffe9f3b0cfa51a45d3a182c78d53c77997e2b9519b0438a646d9ba4bc5" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/f90aab36-2118-8b5f-8d98-f0f8edb16557", "questionRevision": "5225d54482a11d2d4ff92505646b29e6415d904007af3a901e2d50f1a1e760cb" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/0efdec8a-084d-87be-8e66-3c691a87945d", "questionRevision": "6c337d321fa1cdcf8a03d9e39188a32eb6fa8430a3bb6a46760558cdbab208bd" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/bb18b0bb-9519-8b72-8402-182b28a24e84", "questionRevision": "cd9f901ea30bad89726124410cfda76bec1163dfa226a33b1580fe4e6783dacb" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/09ec6a10-b19c-8263-821e-45dfbc3262cf", "questionRevision": "8f11b655ccbf1f5e45933841f9b9d1842860e9785f0bae24f5133589dba076ab" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/35fb2cb0-e30c-8a97-8991-751419aaf35d", "questionRevision": "e58b9676e261457b78257f5a0a16ab422ee93bff36a4429a0464297bfdb88d75" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/417ce042-b823-8e99-8899-d6885b09bb52", "questionRevision": "aff93e2d11ec474c382495c2308abf62202eefd933db6889890de6ff743891f3" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/84055f94-3c0a-8a72-80d5-0c3f79dcfdf8", "questionRevision": "1ee46102b80b584d7abf109b1a3251d7cf75e17c28faf2cbeae7767d370ec8bc" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/83c81520-3030-878a-8b3f-fd9103cf632b", "questionRevision": "f8086d4f9b59792a340ae3f3fa3d45c8d6544e77332fcfd74b361704f189ca48" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/95e89b58-2d7f-8e6f-8de3-3b92c12fdb6e", "questionRevision": "920f21ca66962573009eda969c7a595a0016400f3b42d473fdaccf2e95b2dc18" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/73b4edda-c74c-8d8a-8bfc-153f02f077ac", "questionRevision": "bc4c15ebb56e90dbcf32592984722e93ad6c964575cb453cccd8dd14848c783a" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/406649cd-21f8-8ab4-841b-16406a6d3ac1", "questionRevision": "8ce976a544fbf93b9dd63af78f2ecd5f6fa6f4e2c713715fe3d4b0f4a03fedcb" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/4d3bff5c-6260-886d-871f-a36fda67edab", "questionRevision": "59f7cbf7c61515b954ac630db162ceb1cb5a51928949c7531dbf0df9a86fb7d4" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/f9dc4dbf-1aa7-86e2-8310-c78140c9e503", "questionRevision": "b1b4535438edf30b059472f46d7d395dd8acecbae71f71542654bcbb40e9e62a" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/4af59e4c-5382-86c0-8281-4d5dd76d1a2f", "questionRevision": "c100789db420cbdfedb4993d3f98f5b483afd662e76736da7351b8fa12f6cb72" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/c0c591fc-35b9-83c8-8f21-a5fe0676dc15", "questionRevision": "9f2ee6b0a8287ecc81b0a44fc1a369a43e174652b038fd24c367b741fcb1ab31" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/3c3ad285-2621-8438-80c7-ca6ce8e56fbc", "questionRevision": "58a108a8c324f9b6425c0061b077bb8eb92068d192fb4f34fe2065d153b9349a" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/f22e436d-2695-8009-8b35-db907244aa8f", "questionRevision": "af63474caf37b81cf1320d4fe71e411ca80cc96cbf61d51bfc612e1810c082ce" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/e0d8a008-81c7-8edf-869e-2ea66ffe7303", "questionRevision": "9ce208c91564d1f7f2f562cf442aaf9e01afe02baeac85781a7671ee7850fd66" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/2e17e306-2f9e-8425-8c71-32c112009825", "questionRevision": "5a8a099c04b6f3063237de28c56852885db5297feac1c5983fadf68de4ea5cbb" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/bc1b5045-0a24-8905-8cd3-4f8f7bed3520", "questionRevision": "ab9d864e31e11cd2532ff120345cb4854404d9be614d10113d8a32ca97739a0b" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/22a74962-0030-8fac-83ab-97447e3b590e", "questionRevision": "0ad2a3951b609ad0d42d258e446ad3fa3a6b40b35c6c3ca853cf0f7ce96e8987" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/bf9ff907-cac7-8b1f-8a17-835d76222bde", "questionRevision": "7006fcf2594934e3a8a3fb5b8ba33a98a9c59ed3bd00ac41be1b6e54d758f547" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/80b027fa-4c4f-8b15-87c4-5fef7db2d673", "questionRevision": "b923296ec01080817c647f9598f5c74a3c67e354a414f85b7408dde772ee821a" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/905aaa19-ef90-8c1c-8c56-adadd51df3e8", "questionRevision": "2096983daf3e5c78a92db32cd6d61b40ad179415ae1f32a14cb399f5ab4fc8de" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/b1083abc-4753-8668-8a81-ab1c1513871e", "questionRevision": "dc24dd653e9966109bedc09d3300dfc236d7ad6bcf78a5bd110d1a9e98afa361" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/637d489f-d28a-88a0-80d7-0c2e464a3b1c", "questionRevision": "9ae5cd8403db5be23f44a8371650e25ed16ab65572718f2c9cff803a1853446f" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/7aa0de1e-9d20-8d06-851c-040e75a5491e", "questionRevision": "ba1c9d406b59f573398cd1bac0e10dc61a19082776536796ff8ad673fd33975d" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/e8a59765-1f89-82e8-84ec-7d7ce0f70d7d", "questionRevision": "be8b74edf4c9a898e9f22b42ea6029a42778b64ee4f7d3dc01e455a2a14fc833" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/7d80c5d8-06ed-8e0b-8592-a09d01742c38", "questionRevision": "5e5d7d6b4c5f7d81e06f58e2d48d811c542a35d6bdb529366efb3fe0b9c682cb" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/5dfaeb21-4d6d-8703-8e10-f06983783cba", "questionRevision": "57a938f0b90cd439e03cec2967fd77fa1d7df04f51367e56d14eca7f15b04dde" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/bcd1d10a-6133-8bac-80cb-e6bb389ccb36", "questionRevision": "b8ea5c3e26a28ee16217d33b057bc871992a8a6caa19f009947d627469001758" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/ffbb51ab-1198-8d4e-850e-a17f5b7f75f9", "questionRevision": "96afdbf7a2f804dde195233198f665aefd7e564ad575f034b4bcba9b39cc16dd" }, { "questionKey": "de03a471-ca5a-84cf-81c1-2b8107db535e/f12c070a-1ffd-8434-8dbb-34aac2376733", "questionRevision": "5437f5f2b691a52190fa2a6fcd6a812582c69dd50cfe8bfc0d7d6aeff0c62673" }] }];

// do-worker/src/historical-public-second.generated.js
var secondHistoricalPublicRegistry = { "bankUid": "8d2f947f-cffb-804b-8a3a-c757c6369bc6", "revision": "8a5f96c88bec64fcdff7b0cf7846edf1ccfd9cd606e68c02780c230000504b1b", "metadata": { "title": "211 Sheet Metal", "questionCount": 246, "visibility": "public" }, "contentManifest": { "kind": "public_static", "staticRef": "banks/v2/historical-211-sheet-metal.8a5f96c88bec64fcdff7b0cf7846edf1ccfd9cd606e68c02780c230000504b1b.json", "contentDigest": "8a5f96c88bec64fcdff7b0cf7846edf1ccfd9cd606e68c02780c230000504b1b" }, "publicContentReference": { "contentDigest": "8a5f96c88bec64fcdff7b0cf7846edf1ccfd9cd606e68c02780c230000504b1b", "manifestDigest": "d4ef35f98c20b90974e415003c5555bf0b854739ee43f11888148c284474009d", "totalBytes": 14476875, "chunkCount": 28 }, "questionsrefs": [{ "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/67700c89-2ce3-8da4-8b45-fcac2579e447", "questionRevision": "aacbeed43c145b78b9f0c0ea9a3f886e22f4f964d6de2f62a73643daf203d7e3" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/98662c78-17cb-89ad-8cae-501c40892677", "questionRevision": "591bf2b17078ad198869afdd524f1445df7fb6837dca2e380e76d1523e658821" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/13fa3359-0615-8395-88f3-86d4e191dbc8", "questionRevision": "2f6f374b1f2ece0824ad1a46ad65442f99d48b8121a26d3c430c2fc0e60161c2" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/de7d2496-7036-8f4e-8324-2a6131c06ec9", "questionRevision": "ed2c5baf79715089a7c789112f21cc928233765c466d81a9811548e54c0cce6e" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/c1fc071c-ae63-8fda-8b3e-aaaa3d158a2c", "questionRevision": "abdbc223a9cbc58649a910c84d1fcc5c27da0d4017c382d826bc425078679654" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/359005e7-52b5-898d-89e8-02c54be62c11", "questionRevision": "a959c05014b8ec00f065b4309e398556480d19f9aec9763fa8872f00a3877b6b" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/22431277-8502-837a-867f-7dc083eb08f9", "questionRevision": "cf90cac851488ba80d12151d73cf76a8f0801a67af2798264b3b4bfc0f9279e1" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/0af5f303-bb8b-86de-81e1-2919975fdcac", "questionRevision": "7317531daf84af4773e0d4115055da913241b0d88e621bbcef8a542d85cd32a4" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/bf0c4f10-496f-8fc3-82b9-de7e87f61c46", "questionRevision": "7bf51383fb1d833ec1a1960ef2ef922a4ed870b17dc42efba96c32d4573202c4" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/5e2cc4ca-21ee-8375-8bff-55e22a407ea8", "questionRevision": "8d978ff97373f49f93d88169ab2ceeab125ce909ee901355eaa46f52f7e32f11" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/abdbdfef-f62c-8e79-8b6b-d4ce0fa2ee55", "questionRevision": "778d78b6c5a1636075577e9a617d0372d28cb23cb1bd11bbc08a15e1de76538a" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/1d341f8f-d4ca-82b8-8869-9b4d4c153b9b", "questionRevision": "2bbf6d03b4724307ff06ba69e44d190f1fc8543f164756df818969ea195b65ee" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/173e20d9-0883-8903-8ff7-c4f4b8b7b5f9", "questionRevision": "8ef1068b3a4df88a97b815a3e47fcb91cf95a401f41748d1ed0628bf9b421810" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/b8baa8bd-fdfe-8bbd-8128-2519913b1260", "questionRevision": "cc4b826767efc346ddacc85ccfe5d19a947308ccacfa1e3f5a8326d8e7534d80" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/854eeb14-d810-8a15-81bd-53b5b51d8d94", "questionRevision": "cd5731b7a0810672877a000ce02f3d7e45135f410472cec2bedb830bb020fd56" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/5d2f0ea0-984b-83d7-8831-394942bab213", "questionRevision": "8cdcaf8fd6c4efc66ffcdcc4b537f0dc91975552c311ccdf1f682caa06bdd76b" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/724fc186-fd1e-84e9-8335-3ec38fec662d", "questionRevision": "fbb379de5b210fa8276907d8844a1b49f4989754f390c52b4593d5071290361a" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/4a6d2b42-01fd-89cc-8937-7803b43c3de4", "questionRevision": "df41a89e6319fb8d1dfcc6ce4c79f6d68bc94fe804684a8d8c973249821428d3" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/b2166ef0-ab3d-8725-87aa-12c3741bc3a2", "questionRevision": "93f5c9b1106578aa043e3040a5ee8a928f5808ca9c396441170529bc777bec65" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/184f9d6c-c3db-8e77-80ce-724b624384fb", "questionRevision": "b6fe8d879aa91ee3ef2fb9be0c953e6558173cfd321d2324bb9855bfe57af758" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/8feb2b68-01ee-8004-8baa-d686a4295acc", "questionRevision": "8cedcf6389e92bc9caa533d1f9879cba88755aa2752d983f48561111656253ca" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/4650865e-673e-86ec-87cf-bb5ef6caf419", "questionRevision": "0671222b2d80ae269bb3c3c2ce4e4e796845ac3836d625c69172da9e12bc4560" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/967d652d-14d3-8fd5-86d4-9974d1233cb9", "questionRevision": "91b11c476ef481f53a2a97bfb23c42a3845fd632baf7a2c27a10cf6714adcd61" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/83e688a7-514d-8909-8f6b-d6158e8a9dab", "questionRevision": "ddd6b9060f75060108373b5fcf2293362e039e4d2276626c53317ed3fb3b899e" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/90ef8f31-8f54-89d9-818f-3720b93983be", "questionRevision": "0ce4e982c5150dfc10a69bd9152068c58fa16c7e5d0c6eb6c665454ce23277f6" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/447a02ce-bca0-8487-87ea-9d0447d0b00f", "questionRevision": "337d5cc6856720a4f55c56194e28b95fa2ce19706fa333249f8997d1738883a4" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/3714c0c5-98c6-86f5-81f5-3c6dc4f4ef9b", "questionRevision": "240abca0bdbf9b60ca9ce697cae8a6e9e1f61843b885227ac88a7df1e3ccd12d" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/c9e9cd44-a262-86c5-80ee-eaa0aba667b7", "questionRevision": "79bc9a107468571f45c3115cb96e559d2feb2044fc41a7973f2fb1c886188d8e" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/c5a43673-eff1-899c-8d91-8e035768bcc7", "questionRevision": "a96f65d07f8bec4ce8c150184c88f506dd7684f268b31dcbbd9af1fd6b9b84ae" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/ac0ff82d-eda8-89f0-8bc3-5427c2df243c", "questionRevision": "7515bf346ffe6f1d34bed1bbf93e574bbfbbd25d54e07cceb1ba387d2783b398" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/7373c89d-bff1-87be-837a-137ec1f3c5b2", "questionRevision": "071db3e981df9e0cf7dc7b24fcf83f21da8c5c3d05585d6598cba6e54d218103" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/6e0f5b2c-d690-8cf5-844b-5d8bb2a1cb85", "questionRevision": "3a65129d499aee141a5a303342143d0fcc0d9587d7e8b878de6fc6e622840df7" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/a6aff688-a5ee-859d-8d35-02ba25c6eac8", "questionRevision": "f4d5fd1962c5231774ee8b8fa2bc97ba8c727150bdc29c94a768cb68dbf6e2f4" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/a34d8f96-4f21-864d-89dc-03952ddd2f79", "questionRevision": "0a6aa9ff7e60ae3f2b95f3ccd5267caf9391b40dac6160f4e84e83cd7f23cf68" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/2985dd27-5789-8288-8204-6b8fd16724a0", "questionRevision": "7a04a22ba0d4cdfc5df260bb98f1e1702fc06253187c4cd107be2db8a9aaf7af" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/c490f1cf-3368-8895-80e7-d1a1377f1a6d", "questionRevision": "ed4a4628375df839f170e26f0f977a12fadd5cac2ac021ab9280f685bfe70b88" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/bff5eeb6-7ac5-8eb8-8da2-c6761f745dab", "questionRevision": "8a27d6a8c4f2a6d3ab694adcbacc6181ca9e006d315841532bd9105548543658" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/54681c0e-4142-8227-80de-54e2ce58deb2", "questionRevision": "6b063fe38fba2253313d3823ada34fb43979ef04ede89bb5697342d5cf38b861" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/c4ed50fc-c2a2-80dc-8a03-4147fba88e2d", "questionRevision": "1e40364be40981eed82814f14194f489d0a671e072890276dcb524191fc49361" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/b8bdc1e8-b5b6-8891-8460-caf152647a94", "questionRevision": "c875f8fef6cd3788623d81d05b694ff38c082a2a3c4cd326530bc5eeba4c9c0c" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/eb86dabb-c3d2-8c1f-81b4-c0ffe8b3cfb9", "questionRevision": "94a8c164aa63e1f0c0fda6f717b1c6b83d759ecfb2f4a02321b196e9cdda271e" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/8d3b581a-17e1-80c4-8b9e-80e70267ec52", "questionRevision": "e7cdb49e541a423c3be79d1e137ab27a72ae3d40108499384ee830524273f63e" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/3d25d81c-9ef2-873e-8496-9af9d146abdd", "questionRevision": "8dbc74f110e5bff4f199501405b470b468520bae0a9af95c94b7e759c980e062" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/58e5be87-79ce-82a7-86fb-177f86034066", "questionRevision": "dfa68486f9d651f68837c2752b051bcb1b0f2dba883e680cd91aaa1ad1dba9a5" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/38d0e549-7916-84b0-823c-3858c0970562", "questionRevision": "a043b5d4e8c6e1f94a5d3cc97ebe4a826f64d8cce7f11259cd47d3644c96c340" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/785c3d87-871e-846f-89da-2dcf2ea2aca7", "questionRevision": "9cb034deb879c04a80c2b9c738a990ff3cb4da113007f18912441e66d4ed7dc7" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/0b9cbb79-b311-85de-8a1b-5b5836baa153", "questionRevision": "191b8bbb5e0cad95f45b87a7f21026a70faed576d112ae423812c37b19785410" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/934b9919-a8da-8394-89c2-5a93ef330292", "questionRevision": "c0ddcd33a62da96eec6b191f54207b1080b7e1a646539c8bce0a58feb25e472e" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/b19e088f-7bf4-8717-8e26-19f518c5ac6f", "questionRevision": "35cb32468f2041a406edb45863429eda0366d527caa3f8fcbbbe6ddbed720e3b" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/1f253283-aeb4-8504-859f-cae0fd0223a9", "questionRevision": "06cb92eb29ad21649780c3000d4321d24913fd6ad58fec07c52a0808575ee02c" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/0dcd1a14-0e89-84d8-8a73-031369dfc7b6", "questionRevision": "5dfd6ef47b8327c1bd69a5ae34bcb9d4ba0a7f57257733a6521d31121e9f6bd9" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/764e93c7-a144-8b65-8b69-a4a21b65c86d", "questionRevision": "3ee8e687c150f8f3a5a8149f695b5525e0af3533d8cc2df6c12ca080300d7da0" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/15d510e6-2303-8081-8636-ccdca6d5a4e7", "questionRevision": "b2c0accff2331eaf4884b7a95bfa94d8023a04906c219f17fd6c101632c647d9" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/c72cf154-4c59-8aaa-839a-85a297e8d937", "questionRevision": "d8f3e042c8ece1bfb63da2e30940b56eba0427a8807cee1460574d072be1f88f" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/73c8b565-6cc1-873a-8a02-73845ebd4d57", "questionRevision": "c466b4335ca0e8ad71cbda895f358c66a31177a19936bf25dcc8952c9f8b806a" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/4c38639a-ac3a-896b-833f-2e8ca65c9f6f", "questionRevision": "039b5d0a313c3f6c301d0a2e6a2e5c058eebfe3d707ca868445b48e1b0dd3b3b" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/02b98723-fd57-86eb-8143-2cd7c1dbc6de", "questionRevision": "fecbce3a43ee58636e6b67f27b768434e8e8f73fe3c5cc1a5d1d5a03645e2348" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/6c709ec0-315d-8cc7-8522-a5a88d82039b", "questionRevision": "5000b38bbab398797c32756fe021da131a8012806697c032593a25f57534bf64" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/f315d401-59fb-89f5-8720-9e259e622063", "questionRevision": "c54bf4dbc57ef8936caf79945005fe327753dfb3ed5f65b07b6b7565a6182800" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/ee5e96ff-cb53-88d7-8222-42a625bd9bc1", "questionRevision": "09ea7fe32fdfa88ad3b14e74f4f43af39b20c00c8d29aeeff8e02fc2add2770a" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/22767200-5cba-819a-828a-3d540be9c127", "questionRevision": "88ac388344d47eb86a0beee989f9bc0950e3b9aa39163ccb6893658728f6993b" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/6eb67d6f-fda5-8645-8228-af7a30ad1316", "questionRevision": "ad079c1aef5fbac80633c504f7c7728874a926532419adfee30179bb88654b9d" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/39083d63-6615-8cab-8985-49775ba9f170", "questionRevision": "61c5948f72db383465c73295f93bd3c147023decf90460eb9764faa314e8ce72" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/5bf0c3dc-1be0-8606-873f-29602c73e17a", "questionRevision": "4080470eb3bf994cbded2b31caea460379a1314dddafbb8fd6926da5c9d0cb58" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/11fe3ce7-b216-8646-8c00-77e2b0e49da9", "questionRevision": "dc811c25678cb4d286e4f79fe2c003dd1d593222d22c0169ab30fdd0a02d3565" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/74d9cfe0-2eb7-83bc-8576-fc07a4339a19", "questionRevision": "c4149d2349ecb9ae82973499b0c80015dc6abfd3f71267b03a66d39c14f7ebcf" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/b5c716d1-381e-830f-88f8-b982c40832f5", "questionRevision": "9c2cc01f8ddb73be9ab38468a46f4490a9ebd82c2f3d3e1f44bf3f6800d5f81f" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/f33705f1-d4a6-8ba2-8a53-e458edb634d8", "questionRevision": "a7d16b47e3153f1dd4d377071f5b0b22cf9c5dfca08b33cf491e1bad92377823" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/04cc185c-a526-8192-8f2a-d4b7ae4f77fa", "questionRevision": "f364c6baded13c13089ab2f362db6360f941ef2086f97dd9c1f2d26125a49a57" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/8e70ea82-e031-864a-88db-554b811bae2c", "questionRevision": "7ce6cbac9e4409ac173f7d7e44707b508559fb2cd6dc8b2f0b8bb702fec08bf8" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/f972e977-44c0-87b0-8a08-a1dbf50d5821", "questionRevision": "c5782141cac1ded3e0c1a62929328c98a546904021f99eae3b770a02562ceebe" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/cffebc00-0496-84cd-83e5-d56ffd1ddfb6", "questionRevision": "5375770d654275b318b545045973908d217858e8e67ae6d80043d3830d707fd8" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/f3596101-c5e5-8877-89da-6f1245448a18", "questionRevision": "f10e4470711b88a3d89f22634b161337aaab40c1ce09bb135554b145962cb417" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/844f25b5-dbb1-8bdf-8449-dea6e7e041e0", "questionRevision": "aa5e61810610873127fe48683626bbf82bd83de1a823b985693b2c0cce6a829d" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/97b70b08-da7c-8e92-8e3e-9a532144acdc", "questionRevision": "8c29360397f1073f6b0c64d50a36fa80e5430b746d8d396346f5e54523c38ee7" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/dc1f9491-4cac-8634-80a4-45637b0ce24b", "questionRevision": "8d03dc87650a4d21e5252446a4ffdad0eb56d32778dc792a2634c185c655c948" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/5d14c7b3-20e6-8fb3-8d06-2e12c49e8411", "questionRevision": "538fac72371ddf33181d758b307df3d92cad1219ec6601d4a2079605ca469d4e" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/6f65090c-fe63-87f5-8908-920f1d278dac", "questionRevision": "44df5a15400711c2d1313769950cf9c695df443963de2ade3c10182b4042c937" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/6996edaa-f0d7-895c-8412-f2eba2a6fd15", "questionRevision": "452f7351f0f3b93fdd119c57f7af7391eb3bbf9f4ffde70e036c8863ebabf322" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/ece670ed-df1f-8602-8d08-1e21f356675c", "questionRevision": "b2dc780205c12e6a05c17b9282f8bfe748a6add693840c777f576e7370db2342" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/0f10eda5-c32d-858b-85ff-9df38206c71b", "questionRevision": "3d27f4c5557b1d2631f0823bc5aeb31e4df1a95680440c2138abb2f2c6b3ca8a" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/3347ddf2-e933-8298-8e79-01acd230ff09", "questionRevision": "cbb5e3d69713a462cbbae11f676d49560f456cfec188f4bb98f1af60b73ac3fd" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/7691838f-4a39-81b4-8422-33c18d15e458", "questionRevision": "53e63a8d8b4bfdc981adf14fc4d7428d34cfdb807083fd4a73d006ddc9452b3b" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/a1d043fe-b629-83aa-82a3-c4b140832838", "questionRevision": "85d2cb65353c6d4211768e2118d32737a40c0b861ae9b1fd086262c1e82967f4" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/1d731b18-1082-84fe-8086-98079a963167", "questionRevision": "28d7fc0c5a45ba521a45288863e86e75dae6bf3aaabf902f48f5e537836b14db" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/e6265f28-e2bb-8965-8e96-71dcab357e82", "questionRevision": "7881f5951100f4647699d47e129d0bc5bbfe816be6561efbad3293fc49714e55" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/a4cebc26-6d2b-8c9d-8687-07c9c152c526", "questionRevision": "263487af38cba47ca552779572c68ceff3a1edab44000f41838aa2be11fce389" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/7d15eef8-8eb6-8e13-8d70-2ba482de85f5", "questionRevision": "e5e9559aa863e58742e739867f0fdb01dd5a8186746f897447c2236d1652f7dd" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/f3cdf76c-fda3-88fb-878c-f3369ab5e7ce", "questionRevision": "a95185ad5ab3ab05b4015646beb303619ffff0d3ede20e4a52a6a9b0fe9a1a3f" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/063d5ed2-4552-8a8e-820c-4495f5a1f800", "questionRevision": "3aa73b4a2e062f72c9b686c57647c04f169d1551c06ae8599256c02cdaf76ef1" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/707dca5c-dc50-8748-88a4-e1f3a8cd5f64", "questionRevision": "8813ffd60058d0c4cac9f39fe129f91a6d53163b28abca20428ed458b632f9b9" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/3b34e2b8-23c0-88fd-84e5-6decd03708d0", "questionRevision": "55eae3a3621f0923d986bb8f213a031c31dbf714def4c39b13900f70e062720d" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/d6252e74-69ab-8fcd-845e-286b0b9e14e4", "questionRevision": "60f183063d505d0270706202476a61d92c30222c00ca190898e816a32bc78cec" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/05f3cc05-6a9c-891f-8676-51266c8d8b90", "questionRevision": "d2052c058558328edc7033701dcf113b22825d316f3cb5b619fef0b59c83128d" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/4b42d56d-5c8b-8e19-8941-485ca6e1d24d", "questionRevision": "6ecd74ae565bdc70d933f9b716bfed483e11eb19292021b1decbb4822bf708a8" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/0902f600-add0-8b64-8e11-4979dfe6fc4f", "questionRevision": "217978f0b5d3bc0d0b5ece3c6ab918e24dd803f6c872f1aa74b43ca5afe744ba" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/74394ed3-cadc-8481-8c16-ea1988dc7f3a", "questionRevision": "8a6aee290443bdb0daf69a4aa22da23ead403433d740eec4a07d90ddb2c7eab1" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/ae8fc208-7be2-8440-80be-86e68bfd03dc", "questionRevision": "adcc293d1337a4915b2d19d74de909e9fbaed09149e30a418f08b60caccb8cd6" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/0f432490-8d1f-84d5-84f1-eff9c2fa317b", "questionRevision": "0a0d8e6ecddc87b600ac4f6e23c14ec03d409ad798340d34b67647238a5b0ba9" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/93cc96a6-acd7-85a2-8f97-5ee874bb6d4a", "questionRevision": "1bb38608384a94c217bcf9b55a74ddb3e892e9014ebeafb5b8f1fcf62a6fb39e" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/e5171570-49a2-8a72-8431-79ad6df389ef", "questionRevision": "7d71758e2d931a7f7a9739a79873213960f3f12300759bbcae0ae0cf3647def8" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/28068790-4381-86b5-834f-fc33c146ff2a", "questionRevision": "74476ec11a6dc6133cd84975ae4996b40e0e739e2d2ef949818159342c526e53" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/2f63ffa5-45f9-89f5-8386-f39d0ec42e7c", "questionRevision": "eeb2df2340127147ddcec78af5c53500960b8d4816ca5b7ece70c10a8840fbb5" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/d04403d0-f867-8520-8587-077f651fdfab", "questionRevision": "0549aec347e14ac8884e635898672a6712f3935f7b88120c7ad405c02727b1ae" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/be578c92-1b5b-8ec0-872b-14281f9c016c", "questionRevision": "ecfb77fd61b1091967bf36c74941f29864d2ee3edb3dd0570cd1b8bd2d22aaf6" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/99e0e10c-9ce0-88e4-8bc5-52730e0977ab", "questionRevision": "d87873f00476a675355c0d1003937ca1c5dd63776cb7aef2514bcee438219deb" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/93217ce1-ac25-8646-844d-691ac36f066e", "questionRevision": "e04b8cbe556bdbfcb12668e038b306d6f8dd149691e3271a19b6cd067b9b4778" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/550e6cb5-3244-8637-8c46-cf3e3b87d90d", "questionRevision": "2ff1142b9b780ec5fac7e2c0e5d42d70b1f8c088483ab6417f9a61183c27c1e7" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/bc7f4015-108f-815f-8306-3879db255c46", "questionRevision": "f7643e1ce7977005ccc91b9955fccbad580786dfdbf508f6df6ec1a0aac83564" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/8dfb65bd-43d5-890e-8c6f-5660324a1c2d", "questionRevision": "225897b8528dd8abae5270af1ae52fae38b25021dd77d1e5096d9d6220491b8d" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/ce38f816-6f2b-82a3-85da-71291cc1b663", "questionRevision": "e942abd1e16fd00217ea4f0ad95b7cf2fdc5f71a0dcb1450f808836c44c20cb2" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/e4c5a6e4-ccb3-8618-8ca1-5a21473e5e9a", "questionRevision": "abe3b2e40cfc69dab05b8aa4ecd7780f0eae21702e3f6304f939110a628ba909" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/e635f41c-6cf7-8b5a-88da-5cb810fabbbd", "questionRevision": "4ac52038e6fcce47ee5d5a6c07f6c6dac14b6650eec20b95737e40345fd857b7" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/b37d44d4-dffe-8c01-89da-782d73ddc0e4", "questionRevision": "5ca2b714df2a77be617015e12e3c06aa038715c2b3a3443e8e927e0240389372" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/853cd153-a4e5-822d-845f-7388fec8bf51", "questionRevision": "6048747bea12d96980c6f396357795dd599f6369b189e5ab85d88d7be7054ab5" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/f4579ca9-e324-83ae-8386-4a957d3d2dd9", "questionRevision": "2672b6e3c63aedf8f2614053b15236569e58a2b30a7c052018cbc7edc3483ddb" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/77755e60-a101-8557-885d-89b49dc7135d", "questionRevision": "ab0d558c6b3b624ba5a9f0aa70887292dc4957d4f6006f7edb025d9a26385168" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/8a3d4bc2-4f51-8776-8c80-5232343cb2fc", "questionRevision": "f9136432eabb43d17619842547642436970754a7ddd9639917f0d267130ba6fe" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/06080c8b-359d-8769-840f-0ec7c544ca1f", "questionRevision": "34155f7a9039433c91fda1286e4d0a66e75317efab826e18e7b315360dc04a18" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/4c46e0bd-a4c7-8443-8f37-b4f4dbef6dd9", "questionRevision": "b2617bb2e2df796d894bcf8257a1305446d8653496774f23235c34848d73482a" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/cfbb85d3-b1c6-8623-8fca-1319a8106df5", "questionRevision": "b363087c5b5949aefc86fedfd78d23ab04105b4d03e7e4117821bd15196b2882" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/4d5a43ea-db99-884a-8b32-a8ef9f9298a8", "questionRevision": "a5b1756627734f5747f72e50c31dadbfe7bcbcae51985a940b2dbbeff35e83d1" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/c7073cfe-0889-80ec-8f01-95edf675eb13", "questionRevision": "761e603a18c66c9cb718cf53cd53011ab579f217ba02b6b2deff2c589f2ddcbd" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/0f5387e9-38dd-8f5c-8b2f-2b86e299ecae", "questionRevision": "b5052d4951b5a92247b313c92fc8a7080ea9276d63e65dd251df4c78817cdf03" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/6028c86b-b7f3-8f15-8644-09db8710cf82", "questionRevision": "3052a675a6bfbcad97d2be811caf3e75727622afb535d866161fadfc30146d81" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/49b793ec-f7e0-829a-8ecd-00a4f7e299cb", "questionRevision": "78601df63d4282cc97645e88678bf7a07bae02714abcc35160fc0ff05e821b0b" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/a29afbf6-ae00-816b-8b4b-af208eed9ca1", "questionRevision": "17edbf4bfc84baaa42a71de77485fc7768970d876cf2a46fbdef160acc51d554" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/59ad3058-fac7-8a86-838f-f534bb7a67a7", "questionRevision": "4d20aaa9175bf188046f1e66b7aff0ae93a8a2ddeba94129a3d87ee2ccb0817e" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/ed3d9c46-3755-81c7-87db-aa125643a41f", "questionRevision": "f30b1f5edb1e4fb09566bc2782b3e17de4da4107d1a7ca6f651a727f6c0f8417" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/ded1fb8f-fb2c-8e94-8ee6-fd693f30947b", "questionRevision": "bfa43fcc66bd12f5505e3cc626db9780130b27a19813f9ebe995d4d5fc0aaee1" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/4dc26f20-de2f-83e0-83a8-0d5cb89b3d2c", "questionRevision": "d1a9b267fc6d35447a1fee6d1e0730605c56b9a1a42929b4e89a30caa0861507" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/b8bcaf78-f6d2-818d-8750-e01166de5d07", "questionRevision": "8a3ecd79d7e1fc9a425626c40dadeefa762624aed6e71fab583f7f32d1ba0364" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/d1ce6457-225d-8c1b-8c20-97610b3ecbb4", "questionRevision": "5e2c03310b7d2d374fc460f148a613b672177578932e3f74f77de994e17453be" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/04026227-74c8-8edf-8d9d-9251fbbe1ecb", "questionRevision": "f30a54d9a8a8c6c66900e9b5ea2c5b3ea3cd28b7c3a46e0378dadf72361bf5e2" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/56cdfe4f-a271-818e-8291-44f4e93af25b", "questionRevision": "23ae27bc692788f8ec45b0a06510c9109c10d63192b86f50b0b1b9a80371aab3" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/5f0be21a-d825-8fe2-8c54-3ee595d5228e", "questionRevision": "e152afb841c8e8183e9f2bbe853b8178ea4e469a7d0c789060a71c13511dc56b" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/7c97e26e-d1c0-8237-8ffa-2c237eaee05f", "questionRevision": "bd3b435dd0edfa0c3d3a04b68028c36d14566756f7f8260674b866a780c450e8" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/a1f92a15-b79b-8959-8457-2e69f5b02a02", "questionRevision": "349ca8812313b2fa0c428367547a1a49ca80882684d86566571d5f1040d689e6" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/a5ecf644-8c79-8813-85b3-d2405796d64d", "questionRevision": "de1635b3ce08ce150da15580740baaa69bc54e312df9efbb0cd32e2006bbd502" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/746ae2d0-6705-8e91-8e11-5fff6ee05c38", "questionRevision": "7d58fc4be9b8712bba7c3f84124173c8ff47acc8336a193242615df37419f205" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/f82aa4ea-bda3-8ce3-81e9-1d23022a6094", "questionRevision": "e2a9fd598ed418c6d4272064f203c86dfa6fdf5f3f451da2911db9106a07e0d4" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/03313df0-cdc6-8320-8f8a-ef5d7ae7cbfa", "questionRevision": "bd659af11c0551880c695f925463dc2894901930de94b06e972539d88830163a" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/f6cbb24f-0ddc-8eee-8d57-73219607f81d", "questionRevision": "4e93c7480211e9c370013144e0401d2368b20ea3558297192a103c9a102c727d" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/300875a9-5513-810d-8579-9b06b89b2fc5", "questionRevision": "d33c0c30c69302b32425fb81ea557cf8ac41ad83c63b9d3a37162b5dc2856e82" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/98ed750b-a324-89f3-8282-bab3d0ce02b3", "questionRevision": "a279ee87b1fa238b8e572400ddc43c60322c23375a23e553b944106579800b7e" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/d7902fb1-50f8-81dd-8cc0-43f23c7a1a02", "questionRevision": "fcf54e69bf2473da8193ddd1bac139627ac40a04c756efaf38c135d818b6a138" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/81bee179-23e3-8be5-89b7-7f5a199173d1", "questionRevision": "e4595bdbda42390099f41a1677e8926554000e77a58efa1a3ad920c97f56a479" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/3b0fee76-93da-8c47-8448-d28b4ecbf268", "questionRevision": "6c07c441db1937a22fdc52c4d7cccb49ed6ee86f64b3d8fb90628d9dcba4125a" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/a079e0fc-25b5-8f29-8715-452e1bcc595f", "questionRevision": "938385b36a0a897e7edf513bff455cb10d34a64dbdd5ed2c591ceec5a741cec6" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/155dd2e0-c82e-8dbb-826b-9c7f419e38c7", "questionRevision": "b5f760194196c1169ace54f882de17a46772a153d6bff03c647423afb0ce18d1" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/691dbb32-a8a9-81b8-899e-7c6e8a6fd633", "questionRevision": "ab8417add5bf3b52f0f8a1050c06e6341ab416527ff6993739f540fbc4cf5612" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/e31b33e8-b290-8458-82eb-22cbe9ed268d", "questionRevision": "5103831b5b6e85aba48f17d4db86ca346758412fe2f1e31107401a43e0ee51ba" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/197cdcc6-2c62-881b-885f-5e866b35dacf", "questionRevision": "064bcc0cda16433c0a22360e66de03d6af3fb7ef8d1c163678d6e5132ad6d35e" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/778f53b1-d00a-8375-8d0d-072eaed66a0c", "questionRevision": "03eab1406029116346eb8b06434ff32bbaeefb23d051524219eeac54525a7c0f" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/dd525d7e-e83d-8d1c-8b07-62f6e6bd6e84", "questionRevision": "ed07bffa4b9862fbe343746dde4499103dd4d06aeef5fc7fba33583a12f73e22" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/f6cc8f3e-346a-8ec5-855e-58efa3662924", "questionRevision": "bbce81e84939d30fa380d46caa9e4591f1ab701a46c79821c787dc9c81829a27" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/f6b38b9b-6b4d-8e7b-8488-173f75848b49", "questionRevision": "8f17c801104a3b3de38b1a37478d4aa24d9e42d9dc782d6af241faf324c272ba" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/8b1ee787-6bc9-8f5a-8889-b265446a3e67", "questionRevision": "69b9c33ca09c9404c0e0efd1c8cc7ebf934ca7ade611447f7cac059ad730d59a" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/5e69994a-a2a1-86a3-8c4e-58ec1f3bf950", "questionRevision": "8643f9501899469b40f0dd86062036fe3383067b8bfd5631ad7f107e074e4b63" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/51cd833f-d379-89b3-8614-c03706825173", "questionRevision": "543e6e5b9fa125e8153401671df8a122c29e2a353947d9d9cade132c2c6ca9b2" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/e35e2f1b-82ec-8244-8f7c-2e46c284eb1a", "questionRevision": "274a91b13b373e59dcc56e50dc9cf6d0be92034af9406f3435edbd3395f9ab61" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/3ce935ea-c6bf-8200-80ae-41b208e5bb20", "questionRevision": "6141b0e752c8830e96b43619a91d9a5245548cdd5b1deedc1244164fb938b2e6" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/103d62e6-f3ac-8ef5-81ac-73ced8fca7ea", "questionRevision": "7dc964d4a5bdfd89164aa7a584a6c12001e3cc5944ba605e7e2a4f3954d20388" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/1b4182fe-51cf-83c4-84b2-ce8d3f80d63c", "questionRevision": "841befa8c1b547c81094c10922db19dd67ea0561aefb9ce7add3a3d731954abe" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/8567759e-9fea-87d1-8ce1-378fdc9cf7d2", "questionRevision": "8d4d6d41b93ab4a0c543e9962c11cf52c39647b88b9264f1eb12505771f169c6" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/2fb936fb-f790-8491-8fed-d7557efb3d5f", "questionRevision": "0ebd46c44740d5abf44192c8c2882aac652e1c8ae0e8b765979824270f5d3f50" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/bcd33198-bac8-890e-841f-7671312934e6", "questionRevision": "a0005a26b71317ad82c04ba32a3510197c7dd6f6bca40be37988ffb6874371a4" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/278c2a50-5bc7-8c62-8a7f-0cbc843dd7f0", "questionRevision": "a6f8d468fc21f1e41c173deada4f4dc96a9137c3d66721665c3f8d26f3eabb72" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/61c599f0-5e93-8078-809f-627ad99dd47e", "questionRevision": "99e5e4e66c3e123dba6075a4420963d243597d2f686dd865b8854facf4161984" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/b710535b-87f8-81ee-83ce-f9d3460c40c8", "questionRevision": "a73ba39a55e6e9de544bd2cb4838308f83b7295b1bd72cf220f644c059c19e15" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/3fb753ba-f74c-8467-8083-11b0372e2bc5", "questionRevision": "b336481b0cd6e7d3c1986afe839dbe800feb25299849d6c1f889aee73488f045" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/57ba7cda-ea63-8a83-8cca-5770367d6243", "questionRevision": "4b2547a67519027af496d39bcdc03b02d0499d6837ad1416c301217e5ea55f87" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/58f89bd2-0d79-85e3-8f0f-5eb5be4902b2", "questionRevision": "06c37faf983a6d9fb78c9fe5194651bf484db661284a451117b3598adce608c8" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/2a813f16-f9c6-886e-89b5-89f36742ea1a", "questionRevision": "8db3cde236d3b3977675280144a4b56372af08887baba9ff1a5f016eaae5f4be" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/7e0565be-80e4-84f3-82ff-660366d61966", "questionRevision": "51bbb63dda86dfd6966d1b2b29b7f38f3c4a0a628b2a7557185e6c2cc30c9ec5" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/98527158-9afc-8edb-8544-47693c7483ef", "questionRevision": "bb9d77cb155202a63707d7958dbaffb8f3be519a6c907c36558da6bc305cbead" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/d5090aad-d018-8c19-8e90-cd7ff9aeac97", "questionRevision": "1fc382b93a083af03decd4007fb72bcb72a9716e957a549d3d2d587ab7fe63eb" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/4febc6a2-ef6e-8608-8496-e14153bcd0cc", "questionRevision": "232333913869d8b0ae2936bd9a8608f87a2a32009ebc8734536831f4af365a43" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/db24927e-7607-8e1f-87e9-674b3bddfb85", "questionRevision": "fd0be45b960060f22872b0acdca7d7bc684601a624fddf179e519220a413501f" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/041bac48-015c-8f02-8475-a06531a8dad3", "questionRevision": "0e0791bde38dba994ec4042b624558ed551b6be031c43127aa6b5bd6cf347845" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/193c2c31-16cf-8248-8de6-330d44df41fc", "questionRevision": "495af34e99497c7160369efc9c3a35210ff840d7b2e1cb2c28240a9e2ea39891" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/2d7e89a0-35fd-8412-8438-7b3fc83a99d7", "questionRevision": "ffab7303c83c5aeb2fa336f1ab4ea588df261a34ebc60226a6ef825c7ee9884e" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/3145b192-f0cc-8b71-84b5-f93d07f3ed99", "questionRevision": "97f03d40b0afc338c0d781fd6db54b786f00aed6d2556ce7b2f836b81f35064c" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/5a2daf71-5dc2-81b7-80cc-3b3b556a78cb", "questionRevision": "23cb1a9e7001e1dfd1692afcbf5adafbb8acae668756d949e18733cb0c18780b" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/09afd22d-9729-81ce-8825-2b977298d630", "questionRevision": "1e6b5c5164b8f34b633a9d181b180bbdb9f8d1f56c3b420bb06974ef155dd9d8" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/3cf46592-72dd-8995-8611-e46a3656287c", "questionRevision": "fd4413a21ea73b915066216876ef16256957d930098137d16ca8a8d7e3b78698" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/ee6274ea-0c81-8cfc-8bf8-9131994b60ed", "questionRevision": "55a2a0bd74586ba9b420a50aa28d05721fa8c4beb848050c4f512029d556fbed" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/5ccc5d0c-2a71-8814-8874-9b3860ce3919", "questionRevision": "eef8e26f29f5ba0a726a533fd61558eb58bfd81c4b489e2a0623b2af6113fcf7" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/e4be7ae4-0d8e-8638-893d-f41d76235f4c", "questionRevision": "37a23239d76020a4f7d735fa1d8f31937c78d3d6034b5678dd9abe49ea3f5012" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/fab18e41-08f1-8f04-85da-cb9a528e1931", "questionRevision": "c53db81475e2d7372a92e04963567cdf89079ba230f2bc0cd3e44edd6962f606" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/7725665f-9b48-8138-80d3-89ac97d031c6", "questionRevision": "b313718074bd3b2c0009bdd9872ac88919585e604ca12dadeef06fe6d4e3a364" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/3a01cbc1-b348-8c21-8d4c-6d5798c68e41", "questionRevision": "d3a1f49cbeceee88a90d76f0ca7105afd9c5ed9c47c52ce7c172a14e01f9edab" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/c4d5c5c8-eb93-892f-8434-f0d016299ee3", "questionRevision": "7fb40d73aa9957dfc64d61fa1f2891c37648c0182400684d82322f57685e3629" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/163f7318-514f-824c-8ef6-f9ef9466fdb0", "questionRevision": "39aa8ec766dd7303a17e314f654146aa268a9f279b155cba478798896a03c8d4" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/8edfc347-252f-8e2a-84a3-18c879f35921", "questionRevision": "bd3b2495603b22b95befac0a107b8ccc9d6c69dd1c1a50e77d2d2a655547e581" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/c89aa536-3263-845f-8f63-e110087725c2", "questionRevision": "9074e6882631f7236e7e15747092b530fe643d52b2252d71279f85c31a94348e" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/a005dd9e-4d63-826b-8175-78d3a3d9cf11", "questionRevision": "09201b803c6827f8c7ceaa7625a19e4c73441cc7fd1b5a16b0e5a879ef4bbe76" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/22f9f945-9991-8869-81c2-045834305a09", "questionRevision": "eb121fb2932d300ac34f3d1ac72e73c5b74d1670cb7480fca69302a1b0645eb1" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/0df81e73-e550-8e65-8d8e-1dc4eabaf880", "questionRevision": "9b8d7c9a970b99de50ded7553ccadc9b8ef4c6f5003cd6e1851a8e12a1a34c70" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/f93e8ab9-7b1d-8789-8690-906633b07c3b", "questionRevision": "e37f126a7d45973a0d4324fd3427bff2b5169bf0c35f12a7177971f2ecbf96c7" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/d6b502c3-ef72-8e0a-8bea-1e1da72baab2", "questionRevision": "4781b13f212d4b89fa27af4a7468fe4e9acd1baeba32952d66335d5088e2c22b" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/bc8a02a3-85be-8a2d-85dd-7bad430bf2b9", "questionRevision": "bfa22368f28081f4d9d93e73517ebd3894179c4ea74a126f0b3c57fd5ce5f352" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/0f7449ed-fd54-853b-84ed-4a3e6e57f7d8", "questionRevision": "6ce1b9b30aaa4243d5d593fa3e4a9ed5a8143ad11d14b83f62b8f6792d9148b1" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/e29b1086-6141-80e0-85c3-1b12ac98247f", "questionRevision": "5d85a215d486d76c6496e700bf3cbdeb701ebdc76a23e6b669aa4ca2eb8d8ee7" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/24672668-5894-833d-891e-f91d9c4ab0c0", "questionRevision": "715921b8b211ba3a7b2a1f9b55a3ce8253110f58b942231f07e19f165b6f7b03" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/dae7a13e-ff29-8d20-81f2-e214519d6f64", "questionRevision": "8f65f891ccd3de8033b209277b3547698bf82ef9d97247f155d8992659f2a851" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/f22bb335-a0bc-8a79-80ed-3a9f37d633db", "questionRevision": "83ddc651553ff718b60548c8c7ee9c9aecdc6652a86c532055e63b55fbf63c96" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/33217569-d2dd-8730-862b-86ba78837386", "questionRevision": "ff5afc0077e25962a58aabb9229d1202a48a01f97d7df81e6d6559b50376a90e" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/4313f317-23a3-88e2-8881-6edf8d691146", "questionRevision": "ced8eb5e4e6d475a66ce074762a46b557cbed131265147193b1172048fd39163" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/67a3a28c-b039-874a-873d-501c1f4b188d", "questionRevision": "041f01af62d042ef9f5db9289445042956f6a0077fac58e4624d5528c8e22d7d" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/8d5c2c5d-374b-88dc-8849-0fc00e1a1f1e", "questionRevision": "a1e56a0abc684f88f366fb2cfd3f54f65525b5c7f3a753437852ccc2ba715b43" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/dca588a9-1e93-8e43-8cd1-75960d82ae0b", "questionRevision": "bc716f20a3b7b3819fd14e1107031b50956e2bf1274900d3c452cd9f246ef34c" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/7e0e4754-69a7-8899-82e6-b78f79fde669", "questionRevision": "06ac46ffe9f3b0cfa51a45d3a182c78d53c77997e2b9519b0438a646d9ba4bc5" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/883f7b30-8e80-86b0-8f12-9f754a33fe49", "questionRevision": "5225d54482a11d2d4ff92505646b29e6415d904007af3a901e2d50f1a1e760cb" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/088ed3a6-5de2-8222-8f98-e94d592d2bbc", "questionRevision": "6c337d321fa1cdcf8a03d9e39188a32eb6fa8430a3bb6a46760558cdbab208bd" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/8ed3b5c0-f653-8b39-8d98-5a841f9dd2cb", "questionRevision": "cd9f901ea30bad89726124410cfda76bec1163dfa226a33b1580fe4e6783dacb" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/e776574a-baba-83d9-880e-4f0b1f6c9076", "questionRevision": "8f11b655ccbf1f5e45933841f9b9d1842860e9785f0bae24f5133589dba076ab" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/8b0d2eb5-2fbf-8966-8e80-5c56281fadf2", "questionRevision": "e58b9676e261457b78257f5a0a16ab422ee93bff36a4429a0464297bfdb88d75" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/786cd382-ac95-8f6b-86e7-e3accdf2986f", "questionRevision": "aff93e2d11ec474c382495c2308abf62202eefd933db6889890de6ff743891f3" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/26cd9eb2-2a8c-8e52-8329-26153108bd42", "questionRevision": "1ee46102b80b584d7abf109b1a3251d7cf75e17c28faf2cbeae7767d370ec8bc" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/f207c550-e0a4-85cf-8142-6b023ad4f91d", "questionRevision": "f8086d4f9b59792a340ae3f3fa3d45c8d6544e77332fcfd74b361704f189ca48" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/fd267321-8f47-8f5d-8914-2adafdc850b9", "questionRevision": "920f21ca66962573009eda969c7a595a0016400f3b42d473fdaccf2e95b2dc18" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/600bcd5f-74e3-848f-8dbf-46bc66941e01", "questionRevision": "bc4c15ebb56e90dbcf32592984722e93ad6c964575cb453cccd8dd14848c783a" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/c61d332a-9f6d-8b69-814a-9d1a1346d75b", "questionRevision": "8ce976a544fbf93b9dd63af78f2ecd5f6fa6f4e2c713715fe3d4b0f4a03fedcb" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/e4df1845-f6cd-8e1b-805b-a1d46db20630", "questionRevision": "59f7cbf7c61515b954ac630db162ceb1cb5a51928949c7531dbf0df9a86fb7d4" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/8712a30b-68ae-86c9-8414-3724ec795d9b", "questionRevision": "b1b4535438edf30b059472f46d7d395dd8acecbae71f71542654bcbb40e9e62a" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/89a71bf9-9675-8a8e-8e3f-ef484aaafdab", "questionRevision": "c100789db420cbdfedb4993d3f98f5b483afd662e76736da7351b8fa12f6cb72" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/049cdab8-4475-86c7-8261-2d45cf5de76e", "questionRevision": "9f2ee6b0a8287ecc81b0a44fc1a369a43e174652b038fd24c367b741fcb1ab31" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/6595d877-cc3b-8579-8868-045caa748cb1", "questionRevision": "58a108a8c324f9b6425c0061b077bb8eb92068d192fb4f34fe2065d153b9349a" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/b4c77e8f-9efb-86e0-8e0a-adc35a8a94f8", "questionRevision": "af63474caf37b81cf1320d4fe71e411ca80cc96cbf61d51bfc612e1810c082ce" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/0b44cdfe-e607-8b8d-8f80-cb018adeaa6c", "questionRevision": "9ce208c91564d1f7f2f562cf442aaf9e01afe02baeac85781a7671ee7850fd66" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/b9b8181b-9092-86ee-853e-1cebc6abb1a9", "questionRevision": "5a8a099c04b6f3063237de28c56852885db5297feac1c5983fadf68de4ea5cbb" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/0a1d438d-0b68-8c59-84ee-9253c90963a7", "questionRevision": "ab9d864e31e11cd2532ff120345cb4854404d9be614d10113d8a32ca97739a0b" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/94c4b3a1-4f53-8272-82af-e69528cc4e14", "questionRevision": "0ad2a3951b609ad0d42d258e446ad3fa3a6b40b35c6c3ca853cf0f7ce96e8987" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/97465228-1dab-81ec-87ea-fdfcba4e8833", "questionRevision": "7006fcf2594934e3a8a3fb5b8ba33a98a9c59ed3bd00ac41be1b6e54d758f547" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/d28e5e9b-eba1-8fc4-88df-7dc1e46ef57a", "questionRevision": "b923296ec01080817c647f9598f5c74a3c67e354a414f85b7408dde772ee821a" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/ec78ee13-6ca7-8f2c-8be6-7d5d96b8a803", "questionRevision": "2096983daf3e5c78a92db32cd6d61b40ad179415ae1f32a14cb399f5ab4fc8de" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/e605267c-1ac1-8697-8d9b-4feb5faffcee", "questionRevision": "dc24dd653e9966109bedc09d3300dfc236d7ad6bcf78a5bd110d1a9e98afa361" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/90e4029e-f971-8cf4-8789-97148bcf45ee", "questionRevision": "9ae5cd8403db5be23f44a8371650e25ed16ab65572718f2c9cff803a1853446f" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/5e70d590-aca8-8331-8349-eaa5852480ca", "questionRevision": "ba1c9d406b59f573398cd1bac0e10dc61a19082776536796ff8ad673fd33975d" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/e8a6df33-ce0e-8f3e-8497-59507d9f3f43", "questionRevision": "be8b74edf4c9a898e9f22b42ea6029a42778b64ee4f7d3dc01e455a2a14fc833" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/ca8938f5-9824-8abd-848f-335b149f21b9", "questionRevision": "5e5d7d6b4c5f7d81e06f58e2d48d811c542a35d6bdb529366efb3fe0b9c682cb" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/f2492908-6e48-823e-8ff5-b8f219d5eba2", "questionRevision": "57a938f0b90cd439e03cec2967fd77fa1d7df04f51367e56d14eca7f15b04dde" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/eddab859-b4d3-8726-827a-70ff5cc93e1e", "questionRevision": "b8ea5c3e26a28ee16217d33b057bc871992a8a6caa19f009947d627469001758" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/f99ccec0-e508-80ee-8161-48d822e59966", "questionRevision": "96afdbf7a2f804dde195233198f665aefd7e564ad575f034b4bcba9b39cc16dd" }, { "questionKey": "8d2f947f-cffb-804b-8a3a-c757c6369bc6/cde5b5e8-64fd-8e2f-8f68-ff7b653e6799", "questionRevision": "5437f5f2b691a52190fa2a6fcd6a812582c69dd50cfe8bfc0d7d6aeff0c62673" }] };

// do-worker/src/reviewed-report-public-registry.generated.js
var reviewedReportPublicRegistry = [];
var reviewedReportPublicRegistrySnapshots = [];

// src/domain/question/frozen-public-registry.js
var prior = JSON.parse(publicRegistryJson);
var pins = [
  ["prior8", "5762cc637b3ffabb034e5950ec994c72f17b2732ae90fd5b5370089a7ef22176", prior],
  ["new9", "ea2bb666a4aad50eb54f0b5829e7d15c1306eab88be9e3ce29d00457f7f82aa4", [...prior, ...historicalPublicRegistry]],
  ["final10", "333327636c7a559bbaaa186cfa2a6f86d81e68bab547d73a9496bb68f1777469", [...prior, ...historicalPublicRegistry, secondHistoricalPublicRegistry]]
];
var projection = (banks) => banks.map((bank) => ({ key: `${bank.bankUid}:${bank.revision}`, record: { bankUid: bank.bankUid, revision: bank.revision, metadata: bank.metadata, contentManifest: bank.contentManifest }, reference: bank.publicContentReference })).sort((a, b) => a.key.localeCompare(b.key));
var hash = (value) => Array.from(sha256(canonicalBytes(value)), (b) => b.toString(16).padStart(2, "0")).join("");
var baselineSnapshots = pins.map(([version, digest11, banks], index) => {
  const actual = hash(projection(banks));
  if (banks.length !== 8 + index || actual !== digest11) throw new Error("FROZEN_PUBLIC_REGISTRY_PIN_MISMATCH");
  return Object.freeze({ version, digest: digest11, banks });
});
var approvedBanks = [...baselineSnapshots[2].banks, ...reviewedReportPublicRegistry];
var byKey = /* @__PURE__ */ new Map();
for (const bank of approvedBanks) {
  const key2 = `${bank.bankUid}:${bank.revision}`;
  if (byKey.has(key2) && hash(byKey.get(key2)) !== hash(bank)) throw new Error("FROZEN_PUBLIC_REGISTRY_CONFLICT");
  byKey.set(key2, bank);
}
var versions = new Set(pins.map((row) => row[0]));
var digests = new Set(pins.map((row) => row[1]));
var extensions = reviewedReportPublicRegistrySnapshots.map((snapshot) => {
  const { version, digest: digest11, banks } = snapshot;
  if (Object.keys(snapshot).sort().join() !== "banks,digest,version" || typeof version !== "string" || !version || versions.has(version) || digests.has(digest11) || !Array.isArray(banks) || banks.length < 11 || hash(projection(banks)) !== digest11) throw new Error("FROZEN_REPORT_PROJECTION_INVALID");
  const keys = /* @__PURE__ */ new Set();
  for (const bank of banks) {
    const key2 = `${bank.bankUid}:${bank.revision}`;
    if (keys.has(key2) || !byKey.has(key2) || hash(bank) !== hash(byKey.get(key2))) throw new Error("FROZEN_REPORT_MEMBER_INVALID");
    keys.add(key2);
  }
  for (const bank of baselineSnapshots[2].banks) if (!keys.has(`${bank.bankUid}:${bank.revision}`)) throw new Error("FROZEN_REPORT_BASE_MISSING");
  versions.add(version);
  digests.add(digest11);
  return Object.freeze({ version, digest: digest11, banks });
});
var frozenPublicRegistrySnapshots = Object.freeze([...baselineSnapshots, ...extensions]);
var frozenPublicBanks = Object.freeze([...byKey.values()]);

// src/storage/history/immutable-bank-resolver.js
var fail15 = (code) => Object.assign(new Error(code), { code, name: "ImmutableBankResolutionError" });
var same2 = (a, b) => {
  if (a === void 0 || b === void 0) return a === b;
  const left = canonicalBytes(a), right = canonicalBytes(b);
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
};
async function resolveImmutableBank({ bankUid, bankRevision, readBankRevision, sourceChanges, readContent }) {
  if (typeof bankUid !== "string" || typeof bankRevision !== "string" || typeof readBankRevision !== "function" || typeof sourceChanges !== "function" || typeof readContent !== "function") throw fail15("HISTORY_BANK_RESOLVER_INPUT");
  const current = await readBankRevision(bankUid, bankRevision);
  let record = null;
  if (current) {
    validateBankRevisionRecord(current);
    if (current.bankUid !== bankUid || current.revision !== bankRevision) throw fail15("HISTORY_BANK_BINDING");
    record = current;
  }
  const inputSources = await sourceChanges(bankUid, bankRevision);
  if (!Array.isArray(inputSources)) throw fail15("HISTORY_BANK_SOURCE_BUDGET");
  const filteredSources = inputSources.filter((raw) => {
    if (!raw || typeof raw !== "object") return false;
    const change = raw.provenance?.format === "qb-sync-change-v1" ? raw.provenance.change : raw;
    if (change?.kind === "bank_revision") return change.payload?.bankUid === bankUid && change.payload?.revision === bankRevision;
    if (change?.kind === "content_manifest") return change.payload?.reference?.contentDigest === bankRevision;
    return false;
  });
  const exactSources = /* @__PURE__ */ new Map();
  for (const raw of filteredSources) {
    let key2;
    try {
      key2 = canonicalBytes(raw).toString();
    } catch {
      throw fail15("HISTORY_BANK_SOURCE_INVALID");
    }
    if (!exactSources.has(key2)) exactSources.set(key2, raw);
  }
  const rawSources = [...exactSources.values()];
  let sourceRecord = null;
  const sourceSeen = /* @__PURE__ */ new Set();
  for (const raw of rawSources) {
    const candidate = await verifiedBankChange(raw);
    if (!candidate || candidate.bankUid !== bankUid || candidate.revision !== bankRevision) continue;
    if (sourceRecord && !same2(sourceRecord, candidate)) throw fail15("HISTORY_BANK_SOURCE_CONFLICT");
    sourceRecord = candidate;
    sourceSeen.add(new TextDecoder().decode(canonicalBytes(candidate)));
  }
  if (sourceSeen.size > 1) throw fail15("HISTORY_BANK_SOURCE_CONFLICT");
  if (!record && !sourceRecord) throw fail15("HISTORY_BANK_SOURCE_MISSING");
  if (record && sourceRecord && !same2(record, sourceRecord)) throw fail15("HISTORY_BANK_SOURCE_CONFLICT");
  record ||= sourceRecord;
  const references = [];
  if (record.contentManifest.kind === "private_chunks" || record.contentManifest.kind === "protected_cipher") {
    references.push(record.contentManifest.reference);
  } else if (record.contentManifest.kind === "public_static") {
    const contentSeen = /* @__PURE__ */ new Set();
    for (const raw of rawSources) {
      const contentReference = await verifiedContentChange(raw);
      if (contentReference?.contentDigest === record.contentManifest.contentDigest) {
        references.push(contentReference);
        contentSeen.add(new TextDecoder().decode(canonicalBytes(contentReference)));
      }
    }
    if (contentSeen.size > 1) throw fail15("HISTORY_BANK_SOURCE_CONFLICT");
    const known = frozenPublicBanks.find((bank) => bank.bankUid === bankUid && bank.revision === bankRevision && same2(bank.metadata, record.metadata) && same2(bank.contentManifest, record.contentManifest));
    if (!references.length && known) references.push(structuredClone(validateContentReference(known.publicContentReference)));
    else if (known && references.some((reference2) => !same2(reference2, known.publicContentReference))) throw fail15("HISTORY_BANK_SOURCE_CONFLICT");
  }
  const uniqueReferences = [...new Map(references.map((reference2) => [reference2.manifestDigest, reference2])).values()];
  if (record.contentManifest.kind === "unavailable" || uniqueReferences.length !== 1) throw fail15("HISTORY_BANK_CONTENT_REFERENCE");
  const reference = uniqueReferences[0];
  if (reference.contentDigest !== bankRevision) throw fail15("HISTORY_BANK_BINDING");
  const loaded = await readContent(reference);
  const content = loaded && typeof loaded === "object" && Object.hasOwn(loaded, "value") ? loaded.value : loaded;
  let questionRefs, proofClass;
  if (record.contentManifest.kind === "protected_cipher") {
    const protectedBody = await validateProtectedBankEnvelopeV2(content);
    if (protectedBody.envelope.bankUid !== bankUid || protectedBody.contentDigest !== bankRevision || !same2(protectedBody.questionRefs, loaded?.questionRefs ?? protectedBody.questionRefs)) throw fail15("HISTORY_BANK_BINDING");
    questionRefs = protectedBody.questionRefs;
    proofClass = protectedBody.proofClass;
  } else {
    const verified = await validateBankContent(content);
    if (verified.content.bankUid !== bankUid || verified.contentDigest !== bankRevision || !same2(verified.content.metadata, record.metadata)) throw fail15("HISTORY_BANK_BINDING");
    questionRefs = verified.questionRefs;
    proofClass = "registered-content-verified";
  }
  return Object.freeze({ record, content, questionRefs, reference, proofClass });
}
async function verifiedBankChange(raw) {
  if (!raw || typeof raw !== "object") return null;
  let change = null;
  if (raw.provenance?.format === "qb-sync-change-v1") {
    change = (await validateSyncChangeReceipt(raw)).provenance.change;
  } else if (raw.kind === "bank_revision" && raw.mutationId) {
    validateMutationRecord(raw);
    if (!await verifyMutationDigest({
      protocolVersion: raw.protocolVersion,
      mutationId: raw.mutationId,
      clientStreamId: raw.clientStreamId,
      clientSeq: raw.clientSeq,
      kind: raw.kind,
      entityKey: raw.entityKey,
      payload: raw.payload,
      payloadDigest: raw.payloadDigest
    })) throw fail15("HISTORY_BANK_SOURCE_DIGEST");
    change = raw;
  } else if (raw.kind === "bank_revision" && raw.payloadDigest && raw.payload) {
    validateChangeLogRecord(raw);
    change = raw;
  }
  if (!change || change.kind !== "bank_revision") return null;
  const payload = change.payload;
  validateBankRevisionRecord({ bankUid: payload.bankUid, revision: payload.revision, metadata: payload.metadata, contentManifest: payload.contentManifest });
  return { bankUid: payload.bankUid, revision: payload.revision, metadata: payload.metadata, contentManifest: payload.contentManifest };
}
async function verifiedContentChange(raw) {
  if (!raw || typeof raw !== "object") return null;
  let change = null;
  if (raw.provenance?.format === "qb-sync-change-v1") change = (await validateSyncChangeReceipt(raw)).provenance.change;
  else if (raw.kind === "content_manifest" && raw.mutationId) {
    validateMutationRecord(raw);
    if (!await verifyMutationDigest({
      protocolVersion: raw.protocolVersion,
      mutationId: raw.mutationId,
      clientStreamId: raw.clientStreamId,
      clientSeq: raw.clientSeq,
      kind: raw.kind,
      entityKey: raw.entityKey,
      payload: raw.payload,
      payloadDigest: raw.payloadDigest
    })) throw fail15("HISTORY_BANK_SOURCE_DIGEST");
    change = raw;
  } else if (raw.kind === "content_manifest" && raw.payloadDigest && raw.payload) {
    validateChangeLogRecord(raw);
    change = raw;
  }
  return change?.kind === "content_manifest" ? change.payload.reference : null;
}

// src/storage/history/snapshot-baseline-proof.js
var same3 = (a, b) => new TextDecoder().decode(canonicalBytes(a)) === new TextDecoder().decode(canonicalBytes(b));
var fail16 = () => {
  throw Object.assign(new Error("SNAPSHOT_BASELINE_DEPENDENCY"), { code: "SNAPSHOT_BASELINE_DEPENDENCY" });
};
function createSnapshotBaselineReader({ owner, references, readSnapshotRecord, readContent, readBankRevision, readTombstone }) {
  return (baseline) => validateSnapshotContinuationBaseline(baseline, {
    owner,
    isTombstoned: async (kind, id) => !!await readTombstone(`${kind}:${id}`),
    readSnapshot: async (id) => {
      const record = await readSnapshotRecord(id), sources = references.filter((row) => row.kind === "history_snapshot" && row.payload.snapshotId === id);
      if (!record || !sources.length || sources.some((row) => !same3(row.payload, record))) fail16();
      const loaded = await readContent(record.reference);
      const body = loaded !== null && typeof loaded === "object" && "value" in loaded ? loaded.value : loaded;
      return { record, body };
    },
    resolveQuestion: async (ref) => {
      const bankUid = ref.questionKey.split("/")[0];
      if (bankUid === void 0) fail16();
      const bank = await resolveImmutableBank({ bankUid, bankRevision: ref.bankRevision, readBankRevision, sourceChanges: async () => references, readContent });
      const content = (
        /** @type {import('../../domain/question/bank-content.js').RegisteredBankContent} */
        bank.content
      );
      return content.questions?.find((q) => q.questionKey === ref.questionKey && q.questionRevision === ref.questionRevision);
    }
  });
}

// src/storage/sync/resume-proof.js
var equal = (a, b) => new TextDecoder().decode(canonicalBytes(a)) === new TextDecoder().decode(canonicalBytes(b));
var before = (a, b) => a.length < b.length || a.length === b.length && a <= b;
var withinCut = (left, right) => "serverSeq" in right ? "serverSeq" in left && before(left.serverSeq, right.serverSeq) : !("serverSeq" in left) && left.clientStreamId === right.clientStreamId && left.clientSeq <= right.clientSeq;
async function loadHistoricalResumeProof({ references: inputRefs, attempts: inputAttempts, events: inputEvents, contentDigest, readResumeContent, readSnapshotBaseline }) {
  canonicalContentBytes(inputRefs);
  canonicalContentBytes(inputAttempts);
  canonicalContentBytes(inputEvents);
  canonicalBytes(contentDigest);
  const references = structuredClone(inputRefs), attempts = structuredClone(inputAttempts), events = structuredClone(inputEvents);
  if (!/^[0-9a-f]{64}$/.test(contentDigest) || typeof readResumeContent !== "function") throw syncError("INVALID_INPUT");
  for (const ref of references) Object.hasOwn(ref, "serverSeq") ? validateChangeLogRecord(ref) : validateMutationRecord(ref);
  events.forEach(validateAnswerEvent);
  for (const ref of references) {
    if (Object.hasOwn(ref, "serverSeq")) {
      if (await sha256Hex(canonicalBytes({ protocolVersion: 2, kind: ref.kind, entityKey: ref.entityKey, payload: ref.payload })) !== ref.payloadDigest) throw syncError("SYNC_CHANGE_DIGEST");
    } else if (!await verifyMutationDigest(mutationWire(ref))) throw syncError("CORRUPT_MUTATION");
  }
  const bundles = /* @__PURE__ */ new Map(), visiting = /* @__PURE__ */ new Set(), snapshotProofs = [];
  function selectEvents(ref) {
    const selected = [];
    for (const eventRef of references.filter((row) => row.kind === "answer_event" && row.payload.event.attemptId === ref.payload.attemptId && row.payload.event.writerStreamId === ref.payload.writerStreamId)) {
      const within = "serverSeq" in ref ? Object.hasOwn(eventRef, "serverSeq") && before(eventRef.serverSeq, ref.serverSeq) : eventRef.clientStreamId === ref.clientStreamId && eventRef.clientSeq <= ref.clientSeq;
      if (!within) continue;
      const event = events.find((row) => row.eventId === eventRef.payload.event.eventId);
      if (!event || !equal(event, eventRef.payload.event)) throw syncError("MISSING_RESUME_DEPENDENCY");
      if (!selected.some((row) => row.eventId === event.eventId)) selected.push(event);
    }
    selected.sort((a, b) => a.actionSeq - b.actionSeq);
    return selected;
  }
  async function load(digest11, depth) {
    if (depth > 32 || bundles.size > 32) throw syncError("RESUME_DEPENDENCY_LIMIT");
    if (visiting.has(digest11)) throw syncError("RESUME_DEPENDENCY_CYCLE");
    if (bundles.has(digest11)) return bundles.get(digest11);
    const ref = references.find((row) => row.kind === "resume_state" && row.payload.contentDigest === digest11);
    if (!ref) throw syncError("MISSING_RESUME_DEPENDENCY");
    const p = ref.payload, attempt = attempts.find((row) => row.attemptId === p.attemptId);
    if (!attempt || attempt.writerStreamId !== p.writerStreamId) throw syncError("MISSING_RESUME_DEPENDENCY");
    visiting.add(digest11);
    const loaded = await readResumeContent(structuredClone(p));
    if (loaded.reference.contentDigest !== digest11 || loaded.reference.manifestDigest !== p.chunkManifestDigest) throw syncError("CORRUPT_CONTENT");
    const selected = selectEvents(ref);
    const bundle = { state: loaded.value, reference: structuredClone(p), manifest: loaded.manifest, events: selected, expectedAttempt: { attemptId: attempt.attemptId, writerStreamId: attempt.writerStreamId, scopeDigest: attempt.scopeDigest, scopeCount: attempt.scopeCount, ...attempt.parentAttemptId ? { parentAttemptId: attempt.parentAttemptId } : {} } };
    bundles.set(digest11, bundle);
    if (bundle.state.localRevision > 1) {
      const initial = references.find((row) => row.kind === "resume_state" && row.payload.attemptId === p.attemptId && row.payload.writerStreamId === p.writerStreamId && row.payload.localRevision === 1 && withinCut(row, ref));
      if (initial) {
        const original = await readResumeContent(structuredClone(initial.payload));
        if (await sha256Hex(canonicalContentBytes(original.value)) !== initial.payload.contentDigest) throw syncError("CORRUPT_CONTENT");
        if (original.value.snapshotBaseline && !bundle.state.snapshotBaseline) throw syncError("SNAPSHOT_BASELINE_IMMUTABLE");
      }
    }
    if (bundle.state.snapshotBaseline) {
      if (typeof readSnapshotBaseline !== "function") throw syncError("MISSING_SNAPSHOT_BASELINE_DEPENDENCY");
      const snapshotProof = await readSnapshotBaseline(bundle.state.snapshotBaseline);
      snapshotProofs.push(snapshotProof);
      if (bundle.state.localRevision > 1) {
        const initial = references.find((row) => row.kind === "resume_state" && row.payload.attemptId === p.attemptId && row.payload.writerStreamId === p.writerStreamId && row.payload.localRevision === 1 && withinCut(row, ref));
        if (!initial) throw syncError("MISSING_SNAPSHOT_INITIAL_RESUME");
        const original = await readResumeContent(structuredClone(initial.payload));
        if (!original.value.snapshotBaseline || !equal(original.value.snapshotBaseline, bundle.state.snapshotBaseline)) throw syncError("SNAPSHOT_BASELINE_IMMUTABLE");
        if (!equal(original.reference, { contentDigest: initial.payload.contentDigest, manifestDigest: initial.payload.chunkManifestDigest, chunkCount: original.manifest.chunkCount, totalBytes: original.manifest.totalBytes })) throw syncError("CORRUPT_CONTENT");
        const initialized = await validateResumeDependencies(original.value, initial.payload, original.manifest, selectEvents(initial), bundle.expectedAttempt, { parents: [], snapshotProofs: [snapshotProof] });
        if (initialized.status !== "payload_verified") throw syncError("MISSING_SNAPSHOT_INITIAL_RESUME");
      }
    }
    for (const draft of bundle.state.questionDrafts) if (draft.inheritedFrom) await load(draft.inheritedFrom.resumeContentDigest, depth + 1);
    visiting.delete(digest11);
    return bundle;
  }
  const root = await load(contentDigest, 0), parents = [...bundles.entries()].filter(([digest11]) => digest11 !== contentDigest).map(([, bundle]) => bundle);
  const validation = await validateResumeDependencies(root.state, root.reference, root.manifest, root.events, root.expectedAttempt, { parents, snapshotProofs });
  if (validation.status !== "payload_verified") throw syncError("MISSING_RESUME_DEPENDENCY");
  return { root, parents, snapshotProofs, validation };
}

// src/storage/sync/fork-origin.js
function validateForkOriginReceipt(value) {
  canonicalBytes(value);
  validateImportReceiptRecord(value);
  const p = value.provenance;
  if (!p || Object.keys(p).sort().join() !== "childAttemptId,commandId,format,parentAttemptId,parentResumeContentDigest" || p.format !== "qb-fork-origin-v1" || value.sourceId !== p.format || value.sourceRecordId !== p.commandId || ![p.parentAttemptId, p.childAttemptId, p.commandId].every(isUuid) || p.parentAttemptId === p.childAttemptId || typeof p.parentResumeContentDigest !== "string" || !/^[0-9a-f]{64}$/.test(p.parentResumeContentDigest)) throw syncError("FORK_ORIGIN_CORRUPT");
  return structuredClone(value);
}
function assertForkOriginProof(origin, manifest, child, parent) {
  const cs = child.root.state, ps = parent.root.state;
  if (ps.attemptId !== origin.parentAttemptId || cs.attemptId !== origin.childAttemptId || manifest.attemptId !== origin.childAttemptId || manifest.parentAttemptId !== origin.parentAttemptId || manifest.writerStreamId !== cs.writerStreamId || manifest.scopeDigest !== cs.scopeDigest || manifest.scopeCount !== cs.scope.length) throw syncError("FORK_ORIGIN_CORRUPT");
  const projection2 = (state) => state.scope.map(({ attemptId, ...row }) => row);
  const same5 = (a, b) => new TextDecoder().decode(canonicalContentBytes(a)) === new TextDecoder().decode(canonicalContentBytes(b));
  const expected = ps.questionDrafts.map((row) => ({ ...row, localRevision: 1, inheritedFrom: { attemptId: origin.parentAttemptId, resumeContentDigest: origin.parentResumeContentDigest } }));
  if (!same5(projection2(cs), projection2(ps)) || !same5(cs.questionDrafts, expected) || cs.submittedEventIds.length || cs.position !== ps.position || cs.effectiveElapsedMs !== ps.effectiveElapsedMs) throw syncError("FORK_ORIGIN_CORRUPT");
}

// src/storage/idb/write-input.js
var ownedBinaryCopies = /* @__PURE__ */ new WeakSet();
var NativeUint8Array = Uint8Array;
var nativeSet = Uint8Array.prototype.set;
var invalid = () => {
  throw storageError("INVALID_INPUT", "Invalid or oversized write input");
};
var forbidden = /* @__PURE__ */ new Set(["__proto__", "prototype", "constructor"]);
function stringBytes(value) {
  let bytes = 2;
  for (let i = 0; i < value.length; i++) {
    const n = value.charCodeAt(i);
    if (n === 34 || n === 92) bytes += 2;
    else if (n < 32) bytes += [8, 9, 10, 12, 13].includes(n) ? 2 : 6;
    else if (n < 128) bytes++;
    else if (n < 2048) bytes += 2;
    else if (n >= 55296 && n <= 56319 && i + 1 < value.length && value.charCodeAt(i + 1) >= 56320 && value.charCodeAt(i + 1) <= 57343) {
      bytes += 4;
      i++;
    } else bytes += n >= 55296 && n <= 57343 ? 6 : 3;
    if (bytes > APP_DATA_CONTENT_LIMITS.maxStringUtf8Bytes) invalid();
  }
  return bytes;
}
function ownedWriteInput(input) {
  let total = 0;
  const active = /* @__PURE__ */ new WeakSet();
  const checkedBinary = /* @__PURE__ */ new WeakSet();
  const add = (bytes) => {
    total += bytes;
    if (total > APP_DATA_CONTENT_LIMITS.maxCanonicalUtf8Bytes) invalid();
  };
  function inspect(value, depth) {
    if (depth > APP_DATA_CONTENT_LIMITS.maxDepth) invalid();
    if (value === void 0) {
      add(4);
      return;
    }
    if (value === null) {
      add(4);
      return;
    }
    if (typeof value === "string") {
      add(stringBytes(value));
      return;
    }
    if (typeof value === "boolean") {
      add(value ? 4 : 5);
      return;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) invalid();
      add(String(value).length);
      return;
    }
    if (typeof value !== "object" || active.has(value)) invalid();
    if (value instanceof Uint8Array) {
      if (Object.getPrototypeOf(value) !== Uint8Array.prototype) invalid();
      if (!checkedBinary.has(value)) {
        validateStoreRecord("content_chunks", { contentDigest: "0".repeat(64), chunkIndex: 0, bytes: value });
        checkedBinary.add(value);
      }
      add(value.byteLength + 2);
      return;
    }
    active.add(value);
    const array3 = Array.isArray(value);
    if (Object.getPrototypeOf(value) !== (array3 ? Array.prototype : Object.prototype)) invalid();
    if (array3) {
      const length = Object.getOwnPropertyDescriptor(value, "length");
      if (!length || !("value" in length) || !Number.isSafeInteger(length.value) || length.value > APP_DATA_CONTENT_LIMITS.maxArrayItems) invalid();
      if (Reflect.ownKeys(value).length !== length.value + 1) invalid();
      add(2 + Math.max(0, length.value - 1));
      for (let i = 0; i < length.value; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) invalid();
        inspect(descriptor.value, depth + 1);
      }
    } else {
      const keys = Reflect.ownKeys(value);
      if (keys.length > APP_DATA_CONTENT_LIMITS.maxObjectKeys) invalid();
      add(2 + Math.max(0, keys.length - 1));
      for (const key2 of keys) {
        if (typeof key2 !== "string" || forbidden.has(key2)) invalid();
        const descriptor = Object.getOwnPropertyDescriptor(value, key2);
        if (!descriptor.enumerable || !("value" in descriptor)) invalid();
        add(stringBytes(key2) + 1);
        inspect(descriptor.value, depth + 1);
      }
    }
    active.delete(value);
  }
  inspect(input, 0);
  function clone2(value) {
    if (!value || typeof value !== "object") return value;
    if (value instanceof Uint8Array) {
      const copy = new NativeUint8Array(value.byteLength);
      nativeSet.call(copy, value);
      ownedBinaryCopies.add(copy);
      return copy;
    }
    if (Array.isArray(value)) return value.map(clone2);
    const result = {};
    for (const key2 of Reflect.ownKeys(value)) result[key2] = clone2(Object.getOwnPropertyDescriptor(value, key2).value);
    return result;
  }
  return clone2(input);
}

// src/storage/cloud-recovery/metadata.js
var cloudError = (code) => Object.assign(new Error(code), { code });
var exact4 = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join() === keys.split(",").sort().join();
async function validateCloudReceipt(input, { generation, logEpoch, cut: cut2, change } = {}) {
  const row = ownedWriteInput(input);
  validateImportReceiptRecord(row);
  const p = row.provenance;
  if (!exact4(p, "format,generation,logEpoch,mutation,receipt") || p.format !== "qb-cloud-receipt-v1" || !isUuid(p.generation) || !isUuid(p.logEpoch) || row.sourceId !== `qb-cloud-receipt-v1:${p.generation}:${p.logEpoch}`) throw cloudError("CLOUD_RECEIPT_CORRUPT");
  validateMutation(p.mutation);
  validateMutationReceipt(p.receipt);
  if (row.sourceRecordId !== p.mutation.mutationId || p.receipt.mutationId !== p.mutation.mutationId || p.receipt.payloadDigest !== p.mutation.payloadDigest || !await verifyMutationDigest(p.mutation) || p.receipt.status === "missing_dependency" || generation && generation !== p.generation || logEpoch && logEpoch !== p.logEpoch) throw cloudError("CLOUD_RECEIPT_CORRUPT");
  if (p.receipt.status !== "conflict") {
    if (["bank_revision", "history_snapshot", "attempt_manifest", "resume_state", "user_state"].includes(p.mutation.kind) && p.receipt.currentRevision !== void 0 && p.receipt.currentRevision !== p.mutation.payload.baseRevision + 1) throw cloudError("CLOUD_RECEIPT_REVISION");
    if (cut2 !== void 0 && BigInt(p.receipt.serverSeq) > BigInt(cut2)) throw cloudError("CLOUD_RECEIPT_CUT");
    if (change) {
      validateChangeLogRecord(change);
      if (change.accountGeneration !== p.generation || change.serverSeq !== p.receipt.serverSeq || change.kind !== p.mutation.kind || change.entityKey !== p.mutation.entityKey || new TextDecoder().decode(canonicalBytes(change.payload)) !== new TextDecoder().decode(canonicalBytes(p.mutation.payload)) || await sha256Hex(canonicalBytes({ protocolVersion: 2, kind: change.kind, entityKey: change.entityKey, payload: change.payload })) !== change.payloadDigest) throw cloudError("CLOUD_RECEIPT_CHANGE");
    }
  }
  return row;
}

// src/storage/sync/star-resolution.js
var exact5 = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join() === keys.split(",").sort().join();
async function validateStarResolutionReceipt(input) {
  const row = ownedWriteInput(input);
  validateImportReceiptRecord(row);
  const p = row.provenance;
  if (!exact5(p, "format,commandId,conflictId,choice,generation,logEpoch,originalMutation,sourceChange,newMutationId") || p.format !== "qb-star-conflict-resolution-v1" || !isUuid(p.commandId) || !isUuid(p.conflictId) || !isUuid(p.generation) || !isUuid(p.logEpoch) || !["local", "cloud"].includes(p.choice) || p.newMutationId !== p.commandId || row.sourceId !== "qb-star-conflict-resolution-v1" || row.sourceRecordId !== p.commandId) throw syncError("STAR_RESOLUTION_ORIGIN_CORRUPT");
  validateMutation(p.originalMutation);
  if (p.originalMutation.kind !== "user_state" || p.originalMutation.mutationId !== p.conflictId || !await verifyMutationDigest(p.originalMutation)) throw syncError("STAR_RESOLUTION_ORIGIN_CORRUPT");
  const proof = await validateSyncChangeReceipt({ sourceId: `qb-sync-v2:${p.generation}:${p.logEpoch}`, sourceRecordId: `change:${p.sourceChange.serverSeq}`, importedAt: row.importedAt, provenance: { format: "qb-sync-change-v1", generation: p.generation, logEpoch: p.logEpoch, change: p.sourceChange } });
  if (proof.provenance.change.kind !== "user_state" || proof.provenance.change.entityKey !== p.originalMutation.entityKey) throw syncError("STAR_RESOLUTION_ORIGIN_CORRUPT");
  return row;
}

// src/storage/sync/star-group-resolution.js
var STAR_GROUP_FORMAT = "qb-star-conflict-group-resolution-v1";
var STAR_GROUP_STORES = Object.freeze(["meta", "mutations", "outbox", "conflicts", "import_receipts", "user_state"]);
var STAR_GROUP_READ_BYTES = 3 * 1024 * 1024;
var eq = (a, b) => new TextDecoder().decode(canonicalBytes(a)) === new TextDecoder().decode(canonicalBytes(b));
var exact6 = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join() === keys.split(",").sort().join();
var digest10 = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
var capture = (value) => {
  canonicalBytes(value);
  return ownedWriteInput(value);
};
function star(wire) {
  validateMutation(wire);
  if (wire.kind !== "user_state" || wire.payload.field !== "starred" || wire.entityKey !== `user_state:${wire.payload.questionKey}:starred`) throw syncError("STAR_GROUP_SOURCE_UNAVAILABLE");
}
function validateState(state) {
  if (!exact6(state, STAR_GROUP_STORES.join(","))) throw syncError("STAR_GROUP_STATE");
  for (const store of STAR_GROUP_STORES) {
    if (!Array.isArray(state[store])) throw syncError("STAR_GROUP_STATE");
    const keys = /* @__PURE__ */ new Set();
    for (const row of state[store]) {
      validateStoreRecord(store, row);
      const path = APP_DATA_STORES[store].keyPath, key2 = JSON.stringify(Array.isArray(path) ? path.map((k) => row[k]) : row[path]);
      if (keys.has(key2)) throw syncError("STAR_GROUP_STATE");
      keys.add(key2);
    }
  }
}
function projectStarConflictGroup(state, ownerValue, entityKey) {
  validateState(state);
  const owner = snapshotOwner(ownerValue);
  if (owner.ownerKind !== "account" || typeof entityKey !== "string" || !entityKey.startsWith("user_state:") || !entityKey.endsWith(":starred") || !isQuestionKey(entityKey.slice(11, -8))) throw syncError("INVALID_INPUT");
  const streamRow = state.meta.find((r) => r.key === "clientStreamId"), seqRow = state.meta.find((r) => r.key === "clientSeq"), epochRow = state.meta.find((r) => r.key === "serverLogEpoch"), cursorRow = state.meta.find((r) => r.key === "appliedPullCursor") || null;
  if (!streamRow || !seqRow || !epochRow || !cursorRow || !isUuid(epochRow.value)) throw syncError("PULL_REQUIRED");
  const cursor = decodeCursor(cursorRow.value);
  if (cursor.accountGeneration !== owner.accountGeneration || cursor.logEpoch !== epochRow.value) throw syncError("PULL_REQUIRED");
  const pending = [];
  for (const outbox of state.outbox) {
    const mutation = state.mutations.find((r) => r.mutationId === outbox.mutationId);
    if (!mutation) throw syncError("STAR_GROUP_SOURCE_UNAVAILABLE");
    if (mutation.kind !== "user_state" || mutation.entityKey !== entityKey) continue;
    star(mutationWire(mutation));
    if (mutation.accountGeneration !== owner.accountGeneration) throw syncError("STAR_GROUP_SOURCE_UNAVAILABLE");
    if (mutation.clientStreamId !== streamRow.value) throw syncError("STAR_GROUP_FOREIGN_STREAM");
    const conflict = state.conflicts.find((r) => r.conflictId === mutation.mutationId) || null;
    if (conflict && (!eq(conflict.mutation, mutationWire(mutation)) || conflict.entityKey !== entityKey || conflict.status !== "open")) throw syncError("STAR_GROUP_SOURCE_UNAVAILABLE");
    pending.push({ originalMutation: mutationWire(mutation), originalRecord: mutation, outbox, conflict });
  }
  pending.sort((a, b) => a.originalMutation.clientSeq - b.originalMutation.clientSeq);
  if (!pending.length || !pending.some((r) => r.conflict)) throw syncError("STAR_GROUP_NOT_OPEN");
  if (pending.at(-1).originalMutation.clientSeq > seqRow.value || new Set(pending.map((r) => r.originalMutation.clientSeq)).size !== pending.length) throw syncError("STAR_GROUP_SOURCE_UNAVAILABLE");
  const localState = state.user_state.find((r) => r.questionKey === pending[0].originalMutation.payload.questionKey && r.field === "starred");
  if (!localState || localState.value !== pending.at(-1).originalMutation.payload.value) throw syncError("STAR_GROUP_LOCAL_CHANGED");
  const sourceId = `qb-sync-v2:${owner.accountGeneration}:${epochRow.value}`, entityReceipt = state.import_receipts.find((r) => r.sourceId === sourceId && r.sourceRecordId === `entity:user_state:${entityKey}`);
  if (!entityReceipt) throw syncError("PULL_REQUIRED");
  validateSyncReceipt(entityReceipt);
  const sources = state.import_receipts.filter((r) => r.sourceId === sourceId && r.provenance?.format === "qb-sync-change-v1" && r.provenance.change?.kind === "user_state" && r.provenance.change.entityKey === entityKey).sort((a, b) => a.provenance.change.serverRevision - b.provenance.change.serverRevision || (BigInt(a.provenance.change.serverSeq) < BigInt(b.provenance.change.serverSeq) ? -1 : BigInt(a.provenance.change.serverSeq) > BigInt(b.provenance.change.serverSeq) ? 1 : 0));
  const sourceReceipt = sources.at(-1), change = sourceReceipt?.provenance.change;
  if (!change || change.serverRevision !== entityReceipt.provenance.serverRevision || change.payloadDigest !== entityReceipt.provenance.payloadDigest || BigInt(change.serverSeq) > BigInt(cursor.serverSeq)) throw syncError("PULL_REQUIRED");
  for (const member of pending) for (const receipt of state.import_receipts) if (receipt.provenance?.format === "qb-cloud-receipt-v1" && receipt.provenance.mutation?.mutationId === member.originalMutation.mutationId && ["accepted", "duplicate"].includes(receipt.provenance.receipt?.status)) throw syncError("STAR_GROUP_ACCEPTED_MEMBER");
  return { format: "qb-star-conflict-group-view-v1", owner, entityKey, members: pending, localState, streamRow, seqRow, epochRow, cursorRow, entityReceipt, sourceReceipt };
}
async function verifyGroup(group) {
  if (!exact6(group, "format,owner,entityKey,members,localState,streamRow,seqRow,epochRow,cursorRow,entityReceipt,sourceReceipt") || group.format !== "qb-star-conflict-group-view-v1") throw syncError("STAR_GROUP_ORIGIN_CORRUPT");
  const owner = snapshotOwner(group.owner);
  if (owner.ownerKind !== "account" || !Array.isArray(group.members) || !group.members.length) throw syncError("STAR_GROUP_ORIGIN_CORRUPT");
  const state = { meta: [group.streamRow, group.seqRow, group.epochRow, ...group.cursorRow ? [group.cursorRow] : []], mutations: [], outbox: [], conflicts: [], user_state: [group.localState], import_receipts: [group.entityReceipt, group.sourceReceipt] };
  for (const m of group.members) {
    if (!exact6(m, "originalMutation,originalRecord,outbox,conflict")) throw syncError("STAR_GROUP_ORIGIN_CORRUPT");
    star(m.originalMutation);
    validateMutationRecord(m.originalRecord);
    if (!eq(mutationWire(m.originalRecord), m.originalMutation) || !await verifyMutationDigest(m.originalMutation) || m.outbox.mutationId !== m.originalMutation.mutationId) throw syncError("STAR_GROUP_ORIGIN_CORRUPT");
    state.mutations.push(m.originalRecord);
    state.outbox.push(m.outbox);
    if (m.conflict) state.conflicts.push(m.conflict);
  }
  const projected = projectStarConflictGroup(state, owner, group.entityKey);
  if (!eq(projected, group)) throw syncError("STAR_GROUP_ORIGIN_CORRUPT");
  await validateSyncChangeReceipt(group.sourceReceipt);
  return group;
}
async function validateStarGroupResolutionReceipt(input) {
  const row = capture(input);
  validateImportReceiptRecord(row);
  const p = row.provenance;
  if (!exact6(p, "format,commandId,choice,generation,logEpoch,groupDigest,group,sourceChange,newMutationId") || p.format !== STAR_GROUP_FORMAT || !isUuid(p.commandId) || p.newMutationId !== p.commandId || !isUuid(p.generation) || !isUuid(p.logEpoch) || !["local", "cloud"].includes(p.choice) || !digest10(p.groupDigest) || row.sourceId !== STAR_GROUP_FORMAT || row.sourceRecordId !== p.commandId) throw syncError("STAR_GROUP_ORIGIN_CORRUPT");
  await verifyGroup(p.group);
  if (p.group.members.some((member) => member.originalMutation.mutationId === p.commandId)) throw syncError("STAR_GROUP_ORIGIN_CORRUPT");
  if (p.generation !== p.group.owner.accountGeneration || p.logEpoch !== p.group.epochRow.value || !eq(p.sourceChange, p.group.sourceReceipt.provenance.change) || await sha256Hex(canonicalBytes(p.group)) !== p.groupDigest) throw syncError("STAR_GROUP_ORIGIN_CORRUPT");
  return row;
}

// src/storage/idb/schema.js
var BUSINESS_SCHEMA_VERSION = APP_DATA_DB_SCHEMA_VERSION;
function sameKeyPath(left, right) {
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => item === right[index]);
  }
  return left === right;
}
function applyFreshBusinessSchema(db) {
  for (const [storeName, descriptor] of Object.entries(APP_DATA_STORES)) {
    if (db.objectStoreNames.contains(storeName)) throw storageError("SCHEMA_MISMATCH", `fresh database unexpectedly contains ${storeName}`);
    const store = db.createObjectStore(storeName, { keyPath: descriptor.keyPath, autoIncrement: false });
    for (const index of descriptor.indexes) store.createIndex(index.name, index.keyPath, { unique: index.unique, multiEntry: false });
  }
}
function upgradeBusinessSchema(db, oldVersion, newVersion, transaction) {
  if (oldVersion !== 1 || newVersion !== 2) throw storageError("SCHEMA_VERSION_UNSUPPORTED", "unsupported business upgrade");
  const legacyNames = Object.keys(APP_DATA_STORES).filter((name) => name !== "history_snapshots");
  if (db.objectStoreNames.length !== legacyNames.length || legacyNames.some((name) => !db.objectStoreNames.contains(name))) throw storageError("SCHEMA_MISMATCH", "legacy store inventory differs");
  for (const name of legacyNames) {
    const expected = APP_DATA_STORES[name], store2 = transaction.objectStore(name);
    if (!sameKeyPath(store2.keyPath, expected.keyPath) || store2.autoIncrement !== false || store2.indexNames.length !== expected.indexes.length) throw storageError("SCHEMA_MISMATCH", "legacy store descriptor differs");
    for (const index of expected.indexes) {
      if (!store2.indexNames.contains(index.name)) throw storageError("SCHEMA_MISMATCH", "legacy index missing");
      const actual = store2.index(index.name);
      if (!sameKeyPath(actual.keyPath, index.keyPath) || actual.unique !== index.unique || actual.multiEntry !== false) throw storageError("SCHEMA_MISMATCH", "legacy index descriptor differs");
    }
  }
  const descriptor = APP_DATA_STORES.history_snapshots;
  const store = db.createObjectStore("history_snapshots", { keyPath: descriptor.keyPath, autoIncrement: false });
  for (const index of descriptor.indexes) store.createIndex(index.name, index.keyPath, { unique: index.unique, multiEntry: false });
}
async function assertBusinessSchema(db) {
  const expectedNames = Object.keys(APP_DATA_STORES);
  const actualNames = Array.from(db.objectStoreNames);
  if (actualNames.length !== expectedNames.length || expectedNames.some((name) => !db.objectStoreNames.contains(name))) {
    throw storageError("SCHEMA_MISMATCH", "business database does not have the frozen store set");
  }
  let tx;
  let done;
  try {
    tx = db.transaction(expectedNames, "readonly");
    done = tx.done;
    void done.catch(() => {
    });
    for (const storeName of expectedNames) {
      const descriptor = APP_DATA_STORES[storeName];
      const store = tx.objectStore(storeName);
      if (!sameKeyPath(store.keyPath, descriptor.keyPath) || store.autoIncrement !== false) throw storageError("SCHEMA_MISMATCH", `${storeName} structure differs from APP_DATA_STORES`);
      const actualIndexes = Array.from(store.indexNames);
      if (actualIndexes.length !== descriptor.indexes.length || descriptor.indexes.some((index) => !store.indexNames.contains(index.name))) {
        throw storageError("SCHEMA_MISMATCH", `${storeName} indexes differ from APP_DATA_STORES`);
      }
      for (const expectedIndex of descriptor.indexes) {
        const actualIndex = store.index(expectedIndex.name);
        if (!sameKeyPath(actualIndex.keyPath, expectedIndex.keyPath) || actualIndex.unique !== expectedIndex.unique || actualIndex.multiEntry !== false) {
          throw storageError("SCHEMA_MISMATCH", `${storeName}.${expectedIndex.name} differs from APP_DATA_STORES`);
        }
      }
    }
    await done;
  } catch (cause) {
    const primary = cause && typeof cause === "object" && cause.code === "SCHEMA_MISMATCH" ? cause : storageError("SCHEMA_MISMATCH", "unable to inspect business database schema", cause);
    if (tx && done) {
      try {
        tx.abort();
      } catch {
      }
      await Promise.allSettled([done]);
    }
    throw primary;
  }
}

// src/storage/idb/profile-context.js
var nextContextGeneration = 1;
function getIndexedDbCapability(idb = globalThis.indexedDB) {
  return Boolean(idb && typeof idb === "object" && typeof idb.open === "function");
}
function notifyLifecycle(callback, type, dbName) {
  try {
    callback({ type, dbName });
  } catch {
  }
}
function validateProfile(profile) {
  try {
    return validateProfileRegistry(profile);
  } catch (cause) {
    throw storageError("INVALID", "profile must satisfy the frozen profile registry contract", cause);
  }
}
function positiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw storageError("INVALID", `${name} must be a positive safe integer`);
  return value;
}
async function openProfileContext(options) {
  if (!options || typeof options !== "object") throw storageError("INVALID", "open options are required");
  const { profile, openMode, onLifecycle = () => {
  }, blockedTimeoutMs, signal } = options;
  const validatedProfile = validateProfile(profile);
  const registryRecord = Object.freeze({
    profileId: validatedProfile.profileId,
    dbName: validatedProfile.dbName,
    schemaVersion: validatedProfile.schemaVersion
  });
  if (openMode !== "create" && openMode !== "existing") throw storageError("INVALID", "openMode must be create or existing");
  if (!getIndexedDbCapability()) throw storageError("STORAGE_UNAVAILABLE", "IndexedDB is unavailable");
  if (typeof onLifecycle !== "function") throw storageError("INVALID", "onLifecycle must be a function");
  positiveSafeInteger(blockedTimeoutMs, "blockedTimeoutMs");
  if (signal !== void 0 && !(signal instanceof AbortSignal)) throw storageError("INVALID", "signal must be an AbortSignal");
  if (signal?.aborted) throw storageError("CLOSED", "database open was cancelled");
  let cancelled = false;
  let upgradeFailure;
  let openTimer;
  let removeAbortListener;
  let rejectCancelledOpen;
  const cancelledOpen = new Promise((resolve, reject) => {
    void resolve;
    rejectCancelledOpen = reject;
  });
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    rejectCancelledOpen(storageError("CLOSED", "database open was cancelled"));
  };
  if (signal) {
    signal.addEventListener("abort", cancel, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", cancel);
  }
  let db;
  let closed = false;
  let createdThisOpen = false;
  const activeTransactions = /* @__PURE__ */ new Set();
  function assertOpen() {
    if (closed) throw storageError("CLOSED", "profile context is closed");
  }
  function closeContext() {
    if (closed) return;
    closed = true;
    for (const transaction of activeTransactions) {
      try {
        transaction.abort();
      } catch {
      }
    }
    if (db) db.close();
  }
  try {
    const opening = openDB(registryRecord.dbName, BUSINESS_SCHEMA_VERSION, {
      upgrade(upgradeDb, oldVersion, newVersion, transaction) {
        transaction.done.catch(() => {
        });
        if (cancelled) {
          transaction.abort();
          return;
        }
        if (oldVersion === 1 && newVersion === BUSINESS_SCHEMA_VERSION && openMode === "existing") {
          try {
            upgradeBusinessSchema(upgradeDb, oldVersion, newVersion, transaction);
          } catch (cause) {
            upgradeFailure = cause;
            transaction.abort();
          }
          return;
        }
        if (oldVersion !== 0 || newVersion !== BUSINESS_SCHEMA_VERSION) {
          upgradeFailure = storageError("SCHEMA_VERSION_UNSUPPORTED", "business database version is unsupported");
          transaction.abort();
          return;
        }
        if (openMode !== "create") {
          upgradeFailure = storageError("SCHEMA_MISMATCH", "an existing profile database must not be created during open");
          transaction.abort();
          return;
        }
        try {
          createdThisOpen = true;
          applyFreshBusinessSchema(upgradeDb);
        } catch (cause) {
          upgradeFailure = cause;
          transaction.abort();
        }
      },
      blocked() {
        notifyLifecycle(onLifecycle, "blocked", registryRecord.dbName);
      },
      blocking() {
        closeContext();
        notifyLifecycle(onLifecycle, "versionchange", registryRecord.dbName);
      }
    });
    openTimer = setTimeout(cancel, blockedTimeoutMs);
    opening.then((lateDb) => {
      if (cancelled) lateDb.close();
    }, () => {
    });
    db = await Promise.race([opening, cancelledOpen]);
    if (upgradeFailure) throw upgradeFailure;
    if (openMode === "create" && !createdThisOpen) {
      db.close();
      throw storageError("DB_ALREADY_EXISTS", "create mode will not attach to an existing database");
    }
    if (cancelled) {
      db.close();
      throw storageError("CLOSED", "database open was cancelled");
    }
    await assertBusinessSchema(db);
    if (cancelled || closed) {
      db.close();
      throw storageError("CLOSED", "database open was cancelled or superseded");
    }
  } catch (cause) {
    if (db) db.close();
    if (upgradeFailure) throw upgradeFailure;
    if (cause && typeof cause === "object" && cause.name === "VersionError") {
      throw storageError("SCHEMA_VERSION_UNSUPPORTED", "business database version is unsupported", cause);
    }
    if (cause && typeof cause === "object" && cause.name === "StorageError" && typeof cause.code === "string") throw cause;
    if (cancelled) throw storageError("CLOSED", "database open was cancelled", cause);
    throw storageError("STORAGE_UNAVAILABLE", "unable to open IndexedDB", cause);
  } finally {
    if (openTimer !== void 0) clearTimeout(openTimer);
    removeAbortListener?.();
  }
  const generation = nextContextGeneration;
  nextContextGeneration = nextContextGeneration === Number.MAX_SAFE_INTEGER ? 1 : nextContextGeneration + 1;
  return Object.freeze({
    profileId: registryRecord.profileId,
    dbName: registryRecord.dbName,
    // This is only a local context epoch. It is not accountGeneration,
    // sessionFence, clientSeq, or a writer fence.
    contextGeneration: generation,
    get closed() {
      return closed;
    },
    close: closeContext,
    transaction(storeNames, mode, work) {
      return runIdbTransaction({
        db,
        assertOpen,
        track: (transaction) => activeTransactions.add(transaction),
        untrack: (transaction) => activeTransactions.delete(transaction)
      }, storeNames, mode, work);
    }
  });
}

// src/domain/attempt/commands.js
var commandError = (code) => Object.assign(new Error(code), { name: "LearningCommandError", code });
var clone = (value) => structuredClone(value);
var binding = ({ attemptId, parentAttemptId }) => ({ attemptId, ...parentAttemptId ? { parentAttemptId } : {} });
var equal2 = (a, b) => new TextDecoder().decode(canonicalBytes(a)) === new TextDecoder().decode(canonicalBytes(b));
async function derivedId(commandId, name) {
  const digest11 = await sha256Hex(new TextEncoder().encode(`${commandId}:${name}`));
  return `${digest11.slice(0, 8)}-${digest11.slice(8, 12)}-4${digest11.slice(13, 16)}-8${digest11.slice(17, 20)}-${digest11.slice(20, 32)}`;
}
function validateBundle(bundle) {
  if (!bundle.attempt) throw commandError("ATTEMPT_NOT_FOUND");
  validateAttemptRecord(bundle.attempt);
  validateAttemptScope(bundle.scope, bundle.attempt.attemptId, bundle.attempt.scopeCount);
  const scope = new Map(bundle.scope.map((row) => [row.questionKey, row.questionRevision]));
  const draftKeys = /* @__PURE__ */ new Set();
  bundle.drafts.forEach((draft) => {
    validateDraftForAttempt(draft, binding(bundle.attempt));
    if (draftKeys.has(draft.questionKey) || scope.get(draft.questionKey) !== draft.questionRevision || draft.writerStreamId !== bundle.attempt.writerStreamId || draft.localRevision > bundle.attempt.localRevision) throw commandError("CORRUPT_ATTEMPT");
    draftKeys.add(draft.questionKey);
  });
  const ids = /* @__PURE__ */ new Set();
  const actions = /* @__PURE__ */ new Set();
  bundle.events.forEach((event) => {
    validateAnswerEvent(event);
    if (event.attemptId !== bundle.attempt.attemptId || scope.get(event.questionKey) !== event.questionRevision || event.writerStreamId !== bundle.attempt.writerStreamId || ids.has(event.eventId) || actions.has(event.actionSeq)) throw commandError("CORRUPT_ATTEMPT");
    ids.add(event.eventId);
    actions.add(event.actionSeq);
  });
  if (bundle.events.length !== bundle.attempt.actionSeq || [...actions].sort((a, b) => a - b).some((seq, index) => seq !== index + 1)) throw commandError("CORRUPT_ATTEMPT");
  return bundle;
}
function resumeState(bundle, baseRevision = 0) {
  const state = {
    schemaVersion: bundle.snapshotBaseline ? 2 : 1,
    ...bundle.snapshotBaseline ? { snapshotBaseline: clone(bundle.snapshotBaseline) } : {},
    attemptId: bundle.attempt.attemptId,
    writerStreamId: bundle.attempt.writerStreamId,
    localRevision: bundle.attempt.localRevision,
    baseRevision,
    scopeDigest: bundle.attempt.scopeDigest,
    questionDrafts: [...bundle.drafts].sort((a, b) => a.questionKey < b.questionKey ? -1 : a.questionKey > b.questionKey ? 1 : 0).map(({ attemptId, writerStreamId, fence, dirty, ...draft }) => draft),
    submittedEventIds: [...bundle.events].sort((a, b) => a.actionSeq - b.actionSeq).filter((event) => event.kind === "answer_submitted").map((event) => event.eventId),
    position: bundle.attempt.position,
    effectiveElapsedMs: bundle.attempt.effectiveElapsedMs,
    scope: bundle.scope
  };
  validateResumeState(state);
  return state;
}

// src/storage/backup/snapshot.js
var STORE_NAMES = Object.freeze(Object.keys(APP_DATA_STORES).sort());
var LEGACY_STORE_NAMES = Object.freeze(STORE_NAMES.filter((name) => name !== "history_snapshots"));
if (STORE_NAMES.length !== 20 || LEGACY_STORE_NAMES.length !== 19) throw new Error("BACKUP_STORE_LAYOUT_UNSUPPORTED");
var backupError = (code) => Object.assign(new Error(code), { name: "LearningBackupError", code });
var LIMITS = Object.freeze({ archiveBytes: 110 * 1024 * 1024, expandedBytes: 100 * 1024 * 1024, entries: 1e4, records: 2e5, fileBytes: 16 * 1024 * 1024 });
function ownSnapshot(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).some((key2) => typeof key2 !== "string" || !("value" in Object.getOwnPropertyDescriptor(value, key2))) || Object.keys(value).sort().join() !== STORE_NAMES.join()) throw backupError("BACKUP_STORE_SET");
  for (const name of STORE_NAMES) {
    const rows = value[name];
    if (!Array.isArray(rows) || Reflect.ownKeys(rows).some((key2) => typeof key2 !== "string" || !("value" in Object.getOwnPropertyDescriptor(rows, key2)))) throw backupError("BACKUP_RECORD_INVALID");
    for (let i = 0; i < rows.length; i++) {
      if (!Object.hasOwn(rows, i)) throw backupError("BACKUP_RECORD_INVALID");
      validateStoreRecord(name, rows[i]);
    }
  }
  return structuredClone(value);
}
async function captureProfile(profile, { blockedTimeoutMs = 5e3, signal } = {}) {
  const context = await openProfileContext({ profile, openMode: "existing", blockedTimeoutMs, signal });
  try {
    const requests = [];
    await context.transaction(STORE_NAMES, "readonly", (tx) => {
      for (const name of STORE_NAMES) {
        const request = tx.objectStore(name).getAll();
        void request.catch(() => {
        });
        requests.push(request);
      }
    });
    return Object.fromEntries((await Promise.all(requests)).map((rows, index) => [STORE_NAMES[index], rows]));
  } finally {
    context.close();
  }
}
async function snapshotManifest(snapshot) {
  const stores = [];
  for (const name of STORE_NAMES) {
    const rows = [];
    const path = APP_DATA_STORES[name].keyPath;
    const key2 = (row) => JSON.stringify(Array.isArray(path) ? path.map((field) => row[field]) : row[path]);
    for (const row of [...snapshot[name]].sort((a, b) => key2(a).localeCompare(key2(b), "en"))) rows.push(name === "content_chunks" ? { contentDigest: row.contentDigest, chunkIndex: row.chunkIndex, byteLength: row.bytes.byteLength, sha256: await sha256Hex(row.bytes) } : row);
    stores.push({ name, recordCount: rows.length, sha256: await sha256Hex(canonicalContentBytes(rows)) });
  }
  const manifest = { format: "qb-v2-restored-manifest-v1", businessSchemaVersion: APP_DATA_DB_SCHEMA_VERSION, stores };
  return { manifest, contentDigest: await canonicalDigest(manifest), recordCount: stores.reduce((sum, row) => sum + row.recordCount, 0) };
}
async function validateSnapshot(snapshot, owner) {
  snapshot = ownSnapshot(snapshot);
  if (Object.keys(snapshot).sort().join() !== STORE_NAMES.join()) throw backupError("BACKUP_STORE_SET");
  let bytes = 0, count = 0;
  for (const name of STORE_NAMES) {
    if (!Array.isArray(snapshot[name])) throw backupError("BACKUP_RECORD_INVALID");
    const keys = /* @__PURE__ */ new Set();
    for (const row of snapshot[name]) {
      validateStoreRecord(name, row);
      const path = APP_DATA_STORES[name].keyPath;
      const key2 = JSON.stringify(Array.isArray(path) ? path.map((field) => row[field]) : row[path]);
      if (keys.has(key2)) throw backupError("BACKUP_DUPLICATE_RECORD");
      keys.add(key2);
      bytes += name === "content_chunks" ? row.bytes.byteLength : canonicalBytes(row).byteLength;
      if (++count > LIMITS.records || bytes > LIMITS.expandedBytes) throw backupError("BACKUP_BUDGET_EXCEEDED");
    }
  }
  const mutationIds = /* @__PURE__ */ new Set(), tuples = /* @__PURE__ */ new Set();
  for (const mutation of snapshot.mutations) {
    if (owner.ownerKind === "account" ? mutation.accountGeneration !== owner.accountGeneration : mutation.accountGeneration !== void 0) throw backupError("BACKUP_OWNER_MISMATCH");
    const { protocolVersion, mutationId, clientStreamId, clientSeq, kind, entityKey, payload, payloadDigest } = mutation;
    if (!await verifyMutationDigest({ protocolVersion, mutationId, clientStreamId, clientSeq, kind, entityKey, payload, payloadDigest })) throw backupError("BACKUP_MUTATION_DIGEST");
    const tuple = `${mutation.clientStreamId}:${mutation.clientSeq}`;
    if (tuples.has(tuple)) throw backupError("BACKUP_SEQUENCE_CONFLICT");
    tuples.add(tuple);
    mutationIds.add(mutation.mutationId);
  }
  if (snapshot.outbox.some((row) => !mutationIds.has(row.mutationId))) throw backupError("BACKUP_OUTBOX_DEPENDENCY");
  const chunks = new Map(snapshot.content_chunks.map((row) => [`${row.contentDigest}:${row.chunkIndex}`, row.bytes]));
  async function content(reference, decode = true) {
    const raw = chunks.get(`${reference.manifestDigest}:0`);
    if (!raw || await sha256Hex(raw) !== reference.manifestDigest) throw backupError("BACKUP_CONTENT_MISSING");
    const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
    validateChunkManifest(manifest);
    if (manifest.contentDigest !== reference.contentDigest || manifest.chunkCount !== reference.chunkCount || manifest.totalBytes !== reference.totalBytes) throw backupError("BACKUP_CONTENT_DIGEST");
    const payload = new Uint8Array(reference.totalBytes);
    let offset = 0;
    for (const item of manifest.chunks) {
      const chunk = chunks.get(`${reference.contentDigest}:${item.chunkIndex}`);
      if (!chunk || chunk.byteLength !== item.byteLength || await sha256Hex(chunk) !== item.sha256) throw backupError("BACKUP_CONTENT_DIGEST");
      payload.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (await sha256Hex(payload) !== reference.contentDigest) throw backupError("BACKUP_CONTENT_DIGEST");
    return { reference, manifest, value: decode ? JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)) : void 0 };
  }
  const learningReferences = [...snapshot.mutations];
  for (const receipt of snapshot.import_receipts) if (receipt.provenance?.format === "qb-sync-change-v1") {
    const verified = await validateSyncChangeReceipt(receipt);
    if (owner.ownerKind !== "account" || verified.provenance.generation !== owner.accountGeneration) throw backupError("BACKUP_OWNER_MISMATCH");
    learningReferences.push(verified.provenance.change);
  }
  for (const receipt of snapshot.import_receipts) if (receipt.provenance?.format === "qb-cloud-receipt-v1") {
    if (owner.ownerKind !== "account") throw backupError("BACKUP_OWNER_MISMATCH");
    const p = receipt.provenance, change = learningReferences.find((row) => row.serverSeq === p.receipt?.serverSeq && row.accountGeneration === owner.accountGeneration);
    if (p.receipt?.status !== "conflict" && !change) throw backupError("BACKUP_CLOUD_RECEIPT_DEPENDENCY");
    await validateCloudReceipt(receipt, { generation: owner.accountGeneration, logEpoch: p.logEpoch, change });
  }
  if (snapshot.migration_journal.some((row) => row.checkpoint?.format === "qb-cloud-recovery-stage-v1") || snapshot.import_receipts.some((row) => ["qb-cloud-stage-page-v1", "qb-cloud-stage-index-v1", "qb-final-proof-index-v1", "qb-final-proof-part-v1", "qb-final-proof-reservation-v1"].includes(row.provenance?.format) || row.sourceId.startsWith("qb-cloud-stage-index:") && isUuid(row.sourceId.slice("qb-cloud-stage-index:".length)))) throw backupError("BACKUP_UNFINISHED_CLOUD_STAGE");
  const resolvedStarOrigins = /* @__PURE__ */ new Set();
  for (const receipt of snapshot.import_receipts.filter((row) => row.provenance?.format === "qb-star-conflict-resolution-v1")) {
    const p = (await validateStarResolutionReceipt(receipt)).provenance;
    if (owner.ownerKind !== "account" || p.generation !== owner.accountGeneration) throw backupError("BACKUP_OWNER_MISMATCH");
    const original = snapshot.mutations.find((row) => row.mutationId === p.originalMutation.mutationId), created = snapshot.mutations.find((row) => row.mutationId === p.newMutationId), conflict = snapshot.conflicts.find((row) => row.conflictId === p.conflictId);
    if (!created || created.clientStreamId !== p.originalMutation.clientStreamId || created.clientSeq <= p.originalMutation.clientSeq) throw backupError("BACKUP_STAR_RESOLUTION_ORIGIN");
    if (!original || !created || !conflict || conflict.status !== "resolved" || snapshot.outbox.some((row) => row.mutationId === p.originalMutation.mutationId) || !equal2(conflict.mutation, p.originalMutation) || created.kind !== "user_state" || created.entityKey !== p.originalMutation.entityKey || created.payload.baseRevision !== p.sourceChange.serverRevision || created.payload.value !== (p.choice === "local" ? p.originalMutation.payload.value : p.sourceChange.payload.value)) throw backupError("BACKUP_STAR_RESOLUTION_ORIGIN");
    const { protocolVersion, mutationId, clientStreamId, clientSeq, kind, entityKey, payload, payloadDigest } = original;
    if (!equal2({ protocolVersion, mutationId, clientStreamId, clientSeq, kind, entityKey, payload, payloadDigest }, p.originalMutation)) throw backupError("BACKUP_STAR_RESOLUTION_ORIGIN");
    resolvedStarOrigins.add(p.conflictId);
  }
  for (const receipt of snapshot.import_receipts.filter((row) => row.provenance?.format === STAR_GROUP_FORMAT || row.sourceId === STAR_GROUP_FORMAT)) {
    let p;
    try {
      p = (await validateStarGroupResolutionReceipt(receipt)).provenance;
    } catch {
      throw backupError("BACKUP_STAR_GROUP_RESOLUTION_ORIGIN");
    }
    if (!equal2(p.group.owner, owner)) throw backupError("BACKUP_OWNER_MISMATCH");
    const created = snapshot.mutations.find((row) => row.mutationId === p.newMutationId);
    if (!created || created.accountGeneration !== owner.accountGeneration || created.clientStreamId !== p.group.streamRow.value || created.clientSeq !== p.group.seqRow.value + 1 || created.kind !== "user_state" || created.entityKey !== p.group.entityKey || created.payload.baseRevision !== p.sourceChange.serverRevision || created.payload.value !== (p.choice === "local" ? p.group.localState.value : p.sourceChange.payload.value)) throw backupError("BACKUP_STAR_GROUP_RESOLUTION_ORIGIN");
    for (const member of p.group.members) {
      const original = snapshot.mutations.find((row) => row.mutationId === member.originalMutation.mutationId), conflict = snapshot.conflicts.find((row) => row.conflictId === member.originalMutation.mutationId) || null;
      if (!original || !equal2(original, member.originalRecord) || snapshot.outbox.some((row) => row.mutationId === member.originalMutation.mutationId) || !equal2(conflict, member.conflict ? { ...member.conflict, status: "resolved" } : null)) throw backupError("BACKUP_STAR_GROUP_RESOLUTION_ORIGIN");
      if (member.conflict) resolvedStarOrigins.add(member.conflict.conflictId);
    }
  }
  if (snapshot.conflicts.some((row) => row.status === "resolved" && row.mutation.kind === "user_state" && row.mutation.payload.field === "starred" && !resolvedStarOrigins.has(row.conflictId))) throw backupError("BACKUP_STAR_RESOLUTION_AUDIT_MISSING");
  const references = learningReferences.filter((row) => row.kind === "content_manifest").map((row) => row.payload.reference);
  for (const reference of references) await content(reference, false);
  for (const mutation of learningReferences.filter((row) => row.kind === "attempt_scope")) await content(mutation.payload.reference);
  const snapshotChanges = learningReferences.filter((row) => row.kind === "history_snapshot");
  const snapshotById = /* @__PURE__ */ new Map();
  for (const row of snapshotChanges) {
    const id = row.payload?.snapshotId, prior2 = snapshotById.get(id);
    if (prior2 && (!equal2(prior2.payload, row.payload) || prior2.entityKey !== row.entityKey)) throw backupError("BACKUP_HISTORY_SNAPSHOT_CONFLICT");
    if (!prior2) snapshotById.set(id, row);
  }
  if (snapshotChanges.length && owner.ownerKind !== "account") throw backupError("BACKUP_OWNER_MISMATCH");
  for (const mutation of snapshotChanges) {
    const payload = validateHistorySnapshotPayload(mutation.payload);
    if (mutation.entityKey !== `history_snapshot:${payload.snapshotId}` || payload.accountGeneration !== owner.accountGeneration) throw backupError("BACKUP_OWNER_MISMATCH");
    const decoded = await content(payload.reference);
    await validateHistorySnapshotBinding(payload, decoded.value, { accountGeneration: owner.accountGeneration });
    const stored = snapshot.history_snapshots.find((row) => row.snapshotId === payload.snapshotId);
    const retired = snapshot.entity_tombstones.some((row) => row.entityKind === "history_snapshot" && row.entityId === payload.snapshotId && row.status === "confirmed");
    if (stored && !equal2(stored, payload) || !stored && !retired) throw backupError("BACKUP_HISTORY_SNAPSHOT_DEPENDENCY");
  }
  for (const stored of snapshot.history_snapshots) {
    if (owner.ownerKind !== "account" || stored.accountGeneration !== owner.accountGeneration) throw backupError("BACKUP_OWNER_MISMATCH");
    const mutation = snapshotById.get(stored.snapshotId);
    if (!mutation || mutation.entityKey !== `history_snapshot:${stored.snapshotId}` || !equal2(mutation.payload, stored)) throw backupError("BACKUP_HISTORY_SNAPSHOT_DEPENDENCY");
  }
  const bankChanges = learningReferences.filter((row) => row.kind === "bank_revision" || row.kind === "content_manifest");
  const resolvedBanks = /* @__PURE__ */ new Map();
  const resolveBank = async (bankUid, revision) => {
    const key2 = `${bankUid}@${revision}`;
    if (!resolvedBanks.has(key2)) {
      const resolved = await resolveImmutableBank({
        bankUid,
        bankRevision: revision,
        readBankRevision: async (uid, rev2) => snapshot.bank_revisions.find((row) => row.bankUid === uid && row.revision === rev2) || null,
        sourceChanges: async (uid, rev2) => bankChanges.filter((row) => row.kind === "bank_revision" ? row.payload?.bankUid === uid && row.payload?.revision === rev2 : row.payload?.reference?.contentDigest === rev2),
        readContent: async (reference) => content(reference)
      });
      resolvedBanks.set(key2, resolved);
    }
    return resolvedBanks.get(key2);
  };
  for (const bank of snapshot.bank_revisions) {
    try {
      await resolveBank(bank.bankUid, bank.revision);
    } catch (cause) {
      throw backupError(cause?.code === "HISTORY_BANK_CONTENT_REFERENCE" || cause?.code === "HISTORY_BANK_SOURCE_MISSING" ? "BACKUP_CONTENT_MISSING" : "BACKUP_BANK_BINDING");
    }
  }
  for (const mutation of snapshotById.values()) {
    const body = (await content(mutation.payload.reference)).value;
    for (const entry of body.scope) for (const ref of entry.equivalentSourceRefs) {
      const [bankUid] = ref.questionKey.split("/");
      let resolved;
      try {
        resolved = await resolveBank(bankUid, ref.bankRevision);
      } catch {
        throw backupError("BACKUP_HISTORY_SNAPSHOT_BANK_MISSING");
      }
      if (!resolved || !resolved.questionRefs.some((question) => question.questionKey === ref.questionKey && question.questionRevision === ref.questionRevision)) throw backupError("BACKUP_HISTORY_SNAPSHOT_QUESTION_MISSING");
    }
  }
  const attemptIds = new Set(snapshot.attempts.map((row) => row.attemptId));
  const readSnapshotBaseline = createSnapshotBaselineReader({
    owner,
    references: learningReferences,
    readSnapshotRecord: async (id) => snapshot.history_snapshots.find((row) => row.snapshotId === id),
    readTombstone: async (key2) => snapshot.entity_tombstones.find((row) => row.entityKey === key2),
    readBankRevision: async (uid, revision) => snapshot.bank_revisions.find((row) => row.bankUid === uid && row.revision === revision),
    readContent: content
  });
  async function historicalProof(contentDigest) {
    return loadHistoricalResumeProof({ references: learningReferences, attempts: snapshot.attempts, events: snapshot.answer_events, contentDigest, readSnapshotBaseline, readResumeContent: async (payload) => {
      const raw = chunks.get(`${payload.chunkManifestDigest}:0`);
      if (!raw) throw backupError("BACKUP_CONTENT_MISSING");
      const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
      validateChunkManifest(manifest);
      return content({ contentDigest: payload.contentDigest, manifestDigest: payload.chunkManifestDigest, chunkCount: manifest.chunkCount, totalBytes: manifest.totalBytes });
    } });
  }
  for (const receipt of snapshot.import_receipts.filter((row) => row.provenance?.format === "qb-fork-origin-v1")) {
    const p = validateForkOriginReceipt(receipt).provenance, original = snapshot.mutations.find((row) => row.mutationId === p.commandId), resumeId = await derivedId(p.commandId, "resume"), resume = snapshot.mutations.find((row) => row.mutationId === resumeId);
    if (!original || original.kind !== "attempt_manifest" || original.payload.attemptId !== p.childAttemptId || original.payload.parentAttemptId !== p.parentAttemptId || !resume || resume.kind !== "resume_state" || resume.payload.attemptId !== p.childAttemptId || resume.payload.localRevision !== 1) throw backupError("BACKUP_FORK_ORIGIN");
    const child = await historicalProof(resume.payload.contentDigest), parent = await historicalProof(p.parentResumeContentDigest);
    try {
      assertForkOriginProof(p, original.payload, child, parent);
    } catch (error) {
      throw backupError("BACKUP_FORK_ORIGIN");
    }
  }
  if ([...snapshot.attempt_scope, ...snapshot.drafts, ...snapshot.answer_events].some((row) => !attemptIds.has(row.attemptId))) throw backupError("BACKUP_ATTEMPT_DEPENDENCY");
  for (const attempt of snapshot.attempts) {
    const bundle = validateBundle({ attempt, scope: snapshot.attempt_scope.filter((row) => row.attemptId === attempt.attemptId).sort((a, b) => a.ordinal - b.ordinal), drafts: snapshot.drafts.filter((row) => row.attemptId === attempt.attemptId), events: snapshot.answer_events.filter((row) => row.attemptId === attempt.attemptId) });
    if (await sha256Hex(canonicalContentBytes(bundle.scope)) !== attempt.scopeDigest) throw backupError("BACKUP_SCOPE_DIGEST");
    const mutation = learningReferences.filter((row) => row.kind === "resume_state" && row.payload.attemptId === attempt.attemptId && row.payload.localRevision === attempt.localRevision).at(-1);
    if (!mutation) throw backupError("BACKUP_RESUME_MISSING");
    const raw = chunks.get(`${mutation.payload.chunkManifestDigest}:0`);
    if (!raw) throw backupError("BACKUP_CONTENT_MISSING");
    const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
    const ref = { contentDigest: mutation.payload.contentDigest, manifestDigest: mutation.payload.chunkManifestDigest, chunkCount: manifest.chunkCount, totalBytes: manifest.totalBytes };
    const decoded = await content(ref);
    const { attemptId, writerStreamId, scopeDigest, scopeCount, parentAttemptId } = attempt;
    const proof = await historicalProof(mutation.payload.contentDigest);
    const verification = await validateResumeDependencies(decoded.value, mutation.payload, decoded.manifest, bundle.events, { attemptId, writerStreamId, scopeDigest, scopeCount, ...parentAttemptId ? { parentAttemptId } : {} }, { parents: proof.parents, snapshotProofs: proof.snapshotProofs });
    if (verification.status !== "payload_verified") throw backupError("BACKUP_RESUME_DEPENDENCY");
    if (decoded.value.snapshotBaseline) {
      const baseline = decoded.value.snapshotBaseline;
      for (const receipt of snapshot.import_receipts.filter((row) => row.sourceId === "qb-snapshot-continuation-receipt-v1" && (row.sourceRecordId === baseline.continuationKey || row.provenance?.attemptId === attemptId))) await assertSnapshotContinuationReceipt(receipt, baseline, { attemptId, commandId: await deriveSnapshotContinuationCommandId(baseline.continuationKey) });
    }
    if (await sha256Hex(canonicalContentBytes(decoded.value)) !== await sha256Hex(canonicalContentBytes(resumeState({ ...bundle, ...decoded.value.snapshotBaseline ? { snapshotBaseline: decoded.value.snapshotBaseline } : {} }, mutation.payload.baseRevision)))) throw backupError("BACKUP_RESUME_FACT_MISMATCH");
  }
  for (const receipt of snapshot.import_receipts.filter((row) => row.sourceId === "qb-snapshot-continuation-receipt-v1")) {
    const id = receipt.provenance.attemptId, attempt = snapshot.attempts.find((row) => row.attemptId === id), current = attempt && learningReferences.filter((row) => row.kind === "resume_state" && row.payload.attemptId === id && row.payload.localRevision === attempt.localRevision).at(-1);
    if (!current) throw backupError("BACKUP_SNAPSHOT_RECEIPT_DEPENDENCY");
    const proof = await historicalProof(current.payload.contentDigest);
    if (!proof.root.state.snapshotBaseline) throw backupError("BACKUP_SNAPSHOT_RECEIPT_DEPENDENCY");
    await assertSnapshotContinuationReceipt(receipt, proof.root.state.snapshotBaseline, { attemptId: id, commandId: await deriveSnapshotContinuationCommandId(proof.root.state.snapshotBaseline.continuationKey) });
  }
  return snapshotManifest(snapshot);
}

// ../../task-11/report-release-integration/node_modules/fflate/esm/browser.js
var ch2 = {};
var wk = (function(c, id, msg, transfer, cb) {
  var w = new Worker(ch2[id] || (ch2[id] = URL.createObjectURL(new Blob([
    c + ';addEventListener("error",function(e){e=e.error;postMessage({$e$:[e.message,e.code,e.stack]})})'
  ], { type: "text/javascript" }))));
  w.onmessage = function(e) {
    var d = e.data, ed = d.$e$;
    if (ed) {
      var err2 = new Error(ed[0]);
      err2["code"] = ed[1];
      err2.stack = ed[2];
      cb(err2, null);
    } else
      cb(null, d);
  };
  w.postMessage(msg, transfer);
  return w;
});
var u8 = Uint8Array;
var u16 = Uint16Array;
var i32 = Int32Array;
var fleb = new u8([
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  1,
  1,
  1,
  1,
  2,
  2,
  2,
  2,
  3,
  3,
  3,
  3,
  4,
  4,
  4,
  4,
  5,
  5,
  5,
  5,
  0,
  /* unused */
  0,
  0,
  /* impossible */
  0
]);
var fdeb = new u8([
  0,
  0,
  0,
  0,
  1,
  1,
  2,
  2,
  3,
  3,
  4,
  4,
  5,
  5,
  6,
  6,
  7,
  7,
  8,
  8,
  9,
  9,
  10,
  10,
  11,
  11,
  12,
  12,
  13,
  13,
  /* unused */
  0,
  0
]);
var clim = new u8([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);
var freb = function(eb, start) {
  var b = new u16(31);
  for (var i = 0; i < 31; ++i) {
    b[i] = start += 1 << eb[i - 1];
  }
  var r = new i32(b[30]);
  for (var i = 1; i < 30; ++i) {
    for (var j = b[i]; j < b[i + 1]; ++j) {
      r[j] = j - b[i] << 5 | i;
    }
  }
  return { b, r };
};
var _a = freb(fleb, 2);
var fl = _a.b;
var revfl = _a.r;
fl[28] = 258, revfl[258] = 28;
var _b = freb(fdeb, 0);
var fd = _b.b;
var revfd = _b.r;
var rev = new u16(32768);
for (i = 0; i < 32768; ++i) {
  x = (i & 43690) >> 1 | (i & 21845) << 1;
  x = (x & 52428) >> 2 | (x & 13107) << 2;
  x = (x & 61680) >> 4 | (x & 3855) << 4;
  rev[i] = ((x & 65280) >> 8 | (x & 255) << 8) >> 1;
}
var x;
var i;
var hMap = (function(cd, mb, r) {
  var s = cd.length;
  var i = 0;
  var l = new u16(mb);
  for (; i < s; ++i) {
    if (cd[i])
      ++l[cd[i] - 1];
  }
  var le = new u16(mb);
  for (i = 1; i < mb; ++i) {
    le[i] = le[i - 1] + l[i - 1] << 1;
  }
  var co;
  if (r) {
    co = new u16(1 << mb);
    var rvb = 15 - mb;
    for (i = 0; i < s; ++i) {
      if (cd[i]) {
        var sv = i << 4 | cd[i];
        var r_1 = mb - cd[i];
        var v = le[cd[i] - 1]++ << r_1;
        for (var m = v | (1 << r_1) - 1; v <= m; ++v) {
          co[rev[v] >> rvb] = sv;
        }
      }
    }
  } else {
    co = new u16(s);
    for (i = 0; i < s; ++i) {
      if (cd[i]) {
        co[i] = rev[le[cd[i] - 1]++] >> 15 - cd[i];
      }
    }
  }
  return co;
});
var flt = new u8(288);
for (i = 0; i < 144; ++i)
  flt[i] = 8;
var i;
for (i = 144; i < 256; ++i)
  flt[i] = 9;
var i;
for (i = 256; i < 280; ++i)
  flt[i] = 7;
var i;
for (i = 280; i < 288; ++i)
  flt[i] = 8;
var i;
var fdt = new u8(32);
for (i = 0; i < 32; ++i)
  fdt[i] = 5;
var i;
var flm = /* @__PURE__ */ hMap(flt, 9, 0);
var fdm = /* @__PURE__ */ hMap(fdt, 5, 0);
var shft = function(p) {
  return (p + 7) / 8 | 0;
};
var slc = function(v, s, e) {
  if (s == null || s < 0)
    s = 0;
  if (e == null || e > v.length)
    e = v.length;
  return new u8(v.subarray(s, e));
};
var ec = [
  "unexpected EOF",
  "invalid block type",
  "invalid length/literal",
  "invalid distance",
  "stream finished",
  "no stream handler",
  ,
  "no callback",
  "invalid UTF-8 data",
  "extra field too long",
  "date not in range 1980-2099",
  "filename too long",
  "stream finishing",
  "invalid zip data"
  // determined by unknown compression method
];
var err = function(ind, msg, nt) {
  var e = new Error(msg || ec[ind]);
  e.code = ind;
  if (Error.captureStackTrace)
    Error.captureStackTrace(e, err);
  if (!nt)
    throw e;
  return e;
};
var wbits = function(d, p, v) {
  v <<= p & 7;
  var o = p / 8 | 0;
  d[o] |= v;
  d[o + 1] |= v >> 8;
};
var wbits16 = function(d, p, v) {
  v <<= p & 7;
  var o = p / 8 | 0;
  d[o] |= v;
  d[o + 1] |= v >> 8;
  d[o + 2] |= v >> 16;
};
var hTree = function(d, mb) {
  var t = [];
  for (var i = 0; i < d.length; ++i) {
    if (d[i])
      t.push({ s: i, f: d[i] });
  }
  var s = t.length;
  var t2 = t.slice();
  if (!s)
    return { t: et, l: 0 };
  if (s == 1) {
    var v = new u8(t[0].s + 1);
    v[t[0].s] = 1;
    return { t: v, l: 1 };
  }
  t.sort(function(a, b) {
    return a.f - b.f;
  });
  t.push({ s: -1, f: 25001 });
  var l = t[0], r = t[1], i0 = 0, i1 = 1, i2 = 2;
  t[0] = { s: -1, f: l.f + r.f, l, r };
  while (i1 != s - 1) {
    l = t[t[i0].f < t[i2].f ? i0++ : i2++];
    r = t[i0 != i1 && t[i0].f < t[i2].f ? i0++ : i2++];
    t[i1++] = { s: -1, f: l.f + r.f, l, r };
  }
  var maxSym = t2[0].s;
  for (var i = 1; i < s; ++i) {
    if (t2[i].s > maxSym)
      maxSym = t2[i].s;
  }
  var tr = new u16(maxSym + 1);
  var mbt = ln(t[i1 - 1], tr, 0);
  if (mbt > mb) {
    var i = 0, dt = 0;
    var lft = mbt - mb, cst = 1 << lft;
    t2.sort(function(a, b) {
      return tr[b.s] - tr[a.s] || a.f - b.f;
    });
    for (; i < s; ++i) {
      var i2_1 = t2[i].s;
      if (tr[i2_1] > mb) {
        dt += cst - (1 << mbt - tr[i2_1]);
        tr[i2_1] = mb;
      } else
        break;
    }
    dt >>= lft;
    while (dt > 0) {
      var i2_2 = t2[i].s;
      if (tr[i2_2] < mb)
        dt -= 1 << mb - tr[i2_2]++ - 1;
      else
        ++i;
    }
    for (; i >= 0 && dt; --i) {
      var i2_3 = t2[i].s;
      if (tr[i2_3] == mb) {
        --tr[i2_3];
        ++dt;
      }
    }
    mbt = mb;
  }
  return { t: new u8(tr), l: mbt };
};
var ln = function(n, l, d) {
  return n.s == -1 ? Math.max(ln(n.l, l, d + 1), ln(n.r, l, d + 1)) : l[n.s] = d;
};
var lc = function(c) {
  var s = c.length;
  while (s && !c[--s])
    ;
  var cl = new u16(++s);
  var cli = 0, cln = c[0], cls = 1;
  var w = function(v) {
    cl[cli++] = v;
  };
  for (var i = 1; i <= s; ++i) {
    if (c[i] == cln && i != s)
      ++cls;
    else {
      if (!cln && cls > 2) {
        for (; cls > 138; cls -= 138)
          w(32754);
        if (cls > 2) {
          w(cls > 10 ? cls - 11 << 5 | 28690 : cls - 3 << 5 | 12305);
          cls = 0;
        }
      } else if (cls > 3) {
        w(cln), --cls;
        for (; cls > 6; cls -= 6)
          w(8304);
        if (cls > 2)
          w(cls - 3 << 5 | 8208), cls = 0;
      }
      while (cls--)
        w(cln);
      cls = 1;
      cln = c[i];
    }
  }
  return { c: cl.subarray(0, cli), n: s };
};
var clen = function(cf, cl) {
  var l = 0;
  for (var i = 0; i < cl.length; ++i)
    l += cf[i] * cl[i];
  return l;
};
var wfblk = function(out, pos, dat) {
  var s = dat.length;
  var o = shft(pos + 2);
  out[o] = s & 255;
  out[o + 1] = s >> 8;
  out[o + 2] = out[o] ^ 255;
  out[o + 3] = out[o + 1] ^ 255;
  for (var i = 0; i < s; ++i)
    out[o + i + 4] = dat[i];
  return (o + 4 + s) * 8;
};
var wblk = function(dat, out, final, syms, lf, df, eb, li, bs, bl, p) {
  wbits(out, p++, final);
  ++lf[256];
  var _a2 = hTree(lf, 15), dlt = _a2.t, mlb = _a2.l;
  var _b2 = hTree(df, 15), ddt = _b2.t, mdb = _b2.l;
  var _c = lc(dlt), lclt = _c.c, nlc = _c.n;
  var _d = lc(ddt), lcdt = _d.c, ndc = _d.n;
  var lcfreq = new u16(19);
  for (var i = 0; i < lclt.length; ++i)
    ++lcfreq[lclt[i] & 31];
  for (var i = 0; i < lcdt.length; ++i)
    ++lcfreq[lcdt[i] & 31];
  var _e = hTree(lcfreq, 7), lct = _e.t, mlcb = _e.l;
  var nlcc = 19;
  for (; nlcc > 4 && !lct[clim[nlcc - 1]]; --nlcc)
    ;
  var flen = bl + 5 << 3;
  var ftlen = clen(lf, flt) + clen(df, fdt) + eb;
  var dtlen = clen(lf, dlt) + clen(df, ddt) + eb + 14 + 3 * nlcc + clen(lcfreq, lct) + 2 * lcfreq[16] + 3 * lcfreq[17] + 7 * lcfreq[18];
  if (bs >= 0 && flen <= ftlen && flen <= dtlen)
    return wfblk(out, p, dat.subarray(bs, bs + bl));
  var lm, ll, dm, dl;
  wbits(out, p, 1 + (dtlen < ftlen)), p += 2;
  if (dtlen < ftlen) {
    lm = hMap(dlt, mlb, 0), ll = dlt, dm = hMap(ddt, mdb, 0), dl = ddt;
    var llm = hMap(lct, mlcb, 0);
    wbits(out, p, nlc - 257);
    wbits(out, p + 5, ndc - 1);
    wbits(out, p + 10, nlcc - 4);
    p += 14;
    for (var i = 0; i < nlcc; ++i)
      wbits(out, p + 3 * i, lct[clim[i]]);
    p += 3 * nlcc;
    var lcts = [lclt, lcdt];
    for (var it = 0; it < 2; ++it) {
      var clct = lcts[it];
      for (var i = 0; i < clct.length; ++i) {
        var len = clct[i] & 31;
        wbits(out, p, llm[len]), p += lct[len];
        if (len > 15)
          wbits(out, p, clct[i] >> 5 & 127), p += clct[i] >> 12;
      }
    }
  } else {
    lm = flm, ll = flt, dm = fdm, dl = fdt;
  }
  for (var i = 0; i < li; ++i) {
    var sym = syms[i];
    if (sym > 255) {
      var len = sym >> 18 & 31;
      wbits16(out, p, lm[len + 257]), p += ll[len + 257];
      if (len > 7)
        wbits(out, p, sym >> 23 & 31), p += fleb[len];
      var dst = sym & 31;
      wbits16(out, p, dm[dst]), p += dl[dst];
      if (dst > 3)
        wbits16(out, p, sym >> 5 & 8191), p += fdeb[dst];
    } else {
      wbits16(out, p, lm[sym]), p += ll[sym];
    }
  }
  wbits16(out, p, lm[256]);
  return p + ll[256];
};
var deo = /* @__PURE__ */ new i32([65540, 131080, 131088, 131104, 262176, 1048704, 1048832, 2114560, 2117632]);
var et = /* @__PURE__ */ new u8(0);
var dflt = function(dat, lvl, plvl, pre, post, st) {
  var s = st.z || dat.length;
  var o = new u8(pre + s + 5 * (1 + Math.ceil(s / 7e3)) + post);
  var w = o.subarray(pre, o.length - post);
  var lst = st.l;
  var pos = (st.r || 0) & 7;
  if (lvl) {
    if (pos)
      w[0] = st.r >> 3;
    var opt = deo[lvl - 1];
    var n = opt >> 13, c = opt & 8191;
    var msk_1 = (1 << plvl) - 1;
    var prev = st.p || new u16(32768), head = st.h || new u16(msk_1 + 1);
    var bs1_1 = Math.ceil(plvl / 3), bs2_1 = 2 * bs1_1;
    var hsh = function(i2) {
      return (dat[i2] ^ dat[i2 + 1] << bs1_1 ^ dat[i2 + 2] << bs2_1) & msk_1;
    };
    var syms = new i32(25e3);
    var lf = new u16(288), df = new u16(32);
    var lc_1 = 0, eb = 0, i = st.i || 0, li = 0, wi = st.w || 0, bs = 0;
    for (; i + 2 < s; ++i) {
      var hv = hsh(i);
      var imod = i & 32767, pimod = head[hv];
      prev[imod] = pimod;
      head[hv] = imod;
      if (wi <= i) {
        var rem = s - i;
        if ((lc_1 > 7e3 || li > 24576) && (rem > 423 || !lst)) {
          pos = wblk(dat, w, 0, syms, lf, df, eb, li, bs, i - bs, pos);
          li = lc_1 = eb = 0, bs = i;
          for (var j = 0; j < 286; ++j)
            lf[j] = 0;
          for (var j = 0; j < 30; ++j)
            df[j] = 0;
        }
        var l = 2, d = 0, ch_1 = c, dif = imod - pimod & 32767;
        if (rem > 2 && hv == hsh(i - dif)) {
          var maxn = Math.min(n, rem) - 1;
          var maxd = Math.min(32767, i);
          var ml = Math.min(258, rem);
          while (dif <= maxd && --ch_1 && imod != pimod) {
            if (dat[i + l] == dat[i + l - dif]) {
              var nl = 0;
              for (; nl < ml && dat[i + nl] == dat[i + nl - dif]; ++nl)
                ;
              if (nl > l) {
                l = nl, d = dif;
                if (nl > maxn)
                  break;
                var mmd = Math.min(dif, nl - 2);
                var md = 0;
                for (var j = 0; j < mmd; ++j) {
                  var ti = i - dif + j & 32767;
                  var pti = prev[ti];
                  var cd = ti - pti & 32767;
                  if (cd > md)
                    md = cd, pimod = ti;
                }
              }
            }
            imod = pimod, pimod = prev[imod];
            dif += imod - pimod & 32767;
          }
        }
        if (d) {
          syms[li++] = 268435456 | revfl[l] << 18 | revfd[d];
          var lin = revfl[l] & 31, din = revfd[d] & 31;
          eb += fleb[lin] + fdeb[din];
          ++lf[257 + lin];
          ++df[din];
          wi = i + l;
          ++lc_1;
        } else {
          syms[li++] = dat[i];
          ++lf[dat[i]];
        }
      }
    }
    for (i = Math.max(i, wi); i < s; ++i) {
      syms[li++] = dat[i];
      ++lf[dat[i]];
    }
    pos = wblk(dat, w, lst, syms, lf, df, eb, li, bs, i - bs, pos);
    if (!lst) {
      st.r = pos & 7 | w[pos / 8 | 0] << 3;
      pos -= 7;
      st.h = head, st.p = prev, st.i = i, st.w = wi;
    }
  } else {
    for (var i = st.w || 0; i < s + lst; i += 65535) {
      var e = i + 65535;
      if (e >= s) {
        w[pos / 8 | 0] = lst;
        e = s;
      }
      pos = wfblk(w, pos + 1, dat.subarray(i, e));
    }
    st.i = s;
  }
  return slc(o, 0, pre + shft(pos) + post);
};
var crct = /* @__PURE__ */ (function() {
  var t = new Int32Array(256);
  for (var i = 0; i < 256; ++i) {
    var c = i, k = 9;
    while (--k)
      c = (c & 1 && -306674912) ^ c >>> 1;
    t[i] = c;
  }
  return t;
})();
var crc = function() {
  var c = -1;
  return {
    p: function(d) {
      var cr = c;
      for (var i = 0; i < d.length; ++i)
        cr = crct[cr & 255 ^ d[i]] ^ cr >>> 8;
      c = cr;
    },
    d: function() {
      return ~c;
    }
  };
};
var dopt = function(dat, opt, pre, post, st) {
  if (!st) {
    st = { l: 1 };
    if (opt.dictionary) {
      var dict = opt.dictionary.subarray(-32768);
      var newDat = new u8(dict.length + dat.length);
      newDat.set(dict);
      newDat.set(dat, dict.length);
      dat = newDat;
      st.w = dict.length;
    }
  }
  return dflt(dat, opt.level == null ? 6 : opt.level, opt.mem == null ? st.l ? Math.ceil(Math.max(8, Math.min(13, Math.log(dat.length))) * 1.5) : 20 : 12 + opt.mem, pre, post, st);
};
var mrg = function(a, b) {
  var o = {};
  for (var k in a)
    o[k] = a[k];
  for (var k in b)
    o[k] = b[k];
  return o;
};
var wcln = function(fn, fnStr, td2) {
  var dt = fn();
  var st = fn.toString();
  var ks = st.slice(st.indexOf("[") + 1, st.lastIndexOf("]")).replace(/\s+/g, "").split(",");
  for (var i = 0; i < dt.length; ++i) {
    var v = dt[i], k = ks[i];
    if (typeof v == "function") {
      fnStr += ";" + k + "=";
      var st_1 = v.toString();
      if (v.prototype) {
        if (st_1.indexOf("[native code]") != -1) {
          var spInd = st_1.indexOf(" ", 8) + 1;
          fnStr += st_1.slice(spInd, st_1.indexOf("(", spInd));
        } else {
          fnStr += st_1;
          for (var t in v.prototype)
            fnStr += ";" + k + ".prototype." + t + "=" + v.prototype[t].toString();
        }
      } else
        fnStr += st_1;
    } else
      td2[k] = v;
  }
  return fnStr;
};
var ch = [];
var cbfs = function(v) {
  var tl = [];
  for (var k in v) {
    if (v[k].buffer) {
      tl.push((v[k] = new v[k].constructor(v[k])).buffer);
    }
  }
  return tl;
};
var wrkr = function(fns, init, id, cb) {
  if (!ch[id]) {
    var fnStr = "", td_1 = {}, m = fns.length - 1;
    for (var i = 0; i < m; ++i)
      fnStr = wcln(fns[i], fnStr, td_1);
    ch[id] = { c: wcln(fns[m], fnStr, td_1), e: td_1 };
  }
  var td2 = mrg({}, ch[id].e);
  return wk(ch[id].c + ";onmessage=function(e){for(var k in e.data)self[k]=e.data[k];onmessage=" + init.toString() + "}", id, td2, cbfs(td2), cb);
};
var bDflt = function() {
  return [u8, u16, i32, fleb, fdeb, clim, revfl, revfd, flm, flt, fdm, fdt, rev, deo, et, hMap, wbits, wbits16, hTree, ln, lc, clen, wfblk, wblk, shft, slc, dflt, dopt, deflateSync, pbf];
};
var pbf = function(msg) {
  return postMessage(msg, [msg.buffer]);
};
var astrm = function(strm) {
  strm.ondata = function(dat, final) {
    return postMessage([dat, final], [dat.buffer]);
  };
  return function(ev) {
    if (ev.data.length) {
      strm.push(ev.data[0], ev.data[1]);
      postMessage([ev.data[0].length]);
    } else
      strm.flush();
  };
};
var astrmify = function(fns, strm, opts, init, id, flush, ext) {
  var t;
  var w = wrkr(fns, init, id, function(err2, dat) {
    if (err2)
      w.terminate(), strm.ondata.call(strm, err2);
    else if (!Array.isArray(dat))
      ext(dat);
    else if (dat.length == 1) {
      strm.queuedSize -= dat[0];
      if (strm.ondrain)
        strm.ondrain(dat[0]);
    } else {
      if (dat[1])
        w.terminate();
      strm.ondata.call(strm, err2, dat[0], dat[1]);
    }
  });
  w.postMessage(opts);
  strm.queuedSize = 0;
  strm.push = function(d, f) {
    if (!strm.ondata)
      err(5);
    if (t)
      strm.ondata(err(4, 0, 1), null, !!f);
    strm.queuedSize += d.length;
    w.postMessage([d, t = f], [d.buffer]);
  };
  strm.terminate = function() {
    w.terminate();
  };
  if (flush) {
    strm.flush = function() {
      w.postMessage([]);
    };
  }
};
var wbytes = function(d, b, v) {
  for (; v; ++b)
    d[b] = v, v >>>= 8;
};
function StrmOpt(opts, cb) {
  if (typeof opts == "function")
    cb = opts, opts = {};
  this.ondata = cb;
  return opts;
}
var Deflate = /* @__PURE__ */ (function() {
  function Deflate2(opts, cb) {
    if (typeof opts == "function")
      cb = opts, opts = {};
    this.ondata = cb;
    this.o = opts || {};
    this.s = { l: 0, i: 32768, w: 32768, z: 32768 };
    this.b = new u8(98304);
    if (this.o.dictionary) {
      var dict = this.o.dictionary.subarray(-32768);
      this.b.set(dict, 32768 - dict.length);
      this.s.i = 32768 - dict.length;
    }
  }
  Deflate2.prototype.p = function(c, f) {
    this.ondata(dopt(c, this.o, 0, 0, this.s), f);
  };
  Deflate2.prototype.push = function(chunk, final) {
    if (!this.ondata)
      err(5);
    if (this.s.l)
      err(4);
    var endLen = chunk.length + this.s.z;
    if (endLen > this.b.length) {
      if (endLen > 2 * this.b.length - 32768) {
        var newBuf = new u8(endLen & -32768);
        newBuf.set(this.b.subarray(0, this.s.z));
        this.b = newBuf;
      }
      var split = this.b.length - this.s.z;
      this.b.set(chunk.subarray(0, split), this.s.z);
      this.s.z = this.b.length;
      this.p(this.b, false);
      this.b.set(this.b.subarray(-32768));
      this.b.set(chunk.subarray(split), 32768);
      this.s.z = chunk.length - split + 32768;
      this.s.i = 32766, this.s.w = 32768;
    } else {
      this.b.set(chunk, this.s.z);
      this.s.z += chunk.length;
    }
    this.s.l = final & 1;
    if (this.s.z > this.s.w + 8191 || final) {
      this.p(this.b, final || false);
      this.s.w = this.s.i, this.s.i -= 2;
    }
  };
  Deflate2.prototype.flush = function() {
    if (!this.ondata)
      err(5);
    if (this.s.l)
      err(4);
    this.p(this.b, false);
    this.s.w = this.s.i, this.s.i -= 2;
  };
  return Deflate2;
})();
var AsyncDeflate = /* @__PURE__ */ (function() {
  function AsyncDeflate2(opts, cb) {
    astrmify([
      bDflt,
      function() {
        return [astrm, Deflate];
      }
    ], this, StrmOpt.call(this, opts, cb), function(ev) {
      var strm = new Deflate(ev.data);
      onmessage = astrm(strm);
    }, 6, 1);
  }
  return AsyncDeflate2;
})();
function deflateSync(data, opts) {
  return dopt(data, opts || {}, 0, 0);
}
var te = typeof TextEncoder != "undefined" && /* @__PURE__ */ new TextEncoder();
var td = typeof TextDecoder != "undefined" && /* @__PURE__ */ new TextDecoder();
var tds = 0;
try {
  td.decode(et, { stream: true });
  tds = 1;
} catch (e) {
}
function strToU8(str, latin1) {
  if (latin1) {
    var ar_1 = new u8(str.length);
    for (var i = 0; i < str.length; ++i)
      ar_1[i] = str.charCodeAt(i);
    return ar_1;
  }
  if (te)
    return te.encode(str);
  var l = str.length;
  var ar = new u8(str.length + (str.length >> 1));
  var ai = 0;
  var w = function(v) {
    ar[ai++] = v;
  };
  for (var i = 0; i < l; ++i) {
    if (ai + 5 > ar.length) {
      var n = new u8(ai + 8 + (l - i << 1));
      n.set(ar);
      ar = n;
    }
    var c = str.charCodeAt(i);
    if (c < 128 || latin1)
      w(c);
    else if (c < 2048)
      w(192 | c >> 6), w(128 | c & 63);
    else if (c > 55295 && c < 57344)
      c = 65536 + (c & 1023 << 10) | str.charCodeAt(++i) & 1023, w(240 | c >> 18), w(128 | c >> 12 & 63), w(128 | c >> 6 & 63), w(128 | c & 63);
    else
      w(224 | c >> 12), w(128 | c >> 6 & 63), w(128 | c & 63);
  }
  return slc(ar, 0, ai);
}
var dbf = function(l) {
  return l == 1 ? 3 : l < 6 ? 2 : l == 9 ? 1 : 0;
};
var exfl = function(ex) {
  var le = 0;
  if (ex) {
    for (var k in ex) {
      var l = ex[k].length;
      if (l > 65535)
        err(9);
      le += l + 4;
    }
  }
  return le;
};
var wzh = function(d, b, f, fn, u, c, ce, co) {
  var fl2 = fn.length, ex = f.extra, col = co && co.length;
  var exl = exfl(ex);
  wbytes(d, b, ce != null ? 33639248 : 67324752), b += 4;
  if (ce != null)
    d[b++] = 20, d[b++] = f.os;
  d[b] = 20, b += 2;
  d[b++] = f.flag << 1 | (c < 0 && 8), d[b++] = u && 8;
  d[b++] = f.compression & 255, d[b++] = f.compression >> 8;
  var dt = new Date(f.mtime == null ? Date.now() : f.mtime), y = dt.getFullYear() - 1980;
  if (y < 0 || y > 119)
    err(10);
  wbytes(d, b, y << 25 | dt.getMonth() + 1 << 21 | dt.getDate() << 16 | dt.getHours() << 11 | dt.getMinutes() << 5 | dt.getSeconds() >> 1), b += 4;
  if (c != -1) {
    wbytes(d, b, f.crc);
    wbytes(d, b + 4, c < 0 ? -c - 2 : c);
    wbytes(d, b + 8, f.size);
  }
  wbytes(d, b + 12, fl2);
  wbytes(d, b + 14, exl), b += 16;
  if (ce != null) {
    wbytes(d, b, col);
    wbytes(d, b + 6, f.attrs);
    wbytes(d, b + 10, ce), b += 14;
  }
  d.set(fn, b);
  b += fl2;
  if (exl) {
    for (var k in ex) {
      var exf = ex[k], l = exf.length;
      wbytes(d, b, +k);
      wbytes(d, b + 2, l);
      d.set(exf, b + 4), b += 4 + l;
    }
  }
  if (col)
    d.set(co, b), b += col;
  return b;
};
var wzf = function(o, b, c, d, e) {
  wbytes(o, b, 101010256);
  wbytes(o, b + 8, c);
  wbytes(o, b + 10, c);
  wbytes(o, b + 12, d);
  wbytes(o, b + 16, e);
};
var ZipPassThrough = /* @__PURE__ */ (function() {
  function ZipPassThrough2(filename) {
    this.filename = filename;
    this.c = crc();
    this.size = 0;
    this.compression = 0;
  }
  ZipPassThrough2.prototype.process = function(chunk, final) {
    this.ondata(null, chunk, final);
  };
  ZipPassThrough2.prototype.push = function(chunk, final) {
    if (!this.ondata)
      err(5);
    this.c.p(chunk);
    this.size += chunk.length;
    if (final)
      this.crc = this.c.d();
    this.process(chunk, final || false);
  };
  return ZipPassThrough2;
})();
var AsyncZipDeflate = /* @__PURE__ */ (function() {
  function AsyncZipDeflate2(filename, opts) {
    var _this = this;
    if (!opts)
      opts = {};
    ZipPassThrough.call(this, filename);
    this.d = new AsyncDeflate(opts, function(err2, dat, final) {
      _this.ondata(err2, dat, final);
    });
    this.compression = 8;
    this.flag = dbf(opts.level);
    this.terminate = this.d.terminate;
  }
  AsyncZipDeflate2.prototype.process = function(chunk, final) {
    this.d.push(chunk, final);
  };
  AsyncZipDeflate2.prototype.push = function(chunk, final) {
    ZipPassThrough.prototype.push.call(this, chunk, final);
  };
  return AsyncZipDeflate2;
})();
var Zip = /* @__PURE__ */ (function() {
  function Zip2(cb) {
    this.ondata = cb;
    this.u = [];
    this.d = 1;
  }
  Zip2.prototype.add = function(file) {
    var _this = this;
    if (!this.ondata)
      err(5);
    if (this.d & 2)
      this.ondata(err(4 + (this.d & 1) * 8, 0, 1), null, false);
    else {
      var f = strToU8(file.filename), fl_1 = f.length;
      var com = file.comment, o = com && strToU8(com);
      var u = fl_1 != file.filename.length || o && com.length != o.length;
      var hl_1 = fl_1 + exfl(file.extra) + 30;
      if (fl_1 > 65535)
        this.ondata(err(11, 0, 1), null, false);
      var header2 = new u8(hl_1);
      wzh(header2, 0, file, f, u, -1);
      var chks_1 = [header2];
      var pAll_1 = function() {
        for (var _i = 0, chks_2 = chks_1; _i < chks_2.length; _i++) {
          var chk = chks_2[_i];
          _this.ondata(null, chk, false);
        }
        chks_1 = [];
      };
      var tr_1 = this.d;
      this.d = 0;
      var ind_1 = this.u.length;
      var uf_1 = mrg(file, {
        f,
        u,
        o,
        t: function() {
          if (file.terminate)
            file.terminate();
        },
        r: function() {
          pAll_1();
          if (tr_1) {
            var nxt = _this.u[ind_1 + 1];
            if (nxt)
              nxt.r();
            else
              _this.d = 1;
          }
          tr_1 = 1;
        }
      });
      var cl_1 = 0;
      file.ondata = function(err2, dat, final) {
        if (err2) {
          _this.ondata(err2, dat, final);
          _this.terminate();
        } else {
          cl_1 += dat.length;
          chks_1.push(dat);
          if (final) {
            var dd = new u8(16);
            wbytes(dd, 0, 134695760);
            wbytes(dd, 4, file.crc);
            wbytes(dd, 8, cl_1);
            wbytes(dd, 12, file.size);
            chks_1.push(dd);
            uf_1.c = cl_1, uf_1.b = hl_1 + cl_1 + 16, uf_1.crc = file.crc, uf_1.size = file.size;
            if (tr_1)
              uf_1.r();
            tr_1 = 1;
          } else if (tr_1)
            pAll_1();
        }
      };
      this.u.push(uf_1);
    }
  };
  Zip2.prototype.end = function() {
    var _this = this;
    if (this.d & 2) {
      this.ondata(err(4 + (this.d & 1) * 8, 0, 1), null, true);
      return;
    }
    if (this.d)
      this.e();
    else
      this.u.push({
        r: function() {
          if (!(_this.d & 1))
            return;
          _this.u.splice(-1, 1);
          _this.e();
        },
        t: function() {
        }
      });
    this.d = 3;
  };
  Zip2.prototype.e = function() {
    var bt = 0, l = 0, tl = 0;
    for (var _i = 0, _a2 = this.u; _i < _a2.length; _i++) {
      var f = _a2[_i];
      tl += 46 + f.f.length + exfl(f.extra) + (f.o ? f.o.length : 0);
    }
    var out = new u8(tl + 22);
    for (var _b2 = 0, _c = this.u; _b2 < _c.length; _b2++) {
      var f = _c[_b2];
      wzh(out, bt, f, f.f, f.u, -f.c - 2, l, f.o);
      bt += 46 + f.f.length + exfl(f.extra) + (f.o ? f.o.length : 0), l += f.b;
    }
    wzf(out, bt, this.u.length, tl, l);
    this.ondata(null, out, true);
    this.d = 2;
  };
  Zip2.prototype.terminate = function() {
    for (var _i = 0, _a2 = this.u; _i < _a2.length; _i++) {
      var f = _a2[_i];
      f.t();
    }
    this.d = 2;
  };
  return Zip2;
})();

// src/storage/backup/archive.js
var encoder2 = new TextEncoder();
var decoder = () => new TextDecoder("utf-8", { fatal: true });
var concat = (parts) => {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
};
var yieldTurn = () => new Promise((resolve) => setTimeout(resolve, 0));
var guard = (signal) => {
  if (signal?.aborted) throw backupError("CLOSED");
};
async function encodeBackup(snapshot, { owner, sourceProfileHint = "", appVersion = "qb-v2-local", signal } = {}) {
  const binding2 = snapshotOwner(owner);
  snapshot = ownSnapshot(snapshot);
  await validateSnapshot(snapshot, binding2);
  guard(signal);
  const files = [], sections = [];
  async function add(path, bytes, count) {
    if (bytes.length > LIMITS.fileBytes) throw backupError("BACKUP_BUDGET_EXCEEDED");
    files.push({ path, bytes });
    sections.push({ path, count, utf8Bytes: bytes.length, sha256: await sha256Hex(bytes) });
  }
  await add("owner.json", canonicalBytes(binding2), 1);
  for (const name of STORE_NAMES) {
    const lines = [];
    let fileSize = 0, part = 0, rows = 0;
    const flush = async () => {
      await add(`stores/${name}-${part++}.ndjson`, concat(lines.splice(0)), rows);
      rows = 0;
      fileSize = 0;
    };
    const values = ["writer_leases", "meta"].includes(name) ? [] : name === "import_receipts" ? snapshot[name].filter((row) => !row.sourceId.startsWith("qb-sync-v2:") || row.provenance?.format === "qb-sync-change-v1") : snapshot[name];
    for (const row of values) {
      guard(signal);
      let serial = row;
      if (name === "content_chunks") {
        const path = `content/${row.contentDigest}-${row.chunkIndex}.bin`;
        await add(path, row.bytes, 1);
        serial = { contentDigest: row.contentDigest, chunkIndex: row.chunkIndex, binaryPath: path };
      }
      const bytes = encoder2.encode(`${decoder().decode(canonicalBytes(serial))}
`);
      if (fileSize && fileSize + bytes.length > LIMITS.fileBytes) await flush();
      lines.push(bytes);
      fileSize += bytes.length;
      rows++;
    }
    await flush();
  }
  const manifest = {
    format: "qb-appdata-v2",
    schemaVersion: 2,
    storeSetVersion: 2,
    exportId: crypto.randomUUID(),
    appVersion,
    sourceProfileHint,
    sections,
    legacySourceDigests: [],
    complete: true,
    partial: false,
    coverage: { facts: true, attempts: true, drafts: true, mutations: true, outbox: true, conflicts: true, tombstones: true, legacy: true, content: true },
    partialReasons: []
  };
  validateExportManifest2(manifest);
  const expanded = files.reduce((sum, file) => sum + file.bytes.length, 0);
  if (expanded > LIMITS.expandedBytes || files.length + 1 > LIMITS.entries) throw backupError("BACKUP_BUDGET_EXCEEDED");
  files.push({ path: "manifest.json", bytes: canonicalBytes(manifest) });
  const parts = [];
  let archiveSize = 0, zip, pendingEntryReject, firstFailure;
  const abort = () => {
    const error = firstFailure ??= backupError("CLOSED");
    zip?.terminate();
    pendingEntryReject?.(error);
    rejectArchive?.(error);
  };
  let rejectArchive;
  const complete = new Promise((resolve, reject) => {
    rejectArchive = reject;
    zip = new Zip((error, bytes, final) => {
      if (error) {
        firstFailure ??= error;
        pendingEntryReject?.(firstFailure);
        reject(firstFailure);
        return;
      }
      archiveSize += bytes.length;
      if (archiveSize > LIMITS.archiveBytes || signal?.aborted) {
        firstFailure ??= backupError(signal?.aborted ? "CLOSED" : "BACKUP_BUDGET_EXCEEDED");
        zip.terminate();
        pendingEntryReject?.(firstFailure);
        reject(firstFailure);
        return;
      }
      parts.push(bytes);
      if (final) resolve();
    });
  });
  void complete.catch(() => {
  });
  signal?.addEventListener("abort", abort, { once: true });
  try {
    guard(signal);
    for (const file of files) {
      guard(signal);
      const stream = new AsyncZipDeflate(file.path, { level: 6 });
      zip.add(stream);
      const entryDone = new Promise((resolve, reject) => {
        pendingEntryReject = reject;
        const forward = stream.ondata;
        stream.ondata = (error, bytes, final) => {
          if (error) firstFailure ??= error;
          forward(error, bytes, final);
          if (error) reject(firstFailure);
          else if (final) resolve();
        };
      });
      void entryDone.catch(() => {
      });
      const length = file.bytes.length;
      if (!length) stream.push(new Uint8Array(), true);
      else for (let offset = 0; offset < length; offset += 256 * 1024) {
        stream.push(file.bytes.slice(offset, offset + 256 * 1024), offset + 256 * 1024 >= length);
        await yieldTurn();
        guard(signal);
      }
      await entryDone;
      pendingEntryReject = void 0;
    }
    zip.end();
    await complete;
    return { blob: new Blob(parts, { type: "application/zip" }), manifest, owner: binding2 };
  } catch (error) {
    zip.terminate();
    throw firstFailure ?? error;
  } finally {
    signal?.removeEventListener("abort", abort);
    pendingEntryReject = void 0;
  }
}

// src/storage/profiles/write-lock.js
var keyPattern = /^qb-profile-write:qb-(?:v2|b1a-test)-control-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function validateProfileWriteLockKey(key2) {
  if (typeof key2 !== "string" || !keyPattern.test(key2)) throw storageError("INVALID_INPUT", "invalid profile lock key");
  return key2;
}
async function withProfileWriteLock(key2, mode, work, { signal, timeoutMs = 5e3 } = {}) {
  validateProfileWriteLockKey(key2);
  if (!["shared", "exclusive"].includes(mode) || typeof work !== "function" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) throw storageError("INVALID_INPUT", "invalid profile lock request");
  if (!globalThis.navigator?.locks?.request) throw storageError("STORAGE_LOCKS_UNAVAILABLE", "native Web Locks are required");
  const cancellation = new AbortController();
  let acquired = false, timedOut = false;
  const cancel = () => cancellation.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(() => {
    if (!acquired) {
      timedOut = true;
      cancel();
    }
  }, timeoutMs);
  try {
    return await navigator.locks.request(key2, { mode, signal: cancellation.signal }, async () => {
      acquired = true;
      clearTimeout(timer);
      if (signal?.aborted) throw storageError("CLOSED", "profile lock cancelled");
      return work();
    });
  } catch (error) {
    if (!acquired && cancellation.signal.aborted) throw storageError(timedOut ? "LOCK_WAIT_TIMEOUT" : "CLOSED", timedOut ? "profile lock wait expired" : "profile lock cancelled", error);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancel);
  }
}

// src/browser/old-origin-native-export.js
var sourceWindowId = crypto.randomUUID();
var generatedCaptures = /* @__PURE__ */ new Map();
function assertOriginalCapture(receipt) {
  const actual = generatedCaptures.get(receipt?.manifestDigest);
  if (!actual || !same4(actual, receipt)) throw fail17("SOURCE_WINDOW_OR_CAPTURE_REEXPORT");
  return true;
}
var fail17 = (code) => Object.assign(new Error(code), { code });
var key = (owner) => JSON.stringify(owner.ownerKind === "guest" ? ["guest", owner.guestId] : ["account", owner.accountId, owner.accountGeneration]);
var same4 = (a, b) => new TextDecoder().decode(canonicalBytes(a)) === new TextDecoder().decode(canonicalBytes(b));
async function existing(name) {
  if (!(await indexedDB.databases()).some((r) => r.name === name)) throw fail17("SOURCE_DATABASE_MISSING");
  let late = false, timer;
  const opening = openDB(name, void 0, { upgrade(_db, _old, _new, tx) {
    tx.abort();
  } });
  opening.then((db) => {
    if (late) db.close();
  }, () => {
  });
  try {
    return await Promise.race([opening, new Promise((_, reject) => {
      timer = setTimeout(() => {
        late = true;
        reject(fail17("SOURCE_OPEN_TIMEOUT"));
      }, 5e3);
    })]);
  } finally {
    clearTimeout(timer);
  }
}
async function bindings() {
  const db = await existing("qb-v2-profile-directory");
  try {
    if (db.version !== 1 || db.objectStoreNames.length !== 2 || !db.objectStoreNames.contains("owners") || !db.objectStoreNames.contains("meta")) throw fail17("SOURCE_DIRECTORY_SCHEMA");
    const tx = db.transaction("owners", "readonly");
    const rows = [];
    let cursor = await tx.store.openCursor();
    while (cursor) {
      if (rows.length >= 128) throw fail17("SOURCE_OWNER_BUDGET");
      rows.push(cursor.value);
      cursor = await cursor.continue();
    }
    await tx.done;
    for (const r of rows) {
      const owner = snapshotOwner(r.owner);
      if (r.key !== key(owner) || !["initializing", "ready", "locked", "failed", "cleanup_pending", "deleted"].includes(r.state)) throw fail17("SOURCE_DIRECTORY_CORRUPT");
      controlDbName(r.controlId, "production");
    }
    return rows;
  } finally {
    db.close();
  }
}
async function cut(binding2) {
  const name = controlDbName(binding2.controlId, "production"), db = await existing(name);
  try {
    if (db.version !== 1 || db.objectStoreNames.length !== 2 || !db.objectStoreNames.contains("profiles") || !db.objectStoreNames.contains("meta")) throw fail17("SOURCE_CONTROL_SCHEMA");
    const tx = db.transaction(["profiles", "meta"], "readonly"), p = tx.objectStore("profiles"), m = tx.objectStore("meta");
    const pointer = await m.get("activeProfile");
    validateActiveProfilePointer2(pointer);
    const raw = await p.get(pointer.activeProfileId), journal = await m.get("fresh:" + pointer.activeProfileId);
    await tx.done;
    const pair = validateProfileJournalPair(raw, journal);
    if (pair.phase !== "completed" || pair.profile.profileId !== pointer.activeProfileId || !sameOwner(pair.owner, binding2.owner) || await canonicalDigest(pair.manifest) !== pair.verification.contentDigest) throw fail17("SOURCE_CONTROL_CORRUPT");
    return { pointer, profile: pair.profile, journal };
  } finally {
    db.close();
  }
}
async function inventoryOldNativeProfiles() {
  let rows;
  try {
    rows = await bindings();
  } catch (e) {
    if (e.code === "SOURCE_DATABASE_MISSING") return [];
    throw e;
  }
  return Promise.all(rows.map(async (r) => {
    const item = { key: r.key, owner: r.owner, state: r.state, controlId: r.controlId };
    if (r.state !== "ready") return { ...item, exportable: false, reason: "OWNER_NOT_READY_SOURCE_RETAINED" };
    try {
      const c = await cut(r);
      return { ...item, exportable: true, profileId: c.profile.profileId, activationRevision: c.pointer.activationRevision };
    } catch (e) {
      return { ...item, exportable: false, reason: e.code || e.message };
    }
  }));
}
async function exportOldNativeProfile(ownerKey) {
  const rows = await bindings(), binding2 = rows.find((r) => r.key === ownerKey);
  if (!binding2 || binding2.state !== "ready") throw fail17("SOURCE_OWNER_NOT_READY");
  const name = controlDbName(binding2.controlId, "production");
  return withProfileWriteLock("qb-profile-write:" + name, "exclusive", async () => {
    const before2 = await cut(binding2), snapshot = await captureProfile(before2.profile);
    if (snapshot.writer_leases.some((r) => r.expiresAt > Date.now())) throw fail17("SOURCE_WRITER_ACTIVE_CLOSE_PRACTICE_TABS");
    const verified = await validateSnapshot(snapshot, binding2.owner);
    const archive = await encodeBackup(snapshot, { owner: binding2.owner, sourceProfileHint: before2.profile.profileId, appVersion: "old-origin-export-only" });
    const latest = await captureProfile(before2.profile), again = await cut(binding2), current = (await bindings()).find((r) => r.key === ownerKey);
    if (!current || !same4(current, binding2) || !same4(before2, again) || (await validateSnapshot(latest, binding2.owner)).contentDigest !== verified.contentDigest) throw fail17("SOURCE_CHANGED_EXPORT_RETRY");
    const receipt = { format: "qb-old-native-export-v1", sourceOrigin: location.origin, sourceWindowId, owner: binding2.owner, controlId: binding2.controlId, profileId: before2.profile.profileId, activationRevision: before2.pointer.activationRevision, sourceContentDigest: verified.contentDigest, manifestDigest: await canonicalDigest(archive.manifest), archiveZipDigest: await sha256Hex(new Uint8Array(await archive.blob.arrayBuffer())), archiveZipBytes: archive.blob.size, sections: archive.manifest.sections, sourceRetained: true, exclusiveLockDuringCapture: true, permanentWriterFence: false, accountActivation: "cloud-recovery-only; file quarantine" };
    generatedCaptures.set(receipt.manifestDigest, structuredClone(receipt));
    if (generatedCaptures.size > 128) generatedCaptures.delete(generatedCaptures.keys().next().value);
    return { ...archive, receipt };
  });
}
export {
  assertOriginalCapture,
  exportOldNativeProfile,
  inventoryOldNativeProfiles
};
