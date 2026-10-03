import { loadAccountSession } from './account-session.js';
import { validGeneration } from '../../do-worker/src/generation-transition.js';

const FEATURE = '1';
const TRUSTED_IP = '1';
const RATE_LIMIT = 20;
const RATE_PERIOD = 60;
const RPC_DISPOSER = Symbol.dispose;
const HEX64 = /^[0-9a-f]{64}$/;

const AUTH_ERRORS = new Set([
  'INVALID_CREDENTIALS',
  'NOT_REGISTERED',
  'STALE_AUTHORITY',
  'INVALID_PHASE',
  'STALE_FENCE',
  'STALE_INCARNATION',
  'ACCOUNT_DELETED',
  'DELETE_PENDING',
  'NOT_INITIALIZED',
  'STALE_GENERATION',
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
  return env?.GEN05_ACCOUNT_HTTP === FEATURE
    && env?.GEN05_ACCOUNT_API === FEATURE
    && env?.GEN05_AUTH_TRUST_CF_IP === TRUSTED_IP
    && env.GENERATION_STORE && typeof env.GENERATION_STORE.getByName === 'function'
    && env.ACCOUNT_AUTHORITY && typeof env.ACCOUNT_AUTHORITY.idFromName === 'function'
    && typeof env.ACCOUNT_AUTHORITY.get === 'function'
    && env.GENERATION_SESSIONS && typeof env.GENERATION_SESSIONS.get === 'function'
    && env.RATE_LIMITER && typeof env.RATE_LIMITER.idFromName === 'function'
    && typeof env.RATE_LIMITER.get === 'function';
}

async function limited(env, ip, category = 'gen05:auth:ip', limit = RATE_LIMIT) {
  const bucket = `${category}:${await sha256hex(`qbip:v1:${ip}`)}`;
  const id = env.RATE_LIMITER.idFromName(bucket);
  const stub = env.RATE_LIMITER.get(id);
  if (!stub || typeof stub.fetch !== 'function') throw new Error('UNAVAILABLE');
  const result = await stub.fetch('https://rate-limiter/hit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ limit, periodSec: RATE_PERIOD }),
  });
  if (!result || result.status !== 200) throw new Error('UNAVAILABLE');
  let value;
  try {
    value = await result.json();
  } catch {
    throw new Error('UNAVAILABLE');
  }
  if (!exactRecord(value, ['allowed']) || typeof value.allowed !== 'boolean') throw new Error('UNAVAILABLE');
  return value.allowed;
}

function rpcResult(outcome, successKeys) {
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
  const okDescriptor = Object.getOwnPropertyDescriptor(outcome, 'ok');
  if (!okDescriptor || !('value' in okDescriptor) || typeof okDescriptor.value !== 'boolean') {
    throw new Error('UNAVAILABLE');
  }
  const expected = okDescriptor.value ? successKeys : ['ok', 'error'];
  const stringKeys = keys.filter((key) => typeof key === 'string');
  if (stringKeys.length !== expected.length || stringKeys.some((key) => !expected.includes(key))) {
    throw new Error('UNAVAILABLE');
  }
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(outcome, key);
    if (!descriptor || !('value' in descriptor)) throw new Error('UNAVAILABLE');
  }
  if (!okDescriptor.value) {
    if (typeof outcome.error !== 'string') throw new Error('UNAVAILABLE');
    return { ok: false, error: outcome.error };
  }
  const result = { ok: true };
  for (const key of successKeys) result[key] = outcome[key];
  return result;
}

async function callRpc(stub, method, command, successKeys) {
  if (!stub || typeof stub[method] !== 'function') throw new Error('UNAVAILABLE');
  let outcome;
  try {
    outcome = await stub[method](command);
    return rpcResult(outcome, successKeys);
  } finally {
    if (outcome && typeof outcome === 'object' && RPC_DISPOSER !== undefined) {
      const descriptor = Object.getOwnPropertyDescriptor(outcome, RPC_DISPOSER);
      if (descriptor && 'value' in descriptor && typeof descriptor.value === 'function') {
        try {
          await descriptor.value.call(outcome);
        } catch {
          throw new Error('UNAVAILABLE');
        }
      }
    }
  }
}

function internalError(error) {
  return typeof error?.message === 'string' ? error.message : 'UNAVAILABLE';
}

function mapInternal(error) {
  const code = typeof error === 'string' ? error : internalError(error);
  return AUTH_ERRORS.has(code) ? failure('AUTH_FAILED', 401) : failure('UNAVAILABLE', 503);
}

async function describeData(env, session) {
  const stub = env.GENERATION_STORE.getByName(session.sub);
  const result = await callRpc(stub, 'describeSession', {
    generation: session.generation,
    expiresAt: session.expiresAt,
  }, ['ok', 'principal', 'incarnation', 'generation']);
  if (!result.ok) throw new Error(result.error);
  // A success envelope with malformed identity fields is infrastructure
  // corruption. Only a well-formed identity that no longer matches the
  // current session is an authentication failure.
  if (typeof result.principal !== 'string' || !HEX64.test(result.principal)
    || typeof result.incarnation !== 'string' || !HEX64.test(result.incarnation)
    || !validGeneration(result.generation)) throw new Error('UNAVAILABLE');
  if (result.incarnation !== session.sub || result.generation !== session.generation
    || session.expiresAt <= Date.now()) throw new Error('INVALID_CREDENTIALS');
  return {
    principal: result.principal,
    incarnation: result.incarnation,
    generation: result.generation,
  };
}

