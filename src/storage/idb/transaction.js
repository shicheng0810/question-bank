/**
 * T07a's transaction boundary deliberately accepts only synchronous work.
 * Request promises may be created inside the callback, but a callback may not
 * return one: `tx.done` is the only commit signal this layer exposes.
 */

/** @param {string} code @param {string} message @param {unknown} [cause] */
export function storageError(code, message, cause) {
  const error = new Error(message);
  error.name = "StorageError";
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

/** @param {unknown} value */
function isThenable(value) {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;
  return typeof value.then === "function";
}

/** @param {IDBTransaction} transaction */
function abortQuietly(transaction) {
  try { transaction.abort(); } catch { /* a completed transaction cannot be aborted */ }
}

/** @param {unknown} value @param {Set<Promise<unknown>>} requests */
function observeRequest(value, requests) {
  if (!isThenable(value)) return value;
  const request = Promise.resolve(value);
  // `idb` turns every IDBRequest into a Promise. Attach a handler immediately
  // even if the callback deliberately ignores its return value.
  request.catch(() => {});
  requests.add(request);
  return value;
}

const READ_METHODS = ["get", "getAll", "getKey", "getAllKeys", "count"];
const WRITE_METHODS = ["put", "add", "delete", "clear"];

/** @param {import("idb").IDBPIndex} index @param {Set<Promise<unknown>>} requests */
function indexFacade(index, requests) {
  return Object.freeze(Object.fromEntries(READ_METHODS.map((name) => [name, (...args) => observeRequest(index[name](...args), requests)])));
}

/** @param {import("idb").IDBPObjectStore} store @param {Set<Promise<unknown>>} requests */
function storeFacade(store, requests) {
  const allowed = [...READ_METHODS, ...WRITE_METHODS];
  return Object.freeze({
    ...Object.fromEntries(allowed.map((name) => [name, (...args) => observeRequest(store[name](...args), requests)])),
    index: (name) => indexFacade(store.index(name), requests)
  });
}

/** @param {import("idb").IDBPTransaction} transaction @param {Set<Promise<unknown>>} requests */
function transactionFacade(transaction, requests) {
  return Object.freeze({
    abort: () => transaction.abort(),
    store: transaction.store === undefined ? undefined : storeFacade(transaction.store, requests),
    objectStore: (name) => storeFacade(transaction.objectStore(name), requests)
  });
}

/**
 * @param {{ db: import("idb").IDBPDatabase, assertOpen: () => void, track: (tx: import("idb").IDBPTransaction) => void, untrack: (tx: import("idb").IDBPTransaction) => void }} controller
 * @param {string|string[]} storeNames
 * @param {IDBTransactionMode} mode
 * Read requests are observed, but their values are not returned through this
 * synchronous T07a callback. T07b owns repository/CAS read-modify-write APIs.
 * @param {(tx: {abort:()=>void, store?: object, objectStore:(name:string)=>object}) => unknown} work
 */
export async function runIdbTransaction(controller, storeNames, mode, work) {
  controller.assertOpen();
  if (typeof work !== "function") throw storageError("INVALID", "transaction work must be a function");

  let tx;
  try {
    tx = controller.db.transaction(storeNames, mode);
  } catch (cause) {
    throw storageError("STORAGE_UNAVAILABLE", "unable to create IndexedDB transaction", cause);
  }
  controller.track(tx);
  const requests = new Set();

  try {
    let result;
    try {
      result = work(transactionFacade(tx, requests));
      if (isThenable(result)) {
        // A returned thenable is a programming error, but it may already be
        // rejected. Consume that rejection while the native abort settles.
        Promise.resolve(result).catch(() => {});
        throw storageError("INVALID", "transaction work must not return a thenable");
      }
    } catch (cause) {
      abortQuietly(tx);
      try { await tx.done; } catch { /* the caller receives the work failure */ }
      throw cause;
    }

    try {
      await Promise.all(requests);
    } catch (cause) {
      abortQuietly(tx);
      try { await tx.done; } catch { /* request cause below is more specific */ }
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
