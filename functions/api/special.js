import {validSharePointer,shareCodeHash,SHARE_TYPE} from '../../do-worker/src/generation-sharing.js';
import {decodeAccountRpcOutcome,disposeAccountRpcOutcome} from '../_shared/account-session-handler.js';
import {exactAdminRecord} from '../../do-worker/src/native-admin-items-dto.js';
// Cloudflare Pages Function —— /api/special：访客用「分享码」取一个特殊题库（公开、只读、不建账号、不记历史）。
// POST {code} → 命中则返回那一个特殊题库 {id,title,questions}；未命中 404。轻量限流防暴力猜码。
// 特殊题库由站主在本地 extractor 里创建（wrangler 写入），键：
//   sb:bank:<id>(题目)  sb:meta:<id>(元数据,含明文 shareCode 给站主看)  sb:code:<sha256(分享码)>→id(解析)
import { rateLimitOk } from '../_shared/auth.js';

const ALLOW_ORIGINS = [
  'https://question-bank-78u.pages.dev',
  'https://shicheng0810.github.io',
  'http://localhost:8799',
];
const RL_PER_MIN = 40; // 每 IP 每分钟最多 40 次（防暴力猜分享码）

function corsHeaders(origin) {
  const allow = ALLOW_ORIGINS.includes(origin) ? origin : ALLOW_ORIGINS[0];
  return {
    'access-control-allow-origin': allow,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
  };
}
function json(obj, status, origin) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders(origin) } });
}
async function sha256hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function onRequestOptions({ request }) {
  return new Response(null, { status: 204, headers: corsHeaders(request.headers.get('Origin') || '') });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const origin = request.headers.get('Origin') || '';
  if (!env.EDITS) return json({ ok: false, error: 'not_configured' }, 503, origin);

  // 原子限流（防暴力猜分享码）：每 IP 每分钟 ≤ RL_PER_MIN 次。RateLimiter DO，fail-open。
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (!(await rateLimitOk(env, 'special:' + ip, RL_PER_MIN, 60))) {
    return json({ ok: false, error: 'rate_limited' }, 429, origin);
  }

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'bad_json' }, 400, origin); }
  if(!exactAdminRecord(body,['code'])||typeof body.code!=='string')return json({ok:false,error:'bad_code'},400,origin);
  const code = body.code.trim();
  if (code.length < 6 || code.length > 80) return json({ ok: false, error: 'bad_code' }, 400, origin); // ≥6 抗暴力猜

  const id = await env.EDITS.get('sb:code:' + (await sha256hex('qbshare:v1:' + code)));
  if(id?.startsWith('{')){
    let pointer;try{pointer=JSON.parse(id);}catch{return json({ok:false,error:'share_unavailable'},503,origin);}
    if(!validSharePointer(pointer)||pointer.type!==SHARE_TYPE||pointer.codeHash!==await shareCodeHash(code))return json({ok:false,error:'share_unavailable'},503,origin);
    let raw,result;try{const stub=env.GENERATION_STORE.getByName(pointer.incarnation);raw=await stub.resolveAccountShareTrusted(pointer);result=decodeAccountRpcOutcome(raw,['ok','bank']);if(result.ok)result.bank=structuredClone(result.bank);}catch{return json({ok:false,error:'share_unavailable'},503,origin);}finally{await disposeAccountRpcOutcome(raw);}
    if(!result.ok)return json({ok:false,error:['SHARE_NOT_FOUND','STALE_AUTHORITY','STALE_GENERATION','ACCOUNT_DELETED'].includes(result.error)?'not_found':'share_unavailable'},['SHARE_NOT_FOUND','STALE_AUTHORITY','STALE_GENERATION','ACCOUNT_DELETED'].includes(result.error)?404:503,origin);
    const bank=result.bank;const response=json({ok:true,bank:{id:bank.id,title:bank.title,questions:bank.questions}},200,origin);response.headers.set('X-QB-Share-Bank-Uid',bank.bankUid);response.headers.set('X-QB-Share-Bank-Revision',bank.bankRevision);response.headers.set('Cache-Control','no-store');return response;
  }
  if (!id) return json({ ok: false, error: 'not_found' }, 404, origin);
  const raw = await env.EDITS.get('sb:bank:' + id);
  if (raw == null) return json({ ok: false, error: 'not_found' }, 404, origin);
  let questions = [];
  try { questions = JSON.parse(raw); } catch { questions = []; }
  let title = id;
  try { const m = JSON.parse((await env.EDITS.get('sb:meta:' + id)) || '{}'); if (m && m.title) title = m.title; } catch { /* ignore */ }
  return json({ ok: true, bank: { id, title, questions } }, 200, origin);
}
