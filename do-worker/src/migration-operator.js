import {validReportAdminCommand,reportAdminPage,safeReportAdminResult,REPORT_ADMIN_MAX_BYTES} from './report-admin-dto.js';
import { validAdminItemsCommand, safeAdminItemsResult } from './native-admin-items-dto.js';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { safeSourceDiagnostics } from './source-diagnostics-dto.js';
import {safeNativeConversionInventory} from './native-conversion-dto.js';
import {validateSourceDispositionCommand} from './legacy-source-disposition.js';
import {safeNativeAdminStatus} from './native-admin-status-dto.js';
import {safeNativeIdentityStatus} from './native-identity-status-dto.js';
import {validNativeProofCommand,safeNativeProofResult} from './native-conversion-proof.js';

const HEX64 = /^[0-9a-f]{64}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SAFE_REASON = /^(?:[A-Z][A-Z0-9_]{0,63})$/;
const RPC_DISPOSER = Symbol.dispose;

function invalid() { return { ok: false, error: 'INVALID_INPUT' }; }
function unavailable() { return { ok: false, error: 'UNAVAILABLE' }; }

function exactRecord(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const ownKeys = Reflect.ownKeys(value);
  return ownKeys.length === keys.length && ownKeys.every(key => typeof key === 'string' && keys.includes(key))
    && keys.every(key => Object.hasOwn(value, key) && Object.getOwnPropertyDescriptor(value, key)?.get === undefined
      && Object.getOwnPropertyDescriptor(value, key)?.set === undefined);
}

function validNamespace(namespace, { stringId = false } = {}) {
  return namespace && typeof namespace.get === 'function'
    && typeof (stringId ? namespace.idFromString : namespace.idFromName) === 'function';
}

async function callRpc(namespace, lookup, key, method, args) {
  if (!validNamespace(namespace, { stringId: lookup === 'id' })) throw new Error('NOT_CONFIGURED');
  const id = lookup === 'id' ? namespace.idFromString(key) : namespace.idFromName(key);
  const stub = namespace.get(id);
  if (!stub || typeof stub[method] !== 'function') throw new Error('NOT_CONFIGURED');
  let outcome;
  try {
    outcome = await stub[method](...args);
    if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) throw new Error('UNAVAILABLE');
    const prototype = Object.getPrototypeOf(outcome);
    if (prototype !== Object.prototype && prototype !== null) throw new Error('UNAVAILABLE');
    const result = Object.create(null);
    for (const key of Reflect.ownKeys(outcome)) {
      if (typeof key !== 'string') {
        if (key !== RPC_DISPOSER) throw new Error('UNAVAILABLE');
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(outcome, key);
      if (!descriptor || !('value' in descriptor)) throw new Error('UNAVAILABLE');
      result[key] = descriptor.value;
    }
    return result;
  } finally {
    if (outcome && typeof outcome === 'object' && RPC_DISPOSER && typeof outcome[RPC_DISPOSER] === 'function') {
      await outcome[RPC_DISPOSER]();
    }
    if (stub && RPC_DISPOSER && typeof stub[RPC_DISPOSER] === 'function') await stub[RPC_DISPOSER]();
  }
}

function safeFailure(result) {
  return exactRecord(result, ['ok', 'error']) && result.ok === false && typeof result.error === 'string'
    && SAFE_REASON.test(result.error) ? { ok: false, error: result.error } : unavailable();
}

function safeNativeIdentity(result) {
  if (exactRecord(result, ['ok', 'error'])) return safeFailure(result);
  return safeNativeIdentityStatus(result) || unavailable();
}

function safeSource(result) {
  if (exactRecord(result, ['ok', 'error'])) return safeFailure(result);
  if (!exactRecord(result, ['ok', 'sub', 'imported', 'historyCount', 'bankCount', 'frozen', 'deleted'])
    || result.ok !== true || !(result.sub === null || HEX64.test(result.sub))
    || typeof result.imported !== 'boolean' || typeof result.frozen !== 'boolean' || typeof result.deleted !== 'boolean'
    || !Number.isSafeInteger(result.historyCount) || result.historyCount < 0
    || !Number.isSafeInteger(result.bankCount) || result.bankCount < 0) return unavailable();
  return { ok: true, sub: result.sub, imported: result.imported, historyCount: result.historyCount,
    bankCount: result.bankCount, frozen: result.frozen, deleted: result.deleted };
}

