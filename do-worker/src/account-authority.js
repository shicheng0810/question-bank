import { DurableObject } from 'cloudflare:workers';
import {safeNativeConversionInventory} from './native-conversion-dto.js';
import {validateSourceDispositionCommand} from './legacy-source-disposition.js';
import {safeNativeAdminStatus} from './native-admin-status-dto.js';
import {safeNativeIdentityStatus} from './native-identity-status-dto.js';
import {readNativeIdentityStatus} from './native-identity-status.js';
import {validNativeProofCommand,safeNativeProofResult} from './native-conversion-proof.js';
import { createIncarnationRepository } from './account-incarnation-repository.js';
import { createRegistrationRepository, validRegistrationIntent } from './account-registration.js';
import { isPrincipal, principalForCode } from './account-code.js';
import { validGeneration } from './generation-transition.js';
import {createSessionIssuanceJournal} from './account-session-issuance-journal.js';
import {ACCOUNT_TOKEN_PATTERN,SESSION_V3_FLAG,sessionV3Hash} from './account-session-v3.js';
import {createAuthoritySecretRetention} from './account-secret-retention.js';
import {createAuthorityAlarmQueue} from './account-alarm-queue.js';
import {
  assertDeletionTicket,
  createDeletionTicketSchema,
  findDeletionTicketByOperation,
  issueDeletionTicket,
  insertDeletionTicket,
  readDeletionTicket,
  ticketExpiresAt,
  ticketParts,
} from './account-deletion-ticket.js';
import {
  consumeRevokeOutcome,
  createDeletionJob,
  createDeletionSchema,
  findDeletionJob,
  insertDeletionJob,
  issueFinishOperationId,
  markDeletionComplete,
  pendingDeletionJob,
  readDeletionJobs,
  reserveTwoFences,
  sameDeleteCommand,
  sameDeletionJob,
  validateDeleteCommand,
} from './account-deletion.js';

const FEATURE = '1';
const SESSION_TTL = 30 * 24 * 60 * 60;
// Production Date.now() advances with I/O, so separate DO clock snapshots can
// differ at the exact 30-day boundary. Budget 60s only for new V3 issuance;
// the GenerationStore's strict upper bound and V2 lifetime remain unchanged.
// https://developers.cloudflare.com/workers/runtime-apis/performance/
const SESSION_V3_EXPIRY_MARGIN_MS = 60_000;
const HEX64 = /^[0-9a-f]{64}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SESSION_PREFIX = 'g3:session:';
const RPC_DISPOSER = Symbol.dispose;
const DELETE_RETRY_MS = 2_000;
const AUTHORITY_RECEIPTS_TABLE = 'gen05_authority_receipts';
const LEGACY_SOURCE_ID = 'legacy-account-v1';
const LEGACY_PENDING_RETRY_MS = 750;
const LEGACY_POLICY_TABLE = 'gen07_legacy_policy';

function failure(error) {
  return { ok: false, error };
}