async function validateAuthority(env, identity, session) {
  const id = env.ACCOUNT_AUTHORITY.idFromName(identity.principal);
  const stub = env.ACCOUNT_AUTHORITY.get(id);
  const result = await callRpc(stub, 'validateSession', {
    principal: identity.principal,
    incarnation: identity.incarnation,
    generation: identity.generation,
    expiresAt: session.expiresAt,
  }, ['ok', 'principal', 'incarnation', 'generation']);
  if (!result.ok) throw new Error(result.error);
  if (typeof result.principal !== 'string' || !HEX64.test(result.principal)
    || typeof result.incarnation !== 'string' || !HEX64.test(result.incarnation)
    || !validGeneration(result.generation)) throw new Error('UNAVAILABLE');
  return {
    principal: result.principal,
    incarnation: result.incarnation,
    generation: result.generation,
  };
}

export async function handleAccountSession(request, env) {
  // Keep the disabled path before URL, request body, bindings, limiter or KV.
  if (env?.GEN05_ACCOUNT_HTTP !== FEATURE || env?.GEN05_ACCOUNT_API !== FEATURE) {
    return failure('NOT_FOUND', 404);
  }
  if (request.method !== 'POST') return failure('METHOD_NOT_ALLOWED', 405, { allow: 'POST' });

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return failure('INVALID_REQUEST', 400);
  }
  const origin = request.headers.get('Origin');
  if (!accountOriginAllowed(request, env)) return failure('ORIGIN_NOT_ALLOWED', 403);
  if (url.search !== '') return failure('INVALID_REQUEST', 400);
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

  try {
    const loaded = await loadAccountSession(request, env);
    if (!loaded.ok) return mapInternal(loaded.error);
    const identity = await describeData(env, loaded.session);
    const verified = await validateAuthority(env, identity, loaded.session);
    if (loaded.session.expiresAt <= Date.now()
      || verified.principal !== identity.principal
      || verified.incarnation !== loaded.session.sub
      || verified.generation !== loaded.session.generation
      || identity.incarnation !== loaded.session.sub
      || identity.generation !== loaded.session.generation) {
      return failure('AUTH_FAILED', 401);
    }
    return response({
      ok: true,
      accountId: loaded.session.sub,
      accountGeneration: verified.generation,
      expiresAt: loaded.session.expiresAt,
    }, 200);
  } catch (error) {
    return mapInternal(error);
  }
}

// Internal server adapter: the HTTP layer must apply its own method/origin and
// bounded-body guards before calling. No client supplied principal is used.
export async function loadVerifiedAccountIdentity(request, env) {
  const loaded = await loadAccountSession(request, env);
  if (!loaded.ok) throw new Error(loaded.error);
  const identity = await describeData(env, loaded.session);
  const verified = await validateAuthority(env, identity, loaded.session);
  if (loaded.session.expiresAt <= Date.now() || verified.principal !== identity.principal
    || verified.incarnation !== loaded.session.sub || verified.generation !== loaded.session.generation) throw new Error('INVALID_CREDENTIALS');
  return { principal: verified.principal, incarnation: verified.incarnation, generation: verified.generation, expiresAt: loaded.session.expiresAt };
}

export async function guardAccountSyncRate(request, env) {
  if (!configured(env)) return failure('UNAVAILABLE', 503);
  const ip = canonicalIP(request.headers.get('CF-Connecting-IP'));
  if (!ip) return failure('UNAVAILABLE', 503);
  try { if (!await limited(env, ip)) return failure('RATE_LIMITED', 429, { 'retry-after': String(RATE_PERIOD) }); }
  catch { return failure('UNAVAILABLE', 503); }
  return null;
}

// ADR15 export-only fixed window; ordinary auth/sync retain their 20/min gate.
export async function guardAccountExportIpRate(request, env) {
  if (!configured(env)) return failure('UNAVAILABLE', 503);
  const ip = canonicalIP(request.headers.get('CF-Connecting-IP'));
  if (!ip) return failure('UNAVAILABLE', 503);
  try { if (!await limited(env, ip, 'gen06:export:ip', 120)) return failure('RATE_LIMITED', 429, { 'retry-after': String(RATE_PERIOD) }); }
  catch { return failure('UNAVAILABLE', 503); }
  return null;
}

export function decodeAccountRpcOutcome(outcome, successKeys) {
  return rpcResult(outcome, successKeys);
}

export async function disposeAccountRpcOutcome(outcome) {
  if (!outcome || typeof outcome !== 'object' || RPC_DISPOSER === undefined) return;
  const descriptor = Object.getOwnPropertyDescriptor(outcome, RPC_DISPOSER);
  if (descriptor && 'value' in descriptor && typeof descriptor.value === 'function') {
    try { await descriptor.value.call(outcome); } catch { throw new Error('UNAVAILABLE'); }
  }
}
import { accountOriginAllowed } from './account-http-origin.js';
