import {validateSnapshotContinuationBaseline} from '../../src/domain/app-data/snapshot-continuation.js';
import { GenerationStore } from './generation-store.js';
import {createSessionV3Repository,SESSION_V3_FLAG} from './account-session-v3.js';
import { createGenerationRepository } from './generation-repository.js';
import { validGeneration } from './generation-transition.js';
import { createAccountSyncRepository, clearAccountSyncData } from './account-sync-repository.js';
import { validatePushRequest, validatePullRequest, validateChangeLogRecord, validateMutationReceipt } from '../../src/domain/app-data/sync-wire.js';
import { verifyMutationDigest } from '../../src/domain/app-data/mutation-records.js';
import { createAccountContentRepository } from './account-content-repository.js';
import { validateChunkManifest, validateContentReference } from '../../src/domain/app-data/content-records.js';
import { canonicalBytes, sha256Hex } from '../../src/domain/app-data/canonical.js';
import { canonicalContentBytes } from '../../src/domain/app-data/canonical.js';
import { validateAttemptScope } from '../../src/domain/app-data/core-records.js';
import { validateHistorySnapshotBinding } from '../../src/domain/app-data/history-snapshot-records.js';
import { validateResumeState, validateResumeDependencies } from '../../src/domain/app-data/resume-dependencies.js';
import { validateBankContent, validateProtectedBankEnvelope, validateProtectedBankEnvelopeV2, PROTECTED_BANK_V2_FORMAT } from '../../src/domain/question/bank-content.js';
import { loadAccountPublicRegistry, readFrozenAccountPublicBank } from './account-public-registry.js';
import { createAccountExportRepository } from './account-export-repository.js';
import { validateExportManifest } from '../../src/domain/app-data/export-manifest.js';
import { CLOUD_COVERAGE, validateCloudCheckpoint, validateCloudContentReference } from './account-cloud-checkpoint.js';
import { validateCursorReset } from '../../src/domain/app-data/auth-recovery.js';
import {prepareFrozenNativeHistory,executeLegacyNativeHistory,prepareFrozenNativeBank,executeLegacyNativeBank,readNativeConversionInventory,readFrozenSourceChunk} from './legacy-native-conversion.js';
import {readNativeAdminStatus} from './native-admin-status.js';
import {prepareLegacySourceDisposition,commitPreparedSourceDisposition,validateSourceDispositionCommand,validateDispositionCoverage} from './legacy-source-disposition.js';
import { prepareConvertedPayloadRetirement, commitPreparedRetirement } from './generation-payload-retirement.js';
import {validNativeProofCommand,safeNativeProofResult} from './native-conversion-proof.js';
import {
  beginLegacyArchive, completeLegacyArchiveRecord, legacyArchiveReceiptPreview,
  legacyArchiveManifestPage, legacyArchiveReadChunk, legacyArchiveStatus, recordLegacyNoImport,
  putLegacyArchiveChunk, putLegacyArchiveManifest, sealLegacyArchive, clearLegacyArchive,
} from './legacy-archive-repository.js';

const FEATURE = '1';
const HEX64 = /^[0-9a-f]{64}$/;
const STATE_TABLE = 'gen02_generation_state';
const HISTORY_TABLE = 'gen02_generation_history';
const BINDING_TABLE = 'gen05_data_binding';

function failure(error) {
  return { ok: false, error };
}

