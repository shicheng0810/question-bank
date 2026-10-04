// 站主本地管理「特殊题库」（只在提取器 dev server 跑，用本机 wrangler 操作 CF KV）。
// 特殊题库 = 你做给特定人的私享题库：每个有一个你自定义的「分享码」，告诉谁、谁就能在网站
// signin 框输码进访客模式（只做这一个库、其他全变灰、不联网存历史、刷新即清）。不进任何账号体系。
// KV 键：sb:bank:<id>(题目) sb:meta:<id>(元数据,含明文分享码给你看) sb:code:<sha256(分享码)>→id(解析)
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const NS = 'defda68cdf274d2cad85b40066232daf'; // KV namespace EDITS

function wrangler(args, opts) {
  return execFileSync('npx', ['--yes', 'wrangler', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...(opts || {}) });
}
function kvList(prefix) {
  const result = JSON.parse(wrangler(['kv','key','list','--namespace-id='+NS,'--prefix='+prefix,'--remote']));
  if (!Array.isArray(result) || result.some(row => typeof row?.name !== 'string')) throw new Error('SHARE_LIST_INVALID');
  return result.map(row => row.name);
}
function kvGet(key) {
  try { return wrangler(['kv','key','get','--namespace-id='+NS,'--remote',key]); }
  catch (error) {
    // Only an explicit not-found response is absence; auth/network failures throw.
    const diagnostic = String(error.stderr || '') + String(error.stdout || '');
    if (/\b404\b/.test(diagnostic) && /not found|could not find/i.test(diagnostic)) return null;
    throw new Error('SHARE_READ_FAILED');
  }
}
function kvDelete(key) { wrangler(['kv', 'key', 'delete', '--namespace-id=' + NS, '--remote', key]); }
function kvPut(key, value) { wrangler(['kv', 'key', 'put', '--namespace-id=' + NS, '--remote', key, value]); }
function kvPutFile(key, value) { // 大体积（含图片）走文件，避免命令行长度限制
  const tmp = path.join(os.tmpdir(), 'qb-sb-' + crypto.randomBytes(6).toString('hex') + '.json');
  fs.writeFileSync(tmp, value);
  try { wrangler(['kv', 'key', 'put', '--namespace-id=' + NS, '--remote', key, '--path=' + tmp]); }
  finally { try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
}

function shareHash(code) { return crypto.createHash('sha256').update('qbshare:v1:' + String(code)).digest('hex'); }
function slug(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'bank'; }

/** Same existing KV keys; injection supports isolated loopback fixtures, not a
 * second production store. All backend errors remain errors. */
export function createSpecialBankService(kv = { list: kvList, get: kvGet, put: kvPutFile, delete: kvDelete }) {
  async function list() {
    const keys = await kv.list('sb:meta:');
    if (!Array.isArray(keys) || keys.some(key => typeof key !== 'string' || !key.startsWith('sb:meta:'))) throw new Error('SHARE_LIST_INVALID');
    const rows = await Promise.all(keys.map(async key => {
      const m = JSON.parse(await kv.get(key));
      if (!m || m.id !== key.slice(8) || typeof m.title !== 'string' || !Number.isSafeInteger(m.count) || m.count < 1 || typeof m.shareCode !== 'string' || !Number.isSafeInteger(m.ts)) throw new Error('SHARE_META_INVALID');
      return m;
    }));
    return rows.sort((a,b)=>b.ts-a.ts || a.id.localeCompare(b.id));
  }
  async function create({ title, questions, shareCode }) {
    const qs = Array.isArray(questions) ? questions : questions?.questions;
    if (!Array.isArray(qs) || !qs.length || qs.length > 5000) throw new Error('IMPORT_QUESTION_COUNT');
    const code = String(shareCode ?? '').trim();
    if (code.length < 6 || code.length > 80) throw new Error('分享码需 6–80 个字符');
    const codeKey = 'sb:code:' + shareHash(code);
    if (await kv.get(codeKey) !== null) throw new Error('SHARE_CODE_OCCUPIED');
    const id = slug(title) + '-' + crypto.randomBytes(3).toString('hex');
    const meta = { id, title: String(title || id).slice(0,160), count: qs.length, shareCode: code, ts: Date.now() };
    await kv.put('sb:bank:' + id, JSON.stringify(qs));
    await kv.put('sb:meta:' + id, JSON.stringify(meta));
    await kv.put(codeKey, id);
    const actual = await kv.get(codeKey), stored = await kv.get('sb:bank:' + id);
    if (actual !== id || stored !== JSON.stringify(qs)) throw new Error('SHARE_READBACK_MISMATCH');
    return meta;
  }
  async function remove(id) {
    if (typeof id !== 'string' || !/^[a-z0-9_-]{1,80}$/.test(id)) throw new Error('SHARE_ID_INVALID');
    const raw = await kv.get('sb:meta:' + id);
    if (raw === null) throw new Error('SHARE_NOT_FOUND');
    const meta = JSON.parse(raw);
    if (meta.id !== id || typeof meta.shareCode !== 'string') throw new Error('SHARE_META_INVALID');
    const codeKey = 'sb:code:' + shareHash(meta.shareCode);
    if (await kv.get(codeKey) !== id) throw new Error('SHARE_BINDING_MISMATCH');
    // Revoke code first. A failed payload deletion is reported, never success.
    await kv.delete(codeKey); await kv.delete('sb:bank:' + id); await kv.delete('sb:meta:' + id);
    if (await kv.get(codeKey) !== null || await kv.get('sb:bank:' + id) !== null || await kv.get('sb:meta:' + id) !== null) throw new Error('SHARE_DELETE_READBACK_MISMATCH');
    return { id };
  }
  return Object.freeze({ list, create, delete: remove });
}
const service = createSpecialBankService();
export const listSpecialBanks = () => service.list();
export const createSpecialBank = value => service.create(value);
export const deleteSpecialBank = id => service.delete(id);
