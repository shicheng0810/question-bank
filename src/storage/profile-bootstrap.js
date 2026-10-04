import { openDB } from 'idb';
import { openManagedProfileRegistry } from './profiles/index.js';
import {registerManagedSourceRegistryAlias} from './profiles/managed-profile-registry.js';
import { snapshotOwner, sameOwner } from './profiles/control-schema.js';
import { storageError } from './idb/transaction.js';

const DIRECTORY = 'qb-v2-profile-directory';
const failure = code => storageError(code, code);
const ownerKey = owner => owner.ownerKind === 'guest' ? JSON.stringify(['guest', owner.guestId]) : JSON.stringify(['account', owner.accountId, owner.accountGeneration]);

async function openDirectory(blockedTimeoutMs, signal) {
  if (!Number.isSafeInteger(blockedTimeoutMs) || blockedTimeoutMs < 1 || blockedTimeoutMs > 2147483647) throw failure('INVALID_INPUT');
  if (signal?.aborted) throw failure('CLOSED');
  let cancelled = false; let timer; let rejectCancel;
  const cancelPromise = new Promise((_resolve, reject) => { rejectCancel = reject; });
  const cancel = () => { cancelled = true; rejectCancel(failure('CLOSED')); };
  signal?.addEventListener('abort', cancel, { once: true });
  const opening = openDB(DIRECTORY, 1, {
    upgrade(db, oldVersion, _newVersion, tx) {
      tx.done.catch(() => {});
      if (cancelled || oldVersion !== 0) { tx.abort(); return; }
      db.createObjectStore('owners', { keyPath: 'key' }); db.createObjectStore('meta', { keyPath: 'key' });
    },
  });
  opening.then(db => { if (cancelled) db.close(); }, () => {});
  timer = setTimeout(cancel, blockedTimeoutMs);
  try {
    const db = await Promise.race([opening, cancelPromise]);
    if (signal?.aborted) { db.close(); throw failure('CLOSED'); }
    if (db.objectStoreNames.length !== 2 || !db.objectStoreNames.contains('owners') || !db.objectStoreNames.contains('meta')) { db.close(); throw failure('SCHEMA_MISMATCH'); }
    const tx = db.transaction(['owners', 'meta']);
    for (const store of ['owners', 'meta']) {
      const s = tx.objectStore(store);
      if (s.keyPath !== 'key' || s.autoIncrement || s.indexNames.length) { db.close(); throw failure('SCHEMA_MISMATCH'); }
    }
    await tx.done; return db;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
}

/** Narrow production owner directory. Stores no answers, code or token.
 * guestId and owner->controlId allocation are one metadata IDB transaction.
 * An interrupted initialization is an explicit error, never a new empty replacement.
 */
export async function openProfileBootstrap({ owner: requestedOwner = null, blockedTimeoutMs = 5000, signal, isCurrent = () => true } = {}) {
  const requested = requestedOwner && snapshotOwner(requestedOwner);
  const guard = () => { if (signal?.aborted || !isCurrent()) throw failure('CLOSED'); };
  guard(); const directory = await openDirectory(blockedTimeoutMs, signal);
  try { guard(); } catch (error) { directory.close(); throw error; }
  let registry; let closed = false;
  const close = () => { if (closed) return; closed = true; registry?.close(); directory.close(); signal?.removeEventListener('abort', close); };
  directory.onversionchange = close; signal?.addEventListener('abort', close, { once: true });
  const current = () => { guard(); if (closed) throw failure('CLOSED'); };
  let owner; let binding; let creator = false;
  try {
    const tx = directory.transaction(['owners', 'meta'], 'readwrite');
    tx.done.catch(() => {});
    try {
      owner = requested;
      if (!owner) {
        let guest = await tx.objectStore('meta').get('guest'); current();
        if (!guest) { guest = { key: 'guest', guestId: crypto.randomUUID() }; await tx.objectStore('meta').add(guest); }
        owner = snapshotOwner({ ownerKind: 'guest', guestId: guest.guestId });
      }
      const key = ownerKey(owner);
      binding = await tx.objectStore('owners').get(key); current();
      if (!binding) {
        binding = { key, owner, controlId: crypto.randomUUID(), state: 'initializing' };
        await tx.objectStore('owners').add(binding); creator = true;
      } else if (!sameOwner(owner, binding.owner) || binding.key !== key || !['initializing', 'ready', 'locked', 'failed', 'cleanup_pending', 'deleted'].includes(binding.state)) throw failure('CORRUPT');
      await tx.done; current();
    } catch (error) { try { tx.abort(); } catch { /* settled */ } await Promise.allSettled([tx.done]); throw error; }
    if (['locked', 'cleanup_pending', 'deleted'].includes(binding.state)) throw failure('OWNER_LOCKED');
    if (!creator && binding.state !== 'ready') throw failure(binding.state === 'failed' ? 'PROFILE_INITIALIZATION_FAILED' : 'PROFILE_INITIALIZING');
    const guardOwner = async () => {
      current(); const row = await directory.get('owners', binding.key); current();
      if (!row || row.controlId !== binding.controlId || !sameOwner(row.owner, owner) || !['initializing', 'ready'].includes(row.state)) throw failure('OWNER_LOCKED');
    };
    registry = await openManagedProfileRegistry({ owner, controlId: binding.controlId, controlOpenMode: creator ? 'create' : 'existing', namespace: 'production', blockedTimeoutMs, signal, guardOwner }); current();
    if (creator) {
      const profile = await registry.createFresh(); current();
      await registry.activate({ profileId: profile.profileId, expectedRevision: 0 }); current();
      const tx = directory.transaction('owners', 'readwrite');
      const row = await tx.store.get(binding.key);
      if (!row || row.controlId !== binding.controlId || row.state !== 'initializing' || !sameOwner(row.owner, owner)) { tx.abort(); await tx.done.catch(() => {}); throw failure('PROFILE_BOOTSTRAP_CONFLICT'); }
      await tx.store.put({ ...row, state: 'ready' }); await tx.done; current();
    } else if (!(await registry.readActive())) throw failure('STALE_ACTIVE_PROFILE');
    const base = registry;
    const securedRegistry = Object.freeze({ ...base,
      async createFresh() { await guardOwner(); const value = await base.createFresh(); await guardOwner(); return value; },
      async createRestoreStage() { await guardOwner(); const value = await base.createRestoreStage(); await guardOwner(); return value; },
      async finalizeRestore(input) { await guardOwner(); const value = await base.finalizeRestore(input); await guardOwner(); return value; },
      async activate(input) { await guardOwner(); const value = await base.activate(input); await guardOwner(); return value; },
      async readActive() {
        current(); const row = await directory.get('owners', binding.key); current();
        if (!row || row.state !== 'ready' || row.controlId !== binding.controlId || !sameOwner(row.owner, owner)) throw failure('OWNER_LOCKED');
        const active = await base.readActive(); current(); return active;
      }, close });
    registerManagedSourceRegistryAlias(base,securedRegistry);
    return Object.freeze({ owner: Object.freeze({ ...owner }), controlId: binding.controlId, registry: securedRegistry, close });
  } catch (error) {
    if (creator && !closed) {
      try { const tx = directory.transaction('owners', 'readwrite'); const row = await tx.store.get(binding.key); if (row?.state === 'initializing') await tx.store.put({ ...row, state: 'failed', error: error.code || 'STORAGE_UNAVAILABLE' }); await tx.done; } catch { /* preserve original failure and initialized databases */ }
    }
    close(); throw error;
  }
}

/** Called only after account deletion has been authorized; retains old unsynced facts. */
export async function lockProfileOwner(value, { blockedTimeoutMs = 5000 } = {}) {
  const owner = snapshotOwner(value); const directory = await openDirectory(blockedTimeoutMs);
  try {
    const tx = directory.transaction('owners', 'readwrite'); const key = ownerKey(owner);
    const row = await tx.store.get(key);
    if (row) { if (!sameOwner(row.owner, owner)) throw failure('CORRUPT'); await tx.store.put({ ...row, state: 'locked' }); }
    await tx.done;
  } finally { directory.close(); }
}

