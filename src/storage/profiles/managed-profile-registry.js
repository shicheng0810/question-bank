import {validateTrackedAllocationLineage} from './source-allocation-lineage.js';
import { canonicalDigest, canonicalBytes, canonicalContentBytes, sha256Hex, validateActiveProfilePointer, validateCursorReset,APP_DATA_STORES,validateChunkManifest,validateMetaRecord,validateStoreRecord } from "../../domain/app-data/index.js";
import {ownedWriteInput} from '../idb/write-input.js';
import {openCloudNativeDatabase} from '../cloud-recovery/native-stage.js';
import { openProfileContext } from "../idb/profile-context.js";
import { BUSINESS_SCHEMA_VERSION, upgradeBusinessSchema } from '../idb/schema.js';
import {
  cloneData,
  assertBusinessDbName,
  controlDbName,
  openControlDatabase,
  profileError,
  sameOwner,
  snapshotOwner,
  stableData,
  validateCleanupJob,validateCleanupFrame,validateCleanupCommitment,validateCleanupPrepare,
  validateProfileJournalPair
} from "./control-schema.js";
import { inspectFreshBusinessProfile } from "./fresh-verification.js";
import { captureProfile, validateSnapshot } from '../backup/snapshot.js';
import {withProfileWriteLock} from './write-lock.js';
import {withCleanupJobLock} from './cleanup-lock.js';
import {openDB,unwrap} from 'idb';
import {createBoundedNativeAccess} from '../cloud-recovery/bounded-native.js';
import {validateCloudStageJournal,validateCloudPageReceipt,cloudTemporaryDigest} from '../cloud-recovery/metadata.js';
import {validateCloudStageIndexShape,verifyCloudStageIndex} from '../cloud-recovery/stage-index.js';
import {validateCloudContentReference,validateCloudCheckpoint} from '../../../do-worker/src/account-cloud-checkpoint.js';
import {mergeLatestSavedNative,readLatestSavedMergeDiagnostics} from '../cloud-recovery/bounded-latest-saved-merge.js';
import {consumeCloudProjectionSource} from '../cloud-recovery/index.js';
import {renewHeldCheckpointSourceLease} from '../idb/learning-authority.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OWN = Object.prototype.hasOwnProperty;
export function sameOptionalSourceAllocationCommit(left,right){if(left===undefined||right===undefined)return left===undefined&&right===undefined;return sameStoredData(left,right);}
export function validateSourceAllocationMarker(input){
 const value=ownedWriteInput(input),keys=['key','format','owner','profileId','jobId','dbName','originalPointer','sourceProfileId','leaseOwnerTabId','leaseFence','purpose','status'];
 if(Object.keys(value).sort().join()!==keys.sort().join()||value.format!=='qb-cloud-source-allocation-v1'||value.purpose!=='checkpoint-preverification'||!['allocated','quarantined','committed'].includes(value.status)||!UUID_V4.test(value.profileId)||!UUID_V4.test(value.jobId)||!UUID_V4.test(value.sourceProfileId)||!UUID_V4.test(value.leaseOwnerTabId)||!Number.isSafeInteger(value.leaseFence)||value.leaseFence<1||value.key!==`source-allocation:${value.profileId}`||typeof value.dbName!=='string')throw profileError('CORRUPT','source allocation marker invalid');
 const owner=snapshotOwner(value.owner);if(owner.ownerKind!=='account')throw profileError('CORRUPT','source allocation owner invalid');assertBusinessDbName(value.dbName);validateActiveProfilePointer(value.originalPointer);if(value.originalPointer.activeProfileId!==value.sourceProfileId)throw profileError('CORRUPT','source allocation pointer invalid');return value;
}
export function validateSourceAllocationCommit(input){
 const v=ownedWriteInput(input);if(Object.keys(v).sort().join()!=='format,key,marker,sourceJournal,sourceProfile,targetJournal,targetPointer,targetProfile'||v.format!=='qb-cloud-source-commit-v1')throw profileError('CORRUPT','source allocation commit shape invalid');const marker=validateSourceAllocationMarker(v.marker),source=validateProfileJournalPair(v.sourceProfile,v.sourceJournal,{allowStaged:true}),target=validateProfileJournalPair(v.targetProfile,v.targetJournal);validateActiveProfilePointer(v.targetPointer);if(v.key!==`source-allocation-commit:${marker.profileId}`||marker.status!=='committed'||source.journal.kind!=='qb-v2-staged-restore'||source.phase!=='created'||source.profile.profileId!==marker.profileId||source.journal.jobId!==marker.jobId||source.profile.dbName!==marker.dbName||!sameOwner(source.owner,marker.owner)||!sameOwner(target.owner,marker.owner)||target.phase!=='completed'||v.targetPointer.activeProfileId!==target.profile.profileId||v.targetPointer.activationRevision!==marker.originalPointer.activationRevision+1||target.profile.profileId===marker.profileId)throw profileError('CORRUPT','source allocation commit tuple invalid');return v;
}

const equalBytes=(a,b)=>a instanceof Uint8Array&&b instanceof Uint8Array&&a.length===b.length&&a.every((value,index)=>value===b[index]);
const finalProofWorkspaces=new WeakMap();
const latestMergePairs=new WeakMap();
const finalCommitErrors=new WeakMap();
const heldCheckpointLeases=new WeakMap();
const sourceStageRegistries=new WeakMap();
const sourceAllocationFailures=new WeakMap();
// Diagnostic locator only. It cannot authorize reads, cleanup, or activation.
export function consumePreverificationAllocationFailure(registry,cause){const binding=sourceStageRegistries.get(registry),record=cause&&typeof cause==='object'?sourceAllocationFailures.get(cause):undefined;if(!binding||!record||record.binding!==binding)return null;sourceAllocationFailures.delete(cause);return cloneData(record.locator);}
// Aliases carry only their genuine base's private closure. Alias methods,
// callbacks, copied fields and caller-supplied raw handles are never evidence.
export function registerManagedSourceRegistryAlias(base,alias){const state=sourceStageRegistries.get(base);if(!state||state.base!==base||!alias||Object.getPrototypeOf(alias)!==Object.prototype||!Object.isFrozen(alias)||sourceStageRegistries.has(alias))throw profileError('CLOUD_SOURCE_REGISTRY_INVALID','genuine base and fresh frozen alias required');state.assertOpen();sourceStageRegistries.set(alias,state);return alias;}
export async function bindPreverificationSourceRegistry(registry,input){const state=sourceStageRegistries.get(registry);if(!state)throw profileError('CLOUD_SOURCE_REGISTRY_INVALID','genuine managed registry required');state.assertOpen();return state.bind(ownedWriteInput(input));}
export async function allocatePreverificationSourceStage(registry){const state=sourceStageRegistries.get(registry);if(!state)throw profileError('CLOUD_SOURCE_REGISTRY_INVALID','genuine managed registry required');state.assertOpen();return state.allocate();}
export async function reconcilePreverificationAllocation(registry,input){const state=sourceStageRegistries.get(registry);if(!state)throw profileError('CLOUD_SOURCE_REGISTRY_INVALID','genuine managed registry required');state.assertOpen();return state.reconcile(ownedWriteInput(input));}
export async function listPreverificationAllocations(registry){const state=sourceStageRegistries.get(registry);if(!state)throw profileError('CLOUD_SOURCE_REGISTRY_INVALID','genuine managed registry required');state.assertOpen();return state.list();}

const cleanupMaintenanceCaps=new WeakMap();
export function assertHeldCheckpointSourceLease(capability,database){const state=heldCheckpointLeases.get(capability);if(!state||state.database!==database)throw profileError('INVALID','genuine held source lease/raw pair required');state.binding.assertLive();return state.binding;}
/** Error flags alone are not authority: only an actual terminal control
 * transaction completion recorded by this module matches. No Ready/raw leaks. */
export function isFinalControlCommitError(error,profileId){const actual=finalCommitErrors.get(error);return Boolean(actual)&&typeof profileId==='string'&&actual.profileId===profileId;}
/** A real exclusive-held registry pair, not a DTO/guard supplied by a caller. */
export function assertLatestMergePair(value,sourceDatabase,targetDatabase){const state=latestMergePairs.get(value);if(!state)throw profileError('INVALID','not a private latest merge pair');state.assertLive();if(state.sourceDatabase!==sourceDatabase||state.targetDatabase!==targetDatabase)throw profileError('INVALID','latest merge database identities differ');return Object.freeze({assertLive:state.assertLive,recheck:state.recheck,trackTransaction:state.trackTransaction,verifiedSource:state.verifiedSource,checkpoint:state.checkpoint,operationalMetaKeys:state.operationalMetaKeys});}
/** Only registry-minted, still-held inactive workspaces pass. No raw DB leaks. */
export function assertFinalProofWorkspace(value,database){const state=finalProofWorkspaces.get(value);if(!state)throw profileError('INVALID','not a private final proof workspace');state.assertLive();if(!state.matchesDatabase(database))throw profileError('INVALID','final proof workspace database identity differs');return true;}
export function assertHeldProjectionTarget(value,database){assertFinalProofWorkspace(value,database);const state=finalProofWorkspaces.get(value);return Object.freeze({recheck:state.recheck,metadata:cloneData(state.metadata),proofWorkspace:value});}
/** True binding identity is a closure retained in the registry WeakMap. The
 * snapshot is informational; only this identity/check can bind a future proof. */
export function assertFinalProofBinding(value,database){assertFinalProofWorkspace(value,database);return finalProofWorkspaces.get(value).binding;}

/** @param {unknown} value @param {string} label */
function exactInput(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) throw profileError("INVALID", `${label} must be a plain data object`);
  for (const name of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !OWN.call(descriptor, "value")) throw profileError("INVALID", `${label}.${name} must be a data property`);
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {unknown} options */
function snapshotOptions(options) {
  const value = exactInput(options, "open options");
  const allowed = new Set(["owner", "controlId", "controlOpenMode", "blockedTimeoutMs", "signal", "namespace", "guardOwner"]);
  if (Object.keys(value).some((key) => !allowed.has(key)) || !OWN.call(value, "owner") || !OWN.call(value, "controlId") || !OWN.call(value, "controlOpenMode") || !OWN.call(value, "blockedTimeoutMs")) throw profileError("INVALID", "open options contain unsupported fields");
  const owner = snapshotOwner(value.owner);
  const namespace = value.namespace || "test";
  const dbName = controlDbName(value.controlId, namespace);
  if (value.controlOpenMode !== "create" && value.controlOpenMode !== "existing") throw profileError("INVALID", "controlOpenMode must be create or existing");
  if (!Number.isSafeInteger(value.blockedTimeoutMs) || value.blockedTimeoutMs < 1 || value.blockedTimeoutMs > 2_147_483_647) throw profileError("INVALID", "blockedTimeoutMs must be a bounded positive safe integer");
  if (value.signal !== undefined && !(value.signal instanceof AbortSignal)) throw profileError("INVALID", "signal must be an AbortSignal");
  if (value.guardOwner !== undefined && typeof value.guardOwner !== 'function') throw profileError('INVALID', 'guardOwner must be a function');
  return Object.freeze({ owner, dbName, namespace, controlOpenMode: value.controlOpenMode, blockedTimeoutMs: value.blockedTimeoutMs, signal: value.signal, guardOwner: value.guardOwner });
}

/** @param {unknown} value */
function requireProfileId(value) {
  if (!UUID_V4.test(/** @type {string} */ (value))) throw profileError("INVALID", "profileId must be a UUIDv4");
  return /** @type {string} */ (value);
}

/** @param {unknown} cause */
function errorCode(cause) {
  return cause && typeof cause === "object" && typeof cause.code === "string" && /^[A-Z0-9_]{1,80}$/.test(cause.code) ? cause.code : "STORAGE_UNAVAILABLE";
}

/** @param {unknown} cause */
function rethrowStorage(cause, message) {
  if (cause?.code) throw cause;
  throw profileError("STORAGE_UNAVAILABLE", message, cause);
}

/** @param {unknown} left @param {unknown} right */
function sameStoredData(left, right) {
  try { return stableData(left) === stableData(right); } catch (cause) { throw profileError("CORRUPT", "stored control record cannot be compared", cause); }
}

/** @param {ReturnType<typeof snapshotOwner>} owner @param {string} profileId @param {string} jobId @param {string} dbName */
function stagedProfile(owner, profileId, jobId, dbName) {
  return owner.ownerKind === "guest"
    ? { profileId, dbName, ownerKind: "guest", state: "staged", schemaVersion: 1, importJobId: jobId }
    : { profileId, dbName, ownerKind: "account", accountId: owner.accountId, accountGeneration: owner.accountGeneration, state: "staged", schemaVersion: 1, importJobId: jobId };
}

/** @param {ReturnType<typeof snapshotOwner>} owner @param {string} profileId @param {string} jobId @param {string} dbName */
function allocatedJournal(owner, profileId, jobId, dbName) {
  return { key: `fresh:${profileId}`, kind: "b1a-fresh-creation", profileId, jobId, dbName, owner: cloneData(owner), phase: "allocated" };
}

/** @param {unknown} profile @param {unknown} journal @param {"allocated"|"creating"|"created"|"completed"|"quarantined"} phase @param {unknown} [failure] */
function journalAtPhase(profile, journal, phase, failure) {
  const result = { key: journal.key, kind: journal.kind, profileId: journal.profileId, jobId: journal.jobId, dbName: journal.dbName, owner: cloneData(journal.owner), phase };
  if (failure) result.failure = failure;
  return result;
}

/** @param {unknown} profile @param {unknown} journal @param {{manifest:unknown,contentDigest:string}} inspected */
function completedPair(profile, journal, inspected) {
  const verifiedAt = new Date().toISOString();
  const verification = { jobId: journal.jobId, schemaVersion: 1, contentDigest: inspected.contentDigest, recordCount: inspected.recordCount ?? 0, verifiedAt };
  const ready = profile.ownerKind === "guest"
    ? { profileId: profile.profileId, dbName: profile.dbName, ownerKind: "guest", state: "ready", schemaVersion: 1, importJobId: journal.jobId, verification, lastVerifiedAt: verifiedAt }
    : { profileId: profile.profileId, dbName: profile.dbName, ownerKind: "account", accountId: profile.accountId, accountGeneration: profile.accountGeneration, state: "ready", schemaVersion: 1, importJobId: journal.jobId, verification, lastVerifiedAt: verifiedAt };
  const completed = { key: journal.key, kind: journal.kind, profileId: journal.profileId, jobId: journal.jobId, dbName: journal.dbName, owner: cloneData(journal.owner), phase: "completed", manifest: cloneData(inspected.manifest), verification };
  return { profile: ready, journal: completed };
}

/** @param {unknown} profile @param {unknown} journal @param {"create"|"inspect"|"finalize"} phase @param {unknown} cause */
function quarantinedPair(profile, journal, phase, cause) {
  const failure = { phase, code: errorCode(cause), observedAt: new Date().toISOString() };
  const quarantined = profile.ownerKind === "guest"
    ? { profileId: profile.profileId, dbName: profile.dbName, ownerKind: "guest", state: "quarantined", schemaVersion: 1, importJobId: journal.jobId }
    : { profileId: profile.profileId, dbName: profile.dbName, ownerKind: "account", accountId: profile.accountId, accountGeneration: profile.accountGeneration, state: "quarantined", schemaVersion: 1, importJobId: journal.jobId };
  return { profile: quarantined, journal: journalAtPhase(profile, journal, "quarantined", failure) };
}

/** @param {unknown} value */
async function completedDigestIsValid(value) {
  return (await canonicalDigest(value.manifest)) === value.verification.contentDigest;
}

