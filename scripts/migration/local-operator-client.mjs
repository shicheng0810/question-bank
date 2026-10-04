import {validReportAdminCommand,safeReportAdminResult} from '../../do-worker/src/report-admin-dto.js';
import { validAdminItemsCommand, safeAdminItemsResult } from '../../do-worker/src/native-admin-items-dto.js';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { unstable_dev } from 'wrangler';
import { safeSourceDiagnostics } from '../../do-worker/src/source-diagnostics-dto.js';
import {safeNativeConversionInventory,validNativeConversionCommand,safeNativeConversionResult} from '../../do-worker/src/native-conversion-dto.js';
import {safeNativeAdminStatus} from '../../do-worker/src/native-admin-status-dto.js';
import {safeNativeIdentityStatus} from '../../do-worker/src/native-identity-status-dto.js';
import {validateSourceDispositionCommand,safeSourceDispositionResult} from '../../do-worker/src/legacy-source-disposition.js';

const METHODS = new Set(['inspectReportOperationSummaries','inspectNativeAdminItems','declareNativeSourceDisposition','inspectSource', 'inspectAuthority', 'inspectSourceDiagnostics', 'inspectAuthorityByPrincipal', 'inspectNativeIdentity', 'inspectNativeIdentityByPrincipal', 'inspectNativeConversionInventory','inspectNativeAdminStatus','convertNativeHistory','convertNativeBank','migrate', 'delete', 'deleteLegacySource']);
const START_TIMEOUT_MS = 45000;
const RPC_TIMEOUT_MS = 15000;
const STOP_TIMEOUT_MS = 8000;
const WORKER_PATH = fileURLToPath(new URL('./remote-operator-adapter-worker.mjs', import.meta.url));
const CONFIG_PATH = fileURLToPath(new URL('./remote-operator-adapter.wrangler.jsonc', import.meta.url));

function unavailable() { throw new Error('MIGRATION_OPERATOR_UNAVAILABLE'); }

function timeout(promise, duration, code) {
  let timer;
  const timed = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(code)), duration);
  });
  return Promise.race([promise, timed]).finally(() => clearTimeout(timer));
}

function validArgs(method, args) {
  if(method==='inspectReportOperationSummaries')return validReportAdminCommand(args);
  if (method === 'inspectNativeAdminItems') return validAdminItemsCommand(args);
  if(method==='declareNativeSourceDisposition'){try{validateSourceDispositionCommand(args);return true;}catch{return false;}}
  if(method==='convertNativeHistory'||method==='convertNativeBank')return validNativeConversionCommand(args);
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const keys = Object.keys(args).sort();
  const exact = expected => keys.length === expected.length && expected.every((key, index) => key === keys[index]);
  if (method === 'inspectSource' || method === 'inspectAuthority' || method === 'inspectSourceDiagnostics' || method === 'inspectNativeIdentity') {
    return exact(['objectId']) && typeof args.objectId === 'string' && args.objectId.length > 0 && args.objectId.length <= 128;
  }
  if (method === 'migrate' || method === 'inspectAuthorityByPrincipal' || method === 'inspectNativeIdentityByPrincipal'||method==='inspectNativeConversionInventory'||method==='inspectNativeAdminStatus') return exact(['principal']) && /^[0-9a-f]{64}$/.test(args.principal);
  if (method === 'delete') return exact(['expectedFence', 'incarnation', 'opId', 'principal'])
    && /^[0-9a-f]{64}$/.test(args.principal) && /^[0-9a-f]{64}$/.test(args.incarnation)
    && Number.isSafeInteger(args.expectedFence) && args.expectedFence >= 0
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(args.opId);
  return exact(['opId', 'principal']) && /^[0-9a-f]{64}$/.test(args.principal)
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(args.opId);
}

function safePlainResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) unavailable();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) unavailable();
  const output = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'symbol') unavailable();
    if (key === 'token' || key === 'session' || key === 'payload' || key === 'raw') unavailable();
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (!desc || !('value' in desc) || typeof desc.value === 'function') unavailable();
    output[key] = desc.value;
  }
  return output;
}

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '[::1]';
}

export function createStartPreview(startDev) {
  return async capability => startDev(WORKER_PATH, {
    config: CONFIG_PATH,
    local: false,
    ip: '127.0.0.1',
    port: 0,
    persist: false,
    logLevel: 'none',
    compatibilityDate: '2025-06-01',
    services: [{ binding: 'MIGRATION_OPERATOR', service: 'qb-do', entrypoint: 'MigrationOperator', remote: true }],
    vars: { RPC_CAPABILITY: capability },
    experimental: { disableExperimentalWarning: true, disableDevRegistry: true, testMode: true },
  });
}

