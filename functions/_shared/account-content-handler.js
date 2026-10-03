import { guardAccountSyncRate, loadVerifiedAccountIdentity, decodeAccountRpcOutcome, disposeAccountRpcOutcome } from './account-session-handler.js';
import { validateChunkManifest } from '../../src/domain/app-data/content-records.js';

const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });
const fail = (error, status) => json({ ok: false, error }, status);
async function bytes(request, limit) {
  if (request.headers.has('Content-Encoding')) throw Object.assign(new Error('INVALID_REQUEST'), { status: 415 });
  if (!request.body) throw Object.assign(new Error('INVALID_REQUEST'), { status: 422 });
  const reader = request.body.getReader(); const chunks = []; let length = 0;
  try { for (;;) { const result = await reader.read(); if (result.done) break; length += result.value.length; if (length > limit) { await reader.cancel(); throw Object.assign(new Error('BODY_TOO_LARGE'), { status: 413 }); } chunks.push(result.value); } }
  finally { reader.releaseLock(); }
  const output = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return output;
}
const statusFor = error => ({ INVALID_CONTENT_INPUT: 422, CONTENT_CONFLICT: 409, MISSING_DEPENDENCY: 409, QUOTA_EXCEEDED: 507, ACCOUNT_DELETED: 410, STALE_GENERATION: 410, INVALID_CREDENTIALS: 401 })[error] || 503;

export async function handleAccountContent({ request, env }, kind) {
  if (env?.GEN06_SYNC_HTTP !== '1' || env?.GEN05_ACCOUNT_HTTP !== '1' || env?.GEN05_ACCOUNT_API !== '1') return fail('NOT_FOUND', 404);
  if (!(kind === 'manifest' ? ['POST', 'GET'].includes(request.method) : ['PUT', 'GET'].includes(request.method))) return fail('METHOD_NOT_ALLOWED', 405);
  const url = new URL(request.url); const origin = request.headers.get('Origin');
  if (!accountOriginAllowed(request, env, request.method === 'GET')) return fail('ORIGIN_NOT_ALLOWED', 403);
  try {
    let input;
    if (kind === 'manifest' && request.method === 'GET') {
      const keys = [...url.searchParams.keys()]; const contentDigest = url.searchParams.get('contentDigest');
      if (keys.length !== 1 || keys[0] !== 'contentDigest' || !/^[0-9a-f]{64}$/.test(contentDigest || '')) return fail('INVALID_REQUEST', 422);
      input = { contentDigest };
    } else if (kind === 'manifest') {
      if (url.search || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('Content-Type') || '')) return fail('INVALID_REQUEST', 415);
      const raw = await bytes(request, 128 * 1024);
      try { input = validateChunkManifest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))); }
      catch { return fail('INVALID_REQUEST', 422); }
    } else {
      const keys = [...url.searchParams.keys()];
      const contentDigest = url.searchParams.get('contentDigest'); const index = url.searchParams.get('chunkIndex');
      if (keys.length !== 2 || new Set(keys).size !== 2 || keys.some(k => !['contentDigest', 'chunkIndex'].includes(k)) || !/^[0-9a-f]{64}$/.test(contentDigest || '') || !/^(0|[1-9][0-9]{0,2})$/.test(index || '') || Number(index) >= 200) return fail('INVALID_REQUEST', 422);
      input = { contentDigest, chunkIndex: Number(index) };
      if (request.method === 'PUT') {
        if (request.headers.get('Content-Type') !== 'application/octet-stream') return fail('INVALID_REQUEST', 415);
        input.bytes = await bytes(request, 512 * 1024);
      }
    }
    const rateFailure = await guardAccountSyncRate(request, env); if (rateFailure) return rateFailure;
    const identity = await loadVerifiedAccountIdentity(request, env);
    const stub = env.GENERATION_STORE.getByName(identity.incarnation);
    let result, outcome;
    try {
      outcome = await stub[kind === 'manifest' ? request.method === 'GET' ? 'readManifestTrusted' : 'publishContentTrusted' : request.method === 'PUT' ? 'putChunkTrusted' : 'readChunkTrusted'](identity, input);
      result = decodeAccountRpcOutcome(outcome, kind === 'manifest' ? request.method === 'GET' ? ['ok', 'manifestDigest', 'manifest'] : ['ok', 'manifestDigest', 'status'] : request.method === 'GET' ? ['ok', 'byteLength', 'digest', 'bytes'] : ['ok', 'status']);
      if (result.ok && result.manifest) result.manifest = structuredClone(result.manifest);
      if (result.ok && result.bytes) result.bytes = new Uint8Array(result.bytes);
    } finally { await disposeAccountRpcOutcome(outcome); try { stub[Symbol.dispose]?.(); } catch {} }
    if (!result?.ok) return fail(result?.error || 'UNAVAILABLE', statusFor(result?.error));
    if (kind === 'manifest' && request.method === 'GET') { validateChunkManifest(result.manifest); return json(result); }
    if (request.method === 'GET') {
      if (!(result.bytes instanceof Uint8Array) || result.bytes.length !== result.byteLength || result.bytes.length > 512 * 1024) return fail('UNAVAILABLE', 503);
      return new Response(result.bytes, { headers: { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': String(result.bytes.length), 'X-Content-SHA256': result.digest } });
    }
    if (!['accepted', 'duplicate'].includes(result.status)) return fail('UNAVAILABLE', 503);
    return json({ ok: true, status: result.status, ...(kind === 'manifest' ? { manifestDigest: result.manifestDigest } : {}) });
  } catch (error) {
    if (error.status) return fail(error.message, error.status);
    if (error.name === 'AppDataValidationError' || error instanceof SyntaxError) return fail('INVALID_REQUEST', 422);
    if (['INVALID_CREDENTIALS', 'STALE_AUTHORITY', 'ACCOUNT_DELETED', 'STALE_GENERATION', 'NOT_INITIALIZED'].includes(error.message)) return fail('AUTH_FAILED', 401);
    return fail('UNAVAILABLE', 503);
  }
}
import { accountOriginAllowed } from './account-http-origin.js';
