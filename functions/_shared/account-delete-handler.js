import { readLegacyJson } from './legacy-input.js';
import { loadAccountSession } from './account-session.js';
import { validGeneration } from '../../do-worker/src/generation-transition.js';
import { ticketParts } from '../../do-worker/src/account-deletion-ticket.js';

const FEATURE = '1';
const TRUSTED_IP = '1';
const BODY_LIMIT = 2048;
const RATE_LIMIT = 20;
const RATE_PERIOD = 60;
const RPC_DISPOSER = Symbol.dispose;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const AUTH_ERRORS = new Set([
  'INVALID_CREDENTIALS',
  'NOT_REGISTERED',
  'STALE_AUTHORITY',
  'INVALID_PHASE',
  'STALE_FENCE',
  'STALE_INCARNATION',
  'OPERATION_CONFLICT',
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

function validContentType(value) {
  if (typeof value !== 'string') return false;
  const parts = value.split(';').map((part) => part.trim());
  return parts[0].toLowerCase() === 'application/json'
    && (parts.length === 1 || (parts.length === 2 && /^charset\s*=\s*utf-8$/i.test(parts[1])));
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
  if (typeof value !== 'string' || value.length === 0 || value.length > 45 || /[\s[%\]]/.test(value)) return null;
  const ipv4 = canonicalIPv4(value);
  if (ipv4) return ipv4;
  if (!value.includes(':') || !/^[0-9a-fA-F:.]+$/.test(value)) return null;
  let hostname;
  try { hostname = new URL(`http://[${value}]`).hostname; } catch { return null; }
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
    && env.ACCOUNT_AUTHORITY && typeof env.ACCOUNT_AUTHORITY.idFromName === 'function'
    && typeof env.ACCOUNT_AUTHORITY.get === 'function'
    && env.GENERATION_STORE && typeof env.GENERATION_STORE.getByName === 'function'
    && env.GENERATION_SESSIONS && typeof env.GENERATION_SESSIONS.get === 'function'
    && env.RATE_LIMITER && typeof env.RATE_LIMITER.idFromName === 'function'
    && typeof env.RATE_LIMITER.get === 'function';
}

async function limited(env, ip) {
  const bucket = `gen05:auth:ip:${await sha256hex(`qbip:v1:${ip}`)}`;
  const id = env.RATE_LIMITER.idFromName(bucket);
  const stub = env.RATE_LIMITER.get(id);
  if (!stub || typeof stub.fetch !== 'function') throw new Error('UNAVAILABLE');
  const result = await stub.fetch('https://rate-limiter/hit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ limit: RATE_LIMIT, periodSec: RATE_PERIOD }),
  });
  if (!result || result.status !== 200) throw new Error('UNAVAILABLE');
  const parsed = await readLegacyJson(result, 128);
  if (!parsed.ok || !exactRecord(parsed.value, ['allowed']) || typeof parsed.value.allowed !== 'boolean') {
    throw new Error('UNAVAILABLE');
  }
  return parsed.value.allowed;
}

function publicBody(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const actionDescriptor = Object.getOwnPropertyDescriptor(value, 'action');
  if (!actionDescriptor || !('value' in actionDescriptor)) return null;
  if (actionDescriptor.value === 'prepare-delete') {
    if (!exactRecord(value, ['action', 'opId']) || typeof value.opId !== 'string' || !UUID_V4.test(value.opId)) return null;
    return { action: value.action, opId: value.opId };
  }
  if (actionDescriptor.value !== 'delete' && actionDescriptor.value !== 'status') return null;
  if (!exactRecord(value, ['action', 'ticket']) || typeof value.ticket !== 'string') return null;
  return { action: value.action, ticket: value.ticket };
}

function internalError(code) {
  return typeof code === 'string' ? code : 'UNAVAILABLE';
}

function mapInternal(code) {
  if (code === 'FEATURE_DISABLED') return failure('NOT_FOUND', 404);
  if (AUTH_ERRORS.has(code)) return failure('AUTH_FAILED', 401);
  return failure('UNAVAILABLE', 503);
}

async function describeSession(env, session) {
  const stub = env.GENERATION_STORE.getByName(session.sub);
  if (!stub || typeof stub.describeSession !== 'function') throw new Error('UNAVAILABLE');
  let outcome;
  try {
    outcome = await stub.describeSession({ generation: session.generation, expiresAt: session.expiresAt });
    if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) throw new Error('UNAVAILABLE');
    const prototype = Object.getPrototypeOf(outcome);
    if (prototype !== Object.prototype && prototype !== null) throw new Error('UNAVAILABLE');
    const keys = Reflect.ownKeys(outcome);
    const symbols = keys.filter((key) => typeof key === 'symbol');
    if (symbols.length > 1 || (symbols.length === 1 && (RPC_DISPOSER === undefined || symbols[0] !== RPC_DISPOSER))) throw new Error('UNAVAILABLE');
    if (symbols.length === 1) {
      const descriptor = Object.getOwnPropertyDescriptor(outcome, RPC_DISPOSER);
      if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function') throw new Error('UNAVAILABLE');
    }
    const ok = Object.getOwnPropertyDescriptor(outcome, 'ok');
    if (!ok || !('value' in ok) || typeof outcome.ok !== 'boolean') throw new Error('UNAVAILABLE');
    const expected = outcome.ok ? ['ok', 'principal', 'incarnation', 'generation'] : ['ok', 'error'];
    const stringKeys = keys.filter((key) => typeof key === 'string');
    if (stringKeys.length !== expected.length || stringKeys.some((key) => !expected.includes(key))) throw new Error('UNAVAILABLE');
    for (const key of expected) {
      const descriptor = Object.getOwnPropertyDescriptor(outcome, key);
      if (!descriptor || !('value' in descriptor)) throw new Error('UNAVAILABLE');
    }
    if (!outcome.ok) {
      if (typeof outcome.error !== 'string') throw new Error('UNAVAILABLE');
      throw new Error(outcome.error);
    }
    if (typeof outcome.principal !== 'string' || !/^[0-9a-f]{64}$/.test(outcome.principal)
      || typeof outcome.incarnation !== 'string' || !/^[0-9a-f]{64}$/.test(outcome.incarnation)
      || typeof outcome.generation !== 'string' || !validGeneration(outcome.generation)
      || outcome.incarnation !== session.sub || outcome.generation !== session.generation
      || session.expiresAt <= Date.now()) throw new Error('INVALID_CREDENTIALS');
    return { principal: outcome.principal, incarnation: outcome.incarnation, generation: outcome.generation };
  } finally {
    if (outcome && typeof outcome === 'object' && RPC_DISPOSER !== undefined) {
      const descriptor = Object.getOwnPropertyDescriptor(outcome, RPC_DISPOSER);
      if (descriptor && 'value' in descriptor && typeof descriptor.value === 'function') {
        try { await descriptor.value.call(outcome); } catch { throw new Error('UNAVAILABLE'); }
      }
    }
  }
}

