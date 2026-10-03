import { APP_DATA_STORES } from "../../domain/app-data/index.js";
import { APP_DATA_DB_SCHEMA_VERSION } from "../../domain/app-data/constants.js";
import { storageError } from "./transaction.js";

export const BUSINESS_SCHEMA_VERSION = APP_DATA_DB_SCHEMA_VERSION;

/** @param {string|string[]|null} left @param {string|string[]|null} right */
function sameKeyPath(left, right) {
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => item === right[index]);
  }
  return left === right;
}

/** @param {IDBDatabase} db */
export function applyFreshBusinessSchema(db) {
  for (const [storeName, descriptor] of Object.entries(APP_DATA_STORES)) {
    if (db.objectStoreNames.contains(storeName)) throw storageError("SCHEMA_MISMATCH", `fresh database unexpectedly contains ${storeName}`);
    const store = db.createObjectStore(storeName, { keyPath: descriptor.keyPath, autoIncrement: false });
    for (const index of descriptor.indexes) store.createIndex(index.name, index.keyPath, { unique: index.unique, multiEntry: false });
  }
}

/** Atomic additive upgrade. Validate every legacy descriptor before touching
 * schema; existing keys, values, indexes and verification metadata are retained. */
export function upgradeBusinessSchema(db, oldVersion, newVersion, transaction) {
  if (oldVersion !== 1 || newVersion !== 2) throw storageError('SCHEMA_VERSION_UNSUPPORTED', 'unsupported business upgrade');
  const legacyNames = Object.keys(APP_DATA_STORES).filter(name => name !== 'history_snapshots');
  if (db.objectStoreNames.length !== legacyNames.length || legacyNames.some(name => !db.objectStoreNames.contains(name))) throw storageError('SCHEMA_MISMATCH', 'legacy store inventory differs');
  for (const name of legacyNames) {
    const expected = APP_DATA_STORES[name], store = transaction.objectStore(name);
    if (!sameKeyPath(store.keyPath, expected.keyPath) || store.autoIncrement !== false || store.indexNames.length !== expected.indexes.length) throw storageError('SCHEMA_MISMATCH', 'legacy store descriptor differs');
    for (const index of expected.indexes) {
      if (!store.indexNames.contains(index.name)) throw storageError('SCHEMA_MISMATCH', 'legacy index missing');
      const actual = store.index(index.name);
      if (!sameKeyPath(actual.keyPath, index.keyPath) || actual.unique !== index.unique || actual.multiEntry !== false) throw storageError('SCHEMA_MISMATCH', 'legacy index descriptor differs');
    }
  }
  const descriptor = APP_DATA_STORES.history_snapshots;
  const store = db.createObjectStore('history_snapshots', {keyPath:descriptor.keyPath,autoIncrement:false});
  for (const index of descriptor.indexes) store.createIndex(index.name,index.keyPath,{unique:index.unique,multiEntry:false});
}

/** @param {import("idb").IDBPDatabase} db */
export async function assertBusinessSchema(db) {
  const expectedNames = Object.keys(APP_DATA_STORES);
  const actualNames = Array.from(db.objectStoreNames);
  if (actualNames.length !== expectedNames.length || expectedNames.some((name) => !db.objectStoreNames.contains(name))) {
    throw storageError("SCHEMA_MISMATCH", "business database does not have the frozen store set");
  }

  let tx;
  let done;
  try {
    tx = db.transaction(expectedNames, "readonly");
    // A structural mismatch can be discovered before this readonly transaction
    // naturally completes. Observe its completion immediately so aborting it
    // below cannot surface as an unhandled idb rejection.
    done = tx.done;
    void done.catch(() => {});
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
    const primary = cause && typeof cause === "object" && cause.code === "SCHEMA_MISMATCH"
      ? cause
      : storageError("SCHEMA_MISMATCH", "unable to inspect business database schema", cause);
    // Do not leave a readonly inspection transaction pending while the caller
    // closes this rejected open. Its own completion is cleanup-only: the
    // schema failure remains the reported error.
    if (tx && done) {
      try { tx.abort(); } catch { /* a completed transaction cannot be aborted */ }
      await Promise.allSettled([done]);
    }
    throw primary;
  }
}
