// 配套 Worker「qb-do」入口：导出两个 Durable Object 类，供 Pages 端用 script_name="qb-do" 绑定。
//
// 设计要点：
//  - DO 实例按 sub（UserStore）/ key（RateLimiter）分片，单线程串行执行 → 写操作天然原子，
//    解决 KV 无 CAS 的并发互踩（缺陷 A）与限流 get→compare→put 竞态（缺陷 B）。
//  - UserStore 懒迁移：首次访问把该用户的 h:/bl:/b: 从 KV 拷进 SQLite；绝不删 KV 原数据，
//    便于回滚（回退 Functions 即可继续读 KV 实时数据）。
import { DurableObject } from 'cloudflare:workers';
import {
  freezeLegacyMigration,
  isLegacyMigrationFrozen,
  legacyMigrationExportChunk,
  legacyMigrationExportPage,
  legacyMigrationMetadata,
  legacyMigrationSourceDiagnostics,
  isLegacyMigrationDeleted,
  markLegacyMigrationDeleted,
} from './legacy-userstore-export.js';
import { AccountAuthority } from './account-authority.js';
import { AccountGenerationStore } from './account-generation-store.js';
import { MigrationOperator } from './migration-operator.js';

export { ReportOperationStore } from '../../functions/_shared/report-operation-store.js';

export { AccountAuthority, AccountGenerationStore, MigrationOperator };

const MAX_HISTORY = 10;
const MAX_BANKS = 15;

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

