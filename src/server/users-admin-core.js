// 站主本地后台：只读 Cloudflare metadata census；删除通过受限 MigrationOperator RPC。
// 不读取/打印用户 payload、会话 token 或原始 Cloudflare API 响应。
import crypto from 'node:crypto';
import { createCloudflareMetadataClient } from '../../scripts/migration/cloudflare-api.mjs';
import { migrationOperatorCall, withMigrationOperator } from '../../scripts/migration/local-operator-client.mjs';
import { mapNativeIdentityRows } from './native-identity-dto.js';

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || '1cb5e6e63a6b3c3ea0ad9bb01dac30e9';
const EDITS = 'defda68cdf274d2cad85b40066232daf';
const SCRIPT = 'qb-do';
const SUB = /^[a-f0-9]{64}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NATIVE_STATS_KEYS = ['ok', 'status', 'principal', 'incarnation', 'fence', 'generation', 'highWater',
  'historySnapshotCount', 'attemptCount', 'activePrivateBankCount', 'tombstoneCount', 'coverageStatus'];
let cachedCloudflareMetadataClient;
function cloudflare() {
  if (!cachedCloudflareMetadataClient) cachedCloudflareMetadataClient = createCloudflareMetadataClient({ accountId: ACCOUNT_ID });
  return cachedCloudflareMetadataClient;
}

function fail(code) { throw new Error(code); }
function checked(result) {
  if (!result || result.ok !== true) fail(result?.error || 'MIGRATION_OPERATOR_UNAVAILABLE');
  return result;
}
async function mapLimit(items, limit, mapper) {
  const output = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      output[index] = await mapper(items[index], index);
    }
  }));
  return output;
}

function emptyUser(sub) {
  return { sub, accountKind: 'legacy-only', accountPhase: null,
    hasHistory: null, banks: null, countsKnown: false, countsScope: 'native-unavailable',
    nativeStats: { status: 'unknown', historySnapshotCount: null, activePrivateBankCount: null,
      attemptCount: null, tombstoneCount: null, generation: null, highWater: null, coverageStatus: 'unknown' },
    legacyCounts: null, deleting: false };
}

function exactPlainKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Reflect.ownKeys(value);
  return actual.every(key => typeof key === 'string') && actual.length === keys.length
    && keys.every(key => actual.includes(key))
    && keys.every(key => { const d = Object.getOwnPropertyDescriptor(value, key); return d && 'value' in d; });
}

function unknownNativeStats(generation = null) {
  return { status: 'unknown', historySnapshotCount: null, activePrivateBankCount: null,
    attemptCount: null, tombstoneCount: null, generation, highWater: null, coverageStatus: 'unknown' };
}

function safeNativeStats(value, authority) {
  if (!exactPlainKeys(value, NATIVE_STATS_KEYS) || value.ok !== true
    || value.principal !== authority.principal || value.incarnation !== authority.incarnation
    || value.fence !== authority.fence || !['verified', 'unknown'].includes(value.status)
    || value.coverageStatus !== 'unknown') fail('CENSUS_UNCERTAIN');
  if (value.status === 'unknown') {
    if (!UUID_V4.test(value.generation) || [value.highWater, value.historySnapshotCount, value.attemptCount,
      value.activePrivateBankCount, value.tombstoneCount].some(field => field !== null)) fail('CENSUS_UNCERTAIN');
    return unknownNativeStats(value.generation);
  }
  if (!UUID_V4.test(value.generation) || typeof value.highWater !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value.highWater)
    || !['historySnapshotCount', 'attemptCount', 'activePrivateBankCount', 'tombstoneCount']
      .every(field => Number.isSafeInteger(value[field]) && value[field] >= 0)) fail('CENSUS_UNCERTAIN');
  return { status: 'verified', generation: value.generation, highWater: value.highWater,
    historySnapshotCount: value.historySnapshotCount, attemptCount: value.attemptCount,
    activePrivateBankCount: value.activePrivateBankCount, tombstoneCount: value.tombstoneCount,
    coverageStatus: 'unknown' };
}

function applyCounts(user, historyCount, bankCount, countsScope) {
  if (!Number.isSafeInteger(historyCount) || historyCount < 0
    || !Number.isSafeInteger(bankCount) || bankCount < 0) fail('CENSUS_UNAVAILABLE');
  // These inspection methods only prove legacy source/archive counts. Never
  // populate native compatibility fields with them, including a legacy zero.
  user.legacyCounts = { historyCount, bankCount, scope: countsScope };
}

