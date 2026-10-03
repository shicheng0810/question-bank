import { principalForCode, normalizeCode } from '../../do-worker/src/account-code.js';
import {ACCOUNT_TOKEN_PATTERN} from '../../do-worker/src/account-session-v3.js';
import { accountOriginAllowed } from './account-http-origin.js';
import { readLegacyJson } from './legacy-input.js';

const FEATURE = '1';
const TRUSTED_IP = '1';
const BODY_LIMIT = 2048;
const RATE_LIMIT = 20;
const RATE_PERIOD = 60;
const RPC_DISPOSER = Symbol.dispose;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN = ACCOUNT_TOKEN_PATTERN;
const REGISTRATION_INTENT = /^ri1\.[0-9a-f]{64}$/;
const INTERNAL_AUTH_ERRORS = new Set([
  'INVALID_INPUT',
  'INVALID_CREDENTIALS',
  'NOT_REGISTERED',
  'STALE_AUTHORITY',
  'INVALID_PHASE',
  'STALE_FENCE',
  'STALE_INCARNATION',
  'OPERATION_CONFLICT',
  'ACCOUNT_DELETED',
  'MIGRATION_UNCERTAIN',
  'MIGRATION_QUARANTINED',
  'MIGRATION_REQUIRED',
  'FENCE_EXHAUSTED',
]);

function response(body, status, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...extra,
    },
  });
}

function failure(error, status, extra = {}) {
  return response({ ok: false, error }, status, extra);
}

function exactRecord(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const actual = Reflect.ownKeys(value);
  if (actual.some((key) => typeof key !== 'string')
    || actual.length !== keys.length || keys.some((key) => !actual.includes(key))) return false;
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor;
  });
}

function validContentType(value) {
  if (typeof value !== 'string') return false;
  const parts = value.split(';').map((part) => part.trim());
  if (parts[0].toLowerCase() !== 'application/json') return false;
  if (parts.length === 1) return true;
  return parts.length === 2 && /^charset\s*=\s*utf-8$/i.test(parts[1]);
}

function validContentEncoding(value) {
  return value === null || value.trim().toLowerCase() === 'identity';
}

function canonicalIPv4(value) {
  const parts = value.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part)
    || (part.length > 1 && part.startsWith('0')) || Number(part) > 255)) return null;
  return parts.join('.');
}

function canonicalIP(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 45 || /[\s[\]%]/.test(value)) return null;
  const ipv4 = canonicalIPv4(value);
  if (ipv4) return ipv4;
  if (!value.includes(':') || !/^[0-9a-fA-F:.]+$/.test(value)) return null;
  let hostname;
  try {
    hostname = new URL(`http://[${value}]`).hostname;
  } catch {
    return null;
  }
  if (hostname.startsWith('[') && hostname.endsWith(']')) hostname = hostname.slice(1, -1);
  return hostname.includes(':') ? hostname.toLowerCase() : null;
}

async function sha256hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  let result = '';
  for (const byte of new Uint8Array(digest)) result += byte.toString(16).padStart(2, '0');
  return result;
}

function configured(env) {
  return env?.GEN05_AUTH_TRUST_CF_IP === TRUSTED_IP
    && env.ACCOUNT_AUTHORITY
    && typeof env.ACCOUNT_AUTHORITY.idFromName === 'function'
    && typeof env.ACCOUNT_AUTHORITY.get === 'function'
    && env.RATE_LIMITER
    && typeof env.RATE_LIMITER.idFromName === 'function'
    && typeof env.RATE_LIMITER.get === 'function';
}

async function limited(env, ip) {
  const bucket = `gen05:auth:ip:${await sha256hex(`qbip:v1:${ip}`)}`;
  let id;
  let stub;
  try {
    id = env.RATE_LIMITER.idFromName(bucket);
    stub = env.RATE_LIMITER.get(id);
    if (!stub || typeof stub.fetch !== 'function') throw new Error('limiter unavailable');
    const result = await stub.fetch('https://rate-limiter/hit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ limit: RATE_LIMIT, periodSec: RATE_PERIOD }),
    });
    if (!result || result.status !== 200) throw new Error('limiter status');
    const parsed = await readLegacyJson(result, 128);
    if (!parsed.ok) throw new Error('limiter body');
    const value = parsed.value;
    if (!exactRecord(value, ['allowed']) || typeof value.allowed !== 'boolean') throw new Error('limiter shape');
    return value.allowed;
  } catch {
    throw new Error('UNAVAILABLE');
  }
}