function safeAuthorityStatus(result) {
  if (exactRecord(result, ['ok', 'error'])) return safeFailure(result);
  if (exactRecord(result, ['ok', 'status']) && result.ok === true && result.status === 'empty') return { ok: true, status: 'empty' };
  const keys = ['ok', 'status', 'principal', 'phase', 'incarnation', 'fence', 'policy', 'archiveStatus',
    'archivePhase', 'historyDone', 'historyTotal', 'bankDone', 'bankTotal', 'manifestSha256'];
  const policyReasons = ['legacy-account-v1', 'no-legacy-source', 'retired-re-registration',
    'orphaned-source', 'legacy-deleted-re-registration', 'ADMIN_LEGACY_SOURCE_DELETION'];
  if (!exactRecord(result, keys) || result.ok !== true || result.status !== 'observed'
    || !HEX64.test(result.principal) || !['active', 'deleting', 'retired'].includes(result.phase)
    || !HEX64.test(result.incarnation) || !Number.isSafeInteger(result.fence) || result.fence < 0
    || !(result.policy === null || (exactRecord(result.policy, ['mode', 'reason'])
      && ['legacy', 'no-import'].includes(result.policy.mode)
      && (result.policy.mode === 'legacy' ? result.policy.reason === 'legacy-account-v1'
        : policyReasons.includes(result.policy.reason))))
    || !(result.archiveStatus === null || ['staging', 'sealed', 'deleted', 'quarantined', 'none'].includes(result.archiveStatus))
    || !(result.archivePhase === null || ['history', 'banks', 'verify', 'complete'].includes(result.archivePhase))
    || !['historyDone', 'historyTotal', 'bankDone', 'bankTotal'].every(key => Number.isSafeInteger(result[key]) && result[key] >= 0)
    || !(result.manifestSha256 === null || HEX64.test(result.manifestSha256))) return unavailable();
  return Object.fromEntries(keys.map(key => [key, result[key]]));
}

function safeMigration(result) {
  if (exactRecord(result, ['ok', 'error'])) return safeFailure(result);
  if (exactRecord(result, ['ok', 'status']) && result.ok === true && result.status === 'complete') {
    return { ok: true, status: 'complete' };
  }
  if (exactRecord(result, ['ok', 'status', 'reason']) && result.ok === true && result.status === 'skipped'
    && ['no-authority', 'retired', 'deleted', 'orphaned', 'no-legacy-source', 'no-import-policy'].includes(result.reason)) {
    return { ok: true, status: 'skipped', reason: result.reason };
  }
  if (exactRecord(result, ['ok', 'status', 'migration']) && result.ok === true && result.status === 'pending'
    && (exactRecord(result.migration, ['phase', 'processed', 'total'])
      || (exactRecord(result.migration, ['status', 'phase', 'processed', 'total']) && result.migration.status === 'running'))
    && ['history', 'banks', 'verify'].includes(result.migration.phase)
    && Number.isSafeInteger(result.migration.processed) && result.migration.processed >= 0
    && Number.isSafeInteger(result.migration.total) && result.migration.total >= result.migration.processed) {
    return { ok: true, status: 'pending', migration: {
      phase: result.migration.phase, processed: result.migration.processed, total: result.migration.total,
    } };
  }
  return unavailable();
}

function safeDelete(result) {
  if (exactRecord(result, ['ok', 'error'])) return safeFailure(result);
  if (exactRecord(result, ['ok', 'status']) && result.ok === true && ['pending', 'complete'].includes(result.status)) {
    return { ok: true, status: result.status };
  }
  return unavailable();
}

