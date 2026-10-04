import {createReadonlyContentRanges} from './readonly-content-ranges.js';
import {createReadonlyRegisteredBankStreamer} from '../cloud-recovery/readonly-bank-content-stream.js';
const readonlyAuthorities=new WeakMap();
export async function assertReadonlyAuthorityPair(value,database){const state=readonlyAuthorities.get(value);if(!state||state.database!==database)throw Object.assign(new Error('READONLY_AUTHORITY_PAIR'),{code:'READONLY_AUTHORITY_PAIR'});await state.check();}
import { wrap } from 'idb';
import { APP_DATA_STORES, canonicalBytes, computeMutationDigest, verifyMutationDigest, validateMutation, validateMutationRecord, validateMetaRecord, validateWriterLeaseRecord, validateStoreRecord } from '../../domain/app-data/index.js';
import { assertBusinessSchema, BUSINESS_SCHEMA_VERSION, upgradeBusinessSchema } from './schema.js';
import { storageError } from './transaction.js';
import { snapshotOwner, sameOwner, assertBusinessDbName } from '../profiles/control-schema.js';
import { validatePushRequest, validatePushResponse, validatePushAcknowledgement } from '../../domain/app-data/index.js';
import { mutationWire, validateSyncReceipt } from '../sync/protocol.js';
import {withProfileWriteLock,validateProfileWriteLockKey} from '../profiles/write-lock.js';
import { ownedWriteInput,validateOwnedWriteRecord } from './write-input.js';
import {prepareStarConflictResolution} from '../sync/star-resolution.js';
import {STAR_GROUP_FORMAT,STAR_GROUP_STORES,STAR_GROUP_READ_BYTES,prepareStarConflictGroupResolution,projectStarConflictGroup} from '../sync/star-group-resolution.js';
import {assertHeldCheckpointSourceLease} from '../profiles/managed-profile-registry.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROBE = '00000000-0000-4000-8000-000000000001';
const META = ['clientStreamId', 'clientSeq', 'clockHighWaterMs'];
const fail = (code, cause) => storageError(code, code, cause);
const copy = value => structuredClone(value);
const eq = (a, b) => a === undefined || b === undefined ? a === b : new TextDecoder().decode(canonicalBytes(a)) === new TextDecoder().decode(canonicalBytes(b));
const recordEqual = (store, a, b) => store === 'content_chunks' && a && b
  ? a.contentDigest === b.contentDigest && a.chunkIndex === b.chunkIndex && a.bytes.length === b.bytes.length && a.bytes.every((byte, i) => byte === b.bytes[i])
  : eq(a, b);
const integer = n => { if (!Number.isSafeInteger(n) || n < 0) throw fail('INVALID_INPUT'); return n; };
const uuid = n => { if (!UUID.test(n)) throw fail('INVALID_INPUT'); return n; };
/** Only a genuine exclusive-held registry source/raw pair can bypass the
 * shared-lock wrapper. No caller token/clock/TTL/owner inputs are accepted. */
export async function renewHeldCheckpointSourceLease(capability,database){
  const binding=assertHeldCheckpointSourceLease(capability,database);
  binding.assertLive();await binding.check();await assertBusinessSchema(wrap(database));binding.assertLive();
  const context=binding.context,ttlMs=15000;let nowMs=integer(Date.now());
  if(nowMs>Number.MAX_SAFE_INTEGER-ttlMs)throw fail('LEASE_TIME_EXHAUSTED');
  const renewed=await new Promise((resolve,reject)=>{
    let transaction,ended=false,timer,result;
    const finish=error=>{if(ended)return;ended=true;clearTimeout(timer);remove?.();if(error)reject(error);else resolve(result);};let remove;
    try{binding.assertLive();transaction=database.transaction(['meta'],'readwrite');remove=binding.trackTransaction(transaction);timer=setTimeout(()=>{try{transaction.abort();}catch{}finish(fail('NATIVE_STORE_NOT_COMMITTED'));},binding.timeoutMs);
      transaction.oncomplete=()=>finish();transaction.onabort=()=>finish(fail('NATIVE_STORE_NOT_COMMITTED'));transaction.onerror=()=>{};
      const store=transaction.objectStore('meta'),keys=[...META,'syncCoordinatorLease'],rows={};let remaining=keys.length;
      for(const key of keys){const request=store.get(key);request.onsuccess=()=>{try{binding.assertLive();rows[key]=request.result;if(--remaining)return;
        for(const name of META){validateMetaRecord(rows[name]);if(rows[name].key!==name)throw fail('CORRUPT');}validateMetaRecord(rows.syncCoordinatorLease);
        const old=rows.syncCoordinatorLease.value;
        nowMs=integer(Date.now());if(nowMs>Number.MAX_SAFE_INTEGER-ttlMs)throw fail('LEASE_TIME_EXHAUSTED');
        if(nowMs<rows.clockHighWaterMs.value)throw fail('CLOCK_ROLLBACK');
        if(old.ownerTabId!==context.ownerTabId||old.fence!==context.fence||old.expiresAt<=nowMs)throw fail('SYNC_FENCE_LOST');
        result={ownerTabId:old.ownerTabId,fence:old.fence,expiresAt:nowMs+ttlMs};validateMetaRecord({key:'syncCoordinatorLease',value:result});
        // All exact original rows were read under this same native RW lock.
        store.put({key:'clockHighWaterMs',value:nowMs});store.put({key:'syncCoordinatorLease',value:result});
      }catch(error){try{transaction.abort();}catch{}finish(error);}};}
    }catch(error){try{transaction?.abort();}catch{}finish(error);}
  });
  binding.assertLive();await binding.check();binding.assertLive();return renewed;
}
function dataObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw fail('INVALID_INPUT');
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !('value' in Object.getOwnPropertyDescriptor(value, key)))) throw fail('INVALID_INPUT');
  return value;
}
function dataArray(value) {
  if (!Array.isArray(value) || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !('value' in Object.getOwnPropertyDescriptor(value, key)))) throw fail('INVALID_INPUT');
  for (let i = 0; i < value.length; i++) if (!Object.hasOwn(value, i)) throw fail('INVALID_INPUT');
  return value;
}

