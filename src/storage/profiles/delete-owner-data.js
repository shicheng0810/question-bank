import { openDB } from 'idb';
import { canonicalBytes, validateActiveProfilePointer } from '../../domain/app-data/index.js';
import { snapshotOwner, sameOwner, controlDbName, assertControlSchema, assertBusinessDbName, validateProfileJournalPair } from './control-schema.js';

const DIRECTORY = 'qb-v2-profile-directory';
const fail = code => Object.assign(new Error(code), { code });
const keyFor = owner => JSON.stringify(['account', owner.accountId, owner.accountGeneration]);
async function existing(name, timeout) {
  if (typeof indexedDB.databases !== 'function') throw fail('DATABASE_INVENTORY_UNAVAILABLE');
  if (!(await indexedDB.databases()).some(row => row.name === name && row.version === 1)) throw fail('OWNER_MAPPING_MISSING');
  let late = false, timer;
  const request = openDB(name, 1, { upgrade(_db, _old, _next, tx) { tx.done.catch(() => {}); tx.abort(); } });
  request.then(db => { if (late) db.close(); }, () => {});
  try { return await Promise.race([request, new Promise((_resolve, reject) => { timer = setTimeout(() => { late = true; reject(fail('LOCAL_CLEANUP_INCOMPLETE')); }, timeout); })]); }
  finally { clearTimeout(timer); }
}
function deleteExact(name, timeout) {
  assertBusinessDbName(name);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(fail('LOCAL_CLEANUP_INCOMPLETE')), timeout);
    const request = indexedDB.deleteDatabase(name);
    request.onerror = () => { clearTimeout(timer); reject(fail('LOCAL_CLEANUP_INCOMPLETE')); };
    request.onsuccess = () => { clearTimeout(timer); resolve(); };
    // Blocked other tabs receive native versionchange and must close. A timeout
    // preserves the tombstone/retry inventory; no unrelated DB is targeted.
  });
}
/** Only the trusted completed-delete flow calls this function, after closing its
 * authority. Logout never calls it. Exact incarnation/generation mapping is
 * checked before locking or deleting any DB; shared/control/device guest stay.
 */
export async function deleteCompletedOwnerData(value, { receipt, blockedTimeoutMs = 5000 } = {}) {
  const owner = snapshotOwner(value); canonicalBytes(receipt);
  if (owner.ownerKind !== 'account' || receipt?.ok !== true || receipt.status !== 'complete' || Object.keys(receipt).sort().join() !== 'ok,status' || !Number.isSafeInteger(blockedTimeoutMs) || blockedTimeoutMs < 1 || blockedTimeoutMs > 2147483647) throw fail('DELETE_COMPLETION_REQUIRED');
  if (typeof indexedDB.databases !== 'function') throw fail('DATABASE_INVENTORY_UNAVAILABLE');
  if (!(await indexedDB.databases()).some(row => row.name === DIRECTORY)) return { status: 'complete', reason: 'no-local-profile', deletedDatabases: [] };
  const directory = await existing(DIRECTORY, blockedTimeoutMs); let control;
  try {
    if (directory.objectStoreNames.length !== 2 || !directory.objectStoreNames.contains('owners') || !directory.objectStoreNames.contains('meta')) throw fail('SCHEMA_MISMATCH');
    const schema = directory.transaction(['owners', 'meta']); void schema.done.catch(() => {});
    for (const name of ['owners', 'meta']) { const store = schema.objectStore(name); if (store.keyPath !== 'key' || store.autoIncrement || store.indexNames.length) throw fail('SCHEMA_MISMATCH'); }
    await schema.done;
    const key = keyFor(owner);
    const lock = directory.transaction('owners', 'readwrite'); void lock.done.catch(() => {});
    const binding = await lock.store.get(key);
    if (!binding) { await lock.done; return { status: 'complete', reason: 'no-local-profile', deletedDatabases: [] }; }
    if (binding.key !== key || !sameOwner(binding.owner, owner)) { lock.abort(); await lock.done.catch(() => {}); throw fail('OWNER_MAPPING_MISMATCH'); }
    if (binding.state !== 'deleted') await lock.store.put({ ...binding, state: 'cleanup_pending', cleanupDbs: binding.cleanupDbs || [] });
    await lock.done;
    if (binding.state === 'deleted') return { status: 'complete', deletedDatabases: [] };
    control = await existing(controlDbName(binding.controlId, 'production'), blockedTimeoutMs);
    await assertControlSchema(control);
    const deleted = new Set(); let fingerprint = null, stable = false;
    for (let round = 0; round < 3; round++) {
      const tx = control.transaction(['profiles', 'meta']); void tx.done.catch(() => {});
      const profiles = await tx.objectStore('profiles').getAll(), names = [], phases = [];
      const pointer = await tx.objectStore('meta').get('activeProfile');
      if (!profiles.length || (pointer && !profiles.some(profile => profile.profileId === validateActiveProfilePointer(pointer).activeProfileId))) throw fail('OWNER_MAPPING_MISMATCH');
      for (const profile of profiles) {
        const pair = validateProfileJournalPair(profile, await tx.objectStore('meta').get(`fresh:${profile.profileId}`), { allowStaged: true });
        if (!sameOwner(pair.owner, owner)) throw fail('OWNER_MAPPING_MISMATCH');
        names.push(assertBusinessDbName(profile.dbName)); phases.push(pair.phase);
      }
      await tx.done;
      const update = directory.transaction('owners', 'readwrite'); void update.done.catch(() => {});
      const current = await update.store.get(key);
      if (!current || current.state !== 'cleanup_pending' || current.controlId !== binding.controlId || !sameOwner(current.owner, owner)) { update.abort(); await update.done.catch(() => {}); throw fail('OWNER_MAPPING_MISMATCH'); }
      await update.store.put({ ...current, cleanupDbs: names }); await update.done;
      for (const name of names) { await deleteExact(name, blockedTimeoutMs); deleted.add(name); }
      const next = JSON.stringify(names);
      if (fingerprint === next && !phases.some(phase => ['allocated', 'creating'].includes(phase)) && !(await indexedDB.databases()).some(row => names.includes(row.name))) { stable = true; break; }
      fingerprint = next;
    }
    if (!stable) throw fail('LOCAL_CLEANUP_INCOMPLETE');
    const complete = directory.transaction('owners', 'readwrite');
    const latest = await complete.store.get(key);
    if (!latest || latest.state !== 'cleanup_pending' || latest.controlId !== binding.controlId || !sameOwner(latest.owner, owner)) { complete.abort(); await complete.done.catch(() => {}); throw fail('OWNER_MAPPING_MISMATCH'); }
    await complete.store.put({ ...latest, state: 'deleted' }); await complete.done;
    return { status: 'complete', deletedDatabases: [...deleted] };
  } finally { control?.close(); directory.close(); }
}
