import { accountOriginAllowed } from './account-http-origin.js';
import { guardAccountExportIpRate, loadVerifiedAccountIdentity, decodeAccountRpcOutcome, disposeAccountRpcOutcome } from './account-session-handler.js';
import { validateExportManifest } from '../../src/domain/app-data/export-manifest.js';
import { validateCloudCheckpoint } from '../../do-worker/src/account-cloud-checkpoint.js';
import { CLOUD_EXPORT_SECTIONS } from '../../do-worker/src/account-export-repository.js';
import { validateCursorReset } from '../../src/domain/app-data/auth-recovery.js';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX = /^[0-9a-f]{64}$/;
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });
const fail = (error, status) => json({ ok: false, error }, status);
const methodFor = { start: 'POST', reset: 'POST', page: 'GET', chunk: 'GET' };
const rpcFor = { start: 'startExportTrusted', reset: 'resetExportTrusted', page: 'readExportPageTrusted', chunk: 'readExportChunkTrusted' };
const fieldsFor = { start: ['ok', 'exportId', 'manifest', 'manifestDigest', 'expiresAt', 'checkpoint', 'checkpointDigest'], reset: ['ok', 'reset'], page: ['ok', 'exportId', 'section', 'records', 'next', 'hasMore', 'exportCut'], chunk: ['ok', 'byteLength', 'digest', 'bytes'] };
export async function handleAccountExport({ request, env }, kind) {
  if (env?.GEN06_CLOUD_EXPORT_HTTP !== '1' || env?.GEN06_SYNC_HTTP !== '1' || env?.GEN05_ACCOUNT_HTTP !== '1' || env?.GEN05_ACCOUNT_API !== '1') return fail('NOT_FOUND', 404);
  if (!methodFor[kind] || request.method !== methodFor[kind]) return fail('METHOD_NOT_ALLOWED', 405);
  if (!accountOriginAllowed(request, env, request.method === 'GET')) return fail('ORIGIN_NOT_ALLOWED', 403);
  try {
    const url = new URL(request.url); let input;
    if (request.method === 'POST') {
      if (url.search || request.headers.has('Content-Encoding') || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('Content-Type') || '')) return fail('INVALID_REQUEST', 415);
      if (!request.body) return fail('INVALID_REQUEST', 422);
      const reader = request.body.getReader(); const parts = []; let length = 0;
      try { for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > 2048) { await reader.cancel(); return fail('BODY_TOO_LARGE', 413); } parts.push(part.value); } } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(length); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length; }
      try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return fail('INVALID_REQUEST', 422); }
      if (!input || Object.getPrototypeOf(input) !== Object.prototype || Object.keys(input).sort().join(',') !== (kind === 'start' ? '' : 'exportId') || (kind === 'reset' && !UUID.test(input.exportId))) return fail('INVALID_REQUEST', 422);
    } else {
      const keys = [...url.searchParams.keys()]; const expected = kind === 'page' ? ['exportId', 'section', 'after', 'limit'] : ['exportId', 'contentDigest', 'chunkIndex'];
      if (keys.length !== expected.length || new Set(keys).size !== keys.length || keys.some(key => !expected.includes(key))) return fail('INVALID_REQUEST', 422);
      input = Object.fromEntries(url.searchParams); if (!UUID.test(input.exportId)) return fail('INVALID_REQUEST', 422);
      if (kind === 'page') {
        if (!CLOUD_EXPORT_SECTIONS.includes(input.section) || !/^(0|[1-9][0-9]{0,19})$/.test(input.after) || !/^(?:[1-9]|[1-9][0-9]|100)$/.test(input.limit)) return fail('INVALID_REQUEST', 422);
        input.limit = Number(input.limit);
      } else {
        if (!HEX.test(input.contentDigest) || !/^(0|[1-9][0-9]{0,2})$/.test(input.chunkIndex) || Number(input.chunkIndex) >= 200) return fail('INVALID_REQUEST', 422);
        input.chunkIndex = Number(input.chunkIndex);
      }
    }
    const rateFailure = await guardAccountExportIpRate(request, env); if (rateFailure) return rateFailure;
    const identity = await loadVerifiedAccountIdentity(request, env), stub = env.GENERATION_STORE.getByName(identity.incarnation);
    let outcome, result;
    try {
      let rateOutcome, rate;
      try { rateOutcome = await stub.consumeExportRateTrusted(identity); rate = structuredClone(decodeAccountRpcOutcome(rateOutcome, ['ok', 'allowed', 'retryAfter'])); }
      finally { await disposeAccountRpcOutcome(rateOutcome); }
      if (!rate.ok) return fail(rate.error, 503);
      if (typeof rate.allowed !== 'boolean' || !Number.isSafeInteger(rate.retryAfter) || rate.retryAfter < 1 || rate.retryAfter > 60) return fail('UNAVAILABLE', 503);
      if (!rate.allowed) return new Response(JSON.stringify({ ok: false, error: 'RATE_LIMITED' }), { status: 429, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': String(rate.retryAfter) } });
      outcome = await stub[rpcFor[kind]](identity, input); result = structuredClone(decodeAccountRpcOutcome(outcome, fieldsFor[kind]));
    }
    finally { await disposeAccountRpcOutcome(outcome); try { stub[Symbol.dispose]?.(); } catch {} }
    if (!result.ok) return fail(result.error, ({ INVALID_EXPORT_INPUT: 422, EXPORT_INCOMPLETE: 409, EXPORT_LIMIT: 429, EXPORT_UNAVAILABLE: 404, EXPORT_NOT_READY: 409, EXPORT_CONFLICT: 409, QUOTA_EXCEEDED: 507, EXPORT_METADATA_QUOTA: 507 })[result.error] || 503);
    if (kind === 'start') {
      validateExportManifest(result.manifest); validateCloudCheckpoint(result.checkpoint);
      if (!HEX.test(result.manifestDigest) || !HEX.test(result.checkpointDigest) || result.manifest.accountGeneration !== identity.generation || result.checkpoint.generation !== identity.generation || result.checkpoint.exportId !== result.exportId || result.checkpoint.expiresAt !== result.expiresAt || result.checkpoint.cut !== result.manifest.exportCut || result.checkpoint.logEpoch !== result.manifest.serverLogEpoch) return fail('UNAVAILABLE', 503);
    }
    if (kind === 'reset') {
      validateCursorReset(result.reset);
      if (result.reset.generation !== identity.generation || result.reset.resetExportId !== input.exportId || result.reset.pageUrl !== '/api/v2/export/page' || result.reset.expiresAt <= Date.now()) return fail('UNAVAILABLE', 503);
    }
    if (kind === 'chunk') {
      if (!(result.bytes instanceof Uint8Array) || result.bytes.length !== result.byteLength || result.bytes.length > 512 * 1024 || !HEX.test(result.digest)) return fail('UNAVAILABLE', 503);
      return new Response(result.bytes, { headers: { ...headers, 'Content-Type': 'application/octet-stream', 'X-Content-SHA256': result.digest } });
    }
    return json(result);
  } catch (error) {
    if (['INVALID_CREDENTIALS', 'STALE_AUTHORITY', 'ACCOUNT_DELETED', 'STALE_GENERATION', 'NOT_INITIALIZED'].includes(error.message)) return fail('AUTH_FAILED', 401);
    return fail('UNAVAILABLE', 503);
  }
}
