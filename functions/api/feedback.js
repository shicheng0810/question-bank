// Cloudflare Pages Function —— 访客反馈接收端点 /api/feedback
// 放在仓库根 functions/ 下，和 docs/ 平级；`wrangler pages deploy docs` 会自动随之上线
// （functions/ 相对 CWD 解析，不在 docs/ 里，build-pages 的 rmSync 碰不到它）。
//
// 反馈 → ①先落 KV 留存 ②再转发到站主 Telegram。防滥用：蜜罐 + 字段长度上限 +（可选）Turnstile
// +（可选）KV 限流。
//
// 为什么要落库（2026-08-20 补）：以前反馈**只**转发 Telegram、不留存，聊天里翻不到就永久丢失。
// 实际就踩了一次——要回看最近几条建议时，除了翻聊天没有任何办法。现在每条先写 KV（fb: 前缀，
// 180 天 TTL），再发 Telegram；即使 Telegram 送不达也不会丢内容（读取：npm run feedback:read）。
// 需要的 Secret（wrangler pages secret put ...）：
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
// 可选：TURNSTILE_SECRET_KEY（配了才校验验证码）、KV binding `RL`（绑了才限流）
//
// GitHub Pages 镜像没有 Functions：镜像站前端用绝对 URL 打到本端点，这里开了 CORS 放行该来源。

import { receiveNativeReport } from '../_shared/native-report-receiver.js';
import { boundedJson } from '../_shared/native-report-publisher.js';

const ALLOW_ORIGINS = [
  'https://question-bank-78u.pages.dev',
  'https://shicheng0810.github.io',
];
const MAX = { type: 24, bankId: 80, qId: 80, page: 300, message: 2000, contact: 160, stem: 200, source: 160 };

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
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders(origin) },
  });
}
const clip = (v, n) => (typeof v === 'string' ? v : '').slice(0, n).trim();
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function onRequestOptions({ request }) {
  return new Response(null, { status: 204, headers: corsHeaders(request.headers.get('Origin') || '') });
}

