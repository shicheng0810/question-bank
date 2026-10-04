import { readLegacyJson } from './legacy-input.js';
import {ACCOUNT_TOKEN_PATTERN,v3Route} from '../../do-worker/src/account-session-v3.js';
import {loadVerifiedAccountIdentity} from './account-session-handler.js';
import {
  cloneState,
  validGeneration,
  validateData,
  validateState,
} from '../../do-worker/src/generation-transition.js';

const TOKEN = ACCOUNT_TOKEN_PATTERN;
const SUBJECT = /^[0-9a-f]{64}$/;
const BODY_LIMIT = 65536;
const MAX_DEPTH = 32;
const RPC_DISPOSER = Symbol.dispose;
const ERROR_STATUS = Object.freeze({
  INVALID_SESSION: 401,
  INVALID_INPUT: 400,
  NOT_INITIALIZED: 404,
  STALE_GENERATION: 409,
  ACCOUNT_DELETED: 410,
  REVISION_EXHAUSTED: 409,
});

function jsonHeaders(extra = {}) {
  return {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  };
}

function reply(status, error, extraHeaders = {}) {
  return new Response(JSON.stringify({ ok: false, error }), {
    status,
    headers: jsonHeaders(extraHeaders),
  });
}

function success(state) {
  return new Response(JSON.stringify({ ok: true, state }), {
    status: 200,
    headers: jsonHeaders(),
  });
}

function exactRecord(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_INPUT');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error('INVALID_INPUT');
  const actual = Reflect.ownKeys(value);
  if (actual.some((key) => typeof key !== 'string') || actual.length !== keys.length || keys.some((key) => !actual.includes(key))) {
    throw new Error('INVALID_INPUT');
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) throw new Error('INVALID_INPUT');
  }
}

function authToken(request) {
  const value = request.headers.get('Authorization') || '';
  const match = value.match(/^Bearer\s+(\S+)$/i);
  return match?.[1] || null;
}

function parseSession(raw) {
  if (typeof raw !== 'string' || raw.length > 1024) return null;
  let session;
  try {
    session = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!session || typeof session !== 'object' || Array.isArray(session)) return null;
  try {
    exactRecord(session, ['sub', 'generation', 'expiresAt']);
  } catch {
    return null;
  }
  if (typeof session.sub !== 'string' || !SUBJECT.test(session.sub) || !validGeneration(session.generation)
    || !Number.isSafeInteger(session.expiresAt) || session.expiresAt <= Date.now()) return null;
  return session;
}

function depthWithinLimit(data) {
  const stack = [{ value: data, depth: 1 }];
  while (stack.length) {
    const { value, depth } = stack.pop();
    if (value === null || typeof value !== 'object') continue;
    if (depth > MAX_DEPTH) return false;
    if (Array.isArray(value)) {
      for (const child of value) stack.push({ value: child, depth: depth + 1 });
    } else {
      for (const key of Reflect.ownKeys(value)) stack.push({ value: value[key], depth: depth + 1 });
    }
  }
  return true;
}

function validBody(value) {
  try {
    exactRecord(value, ['data']);
    if (!depthWithinLimit(value.data)) return false;
    validateData(value.data);
    return true;
  } catch {
    return false;
  }
}

function mappedError(code) {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(ERROR_STATUS, code)
    ? { status: ERROR_STATUS[code], error: code }
    : { status: 503, error: 'UNAVAILABLE' };
}

function malformedOutcome() {
  return reply(503, 'UNAVAILABLE');
}

function exactOutcomeRecord(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_INPUT');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error('INVALID_INPUT');
  const actual = Reflect.ownKeys(value);
  const symbols = actual.filter((key) => typeof key === 'symbol');
  if (symbols.length > 0) {
    if (RPC_DISPOSER === undefined || symbols.length !== 1 || symbols[0] !== RPC_DISPOSER) throw new Error('INVALID_INPUT');
    const descriptor = Object.getOwnPropertyDescriptor(value, RPC_DISPOSER);
    if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function') throw new Error('INVALID_INPUT');
  }
  const strings = actual.filter((key) => typeof key === 'string');
  if (strings.length !== keys.length || strings.some((key) => !keys.includes(key))) throw new Error('INVALID_INPUT');
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) throw new Error('INVALID_INPUT');
  }
}