async function authorityRows(metadataClient = cloudflare(), withOperator = withMigrationOperator) {
  const { objects } = await metadataClient.listDurableObjects({ scriptName: SCRIPT, className: 'AccountAuthority' });
  const stored = objects.filter(item => item.hasStoredData);
  return withOperator(async call => (await mapLimit(stored, 6, async item => {
    const status = checked(await call('inspectAuthority', { objectId: item.id }));
    if (status.status === 'empty') return null;
    if (status.status !== 'observed' || !SUB.test(status.principal)) fail('CENSUS_UNAVAILABLE');
    let nativeStats = unknownNativeStats();
    if (status.phase === 'active') {
      try {
        const result = await call('inspectNativeAdminStatus', { principal: status.principal });
        nativeStats = result?.ok === false ? unknownNativeStats() : safeNativeStats(result, status);
      }
      catch (error) {
        if (error?.message === 'CENSUS_UNCERTAIN') throw error;
        // A pre-upgrade Worker may not expose the new safe read method yet.
        // Keep the authority observed, but never turn unavailable into zero.
        nativeStats = unknownNativeStats();
      }
    }
    return { objectId: item.id, ...status, nativeStats };
  })).filter(Boolean));
}

async function nativeAuthorityRows(metadataClient = cloudflare(), withOperator = withMigrationOperator) {
  const { objects } = await metadataClient.listDurableObjects({ scriptName: SCRIPT, className: 'AccountAuthority' });
  return withOperator(async call => mapNativeIdentityRows(objects, {
    readIdentity: objectId => call('inspectNativeIdentity', { objectId }),
    readStats: principal => call('inspectNativeAdminStatus', { principal }),
  }));
}

async function sourceRows(metadataClient = cloudflare(), withOperator = withMigrationOperator) {
  const { objects } = await metadataClient.listDurableObjects({ scriptName: SCRIPT, className: 'UserStore' });
  const stored = objects.filter(item => item.hasStoredData);
  return withOperator(async call => (await mapLimit(stored, 6, async item => {
    const status = checked(await call('inspectSource', { objectId: item.id }));
    if (status.deleted) return { ...status, objectId: item.id };
    if (status.sub === null) {
      if (status.historyCount || status.bankCount || status.imported) fail('CENSUS_UNCERTAIN');
      return null;
    }
    if (!SUB.test(status.sub)) fail('CENSUS_UNCERTAIN');
    return { ...status, objectId: item.id };
  })).filter(Boolean));
}

async function kvUserRows(metadataClient = cloudflare()) {
  const [users, stats] = await Promise.all([
    metadataClient.listKVKeys({ namespaceId: EDITS, prefix: 'u:' }),
    metadataClient.listKVKeys({ namespaceId: EDITS, prefix: 'ustat:' }),
  ]);
  const counts = new Map();
  for (const key of stats.keys) {
    const sub = key.name.slice('ustat:'.length);
    if (!SUB.test(sub)) fail('CENSUS_UNCERTAIN');
    counts.set(sub, key.metadata);
  }
  const rows = [];
  for (const key of users.keys) {
    const sub = key.name.slice('u:'.length);
    if (!SUB.test(sub)) fail('CENSUS_UNCERTAIN');
    const user = emptyUser(sub);
    const metadata = counts.get(sub);
    if (metadata && Number.isSafeInteger(metadata.h) && Number.isSafeInteger(metadata.b)) {
      applyCounts(user, metadata.h, metadata.b, 'legacy-kv-mirror');
    }
    rows.push(user);
  }
  return rows;
}

