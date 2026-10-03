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
  try {
    const a = JSON.parse(wrangler(['kv', 'key', 'list', '--namespace-id=' + NS, '--prefix=' + prefix, '--remote']));
    return Array.isArray(a) ? a.map((k) => k.name).filter(Boolean) : [];
  } catch { return []; }
}
// get 查不到键会往 stderr 打 404——这是「分享码可用」的正常情况，静音 stderr 免得唬人。
function kvGet(key) { try { return wrangler(['kv', 'key', 'get', '--namespace-id=' + NS, '--remote', key], { stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; } }
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

export function listSpecialBanks() {
  const ids = kvList('sb:meta:').map((k) => k.slice('sb:meta:'.length));
  return ids.map((id) => {
    try { const m = JSON.parse(kvGet('sb:meta:' + id) || '{}'); return { id, title: m.title || id, count: m.count || 0, shareCode: m.shareCode || '', ts: m.ts || 0 }; }
    catch { return { id, title: id, count: 0, shareCode: '', ts: 0 }; }
  }).sort((a, b) => (b.ts - a.ts));
}

export function createSpecialBank({ title, questions, shareCode }) {
  const qs = Array.isArray(questions) ? questions : (questions && Array.isArray(questions.questions) ? questions.questions : null);
  if (!qs || !qs.length) throw new Error('题目为空');
  const code = String(shareCode == null ? '' : shareCode).trim();
  if (code.length < 6 || code.length > 80) throw new Error('分享码需 6–80 个字符（太短易被猜到）');
  const codeKey = 'sb:code:' + shareHash(code);
  const exist = kvGet(codeKey);
  if (exist && String(exist).trim()) throw new Error('这个分享码已被占用，换一个');
  const id = slug(title) + '-' + crypto.randomBytes(3).toString('hex');
  const t = String(title || id).slice(0, 160);
  kvPutFile('sb:bank:' + id, JSON.stringify(qs));
  kvPut('sb:meta:' + id, JSON.stringify({ id, title: t, count: qs.length, shareCode: code, ts: Date.now() }));
  kvPut(codeKey, id);
  return { id, title: t, count: qs.length, shareCode: code };
}

export function deleteSpecialBank(id) {
  const sid = slug(id);
  let meta = {};
  try { meta = JSON.parse(kvGet('sb:meta:' + sid) || '{}'); } catch { /* ignore */ }
  if (meta && meta.shareCode) { try { kvDelete('sb:code:' + shareHash(meta.shareCode)); } catch { /* ignore */ } }
  kvDelete('sb:bank:' + sid);
  kvDelete('sb:meta:' + sid);
  return { id: sid };
}