/** @param {ReturnType<typeof snapshotOptions>} snapshot */
async function createController(snapshot) {
  const database = await openControlDatabase({ dbName: snapshot.dbName, openMode: snapshot.controlOpenMode, blockedTimeoutMs: snapshot.blockedTimeoutMs, signal: snapshot.signal });
  let closed = false;
  const lifecycle = new AbortController();
  /** @type {Set<import("idb").IDBPTransaction>} */
  const inFlight = new Set();
  const sourceStageAllocations=new Set(),sourceStageBindings=new Set();
  let externalAbortAttached = false;
  const externalAbort = () => invalidate();
  const detachExternalAbort = () => {
    if (!externalAbortAttached) return;
    snapshot.signal?.removeEventListener("abort", externalAbort);
    externalAbortAttached = false;
  };
  const invalidate = () => {
    if (closed) return;
    closed = true;
    detachExternalAbort();
    lifecycle.abort();
    for(const binding of sourceStageBindings)binding.close();sourceStageBindings.clear();sourceStageAllocations.clear();
    for (const tx of inFlight) { try { tx.abort(); } catch { /* completion won */ } }
    inFlight.clear();
    try { database.close(); } catch { /* best effort */ }
  };
  database.onversionchange = invalidate;
  if (snapshot.signal?.aborted) {
    invalidate();
    throw profileError("CLOSED", "managed profile registry was cancelled while opening");
  }
  snapshot.signal?.addEventListener("abort", externalAbort, { once: true });
  externalAbortAttached = snapshot.signal !== undefined;
  if (snapshot.signal?.aborted) {
    invalidate();
    throw profileError("CLOSED", "managed profile registry was cancelled while opening");
  }

  const assertOpen = () => { if (closed || snapshot.signal?.aborted) throw profileError("CLOSED", "managed profile registry is closed"); };
  const signal = lifecycle.signal;
  const finalControlCompletions=new WeakMap();

  /** @template T @param {"readonly"|"readwrite"} mode @param {(tx: import("idb").IDBPTransaction) => Promise<T>} work */
  const controlTx = async (mode, work, terminalWitness, nativeBudgetMs) => {
    assertOpen();
    if (snapshot.guardOwner) { await snapshot.guardOwner(); assertOpen(); }
    let tx;
    try { tx = database.transaction(["profiles", "meta"], mode); } catch (cause) { rethrowStorage(cause, "unable to begin control transaction"); }
    inFlight.add(tx);
    const done = tx.done;
    let nativeTimedOut=false;const nativeTimer=nativeBudgetMs===undefined?null:setTimeout(()=>{nativeTimedOut=true;try{tx.abort();}catch{}},nativeBudgetMs);
    done.catch(() => {});
    const physical=finalControlCompletions.get(terminalWitness);
    if(physical)done.then(()=>{physical.committed=true;},()=>{});
    try {
      const result = await work(tx);
      await done;
      assertOpen();
      if (snapshot.guardOwner) { await snapshot.guardOwner(); assertOpen(); }
      return result;
    } catch (cause) {
      try { tx.abort(); } catch { /* transaction may have settled */ }
      await Promise.allSettled([done]);
      if(physical?.committed){const failure=cause&&typeof cause==='object'&&Object.isExtensible(cause)?cause:profileError('CLOSED','control committed before lifecycle rejection',cause);if(physical.kind==='cleanup'){failure.cleanupCommitted=true;}else{failure.recoveryCommitted=true;failure.committedProfileId=physical.profileId;finalCommitErrors.set(failure,{profileId:physical.profileId});}throw failure;}
      if(nativeTimedOut)throw profileError('CLOUD_CLEANUP_DEADLINE','bounded maintenance control transaction expired',cause);
      if (typeof cause?.code === "string") throw cause;
      if (closed) throw profileError("CLOSED", "managed registry closed during operation", cause);
      throw profileError("ABORTED", "control transaction did not complete", cause);
    } finally {if(nativeTimer!==null)clearTimeout(nativeTimer);inFlight.delete(tx);if(physical)finalControlCompletions.delete(terminalWitness); }
  };

  /** @param {string} profileId */
  const rawPair = (profileId) => controlTx("readonly", async (tx) => {
    const profiles = tx.objectStore("profiles");
    const meta = tx.objectStore("meta");
    const profile = await profiles.get(profileId);
    if (profile === undefined) return null;
    return { profile, journal: await meta.get(`fresh:${profileId}`) };
  });

  /** @param {string} profileId @param {{allowStaged?:boolean, requireOwner?:boolean}} [options] */
  const checkedPair = async (profileId, options = {}) => {
    const raw = await rawPair(profileId);
    if (raw === null) return null;
    const pair = validateProfileJournalPair(raw.profile, raw.journal, { allowStaged: options.allowStaged === true });
    if (options.requireOwner && !sameOwner(pair.owner, snapshot.owner)) throw profileError("OWNER_MISMATCH", "profile belongs to another owner");
    if (pair.phase === "completed" && !(await completedDigestIsValid(pair))) throw profileError("CORRUPT", "completed fresh manifest digest is invalid");
    assertOpen();
    return { ...pair, rawProfile: raw.profile, rawJournal: raw.journal };
  };

  const putInitial = async (profile, journal, marker) => controlTx("readwrite", async (tx) => {
    if(marker){validateSourceAllocationMarker(marker);const meta=tx.objectStore("meta");if(!sameStoredData(await meta.get("activeProfile"),marker.originalPointer))throw profileError("STALE_ACTIVE_PROFILE","source allocation pointer changed");let count=0,cursor=await meta.openCursor(IDBKeyRange.bound("source-allocation:","source-allocation:\uffff"));while(cursor){const existing=validateSourceAllocationMarker(cursor.value);if(cursor.primaryKey!==existing.key||!sameOwner(existing.owner,marker.owner))throw profileError("OWNER_MISMATCH","source allocation inventory identity changed");if(++count>=100)throw profileError("PROOF_ROW_BUDGET","source allocation inventory limit");cursor=await cursor.continue();}await meta.add(marker);}
    await tx.objectStore("profiles").add(profile);
    await tx.objectStore("meta").add(journal);
  });

  /** @param {{profile:unknown,journal:unknown,rawProfile:unknown,rawJournal:unknown}} expected @param {string} expectedPhase @param {(pair:ReturnType<typeof validateProfileJournalPair>)=>{profile?:unknown,journal?:unknown}} make */
  const transition = async (expected, expectedPhase, make) => controlTx("readwrite", async (tx) => {
    const profiles = tx.objectStore("profiles");
    const meta = tx.objectStore("meta");
    const profile = await profiles.get(expected.profile.profileId);
    const journal = await meta.get(`fresh:${expected.profile.profileId}`);
    if (!sameStoredData(profile, expected.rawProfile) || !sameStoredData(journal, expected.rawJournal)) throw profileError("CONFLICT", "fresh profile pair changed concurrently");
    const pair = validateProfileJournalPair(profile, journal, { allowStaged: true });
    if (!sameOwner(pair.owner, snapshot.owner)) throw profileError("OWNER_MISMATCH", "profile belongs to another owner");
    if (pair.phase !== expectedPhase) throw profileError("CONFLICT", "fresh profile phase changed concurrently");
    const next = make(pair);
    const resultingPair = {
      profile: next.profile === undefined ? profile : next.profile,
      journal: next.journal === undefined ? journal : next.journal
    };
    if (next.profile !== undefined) await profiles.put(next.profile);
    if (next.journal !== undefined) await meta.put(next.journal);
    return resultingPair;
  });

  /** @param {ReturnType<typeof checkedPair>} pair @param {"create"|"inspect"|"finalize"} phase @param {unknown} cause */
  const quarantine = async (pair, phase, cause) => {
    try {
      await transition(pair, pair.phase, (current) => quarantinedPair(current.profile, current.journal, phase, cause));
    } catch (quarantineCause) {
      if (quarantineCause?.code === "CONFLICT" || quarantineCause?.code === "CLOSED") return;
      throw quarantineCause;
    }
  };

  /** @param {string} profileId */
  const resume = async (profileId) => {
    let pair = await checkedPair(profileId, { allowStaged: true, requireOwner: true });
    if (!pair) throw profileError("NOT_FOUND", "fresh profile does not exist");
    if (pair.journal.kind !== 'b1a-fresh-creation') throw profileError('INVALID', 'restore stages cannot use fresh resume');
    if (pair.phase === "completed") return cloneData(pair.profile);
    if (pair.phase === "quarantined") throw profileError("FRESH_VERIFICATION_FAILED", "fresh profile is quarantined");
    if (pair.phase === "creating") {
      await quarantine(pair, "create", profileError("CREATION_AMBIGUOUS", "creation may have reached the business database"));
      throw profileError("CREATION_AMBIGUOUS", "creating profile was interrupted and is quarantined");
    }
    if (pair.phase === "allocated") {
      const creatingExpected = await transition(pair, "allocated", (current) => ({ journal: journalAtPhase(current.profile, current.journal, "creating") }));
      pair = await checkedPair(profileId, { allowStaged: true, requireOwner: true });
      if (!pair || pair.phase !== "creating" || !sameStoredData(pair.rawProfile, creatingExpected.profile) || !sameStoredData(pair.rawJournal, creatingExpected.journal)) {
        throw profileError("CONFLICT", "fresh profile pair changed after allocation CAS");
      }
      try {
        const context = await openProfileContext({ profile: pair.profile, openMode: "create", blockedTimeoutMs: snapshot.blockedTimeoutMs, signal });
        context.close();
      } catch (cause) {
        await quarantine(pair, "create", cause);
        rethrowStorage(cause, "unable to create fresh business database");
      }
      const createdExpected = await transition(pair, "creating", (current) => ({ journal: journalAtPhase(current.profile, current.journal, "created") }));
      pair = await checkedPair(profileId, { allowStaged: true, requireOwner: true });
      if (!pair || pair.phase !== "created" || !sameStoredData(pair.rawProfile, createdExpected.profile) || !sameStoredData(pair.rawJournal, createdExpected.journal)) {
        throw profileError("CONFLICT", "fresh profile pair changed after creation CAS");
      }
    }
    if (pair.phase !== "created") throw profileError("CONFLICT", "fresh profile did not reach created phase");
    let inspected;
    try { inspected = await inspectFreshBusinessProfile({ profile: pair.profile, blockedTimeoutMs: snapshot.blockedTimeoutMs, signal }); }
    catch (cause) { await quarantine(pair, "inspect", cause); rethrowStorage(cause, "fresh business verification failed"); }
    try {
      await transition(pair, "created", (current) => completedPair(current.profile, current.journal, inspected));
    } catch (cause) {
      await quarantine(pair, "finalize", cause);
      rethrowStorage(cause, "unable to finalize fresh profile");
    }
    const completed = await checkedPair(profileId, { requireOwner: true });
    if (!completed || completed.phase !== "completed") throw profileError("CORRUPT", "fresh profile finalization did not produce a completed pair");
    return cloneData(completed.profile);
  };

  const createFresh = async () => {
    assertOpen();
    const profileId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    if (!UUID_V4.test(profileId) || !UUID_V4.test(jobId)) throw profileError("STORAGE_UNAVAILABLE", "crypto.randomUUID did not produce UUIDv4 values");
    const businessId = crypto.randomUUID();
    if (!UUID_V4.test(businessId)) throw profileError("STORAGE_UNAVAILABLE", "crypto.randomUUID did not produce a UUIDv4 business locator");
    const dbName = `${snapshot.namespace === "production" ? "qb-v2" : "qb-b1a-test"}-business-${businessId}`;
    const profile = stagedProfile(snapshot.owner, profileId, jobId, dbName);
    const journal = allocatedJournal(snapshot.owner, profileId, jobId, dbName);
    await putInitial(profile, journal);
    return resume(profileId);
  };

  const allocateRestoreStage = async allocation => {
    assertOpen();
    const profileId = crypto.randomUUID(), jobId = crypto.randomUUID(), businessId = crypto.randomUUID();
    const dbName = `${snapshot.namespace === 'production' ? 'qb-v2' : 'qb-b1a-test'}-business-${businessId}`;
    const profile = stagedProfile(snapshot.owner, profileId, jobId, dbName);
    const journal = { ...allocatedJournal(snapshot.owner, profileId, jobId, dbName), kind: 'qb-v2-staged-restore' };
    const marker=allocation?validateSourceAllocationMarker({...allocation,key:`source-allocation:${profileId}`,profileId,jobId,dbName}):null;
    await putInitial(profile, journal,marker);
    let pair = await checkedPair(profileId, { allowStaged: true, requireOwner: true });
    await transition(pair, 'allocated', current => ({ journal: journalAtPhase(current.profile, current.journal, 'creating') }));
    pair = await checkedPair(profileId, { allowStaged: true, requireOwner: true });
    try {
      const context = await openProfileContext({ profile, openMode: 'create', blockedTimeoutMs: snapshot.blockedTimeoutMs, signal }); context.close();
      await transition(pair, 'creating', current => ({ journal: journalAtPhase(current.profile, current.journal, 'created') }));
    } catch (cause) { await quarantine(pair, 'create', cause); throw cause; }
    return cloneData(profile);
  };

  const createRestoreStage=()=>allocateRestoreStage(null);

  const finalizeRestore = async input => {
    const value = cloneData(exactInput(input, 'restore verification'));
    if (Object.keys(value).sort().join() !== 'expectedContentDigest,profileId' || !/^[0-9a-f]{64}$/.test(value.expectedContentDigest)) throw profileError('INVALID', 'restore verification input is invalid');
    const pair = await checkedPair(requireProfileId(value.profileId), { allowStaged: true, requireOwner: true });
    if (!pair || pair.phase !== 'created' || pair.journal.kind !== 'qb-v2-staged-restore') throw profileError('NOT_READY', 'restore target is not staged');
    try {
      const records = await captureProfile(pair.profile, { blockedTimeoutMs: snapshot.blockedTimeoutMs, signal });
      const inspected = await validateSnapshot(records, snapshot.owner);
      if (inspected.contentDigest !== value.expectedContentDigest) throw profileError('RESTORE_READBACK_MISMATCH', 'staged readback differs from restore input');
      await transition(pair, 'created', current => completedPair(current.profile, current.journal, inspected));
      return cloneData((await checkedPair(value.profileId, { requireOwner: true })).profile);
    } catch (cause) { await quarantine(pair, 'inspect', cause); throw cause; }
  };

  /** @param {unknown} value */
  const readProfile = async (value) => {
    const profileId = requireProfileId(value);
    const pair = await checkedPair(profileId, { allowStaged: true });
    return pair && sameOwner(pair.owner, snapshot.owner) ? cloneData(pair.profile) : null;
  };

  const pointerBundle = async (nativeBudgetMs) => controlTx("readonly", async (tx) => {
    const profiles = tx.objectStore("profiles");
    const meta = tx.objectStore("meta");
    const pointer = await meta.get("activeProfile");
    if (pointer === undefined) return { pointer: null, profile: null, journal: null };
    let checkedPointer;
    try { checkedPointer = validateProfileJournalPointer(pointer); } catch (cause) { throw profileError("CORRUPT", "active pointer is invalid", cause); }
    const profile = await profiles.get(checkedPointer.activeProfileId);
    return { pointer, profile, journal: await meta.get(`fresh:${checkedPointer.activeProfileId}`) };
  },undefined,nativeBudgetMs);

  const checkedPointerBundle = async () => {
    const raw = await pointerBundle();
    if (raw.pointer === null) return { ...raw, pair: null };
    const pointer = validateProfileJournalPointer(raw.pointer);
    const pair = validateProfileJournalPair(raw.profile, raw.journal);
    if (pair.profile.profileId !== pointer.activeProfileId || pair.phase !== "completed" || !(await completedDigestIsValid(pair))) throw profileError("CORRUPT", "active pointer does not resolve to a verified ready profile");
    assertOpen();
    return { ...raw, pointer, pair };
  };
  const readColdActive=async(deadline)=>{
    const raw=await withProfileWriteLock(profileWriteLockKey(),'shared',()=>pointerBundle(Math.max(1,Math.min(2000,deadline-Date.now()))),{signal,timeoutMs:Math.max(1,Math.min(snapshot.blockedTimeoutMs,deadline-Date.now()))});
    assertOpen();if(Date.now()>=deadline)throw profileError('CLOUD_CLEANUP_DEADLINE','cold discovery deadline');if(raw.pointer===null)return {...raw,pair:null};
    const pointer=validateProfileJournalPointer(raw.pointer),pair=validateProfileJournalPair(raw.profile,raw.journal);
    // Digest work outside the native shared grant; every later destructive
    // step compares the actual original pair again under its own grant.
    if(pair.profile.profileId!==pointer.activeProfileId||pair.phase!=='completed'||!await completedDigestIsValid(pair))throw profileError('CORRUPT','cold pointer is not verified Ready');assertOpen();return {...raw,pointer,pair};
  };

  /** @param {unknown} input */
  const activateUnlocked = async (input) => {
    const value = exactInput(input, "activate input");
    if (Object.keys(value).length !== 2 || !OWN.call(value, "profileId") || !OWN.call(value, "expectedRevision")) throw profileError("INVALID", "activate input has unsupported fields");
    const profileId = requireProfileId(value.profileId);
    const expectedRevision = value.expectedRevision;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw profileError("INVALID", "expectedRevision must be a non-negative safe integer");
    const target = await checkedPair(profileId, { requireOwner: true });
    if (!target || target.phase !== "completed") throw profileError("NOT_READY", "activation target is not ready");
    const before = await checkedPointerBundle();
    if (target.manifest.format === 'qb-v2-native-manifest-v2' && before.pointer?.activeProfileId !== profileId) throw profileError('NOT_READY', 'inactive native V2 profile requires a fresh private one-use final proof');
    const context = await openProfileContext({ profile: target.profile, openMode: "existing", blockedTimeoutMs: snapshot.blockedTimeoutMs, signal });
    context.close();
    const next = await controlTx("readwrite", async (tx) => {
      const profiles = tx.objectStore("profiles");
      const meta = tx.objectStore("meta");
      const nowTarget = { profile: await profiles.get(profileId), journal: await meta.get(`fresh:${profileId}`) };
      if (!sameStoredData(nowTarget.profile, target.rawProfile) || !sameStoredData(nowTarget.journal, target.rawJournal)) throw profileError("CONFLICT", "activation target changed during business verification");
      const nowPointer = await meta.get("activeProfile");
      if (!sameStoredData(nowPointer === undefined ? null : nowPointer, before.pointer)) throw profileError("CONFLICT", "active pointer changed during business verification");
      const currentRevision = before.pointer === null ? 0 : before.pointer.activationRevision;
      if (currentRevision !== expectedRevision) throw profileError("CONFLICT", "expected activation revision is stale");
      if (currentRevision >= Number.MAX_SAFE_INTEGER) throw profileError("REVISION_EXHAUSTED", "activation revision cannot advance safely");
      if (before.pointer !== null) {
        const nowCurrent = { profile: await profiles.get(before.pointer.activeProfileId), journal: await meta.get(`fresh:${before.pointer.activeProfileId}`) };
        if (!sameStoredData(nowCurrent.profile, before.profile) || !sameStoredData(nowCurrent.journal, before.journal)) throw profileError("CONFLICT", "current active profile changed during business verification");
      }
      const pointer = { key: "activeProfile", activeProfileId: profileId, activationRevision: currentRevision + 1 };
      await meta.put(pointer);
      return pointer;
    });
    return { profile: cloneData(target.profile), pointer: cloneData(next) };
  };
  const profileWriteLockKey=()=>`qb-profile-write:${snapshot.dbName}`;
  // Proposed lexical controller helper; private IDs only, no cached authority.
  const checkedRegistryPairCut=async(targetId)=>{
    const raw=await controlTx('readonly',async tx=>{
      const profiles=tx.objectStore('profiles'),meta=tx.objectStore('meta');
      const targetProfile=await profiles.get(targetId);
      const targetJournal=targetProfile===undefined?undefined:await meta.get(`fresh:${targetId}`);
      const pointer=await meta.get('activeProfile');
      if(pointer===undefined)return {targetProfile,targetJournal,pointer:null,profile:null,journal:null};
      let checked,pointerCause;try{checked=validateProfileJournalPointer(pointer);}catch(cause){pointerCause=cause;}
      // Do not guess an invalid pointer key; defer its error until after the
      // original target validation to preserve the original rejection priority.
      return {targetProfile,targetJournal,pointer,pointerCause,profile:checked?await profiles.get(checked.activeProfileId):undefined,journal:checked?await meta.get(`fresh:${checked.activeProfileId}`):undefined};
    });
    let currentPair=null;
    if(raw.targetProfile!==undefined){
      const pair=validateProfileJournalPair(raw.targetProfile,raw.targetJournal,{allowStaged:true});
      if(!sameOwner(pair.owner,snapshot.owner))throw profileError('OWNER_MISMATCH','profile belongs to another owner');
      if(pair.phase==='completed'&&!await completedDigestIsValid(pair))throw profileError('CORRUPT','completed fresh manifest digest is invalid');
      assertOpen();currentPair={...pair,rawProfile:raw.targetProfile,rawJournal:raw.targetJournal};
    }
    let current={pointer:raw.pointer,profile:raw.profile,journal:raw.journal,pair:null};
    if(raw.pointer!==null || raw.pointerCause){
      if(raw.pointerCause)throw profileError('CORRUPT','active pointer is invalid',raw.pointerCause);
      const pointer=validateProfileJournalPointer(raw.pointer),pair=validateProfileJournalPair(raw.profile,raw.journal);
      if(pair.profile.profileId!==pointer.activeProfileId||pair.phase!=='completed'||!await completedDigestIsValid(pair))throw profileError('CORRUPT','active pointer does not resolve to a verified ready profile');
      assertOpen();current={pointer,profile:raw.profile,journal:raw.journal,pair};
    }
    return {currentPair,current};
  };
  const createHeldFinalReader=async(input,heldState)=>{
    const value=ownedWriteInput(input);if(Object.keys(value).join()!=='profileId')throw profileError('INVALID','final reader accepts only profileId');
    const profileId=requireProfileId(value.profileId),pair=await checkedPair(profileId,{allowStaged:true,requireOwner:true}),original=await checkedPointerBundle();
    if(original.pair&&!sameOwner(original.pair.owner,snapshot.owner))throw profileError('OWNER_MISMATCH','original active profile belongs to another owner');
    if(!pair||pair.phase!=='created'||pair.profile.state!=='staged'||pair.journal.kind!=='qb-v2-staged-restore'||original.pointer?.activeProfileId===profileId)throw profileError('NOT_READY','proof workspace requires an inactive created restore stage');
    const workspaceId=crypto.randomUUID(),sourceId=`qb-cloud-stage-index:${workspaceId}`,cancellation=new AbortController();let native,disposed=false,expectedReservation;
    const assertLive=()=>{assertOpen();if(!heldState.live||disposed||cancellation.signal.aborted)throw profileError('CLOSED','final proof workspace is no longer held');};
    // Proposed lexical helper inside createHeldFinalReader; no cached authority.
    const checkedHeldControlCut=async()=>{
      const raw=await controlTx('readonly',async tx=>{
        const profiles=tx.objectStore('profiles'),meta=tx.objectStore('meta');
        const targetProfile=await profiles.get(profileId);
        const targetJournal=targetProfile===undefined?undefined:await meta.get(`fresh:${profileId}`);
        const pointer=await meta.get('activeProfile');
        if(pointer===undefined)return {targetProfile,targetJournal,pointer:null,profile:null,journal:null};
        let checked,pointerCause;try{checked=validateProfileJournalPointer(pointer);}catch(cause){pointerCause=cause;}
        // Do not guess an invalid pointer key; defer its error until after the
        // original target validation to preserve the original rejection priority.
        return {targetProfile,targetJournal,pointer,pointerCause,profile:checked?await profiles.get(checked.activeProfileId):undefined,journal:checked?await meta.get(`fresh:${checked.activeProfileId}`):undefined};
      });
      let currentPair=null;
      if(raw.targetProfile!==undefined){
        const pair=validateProfileJournalPair(raw.targetProfile,raw.targetJournal,{allowStaged:true});
        if(!sameOwner(pair.owner,snapshot.owner))throw profileError('OWNER_MISMATCH','profile belongs to another owner');
        if(pair.phase==='completed'&&!await completedDigestIsValid(pair))throw profileError('CORRUPT','completed fresh manifest digest is invalid');
        assertOpen();currentPair={...pair,rawProfile:raw.targetProfile,rawJournal:raw.targetJournal};
      }
      let current={pointer:raw.pointer,profile:raw.profile,journal:raw.journal,pair:null};
      if(raw.pointer!==null || raw.pointerCause){
        if(raw.pointerCause)throw profileError('CORRUPT','active pointer is invalid',raw.pointerCause);
        const pointer=validateProfileJournalPointer(raw.pointer),pair=validateProfileJournalPair(raw.profile,raw.journal);
        if(pair.profile.profileId!==pointer.activeProfileId||pair.phase!=='completed'||!await completedDigestIsValid(pair))throw profileError('CORRUPT','active pointer does not resolve to a verified ready profile');
        assertOpen();current={pointer,profile:raw.profile,journal:raw.journal,pair};
      }
      return {currentPair,current};
    };
    const recheck=async()=>{
      assertLive();const capturedNative=native;
      if(!original.pointer){const {currentPair,current}=await checkedHeldControlCut();assertLive();if(!currentPair||!sameStoredData(currentPair.rawProfile,pair.rawProfile)||!sameStoredData(currentPair.rawJournal,pair.rawJournal)||!sameStoredData(current.pointer,original.pointer)||!sameStoredData(current.profile,original.profile)||!sameStoredData(current.journal,original.journal)||current.pointer?.activeProfileId===profileId)throw profileError('CONFLICT','final proof binding changed');if(capturedNative)await capturedNative.assertProofNamespace(sourceId);assertLive();return;}
      const control=(async()=>{const {currentPair,current}=await checkedHeldControlCut();assertLive();if(!currentPair||!sameStoredData(currentPair.rawProfile,pair.rawProfile)||!sameStoredData(currentPair.rawJournal,pair.rawJournal)||!sameStoredData(current.pointer,original.pointer)||!sameStoredData(current.profile,original.profile)||!sameStoredData(current.journal,original.journal)||current.pointer?.activeProfileId===profileId)throw profileError('CONFLICT','final proof binding changed');return true;})().then(value=>({value}),cause=>({cause}));
      const namespace=(async()=>{if(capturedNative)await capturedNative.assertProofNamespace(sourceId);return true;})().then(value=>({value}),cause=>({cause}));
      const controlResult=await control;if(Object.hasOwn(controlResult,'cause')){if(capturedNative)close();await namespace;throw controlResult.cause;}
      const namespaceResult=await namespace;if(Object.hasOwn(namespaceResult,'cause'))throw namespaceResult.cause;assertLive();
    };
    const close=()=>{if(disposed)return;disposed=true;signal.removeEventListener('abort',close);cancellation.abort();native?.close();};heldState.closers.add(close);signal.addEventListener('abort',close,{once:true});
    const label=value=>{if(typeof value!=='string'||!value.length||value.length>400||!/^[A-Za-z0-9:_.\/-]+$/.test(value)||value==='reservation')throw profileError('INVALID','proof label is invalid');return value;};
    const oneLabel=value=>{if(Object.keys(value).join()!=='label')throw profileError('INVALID','proof operation accepts only label');return label(value.label);};
    const receipt=(id,provenance)=>({sourceId,sourceRecordId:id,importedAt:Date.now(),provenance});
    const reservationKey=[sourceId,'reservation'];
    const inspectReceipt=row=>{const p=row?.provenance;if(!row||row.sourceId!==sourceId||p?.workspaceId!==workspaceId)throw profileError('CORRUPT','foreign proof namespace row');if(p.format==='qb-final-proof-index-v1'){if(Object.keys(p).sort().join()!=='format,label,value,workspaceId'||row.sourceRecordId!=='index:'+label(p.label))throw profileError('CORRUPT','proof index malformed');}else if(p.format==='qb-final-proof-part-v1'){if(Object.keys(p).sort().join()!=='byteLength,contentDigest,format,label,sha256,workspaceId'||row.sourceRecordId!=='part:'+label(p.label)||!Number.isSafeInteger(p.byteLength)||p.byteLength<1||p.byteLength>512*1024||!/^[0-9a-f]{64}$/.test(p.contentDigest)||!/^[0-9a-f]{64}$/.test(p.sha256))throw profileError('CORRUPT','proof part malformed');}else throw profileError('CORRUPT','unknown proof namespace row');return row;};
    const reservation=async()=>{const row=await native.get('import_receipts',reservationKey),p=row?.provenance;if(!row||!sameStoredData(row,expectedReservation)||row.sourceId!==sourceId||row.sourceRecordId!=='reservation'||Object.keys(p||{}).sort().join()!=='bytes,format,recordCount,workspaceId'||p.format!=='qb-final-proof-reservation-v1'||p.workspaceId!==workspaceId||!Number.isSafeInteger(p.bytes)||p.bytes<0||p.bytes>256*1024*1024||!Number.isSafeInteger(p.recordCount)||p.recordCount<0)throw profileError('CORRUPT','proof reservation missing');return row;};
    const call=(input,work)=>{const captured=ownedWriteInput(input);assertLive();const operation=(async()=>{await recheck();const result=await work(captured);await recheck();return result;})().catch(cause=>{if(cause.code==='QUOTA_EXCEEDED'){cause.cleanupRequired=true;close();}throw cause;});heldState.operations.add(operation);operation.then(()=>heldState.operations.delete(operation),()=>heldState.operations.delete(operation));return operation;};
    const writeReserved=async(puts,conditions)=>{const before=await reservation();let increment=0;for(const put of puts)increment+=put.store==='content_chunks'?put.value.bytes.length+canonicalBytes({contentDigest:put.value.contentDigest,chunkIndex:put.value.chunkIndex}).length:canonicalBytes(put.value).length;const next=ownedWriteInput(before);next.provenance.recordCount+=puts.length;const oldSize=canonicalBytes(before).length;for(let i=0;i<4;i++)next.provenance.bytes=before.provenance.bytes+increment+canonicalBytes(next).length-oldSize;if(next.provenance.bytes>256*1024*1024)throw profileError('PROOF_BUDGET_EXCEEDED','temporary proof budget exceeded');await native.write({conditions:[{store:'import_receipts',key:reservationKey,expected:before},...conditions],puts:[...puts,{store:'import_receipts',value:next}]});expectedReservation=ownedWriteInput(next);return ownedWriteInput(next.provenance);};
    const workspace=Object.freeze({
      check:()=>call({},async()=>true),metadata:()=>call({},async()=>({workspaceId,sourceId,profileId,owner:cloneData(snapshot.owner)})),
      readIndex:input=>call(input,async value=>{const row=await native.get('import_receipts',[sourceId,'index:'+oneLabel(value)]);return row?inspectReceipt(row):null;}),
      readIndexes:input=>call(input,async value=>{if(Object.keys(value).join()!=='labels'||!Array.isArray(value.labels)||value.labels.length<1||value.labels.length>100)throw profileError('INVALID','proof read batch invalid');const labels=value.labels.map(label);if(new Set(labels).size!==labels.length)throw profileError('INVALID','proof read labels duplicate');const rows=await native.getProofIndexes({sourceId,labels});return rows.map((row,index)=>{if(!row)return null;inspectReceipt(row);if(row.provenance.format!=='qb-final-proof-index-v1'||row.provenance.label!==labels[index]||row.sourceRecordId!=='index:'+labels[index])throw profileError('CORRUPT','proof read batch binding mismatch');return row;});}),
      scanIndexes:input=>call(input,async value=>{if(Object.keys(value).sort().join()!=='after,limit,maxBytes,prefix')throw profileError('INVALID','proof range shape invalid');return native.proofPage({...value,sourceId});}),
      writeIndexes:input=>call(input,async value=>{if(Object.keys(value).join()!=='rows'||!Array.isArray(value.rows)||!value.rows.length||value.rows.length>100)throw profileError('INVALID','proof batch invalid');const puts=[],conditions=[],keys=new Set();let bytes=0;for(const row of value.rows){if(Object.keys(row).sort().join()!=='label,value')throw profileError('INVALID','proof row invalid');const id='index:'+label(row.label);if(keys.has(id))throw profileError('CONFLICT','proof label collision');keys.add(id);const record=receipt(id,{format:'qb-final-proof-index-v1',workspaceId,label:row.label,value:row.value});const size=canonicalBytes(record).length;bytes+=size;if(size>3*1024*1024||bytes>1024*1024&&value.rows.length!==1)throw profileError('PROOF_ROW_BUDGET','proof rows over budget');puts.push({store:'import_receipts',value:record});conditions.push({store:'import_receipts',key:[sourceId,id],expected:undefined});}return writeReserved(puts,conditions);}),
      writePart:input=>call(input,async value=>{if(Object.keys(value).sort().join()!=='bytes,label'||!(value.bytes instanceof Uint8Array)||!value.bytes.length||value.bytes.length>512*1024)throw profileError('INVALID','proof part invalid');const id=label(value.label),contentDigest=await sha256Hex(canonicalBytes({format:'qb-final-proof-part-key-v1',workspaceId,label:id})),sha256=await sha256Hex(value.bytes),pointer=receipt('part:'+id,{format:'qb-final-proof-part-v1',workspaceId,label:id,contentDigest,sha256,byteLength:value.bytes.length});await writeReserved([{store:'content_chunks',value:{contentDigest,chunkIndex:0,bytes:value.bytes}},{store:'import_receipts',value:pointer}],[{store:'content_chunks',key:[contentDigest,0],expected:undefined},{store:'import_receipts',key:[sourceId,'part:'+id],expected:undefined}]);return ownedWriteInput(pointer.provenance);}),
      readPart:input=>call(input,async value=>{const id=oneLabel(value),row=await native.get('import_receipts',[sourceId,'part:'+id]);if(!row)throw profileError('CORRUPT','proof part pointer missing');inspectReceipt(row);if(row.provenance.contentDigest!==await sha256Hex(canonicalBytes({format:'qb-final-proof-part-key-v1',workspaceId,label:id})))throw profileError('CORRUPT','proof part key mismatch');const part=await native.get('content_chunks',[row.provenance.contentDigest,0]);if(!part||part.bytes.length!==row.provenance.byteLength||await sha256Hex(part.bytes)!==row.provenance.sha256)throw profileError('CORRUPT','proof part corrupted');return part.bytes;}),
      cleanup:()=>call({},async()=>{
        let after=null;
        do{
          const page=await native.proofPage({sourceId,prefix:'',after,limit:100,maxBytes:1024*1024});
          for(const row of page.rows){
            if(row.sourceRecordId==='reservation')continue;
            inspectReceipt(row);await recheck();
            const before=await reservation(),deletes=[{store:'import_receipts',key:[sourceId,row.sourceRecordId]}],conditions=[{store:'import_receipts',key:[sourceId,row.sourceRecordId],expected:row}];
            let removedBytes=canonicalBytes(row).length,part;
            if(row.provenance.format==='qb-final-proof-part-v1'){
              const expectedDigest=await sha256Hex(canonicalBytes({format:'qb-final-proof-part-key-v1',workspaceId,label:label(row.provenance.label)}));
              if(row.provenance.contentDigest!==expectedDigest)throw profileError('CORRUPT','proof cleanup key mismatch');
              part=await native.get('content_chunks',[expectedDigest,0]);
              if(!part||part.bytes.length!==row.provenance.byteLength||await sha256Hex(part.bytes)!==row.provenance.sha256)throw profileError('CORRUPT','proof cleanup chunk mismatch');
              conditions.push({store:'content_chunks',key:[expectedDigest,0],expected:part});deletes.push({store:'content_chunks',key:[expectedDigest,0]});
              removedBytes+=part.bytes.length+canonicalBytes({contentDigest:expectedDigest,chunkIndex:0}).length;
            }
            const next=ownedWriteInput(before);next.provenance.recordCount-=deletes.length;
            const base=before.provenance.bytes-removedBytes,oldSize=canonicalBytes(before).length;
            for(let i=0;i<4;i++)next.provenance.bytes=base+canonicalBytes(next).length-oldSize;
            if(next.provenance.bytes<0||next.provenance.recordCount<1)throw profileError('CORRUPT','proof cleanup reservation underflow');
            const exactConditions=[{store:'import_receipts',key:reservationKey,expected:before},...conditions],puts=[{store:'import_receipts',value:next}];
            const framingConditions=exactConditions.map(condition=>condition.expected?.bytes instanceof Uint8Array?{...condition,expected:{contentDigest:condition.expected.contentDigest,chunkIndex:condition.expected.chunkIndex,byteLength:condition.expected.bytes.length}}:condition);
            const frameBytes=canonicalContentBytes({conditions:framingConditions,deletes,puts}).length+(part?.bytes.length||0);
            if(frameBytes>(part?1024*1024:3*1024*1024))throw profileError('PROOF_CLEANUP_BUDGET','single cleanup condition payload exceeds bounded framing budget');
            await recheck();await native.write({deletes,conditions:exactConditions,puts});expectedReservation=ownedWriteInput(next);await recheck();
          }
          after=page.after;
        }while(after!==null);
        const final=await reservation();
        const remaining=await native.proofPage({sourceId,prefix:'',after:null,limit:2,maxBytes:1024*1024});
        if(remaining.after!==null||remaining.rows.length!==1||!sameStoredData(remaining.rows[0],final))throw profileError('CORRUPT','proof cleanup left unexpected native rows');
        if(final.provenance.recordCount!==1||final.provenance.bytes!==canonicalBytes(final).length)throw profileError('CORRUPT','proof cleanup did not exhaust its namespace');
        await recheck();await native.write({conditions:[{store:'import_receipts',key:reservationKey,expected:final}],deletes:[{store:'import_receipts',key:reservationKey}]});expectedReservation=undefined;await recheck();
        return {status:'temporary_proof_cleaned',ready:false};
      }),
      resetForProjection:async()=>{
        assertLive();
        if(state.sourceAccess||heldState.projectionTargets.has(profileId))throw profileError('FINAL_PROJECTION_RESET_SEALED','bound final workspace cannot reset');
        await workspace.cleanup();await recheck();
        if(state.sourceAccess||heldState.projectionTargets.has(profileId))throw profileError('FINAL_PROJECTION_RESET_SEALED','workspace became bound during reset');
        const first=receipt('reservation',{format:'qb-final-proof-reservation-v1',workspaceId,bytes:0,recordCount:1});
        for(let i=0;i<4;i++)first.provenance.bytes=canonicalBytes(first).length;
        await native.write({conditions:[{store:'import_receipts',key:reservationKey,expected:undefined}],puts:[{store:'import_receipts',value:first}]});
        expectedReservation=ownedWriteInput(first);await recheck();
        return {status:'projection_workspace_reset',ready:false};
      },
      close
    });
    const metadata={owner:cloneData(snapshot.owner),profileId,originalPointer:cloneData(original.pointer),sourceProfileId:original.pair?.profile.profileId??null,controlLockKey:profileWriteLockKey()};
    const state={assertLive,recheck,metadata,matchesDatabase:database=>native?.ownsDatabaseIdentity(database)===true,projectSource:sourceCapability=>native.createCheckpointProjection(sourceCapability,workspace),consumeFinalProof:token=>native.consumeFinalProof(token,state.binding),sourceAccess:null,sourceMetadata:null,cleanupSource:null,terminalCompletion:null};
    state.binding=Object.freeze({
      check:async()=>{await recheck();if(state.sourceAccess){await state.sourceAccess.check();await recheck();const current=await state.sourceAccess.metadata();if(!sameStoredData(current,state.sourceMetadata))throw profileError('CORRUPT','verified checkpoint source binding changed');await recheck();}return true;},
      snapshot:async()=>{await state.binding.check();return cloneData({...metadata,targetProfile:pair.profile,targetJournal:pair.journal,originalProfile:original.profile,originalJournal:original.journal,sourceVerified:Boolean(state.sourceAccess),source:state.sourceMetadata});}
    });finalProofWorkspaces.set(workspace,state);
    try{await recheck();native=await openCloudNativeDatabase({profile:pair.profile,blockedTimeoutMs:snapshot.blockedTimeoutMs,signal:cancellation.signal,guard:assertLive});await recheck();const first=receipt('reservation',{format:'qb-final-proof-reservation-v1',workspaceId,bytes:0,recordCount:1});for(let i=0;i<4;i++)first.provenance.bytes=canonicalBytes(first).length;await native.write({conditions:[{store:'import_receipts',key:reservationKey,expected:undefined}],puts:[{store:'import_receipts',value:first}]});expectedReservation=ownedWriteInput(first);await recheck();const reader=await native.createFinalReader(snapshot.owner,workspace);await recheck();return Object.freeze({...reader,proofWorkspace:workspace,close:()=>{reader.close();close();}});}catch(cause){close();throw cause;}
  };
  const projectHeldCheckpoint=async(input,heldState)=>{
    const raw=exactInput(input,'checkpoint projection input');if(Object.keys(raw).sort().join()!=='sourceCapability,targetProfileId')throw profileError('INVALID','checkpoint projection accepts only genuine source capability and targetProfileId');
    const sourceCapability=raw.sourceCapability,id=ownedWriteInput(raw.targetProfileId);if(typeof id!=='string')throw profileError('INVALID','projection target must be a profileId');const profileId=requireProfileId(id);
    const sourceAccess=consumeCloudProjectionSource(sourceCapability);await sourceAccess.check();if(!heldState.live)throw profileError('CLOSED','projection held capability expired');
    const reader=await createHeldFinalReader({profileId},heldState),state=finalProofWorkspaces.get(reader.proofWorkspace);let projector;
    try{
      const metadata=await sourceAccess.metadata();await state.recheck();
      if(!sameStoredData(metadata.owner,state.metadata.owner)||!sameStoredData(metadata.originalPointer,state.metadata.originalPointer)||metadata.sourceProfileId!==state.metadata.sourceProfileId||metadata.stageProfileId===profileId)throw profileError('OWNER_MISMATCH','projection source does not match actual held target/source pair');
      const sourcePair=await checkedPair(metadata.stageProfileId,{allowStaged:true,requireOwner:true});await state.recheck();await sourceAccess.check();
      if(!sourcePair||sourcePair.phase!=='created'||sourcePair.profile.state!=='staged'||metadata.stageProfileId===metadata.sourceProfileId)throw profileError('CLOUD_CLEANUP_SOURCE_BINDING','projection source is not a distinct owned allocated stage');
      const sourceNative=await openCloudNativeDatabase({profile:sourcePair.profile,blockedTimeoutMs:snapshot.blockedTimeoutMs,signal,guard:()=>{assertOpen();if(!heldState.live)throw profileError('CLOSED','source capture lock released');}});
      let sourceJournal;
      try{sourceJournal=validateCloudStageJournal(await sourceNative.get('migration_journal',metadata.stageId));}finally{sourceNative.close();}
      await state.recheck();await sourceAccess.check();
      const p=sourceJournal.checkpoint;
      if(sourceJournal.migrationId!==metadata.stageId||p.profileId!==metadata.stageProfileId||p.sourceProfileId!==metadata.sourceProfileId||!sameOwner(p.owner,metadata.owner)||p.activationRevision!==metadata.originalPointer.activationRevision||p.checkpointDigest!==metadata.checkpointDigest||!sameStoredData(p.cloudCheckpoint,metadata.checkpoint))throw profileError('CLOUD_CLEANUP_SOURCE_BINDING','actual source journal differs from genuine checkpoint capability');
      projector=await state.projectSource(sourceCapability);await state.recheck();await sourceAccess.check();
      heldState.diagnosticGetters.set(profileId,()=>projector.readDiagnostics());
      let projected=0,hasMore=true;const kinds={};
      while(hasMore){const result=await projector.projectNext({limit:100});await state.recheck();await sourceAccess.check();projected+=result.projected;for(const kind of result.kinds)kinds[kind]=(kinds[kind]??0)+1;hasMore=result.hasMore;}
      // Drain proof indexes belong to this exact workspace, not ordinary
      // learning/sync rows. Exhaust them before the final dependency pass.
      heldState.diagnosticGetters.delete(profileId);projector.close();projector=null;
      await reader.proofWorkspace.resetForProjection();await state.recheck();await sourceAccess.check();
      state.sourceAccess=sourceAccess;state.sourceCapability=sourceCapability;state.sourceMetadata=ownedWriteInput(metadata);await state.binding.check();
      state.cleanupSource={pair:sourcePair,journal:ownedWriteInput(sourceJournal)};
      heldState.projectionTargets.set(profileId,reader);
      return {status:'source_projected_unverified',profileId,projected,kinds,ready:false,fullSemanticClosure:false};
    }catch(error){reader.close();throw error;}finally{heldState.diagnosticGetters.delete(profileId);projector?.close();}
  };
  const mergeHeldLatestLocal=async(input,heldState)=>{
    const value=ownedWriteInput(exactInput(input,'latest merge input'));
    if(Object.keys(value).join()!=='profileId')throw profileError('INVALID','latest merge input must contain only profileId');
    if(typeof value.profileId!=='string')throw profileError('INVALID','latest merge profileId must be a string');
    const profileId=requireProfileId(value.profileId);
    const projectedReader=heldState.projectionTargets.get(profileId),projectionState=projectedReader?finalProofWorkspaces.get(projectedReader.proofWorkspace):null;
    let disposed=false,sourceDb,targetDb,nativeTarget,nativeSource,journal,operationalClock;const transactions=new Set();
    const close=()=>{if(disposed)return;disposed=true;for(const tx of transactions){try{tx.abort();}catch{}}transactions.clear();nativeTarget?.close();nativeSource?.close();sourceDb?.close();targetDb?.close();};
    heldState.closers.add(close);
    const assertLive=()=>{assertOpen();if(disposed||!heldState.live||signal.aborted)throw profileError('CLOSED','latest merge capability expired');};
    const targetPair=await checkedPair(profileId,{allowStaged:true,requireOwner:true});assertLive();
    const original=await checkedPointerBundle();assertLive();
    const leaseSource=heldState.leaseSource;
    const operationalMetaKeys=projectionState&&leaseSource&&leaseSource.sourceCapability===projectionState.sourceCapability&&sameStoredData(leaseSource.metadata,projectionState.sourceMetadata)&&sameStoredData(projectionState.metadata.originalPointer,original.pointer)&&sameOwner(projectionState.metadata.owner,snapshot.owner)?Object.freeze(['clockHighWaterMs','syncCoordinatorLease']):Object.freeze([]);
    if(!targetPair||targetPair.phase!=='created'||targetPair.profile.state!=='staged'||targetPair.journal.kind!=='qb-v2-staged-restore'||!original.pair||!sameOwner(original.pair.owner,snapshot.owner)||original.pointer.activeProfileId===profileId)throw profileError('INVALID','latest merge requires distinct owned active and created restore profiles');
    const recheck=async()=>{
      assertLive();const {currentPair:currentTarget,current:currentSource}=await checkedRegistryPairCut(profileId);assertLive();
      if(!sameStoredData(currentTarget?.profile,targetPair.profile)||!sameStoredData(currentTarget?.journal,targetPair.journal)||!sameStoredData(currentSource.pointer,original.pointer)||!sameStoredData(currentSource.profile,original.profile)||!sameStoredData(currentSource.journal,original.journal))throw profileError('STALE_ACTIVE_PROFILE','latest merge source/control pair changed');
      if(projectionState){await projectionState.binding.check();assertLive();if(!projectionState.sourceAccess||projectionState.metadata.profileId!==profileId||projectionState.metadata.sourceProfileId!==original.pair.profile.profileId||!sameStoredData(projectionState.metadata.originalPointer,original.pointer)||!sameOwner(projectionState.metadata.owner,snapshot.owner))throw profileError('CORRUPT','projected source pair differs');}
      if(operationalMetaKeys.length&&nativeSource){await leaseSource.binding.check();const [clock,lease]=await nativeSource.readKeys([{store:'meta',key:'clockHighWaterMs'},{store:'meta',key:'syncCoordinatorLease'}]);assertLive();validateMetaRecord(clock);validateMetaRecord(lease);const context=leaseSource.binding.context;if(clock.key!=='clockHighWaterMs'||lease.key!=='syncCoordinatorLease'||lease.value.ownerTabId!==context.ownerTabId||lease.value.fence!==context.fence||lease.value.expiresAt<=Date.now())throw profileError('SYNC_FENCE_LOST','held operational lease changed');if(operationalClock!==undefined&&clock.value<operationalClock)throw profileError('CLOCK_ROLLBACK','held operational clock regressed');operationalClock=clock.value;}
      if(journal){const [actual]=await nativeTarget.readKeys([{store:'migration_journal',key:journal.migrationId}]);assertLive();if(!sameStoredData(actual,journal))throw profileError('CORRUPT','cloud stage journal changed during latest merge');if(journal.checkpoint.cloudCheckpoint.expiresAt<=Date.now())throw profileError('CLOUD_CHECKPOINT_EXPIRED','cloud stage checkpoint expired');}
    };
    async function openExisting(profile){
      assertLive();if(typeof indexedDB.databases!=='function')throw profileError('DATABASE_INVENTORY_UNAVAILABLE','existing merge database inventory required');
      const inventory=await indexedDB.databases();await recheck();if(!inventory.some(row=>row.name===profile.dbName&&(row.version===1||row.version===BUSINESS_SCHEMA_VERSION)))throw profileError('SCHEMA_MISMATCH','existing merge database missing or wrong version');
      let timer,cancelled=false;const opening=openDB(profile.dbName,BUSINESS_SCHEMA_VERSION,{upgrade(db,oldVersion,newVersion,tx){tx.done.catch(()=>{});try{if(cancelled||disposed||!heldState.live)throw profileError('CLOSED','upgrade cancelled');upgradeBusinessSchema(db,oldVersion,newVersion,tx);}catch(error){tx.abort();}},blocking(){close();}});
      const expired=new Promise((resolve,reject)=>{void resolve;timer=setTimeout(()=>{cancelled=true;reject(profileError('CLOSED','latest merge open budget expired'));},snapshot.blockedTimeoutMs);});
      opening.then(db=>{if(cancelled||disposed||!heldState.live)db.close();},()=>{});
      let db;try{db=await Promise.race([opening,expired]);assertLive();await recheck();return unwrap(db);}catch(error){db?.close();throw error;}finally{clearTimeout(timer);}
    }
    try{
      sourceDb=await openExisting(original.pair.profile);assertLive();targetDb=await openExisting(targetPair.profile);assertLive();
      sourceDb.addEventListener('versionchange',close);targetDb.addEventListener('versionchange',close);
      nativeTarget=await createBoundedNativeAccess(targetDb,{signal,guard:assertLive,timeoutMs:snapshot.blockedTimeoutMs});nativeSource=await createBoundedNativeAccess(sourceDb,{signal,guard:assertLive,timeoutMs:snapshot.blockedTimeoutMs});await recheck();
      if(!projectionState){let after=null;
        do{const page=await nativeTarget.readPage({store:'migration_journal',after,limit:100});await recheck();for(const row of page.rows){if(row.checkpoint?.format!=='qb-cloud-recovery-stage-v1')continue;if(journal)throw profileError('CORRUPT','multiple cloud stage journals');const candidate=validateCloudStageJournal(row),p=candidate.checkpoint;if(candidate.status!=='RAW_SAVED'||p.profileId!==profileId||p.sourceProfileId!==original.pair.profile.profileId||p.activationRevision!==original.pointer.activationRevision||!sameOwner(p.owner,snapshot.owner)||await sha256Hex(canonicalBytes(p.cloudCheckpoint))!==p.checkpointDigest)throw profileError('CORRUPT','cloud stage is not bound to actual source pair');assertLive();journal=candidate;}after=page.after;}while(after!==null);
        if(!journal)throw profileError('CLOUD_STAGE_JOURNAL','actual cloud stage journal required');
      }await recheck();
      const pair=Object.freeze({});latestMergePairs.set(pair,{sourceDatabase:sourceDb,targetDatabase:targetDb,assertLive,recheck,operationalMetaKeys,verifiedSource:projectionState?.sourceAccess??null,checkpoint:projectionState?ownedWriteInput(projectionState.sourceMetadata.checkpoint):null,trackTransaction:tx=>{assertLive();transactions.add(tx);return ()=>transactions.delete(tx);}});
      heldState.diagnosticGetters.set(profileId,()=>readLatestSavedMergeDiagnostics(pair,sourceDb,targetDb));
      return await mergeLatestSavedNative({pair,sourceDatabase:sourceDb,targetDatabase:targetDb,signal,timeoutMs:snapshot.blockedTimeoutMs});
    }finally{heldState.diagnosticGetters.delete(profileId);close();heldState.closers.delete(close);}
  };
  const commitHeldFinalBundle=async(input,heldState)=>{
    const value=exactInput(input,'final bundle commit');if(Object.keys(value).sort().join()!=='profileId,proof')throw profileError('INVALID','final commit accepts only profileId and opaque proof');
    const id=ownedWriteInput(value.profileId);if(typeof id!=='string')throw profileError('INVALID','final profileId must be a string');const profileId=requireProfileId(id),proof=value.proof;
    const reader=heldState.projectionTargets.get(profileId),state=reader?finalProofWorkspaces.get(reader.proofWorkspace):null;
    if(!state||!heldState.live)throw profileError('FINAL_TERMINAL_PROOF_BINDING','final commit requires this held projected target');
    state.assertLive();
    // Consumption is genuine static WeakMap authority through the private
    // native wrapper, not an input DTO. Failed consumption destroys the token.
    const verified=await state.consumeFinalProof(proof);state.assertLive();await state.binding.check();const bound=await state.binding.snapshot();
    if(verified.format!=='qb-native-final-cut-proof-v1'||verified.verifiedPerCut!==true||!sameStoredData(verified.bindingSnapshot,bound)||!bound.sourceVerified||bound.profileId!==profileId||!sameOwner(bound.owner,snapshot.owner)||bound.source?.checkpoint?.generation!==snapshot.owner.accountGeneration)throw profileError('FINAL_TERMINAL_PROOF_BINDING','consumed final proof differs from private binding');
    const reset=validateCursorReset(bound.source.cursorReset),checkpoint=bound.source.checkpoint;
    if(reset.generation!==snapshot.owner.accountGeneration||reset.generation!==checkpoint.generation||reset.logEpoch!==checkpoint.logEpoch||reset.exportCut!==checkpoint.cut||reset.resetExportId!==checkpoint.exportId||reset.manifestDigest!==bound.source.checkpointDigest||reset.expiresAt!==checkpoint.expiresAt||reset.pageUrl!=='/api/v2/export/page'||await canonicalDigest(checkpoint)!==reset.manifestDigest)throw profileError('CLOUD_RESET_BINDING','final private reset differs from verified checkpoint');
    const inspected=verified.nativeSummary;if(inspected?.manifest?.format!=='qb-v2-native-manifest-v2'||await canonicalDigest(inspected.manifest)!==inspected.contentDigest)throw profileError('CORRUPT','native final manifest digest differs');
    await state.binding.check();const completed=completedPair(bound.targetProfile,bound.targetJournal,inspected);validateProfileJournalPair(completed.profile,completed.journal);
    // Cleanup plan failure is observable, not a reason to roll back a genuine
    // verified recovery. Only this terminal transaction can commit its root.
    const revision=bound.originalPointer?.activationRevision??0;
    const finalPointer={key:'activeProfile',activeProfileId:profileId,activationRevision:revision+1};validateActiveProfilePointer(finalPointer);
    const jobId=crypto.randomUUID(),binding=ownedWriteInput({owner:snapshot.owner,sourceProfile:state.cleanupSource.pair.rawProfile,sourceJournal:state.cleanupSource.pair.rawJournal,migrationJournal:state.cleanupSource.journal,metadata:state.sourceMetadata,originalProfileId:bound.originalProfile.profileId,originalDbName:bound.originalProfile.dbName,originalPointer:bound.originalPointer,finalPointer,targetProfileId:profileId,targetJobId:bound.targetJournal.jobId,targetDbName:bound.targetProfile.dbName,targetContentDigest:inspected.contentDigest});
    let cleanupJob={key:`cleanup:${jobId}`,format:'qb-s1-cleanup-job-v1',jobId,phase:'prepared',binding,bindingDigest:await canonicalDigest(binding),inventory:null};
    const prepared=await cleanupHeldCheckpoint({profileId},heldState,{state,prepareOnly:true,deadline:Date.now()+60000});
    if(prepared.status==='checkpoint_source_prepared')try{cleanupJob=await saveCleanupInventory(cleanupJob,state.cleanupInventory,()=>state.binding.check(),state);}catch(error){cleanupJob={...cleanupJob,inventory:null,error:errorCode(error)};}
    else cleanupJob.error=prepared.error;
    validateCleanupJob(cleanupJob);completed.journal.cleanupCommitment={format:'qb-s1-cleanup-commitment-v1',jobId,bindingDigest:cleanupJob.bindingDigest,initialInventory:cleanupJob.inventory};if(state.prepareMarker)completed.journal.cleanupCommitment.prepareAnchor={format:'qb-s1-cleanup-prepare-anchor-v1',jobId,bindingDigest:cleanupJob.bindingDigest,inventoryRoot:state.prepareMarker.inventory.sha256};validateProfileJournalPair(completed.profile,completed.journal);
    const terminalWitness=Object.freeze({}),completion={profileId,committed:false,pointer:null};state.terminalCompletion=completion;finalControlCompletions.set(terminalWitness,completion);
    const pointer=await controlTx('readwrite',async tx=>{
      state.assertLive();if(!heldState.live||bound.source.checkpoint.expiresAt<=Date.now())throw profileError('CLOUD_CHECKPOINT_EXPIRED','checkpoint expired before final control commit');
      const profiles=tx.objectStore('profiles'),meta=tx.objectStore('meta');
      const actualProfile=await profiles.get(profileId),actualJournal=await meta.get(`fresh:${profileId}`),actualPointer=await meta.get('activeProfile');
      const oldId=bound.originalPointer?.activeProfileId,oldProfile=oldId?await profiles.get(oldId):undefined,oldJournal=oldId?await meta.get(`fresh:${oldId}`):undefined;
      state.assertLive();if(!heldState.live||bound.source.checkpoint.expiresAt<=Date.now())throw profileError('CLOUD_CHECKPOINT_EXPIRED','checkpoint expired inside final control transaction');
      if(!sameStoredData(actualProfile,bound.targetProfile)||!sameStoredData(actualJournal,bound.targetJournal)||!sameStoredData(actualPointer??null,bound.originalPointer)||!sameStoredData(oldProfile,bound.originalProfile)||!sameStoredData(oldJournal,bound.originalJournal))throw profileError('CONFLICT','final control original pair or pointer changed');
      const revision=bound.originalPointer?.activationRevision??0;if(revision>=Number.MAX_SAFE_INTEGER)throw profileError('REVISION_EXHAUSTED','activation revision exhausted');
      const next={key:'activeProfile',activeProfileId:profileId,activationRevision:revision+1};validateActiveProfilePointer(next);
      completion.pointer=ownedWriteInput(next);
      const priorCleanup=await meta.get(cleanupJob.key);if(priorCleanup!==undefined&&!sameStoredData(priorCleanup,cleanupJob))throw profileError('CONFLICT','cleanup prepared root changed');
      if(state.prepareMarker){const marker=validateCleanupPrepare(await meta.get(state.prepareMarker.key));if(!sameStoredData(marker,state.prepareMarker))throw profileError('CONFLICT','terminal preparation marker changed');if(cleanupJob.inventory!==null){if(marker.progress!==marker.inventory.frameCount||!sameStoredData(marker.inventory,cleanupJob.inventory))throw profileError('CONFLICT','terminal preparation incomplete');await meta.delete(marker.key);}else await meta.put(validateCleanupPrepare({...marker,phase:'terminal-referenced',targetProfile:completed.profile,targetJournal:completed.journal}));}
      cleanupJob={...cleanupJob,phase:'committed'};validateCleanupJob(cleanupJob);await meta.put(cleanupJob);state.cleanupJob=ownedWriteInput(cleanupJob);
      // Same terminal control transaction: optional indexed allocation never
      // replaces the durable job/commitment already written above.
      const allocationKey=`source-allocation:${binding.sourceProfile.profileId}`;
      const storedAllocation=await meta.get(allocationKey);
      if(storedAllocation!==undefined){
        const allocation=validateSourceAllocationMarker(storedAllocation);
        const sourceProfile=await profiles.get(allocation.profileId),sourceJournal=await meta.get(`fresh:${allocation.profileId}`);
        if(allocation.status!=='allocated'||!sameOwner(allocation.owner,snapshot.owner)||allocation.sourceProfileId!==binding.originalProfileId||allocation.leaseOwnerTabId!==binding.metadata.context.ownerTabId||allocation.leaseFence!==binding.metadata.context.fence||!sameStoredData(allocation.originalPointer,binding.originalPointer)||!sameStoredData(sourceProfile,binding.sourceProfile)||!sameStoredData(sourceJournal,binding.sourceJournal))throw profileError('CONFLICT','terminal indexed source allocation changed');
        const committedMarker=validateSourceAllocationMarker({...allocation,status:'committed'});
        const sourceCommit=validateSourceAllocationCommit({key:`source-allocation-commit:${allocation.profileId}`,format:'qb-cloud-source-commit-v1',marker:committedMarker,sourceProfile,sourceJournal,targetProfile:completed.profile,targetJournal:completed.journal,targetPointer:next});
        // Current journal contains cleanupCommitment and its prepareAnchor.
        validateCleanupCommitment(sourceCommit.targetJournal.cleanupCommitment);
        if(await meta.get(sourceCommit.key)!==undefined)throw profileError('CONFLICT','terminal allocation commit collision');
        await meta.put(committedMarker);await meta.add(sourceCommit);
      }
      await profiles.put(completed.profile);await meta.put(completed.journal);await meta.put(next);return next;
    },terminalWitness);
    // The committed control transaction intentionally invalidates the old
    // captured binding. Do not re-run its stale-pointer check after completion.
    return {status:'complete',profile:cloneData(completed.profile),pointer:cloneData(pointer),verification:cloneData(completed.journal.verification),capacityQualified:false,cleanupRequired:true,cleanupPreparationError:cleanupJob.error??null};
  };
  const bindHeldCheckpointLease=async(input,heldState)=>{
    const value=exactInput(input,'held checkpoint lease binding');if(Object.keys(value).join()!=='sourceCapability')throw profileError('INVALID','lease binding accepts only genuine source capability');
    if(heldState.leaseSource){if(heldState.leaseSource.sourceCapability!==value.sourceCapability)throw profileError('CONFLICT','held lease source cannot be replaced');await heldState.leaseSource.binding.check();return {status:'checkpoint_source_lease_bound'};}
    const access=consumeCloudProjectionSource(value.sourceCapability),metadata=await access.metadata(),original=await checkedPointerBundle();
    if(!heldState.live||!original.pair||!sameOwner(metadata.owner,snapshot.owner)||!sameOwner(original.pair.owner,snapshot.owner)||metadata.sourceProfileId!==original.pair.profile.profileId||!sameStoredData(metadata.originalPointer,original.pointer)||metadata.context.profileId!==metadata.sourceProfileId||metadata.context.activationRevision!==original.pointer.activationRevision||metadata.context.owner.accountId!==snapshot.owner.accountId||metadata.context.owner.accountGeneration!==snapshot.owner.accountGeneration)throw profileError('OWNER_MISMATCH','held lease source does not match actual original pair');
    if(typeof indexedDB.databases!=='function')throw profileError('DATABASE_INVENTORY_UNAVAILABLE','held source database inventory required');const inventory=await indexedDB.databases();if(!inventory.some(row=>row.name===original.pair.profile.dbName&&(row.version===1||row.version===BUSINESS_SCHEMA_VERSION)))throw profileError('SCHEMA_MISMATCH','held source database missing');
    let disposed=false,raw;const transactions=new Set(),opening=openDB(original.pair.profile.dbName,BUSINESS_SCHEMA_VERSION,{upgrade(db,oldVersion,newVersion,tx){tx.done.catch(()=>{});try{if(disposed||!heldState.live)throw profileError('CLOSED','upgrade cancelled');upgradeBusinessSchema(db,oldVersion,newVersion,tx);}catch(error){tx.abort();}}});
    const close=()=>{if(disposed)return;disposed=true;signal.removeEventListener('abort',close);for(const tx of transactions){try{tx.abort();}catch{}}transactions.clear();raw?.close();};heldState.closers.add(close);signal.addEventListener('abort',close,{once:true});
    const live=()=>{assertOpen();if(disposed||!heldState.live)throw profileError('CLOSED','held source lease capability closed');};
    const check=async()=>{live();const current=await checkedPointerBundle();live();if(!sameStoredData(current.pointer,original.pointer)||!sameStoredData(current.profile,original.profile)||!sameStoredData(current.journal,original.journal)||!sameOwner(current.pair?.owner,snapshot.owner))throw profileError('STALE_ACTIVE_PROFILE','held lease original pointer/pair changed');await access.check();live();};
    let timer;opening.then(db=>{if(disposed)db.close();},()=>{});
    try{raw=await Promise.race([opening,new Promise((resolve,reject)=>{void resolve;timer=setTimeout(()=>{close();reject(profileError('CLOSED','held lease open budget expired'));},snapshot.blockedTimeoutMs);})]);await check();
      const capability=Object.freeze({}),binding=Object.freeze({context:ownedWriteInput(metadata.context),timeoutMs:snapshot.blockedTimeoutMs,assertLive:live,check,trackTransaction:tx=>{live();transactions.add(tx);return ()=>transactions.delete(tx);}});
      raw.addEventListener('versionchange',close);
      const state={database:unwrap(raw),binding,capability,sourceCapability:value.sourceCapability,metadata:ownedWriteInput(metadata)};heldCheckpointLeases.set(capability,state);heldState.leaseSource=state;
      return {status:'checkpoint_source_lease_bound'};
    }catch(error){close();throw error;}finally{clearTimeout(timer);}
  };
  const renewHeldCheckpointLease=async(heldState)=>{if(!heldState.leaseSource)throw profileError('INVALID','checkpoint source lease is not bound');const state=heldState.leaseSource;return renewHeldCheckpointSourceLease(state.capability,state.database);};
  const cleanupFrameKey=(jobId,index)=>`cleanup-frame:${jobId}:${String(index).padStart(6,'0')}`;
  const originalControlTx=controlTx;
  const saveCleanupInventory=async(job,inventory,guard,state)=>{
    const controlTx=state.maintenanceControlTx??originalControlTx;
    const entries=[...inventory.values()].sort((a,b)=>a.store.localeCompare(b.store)||indexedDB.cmp(a.key,b.key));let parts=[],current=[],bytes=0;
    for(const entry of entries){bytes+=canonicalBytes(entry).length;if(bytes>8*1024*1024||entries.length>200000)throw profileError('CLOUD_CLEANUP_BUDGET','durable inventory budget');const candidate={key:cleanupFrameKey(job.jobId,parts.length),format:'qb-s1-cleanup-frame-v1',jobId:job.jobId,index:parts.length,entries:[...current,entry]};if(canonicalBytes(candidate).length>512*1024){if(!current.length)throw profileError('CLOUD_CLEANUP_BUDGET','cleanup entry too large');parts.push(current);current=[entry];}else current.push(entry);}
    parts.push(current);if(parts.length>32)throw profileError('CLOUD_CLEANUP_BUDGET','cleanup frame count');const descriptors=[],frames=[];let encodedBytes=0;
    // Entire encoded budget/root is computed before the FIRST metadata write.
    for(let index=0;index<parts.length;index++){await guard();const frame=validateCleanupFrame({key:cleanupFrameKey(job.jobId,index),format:'qb-s1-cleanup-frame-v1',jobId:job.jobId,index,entries:parts[index]}),frameBytes=canonicalBytes(frame).length;encodedBytes+=frameBytes;if(encodedBytes>8*1024*1024)throw profileError('CLOUD_CLEANUP_BUDGET','encoded frame aggregate');descriptors.push({index,count:frame.entries.length,bytes:frameBytes,sha256:await canonicalDigest(frame)});frames.push(frame);}
    const next=validateCleanupJob({...job,inventory:{frameCount:parts.length,recordCount:entries.length,bytes,encodedBytes,frames:descriptors,sha256:await canonicalDigest(descriptors)}});await guard();const witness=Object.freeze({}),physical={kind:'cleanup',committed:false};finalControlCompletions.set(witness,physical);
    const markerKey=`cleanup-prepare:${job.jobId}`,b=job.binding;
    const allocation=async(tx,marker)=>{const meta=tx.objectStore('meta'),profiles=tx.objectStore('profiles'),source=await profiles.get(b.sourceProfile.profileId),sourceJournal=await meta.get(`fresh:${b.sourceProfile.profileId}`),target=await profiles.get(b.targetProfileId),targetJournal=await meta.get(`fresh:${b.targetProfileId}`),pointer=await meta.get('activeProfile'),original=await profiles.get(b.originalProfileId),originalJournal=await meta.get(`fresh:${b.originalProfileId}`);const sourcePair=validateProfileJournalPair(source,sourceJournal,{allowStaged:true}),targetPair=validateProfileJournalPair(target,targetJournal,{allowStaged:true}),originalPair=validateProfileJournalPair(original,originalJournal);if(sourcePair.phase!=='created'||!sameStoredData(source,b.sourceProfile)||!sameStoredData(sourceJournal,b.sourceJournal)||!sameOwner(sourcePair.owner,snapshot.owner)||!sameOwner(targetPair.owner,snapshot.owner)||!sameOwner(originalPair.owner,snapshot.owner)||original.dbName!==b.originalDbName||target.dbName!==b.targetDbName||targetJournal.jobId!==b.targetJobId||!sameStoredData(pointer,job.phase==='prepared'?b.originalPointer:b.finalPointer)||target.profileId===source.profileId||source.profileId===original.profileId)throw profileError('CLOUD_CLEANUP_BINDING','prepare allocation changed');if(marker&&(!sameStoredData(target,marker.targetProfile)||!sameStoredData(targetJournal,marker.targetJournal)))throw profileError('CLOUD_CLEANUP_BINDING','prepare target pair changed');return {target,targetJournal,targetPair};};
    let marker=await controlTx('readwrite',async tx=>{
      const meta=tx.objectStore('meta'),old=await meta.get(markerKey),pair=await allocation(tx,old);
      if(old!==undefined){const m=validateCleanupPrepare(old);if(m.phase===(job.phase==='prepared'?'prepared':'terminal-referenced')&&m.job.bindingDigest===job.bindingDigest&&sameStoredData(m.job.binding,b)&&sameStoredData(m.inventory,next.inventory))return m;throw profileError('CLOUD_CLEANUP_CHANGED','prepare marker/root differs');}
      const prefix=`cleanup-frame:${job.jobId}:`;if(await meta.openKeyCursor(IDBKeyRange.bound(prefix,prefix+'\uffff')))throw profileError('CLOUD_CLEANUP_CHANGED','unidentified frame before prepare marker');
      let journal=pair.targetJournal;
      if(job.phase==='prepared'){if(pair.targetPair.phase!=='created')throw profileError('CLOUD_CLEANUP_BINDING','prepare target must be inactive created');}
      else{const c=validateCleanupCommitment(journal.cleanupCommitment);if(pair.targetPair.phase!=='completed'||pair.targetPair.manifest.format!=='qb-v2-native-manifest-v2'||c.jobId!==job.jobId||c.bindingDigest!==job.bindingDigest||c.initialInventory!==null||c.prepareAnchor!==undefined)throw profileError('CLOUD_CLEANUP_BINDING','new fallback anchor requires genuine null terminal');journal={...journal,cleanupCommitment:{...c,prepareAnchor:{format:'qb-s1-cleanup-prepare-anchor-v1',jobId:job.jobId,bindingDigest:job.bindingDigest,inventoryRoot:next.inventory.sha256}}};await meta.put(journal);}
      const m=validateCleanupPrepare({key:markerKey,format:'qb-s1-cleanup-prepare-v1',jobId:job.jobId,phase:job.phase==='prepared'?'prepared':'terminal-referenced',job,inventory:next.inventory,progress:0,targetProfile:pair.target,targetJournal:journal});await meta.put(m);return m;
    });state.prepareMarker=marker;if(state.maintenanceExpectedTarget&&job.phase==='committed')state.maintenanceExpectedTarget=ownedWriteInput({profile:marker.targetProfile,journal:marker.targetJournal});await guard();
    for(const frame of frames){await guard();marker=await controlTx('readwrite',async tx=>{const meta=tx.objectStore('meta'),actual=validateCleanupPrepare(await meta.get(markerKey));await allocation(tx,actual);if(!sameStoredData(actual,marker))throw profileError('CLOUD_CLEANUP_CHANGED','frame progress CAS');const old=await meta.get(frame.key);if(frame.index<actual.progress){if(!sameStoredData(old,frame))throw profileError('CLOUD_CLEANUP_CHANGED','previous prepared frame differs');return actual;}if(frame.index!==actual.progress||old!==undefined&&!sameStoredData(old,frame))throw profileError('CLOUD_CLEANUP_CHANGED','frame/progress mismatch');const advanced=validateCleanupPrepare({...actual,progress:actual.progress+1});await meta.put(frame);await meta.put(advanced);return advanced;});state.prepareMarker=marker;await guard();}
    let committedTarget;
    try{await controlTx('readwrite',async tx=>{
      const meta=tx.objectStore('meta'),old=await meta.get(job.key),actualMarker=validateCleanupPrepare(await meta.get(markerKey));await allocation(tx,actualMarker);if(!sameStoredData(actualMarker,marker)||marker.progress!==marker.inventory.frameCount||old!==undefined&&!sameStoredData(old,job))throw profileError('CLOUD_CLEANUP_CHANGED','cleanup root/progress changed before inventory');
      if(job.phase==='committed'){
        const b=job.binding,pointer=await meta.get('activeProfile'),target=await tx.objectStore('profiles').get(b.targetProfileId),journal=await meta.get(`fresh:${b.targetProfileId}`),pair=validateProfileJournalPair(target,journal),commitment=validateCleanupCommitment(journal.cleanupCommitment);
        if(!sameStoredData(pointer,b.finalPointer)||pair.phase!=='completed'||!sameOwner(pair.owner,snapshot.owner)||target.dbName!==b.targetDbName||journal.jobId!==b.targetJobId||pair.verification.contentDigest!==b.targetContentDigest||commitment.jobId!==job.jobId||commitment.bindingDigest!==job.bindingDigest||commitment.initialInventory!==null)throw profileError('CLOUD_CLEANUP_BINDING','maintenance inventory requires exact unprepared terminal root');
        // A failed precommit preparation may be completed only after actual
        // source membership validation. Anchor its new root to the completed
        // target journal in this SAME maintenance control transaction.
        committedTarget={profile:target,journal:{...journal,cleanupCommitment:{...commitment,initialInventory:next.inventory}}};await meta.put(committedTarget.journal);
        await meta.delete(markerKey);
      }
      await meta.put(next);
    },witness);}catch(error){if(!physical.committed)throw error;}
    if(state.maintenanceExpectedTarget&&physical.committed&&committedTarget)state.maintenanceExpectedTarget=ownedWriteInput(committedTarget);
    // Preserve the actual prepared root if tx.done completed before a later
    // lifecycle guard rejected. Terminal owner/pointer guards still run.
    return next;
  };
  const loadCleanupInventory=async(job,guard,maintenanceControlTx)=>{
    const controlTx=maintenanceControlTx??originalControlTx;
    if(!job.inventory)return null;const map=new Map(),descriptors=[];let count=0,bytes=0,previous;
    await guard();const frameKeys=await controlTx('readonly',async tx=>{const prefix=`cleanup-frame:${job.jobId}:`,keys=[];let cursor=await tx.objectStore('meta').openKeyCursor(IDBKeyRange.bound(prefix,prefix+'\uffff'));while(cursor){keys.push(cursor.key);if(keys.length>32)throw profileError('CLOUD_CLEANUP_BUDGET','too many durable frames');cursor=await cursor.continue();}return keys;});await guard();
    if(frameKeys.length!==job.inventory.frameCount||frameKeys.some((key,index)=>key!==cleanupFrameKey(job.jobId,index)))throw profileError('CLOUD_CLEANUP_CHANGED','unknown or missing durable frame');
    for(let index=0;index<job.inventory.frameCount;index++){
      await guard();const frame=validateCleanupFrame(await controlTx('readonly',tx=>tx.objectStore('meta').get(cleanupFrameKey(job.jobId,index))));if(frame.jobId!==job.jobId||frame.index!==index)throw profileError('CLOUD_CLEANUP_CHANGED','inventory frame identity');
      descriptors.push({index,count:frame.entries.length,bytes:canonicalBytes(frame).length,sha256:await canonicalDigest(frame)});if(descriptors.reduce((sum,f)=>sum+f.bytes,0)>8*1024*1024)throw profileError('CLOUD_CLEANUP_BUDGET','encoded frame read aggregate');
      for(const e of frame.entries){if(previous&&(previous.store.localeCompare(e.store)||indexedDB.cmp(previous.key,e.key))>=0)throw profileError('CLOUD_CLEANUP_CHANGED','inventory order or duplicate');previous=e;const id=`${e.store}:${JSON.stringify(e.key)}`;count++;bytes+=canonicalBytes(e).length;if(count>200000||bytes>8*1024*1024)throw profileError('CLOUD_CLEANUP_BUDGET','inventory read budget');map.set(id,ownedWriteInput(e));}await guard();
    }
    if(count!==job.inventory.recordCount||bytes!==job.inventory.bytes||descriptors.reduce((sum,f)=>sum+f.bytes,0)!==job.inventory.encodedBytes||!sameStoredData(descriptors,job.inventory.frames)||await canonicalDigest(descriptors)!==job.inventory.sha256)throw profileError('CLOUD_CLEANUP_CHANGED','inventory root differs');return map;
  };
  const cleanupCompletedFrames=async(state,check,live)=>{
    const controlTx=state.maintenanceControlTx??originalControlTx;
    const job=state.cleanupJob;if(job.phase!=='complete'||!job.inventory||await canonicalDigest(job.inventory.frames)!==job.inventory.sha256)throw profileError('CLOUD_CLEANUP_CHANGED','completed frame authority required');
    const controlBinding=async tx=>{live();const meta=tx.objectStore('meta'),profiles=tx.objectStore('profiles'),b=job.binding,stored=await meta.get(job.key),pointer=await meta.get('activeProfile'),target=await profiles.get(b.targetProfileId),journal=await meta.get(`fresh:${b.targetProfileId}`),source=await profiles.get(b.sourceProfile.profileId),sourceJournal=await meta.get(`fresh:${b.sourceProfile.profileId}`);live();const pair=validateProfileJournalPair(target,journal),commitment=validateCleanupCommitment(journal.cleanupCommitment);if(!sameStoredData(stored,state.cleanupJob)||!sameStoredData(pointer,b.finalPointer)||pair.phase!=='completed'||!sameOwner(pair.owner,snapshot.owner)||target.dbName!==b.targetDbName||journal.jobId!==b.targetJobId||pair.verification.contentDigest!==b.targetContentDigest||commitment.jobId!==job.jobId||commitment.bindingDigest!==job.bindingDigest||!sameStoredData(commitment.initialInventory,job.inventory)||!sameStoredData(source,job.completedSource.profile)||!sameStoredData(sourceJournal,job.completedSource.journal))throw profileError('CLOUD_CLEANUP_BINDING','completed-frame actual control binding');};
    const keys=async()=>controlTx('readonly',async tx=>{const prefix=`cleanup-frame:${job.jobId}:`,result=[];let cursor=await tx.objectStore('meta').openKeyCursor(IDBKeyRange.bound(prefix,prefix+'\uffff'));while(cursor){result.push(cursor.key);if(result.length>32)throw profileError('CLOUD_CLEANUP_BUDGET','remaining frame count');cursor=await cursor.continue();}return result;});
    await check();const remaining=await keys();await check();if(job.framesCleaned&&remaining.length)throw profileError('CLOUD_CLEANUP_CHANGED','completed frames reappeared');
    const readFrame=async key=>{const index=job.inventory.frames.findIndex(f=>cleanupFrameKey(job.jobId,f.index)===key);if(index<0)throw profileError('CLOUD_CLEANUP_CHANGED','foreign cleanup frame');const frame=validateCleanupFrame(await controlTx('readonly',tx=>tx.objectStore('meta').get(key))),descriptor=job.inventory.frames[index];if(frame.jobId!==job.jobId||frame.index!==index||frame.entries.length!==descriptor.count||canonicalBytes(frame).length!==descriptor.bytes||await canonicalDigest(frame)!==descriptor.sha256)throw profileError('CLOUD_CLEANUP_CHANGED','remaining frame changed');return frame;};
    // Validate the entire remaining set before deleting any member. Missing
    // members are legal only after the actual source-completion marker.
    for(const key of remaining){await check();await readFrame(key);await check();}
    for(const key of remaining){await check();const frame=await readFrame(key);await check();await controlTx('readwrite',async tx=>{await controlBinding(tx);const meta=tx.objectStore('meta'),actual=await meta.get(key);live();if(!sameStoredData(actual,frame))throw profileError('CLOUD_CLEANUP_CHANGED','frame deletion CAS changed');await meta.delete(key);});await check();}
    if((await keys()).length)throw profileError('CLOUD_CLEANUP_CHANGED','frames remain');await check();
    if(!job.framesCleaned){const next=validateCleanupJob({...job,framesCleaned:true}),witness=Object.freeze({}),physical={kind:'cleanup',committed:false};finalControlCompletions.set(witness,physical);state.framesCompletion=physical;
      await controlTx('readwrite',async tx=>{await controlBinding(tx);live();const meta=tx.objectStore('meta'),prefix=`cleanup-frame:${job.jobId}:`,remaining=await meta.openKeyCursor(IDBKeyRange.bound(prefix,prefix+'\uffff'));live();if(remaining)throw profileError('CLOUD_CLEANUP_CHANGED','frame appeared before atomic completion');await meta.put(next);},witness);state.cleanupJob=next;
    }
    return {status:'checkpoint_source_cleaned',cleanupRequired:false,framesCleanupRequired:false,profileId:job.binding.targetProfileId,sourceProfileId:job.binding.sourceProfile.profileId};
  };
  const cleanupHeldCheckpoint=async(input,heldState,privateMode={})=>{
    const value=ownedWriteInput(exactInput(input,'checkpoint cleanup'));if(Object.keys(value).join()!=='profileId'||typeof value.profileId!=='string')throw profileError('INVALID','cleanup accepts only profileId');
    const profileId=requireProfileId(value.profileId),reader=heldState.projectionTargets.get(profileId),state=privateMode.state??(reader?finalProofWorkspaces.get(reader.proofWorkspace):null);
    if((!privateMode.prepareOnly&&!state?.terminalCompletion?.committed)||!state?.cleanupSource||!heldState.live)throw profileError('CLOUD_CLEANUP_NOT_COMMITTED','cleanup requires this actual committed held target');
    const expected=state.cleanupSource,sourceId=expected.pair.profile.profileId,metadata=state.sourceMetadata,completion=state.terminalCompletion;
    const controlTx=state.maintenanceControlTx??originalControlTx,step=state.maintenanceStep??(work=>work());
    let raw,native,rows,cleanupCompletion;const deadline=privateMode.deadline??Date.now()+60000;
    const live=()=>{assertOpen();if(!heldState.live)throw profileError('CLOSED','cleanup lock released');if(state.maintenanceCap&&cleanupMaintenanceCaps.get(state.maintenanceCap)?.heldState!==heldState)throw profileError('CLOSED','maintenance capability invalid');if(Date.now()>=deadline)throw profileError('CLOUD_CLEANUP_DEADLINE','maintenance attempt expired');};
    const check=async()=>{live();const active=await checkedPointerBundle(),source=await checkedPair(sourceId,{allowStaged:true,requireOwner:true});live();const pointer=privateMode.prepareOnly?state.metadata.originalPointer:completion.pointer,expectedSource=state.cleanupJob?.phase==='complete'?state.cleanupJob.completedSource:{profile:expected.pair.rawProfile,journal:expected.pair.rawJournal};if(!sameStoredData(active.pointer,pointer)||(!privateMode.prepareOnly&&active.pointer?.activeProfileId!==profileId)||!sameOwner(active.pair?.owner,snapshot.owner)||sourceId===profileId||sourceId===state.metadata.sourceProfileId||sourceId===active.pointer?.activeProfileId||!sameStoredData(source?.rawProfile,expectedSource.profile)||!sameStoredData(source?.rawJournal,expectedSource.journal))throw profileError('CLOUD_CLEANUP_BINDING','actual source/control binding changed');if(state.cleanupJob){const stored=validateCleanupJob(await controlTx('readonly',tx=>tx.objectStore('meta').get(state.cleanupJob.key)));if(!sameStoredData(stored,state.cleanupJob))throw profileError('CLOUD_CLEANUP_CHANGED','durable cleanup job changed');if(!privateMode.prepareOnly){const commitment=validateCleanupCommitment(active.pair.journal.cleanupCommitment),b=stored.binding,original=await checkedPair(b.originalProfileId,{requireOwner:true});live();if(commitment.jobId!==stored.jobId||commitment.bindingDigest!==stored.bindingDigest||active.pair.journal.jobId!==b.targetJobId||active.pair.profile.dbName!==b.targetDbName||active.pair.verification.contentDigest!==b.targetContentDigest||!original||original.profile.dbName!==b.originalDbName||!sameOwner(original.owner,snapshot.owner))throw profileError('CLOUD_CLEANUP_BINDING','terminal cleanup authority changed');}}};
    try{
      await check();const inventory=await indexedDB.databases();await check();if(!inventory.some(row=>row.name===expected.pair.profile.dbName&&(row.version===1||row.version===BUSINESS_SCHEMA_VERSION)))throw profileError('SCHEMA_MISMATCH','owned source database unavailable');
      raw=await step(()=>openDB(expected.pair.profile.dbName,BUSINESS_SCHEMA_VERSION,{upgrade(db,oldVersion,newVersion,tx){tx.done.catch(()=>{});try{live();upgradeBusinessSchema(db,oldVersion,newVersion,tx);}catch(error){tx.abort();}}}));unwrap(raw).onversionchange=()=>{heldState.live=false;raw.close();};await check();
      native=await step(()=>openCloudNativeDatabase({profile:expected.pair.profile,blockedTimeoutMs:state.maintenanceStep?Math.min(2000,snapshot.blockedTimeoutMs):snapshot.blockedTimeoutMs,signal,guard:live}));rows=await step(()=>createBoundedNativeAccess(unwrap(raw),{signal,guard:live,timeoutMs:state.maintenanceStep?Math.min(2000,snapshot.blockedTimeoutMs):snapshot.blockedTimeoutMs}));
      const nativeGet=native.get.bind(native),nativeWrite=native.write.bind(native);native={...native,get:(...args)=>step(()=>nativeGet(...args)),write:(...args)=>step(()=>nativeWrite(...args))};
      const scan=async(store,work)=>{let after=null;do{const page=await step(()=>rows.readPage({store,after,limit:100}));await check();for(const row of page.rows)await work(row);after=page.after;}while(after!==null);};
      const keyOf=(store,row)=>store==='content_chunks'?[row.contentDigest,row.chunkIndex]:store==='import_receipts'?[row.sourceId,row.sourceRecordId]:row.migrationId;
      const fingerprint=async(store,row)=>store==='content_chunks'?canonicalDigest({contentDigest:row.contentDigest,chunkIndex:row.chunkIndex,byteLength:row.bytes.length,sha256:await sha256Hex(row.bytes)}):canonicalDigest(row);
      for(const store of Object.keys(APP_DATA_STORES))if(!['content_chunks','import_receipts','migration_journal'].includes(store))await scan(store,()=>{throw profileError('CLOUD_CLEANUP_FOREIGN_BUSINESS','source contains learning business rows');});
      if(state.cleanupJob?.phase==='complete'){for(const store of ['content_chunks','import_receipts','migration_journal'])await scan(store,()=>{throw profileError('CLOUD_CLEANUP_CHANGED','completed cleanup source not empty');});await check();return {...await cleanupCompletedFrames(state,check,live),idempotent:true};}
      if(!state.cleanupInventory){
      const initialCut=new Map();let initialBytes=0;
      for(const store of ['content_chunks','import_receipts','migration_journal'])await scan(store,async row=>{const key=keyOf(store,row),entry={store,key,sha256:await fingerprint(store,row)};initialBytes+=canonicalBytes(entry).length;if(initialCut.size>=200000||initialBytes>8*1024*1024)throw profileError('CLOUD_CLEANUP_BUDGET','initial source cut exceeds bounded metadata budget');initialCut.set(`${store}:${JSON.stringify(key)}`,entry);});
      const journal=validateCloudStageJournal(await native.get('migration_journal',metadata.stageId));await check();if(!sameStoredData(journal,expected.journal))throw profileError('CLOUD_CLEANUP_BINDING','source stage journal changed');
      const allowed=new Map(),references=new Map();let membershipBytes=0;
      const permit=(digest,index,sha,length)=>{const key=`${digest}:${index}`,prior=allowed.get(key);if(prior&&(prior.sha!==sha||prior.length!==length))throw profileError('CLOUD_CLEANUP_COLLISION','owned chunk descriptors diverge');if(!prior){membershipBytes+=canonicalBytes({key,sha,length}).length;if(membershipBytes>8*1024*1024)throw profileError('CLOUD_CLEANUP_BUDGET','source membership metadata exceeds bounded budget');}allowed.set(key,{sha,length});if(allowed.size>200000)throw profileError('CLOUD_CLEANUP_BUDGET','source inventory exceeds bounded key count');};
      for(const [section,count]of Object.entries(journal.counts))for(let index=0;index<count.pages;index++){
        const page=validateCloudPageReceipt(await native.get('import_receipts',[`qb-cloud-stage:${metadata.stageId}`,`${section}:${index}`]));await check();const p=page.provenance;
        if(p.stageId!==metadata.stageId||p.section!==section||p.index!==index||p.storageDigest!==await cloudTemporaryDigest(metadata.stageId,'page',`${section}:${index}`))throw profileError('CLOUD_CLEANUP_PAGE','foreign source page');
        const chunk=await native.get('content_chunks',[p.storageDigest,0]);const bytes=chunk?.bytes??new Uint8Array();
        if(bytes.length!==p.utf8Bytes||await sha256Hex(bytes)!==p.sha256)throw profileError('CLOUD_CLEANUP_PAGE','source page bytes differ');if(bytes.length)permit(p.storageDigest,0,p.sha256,bytes.length);
        if(section==='content-references.ndjson')for(const line of new TextDecoder('utf-8',{fatal:true}).decode(bytes).split('\n').filter(Boolean)){const row=validateCloudContentReference(JSON.parse(line));const ref=row.reference;if(ref){const prior=references.get(ref.contentDigest);if(prior&&!sameStoredData(prior,ref))throw profileError('CLOUD_CLEANUP_COLLISION','source reference diverges');if(!prior){membershipBytes+=canonicalBytes(ref).length;if(membershipBytes>8*1024*1024)throw profileError('CLOUD_CLEANUP_BUDGET','source reference metadata exceeds bounded budget');}references.set(ref.contentDigest,ref);if(references.size>200000)throw profileError('CLOUD_CLEANUP_BUDGET','source reference inventory exceeds bounded key count');}}
      }
      for(const reference of references.values()){
        const manifestChunk=await native.get('content_chunks',[reference.manifestDigest,0]);if(!manifestChunk||await sha256Hex(manifestChunk.bytes)!==reference.manifestDigest)throw profileError('CLOUD_CLEANUP_CONTENT','normalized manifest missing');
        const manifest=validateChunkManifest(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(manifestChunk.bytes)));if(manifest.contentDigest!==reference.contentDigest||manifest.totalBytes!==reference.totalBytes||manifest.chunkCount!==reference.chunkCount||!equalBytes(manifestChunk.bytes,canonicalBytes(manifest)))throw profileError('CLOUD_CLEANUP_CONTENT','source manifest binding differs');
        permit(reference.manifestDigest,0,reference.manifestDigest,manifestChunk.bytes.length);
        for(const part of manifest.chunks){permit(reference.contentDigest,part.chunkIndex,part.sha256,part.byteLength);permit(await cloudTemporaryDigest(metadata.stageId,'chunk',`${reference.contentDigest}:${part.chunkIndex}`),0,part.sha256,part.byteLength);}
      }
      // Validate the complete source inventory before deleting any row.
      await scan('migration_journal',row=>{if(!sameStoredData(row,journal))throw profileError('CLOUD_CLEANUP_FOREIGN_JOURNAL','source contains another journal');});
      await scan('import_receipts',async row=>{if(row.sourceId===`qb-cloud-stage:${metadata.stageId}`){const page=validateCloudPageReceipt(row);if(page.provenance.stageId!==metadata.stageId||page.provenance.index>=journal.counts[page.provenance.section].pages)throw profileError('CLOUD_CLEANUP_PAGE','unexpected source page');return;}const index=validateCloudStageIndexShape(row);if(index.provenance.stageId!==metadata.stageId)throw profileError('CLOUD_CLEANUP_FOREIGN_INDEX','source contains foreign index');const p=index.provenance,pageReceipt=await native.get('import_receipts',[`qb-cloud-stage:${metadata.stageId}`,`${p.section}:${p.pageIndex}`]),chunk=await native.get('content_chunks',[p.storageDigest,0]);await verifyCloudStageIndex({index,journal,pageReceipt,pageBytes:chunk?.bytes??new Uint8Array(),expected:{}});});
      await scan('content_chunks',async row=>{const descriptor=allowed.get(`${row.contentDigest}:${row.chunkIndex}`);if(!descriptor||row.bytes.length!==descriptor.length||await sha256Hex(row.bytes)!==descriptor.sha)throw profileError('CLOUD_CLEANUP_UNKNOWN_CONTENT','unknown or changed source chunk');});
      // Retain only exact validated key/digests in this private held state.
      // A interrupted cleanup can resume without pretending deleted pages
      // were freshly revalidated. No persisted/caller inventory is accepted.
      const inventory=new Map();let inventoryBytes=0;
      for(const store of ['content_chunks','import_receipts','migration_journal'])await scan(store,async row=>{const key=keyOf(store,row),entry={store,key,sha256:await fingerprint(store,row)},id=`${store}:${JSON.stringify(key)}`;inventoryBytes+=canonicalBytes(entry).length;if(inventory.size>=200000||inventoryBytes>8*1024*1024)throw profileError('CLOUD_CLEANUP_BUDGET','private cleanup inventory exceeds bounded metadata budget');if(!sameStoredData(initialCut.get(id),entry))throw profileError('CLOUD_CLEANUP_CHANGED','source changed during validation');inventory.set(id,entry);});
      if(inventory.size!==initialCut.size)throw profileError('CLOUD_CLEANUP_CHANGED','source rows changed during validation');
      await check();state.cleanupInventory=inventory;
      }
      if(privateMode.prepareOnly)return {status:'checkpoint_source_prepared',profileId};
      if(state.cleanupJob?.inventory===null){state.cleanupJob=await saveCleanupInventory(state.cleanupJob,state.cleanupInventory,check,state);await check();}
      // Before each attempt, reject every changed/foreign remaining row.
      // Missing entries are legitimate only under this genuine prior cut.
      for(const store of ['content_chunks','import_receipts','migration_journal'])await scan(store,async row=>{const key=keyOf(store,row),entry=state.cleanupInventory.get(`${store}:${JSON.stringify(key)}`);if(!entry||await fingerprint(store,row)!==entry.sha256)throw profileError('CLOUD_CLEANUP_CHANGED','source differs from private validated inventory');});
      for(const store of ['content_chunks','import_receipts','migration_journal'])await scan(store,async row=>{const key=keyOf(store,row),entry=state.cleanupInventory.get(`${store}:${JSON.stringify(key)}`);if(!entry||await fingerprint(store,row)!==entry.sha256)throw profileError('CLOUD_CLEANUP_CHANGED','source changed before exact delete');await check();await native.write({conditions:[{store,key,expected:row}],deletes:[{store,key}]});await check();});
      for(const store of ['content_chunks','import_receipts','migration_journal'])await scan(store,()=>{throw profileError('CLOUD_CLEANUP_INCOMPLETE','source rows remain');});
      await check();const quarantined=quarantinedPair(expected.pair.profile,expected.pair.journal,'inspect',profileError('CLOUD_SOURCE_CLEANED','committed checkpoint source cleaned')),job=validateCleanupJob({...state.cleanupJob,phase:'complete',completedSource:quarantined,framesCleaned:false}),witness=Object.freeze({});cleanupCompletion={kind:'cleanup',profileId,committed:false};finalControlCompletions.set(witness,cleanupCompletion);
      await controlTx('readwrite',async tx=>{
        live();const meta=tx.objectStore('meta'),profiles=tx.objectStore('profiles'),pointer=await meta.get('activeProfile'),target=await profiles.get(profileId),targetJournal=await meta.get(`fresh:${profileId}`),source=await profiles.get(sourceId),sourceJournal=await meta.get(`fresh:${sourceId}`),oldJob=await meta.get(job.key);live();
        const targetPair=validateProfileJournalPair(target,targetJournal),commitment=validateCleanupCommitment(targetJournal.cleanupCommitment),b=job.binding;
        if(!sameStoredData(pointer,completion.pointer)||targetPair.phase!=='completed'||!sameOwner(targetPair.owner,snapshot.owner)||target.dbName!==b.targetDbName||targetJournal.jobId!==b.targetJobId||targetPair.verification.contentDigest!==b.targetContentDigest||commitment.jobId!==job.jobId||commitment.bindingDigest!==job.bindingDigest||(commitment.initialInventory!==null&&!sameStoredData(commitment.initialInventory,job.inventory))||!sameStoredData(source,expected.pair.rawProfile)||!sameStoredData(sourceJournal,expected.pair.rawJournal)||!sameStoredData(oldJob,state.cleanupJob))throw profileError('CLOUD_CLEANUP_BINDING','cleanup completion control CAS changed');
        await profiles.put(quarantined.profile);await meta.put(quarantined.journal);await meta.put(job);
      },witness);state.cleanupJob=job;
      return await cleanupCompletedFrames(state,check,live);
    }catch(cause){const sourceCommitted=cleanupCompletion?.committed===true||state.cleanupJob?.phase==='complete',framesCommitted=state.framesCompletion?.committed===true;return {status:sourceCommitted?'checkpoint_source_cleaned':'cleanup-incomplete',cleanupRequired:!framesCommitted,framesCleanupRequired:sourceCommitted&&!framesCommitted,cleanupCommitted:sourceCommitted,profileId,error:typeof cause?.code==='string'?cause.code:'CLOUD_CLEANUP_FAILED'};}finally{rows?.close();native?.close();raw?.close();}
  };
  const resumeCleanupHeld=async(input,heldState,deadline=Date.now()+60000)=>{
    const value=ownedWriteInput(exactInput(input,'resume source cleanup'));if(Object.keys(value).join()!=='profileId'||typeof value.profileId!=='string')throw profileError('INVALID','cleanup resume accepts only profileId');const profileId=requireProfileId(value.profileId);
    const live=()=>{assertOpen();if(!heldState.live)throw profileError('CLOSED','cleanup maintenance lock released');if(Date.now()>=deadline)throw profileError('CLOUD_CLEANUP_DEADLINE','maintenance attempt expired');};
    live();const active=await readColdActive(deadline);live();if(active.pointer?.activeProfileId!==profileId||active.pair?.phase!=='completed'||!sameOwner(active.pair.owner,snapshot.owner))throw profileError('CLOUD_CLEANUP_BINDING','current owned Ready terminal required');
    if(!Object.prototype.hasOwnProperty.call(active.pair.journal,'cleanupCommitment')){
      if(active.pair.manifest.format==='qb-v2-native-manifest-v2')return {status:'cleanup-untracked',cleanupRequired:true,framesCleanupRequired:false,profileId,error:'CLOUD_CLEANUP_UNTRACKED'};
      return {status:'no-cleanup-commitment',cleanupRequired:false,framesCleanupRequired:false,profileId};
    }
    const commitment=validateCleanupCommitment(active.pair.journal.cleanupCommitment),job=validateCleanupJob(await withProfileWriteLock(profileWriteLockKey(),'shared',()=>controlTx('readonly',tx=>tx.objectStore('meta').get(`cleanup:${commitment.jobId}`),undefined,Math.max(1,Math.min(2000,deadline-Date.now()))),{signal,timeoutMs:Math.max(1,Math.min(snapshot.blockedTimeoutMs,deadline-Date.now()))}));live();
    if(job.phase==='prepared'||job.bindingDigest!==commitment.bindingDigest||await canonicalDigest(job.binding)!==job.bindingDigest||!sameOwner(job.binding.owner,snapshot.owner)||job.binding.targetProfileId!==profileId||!sameStoredData(job.binding.finalPointer,active.pointer)||(commitment.initialInventory!==null&&!sameStoredData(commitment.initialInventory,job.inventory)))throw profileError('CLOUD_CLEANUP_BINDING','no genuine committed cleanup root');
    const b=job.binding,m=b.metadata,checkpoint=validateCloudCheckpoint(m.checkpoint),reset=validateCursorReset(m.cursorReset),journal=validateCloudStageJournal(b.migrationJournal);
    if(await canonicalDigest(checkpoint)!==m.checkpointDigest||reset.manifestDigest!==m.checkpointDigest||reset.resetExportId!==checkpoint.exportId||reset.generation!==checkpoint.generation||reset.logEpoch!==checkpoint.logEpoch||reset.exportCut!==checkpoint.cut||reset.expiresAt!==checkpoint.expiresAt||reset.pageUrl!=='/api/v2/export/page'||checkpoint.generation!==snapshot.owner.accountGeneration||journal.migrationId!==m.stageId||journal.checkpoint.profileId!==b.sourceProfile.profileId||journal.checkpoint.sourceProfileId!==b.originalProfileId||!sameOwner(journal.checkpoint.owner,snapshot.owner)||!sameStoredData(journal.checkpoint.cloudCheckpoint,checkpoint)||journal.checkpoint.checkpointDigest!==m.checkpointDigest)throw profileError('CLOUD_CLEANUP_BINDING','committed original checkpoint/source differs');
    const pair=validateProfileJournalPair(b.sourceProfile,b.sourceJournal,{allowStaged:true}),state={cleanupSource:{pair:{...pair,rawProfile:b.sourceProfile,rawJournal:b.sourceJournal},journal:b.migrationJournal},sourceMetadata:m,metadata:{sourceProfileId:b.originalProfileId,originalPointer:b.originalPointer},terminalCompletion:{committed:true,pointer:b.finalPointer},cleanupJob:job,maintenanceCap:Object.freeze({})};cleanupMaintenanceCaps.set(state.maintenanceCap,{heldState,state});
    state.maintenanceExpectedTarget=ownedWriteInput({profile:active.profile,journal:active.journal});
    let stepping=false,stepEnd=0;
    const step=async work=>{if(stepping)throw profileError('INVALID','nested maintenance profile grant');live();return withProfileWriteLock(profileWriteLockKey(),'shared',async()=>{
      stepping=true;stepEnd=Math.min(deadline,Date.now()+2000);const stepTimer=setTimeout(()=>invalidate(),Math.max(0,stepEnd-Date.now()));try{live();await originalControlTx('readonly',async tx=>{const meta=tx.objectStore('meta'),profiles=tx.objectStore('profiles'),pointer=await meta.get('activeProfile'),target=await profiles.get(profileId),targetJournal=await meta.get(`fresh:${profileId}`),source=await profiles.get(b.sourceProfile.profileId),sourceJournal=await meta.get(`fresh:${b.sourceProfile.profileId}`),stored=validateCleanupJob(await meta.get(job.key)),original=await profiles.get(b.originalProfileId),originalJournal=await meta.get(`fresh:${b.originalProfileId}`);live();const targetPair=validateProfileJournalPair(target,targetJournal),sourcePair=validateProfileJournalPair(source,sourceJournal,{allowStaged:true}),originalPair=validateProfileJournalPair(original,originalJournal),commitment=validateCleanupCommitment(targetJournal.cleanupCommitment),expectedSource=state.cleanupJob.phase==='complete'?state.cleanupJob.completedSource:{profile:b.sourceProfile,journal:b.sourceJournal};if(!sameStoredData(target,state.maintenanceExpectedTarget.profile)||!sameStoredData(targetJournal,state.maintenanceExpectedTarget.journal)||state.maintenanceExpectedOriginal&&(!sameStoredData(original,state.maintenanceExpectedOriginal.profile)||!sameStoredData(originalJournal,state.maintenanceExpectedOriginal.journal))||!sameStoredData(pointer,b.finalPointer)||!sameStoredData(stored,state.cleanupJob)||!sameStoredData(source,expectedSource.profile)||!sameStoredData(sourceJournal,expectedSource.journal)||![targetPair.owner,sourcePair.owner,originalPair.owner].every(o=>sameOwner(o,snapshot.owner))||targetPair.phase!=='completed'||target.dbName!==b.targetDbName||targetJournal.jobId!==b.targetJobId||targetPair.verification.contentDigest!==b.targetContentDigest||original.dbName!==b.originalDbName||commitment.jobId!==job.jobId||commitment.bindingDigest!==job.bindingDigest)throw profileError('CLOUD_CLEANUP_BINDING','short maintenance step authority changed');if(!state.maintenanceExpectedOriginal)state.maintenanceExpectedOriginal=ownedWriteInput({profile:original,journal:originalJournal});},undefined,Math.max(1,Math.min(2000,stepEnd-Date.now())));live();const result=await work();live();return result;}finally{clearTimeout(stepTimer);stepping=false;stepEnd=0;}
    },{signal,timeoutMs:Math.max(1,Math.min(snapshot.blockedTimeoutMs,deadline-Date.now()))});};
    state.maintenanceStep=step;state.maintenanceControlTx=(mode,work,witness)=>step(()=>originalControlTx(mode,work,witness,Math.max(1,Math.min(2000,stepEnd-Date.now()))));
    try{await step(async()=>{});state.cleanupInventory=job.phase==='complete'?null:await loadCleanupInventory(job,()=>step(async()=>{}),state.maintenanceControlTx);return await cleanupHeldCheckpoint({profileId},heldState,{state,deadline});}finally{cleanupMaintenanceCaps.delete(state.maintenanceCap);}
  };
  const cleanupOrphanInventories=async(heldState)=>{
    const deadline=Date.now()+60000,live=()=>{assertOpen();if(!heldState.live)throw profileError('CLOSED','orphan maintenance released');if(Date.now()>=deadline)throw profileError('CLOUD_CLEANUP_DEADLINE','orphan maintenance deadline');};
    const results=[];let after=null;
    const controlTx=(mode,work,witness)=>withProfileWriteLock(profileWriteLockKey(),'shared',()=>{live();return originalControlTx(mode,work,witness,Math.max(1,Math.min(2000,deadline-Date.now())));},{signal,timeoutMs:Math.max(1,Math.min(snapshot.blockedTimeoutMs,deadline-Date.now()))});
    const authority=async(tx,m)=>{
      live();validateCleanupPrepare(m);if(m.phase==='terminal-referenced')throw profileError('CLOUD_CLEANUP_BINDING','terminal-referenced preparation is not orphan');
      const meta=tx.objectStore('meta'),profiles=tx.objectStore('profiles'),b=m.job.binding,pointer=await meta.get('activeProfile'),source=await profiles.get(b.sourceProfile.profileId),sourceJournal=await meta.get(`fresh:${b.sourceProfile.profileId}`),target=await profiles.get(b.targetProfileId),targetJournal=await meta.get(`fresh:${b.targetProfileId}`),original=await profiles.get(b.originalProfileId),originalJournal=await meta.get(`fresh:${b.originalProfileId}`),stored=await meta.get(m.key),job=await meta.get(m.job.key);live();
      const sourcePair=validateProfileJournalPair(source,sourceJournal,{allowStaged:true}),targetPair=validateProfileJournalPair(target,targetJournal,{allowStaged:true}),originalPair=validateProfileJournalPair(original,originalJournal),currentProfile=pointer?await profiles.get(pointer.activeProfileId):null,currentJournal=pointer?await meta.get(`fresh:${pointer.activeProfileId}`):null;live();
      if(!sameStoredData(stored,m)||sourcePair.phase!=='created'||targetPair.phase!=='created'||!sameStoredData(source,b.sourceProfile)||!sameStoredData(sourceJournal,b.sourceJournal)||!sameStoredData(target,m.targetProfile)||!sameStoredData(targetJournal,m.targetJournal)||![sourcePair.owner,targetPair.owner,originalPair.owner].every(owner=>sameOwner(owner,snapshot.owner))||original.dbName!==b.originalDbName||!pointer||!sameOwner(validateProfileJournalPair(currentProfile,currentJournal).owner,snapshot.owner)||[source.profileId,target.profileId].includes(pointer.activeProfileId)||[source.profileId,target.profileId].includes(original.profileId)||source.dbName===target.dbName)throw profileError('CLOUD_CLEANUP_BINDING','orphan current owner/allocation changed');
      if(job!==undefined){const j=validateCleanupJob(job);if(j.phase!=='prepared'||j.bindingDigest!==m.job.bindingDigest||!sameStoredData(j.binding,b)||j.inventory!==null&&!sameStoredData(j.inventory,m.inventory))throw profileError('CLOUD_CLEANUP_BINDING','orphan job is committed or differs');}
      // True native references absence is rechecked INSIDE each destructive TX.
      let cursor=await meta.openCursor(IDBKeyRange.bound('fresh:','fresh:\uffff')),count=0,referenceBytes=0;
      while(cursor){live();const row=cursor.value;if(++count>100||(referenceBytes+=canonicalBytes(row).length)>1048576)throw profileError('CLOUD_CLEANUP_BUDGET','supported cold profile reference scan exceeded');const profile=await profiles.get(row.profileId);validateProfileJournalPair(profile,row,{allowStaged:true});if(row.phase==='completed'&&(row.cleanupCommitment?.jobId===m.jobId||row.cleanupCommitment?.prepareAnchor?.jobId===m.jobId))throw profileError('CLOUD_CLEANUP_BINDING','completed terminal references preparation');cursor=await cursor.continue();}
      return job;
    };
    const namespace=async(tx,m,expected)=>{const prefix=`cleanup-frame:${m.jobId}:`,meta=tx.objectStore('meta');let cursor=await meta.openCursor(IDBKeyRange.bound(prefix,prefix+'\uffff')),count=0,bytes=0;while(cursor){live();if(++count>32||(bytes+=canonicalBytes(cursor.value).length)>8*1024*1024||!expected.has(cursor.key)||!sameStoredData(cursor.value,expected.get(cursor.key)))throw profileError('CLOUD_CLEANUP_CHANGED','orphan namespace foreign/changed');cursor=await cursor.continue();}if(m.phase==='prepared'&&count!==m.progress)throw profileError('CLOUD_CLEANUP_CHANGED','prepared frames missing');};
    while(true){live();const page=await controlTx('readonly',async tx=>{const prefix='cleanup-prepare:',range=IDBKeyRange.bound(after??prefix,prefix+'\uffff',after!==null),rows=[];let cursor=await tx.objectStore('meta').openCursor(range),bytes=0;while(cursor&&rows.length<100){live();const size=canonicalBytes(cursor.value).length;if(size>1048576)throw profileError('CLOUD_CLEANUP_BUDGET','orphan marker row');if(bytes+size>1048576&&rows.length)break;bytes+=size;rows.push(cursor.value);cursor=await cursor.continue();}return rows;});if(!page.length)break;
      for(const raw of page){live();after=raw.key;let marker,physical;try{
        marker=validateCleanupPrepare(raw);await withCleanupJobLock(snapshot.dbName,marker.jobId,async()=>{if(await canonicalDigest(marker.job.binding)!==marker.job.bindingDigest||await canonicalDigest(marker.inventory.frames)!==marker.inventory.sha256)throw profileError('CLOUD_CLEANUP_CHANGED','orphan marker root');await controlTx('readonly',tx=>authority(tx,marker));
        const frames=new Map();await controlTx('readonly',async tx=>{await authority(tx,marker);const prefix=`cleanup-frame:${marker.jobId}:`;let cursor=await tx.objectStore('meta').openCursor(IDBKeyRange.bound(prefix,prefix+'\uffff'));while(cursor){live();const frame=validateCleanupFrame(cursor.value);if(frame.index>=marker.progress||frames.size>=32)throw profileError('CLOUD_CLEANUP_CHANGED','frame beyond committed progress');frames.set(cursor.key,frame);cursor=await cursor.continue();}});
        let encoded=0;for(const frame of frames.values()){live();const d=marker.inventory.frames[frame.index];if(!d||frame.jobId!==marker.jobId||frame.entries.length!==d.count||(encoded+=canonicalBytes(frame).length)>8*1024*1024||canonicalBytes(frame).length!==d.bytes||await canonicalDigest(frame)!==d.sha256)throw profileError('CLOUD_CLEANUP_CHANGED','orphan frame descriptor');}
        if(marker.phase==='prepared'){const next=validateCleanupPrepare({...marker,phase:'orphan-cleaning'});await controlTx('readwrite',async tx=>{await authority(tx,marker);await namespace(tx,marker,frames);live();await tx.objectStore('meta').put(next);});marker=next;}
        for(const[key,frame]of frames){await controlTx('readwrite',async tx=>{await authority(tx,marker);await namespace(tx,marker,frames);live();const meta=tx.objectStore('meta'),actual=await meta.get(key);if(!sameStoredData(actual,frame))throw profileError('CLOUD_CLEANUP_CHANGED','orphan frame deletion CAS');await meta.delete(key);});}
        const witness=Object.freeze({});physical={kind:'cleanup',committed:false};finalControlCompletions.set(witness,physical);
        await controlTx('readwrite',async tx=>{const job=await authority(tx,marker),meta=tx.objectStore('meta'),prefix=`cleanup-frame:${marker.jobId}:`;if(await meta.openKeyCursor(IDBKeyRange.bound(prefix,prefix+'\uffff')))throw profileError('CLOUD_CLEANUP_CHANGED','orphan final namespace not empty');live();if(job!==undefined)await meta.delete(marker.job.key);await meta.delete(marker.key);},witness);
        results.push({jobId:marker.jobId,status:'orphan_metadata_cleaned',metadataCleanupRequired:false});},{signal,deadline});
      }catch(error){results.push({jobId:marker?.jobId??null,status:physical?.committed?'orphan_metadata_cleaned':'orphan_metadata_refused',metadataCleanupRequired:!physical?.committed,error:errorCode(error)});if(error.code==='CLOSED'||error.code==='CLOUD_CLEANUP_DEADLINE')return {results,deadlineReached:error.code==='CLOUD_CLEANUP_DEADLINE'};}}
    }
    return {results,deadlineReached:false};
  };
  const withActivationLock=work=>{if(typeof work!=='function')return Promise.reject(profileError('INVALID','activation work must be callable'));return withProfileWriteLock(profileWriteLockKey(),'exclusive',async()=>{
    assertOpen();let held=true;const operations=new Set(),heldState={live:true,operations,closers:new Set(),projectionTargets:new Map(),diagnosticGetters:new Map()};
    const access=Object.freeze({readRecoveryDiagnostics:input=>{const captured=ownedWriteInput(exactInput(input,'held diagnostics'));if(Object.keys(captured).join()!=='profileId')throw profileError('INVALID','diagnostics only accepts profileId');const id=requireProfileId(captured.profileId);const result=(async()=>{assertOpen();if(!heldState.live)throw profileError('CLOSED','held diagnostics expired');const getter=heldState.diagnosticGetters.get(id);if(!getter)return {available:false};const actual=await getter();assertOpen();if(!heldState.live||heldState.diagnosticGetters.get(id)!==getter)throw profileError('CLOSED','held diagnostics source changed');return {available:true,counters:actual};})();operations.add(result);result.then(()=>operations.delete(result),()=>operations.delete(result));return result;},bindCheckpointSourceLease:input=>{if(!held)throw profileError('CLOSED','activation capability expired');const result=bindHeldCheckpointLease(input,heldState);operations.add(result);result.then(()=>operations.delete(result),()=>operations.delete(result));return result;},renewCheckpointSourceLease:(...args)=>{if(!held)throw profileError('CLOSED','activation capability expired');if(args.length)throw profileError('INVALID','held renew accepts no arguments');const result=renewHeldCheckpointLease(heldState);operations.add(result);result.then(()=>operations.delete(result),()=>operations.delete(result));return result;},cleanupCheckpointSource:input=>{if(!held)throw profileError('CLOSED','activation lock capability expired');const result=cleanupHeldCheckpoint(input,heldState);operations.add(result);result.then(()=>operations.delete(result),()=>operations.delete(result));return result;},commitFinalBundle:input=>{if(!held)throw profileError('CLOSED','activation lock capability expired');const result=commitHeldFinalBundle(input,heldState);operations.add(result);result.then(()=>operations.delete(result),()=>operations.delete(result));return result;},projectCheckpointFromStage:input=>{if(!held)throw profileError('CLOSED','activation lock capability expired');const result=projectHeldCheckpoint(input,heldState);operations.add(result);result.then(()=>operations.delete(result),()=>operations.delete(result));return result;},mergeLatestLocal:input=>{if(!held)throw profileError('CLOSED','activation lock capability expired');const result=mergeHeldLatestLocal(input,heldState);operations.add(result);result.then(()=>operations.delete(result),()=>operations.delete(result));return result;},createFinalReader:input=>{if(!held)throw profileError('CLOSED','activation lock capability expired');const captured=ownedWriteInput(input);if(Object.keys(captured).join()!=='profileId')throw profileError('INVALID','final reader accepts only profileId');const result=heldState.projectionTargets.has(captured.profileId)?Promise.resolve(heldState.projectionTargets.get(captured.profileId)):createHeldFinalReader(captured,heldState);operations.add(result);result.then(()=>operations.delete(result),()=>operations.delete(result));return result;},readActive:async()=>{if(!held)throw profileError('CLOSED','activation lock capability expired');assertOpen();const active=await checkedPointerBundle();if(!held)throw profileError('CLOSED','activation lock capability expired');if(!active.pair||!sameOwner(active.pair.owner,snapshot.owner))return null;return {profile:cloneData(active.pair.profile),pointer:cloneData(active.pointer)};},activate:input=>{if(!held)throw profileError('CLOSED','activation lock capability expired');assertOpen();const result=activateUnlocked(input);operations.add(result);result.then(()=>operations.delete(result),()=>operations.delete(result));return result;}});
    try{return await work(access);}finally{held=false;heldState.live=false;heldState.diagnosticGetters.clear();for(const close of heldState.closers)close();await Promise.allSettled([...operations]);}
  },{signal,timeoutMs:snapshot.blockedTimeoutMs});};
  const activate=input=>{const owned=cloneData(exactInput(input,'activate input'));return withActivationLock(access=>access.activate(owned));};

  const registry=Object.freeze({
    ownerSnapshot() { return cloneData(snapshot.owner); },
    profileWriteLockKey,
    withActivationLock,
    async resumeCheckpointSourceCleanup(input){const value=ownedWriteInput(exactInput(input,'resume source cleanup'));if(Object.keys(value).join()!=='profileId')throw profileError('INVALID','cleanup accepts only profileId');requireProfileId(value.profileId);const deadline=Date.now()+60000,initial=await readColdActive(deadline);assertOpen();if(initial.pointer?.activeProfileId!==value.profileId||!sameOwner(initial.pair?.owner,snapshot.owner))throw profileError('CLOUD_CLEANUP_BINDING','cold current owned profile required');if(!Object.prototype.hasOwnProperty.call(initial.pair.journal,'cleanupCommitment'))return resumeCleanupHeld(value,{live:true},deadline);const commitment=validateCleanupCommitment(initial.pair.journal.cleanupCommitment);return withCleanupJobLock(snapshot.dbName,commitment.jobId,async()=>{const heldState={live:true,operations:new Set(),closers:new Set(),projectionTargets:new Map()};try{return await resumeCleanupHeld(value,heldState,deadline);}finally{heldState.live=false;for(const close of heldState.closers)close();}},{signal,deadline});},
    async cleanupPreparedInventories(...args){if(args.length)throw profileError('INVALID','orphan maintenance accepts no inputs');const heldState={live:true};try{return await cleanupOrphanInventories(heldState);}finally{heldState.live=false;}},
    createFresh,
    createRestoreStage,
    finalizeRestore,
    async quarantineRestore(value) {
      const pair = await checkedPair(requireProfileId(value), { allowStaged: true, requireOwner: true });
      if (!pair || pair.journal.kind !== 'qb-v2-staged-restore') throw profileError('INVALID', 'not a restore stage');
      const active = await checkedPointerBundle();
      if (active.pointer?.activeProfileId === pair.profile.profileId) throw profileError('CONFLICT', 'an active profile cannot be quarantined by restore');
      if (pair.phase !== 'quarantined') await quarantine(pair, 'inspect', profileError('RESTORE_QUARANTINED', 'restore awaits trusted reconciliation'));
      return cloneData((await checkedPair(value, { allowStaged: true, requireOwner: true })).profile);
    },
    resumeFresh(value) { try { return resume(requireProfileId(value)); } catch (cause) { return Promise.reject(cause); } },
    readProfile,
    activate,
    async readActive() {
      const active = await checkedPointerBundle();
      if (!active.pair || !sameOwner(active.pair.owner, snapshot.owner)) return null;
      return { profile: cloneData(active.pair.profile), pointer: cloneData(active.pointer) };
    },
    async readControlRevision() {
      const active = await checkedPointerBundle();
      return active.pointer === null ? 0 : active.pointer.activationRevision;
    },
    close: invalidate
  });
  const bindSource=async value=>{
    if(Object.keys(value).sort().join()!=='context,originalPointer,owner,sourceProfileId,stageProfileId'||snapshot.namespace!=='production'||snapshot.owner.ownerKind!=='account'||!sameOwner(snapshot.owner,snapshotOwner(value.owner)))throw profileError('CLOUD_SOURCE_REGISTRY_INVALID','source binding fields/owner invalid');
    const stageId=requireProfileId(value.stageProfileId),sourceId=requireProfileId(value.sourceProfileId),context=value.context;
    if(!sourceStageAllocations.has(stageId))throw profileError('CLOUD_SOURCE_REGISTRY_INVALID','source was not privately allocated by this live registry');
    if(!context||Object.keys(context).sort().join()!=='activationRevision,appliedPullCursor,fence,logEpoch,owner,ownerTabId,profileId'||Object.keys(context.owner||{}).sort().join()!=='accountGeneration,accountId'||context.profileId!==sourceId||context.activationRevision!==value.originalPointer?.activationRevision||context.owner?.accountId!==snapshot.owner.accountId||context.owner?.accountGeneration!==snapshot.owner.accountGeneration||!UUID_V4.test(context.ownerTabId)||!Number.isSafeInteger(context.fence)||context.fence<1||context.logEpoch!==null&&!UUID_V4.test(context.logEpoch)||context.appliedPullCursor!==null&&typeof context.appliedPullCursor!=='string')throw profileError('CLOUD_SOURCE_REGISTRY_INVALID','source context invalid');
    let originalNative,directory,disposed=false;const live=()=>{assertOpen();if(disposed)throw profileError('CLOSED','source registry binding closed');};
    const binding={close(){if(disposed)return;disposed=true;sourceStageBindings.delete(binding);sourceStageAllocations.delete(stageId);originalNative?.close();directory?.close();}};
    try{
      live();const pair=await checkedPair(stageId,{allowStaged:true,requireOwner:true}),original=await checkedPointerBundle();live();
      if(!pair||pair.phase!=='created'||pair.profile.state!=='staged'||pair.journal.kind!=='qb-v2-staged-restore'||!original.pair||!sameOwner(original.pair.owner,snapshot.owner)||original.pair.profile.profileId!==sourceId||stageId===sourceId||!sameStoredData(original.pointer,value.originalPointer))throw profileError('CLOUD_SOURCE_REGISTRY_INVALID','actual source/active pair invalid');
      const inventory=await indexedDB.databases();live();if(!inventory.some(row=>row.name==='qb-v2-profile-directory'&&row.version===1))throw profileError('OWNER_LOCKED','production owner directory missing');
      directory=await new Promise((resolve,reject)=>{let ended=false;const timer=setTimeout(()=>{ended=true;reject(profileError('STORAGE_OPEN_TIMEOUT','source owner directory open timed out'));},snapshot.blockedTimeoutMs);openDB('qb-v2-profile-directory',1,{upgrade(_db,_old,_next,tx){tx.abort();}}).then(db=>{if(ended){db.close();return;}ended=true;clearTimeout(timer);resolve(db);},cause=>{if(ended)return;ended=true;clearTimeout(timer);reject(cause);});});live();if(directory.version!==1||!directory.objectStoreNames.contains('owners'))throw profileError('OWNER_LOCKED','production owner directory invalid');
      originalNative=await openCloudNativeDatabase({profile:original.pair.profile,blockedTimeoutMs:snapshot.blockedTimeoutMs,signal,guard:live});live();
      const ownerKey=JSON.stringify(['account',snapshot.owner.accountId,snapshot.owner.accountGeneration]);
      const recheckPairs=async()=>{live();const {currentPair:nowPair,current:nowActive}=await checkedRegistryPairCut(stageId);live();if(!nowPair||!sameStoredData(nowPair.rawProfile,pair.rawProfile)||!sameStoredData(nowPair.rawJournal,pair.rawJournal)||!sameStoredData(nowActive.pointer,original.pointer)||!sameStoredData(nowActive.profile,original.profile)||!sameStoredData(nowActive.journal,original.journal))throw profileError('CLOUD_SOURCE_REGISTRY_CHANGED','actual source control/pointer changed');};
      const check=async()=>{await recheckPairs();const row=await directoryOwnerRow(directory,ownerKey);live();if(!row||row.key!==ownerKey||row.state!=='ready'||!sameOwner(row.owner,snapshot.owner)||controlDbName(row.controlId,'production')!==snapshot.dbName)throw profileError('OWNER_LOCKED','actual owner directory no longer grants this control');
        const nativeContext=await originalNative.readSourceContext();live();const lease=nativeContext.lease;if(!lease||lease.ownerTabId!==context.ownerTabId||lease.fence!==context.fence||lease.expiresAt<=Date.now())throw profileError('SYNC_FENCE_LOST','actual native coordinator lease changed/expired');if(nativeContext.logEpoch!==context.logEpoch||nativeContext.appliedPullCursor!==context.appliedPullCursor)throw profileError('SYNC_CONTEXT_CHANGED','actual native epoch/cursor changed');await recheckPairs();};
      directory.onversionchange=binding.close;sourceStageBindings.add(binding);await check();return Object.freeze({check,assertLive:live,close:binding.close});
    }catch(cause){binding.close();throw cause;}
  };
  const directoryOwnerRow=async(directory,key)=>{
    assertOpen();const tx=directory.transaction('owners','readonly');inFlight.add(tx);let timedOut=false;
    const timer=setTimeout(()=>{timedOut=true;try{tx.abort();}catch{}},snapshot.blockedTimeoutMs);tx.done.catch(()=>{});
    try{const row=await tx.objectStore('owners').get(key);await tx.done;assertOpen();return row;}
    catch(cause){try{tx.abort();}catch{}await Promise.allSettled([tx.done]);if(timedOut)throw profileError('STORAGE_OPEN_TIMEOUT','source directory row deadline',cause);throw cause;}
    finally{clearTimeout(timer);inFlight.delete(tx);}
  };
  const assertSourceOwnerDirectory=async()=>{
    assertOpen();if(snapshot.namespace!=='production'||snapshot.owner.ownerKind!=='account')throw profileError('CLOUD_SOURCE_REGISTRY_INVALID','source allocation requires production account directory');
    const inventory=await indexedDB.databases();assertOpen();if(!inventory.some(row=>row.name==='qb-v2-profile-directory'&&row.version===1))throw profileError('OWNER_LOCKED','source directory missing');
    let directory,ended=false,timer;const opening=openDB('qb-v2-profile-directory',1,{upgrade(_db,_old,_next,tx){tx.abort();}}),close=()=>{ended=true;directory?.close();};
    signal.addEventListener('abort',close,{once:true});opening.then(db=>{if(ended)db.close();},()=>{});
    try{directory=await Promise.race([opening,new Promise((_,reject)=>{timer=setTimeout(()=>{close();reject(profileError('STORAGE_OPEN_TIMEOUT','source directory deadline'));},snapshot.blockedTimeoutMs);})]);assertOpen();if(ended)throw profileError('CLOSED','source directory closed');if(directory.version!==1||!directory.objectStoreNames.contains('owners'))throw profileError('OWNER_LOCKED','source directory schema differs');
      const key=JSON.stringify(['account',snapshot.owner.accountId,snapshot.owner.accountGeneration]),row=await directoryOwnerRow(directory,key);assertOpen();if(!row||row.key!==key||row.state!=='ready'||!sameOwner(row.owner,snapshot.owner)||controlDbName(row.controlId,'production')!==snapshot.dbName)throw profileError('OWNER_LOCKED','source directory no longer grants owner');
    }finally{clearTimeout(timer);signal.removeEventListener('abort',close);close();}
  };
  const allocateSource=()=>withProfileWriteLock(profileWriteLockKey(),'exclusive',async()=>{
    await assertSourceOwnerDirectory();const original=await checkedPointerBundle();if(!original.pair||snapshot.owner.ownerKind!=='account')throw profileError('NOT_READY','source allocation needs active account');
    const native=await openCloudNativeDatabase({profile:original.pair.profile,blockedTimeoutMs:snapshot.blockedTimeoutMs,signal,guard:assertOpen});
    try{const context=await native.readSourceContext();assertOpen();const lease=context.lease;if(!lease||lease.expiresAt<=Date.now())throw profileError('SYNC_FENCE_LOST','source allocation needs actual live native lease');
      const allocation={format:'qb-cloud-source-allocation-v1',owner:cloneData(snapshot.owner),originalPointer:cloneData(original.pointer),sourceProfileId:original.pair.profile.profileId,leaseOwnerTabId:lease.ownerTabId,leaseFence:lease.fence,purpose:'checkpoint-preverification',status:'allocated'};
      const profile=await allocateRestoreStage(allocation);try{await assertSourceOwnerDirectory();const after=await checkedPointerBundle(),actual=await native.readSourceContext();assertOpen();if(!sameStoredData(after.pointer,original.pointer)||!sameStoredData(after.profile,original.profile)||!sameStoredData(after.journal,original.journal)||actual.lease?.ownerTabId!==lease.ownerTabId||actual.lease?.fence!==lease.fence||actual.lease?.expiresAt<=Date.now())throw profileError('SYNC_FENCE_LOST','allocation original active cut/lease changed');sourceStageAllocations.add(profile.profileId);return profile;}catch(cause){if(cause&&typeof cause==='object')sourceAllocationFailures.set(cause,{binding:sourceRegistryState,locator:{profileId:profile.profileId,owner:cloneData(snapshot.owner),status:'staged-retained',cleanupRequired:true}});throw cause;}
    }finally{native.close();}
  });
  const readAllocation=async profileId=>controlTx('readonly',async tx=>{
    const meta=tx.objectStore('meta'),profiles=tx.objectStore('profiles'),markerRaw=await meta.get(`source-allocation:${profileId}`);
    if(markerRaw===undefined)return null;
    const marker=validateSourceAllocationMarker(markerRaw);if(!sameOwner(marker.owner,snapshot.owner))throw profileError('OWNER_MISMATCH','allocation owner differs');
    const sourceProfile=await profiles.get(profileId),sourceJournal=await meta.get(`fresh:${profileId}`),pointer=await meta.get('activeProfile');
    if(!pointer)throw profileError('CONFLICT','allocation has no actual active pointer');
    const targetProfile=await profiles.get(pointer.activeProfileId),targetJournal=await meta.get(`fresh:${pointer.activeProfileId}`),target=validateProfileJournalPair(targetProfile,targetJournal);
    const pair=sourceProfile===undefined?null:validateProfileJournalPair(sourceProfile,sourceJournal,{allowStaged:true});
    if(!sameOwner(target.owner,snapshot.owner)||pointer.activeProfileId===profileId||!pair||!sameOwner(pair.owner,snapshot.owner)||pair.profile.dbName!==marker.dbName||pair.journal.jobId!==marker.jobId||pair.journal.kind!=='qb-v2-staged-restore'||pair.phase==='completed')throw profileError('CONFLICT','allocation inactive source/actual target invalid');
    const commitRaw=await meta.get(`source-allocation-commit:${profileId}`),commit=commitRaw===undefined?null:validateSourceAllocationCommit(commitRaw);
    if(commit&&!sameStoredData({...commit.marker,status:marker.status},marker))throw profileError('CONFLICT','allocation provenance marker differs');
    let job,prepare;
    if(Object.prototype.hasOwnProperty.call(targetJournal,'cleanupCommitment')){
      const commitment=validateCleanupCommitment(targetJournal.cleanupCommitment),candidate=validateCleanupJob(await meta.get(`cleanup:${commitment.jobId}`));
      if(candidate.binding.sourceProfile.profileId===profileId){
        if(!commit)throw profileError('CLOUD_CLEANUP_BINDING','tracked allocation lacks terminal provenance');
        prepare=commitment.prepareAnchor===undefined?undefined:await meta.get(`cleanup-prepare:${commitment.jobId}`);
        job=validateTrackedAllocationLineage({commit,targetProfile,targetJournal,pointer,job:candidate,prepare});
      }
    }
    if(commit&&!job)throw profileError('CLOUD_CLEANUP_BINDING','committed allocation requires original durable job');
    return {marker,pair,sourceProfile,sourceJournal,pointer,targetProfile,targetJournal,target,commitRaw,commit,job,prepare};
  },undefined,2000);
  const reconcileTrackedAllocation=async initial=>{
    const deadline=Date.now()+60000;
    // The current durable API runs first. A marker cannot replace this authority.
    await registry.resumeCheckpointSourceCleanup({profileId:initial.targetProfile.profileId});
    let captured=await readAllocation(initial.marker.profileId);
    if(!captured?.job||captured.job.phase!=='complete'||captured.job.framesCleaned!==true)return {status:'cleanup-incomplete',cleanupRequired:true,physicalDeleted:false,error:'CLOUD_CLEANUP_INCOMPLETE'};
    return withCleanupJobLock(snapshot.dbName,captured.job.jobId,async()=>{
      const live=()=>{assertOpen();if(Date.now()>=deadline)throw profileError('CLOUD_CLEANUP_DEADLINE','tracked allocation maintenance expired');};
      const check=async()=>{live();const now=await readAllocation(captured.marker.profileId);live();
        if(!now?.job||now.job.phase!=='complete'||now.job.framesCleaned!==true||!sameStoredData(now.marker,captured.marker)||!sameStoredData(now.commitRaw,captured.commitRaw)||!sameStoredData(now.pointer,captured.pointer)||!sameStoredData(now.targetProfile,captured.targetProfile)||!sameStoredData(now.targetJournal,captured.targetJournal)||!sameStoredData(now.job,captured.job)||!sameStoredData(now.sourceProfile,now.job.completedSource.profile)||!sameStoredData(now.sourceJournal,now.job.completedSource.journal))throw profileError('CONFLICT','tracked completed cleanup/current cut changed');
        return now;};
      const step=work=>withProfileWriteLock(profileWriteLockKey(),'shared',async()=>{live();await check();const result=await work();live();await check();return result;},{signal,timeoutMs:Math.max(1,Math.min(2000,deadline-Date.now()))});
      let source;
      try{
        const inventory=await indexedDB.databases();live();const found=inventory.find(row=>row.name===captured.marker.dbName);
        if(found){if(found.version!==1&&found.version!==BUSINESS_SCHEMA_VERSION)throw profileError('SCHEMA_MISMATCH','tracked source schema changed');
          source=await openCloudNativeDatabase({profile:captured.sourceProfile,blockedTimeoutMs:snapshot.blockedTimeoutMs,signal,guard:live});
          for(const store of Object.keys(APP_DATA_STORES)){if(await step(()=>source.hasStoreRows({store})))throw profileError('CLOUD_CLEANUP_CHANGED','completed tracked source is not independently empty');}
          source.close();source=null;
          // deleteDatabase cannot be cancelled after onblocked. An uncooperative
          // native handle can append unknown facts before close; no Web Lock
          // proves their absence at the eventual physical deletion.
          return {status:'cleanup-incomplete',cleanupRequired:true,physicalDeleted:false,error:'CLOUD_SOURCE_PHYSICAL_DELETE_UNAVAILABLE',logicalContentEmpty:true,physicalContainerRetained:true,sourceProfileId:captured.marker.profileId};
        }
        const after=await indexedDB.databases();live();if(after.some(row=>row.name===captured.marker.dbName))throw profileError('CLOUD_CLEANUP_INCOMPLETE','tracked source still present');
        await withProfileWriteLock(profileWriteLockKey(),'shared',async()=>{
          await check();await controlTx('readwrite',async tx=>{
            const meta=tx.objectStore('meta'),profiles=tx.objectStore('profiles');
            for(const [key,expected]of [[captured.marker.key,captured.marker],[captured.commit.key,captured.commitRaw],['activeProfile',captured.pointer],[captured.job.key,captured.job],[captured.sourceJournal.key,captured.sourceJournal],[captured.targetJournal.key,captured.targetJournal]])if(!sameStoredData(await meta.get(key),expected))throw profileError('CONFLICT','tracked allocation forget native control CAS changed');
            if(!sameStoredData(await profiles.get(captured.sourceProfile.profileId),captured.sourceProfile)||!sameStoredData(await profiles.get(captured.targetProfile.profileId),captured.targetProfile))throw profileError('CONFLICT','tracked allocation profile CAS changed');
            // Retain completedSource control lineage required by the existing
            // durable job's idempotent maintenance. Forget allocation metadata only.
            await meta.delete(captured.marker.key);await meta.delete(captured.commit.key);
          },undefined,Math.max(1,Math.min(2000,deadline-Date.now())));
        },{signal,timeoutMs:Math.max(1,Math.min(2000,deadline-Date.now()))});
        return {status:'source-allocation-cleaned',cleanupRequired:false,physicalDeleted:true};
      }catch(cause){return {status:'cleanup-incomplete',cleanupRequired:true,error:errorCode(cause)};}finally{source?.close();}
    },{signal,deadline});
  };
  const reconcileSource=async input=>{
    if(Object.keys(input).join()!=='profileId')throw profileError('INVALID','reconcile accepts one selector');
    const profileId=requireProfileId(input.profileId),initial=await readAllocation(profileId);
    if(!initial)return {status:'unclassified',cleanupRequired:true};
    if(initial.job)return reconcileTrackedAllocation(initial);
    if(initial.commit||initial.marker.status==='committed')throw profileError('CLOUD_CLEANUP_BINDING','terminal allocation cannot bypass durable job');
    const deadline=Date.now()+60000;
    return withCleanupJobLock(snapshot.dbName,initial.marker.jobId,async()=>{
      const captured=await readAllocation(profileId);if(!captured||captured.job||captured.commit||!sameStoredData(captured.marker,initial.marker)||!sameStoredData(captured.pointer,captured.marker.originalPointer))throw profileError('CONFLICT','nonterminal allocation cut changed');
      const native=await openCloudNativeDatabase({profile:captured.targetProfile,blockedTimeoutMs:snapshot.blockedTimeoutMs,signal,guard:assertOpen});
      try{
        let retained=false;
        await withProfileWriteLock(profileWriteLockKey(),'shared',async()=>{
          const actual=await readAllocation(profileId);if(!actual||!sameStoredData(actual.marker,captured.marker)||!sameStoredData(actual.sourceProfile,captured.sourceProfile)||!sameStoredData(actual.sourceJournal,captured.sourceJournal)||!sameStoredData(actual.targetProfile,captured.targetProfile)||!sameStoredData(actual.targetJournal,captured.targetJournal)||!sameStoredData(actual.pointer,captured.pointer))throw profileError('CONFLICT','nonterminal quarantine cut changed');
          const context=await native.readSourceContext();assertOpen();if(context.lease?.expiresAt>Date.now()){retained=true;return;}
          await controlTx('readwrite',async tx=>{
            const meta=tx.objectStore('meta'),profiles=tx.objectStore('profiles');
            if(!sameStoredData(await meta.get(captured.marker.key),captured.marker)||!sameStoredData(await meta.get('activeProfile'),captured.pointer)||!sameStoredData(await profiles.get(profileId),captured.sourceProfile)||!sameStoredData(await meta.get(captured.sourceJournal.key),captured.sourceJournal)||await meta.get(`source-allocation-commit:${profileId}`)!==undefined)throw profileError('CONFLICT','nonterminal quarantine actual CAS changed');
            if(captured.pair.phase!=='quarantined'){const next=quarantinedPair(captured.pair.profile,captured.pair.journal,'inspect',profileError('CLOUD_SOURCE_ORPHAN','cold allocation quarantined'));await profiles.put(next.profile);await meta.put(next.journal);}
            await meta.put({...captured.marker,status:'quarantined'});
          },undefined,Math.max(1,Math.min(2000,deadline-Date.now())));
        },{signal,timeoutMs:Math.max(1,Math.min(2000,deadline-Date.now()))});
        if(retained)return {status:'live-lease-retained',cleanupRequired:true};
        const q=await checkedPair(profileId,{allowStaged:true,requireOwner:true});
        const original={pointer:captured.pointer,profile:captured.targetProfile,journal:captured.targetJournal,pair:captured.target};
        return await cleanupColdSource({...captured.marker,status:'quarantined'},q,original,native,undefined,deadline);
      }finally{native.close();}
    },{signal,deadline});
  };
  const cleanupColdSource=async(marker,pair,original,originalNative,commitRecord,deadline)=>{
    let raw,source,rows,physicalDeleted=false;
    const cancelled=new AbortController(),cancel=()=>cancelled.abort();signal.addEventListener('abort',cancel,{once:true});const expiry=setTimeout(cancel,Math.max(0,deadline-Date.now()));const live=()=>{assertOpen();if(cancelled.signal.aborted||Date.now()>=deadline)throw profileError('CLOUD_CLEANUP_DEADLINE','source allocation maintenance expired');};
    const step=work=>withProfileWriteLock(profileWriteLockKey(),'shared',async()=>{live();await checkUnlocked();live();const result=await work();live();await checkUnlocked();live();return result;},{signal:cancelled.signal,timeoutMs:Math.max(1,Math.min(2000,deadline-Date.now()))});
    const checkUnlocked=async()=>{
      live();const actual=await readAllocation(marker.profileId);live();
      if(!actual||actual.pair.phase!=='quarantined'||!sameStoredData(actual.sourceProfile,pair.rawProfile)||!sameStoredData(actual.sourceJournal,pair.rawJournal)||!sameStoredData(actual.marker,marker)||!sameOptionalSourceAllocationCommit(actual.commitRaw,commitRecord)||!sameStoredData(actual.pointer,original.pointer)||!sameStoredData(actual.targetProfile,original.profile)||!sameStoredData(actual.targetJournal,original.journal))throw profileError('CONFLICT','cold source cleanup binding changed');
      let timer;try{const context=await Promise.race([originalNative.readSourceContext(),new Promise((_,reject)=>{timer=setTimeout(()=>{originalNative.close();reject(profileError('CLOUD_CLEANUP_DEADLINE','source meta short step deadline'));},Math.max(1,Math.min(2000,deadline-Date.now())));})]);live();if(context.lease?.expiresAt>Date.now())throw profileError('SYNC_FENCE_LOST','new live lease protects cold source');}finally{clearTimeout(timer);}
    };
    const check=()=>step(async()=>{});
    const forget=()=>withProfileWriteLock(profileWriteLockKey(),'shared',async()=>{await checkUnlocked();await controlTx('readwrite',async tx=>{const profiles=tx.objectStore('profiles'),meta=tx.objectStore('meta');if(!sameStoredData(await profiles.get(marker.profileId),pair.rawProfile)||!sameStoredData(await meta.get(`fresh:${marker.profileId}`),pair.rawJournal)||!sameStoredData(await meta.get(marker.key),marker)||!sameStoredData(await meta.get('activeProfile'),original.pointer)||!sameOptionalSourceAllocationCommit(await meta.get(`source-allocation-commit:${marker.profileId}`),commitRecord))throw profileError('CONFLICT','cold deletion control changed');await profiles.delete(marker.profileId);await meta.delete(`fresh:${marker.profileId}`);await meta.delete(marker.key);if(commitRecord !== undefined)await meta.delete(`source-allocation-commit:${marker.profileId}`);},undefined,Math.max(1,Math.min(2000,deadline-Date.now())));const active=await checkedPointerBundle();if(!sameStoredData(active.pointer,original.pointer)||!sameStoredData(active.profile,original.profile)||!sameStoredData(active.journal,original.journal))throw profileError('CONFLICT','source forgotten before current pointer changed');},{signal:cancelled.signal,timeoutMs:Math.max(1,Math.min(2000,deadline-Date.now()))});
    try{
      await check();if(typeof indexedDB.databases!=='function')throw profileError('DATABASE_INVENTORY_UNAVAILABLE','cold cleanup needs actual database inventory');const inventory=await indexedDB.databases();await check();const found=inventory.find(row=>row.name===marker.dbName);
      if(!found){physicalDeleted=true;await forget();return {status:'source-allocation-cleaned',cleanupRequired:false,physicalDeleted:true};}
      if(found.version!==1&&found.version!==BUSINESS_SCHEMA_VERSION)throw profileError('SCHEMA_MISMATCH','cold source version differs');
      {let opened=false,timer;const opening=openDB(marker.dbName,BUSINESS_SCHEMA_VERSION,{upgrade(db,oldVersion,newVersion,tx){tx.done.catch(()=>{});try{live();upgradeBusinessSchema(db,oldVersion,newVersion,tx);}catch(error){tx.abort();}}});opening.then(db=>{if(!opened&&cancelled.signal.aborted)db.close();},()=>{});try{raw=await Promise.race([opening,new Promise((_,reject)=>{timer=setTimeout(()=>{cancelled.abort();reject(profileError('CLOUD_CLEANUP_DEADLINE','cold native open deadline'));},Math.max(1,Math.min(snapshot.blockedTimeoutMs,deadline-Date.now())));})]);opened=true;}finally{clearTimeout(timer);}}await check();
      source=await openCloudNativeDatabase({profile:pair.profile,blockedTimeoutMs:snapshot.blockedTimeoutMs,signal:cancelled.signal,guard:live});rows=await createBoundedNativeAccess(unwrap(raw),{signal:cancelled.signal,guard:live,timeoutMs:Math.min(2000,snapshot.blockedTimeoutMs)});
      const get=(store,key)=>step(()=>source.get(store,key));
      const exactColdWrite=async input=>step(async()=>{const value=ownedWriteInput(input);let binaryBytes=0;const frame=row=>{if(row?.bytes instanceof Uint8Array){binaryBytes+=row.bytes.length;const {bytes,...fields}=row;return {...fields,byteLength:bytes.length};}return row;};if(canonicalContentBytes({conditions:value.conditions.map(row=>({...row,expected:frame(row.expected)})),puts:value.puts??[],deletes:value.deletes}).length+binaryBytes>1024*1024)throw profileError('PROOF_ROW_BUDGET','cold exact CAS frame too large');const tx=raw.transaction(['import_receipts','content_chunks','migration_journal'],'readwrite');inFlight.add(tx);const timer=setTimeout(()=>{try{tx.abort();}catch{}},Math.max(1,Math.min(2000,deadline-Date.now())));try{for(const condition of value.conditions){const actual=await tx.objectStore(condition.store).get(condition.key);assertOpen();if(actual!==undefined){validateStoreRecord(condition.store,actual);const actualKey=condition.store==='content_chunks'?[actual.contentDigest,actual.chunkIndex]:condition.store==='import_receipts'?[actual.sourceId,actual.sourceRecordId]:actual.migrationId;if(indexedDB.cmp(actualKey,condition.key)!==0)throw profileError('CORRUPT','cold CAS actual PK invalid');}if(actual?.bytes instanceof Uint8Array||condition.expected?.bytes instanceof Uint8Array){const expected=condition.expected;if(!actual||!expected||!(actual.bytes instanceof Uint8Array)||!(expected.bytes instanceof Uint8Array))throw profileError('CONFLICT','cold CAS binary missing');const {bytes:a,...af}=actual,{bytes:b,...bf}=expected;if(!sameStoredData(af,bf)||!equalBytes(a,b))throw profileError('CONFLICT','cold CAS binary fields changed');}else if(!sameStoredData(actual,condition.expected))throw profileError('CONFLICT','cold CAS actual row changed');}for(const put of value.puts??[]){validateStoreRecord(put.store,put.value);await tx.objectStore(put.store).put(put.value);}for(const remove of value.deletes)await tx.objectStore(remove.store).delete(remove.key);await tx.done;}catch(cause){try{tx.abort();}catch{}await Promise.allSettled([tx.done]);throw cause;}finally{clearTimeout(timer);inFlight.delete(tx);}});
      const scan=async(store,work)=>{let after=null;do{await check();const page=await step(()=>rows.readPage({store,after,limit:100}));await check();for(const row of page.rows)await work(row);after=page.after;}while(after!==null);};
      for(const store of Object.keys(APP_DATA_STORES))if(!['content_chunks','import_receipts','migration_journal'].includes(store))await scan(store,()=>{throw profileError('CLOUD_CLEANUP_FOREIGN_BUSINESS','cold source contains learning records');});
      const cutKey=(store,row)=>`${store}:${JSON.stringify(store==='content_chunks'?[row.contentDigest,row.chunkIndex]:store==='import_receipts'?[row.sourceId,row.sourceRecordId]:row.migrationId)}`,cutHash=async(store,row)=>store==='content_chunks'?canonicalDigest({contentDigest:row.contentDigest,chunkIndex:row.chunkIndex,byteLength:row.bytes.length,sha256:await sha256Hex(row.bytes)}):canonicalDigest(row),expectedCut=new Map();let cutBytes=0;
      for(const store of Object.keys(APP_DATA_STORES))await scan(store,async row=>{if(!['content_chunks','import_receipts','migration_journal'].includes(store))throw profileError('CLOUD_CLEANUP_FOREIGN_BUSINESS','cold learning row appeared before classification');const key=cutKey(store,row),sha=await cutHash(store,row);cutBytes+=canonicalBytes({key,sha}).length;if(expectedCut.size>=200000||cutBytes>8*1024*1024)throw profileError('CLOUD_CLEANUP_BUDGET','cold independent cut metadata bound');expectedCut.set(key,sha);});
      let journal=null;await scan('migration_journal',row=>{if(journal)throw profileError('CLOUD_CLEANUP_FOREIGN_JOURNAL','multiple cold source journals');journal=validateCloudStageJournal(row);const p=journal.checkpoint;if(p.profileId!==marker.profileId||p.sourceProfileId!==marker.sourceProfileId||p.activationRevision!==marker.originalPointer.activationRevision||!sameOwner(p.owner,marker.owner))throw profileError('CLOUD_CLEANUP_BINDING','cold journal full owner/pointer differs');});
      const allowed=new Map(),parts=[],reservations=new Map(),refs=new Map();let metadataBytes=0;
      const permit=(digest,index,sha,length)=>{const key=`${digest}:${index}`,prior=allowed.get(key);if(prior&&(prior.sha!==sha||prior.length!==length))throw profileError('CLOUD_CLEANUP_COLLISION','cold owned chunk key collision');if(!prior){metadataBytes+=canonicalBytes({key,sha,length}).length;if(metadataBytes>8*1024*1024||allowed.size>=200000)throw profileError('CLOUD_CLEANUP_BUDGET','cold source membership metadata bound');allowed.set(key,{sha,length});}};
      if(journal)for(const [section,count]of Object.entries(journal.counts))for(let index=0;index<count.pages;index++){
        const receipt=validateCloudPageReceipt(await get('import_receipts',[`qb-cloud-stage:${journal.migrationId}`,`${section}:${index}`]));await check();const p=receipt.provenance;if(p.stageId!==journal.migrationId||p.section!==section||p.index!==index||p.storageDigest!==await cloudTemporaryDigest(journal.migrationId,'page',`${section}:${index}`))throw profileError('CLOUD_CLEANUP_PAGE','cold page identity differs');const chunk=await get('content_chunks',[p.storageDigest,0]),bytes=chunk?.bytes??new Uint8Array();if(bytes.length!==p.utf8Bytes||await sha256Hex(bytes)!==p.sha256)throw profileError('CLOUD_CLEANUP_PAGE','cold page bytes differ');if(bytes.length)permit(p.storageDigest,0,p.sha256,bytes.length);
        if(section==='content-references.ndjson')for(const line of new TextDecoder('utf-8',{fatal:true}).decode(bytes).split('\n').filter(Boolean)){const row=validateCloudContentReference(JSON.parse(line)),ref=row.reference,prior=refs.get(ref.contentDigest);if(prior&&!sameStoredData(prior,ref))throw profileError('CLOUD_CLEANUP_COLLISION','cold reference differs');if(!prior){metadataBytes+=canonicalBytes(ref).length;if(metadataBytes>8*1024*1024||refs.size>=200000)throw profileError('CLOUD_CLEANUP_BUDGET','cold reference metadata bound');refs.set(ref.contentDigest,ref);}}
      }
      for(const ref of refs.values()){
        const manifestRow=await get('content_chunks',[ref.manifestDigest,0]);await check();let manifest;
        if(manifestRow){if(await sha256Hex(manifestRow.bytes)!==ref.manifestDigest)throw profileError('CLOUD_CLEANUP_CONTENT','cold normalized manifest SHA differs');manifest=validateChunkManifest(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(manifestRow.bytes)));if(!equalBytes(manifestRow.bytes,canonicalBytes(manifest))||manifest.contentDigest!==ref.contentDigest||manifest.totalBytes!==ref.totalBytes||manifest.chunkCount!==ref.chunkCount)throw profileError('CLOUD_CLEANUP_CONTENT','cold manifest binding differs');permit(ref.manifestDigest,0,ref.manifestDigest,manifestRow.bytes.length);}
        for(let i=0;i<ref.chunkCount;i++){const descriptor=manifest?.chunks[i],temporary=await cloudTemporaryDigest(journal.migrationId,'chunk',`${ref.contentDigest}:${i}`),row=await get('content_chunks',[temporary,0]);await check();if(row){const length=Math.min(512*1024,ref.totalBytes-i*512*1024);if(row.bytes.length!==length||descriptor&&await sha256Hex(row.bytes)!==descriptor.sha256)throw profileError('CLOUD_CLEANUP_CONTENT','cold transport part differs');permit(temporary,0,await sha256Hex(row.bytes),length);}if(descriptor)permit(ref.contentDigest,i,descriptor.sha256,descriptor.byteLength);}
      }
      await scan('import_receipts',async row=>{
        const p=row.provenance;
        if(journal&&row.sourceId===`qb-cloud-stage:${journal.migrationId}`){const page=validateCloudPageReceipt(row);if(page.provenance.stageId!==journal.migrationId||page.provenance.index>=journal.counts[page.provenance.section].pages)throw profileError('CLOUD_CLEANUP_PAGE','cold extra page');return;}
        if(journal&&p?.format==='qb-cloud-stage-index-v1'){const index=validateCloudStageIndexShape(row);if(index.provenance.stageId!==journal.migrationId)throw profileError('CLOUD_CLEANUP_FOREIGN_INDEX','cold source index differs');const page=await get('import_receipts',[`qb-cloud-stage:${journal.migrationId}`,`${p.section}:${p.pageIndex}`]),chunk=await get('content_chunks',[p.storageDigest,0]);await verifyCloudStageIndex({index,journal,pageReceipt:page,pageBytes:chunk?.bytes??new Uint8Array(),expected:{}});return;}
        if(!/^qb-cloud-stage-index:[0-9a-f-]{36}$/.test(row.sourceId)||!UUID_V4.test(p?.workspaceId)||row.sourceId!==`qb-cloud-stage-index:${p.workspaceId}`)throw profileError('CLOUD_CLEANUP_FOREIGN_INDEX','cold source contains foreign receipt');
        if(p.format==='qb-final-proof-reservation-v1'){if(row.sourceRecordId!=='reservation'||Object.keys(p).sort().join()!=='bytes,format,recordCount,workspaceId'||!Number.isSafeInteger(p.bytes)||p.bytes<0||p.bytes>256*1024*1024||!Number.isSafeInteger(p.recordCount)||p.recordCount<1)throw profileError('CORRUPT','cold reservation invalid');reservations.set(row.sourceId,row);return;}
        if(p.format!=='qb-final-proof-part-v1'||Object.keys(p).sort().join()!=='byteLength,contentDigest,format,label,sha256,workspaceId'||typeof p.label!=='string'||p.label.length>400||!/^[A-Za-z0-9:_.\/-]+$/.test(p.label)||row.sourceRecordId!=='part:'+p.label||!Number.isSafeInteger(p.byteLength)||p.byteLength<1||p.byteLength>512*1024||p.contentDigest!==await sha256Hex(canonicalBytes({format:'qb-final-proof-part-key-v1',workspaceId:p.workspaceId,label:p.label})))throw profileError('CORRUPT','cold source frame invalid');
        const chunk=await get('content_chunks',[p.contentDigest,0]);await check();if(!chunk||chunk.bytes.length!==p.byteLength||await sha256Hex(chunk.bytes)!==p.sha256)throw profileError('CORRUPT','cold source frame bytes differ');permit(p.contentDigest,0,p.sha256,p.byteLength);parts.push({row});metadataBytes+=canonicalBytes(row).length;if(metadataBytes>8*1024*1024)throw profileError('CLOUD_CLEANUP_BUDGET','cold frame metadata bound');
      });
      for(const [id,reservation]of reservations){const own=parts.filter(item=>item.row.sourceId===id);const actualBytes=canonicalBytes(reservation).length+own.reduce((sum,item)=>sum+canonicalBytes(item.row).length+item.row.provenance.byteLength+canonicalBytes({contentDigest:item.row.provenance.contentDigest,chunkIndex:0}).length,0);if(reservation.provenance.recordCount!==1+own.length*2||reservation.provenance.bytes!==actualBytes)throw profileError('CORRUPT','cold source reservation does not match actual frames');}
      for(const item of parts)if(!reservations.has(item.row.sourceId))throw profileError('CORRUPT','cold source frame reservation missing');
      await scan('content_chunks',async row=>{const expected=allowed.get(`${row.contentDigest}:${row.chunkIndex}`);if(!expected||row.bytes.length!==expected.length||await sha256Hex(row.bytes)!==expected.sha)throw profileError('CLOUD_CLEANUP_UNKNOWN_CONTENT','cold source contains unknown or changed chunk');});
      let classifiedCount=0;for(const store of Object.keys(APP_DATA_STORES))await scan(store,async row=>{if(!['content_chunks','import_receipts','migration_journal'].includes(store))throw profileError('CLOUD_CLEANUP_FOREIGN_BUSINESS','cold learning row appeared during classification');if(expectedCut.get(cutKey(store,row))!==await cutHash(store,row))throw profileError('CLOUD_CLEANUP_CHANGED','cold source changed during classification');classifiedCount++;});if(classifiedCount!==expectedCut.size)throw profileError('CLOUD_CLEANUP_CHANGED','cold source row disappeared during classification');
      // All nineteen stores have been classified before the first mutation.
      // Exact own source frames are removed with real schema/full-row CAS.
      for(const item of parts){await check();const p=item.row.provenance;item.chunk=await get('content_chunks',[p.contentDigest,0]);await check();if(!item.chunk||item.chunk.bytes.length!==p.byteLength||await sha256Hex(item.chunk.bytes)!==p.sha256)throw profileError('CONFLICT','cold source part changed before CAS');const before=reservations.get(item.row.sourceId),next=ownedWriteInput(before),oldSize=canonicalBytes(before).length;next.provenance.recordCount-=2;for(let n=0;n<4;n++)next.provenance.bytes=before.provenance.bytes-canonicalBytes(item.row).length-item.chunk.bytes.length-canonicalBytes({contentDigest:item.chunk.contentDigest,chunkIndex:0}).length+canonicalBytes(next).length-oldSize;
        await exactColdWrite({conditions:[{store:'import_receipts',key:[item.row.sourceId,'reservation'],expected:before},{store:'import_receipts',key:[item.row.sourceId,item.row.sourceRecordId],expected:item.row},{store:'content_chunks',key:[item.chunk.contentDigest,0],expected:item.chunk}],puts:[{store:'import_receipts',value:next}],deletes:[{store:'import_receipts',key:[item.row.sourceId,item.row.sourceRecordId]},{store:'content_chunks',key:[item.chunk.contentDigest,0]}]});expectedCut.delete(cutKey('import_receipts',item.row));expectedCut.delete(cutKey('content_chunks',item.chunk));expectedCut.set(cutKey('import_receipts',next),await cutHash('import_receipts',next));delete item.chunk;await check();reservations.set(item.row.sourceId,next);}
      for(const [id,row]of reservations){if(row.provenance.recordCount!==1||row.provenance.bytes!==canonicalBytes(row).length)throw profileError('CORRUPT','cold final reservation differs');await exactColdWrite({conditions:[{store:'import_receipts',key:[id,'reservation'],expected:row}],deletes:[{store:'import_receipts',key:[id,'reservation']}]});expectedCut.delete(cutKey('import_receipts',row));await check();}
      let finalCount=0;for(const store of Object.keys(APP_DATA_STORES))await scan(store,async row=>{if(!['content_chunks','import_receipts','migration_journal'].includes(store))throw profileError('CLOUD_CLEANUP_FOREIGN_BUSINESS','cold learning row appeared before physical deletion');if(expectedCut.get(cutKey(store,row))!==await cutHash(store,row))throw profileError('CLOUD_CLEANUP_CHANGED','cold source changed after frame cleanup');finalCount++;});if(finalCount!==expectedCut.size)throw profileError('CLOUD_CLEANUP_CHANGED','cold source row disappeared after frame cleanup');await check();
      // Exact known rows can be deleted transactionally; a physical delete
      // request has no abort primitive and therefore is NOT issued here.
      for(const store of ['content_chunks','import_receipts','migration_journal'])await scan(store,async row=>{
        const key=store==='content_chunks'?[row.contentDigest,row.chunkIndex]:store==='import_receipts'?[row.sourceId,row.sourceRecordId]:row.migrationId;
        if(expectedCut.get(cutKey(store,row))!==await cutHash(store,row))throw profileError('CLOUD_CLEANUP_CHANGED','logical cleanup row is not in the original classified cut');
        await exactColdWrite({conditions:[{store,key,expected:row}],deletes:[{store,key}]});expectedCut.delete(cutKey(store,row));
      });
      for(const store of Object.keys(APP_DATA_STORES))await scan(store,()=>{throw profileError('CLOUD_CLEANUP_CHANGED','unknown row appeared before logical cleanup completed');});
      await check();return {status:'cleanup-incomplete',cleanupRequired:true,physicalDeleted:false,error:'CLOUD_SOURCE_PHYSICAL_DELETE_UNAVAILABLE',logicalContentEmpty:true,physicalContainerRetained:true,sourceProfileId:marker.profileId};
    }catch(cause){return {status:'cleanup-incomplete',cleanupRequired:true,physicalDeleted,error:typeof cause?.code==='string'?cause.code:'CLOUD_CLEANUP_FAILED'};}finally{clearTimeout(expiry);signal.removeEventListener('abort',cancel);cancelled.abort();rows?.close();source?.close();raw?.close();}
  };
  const listSource=()=>controlTx('readonly',async tx=>{const results=[];let cursor=await tx.objectStore('meta').openCursor(IDBKeyRange.bound('source-allocation:','source-allocation:\uffff'));while(cursor){if(results.length===100)throw profileError('PROOF_ROW_BUDGET','allocation inventory exceeds bounded page');const marker=validateSourceAllocationMarker(cursor.value);if(cursor.primaryKey!==marker.key||!sameOwner(marker.owner,snapshot.owner))throw profileError('OWNER_MISMATCH','allocation inventory owner/key invalid');results.push({profileId:marker.profileId,status:marker.status,cleanupRequired:true});cursor=await cursor.continue();}return results;});
  const sourceRegistryState={base:registry,assertOpen,bind:bindSource,allocate:allocateSource,reconcile:reconcileSource,list:listSource};
  sourceStageRegistries.set(registry,sourceRegistryState);
  return registry;
}

/** @param {unknown} pointer */
function validateProfileJournalPointer(pointer) {
  try { return validateActiveProfilePointer(pointer); }
  catch (cause) { throw profileError("CORRUPT", "active pointer is invalid", cause); }
}

/** @param {{ owner:unknown, controlId:string, controlOpenMode:"create"|"existing", blockedTimeoutMs:number, signal?:AbortSignal }} options */
export function openManagedProfileRegistry(options) {
  let snapshot;
  try { snapshot = snapshotOptions(options); } catch (cause) { return Promise.reject(cause); }
  return createController(snapshot);
}