function cause(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function legacyMigrationEnabled(env) { return env?.GEN07_LEGACY_MIGRATION === FEATURE; }

function assertLegacyMigrationBindings(env) {
  if (!env?.EDITS || typeof env.EDITS.get !== 'function'
    || !env?.USER_STORE || typeof env.USER_STORE.idFromName !== 'function'
    || typeof env.USER_STORE.get !== 'function') throw cause('NOT_CONFIGURED');
}

function migrationOperationId(principal) {
  return `${principal.slice(0, 8)}-${principal.slice(8, 12)}-4${principal.slice(13, 16)}-8${principal.slice(17, 20)}-${principal.slice(20, 32)}`;
}

async function migrationFreezeId(snapshot) {
  const bytes = new TextEncoder().encode(`legacy-migration-v1:${snapshot.principal}:${snapshot.incarnation}:${snapshot.fence}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
}

function deletionOpIdForFreeze(freezeId) {
  if (typeof freezeId !== 'string' || !HEX64.test(freezeId)) throw cause('INVALID_INPUT');
  return `${freezeId.slice(0, 8)}-${freezeId.slice(8, 12)}-4${freezeId.slice(13, 16)}-8${freezeId.slice(17, 20)}-${freezeId.slice(20, 32)}`;
}

async function disposeRpc(outcome) {
  if (!outcome || typeof outcome !== 'object' || RPC_DISPOSER === undefined) return;
  const descriptor = Object.getOwnPropertyDescriptor(outcome, RPC_DISPOSER);
  if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function') return;
  await descriptor.value.call(outcome);
}

async function disposeStub(stub) {
  if (!stub || RPC_DISPOSER === undefined) return;
  const descriptor = Object.getOwnPropertyDescriptor(stub, RPC_DISPOSER);
  if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function') return;
  await descriptor.value.call(stub);
}

async function legacySourceLookup(env, principal, { allowDeleted = false, destructiveImportedEpoch = false } = {}) {
  assertLegacyMigrationBindings(env);
  const kv = env.EDITS;
  const stub = env.USER_STORE.get(env.USER_STORE.idFromName(principal));
  if (!stub || typeof stub.legacyMigrationSourceStatus !== 'function') throw cause('NOT_CONFIGURED');
  let metadata;
  try { metadata = await stub.legacyMigrationSourceStatus(); }
  catch { throw cause('UNAVAILABLE'); }
  try {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw cause('UNAVAILABLE');
    const expected = ['ok', 'sub', 'imported', 'historyCount', 'bankCount', 'frozen', 'deleted'];
    if (Object.keys(metadata).length !== expected.length || expected.some(key => !Object.hasOwn(metadata, key))
      || metadata.ok !== true || (metadata.sub !== null && metadata.sub !== principal)
      || typeof metadata.imported !== 'boolean' || !Number.isSafeInteger(metadata.historyCount) || metadata.historyCount < 0
      || !Number.isSafeInteger(metadata.bankCount) || metadata.bankCount < 0
      || typeof metadata.frozen !== 'boolean' || typeof metadata.deleted !== 'boolean') throw cause('MIGRATION_UNCERTAIN');
  } finally { await disposeRpc(metadata); await disposeStub(stub); }
  let del; let rawUser; let epoch;
  try {
    [del, rawUser, epoch] = await Promise.all([
      kv.get(`del:${principal}`), kv.get(`u:${principal}`), kv.get(`uepoch:${principal}`),
    ]);
  } catch { throw cause('UNAVAILABLE'); }
  let user = null;
  if (rawUser !== null && rawUser !== undefined) {
    try { user = JSON.parse(rawUser); } catch { throw cause('MIGRATION_UNCERTAIN'); }
    if (!user || typeof user !== 'object' || Array.isArray(user) || user.sub !== principal) throw cause('MIGRATION_UNCERTAIN');
  }
  if (del !== null && del !== undefined || metadata.deleted) {
    if (allowDeleted) return { kind: 'deleted', metadata };
    throw cause('ACCOUNT_DELETED');
  }
  if (epoch !== null && epoch !== undefined
    && (typeof epoch !== 'string' || !/^(?:0|[1-9]\d*)$/.test(epoch))) throw cause('MIGRATION_UNCERTAIN');
  if (metadata.imported && metadata.sub !== principal) throw cause('MIGRATION_UNCERTAIN');
  if (metadata.sub !== null && metadata.sub !== principal) throw cause('MIGRATION_UNCERTAIN');
  if (user) {
    if (epoch !== null && epoch !== undefined && epoch !== '1'
      && !(destructiveImportedEpoch && metadata.imported && metadata.sub === principal
        && Number.isSafeInteger(Number(epoch)) && Number(epoch) < Number.MAX_SAFE_INTEGER)) throw cause('MIGRATION_UNCERTAIN');
    let finalDel; let finalUser; let finalEpoch;
    try {
      [finalDel, finalUser, finalEpoch] = await Promise.all([
        kv.get(`del:${principal}`), kv.get(`u:${principal}`), kv.get(`uepoch:${principal}`),
      ]);
    } catch { throw cause('UNAVAILABLE'); }
    if (finalDel !== null && finalDel !== undefined) throw cause('ACCOUNT_DELETED');
    if (finalUser !== rawUser || finalEpoch !== epoch) throw cause('MIGRATION_UNCERTAIN');
    return { kind: 'legacy', metadata };
  }
  let historyKey; let bankIndex; let bankKeys;
  try {
    if (typeof kv.list !== 'function') throw new Error('not configured');
    [historyKey, bankIndex, bankKeys] = await Promise.all([
      kv.get(`h:${principal}`), kv.get(`bl:${principal}`), kv.list({ prefix: `b:${principal}:`, limit: 16 }),
    ]);
  } catch { throw cause('UNAVAILABLE'); }
  if (!bankKeys || !Array.isArray(bankKeys.keys) || typeof bankKeys.list_complete !== 'boolean'
    || (!bankKeys.list_complete && typeof bankKeys.cursor !== 'string')) throw cause('MIGRATION_UNCERTAIN');
  if (bankKeys.keys.some(key => !key || typeof key.name !== 'string' || !key.name.startsWith(`b:${principal}:`))) throw cause('MIGRATION_UNCERTAIN');
  const orphaned = metadata.imported || metadata.sub !== null || metadata.historyCount !== 0 || metadata.bankCount !== 0
    || (epoch !== null && epoch !== undefined) || historyKey !== null && historyKey !== undefined
    || bankIndex !== null && bankIndex !== undefined || bankKeys.keys.length > 0 || !bankKeys.list_complete;
  // Re-read identity and deletion evidence after all preceding awaits. Never
  // turn a concurrent delete or partially changed legacy identity into empty.
  let finalDel; let finalUser; let finalEpoch; let finalHistory; let finalBankIndex;
  try {
    [finalDel, finalUser, finalEpoch, finalHistory, finalBankIndex] = await Promise.all([
      kv.get(`del:${principal}`), kv.get(`u:${principal}`), kv.get(`uepoch:${principal}`), kv.get(`h:${principal}`), kv.get(`bl:${principal}`),
    ]);
  } catch { throw cause('UNAVAILABLE'); }
  if (finalDel !== null && finalDel !== undefined) throw cause('ACCOUNT_DELETED');
  if (finalUser !== null && finalUser !== undefined || finalEpoch !== epoch
    || finalHistory !== historyKey || finalBankIndex !== bankIndex) throw cause('MIGRATION_UNCERTAIN');
  return { kind: orphaned ? 'orphaned' : 'none', metadata };
}

function legacyUserStub(env, principal) {
  assertLegacyMigrationBindings(env);
  return env.USER_STORE.get(env.USER_STORE.idFromName(principal));
}

function legacyDataStub(env, incarnation) {
  const id = namespaceId(env.GENERATION_STORE, incarnation);
  return env.GENERATION_STORE.get(id);
}

function assertPlainRpc(outcome, keys) {
  if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) throw cause('UNAVAILABLE');
  const proto = Object.getPrototypeOf(outcome);
  if (proto !== Object.prototype && proto !== null) throw cause('UNAVAILABLE');
  const names = Reflect.ownKeys(outcome).filter(key => typeof key === 'string');
  const symbols = Reflect.ownKeys(outcome).filter(key => typeof key === 'symbol');
  if (symbols.length > 1 || (symbols.length === 1 && (RPC_DISPOSER === undefined || symbols[0] !== RPC_DISPOSER))
    || names.length !== keys.length || names.some(key => !keys.includes(key))) throw cause('UNAVAILABLE');
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(outcome, key);
    if (!descriptor || !('value' in descriptor)) throw cause('UNAVAILABLE');
  }
  return outcome;
}

async function rpcOk(stub, method, args, expectedKeys) {
  if (!stub || typeof stub[method] !== 'function') throw cause('NOT_CONFIGURED');
  let outcome;
  try {
    outcome = await stub[method](...args);
    assertPlainRpc(outcome, outcome?.ok === true ? ['ok', ...expectedKeys] : ['ok', 'error']);
    if (outcome.ok !== true) throw cause(typeof outcome.error === 'string' ? outcome.error : 'UNAVAILABLE');
    return Object.fromEntries(expectedKeys.map(key => [key, outcome[key]]));
  } catch (error) {
    if (error?.code) throw error;
    throw cause('UNAVAILABLE');
  } finally { await disposeRpc(outcome); await disposeStub(stub); }
}

function legacyPolicy(sql, incarnation) {
  const tables = resultRows(sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name=?", LEGACY_POLICY_TABLE));
  if (!tables.length) return null;
  const rows = resultRows(sql.exec(`SELECT principal,incarnation,mode,reason FROM ${LEGACY_POLICY_TABLE} WHERE incarnation=?`, incarnation));
  if (!rows.length) return null;
  if (rows.length !== 1 || !isPrincipal(rows[0].principal) || rows[0].incarnation !== incarnation
    || !['legacy', 'no-import'].includes(rows[0].mode) || typeof rows[0].reason !== 'string') throw cause('MIGRATION_UNCERTAIN');
  return { principal: rows[0].principal, incarnation: rows[0].incarnation, mode: rows[0].mode, reason: rows[0].reason };
}

function persistLegacyPolicy(sql, policy) {
  sql.exec(`CREATE TABLE IF NOT EXISTS ${LEGACY_POLICY_TABLE}(
    incarnation TEXT PRIMARY KEY, principal TEXT NOT NULL, mode TEXT NOT NULL, reason TEXT NOT NULL
  )`);
  const existing = legacyPolicy(sql, policy.incarnation);
  if (existing) {
    if (existing.principal !== policy.principal || existing.mode !== policy.mode || existing.reason !== policy.reason) throw cause('MIGRATION_UNCERTAIN');
    return existing;
  }
  sql.exec(`INSERT INTO ${LEGACY_POLICY_TABLE}(incarnation,principal,mode,reason) VALUES(?,?,?,?)`,
    policy.incarnation, policy.principal, policy.mode, policy.reason);
  return policy;
}

async function callMigrationMethod(authority, snapshot, stubFactory, method, args, expectedKeys) {
  const stub = typeof stubFactory === 'function' ? stubFactory() : stubFactory;
  if (!stub || typeof stub[method] !== 'function') throw cause('NOT_CONFIGURED');
  let outcome;
  try {
    outcome = await stub[method](...args);
    if (!exactAuthority(deletionRepository(authority, snapshot.principal).read(), snapshot)) throw cause('STALE_AUTHORITY');
    return rpcOkResult(outcome, expectedKeys);
  } finally { await disposeRpc(outcome); if (typeof stubFactory === 'function') await disposeStub(stub); }
}

function rpcOkResult(outcome, expectedKeys) {
  assertPlainRpc(outcome, outcome?.ok === true ? ['ok', ...expectedKeys] : ['ok', 'error']);
  if (outcome.ok !== true) throw cause(typeof outcome.error === 'string' ? outcome.error : 'UNAVAILABLE');
  return Object.fromEntries(expectedKeys.map(key => [key, outcome[key]]));
}

async function readLegacyArchiveStatus(authority, snapshot, stubFactory, generation) {
  const stub = typeof stubFactory === 'function' ? stubFactory() : stubFactory;
  let outcome;
  try {
    outcome = await stub.legacyArchiveStatus({ principal: snapshot.principal, incarnation: snapshot.incarnation }, generation);
    if (!exactAuthority(deletionRepository(authority, snapshot.principal).read(), snapshot)) throw cause('STALE_AUTHORITY');
    if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)
      || !Object.hasOwn(outcome, 'ok') || outcome.ok !== true || typeof outcome.status !== 'string') throw cause('UNAVAILABLE');
    if (outcome.status === 'none') {
      if (Object.keys(outcome).length !== 2) throw cause('UNAVAILABLE');
      return { status: 'none' };
    }
    const keys = ['ok', 'status', 'phase', 'processed', 'total', 'historyDone', 'historyTotal', 'bankDone', 'bankTotal', 'historyCursor', 'bankCursor', 'receipt'];
    if (Object.keys(outcome).length !== keys.length || keys.some(key => !Object.hasOwn(outcome, key))
      || !['staging', 'sealed', 'deleted', 'quarantined'].includes(outcome.status)
      || !['history', 'banks', 'verify', 'complete'].includes(outcome.phase)
      || !Number.isSafeInteger(outcome.processed) || !Number.isSafeInteger(outcome.total)
      || !Number.isSafeInteger(outcome.historyDone) || !Number.isSafeInteger(outcome.historyTotal)
      || !Number.isSafeInteger(outcome.bankDone) || !Number.isSafeInteger(outcome.bankTotal)
      || !(outcome.historyCursor === null || typeof outcome.historyCursor === 'string')
      || !(outcome.bankCursor === null || typeof outcome.bankCursor === 'string')) throw cause('UNAVAILABLE');
    return Object.fromEntries(keys.filter(key => key !== 'ok').map(key => [key, outcome[key]]));
  } finally { await disposeRpc(outcome); if (typeof stubFactory === 'function') await disposeStub(stub); }
}

function pendingMigration(status) {
  const phase = status.phase === 'complete' ? 'verify' : status.phase;
  return { ok: false, error: 'MIGRATION_PENDING', migration: {
    status: 'running', phase,
    processed: phase === 'history' ? status.historyDone : phase === 'banks' ? status.bankDone : 0,
    total: phase === 'history' ? status.historyTotal : phase === 'banks' ? status.bankTotal : 1,
  }, retryAfterMs: LEGACY_PENDING_RETRY_MS };
}

async function transferLegacyPart(authority, snapshot, userStub, dataStore, generation, freezeId, section, id, part, summary) {
  const source = await callMigrationMethod(authority, snapshot, userStub, 'legacyMigrationExportChunk', [{
    expectedSub: snapshot.principal, freezeId, section, id,
    ...(section === 'banks' ? { part } : {}), chunkIndex: 0,
  }], ['found', 'sourceKey', 'sourceDigest', 'byteLength', 'chunkIndex', 'chunkCount', 'chunkDigest', 'bytes']);
  if (!source.found || source.chunkIndex !== 0 || !(source.bytes instanceof Uint8Array)) throw cause('MIGRATION_QUARANTINED');
  const targetCommand = { generation, authorityFence: snapshot.fence, freezeId };
  const sourceKey = section === 'history' ? `history:${id}` : `bank:${id}:${part}`;
  if (source.sourceKey !== sourceKey) throw cause('MIGRATION_QUARANTINED');
  const metadata = section === 'history' ? summary
    : part === 'questions' ? summary : { id, part: 'meta' };
  await callMigrationMethod(authority, snapshot, dataStore, 'putLegacyArchiveManifest', [
    { principal: snapshot.principal, incarnation: snapshot.incarnation },
    { ...targetCommand, manifest: { section, id, part, sourceKey, sourceSha256: source.sourceDigest,
      byteLength: source.byteLength, chunkCount: source.chunkCount, metadata } },
  ], ['existing', 'complete']);
  for (let chunkIndex = 0; chunkIndex < source.chunkCount; chunkIndex += 1) {
    const chunk = chunkIndex === 0 ? source : await callMigrationMethod(authority, snapshot, userStub, 'legacyMigrationExportChunk', [{
      expectedSub: snapshot.principal, freezeId, section, id,
      ...(section === 'banks' ? { part } : {}), chunkIndex,
    }], ['found', 'sourceKey', 'sourceDigest', 'byteLength', 'chunkIndex', 'chunkCount', 'chunkDigest', 'bytes']);
    if (!chunk.found || chunk.chunkIndex !== chunkIndex || chunk.sourceKey !== sourceKey
      || chunk.sourceDigest !== source.sourceDigest || chunk.byteLength !== source.byteLength
      || chunk.chunkCount !== source.chunkCount || !(chunk.bytes instanceof Uint8Array)) throw cause('MIGRATION_QUARANTINED');
    await callMigrationMethod(authority, snapshot, dataStore, 'putLegacyArchiveChunk', [
      { principal: snapshot.principal, incarnation: snapshot.incarnation },
      { ...targetCommand, chunk: { sourceKey, index: chunkIndex, sha256: source.sourceDigest,
        chunkSha256: chunk.chunkDigest, bytes: chunk.bytes } },
    ], ['existing']);
  }
  const complete = await callMigrationMethod(authority, snapshot, dataStore, 'completeLegacyArchiveRecord', [
    { principal: snapshot.principal, incarnation: snapshot.incarnation },
    { ...targetCommand, sourceKey },
  ], ['complete']);
  if (!complete.complete) throw cause('MIGRATION_PENDING');
}

async function legacyMigrationAttempt(authority, snapshot, generation, policy = null) {
  if (!legacyMigrationEnabled(authority.env)) return { ready: true };
  assertLegacyMigrationBindings(authority.env);
  const checkAuthority = () => {
    if (!exactAuthority(deletionRepository(authority, snapshot.principal).read(), snapshot)) throw cause('STALE_AUTHORITY');
  };
  const binding = { principal: snapshot.principal, incarnation: snapshot.incarnation };
  const dataStore = () => legacyDataStub(authority.env, snapshot.incarnation);
  const status = await readLegacyArchiveStatus(authority, snapshot, dataStore, generation);
  if (status.status === 'sealed') return { ready: true };
  if (status.status === 'deleted') throw cause('ACCOUNT_DELETED');
  if (status.status === 'quarantined') throw cause('MIGRATION_QUARANTINED');

  let source = null;
  if (!policy) {
    source = await legacySourceLookup(authority.env, snapshot.principal);
    checkAuthority();
  }
  if (policy?.mode === 'no-import' || source?.kind === 'none') {
    if (status.status !== 'none') throw cause('MIGRATION_UNCERTAIN');
    const reason = policy?.reason || 'no-legacy-source';
    if (!policy) authority.ctx.storage.transactionSync(() => persistLegacyPolicy(authority.ctx.storage.sql, {
      principal: snapshot.principal, incarnation: snapshot.incarnation, mode: 'no-import', reason,
    }));
    const outcome = await callMigrationMethod(authority, snapshot, dataStore, 'recordLegacyNoImport', [binding, {
      generation, authorityFence: snapshot.fence, reason,
    }], ['status', 'receipt']);
    if (outcome.status !== 'sealed') throw cause('UNAVAILABLE');
    return { ready: true };
  }
  if (source?.kind === 'orphaned') throw cause('MIGRATION_UNCERTAIN');
  if (source && source.kind !== 'legacy') throw cause('MIGRATION_UNCERTAIN');
  if (policy && policy.mode !== 'legacy') throw cause('MIGRATION_UNCERTAIN');
  if (!policy) authority.ctx.storage.transactionSync(() => persistLegacyPolicy(authority.ctx.storage.sql, {
    principal: snapshot.principal, incarnation: snapshot.incarnation, mode: 'legacy', reason: LEGACY_SOURCE_ID,
  }));

  const freezeId = await migrationFreezeId(snapshot);
  checkAuthority();
  const userStub = () => legacyUserStub(authority.env, snapshot.principal);
  const frozen = await callMigrationMethod(authority, snapshot, userStub, 'freezeLegacyMigration', [{
    expectedSub: snapshot.principal, freezeId,
  }], ['frozen', 'imported', 'sourceKind', 'historyTotal', 'bankTotal']);
  if (frozen.frozen !== true || !Number.isSafeInteger(frozen.historyTotal) || !Number.isSafeInteger(frozen.bankTotal)) throw cause('MIGRATION_UNCERTAIN');
  const targetCommand = { generation, authorityFence: snapshot.fence, freezeId };
  await callMigrationMethod(authority, snapshot, dataStore, 'beginLegacyArchive', [binding, {
    ...targetCommand, sourceKind: frozen.sourceKind, historyTotal: frozen.historyTotal, bankTotal: frozen.bankTotal,
  }], ['status', 'phase', 'historyDone', 'bankDone']);
  let progress = await readLegacyArchiveStatus(authority, snapshot, dataStore, generation);
  if (progress.phase === 'history' && progress.historyDone < progress.historyTotal) {
    const page = await callMigrationMethod(authority, snapshot, userStub, 'legacyMigrationExportPage', [{
      expectedSub: snapshot.principal, freezeId, section: 'history', cursor: progress.historyCursor, limit: 1,
    }], ['sourceKind', 'items', 'nextCursor']);
    if (!Array.isArray(page.items) || page.items.length !== 1) throw cause('MIGRATION_UNCERTAIN');
    const item = page.items[0];
    await transferLegacyPart(authority, snapshot, userStub, dataStore, generation, freezeId, 'history', item.id, 'record', item);
    progress = await readLegacyArchiveStatus(authority, snapshot, dataStore, generation);
    return { ready: false, pending: pendingMigration(progress) };
  }
  if (progress.phase === 'banks' && progress.bankDone < progress.bankTotal) {
    const page = await callMigrationMethod(authority, snapshot, userStub, 'legacyMigrationExportPage', [{
      expectedSub: snapshot.principal, freezeId, section: 'banks', cursor: progress.bankCursor, limit: 1,
    }], ['sourceKind', 'items', 'nextCursor']);
    if (!Array.isArray(page.items) || page.items.length !== 1) throw cause('MIGRATION_UNCERTAIN');
    const item = page.items[0];
    await transferLegacyPart(authority, snapshot, userStub, dataStore, generation, freezeId, 'banks', item.id, 'meta', item);
    await transferLegacyPart(authority, snapshot, userStub, dataStore, generation, freezeId, 'banks', item.id, 'questions', item);
    progress = await readLegacyArchiveStatus(authority, snapshot, dataStore, generation);
    return { ready: false, pending: pendingMigration(progress) };
  }
  if (progress.phase !== 'verify') return { ready: false, pending: pendingMigration(progress) };
  const finalHistory = await callMigrationMethod(authority, snapshot, userStub, 'legacyMigrationExportPage', [{
    expectedSub: snapshot.principal, freezeId, section: 'history', cursor: progress.historyCursor, limit: 1,
  }], ['sourceKind', 'items', 'nextCursor']);
  const finalBanks = await callMigrationMethod(authority, snapshot, userStub, 'legacyMigrationExportPage', [{
    expectedSub: snapshot.principal, freezeId, section: 'banks', cursor: progress.bankCursor, limit: 1,
  }], ['sourceKind', 'items', 'nextCursor']);
  if (finalHistory.items.length || finalBanks.items.length) throw cause('MIGRATION_UNCERTAIN');
  const preview = await callMigrationMethod(authority, snapshot, dataStore, 'legacyArchiveReceiptPreview', [binding, targetCommand],
    ['sourceId', 'sourceKind', 'historyCount', 'bankCount', 'manifestSha256']);
  const receipt = { sourceId: LEGACY_SOURCE_ID, sourceKind: frozen.sourceKind,
    historyCount: frozen.historyTotal, bankCount: frozen.bankTotal, manifestSha256: preview.manifestSha256 };
  const sealed = await callMigrationMethod(authority, snapshot, dataStore, 'sealLegacyArchive', [binding, { ...targetCommand, receipt }], ['status', 'receipt']);
  if (sealed.status !== 'sealed') throw cause('MIGRATION_UNCERTAIN');
  return { ready: true };
}

function exactRecord(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw cause('INVALID_INPUT');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw cause('INVALID_INPUT');
  const actual = Reflect.ownKeys(value);
  if (actual.some((key) => typeof key !== 'string')
    || actual.length !== keys.length || keys.some((key) => !actual.includes(key))) {
    throw cause('INVALID_INPUT');
  }
  const fields = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) throw cause('INVALID_INPUT');
    fields[key] = descriptor.value;
  }
  return fields;
}

function safeFence(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  if (encoded.length !== 43) throw cause('UNAVAILABLE');
  return `v2.${encoded}`;
}

function validToken(token) {
  return typeof token === 'string' && ACCOUNT_TOKEN_PATTERN.test(token);
}

function exactAuthority(state, snapshot) {
  return state && state.phase === 'active'
    && state.principal === snapshot.principal
    && state.incarnation === snapshot.incarnation
    && state.fence === snapshot.fence;
}

function knownError(error) {
  const known = new Set([
    'FEATURE_DISABLED',
    'NOT_CONFIGURED',
    'INVALID_INPUT',
    'INVALID_CREDENTIALS',
    'NOT_REGISTERED',
    'STALE_AUTHORITY',
    'INVALID_PHASE',
    'STALE_FENCE',
    'STALE_INCARNATION',
    'OPERATION_CONFLICT',
    'FENCE_EXHAUSTED',
    'INCARNATION_ISSUANCE_FAILED',
    'ACCOUNT_DELETED',
    'NOT_INITIALIZED',
    'STALE_GENERATION',
      'GENERATION_ISSUANCE_FAILED',
    'MIGRATION_PENDING',
    'MIGRATION_UNCERTAIN',
    'MIGRATION_QUARANTINED',
    'MIGRATION_REQUIRED',
    'DELETE_PENDING',
    'REMOTE_INVALID',
    'STORAGE_REQUIRED',
  ]);
  return known.has(error?.code) ? error.code : 'UNAVAILABLE';
}

function mapAuthorityRead(state) {
  if (state.phase === 'empty' || state.phase === 'retired') throw cause('NOT_REGISTERED');
  if (state.phase === 'deleting') throw cause('STALE_AUTHORITY');
  if (state.phase !== 'active') throw cause('STALE_AUTHORITY');
}

function namespaceId(namespace, name) {
  if (!namespace || typeof namespace.idFromName !== 'function') throw cause('NOT_CONFIGURED');
  const id = namespace.idFromName(name);
  if (!id || typeof id.equals !== 'function') throw cause('NOT_CONFIGURED');
  return id;
}

function assertAuthorityIdentity(env, ctx, principal) {
  const id = namespaceId(env.ACCOUNT_AUTHORITY, principal);
  if (!id.equals(ctx.id)) throw cause('INVALID_CREDENTIALS');
}

function assertSessionKV(env) {
  if (!env?.GENERATION_SESSIONS || typeof env.GENERATION_SESSIONS.get !== 'function'
    || typeof env.GENERATION_SESSIONS.put !== 'function'
    || typeof env.GENERATION_SESSIONS.delete !== 'function') throw cause('NOT_CONFIGURED');
  return env.GENERATION_SESSIONS;
}

function registrationRepository(authority, principal) {
  return createRegistrationRepository(authority.ctx.storage, { principal });
}

function assertRegistrationFresh(expiresAt) {
  if (!Number.isSafeInteger(expiresAt) || expiresAt < 0 || Date.now() >= expiresAt) throw cause('STALE_AUTHORITY');
}

function assertSessionClaim(expiresAt, generation) {
  if (!validGeneration(generation) || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) {
    throw cause('INVALID_CREDENTIALS');
  }
}

function sameTicketSnapshot(command, fields) {
  return command.principal === fields.principal
    && command.incarnation === fields.incarnation
    && command.generation === fields.generation
    && command.fence === fields.fence
    && command.opId === fields.opId;
}

function ticketCommand(row) {
  const command = row?.command;
  if (!command || typeof command !== 'object' || !isPrincipal(command.principal)
    || typeof command.incarnation !== 'string' || !HEX64.test(command.incarnation)
    || !validGeneration(command.generation) || !Number.isSafeInteger(command.expiresAt)
    || !safeFence(command.fence) || typeof command.opId !== 'string' || !UUID_V4.test(command.opId)) throw cause('UNAVAILABLE');
  return {
    principal: command.principal,
    incarnation: command.incarnation,
    generation: command.generation,
    expiresAt: command.expiresAt,
    fence: command.fence,
    opId: command.opId,
  };
}

function ticketDeleteCommand(row) {
  const command = ticketCommand(row);
  return {
    principal: command.principal,
    incarnation: command.incarnation,
    expectedFence: command.fence,
    opId: command.opId,
  };
}

function assertDependencies(env) {
  if (!env?.ACCOUNT_AUTHORITY || typeof env.ACCOUNT_AUTHORITY.idFromName !== 'function'
    || typeof env.ACCOUNT_AUTHORITY.get !== 'function') throw cause('NOT_CONFIGURED');
  if (!env.GENERATION_STORE || typeof env.GENERATION_STORE.idFromName !== 'function'
    || typeof env.GENERATION_STORE.get !== 'function') throw cause('NOT_CONFIGURED');
  assertSessionKV(env);
}

function assertReadDependencies(env) {
  if (!env?.ACCOUNT_AUTHORITY || typeof env.ACCOUNT_AUTHORITY.idFromName !== 'function'
    || typeof env.ACCOUNT_AUTHORITY.get !== 'function') throw cause('NOT_CONFIGURED');
  if (!env.GENERATION_STORE || typeof env.GENERATION_STORE.idFromName !== 'function'
    || typeof env.GENERATION_STORE.get !== 'function') throw cause('NOT_CONFIGURED');
}

function dataStub(env, incarnation) {
  const id = namespaceId(env.GENERATION_STORE, incarnation);
  return env.GENERATION_STORE.get(id);
}

async function dataBootstrap(env, snapshot) {
  const stub = dataStub(env, snapshot.incarnation);
  if (!stub || typeof stub.bootstrapTrusted !== 'function') throw cause('NOT_CONFIGURED');
  const outcome = await stub.bootstrapTrusted({
    principal: snapshot.principal,
    incarnation: snapshot.incarnation,
  });
  try {
    if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) throw cause('UNAVAILABLE');
    const prototype = Object.getPrototypeOf(outcome);
    if (prototype !== Object.prototype && prototype !== null) throw cause('UNAVAILABLE');
    const keys = Reflect.ownKeys(outcome);
    const symbols = keys.filter((key) => typeof key === 'symbol');
    if (symbols.length > 0) {
      if (RPC_DISPOSER === undefined || symbols.length !== 1 || symbols[0] !== RPC_DISPOSER) {
        throw cause('UNAVAILABLE');
      }
      const descriptor = Object.getOwnPropertyDescriptor(outcome, RPC_DISPOSER);
      if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function') {
        throw cause('UNAVAILABLE');
      }
    }
    const strings = keys.filter((key) => typeof key === 'string');
    const okDescriptor = Object.getOwnPropertyDescriptor(outcome, 'ok');
    if (!okDescriptor || !('value' in okDescriptor) || typeof outcome.ok !== 'boolean') {
      throw cause('UNAVAILABLE');
    }
    const resultKeys = outcome.ok ? ['ok', 'generation'] : ['ok', 'error'];
    if (strings.length !== resultKeys.length || strings.some((key) => !resultKeys.includes(key))) {
      throw cause('UNAVAILABLE');
    }
    for (const key of resultKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(outcome, key);
      if (!descriptor || !('value' in descriptor)) throw cause('UNAVAILABLE');
    }
    if (!outcome.ok) {
      if (typeof outcome.error !== 'string') throw cause('UNAVAILABLE');
      return { ok: false, error: outcome.error };
    }
    if (!validGeneration(outcome.generation)) throw cause('UNAVAILABLE');
    return { ok: true, generation: outcome.generation };
  } finally {
    if (outcome && typeof outcome === 'object' && RPC_DISPOSER !== undefined) {
      const descriptor = Object.getOwnPropertyDescriptor(outcome, RPC_DISPOSER);
      if (descriptor && 'value' in descriptor && typeof descriptor.value === 'function') {
        try { descriptor.value.call(outcome); } catch { /* disposal cannot replace the result */ }
      }
    }
    await disposeStub(stub);
  }
}

async function dataDescribeSession(env, identity, claim) {
  const stub = dataStub(env, identity.incarnation);
  if (!stub || typeof stub.describeSession !== 'function') throw cause('NOT_CONFIGURED');
  let outcome;
  try {
    outcome = await stub.describeSession({ generation: claim.generation, expiresAt: claim.expiresAt });
    if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) throw cause('UNAVAILABLE');
    const prototype = Object.getPrototypeOf(outcome);
    if (prototype !== Object.prototype && prototype !== null) throw cause('UNAVAILABLE');
    const keys = Reflect.ownKeys(outcome);
    const symbols = keys.filter((key) => typeof key === 'symbol');
    if (symbols.length > 1 || (symbols.length === 1 && (RPC_DISPOSER === undefined || symbols[0] !== RPC_DISPOSER))) {
      throw cause('UNAVAILABLE');
    }
    if (symbols.length === 1) {
      const descriptor = Object.getOwnPropertyDescriptor(outcome, RPC_DISPOSER);
      if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function') throw cause('UNAVAILABLE');
    }
    const stringKeys = keys.filter((key) => typeof key === 'string');
    const okDescriptor = Object.getOwnPropertyDescriptor(outcome, 'ok');
    if (!okDescriptor || !('value' in okDescriptor) || typeof outcome.ok !== 'boolean') throw cause('UNAVAILABLE');
    const expected = outcome.ok ? ['ok', 'principal', 'incarnation', 'generation'] : ['ok', 'error'];
    if (stringKeys.length !== expected.length || stringKeys.some((key) => !expected.includes(key))) {
      throw cause('UNAVAILABLE');
    }
    for (const key of expected) {
      const descriptor = Object.getOwnPropertyDescriptor(outcome, key);
      if (!descriptor || !('value' in descriptor)) throw cause('UNAVAILABLE');
    }
    if (!outcome.ok) {
      if (typeof outcome.error !== 'string') throw cause('UNAVAILABLE');
      throw cause(outcome.error);
    }
    if (!isPrincipal(outcome.principal) || typeof outcome.incarnation !== 'string' || !HEX64.test(outcome.incarnation)
      || outcome.principal !== identity.principal || outcome.incarnation !== identity.incarnation
      || !validGeneration(outcome.generation) || outcome.generation !== claim.generation) {
      throw cause('INVALID_CREDENTIALS');
    }
    return {
      ok: true,
      principal: outcome.principal,
      incarnation: outcome.incarnation,
      generation: outcome.generation,
    };
  } finally {
    if (outcome && typeof outcome === 'object' && RPC_DISPOSER !== undefined) {
      const descriptor = Object.getOwnPropertyDescriptor(outcome, RPC_DISPOSER);
      if (descriptor && 'value' in descriptor && typeof descriptor.value === 'function') {
        try { await descriptor.value.call(outcome); } catch { throw cause('UNAVAILABLE'); }
      }
    }
  }
}

function freshIncarnation() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let value = '';
  for (const byte of bytes) value += byte.toString(16).padStart(2, '0');
  if (!HEX64.test(value)) throw cause('INCARNATION_ISSUANCE_FAILED');
  return value;
}

function assertDeleteDependencies(env, ctx, principal) {
  if (env?.GEN05_ACCOUNT_API !== FEATURE) throw cause('FEATURE_DISABLED');
  assertAuthorityIdentity(env, ctx, principal);
  assertSessionKV(env);
  if (!env?.ACCOUNT_AUTHORITY || typeof env.ACCOUNT_AUTHORITY.get !== 'function'
    || typeof env.GENERATION_STORE?.idFromName !== 'function'
    || typeof env.GENERATION_STORE?.get !== 'function') throw cause('NOT_CONFIGURED');
  if (legacyMigrationEnabled(env)) assertLegacyMigrationBindings(env);
  if (!ctx?.storage || typeof ctx.storage.transaction !== 'function'
    || typeof ctx.storage.transactionSync !== 'function'
    || typeof ctx.storage.setAlarm !== 'function'
    || !ctx.storage.sql || typeof ctx.storage.sql.exec !== 'function') {
    throw cause('STORAGE_REQUIRED');
  }
}

function deletionRepository(authority, principal) {
  return createIncarnationRepository(authority.ctx.storage, { principal });
}

function deletionJobs(authority, principal = null) {
  return readDeletionJobs(authority.ctx.storage.sql, principal);
}

function resultRows(result) {
  if (!result) return [];
  if (typeof result.toArray === 'function') return result.toArray();
  return Array.from(result);
}

function assertAuthorityReceipt(authority, opId, type, expectedFence, expectedIncarnation, appliedFence) {
  let rows;
  try {
    rows = resultRows(authority.ctx.storage.sql.exec(
      `SELECT op_id,command_json,applied_fence FROM ${AUTHORITY_RECEIPTS_TABLE} WHERE op_id=?`,
      opId,
    ));
  } catch {
    throw cause('INVALID_INPUT');
  }
  if (rows.length !== 1) throw cause('INVALID_INPUT');
  const row = rows[0];
  if (!row || row.op_id !== opId || typeof row.command_json !== 'string'
    || row.applied_fence !== appliedFence) throw cause('INVALID_INPUT');
  let parsed;
  try {
    parsed = JSON.parse(row.command_json);
  } catch {
    throw cause('INVALID_INPUT');
  }
  const command = exactRecord(parsed, ['type', 'opId', 'expectedFence', 'expectedIncarnation']);
  if (command.type !== type || command.opId !== opId || command.expectedFence !== expectedFence
    || command.expectedIncarnation !== expectedIncarnation
    || JSON.stringify(command) !== row.command_json) throw cause('INVALID_INPUT');
}

function assertCompletedLineage(authority, job) {
  const repository = deletionRepository(authority, job.principal);
  const state = repository.read();
  if (state.principal !== job.principal || !state.retired.includes(job.incarnation)
    || state.fence < job.originalFence + 2
    || (state.fence === job.originalFence + 2
      && (state.phase !== 'retired' || state.incarnation !== job.incarnation))
    || (state.fence > job.originalFence + 2 && state.incarnation === job.incarnation)) {
    throw cause('STALE_AUTHORITY');
  }
  assertAuthorityReceipt(
    authority,
    job.opId,
    'begin-delete',
    job.originalFence,
    job.incarnation,
    job.originalFence + 1,
  );
  assertAuthorityReceipt(
    authority,
    job.finishOpId,
    'finish-delete',
    job.originalFence + 1,
    job.incarnation,
    job.originalFence + 2,
  );
  return { ok: true, status: 'complete' };
}

function persistedDeletion(authority, job) {
  const persisted = findDeletionJob(deletionJobs(authority, job.principal), job.opId);
  if (!persisted || !sameDeletionJob(persisted, job)
    || persisted.finishOpId !== job.finishOpId) throw cause('INVALID_INPUT');
  return persisted;
}

function scheduleDeletionRetry(authority) {
  return scheduleAuthorityMaintenance(authority,null,{deletionRetryAt:Date.now()+DELETE_RETRY_MS});
}

function retention(authority,principal){return createAuthoritySecretRetention(authority.ctx,authority.env,{principal});}
async function scheduleAuthorityMaintenance(authority,principal=null,proposed={}){
  const sql=authority.ctx.storage.sql;
  if(!principal){const found=Array.from(sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='gen05_authority_state'"));if(!found.length)throw cause('NOT_INITIALIZED');const row=Array.from(sql.exec('SELECT state_json FROM gen05_authority_state'))[0];principal=JSON.parse(row.state_json).principal;}
  const clean=retention(authority,principal),journal=createSessionIssuanceJournal(authority.ctx.storage);
  const min=(a,b)=>a===null?b:b===undefined?a:Math.min(a,b);
  const pending=pendingDeletionJob(deletionJobs(authority,principal));
  const due={deletionRetryAt:pending?Date.now()+DELETE_RETRY_MS:null,registrationExpiryAt:clean.nextDue('registration-intent'),ticketExpiryAt:clean.nextDue('deletion-ticket'),v2ExpiryAt:journal.nextDue()};
  for(const key of Object.keys(proposed)){if(!Object.hasOwn(due,key))throw cause('INVALID_INPUT');due[key]=min(due[key],proposed[key]);}
  if(authority.maintenanceRetryAt)for(const key of ['registrationExpiryAt','ticketExpiryAt','v2ExpiryAt'])if(due[key]!==null&&due[key]<=Date.now())due[key]=Math.max(due[key],authority.maintenanceRetryAt);
  authority.secretAlarmQueue??=createAuthorityAlarmQueue(authority.ctx.storage);
  return authority.secretAlarmQueue.ensureDue(due);
}

async function cleanExpiredIssuedSessions(authority,principal){
  const journal=createSessionIssuanceJournal(authority.ctx.storage),sessions=assertSessionKV(authority.env),repository=deletionRepository(authority,principal);
  for(const row of journal.expiredPage(Date.now())){
    if(authority.maintenanceKvBudget===0)break;
    if(authority.maintenanceKvBudget!==undefined)authority.maintenanceKvBudget--;
    const captured=repository.read();
    if(captured.principal!==principal||!(captured.incarnation===row.incarnation&&((captured.phase==='active'&&captured.fence===row.fence)||(captured.phase==='deleting'&&captured.fence===row.fence+1))||captured.retired.includes(row.incarnation)&&captured.fence>=row.fence+2))throw cause('STALE_AUTHORITY');
    const check=()=>{if(JSON.stringify(repository.read())!==JSON.stringify(captured))throw cause('STALE_AUTHORITY');};
    check();const raw=await sessions.get(row.session_key);check();
    if(raw!==null&&raw!==undefined){const value=exactRecord(JSON.parse(raw),['sub','generation','expiresAt']);if(value.sub!==row.incarnation||value.generation!==row.generation||value.expiresAt!==row.expires_at)throw cause('UNAVAILABLE');}
    await sessions.delete(row.session_key);check();journal.remove(row);
  }
}

function assertPendingIdentity(authority, job) {
  const persisted = persistedDeletion(authority, job);
  if (persisted.status !== 'pending') throw cause('INVALID_INPUT');
  const state = deletionRepository(authority, job.principal).read();
  if (state.phase !== 'deleting' || state.principal !== job.principal
    || state.incarnation !== job.incarnation || state.fence !== job.originalFence + 1) {
    throw cause('STALE_AUTHORITY');
  }
  assertAuthorityReceipt(
    authority,
    job.opId,
    'begin-delete',
    job.originalFence,
    job.incarnation,
    job.originalFence + 1,
  );
  return { persisted, state };
}

function assertFinishIdentity(authority, job) {
  const repository = deletionRepository(authority, job.principal);
  const state = repository.read();
  if (state.principal !== job.principal || state.incarnation !== job.incarnation
    || state.fence < job.originalFence + 1 || state.fence > job.originalFence + 2) {
    throw cause('STALE_AUTHORITY');
  }
  if (state.fence === job.originalFence + 1 && state.phase !== 'deleting') {
    throw cause('STALE_AUTHORITY');
  }
  if (state.fence === job.originalFence + 2
    && (state.phase !== 'retired' || !state.retired.includes(job.incarnation))) {
    throw cause('STALE_AUTHORITY');
  }
  return { repository, state };
}

async function beginDeletion(authority, command) {
  return authority.ctx.storage.transaction(async () => {
    const repository = deletionRepository(authority, command.principal);
    const jobs = deletionJobs(authority, command.principal);
    const existing = findDeletionJob(jobs, command.opId);
    if (existing) {
      if (!sameDeleteCommand(existing, command)) throw cause('OPERATION_CONFLICT');
      if (existing.status === 'complete') return assertCompletedLineage(authority, existing);
      await scheduleDeletionRetry(authority);
      return existing;
    }
    if (pendingDeletionJob(jobs)) throw cause('DELETE_PENDING');

    const current = repository.read();
    if (current.principal !== command.principal || current.phase !== 'active'
      || current.incarnation !== command.incarnation || current.fence !== command.expectedFence) {
      throw cause('STALE_AUTHORITY');
    }
    reserveTwoFences(current.fence);
    const begin = repository.apply({
      type: 'begin-delete',
      opId: command.opId,
      expectedFence: command.expectedFence,
      expectedIncarnation: command.incarnation,
    });
    if (begin.replayed || begin.state.phase !== 'deleting'
      || begin.state.incarnation !== command.incarnation
      || begin.state.fence !== command.expectedFence + 1) throw cause('STALE_AUTHORITY');

    const job = createDeletionJob(command, issueFinishOperationId());
    createDeletionSchema(authority.ctx.storage.sql);
    insertDeletionJob(authority.ctx.storage.sql, job);
    await scheduleDeletionRetry(authority);
    return job;
  });
}

async function revokeOldIncarnation(authority, job) {
  const stub = dataStub(authority.env, job.incarnation);
  if (!stub || typeof stub.revokeTrusted !== 'function') throw cause('NOT_CONFIGURED');
  let outcome;
  let revoked;
  try {
    outcome = await stub.revokeTrusted({ principal: job.principal, incarnation: job.incarnation });
    revoked = await consumeRevokeOutcome(outcome);
  } finally { await disposeStub(stub); }
  if (!revoked.ok) return revoked;
  if (legacyMigrationEnabled(authority.env)) {
    const source = legacyUserStub(authority.env, job.principal);
    if (!source || typeof source.markLegacyMigrationDeletedTrusted !== 'function') return { ok: false };
    let deleted;
    try {
      deleted = await source.markLegacyMigrationDeletedTrusted({ expectedSub: job.principal });
      assertPlainRpc(deleted, deleted?.ok === true ? ['ok'] : ['ok', 'error']);
      if (deleted.ok !== true) return { ok: false };
    } finally { await disposeRpc(deleted); await disposeStub(source); }
    const currentJob = persistedDeletion(authority, job);
    if (currentJob.status === 'pending') assertPendingIdentity(authority, currentJob);
    else if (currentJob.status !== 'complete') return { ok: false };
  }
  return revoked;
}

async function finishDeletion(authority, job) {
  return authority.ctx.storage.transaction(async () => {
    const persisted = persistedDeletion(authority, job);
    if (persisted.status === 'complete') return assertCompletedLineage(authority, persisted);

    const { repository, state } = assertFinishIdentity(authority, job);
    if (state.fence === job.originalFence + 2) {
      assertAuthorityReceipt(
        authority,
        job.finishOpId,
        'finish-delete',
        job.originalFence + 1,
        job.incarnation,
        job.originalFence + 2,
      );
    }
    const finish = repository.apply({
      type: 'finish-delete',
      opId: job.finishOpId,
      expectedFence: job.originalFence + 1,
      expectedIncarnation: job.incarnation,
    });
    if (finish.state.phase !== 'retired' || finish.state.incarnation !== job.incarnation
      || finish.state.fence !== job.originalFence + 2
      || !finish.state.retired.includes(job.incarnation)
      || (state.fence === job.originalFence + 2 && !finish.replayed)) {
      throw cause('STALE_AUTHORITY');
    }
    markDeletionComplete(authority.ctx.storage.sql, job.opId);
    const completed = persistedDeletion(authority, job);
    if (completed.status !== 'complete') throw cause('INVALID_INPUT');
    return assertCompletedLineage(authority, completed);
  });
}

async function resumeDeletion(authority, job) {
  await scheduleDeletionRetry(authority);
  const initial = persistedDeletion(authority, job);
  if (initial.status === 'complete') return assertCompletedLineage(authority, initial);
  assertPendingIdentity(authority, initial);
  let revoked;
  try {
    revoked = await revokeOldIncarnation(authority, job);
  } catch {
    revoked = { ok: false };
  }
  const afterRemote = persistedDeletion(authority, job);
  if (afterRemote.status === 'complete') return assertCompletedLineage(authority, afterRemote);
  assertPendingIdentity(authority, afterRemote);
  if (!revoked?.ok) return { ok: true, status: 'pending' };
  if (!await purgeIndexedSessions(authority, afterRemote)) return {ok:true,status:'pending'};
  return finishDeletion(authority, afterRemote);
}

async function purgeIndexedSessions(authority,job){
  const journal=createSessionIssuanceJournal(authority.ctx.storage),sessions=assertSessionKV(authority.env);
  const check=()=>{
    const current=persistedDeletion(authority,job);
    if(current.status==='complete')assertCompletedLineage(authority,current);
    else assertPendingIdentity(authority,current);
  };
  check();
  const page=journal.issuedPage(job.incarnation);
  for(const row of page){
    if(row.incarnation!==job.incarnation||row.fence!==job.originalFence)throw cause('STALE_AUTHORITY');
    // A still-awaiting PUT or crash/ambiguous PUT debt is not deletion proof.
    // Never discard the secret locator while that operation may create a row.
    if(row.status!=='issued')continue;
    if(authority.maintenanceKvBudget===0)break;
    if(authority.maintenanceKvBudget!==undefined)authority.maintenanceKvBudget--;
    check();
    let raw;
    try{raw=await sessions.get(row.session_key);}catch{check();return false;}
    check();
    if(raw!==null&&raw!==undefined){
      // Expired sessions still require their exact issuer binding. Do not use
      // the public parser, which intentionally rejects expired credentials.
      let value;try{value=exactRecord(JSON.parse(raw),['sub','generation','expiresAt']);}catch{return false;}
      if(value.sub!==job.incarnation||value.generation!==row.generation||value.expiresAt!==row.expires_at)return false;
    }
    // Null is not PUT absence proof. Only a settled issued row reaches this
    // branch, and we still issue DELETE for the precise known locator.
    try{await sessions.delete(row.session_key);}catch{check();return false;}
    check();journal.remove(row);
  }
  check();
  return journal.page(job.incarnation).length===0;
}

async function recoverDeletion(authority) {
  if (authority.env?.GEN05_ACCOUNT_API !== FEATURE) return;
  const job = pendingDeletionJob(deletionJobs(authority));
  if (!job) return;
  assertDeleteDependencies(authority.env, authority.ctx, job.principal);
  await resumeDeletion(authority, job);
}

export class AccountAuthority extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
  }

  async prepareRegistration(command) {
    try {
      if (this.env?.GEN05_ACCOUNT_API !== FEATURE) throw cause('FEATURE_DISABLED');
      assertDependencies(this.env);
      const fields = exactRecord(command, ['code', 'opId']);
      if (typeof fields.code !== 'string' || typeof fields.opId !== 'string' || !UUID_V4.test(fields.opId)) {
        throw cause('INVALID_INPUT');
      }
      const principal = await principalForCode(fields.code);
      assertAuthorityIdentity(this.env, this.ctx, principal);
      const repository = createIncarnationRepository(this.ctx.storage, {
        principal,
        issueIncarnation: freshIncarnation,
      });

      if (legacyMigrationEnabled(this.env)) {
        const current = repository.read();
        if (current.phase === 'deleting') throw cause('DELETE_PENDING');
        if (current.phase !== 'retired') {
          const source = await legacySourceLookup(this.env, principal, { allowDeleted: true });
          if (source.kind === 'legacy') throw cause('MIGRATION_REQUIRED');
          if (source.kind === 'uncertain') throw cause('MIGRATION_UNCERTAIN');
        }
      }
      const registration = registrationRepository(this, principal);
      retention(this,principal).assertOperationAvailable('registration-intent',fields.opId);
      await scheduleAuthorityMaintenance(this,principal,{registrationExpiryAt:Date.now()+10*60*1000});
      const result = registration.prepare({ opId: fields.opId, readState: () => repository.read() });
      if (!result || result.ok !== true || !validRegistrationIntent(result.intent)
        || !Number.isSafeInteger(result.expiresAt) || result.expiresAt <= Date.now()) throw cause('UNAVAILABLE');
      return { ok: true, intent: result.intent, expiresAt: result.expiresAt };
    } catch (error) {
      return failure(knownError(error));
    }
  }

  async authenticate(command) {
    let diagnosticAction = 'OTHER';
    let diagnosticStage = 'INPUT';
    let diagnosticLeaf = null;
    try {
      if (this.env?.GEN05_ACCOUNT_API !== FEATURE) throw cause('FEATURE_DISABLED');
      assertDependencies(this.env);
      const type = command && typeof command === 'object' && !Array.isArray(command)
        ? Object.getOwnPropertyDescriptor(command, 'type') : null;
      if (!type || !('value' in type)
        || (type.value !== 'register' && type.value !== 'register-intent' && type.value !== 'login')) {
        throw cause('INVALID_INPUT');
      }
      diagnosticAction = type.value === 'login' ? 'LOGIN' : 'REGISTER';
      const fields = type.value === 'register'
        ? exactRecord(command, ['type', 'code', 'opId', 'expectedFence'])
        : type.value === 'register-intent'
          ? exactRecord(command, ['type', 'code', 'opId', 'intent'])
        : exactRecord(command, ['type', 'code']);
      if (typeof fields.code !== 'string') throw cause('INVALID_CREDENTIALS');
      if (type.value === 'register'
        && (typeof fields.opId !== 'string' || !UUID_V4.test(fields.opId)
          || !safeFence(fields.expectedFence))) throw cause('INVALID_INPUT');
      if (type.value === 'register-intent'
        && (typeof fields.opId !== 'string' || !UUID_V4.test(fields.opId)
          || !validRegistrationIntent(fields.intent))) throw cause('INVALID_INPUT');

      diagnosticStage = 'AUTHORITY_READ';
      const principal = await principalForCode(fields.code);
      assertAuthorityIdentity(this.env, this.ctx, principal);
      const repository = createIncarnationRepository(this.ctx.storage, {
        principal,
        issueIncarnation: freshIncarnation,
      });

      let registrationNoImportReason = null;
      let legacyLoginSource = null;
      if (legacyMigrationEnabled(this.env)
        && (type.value === 'register' || type.value === 'register-intent')) {
        const beforeRegistration = repository.read();
        if (beforeRegistration.phase === 'retired') registrationNoImportReason = 'retired-re-registration';
        else {
          const source = await legacySourceLookup(this.env, principal, { allowDeleted: true });
          if (source.kind === 'legacy') throw cause('MIGRATION_REQUIRED');
          if (source.kind === 'orphaned') registrationNoImportReason = 'orphaned-source';
          else if (source.kind === 'deleted') registrationNoImportReason = 'legacy-deleted-re-registration';
          else registrationNoImportReason = 'no-legacy-source';
        }
      }

      let result;
      let registrationInfo = null;
      if (type.value === 'register') {
        result = repository.apply({
          type: 'create',
          opId: fields.opId,
          expectedFence: fields.expectedFence,
        });
      } else if (type.value === 'register-intent') {
        const registration = registrationRepository(this, principal);
        retention(this,principal).assertOperationAvailable('registration-intent',fields.opId);
        registrationInfo = registration.commit({
          opId: fields.opId,
          intent: fields.intent,
          readState: () => repository.read(),
          applyCreate: ({ opId, expectedFence }) => repository.apply({
            type: 'create',
            opId,
            expectedFence,
          }),
        });
        if (registrationInfo.replayed) {
          const current = repository.read();
          if (current.phase !== 'active' || current.incarnation !== registrationInfo.incarnation
            || current.fence !== registrationInfo.expectedFence + 1) throw cause('STALE_AUTHORITY');
          result = { replayed: true, appliedFence: current.fence, state: current };
        } else {
          result = {
            replayed: false,
            appliedFence: registrationInfo.expectedFence + 1,
            state: repository.read(),
          };
          if (!result.state || result.state.phase !== 'active'
            || result.state.incarnation !== registrationInfo.incarnation) throw cause('STALE_AUTHORITY');
        }
      } else {
        let current = repository.read();
        if (legacyMigrationEnabled(this.env) && current.phase === 'retired') {
          legacyLoginSource = await legacySourceLookup(this.env, principal);
          if (legacyLoginSource.kind === 'orphaned' || legacyLoginSource.kind === 'legacy') throw cause('MIGRATION_UNCERTAIN');
          throw cause('NOT_REGISTERED');
        }
        if (legacyMigrationEnabled(this.env) && current.phase === 'empty') {
          legacyLoginSource = await legacySourceLookup(this.env, principal);
          if (legacyLoginSource.kind !== 'legacy') {
            if (legacyLoginSource.kind === 'orphaned') throw cause('MIGRATION_UNCERTAIN');
            throw cause('NOT_REGISTERED');
          }
          current = repository.read();
          if (current.phase === 'empty') {
            result = repository.apply({ type: 'create', opId: migrationOperationId(principal), expectedFence: current.fence });
            current = result.state;
          } else {
            mapAuthorityRead(current);
            result = { replayed: false, appliedFence: current.fence, state: current };
          }
        } else {
          mapAuthorityRead(current);
          result = { replayed: false, appliedFence: current.fence, state: current };
        }
      }

      const snapshot = {
        principal,
        incarnation: result.state.incarnation,
        fence: result.state.fence,
      };
      if (!isPrincipal(snapshot.principal) || typeof snapshot.incarnation !== 'string'
        || !HEX64.test(snapshot.incarnation) || !safeFence(snapshot.fence)) {
        throw cause('UNAVAILABLE');
      }
      if (type.value === 'register' && result.replayed && result.appliedFence !== result.state.fence) {
        throw cause('STALE_AUTHORITY');
      }
      diagnosticStage = 'LEGACY_POLICY';
      if (legacyMigrationEnabled(this.env)) {
        const policy = legacyPolicy(this.ctx.storage.sql, snapshot.incarnation);
        if (!policy && registrationNoImportReason) {
          this.ctx.storage.transactionSync(() => persistLegacyPolicy(this.ctx.storage.sql, {
            principal, incarnation: snapshot.incarnation, mode: 'no-import', reason: registrationNoImportReason,
          }));
        } else if (!policy && legacyLoginSource?.kind === 'legacy') {
          this.ctx.storage.transactionSync(() => persistLegacyPolicy(this.ctx.storage.sql, {
            principal, incarnation: snapshot.incarnation, mode: 'legacy', reason: LEGACY_SOURCE_ID,
          }));
        }
      }
      if (type.value === 'register-intent') assertRegistrationFresh(registrationInfo.expiresAt);
      if (!exactAuthority(repository.read(), snapshot)) throw cause('STALE_AUTHORITY');

      let bootstrapped;
      let bootstrapFailureLeaf = null;
      diagnosticStage = 'DATA_BOOTSTRAP';
      try {
        bootstrapped = await dataBootstrap(this.env, snapshot);
      } catch (error) {
        bootstrapFailureLeaf = knownError(error);
        bootstrapped = { ok: false, error: 'UNAVAILABLE' };
      }
      diagnosticStage = 'BOOTSTRAP_AUTHORITY_CHECK';
      const afterBootstrap = repository.read();
      if (!exactAuthority(afterBootstrap, snapshot)) throw cause('STALE_AUTHORITY');
      if (type.value === 'register-intent') assertRegistrationFresh(registrationInfo.expiresAt);
      if (!bootstrapped?.ok || typeof bootstrapped.generation !== 'string') {
        diagnosticStage = 'DATA_BOOTSTRAP';
        diagnosticLeaf = bootstrapFailureLeaf ?? knownError({ code: bootstrapped?.error });
        throw cause(bootstrapped?.error || 'UNAVAILABLE');
      }

      diagnosticLeaf = null;
      diagnosticStage = 'LEGACY_POLICY';
      const migrationPolicy = legacyMigrationEnabled(this.env)
        ? legacyPolicy(this.ctx.storage.sql, snapshot.incarnation) : null;
      diagnosticStage = 'LEGACY_MIGRATION';
      const migration = await legacyMigrationAttempt(this, snapshot, bootstrapped.generation, migrationPolicy);
      if (!migration.ready) return migration.pending;

      const expiresAt = Date.now() + SESSION_TTL * 1000;
      if(this.env?.[SESSION_V3_FLAG]==='1'){
        const v3ExpiresAt = expiresAt - SESSION_V3_EXPIRY_MARGIN_MS;
        diagnosticStage = 'SESSION_V3_PREPARE';
        const candidate=`v3.${snapshot.incarnation}.${randomToken().slice(3)}`;
        const tokenHash=await sessionV3Hash(candidate);
        if(!exactAuthority(repository.read(),snapshot))throw cause('STALE_AUTHORITY');
        const stub=dataStub(this.env,snapshot.incarnation);
        diagnosticStage = 'SESSION_V3_ISSUE';
        const issued=await stub.issueSessionTrusted({principal:snapshot.principal,incarnation:snapshot.incarnation,generation:bootstrapped.generation,expiresAt:v3ExpiresAt,tokenHash});
        if(!issued||issued.ok!==true||Object.keys(issued).join()!=='ok'){
          diagnosticLeaf = knownError({ code: issued?.error });
          throw cause('UNAVAILABLE');
        }
        diagnosticStage = 'FINAL_AUTHORITY_CHECK';
        if(!exactAuthority(repository.read(),snapshot)||v3ExpiresAt<=Date.now())throw cause('STALE_AUTHORITY');
        if(type.value==='register-intent')assertRegistrationFresh(registrationInfo.expiresAt);
        return {ok:true,token:candidate};
      }
      diagnosticStage = 'SESSION_V2_ISSUE';
      const sessions = assertSessionKV(this.env);
      await scheduleAuthorityMaintenance(this,snapshot.principal,{v2ExpiryAt:expiresAt});
      if(!exactAuthority(repository.read(),snapshot))throw cause('STALE_AUTHORITY');
      let token = null;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const candidate = randomToken();
        const key = SESSION_PREFIX + candidate;
        const existing = await sessions.get(key);
        const afterGet = repository.read();
        if (!exactAuthority(afterGet, snapshot) || expiresAt <= Date.now()) throw cause('STALE_AUTHORITY');
        if (type.value === 'register-intent') assertRegistrationFresh(registrationInfo.expiresAt);
        if (existing !== null && existing !== undefined) continue;
        const dto = { sub: snapshot.incarnation, generation: bootstrapped.generation, expiresAt };
        const issuance=createSessionIssuanceJournal(this.ctx.storage);
        const intent=issuance.reserve({session_key:key,incarnation:snapshot.incarnation,generation:bootstrapped.generation,fence:snapshot.fence,expires_at:expiresAt});
        let issued;
        try{
          await sessions.put(key, JSON.stringify(dto), { expirationTtl: SESSION_TTL });
          issued=issuance.settle(intent,'issued');
        }catch{
          // A rejected external request does not prove no remote write happened.
          // Persist unknown debt; deletion cannot acknowledge this as purged.
          issuance.settle(intent,'unknown_debt');
          throw cause('UNAVAILABLE');
        }
        const afterPut = repository.read();
        if (!exactAuthority(afterPut, snapshot) || expiresAt <= Date.now()
          || (type.value==='register-intent'&&Date.now()>=registrationInfo.expiresAt)) {
          // Successful but stale issuance is never returned to the caller.
          // Exact-key compensation remains indexed if KV deletion fails.
          try{await sessions.delete(key);issuance.remove(issued);}catch{}
          throw cause('STALE_AUTHORITY');
        }
        if (type.value === 'register-intent') assertRegistrationFresh(registrationInfo.expiresAt);
        token = candidate;
        break;
      }
      if (!validToken(token)) throw cause('UNAVAILABLE');
      if (type.value === 'register-intent') {
        assertRegistrationFresh(registrationInfo.expiresAt);
        if (!exactAuthority(repository.read(), snapshot)) throw cause('STALE_AUTHORITY');
      }
      return { ok: true, token };
    } catch (error) {
      // Request-local fixed enums only: never log credentials, RPC DTOs, or errors.
      try {
        console.error(JSON.stringify({ event: 'QB_AUTH_FAILURE_V1', action: diagnosticAction,
          stage: diagnosticStage, error: diagnosticLeaf ?? knownError(error) }));
      } catch { /* Diagnostics must not change the authentication response. */ }
      return failure(knownError(error));
    }
  }

  async migrateLegacyTrusted(command) {
    try {
      if (!legacyMigrationEnabled(this.env) || this.env?.GEN05_ACCOUNT_API !== FEATURE) throw cause('FEATURE_DISABLED');
      const fields = exactRecord(command, ['principal']);
      if (!isPrincipal(fields.principal)) throw cause('INVALID_INPUT');
      assertDependencies(this.env);
      assertLegacyMigrationBindings(this.env);
      assertAuthorityIdentity(this.env, this.ctx, fields.principal);
      const repository = createIncarnationRepository(this.ctx.storage, { principal: fields.principal, issueIncarnation: freshIncarnation });
      let state = repository.read();
      if (state.phase === 'retired') return { ok: true, status: 'skipped', reason: 'retired' };
      if (state.phase === 'deleting') return { ok: false, error: 'DELETE_PENDING' };

      const source = await legacySourceLookup(this.env, fields.principal, { allowDeleted: true });
      state = repository.read();
      if (state.phase === 'retired') return { ok: true, status: 'skipped', reason: 'retired' };
      if (state.phase === 'deleting') return { ok: false, error: 'DELETE_PENDING' };
      if (!['empty', 'active'].includes(state.phase)) throw cause('STALE_AUTHORITY');
      if (source.kind === 'deleted') return { ok: true, status: 'skipped', reason: 'deleted' };
      if (source.kind === 'orphaned') return { ok: true, status: 'skipped', reason: 'orphaned' };
      if (source.kind === 'none') return { ok: true, status: 'skipped', reason: 'no-legacy-source' };
      if (source.kind !== 'legacy') throw cause('MIGRATION_UNCERTAIN');

      if (state.phase === 'empty') {
        const created = repository.apply({ type: 'create', opId: migrationOperationId(fields.principal), expectedFence: state.fence });
        if (created.state.phase !== 'active' || created.state.principal !== fields.principal) throw cause('STALE_AUTHORITY');
        state = created.state;
      }
      const snapshot = { principal: fields.principal, incarnation: state.incarnation, fence: state.fence };
      const policy = legacyPolicy(this.ctx.storage.sql, snapshot.incarnation);
      if (policy?.mode === 'no-import') return { ok: true, status: 'skipped', reason: 'no-import-policy' };
      if (policy && (policy.mode !== 'legacy' || policy.principal !== fields.principal)) throw cause('MIGRATION_UNCERTAIN');
      if (!policy) this.ctx.storage.transactionSync(() => persistLegacyPolicy(this.ctx.storage.sql, {
        principal: fields.principal, incarnation: snapshot.incarnation, mode: 'legacy', reason: LEGACY_SOURCE_ID,
      }));
      let bootstrapped;
      try { bootstrapped = await dataBootstrap(this.env, snapshot); }
      catch { throw cause('UNAVAILABLE'); }
      if (!exactAuthority(repository.read(), snapshot)) throw cause('STALE_AUTHORITY');
      if (!bootstrapped?.ok || typeof bootstrapped.generation !== 'string') throw cause(bootstrapped?.error || 'UNAVAILABLE');
      const migration = await legacyMigrationAttempt(this, snapshot, bootstrapped.generation, policy || legacyPolicy(this.ctx.storage.sql, snapshot.incarnation));
      if (migration.ready) return { ok: true, status: 'complete' };
      const pending = migration.pending;
      if (!pending || pending.error !== 'MIGRATION_PENDING' || !pending.migration) throw cause('UNAVAILABLE');
      const { phase, processed, total } = pending.migration;
      if (!['history', 'banks', 'verify'].includes(phase) || !Number.isSafeInteger(processed)
        || processed < 0 || !Number.isSafeInteger(total) || total < processed) throw cause('UNAVAILABLE');
      return { ok: true, status: 'pending', migration: { phase, processed, total } };
    } catch (error) {
      return failure(knownError(error));
    }
  }

  async convertLegacyNativeTrusted(command) {return this.#convertLegacyNative(command,'history');}
  async nativeConversionInventoryTrusted(command){
    try{
      const fields=exactRecord(command,['principal']);if(!isPrincipal(fields.principal))throw cause('INVALID_INPUT');
      assertAuthorityIdentity(this.env,this.ctx,fields.principal);
      const before=await this.operatorStatusTrusted();
      if(before.ok!==true||before.status!=='observed'||before.phase!=='active'||before.archiveStatus!=='sealed'||before.archivePhase!=='complete')throw cause('STALE_AUTHORITY');
      const result={ok:true,...await rpcOk(dataStub(this.env,before.incarnation),'nativeConversionInventoryTrusted',[{principal:fields.principal,incarnation:before.incarnation,authorityFence:before.fence,manifestSha256:before.manifestSha256}],['status','principal','incarnation','authorityFence','manifestSha256','generation','histories','banks'])};
      const after=await this.operatorStatusTrusted(),safe=safeNativeConversionInventory(result);
      if(!safe||after.ok!==true||after.phase!=='active'||after.incarnation!==before.incarnation||after.fence!==before.fence||after.manifestSha256!==before.manifestSha256||safe.principal!==fields.principal||safe.incarnation!==before.incarnation||safe.authorityFence!==before.fence||safe.manifestSha256!==before.manifestSha256||safe.histories.length!==before.historyTotal||safe.banks.length!==before.bankTotal)throw cause('STALE_AUTHORITY');
      return safe;
    }catch(error){return failure(knownError(error));}
  }
  async nativeAdminStatusTrusted(command){
    try{
      const fields=exactRecord(command,['principal','expectedIncarnation','expectedFence']);if(!isPrincipal(fields.principal)||!HEX64.test(fields.expectedIncarnation)||!safeFence(fields.expectedFence))throw cause('INVALID_INPUT');
      assertAuthorityIdentity(this.env,this.ctx,fields.principal);const before=await this.nativeManagerIdentityTrusted({principal:fields.principal});
      const current=s=>s.ok===true&&s.status==='observed'&&s.phase==='active'&&s.principal===fields.principal&&s.incarnation===fields.expectedIncarnation&&s.fence===fields.expectedFence;
      if(!current(before))throw cause('STALE_AUTHORITY');
      const inner=await rpcOk(dataStub(this.env,before.incarnation),'nativeAdminStatusTrusted',[{principal:fields.principal,incarnation:before.incarnation}],['status','generation','highWater','historySnapshotCount','attemptCount','activePrivateBankCount','tombstoneCount','coverageStatus']);
      const result=safeNativeAdminStatus({ok:true,...inner,principal:fields.principal,incarnation:before.incarnation,fence:before.fence});
      if(!current(await this.nativeManagerIdentityTrusted({principal:fields.principal}))||!result)throw cause('STALE_AUTHORITY');return result;
    }catch(error){return failure(knownError(error));}
  }
  async nativeManagerIdentityTrusted(command){
    try{
      if(this.env?.GEN05_ACCOUNT_API!==FEATURE)throw cause('FEATURE_DISABLED');
      let expectedPrincipal;
      if(command!==undefined){const fields=exactRecord(command,['principal']);if(!isPrincipal(fields.principal))throw cause('INVALID_INPUT');expectedPrincipal=fields.principal;}
      const identity=readNativeIdentityStatus(this.ctx.storage.sql,{principal:expectedPrincipal,gen05Enabled:true});
      if(identity.ok!==true)return identity;
      if(identity.status==='empty')return safeNativeIdentityStatus(identity)||failure('IDENTITY_UNCERTAIN');
      assertAuthorityIdentity(this.env,this.ctx,identity.principal);
      if(expectedPrincipal!==undefined&&identity.principal!==expectedPrincipal)throw cause('IDENTITY_MISMATCH');
      return safeNativeIdentityStatus(identity)||failure('IDENTITY_UNCERTAIN');
    }catch(error){return failure(knownError(error));}
  }
  async nativeConversionProofTrusted(command){
    try{
      if(!validNativeProofCommand(command))throw cause('INVALID_INPUT');const fields=structuredClone(command);assertAuthorityIdentity(this.env,this.ctx,fields.principal);
      const current=status=>status?.ok===true&&status.status==='observed'&&status.phase==='active'&&status.principal===fields.principal&&status.incarnation===fields.incarnation&&status.fence===fields.authorityFence&&status.manifestSha256===fields.manifestSha256;
      if(!current(await this.operatorStatusTrusted()))throw cause('STALE_AUTHORITY');
      const raw={ok:true,...await rpcOk(dataStub(this.env,fields.incarnation),'nativeConversionProofTrusted',[fields],['operation','body'])};
      const result=await safeNativeProofResult(raw,fields);if(!current(await this.operatorStatusTrusted())||!result)throw cause('STALE_AUTHORITY');return result;
    }catch(error){return failure(knownError(error));}
  }
  async convertLegacyNativeBankTrusted(command) {return this.#convertLegacyNative(command,'bank');}
  async declareNativeSourceDispositionTrusted(input){
    try{
      const command=validateSourceDispositionCommand(input);assertAuthorityIdentity(this.env,this.ctx,command.principal);
      const current=s=>s.ok===true&&s.status==='observed'&&s.phase==='active'&&s.principal===command.principal&&s.incarnation===command.incarnation&&s.fence===command.authorityFence&&s.archiveStatus==='sealed'&&s.archivePhase==='complete'&&s.manifestSha256===command.manifestSha256;
      if(!current(await this.operatorStatusTrusted()))throw cause('STALE_AUTHORITY');
      const result={ok:true,...await rpcOk(dataStub(this.env,command.incarnation),'declareNativeSourceDispositionTrusted',[command],['status','historyCount','discardCount','sourceDeleted'])};
      if(!current(await this.operatorStatusTrusted()))throw cause('STALE_AUTHORITY');
      exactRecord(result,['ok','status','historyCount','discardCount','sourceDeleted']);
      if(result.status!=='declared-not-deleted'||result.historyCount!==command.histories.length||result.discardCount!==command.histories.filter(h=>h.disposition==='discard-authorized').length||result.sourceDeleted!==false)throw cause('UNAVAILABLE');
      return result;
    }catch(error){return failure(knownError(error));}
  }
  async #convertLegacyNative(command,kind) {
    try {
      const keys=['principal','incarnation','generation','authorityFence','manifestSha256','recordId','mode'];
      const fields=exactRecord(command,keys);
      if(!isPrincipal(fields.principal)||!HEX64.test(fields.incarnation)||!validGeneration(fields.generation)
        ||!safeFence(fields.authorityFence)||!HEX64.test(fields.manifestSha256)||typeof fields.recordId!=='string'
        ||!fields.recordId||new TextEncoder().encode(fields.recordId).length>64||!['plan','execute'].includes(fields.mode))throw cause('INVALID_INPUT');
      assertAuthorityIdentity(this.env,this.ctx,fields.principal);
      const before=await this.operatorStatusTrusted();
      const current=status=>status.ok===true&&status.status==='observed'&&status.phase==='active'&&status.principal===fields.principal
        &&status.incarnation===fields.incarnation&&status.fence===fields.authorityFence&&status.archiveStatus==='sealed'
        &&status.archivePhase==='complete'&&status.manifestSha256===fields.manifestSha256;
      if(!current(before))throw cause('STALE_AUTHORITY');
      const idField=kind==='bank'?'bankUid':'snapshotId';
      const result={ok:true,...await rpcOk(dataStub(this.env,fields.incarnation),kind==='bank'?'convertArchivedBankTrusted':'convertArchivedHistoryTrusted',[{...fields}],['status',idField,'contentDigest','sourceDeleted'])};
      if(!current(await this.operatorStatusTrusted()))throw cause('STALE_AUTHORITY');
      const expected=['ok','status',idField,'contentDigest','sourceDeleted'];
      if(result?.ok!==true)throw cause(result?.error||'UNAVAILABLE');
      exactRecord(result,expected);
      if(!['planned','accepted','duplicate','already-accepted'].includes(result.status)||typeof result[idField]!=='string'
        ||!/^[0-9a-f]{8}-[0-9a-f]{4}-[48][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(result[idField])||!HEX64.test(result.contentDigest)||result.sourceDeleted!==false)throw cause('UNAVAILABLE');
      return result;
    }catch(error){return failure(knownError(error));}
  }

  async operatorStatusTrusted() {
    try {
      if (arguments.length !== 0) throw cause('INVALID_INPUT');
      if (!legacyMigrationEnabled(this.env) || this.env?.GEN05_ACCOUNT_API !== FEATURE) throw cause('FEATURE_DISABLED');
      const sql = this.ctx.storage.sql;
      const table = resultRows(sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='gen05_authority_state'"));
      if (table.length === 0) return { ok: true, status: 'empty' };
      const rows = resultRows(sql.exec('SELECT state_json FROM gen05_authority_state'));
      if (rows.length !== 1 || typeof rows[0].state_json !== 'string') throw cause('MIGRATION_UNCERTAIN');
      let state;
      try { state = JSON.parse(rows[0].state_json); } catch { throw cause('MIGRATION_UNCERTAIN'); }
      if (!state || !isPrincipal(state.principal) || !['empty', 'active', 'deleting', 'retired'].includes(state.phase)
        || !safeFence(state.fence) || !(state.incarnation === null || (typeof state.incarnation === 'string' && HEX64.test(state.incarnation)))) {
        throw cause('MIGRATION_UNCERTAIN');
      }
      assertAuthorityIdentity(this.env, this.ctx, state.principal);
      if (state.phase === 'empty') return { ok: true, status: 'empty' };
      const policy = state.incarnation ? legacyPolicy(sql, state.incarnation) : null;
      let archive = { status: 'none', phase: null, historyDone: 0, historyTotal: 0, bankDone: 0, bankTotal: 0, manifestSha256: null };
      if (state.phase === 'active' && state.incarnation) {
        const data = dataStub(this.env, state.incarnation);
        if (!data || typeof data.legacyMigrationOperatorStatus !== 'function') throw cause('NOT_CONFIGURED');
        const expected = ['status', 'phase', 'historyDone', 'historyTotal', 'bankDone', 'bankTotal', 'manifestSha256'];
        archive = await rpcOk(data, 'legacyMigrationOperatorStatus', [
          { principal: state.principal, incarnation: state.incarnation },
        ], expected);
        if (!['none', 'staging', 'sealed', 'deleted', 'quarantined'].includes(archive.status)
          || !(archive.phase === null || ['history', 'banks', 'verify', 'complete'].includes(archive.phase))
          || !Number.isSafeInteger(archive.historyDone) || !Number.isSafeInteger(archive.historyTotal)
          || !Number.isSafeInteger(archive.bankDone) || !Number.isSafeInteger(archive.bankTotal)
          || !(archive.manifestSha256 === null || HEX64.test(archive.manifestSha256))) throw cause('UNAVAILABLE');
      }
      return { ok: true, status: 'observed', principal: state.principal, phase: state.phase,
        incarnation: state.incarnation, fence: state.fence, policy: policy ? { mode: policy.mode, reason: policy.reason } : null,
        archiveStatus: archive.status, archivePhase: archive.phase, historyDone: archive.historyDone,
        historyTotal: archive.historyTotal, bankDone: archive.bankDone, bankTotal: archive.bankTotal,
        manifestSha256: archive.manifestSha256 };
    } catch (error) {
      return failure(knownError(error));
    }
  }

  async legacySourceDeletionObserved(command) {
    try {
      if (!legacyMigrationEnabled(this.env) || !exactRecord(command, ['principal', 'freezeId'])
        || !isPrincipal(command.principal) || typeof command.freezeId !== 'string' || !HEX64.test(command.freezeId)) {
        throw cause('INVALID_INPUT');
      }
      assertAuthorityIdentity(this.env, this.ctx, command.principal);
      const repository = deletionRepository(this, command.principal);
      const state = repository.read();
      let incarnation; let originalFence; let status = 'unmatched';
      if (state.phase === 'active') {
        incarnation = state.incarnation; originalFence = state.fence;
      } else if (state.phase === 'deleting') {
        incarnation = state.incarnation; originalFence = state.fence - 1; status = 'pending';
      } else if (state.phase === 'retired') {
        incarnation = state.incarnation; originalFence = state.fence - 2;
      } else return { ok: true, status: 'unmatched' };
      if (!Number.isSafeInteger(originalFence) || originalFence < 0) return { ok: true, status: 'unmatched' };
      const policy = legacyPolicy(this.ctx.storage.sql, incarnation);
      if (!policy || policy.mode !== 'legacy' || policy.principal !== command.principal
        || await migrationFreezeId({ principal: command.principal, incarnation, fence: originalFence }) !== command.freezeId) {
        return { ok: true, status: 'unmatched' };
      }
      if (state.phase === 'active') {
        const begun = await beginDeletion(this, {
          principal: command.principal, incarnation, expectedFence: state.fence,
          opId: deletionOpIdForFreeze(command.freezeId),
        });
        if (begun.status === 'complete') return { ok: true, status: 'complete' };
        status = 'pending';
      } else {
        const existing = deletionJobs(this, command.principal).find(job => job.incarnation === incarnation && job.originalFence === originalFence);
        if (!existing) return { ok: true, status: 'unmatched' };
        status = existing.status === 'complete' ? 'complete' : 'pending';
      }
      const after = repository.read();
      if (status === 'pending' && (after.phase !== 'deleting' || after.incarnation !== incarnation)) throw cause('STALE_AUTHORITY');
      return { ok: true, status };
    } catch (error) { return failure(knownError(error)); }
  }

  async validateSession(command) {
    try {
      if (this.env?.GEN05_ACCOUNT_API !== FEATURE) throw cause('FEATURE_DISABLED');
      assertReadDependencies(this.env);
      const fields = exactRecord(command, ['principal', 'incarnation', 'generation', 'expiresAt']);
      if (!isPrincipal(fields.principal) || typeof fields.incarnation !== 'string'
        || !HEX64.test(fields.incarnation) || fields.principal === fields.incarnation
        || !validGeneration(fields.generation) || !Number.isSafeInteger(fields.expiresAt)
        || fields.expiresAt < 0) throw cause('INVALID_INPUT');
      assertSessionClaim(fields.expiresAt, fields.generation);
      assertAuthorityIdentity(this.env, this.ctx, fields.principal);

      // Reading a missing authority is intentionally non-creating. The
      // repository's read path returns an in-memory empty state when its
      // SQLite tables are absent; no schema or receipt is written here.
      const repository = createIncarnationRepository(this.ctx.storage, {
        principal: fields.principal,
      });
      const initial = repository.read();
      if (!initial || initial.phase !== 'active' || initial.principal !== fields.principal) {
        mapAuthorityRead(initial);
        throw cause('STALE_AUTHORITY');
      }
      if (initial.incarnation !== fields.incarnation) throw cause('STALE_INCARNATION');
      const snapshot = {
        principal: fields.principal,
        incarnation: fields.incarnation,
        fence: initial.fence,
      };

      // Re-read the bound data namespace while holding the authority
      // snapshot, then fence-check authority again after the await. This
      // closes the deletion/re-registration window without issuing any
      // capability or changing persisted state.
      const described = await dataDescribeSession(this.env, snapshot, fields);
      if (fields.expiresAt <= Date.now()) throw cause('INVALID_CREDENTIALS');
      const afterData = repository.read();
      if (!exactAuthority(afterData, snapshot)) throw cause('STALE_AUTHORITY');
      if (described.principal !== fields.principal
        || described.incarnation !== fields.incarnation
        || described.generation !== fields.generation) throw cause('INVALID_CREDENTIALS');
      if (fields.expiresAt <= Date.now()) throw cause('INVALID_CREDENTIALS');
      return {
        ok: true,
        principal: described.principal,
        incarnation: described.incarnation,
        generation: described.generation,
      };
    } catch (error) {
      return failure(knownError(error));
    }
  }

  async prepareDeletion(command) {
    try {
      if (this.env?.GEN05_ACCOUNT_API !== FEATURE) throw cause('FEATURE_DISABLED');
      const fields = exactRecord(command, ['principal', 'incarnation', 'generation', 'expiresAt', 'opId']);
      if (!isPrincipal(fields.principal) || typeof fields.incarnation !== 'string'
        || !HEX64.test(fields.incarnation) || fields.principal === fields.incarnation
        || typeof fields.opId !== 'string' || !UUID_V4.test(fields.opId)) throw cause('INVALID_INPUT');
      assertSessionClaim(fields.expiresAt, fields.generation);
      assertDeleteDependencies(this.env, this.ctx, fields.principal);
      assertAuthorityIdentity(this.env, this.ctx, fields.principal);

      const repository = deletionRepository(this, fields.principal);
      const initial = repository.read();
      if (!initial || initial.phase !== 'active' || initial.principal !== fields.principal
        || initial.incarnation !== fields.incarnation || !safeFence(initial.fence)) {
        throw cause('STALE_AUTHORITY');
      }
      const snapshot = {
        principal: fields.principal,
        incarnation: fields.incarnation,
        fence: initial.fence,
      };
      const described = await dataDescribeSession(this.env, snapshot, fields);
      if (fields.expiresAt <= Date.now()) throw cause('INVALID_CREDENTIALS');
      const afterData = repository.read();
      if (!exactAuthority(afterData, snapshot)) throw cause('STALE_AUTHORITY');
      if (described.principal !== snapshot.principal || described.incarnation !== snapshot.incarnation
        || described.generation !== fields.generation) throw cause('INVALID_CREDENTIALS');

      const expiresAt = ticketExpiresAt(Date.now());
      await scheduleAuthorityMaintenance(this,fields.principal,{ticketExpiryAt:expiresAt});
      const outcome = this.ctx.storage.transactionSync(() => {
        const sql = this.ctx.storage.sql;
        if (fields.expiresAt <= Date.now()) throw cause('INVALID_CREDENTIALS');
        if (!exactAuthority(repository.read(), snapshot)) throw cause('STALE_AUTHORITY');
        retention(this,fields.principal).assertOperationAvailable('deletion-ticket',fields.opId,{...fields,fence:snapshot.fence});
        createDeletionTicketSchema(sql);
        const existing = findDeletionTicketByOperation(sql, fields.principal, fields.opId);
        if (existing) {
          const current = repository.read();
          const stored = ticketCommand(existing);
          if (!sameTicketSnapshot(stored, { ...fields, fence: snapshot.fence })) throw cause('OPERATION_CONFLICT');
          if (!exactAuthority(current, snapshot)) throw cause('STALE_AUTHORITY');
          if (existing.expiresAt <= Date.now()) throw cause('INVALID_CREDENTIALS');
          return { ok: true, ticket: existing.ticket, expiresAt: existing.expiresAt };
        }
        const issued = issueDeletionTicket(fields.principal);
        const row = {
          ticket: issued.ticket,
          principal: fields.principal,
          secretHex: issued.secretHex,
          expiresAt,
          command: {
            principal: fields.principal,
            incarnation: fields.incarnation,
            generation: fields.generation,
            expiresAt: fields.expiresAt,
            fence: snapshot.fence,
            opId: fields.opId,
          },
        };
        insertDeletionTicket(sql, row);
        return { ok: true, ticket: row.ticket, expiresAt: row.expiresAt };
      });
      if (!outcome || outcome.ok !== true || typeof outcome.ticket !== 'string'
        || !ticketParts(outcome.ticket) || !Number.isSafeInteger(outcome.expiresAt)
        || outcome.expiresAt <= Date.now() || fields.expiresAt <= Date.now()
        || !exactAuthority(repository.read(), snapshot)) throw cause('STALE_AUTHORITY');
      return outcome;
    } catch (error) {
      return failure(knownError(error));
    }
  }

  async useDeletionTicket(command) {
    try {
      if (this.env?.GEN05_ACCOUNT_API !== FEATURE) throw cause('FEATURE_DISABLED');
      const fields = exactRecord(command, ['action', 'ticket']);
      if ((fields.action !== 'delete' && fields.action !== 'status') || typeof fields.ticket !== 'string') {
        throw cause('INVALID_INPUT');
      }
      const parts = ticketParts(fields.ticket);
      if (!parts) throw cause('INVALID_CREDENTIALS');
      assertDeleteDependencies(this.env, this.ctx, parts.principal);
      assertAuthorityIdentity(this.env, this.ctx, parts.principal);
      // This read path intentionally does not create the ticket table for an
      // unknown status/capability.
      const row = readDeletionTicket(this.ctx.storage.sql, fields.ticket);
      assertDeletionTicket(row, Date.now());
      const captured = ticketCommand(row);
      if (captured.principal !== parts.principal) throw cause('UNAVAILABLE');

      if (fields.action === 'status') {
        const jobs = deletionJobs(this, captured.principal);
        const job = findDeletionJob(jobs, captured.opId);
        let result;
        if (job) {
          if (!sameDeletionJob(job, {
            principal: captured.principal,
            incarnation: captured.incarnation,
            originalFence: captured.fence,
            opId: captured.opId,
            finishOpId: job.finishOpId,
          })) throw cause('UNAVAILABLE');
          result = job.status === 'complete'
            ? assertCompletedLineage(this, job)
            : assertPendingIdentity(this, job) && { ok: true, status: 'pending' };
        } else {
          const state = deletionRepository(this, captured.principal).read();
          if (!exactAuthority(state, {
            principal: captured.principal,
            incarnation: captured.incarnation,
            fence: captured.fence,
          })) throw cause('STALE_AUTHORITY');
          result = { ok: true, status: 'prepared' };
        }
        if (Date.now() >= row.expiresAt) throw cause('INVALID_CREDENTIALS');
        return result;
      }

      const result = await this.deleteTrusted(ticketDeleteCommand(row));
      if (!result || typeof result !== 'object' || Array.isArray(result)
        || result.ok !== true || (result.status !== 'pending' && result.status !== 'complete')) {
        if (result?.ok === false && result.error === 'DELETE_PENDING') throw cause('STALE_AUTHORITY');
        throw cause(result?.error || 'UNAVAILABLE');
      }
      if (Date.now() >= row.expiresAt) throw cause('INVALID_CREDENTIALS');
      return result;
    } catch (error) {
      return failure(knownError(error));
    }
  }

  async deleteTrusted(command) {
    try {
      if (this.env?.GEN05_ACCOUNT_API !== FEATURE) throw cause('FEATURE_DISABLED');
      const fields = validateDeleteCommand(command);
      assertDeleteDependencies(this.env, this.ctx, fields.principal);
      const job = await beginDeletion(this, fields);
      if (job.status === 'complete') return { ok: true, status: 'complete' };
      return await resumeDeletion(this, job);
    } catch (error) {
      return failure(knownError(error));
    }
  }

  async deleteLegacySourceTrusted(command) {
    try {
      if (!legacyMigrationEnabled(this.env)) throw cause('FEATURE_DISABLED');
      const fields = exactRecord(command, ['principal', 'opId']);
      if (!isPrincipal(fields.principal) || typeof fields.opId !== 'string' || !UUID_V4.test(fields.opId)) throw cause('INVALID_INPUT');
      assertDeleteDependencies(this.env, this.ctx, fields.principal);
      const repository = deletionRepository(this, fields.principal);
      let state = repository.read();
      let source = null;
      let deletedBanks = 0;
      if (state.phase === 'empty') {
        // Destruction does not import ambiguous older generations. Only this
        // trusted empty-authority path may remove a matching imported source
        // with a valid non-initial epoch; login/migration retain their guard.
        source = await legacySourceLookup(this.env, fields.principal, { allowDeleted: true, destructiveImportedEpoch: true });
        if (!source || !['legacy', 'orphaned', 'none', 'deleted'].includes(source.kind)) throw cause('MIGRATION_UNCERTAIN');
        deletedBanks = source.metadata?.bankCount || 0;
        // The source census can await KV and the UserStore. Re-read before
        // choosing a path; never turn an account created during census into
        // the no-authority deletion path.
        state = repository.read();
        if (state.phase === 'empty' && source.kind === 'none') return { ok: true, status: 'complete', deletedBanks: 0 };
      }
      if (state.phase === 'active') {
        // A source-only request never gains authority over a generation that
        // may have been registered while the source census was awaiting.
        throw cause('STALE_AUTHORITY');
      }
      if (state.phase === 'deleting') {
        const job = pendingDeletionJob(deletionJobs(this, fields.principal));
        if (!job || job.opId !== fields.opId) throw cause('STALE_AUTHORITY');
        // A prior attempt may have persisted the delete fence/job but stopped
        // before initializing its empty generation. Re-running bootstrap is
        // idempotent; a previously revoked generation simply continues into
        // the existing deletion recovery path.
        try { await dataBootstrap(this.env, { principal: job.principal, incarnation: job.incarnation }); } catch { /* resume below remains pending */ }
        const outcome = await resumeDeletion(this, job);
        if (!outcome?.ok) return outcome;
        return { ok: true, status: outcome.status, deletedBanks };
      }
      if (state.phase === 'empty') {
        // No Authority exists yet, but legacy data does. Create an empty
        // no-import generation and atomically advance it to deleting before
        // the first await. This reuses the existing fenced deletion job and
        // ensures no concurrent login can import or receive a session.
        const incarnation = freshIncarnation();
        const emptyRepository = createIncarnationRepository(this.ctx.storage, {
          principal: fields.principal, issueIncarnation: () => incarnation,
        });
        const deleteCommand = { principal: fields.principal, incarnation, expectedFence: 1, opId: fields.opId };
        const outcomes = emptyRepository.applySequence([
          { type: 'create', opId: migrationOperationId(fields.principal), expectedFence: 0 },
          { type: 'begin-delete', opId: fields.opId, expectedFence: 1, expectedIncarnation: incarnation },
        ], sql => {
          persistLegacyPolicy(sql, { principal: fields.principal, incarnation, mode: 'no-import', reason: 'ADMIN_LEGACY_SOURCE_DELETION' });
          createDeletionSchema(sql);
          insertDeletionJob(sql, createDeletionJob(deleteCommand, issueFinishOperationId()));
        });
        if (outcomes.length !== 2 || outcomes[1].state.phase !== 'deleting') throw cause('UNAVAILABLE');
        const job = pendingDeletionJob(deletionJobs(this, fields.principal));
        if (!job || job.opId !== fields.opId) throw cause('UNAVAILABLE');
        await scheduleDeletionRetry(this);
        const bootstrapped = await dataBootstrap(this.env, { principal: fields.principal, incarnation, fence: 1 });
        if (!bootstrapped?.ok || typeof bootstrapped.generation !== 'string') return { ok: true, status: 'pending', deletedBanks: 0 };
        assertPendingIdentity(this, persistedDeletion(this, job));
        const outcome = await resumeDeletion(this, job);
        if (!outcome?.ok) return outcome;
        return { ok: true, status: outcome.status, deletedBanks };
      }
      if (state.phase === 'retired') {
        // A retired generation is not a capability to delete a later fresh
        // generation. Only finish idempotent cleanup of its old source.
        const completed = deletionJobs(this, fields.principal).find(job => job.opId === fields.opId
          && job.incarnation === state.incarnation && job.status === 'complete');
        if (!completed) throw cause('STALE_AUTHORITY');
        if (legacyMigrationEnabled(this.env)) {
          const source = legacyUserStub(this.env, fields.principal);
          if (!source || typeof source.markLegacyMigrationDeletedTrusted !== 'function') throw cause('NOT_CONFIGURED');
          let result;
          try {
            result = await source.markLegacyMigrationDeletedTrusted({ expectedSub: fields.principal });
            assertPlainRpc(result, result?.ok === true ? ['ok'] : ['ok', 'error']);
            if (result.ok !== true) return { ok: true, status: 'pending', deletedBanks };
          } finally { await disposeRpc(result); await disposeStub(source); }
        }
        return { ok: true, status: 'complete', deletedBanks };
      }
      throw cause('MIGRATION_UNCERTAIN');
    } catch (error) { return failure(knownError(error)); }
  }

  async alarm() {
    this.maintenanceKvBudget=10;
    try {
    let failed=false;
    try{await recoverDeletion(this);}catch{failed=true;}
    const sql=this.ctx.storage.sql,found=Array.from(sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='gen05_authority_state'"));
    let principal;
    if(found.length)principal=JSON.parse(Array.from(sql.exec('SELECT state_json FROM gen05_authority_state'))[0].state_json).principal;
    else{
      // Prepared registration can precede persisted authority state. Its own
      // namespace-checked principal is captured from the secret table only.
      const table=Array.from(sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='gen05_registration_intents'"));
      if(table.length)principal=Array.from(sql.exec('SELECT principal FROM gen05_registration_intents LIMIT 1'))[0]?.principal;
    }
    if(!principal)return;
    for(const purpose of ['registration-intent','deletion-ticket'])try{retention(this,principal).gc({purpose});}catch{failed=true;}
    try{await cleanExpiredIssuedSessions(this,principal);}catch{failed=true;}
    this.maintenanceRetryAt=failed?Date.now()+DELETE_RETRY_MS:null;
    await scheduleAuthorityMaintenance(this,principal);
    } finally {
      delete this.maintenanceKvBudget;
    }
  }

}
