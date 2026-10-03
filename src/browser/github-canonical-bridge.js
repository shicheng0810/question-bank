import { scanBrowserLearningState } from './local-storage-migration.js';
import {
  APP_DATA_DB_SCHEMA_VERSION,
  APP_DATA_STORES,
  validateActiveProfilePointer,
  validateMetaRecord,
  validateProfileRegistry,
} from '../domain/app-data/index.js';
import {
  assertBusinessDbName,
  controlDbName,
  sameOwner,
  snapshotOwner,
  validateProfileJournalPair,
} from '../storage/profiles/control-schema.js';
import { CONTROL_SCHEMA_VERSION, CONTROL_STORES } from '../storage/profiles/control-schema.js';
import { BUSINESS_SCHEMA_VERSION } from '../storage/idb/schema.js';

export const CANONICAL_ORIGIN = 'https://question-bank-78u.pages.dev';
export const GITHUB_ORIGIN = 'https://shicheng0810.github.io';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BANK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const HISTORY_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIRECTORY_DB = 'qb-v2-profile-directory';
const DIRECTORY_VERSION = 1;
const DIRECTORY_STORES = Object.freeze(['owners', 'meta']);
const DIRECTORY_ROW_OPTIONAL = new Set(['error', 'cleanupDbs']);
const IDB_TIMEOUT_MS = 3000;
const invalidatedDatabases = new WeakSet();
const SAFE_LEGACY_KEY = /^(?:amt_(?:starred_questions|wrong_questions|attempt_count_map_v1|conquered_questions_v1)|qb_(?:activity_days_v1|local_banks_v1|daily_goal_v1)|[A-Za-z0-9_-]{1,64}_(?:starred_questions|wrong_questions|attempt_count_map_v1|conquered_questions_v1|last_active_v1))$/;
const SESSION_STATE_KEYS = new Set([
  'qb_special', 'qb_account_v2_session_v1', 'qb_account_v2_delete_ticket_v1', 'qb_account_v2_local_cleanup_v1',
]);
let databaseVersionchangeEpoch = 0;

const hold = reason => Object.freeze({ action: 'hold', reason });

function exactArray(actual, expected) {
  return actual.length === expected.length && expected.every(name => actual.includes(name));
}

function keyPathEquals(actual, expected) {
  return Array.isArray(actual) || Array.isArray(expected)
    ? Array.isArray(actual) && Array.isArray(expected) && actual.length === expected.length && actual.every((part, index) => part === expected[index])
    : actual === expected;
}

function requestResult(request) {
  return withTimeout(new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IDB_REQUEST_FAILED'));
  }), 'IDB_READ_TIMEOUT');
}

function transactionDone(transaction) {
  const done = new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () => reject(transaction.error || new Error('IDB_TRANSACTION_FAILED'));
  });
  void done.catch(() => {});
  const bounded = withTimeout(done, 'IDB_READ_TIMEOUT', () => { try { transaction.abort(); } catch { /* already closed */ } });
  void bounded.catch(() => {});
  return bounded;
}

function withTimeout(promise, code, onTimeout) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => { onTimeout?.(); reject(new Error(code)); }, IDB_TIMEOUT_MS); }),
  ]).finally(() => clearTimeout(timer));
}

async function openExistingDatabase(indexedDB, item, expectedVersion) {
  if (!item || typeof item.name !== 'string' || item.version !== expectedVersion) throw new Error('IDB_VERSION_UNSUPPORTED');
  let settled = false;
  return withTimeout(new Promise((resolve, reject) => {
    const finish = (error, database) => {
      if (settled) { database?.close(); return; }
      settled = true;
      if (error) reject(error);
      else resolve(database);
    };
    let request;
    try { request = indexedDB.open(item.name); } catch { finish(new Error('IDB_OPEN_FAILED')); return; }
    request.onupgradeneeded = () => {
      // An inventory/open race must never initialize an absent database.
      try { request.transaction?.abort(); } catch { /* already aborting */ }
      finish(new Error('IDB_OPEN_WOULD_CREATE'));
    };
    request.onerror = () => finish(new Error('IDB_OPEN_FAILED'));
    request.onblocked = () => finish(new Error('IDB_OPEN_BLOCKED'));
    request.onsuccess = () => {
      const database = request.result;
      if (database.version !== expectedVersion) { database.close(); finish(new Error('IDB_VERSION_UNSUPPORTED')); return; }
      database.onversionchange = () => { invalidatedDatabases.add(database); databaseVersionchangeEpoch += 1; database.close(); };
      finish(null, database);
    };
  }), 'IDB_OPEN_TIMEOUT', () => { settled = true; });
}

