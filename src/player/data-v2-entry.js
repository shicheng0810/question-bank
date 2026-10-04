import { openProfileBootstrap, lockProfileOwner } from '../storage/profile-bootstrap.js';
import {listPreverificationAllocations,reconcilePreverificationAllocation} from '../storage/profiles/managed-profile-registry.js';
import { openLearningRepository } from '../storage/idb/learning-repository.js';
import { exportLocalBackup, restoreLocalBackup } from '../storage/backup/index.js';
import { deleteCompletedOwnerData } from '../storage/profiles/delete-owner-data.js';
import {createNativeCloudRecoveryProvider} from '../storage/cloud-recovery/index.js';
import {createCloudRecoveryV2} from '../browser/cloud-recovery-v2.js';

/** UI passes the trusted current owner and session epoch predicate.
 * Close the returned context before switching identity; logout keeps outbox data.
 * Account deletion calls lockDeletedOwner after close, never reuses its generation.
 */
export async function openDataV2({ owner = null, ownerTabId = crypto.randomUUID(), signal, isCurrent = () => true, blockedTimeoutMs = 5000, now = Date.now, onCleanup = () => {}, authorizeSnapshotInitialization } = {}) {
  const lifecycle=new AbortController(),cancel=()=>lifecycle.abort();if(signal?.aborted)cancel();else signal?.addEventListener('abort',cancel,{once:true});
  const localSignal=lifecycle.signal;let bootstrap,repository,closed=false,cleanupFlight=null,cleanupState=null,allocationFlight=null,allocationCursor=0,terminalCleanup=null,allocationTimer=null,manualCleanupFlight=null,allocationWakePending=false;const allocationVisited=new Set(),allocationObservations=new Map();let allocationFirstError=null;
  const guard=()=>{if(closed||localSignal.aborted||!isCurrent())throw Object.assign(new Error('CLOSED'),{code:'CLOSED'});};
  const cleanupReport=value=>{guard();cleanupState=Object.freeze({...value});onCleanup(cleanupState);};
  const allocationReport=value=>{const normalized={...value,...(terminalCleanup?.cleanupRequired===true?{status:terminalCleanup.status,cleanupRequired:true,framesCleanupRequired:terminalCleanup.framesCleanupRequired===true,profileId:terminalCleanup.profileId,error:terminalCleanup.error??value.error}:{}),...(allocationFirstError?{allocationFirstError}: {})};cleanupReport(normalized);return cleanupState;};
  const retainedObservations=entries=>Object.freeze(entries.flatMap(entry=>allocationObservations.has(entry.profileId)?[allocationObservations.get(entry.profileId)]:[]));
  function scheduleAllocationRound(){
    guard();if(allocationTimer!==null)return;
    allocationTimer=setTimeout(()=>{allocationTimer=null;if(closed||localSignal.aborted||!isCurrent())return;
      void maintainIndexedAllocations().catch(()=>{/* original failure is reported by the guarded operation; close suppresses stale reports */});
    },0);
  }
  // Only settled internal producers request a refresh; no public wake authority.
  function flushSettledAllocationWake(){
    if(!allocationWakePending||closed||localSignal.aborted||!isCurrent()||cleanupFlight||allocationFlight||manualCleanupFlight)return;
    allocationWakePending=false;scheduleAllocationRound();
  }
  function wakeAfterSettledLifecycle(){
    if(closed||localSignal.aborted||!isCurrent()||bootstrap.owner.ownerKind!=='account')return;
    allocationWakePending=true;flushSettledAllocationWake();
  }
  async function maintainIndexedAllocations(){
    guard();if(allocationFlight)return allocationFlight;
    const flight=(async()=>{
      const entries=await listPreverificationAllocations(bootstrap.registry);guard();
      // One native request per macrotask; each live cycle visits at most the actual100 marker bound.
      const entry=entries.find(value=>!allocationVisited.has(value.profileId));
      if(!entry){const pending=entries.length>0;const result={...terminalCleanup,status:allocationFirstError?'source-allocation-error':pending?'source-allocation-pending':terminalCleanup?.status??'no-cleanup-commitment',cleanupRequired:terminalCleanup?.cleanupRequired===true||!!allocationFirstError||pending,allocationPendingCount:entries.length,allocationResults:retainedObservations(entries),error:terminalCleanup?.error??allocationFirstError??(pending?'CLOUD_SOURCE_ALLOCATION_PENDING':undefined)};return allocationReport(result);}
      if(allocationVisited.size>=100)throw Object.assign(new Error('CLOUD_SOURCE_ALLOCATION_LIMIT'),{code:'CLOUD_SOURCE_ALLOCATION_LIMIT'});
      allocationVisited.add(entry.profileId);
      let result;try{result=await reconcilePreverificationAllocation(bootstrap.registry,{profileId:entry.profileId});guard();}
      catch(error){allocationObservations.clear();guard();allocationFirstError??=typeof error?.code==='string'?error.code:'CLOUD_SOURCE_ALLOCATION_FAILED';result={status:'cleanup-incomplete',cleanupRequired:true,error:allocationFirstError};}
      if(result.status==='cleanup-incomplete'&&result.cleanupRequired===true&&result.physicalDeleted===false&&result.error==='CLOUD_SOURCE_PHYSICAL_DELETE_UNAVAILABLE'&&result.sourceProfileId===entry.profileId&&result.logicalContentEmpty===true&&result.physicalContainerRetained===true)allocationObservations.set(entry.profileId,Object.freeze({profileId:entry.profileId,status:result.status,cleanupRequired:true,error:result.error,sourceProfileId:entry.profileId,logicalContentEmpty:true,physicalContainerRetained:true}));else allocationObservations.delete(entry.profileId);
      const remaining=await listPreverificationAllocations(bootstrap.registry);guard();
      const pending=remaining.length>0,error=terminalCleanup?.error??allocationFirstError??result.error??(pending?'CLOUD_SOURCE_ALLOCATION_PENDING':undefined);
      const report={status:(pending||allocationFirstError||result.cleanupRequired)?'source-allocation-pending':terminalCleanup?.status??'no-cleanup-commitment',cleanupRequired:terminalCleanup?.cleanupRequired===true||pending||!!allocationFirstError||result.cleanupRequired===true,framesCleanupRequired:terminalCleanup?.framesCleanupRequired===true,profileId:terminalCleanup?.profileId,allocationPendingCount:remaining.length,allocationVisited:allocationVisited.size,allocationResults:Object.freeze([...retainedObservations(remaining),...(allocationObservations.has(entry.profileId)?[]:[Object.freeze({profileId:entry.profileId,status:result.status,cleanupRequired:result.cleanupRequired===true,error:typeof result.error==='string'?result.error:null})])]),error};
      const normalized=allocationReport(report);
      if(remaining.some(value=>!allocationVisited.has(value.profileId))&&allocationVisited.size<100)scheduleAllocationRound();
      return normalized;
    })().catch(error=>{allocationObservations.clear();guard();allocationFirstError??=typeof error?.code==='string'?error.code:'CLOUD_SOURCE_ALLOCATION_FAILED';const report={status:'source-allocation-error',cleanupRequired:true,error:allocationFirstError};return allocationReport(report);}).finally(()=>{if(allocationFlight===flight)allocationFlight=null;flushSettledAllocationWake();});
    allocationFlight=flight;return flight;
  }
  async function retryIndexedCleanup(){
    guard();if(manualCleanupFlight)return manualCleanupFlight;
    const flight=(async()=>{
      // Wait for existing operations; do not mutate visited/error while they own their cut.
      if(cleanupFlight){await cleanupFlight;guard();}
      if(allocationFlight){await allocationFlight;guard();}
      if(allocationTimer!==null){clearTimeout(allocationTimer);allocationTimer=null;}
      allocationObservations.clear();allocationVisited.clear(); // first failure remains visible across an explicit retry
      return await retryCleanup(true);
    })().finally(()=>{if(manualCleanupFlight===flight)manualCleanupFlight=null;flushSettledAllocationWake();});
    manualCleanupFlight=flight;return flight;
  }
  async function retryCleanup(includeAllocations=true){
    guard();if(cleanupFlight)return cleanupFlight;
    const flight=(async()=>{guard();const active=await bootstrap.registry.readActive();guard();if(!active)throw Object.assign(new Error('CLOUD_CLEANUP_BINDING'),{code:'CLOUD_CLEANUP_BINDING'});cleanupReport({status:'checking',cleanupRequired:true,profileId:active.profile.profileId});
      try{const result=await bootstrap.registry.resumeCheckpointSourceCleanup({profileId:active.profile.profileId});guard();terminalCleanup=result;cleanupReport(result);return includeAllocations?await maintainIndexedAllocations():result;}
      catch(error){allocationObservations.clear();guard();const result={status:'cleanup-incomplete',cleanupRequired:true,profileId:active.profile.profileId,error:typeof error?.code==='string'?error.code:'CLOUD_CLEANUP_FAILED'};terminalCleanup=result;cleanupReport(result);return result;}
    })().finally(()=>{if(cleanupFlight===flight)cleanupFlight=null;flushSettledAllocationWake();});cleanupFlight=flight;return flight;
  }
  try {
    bootstrap=await openProfileBootstrap({owner,signal:localSignal,isCurrent,blockedTimeoutMs});guard();
    await retryCleanup(false);guard();
    repository = await openLearningRepository({ registry: bootstrap.registry, owner: bootstrap.owner, ownerTabId, blockedTimeoutMs, signal:localSignal, now, authorizeSnapshotInitialization });
    await repository.initializeStream();
    if (signal?.aborted || !isCurrent()) throw Object.assign(new Error('CLOSED'), { code: 'CLOSED' });
    let recoveryFlight=null,recoveryCancellation=null,recoveryCommitted=false;
    const close = () => { if(closed)return;closed=true;allocationObservations.clear();allocationWakePending=false;if(allocationTimer!==null){clearTimeout(allocationTimer);allocationTimer=null;}if(!recoveryCommitted)recoveryCancellation?.abort();lifecycle.abort();signal?.removeEventListener('abort',cancel);let failure,hasFailure=false;for(const dispose of[()=>repository.close(),()=>bootstrap.close()]){try{dispose();}catch(error){if(!hasFailure){failure=error;hasFailure=true;}}}if(hasFailure)throw failure; };
    function recoverCloud({account,signal:operationSignal,onProgress=()=>{}}){
      if(recoveryFlight)throw Object.assign(new Error('RECOVERY_BUSY'),{code:'RECOVERY_BUSY'});
      const captured=account?.snapshot(),trusted=bootstrap.owner;
      if(trusted.ownerKind!=='account'||captured?.phase!=='ready'||captured.owner?.accountId!==trusted.accountId||captured.owner?.accountGeneration!==trusted.accountGeneration||!isCurrent())throw Object.assign(new Error('STALE_OWNER'),{code:'STALE_OWNER'});
      const cancellation=new AbortController(),sources=[signal,operationSignal].filter(Boolean),cancel=()=>cancellation.abort();for(const source of sources){if(source.aborted)cancel();else source.addEventListener('abort',cancel,{once:true});}
      recoveryCancellation=cancellation;
      recoveryCommitted=false;
      const current=()=>isCurrent()&&account.snapshot().epoch===captured.epoch&&account.snapshot().owner?.accountId===trusted.accountId&&account.snapshot().owner?.accountGeneration===trusted.accountGeneration;
      let provider,client,abortLifecycleSettled=false;try{provider=createNativeCloudRecoveryProvider({registry:bootstrap.registry,repository,owner:trusted,signal:cancellation.signal,isCurrent:current,blockedTimeoutMs,onCommitted:()=>{recoveryCommitted=true;}});const actualProvider=provider;provider=Object.freeze({...actualProvider,async abortCloudRecovery(input){const result=await actualProvider.abortCloudRecovery(input);if(result.status==='quarantined')abortLifecycleSettled=true;return result;}});client=createCloudRecoveryV2({account,repository,provider,signal:cancellation.signal,onProgress:value=>{if(current())onProgress(value);}});}catch(error){for(const source of sources)source.removeEventListener('abort',cancel);if(recoveryCancellation===cancellation)recoveryCancellation=null;throw error;}
      const flight=client.runOnce().then(result=>{close();if(!current())throw Object.assign(new Error('STALE_OWNER'),{code:'STALE_OWNER',recoveryCommitted:result.status==='complete'});return result;}).catch(error=>{if(error.recoveryCommitted)close();throw error;}).finally(()=>{for(const source of sources)source.removeEventListener('abort',cancel);if(recoveryCancellation===cancellation)recoveryCancellation=null;if(recoveryFlight===flight)recoveryFlight=null;if(abortLifecycleSettled&&current())wakeAfterSettledLifecycle();});recoveryFlight=flight;return flight;
    }
    const context=Object.freeze({ owner: bootstrap.owner, repository, close,recoverCloud,retryCleanup:retryIndexedCleanup,cleanupSnapshot:()=>cleanupState,
      exportBackup() { return exportLocalBackup({ registry: bootstrap.registry, owner: bootstrap.owner, signal, isCurrent, blockedTimeoutMs }); },
      async restoreBackup(archive) {
        let hasRestoreFailure=false;
        try { const active = await bootstrap.registry.readActive(); repository.close();return await restoreLocalBackup({ registry: bootstrap.registry, owner: bootstrap.owner, archive, expectedRevision: active?.pointer.activationRevision ?? 0, signal, isCurrent, blockedTimeoutMs }); }
        catch(error){hasRestoreFailure=true;throw error;}
        finally { try{close();}catch(error){if(!hasRestoreFailure)throw error;} }
      },
      async cleanupDeletedOwner(receipt) { close(); return deleteCompletedOwnerData(bootstrap.owner, { receipt, blockedTimeoutMs }); },
      async lockDeletedOwner() { close(); if (bootstrap.owner.ownerKind === 'account') await lockProfileOwner(bootstrap.owner); } });
    if(bootstrap.owner.ownerKind==='account')queueMicrotask(()=>{if(closed||localSignal.aborted||!isCurrent())return;void maintainIndexedAllocations().catch(error=>{if(!closed&&!localSignal.aborted&&isCurrent())allocationReport({status:'source-allocation-error',cleanupRequired:true,error:typeof error?.code==='string'?error.code:'CLOUD_SOURCE_ALLOCATION_FAILED'});});});
    return context;
  } catch (error) { allocationObservations.clear();closed=true;lifecycle.abort();signal?.removeEventListener('abort',cancel);repository?.close(); bootstrap?.close(); throw error; }
}

export { openProfileBootstrap, lockProfileOwner, openLearningRepository };