function cause(code) {
  const error = new Error(code);
  error.code = code;
  return error;
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

function validBinding(value) {
  return exactRecord(value, ['principal', 'incarnation'])
    && typeof value.principal === 'string'
    && typeof value.incarnation === 'string'
    && HEX64.test(value.principal)
    && HEX64.test(value.incarnation)
    && value.principal !== value.incarnation;
}

function rows(cursor) {
  if (!cursor) return [];
  if (typeof cursor.toArray === 'function') return cursor.toArray();
  return Array.from(cursor);
}

function query(sql, statement, ...bindings) {
  return rows(sql.exec(statement, ...bindings));
}

function tableExists(sql, table) {
  return query(sql, "SELECT name FROM sqlite_master WHERE type='table' AND name=?", table).length > 0;
}

function schema(sql) {
  return {
    binding: tableExists(sql, BINDING_TABLE),
    state: tableExists(sql, STATE_TABLE),
    history: tableExists(sql, HISTORY_TABLE),
  };
}

function allAbsent(current) {
  return !current.binding && !current.state && !current.history;
}

function allPresent(current) {
  return current.binding && current.state && current.history;
}

function readBinding(sql) {
  const result = query(sql, `SELECT id,principal,incarnation FROM ${BINDING_TABLE}`);
  if (result.length !== 1 || result[0].id !== 1) throw cause('INVALID_INPUT');
  const binding = { principal: result[0].principal, incarnation: result[0].incarnation };
  if (!validBinding(binding)) throw cause('INVALID_INPUT');
  return binding;
}

function assertBinding(sql, expected) {
  const actual = readBinding(sql);
  if (actual.principal !== expected.principal || actual.incarnation !== expected.incarnation) {
    throw cause('INVALID_CREDENTIALS');
  }
  return actual;
}

function readGeneration(sql, repository) {
  const stateRows = query(sql, `SELECT id,state_json FROM ${STATE_TABLE}`);
  if (stateRows.length !== 1 || stateRows[0].id !== 1 || typeof stateRows[0].state_json !== 'string') {
    throw cause('INVALID_INPUT');
  }
  const state = repository.read();
  if (!state) throw cause('INVALID_INPUT');
  const historyRows = query(sql, `SELECT generation FROM ${HISTORY_TABLE}`);
  if (historyRows.some((row) => !row || !validGeneration(row.generation))) throw cause('INVALID_INPUT');
  if (historyRows.filter((row) => row.generation === state.generation).length !== 1) {
    throw cause('INVALID_INPUT');
  }
  return state;
}

function insertBinding(sql, binding) {
  sql.exec(`INSERT INTO ${BINDING_TABLE}(id,principal,incarnation) VALUES(?,?,?)`,
    1, binding.principal, binding.incarnation);
}

function verifyNamespace(env, ctx, incarnation) {
  if (!env || typeof env.GENERATION_STORE?.idFromName !== 'function') throw cause('NOT_CONFIGURED');
  const id = env.GENERATION_STORE.idFromName(incarnation);
  if (!id || typeof id.equals !== 'function' || !id.equals(ctx.id)) throw cause('INVALID_CREDENTIALS');
}

function assertFeature(env) {
  if (env?.GEN05_ACCOUNT_API !== FEATURE) throw cause('FEATURE_DISABLED');
}

function validateCall(env, ctx, binding) {
  assertFeature(env);
  if (!validBinding(binding)) throw cause('INVALID_INPUT');
  verifyNamespace(env, ctx, binding.incarnation);
}

function captureSyncClaim(env, ctx, claim) {
  if (!exactRecord(claim, ['principal', 'incarnation', 'generation', 'expiresAt'])
    || !validGeneration(claim.generation) || !Number.isSafeInteger(claim.expiresAt) || claim.expiresAt <= Date.now()) throw cause('INVALID_CREDENTIALS');
  validateCall(env, ctx, { principal: claim.principal, incarnation: claim.incarnation });
  return structuredClone(claim);
}

function publicError(error) {
  const known = new Set([
    'FEATURE_DISABLED',
    'NOT_CONFIGURED',
    'INVALID_CREDENTIALS',
    'INVALID_INPUT',
    'NOT_INITIALIZED',
    'STALE_GENERATION',
    'ACCOUNT_DELETED',
    'REVISION_EXHAUSTED',
    'GENERATION_ISSUANCE_FAILED',
    'INVALID_CONTENT_INPUT', 'CONTENT_CONFLICT', 'MISSING_DEPENDENCY', 'QUOTA_EXCEEDED',
    'INVALID_SYNC_SCHEMA',
    'CONTENT_VALIDATION_UNAVAILABLE', 'SNAPSHOT_BASELINE_DISABLED', 'CLIENT_UPGRADE_REQUIRED',
    'INVALID_EXPORT_INPUT', 'INVALID_EXPORT_SCHEMA', 'INVALID_CLOUD_CHECKPOINT', 'EXPORT_METADATA_QUOTA', 'EXPORT_UNAVAILABLE', 'EXPORT_NOT_READY', 'EXPORT_CONFLICT', 'EXPORT_LIMIT', 'EXPORT_ROW_TOO_LARGE', 'EXPORT_INCOMPLETE',
    'INVALID_RETIREMENT_INPUT', 'STALE_RETIREMENT_OWNER', 'SOURCE_NOT_SEALED', 'SOURCE_MANIFEST_MISMATCH',
    'SOURCE_BYTES_MISMATCH', 'SOURCE_BYTES_INVALID', 'PRIVATE_SOURCE_NOT_PROVEN', 'NATIVE_COVERAGE_NOT_PROVEN',
    'NATIVE_ACCEPTANCE_MISSING', 'NATIVE_CONTENT_NOT_PROVEN', 'NATIVE_BANK_SEMANTICS_MISMATCH',
    'NATIVE_PUBLIC_BANK_MISMATCH', 'NATIVE_QUESTION_CLOSURE_NOT_PROVEN', 'NATIVE_SOURCE_SEMANTICS_MISMATCH',
    'NATIVE_CHECKPOINT_NOT_PROVEN', 'PUBLIC_BANK_BINDING', 'RETIREMENT_DRIFT', 'RETIREMENT_CONFLICT',
    'INVALID_RETIREMENT_CAPABILITY',
  ]);
  return known.has(error?.code) ? error.code : 'UNAVAILABLE';
}

export class AccountGenerationStore extends GenerationStore {
  constructor(ctx, env) {
    super(ctx, env);
  }

  // Binding-only, source-selected conversion. No code/token or caller payload.
  async convertArchivedHistoryTrusted(input) {return this.#convertArchivedNative(input,'history');}
  async nativeConversionInventoryTrusted(input){
    try{validateCall(this.env,this.ctx,{principal:input.principal,incarnation:input.incarnation});return await readNativeConversionInventory(this.ctx.storage.sql,input);}catch(error){return failure(publicError(error));}
  }
  nativeAdminStatusTrusted(binding){
    try{validateCall(this.env,this.ctx,binding);const sql=this.ctx.storage.sql;assertBinding(sql,binding);const state=readGeneration(sql,createGenerationRepository(this.ctx.storage));if(state.status!=='active')throw cause('STALE_AUTHORITY');return{ok:true,...readNativeAdminStatus(sql,{generation:state.generation})};}catch(error){return failure(publicError(error));}
  }
  // Internal single-writer entry point. It is intentionally not routed through
  // HTTP or the general migration operator; callers must first validate the
  // independent recovery receipt in the privileged local operator workflow.
  async retireConvertedPayloadTrusted(command) {
    try {
      const binding = { principal: command?.principal, incarnation: command?.incarnation };
      validateCall(this.env, this.ctx, binding);
      const check = async () => {
        const sql = this.ctx.storage.sql;
        assertBinding(sql, binding);
        const state = readGeneration(sql, createGenerationRepository(this.ctx.storage));
        if (state.status !== 'active' || state.generation !== command.accountGeneration) throw cause('STALE_RETIREMENT_OWNER');
        const authority = this.env.ACCOUNT_AUTHORITY?.getByName?.(command.principal);
        if (!authority || typeof authority.operatorStatusTrusted !== 'function') throw cause('STALE_AUTHORITY');
        const status = await authority.operatorStatusTrusted();
        if (status?.ok !== true || status.status !== 'observed' || status.phase !== 'active'
          || status.principal !== command.principal || status.incarnation !== command.incarnation
          || status.fence !== command.authorityFence || status.manifestSha256 !== command.sealedManifestSha256) throw cause('STALE_AUTHORITY');
      };
      await check();
      const capability = await prepareConvertedPayloadRetirement(this.ctx.storage.sql, command);
      await check();
      return this.ctx.storage.transactionSync(() => commitPreparedRetirement(this.ctx.storage.sql, capability));
    } catch (error) { return failure(publicError(error)); }
  }
  async nativeConversionProofTrusted(input){
    try{
      if(!validNativeProofCommand(input))throw cause('INVALID_INPUT');
      const command=structuredClone(input),binding={principal:command.principal,incarnation:command.incarnation};validateCall(this.env,this.ctx,binding);
      const guard=async()=>{const state=readGeneration(this.ctx.storage.sql,createGenerationRepository(this.ctx.storage));assertBinding(this.ctx.storage.sql,binding);if(state.status!=='active'||state.generation!==command.generation)throw cause('STALE_GENERATION');const status=await this.env.ACCOUNT_AUTHORITY.getByName(command.principal).operatorStatusTrusted();if(status?.ok!==true||status.phase!=='active'||status.incarnation!==command.incarnation||status.fence!==command.authorityFence||status.manifestSha256!==command.manifestSha256)throw cause('STALE_AUTHORITY');};
      await guard();const claim={...binding,generation:command.generation,expiresAt:Date.now()+120000};let body;
      if(command.operation==='start')body=await this.startExportTrusted(claim,{});
      if(command.operation==='page')body=this.readExportPageTrusted(claim,{exportId:command.exportId,section:command.section,after:command.after,limit:100});
      if(command.operation==='chunk')body=this.readExportChunkTrusted(claim,{exportId:command.exportId,contentDigest:command.contentDigest,chunkIndex:command.chunkIndex});
      if(command.operation==='reset')body=await this.resetExportTrusted(claim,{exportId:command.exportId});
      if(command.operation==='source-chunk')body=await readFrozenSourceChunk(this.ctx.storage.sql,command);
      await guard();if(body?.ok!==true)throw cause(body?.error||'UNAVAILABLE');const result=await safeNativeProofResult({ok:true,operation:command.operation,body},command);if(!result)throw cause('UNAVAILABLE');return result;
    }catch(error){return failure(publicError(error));}
  }
  async convertArchivedBankTrusted(input) {return this.#convertArchivedNative(input,'bank');}
  async declareNativeSourceDispositionTrusted(input){
    try{
      const command=validateSourceDispositionCommand(input);validateCall(this.env,this.ctx,{principal:command.principal,incarnation:command.incarnation});
      const guard=async()=>{const s=await this.env.ACCOUNT_AUTHORITY.getByName(command.principal).operatorStatusTrusted();if(s?.ok!==true||s.status!=='observed'||s.phase!=='active'||s.principal!==command.principal||s.incarnation!==command.incarnation||s.fence!==command.authorityFence||s.manifestSha256!==command.manifestSha256)throw cause('STALE_AUTHORITY');};
      await guard();
      validateDispositionCoverage(await readNativeConversionInventory(this.ctx.storage.sql,{principal:command.principal,incarnation:command.incarnation,authorityFence:command.authorityFence,manifestSha256:command.manifestSha256}),command);
      await guard();
      // Schema initialization is the normal native repository path, not a reset.
      this.ctx.storage.transactionSync(()=>{createAccountSyncRepository(this.ctx.storage.sql,command.generation);});
      const token=await prepareLegacySourceDisposition(this.ctx.storage.sql,command);await guard();
      const result=this.ctx.storage.transactionSync(()=>commitPreparedSourceDisposition(this.ctx.storage.sql,token));
      await guard();return result;
    }catch(error){return failure(publicError(error));}
  }
  async #convertArchivedNative(input,kind) {
    try {
      if(!exactRecord(input,['principal','incarnation','generation','authorityFence','manifestSha256','recordId','mode'])||!['plan','execute'].includes(input.mode))return failure('INVALID_INPUT');
      const {mode,...command}=structuredClone(input);
      validateCall(this.env,this.ctx,{principal:command.principal,incarnation:command.incarnation});
      const checkAuthority=async()=>{
        const status=await this.env.ACCOUNT_AUTHORITY.getByName(command.principal).operatorStatusTrusted();
        if(status?.ok!==true||status.status!=='observed'||status.phase!=='active'||status.principal!==command.principal
          ||status.incarnation!==command.incarnation||status.fence!==command.authorityFence||status.manifestSha256!==command.manifestSha256)throw cause('STALE_AUTHORITY');
      };
      await checkAuthority();
      const plan=await (kind==='bank'?prepareFrozenNativeBank:prepareFrozenNativeHistory)(this.ctx.storage.sql,command);
      await checkAuthority();
      if(mode==='plan')return{ok:true,status:'planned',...(kind==='bank'?{bankUid:plan.bankUid}:{snapshotId:plan.snapshotId}),contentDigest:plan.contentDigest,sourceDeleted:false};
      const claim={principal:command.principal,incarnation:command.incarnation,generation:command.generation,expiresAt:Date.now()+120000};
      const result=await (kind==='bank'?executeLegacyNativeBank:executeLegacyNativeHistory)(this.ctx.storage.sql,plan,{store:this,claim,checkAuthority});
      await checkAuthority();return{...result,contentDigest:plan.contentDigest};
    }catch(error){return failure(publicError(error));}
  }

  beginLegacyArchive(binding, command) {
    try {
      validateCall(this.env, this.ctx, binding);
      return this.ctx.storage.transactionSync(() => beginLegacyArchive(this.ctx.storage.sql, binding, command));
    } catch (error) { return { ok: false, error: publicError(error) }; }
  }

  putLegacyArchiveManifest(binding, command) {
    try {
      validateCall(this.env, this.ctx, binding);
      return this.ctx.storage.transactionSync(() => putLegacyArchiveManifest(this.ctx.storage.sql, binding, command));
    } catch (error) { return { ok: false, error: publicError(error) }; }
  }

  async putLegacyArchiveChunk(binding, command) {
    try {
      validateCall(this.env, this.ctx, binding);
      return await putLegacyArchiveChunk(this.ctx.storage.sql, binding, command);
    } catch (error) { return { ok: false, error: publicError(error) }; }
  }

  async completeLegacyArchiveRecord(binding, command) {
    try {
      validateCall(this.env, this.ctx, binding);
      return await completeLegacyArchiveRecord(this.ctx.storage.sql, binding, command);
    } catch (error) { return { ok: false, error: publicError(error) }; }
  }

  async sealLegacyArchive(binding, command) {
    try {
      validateCall(this.env, this.ctx, binding);
      return await sealLegacyArchive(this.ctx.storage.sql, binding, command);
    } catch (error) { return { ok: false, error: publicError(error) }; }
  }

  async legacyArchiveReceiptPreview(binding, command) {
    try {
      validateCall(this.env, this.ctx, binding);
      return await legacyArchiveReceiptPreview(this.ctx.storage.sql, binding, command);
    } catch (error) { return { ok: false, error: publicError(error) }; }
  }

  async recordLegacyNoImport(binding, command) {
    try {
      validateCall(this.env, this.ctx, binding);
      return await recordLegacyNoImport(this.ctx.storage.sql, binding, command);
    } catch (error) { return { ok: false, error: publicError(error) }; }
  }

  legacyArchiveStatus(binding, generation) {
    try {
      validateCall(this.env, this.ctx, binding);
      return legacyArchiveStatus(this.ctx.storage.sql, binding, generation);
    } catch (error) { return { ok: false, error: publicError(error) }; }
  }

  legacyMigrationOperatorStatus(binding) {
    try {
      validateCall(this.env, this.ctx, binding);
      const sql = this.ctx.storage.sql;
      const current = schema(sql);
      if (allAbsent(current)) return { ok: true, status: 'none', phase: null, historyDone: 0, historyTotal: 0, bankDone: 0, bankTotal: 0, manifestSha256: null };
      if (!allPresent(current)) throw cause('INVALID_INPUT');
      assertBinding(sql, binding);
      const stateRows = query(sql, `SELECT state_json FROM ${STATE_TABLE} WHERE id=1`);
      if (stateRows.length !== 1) throw cause('INVALID_INPUT');
      let state;
      try { state = JSON.parse(stateRows[0].state_json); } catch { throw cause('INVALID_INPUT'); }
      if (!state || !validGeneration(state.generation) || !['active', 'deleted'].includes(state.status)) throw cause('INVALID_INPUT');
      if (state.status === 'deleted') return { ok: true, status: 'deleted', phase: 'complete', historyDone: 0, historyTotal: 0, bankDone: 0, bankTotal: 0, manifestSha256: null };
      if (!tableExists(sql, 'gen05_legacy_migration')) return { ok: true, status: 'none', phase: null, historyDone: 0, historyTotal: 0, bankDone: 0, bankTotal: 0, manifestSha256: null };
      const jobs = query(sql, 'SELECT principal,incarnation,generation,status,phase,history_done,history_total,bank_done,bank_total,receipt_json FROM gen05_legacy_migration WHERE id=1');
      if (!jobs.length) return { ok: true, status: 'none', phase: null, historyDone: 0, historyTotal: 0, bankDone: 0, bankTotal: 0, manifestSha256: null };
      const job = jobs[0];
      if (jobs.length !== 1 || job.principal !== binding.principal || job.incarnation !== binding.incarnation
        || job.generation !== state.generation || !['staging', 'sealed', 'deleted', 'quarantined'].includes(job.status)
        || !['history', 'banks', 'verify', 'complete'].includes(job.phase)
        || !Number.isSafeInteger(job.history_done) || !Number.isSafeInteger(job.history_total)
        || !Number.isSafeInteger(job.bank_done) || !Number.isSafeInteger(job.bank_total)) throw cause('INVALID_INPUT');
      let manifestSha256 = null;
      if (job.status === 'sealed') {
        let receipt;
        try { receipt = JSON.parse(job.receipt_json); } catch { throw cause('INVALID_INPUT'); }
        if (!receipt || typeof receipt.manifestSha256 !== 'string' || !HEX64.test(receipt.manifestSha256)) throw cause('INVALID_INPUT');
        manifestSha256 = receipt.manifestSha256;
      }
      return { ok: true, status: job.status, phase: job.phase, historyDone: job.history_done,
        historyTotal: job.history_total, bankDone: job.bank_done, bankTotal: job.bank_total, manifestSha256 };
    } catch (error) { return { ok: false, error: publicError(error) }; }
  }

  legacyArchiveManifestPage(binding, generation, section, afterId = null, limit = 5) {
    try {
      validateCall(this.env, this.ctx, binding);
      return legacyArchiveManifestPage(this.ctx.storage.sql, binding, generation, section, afterId, limit);
    } catch (error) { return { ok: false, error: publicError(error) }; }
  }

  legacyArchiveReadChunk(binding, generation, sourceKey, chunkIndex) {
    try {
      validateCall(this.env, this.ctx, binding);
      return legacyArchiveReadChunk(this.ctx.storage.sql, binding, generation, sourceKey, chunkIndex);
    } catch (error) { return { ok: false, error: publicError(error) }; }
  }

  bootstrapTrusted(binding) {
    try {
      validateCall(this.env, this.ctx, binding);
      const sql = this.ctx.storage.sql;
      const current = schema(sql);
      if (allAbsent(current)) {
        return this.ctx.storage.transactionSync(() => {
          sql.exec(`CREATE TABLE IF NOT EXISTS ${BINDING_TABLE}(
            id INTEGER PRIMARY KEY CHECK (id=1),
            principal TEXT NOT NULL,
            incarnation TEXT NOT NULL
          )`);
          insertBinding(sql, binding);
          const repository = createGenerationRepository(this.ctx.storage);
          const state = repository.initialize();
          if (state.status !== 'active') throw cause('INVALID_INPUT');
          readGeneration(sql, repository);
          return { ok: true, generation: state.generation };
        });
      }
      if (!allPresent(current)) throw cause('INVALID_INPUT');
      return this.ctx.storage.transactionSync(() => {
        assertBinding(sql, binding);
        const repository = createGenerationRepository(this.ctx.storage);
        const state = readGeneration(sql, repository);
        if (state.status === 'deleted') throw cause('ACCOUNT_DELETED');
        return { ok: true, generation: state.generation };
      });
    } catch (error) {
      return failure(publicError(error));
    }
  }

  revokeTrusted(binding) {
    try {
      validateCall(this.env, this.ctx, binding);
      const sql = this.ctx.storage.sql;
      const current = schema(sql);
      return this.ctx.storage.transactionSync(() => {
        createSessionV3Repository(sql).clear();
        if (allAbsent(current)) {
          sql.exec(`CREATE TABLE IF NOT EXISTS ${BINDING_TABLE}(
            id INTEGER PRIMARY KEY CHECK (id=1),
            principal TEXT NOT NULL,
            incarnation TEXT NOT NULL
          )`);
          insertBinding(sql, binding);
          const repository = createGenerationRepository(this.ctx.storage);
          const initial = repository.initialize();
          readGeneration(sql, repository);
          repository.apply({ type: 'delete', expectedGeneration: initial.generation });
          clearAccountSyncData(sql);
          clearLegacyArchive(sql);
          readGeneration(sql, repository);
          return { ok: true };
        }
        if (!allPresent(current)) throw cause('INVALID_INPUT');
        assertBinding(sql, binding);
        const repository = createGenerationRepository(this.ctx.storage);
        const state = readGeneration(sql, repository);
        if (state.status === 'deleted') { clearAccountSyncData(sql); clearLegacyArchive(sql); return { ok: true }; }
        repository.apply({ type: 'delete', expectedGeneration: state.generation });
        clearAccountSyncData(sql);
        clearLegacyArchive(sql);
        readGeneration(sql, repository);
        return { ok: true };
      });
    } catch (error) {
      return failure(publicError(error));
    }
  }

  // Trusted adapter used by the account authority. This is deliberately a
  // read-only path: a missing or partial data namespace is never initialized
  // while a session claim is being checked.
  async issueSessionTrusted(claim){
    let diagnosticStage = 'SESSION_V3_INPUT_SHAPE';
    try{
      if(this.env?.[SESSION_V3_FLAG]!=='1')throw cause('FEATURE_DISABLED');
      if(!exactRecord(claim,['principal','incarnation','generation','expiresAt','tokenHash']))throw cause('INVALID_INPUT');
      diagnosticStage = 'SESSION_V3_CLAIM_BINDING';
      const owned=structuredClone(captureSyncClaim(this.env,this.ctx,{principal:claim.principal,incarnation:claim.incarnation,generation:claim.generation,expiresAt:claim.expiresAt}));
      diagnosticStage = 'SESSION_V3_TOKEN_HASH';
      if(typeof claim.tokenHash!=='string'||!HEX64.test(claim.tokenHash))throw cause('INVALID_INPUT');
      diagnosticStage = 'SESSION_V3_EXPIRY_BOUND';
      if(owned.expiresAt>Date.now()+30*24*60*60*1000)throw cause('INVALID_INPUT');
      const hash=claim.tokenHash;
      // Alarm durability precedes hash insertion. Crash after SQL commit cannot
      // strand a newly issued hash without an expiry wakeup.
      diagnosticStage = 'SESSION_V3_ALARM_BEFORE';
      await this.scheduleSessionExpiry(owned.expiresAt);
      diagnosticStage = 'SESSION_V3_SESSION_TRANSACTION';
      this.ctx.storage.transactionSync(()=>{
        assertBinding(this.ctx.storage.sql,owned);
        const state=readGeneration(this.ctx.storage.sql,createGenerationRepository(this.ctx.storage));
        if(state.status!=='active'||state.generation!==owned.generation||owned.expiresAt<=Date.now())throw cause('INVALID_CREDENTIALS');
        createSessionV3Repository(this.ctx.storage.sql).issue({token_hash:hash,generation:owned.generation,expires_at:owned.expiresAt});
      });
      diagnosticStage = 'SESSION_V3_ALARM_AFTER';
      await this.scheduleSessionExpiry();return {ok:true};
    }catch(error){
      try { console.error(JSON.stringify({event:'QB_AUTH_FAILURE_V1',action:'OTHER',stage:diagnosticStage,error:publicError(error)})); } catch {}
      return failure(publicError(error));
    }
  }
  loadSessionTrusted(claim){
    try{
      if(this.env?.[SESSION_V3_FLAG]!=='1')throw cause('FEATURE_DISABLED');assertFeature(this.env);
      if(!exactRecord(claim,['tokenHash']))throw cause('INVALID_INPUT');
      return this.ctx.storage.transactionSync(()=>{
        const sql=this.ctx.storage.sql,current=schema(sql);
        if(allAbsent(current))throw cause('INVALID_CREDENTIALS');
        if(!allPresent(current))throw cause('INVALID_INPUT');
        const binding=readBinding(sql);verifyNamespace(this.env,this.ctx,binding.incarnation);
        const state=readGeneration(sql,createGenerationRepository(this.ctx.storage)),row=createSessionV3Repository(sql).read(claim.tokenHash);
        if(!row||row.expires_at<=Date.now()||state.status!=='active'||row.generation!==state.generation)throw cause('INVALID_CREDENTIALS');
        return {ok:true,session:{sub:binding.incarnation,generation:row.generation,expiresAt:row.expires_at}};
      });
    }catch(error){return failure(publicError(error));}
  }
  async scheduleSessionExpiry(proposedExpiry=null){
    // Serialize only alarm I/O, not issuance/storage transactions. A stale later
    // setAlarm cannot overwrite an earlier expiry from concurrent issuance.
    const task=(this.sessionAlarmQueue??Promise.resolve()).catch(()=>{}).then(async()=>{
      const current=await this.ctx.storage.getAlarm();
      const stored=createSessionV3Repository(this.ctx.storage.sql).nextDue();
      const next=stored===null?proposedExpiry:proposedExpiry===null?stored:Math.min(stored,proposedExpiry);
      if(next!==null&&(current===null||current>next))await this.ctx.storage.setAlarm(Math.max(Date.now()+1,next));
    });
    this.sessionAlarmQueue=task;await task;
  }
  async alarm(){
    // Existing expired hashes still need GC when new issuance is disabled.
    this.ctx.storage.transactionSync(()=>createSessionV3Repository(this.ctx.storage.sql).gc(Date.now()));
    await this.scheduleSessionExpiry();
  }
  describeSession(claim) {
    try {
      assertFeature(this.env);
      if (!exactRecord(claim, ['generation', 'expiresAt'])
        || !validGeneration(claim.generation)
        || !Number.isSafeInteger(claim.expiresAt) || claim.expiresAt <= Date.now()) {
        throw cause('INVALID_CREDENTIALS');
      }
      const sql = this.ctx.storage.sql;
      const current = schema(sql);
      if (allAbsent(current)) throw cause('NOT_INITIALIZED');
      if (!allPresent(current)) throw cause('INVALID_INPUT');
      const binding = readBinding(sql);
      verifyNamespace(this.env, this.ctx, binding.incarnation);
      const repository = createGenerationRepository(this.ctx.storage);
      const state = readGeneration(sql, repository);
      if (claim.expiresAt <= Date.now()) throw cause('INVALID_CREDENTIALS');
      if (state.status === 'deleted') throw cause('ACCOUNT_DELETED');
      if (state.status !== 'active') throw cause('INVALID_INPUT');
      if (state.generation !== claim.generation) throw cause('STALE_GENERATION');
      return {
        ok: true,
        principal: binding.principal,
        incarnation: binding.incarnation,
        generation: claim.generation,
      };
    } catch (error) {
      return failure(publicError(error));
    }
  }

  execute(claim, action) {
    try {
      if (this.env?.GEN05_ACCOUNT_API !== FEATURE) return failure('FEATURE_DISABLED');
      const sql = this.ctx.storage.sql;
      const current = schema(sql);
      if (allAbsent(current)) return failure('NOT_INITIALIZED');
      if (!allPresent(current)) return failure('INVALID_INPUT');
      const binding = readBinding(sql);
      verifyNamespace(this.env, this.ctx, binding.incarnation);
      const repository = createGenerationRepository(this.ctx.storage);
      readGeneration(sql, repository);
      return super.execute(claim, action);
    } catch (error) {
      return failure(publicError(error));
    }
  }

  // Pages constructs this claim from KV + the authority's verified identity;
  // it is never accepted from the HTTP body. Recheck after digest awaits and
  // within the very same transaction as every sync write.
  #syncTransaction(claim, operation) {
    assertFeature(this.env);
    if (this.env?.GEN06_SYNC_API !== FEATURE) throw cause('FEATURE_DISABLED');
    if (!exactRecord(claim, ['principal', 'incarnation', 'generation', 'expiresAt'])
      || !validBinding({ principal: claim.principal, incarnation: claim.incarnation })
      || !validGeneration(claim.generation) || !Number.isSafeInteger(claim.expiresAt)) throw cause('INVALID_CREDENTIALS');
    validateCall(this.env, this.ctx, { principal: claim.principal, incarnation: claim.incarnation });
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      if (!allPresent(schema(sql))) throw cause('NOT_INITIALIZED');
      assertBinding(sql, { principal: claim.principal, incarnation: claim.incarnation });
      const state = readGeneration(sql, createGenerationRepository(this.ctx.storage));
      if (claim.expiresAt <= Date.now()) throw cause('INVALID_CREDENTIALS');
      if (state.status === 'deleted') throw cause('ACCOUNT_DELETED');
      if (state.generation !== claim.generation) throw cause('STALE_GENERATION');
      return operation(createAccountSyncRepository(sql, state.generation), createAccountContentRepository(sql));
    });
  }

  syncCapabilitiesTrusted(claim) {
    try {
      assertFeature(this.env);
      if(this.env?.GEN06_SYNC_API!==FEATURE)throw cause('FEATURE_DISABLED');
      const identity=captureSyncClaim(this.env,this.ctx,claim);
      const sql=this.ctx.storage.sql;
      if(!allPresent(schema(sql)))throw cause('NOT_INITIALIZED');
      assertBinding(sql,{principal:identity.principal,incarnation:identity.incarnation});
      const state=readGeneration(sql,createGenerationRepository(this.ctx.storage));
      if(identity.expiresAt<=Date.now())throw cause('INVALID_CREDENTIALS');
      if(state.status==='deleted')throw cause('ACCOUNT_DELETED');
      if(state.generation!==identity.generation)throw cause('STALE_GENERATION');
      return {ok:true,response:{resumeSchemaVersions:[1,2],snapshotBaselineInitializationEnabled:this.env.GEN06_SNAPSHOT_BASELINE_INIT==='1'&&this.env.GEN06_RESUME_V2_READ_GUARD==='1'}};
    } catch(error){return failure(publicError(error));}
  }

  async pushTrusted(claim, input) {
    try {
      if (this.env?.GEN06_SYNC_API !== FEATURE) return failure('FEATURE_DISABLED');
      const request = structuredClone(validatePushRequest(input));
      const identity = captureSyncClaim(this.env, this.ctx, claim);
      if (request.accountGeneration !== identity.generation) return failure('STALE_GENERATION');
      // Full batch structural/digest validation precedes any SQL initialization.
      for (const mutation of request.mutations) if (!await verifyMutationDigest(mutation)) return failure('INVALID_SYNC_INPUT');
      const dependencies = await this.#prepareSyncDependencies(identity, request);
      return { ok: true, response: this.#syncTransaction(identity, repository => {
        // Final transaction barrier: a declaration may commit while content
        // validation awaits. Never accept a discarded source after that commit.
        const sql=this.ctx.storage.sql;
        if(this.env.GEN06_SNAPSHOT_BASELINE_INIT!=='1'||this.env.GEN06_RESUME_V2_READ_GUARD!=='1')for(const m of request.mutations){
          const state=dependencies.contents.get(m.payload.contentDigest)?.resume;
          if(m.kind==='resume_state'&&state?.snapshotBaseline){
            const initialized=sql.exec("SELECT record_json FROM gen06_change_log WHERE json_extract(record_json,'$.kind')='resume_state' AND json_extract(record_json,'$.payload.attemptId')=? AND json_extract(record_json,'$.payload.writerStreamId')=? AND json_extract(record_json,'$.payload.localRevision')=1 LIMIT 1",state.attemptId,state.writerStreamId).toArray();
            if(initialized.length!==1)throw cause('SNAPSHOT_BASELINE_DISABLED');
          }
        }
        if(sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='gen11_source_dispositions'").toArray().length)for(const m of request.mutations)if(m.kind==='history_snapshot'&&m.payload.source.namespace==='legacy_account'&&sql.exec("SELECT source_key FROM gen11_source_dispositions WHERE source_key=? AND generation=? AND incarnation=? AND disposition='discard-authorized'",`history:${m.payload.source.recordId}`,identity.generation,identity.incarnation).toArray().length)throw cause('CONTENT_CONFLICT');
        return repository.withDependencies(dependencies).push(request);
      }) };
    } catch (error) {
      return failure(error?.name === 'AppDataValidationError' ? 'INVALID_SYNC_INPUT' : publicError(error));
    }
  }

  pullTrusted(claim, input, readerVersion = 1) {
    try {
      const request = validatePullRequest(input);
      return { ok: true, response: this.#syncTransaction(claim, repository => {
        if(![1,2].includes(readerVersion))throw cause('INVALID_SYNC_INPUT');
        if(this.env.GEN06_RESUME_V2_READ_GUARD==='1'&&readerVersion!==2)throw cause('CLIENT_UPGRADE_REQUIRED');
        return repository.pull(request);
      }) };
    } catch (error) {
      return failure(error?.code === 'CURSOR_UNAVAILABLE' ? 'CURSOR_UNAVAILABLE'
        : error?.name === 'AppDataValidationError' ? 'INVALID_SYNC_INPUT' : publicError(error));
    }
  }

  async putChunkTrusted(claim, input) {
    try {
      if (this.env?.GEN06_SYNC_API !== FEATURE) return failure('FEATURE_DISABLED');
      if (!exactRecord(input, ['contentDigest', 'chunkIndex', 'bytes']) || !(input.bytes instanceof Uint8Array)) return failure('INVALID_CONTENT_INPUT');
      const { contentDigest, chunkIndex } = input;
      if (!HEX64.test(contentDigest) || !Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= 200) return failure('INVALID_CONTENT_INPUT');
      const identity = captureSyncClaim(this.env, this.ctx, claim);
      const bytes = new Uint8Array(input.bytes);
      if (bytes.byteLength < 1 || bytes.byteLength > 512 * 1024) return failure('INVALID_CONTENT_INPUT');
      const digest = await sha256Hex(bytes);
      return { ok: true, ...this.#syncTransaction(identity, (_, content) => content.putChunk(contentDigest, chunkIndex, digest, bytes)) };
    } catch (error) { return failure(publicError(error)); }
  }

  async publishContentTrusted(claim, input) {
    try {
      if (this.env?.GEN06_SYNC_API !== FEATURE) return failure('FEATURE_DISABLED');
      const manifest = structuredClone(validateChunkManifest(input));
      const identity = captureSyncClaim(this.env, this.ctx, claim);
      const manifestDigest = await sha256Hex(canonicalBytes(manifest));
      // Workers-native streaming hash retains no accumulated content bytes.
      const stream = new crypto.DigestStream('SHA-256');
      const writer = stream.getWriter();
      try {
        for (const expected of manifest.chunks) {
          const chunk = this.#syncTransaction(identity, (_, content) => content.readChunk(manifest.contentDigest, expected.chunkIndex, false));
          if (chunk.byteLength !== expected.byteLength || chunk.digest !== expected.sha256 || await sha256Hex(chunk.bytes) !== expected.sha256) throw cause('CONTENT_CONFLICT');
          await writer.write(chunk.bytes);
        }
        await writer.close();
      } catch (error) { await writer.abort(error).catch(() => {}); await stream.digest.catch(() => {}); throw error; }
      const digest = [...new Uint8Array(await stream.digest)].map(b => b.toString(16).padStart(2, '0')).join('');
      if (digest !== manifest.contentDigest) return failure('CONTENT_CONFLICT');
      // All chunk keys are immutable; recheck identity and the complete manifest
      // immediately before publication after every external crypto await.
      return { ok: true, manifestDigest, ...this.#syncTransaction(identity, (_, content) => content.publish(manifest, manifestDigest)) };
    } catch (error) { return failure(error?.name === 'AppDataValidationError' ? 'INVALID_CONTENT_INPUT' : publicError(error)); }
  }

  readManifestTrusted(claim, input) {
    try {
      if (!exactRecord(input, ['contentDigest']) || !/^[0-9a-f]{64}$/.test(input.contentDigest)) return failure('INVALID_CONTENT_INPUT');
      const stored = this.#syncTransaction(claim, (_, content) => content.manifest(input.contentDigest));
      if (!stored) return failure('MISSING_DEPENDENCY');
      return { ok: true, manifestDigest: stored.manifestDigest, manifest: structuredClone(stored.manifest) };
    } catch (error) { return failure(publicError(error)); }
  }

  #exportTransaction(claim, operation) {
    if (this.env?.GEN06_CLOUD_EXPORT_API !== FEATURE) throw cause('FEATURE_DISABLED');
    return this.#syncTransaction(claim, repository => {
      const info = repository.info();
      return operation(createAccountExportRepository(this.ctx.storage.sql, info.generation, info.logEpoch, info.serverHighWater));
    });
  }

  consumeExportRateTrusted(claim) {
    try { return { ok: true, ...this.#exportTransaction(claim, repository => repository.consumeRate()) }; }
    catch (error) { return failure(publicError(error)); }
  }

  async startExportTrusted(claim, input) {
    try {
      if (!exactRecord(input, [])) return failure('INVALID_EXPORT_INPUT');
      const identity = captureSyncClaim(this.env, this.ctx, claim);
      const registry = [...loadAccountPublicRegistry(this.env)].sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => ({ key, record: entry.record, reference: entry.publicContentReference }));
      const registryDigest = await sha256Hex(canonicalBytes(registry));
      const snapshot = this.#exportTransaction(identity, repository => repository.prepare({ registry, registryDigest }));
      const sections = [];
      for (const section of snapshot.sections) {
        const stream = new crypto.DigestStream('SHA-256'), writer = stream.getWriter();
        let after = '0', count = 0, utf8Bytes = 0;
        try {
          for (;;) {
            const page = this.#cloudExportPage(identity, { exportId: snapshot.exportId, section, after, limit: 100 });
            for (const record of page.records) {
              const bytes = canonicalBytes(record);
              await writer.write(bytes); await writer.write(new Uint8Array([10]));
              count++; utf8Bytes += bytes.length + 1;
            }
            after = page.next;
            if (!page.hasMore) break;
          }
          await writer.close();
          const digest = new Uint8Array(await stream.digest);
          sections.push({ path: section, count, utf8Bytes, sha256: Array.from(digest, b => b.toString(16).padStart(2, '0')).join('') });
        } catch (error) { await writer.abort().catch(() => {}); stream.digest.catch(() => {}); throw error; }
      }
      const manifest = validateExportManifest({ format: 'qb-appdata-v2', schemaVersion: 2, exportId: snapshot.exportId, appVersion: 'gen06-cloud-checkpoint-v1', sourceProfileHint: 'verified cloud accepted-state checkpoint', sections, legacySourceDigests: [], complete: false, partial: true,
        coverage: { facts: false, attempts: false, drafts: false, mutations: false, outbox: false, conflicts: false, tombstones: false, legacy: false, content: false },
        partialReasons: ['cloud_accepted_changes_only', 'unuploaded_local_facts_outbox_conflicts_legacy_not_available', 'public_bodies_are_immutable_static_references'], accountGeneration: snapshot.generation, serverLogEpoch: snapshot.logEpoch, exportCut: snapshot.exportCut, throughServerSeq: snapshot.exportCut });
      const digest = await sha256Hex(canonicalBytes(manifest));
      this.#exportTransaction(identity, repository => repository.finalize(snapshot.exportId, manifest, digest));
      const proof = await this.#proveCloudCheckpoint(identity, snapshot);
      const checkpoint = validateCloudCheckpoint({ format: 'qb-cloud-checkpoint-v1', scope: 'server-known-accepted-state', exportId: snapshot.exportId, generation: snapshot.generation, logEpoch: snapshot.logEpoch, cut: snapshot.exportCut, expiresAt: snapshot.expiresAt, sections, ...proof });
      const checkpointDigest = await sha256Hex(canonicalBytes(checkpoint));
      return { ok: true, ...this.#exportTransaction(identity, repository => repository.finalizeCheckpoint(snapshot.exportId, checkpoint, checkpointDigest)) };
    } catch (error) { return failure(publicError(error)); }
  }

  #cloudExportPage(identity, input, requireComplete = false) {
      const page = this.#exportTransaction(identity, repository => repository.page(input, requireComplete));
      if (input.section !== 'content-references.ndjson') return page;
      const frozen = this.#exportTransaction(identity, repository => repository.registry(input.exportId));
      if (frozen.mode !== 'pinned-v1') {
        // Never change an older snapshot's bytes/count/digest by regenerating
        // its reference projection against a newer registry.
        for (const record of page.records) record?.sourceChange ? validateCloudContentReference(record) : validateChangeLogRecord(record);
        return page;
      }
      const registry = new Map(frozen.entries.map(entry => [entry.key, { record: entry.record, publicContentReference: entry.reference }]));
      page.records = page.records.map(sourceChange => {
        const p = validateChangeLogRecord(sourceChange).payload;
        let reference = sourceChange.kind === 'content_manifest' || sourceChange.kind === 'attempt_scope' || sourceChange.kind === 'history_snapshot' ? p.reference : sourceChange.kind === 'bank_revision' ? p.contentManifest.reference : null;
        const trusted = sourceChange.kind === 'bank_revision' && p.contentManifest.kind === 'public_static' ? registry.get(`${p.bankUid}:${p.revision}`)
          : sourceChange.kind === 'content_manifest' ? [...registry.values()].find(entry => new TextDecoder().decode(canonicalBytes(entry.publicContentReference)) === new TextDecoder().decode(canonicalBytes(reference))) : null;
        let provenance;
        if (trusted) {
          reference = trusted.publicContentReference;
          provenance = { kind: 'frozen_public_static', bankUid: trusted.record.bankUid, revision: trusted.record.revision, staticRef: trusted.record.contentManifest.staticRef, registryDigest: frozen.digest };
        } else {
          const stored = this.#syncTransaction(identity, (_, content) => content.manifest(reference?.contentDigest || p.contentDigest));
          if (sourceChange.kind === 'history_snapshot' && !stored) {
            reference = null;
            provenance = { kind: 'missing' };
          } else {
            if (!reference && stored) reference = { contentDigest: p.contentDigest, manifestDigest: p.chunkManifestDigest, chunkCount: stored.manifest.chunkCount, totalBytes: stored.manifest.totalBytes };
            provenance = { kind: reference ? 'server_chunks' : 'missing' };
          }
        }
        return validateCloudContentReference({ sourceChange, reference: reference || null, provenance });
      });
      let bytes = 0, count = 0;
      for (const record of page.records) { const size = canonicalBytes(record).length + 1; if (bytes + size > 480 * 1024) break; bytes += size; count++; }
      if (count < page.records.length) {
        if (!count) throw cause('EXPORT_ROW_TOO_LARGE');
        page.records = page.records.slice(0, count); page.next = page.records.at(-1).sourceChange.serverSeq; page.hasMore = true;
      }
      return page;
  }

  async #proveCloudCheckpoint(identity, snapshot) {
    const reasons = new Set(), coverage = Object.fromEntries(CLOUD_COVERAGE.map(key => [key, true]));
    const frozen = this.#exportTransaction(identity, repository => repository.registry(snapshot.exportId));
    const registry = new Map(frozen.entries.map(entry => [entry.key, { record: entry.record, publicContentReference: entry.reference }]));
    const verifiedContents = new Set();
    const mark = (reason, ...keys) => { reasons.add(reason); for (const key of keys) coverage[key] = false; };
    const visit = async (section, callback) => {
      let after = '0';
      for (;;) {
        const page = this.#cloudExportPage(identity, { exportId: snapshot.exportId, section, after, limit: 100 });
        for (const record of page.records) await callback(record);
        after = page.next; if (!page.hasMore) break;
      }
    };
    let seq = 0n;
    await visit('accepted-changes.ndjson', async raw => {
      try {
        const change = validateChangeLogRecord(raw);
        if (change.accountGeneration !== snapshot.generation || BigInt(change.serverSeq) !== ++seq || await sha256Hex(canonicalBytes({ protocolVersion: 2, kind: change.kind, entityKey: change.entityKey, payload: change.payload })) !== change.payloadDigest
          || !this.#exportTransaction(identity, repository => repository.hasAcceptedReceipt(snapshot.exportId, change.serverSeq, change.payloadDigest))) throw cause('EXPORT_CONFLICT');
        if (change.kind === 'attempt_manifest') {
          const retired = this.#exportTransaction(identity, repository => repository.latestChangeAtCut(snapshot.exportId, 'entity_tombstone', change.entityKey));
          if (!retired) {
            const scope = this.#exportTransaction(identity, repository => repository.latestChangeAtCut(snapshot.exportId, 'attempt_scope', change.entityKey));
            if (!scope || scope.payload.attemptId !== change.payload.attemptId || scope.payload.scopeDigest !== change.payload.scopeDigest || scope.payload.reference.contentDigest !== change.payload.scopeDigest) mark('missing_scope_at_cut', 'attempts', 'contentClosure');
            const resume = this.#exportTransaction(identity, repository => repository.latestChangeAtCut(snapshot.exportId, 'resume_state', change.entityKey));
            if (!resume || resume.payload.attemptId !== change.payload.attemptId || resume.payload.writerStreamId !== change.payload.writerStreamId) mark('missing_resume_at_cut', 'attempts', 'latestDrafts', 'contentClosure');
          }
        }
      } catch { mark('invalid_accepted_fact', 'acceptedFacts', 'attempts', 'latestDrafts', 'tombstones'); }
    });
    if (seq !== BigInt(snapshot.exportCut)) mark('incomplete_accepted_log', 'acceptedFacts', 'attempts', 'latestDrafts', 'tombstones');
    await visit('mutation-receipts.ndjson', async row => {
      try {
        if (!exactRecord(row, ['receipt', 'mutation'])) throw cause('EXPORT_CONFLICT');
        const receipt = validateMutationReceipt(row.receipt);
        if (!row.mutation) { mark('original_mutation_wire_unavailable', 'permanentMutationReceipts', 'serverConflicts'); return; }
        const mutation = row.mutation;
        if (!await verifyMutationDigest(mutation) || mutation.mutationId !== receipt.mutationId || mutation.payloadDigest !== receipt.payloadDigest || receipt.status === 'missing_dependency') throw cause('EXPORT_CONFLICT');
        if (receipt.status === 'accepted' || receipt.status === 'duplicate') {
          const change = this.#exportTransaction(identity, repository => repository.changeAt(snapshot.exportId, receipt.serverSeq));
          if (!change || change.kind !== mutation.kind || change.entityKey !== mutation.entityKey || change.payloadDigest !== mutation.payloadDigest || new TextDecoder().decode(canonicalBytes(change.payload)) !== new TextDecoder().decode(canonicalBytes(mutation.payload))) throw cause('EXPORT_CONFLICT');
        }
      } catch { mark('receipt_fact_mismatch', 'permanentMutationReceipts', 'serverConflicts'); }
    });
    await visit('content-references.ndjson', async row => {
      try {
        validateCloudContentReference(row);
        const change = row.sourceChange;
        const p = validateChangeLogRecord(change).payload;
        if (row.provenance.kind === 'missing') throw cause('MISSING_DEPENDENCY');
        if (change.kind === 'bank_revision' && p.contentManifest.kind === 'public_static') {
          const trusted = registry.get(`${p.bankUid}:${p.revision}`);
          if (!trusted || new TextDecoder().decode(canonicalBytes(trusted.record)) !== new TextDecoder().decode(canonicalBytes({ bankUid: p.bankUid, revision: p.revision, metadata: p.metadata, contentManifest: p.contentManifest }))) throw cause('CONTENT_CONFLICT');
          return;
        }
        let reference = row.reference;
        if (reference && [...registry.values()].some(entry => new TextDecoder().decode(canonicalBytes(entry.publicContentReference)) === new TextDecoder().decode(canonicalBytes(reference)))) return;
        const stored = this.#syncTransaction(identity, (_, content) => content.manifest(reference?.contentDigest || p.contentDigest));
        if (!stored) throw cause('MISSING_DEPENDENCY');
        const manifest = validateChunkManifest(stored.manifest);
        if (!reference) reference = { contentDigest: p.contentDigest, manifestDigest: p.chunkManifestDigest, chunkCount: manifest.chunkCount, totalBytes: manifest.totalBytes };
        validateContentReference(reference);
        if (reference.manifestDigest !== stored.manifestDigest || await sha256Hex(canonicalBytes(manifest)) !== reference.manifestDigest || manifest.contentDigest !== reference.contentDigest || manifest.chunkCount !== reference.chunkCount || manifest.totalBytes !== reference.totalBytes) throw cause('CONTENT_CONFLICT');
        if(change.kind==='resume_state'){
          const resume=await this.#readContentJson(identity,p.contentDigest);if(!resume)throw cause('MISSING_DEPENDENCY');const state=validateResumeState(resume.value);
          if(state.snapshotBaseline){const atCut=(kind,key)=>this.#exportTransaction(identity,repository=>repository.latestChangeAtCut(snapshot.exportId,kind,key))?.payload;
            await this.#proveSnapshotBaseline(identity,state.snapshotBaseline,atCut);
            const baselineChange=this.#exportTransaction(identity,repository=>repository.latestChangeAtCut(snapshot.exportId,'history_snapshot',`history_snapshot:${state.snapshotBaseline.snapshotId}`));
            if(!baselineChange||BigInt(baselineChange.serverSeq)>BigInt(change.serverSeq))throw cause('MISSING_DEPENDENCY');}
        }
        if (change.kind === 'history_snapshot') {
          if (new TextDecoder().decode(canonicalBytes(reference)) !== new TextDecoder().decode(canonicalBytes(p.reference))) throw cause('CONTENT_CONFLICT');
          const historySnapshot = await this.#readContentJson(identity, reference.contentDigest);
          if (!historySnapshot || historySnapshot.manifestDigest !== reference.manifestDigest
            || historySnapshot.manifest.chunkCount !== reference.chunkCount || historySnapshot.manifest.totalBytes !== reference.totalBytes) throw cause('CONTENT_CONFLICT');
          const body = await validateHistorySnapshotBinding(p, historySnapshot.value, { accountGeneration: snapshot.generation });
          const refsStatus = this.#syncTransaction(identity, repository => repository.historySnapshotReferencesStatus(
            body.scope.flatMap(row => row.equivalentSourceRefs), { acceptedAtSeq: change.serverSeq }));
          if (refsStatus !== 'ok') throw cause(refsStatus === 'missing_dependency' ? 'MISSING_DEPENDENCY' : 'CONTENT_CONFLICT');
        }
        if (verifiedContents.has(reference.contentDigest)) return;
        const stream = new crypto.DigestStream('SHA-256'), writer = stream.getWriter();
        try {
          for (const expected of manifest.chunks) {
            const chunk = this.#syncTransaction(identity, (_, content) => content.readChunk(reference.contentDigest, expected.chunkIndex));
            if (chunk.byteLength !== expected.byteLength || chunk.digest !== expected.sha256 || await sha256Hex(chunk.bytes) !== expected.sha256) throw cause('CONTENT_CONFLICT');
            await writer.write(chunk.bytes);
          }
          await writer.close();
          if (Array.from(new Uint8Array(await stream.digest), byte => byte.toString(16).padStart(2, '0')).join('') !== reference.contentDigest) throw cause('CONTENT_CONFLICT');
          verifiedContents.add(reference.contentDigest);
        } catch (error) { await writer.abort().catch(() => {}); stream.digest.catch(() => {}); throw error; }
      } catch { mark('incomplete_content_closure', 'contentClosure'); }
    });
    return { coverage, complete: reasons.size === 0, partialReasons: [...reasons] };
  }

  readExportPageTrusted(claim, input) {
    try {
      if (!exactRecord(input, ['exportId', 'section', 'after', 'limit'])) return failure('INVALID_EXPORT_INPUT');
      return { ok: true, ...this.#cloudExportPage(claim, input, true) };
    } catch (error) { return failure(publicError(error)); }
  }

  readExportChunkTrusted(claim, input) {
    try {
      if (!exactRecord(input, ['exportId', 'contentDigest', 'chunkIndex'])) return failure('INVALID_EXPORT_INPUT');
      if (!this.#exportTransaction(claim, repository => repository.permitsChunk(input.exportId, input.contentDigest))) return failure('EXPORT_UNAVAILABLE');
      return this.readChunkTrusted(claim, { contentDigest: input.contentDigest, chunkIndex: input.chunkIndex });
    } catch (error) { return failure(publicError(error)); }
  }

  async resetExportTrusted(claim, input) {
    try {
      if (!exactRecord(input, ['exportId'])) return failure('INVALID_EXPORT_INPUT');
      const identity = captureSyncClaim(this.env, this.ctx, claim);
      const exportId = input.exportId;
      const described = this.#exportTransaction(identity, repository => repository.describe(exportId));
      if (!described.checkpoint || !validateCloudCheckpoint(described.checkpoint).complete) return failure('EXPORT_INCOMPLETE');
      const checkpoint = described.checkpoint;
      if (await sha256Hex(canonicalBytes(checkpoint)) !== described.checkpointDigest) return failure('EXPORT_CONFLICT');
      const current = this.#exportTransaction(identity, repository => repository.describe(exportId));
      if (current.checkpointDigest !== described.checkpointDigest) return failure('EXPORT_CONFLICT');
      // This is a rebuilding capability, never a command to clear local facts.
      return { ok: true, reset: validateCursorReset({ reason: 'verified_cloud_checkpoint', generation: checkpoint.generation, logEpoch: checkpoint.logEpoch, earliestAvailableSeq: '0', resetExportId: exportId, exportCut: checkpoint.cut, manifestDigest: described.checkpointDigest, pageUrl: '/api/v2/export/page', expiresAt: described.expiresAt }) };
    } catch (error) { return failure(publicError(error)); }
  }

  readChunkTrusted(claim, input) {
    try {
      if (!exactRecord(input, ['contentDigest', 'chunkIndex'])) return failure('INVALID_CONTENT_INPUT');
      return { ok: true, ...this.#syncTransaction(claim, (_, content) => content.readChunk(input.contentDigest, input.chunkIndex)) };
    } catch (error) { return failure(publicError(error)); }
  }

  async #readContentJson(claim, digest, canonical = true) {
    const stored = this.#syncTransaction(claim, (_, content) => content.manifest(digest));
    if (!stored) return null;
    // Raw 100 MiB publication is streaming. The current semantic JSON verifier
    // is intentionally fail-closed above its bounded 3 MiB working snapshot,
    // not a new product quota and not a claim of large resume support.
    if (stored.manifest.totalBytes > 3 * 1024 * 1024) throw cause('CONTENT_VALIDATION_UNAVAILABLE');
    const bytes = new Uint8Array(stored.manifest.totalBytes); let offset = 0;
    for (const expected of stored.manifest.chunks) {
      const chunk = this.#syncTransaction(claim, (_, content) => content.readChunk(digest, expected.chunkIndex));
      bytes.set(chunk.bytes, offset); offset += chunk.bytes.length;
    }
    let value;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw cause('INVALID_CONTENT_INPUT'); }
    if (canonical && await sha256Hex(canonicalContentBytes(value)) !== digest) throw cause('CONTENT_CONFLICT');
    return { ...stored, value };
  }

  async #proveSnapshotBaseline(claim,baseline,readEntity){
    // The runtime base owns these injected fields; this local structural view
    // supplies their concrete types without changing the Durable Object class.
    const proofStore=/** @type {AccountGenerationStore & {env:Parameters<typeof readFrozenAccountPublicBank>[0],ctx:{storage:{sql:{exec:(query:string,...bindings:(string|number)[])=>{toArray:()=>{record_json:string}[]}}}}}} */(/** @type {unknown} */(this));
    /** @type {Map<string,Awaited<ReturnType<typeof validateBankContent>>|Awaited<ReturnType<typeof readFrozenAccountPublicBank>>>} */
    const banks=new Map();let retainedPublicBytes=0;const publicRegistry=loadAccountPublicRegistry(proofStore.env);
    return validateSnapshotContinuationBaseline(baseline,{owner:{ownerKind:'account',accountGeneration:claim.generation},
      isTombstoned:async(kind,id)=>!!readEntity('entity_tombstone',`${kind}:${id}`),
      readSnapshot:async id=>{const record=readEntity('history_snapshot',`history_snapshot:${id}`);if(!record)throw cause('MISSING_DEPENDENCY');const stored=await this.#readContentJson(claim,record.reference.contentDigest);if(!stored||stored.manifestDigest!==record.reference.manifestDigest)throw cause('MISSING_DEPENDENCY');return {record,body:stored.value};},
      resolveQuestion:async ref=>{const uid=ref.questionKey.split('/')[0],key=`${uid}:${ref.bankRevision}`,cached=banks.get(key);if(cached)return cached.content.questions.find(q=>q.questionKey===ref.questionKey&&q.questionRevision===ref.questionRevision);if(!uid)throw cause('MISSING_DEPENDENCY');const rows=this.#syncTransaction(claim,()=>proofStore.ctx.storage.sql.exec('SELECT record_json FROM gen06_bank_revisions WHERE bank_uid=? AND revision=?',uid,ref.bankRevision).toArray());
        if(rows.length!==1)throw cause('MISSING_DEPENDENCY');const record=JSON.parse(rows[0].record_json);let checked;
        if(record.contentManifest.kind==='public_static'){checked=await readFrozenAccountPublicBank(proofStore.env,record,publicRegistry);retainedPublicBytes+=checked.retainedProjectionBytes;if(retainedPublicBytes>8*1048576)throw cause('PUBLIC_PROJECTION_LIMIT');}
        else {const stored=await this.#readContentJson(claim,ref.bankRevision);if(!stored)throw cause('MISSING_DEPENDENCY');checked=await validateBankContent(stored.value);}if(checked.content.bankUid!==uid||checked.contentDigest!==ref.bankRevision||new TextDecoder().decode(canonicalBytes(checked.content.metadata))!==new TextDecoder().decode(canonicalBytes(record.metadata)))throw cause('CONTENT_CONFLICT');banks.set(key,checked);return checked.content.questions.find(q=>q.questionKey===ref.questionKey&&q.questionRevision===ref.questionRevision);}});
  }
  /** @param {{principal:string,incarnation:string,generation:string}} claim
   * @param {import('../../src/domain/app-data/contracts').ResumeState} state
   * @param {import('../../src/domain/app-data/contracts').AttemptManifestPayload} attempt
   * @param {import('../../src/domain/app-data/contracts').PushRequest} request
   * @param {import('../../src/domain/app-data/snapshot-continuation.js').BaselineProof} snapshotProof */
  async #proveSnapshotInitialization(claim,state,attempt,request,snapshotProof) {
    // The runtime base owns these injected fields; this local structural view
    // supplies their concrete types without changing the Durable Object class.
    const proofStore=/** @type {AccountGenerationStore & {env:Parameters<typeof readFrozenAccountPublicBank>[0],ctx:{storage:{sql:{exec:(query:string,...bindings:(string|number)[])=>{toArray:()=>{record_json:string}[]}}}}}} */(/** @type {unknown} */(this));
    const initialMutation=request.mutations.find(m=>m.kind==='resume_state'&&m.payload.attemptId===state.attemptId&&m.payload.writerStreamId===state.writerStreamId&&m.payload.localRevision===1);
    let initial;
    if(initialMutation){
      const index=request.mutations.indexOf(initialMutation),accepted=/** @type {{record_json:string}[]} */(this.#syncTransaction(claim,()=>proofStore.ctx.storage.sql.exec("SELECT record_json FROM gen06_change_log WHERE json_extract(record_json,'$.kind')='answer_event' AND json_extract(record_json,'$.payload.event.attemptId')=? AND json_extract(record_json,'$.payload.event.writerStreamId')=? ORDER BY length(server_seq),server_seq",state.attemptId,state.writerStreamId).toArray())).map(row=>JSON.parse(row.record_json).payload.event),events=[...accepted,...request.mutations.slice(0,index).flatMap(m=>m.kind==='answer_event'&&m.payload.event.attemptId===state.attemptId&&m.payload.event.writerStreamId===state.writerStreamId?[m.payload.event]:[])];
      initial={reference:initialMutation.payload,events};
    } else {
      const rows=this.#syncTransaction(claim,()=>proofStore.ctx.storage.sql.exec("SELECT record_json FROM gen06_change_log WHERE json_extract(record_json,'$.kind')='resume_state' AND json_extract(record_json,'$.payload.attemptId')=? AND json_extract(record_json,'$.payload.writerStreamId')=? AND json_extract(record_json,'$.payload.localRevision')=1 ORDER BY length(server_seq),server_seq LIMIT 1",state.attemptId,state.writerStreamId).toArray());
      if(rows.length===1){const reference=JSON.parse(rows[0].record_json).payload;initial=this.#syncTransaction(claim,(/** @type {ReturnType<typeof createAccountSyncRepository>} */ repository)=>repository.readHistoricalResumeProof(state.attemptId,reference.contentDigest));}
    }
    if(!initial)throw cause('MISSING_DEPENDENCY');
    const stored=await this.#readContentJson(claim,initial.reference.contentDigest);if(!stored)throw cause('MISSING_DEPENDENCY');
    const initialized=validateResumeState(stored.value);
    if(!initialized.snapshotBaseline||new TextDecoder().decode(canonicalBytes(initialized.snapshotBaseline))!==new TextDecoder().decode(canonicalBytes(state.snapshotBaseline)))throw cause('CONTENT_CONFLICT');
    const validation=await validateResumeDependencies(initialized,initial.reference,stored.manifest,initial.events,this.#resumeAttemptBinding(attempt),{parents:[],snapshotProofs:[snapshotProof]});
    if(validation.status!=='payload_verified')throw cause('MISSING_DEPENDENCY');
  }
  async #prepareSyncDependencies(claim, request) {
    const dependencies = { contents: new Map(), publicRegistry: loadAccountPublicRegistry(this.env) };
    const entity = (kind, key) => this.#syncTransaction(claim, repository => repository.readEntity(kind, key));
    const expectedAttempt = id => request.mutations.find(m => m.kind === 'attempt_manifest' && m.payload.attemptId === id)?.payload || entity('attempt_manifest', `attempt:${id}`);
    const eventsFor = state => state.submittedEventIds.map(id => request.mutations.find(m => m.kind === 'answer_event' && m.payload.event.eventId === id)?.payload.event || entity('answer_event', `event:${id}`)?.event).filter(Boolean);
    for (const mutation of request.mutations) {
      const p = mutation.payload;
      if (mutation.kind === 'attempt_scope') {
        const stored = await this.#readContentJson(claim, p.reference.contentDigest); if (!stored) continue;
        const scope = validateAttemptScope(stored.value, p.attemptId, stored.value.length);
        dependencies.contents.set(p.reference.contentDigest, { scope, scopeDigest: await sha256Hex(canonicalContentBytes(scope)) });
      } else if (mutation.kind === 'bank_revision' && p.contentManifest.kind === 'private_chunks') {
        const stored = await this.#readContentJson(claim, p.contentManifest.reference.contentDigest); if (!stored) continue;
        const verified = await validateBankContent(stored.value);
        if (verified.content.bankUid !== p.bankUid || verified.contentDigest !== p.revision || verified.contentDigest !== p.contentManifest.reference.contentDigest
          || new TextDecoder().decode(canonicalBytes(verified.content.metadata)) !== new TextDecoder().decode(canonicalBytes(p.metadata))) throw cause('CONTENT_CONFLICT');
        dependencies.contents.set(p.contentManifest.reference.contentDigest, { bankQuestions: verified.questionRefs });
      } else if (mutation.kind === 'bank_revision' && p.contentManifest.kind === 'protected_cipher') {
        const stored = await this.#readContentJson(claim, p.contentManifest.reference.contentDigest, false); if (!stored) continue;
        if (p.revision !== p.contentManifest.reference.contentDigest) throw cause('CONTENT_CONFLICT');
        if (stored.value?.format === PROTECTED_BANK_V2_FORMAT) {
          const verified = await validateProtectedBankEnvelopeV2(stored.value);
          if (verified.contentDigest !== p.revision || verified.envelope.bankUid !== p.bankUid || p.metadata.visibility !== 'protected'
            || verified.questionRefs.length !== p.metadata.questionCount) throw cause('CONTENT_CONFLICT');
          dependencies.contents.set(p.contentManifest.reference.contentDigest, { cipherEnvelope: true, protectedQuestions: verified.questionRefs, proofClass: 'authenticated-owner-declared-encrypted-index' });
        } else {
          validateProtectedBankEnvelope(stored.value);
          dependencies.contents.set(p.contentManifest.reference.contentDigest, { cipherEnvelope: true, protectedQuestions: [], proofClass: 'legacy-cipher-storage-only-no-v2-question-proof' });
        }
      } else if (mutation.kind === 'history_snapshot') {
        const stored = await this.#readContentJson(claim, p.reference.contentDigest);
        if (!stored) continue;
        if (stored.manifestDigest !== p.reference.manifestDigest
          || stored.manifest.chunkCount !== p.reference.chunkCount
          || stored.manifest.totalBytes !== p.reference.totalBytes) throw cause('CONTENT_CONFLICT');
        const snapshot = await validateHistorySnapshotBinding(p, stored.value, { accountGeneration: claim.generation });
        if(snapshot.source.namespace==='legacy_account'&&this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='gen11_source_dispositions'").toArray().length&&this.ctx.storage.sql.exec("SELECT source_key FROM gen11_source_dispositions WHERE source_key=? AND generation=? AND incarnation=? AND disposition='discard-authorized'",`history:${snapshot.source.recordId}`,claim.generation,claim.incarnation).toArray().length)throw cause('CONTENT_CONFLICT');
        dependencies.contents.set(p.reference.contentDigest, { historySnapshot: snapshot });
      } else if (mutation.kind === 'resume_state') {
        const stored = await this.#readContentJson(claim, p.contentDigest); if (!stored) continue;
        const state = validateResumeState(stored.value); const attempt = expectedAttempt(p.attemptId); if (!attempt) continue;
        const previous=entity('resume_state',`attempt:${p.attemptId}`);if(previous){const original=await this.#readContentJson(claim,previous.contentDigest);if(!original)throw cause('MISSING_DEPENDENCY');const before=validateResumeState(original.value);if(before.snapshotBaseline&&(!state.snapshotBaseline||new TextDecoder().decode(canonicalBytes(before.snapshotBaseline))!==new TextDecoder().decode(canonicalBytes(state.snapshotBaseline))))throw cause('CONTENT_CONFLICT');}

        const parents = []; const visited = new Set(); const queue = [...state.questionDrafts];
        while (queue.length) {
          const inherited = queue.shift().inheritedFrom; if (!inherited || visited.has(inherited.resumeContentDigest)) continue;
          visited.add(inherited.resumeContentDigest); if (visited.size > 32) throw cause('INVALID_CONTENT_INPUT');
          const parentProof = this.#syncTransaction(claim, repository => repository.readHistoricalResumeProof(inherited.attemptId, inherited.resumeContentDigest));
          if (!parentProof) continue;
          const parentContent = await this.#readContentJson(claim, inherited.resumeContentDigest); if (!parentContent) continue;
          const parentState = validateResumeState(parentContent.value); const parentAttempt = entity('attempt_manifest', `attempt:${inherited.attemptId}`); if (!parentAttempt) continue;
          parents.push({ state: parentState, reference: parentProof.reference, manifest: parentContent.manifest, events: parentProof.events, expectedAttempt: this.#resumeAttemptBinding(parentAttempt) });
          queue.push(...parentState.questionDrafts);
        }
        const snapshotProofs=[];for(const resume of [state,...parents.map(parent=>parent.state)])if(resume.snapshotBaseline){const proof=await this.#proveSnapshotBaseline(claim,resume.snapshotBaseline,entity);snapshotProofs.push(proof);const ownerAttempt=expectedAttempt(resume.attemptId);if(!ownerAttempt)throw cause('MISSING_DEPENDENCY');await this.#proveSnapshotInitialization(claim,resume,ownerAttempt,request,proof);}
        const verification = await validateResumeDependencies(state, p, stored.manifest, eventsFor(state), this.#resumeAttemptBinding(attempt), { parents,snapshotProofs });
        dependencies.contents.set(p.contentDigest, { resume: state, resumeDependencyStatus: verification.status });
      }
    }
    return dependencies;
  }

  #resumeAttemptBinding(p) {
    return { attemptId: p.attemptId, writerStreamId: p.writerStreamId, scopeDigest: p.scopeDigest, scopeCount: p.scopeCount, ...(p.parentAttemptId ? { parentAttemptId: p.parentAttemptId } : {}) };
  }

}