async function callRpc(stub, method, command, expected) {
  if (!stub || typeof stub[method] !== 'function') throw new Error('UNAVAILABLE');
  let outcome;
  try {
    outcome = await stub[method](command);
    if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) throw new Error('UNAVAILABLE');
    const prototype = Object.getPrototypeOf(outcome);
    if (prototype !== Object.prototype && prototype !== null) throw new Error('UNAVAILABLE');
    const keys = Reflect.ownKeys(outcome);
    const symbols = keys.filter((key) => typeof key === 'symbol');
    if (symbols.length > 1 || (symbols.length === 1 && (RPC_DISPOSER === undefined || symbols[0] !== RPC_DISPOSER))) throw new Error('UNAVAILABLE');
    if (symbols.length === 1) {
      const descriptor = Object.getOwnPropertyDescriptor(outcome, RPC_DISPOSER);
      if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function') throw new Error('UNAVAILABLE');
    }
    const stringKeys = keys.filter((key) => typeof key === 'string');
    const ok = Object.getOwnPropertyDescriptor(outcome, 'ok');
    if (!ok || !('value' in ok) || typeof outcome.ok !== 'boolean') throw new Error('UNAVAILABLE');
    const expectedKeys = outcome.ok ? expected : ['ok', 'error'];
    if (stringKeys.length !== expectedKeys.length || stringKeys.some((key) => !expectedKeys.includes(key))) throw new Error('UNAVAILABLE');
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(outcome, key);
      if (!descriptor || !('value' in descriptor)) throw new Error('UNAVAILABLE');
    }
    if (!outcome.ok) {
      if (typeof outcome.error !== 'string') throw new Error('UNAVAILABLE');
      return { ok: false, error: outcome.error };
    }
    if (method === 'prepareDeletion'
      && (typeof outcome.ticket !== 'string' || !ticketParts(outcome.ticket)
        || !Number.isSafeInteger(outcome.expiresAt) || outcome.expiresAt <= Date.now())) throw new Error('UNAVAILABLE');
    if (method === 'useDeletionTicket' && !['prepared', 'pending', 'complete'].includes(outcome.status)) throw new Error('UNAVAILABLE');
    return method === 'prepareDeletion'
      ? { ok: true, ticket: outcome.ticket, expiresAt: outcome.expiresAt }
      : { ok: true, status: outcome.status };
  } finally {
    if (outcome && typeof outcome === 'object' && RPC_DISPOSER !== undefined) {
      const descriptor = Object.getOwnPropertyDescriptor(outcome, RPC_DISPOSER);
      if (descriptor && 'value' in descriptor && typeof descriptor.value === 'function') {
        try { await descriptor.value.call(outcome); } catch { throw new Error('UNAVAILABLE'); }
      }
    }
  }
}

