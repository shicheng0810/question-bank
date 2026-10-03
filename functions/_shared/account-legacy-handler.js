import {
  decodeAccountRpcOutcome,
  disposeAccountRpcOutcome,
  guardAccountExportIpRate,
  loadVerifiedAccountIdentity,
} from './account-session-handler.js';
import { accountCorsResponse, accountOriginAllowed } from './account-http-origin.js';

const HEX64 = /^[0-9a-f]{64}$/;
const ID = value => typeof value === 'string' && value.length > 0 && value.length <= 64;
const BANK_ID = /^[a-z0-9_][a-z0-9_-]{0,47}$/;
const MAX_CURSOR = 2048;
const BASE_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { ...BASE_HEADERS, 'Content-Type': 'application/json; charset=utf-8' } });
}

function fail(error, status) { return json({ ok: false, error }, status); }

function internalStatus(error) {
  return ({
    INVALID_CREDENTIALS: 401, STALE_AUTHORITY: 401, ACCOUNT_DELETED: 410,
    STALE_GENERATION: 401, NOT_INITIALIZED: 401,
    MIGRATION_PENDING: 409, MIGRATION_UNCERTAIN: 409, MIGRATION_QUARANTINED: 409,
    INVALID_INPUT: 422, INVALID_REQUEST: 422,
  })[error] || 503;
}

function b64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function utf8(value) { return new TextEncoder().encode(value); }

function encodeCursor(identity, section, sourceDigest, afterId) {
  return b64url(utf8(JSON.stringify({ v: 1, p: identity.principal, i: identity.incarnation,
    g: identity.generation, s: section, d: sourceDigest, a: afterId })));
}

function decodeCursor(value, identity, section, sourceDigest) {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_CURSOR || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('INVALID_INPUT');
  let parsed;
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { throw new Error('INVALID_INPUT'); }
  if (!parsed || Object.getPrototypeOf(parsed) !== Object.prototype
    || Object.keys(parsed).sort().join(',') !== 'a,d,g,i,p,s,v'
    || parsed.v !== 1 || parsed.p !== identity.principal || parsed.i !== identity.incarnation
    || parsed.g !== identity.generation || parsed.s !== section || parsed.d !== sourceDigest
    || !ID(parsed.a)) throw new Error('INVALID_INPUT');
  return parsed.a;
}

async function call(stub, method, command, successKeys) {
  let outcome;
  try {
    if (!stub || typeof stub[method] !== 'function') throw new Error('UNAVAILABLE');
    outcome = await stub[method](...command);
    const keys = typeof successKeys === 'function' ? successKeys(outcome) : successKeys;
    return structuredClone(decodeAccountRpcOutcome(outcome, keys));
  } finally {
    await disposeAccountRpcOutcome(outcome);
  }
}

async function archiveBinding(context) {
  const { request, env } = context;
  if (env?.GEN05_ACCOUNT_HTTP !== '1' || env?.GEN05_ACCOUNT_API !== '1' || env?.GEN07_LEGACY_MIGRATION !== '1') return { response: fail('NOT_FOUND', 404) };
  if (request.method !== 'GET') return { response: fail('METHOD_NOT_ALLOWED', 405) };
  if (!accountOriginAllowed(request, env, true)) return { response: fail('ORIGIN_NOT_ALLOWED', 403) };
  const rateFailure = await guardAccountExportIpRate(request, env);
  if (rateFailure) return { response: accountCorsResponse(request, env, rateFailure) };
  const identity = await loadVerifiedAccountIdentity(request, env);
  const stub = env.GENERATION_STORE.getByName(identity.incarnation);
  const binding = { principal: identity.principal, incarnation: identity.incarnation };
  const outcome = await call(stub, 'legacyArchiveStatus', [binding, identity.generation], value => {
    if (!value || typeof value !== 'object' || typeof value.status !== 'string') throw new Error('UNAVAILABLE');
    return value.status === 'none' ? ['ok', 'status']
      : ['ok', 'status', 'phase', 'processed', 'total', 'historyDone', 'historyTotal', 'bankDone', 'bankTotal', 'historyCursor', 'bankCursor', 'receipt'];
  });
  if (!outcome.ok) throw new Error(outcome.error);
  return { env, request, identity, stub: env.GENERATION_STORE.getByName(identity.incarnation), binding, archive: outcome };
}

async function readPage(state, section, afterId, limit) {
  const outcome = await call(state.stub, 'legacyArchiveManifestPage', [state.binding, state.identity.generation, section, afterId, limit], ['ok', 'items', 'nextCursor']);
  if (!outcome.ok) throw new Error(outcome.error);
  if (!Array.isArray(outcome.items) || outcome.items.length > limit
    || !(outcome.nextCursor === null || ID(outcome.nextCursor))) throw new Error('UNAVAILABLE');
  return outcome;
}