// Metadata-only full account census. Any namespace, page, or DO inspection
// error fails the whole read; it is never converted into an empty user list.
export async function listUsers({ metadataClient = cloudflare(), withOperator = withMigrationOperator, includeLegacy = false } = {}) {
  if (typeof includeLegacy !== 'boolean') fail('INVALID_CENSUS_SCOPE');
  if (!includeLegacy) {
    const identities = await nativeAuthorityRows(metadataClient, withOperator);
    return identities.filter(identity => identity.phase !== 'retired').map(identity => {
      if (identity.phase !== 'active' && identity.phase !== 'deleting') throw new Error('UNKNOWN_AUTHORITY_PHASE');
      const user = emptyUser(identity.principal);
      user.accountKind = 'native';
      user.accountPhase = identity.phase;
      user.deleting = identity.deleting;
      user.nativeStats = identity.nativeStats;
      return user;
    }).sort((a, b) => a.sub.localeCompare(b.sub));
  }
  const authorities = await authorityRows(metadataClient, withOperator);
  const [kvUsers, sources] = await Promise.all([
    kvUserRows(metadataClient), sourceRows(metadataClient, withOperator),
  ]);
  const bySub = new Map(kvUsers.map(user => [user.sub, user]));
  for (const source of sources) {
    if (source.deleted) {
      bySub.delete(source.sub);
      continue;
    }
    const user = bySub.get(source.sub) || emptyUser(source.sub);
    applyCounts(user, source.historyCount, source.bankCount, 'legacy-source');
    bySub.set(source.sub, user);
  }
  for (const authority of authorities) {
    if (authority.phase === 'retired') {
      bySub.delete(authority.principal);
      continue;
    }
    const user = bySub.get(authority.principal) || emptyUser(authority.principal);
    if (authority.phase !== 'active' && authority.phase !== 'deleting') throw new Error('UNKNOWN_AUTHORITY_PHASE');
    user.accountKind = 'native';
    user.accountPhase = authority.phase;
    user.deleting = authority.phase === 'deleting';
    user.nativeStats = authority.nativeStats || unknownNativeStats();
    if (authority.archiveStatus === 'sealed') {
      applyCounts(user, authority.historyTotal, authority.bankTotal, 'legacy-archive');
    }
    bySub.set(authority.principal, user);
  }
  // Namespace enumeration is an observed census, not a completeness proof.
  // Legacy-only metadata is explicitly opt-in, never a current account row.
  return Array.from(bySub.values()).filter(user => includeLegacy || user.accountKind === 'native')
    .sort((a, b) => a.sub.localeCompare(b.sub));
}

// 码 → sub（与 auth.js 相同的 trim + 加盐哈希）。
export function codeToSub(code) {
  return crypto.createHash('sha256').update('qbcode:v1:' + String(code == null ? '' : code).trim()).digest('hex');
}

async function authorityForPrincipal(principal, metadataClient = cloudflare(), withOperator = withMigrationOperator) {
  const rows = await authorityRows(metadataClient, withOperator);
  return rows.find(row => row.principal === principal) || null;
}

export async function deleteUser(sub, { metadataClient = cloudflare(), withOperator = withMigrationOperator,
  operatorCall = migrationOperatorCall } = {}) {
  if (!SUB.test(String(sub))) fail('INVALID_SUB');
  const principal = String(sub);
  const authority = await authorityForPrincipal(principal, metadataClient, withOperator);
  if (authority?.phase === 'deleting') return { sub: principal, status: 'pending', deletedBanks: 0 };
  if (authority?.phase === 'active') {
    const result = checked(await operatorCall('delete', {
      principal, incarnation: authority.incarnation, expectedFence: authority.fence, opId: crypto.randomUUID(),
    }));
    if (!['pending', 'complete'].includes(result.status)) fail('MIGRATION_OPERATOR_UNAVAILABLE');
    return { sub: principal, status: result.status, deletedBanks: 0 };
  }
  if (authority?.phase === 'retired') return { sub: principal, status: 'complete', deletedBanks: 0 };
  // No current Authority: trusted path is constrained to a still-empty source
  // census and persists the deletion fence before awaiting source cleanup.
  const result = checked(await operatorCall('deleteLegacySource', { principal, opId: crypto.randomUUID() }));
  if (!['pending', 'complete'].includes(result.status) || !Number.isSafeInteger(result.deletedBanks)) fail('MIGRATION_OPERATOR_UNAVAILABLE');
  return { sub: principal, status: result.status, deletedBanks: result.deletedBanks };
}

export async function deleteUsers(subs, options) {
  const list = Array.isArray(subs) ? Array.from(new Set(subs.map(value => String(value || '')).filter(Boolean))) : [];
  let deletedUsers = 0;
  let pendingUsers = 0;
  let deletedBanks = 0;
  const errors = [];
  for (const sub of list) {
    try {
      const result = await deleteUser(sub, options);
      if (result.status === 'complete') {
        deletedUsers += 1;
        deletedBanks += result.deletedBanks || 0;
      } else pendingUsers += 1;
    } catch (error) {
      errors.push({ sub, error: String(error?.message || 'DELETE_UNAVAILABLE').slice(0, 80) });
    }
  }
  const status = deletedUsers === list.length && errors.length === 0 ? 'complete' : 'pending';
  return { status, requested: list.length, deletedUsers, pendingUsers, deletedBanks, errors };
}

export async function attachUserListAfterAction(result, refresh = listUsers) {
  try { return { ...result, users: await refresh() }; }
  catch (error) { return { ...result, refreshError: String(error?.message || 'CENSUS_UNAVAILABLE').slice(0, 80) }; }
}