function openExisting(profile, budget, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let request;
    const finish = (error, db) => {
      if (settled) { db?.close(); return; }
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      if (error) reject(error); else resolve(db);
    };
    const cancel = () => finish(fail('CLOSED'));
    const timer = setTimeout(cancel, budget);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) { cancel(); return; }
    try { request = indexedDB.open(assertBusinessDbName(profile.dbName), BUSINESS_SCHEMA_VERSION); }
    catch (error) { finish(fail('STORAGE_UNAVAILABLE', error)); return; }
    request.onupgradeneeded = event => {
      if (settled || signal?.aborted) { request.transaction.abort(); return; }
      try { upgradeBusinessSchema(request.result, event.oldVersion, event.newVersion, request.transaction); }
      catch (error) { request.transaction.abort(); finish(error); }
    };
    request.onerror = () => finish(fail('STORAGE_UNAVAILABLE', request.error));
    request.onsuccess = () => {
      const db = request.result;
      if (settled || signal?.aborted) { db.close(); cancel(); return; }
      finish(null, db);
    };
  });
}

/** Private native request chaining. Every result is resolved only on tx completion.
 * registry is an already-open managed registry; owner comes from trusted session metadata.
 * now is injectable for deterministic tests, and defaults to wall clock.
 */
export async function openB1bAuthority({ registry, owner, ownerTabId, blockedTimeoutMs = 5000, signal, now = Date.now }) {
  const boundOwner = snapshotOwner(owner);
  uuid(ownerTabId); integer(blockedTimeoutMs);
  if (!blockedTimeoutMs || blockedTimeoutMs > 2147483647 || typeof now !== 'function' || !registry || typeof registry.readActive !== 'function') throw fail('INVALID_INPUT');
  if (registry.ownerSnapshot && !sameOwner(boundOwner, registry.ownerSnapshot())) throw fail('OWNER_MISMATCH');
  const writeLockKey=validateProfileWriteLockKey(registry.profileWriteLockKey?.());
  let closed = false; let epoch = 0; let db;
  const writeLifecycle=new AbortController();
  const transactions = new Map();
  const close = () => {
    if (closed) return;
    closed = true; epoch++;
    writeLifecycle.abort();
    signal?.removeEventListener('abort', close);
    for (const [transaction, rejectClosed] of transactions) { try { transaction.abort(); } catch { /* settled */ } rejectClosed(); }
    db?.close();
  };
  signal?.addEventListener('abort', close, { once: true });
  const guard = captured => { if (closed || signal?.aborted || captured !== epoch) throw fail('CLOSED'); };
  let active;
  function matching(current) {
    if (!current?.profile || !current.pointer || current.profile.state !== 'ready' || !current.profile.verification) return false;
    const profile = current.profile;
    if (profile.ownerKind !== boundOwner.ownerKind || (profile.ownerKind === 'account' && (profile.accountId !== boundOwner.accountId || profile.accountGeneration !== boundOwner.accountGeneration))) return false;
    return !active || (profile.profileId === active.profile.profileId && profile.dbName === active.profile.dbName && current.pointer.activationRevision === active.pointer.activationRevision && eq(profile, active.profile));
  }
  async function authority(captured = epoch) {
    guard(captured);
    const current = await registry.readActive(); guard(captured);
    if (!matching(current)) throw fail('STALE_ACTIVE_PROFILE');
    return current;
  }
  try {
    active = copy(await authority());
    // A missing managed DB is never opened: WebKit may retain an aborted
    // version-zero shell after onupgradeneeded. Capability absence is explicit.
    if (typeof indexedDB.databases !== 'function') throw fail('DATABASE_INVENTORY_UNAVAILABLE');
    let inventory;
    try { inventory = await indexedDB.databases(); } catch (error) { throw fail('DATABASE_INVENTORY_UNAVAILABLE', error); }
    guard(epoch);
    if (!inventory.some(row => row.name === active.profile.dbName && (row.version === 1 || row.version === BUSINESS_SCHEMA_VERSION))) throw fail('SCHEMA_MISMATCH');
    db = await openExisting(active.profile, blockedTimeoutMs, signal); guard(epoch);
    db.onversionchange = close;
    await assertBusinessSchema(wrap(db));
    await authority();
  } catch (error) { close(); throw error; }

  const snapshot = () => ({ profileId: active.profile.profileId, activationRevision: active.pointer.activationRevision, owner: copy(boundOwner), ownerTabId, closed });
  const guardedWrite=work=>async input=>{
    const owned=ownedWriteInput(input??{}),captured=epoch;guard(captured);
    return withProfileWriteLock(writeLockKey,'shared',async()=>{guard(captured);await authority(captured);return work(owned);},{signal:writeLifecycle.signal,timeoutMs:blockedTimeoutMs});
  };
  function tx(stores, mode, start, captured) {
    guard(captured);
    return new Promise((resolve, reject) => {
      let transaction; let result; let primary; let settled = false;
      try { transaction = db.transaction([...new Set(stores)], mode); }
      catch (error) { reject(fail('CLOCK_HISTORY_NOT_COMMITTED', error)); return; }
      const rejectOnce = error => { if (settled) return; settled = true; transactions.delete(transaction); reject(error); };
      transactions.set(transaction, () => rejectOnce(fail('CLOCK_HISTORY_NOT_COMMITTED', fail('CLOSED'))));
      const abort = error => { primary = error; try { transaction.abort(); } catch { /* settled */ } };
      transaction.oncomplete = () => { transactions.delete(transaction); if (settled) return; try { guard(captured); settled = true; resolve(result); } catch (error) { rejectOnce(fail('CLOCK_HISTORY_NOT_COMMITTED', error)); } };
      transaction.onabort = () => rejectOnce(fail('CLOCK_HISTORY_NOT_COMMITTED', primary || transaction.error));
      transaction.onerror = () => {};
      const get = (store, key, done) => {
        const r = transaction.objectStore(store).get(key);
        r.onerror = () => abort(r.error);
        r.onsuccess = () => { try { guard(captured); done(r.result); } catch (error) { abort(error); } };
      };
      const read = (rows, done) => {
        const values = {}; let left = rows.length;
        if (!left) { done(values); return; }
        for (const row of rows) get(row.store, row.key, value => { values[row.name] = value; if (!--left) done(values); });
      };
      try { start(transaction, read, value => { result = value; }, abort); } catch (error) { abort(error); }
    });
  }
  async function settle(result, captured) {
    await authority(captured);
    if (result?.error) throw fail(result.error);
    return result;
  }
  function meta(rows) {
    const result = {};
    for (const name of META) {
      if (!rows[name]) throw fail('CORRUPT_META_INIT');
      try { validateMetaRecord(rows[name]); } catch (error) { throw fail('CORRUPT_META_INIT', error); }
      result[name] = rows[name].value;
    }
    return result;
  }
  const metaReads = META.map(key => ({ store: 'meta', key, name: key }));
  const projectionReads=['projectionVersion','projectionInvalidationRevision','projectionAppliedRevision'].map(key=>({store:'meta',key,name:key}));
  function invalidateProjection(t,rows){
    for(const {name} of projectionReads)if(rows[name])validateMetaRecord(rows[name]);
    const invalidation=rows.projectionInvalidationRevision?.value??0;
    if(invalidation===Number.MAX_SAFE_INTEGER)throw fail('REVISION_EXHAUSTED');
    t.objectStore('meta').put({key:'projectionVersion',value:1});
    t.objectStore('meta').put({key:'projectionInvalidationRevision',value:invalidation+1});
    if(!rows.projectionAppliedRevision)t.objectStore('meta').put({key:'projectionAppliedRevision',value:0});
  }
  async function initializeStream(input = {}) {
    canonicalBytes(input);
    const suppliedNowMs=input.nowMs;if(suppliedNowMs!==undefined)integer(suppliedNowMs);const captured=epoch;await authority(captured);
    const result = await tx(Object.keys(APP_DATA_STORES), 'readwrite', (t, read, finish, abort) => {
      read(metaReads, values => {
        if (META.every(key => values[key] === undefined)) {
          let left = Object.keys(APP_DATA_STORES).length; let empty = true;
          for (const name of Object.keys(APP_DATA_STORES)) {
            const request = t.objectStore(name).count();
            request.onsuccess = () => {
              try {
              guard(captured);
              empty = empty && request.result === 0;
              if (--left) return;
              if (!empty) { finish({ error: 'CORRUPT_META_INIT' }); return; }
              const stream = uuid(crypto.randomUUID()),nowMs=integer(suppliedNowMs??now());
              t.objectStore('meta').put({ key: 'clientStreamId', value: stream });
              t.objectStore('meta').put({ key: 'clientSeq', value: 0 });
              t.objectStore('meta').put({ key: 'clockHighWaterMs', value: nowMs });
              finish({ clientStreamId: stream, clientSeq: 0 });
              } catch (error) { abort(error); }
            };
          }
        } else {
          try { const m = meta(values); finish({ clientStreamId: m.clientStreamId, clientSeq: m.clientSeq }); }
          catch { finish({ error: 'CORRUPT_META_INIT' }); }
        }
      });
    }, captured);
    return settle(result, captured);
  }
  async function writer(input, mode) {
    canonicalBytes(input);
    const attemptId = uuid(input.attemptId || input.token?.attemptId);
    const suppliedNowMs=input.nowMs;if(suppliedNowMs!==undefined)integer(suppliedNowMs);
    const ttlMs = mode === 'release' ? 0 : integer(input.ttlMs ?? 15000);
    if (mode !== 'release' && !ttlMs) throw fail('INVALID_INPUT');
    if (input.token) { canonicalBytes(input.token); validateWriterLeaseRecord(input.token); }
    const token = input.token && copy(input.token); const captured = epoch; await authority(captured);
    const result = await tx(['meta', 'writer_leases'], 'readwrite', (t, read, finish) => {
      read([...metaReads, { store: 'writer_leases', key: attemptId, name: 'lease' }], values => {
        let m; try { m = meta(values); if (values.lease) validateWriterLeaseRecord(values.lease); }
        catch { finish({ error: 'CORRUPT_META_INIT' }); return; }
        const nowMs=integer(suppliedNowMs??now());
        if (nowMs < m.clockHighWaterMs) { finish({ error: 'CLOCK_ROLLBACK' }); return; }
        t.objectStore('meta').put({ key: 'clockHighWaterMs', value: nowMs });
        const old = values.lease;
        if (nowMs > Number.MAX_SAFE_INTEGER - ttlMs) { finish({ error: 'LEASE_TIME_EXHAUSTED' }); return; }
        let record;
        if (mode === 'acquire') {
          if (old && old.expiresAt > nowMs && old.ownerTabId !== ownerTabId) { finish({ error: 'LEASE_BUSY' }); return; }
          const takeover = old && old.expiresAt <= nowMs;
          if (takeover && old.fence === Number.MAX_SAFE_INTEGER) { finish({ error: 'FENCE_EXHAUSTED' }); return; }
          record = { attemptId, ownerTabId, fence: old ? old.fence + (takeover ? 1 : 0) : 1, expiresAt: old && !takeover ? old.expiresAt : nowMs + ttlMs, exportExcluded: true };
        } else {
          if (!old || !token || token.attemptId !== attemptId || token.ownerTabId !== ownerTabId || old.ownerTabId !== ownerTabId || old.fence !== token.fence || old.expiresAt <= nowMs) { finish({ error: 'STALE_LEASE' }); return; }
          record = { ...old, expiresAt: mode === 'release' ? nowMs : nowMs + ttlMs };
        }
        validateWriterLeaseRecord(record); t.objectStore('writer_leases').put(record);
        finish(mode === 'release' ? undefined : record);
      });
    }, captured);
    return settle(result, captured);
  }
  async function prepareMutation(draft) {
    canonicalBytes(draft);
    const keys = draft && Object.keys(draft).sort().join(',');
    if (keys !== 'entityKey,kind,mutationId,payload,protocolVersion') throw fail('INVALID_INPUT');
    const value = copy(draft);
    const probe = { ...value, clientStreamId: PROBE, clientSeq: 1, payloadDigest: '0'.repeat(64) };
    validateMutation(probe);
    const payloadDigest = await computeMutationDigest(probe);
    if (!(await verifyMutationDigest({ ...probe, payloadDigest }))) throw fail('INVALID_INPUT');
    return { ...value, payloadDigest };
  }
  /** Atomic command commit. Records are frozen DTOs, not raw database handles.
   * Conditions compare exact read snapshots; payload hashing happens before this transaction.
   * All mutations and their durable outbox intent commit together with business records.
   */
  // Implicit wall time is sampled only after the transaction owns its meta cut.
  // Caller-supplied deterministic times retain exact rollback validation.
  async function commit(input, privateWithdrawal) {
    dataObject(input);
    const { lease, mutationDrafts = [], records = [], conditions = [], nowMs: suppliedNowMs } = input;
    dataArray(mutationDrafts); dataArray(records); dataArray(conditions);
    if(suppliedNowMs!==undefined)integer(suppliedNowMs); canonicalBytes(lease); validateWriterLeaseRecord(lease);
    const token = copy(lease);
    if(Object.hasOwn(input,'withdrawOutbox')||Object.hasOwn(input,'withdrawOutboxes'))throw fail('INVALID_INPUT');
    // All caller-owned data is validated and captured before the first await.
    for (const row of records) {
      dataObject(row);
      const descriptors = Object.getOwnPropertyDescriptors(row);
      if (!descriptors.store || !descriptors.value || !('value' in descriptors.store) || !('value' in descriptors.value) || Object.keys(descriptors).some(key => !['store', 'value'].includes(key))) throw fail('INVALID_INPUT');
      if (['meta', 'writer_leases', 'mutations', 'outbox'].includes(row.store)) throw fail('INVALID_INPUT');
      validateOwnedWriteRecord(row.store, row.value);
      if(row.store==='import_receipts'&&(['qb-star-conflict-resolution-v1',STAR_GROUP_FORMAT].includes(row.value.provenance?.format)||row.value.sourceId===STAR_GROUP_FORMAT)&&!privateWithdrawal)throw fail('INVALID_INPUT');
    }
    for (const row of conditions) {
      dataObject(row);
      const descriptors = Object.getOwnPropertyDescriptors(row);
      if (Object.values(descriptors).some(d => !('value' in d))) throw fail('INVALID_INPUT');
      canonicalBytes({ store: row.store, key: row.key });
      if (!Object.hasOwn(APP_DATA_STORES, row.store)) throw fail('INVALID_INPUT');
      if (row.expected !== undefined) validateStoreRecord(row.store, row.expected);
    }
    mutationDrafts.forEach(canonicalBytes);
    const capturedDrafts = copy(mutationDrafts); const writes = copy(records); const checks = copy(conditions);
    const captured = epoch; await authority(captured);
    const prepared = await Promise.all(capturedDrafts.map(prepareMutation));
    if (new Set(prepared.map(p => p.mutationId)).size !== prepared.length) throw fail('INVALID_INPUT');
    await authority(captured);
    const stores = ['meta', 'writer_leases', 'mutations', 'outbox', ...writes.map(r => r.store), ...checks.map(r => r.store)];
    const result = await tx(stores, 'readwrite', (t, read, finish, abort) => {
      const keyOf = row => { const path = APP_DATA_STORES[row.store].keyPath; return Array.isArray(path) ? path.map(key => row.value[key]) : row.value[path]; };
      read([...metaReads,...projectionReads, { store: 'writer_leases', key: token.attemptId, name: 'lease' }, ...prepared.map((p, i) => ({ store: 'mutations', key: p.mutationId, name: `m${i}` })), ...checks.map((p, i) => ({ store: p.store, key: p.key, name: `c${i}` })), ...writes.map((p, i) => ({ store: p.store, key: keyOf(p), name: `w${i}` }))], values => {
        let m; try { m = meta(values); if (values.lease) validateWriterLeaseRecord(values.lease); } catch { finish({ error: 'CORRUPT_META_INIT' }); return; }
        const nowMs=integer(suppliedNowMs??now());
        if (nowMs < m.clockHighWaterMs) { finish({ error: 'CLOCK_ROLLBACK' }); return; }
        if(privateWithdrawal?.mode!=='star-group')t.objectStore('meta').put({ key: 'clockHighWaterMs', value: nowMs });
        if (!values.lease || token.ownerTabId !== ownerTabId || values.lease.ownerTabId !== ownerTabId || token.fence !== values.lease.fence || values.lease.expiresAt <= nowMs) { finish({ error: 'STALE_LEASE' }); return; }
        const generation = boundOwner.ownerKind === 'account' ? boundOwner.accountGeneration : undefined;
        const found = prepared.map((p, i) => values[`m${i}`]);
        for (let i = 0; i < prepared.length; i++) {
          const old = found[i], p = prepared[i]; if (!old) continue;
          try { validateMutationRecord(old); } catch { finish({ error: 'MUTATION_ID_CONFLICT' }); return; }
          if (old.clientStreamId !== m.clientStreamId || old.accountGeneration !== generation || old.clientSeq > m.clientSeq || old.payloadDigest !== p.payloadDigest || !eq({ protocolVersion: old.protocolVersion, kind: old.kind, entityKey: old.entityKey, payload: old.payload }, { protocolVersion: p.protocolVersion, kind: p.kind, entityKey: p.entityKey, payload: p.payload })) { finish({ error: 'MUTATION_ID_CONFLICT' }); return; }
        }
        if (found.length && found.every(Boolean)) {
          if (writes.some((row, i) => !recordEqual(row.store, values[`w${i}`], row.value))) { finish({ error: 'MUTATION_ID_CONFLICT' }); return; }
          finish({ mutations: found, duplicate: true }); return;
        }
        if (found.some(Boolean)) { finish({ error: 'MUTATION_BATCH_CONFLICT' }); return; }
        for (let i = 0; i < checks.length; i++) if (!recordEqual(checks[i].store, values[`c${i}`], checks[i].expected)) { if(privateWithdrawal?.mode==='star-group')abort(fail('STAR_GROUP_VIEW_STALE'));else finish({ error: 'REVISION_CONFLICT' }); return; }
        if (m.clientSeq > Number.MAX_SAFE_INTEGER - prepared.length) { finish({ error: 'SEQ_EXHAUSTED' }); return; }
        // Check all target tuples before scheduling any factual write. Unique-index
        // request failure also aborts the complete transaction, including the clock.
        const tuples = prepared.map((p, i) => [m.clientStreamId, m.clientSeq + i + 1]);
        let remaining = tuples.length;
        const append = () => {
          if(privateWithdrawal?.mode==='star-group')t.objectStore('meta').put({key:'clockHighWaterMs',value:nowMs});
          const mutations = prepared.map((p, i) => ({ ...p, clientStreamId: m.clientStreamId, clientSeq: tuples[i][1], createdAt: nowMs, ...(generation ? { accountGeneration: generation } : {}) }));
          mutations.forEach(validateMutationRecord);
          if(writes.length)invalidateProjection(t,values);
          for (const row of writes) t.objectStore(row.store).put(row.value);
          if(privateWithdrawal?.mode==='star-group')for(const row of privateWithdrawal.members)t.objectStore('outbox').delete(row.mutationId);
          else if(privateWithdrawal)t.objectStore('outbox').delete(privateWithdrawal.mutationId);
          for (const record of mutations) {
            t.objectStore('mutations').add(record);
            t.objectStore('outbox').add({ mutationId: record.mutationId, nextAttemptAt: nowMs, attemptCount: 0 });
          }
          if (mutations.length) t.objectStore('meta').put({ key: 'clientSeq', value: m.clientSeq + mutations.length });
          finish({ mutations, duplicate: false });
        };
        const checkTuples=()=>{
        if (!remaining) { append(); return; }
        let collision = false;
        for (const tuple of tuples) {
          const r = t.objectStore('mutations').index('streamSequence').getKey(tuple);
          r.onsuccess = () => { try { guard(captured); collision ||= r.result !== undefined; if (!--remaining) { if (collision) finish({ error: 'STREAM_SEQUENCE_CONFLICT' }); else append(); } } catch (error) { abort(error); } };
        }
        };
        if(privateWithdrawal?.mode==='star-group')readStarGroupCut(t,captured,state=>{try{if(!eq(projectStarConflictGroup(state,boundOwner,privateWithdrawal.group.entityKey),privateWithdrawal.group))throw fail('STAR_GROUP_VIEW_STALE');checkTuples();}catch(cause){abort(fail('STAR_GROUP_VIEW_STALE',cause));}},abort);
        else checkTuples();
      });
    }, captured);
    return settle(result, captured);
  }
  async function readRecords(store, key, index) {
    if (!Object.hasOwn(APP_DATA_STORES, store)) throw fail('INVALID_INPUT');
    const captured = epoch; await authority(captured);
    const result = await tx([store], 'readonly', (t, _read, finish) => {
      const source = index ? t.objectStore(store).index(index) : t.objectStore(store);
      const request = key === undefined || index ? source.getAll(key) : source.get(key);
      request.onsuccess = () => finish(request.result);
    }, captured);
    return settle(result, captured);
  }
  async function readAttempt(attemptId) {
    uuid(attemptId); const captured = epoch; await authority(captured);
    const result = await tx(['attempts', 'attempt_scope', 'drafts', 'answer_events'], 'readonly', (t, _read, finish, abort) => {
      const values = {}; let left = 4;
      const requests = [
        ['attempt', t.objectStore('attempts').get(attemptId)],
        ['scope', t.objectStore('attempt_scope').index('attemptId').getAll(attemptId)],
        ['drafts', t.objectStore('drafts').index('attemptId').getAll(attemptId)],
        ['events', t.objectStore('answer_events').index('attemptId').getAll(attemptId)],
      ];
      for (const [name, request] of requests) request.onsuccess = () => { try { guard(captured); values[name] = request.result; if (!--left) { values.scope.sort((a, b) => a.ordinal - b.ordinal); values.events.sort((a, b) => a.actionSeq - b.actionSeq); finish(values); } } catch (error) { abort(error); } };
    }, captured);
    return settle(result, captured);
  }
  async function readSyncState() {
    const captured = epoch; await authority(captured);
    const stores = ['meta', 'mutations', 'outbox', 'conflicts', 'import_receipts'];
    const result = await tx(stores, 'readonly', (t, _read, finish, abort) => {
      const values = {}; let left = stores.length;
      for (const store of stores) { const request = t.objectStore(store).getAll(); request.onsuccess = () => { try { guard(captured); values[store === 'import_receipts' ? 'receipts' : store] = request.result; if (!--left) finish(values); } catch (error) { abort(error); } }; }
    }, captured);
    return settle(result, captured);
  }
  async function readStarResolutionState(){
    const captured=epoch;await authority(captured);const stores=['meta','mutations','outbox','conflicts','import_receipts','user_state'];
    const result=await tx(stores,'readonly',(t,_read,finish,abort)=>{const state={};let left=stores.length;for(const store of stores){const request=t.objectStore(store).getAll();request.onsuccess=()=>{try{guard(captured);state[store]=request.result;if(!--left)finish(state);}catch(cause){abort(cause);}}}},captured);return settle(result,captured);
  }
  // Cursor reads bound allocation BEFORE getAll could allocate an unbounded cut.
  // Reused in the final readwrite transaction; no await or second transaction.
  function readStarGroupCut(t,captured,done,abort){
    const state={};let remaining=STAR_GROUP_STORES.length,bytes=0;
    for(const store of STAR_GROUP_STORES){state[store]=[];const request=t.objectStore(store).openCursor();request.onsuccess=()=>{try{guard(captured);const cursor=request.result;if(cursor){validateStoreRecord(store,cursor.value);bytes+=canonicalBytes(cursor.value).length+1;if(bytes>STAR_GROUP_READ_BYTES)throw fail('STAR_GROUP_READ_LIMIT');state[store].push(cursor.value);cursor.continue();}else if(!--remaining){if(canonicalBytes(state).length>STAR_GROUP_READ_BYTES)throw fail('STAR_GROUP_READ_LIMIT');done(state);}}catch(cause){abort(cause);}};}
  }
  async function readStarGroupResolutionState(){
    const captured=epoch;await authority(captured);const result=await tx(STAR_GROUP_STORES,'readonly',(t,_read,finish,abort)=>readStarGroupCut(t,captured,finish,abort),captured);return settle(result,captured);
  }
  async function resolveStarConflictGroup(input){
    canonicalBytes(input);const owned=copy(input);if(Object.keys(owned).some(key=>!['commandId','entityKey','groupDigest','choice','lease','nowMs'].includes(key)))throw fail('INVALID_INPUT');
    const lease=owned.lease;validateWriterLeaseRecord(lease);const nowMs=owned.nowMs??now();integer(nowMs);
    const state=await readStarGroupResolutionState(),plan=await prepareStarConflictGroupResolution({commandId:owned.commandId,entityKey:owned.entityKey,groupDigest:owned.groupDigest,choice:owned.choice,state,owner:boundOwner,nowMs});
    if(plan.duplicate)return {duplicate:true,mutation:plan.mutation};
    const bundle=await readAttempt(lease.attemptId);if(!bundle.attempt||!bundle.scope.some(row=>row.questionKey===plan.mutationDraft.payload.questionKey))throw fail('QUESTION_NOT_IN_SCOPE');
    try{const result=await commit({lease,nowMs,mutationDrafts:[plan.mutationDraft],records:plan.records,conditions:[...plan.conditions,{store:'attempts',key:bundle.attempt.attemptId,expected:bundle.attempt}]},{mode:'star-group',group:plan.group,members:plan.withdrawOutboxes});return {duplicate:result.duplicate,mutation:result.mutations[0]};}
    catch(cause){if(cause.code==='STAR_GROUP_VIEW_STALE'||cause.cause?.code==='STAR_GROUP_VIEW_STALE')throw fail('STAR_GROUP_VIEW_STALE',cause);throw cause;}
  }
  async function resolveStarConflict(input){
    canonicalBytes(input);const owned=copy(input);
    if(Object.keys(owned).some(key=>!['commandId','conflictId','choice','expectedCloudDigest','expectedCloudRevision','lease','nowMs'].includes(key)))throw fail('INVALID_INPUT');
    const lease=owned.lease;validateWriterLeaseRecord(lease);const nowMs=owned.nowMs??now();integer(nowMs);
    const state=await readStarResolutionState();
    const plan=await prepareStarConflictResolution({commandId:owned.commandId,conflictId:owned.conflictId,choice:owned.choice,expectedCloudDigest:owned.expectedCloudDigest,expectedCloudRevision:owned.expectedCloudRevision,state,owner:boundOwner,nowMs});
    if(plan.duplicate)return {duplicate:true,mutation:plan.mutation};
    const questionKey=plan.mutationDraft.payload.questionKey,bundle=await readAttempt(lease.attemptId);
    if(!bundle.attempt||!bundle.scope.some(row=>row.questionKey===questionKey))throw fail('QUESTION_NOT_IN_SCOPE');
    const result=await commit({lease,nowMs,mutationDrafts:[plan.mutationDraft],records:plan.records,conditions:[...plan.conditions,{store:'attempts',key:bundle.attempt.attemptId,expected:bundle.attempt}]},plan.withdrawOutbox);
    return {duplicate:result.duplicate,mutation:result.mutations[0]};
  }
  async function readFacts() {
    const captured=epoch; await authority(captured);
    const stores=Object.keys(APP_DATA_STORES);
    const result=await tx(stores,'readonly',(t,_read,finish)=>{
      const values={};let left=stores.length;
      for(const store of stores){const request=t.objectStore(store).getAll();request.onsuccess=()=>{values[store]=request.result;if(!--left)finish(values);};}
    },captured);
    return settle(result,captured);
  }
  async function commitPullFacts(input) {
    dataObject(input); canonicalBytes(input.context); canonicalBytes(input.conditions); canonicalBytes(input.deletes);
    dataArray(input.records); for(const row of input.records){dataObject(row);validateStoreRecord(row.store,row.value);if(row.store==='import_receipts'&&([STAR_GROUP_FORMAT,'qb-star-conflict-resolution-v1'].includes(row.value.provenance?.format)||row.value.sourceId===STAR_GROUP_FORMAT))throw fail('INVALID_INPUT');}
    const owned=copy(input), {context,records,conditions,deletes,nextCursor}=owned;
    if(deletes.some(row=>row.store==='import_receipts'&&Array.isArray(row.key)&&row.key[0]===STAR_GROUP_FORMAT))throw fail('INVALID_INPUT');
    validateMetaRecord({key:'appliedPullCursor',value:nextCursor});
    if(boundOwner.ownerKind!=='account'||!eq(context.owner,{accountId:boundOwner.accountId,accountGeneration:boundOwner.accountGeneration})||context.profileId!==active.profile.profileId||context.activationRevision!==active.pointer.activationRevision||context.ownerTabId!==ownerTabId)throw fail('OWNER_MISMATCH');
    if(records.some(row=>['meta','writer_leases','mutations','outbox'].includes(row.store))||deletes.some(row=>!Object.hasOwn(APP_DATA_STORES,row.store)||['meta','writer_leases','mutations','outbox'].includes(row.store)))throw fail('INVALID_INPUT');
    const suppliedNowMs=owned.nowMs;if(suppliedNowMs!==undefined)integer(suppliedNowMs);const captured=epoch;await authority(captured);
    const reads=[...metaReads,...projectionReads,{store:'meta',key:'syncCoordinatorLease',name:'lease'},{store:'meta',key:'serverLogEpoch',name:'logEpoch'},{store:'meta',key:'appliedPullCursor',name:'cursor'},...conditions.map((row,i)=>({store:row.store,key:row.key,name:`condition${i}`}))];
    const result=await tx(Object.keys(APP_DATA_STORES),'readwrite',(t,read,finish)=>read(reads,rows=>{
      const m=meta(rows),lease=rows.lease?.value;if(rows.lease)validateMetaRecord(rows.lease);const nowMs=integer(suppliedNowMs??now());
      if(!lease||lease.ownerTabId!==ownerTabId||lease.fence!==context.fence||lease.expiresAt<=nowMs){finish({error:'STALE_LEASE'});return;}
      if(rows.logEpoch?.value!==context.logEpoch||(rows.cursor?.value??null)!==context.appliedPullCursor){finish({error:'SYNC_CONTEXT_STALE'});return;}
      if(nowMs<m.clockHighWaterMs){finish({error:'CLOCK_ROLLBACK'});return;}
      for(let i=0;i<conditions.length;i++)if(!recordEqual(conditions[i].store,rows[`condition${i}`],conditions[i].expected)){finish({error:'REVISION_CONFLICT'});return;}
      if(owned.applied)invalidateProjection(t,rows);
      for(const row of deletes)t.objectStore(row.store).delete(row.key);
      for(const row of records)t.objectStore(row.store).put(row.value);
      t.objectStore('meta').put({key:'clockHighWaterMs',value:nowMs});t.objectStore('meta').put({key:'appliedPullCursor',value:nextCursor});
      finish({applied:owned.applied,cursor:nextCursor});
    }),captured);return settle(result,captured);
  }
  async function syncCoordinator(input = {}, mode = 'acquire') {
    canonicalBytes(input); const capturedInput = copy(input);
    const suppliedNowMs=capturedInput.nowMs;if(suppliedNowMs!==undefined)integer(suppliedNowMs);
    const ttlMs = mode === 'release' ? 0 : integer(capturedInput.ttlMs ?? 15000);
    if (mode !== 'release' && !ttlMs) throw fail('INVALID_INPUT');
    if (capturedInput.token) validateMetaRecord({ key: 'syncCoordinatorLease', value: capturedInput.token });
    const captured = epoch; await authority(captured);
    const result = await tx(['meta'], 'readwrite', (t, read, finish) => {
      read([...metaReads, { store: 'meta', key: 'syncCoordinatorLease', name: 'lease' }], rows => {
        const m = meta(rows); if (rows.lease) validateMetaRecord(rows.lease);
        const nowMs=integer(suppliedNowMs??now());
        if (nowMs < m.clockHighWaterMs) { finish({ error: 'CLOCK_ROLLBACK' }); return; }
        t.objectStore('meta').put({ key: 'clockHighWaterMs', value: nowMs });
        const old = rows.lease?.value, token = capturedInput.token;
        if (nowMs > Number.MAX_SAFE_INTEGER - ttlMs) { finish({ error: 'LEASE_TIME_EXHAUSTED' }); return; }
        if (mode === 'acquire') {
          if (old && old.expiresAt > nowMs && old.ownerTabId !== ownerTabId) { finish({ error: 'LEASE_BUSY' }); return; }
          if (old?.expiresAt <= nowMs && old.fence === Number.MAX_SAFE_INTEGER) { finish({ error: 'FENCE_EXHAUSTED' }); return; }
        } else if (!old || !token || token.ownerTabId !== ownerTabId || old.ownerTabId !== ownerTabId || old.fence !== token.fence || old.expiresAt <= nowMs) { finish({ error: 'STALE_LEASE' }); return; }
        const value = { ownerTabId, fence: mode === 'acquire' ? old ? old.fence + (old.expiresAt <= nowMs ? 1 : 0) : 1 : old.fence, expiresAt: mode === 'release' ? nowMs : mode === 'acquire' && old?.expiresAt > nowMs ? old.expiresAt : nowMs + ttlMs };
        validateMetaRecord({ key: 'syncCoordinatorLease', value }); t.objectStore('meta').put({ key: 'syncCoordinatorLease', value }); finish(value);
      });
    }, captured);
    return settle(result, captured);
  }
  async function snapshotSyncContext(input) {
    canonicalBytes(input); const token = copy(input.token); validateMetaRecord({ key: 'syncCoordinatorLease', value: token });
    if (boundOwner.ownerKind !== 'account') throw fail('ACCOUNT_REQUIRED');
    const state = await readSyncState(), lease = state.meta.find(row => row.key === 'syncCoordinatorLease')?.value;
    if (!lease || lease.ownerTabId !== ownerTabId || lease.fence !== token.fence || lease.expiresAt <= now()) throw fail('STALE_LEASE');
    return { owner: { accountId: boundOwner.accountId, accountGeneration: boundOwner.accountGeneration }, profileId: active.profile.profileId, activationRevision: active.pointer.activationRevision, ownerTabId, fence: lease.fence, logEpoch: state.meta.find(row => row.key === 'serverLogEpoch')?.value ?? null, appliedPullCursor: state.meta.find(row => row.key === 'appliedPullCursor')?.value ?? null };
  }
  async function readOutboxBatch(input = {}) {
    canonicalBytes(input); const maxMutations = integer(input.maxMutations ?? 100), maxBytes = integer(input.maxBytes ?? 262144);
    if (!maxMutations || maxMutations > 100 || !maxBytes || maxBytes > 262144) throw fail('INVALID_INPUT');
    const state = await readSyncState(), pending = new Set(state.outbox.map(row => row.mutationId));
    const blocked = state.conflicts.filter(row => row.status === 'open').map(row => row.mutation);
    if (boundOwner.ownerKind !== 'account') throw fail('ACCOUNT_REQUIRED');
    const result = [];
    for (const row of state.mutations.filter(row => pending.has(row.mutationId)).sort((a, b) => a.clientSeq - b.clientSeq)) {
      if (blocked.some(prior => prior.mutationId === row.mutationId || ['attempt_manifest', 'resume_state'].includes(row.kind) && prior.kind === row.kind && prior.entityKey === row.entityKey && prior.clientSeq < row.clientSeq)) continue;
      const envelope = mutationWire(row);
      if (result.length >= maxMutations || canonicalBytes({ protocolVersion: 2, accountGeneration: boundOwner.accountGeneration, mutations: [...result, envelope] }).length > maxBytes) break;
      result.push(envelope);
    }
    return result;
  }
  async function snapshotSyncStatus(input) {
    canonicalBytes(input); const token = copy(input.token); validateMetaRecord({ key: 'syncCoordinatorLease', value: token });
    if (boundOwner.ownerKind !== 'account') throw fail('ACCOUNT_REQUIRED');
    const state = await readSyncState(), lease = state.meta.find(row => row.key === 'syncCoordinatorLease')?.value;
    if (!lease || lease.ownerTabId !== ownerTabId || token.ownerTabId !== ownerTabId || lease.fence !== token.fence || lease.expiresAt <= now()) throw fail('STALE_LEASE');
    return { outboxCount: state.outbox.length, openConflictCount: state.conflicts.filter(row => row.status === 'open').length, logEpoch: state.meta.find(row => row.key === 'serverLogEpoch')?.value ?? null, appliedPullCursor: state.meta.find(row => row.key === 'appliedPullCursor')?.value ?? null };
  }
  async function applyExactAck(input) {
    canonicalBytes(input); const owned = copy(input), { context, request, response } = owned;
    validatePushRequest(request); validatePushResponse(response);
    if (boundOwner.ownerKind !== 'account' || !eq(context.owner, { accountId: boundOwner.accountId, accountGeneration: boundOwner.accountGeneration }) || context.profileId !== active.profile.profileId || context.activationRevision !== active.pointer.activationRevision || context.ownerTabId !== ownerTabId || response.generation !== boundOwner.accountGeneration || request.accountGeneration !== boundOwner.accountGeneration) throw fail('OWNER_MISMATCH');
    if (context.logEpoch === null) { if (request.mutations.length || response.receipts.length) throw fail('SYNC_EPOCH_UNBOUND'); }
    else validatePushAcknowledgement(response, request, context.logEpoch);
    for (const receipt of response.receipts) {
      const mutation = request.mutations.find(row => row.mutationId === receipt.mutationId);
      if (['accepted', 'duplicate'].includes(receipt.status) && ['bank_revision', 'attempt_manifest', 'resume_state', 'user_state'].includes(mutation.kind) && receipt.currentRevision !== undefined && receipt.currentRevision !== mutation.payload.baseRevision + 1) throw fail('SYNC_RECEIPT_DIVERGENCE');
    }
    const suppliedNowMs=owned.nowMs;if(suppliedNowMs!==undefined)integer(suppliedNowMs);const captured=epoch;await authority(captured);
    const reads = [...metaReads, { store: 'meta', key: 'syncCoordinatorLease', name: 'syncLease' }, { store: 'meta', key: 'serverLogEpoch', name: 'logEpoch' }, { store: 'meta', key: 'appliedPullCursor', name: 'cursor' }];
    request.mutations.forEach((row, i) => { reads.push({ store: 'mutations', key: row.mutationId, name: `mutation${i}` }, { store: 'outbox', key: row.mutationId, name: `outbox${i}` }, { store: 'import_receipts', key: [`qb-sync-v2:${response.generation}:${response.logEpoch}`, `entity:${row.kind}:${row.entityKey}`], name: `receipt${i}` }); });
    const result = await tx(['meta', 'mutations', 'outbox', 'conflicts', 'import_receipts'], 'readwrite', (t, read, finish) => read(reads, rows => {
      const m = meta(rows), lease = rows.syncLease?.value;
      const nowMs=integer(suppliedNowMs??now());
      if (rows.syncLease) validateMetaRecord(rows.syncLease);
      if (!lease || lease.ownerTabId !== ownerTabId || lease.fence !== context.fence || lease.expiresAt <= nowMs) { finish({ error: 'STALE_LEASE' }); return; }
      if ((rows.logEpoch?.value ?? null) !== context.logEpoch || (rows.cursor?.value ?? null) !== context.appliedPullCursor) { finish({ error: 'SYNC_CONTEXT_STALE' }); return; }
      if (nowMs < m.clockHighWaterMs) { finish({ error: 'CLOCK_ROLLBACK' }); return; }
      for (let i = 0; i < request.mutations.length; i++) if (!rows[`mutation${i}`] || !rows[`outbox${i}`] || !eq(mutationWire(rows[`mutation${i}`]), request.mutations[i])) { finish({ error: 'SYNC_ACK_LOCAL_MISMATCH' }); return; }
      const receiptWrites = [], conflictWrites = [];
      for (const receipt of response.receipts) {
        const mutation = request.mutations.find(row => row.mutationId === receipt.mutationId);
        if (['accepted', 'duplicate'].includes(receipt.status) && ['bank_revision', 'attempt_manifest', 'resume_state', 'user_state'].includes(mutation.kind)) {
          const serverRevision = mutation.payload.baseRevision + 1;
          const record = { sourceId: `qb-sync-v2:${response.generation}:${response.logEpoch}`, sourceRecordId: `entity:${mutation.kind}:${mutation.entityKey}`, importedAt: nowMs, provenance: { format: 'qb-sync-entity-v1', kind: mutation.kind, entityKey: mutation.entityKey, serverRevision, payloadDigest: mutation.payloadDigest, generation: response.generation, logEpoch: response.logEpoch } };
          validateSyncReceipt(record);
          const prior = rows[`receipt${request.mutations.indexOf(mutation)}`];
          if (prior) validateSyncReceipt(prior);
          if (!prior || prior.provenance.serverRevision < serverRevision) receiptWrites.push(record);
          else if (prior.provenance.serverRevision === serverRevision && prior.provenance.payloadDigest !== record.provenance.payloadDigest) { finish({ error: 'SYNC_RECEIPT_DIVERGENCE' }); return; }
        } else if (receipt.status === 'conflict') { const record = { conflictId: mutation.mutationId, entityKey: mutation.entityKey, status: 'open', mutation, ...(receipt.currentRevision !== undefined ? { currentRevision: receipt.currentRevision } : {}) }; validateStoreRecord('conflicts', record); conflictWrites.push(record); }
      }
      t.objectStore('meta').put({ key: 'clockHighWaterMs', value: nowMs });
      if (context.logEpoch === null) t.objectStore('meta').put({ key: 'serverLogEpoch', value: response.logEpoch });
      const newestReceipts = new Map();
      for (const row of receiptWrites) {
        const key = row.sourceRecordId, prior = newestReceipts.get(key);
        if (!prior || prior.provenance.serverRevision < row.provenance.serverRevision) newestReceipts.set(key, row);
        else if (prior.provenance.serverRevision === row.provenance.serverRevision && prior.provenance.payloadDigest !== row.provenance.payloadDigest) throw fail('SYNC_RECEIPT_DIVERGENCE');
      }
      for (const row of newestReceipts.values()) t.objectStore('import_receipts').put(row);
      for (const row of conflictWrites) t.objectStore('conflicts').put(row);
      for (const receipt of response.receipts) if (['accepted', 'duplicate'].includes(receipt.status)) t.objectStore('outbox').delete(receipt.mutationId);
      finish({ accepted: response.receipts.filter(row => ['accepted', 'duplicate'].includes(row.status)).length, conflicts: conflictWrites.length, pending: response.receipts.filter(row => !['accepted', 'duplicate'].includes(row.status)).length });
    }), captured);
    return settle(result, captured);
  }
  const publicAuthority=Object.freeze({ createReadonlyBankRanges:async input=>{const captured=ownedWriteInput(input);await authority();return createReadonlyContentRanges(db,{reference:captured.reference,signal,authorityToken:publicAuthority});}, snapshot, initializeStream:guardedWrite(initializeStream), acquireWriter: guardedWrite(input => writer(input, 'acquire')), renewWriter: guardedWrite(input => writer(input, 'renew')), releaseWriter: guardedWrite(input => writer(input, 'release')), commit:guardedWrite(commit), readRecords, readAttempt, readSyncState, readStarResolutionState,resolveStarConflict:guardedWrite(resolveStarConflict),readStarGroupResolutionState,resolveStarConflictGroup:guardedWrite(resolveStarConflictGroup), readFacts, commitPullFacts:guardedWrite(commitPullFacts),
    acquireSyncCoordinator: guardedWrite(input => syncCoordinator(input, 'acquire')), renewSyncCoordinator: guardedWrite(input => syncCoordinator(input, 'renew')), releaseSyncCoordinator: guardedWrite(input => syncCoordinator(input, 'release')), snapshotSyncContext, snapshotSyncStatus, readOutboxBatch, applyExactAck:guardedWrite(applyExactAck),
    appendMutation:guardedWrite(async input => { canonicalBytes(input); const { lease, mutationDraft, nowMs } = input; return (await commit({ lease, mutationDrafts: [mutationDraft], nowMs })).mutations[0]; }),
    createReadonlyBankStreamer:async workspace=>{await authority();const result=await createReadonlyRegisteredBankStreamer(db,workspace);try{await authority();return result;}catch(error){result.close();throw error;}},
    close });
  readonlyAuthorities.set(publicAuthority,{database:db,check:()=>authority()});
  return publicAuthority;
}
