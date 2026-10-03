// One no-op identity test. This protocol never grants approver authority.
export const IDENTITY_PREFIX = 'report-identity-challenge:';
export const IDENTITY_SEED_PREFIX = 'report-identity-seed:';
export const CONFIGURED_REPORT_CHAT = 'configured-report-chat';
const idPattern = /^[a-f0-9]{32}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const noncePattern = /^[A-Za-z0-9_-]{22}$/;
const codePattern = /^[A-F0-9]{4}-[A-F0-9]{4}$/;
const maxLifetime = 10 * 60 * 1000;
const codeLifetime = 2 * 60 * 1000;
const encoder = new TextEncoder();
export const randomHex = bytes => [...crypto.getRandomValues(new Uint8Array(bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
export const randomNonce = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
export async function identityHash(value) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))].map(n => n.toString(16).padStart(2, '0')).join(''); }
export async function identityBoundedJson(message, maximum=4096) {
  const reader=message.body?.getReader();if(!reader)throw Error('IDENTITY_INPUT');
  const chunks=[];let total=0;
  try {
    while(true){const {done,value}=await reader.read();if(done)break;
      if(!value || total+value.byteLength>maximum){void reader.cancel().catch(()=>{});throw Error('IDENTITY_INPUT');}
      total+=value.byteLength;chunks.push(value);
    }
  }finally{reader.releaseLock();}
  const bytes=new Uint8Array(total);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
}
function equalHash(a, b) { if (!hashPattern.test(a || '') || !hashPattern.test(b || '')) return false; let diff = 0; for (let i = 0; i < 64; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i); return diff === 0; }
const numeric = value => /^-?[1-9][0-9]{0,15}$/.test(String(value)) && Number.isSafeInteger(Number(value));
export function validIdentitySeed(seed, id, chat, now = Date.now()) {
  return seed?.schema === 1 && Object.keys(seed).sort().join(',') === 'capHash,challengeId,chatId,createdAt,expiresAt,nonce,schema' && idPattern.test(id) && seed.challengeId === id && hashPattern.test(seed.capHash || '') && noncePattern.test(seed.nonce || '') && numeric(chat) && String(seed.chatId) === String(chat) && Number.isSafeInteger(seed.createdAt) && seed.createdAt <= now && Number.isSafeInteger(seed.expiresAt) && seed.expiresAt > now && seed.expiresAt > seed.createdAt && seed.expiresAt - seed.createdAt <= maxLifetime;
}
function publicStatus(row) {
  if (!row) return {state:'missing'};
  const result = {challengeId:row.challengeId, state:row.state, expiresAt:row.expiresAt};
  if (row.state === 'confirmed') result.receipt = {schema:1, purpose:'telegram-noop-identity', challengeId:row.challengeId, telegramUserId:row.candidateId, chatId:row.chatId, messageId:row.messageId, confirmedAt:row.confirmedAt, authorityGranted:false};
  return result;
}