async function findManifest(state, section, id) {
  const cursorProperty = section === 'history' ? 'historyCursor' : 'bankCursor';
  const endId = state.archive[cursorProperty];
  let afterId = null;
  for (let pageCount = 0; pageCount < 3; pageCount += 1) {
    const page = await readPage(state, section, afterId, 5);
    const found = page.items.find(item => item.id === id);
    if (found) return found;
    if (page.nextCursor === null) break;
    afterId = page.nextCursor;
    if (afterId === endId) break;
  }
  return null;
}

function rawResponse(bytes, headers, request, env) {
  const safeHeaders = { ...headers };
  if (typeof safeHeaders['X-Legacy-Source-Key'] === 'string') {
    safeHeaders['X-Legacy-Source-Key'] = encodeURIComponent(safeHeaders['X-Legacy-Source-Key']);
  }
  return accountCorsResponse(request, env, new Response(bytes, { headers: { ...BASE_HEADERS,
    'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(bytes.byteLength), ...safeHeaders } }));
}

function parseQuery(url, section) {
  const keys = [...url.searchParams.keys()];
  const isHistory = section === 'history';
  const detailKeys = isHistory ? ['id'] : ['id', 'part', ...(url.searchParams.has('chunkIndex') ? ['chunkIndex'] : [])];
  const listKeys = url.searchParams.has('cursor') ? ['limit', 'cursor'] : ['limit'];
  const detail = url.searchParams.has('id');
  const expected = detail ? detailKeys : listKeys;
  if (keys.length !== expected.length || new Set(keys).size !== keys.length || keys.some(key => !expected.includes(key))) throw new Error('INVALID_INPUT');
  const input = Object.fromEntries(url.searchParams);
  if (detail) {
    if (isHistory ? !ID(input.id) : !BANK_ID.test(input.id)) throw new Error('INVALID_INPUT');
    if (!isHistory) {
      if (!['meta', 'questions'].includes(input.part)
        || (input.part === 'meta' && 'chunkIndex' in input)
        || (input.part === 'questions' && (!/^(0|[1-9][0-9]{0,2})$/.test(input.chunkIndex || '') || Number(input.chunkIndex) > 7))) throw new Error('INVALID_INPUT');
    }
    return { detail: true, ...input, chunkIndex: input.chunkIndex === undefined ? 0 : Number(input.chunkIndex) };
  }
  if (input.limit !== undefined && !/^(?:[1-9]|[12][0-9])$/.test(input.limit)) throw new Error('INVALID_INPUT');
  const limit = input.limit === undefined ? 5 : Number(input.limit);
  if (limit > 20) throw new Error('INVALID_INPUT');
  if (input.cursor !== undefined && (input.cursor.length > MAX_CURSOR)) throw new Error('INVALID_INPUT');
  return { detail: false, limit, cursor: input.cursor || null };
}

function validDigest(value) { return typeof value === 'string' && HEX64.test(value); }

export async function handleAccountLegacy(context, section) {
  let state;
  try {
    state = await archiveBinding(context);
    if (state.response) return state.response;
    const { request, env, identity, archive } = state;
    const url = new URL(request.url);
    if (url.hash || url.username || url.password) return fail('INVALID_INPUT', 422);
    const input = parseQuery(url, section);
    const receipt = archive.receipt;
    const manifestDigest = receipt?.manifestSha256 || null;
    if (input.detail) {
      const item = await findManifest(state, section, input.id);
      if (!item) return fail('NOT_FOUND', 404);
      const part = section === 'history' ? 'record' : input.part;
      const sourceKey = section === 'history' ? `history:${input.id}` : `bank:${input.id}:${part}`;
      const expectedSha = section === 'history' ? item.sha256 : part === 'meta' ? item.metaSha256 : item.sha256;
      const expectedLength = section === 'history' ? item.byteLength : part === 'meta' ? item.metaByteLength : item.byteLength;
      const expectedCount = section === 'history' ? item.chunkCount : part === 'meta' ? 1 : item.chunkCount;
      const chunkCount = section === 'history' ? item.chunkCount : expectedCount;
      if (!validDigest(expectedSha) || !Number.isSafeInteger(expectedLength) || expectedLength < 1 || expectedLength > (section === 'history' ? 409600 : 1_900_000)) throw new Error('MIGRATION_QUARANTINED');
      if (section === 'history' && expectedLength > 409600) throw new Error('MIGRATION_QUARANTINED');
      const chunks = [];
      let total = 0;
      const firstIndex = section === 'banks' && part === 'questions' ? input.chunkIndex : 0;
      const lastIndex = section === 'banks' && part === 'questions' ? input.chunkIndex + 1 : chunkCount;
      for (let index = firstIndex; index < lastIndex; index += 1) {
        const chunk = await call(state.stub, 'legacyArchiveReadChunk', [state.binding, identity.generation, sourceKey, index], ['ok', 'found', 'sourceSha256', 'byteLength', 'chunkCount', 'chunkIndex', 'chunkSha256', 'bytes']);
        if (!chunk.ok) throw new Error(chunk.error);
        if (!chunk.found) return fail('NOT_FOUND', 404);
        if (!(chunk.bytes instanceof Uint8Array) || chunk.bytes.byteLength > 256 * 1024 || chunk.sourceSha256 !== expectedSha
          || chunk.byteLength !== expectedLength || chunk.chunkCount !== chunkCount || chunk.chunkIndex !== index
          || !validDigest(chunk.chunkSha256)) throw new Error('MIGRATION_QUARANTINED');
        const actualChunkSha = await digestHex(chunk.bytes);
        if (actualChunkSha !== chunk.chunkSha256) throw new Error('MIGRATION_QUARANTINED');
        chunks.push({ index, bytes: chunk.bytes, sha256: chunk.chunkSha256 });
        total += chunk.bytes.byteLength;
      }
      const headers = {
        'X-Legacy-Source-Key': sourceKey,
        'X-Legacy-Source-SHA256': expectedSha,
        'X-Legacy-Byte-Length': String(expectedLength),
      };
      if (section === 'banks' && part === 'questions') {
        const chunk = chunks[0];
        headers['X-Legacy-Chunk-SHA256'] = chunk.sha256;
        headers['X-Legacy-Chunk-Index'] = String(chunk.index);
        headers['X-Legacy-Chunk-Count'] = String(chunkCount);
        return rawResponse(chunk.bytes, headers, request, env);
      }
      if (total !== expectedLength) throw new Error('MIGRATION_QUARANTINED');
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk.bytes, offset); offset += chunk.bytes.byteLength; }
      if (await digestHex(bytes) !== expectedSha) throw new Error('MIGRATION_QUARANTINED');
      return rawResponse(bytes, headers, request, env);
    }
    const afterId = input.cursor === null ? null : decodeCursor(input.cursor, identity, section, manifestDigest);
    const items = [];
    let nextId = afterId;
    let hasMore = false;
    for (let pageNumber = 0; pageNumber < 4 && items.length < input.limit; pageNumber += 1) {
      const count = Math.min(5, input.limit - items.length);
      const page = await readPage(state, section, nextId, count);
      items.push(...page.items);
      nextId = page.nextCursor;
      if (nextId === null) break;
      if (items.length >= input.limit) hasMore = true;
    }
    const nextCursor = !hasMore || !manifestDigest ? null : encodeCursor(identity, section, manifestDigest, nextId);
    if (section === 'history') {
      for (const item of items) {
        if (!ID(item.id) || item.sourceKey !== `history:${item.id}` || !validDigest(item.sha256)
          || !Number.isSafeInteger(item.byteLength) || item.byteLength < 1 || item.byteLength > 409600
          || !Number.isSafeInteger(item.chunkCount) || item.chunkCount !== Math.ceil(item.byteLength / (256 * 1024))) throw new Error('MIGRATION_QUARANTINED');
      }
    } else {
      for (const item of items) {
        if (!BANK_ID.test(item.id) || item.sourceKey !== `bank:${item.id}` || !validDigest(item.sha256) || !validDigest(item.metaSha256)
          || !Number.isSafeInteger(item.byteLength) || item.byteLength < 1 || item.byteLength > 1_900_000
          || !Number.isSafeInteger(item.metaByteLength) || item.metaByteLength < 1 || item.metaByteLength > 256 * 1024
          || !Number.isSafeInteger(item.chunkCount) || item.chunkCount !== Math.ceil(item.byteLength / (256 * 1024))) throw new Error('MIGRATION_QUARANTINED');
      }
    }
    return accountCorsResponse(request, env, json({ ok: true, items, nextCursor }));
  } catch (error) {
    const code = typeof error?.message === 'string' ? error.message : 'UNAVAILABLE';
    return context?.request ? accountCorsResponse(context.request, context.env, fail(code, internalStatus(code))) : fail(code, internalStatus(code));
  }
}

async function digestHex(bytes) {
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}