function safeLegacySourceDelete(result) {
  if (exactRecord(result, ['ok', 'error'])) return safeFailure(result);
  if (exactRecord(result, ['ok', 'status', 'deletedBanks']) && result.ok === true
    && ['pending', 'complete'].includes(result.status)
    && Number.isSafeInteger(result.deletedBanks) && result.deletedBanks >= 0 && result.deletedBanks <= 15) {
    return { ok: true, status: result.status, deletedBanks: result.deletedBanks };
  }
  return unavailable();
}

export class MigrationOperator extends WorkerEntrypoint {
  // Global public Report metadata. Authorization is the existing private
  // service caller, not an account principal or an ordinary session.
  async inspectReportOperationSummaries(command){
    if(!validReportAdminCommand(command))return invalid();
    if(!validNamespace(this.env.REPORT_OPERATIONS))return {ok:false,error:'NOT_CONFIGURED'};
    let page;try{page=await reportAdminPage(command);}catch{return {ok:false,error:'REPORT_CURSOR_STALE'};}
    const items=[];
    try{for(const id of page.selected){
      const summary=await callRpc(this.env.REPORT_OPERATIONS,'name',id,'inspectSummaryTrusted',[id]);
      const end=page.offset+items.length+1,trial={ok:true,scope:'provided-operation-ids',partial:true,knownOperationCount:page.ids.length,items:[...items,summary],cursor:end<page.ids.length?`${page.scope}:${end}`:null,snapshot:'live-read-not-snapshot'};
      if(new TextEncoder().encode(JSON.stringify(trial)).byteLength>REPORT_ADMIN_MAX_BYTES){if(!items.length)return unavailable();break;}items.push(summary);
    }
    const end=page.offset+items.length,result={ok:true,scope:'provided-operation-ids',partial:true,knownOperationCount:page.ids.length,items,cursor:end<page.ids.length?`${page.scope}:${end}`:null,snapshot:'live-read-not-snapshot'};
    return await safeReportAdminResult(result,command)||unavailable();
    }catch{return unavailable();}
  }

