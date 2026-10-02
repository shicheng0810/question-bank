const TOKEN_RE = /^(?:v2\.[A-Za-z0-9_-]{43}|v3\.[0-9a-f]{64}\.[A-Za-z0-9_-]{43})$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const MIGRATION_PHASES = new Set(['history', 'banks', 'verify']);
const MAX_PAGE_SIZE = 20;
const MAX_CURSOR_LENGTH = 4096;

export class LegacyMigrationError extends Error {
  constructor(code, details = null) {
    super(code);
    this.name = 'LegacyMigrationError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, details) {
  throw new LegacyMigrationError(code, details);
}

function decodeSourceKey(value) {
  if (typeof value !== 'string' || !value || value.length > 2048) return null;
  try { return decodeURIComponent(value); } catch { return null; }
}

function sameOriginBase(value, locationValue, allowMirrorApi) {
  locationValue ||= globalThis.location;
  const base = new URL(String(value || '/api'), locationValue ? locationValue.href : 'http://localhost/');
  if (base.origin !== (locationValue ? locationValue.origin : 'http://localhost')) {
    if (allowMirrorApi !== true || locationValue?.origin !== 'https://shicheng0810.github.io'
      || base.origin !== 'https://question-bank-78u.pages.dev' || base.pathname !== '/api'
      || base.search || base.hash || base.username || base.password) fail('ORIGIN_NOT_ALLOWED');
    return `${base.origin}/api`;
  }
  if (base.search || base.hash || base.username || base.password) fail('ORIGIN_NOT_ALLOWED');
  return base.pathname.replace(/\/+$/, '') || '/';
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

async function responseJson(response) {
  try {
    const value = await response.json();
    if (!isObject(value)) fail('INVALID_RESPONSE');
    return value;
  } catch (error) {
    if (error instanceof LegacyMigrationError) throw error;
    fail('INVALID_RESPONSE');
  }
}

export function parseLegacyAuthResponse(status, value) {
  if (status === 202 && value.error === 'MIGRATION_PENDING') {
    if (Object.hasOwn(value, 'token') || value.ok !== false || !isObject(value.migration)) fail('INVALID_RESPONSE');
    const migration = value.migration;
    if (migration.status !== 'running' || !MIGRATION_PHASES.has(migration.phase)
      || !validCount(migration.processed) || !validCount(migration.total) || migration.processed > migration.total
      || !Number.isSafeInteger(value.retryAfterMs) || value.retryAfterMs !== 750) {
      fail('INVALID_RESPONSE');
    }
    return { state: 'pending', migration: structuredClone(migration), retryAfterMs: value.retryAfterMs };
  }
  if (status === 200 && value.ok === true && typeof value.token === 'string' && TOKEN_RE.test(value.token)) {
    return { state: 'ready', token: value.token };
  }
  const known = new Set(['MIGRATION_UNCERTAIN', 'MIGRATION_QUARANTINED', 'ACCOUNT_DELETED', 'UNAVAILABLE', 'RATE_LIMITED', 'AUTH_FAILED']);
  if (known.has(value.error)) fail(value.error, { retryable: value.error === 'UNAVAILABLE' || value.error === 'RATE_LIMITED' });
  fail('AUTH_FAILED');
}

function queryString(values) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null) params.set(key, String(value));
  }
  return params.toString();
}

function validArchivePage(value, kind) {
  if (!isObject(value) || !Array.isArray(value.items) || value.items.length > MAX_PAGE_SIZE
    || !(value.nextCursor === null || (typeof value.nextCursor === 'string' && value.nextCursor.length > 0 && value.nextCursor.length <= MAX_CURSOR_LENGTH))) {
    fail('INVALID_RESPONSE');
  }
  for (const item of value.items) {
    if (!isObject(item) || typeof item.id !== 'string' || !item.id || item.id.length > 128 || typeof item.sourceKey !== 'string' || !item.sourceKey
      || !SHA256_RE.test(item.sha256) || !validCount(item.byteLength)) fail('INVALID_RESPONSE');
    if (kind === 'history' && (item.sourceKey !== `history:${item.id}` || item.byteLength > 409_600 || typeof item.bank_id !== 'string' || !Number.isSafeInteger(item.ts) || !validCount(item.count) || typeof item.title !== 'string' || typeof item.viewMode !== 'string')) fail('INVALID_RESPONSE');
    if (kind === 'banks' && (typeof item.title !== 'string' || !Number.isSafeInteger(item.ts) || !validCount(item.count)
      || item.sourceKey !== `bank:${item.id}` || item.byteLength > 2_000_000
      || !Number.isSafeInteger(item.questionCount) || item.questionCount !== item.count
      || !Number.isSafeInteger(item.chunkCount) || item.chunkCount < 1 || item.chunkCount > 8
      || item.chunkCount !== Math.max(1, Math.ceil(item.byteLength / (256 * 1024)))
      || !validCount(item.metaByteLength) || item.metaByteLength > 256 * 1024 || !SHA256_RE.test(item.metaSha256))) fail('INVALID_RESPONSE');
  }
  return { items: structuredClone(value.items), nextCursor: value.nextCursor };
}

