import {validReportAdminCommand,safeReportAdminResult} from '../../do-worker/src/report-admin-dto.js';
import { validAdminItemsCommand, safeAdminItemsResult } from '../../do-worker/src/native-admin-items-dto.js';
import { safeSourceDiagnostics } from '../../do-worker/src/source-diagnostics-dto.js';
import {safeNativeConversionInventory,validNativeConversionCommand,safeNativeConversionResult} from '../../do-worker/src/native-conversion-dto.js';
import {safeNativeAdminStatus} from '../../do-worker/src/native-admin-status-dto.js';
import {safeNativeIdentityStatus} from '../../do-worker/src/native-identity-status-dto.js';
import {validateSourceDispositionCommand,safeSourceDispositionResult} from '../../do-worker/src/legacy-source-disposition.js';
const METHODS = new Set(['inspectReportOperationSummaries','inspectNativeAdminItems','declareNativeSourceDisposition','inspectSource', 'inspectAuthority', 'inspectSourceDiagnostics', 'inspectAuthorityByPrincipal','inspectNativeIdentity','inspectNativeIdentityByPrincipal','inspectNativeConversionInventory','inspectNativeAdminStatus','convertNativeHistory','convertNativeBank', 'migrate', 'delete', 'deleteLegacySource']);
const HEX64 = /^[0-9a-f]{64}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAFE_ERROR = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_REQUEST_BYTES = 4096;
const MAX_RESPONSE_BYTES = 16384;

function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' } });
}

function exactObject(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    && Reflect.ownKeys(value).length === keys.length
    && Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key))
    && keys.every(key => Object.hasOwn(value, key));
}

function equalSecret(expected, actual) {
  if (typeof expected !== 'string' || typeof actual !== 'string' || expected.length !== actual.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) difference |= expected.charCodeAt(index) ^ actual.charCodeAt(index);
  return difference === 0;
}

async function boundedText(request) {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_REQUEST_BYTES)) throw new Error('TOO_LARGE');
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new Error('TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const all = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(all);
}

function validateArgs(method, args) {
  if(method==='inspectReportOperationSummaries')return validReportAdminCommand(args);
  if (method === 'inspectNativeAdminItems') return validAdminItemsCommand(args);
  if (!METHODS.has(method)) return false;
  if(method==='declareNativeSourceDisposition'){try{validateSourceDispositionCommand(args);return true;}catch{return false;}}
  if(method==='convertNativeHistory'||method==='convertNativeBank')return validNativeConversionCommand(args);
  if (method === 'inspectSource' || method === 'inspectAuthority' || method === 'inspectSourceDiagnostics') {
    return exactObject(args, ['objectId']) && typeof args.objectId === 'string' && args.objectId.length > 0 && args.objectId.length <= 128;
  }
  if(method==='inspectNativeIdentity')return exactObject(args,['objectId'])&&typeof args.objectId==='string'&&args.objectId.length>0&&args.objectId.length<=128;
  if (method === 'migrate' || method === 'inspectAuthorityByPrincipal'||method==='inspectNativeIdentityByPrincipal'||method==='inspectNativeConversionInventory'||method==='inspectNativeAdminStatus') return exactObject(args, ['principal']) && HEX64.test(args.principal);
  if (method === 'delete') return exactObject(args, ['principal', 'incarnation', 'expectedFence', 'opId'])
    && HEX64.test(args.principal) && HEX64.test(args.incarnation) && Number.isSafeInteger(args.expectedFence)
    && args.expectedFence >= 0 && UUID_V4.test(args.opId);
  return exactObject(args, ['principal', 'opId']) && HEX64.test(args.principal) && UUID_V4.test(args.opId);
}

function safeErrorResult(value) {
  return exactObject(value, ['ok', 'error']) && value.ok === false && SAFE_ERROR.test(value.error);
}