  async convertNativeHistory(command) {return this.#convertNative(command,'history');}
  async inspectNativeConversionInventory(command){
    if(!exactRecord(command,['principal'])||!HEX64.test(command.principal))return invalid();
    try{const result=await callRpc(this.env.ACCOUNT_AUTHORITY,'name',command.principal,'nativeConversionInventoryTrusted',[command]);if(result?.ok===false)return safeFailure(result);const safe=safeNativeConversionInventory(result);return safe&&safe.principal===command.principal?safe:unavailable();}catch{return unavailable();}
  }
  async inspectNativeAdminItems(command) {
    if (!validAdminItemsCommand(command)) return invalid();
    try {
      const result = await callRpc(this.env.ACCOUNT_AUTHORITY, 'name', command.principal, 'nativeAdminItemsTrusted', [command]);
      return safeAdminItemsResult(result, command) || unavailable();
    } catch { return unavailable(); }
  }
  async inspectNativeAdminStatus(command){
    if(!exactRecord(command,['principal'])||!HEX64.test(command.principal))return invalid();
    try{const before=safeNativeIdentity(await callRpc(this.env.ACCOUNT_AUTHORITY,'name',command.principal,'nativeManagerIdentityTrusted',[{principal:command.principal}]));if(before.ok!==true||before.status!=='observed'||before.phase!=='active'||before.principal!==command.principal)return unavailable();
      const result=await callRpc(this.env.ACCOUNT_AUTHORITY,'name',command.principal,'nativeAdminStatusTrusted',[{principal:command.principal,expectedIncarnation:before.incarnation,expectedFence:before.fence}]);if(result?.ok===false)return safeFailure(result);const safe=safeNativeAdminStatus(result);const after=safeNativeIdentity(await callRpc(this.env.ACCOUNT_AUTHORITY,'name',command.principal,'nativeManagerIdentityTrusted',[{principal:command.principal}]));return safe&&after.ok===true&&after.status==='observed'&&after.principal===command.principal&&after.phase==='active'&&safe.principal===command.principal&&safe.incarnation===before.incarnation&&safe.fence===before.fence&&after.incarnation===before.incarnation&&after.fence===before.fence?safe:unavailable();}catch{return unavailable();}
  }
  async inspectNativeIdentity(command){
    if(!exactRecord(command,['objectId'])||typeof command.objectId!=='string'||command.objectId.length<1||command.objectId.length>128)return invalid();
    try{return safeNativeIdentity(await callRpc(this.env.ACCOUNT_AUTHORITY,'id',command.objectId,'nativeManagerIdentityTrusted',[]));}catch(error){return error?.message==='NOT_CONFIGURED'?{ok:false,error:'NOT_CONFIGURED'}:unavailable();}
  }
  async inspectNativeIdentityByPrincipal(command){
    if(!exactRecord(command,['principal'])||typeof command.principal!=='string'||!HEX64.test(command.principal))return invalid();
    try{const result=safeNativeIdentity(await callRpc(this.env.ACCOUNT_AUTHORITY,'name',command.principal,'nativeManagerIdentityTrusted',[{principal:command.principal}]));return result.ok===true&&result.status==='observed'&&result.principal!==command.principal?unavailable():result;}catch(error){return error?.message==='NOT_CONFIGURED'?{ok:false,error:'NOT_CONFIGURED'}:unavailable();}
  }
  async readNativeConversionProof(command){
    if(!validNativeProofCommand(command))return invalid();
    try{const result=await callRpc(this.env.ACCOUNT_AUTHORITY,'name',command.principal,'nativeConversionProofTrusted',[command]);if(result?.ok===false)return safeFailure(result);return await safeNativeProofResult(result,command)||unavailable();}catch{return unavailable();}
  }
  async convertNativeBank(command) {return this.#convertNative(command,'bank');}
  async declareNativeSourceDisposition(input){
    try{const command=validateSourceDispositionCommand(input),r=await callRpc(this.env.ACCOUNT_AUTHORITY,'name',command.principal,'declareNativeSourceDispositionTrusted',[command]);if(r?.ok===false)return safeFailure(r);
      if(!exactRecord(r,['ok','status','historyCount','discardCount','sourceDeleted'])||r.ok!==true||r.status!=='declared-not-deleted'||r.historyCount!==command.histories.length||r.discardCount!==command.histories.filter(h=>h.disposition==='discard-authorized').length||r.sourceDeleted!==false)return unavailable();
      return {ok:true,status:r.status,historyCount:r.historyCount,discardCount:r.discardCount,sourceDeleted:false};
    }catch{return unavailable();}
  }
  async #convertNative(command,kind) {
    if(!exactRecord(command,['principal','incarnation','generation','authorityFence','manifestSha256','recordId','mode'])
      ||!HEX64.test(command.principal)||!HEX64.test(command.incarnation)
      ||typeof command.generation!=='string'||!Number.isSafeInteger(command.authorityFence)||command.authorityFence<0
      ||!HEX64.test(command.manifestSha256)||typeof command.recordId!=='string'||!command.recordId||command.recordId.length>64
      ||!['plan','execute'].includes(command.mode))return invalid();
    try{
      const result=await callRpc(this.env.ACCOUNT_AUTHORITY,'name',command.principal,kind==='bank'?'convertLegacyNativeBankTrusted':'convertLegacyNativeTrusted',[command]);
      if(result?.ok===false)return safeFailure(result);
      const idField=kind==='bank'?'bankUid':'snapshotId';
      if(!exactRecord(result,['ok','status',idField,'contentDigest','sourceDeleted'])||result.ok!==true
        ||!['planned','accepted','duplicate','already-accepted'].includes(result.status)||typeof result[idField]!=='string'
        ||!HEX64.test(result.contentDigest)||result.sourceDeleted!==false)return unavailable();
      return {ok:true,status:result.status,[idField]:result[idField],contentDigest:result.contentDigest,sourceDeleted:false};
    }catch{return unavailable();}
  }
  async inspectSourceDiagnostics(command) {
    if (!exactRecord(command,['objectId']) || typeof command.objectId!=='string' || command.objectId.length<1 || command.objectId.length>128) return invalid();
    try { return safeSourceDiagnostics(await callRpc(this.env.USER_STORE,'id',command.objectId,'legacyMigrationSourceDiagnostics',[])) || unavailable(); }
    catch (error) { return error?.message==='NOT_CONFIGURED' ? {ok:false,error:'NOT_CONFIGURED'} : unavailable(); }
  }

  async inspectAuthorityByPrincipal(command) {
    if (!exactRecord(command,['principal']) || typeof command.principal!=='string' || !HEX64.test(command.principal)) return invalid();
    try {
      const result=safeAuthorityStatus(await callRpc(this.env.ACCOUNT_AUTHORITY,'name',command.principal,'operatorStatusTrusted',[]));
      return result.ok===true && result.status==='observed' && result.principal!==command.principal ? unavailable() : result;
    } catch (error) { return error?.message==='NOT_CONFIGURED' ? {ok:false,error:'NOT_CONFIGURED'} : unavailable(); }
  }

  async inspectSource(command) {
    if (!exactRecord(command, ['objectId']) || typeof command.objectId !== 'string' || command.objectId.length < 1 || command.objectId.length > 128) return invalid();
    try { return safeSource(await callRpc(this.env.USER_STORE, 'id', command.objectId, 'legacyMigrationSourceStatus', [])); }
    catch (error) { return error?.message === 'NOT_CONFIGURED' ? { ok: false, error: 'NOT_CONFIGURED' } : unavailable(); }
  }

  async inspectAuthority(command) {
    if (!exactRecord(command, ['objectId']) || typeof command.objectId !== 'string' || command.objectId.length < 1 || command.objectId.length > 128) return invalid();
    try { return safeAuthorityStatus(await callRpc(this.env.ACCOUNT_AUTHORITY, 'id', command.objectId, 'operatorStatusTrusted', [])); }
    catch (error) { return error?.message === 'NOT_CONFIGURED' ? { ok: false, error: 'NOT_CONFIGURED' } : unavailable(); }
  }

  async migrate(command) {
    if (!exactRecord(command, ['principal']) || typeof command.principal !== 'string' || !HEX64.test(command.principal)) return invalid();
    try { return safeMigration(await callRpc(this.env.ACCOUNT_AUTHORITY, 'name', command.principal, 'migrateLegacyTrusted', [{ principal: command.principal }])); }
    catch (error) { return error?.message === 'NOT_CONFIGURED' ? { ok: false, error: 'NOT_CONFIGURED' } : unavailable(); }
  }

  async delete(command) {
    if (!exactRecord(command, ['principal', 'incarnation', 'expectedFence', 'opId'])
      || typeof command.principal !== 'string' || !HEX64.test(command.principal)
      || typeof command.incarnation !== 'string' || !HEX64.test(command.incarnation)
      || !Number.isSafeInteger(command.expectedFence) || command.expectedFence < 0
      || typeof command.opId !== 'string' || !UUID_V4.test(command.opId)) return invalid();
    const trustedCommand = {
      principal: command.principal, incarnation: command.incarnation,
      expectedFence: command.expectedFence, opId: command.opId,
    };
    try { return safeDelete(await callRpc(this.env.ACCOUNT_AUTHORITY, 'name', command.principal, 'deleteTrusted', [trustedCommand])); }
    catch (error) { return error?.message === 'NOT_CONFIGURED' ? { ok: false, error: 'NOT_CONFIGURED' } : unavailable(); }
  }

  async deleteLegacySource(command) {
    if (!exactRecord(command, ['principal', 'opId']) || typeof command.principal !== 'string' || !HEX64.test(command.principal)
      || typeof command.opId !== 'string' || !UUID_V4.test(command.opId)) return invalid();
    const trustedCommand = { principal: command.principal, opId: command.opId };
    try {
      return safeLegacySourceDelete(await callRpc(this.env.ACCOUNT_AUTHORITY, 'name', command.principal,
        'deleteLegacySourceTrusted', [trustedCommand]));
    } catch (error) {
      return error?.message === 'NOT_CONFIGURED' ? { ok: false, error: 'NOT_CONFIGURED' } : unavailable();
    }
  }
}