async function inspectControlStructure(database, expectedVersion, storeNames, keyPathFor) {
  if (database.version !== expectedVersion || !exactArray(Array.from(database.objectStoreNames), storeNames)) throw new Error('IDB_SCHEMA_UNKNOWN');
  const transaction = database.transaction(storeNames, 'readonly');
  const done = transactionDone(transaction);
  try {
    for (const name of storeNames) {
      const store = transaction.objectStore(name);
      if (store.keyPath !== keyPathFor(name) || store.autoIncrement || store.indexNames.length !== 0) throw new Error('IDB_SCHEMA_UNKNOWN');
    }
    await done;
  } catch (error) {
    try { transaction.abort(); } catch { /* already complete or aborted */ }
    await Promise.allSettled([done]);
    throw error;
  }
}

function assertDirectorySchema(database) {
  return inspectControlStructure(database, DIRECTORY_VERSION, DIRECTORY_STORES, () => 'key');
}

function assertControlSchema(database) {
  return inspectControlStructure(database, CONTROL_SCHEMA_VERSION, CONTROL_STORES, name => name === 'profiles' ? 'profileId' : 'key');
}

function validDirectoryOwnerRow(row) {
  if (!row || Object.getPrototypeOf(row) !== Object.prototype || typeof row.key !== 'string'
    || !UUID_RE.test(row.controlId) || row.state !== 'ready') return null;
  const allowed = new Set(['key', 'owner', 'controlId', 'state', ...DIRECTORY_ROW_OPTIONAL]);
  if (Object.keys(row).some(key => !allowed.has(key)) || Object.hasOwn(row, 'error') || Object.hasOwn(row, 'cleanupDbs')) return null;
  let owner;
  try { owner = snapshotOwner(row.owner); } catch { return null; }
  const expectedKey = owner.ownerKind === 'guest'
    ? JSON.stringify(['guest', owner.guestId])
    : JSON.stringify(['account', owner.accountId, owner.accountGeneration]);
  return row.key === expectedKey ? { owner, controlId: row.controlId } : null;
}

async function inspectBusinessDatabase(indexedDB, databaseItem) {
  const database = await openExistingDatabase(indexedDB, databaseItem, BUSINESS_SCHEMA_VERSION);
  let transaction, done;
  try {
    const expectedNames = Object.keys(APP_DATA_STORES);
    if (database.version !== APP_DATA_DB_SCHEMA_VERSION || !exactArray(Array.from(database.objectStoreNames), expectedNames)) throw new Error('IDB_SCHEMA_UNKNOWN');
    const storeNames = expectedNames;
    transaction = database.transaction(storeNames, 'readonly');
    done = transactionDone(transaction);
    const counts = await Promise.all(storeNames.map(async name => {
      const store = transaction.objectStore(name), descriptor = APP_DATA_STORES[name];
      if (!keyPathEquals(store.keyPath, descriptor.keyPath) || store.autoIncrement !== false) throw new Error('IDB_SCHEMA_UNKNOWN');
      const indexes = Array.from(store.indexNames);
      if (!exactArray(indexes, descriptor.indexes.map(index => index.name))) throw new Error('IDB_SCHEMA_UNKNOWN');
      for (const indexDescriptor of descriptor.indexes) {
        const index = store.index(indexDescriptor.name);
        if (!keyPathEquals(index.keyPath, indexDescriptor.keyPath) || index.unique !== indexDescriptor.unique || index.multiEntry !== false) throw new Error('IDB_SCHEMA_UNKNOWN');
      }
      if (name === 'meta') {
        const rows = await requestResult(store.getAll());
        const keys = new Set();
        for (const row of rows) {
          validateMetaRecord(row);
          if (keys.has(row.key)) throw new Error('IDB_META_STATE_UNKNOWN');
          keys.add(row.key);
        }
        return { name, count: 0, syncLeasePresent: keys.has('syncCoordinatorLease') };
      }
      return { name, count: await requestResult(store.count()), syncLeasePresent: false };
    }));
    await done;
    if (invalidatedDatabases.has(database) || counts.some(row => !Number.isSafeInteger(row.count) || row.count < 0)) throw new Error('IDB_VERSION_CHANGED');
    return {
      businessRecordCount: counts.reduce((sum, row) => sum + row.count, 0),
      syncLeasePresent: counts.some(row => row.syncLeasePresent),
    };
  } catch (error) {
    try { transaction?.abort(); } catch { /* already complete or aborted */ }
    await Promise.allSettled(done ? [done] : []);
    throw error;
  } finally { database.close(); }
}