async function sha256Hex(bytes, subtle) {
  const digest = await subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function boundedBody(response, maximumBytes) {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes)) fail('ARCHIVE_TOO_LARGE');
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maximumBytes) fail('ARCHIVE_TOO_LARGE');
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        fail('ARCHIVE_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

/**
 * Client for account cutover and the immutable legacy archive. It never stores
 * the supplied code or token; callers keep credentials in their own lifecycle.
 */
export function createLegacyMigrationClient(options = {}) {
  const apiBase = sameOriginBase(options.apiBase || '/api', options.location, options.allowMirrorApi);
  const fetchImpl = options.fetchImpl || globalThis.fetch.bind(globalThis);
  const transport = options.transport || null;
  const subtle = options.subtle || globalThis.crypto?.subtle;

  async function request(path, { method = 'GET', body, token } = {}) {
    const headers = new Headers();
    if (body !== undefined) headers.set('content-type', 'application/json');
    if (!transport && path.startsWith('/v2/legacy/') && (typeof token !== 'string' || !TOKEN_RE.test(token))) fail('SESSION_REQUIRED');
    if (!transport && token !== undefined) {
      if (typeof token !== 'string' || !TOKEN_RE.test(token)) fail('SESSION_REQUIRED');
      headers.set('authorization', `Bearer ${token}`);
    }
    let response;
    try {
      if (transport) {
        const safeResult = await transport({ path, method, ...(body === undefined ? {} : { body }) });
        const payload = safeResult.body instanceof Uint8Array ? safeResult.body : new TextEncoder().encode(JSON.stringify(safeResult.body));
        response = new Response(payload, { status: safeResult.status, headers: safeResult.headers || { 'content-type': 'application/json; charset=utf-8' } });
      } else {
        response = await fetchImpl(`${apiBase}${path}`, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          cache: 'no-store',
        });
      }
    } catch {
      fail('UNAVAILABLE', { retryable: true });
    }
    return response;
  }

  async function login(code) {
    if (typeof code !== 'string' || code.trim().length < 4 || code.length > 64) fail('BAD_CODE');
    const response = await request('/v2/auth', { method: 'POST', body: { action: 'login', code } });
    const value = await responseJson(response);
    return parseLegacyAuthResponse(response.status, value);
  }

  async function listArchive(kind, { limit = 5, cursor = null, token } = {}) {
    if (kind !== 'history' && kind !== 'banks') fail('INVALID_ARGUMENT');
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE
      || (cursor !== null && (typeof cursor !== 'string' || !cursor || cursor.length > MAX_CURSOR_LENGTH))) fail('INVALID_ARGUMENT');
    const suffix = queryString({ limit, cursor });
    const response = await request(`/v2/legacy/${kind}?${suffix}`, { token });
    if (response.status !== 200) fail(response.status === 401 ? 'SESSION_EXPIRED' : 'ARCHIVE_UNAVAILABLE', { retryable: response.status >= 500 });
    const value = await responseJson(response);
    if (value.ok !== true) fail('INVALID_RESPONSE');
    return validArchivePage(value, kind);
  }

  async function readHistory(id, { token } = {}) {
    if (typeof id !== 'string' || !id) fail('INVALID_ARGUMENT');
    const response = await request(`/v2/legacy/history?${queryString({ id })}`, { token });
    if (response.status !== 200) fail(response.status === 401 ? 'SESSION_EXPIRED' : 'ARCHIVE_UNAVAILABLE', { retryable: response.status >= 500 });
    if (!subtle) fail('DIGEST_UNAVAILABLE');
    const bytes = await boundedBody(response, 409_600);
    const sourceKey = decodeSourceKey(response.headers.get('x-legacy-source-key'));
    const sha256 = response.headers.get('x-legacy-source-sha256');
    const byteLength = Number(response.headers.get('x-legacy-byte-length'));
    if (sourceKey !== `history:${id}` || !SHA256_RE.test(sha256 || '') || byteLength !== bytes.byteLength || await sha256Hex(bytes, subtle) !== sha256) fail('DIGEST_MISMATCH');
    let record;
    try { record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('INVALID_ARCHIVE_CONTENT'); }
    if (!isObject(record) || record.id !== id) fail('INVALID_ARCHIVE_CONTENT');
    return { sourceKey, sha256, byteLength, rawJson: new TextDecoder().decode(bytes), record };
  }

  async function readBankChunk(id, chunkIndex, { token, part = 'questions' } = {}) {
    if (typeof id !== 'string' || !id || !Number.isSafeInteger(chunkIndex) || chunkIndex < 0) fail('INVALID_ARGUMENT');
    if (part !== 'questions' && part !== 'meta') fail('INVALID_ARGUMENT');
    const response = await request(`/v2/legacy/banks?${queryString({ id, part, ...(part === 'questions' ? { chunkIndex } : {}) })}`, { token });
    if (response.status !== 200) fail(response.status === 401 ? 'SESSION_EXPIRED' : 'ARCHIVE_UNAVAILABLE', { retryable: response.status >= 500 });
    if (!subtle) fail('DIGEST_UNAVAILABLE');
    const bytes = await boundedBody(response, 256 * 1024);
    const digest = part === 'meta' ? response.headers.get('x-legacy-source-sha256') : response.headers.get('x-legacy-chunk-sha256');
    const sourceDigest = response.headers.get('x-legacy-source-sha256');
    const sourceKey = decodeSourceKey(response.headers.get('x-legacy-source-key'));
    const declaredLength = Number(response.headers.get('x-legacy-byte-length'));
    const index = part === 'meta' ? 0 : Number(response.headers.get('x-legacy-chunk-index'));
    const count = part === 'meta' ? 1 : Number(response.headers.get('x-legacy-chunk-count'));
    if (sourceKey !== `bank:${id}:${part}` || !SHA256_RE.test(digest || '') || !SHA256_RE.test(sourceDigest || '') || !Number.isSafeInteger(declaredLength)
      || declaredLength < bytes.byteLength || bytes.byteLength > 256 * 1024 || index !== chunkIndex
      || !Number.isSafeInteger(count) || count < 1 || await sha256Hex(bytes, subtle) !== digest) fail('DIGEST_MISMATCH');
    return { bytes, sourceKey, chunkSha256: digest, sourceSha256: sourceDigest, sourceByteLength: declaredLength, chunkCount: count, part };
  }

  async function readBank(id, { token, chunkCount, sha256, byteLength, sourceKey, metaByteLength, metaSha256 } = {}) {
    if (chunkCount === undefined && validCount(byteLength)) chunkCount = Math.max(1, Math.ceil(byteLength / (256 * 1024)));
    if (typeof id !== 'string' || !id || !Number.isSafeInteger(chunkCount) || chunkCount < 1 || chunkCount > 8
      || !SHA256_RE.test(sha256 || '') || !validCount(byteLength) || byteLength > 2_000_000
      || chunkCount !== Math.max(1, Math.ceil(byteLength / (256 * 1024)))
      || typeof sourceKey !== 'string' || !sourceKey || !validCount(metaByteLength) || metaByteLength > 256 * 1024
      || !SHA256_RE.test(metaSha256 || '') || !subtle) fail('INVALID_ARGUMENT');
    const metaChunk = await readBankChunk(id, 0, { token, part: 'meta' });
    if (metaChunk.sourceByteLength !== metaByteLength || metaChunk.chunkSha256 !== metaSha256
      || metaChunk.sourceKey !== `${sourceKey}:meta`) fail('DIGEST_MISMATCH');
    let meta;
    try { meta = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(metaChunk.bytes)); } catch { fail('INVALID_ARCHIVE_CONTENT'); }
    if (!isObject(meta) || meta.id !== id) fail('INVALID_ARCHIVE_CONTENT');
    const chunks = [];
    let total = 0;
    for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
      const chunk = await readBankChunk(id, chunkIndex, { token, part: 'questions' });
      if (chunk.sourceSha256 !== sha256 || chunk.sourceByteLength !== byteLength || chunk.chunkCount !== chunkCount
        || chunk.sourceKey !== `${sourceKey}:questions`) fail('DIGEST_MISMATCH');
      chunks.push(chunk.bytes);
      total += chunk.bytes.byteLength;
      if (total > byteLength) fail('DIGEST_MISMATCH');
    }
    if (total !== byteLength) fail('DIGEST_MISMATCH');
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    if (await sha256Hex(bytes, subtle) !== sha256) fail('DIGEST_MISMATCH');
    let bank;
    try { bank = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('INVALID_ARCHIVE_CONTENT'); }
    if (!Array.isArray(bank)) fail('INVALID_ARCHIVE_CONTENT');
    return { bytes, bank: { ...meta, questions: bank }, questions: bank, metadata: meta,
      source: { sourceKey, questionsSha256: sha256, questionsByteLength: byteLength, metaSha256, metaByteLength } };
  }

  return Object.freeze({ login, listHistory: (options) => listArchive('history', options), readHistory, listBanks: (options) => listArchive('banks', options), readBankChunk, readBank });
}