export function onRequestGet({ request }) {
  // 健康检查：部署后浏览器访问 /api/feedback 应见此文本（而非 404/HTML）
  return new Response('feedback endpoint up', {
    headers: { 'content-type': 'text/plain; charset=utf-8', ...corsHeaders(request.headers.get('Origin') || '') },
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const origin = request.headers.get('Origin') || '';
  if(origin && !ALLOW_ORIGINS.includes(origin) && origin!==new URL(request.url).origin)return json({ok:false,error:'origin_denied'},403,origin);
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    return json({ ok: false, error: 'not_configured' }, 503, origin);
  }

  let body;
  try { body = await boundedJson(request,64*1024); } catch { return json({ ok: false, error: 'bad_json' }, 400, origin); }
  if(!body || typeof body!=='object' || Array.isArray(body))return json({ok:false,error:'bad_json'},400,origin);

  // 蜜罐：正常用户不会填这个隐藏字段，填了直接当成功丢弃（不告诉机器人被拦）
  if (clip(body.hp || body.website, 100)) return json({ ok: true, dropped: true }, 200, origin);

  // 可选 Turnstile（仅当配置了 secret 才强制）
  if (env.TURNSTILE_SECRET_KEY) {
    const token = clip(body['cf-turnstile-response'], 4096);
    if (!token) return json({ ok: false, error: 'captcha_missing' }, 400, origin);
    const v = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: env.TURNSTILE_SECRET_KEY, response: token, remoteip: ip }),
    }).then((r) => r.json()).catch(() => ({ success: false }));
    if (!v.success) return json({ ok: false, error: 'captcha_failed' }, 403, origin);
  }

  // 可选 KV 限流：每 IP 每分钟 ≤6 条（绑了 KV namespace `RL` 才生效）
  if (env.RL) {
    try {
      const key = `rl:${ip}:${Math.floor(Date.now() / 60000)}`;
      const n = parseInt((await env.RL.get(key)) || '0', 10);
      if (n >= 6) return json({ ok: false, error: 'rate_limited' }, 429, origin);
      await env.RL.put(key, String(n + 1), { expirationTtl: 120 });
    } catch (_e) { /* 限流失败不阻断正常反馈 */ }
  }

  const kind = clip(body.kind, MAX.type) || 'general_feedback';
  if (kind === 'question_edit') {
    try { return json(await receiveNativeReport(body,env),200,origin); }
    catch(error) {
      const code=error.code || 'REPORT_SAVE_FAILED';
      return json({ok:false,error:code},code.includes('CONFLICT') ? 409 : code.includes('CONFIGURED') || code.includes('CONFIGURATION') || code==='REPORT_SAVE_FAILED' ? 503 : 400,origin);
    }
  }
  const message = clip(body.message, MAX.message);
  if (message.length < 2 && kind !== 'question_edit') return json({ ok: false, error: 'empty' }, 400, origin);
  if (kind === 'question_edit' && !(Array.isArray(body.diff) && body.diff.length) && !clip(body.note, MAX.message)) return json({ ok: false, error: 'empty' }, 400, origin);

  const lines = [];
  if (kind === 'question_edit') {
    const fmt = (v) => Array.isArray(v)
      ? v.map((x) => (x && typeof x === 'object') ? JSON.stringify(x) : String(x)).join(' | ')
      : ((v && typeof v === 'object') ? JSON.stringify(v) : String(v == null ? '' : v));
    // 始终带上题干，站主审批时能直接核对（之前只发 diff，若只改答案就看不到是哪道题）。
    const stem = (body.original && body.original.question) || (body.corrected && body.corrected.question) || '';
    lines.push('✏️ <b>题目修正建议</b>');
    lines.push(`题库: <code>${esc(clip(body.bank_id, MAX.bankId))}</code>`);
    if (body.question_source) lines.push(`来源: ${esc(clip(body.question_source, MAX.source))}`);
    if (stem) lines.push(`题干: ${esc(clip(stem, MAX.stem))}`);
    const diff = Array.isArray(body.diff) ? body.diff : [];
    for (const d of diff.slice(0, 6)) {
      lines.push(`— <b>${esc(clip(d && d.field, 24))}</b>`);
      lines.push(`旧: ${esc(clip(fmt(d && d.from), 300))}`);
      lines.push(`新: ${esc(clip(fmt(d && d.to), 300))}`);
    }
    const note = clip(body.note, MAX.message);
    if (note) lines.push(`备注: ${esc(note)}`);
  } else {
    lines.push('💬 <b>用户建议</b>');
    lines.push(`题库: <code>${esc(clip(body.bank_id, MAX.bankId))}</code>`);
    lines.push(`内容: ${esc(message)}`);
    const contact = clip(body.reply_email || body.contact, MAX.contact);
    if (contact) lines.push(`回联: ${esc(contact)}`);
  }
  lines.push(`<i>${esc(clip(body.ui_lang, 8))} · ${esc(clip(body.page_url, MAX.page))}</i>`);

  // 题目修正：把"修正内容"暂存进 KV，并在消息上挂 [✅ 批准并开 PR] 按钮（短 id 放 callback_data，
  // 站主一点 → /api/tg-webhook 凭 id 取回 → 开 PR）。需 KV(env.EDITS)+GitHub token；缺则只发消息不挂按钮。
  let reply_markup;
  if (kind === 'question_edit' && env.EDITS && env.GITHUB_TOKEN
      && body.corrected && typeof body.corrected === 'object' && body.corrected.question) {
    const id = ((typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID().replace(/-/g, '')
      : String(Date.now()) + Math.random().toString(16).slice(2)).slice(0, 16);
    const pending = {
      bank_id: clip(body.bank_id, MAX.bankId),
      question_source: clip(body.question_source, MAX.source),
      question_index: body.question_index || null,
      original: (body.original && typeof body.original === 'object') ? body.original : null,
      corrected: body.corrected,
      note: clip(body.note, MAX.message),
      ts: Date.now(),
    };
    try {
      await env.EDITS.put('edit:' + id, JSON.stringify(pending), { expirationTtl: 14 * 24 * 3600 });
      reply_markup = { inline_keyboard: [[{ text: '✅ 批准并开 PR', callback_data: 'ap:' + id }]] };
    } catch (_e) { /* KV 写失败：消息照发、无按钮 */ }
  }

  // 先落库、再发 Telegram：顺序很重要 —— 发送失败时内容仍然留得住。
  // 写失败绝不阻断（反馈本身比留存重要），只在响应里带个 stored 标记便于排查绑定问题。
  let stored = false;
  if (env.EDITS) {
    try {
      const rnd = ((typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID().replace(/-/g, '') : Math.random().toString(16).slice(2)).slice(0, 8);
      // key 前缀带时间戳（十进制、定宽）→ KV 按 key 字典序列出时天然按时间排序，方便读最近 N 条
      const key = 'fb:' + String(Date.now()).padStart(14, '0') + '-' + rnd;
      await env.EDITS.put(key, JSON.stringify({
        kind,
        bank_id: clip(body.bank_id, MAX.bankId),
        question_source: clip(body.question_source, MAX.source),
        stem: clip((body.original && body.original.question) || (body.corrected && body.corrected.question) || '', MAX.stem),
        message,
        note: clip(body.note, MAX.message),
        diff: Array.isArray(body.diff) ? body.diff.slice(0, 6) : [],
        contact: clip(body.reply_email || body.contact, MAX.contact),
        ui_lang: clip(body.ui_lang, 8),
        page_url: clip(body.page_url, MAX.page),
        ts: Date.now(),
      }), { expirationTtl: 180 * 24 * 3600 });
      stored = true;
    } catch (_e) { /* 留存失败不阻断转发 */ }
  }

  const tgBody = { chat_id: env.TELEGRAM_CHAT_ID, text: lines.join('\n'), parse_mode: 'HTML', disable_web_page_preview: true };
  if (reply_markup) tgBody.reply_markup = reply_markup;
  const tg = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(tgBody),
  }).catch(() => null);

  // Telegram 可能 HTTP 200 但 body {ok:false}（parse_mode/实体错误等）——必须读 body 才算真送达
  let tgOk = false;
  if (tg && tg.ok) { try { const d = await tg.json(); tgOk = !!(d && d.ok); } catch (_e) { tgOk = false; } }
  // Telegram 没送达但已落库：不再算彻底失败（内容找得回来），但仍如实告知前端
  if (!tgOk) return json({ ok: false, error: 'delivery_failed', stored }, 502, origin);
  return json({ ok: true, stored }, 200, origin);
}