// All changes below are synchronous SQLite CAS inside one named DO. No Report
// table, operation, release head, gate, PR, provider deployment or allowlist is used.
export class IdentityChallengeLedger {
  constructor(storage) {
    this.sql = storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS report_identity_challenge (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
  }
  read(id) { const row = [...this.sql.exec('SELECT value FROM report_identity_challenge WHERE id = ?', id)][0]; return row ? JSON.parse(row.value) : null; }
  save(row, expected) {
    if (!expected) return this.sql.exec('INSERT OR IGNORE INTO report_identity_challenge (id,value) VALUES (?,?)', row.challengeId, JSON.stringify(row)).rowsWritten === 1;
    return this.sql.exec('UPDATE report_identity_challenge SET value = ? WHERE id = ? AND value = ?', JSON.stringify(row), row.challengeId, JSON.stringify(expected)).rowsWritten === 1;
  }
  execute(id, command, input = {}) {
    if (!idPattern.test(id)) throw Error('IDENTITY_ID_INVALID');
    const now = Date.now();
    let row = this.read(id);
    if (row && row.expiresAt <= now) {
      this.erase(id);
      row = this.read(id);
    }
    if (command === 'prepare') {
      if (!validIdentitySeed(input.seed, id, input.seed?.chatId, now)) throw Error('IDENTITY_SEED_INVALID');
      if (!row) { const seed = input.seed; this.save({...seed, state:'prepared'}, null); row = this.read(id); }
      // A rotated seed or stale KV read cannot reset a consumed challenge.
      return equalHash(row.capHash, input.seed.capHash) && row.nonce === input.seed.nonce && row.chatId === input.seed.chatId && row.createdAt === input.seed.createdAt && row.expiresAt === input.seed.expiresAt ? publicStatus(row) : {state:'denied'};
    }
    if (!row) return {state:'missing'};
    if (command === 'click') {
      if (row.state !== 'armed' || !noncePattern.test(input.nonce || '') || row.nonce !== input.nonce || !numeric(input.fromId) || Number(input.fromId) <= 0 || input.isBot !== false || !Number.isSafeInteger(input.messageId) || row.messageId !== input.messageId || String(row.chatId) !== String(input.chatId) || row.botId !== input.botId || !hashPattern.test(input.codeHash || '') || typeof input.queryId !== 'string' || !input.queryId || input.queryId.length > 256) return {accepted:false};
      const next = {...row, state:'answering', candidateId:String(input.fromId), queryId:input.queryId, codeHash:input.codeHash, codeExpiresAt:Math.min(row.expiresAt, now + codeLifetime), attempts:0};
      return {accepted:this.save(next, row)};
    }
    if (command === 'answer') {
      if (row.state !== 'answering' || row.queryId !== input.queryId) return {accepted:false};
      return {accepted:this.save({...row, state:input.ok === true ? 'awaiting_confirmation' : 'answer_unknown'}, row)};
    }
    if (!equalHash(row.capHash, input.capHash)) return {state:'denied'};
    if (command === 'status') return publicStatus(row);
    if (command === 'confirm') {
      if (row.state === 'confirmed') return equalHash(row.codeHash, input.codeHash) ? publicStatus(row) : {state:'denied'};
      if (row.state !== 'awaiting_confirmation' || row.codeExpiresAt <= now || row.attempts >= 3) return {state:'denied'};
      if (!equalHash(row.codeHash, input.codeHash)) { this.save({...row, attempts:row.attempts + 1, state:row.attempts + 1 >= 3 ? 'confirmation_locked' : row.state}, row); return {state:'denied'}; }
      const next = {...row, state:'confirmed', confirmedAt:now};
      return this.save(next, row) ? publicStatus(next) : {state:'denied'};
    }
    const steps = {
      beginSend:['prepared','sending'],
      sendUnknown:['sending','send_unknown'],
      bind:['sending','bound'],
      beginExpose:['bound','exposing'],
      expose:['exposing','armed'],
      exposeUnknown:['exposing','visibility_unknown']
    };
    const step = steps[command];
    if (!step || row.state !== step[0]) return {accepted:false, ...publicStatus(row)};
    let next = {...row, state:step[1]};
    if (command === 'bind') {
      if (!Number.isSafeInteger(input.messageId) || input.messageId <= 0 || !numeric(input.botId) || Number(input.botId) <= 0 || String(input.chatId) !== String(row.chatId)) return {accepted:false};
      next = {...next, messageId:input.messageId, botId:String(input.botId)};
    }
    return {accepted:this.save(next, row), ...publicStatus(next)};
  }
  erase(id) {
    const row = this.read(id);
    if (row) this.save({challengeId:id, expiresAt:row.expiresAt, state:'expired'}, row);
  }
}

function challengeStub(env, id) { return env.REPORT_OPERATIONS.getByName(IDENTITY_PREFIX + id); }
async function telegram(env, method, body) {
  try {
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body), signal:AbortSignal.timeout(10000)});
    if (!response.ok) return null;
    const result = await response.json(); return result?.ok === true ? result.result : null;
  } catch { return null; } // Never log URLs, tokens, codes, capabilities, or updates.
}
async function startChallenge(env, id, seed, capHash) {
  const stub = challengeStub(env, id), call = (command, input={}) => stub.identityChallenge(id, command, {capHash, ...input});
  const prepared=await call('prepare', {seed});
  if(prepared.state==='denied')return prepared;
  if (!(await call('beginSend')).accepted) return call('status');
  // Persist "sending" BEFORE provider I/O. Unknown/crash outcomes cannot resend.
  const message = await telegram(env, 'sendMessage', {chat_id:seed.chatId, text:'TEST · 无改题身份测试。此消息不会审批 Report、修改题库或发布。按钮点击者仅为候选；需在当前可信会话回传私有码才能确认身份。'});
  if (!message || message.from?.is_bot !== true || !(await call('bind', {messageId:message.message_id, chatId:message.chat?.id, botId:String(message.from?.id)})).accepted) { await call('sendUnknown'); return call('status'); }
  if (!(await call('beginExpose')).accepted) return call('status');
  const edited = await telegram(env, 'editMessageReplyMarkup', {chat_id:seed.chatId, message_id:message.message_id, reply_markup:{inline_keyboard:[[{text:'TEST：确认我的 Telegram 身份', callback_data:`ti:${id}:${seed.nonce}`}]]}});
  // editMessageReplyMarkup for a non-inline message must return that exact Message.
  const exact = edited?.message_id === message.message_id && String(edited?.chat?.id) === String(seed.chatId) && edited?.from?.is_bot === true && String(edited?.from?.id) === String(message.from.id);
  await call(exact ? 'expose' : 'exposeUnknown');
  return call('status');
}
export async function identityChallengeCallback(env, callback) {
  const match = typeof callback.data === 'string' && callback.data.match(/^ti:([a-f0-9]{32}):([A-Za-z0-9_-]{22})$/);
  if (!match || !env.REPORT_OPERATIONS || !env.TELEGRAM_BOT_TOKEN || callback.inline_message_id || callback.message?.from?.is_bot !== true || callback.message?.forward_origin || callback.message?.forward_date) return;
  const [, id, nonce] = match, stub = challengeStub(env, id);
  const value = randomHex(4).toUpperCase(), code = value.slice(0,4) + '-' + value.slice(4);
  const claimed = await stub.identityChallenge(id, 'click', {nonce, fromId:callback.from?.id, isBot:callback.from?.is_bot, messageId:callback.message?.message_id, chatId:callback.message?.chat?.id, botId:String(callback.message?.from?.id), queryId:callback.id, codeHash:await identityHash(code)});
  if (!claimed.accepted) return;
  const ok = await telegram(env, 'answerCallbackQuery', {callback_query_id:callback.id, text:`TEST 私有码：${code}\n两分钟内在发起测试的当前可信会话回传此码。点击本身不会授予审批权。`, show_alert:true, cache_time:0});
  await stub.identityChallenge(id, 'answer', {queryId:callback.id, ok:ok === true});
}
function reply(body, status=200) { return Response.json(body, {status, headers:{'cache-control':'no-store'}}); }
export async function identityChallengeRequest({request, env}) {
  const capability=request.headers.get('authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if(!capability){void request.body?.cancel().catch(()=>{});return reply({error:'IDENTITY_DENIED'},403);}
  // Disabled without a short-lived seed written by the existing trusted owner.
  // The seed holds a capability HASH only, never its bearer value.
  if (!env.REPORT_OPERATIONS || !env.EDITS || !env.TELEGRAM_BOT_TOKEN || !numeric(env.TELEGRAM_CHAT_ID)) return reply({error:'IDENTITY_DISABLED'}, 503);
  try {
    let body;try{body=await identityBoundedJson(request);}catch{return reply({error:'IDENTITY_INPUT'},400);}
    if (!body || !['start','status','confirm'].includes(body.action) || !idPattern.test(body.challengeId || '') || Object.keys(body).some(k => !['action','challengeId','code'].includes(k)) || (body.action === 'confirm' ? !codePattern.test(body.code || '') : 'code' in body)) return reply({error:'IDENTITY_INPUT'}, 400);
    const storedSeed = await env.EDITS.get(IDENTITY_SEED_PREFIX + body.challengeId, 'json');
    // The fixed owner tool never reads the encrypted chat value. Only this
    // existing runtime resolves the one permitted selector to its Report chat.
    const seed = storedSeed?.chatId===CONFIGURED_REPORT_CHAT ? {...storedSeed,chatId:String(env.TELEGRAM_CHAT_ID)} : storedSeed;
    const capHash = await identityHash(capability);
    if (!validIdentitySeed(seed, body.challengeId, env.TELEGRAM_CHAT_ID) || !equalHash(seed.capHash, capHash)) return reply({error:'IDENTITY_DENIED'}, 403);
    let result;
    if (body.action === 'start') result = await startChallenge(env, body.challengeId, seed, capHash);
    else result = await challengeStub(env, body.challengeId).identityChallenge(body.challengeId, body.action, {capHash, ...(body.action === 'confirm' ? {codeHash:await identityHash(body.code)} : {})});
    return reply(result, ['denied','missing'].includes(result.state) ? 403 : 200);
  } catch { return reply({error:'IDENTITY_UNCERTAIN_STOP'}, 503); }
}
