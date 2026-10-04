import { validGeneration } from '../../do-worker/src/generation-transition.js';
import {ACCOUNT_TOKEN_PATTERN,SESSION_V3_FLAG,v3Route,sessionV3Hash} from '../../do-worker/src/account-session-v3.js';

const TOKEN = ACCOUNT_TOKEN_PATTERN;
const SUBJECT = /^[0-9a-f]{64}$/;
const SESSION_PREFIX = 'g3:session:';

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

export function bearerToken(request) {
  const value = request.headers.get('Authorization') || '';
  const match = value.match(/^Bearer\s+(\S+)$/i);
  return match?.[1] || null;
}

export function parseAccountSession(raw) {
  if (typeof raw !== 'string' || raw.length > 1024) return null;
  let session;
  try {
    session = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!exactRecord(session, ['sub', 'generation', 'expiresAt'])
    || typeof session.sub !== 'string' || !SUBJECT.test(session.sub)
    || !validGeneration(session.generation) || !Number.isSafeInteger(session.expiresAt)
    || session.expiresAt <= Date.now()) return null;
  return {
    sub: session.sub,
    generation: session.generation,
    expiresAt: session.expiresAt,
  };
}

export async function loadAccountSession(request, env) {
  const token = bearerToken(request);
  if (!token || !TOKEN.test(token)) return { ok: false, error: 'INVALID_CREDENTIALS' };
  const route=v3Route(token);
  if(route){
    if(env?.[SESSION_V3_FLAG]!=='1')return {ok:false,error:'INVALID_CREDENTIALS'};
    try{
      const stub=env.GENERATION_STORE.getByName(route);
      const outcome=await stub.loadSessionTrusted({tokenHash:await sessionV3Hash(token)});
      if(!outcome||outcome.ok!==true)return {ok:false,error:outcome?.error==='INVALID_CREDENTIALS'?'INVALID_CREDENTIALS':'UNAVAILABLE'};
      if(Object.keys(outcome).sort().join()!=='ok,session')return {ok:false,error:'UNAVAILABLE'};
      const session=parseAccountSession(JSON.stringify(outcome.session));
      if(!session||session.sub!==route)return {ok:false,error:'INVALID_CREDENTIALS'};
      return {ok:true,token,session};
    }catch{return {ok:false,error:'UNAVAILABLE'};}
  }
  if (!env?.GENERATION_SESSIONS || typeof env.GENERATION_SESSIONS.get !== 'function') {
    return { ok: false, error: 'NOT_CONFIGURED' };
  }
  let raw;
  try {
    raw = await env.GENERATION_SESSIONS.get(`${SESSION_PREFIX}${token}`);
  } catch {
    return { ok: false, error: 'UNAVAILABLE' };
  }
  const session = parseAccountSession(raw);
  if (!session || session.expiresAt <= Date.now()) return { ok: false, error: 'INVALID_CREDENTIALS' };
  return { ok: true, token, session };
}

export function tokenPattern() {
  return TOKEN;
}
