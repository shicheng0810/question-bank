import { openDB } from "idb";
import { validateProfileRegistry } from "../../domain/app-data/index.js";
import { BUSINESS_SCHEMA_VERSION, applyFreshBusinessSchema, assertBusinessSchema, upgradeBusinessSchema } from "./schema.js";
import { runIdbTransaction, storageError } from "./transaction.js";

let nextContextGeneration = 1;

/** @param {unknown} idb */
export function getIndexedDbCapability(idb = globalThis.indexedDB) {
  return Boolean(idb && typeof idb === "object" && typeof idb.open === "function");
}

/** @param {(event: { type: "blocked" | "versionchange", dbName: string }) => void} callback @param {"blocked" | "versionchange"} type @param {string} dbName */
function notifyLifecycle(callback, type, dbName) {
  try { callback({ type, dbName }); } catch { /* lifecycle observers cannot keep a connection alive */ }
}

/** @param {unknown} profile */
function validateProfile(profile) {
  try {
    return validateProfileRegistry(profile);
  } catch (cause) {
    throw storageError("INVALID", "profile must satisfy the frozen profile registry contract", cause);
  }
}

/** @param {unknown} value @param {string} name */
function positiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw storageError("INVALID", `${name} must be a positive safe integer`);
  return value;
}

/**
 * Opens an already-identified business database. This module validates the
 * profile DTO but neither owns a control registry nor authorizes the supplied
 * dbName; T07b supplies that trust boundary and the session fence.
 *
 * `openMode` is intentionally required: an existing profile may never create
 * an empty database just because its registry mapping is wrong or missing.
 *
 * @param {{ profile: unknown, openMode: "create" | "existing", onLifecycle?: (event: { type: "blocked" | "versionchange", dbName: string }) => void, blockedTimeoutMs: number, signal?: AbortSignal }} options
 */
export async function openProfileContext(options) {
  if (!options || typeof options !== "object") throw storageError("INVALID", "open options are required");
  const { profile, openMode, onLifecycle = () => {}, blockedTimeoutMs, signal } = options;
  const validatedProfile = validateProfile(profile);
  // The validator deliberately returns the caller's reference. Snapshot the
  // only values this module uses before its first await.
  const registryRecord = Object.freeze({
    profileId: validatedProfile.profileId,
    dbName: validatedProfile.dbName,
    schemaVersion: validatedProfile.schemaVersion
  });
  if (openMode !== "create" && openMode !== "existing") throw storageError("INVALID", "openMode must be create or existing");
  if (!getIndexedDbCapability()) throw storageError("STORAGE_UNAVAILABLE", "IndexedDB is unavailable");
  if (typeof onLifecycle !== "function") throw storageError("INVALID", "onLifecycle must be a function");
  positiveSafeInteger(blockedTimeoutMs, "blockedTimeoutMs");
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw storageError("INVALID", "signal must be an AbortSignal");
  if (signal?.aborted) throw storageError("CLOSED", "database open was cancelled");

  let cancelled = false;
  let upgradeFailure;
  let openTimer;
  /** @type {(() => void) | undefined} */
  let removeAbortListener;
  /** @type {(reason: unknown) => void} */
  let rejectCancelledOpen;
  const cancelledOpen = new Promise((resolve, reject) => {
    // This promise is intentionally rejected only by cancel below. The resolve
    // parameter is retained to keep the native Promise constructor shape.
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
  /** @type {Set<import("idb").IDBPTransaction>} */
  const activeTransactions = new Set();

  function assertOpen() {
    if (closed) throw storageError("CLOSED", "profile context is closed");
  }
  function closeContext() {
    if (closed) return;
    closed = true;
    for (const transaction of activeTransactions) {
      try { transaction.abort(); } catch { /* completion may have won the race */ }
    }
    if (db) db.close();
  }

  try {
    const opening = openDB(registryRecord.dbName, BUSINESS_SCHEMA_VERSION, {
      upgrade(upgradeDb, oldVersion, newVersion, transaction) {
        // idb v8 exposes an independent upgrade-transaction promise; consume
        // its rejection even when openDB itself wins the error race.
        transaction.done.catch(() => {});
        if (cancelled) {
          transaction.abort();
          return;
        }
        if (oldVersion === 1 && newVersion === BUSINESS_SCHEMA_VERSION && openMode === 'existing') {
          try { upgradeBusinessSchema(upgradeDb, oldVersion, newVersion, transaction); }
          catch (cause) { upgradeFailure = cause; transaction.abort(); }
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
    // The budget covers native queueing from the moment open starts, rather
    // than only the time after a blocked event is delivered.
    openTimer = setTimeout(cancel, blockedTimeoutMs);
    // The wrapper does not expose a native request.abort(). Racing cancellation
    // bounds the caller; a later successful connection is immediately closed,
    // while a late upgrade observes cancelled and aborts its upgrade tx above.
    opening.then((lateDb) => { if (cancelled) lateDb.close(); }, () => {});
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
    if (openTimer !== undefined) clearTimeout(openTimer);
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
    get closed() { return closed; },
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