async function inspectControlDatabase(indexedDB, databaseItem, owner) {
  const database = await openExistingDatabase(indexedDB, databaseItem, CONTROL_SCHEMA_VERSION);
  let transaction, done;
  try {
    await assertControlSchema(database);
    transaction = database.transaction(CONTROL_STORES, 'readonly');
    done = transactionDone(transaction);
    const profilesStore = transaction.objectStore('profiles'), metaStore = transaction.objectStore('meta');
    const [profiles, metaKeys] = await Promise.all([requestResult(profilesStore.getAll()), requestResult(metaStore.getAllKeys())]);
    const allowedMetaKeys = new Set(['activeProfile']);
    for (const profile of profiles) allowedMetaKeys.add(`fresh:${profile.profileId}`);
    if (metaKeys.some(key => typeof key !== 'string' || !allowedMetaKeys.has(key))) throw new Error('IDB_CONTROL_STATE_UNKNOWN');
    if (!profiles.length || !metaKeys.includes('activeProfile')) throw new Error('IDB_CONTROL_STATE_UNKNOWN');
    const pointer = validateActiveProfilePointer(await requestResult(metaStore.get('activeProfile')));
    const profileIds = new Set(), businessNames = [];
    for (const rawProfile of profiles) {
      const profile = validateProfileRegistry(rawProfile);
      if (profileIds.has(profile.profileId)) throw new Error('IDB_CONTROL_STATE_UNKNOWN');
      profileIds.add(profile.profileId);
      const journal = await requestResult(metaStore.get(`fresh:${profile.profileId}`));
      const pair = validateProfileJournalPair(profile, journal, { allowStaged: true });
      if (!sameOwner(pair.owner, owner) || pair.phase !== 'completed' || profile.state !== 'ready') throw new Error('IDB_CONTROL_STATE_UNKNOWN');
      businessNames.push(assertBusinessDbName(profile.dbName));
    }
    if (!profileIds.has(pointer.activeProfileId) || new Set(businessNames).size !== businessNames.length) throw new Error('IDB_CONTROL_STATE_UNKNOWN');
    await done;
    if (invalidatedDatabases.has(database)) throw new Error('IDB_VERSION_CHANGED');
    return businessNames;
  } catch (error) {
    try { transaction?.abort(); } catch { /* already complete or aborted */ }
    await Promise.allSettled(done ? [done] : []);
    throw error;
  } finally { database.close(); }
}

function safeStorageHas(storage, key) {
  if (!storage || typeof storage.getItem !== 'function') throw new Error('STORAGE_UNAVAILABLE');
  return storage.getItem(key) !== null;
}

function storageKeyInventory(storage, recognizedPattern, namespacePattern, unknownCode) {
  if (!storage || typeof storage.length !== 'number' || typeof storage.key !== 'function') throw new Error('STORAGE_UNAVAILABLE');
  const keys = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (typeof key !== 'string') throw new Error('STORAGE_INVENTORY_INVALID');
    const recognized = typeof recognizedPattern === 'function' ? recognizedPattern(key) : recognizedPattern.test(key);
    if (namespacePattern.test(key) && !recognized) throw new Error(unknownCode);
    if (recognized) keys.push(key);
  }
  return keys.sort();
}