function publicBody(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const actionDescriptor = Object.getOwnPropertyDescriptor(parsed, 'action');
  if (!actionDescriptor || !('value' in actionDescriptor)
    || (actionDescriptor.value !== 'login'
      && actionDescriptor.value !== 'prepare-register' && actionDescriptor.value !== 'register')) return null;
  const action = actionDescriptor.value;
  const keys = action === 'login'
    ? ['action', 'code']
    : ['action', 'code', 'opId', ...(action === 'register' ? ['intent'] : [])];
  if (!exactRecord(parsed, keys)) return null;
  if (typeof parsed.code !== 'string') return null;
  let code;
  try {
    code = normalizeCode(parsed.code);
  } catch {
    return null;
  }
  if (action !== 'login' && (typeof parsed.opId !== 'string' || !UUID_V4.test(parsed.opId))) return null;
  if (action === 'register' && (typeof parsed.intent !== 'string' || !REGISTRATION_INTENT.test(parsed.intent))) return null;
  if (action === 'login') return { action, code };
  if (action === 'prepare-register') return { action, code, opId: parsed.opId };
  return { action, code, opId: parsed.opId, intent: parsed.intent };
}

async function disposeOutcome(outcome) {
  if (!outcome || typeof outcome !== 'object' || RPC_DISPOSER === undefined) return null;
  const descriptor = Object.getOwnPropertyDescriptor(outcome, RPC_DISPOSER);
  if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function') return null;
  try {
    await descriptor.value.call(outcome);
    return null;
  } catch {
    return new Error('UNAVAILABLE');
  }
}

function rpcOutcome(outcome, action) {
  if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) throw new Error('UNAVAILABLE');
  const prototype = Object.getPrototypeOf(outcome);
  if (prototype !== Object.prototype && prototype !== null) throw new Error('UNAVAILABLE');
  const keys = Reflect.ownKeys(outcome);
  const symbols = keys.filter((key) => typeof key === 'symbol');
  if (symbols.length > 1 || (symbols.length === 1 && (RPC_DISPOSER === undefined || symbols[0] !== RPC_DISPOSER))) {
    throw new Error('UNAVAILABLE');
  }
  if (symbols.length === 1) {
    const descriptor = Object.getOwnPropertyDescriptor(outcome, RPC_DISPOSER);
    if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function') throw new Error('UNAVAILABLE');
  }
  const ok = Object.getOwnPropertyDescriptor(outcome, 'ok');
  if (!ok || !('value' in ok) || typeof ok.value !== 'boolean') throw new Error('UNAVAILABLE');
  if (!ok.value && outcome.error === 'MIGRATION_PENDING') {
    const pendingKeys = Reflect.ownKeys(outcome).filter(key => typeof key === 'string');
    if (pendingKeys.length !== 4 || ['ok', 'error', 'migration', 'retryAfterMs'].some(key => !pendingKeys.includes(key))
      || ['ok', 'error', 'migration', 'retryAfterMs'].some(key => {
        const descriptor = Object.getOwnPropertyDescriptor(outcome, key);
        return !descriptor || !('value' in descriptor);
      }) || !exactRecord(outcome.migration, ['status', 'phase', 'processed', 'total'])
      || outcome.migration.status !== 'running'
      || !['history', 'banks', 'verify'].includes(outcome.migration.phase)
      || !Number.isSafeInteger(outcome.migration.processed) || outcome.migration.processed < 0
      || !Number.isSafeInteger(outcome.migration.total) || outcome.migration.total < outcome.migration.processed
      || outcome.retryAfterMs !== 750) throw new Error('UNAVAILABLE');
    return { ok: false, error: 'MIGRATION_PENDING', migration: outcome.migration, retryAfterMs: 750 };
  }
  const expected = ok.value
    ? (action === 'prepare-register' ? ['ok', 'intent', 'expiresAt'] : ['ok', 'token'])
    : ['ok', 'error'];
  const strings = keys.filter((key) => typeof key === 'string');
  if (strings.length !== expected.length || strings.some((key) => !expected.includes(key))) throw new Error('UNAVAILABLE');
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(outcome, key);
    if (!descriptor || !('value' in descriptor)) throw new Error('UNAVAILABLE');
  }
  if (ok.value) {
    if (action === 'prepare-register') {
      if (typeof outcome.intent !== 'string' || !REGISTRATION_INTENT.test(outcome.intent)
        || !Number.isSafeInteger(outcome.expiresAt) || outcome.expiresAt < 0) throw new Error('UNAVAILABLE');
      return { ok: true, intent: outcome.intent, expiresAt: outcome.expiresAt };
    }
    if (typeof outcome.token !== 'string' || !TOKEN.test(outcome.token)) throw new Error('UNAVAILABLE');
    return { ok: true, token: outcome.token };
  }
  if (typeof outcome.error !== 'string') throw new Error('UNAVAILABLE');
  return { ok: false, error: outcome.error };
}