export async function handleAccountDelete(request, env) {
  if (env?.GEN05_ACCOUNT_HTTP !== FEATURE) return failure('NOT_FOUND', 404);
  if (request.method !== 'POST') return failure('METHOD_NOT_ALLOWED', 405, { allow: 'POST' });
  const origin = request.headers.get('Origin');
  if (!accountOriginAllowed(request, env)) return failure('ORIGIN_NOT_ALLOWED', 403);
  if (!validContentType(request.headers.get('Content-Type'))
    || !validContentEncoding(request.headers.get('Content-Encoding'))) return failure('UNSUPPORTED_MEDIA_TYPE', 415);
  if (!configured(env)) return failure('UNAVAILABLE', 503);
  const ip = canonicalIP(request.headers.get('CF-Connecting-IP'));
  if (!ip) return failure('UNAVAILABLE', 503);
  let allowed;
  try { allowed = await limited(env, ip); } catch { return failure('UNAVAILABLE', 503); }
  if (!allowed) return failure('RATE_LIMITED', 429, { 'retry-after': String(RATE_PERIOD) });
  const parsed = await readLegacyJson(request, BODY_LIMIT);
  if (!parsed.ok) return parsed.error === 'too_large'
    ? failure('REQUEST_TOO_LARGE', 413)
    : failure('INVALID_REQUEST', 400);
  const body = publicBody(parsed.value);
  if (!body) return failure('INVALID_REQUEST', 400);

  try {
    if (body.action === 'prepare-delete') {
      const loaded = await loadAccountSession(request, env);
      if (!loaded.ok) return mapInternal(loaded.error);
      const identity = await describeSession(env, loaded.session);
      const id = env.ACCOUNT_AUTHORITY.idFromName(identity.principal);
      const stub = env.ACCOUNT_AUTHORITY.get(id);
      const result = await callRpc(stub, 'prepareDeletion', {
        principal: identity.principal,
        incarnation: identity.incarnation,
        generation: identity.generation,
        expiresAt: loaded.session.expiresAt,
        opId: body.opId,
      }, ['ok', 'ticket', 'expiresAt']);
      if (!result.ok) return mapInternal(result.error);
      if (ticketParts(result.ticket)?.principal !== identity.principal) return failure('UNAVAILABLE', 503);
      if (loaded.session.expiresAt <= Date.now() || result.expiresAt <= Date.now()) return failure('AUTH_FAILED', 401);
      return mapRpcResponse(result, 'prepare');
    }
    const parts = ticketParts(body.ticket);
    if (!parts) return failure('AUTH_FAILED', 401);
    const id = env.ACCOUNT_AUTHORITY.idFromName(parts.principal);
    const stub = env.ACCOUNT_AUTHORITY.get(id);
    const result = await callRpc(stub, 'useDeletionTicket', {
      action: body.action,
      ticket: body.ticket,
    }, ['ok', 'status']);
    if (!result.ok) return mapInternal(result.error);
    if (body.action === 'delete' && result.status === 'prepared') return failure('UNAVAILABLE', 503);
    return mapRpcResponse(result, body.action);
  } catch (error) {
    return mapInternal(internalError(error?.message));
  }
}

function mapRpcResponse(result, action) {
  if (!result.ok) return mapInternal(result.error);
  if (action === 'prepare') return response(result, 200);
  return response(result, result.status === 'pending' ? 202 : 200);
}
import { accountOriginAllowed } from './account-http-origin.js';