function handleOutcome(outcome) {
  if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) return malformedOutcome();
  const okDescriptor = Object.getOwnPropertyDescriptor(outcome, 'ok');
  if (!okDescriptor || !('value' in okDescriptor)) return malformedOutcome();
  if (okDescriptor.value === true) {
    try {
      exactOutcomeRecord(outcome, ['ok', 'state']);
      validateState(outcome.state);
      return success(cloneState(outcome.state));
    } catch {
      return malformedOutcome();
    }
  }
  if (okDescriptor.value === false) {
    try {
      exactOutcomeRecord(outcome, ['ok', 'error']);
    } catch {
      return malformedOutcome();
    }
    if (typeof outcome.error !== 'string') return malformedOutcome();
    const mapped = mappedError(outcome.error);
    return reply(mapped.status, mapped.error);
  }
  return malformedOutcome();
}

function disposeOutcome(outcome) {
  if (!outcome || typeof outcome !== 'object' || RPC_DISPOSER === undefined) return;
  const descriptor = Object.getOwnPropertyDescriptor(outcome, RPC_DISPOSER);
  if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function') return;
  try {
    descriptor.value.call(outcome);
  } catch {
    // Disposal failures must not replace or expose the already-built response.
  }
}

export async function handleGenerationState({ request, env }) {
  if (env?.GEN03_STATE_API !== '1') return reply(404, 'FEATURE_DISABLED');

  if (request.method !== 'GET' && request.method !== 'PUT') {
    return reply(405, 'METHOD_NOT_ALLOWED', { Allow: 'GET, PUT' });
  }

  const origin = request.headers.get('Origin');
  if (origin !== null && origin !== new URL(request.url).origin) return reply(403, 'ORIGIN_NOT_ALLOWED');

  if (!env?.GENERATION_SESSIONS || typeof env.GENERATION_SESSIONS.get !== 'function'
    || !env?.GENERATION_STORE || typeof env.GENERATION_STORE.getByName !== 'function') {
    return reply(503, 'NOT_CONFIGURED');
  }

  const token = authToken(request);
  if (!token || !TOKEN.test(token)) return reply(401, 'INVALID_SESSION');

  let raw,session;
  if(v3Route(token)){
    try{const identity=await loadVerifiedAccountIdentity(request,env);session={sub:identity.incarnation,generation:identity.generation,expiresAt:identity.expiresAt};}
    catch(error){return reply(error.message==='INVALID_CREDENTIALS'?401:503,error.message==='INVALID_CREDENTIALS'?'INVALID_SESSION':'UNAVAILABLE');}
  }else{
  try {
    raw = await env.GENERATION_SESSIONS.get(`g3:session:${token}`);
  } catch {
    return reply(503, 'UNAVAILABLE');
  }
  session = parseSession(raw);
  }
  if (!session) return reply(401, 'INVALID_SESSION');

  let action;
  if (request.method === 'GET') {
    action = { type: 'read' };
  } else {
    const contentType = request.headers.get('Content-Type') || '';
    const mediaType = contentType.split(';', 1)[0].trim().toLowerCase();
    if (mediaType !== 'application/json') return reply(415, 'UNSUPPORTED_MEDIA_TYPE');
    const body = await readLegacyJson(request, BODY_LIMIT);
    if (body.error === 'too_large') return reply(413, 'TOO_LARGE');
    if (!body.ok || !validBody(body.value)) return reply(400, 'INVALID_INPUT');
    action = { type: 'write', data: body.value.data };
  }

  let outcome;
  try {
    const stub = env.GENERATION_STORE.getByName(session.sub);
    if (!stub || typeof stub.execute !== 'function') return reply(503, 'UNAVAILABLE');
    outcome = await stub.execute({ generation: session.generation, expiresAt: session.expiresAt }, action);
    return handleOutcome(outcome);
  } catch {
    return reply(503, 'UNAVAILABLE');
  } finally {
    disposeOutcome(outcome);
  }
}