function databaseInventorySignature(inventory) {
  if (!Array.isArray(inventory) || inventory.some(row => !row || typeof row.name !== 'string' || !Number.isSafeInteger(row.version))) throw new Error('IDB_INVENTORY_INVALID');
  const sorted = inventory.map(({ name, version }) => [name, version]).sort((a, b) => a[0].localeCompare(b[0]));
  if (new Set(sorted.map(row => row[0])).size !== sorted.length) throw new Error('IDB_INVENTORY_DUPLICATE');
  return JSON.stringify(sorted);
}

/** Read-only, fail-closed inventory. It emits counts/booleans only, never keys,
 * source values, IDs, tokens, share codes, or business record payloads. */
export async function inspectGithubLocalInventory({
  indexedDB = globalThis.indexedDB,
  localStorage = globalThis.localStorage,
  sessionStorage = globalThis.sessionStorage,
  origin = globalThis.location?.origin,
} = {}) {
  try {
    if (origin !== GITHUB_ORIGIN) return Object.freeze({ status: 'unknown', reason: 'UNEXPECTED_ORIGIN' });
    const versionchangeAtStart = databaseVersionchangeEpoch;
    const localKeysBefore = storageKeyInventory(localStorage, SAFE_LEGACY_KEY, /^(?:qb_|amt_)/, 'LOCAL_KEY_NAMESPACE_UNKNOWN');
    const sessionKeysBefore = storageKeyInventory(sessionStorage, key => SESSION_STATE_KEYS.has(key), /^qb_/, 'SESSION_KEY_UNKNOWN');
    const legacy = await scanBrowserLearningState(localStorage, { sourceOrigin: origin });
    const legacyKeyCount = localKeysBefore.length;
    const shareSessionPresent = safeStorageHas(sessionStorage, 'qb_special');
    const accountSessionPresent = safeStorageHas(sessionStorage, 'qb_account_v2_session_v1');
    const deletionSessionPresent = safeStorageHas(sessionStorage, 'qb_account_v2_delete_ticket_v1');
    const cleanupSessionPresent = safeStorageHas(sessionStorage, 'qb_account_v2_local_cleanup_v1');
    if (!indexedDB || typeof indexedDB.databases !== 'function' || typeof indexedDB.open !== 'function') throw new Error('IDB_INVENTORY_UNAVAILABLE');
    const listDatabases = () => withTimeout(Promise.resolve().then(() => indexedDB.databases()), 'IDB_INVENTORY_TIMEOUT');
    const inventory = await listDatabases();
    const beforeSignature = databaseInventorySignature(inventory);
    if (beforeSignature !== databaseInventorySignature(await listDatabases())) throw new Error('INVENTORY_CHANGED_DURING_SCAN');
    const byName = new Map(inventory.map(row => [row.name, row]));
    for (const item of inventory) {
      if (!item.name.startsWith('qb-')) continue;
      if (item.name === DIRECTORY_DB) continue;
      if (/^qb-v2-control-[0-9a-f-]+$/.test(item.name)) {
        const id = item.name.slice('qb-v2-control-'.length);
        if (!UUID_RE.test(id) || item.version !== CONTROL_SCHEMA_VERSION) throw new Error('IDB_SCHEMA_UNKNOWN');
      } else if (/^qb-v2-business-[0-9a-f-]+$/.test(item.name)) {
        const id = item.name.slice('qb-v2-business-'.length);
        if (!UUID_RE.test(id) || item.version !== BUSINESS_SCHEMA_VERSION) throw new Error('IDB_SCHEMA_UNKNOWN');
      } else throw new Error('IDB_NAMESPACE_UNKNOWN');
    }
    const directoryItem = byName.get(DIRECTORY_DB);
    const referencedControls = new Set(), referencedBusinesses = new Set();
    let nativeRecordCount = 0, nativeSyncLeasePresent = false;
    if (directoryItem) {
      const directory = await openExistingDatabase(indexedDB, directoryItem, DIRECTORY_VERSION);
      let transaction, done;
      try {
        await assertDirectorySchema(directory);
        transaction = directory.transaction(DIRECTORY_STORES, 'readonly');
        done = transactionDone(transaction);
        const owners = await requestResult(transaction.objectStore('owners').getAll());
        const metaStore = transaction.objectStore('meta');
        const metaKeys = await requestResult(metaStore.getAllKeys());
        const allowedDirectoryMeta = new Set(['guest', 'completedDeletes']);
        if (metaKeys.some(key => typeof key !== 'string' || !allowedDirectoryMeta.has(key))) throw new Error('IDB_DIRECTORY_STATE_UNKNOWN');
        if (metaKeys.includes('completedDeletes')) throw new Error('IDB_LOCAL_CLEANUP_PENDING');
        const guestRow = metaKeys.includes('guest') ? await requestResult(metaStore.get('guest')) : undefined;
        const checkedOwners = owners.map(validDirectoryOwnerRow);
        if (checkedOwners.some(row => row === null)) throw new Error('IDB_DIRECTORY_STATE_UNKNOWN');
        const guestOwners = checkedOwners.filter(row => row.owner.ownerKind === 'guest');
        if ((guestRow === undefined && guestOwners.length) || (guestRow !== undefined
          && (guestOwners.length !== 1 || guestRow.key !== 'guest' || guestRow.guestId !== guestOwners[0].owner.guestId))) throw new Error('IDB_DIRECTORY_STATE_UNKNOWN');
        if (guestRow !== undefined && guestOwners.length !== 1) throw new Error('IDB_DIRECTORY_STATE_UNKNOWN');
        await done;
        if (invalidatedDatabases.has(directory)) throw new Error('IDB_VERSION_CHANGED');
        for (const row of checkedOwners) {
          const controlName = controlDbName(row.controlId, 'production');
          referencedControls.add(controlName);
          const controlItem = byName.get(controlName);
          if (!controlItem) throw new Error('IDB_CONTROL_MISSING');
          const businessNames = await inspectControlDatabase(indexedDB, controlItem, row.owner);
          for (const businessName of businessNames) {
            if (referencedBusinesses.has(businessName)) throw new Error('IDB_BUSINESS_DUPLICATE');
            referencedBusinesses.add(businessName);
            const businessItem = byName.get(businessName);
            if (!businessItem) throw new Error('IDB_BUSINESS_MISSING');
            const businessState = await inspectBusinessDatabase(indexedDB, businessItem);
            nativeRecordCount += businessState.businessRecordCount;
            nativeSyncLeasePresent ||= businessState.syncLeasePresent;
          }
        }
      } catch (error) {
        try { transaction?.abort(); } catch { /* already complete or aborted */ }
        await Promise.allSettled(done ? [done] : []);
        throw error;
      } finally { directory.close(); }
    }
    for (const item of inventory) {
      if (item.name.startsWith('qb-') && item.name !== DIRECTORY_DB
        && !referencedControls.has(item.name) && !referencedBusinesses.has(item.name)) throw new Error('IDB_ORPHAN_DATABASE');
    }
    const localKeysAfter = storageKeyInventory(localStorage, SAFE_LEGACY_KEY, /^(?:qb_|amt_)/, 'LOCAL_KEY_NAMESPACE_UNKNOWN');
    const sessionKeysAfter = storageKeyInventory(sessionStorage, key => SESSION_STATE_KEYS.has(key), /^qb_/, 'SESSION_KEY_UNKNOWN');
    const legacyAfter = await scanBrowserLearningState(localStorage, { sourceOrigin: origin });
    const inventoryAfter = await listDatabases();
    const afterSignature = databaseInventorySignature(inventoryAfter);
    if (beforeSignature !== afterSignature || JSON.stringify(localKeysBefore) !== JSON.stringify(localKeysAfter)
      || JSON.stringify(sessionKeysBefore) !== JSON.stringify(sessionKeysAfter) || legacy.dataDigest !== legacyAfter.dataDigest
      || databaseVersionchangeEpoch !== versionchangeAtStart) {
      throw new Error('INVENTORY_CHANGED_DURING_SCAN');
    }
    const sessionStatePresent = shareSessionPresent || accountSessionPresent || deletionSessionPresent || cleanupSessionPresent;
    const localStatePresent = localKeysBefore.length > 0 || nativeRecordCount > 0 || sessionStatePresent || nativeSyncLeasePresent;
    return Object.freeze({
      status: localStatePresent ? 'present' : 'empty',
      reason: localStatePresent ? 'LOCAL_STATE_REQUIRES_EXPLICIT_HANDOFF' : 'NO_LOCAL_LEARNING_STATE',
      legacyKeyCount,
      nativeRecordCount,
      nativeSyncLeasePresent,
      knownDatabaseCount: referencedControls.size + referencedBusinesses.size + Number(Boolean(directoryItem)),
      shareSessionPresent,
      accountSessionPresent,
      deletionSessionPresent,
      cleanupSessionPresent,
    });
  } catch (error) {
    const reason = typeof error?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code
      : typeof error?.message === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.message) ? error.message : 'INVENTORY_UNAVAILABLE';
    return Object.freeze({ status: 'unknown', reason });
  }
}

