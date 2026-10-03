import {canonicalBytes,validateStoreRecord,verifyMutationDigest,encodeCursor} from '../../domain/app-data/index.js';
import {ownedWriteInput} from '../idb/write-input.js';
import {mutationWire,validateSyncReceipt} from '../sync/protocol.js';
import {validateCloudReceipt,cloudError} from './metadata.js';

const same=(a,b)=>{if(a===undefined||b===undefined)return a===b;const x=canonicalBytes(a),y=canonicalBytes(b);return x.length===y.length&&x.every((v,i)=>v===y[i]);};
function input(value,keys){const captured=ownedWriteInput(value);if(!captured||Object.keys(captured).sort().join()!==keys.split(',').sort().join())throw cloudError('CLOUD_RECONCILE_INPUT');return captured;}
function checkedContext(value){const context=input(value,'generation,logEpoch,cut');encodeCursor({protocolVersion:2,accountGeneration:context.generation,logEpoch:context.logEpoch,serverSeq:context.cut});return context;}

/** Unimported pure per-original-record policy. This does NOT establish native
 * provenance, authorize a write/ACK, or mint an activation capability. */
export async function planExactCloudReceipt(value){
 const {mutation,outbox,previousConflict,receipt,change,context}=input(value,'mutation,outbox,previousConflict,receipt,change,context');
 checkedContext(context);
 validateStoreRecord('mutations',mutation);if(outbox!==undefined){validateStoreRecord('outbox',outbox);if(outbox.mutationId!==mutation.mutationId)throw cloudError('CLOUD_LOCAL_ORIGINAL_MISSING');}
 if(previousConflict!==undefined)validateStoreRecord('conflicts',previousConflict);
 const original=mutationWire(mutation);if(!await verifyMutationDigest(original))throw cloudError('CORRUPT_MUTATION');
 if(mutation.accountGeneration!==undefined&&mutation.accountGeneration!==context.generation)throw cloudError('CLOUD_OWNER_MISMATCH');
 if(receipt===undefined)return {action:'retain_original',ready:false};
 const cloud=await validateCloudReceipt(receipt,context),p=cloud.provenance;
 if(!same(original,p.mutation))throw cloudError('CLOUD_LOCAL_RECEIPT_MISMATCH');
 if(['accepted','duplicate'].includes(p.receipt.status)){
  // A real native accepted-change lookup is mandatory when integrated. An
  // equal payload belonging to another mutation is never sufficient evidence.
  if(change===undefined)throw cloudError('CLOUD_RECEIPT_CHANGE');
  await validateCloudReceipt(cloud,{...context,change});
  return {action:'delete_exact_outbox',mutationId:original.mutationId,expectedOutbox:outbox,originalWire:original,ready:false};
 }
 const conflict={conflictId:original.mutationId,entityKey:original.entityKey,status:'open',mutation:original,...(p.receipt.currentRevision!==undefined?{currentRevision:p.receipt.currentRevision}:{})};
 validateStoreRecord('conflicts',conflict);if(previousConflict&&!same(previousConflict,conflict))throw cloudError('CLOUD_CONFLICT_DIVERGENCE');
 return {action:'retain_outbox_with_conflict',expectedOutbox:outbox,expectedConflict:previousConflict,conflict,originalWire:original,ready:false};
}

/** Exact original old merge precedence, one native receipt key at a time. */
export function planSyncEntityReceipt(value){
 const {local,remote}=input(value,'local,remote');validateSyncReceipt(local);if(remote===undefined)return {action:'put_local',value:local,ready:false};validateSyncReceipt(remote);
 if(local.sourceId!==remote.sourceId||local.sourceRecordId!==remote.sourceRecordId)throw cloudError('CLOUD_LOCAL_FACT_DIVERGENCE');
 const a=local.provenance,b=remote.provenance;
 if(a.serverRevision>b.serverRevision)return {action:'put_local',value:local,ready:false};
 if(a.serverRevision===b.serverRevision&&a.payloadDigest!==b.payloadDigest)throw cloudError('CLOUD_LOCAL_FACT_DIVERGENCE');
 return {action:'keep_remote',value:remote,ready:false};
}

/** Only a plan: actual checkpoint/native source and final private CAS must be
 * proven by the caller's genuine registry bridge, never by this context DTO. */
export function planCloudRuntimeCut(value){
 const {context,invalidation}=input(value,'context,invalidation');
 checkedContext(context);
 if(!Number.isSafeInteger(invalidation)||invalidation<0)throw cloudError('CORRUPT_PROJECTION_META');
 if(invalidation===Number.MAX_SAFE_INTEGER)throw cloudError('REVISION_EXHAUSTED');
 const cursor=encodeCursor({protocolVersion:2,accountGeneration:context.generation,logEpoch:context.logEpoch,serverSeq:context.cut});
 return {ready:false,records:[{key:'serverLogEpoch',value:context.logEpoch},{key:'appliedPullCursor',value:cursor},{key:'projectionVersion',value:1},{key:'projectionInvalidationRevision',value:invalidation+1},{key:'projectionAppliedRevision',value:0}]};
}