function mapInternal(result) {
  if (result.ok) return response(result, 200);
  if (result.error === 'MIGRATION_PENDING') return response(result, 202);
  if (result.error === 'ACCOUNT_DELETED') return failure('ACCOUNT_DELETED', 410);
  if (result.error === 'MIGRATION_UNCERTAIN' || result.error === 'MIGRATION_QUARANTINED') return failure(result.error, 409);
  if (result.error === 'MIGRATION_REQUIRED') return failure('MIGRATION_REQUIRED', 409);
  return INTERNAL_AUTH_ERRORS.has(result.error)
    ? failure('AUTH_FAILED', 401)
    : failure('UNAVAILABLE', 503);
}

export async function handleAccountAuth(request, env) {
  if (env?.GEN05_AUTH_HTTP !== FEATURE) return failure('NOT_FOUND', 404);
  if (request.method !== 'POST') return failure('METHOD_NOT_ALLOWED', 405, { allow: 'POST' });
  const origin = request.headers.get('Origin');
  if (!accountOriginAllowed(request, env)) return failure('ORIGIN_NOT_ALLOWED', 403);
  if (!validContentType(request.headers.get('Content-Type'))
    || !validContentEncoding(request.headers.get('Content-Encoding'))) {
    return failure('UNSUPPORTED_MEDIA_TYPE', 415);
  }
  if (!configured(env)) return failure('UNAVAILABLE', 503);

  const ip = canonicalIP(request.headers.get('CF-Connecting-IP'));
  if (!ip) return failure('UNAVAILABLE', 503);
  let allowed;
  try {
    allowed = await limited(env, ip);
  } catch {
    return failure('UNAVAILABLE', 503);
  }
  if (!allowed) return failure('RATE_LIMITED', 429, { 'retry-after': String(RATE_PERIOD) });

  const parsed = await readLegacyJson(request, BODY_LIMIT);
  if (!parsed.ok) return parsed.error === 'too_large'
    ? failure('REQUEST_TOO_LARGE', 413)
    : failure('INVALID_REQUEST', 400);
  const body = publicBody(parsed.value);
  if (!body) return failure('INVALID_REQUEST', 400);

  try {
    const principal = await principalForCode(body.code);
    const id = env.ACCOUNT_AUTHORITY.idFromName(principal);
    const stub = env.ACCOUNT_AUTHORITY.get(id);
    const isPrepare = body.action === 'prepare-register';
    if (!stub || (isPrepare
      ? typeof stub.prepareRegistration !== 'function'
      : typeof stub.authenticate !== 'function')) throw new Error('UNAVAILABLE');
    const command = body.action === 'login'
      ? { type: 'login', code: body.code }
      : isPrepare
        ? { code: body.code, opId: body.opId }
        : { type: 'register-intent', code: body.code, opId: body.opId, intent: body.intent };
    const outcome = isPrepare
      ? await stub.prepareRegistration(command)
      : await stub.authenticate(command);
    let result;
    let disposalError;
    try {
      result = rpcOutcome(outcome, body.action);
    } catch {
      result = { ok: false, error: 'UNAVAILABLE' };
    } finally {
      disposalError = await disposeOutcome(outcome);
    }
    if (disposalError) return failure('UNAVAILABLE', 503);
    return mapInternal(result);
  } catch {
    return failure('UNAVAILABLE', 503);
  }
}
