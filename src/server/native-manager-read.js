import {readManagerMigrationPreflight} from './manager-migration-preflight.js';
import { validAdminItemsCommand, safeAdminItemsResult } from '../../do-worker/src/native-admin-items-dto.js';
const SUB = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const missing = (endpoint, reason) => ({ status: 'unknown', items: null, endpoint, reason });
function validRows(rows) {
  if (!Array.isArray(rows) || rows.some(row => !row || !SUB.test(row.sub)
    || !['native', 'legacy-only'].includes(row.accountKind))
    || new Set(rows.map(row => row.sub)).size !== rows.length) throw new Error('CENSUS_SHAPE_INVALID');
  return rows;
}
// Cursor is an exclusive principal boundary, scoped to query and census mode.
// Every page is a fresh observation; it is not a frozen cloud snapshot.
export async function readNativeManager(query, { list, withOperator }) {
  const q = (query.get('q') || '').trim().toLowerCase();
  if (q.length > 64 || q && !/^[0-9a-f]+$/.test(q)) throw new Error('INVALID_SEARCH');
  const includeLegacy = query.get('includeLegacy') === '1';
  const detail = query.get('sub');
  if (detail && !SUB.test(detail)) throw new Error('INVALID_SUB');
  const rows = validRows(await list({ includeLegacy }));
  if (detail) {
    const user = rows.find(row => row.sub === detail);
    if (!user) throw new Error('ACCOUNT_NOT_OBSERVED');
    if(query.get('preflight')==='1'){if(typeof withOperator!=='function')throw Error('MIGRATION_PREFLIGHT_UNAVAILABLE');return readManagerMigrationPreflight(query,user,withOperator);}
    const kind = query.get('kind');
    if (kind) {
      const command = { principal: user.sub, incarnation: query.get('incarnation'), expectedFence: Number(query.get('fence')),
        expectedGeneration: query.get('generation'), kind, limit: Number(query.get('limit') || '25'), cursor: query.get('cursor') || null };
      if (!validAdminItemsCommand(command)) throw new Error('INVALID_ADMIN_ITEMS_QUERY');
      if (user.accountKind !== 'native' || user.accountPhase !== 'active' || user.incarnation !== command.incarnation
        || user.fence !== command.expectedFence || user.nativeStats?.generation !== command.expectedGeneration) throw new Error('STALE_ACCOUNT_BINDING');
      if (typeof withOperator !== 'function') throw new Error('ADMIN_ITEMS_UNAVAILABLE');
      const result = await withOperator(call => call('inspectNativeAdminItems', command));
      const safe = safeAdminItemsResult(result, command);
      if (!safe || safe.ok !== true) throw new Error(safe?.error || 'ADMIN_ITEMS_SHAPE_INVALID');
      return safe;
    }
    const stats = user.nativeStats;
    const verified = user.accountKind === 'native' && stats?.status === 'verified'
      && UUID.test(stats.generation) && ['historySnapshotCount','attemptCount','activePrivateBankCount','tombstoneCount']
        .every(key => Number.isSafeInteger(stats[key]) && stats[key] >= 0);
    return { ok: true, user, binding: { principal: user.sub, incarnation: user.incarnation ?? null,
      fence: user.fence ?? null, generation: stats?.generation ?? null },
      counts: { status: verified ? 'verified' : 'unknown', source: 'inspectNativeAdminStatus',
        historySnapshotCount: verified ? stats.historySnapshotCount : null,
        attemptCount: verified ? stats.attemptCount : null,
        activePrivateBankCount: verified ? stats.activePrivateBankCount : null },
      history: missing('MigrationOperator: native history metadata list', 'Use manager detail kind query with displayed binding; no page observed yet'),
      privateBanks: missing('MigrationOperator: native private bank metadata list', 'Use manager detail kind query with displayed binding; no page observed yet'),
      save: { status: 'unknown', reason: 'highWater is an observed cloud sequence, not a local save receipt', highWater: verified ? stats.highWater : null },
      report: { status: 'unknown', reason: 'Use global Report panel by operationID; no account-to-Report ownership contract' },
      publication: { localSave: 'unknown', preview: 'unknown', production: 'unknown', onlineReadback: 'unknown' } };
  }
  const limit = Number(query.get('limit') || '25');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('INVALID_PAGE_LIMIT');
  let after = '';
  const cursor = query.get('cursor');
  if (cursor) {
    try {
      const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString());
      if (decoded.q !== q || decoded.legacy !== includeLegacy || !SUB.test(decoded.after)) throw new Error();
      after = decoded.after;
    } catch { throw new Error('INVALID_PAGE_CURSOR'); }
  }
  const matching = rows.filter(row => (includeLegacy || row.accountKind === 'native') && row.sub.includes(q))
    .sort((a,b) => a.sub.localeCompare(b.sub));
  const remaining = matching.filter(row => row.sub > after);
  const users = remaining.slice(0,limit);
  return { ok: true, users, observedMatches: matching.length, completeness: 'unknown',
    observation: 'fresh-census', nextCursor: remaining.length > limit
      ? Buffer.from(JSON.stringify({ q, legacy: includeLegacy, after: users.at(-1).sub })).toString('base64url') : null };
}