export class UserStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this._importing = null;
    this.sql.exec('CREATE TABLE IF NOT EXISTS history(id TEXT PRIMARY KEY, ts INTEGER, bank_id TEXT, json TEXT)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS banks(id TEXT PRIMARY KEY, ts INTEGER, meta TEXT, questions TEXT)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT)');
  }

  _metaGet(k) {
    const rows = this.sql.exec('SELECT v FROM meta WHERE k=?', k).toArray();
    return rows.length ? rows[0].v : null;
  }

  _assertLegacyWritable() {
    if (isLegacyMigrationFrozen(this.sql)) {
      const error = new Error('migration_frozen');
      error.code = 'MIGRATION_FROZEN';
      throw error;
    }
  }

  legacyMigrationMetadata() {
    return legacyMigrationMetadata(this.sql);
  }

  markLegacyMigrationDeletedTrusted(input) {
    return this._markLegacyMigrationDeletedTrusted(input);
  }

  async _markLegacyMigrationDeletedTrusted(input) {
    try {
      if (!input || typeof input.expectedSub !== 'string' || !/^[0-9a-f]{64}$/.test(input.expectedSub)) {
        return { ok: false, error: 'INVALID_INPUT' };
      }
      this.ctx.storage.transactionSync(() => markLegacyMigrationDeleted(this.sql, input.expectedSub));
      await this._purgeLegacyKvPayload(input.expectedSub);
      return { ok: true };
    } catch (error) { return { ok: false, error: error?.code || 'SOURCE_UNAVAILABLE' }; }
  }

  async _purgeLegacyKvPayload(sub) {
    const kv = this.env.EDITS;
    if (!kv || typeof kv.get !== 'function' || typeof kv.put !== 'function'
      || typeof kv.delete !== 'function' || typeof kv.list !== 'function') throw Object.assign(new Error('NOT_CONFIGURED'), { code: 'NOT_CONFIGURED' });
    const delKey = `del:${sub}`;
    const epochKey = `uepoch:${sub}`;
    let marker;
    let epoch;
    try { [marker, epoch] = await Promise.all([kv.get(delKey), kv.get(epochKey)]); }
    catch { throw Object.assign(new Error('SOURCE_UNAVAILABLE'), { code: 'SOURCE_UNAVAILABLE' }); }
    if (epoch !== null && epoch !== undefined && (typeof epoch !== 'string' || !/^(?:0|[1-9]\d*)$/.test(epoch))) {
      throw Object.assign(new Error('MIGRATION_UNCERTAIN'), { code: 'MIGRATION_UNCERTAIN' });
    }
    const deletionPrefix = `gen07-deleted-v1:${sub}:`;
    let targetEpoch = null;
    if (typeof marker === 'string' && marker.startsWith(deletionPrefix)) {
      targetEpoch = marker.slice(deletionPrefix.length);
      if (!/^[1-9]\d*$/.test(targetEpoch) || BigInt(targetEpoch) > BigInt(Number.MAX_SAFE_INTEGER)) throw Object.assign(new Error('MIGRATION_UNCERTAIN'), { code: 'MIGRATION_UNCERTAIN' });
    } else if (marker === null || marker === undefined) {
      const current = epoch === null || epoch === undefined ? 0n : BigInt(epoch);
      if (current >= BigInt(Number.MAX_SAFE_INTEGER)) throw Object.assign(new Error('MIGRATION_UNCERTAIN'), { code: 'MIGRATION_UNCERTAIN' });
      targetEpoch = String(current + 1n);
      try { await kv.put(delKey, `${deletionPrefix}${targetEpoch}`); }
      catch { throw Object.assign(new Error('SOURCE_UNAVAILABLE'), { code: 'SOURCE_UNAVAILABLE' }); }
    }
    // The deletion marker is written before cleanup. Its deterministic target
    // epoch lets an interrupted retry finish without incrementing twice.
    if (targetEpoch !== null && (epoch === null || epoch === undefined || BigInt(epoch) < BigInt(targetEpoch))) {
      try { await kv.put(epochKey, targetEpoch); }
      catch { throw Object.assign(new Error('SOURCE_UNAVAILABLE'), { code: 'SOURCE_UNAVAILABLE' }); }
    } else if ((epoch === null || epoch === undefined) && marker !== null && marker !== undefined) {
      try { await kv.put(epochKey, '1'); }
      catch { throw Object.assign(new Error('SOURCE_UNAVAILABLE'), { code: 'SOURCE_UNAVAILABLE' }); }
    }
    const prefix = `b:${sub}:`;
    let cursor;
    const seenCursors = new Set();
    let pages = 0;
    for (;;) {
      if (pages >= 2) throw Object.assign(new Error('MIGRATION_QUARANTINED'), { code: 'MIGRATION_QUARANTINED' });
      let page;
      try { page = await kv.list(cursor === undefined ? { prefix, limit: 16 } : { prefix, limit: 16, cursor }); }
      catch { throw Object.assign(new Error('SOURCE_UNAVAILABLE'), { code: 'SOURCE_UNAVAILABLE' }); }
      pages += 1;
      if (!page || !Array.isArray(page.keys) || typeof page.list_complete !== 'boolean') {
        throw Object.assign(new Error('MIGRATION_UNCERTAIN'), { code: 'MIGRATION_UNCERTAIN' });
      }
      const names = new Set();
      for (const item of page.keys) {
        if (!item || typeof item.name !== 'string' || !item.name.startsWith(prefix)
          || item.name.length <= prefix.length || names.has(item.name)) {
          throw Object.assign(new Error('MIGRATION_QUARANTINED'), { code: 'MIGRATION_QUARANTINED' });
        }
        names.add(item.name);
      }
      for (const name of names) {
        try { await kv.delete(name); }
        catch { throw Object.assign(new Error('SOURCE_UNAVAILABLE'), { code: 'SOURCE_UNAVAILABLE' }); }
        if (isLegacyMigrationDeleted(this.sql) !== true) throw Object.assign(new Error('ACCOUNT_DELETED'), { code: 'ACCOUNT_DELETED' });
      }
      if (page.list_complete) break;
      if (typeof page.cursor !== 'string' || !page.cursor || seenCursors.has(page.cursor)) {
        throw Object.assign(new Error('MIGRATION_UNCERTAIN'), { code: 'MIGRATION_UNCERTAIN' });
      }
      seenCursors.add(page.cursor);
      cursor = page.cursor;
    }
    for (const key of [`bl:${sub}`, `h:${sub}`, `u:${sub}`, `ustat:${sub}`]) {
      try { await kv.delete(key); }
      catch { throw Object.assign(new Error('SOURCE_UNAVAILABLE'), { code: 'SOURCE_UNAVAILABLE' }); }
      if (!isLegacyMigrationDeleted(this.sql)) throw Object.assign(new Error('ACCOUNT_DELETED'), { code: 'ACCOUNT_DELETED' });
    }
  }

  async _notifyAuthorityOfLegacyDeletion(sub) {
    if (this.env.GEN07_LEGACY_MIGRATION !== '1') return;
    const raw = this._metaGet('legacyMigrationFreeze');
    if (!raw) return;
    let freeze;
    try { freeze = JSON.parse(raw); } catch { throw new Error('migration_state_invalid'); }
    if (!freeze || freeze.expectedSub !== sub || typeof freeze.freezeId !== 'string') throw new Error('migration_identity_invalid');
    if (freeze.state === 'deleted' && freeze.freezeId === `deleted:${sub}`) return;
    if (freeze.state !== 'frozen' || !/^[0-9a-f]{64}$/.test(freeze.freezeId)) throw new Error('migration_identity_invalid');
    const namespace = this.env.ACCOUNT_AUTHORITY;
    if (!namespace || typeof namespace.idFromName !== 'function' || typeof namespace.get !== 'function') {
      throw new Error('migration_authority_unavailable');
    }
    const stub = namespace.get(namespace.idFromName(sub));
    if (!stub || typeof stub.legacySourceDeletionObserved !== 'function') throw new Error('migration_authority_unavailable');
    const outcome = await stub.legacySourceDeletionObserved({ principal: sub, freezeId: freeze.freezeId });
    if (!outcome || typeof outcome !== 'object' || outcome.ok !== true
      || !['pending', 'complete', 'unmatched'].includes(outcome.status)) throw new Error('migration_authority_unavailable');
  }

  legacyMigrationSourceStatus() {
    return { ...legacyMigrationMetadata(this.sql), deleted: isLegacyMigrationDeleted(this.sql) };
  }

  legacyMigrationSourceDiagnostics() {
    return legacyMigrationSourceDiagnostics(this.sql);
  }

  freezeLegacyMigration(input) {
    return freezeLegacyMigration({ sql: this.sql, kv: this.env.EDITS, ...input });
  }

  legacyMigrationExportPage(input) {
    return legacyMigrationExportPage({ sql: this.sql, kv: this.env.EDITS, ...input });
  }

  legacyMigrationExportChunk(input) {
    return legacyMigrationExportChunk({ sql: this.sql, kv: this.env.EDITS, ...input });
  }

  // 首次访问把 KV 里该用户的数据拷进 DO（幂等，meta.imported 守卫；并发首调用用 promise 去重）。
  async ensureImported(sub) {
    if (this._metaGet('imported')) return;
    if (!this._importing) {
      const task = this._doImport(sub);
      this._importing = task;
      try { await task; }
      finally { if (this._importing === task) this._importing = null; }
      return;
    }
    await this._importing;
  }

  async _doImport(sub) {
    this._assertLegacyWritable();
    const historyText = await this.env.EDITS.get('h:' + sub);
    this._assertLegacyWritable();
    const banksText = await this.env.EDITS.get('bl:' + sub);
    this._assertLegacyWritable();
    let hist; let list;
    try { hist = historyText == null ? [] : JSON.parse(historyText); } catch { throw new Error('legacy_history_corrupt'); }
    try { list = banksText == null ? [] : JSON.parse(banksText); } catch { throw new Error('legacy_bank_list_corrupt'); }
    if (!Array.isArray(hist) || hist.length > MAX_HISTORY || !Array.isArray(list) || list.length > MAX_BANKS) {
      throw new Error('legacy_source_shape');
    }
    const banks = [];
    for (const b of list) {
      this._assertLegacyWritable();
      if (!b || typeof b.id !== 'string' || !b.id) throw new Error('legacy_bank_list_corrupt');
      const questions = await this.env.EDITS.get('b:' + sub + ':' + b.id);
      this._assertLegacyWritable();
      if (questions == null) throw new Error('legacy_bank_missing');
      let parsed;
      try { parsed = JSON.parse(questions); } catch { throw new Error('legacy_bank_corrupt'); }
      if (!Array.isArray(parsed)) throw new Error('legacy_bank_corrupt');
      banks.push({ meta: b, questions });
    }
    // All external reads finish before this transaction; no partial lazy import
    // can be published if a source read or the migration fence fails.
    this._assertLegacyWritable();
    this.ctx.storage.transactionSync(() => {
      for (const s of hist) {
        if (!s || !s.id) throw new Error('legacy_history_corrupt');
        this.sql.exec('INSERT OR REPLACE INTO history(id,ts,bank_id,json) VALUES(?,?,?,?)',
          String(s.id), Number(s.ts) || 0, String(s.bank_id || ''), JSON.stringify(s));
      }
      for (const { meta, questions } of banks) {
        this.sql.exec('INSERT OR REPLACE INTO banks(id,ts,meta,questions) VALUES(?,?,?,?)',
          String(meta.id), Number(meta.ts) || 0, JSON.stringify(meta), questions);
      }
      this.sql.exec("INSERT OR REPLACE INTO meta(k,v) VALUES('sub',?)", sub);
      this.sql.exec("INSERT OR REPLACE INTO meta(k,v) VALUES('imported','1')");
    });
    await this._writeStat(sub);
  }

  // 站主在提取器里删用户 = 设 KV 墓碑 del:<sub>（本地 wrangler 够不到 DO）。DO 每次被访问先查墓碑：
  // 命中 → 清空全部表 + 删墓碑（消费，避免之后重建的账号被反复清）。meta 清掉后 ensureImported 会从
  // 已清空的 KV 重导（=空）。这样删完立即不可读，物理清除发生在该用户下次访问 DO 时。
  async maybePurgeOnTombstone(sub) {
    let del;
    try { del = await this.env.EDITS.get('del:' + sub, { type: 'arrayBuffer' }); }
    catch { throw new Error('legacy_tombstone_unavailable'); }
    if (del == null) return;
    await this._notifyAuthorityOfLegacyDeletion(sub);
    this.ctx.storage.transactionSync(() => markLegacyMigrationDeleted(this.sql, sub));
    await this._purgeLegacyKvPayload(sub);
    this._importing = null;
  }

  _historyList() {
    return this.sql.exec('SELECT json FROM history ORDER BY ts DESC').toArray().map((r) => JSON.parse(r.json));
  }
  _banksList() {
    return this.sql.exec('SELECT meta FROM banks ORDER BY ts DESC').toArray().map((r) => JSON.parse(r.meta));
  }

  // 把该用户的实时计数镜像到 KV（ustat:<sub> = {h,b}，同时写进 metadata）。DO 是数据真身、KV 这份
  // 只读给站主本地后台显示——否则提取器面板（读 KV）对"数据在 DO、KV 为空"的用户会把历史/题库数显示成 0。
  //
  // ⚠ 只在计数**变化**时才写 KV。播放器每答一题就（1.5s 防抖）存一次快照 → putHistory → 这里；
  // 而一轮练习里 upsert 的是同一条 history 记录，h/b 根本不变，等于把同样的值重复写几百次。
  // KV 免费额度每天只有 1000 次写：一个学生做完 246 题的题库就烧掉约 246 次，四个人就见底
  // （2026-08-25 收到 Cloudflare「已用 50% 日额度」告警，就是这么来的）。
  // 上次写入的值存在 DO 的 meta 表里（不是内存），这样 DO 被回收重建后也不会白写一次。
  async _writeStat(sub) {
    const h = this.sql.exec('SELECT COUNT(*) AS c FROM history').toArray()[0].c;
    const b = this.sql.exec('SELECT COUNT(*) AS c FROM banks').toArray()[0].c;
    const sig = h + ':' + b;
    if (this._metaGet('statsig') === sig) return;   // 计数没变 → 不写（这份镜像不需要实时）
    try {
      await this.env.EDITS.put('ustat:' + sub, JSON.stringify({ h, b }), { metadata: { h, b } });
      this.sql.exec('INSERT OR REPLACE INTO meta(k,v) VALUES(?,?)', 'statsig', sig);
    } catch { /* 写失败不记 statsig，下次自然重试 */ }
  }

  async fetch(request) {
    let body = {};
    try { body = await request.json(); } catch { body = {}; }
    const op = new URL(request.url).pathname.replace(/^\//, '');
    const sub = body.sub;
    if (!sub) return jsonResponse({ error: 'no_sub' }, 400);
    const writes = new Set(['putHistory', 'deleteHistory', 'putBank', 'deleteBank']);
    if (writes.has(op) && isLegacyMigrationFrozen(this.sql)) return jsonResponse({ error: 'migration_frozen' }, 409);
    try { await this.maybePurgeOnTombstone(sub); }
    catch { return jsonResponse({ error: 'legacy_source_unavailable' }, 503); }
    if (isLegacyMigrationDeleted(this.sql) && op !== 'purgeAll') return jsonResponse({ error: 'account_deleted' }, 410);
    if (op === 'purgeAll') {
      try {
        await this._notifyAuthorityOfLegacyDeletion(sub);
        this.ctx.storage.transactionSync(() => markLegacyMigrationDeleted(this.sql, sub));
        await this._purgeLegacyKvPayload(sub);
        return jsonResponse({ ok: true });
      } catch {
        return jsonResponse({ error: 'account_deleted' }, 410);
      }
    }
    try { await this.ensureImported(sub); }
    catch (error) {
      if (writes.has(op) && error?.code === 'MIGRATION_FROZEN') return jsonResponse({ error: 'migration_frozen' }, 409);
      return jsonResponse({ error: 'legacy_source_unavailable' }, 503);
    }
    if (writes.has(op) && isLegacyMigrationFrozen(this.sql)) return jsonResponse({ error: 'migration_frozen' }, 409);

    switch (op) {
      case 'listHistory':
        return jsonResponse({ items: this._historyList() });

      case 'getHistory': {
        const rows = this.sql.exec('SELECT json FROM history WHERE id=?', String(body.id)).toArray();
        return jsonResponse({ snapshot: rows.length ? JSON.parse(rows[0].json) : null });
      }

      case 'putHistory': {
        this._assertLegacyWritable();
        // 单条原子 upsert + 裁剪最近 maxN —— 整段无 await，DO 单线程 → 不会与并发 POST 互踩。
        const s = body.snapshot;
        const maxN = Number(body.maxN) || MAX_HISTORY;
        this.sql.exec('DELETE FROM history WHERE id=?', String(s.id));
        this.sql.exec('INSERT INTO history(id,ts,bank_id,json) VALUES(?,?,?,?)',
          String(s.id), Number(s.ts) || 0, String(s.bank_id || ''), JSON.stringify(s));
        this.sql.exec('DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY ts DESC LIMIT ?)', maxN);
        await this._writeStat(sub);
        return jsonResponse({ items: this._historyList() });
      }

      case 'deleteHistory':
        this._assertLegacyWritable();
        this.sql.exec('DELETE FROM history WHERE id=?', String(body.id));
        await this._writeStat(sub);
        return jsonResponse({ items: this._historyList() });

      case 'listBanks':
        return jsonResponse({ items: this._banksList() });

      case 'getBank': {
        const rows = this.sql.exec('SELECT meta,questions FROM banks WHERE id=?', String(body.id)).toArray();
        if (!rows.length) return jsonResponse({ bank: null });
        const m = JSON.parse(rows[0].meta);
        let questions = [];
        try { questions = JSON.parse(rows[0].questions); } catch { questions = []; }
        return jsonResponse({ bank: { id: m.id, title: m.title || m.id, questions } });
      }

      case 'putBank': {
        this._assertLegacyWritable();
        // 原子：超量检查 + 写 meta + 写 questions（旧 KV 实现是两次独立 put，会被并发互踩）。
        const m = body.meta; // {id,title,count,ts,bytes}
        const maxN = Number(body.maxBanks) || MAX_BANKS;
        const exists = this.sql.exec('SELECT id FROM banks WHERE id=?', String(m.id)).toArray().length > 0;
        if (!exists) {
          const cnt = this.sql.exec('SELECT COUNT(*) AS c FROM banks').toArray()[0].c;
          if (cnt >= maxN) return jsonResponse({ error: 'limit' });
        }
        this.sql.exec('INSERT OR REPLACE INTO banks(id,ts,meta,questions) VALUES(?,?,?,?)',
          String(m.id), Number(m.ts) || 0, JSON.stringify(m), String(body.questions || '[]'));
        await this._writeStat(sub);
        return jsonResponse({ items: this._banksList() });
      }

      case 'deleteBank': {
        this._assertLegacyWritable();
        // 原子：删库 + 级联删该库历史（私有库 bank_id = "u-"+id 或 id）。
        const id = String(body.id);
        this.sql.exec('DELETE FROM banks WHERE id=?', id);
        this.sql.exec('DELETE FROM history WHERE bank_id=? OR bank_id=?', 'u-' + id, id);
        await this._writeStat(sub);
        return jsonResponse({ items: this._banksList() });
      }

      default:
        return jsonResponse({ error: 'unknown_op' }, 400);
    }
  }
}

export class RateLimiter extends DurableObject {
  // 固定窗口原子计数：window=floor(now/period)，同窗口自增、跨窗口重置。DO 单线程 → 无竞态。
  async fetch(request) {
    let body = {};
    try { body = await request.json(); } catch { body = {}; }
    const limit = Number(body.limit) || 0;
    const periodSec = Number(body.periodSec) || 60;
    const now = Date.now();
    const win = Math.floor(now / (periodSec * 1000));
    const st = (await this.ctx.storage.get('st')) || { win: -1, c: 0 };
    const c = st.win === win ? st.c + 1 : 1;
    await this.ctx.storage.put('st', { win, c });
    return jsonResponse({ allowed: c <= limit });
  }
}

// 顶层 fetch（健康检查；DO 实际通过绑定从 Pages 调用，不走这里）。
export default {
  async fetch() {
    return new Response('qb-do up', { status: 200, headers: { 'content-type': 'text/plain' } });
  },
};