async function safeResult(method, outcome, args) {
  if(method==='inspectReportOperationSummaries'){
    const dto={};for(const key of Reflect.ownKeys(outcome||{})){if(key===Symbol.dispose)continue;const d=Object.getOwnPropertyDescriptor(outcome,key);if(typeof key!=='string'||!d||!('value'in d))throw Error('INVALID_RESULT');dto[key]=d.value;}
    const safe=await safeReportAdminResult(dto,args);if(!safe)throw Error('INVALID_RESULT');return safe;
  }

  if (method === 'inspectNativeAdminItems') {
    const dto={}; for(const key of Reflect.ownKeys(outcome||{})){if(key===Symbol.dispose)continue;const d=Object.getOwnPropertyDescriptor(outcome,key);if(typeof key!=='string'||!d||!('value'in d))throw Error('INVALID_RESULT');dto[key]=d.value;}
    const safe=safeAdminItemsResult(dto,args);if(!safe)throw Error('INVALID_RESULT');return safe;
  }
  if(method==='declareNativeSourceDisposition'){
    const dto={};for(const key of Reflect.ownKeys(outcome||{})){if(key===Symbol.dispose)continue;const d=Object.getOwnPropertyDescriptor(outcome,key);if(typeof key!=='string'||!d||!('value'in d))throw Error('INVALID_RESULT');dto[key]=d.value;}
    if(safeErrorResult(dto))return dto;const safe=safeSourceDispositionResult(dto,args);if(!safe)throw Error('INVALID_RESULT');return safe;
  }
  if(['inspectNativeConversionInventory','inspectNativeAdminStatus','convertNativeHistory','convertNativeBank'].includes(method)){
    const dto={};for(const key of Reflect.ownKeys(outcome||{})){if(key===Symbol.dispose)continue;const d=Object.getOwnPropertyDescriptor(outcome,key);if(typeof key!=='string'||!d||!('value'in d))throw Error('INVALID_RESULT');dto[key]=d.value;}
    if(safeErrorResult(dto))return dto;
    const safe=method==='inspectNativeAdminStatus'?safeNativeAdminStatus(dto):method==='inspectNativeConversionInventory'?safeNativeConversionInventory(dto):safeNativeConversionResult(dto,method==='convertNativeBank'?'bank':'history');
    if(!safe)throw Error('INVALID_RESULT');return safe;
  }
  if(method==='inspectNativeIdentity'||method==='inspectNativeIdentityByPrincipal'){
    const dto={};for(const key of Reflect.ownKeys(outcome||{})){if(key===Symbol.dispose)continue;const d=Object.getOwnPropertyDescriptor(outcome,key);if(typeof key!=='string'||!d||!('value'in d))throw Error('INVALID_RESULT');dto[key]=d.value;}
    if(safeErrorResult(dto))return dto;
    const safe=safeNativeIdentityStatus(dto);if(!safe||method==='inspectNativeIdentityByPrincipal'&&safe.status==='observed'&&safe.principal!==args.principal)throw Error('INVALID_RESULT');return safe;
  }
  if (method === 'inspectSourceDiagnostics') { const diagnostic=safeSourceDiagnostics(outcome); if (!diagnostic) throw new Error('INVALID_RESULT'); return diagnostic; }
  if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)
    || (Object.getPrototypeOf(outcome) !== Object.prototype && Object.getPrototypeOf(outcome) !== null)) throw new Error('INVALID_RESULT');
  const allowed = method === 'inspectSource'
    ? ['ok', 'error', 'sub', 'imported', 'historyCount', 'bankCount', 'frozen', 'deleted']
    : method === 'inspectAuthority' || method === 'inspectAuthorityByPrincipal'
      ? ['ok', 'error', 'status', 'principal', 'phase', 'incarnation', 'fence', 'policy', 'archiveStatus', 'archivePhase',
        'historyDone', 'historyTotal', 'bankDone', 'bankTotal', 'manifestSha256']
      : method === 'migrate' ? ['ok', 'error', 'status', 'reason', 'migration']
        : method === 'delete' ? ['ok', 'error', 'status'] : ['ok', 'error', 'status', 'deletedBanks'];
  const dto = Object.create(null);
  for (const key of Reflect.ownKeys(outcome)) {
    if (key === Symbol.dispose) continue;
    if (typeof key !== 'string' || !allowed.includes(key)) throw new Error('INVALID_RESULT');
    const descriptor = Object.getOwnPropertyDescriptor(outcome, key);
    if (!descriptor || !('value' in descriptor)) throw new Error('INVALID_RESULT');
    dto[key] = descriptor.value;
  }
  let valid = safeErrorResult(dto);
  if (method === 'inspectSource' && exactObject(dto,
    ['ok', 'sub', 'imported', 'historyCount', 'bankCount', 'frozen', 'deleted'])) {
    valid = dto.ok === true && (dto.sub === null || HEX64.test(dto.sub)) && typeof dto.imported === 'boolean'
      && Number.isSafeInteger(dto.historyCount) && dto.historyCount >= 0
      && Number.isSafeInteger(dto.bankCount) && dto.bankCount >= 0
      && typeof dto.frozen === 'boolean' && typeof dto.deleted === 'boolean';
  }
  if (method === 'inspectAuthority' || method === 'inspectAuthorityByPrincipal') {
    if (exactObject(dto, ['ok', 'status']) && dto.ok === true && dto.status === 'empty') valid = true;
    const keys = ['ok', 'status', 'principal', 'phase', 'incarnation', 'fence', 'policy', 'archiveStatus', 'archivePhase',
      'historyDone', 'historyTotal', 'bankDone', 'bankTotal', 'manifestSha256'];
    if (exactObject(dto, keys)) {
      const reasons = ['legacy-account-v1', 'no-legacy-source', 'retired-re-registration', 'orphaned-source',
        'legacy-deleted-re-registration', 'ADMIN_LEGACY_SOURCE_DELETION'];
      const policy = dto.policy === null || (exactObject(dto.policy, ['mode', 'reason'])
        && ['legacy', 'no-import'].includes(dto.policy.mode)
        && (dto.policy.mode === 'legacy' ? dto.policy.reason === 'legacy-account-v1' : reasons.includes(dto.policy.reason)));
      valid = dto.ok === true && dto.status === 'observed' && HEX64.test(dto.principal)
        && ['active', 'deleting', 'retired'].includes(dto.phase) && HEX64.test(dto.incarnation)
        && Number.isSafeInteger(dto.fence) && dto.fence >= 0 && policy
        && (dto.archiveStatus === null || ['staging', 'sealed', 'deleted', 'quarantined', 'none'].includes(dto.archiveStatus))
        && (dto.archivePhase === null || ['history', 'banks', 'verify', 'complete'].includes(dto.archivePhase))
        && ['historyDone', 'historyTotal', 'bankDone', 'bankTotal'].every(key => Number.isSafeInteger(dto[key]) && dto[key] >= 0)
        && (dto.manifestSha256 === null || HEX64.test(dto.manifestSha256));
    }
  }
  if (method === 'migrate') {
    if (exactObject(dto, ['ok', 'status']) && dto.ok === true && dto.status === 'complete') valid = true;
    if (exactObject(dto, ['ok', 'status', 'reason']) && dto.ok === true && dto.status === 'skipped'
      && ['no-authority', 'retired', 'deleted', 'orphaned', 'no-legacy-source', 'no-import-policy'].includes(dto.reason)) valid = true;
    if (exactObject(dto, ['ok', 'status', 'migration']) && dto.ok === true && dto.status === 'pending') {
      const progress = dto.migration;
      valid = (exactObject(progress, ['phase', 'processed', 'total'])
        || (exactObject(progress, ['status', 'phase', 'processed', 'total']) && progress.status === 'running'))
        && ['history', 'banks', 'verify'].includes(progress.phase)
        && Number.isSafeInteger(progress.processed) && progress.processed >= 0
        && Number.isSafeInteger(progress.total) && progress.total >= progress.processed;
    }
  }
  if (method === 'delete' && exactObject(dto, ['ok', 'status']) && dto.ok === true
    && ['pending', 'complete'].includes(dto.status)) valid = true;
  if (method === 'deleteLegacySource' && exactObject(dto, ['ok', 'status', 'deletedBanks']) && dto.ok === true
    && ['pending', 'complete'].includes(dto.status) && Number.isSafeInteger(dto.deletedBanks)
    && dto.deletedBanks >= 0 && dto.deletedBanks <= 15) valid = true;
  if (!valid) throw new Error('INVALID_RESULT');
  const response = JSON.stringify(dto);
  if (new TextEncoder().encode(response).byteLength > MAX_RESPONSE_BYTES) throw new Error('INVALID_RESULT');
  return dto;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/rpc' || url.search || request.method !== 'POST' || request.headers.has('origin')) {
      return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });
    }
    const authorization = request.headers.get('authorization') || '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!equalSecret(env.RPC_CAPABILITY, token)) return json({ ok: false, error: 'UNAUTHORIZED' }, 401);
    if (request.headers.get('content-type') !== 'application/json') return json({ ok: false, error: 'INVALID_INPUT' }, 415);
    let body;
    try { body = JSON.parse(await boundedText(request)); }
    catch (error) { return json({ ok: false, error: error?.message === 'TOO_LARGE' ? 'TOO_LARGE' : 'INVALID_INPUT' }, 400); }
    if (!exactObject(body, ['method', 'args']) || !validateArgs(body.method, body.args)
      || typeof env.MIGRATION_OPERATOR?.[body.method] !== 'function') return json({ ok: false, error: 'INVALID_INPUT' }, 400);
    let outcome;
    try {
      outcome = await env.MIGRATION_OPERATOR[body.method](body.args);
      const result=await safeResult(body.method, outcome, body.args);
      if (body.method==='inspectAuthorityByPrincipal' && result.ok===true && result.status==='observed' && result.principal!==body.args.principal) throw new Error('INVALID_RESULT');
      return json(result);
    } catch {
      return json({ ok: false, error: 'RPC_UNAVAILABLE' }, 502);
    } finally {
      const descriptor = outcome && Object.getOwnPropertyDescriptor(outcome, Symbol.dispose);
      if (descriptor && 'value' in descriptor && typeof descriptor.value === 'function') await descriptor.value.call(outcome);
    }
  },
};