function projectRoute(pathname) {
  let path = pathname;
  for (const prefix of ['/question-bank/', '/question-bank-template/']) {
    if (path.startsWith(prefix)) { path = `/${path.slice(prefix.length)}`; break; }
  }
  if (path === '/' || path === '/index.html') return { path: '/' };
  if (path === '/player.html') return { path };
  if (path === '/local.html') return { path };
  if (path === '/format.html') return { path };
  return null;
}

/** Fixed-host route contract. Unknown routes and stateful links are held rather
 * than guessed; unapproved query fields and fragments are never forwarded. */
export function resolveCanonicalBridgeTarget(input) {
  let url;
  try { url = new URL(String(input)); } catch { return hold('INVALID_SOURCE_URL'); }
  if (url.origin !== GITHUB_ORIGIN || url.protocol !== 'https:' || url.username || url.password) return hold('UNEXPECTED_SOURCE_ORIGIN');
  const route = projectRoute(url.pathname);
  if (!route) return hold('UNMAPPED_OLD_ROUTE');
  const entries = [...url.searchParams.entries()];
  const keys = entries.map(([key]) => key.toLowerCase());
  if (keys.some(key => ['code', 'token', 'auth', 'authorization', 'sharecode', 'share_code', 'secret', 'credential'].includes(key))) return hold('SENSITIVE_QUERY_NOT_FORWARDED');
  if (keys.includes('special')) return hold('SHARE_CODE_REENTRY_REQUIRED');
  if (keys.includes('mybank')) return hold('LEGACY_PRIVATE_BANK_ROUTE_UNMAPPED');
  if (/(?:^|[?&#])(?:code|token|auth|authorization|share_?code|special|secret|credential)=/i.test(url.hash)) return hold('SENSITIVE_FRAGMENT_NOT_FORWARDED');
  if (keys.some(key => ['bank', 'workbench', 'snapshot', 'attempt', 'id', 'lang'].includes(key)
    && !entries.some(([exact]) => exact === key))) return hold('NONCANONICAL_QUERY_KEY');

  const target = new URL(route.path, CANONICAL_ORIGIN);
  const values = key => url.searchParams.getAll(key);
  const addSingle = (key, pattern, destination = key) => {
    const found = values(key);
    if (found.length > 1 || (found.length === 1 && !pattern.test(found[0]))) return false;
    if (found.length === 1) target.searchParams.set(destination, found[0]);
    return true;
  };
  if (route.path === '/player.html' || route.path === '/local.html') {
    if (!addSingle('bank', BANK_ID_RE)) return hold('INVALID_BANK_ROUTE');
  } else if (url.searchParams.has('bank')) return hold('UNMAPPED_BANK_ROUTE');

  const workbench = values('workbench');
  if (workbench.length > 1) return hold('INVALID_HISTORY_ROUTE');
  if (workbench.length === 1) {
    if (workbench[0] === 'history') {
      if (route.path !== '/local.html') return hold('INVALID_HISTORY_ROUTE');
      const snapshot = values('snapshot'), attempt = values('attempt');
      if ((!snapshot.length && !attempt.length)
        || (snapshot.length === 1 && HISTORY_ID_RE.test(snapshot[0]) && !attempt.length)
        || (attempt.length === 1 && HISTORY_ID_RE.test(attempt[0]) && !snapshot.length)) {
        target.searchParams.set('workbench', 'history');
        if (snapshot.length) target.searchParams.set('snapshot', snapshot[0]);
        if (attempt.length) target.searchParams.set('attempt', attempt[0]);
      } else return hold('INVALID_HISTORY_ROUTE');
    } else if (workbench[0] === 'recovery' && route.path === '/local.html') {
      target.searchParams.set('workbench', 'recovery');
    } else return hold('UNMAPPED_OLD_ROUTE');
  } else if (url.searchParams.has('snapshot') || url.searchParams.has('attempt') || url.searchParams.has('id')) {
    return hold('UNMAPPED_HISTORY_ROUTE');
  }
  const lang = values('lang');
  if (lang.length > 1 || (lang.length === 1 && !['en', 'zh', 'es'].includes(lang[0]))) return hold('INVALID_LANGUAGE_ROUTE');
  if (lang.length === 1) target.searchParams.set('lang', lang[0]);
  return Object.freeze({ action: 'redirect', target: target.href, requiresFreshLogin: true });
}

/** Empty state is the only redirect case. No ACK flag or caller-supplied
 * migration result can override inventory. */
export function decideCanonicalBridge({ sourceUrl, inventory }) {
  const route = resolveCanonicalBridgeTarget(sourceUrl);
  if (route.action !== 'redirect') return route;
  if (!inventory || inventory.status === 'unknown') return hold('LOCAL_INVENTORY_UNKNOWN');
  if (inventory.status !== 'empty') return hold('LOCAL_STATE_REQUIRES_HANDOFF');
  return route;
}

/** Browser entry point used only by a generated GitHub bridge candidate. An
 * empty local origin redirects; every other outcome leaves the existing
 * same-origin application available as the migration handoff. */
export async function startGithubCanonicalBridge({
  windowObject = globalThis.window,
  documentObject = globalThis.document,
  inspect = inspectGithubLocalInventory,
} = {}) {
  const sourceUrl = windowObject?.location?.href;
  const inventory = await inspect();
  const decision = decideCanonicalBridge({ sourceUrl, inventory });
  if (decision.action === 'redirect') {
    windowObject.location.replace(decision.target);
    return Object.freeze({ action: 'redirect', reason: 'EMPTY_LOCAL_STATE' });
  }
  if (!documentObject) return Object.freeze({ action: 'hold', reason: decision.reason });
  const showNotice = () => {
    if (!documentObject.body || documentObject.getElementById('qb-canonical-bridge-notice')) return;
    const notice = documentObject.createElement('aside');
    notice.id = 'qb-canonical-bridge-notice';
    notice.setAttribute('role', 'status');
    notice.setAttribute('aria-live', 'polite');
    const message = documentObject.createElement('span');
    message.textContent = inventory.status === 'present'
      ? 'Local learning data may exist. Stay on this site and complete its migration and cloud sync before switching. 本机可能有学习数据；请先在此站完成迁移与云同步。 '
      : 'Local data could not be verified. Stay on this site; nothing has been redirected or cleared. 无法确认本机数据状态，请留在此站；尚未跳转或清除数据。 ';
    const handoff = documentObject.createElement('a');
    handoff.href = `${GITHUB_ORIGIN}/question-bank/`;
    handoff.textContent = 'Open the existing import and account page / 打开现有导入与账号页面';
    notice.append(message, handoff);
    notice.style.cssText = 'position:relative;z-index:2147483000;padding:.65rem 1rem;background:#fff4cc;color:#332700;border-bottom:1px solid #9a7410;font:600 14px/1.4 system-ui,sans-serif;text-align:center';
    documentObject.body.prepend(notice);
  };
  if (documentObject.body) showNotice();
  else documentObject.addEventListener('DOMContentLoaded', showNotice, { once: true });
  return Object.freeze({ action: 'hold', reason: decision.reason });
}