export function createMigrationOperatorClient({ startPreview = createStartPreview(unstable_dev),
  random = () => randomBytes(32).toString('hex'), startTimeoutMs = START_TIMEOUT_MS,
  rpcTimeoutMs = RPC_TIMEOUT_MS, stopTimeoutMs = STOP_TIMEOUT_MS } = {}) {
  async function withOperator(callback) {
    if (typeof callback !== 'function') throw new Error('INVALID_MIGRATION_OPERATOR_CALL');
    const capability = random();
    if (typeof capability !== 'string' || !/^[0-9a-f]{64}$/.test(capability)) unavailable();
    let preview;
    let open = true;
    let startupTimedOut = false;
    let startPromise;
    try {
      startPromise = Promise.resolve().then(() => startPreview(capability));
      // If timeout wins, a late preview is still stopped as soon as it resolves.
      startPromise.then(late => { if (startupTimedOut) return late?.stop?.(); return undefined; }).catch(() => {});
      try { preview = await timeout(startPromise, startTimeoutMs, 'MIGRATION_PREVIEW_START_TIMEOUT'); }
      catch (error) {
        if (error?.message === 'MIGRATION_PREVIEW_START_TIMEOUT') startupTimedOut = true;
        throw error;
      }
      if (!preview || typeof preview.fetch !== 'function' || typeof preview.stop !== 'function'
        || !isLoopback(preview.address) || !Number.isSafeInteger(preview.port) || preview.port < 1 || preview.port > 65535) unavailable();
      const call = async (method, args) => {
        if (!open || !METHODS.has(method) || !validArgs(method, args)) throw new Error('INVALID_MIGRATION_OPERATOR_CALL');
        let response;
        try {
          response = await timeout(preview.fetch(`http://${preview.address.includes(':') ? `[${preview.address.replace(/[\[\]]/g, '')}]` : preview.address}:${preview.port}/rpc`, {
            method: 'POST',
            headers: { authorization: `Bearer ${capability}`, 'content-type': 'application/json' },
            body: JSON.stringify({ method, args }),
            signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
          }), rpcTimeoutMs, 'MIGRATION_OPERATOR_RPC_TIMEOUT');
          if (!response || response.status !== 200) unavailable();
          const contentType = response.headers?.get?.('content-type') || '';
          if (!contentType.startsWith('application/json')) unavailable();
          const length = response.headers?.get?.('content-length');
          if (length !== null && length !== undefined && (!/^\d+$/.test(length) || Number(length) > 16384)) unavailable();
          const body = await timeout((async () => {
            const reader = response.body?.getReader?.();
            if (!reader) unavailable();
            const chunks = [];
            let total = 0;
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                total += value.byteLength;
                if (total > 16384) { await reader.cancel(); unavailable(); }
                chunks.push(value);
              }
            } finally { reader.releaseLock(); }
            const bytes = new Uint8Array(total);
            let offset = 0;
            for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
            return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          })(), rpcTimeoutMs, 'MIGRATION_OPERATOR_RPC_TIMEOUT');
          const result = safePlainResult(JSON.parse(body));
          if(method==='inspectReportOperationSummaries'){const safe=await safeReportAdminResult(result,args);if(!safe)unavailable();return safe;}
          if(method==='inspectNativeAdminItems'){const safe=safeAdminItemsResult(result,args);if(!safe)unavailable();return safe;}
          if(method==='inspectNativeAdminStatus'){if(result.ok===false&&Object.keys(result).length===2&&/^[A-Z][A-Z0-9_]{0,63}$/.test(result.error||''))return result;const safe=safeNativeAdminStatus(result);if(!safe||safe.principal!==args.principal)unavailable();return safe;}
          if(method==='inspectNativeIdentity'||method==='inspectNativeIdentityByPrincipal'){
            if(result.ok===false&&Object.keys(result).length===2&&/^[A-Z][A-Z0-9_]{0,63}$/.test(result.error||''))return result;
            const safe=safeNativeIdentityStatus(result);
            if(!safe||method==='inspectNativeIdentityByPrincipal'&&safe.status==='observed'&&safe.principal!==args.principal)unavailable();
            return safe;
          }
          if(method==='declareNativeSourceDisposition'){if(result.ok===false&&Object.keys(result).length===2&&/^[A-Z][A-Z0-9_]{0,63}$/.test(result.error||''))return result;const safe=safeSourceDispositionResult(result,args);if(!safe)unavailable();return safe;}
          if(['inspectNativeConversionInventory','convertNativeHistory','convertNativeBank'].includes(method)){
            if(result.ok===false&&Object.keys(result).length===2&&typeof result.error==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(result.error))return result;
            const safe=method==='inspectNativeConversionInventory'?safeNativeConversionInventory(result):safeNativeConversionResult(result,method==='convertNativeBank'?'bank':'history');
            if(!safe||method==='inspectNativeConversionInventory'&&safe.principal!==args.principal)unavailable();return safe;
          }
          if (method === 'inspectSourceDiagnostics') {
            const diagnostic=safeSourceDiagnostics(result); if (!diagnostic) unavailable(); return diagnostic;
          }
          if (method === 'inspectAuthorityByPrincipal' && result.ok===true && result.status==='observed' && result.principal!==args.principal) unavailable();
          return result;
        } catch (error) {
          if (error?.message === 'INVALID_MIGRATION_OPERATOR_CALL') throw error;
          if (error?.message === 'MIGRATION_OPERATOR_RPC_TIMEOUT') throw error;
          unavailable();
        }
      };
      return await callback(call);
    } catch (error) {
      if (error?.message === 'INVALID_MIGRATION_OPERATOR_CALL' || error?.message === 'MIGRATION_PREVIEW_START_TIMEOUT'
        || error?.message === 'MIGRATION_OPERATOR_RPC_TIMEOUT') throw error;
      throw new Error('MIGRATION_OPERATOR_UNAVAILABLE');
    } finally {
      open = false;
      if (preview?.stop) {
        try { await timeout(Promise.resolve().then(() => preview.stop()), stopTimeoutMs, 'MIGRATION_PREVIEW_STOP_TIMEOUT'); }
        catch { throw new Error('MIGRATION_PREVIEW_CLEANUP_INCOMPLETE'); }
      }
    }
  }
  return Object.freeze({
    withOperator,
    call(method, args) { return withOperator(call => call(method, args)); },
  });
}

const defaultClient = createMigrationOperatorClient();

export function migrationOperatorCall(method, args) {
  return defaultClient.call(method, args);
}

export function withMigrationOperator(callback) {
  return defaultClient.withOperator(callback);
}
