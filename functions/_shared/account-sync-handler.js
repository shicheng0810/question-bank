import { loadVerifiedAccountIdentity, guardAccountSyncRate, decodeAccountRpcOutcome, disposeAccountRpcOutcome } from './account-session-handler.js';
import { validatePushRequest, validatePullRequest, validatePushResponse, validatePullResponse } from '../../src/domain/app-data/sync-wire.js';

const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers });
const fail = (error, status) => json({ ok: false, error }, status);
import {validateResumeCapabilities} from '../../src/browser/resume-capabilities.js';
const AUTH = new Set(['INVALID_CREDENTIALS', 'STALE_AUTHORITY', 'ACCOUNT_DELETED', 'STALE_GENERATION', 'NOT_INITIALIZED']);
async function body(request) {
  if (request.headers.has('Content-Encoding')) throw Object.assign(new Error('INVALID_REQUEST'), { status: 415 });
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('Content-Type') || '')) throw Object.assign(new Error('INVALID_REQUEST'), { status: 415 });
  if (!request.body) throw Object.assign(new Error('INVALID_REQUEST'), { status: 422 });
  const reader = request.body.getReader();
  let size = 0; const chunks = [];
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength;
      if (size > 256 * 1024) { await reader.cancel(); throw Object.assign(new Error('BODY_TOO_LARGE'), { status: 413 }); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw Object.assign(new Error('INVALID_REQUEST'), { status: 422 }); }
}

export async function handleAccountSync({ request, env }, kind) {
  // Default-off is checked before request parsing or any storage access.
  if (env?.GEN06_SYNC_HTTP !== '1' || env?.GEN05_ACCOUNT_HTTP !== '1' || env?.GEN05_ACCOUNT_API !== '1') return fail('NOT_FOUND', 404);
  const method = kind === 'push' ? 'POST' : 'GET';
  if (request.method !== method) return fail('METHOD_NOT_ALLOWED', 405);
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  // Browsers do not normally send Origin on same-origin GET. Cross-origin
  // Origin is rejected; POST continues to require explicit same-origin.
  if (!accountOriginAllowed(request, env, kind !== 'push')) return fail('ORIGIN_NOT_ALLOWED', 403);
  try {
    let input;
    if (kind === 'push') {
      if (url.search) return fail('INVALID_REQUEST', 422);
      input = validatePushRequest(await body(request));
    } else if(kind==='capabilities'){
      if(url.search||request.body)return fail('INVALID_REQUEST',422);
    } else {
      const reader=request.headers.get('X-QB-Resume-Reader');
      if(reader!==null&&!['1','2'].includes(reader))return fail('INVALID_REQUEST',422);
      const keys = [...url.searchParams.keys()];
      if (keys.some(k => !['after', 'until', 'limit'].includes(k)) || new Set(keys).size !== keys.length) return fail('INVALID_REQUEST', 422);
      const limit = url.searchParams.get('limit') || '200';
      if (!/^[1-9][0-9]{0,2}$/.test(limit)) return fail('INVALID_REQUEST', 422);
      input = validatePullRequest({ protocolVersion: 2, after: url.searchParams.get('after'), ...(url.searchParams.has('until') ? { until: url.searchParams.get('until') } : {}), limit: Number(limit) });
    }
    const rateFailure = await guardAccountSyncRate(request, env);
    if (rateFailure) return rateFailure;
    const identity = await loadVerifiedAccountIdentity(request, env);
    if (kind === 'push' && input.accountGeneration !== identity.generation) return fail('STALE_GENERATION', 410);
    if(kind==='pull'&&env.GEN06_RESUME_V2_READ_GUARD==='1'&&request.headers.get('X-QB-Resume-Reader')!=='2')return fail('CLIENT_UPGRADE_REQUIRED',409);
    const stub = env.GENERATION_STORE.getByName(identity.incarnation);
    let result, outcome;
    try {
      outcome = kind==='capabilities'?await stub.syncCapabilitiesTrusted(identity):kind==='push'?await stub.pushTrusted(identity,input):await stub.pullTrusted(identity,input,request.headers.get('X-QB-Resume-Reader')==='2'?2:1);
      result = decodeAccountRpcOutcome(outcome, ['ok', 'response']);
      if (result.ok) result.response = structuredClone(result.response);
    } finally { await disposeAccountRpcOutcome(outcome); try { stub[Symbol.dispose]?.(); } catch {} }
    if (!result?.ok) {
      if (result?.error === 'INVALID_SYNC_INPUT') return fail('INVALID_REQUEST', 422);
      if (result?.error === 'CURSOR_UNAVAILABLE') return fail('CURSOR_UNAVAILABLE', 409); // no fabricated export/reset capability
      if (result?.error === 'CLIENT_UPGRADE_REQUIRED') return fail('CLIENT_UPGRADE_REQUIRED',409);
      if (result?.error === 'SNAPSHOT_BASELINE_DISABLED') return fail('SNAPSHOT_BASELINE_DISABLED',409);
      if (result?.error === 'QUOTA_EXCEEDED') return fail('QUOTA_EXCEEDED', 507);
      if (result?.error === 'CONTENT_CONFLICT') return fail('CONTENT_CONFLICT', 409);
      if (result?.error === 'INVALID_CONTENT_INPUT') return fail('INVALID_CONTENT_INPUT', 422);
      if (result?.error === 'CONTENT_VALIDATION_UNAVAILABLE') return fail('CONTENT_VALIDATION_UNAVAILABLE', 503);
      if (AUTH.has(result?.error)) return fail(result.error, 410);
      return fail('UNAVAILABLE', 503);
    }
    if(kind==='capabilities')return json(validateResumeCapabilities(result.response));
    const response = (kind === 'push' ? validatePushResponse : validatePullResponse)(result.response);
    if (response.generation !== identity.generation) return fail('UNAVAILABLE', 503);
    return json(response);
  } catch (error) {
    if (error.status) return fail(error.message, error.status);
    if (error.name === 'AppDataValidationError') return fail('INVALID_REQUEST', 422);
    if (AUTH.has(error.message)) return fail('AUTH_FAILED', 401);
    return fail('UNAVAILABLE', 503);
  }
}
import { accountOriginAllowed } from './account-http-origin.js';
