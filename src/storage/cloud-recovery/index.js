import {sha256} from '@noble/hashes/sha2.js';
import {validateHistorySnapshotBinding} from '../../domain/app-data/history-snapshot-records.js';
import {canonicalBytes,canonicalContentBytes,sha256Hex,validateChangeLogRecord,validateChunkManifest,validateContentReference,verifyMutationDigest,validateMutationReceipt,validateAttemptScope,validateResumeState,encodeCursor,validateCursorReset,APP_DATA_STORES} from '../../domain/app-data/index.js';
import {validateBankContent,validateProtectedBankEnvelopeV2} from '../../domain/question/bank-content.js';
import {isUuid} from '../../domain/question/index.js';
import {validateCloudCheckpoint,validateCloudContentReference,CLOUD_SECTION_PATHS} from '../../../do-worker/src/account-cloud-checkpoint.js';
import {snapshotOwner,sameOwner} from '../profiles/control-schema.js';
import {isFinalControlCommitError,allocatePreverificationSourceStage,bindPreverificationSourceRegistry,consumePreverificationAllocationFailure} from '../profiles/managed-profile-registry.js';
import {ownedWriteInput} from '../idb/write-input.js';
import {openCloudNativeDatabase} from './native-stage.js';
import {cloudError,validateCloudStageJournal,validateCloudPageReceipt,cloudTemporaryDigest,validateCloudReceipt} from './metadata.js';
import {verifyFrozenCloudPublicReference} from '../../browser/cloud-recovery-v2.js';
import {applyPullPage} from '../sync/pull.js';
// Strict bytes validator only, not source/public/Ready authority. The private
// caller must independently authenticate the real frozen-registry source row.
export async function validateCanonicalStoredManifest(reference,input){
 const expected=ownedWriteInput(reference);validateContentReference(expected);
 if(!(input instanceof Uint8Array))throw cloudError('CLOUD_MANIFEST_MISSING');
 const bytes=new Uint8Array(input);if(bytes.length>3*1024*1024)throw cloudError('CLOUD_MANIFEST_BINDING');
 let manifest;try{manifest=validateChunkManifest(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));}catch{throw cloudError('CLOUD_MANIFEST_BINDING');}
 const canonical=canonicalBytes(manifest);if(canonical.length!==bytes.length||!canonical.every((byte,index)=>byte===bytes[index])||await sha256Hex(bytes)!==expected.manifestDigest||manifest.contentDigest!==expected.contentDigest||manifest.totalBytes!==expected.totalBytes||manifest.chunkCount!==expected.chunkCount)throw cloudError('CLOUD_MANIFEST_BINDING');
 return ownedWriteInput(manifest);
}
import {mergeCloudRecoveryCut} from './merge.js';
import {createCloudStageIndexes} from './stage-index.js';
import {validateSnapshot,snapshotManifest,STORE_NAMES} from '../backup/snapshot.js';

const equal=(a,b)=>new TextDecoder().decode(canonicalContentBytes(a))===new TextDecoder().decode(canonicalContentBytes(b));
const byteEqual=(a,b)=>a.length===b.length&&a.every((byte,index)=>byte===b[index]);
const hex=bytes=>Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('');
const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true});
const projectionSources=new WeakMap();
const preverificationSourceStages=new WeakMap();
// This matcher accepts only an internally minted provider stage and its exact
// native handle. It is not the semantically verified projection capability.
export function assertPreverificationSourceStage(capability,database){const entry=preverificationSourceStages.get(capability);if(!entry||!entry.live||!entry.state.db.ownsDatabaseIdentity(database))throw cloudError('CLOUD_SOURCE_STAGE_INVALID');entry.assertLive();return entry.access;}
const committedRecoveryResults=new WeakSet();
export function isCommittedNativeCloudRecoveryResult(value){return !!value&&typeof value==='object'&&committedRecoveryResults.has(value);}
function committedCallbackError(cause){
  if(cause&&typeof cause==='object'&&Object.isExtensible(cause))return cause;
  const error=new Error('Committed recovery callback failed',{cause});error.code='RECOVERY_COMMITTED_CALLBACK_FAILED';return error;
}
// Only a real completed native stage below can mint this module-private entry.
// The accessor exposes bounded reads, never the raw database or an activation.
export function consumeCloudProjectionSource(capability){const entry=projectionSources.get(capability);if(!entry)throw cloudError('CLOUD_PROJECTION_SOURCE_INVALID');entry.assertLive();return entry.access;}
function capabilityInput(input){if(!input||Object.getPrototypeOf(input)!==Object.prototype)throw cloudError('INVALID_INPUT');const descriptors=Object.getOwnPropertyDescriptors(input),raw={};let handle;for(const key of Reflect.ownKeys(descriptors)){const descriptor=descriptors[key];if(typeof key!=='string'||!descriptor.enumerable||!Object.hasOwn(descriptor,'value'))throw cloudError('INVALID_INPUT');if(key==='handle')handle=descriptor.value;else raw[key]=descriptor.value;}return {handle,raw:ownedWriteInput(raw)};}
function ndjson(records){const parts=records.map(row=>canonicalBytes(row));const size=parts.reduce((sum,part)=>sum+part.length+1,0);if(size>480*1024)throw cloudError('CLOUD_PAGE_BUDGET');const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;bytes[offset++]=10;}return bytes;}

/** A capability owns a real inactive 19-store DB. No stage method can activate
 * it; every operation rechecks the live original owner/coordinator/pointer. */
export function createNativeCloudRecoveryProvider({registry,repository,owner,signal,isCurrent=()=>true,blockedTimeoutMs=5000,onCommitted=()=>{}}){
  if(typeof onCommitted!=='function')throw cloudError('INVALID_INPUT');
  const trustedOwner=snapshotOwner(owner),handles=new WeakMap();
  if(trustedOwner.ownerKind!=='account'||!sameOwner(registry.ownerSnapshot(),trustedOwner))throw cloudError('CLOUD_OWNER_MISMATCH');
  function localGuard(){if(signal?.aborted||!isCurrent())throw cloudError('CLOSED');if(!sameOwner(registry.ownerSnapshot(),trustedOwner))throw cloudError('CLOUD_OWNER_MISMATCH');}
  function notifyCommitted(state){
    let failure,hasFailure=false;try{onCommitted();}catch(cause){failure=cause;hasFailure=true;}
    state.closed=true;
    // Pointer projector has no owned handle/close API. Its native database
    // owns the resources. Attempt every close without masking callback error.
    for(const close of [()=>state.removeAbort?.(),()=>state.sourceRegistryBinding?.close(),()=>state.db.close(),()=>repository.close()]){
      try{close();}catch(cause){if(!hasFailure){failure=cause;hasFailure=true;}}
    }
    if(hasFailure)throw committedCallbackError(failure);
  }
  async function cleanupCommittedSource(state,access,profileId){
    state.renewMode='terminal';state.heldRenew=null;state.resolveRenewRoute?.();
    state.finalPhase='committed-source-cleanup';
    try{
      state.db.close();
      const result=await access.cleanupCheckpointSource({profileId});
      if(result?.status!=='checkpoint_source_cleaned'||result.cleanupRequired!==false){state.cleanupRequired=true;state.cleanupError=result?.error||'CLOUD_CLEANUP_FAILED';}
      else state.cleanupRequired=false;
    }catch(cause){state.cleanupRequired=true;state.cleanupError=typeof cause?.code==='string'?cause.code:'CLOUD_CLEANUP_FAILED';}
    return {cleanupRequired:!!state.cleanupRequired,...(state.cleanupRequired?{cleanupError:state.cleanupError}:{})};
  }
  async function guard(state){localGuard();if(state.checkpoint.expiresAt<=Date.now())throw cloudError('CLOUD_CHECKPOINT_EXPIRED');if(state.sourceRegistryBinding)await state.sourceRegistryBinding.check();const active=await registry.readActive();localGuard();if(!equal(active,state.active))throw cloudError('STALE_ACTIVE_PROFILE');const meta=await repository.readRecords('meta');localGuard();const lease=meta.find(row=>row.key==='syncCoordinatorLease')?.value;if(!lease||lease.ownerTabId!==state.context.ownerTabId||lease.fence!==state.context.fence||lease.expiresAt<=Date.now())throw cloudError('SYNC_FENCE_LOST');const epoch=meta.find(row=>row.key==='serverLogEpoch')?.value??null,cursor=meta.find(row=>row.key==='appliedPullCursor')?.value??null;if(epoch!==state.context.logEpoch||cursor!==state.context.appliedPullCursor)throw cloudError('SYNC_CONTEXT_CHANGED');return {meta};}
  function handleState(handle){const state=handles.get(handle);if(!state||state.closed)throw cloudError('CLOUD_HANDLE_CLOSED');return state;}
  async function renewCloudRecoveryLease(input){
    const {handle,raw}=capabilityInput(input);if(Object.keys(raw).length)throw cloudError('INVALID_INPUT');
    const known=handles.get(handle);if(known?.activated)return undefined;
    const state=handleState(handle);localGuard();
    if(state.renewFlight)return state.renewFlight;
    state.renewFlight=(async()=>{
      if(state.renewMode==='waiting')await state.renewRouteReady;
      if(state.activated)return undefined;localGuard();if(state.closed||state.renewMode==='terminal')throw cloudError('CLOUD_HANDLE_CLOSED');
      let value;try{value=state.heldRenew?await state.heldRenew():await repository.renewSyncCoordinator({token:state.renewToken,ttlMs:15000});}catch(cause){if(state.activated)return undefined;throw cause;}
      if(state.activated)return undefined;localGuard();if(state.closed)throw cloudError('CLOUD_HANDLE_CLOSED');state.renewToken=value;return value;
    })().finally(()=>{state.renewFlight=null;});return state.renewFlight;
  }
  async function checked(handle){const state=handleState(handle);await guard(state);return state;}
  async function readCloudRecoveryDiagnostics(input){
    const {handle,raw}=capabilityInput(input);if(Object.keys(raw).length)throw cloudError('INVALID_INPUT');
    const state=await checked(handle),reader=state.finalReader;
    const actual=reader?reader.readFinalDiagnostics():null;
    const held=state.readHeldDiagnostics?await state.readHeldDiagnostics():null;
    const counters={};
    const keys=['scopeRows','indexReads','indexReadBatches','indexWrites','indexWriteBatches','scopeReadBatches','partWrites','partReads','bankBodyHashes','freshFullBodyHashes','rawProofReuses','actualChunkHashes','bankSemanticParses','bankSemanticReuses','bankRawHashBytes','scopeMs','sourceCheckMs','nativeGets','checks','checkMs','projectorReaderCreates','projectorReaderResets','projectorSameRawCreates','projectorSameWorkspaceCreates','mergeChecks','mergeCheckMs','mergeNativeOps','mergeNativeMs','mergeRowsRead','mergePageBytes','mergeHashRows','mergeHashBytes'];
    // Explicit scalar projection only. No source text, IDs, DB or proof escapes.
    for(const source of [held?.counters,actual,actual?.semantics,actual?.diagnostics])if(source)for(const key of keys){const value=source[key];if(typeof value==='number'&&Number.isFinite(value)&&value>=0)counters[key]=value;}
    await guard(state);handleState(handle);
    return Object.freeze({status:'cloud_recovery_diagnostics',phase:state.finalPhase??null,readerAvailable:!!reader||held?.available===true,counters:Object.freeze(counters),ready:false});
  }
  function pointer(state){if(!state.projector)state.projector=state.db.createPointerProjector({stageId:state.stageId,profileId:state.profile.profileId,owner:trustedOwner,generation:state.checkpoint.generation,logEpoch:state.checkpoint.logEpoch,checkpointDigest:state.checkpointDigest});return state.projector;}
  async function journal(state){const row=await state.db.get('migration_journal',state.stageId);const value=validateCloudStageJournal(row);if(!equal(value.checkpoint,state.journal.checkpoint))throw cloudError('CLOUD_STAGE_JOURNAL');return value;}
  async function* pages(state,path){const progress=(await journal(state)).counts[path];for(let index=0;index<progress.pages;index++){await guard(state);const receipt=validateCloudPageReceipt(await state.db.get('import_receipts',[`qb-cloud-stage:${state.stageId}`,`${path}:${index}`]));const stored=await state.db.get('content_chunks',[receipt.provenance.storageDigest,0]);let bytes;if(receipt.provenance.utf8Bytes===0){if(stored||receipt.provenance.count!==0)throw cloudError('CLOUD_STAGE_READBACK');bytes=new Uint8Array();}else bytes=stored?.bytes;if(!bytes||bytes.length!==receipt.provenance.utf8Bytes||await sha256Hex(bytes)!==receipt.provenance.sha256||receipt.provenance.storageDigest!==await cloudTemporaryDigest(state.stageId,'page',`${path}:${index}`))throw cloudError('CLOUD_STAGE_READBACK');const text=decoder.decode(bytes);if(bytes.length&& !text.endsWith('\n'))throw cloudError('CLOUD_STAGE_READBACK');const records=bytes.length?text.slice(0,-1).split('\n').map(line=>JSON.parse(line)):[];const encoded=ndjson(records);if(records.length!==receipt.provenance.count||encoded.length!==bytes.length||!encoded.every((byte,i)=>byte===bytes[i]))throw cloudError('CLOUD_STAGE_READBACK');yield {records,bytes,receipt};}}
  async function beginCloudRecovery(input){
    const captured=ownedWriteInput(input);validateCloudCheckpoint(captured.checkpoint);localGuard();const {context,checkpoint,checkpointDigest}=captured;
    if(checkpoint.sections.reduce((sum,row)=>sum+row.utf8Bytes,0)>100*1024*1024||checkpoint.sections.reduce((sum,row)=>sum+row.count,0)>200000)throw cloudError('CLOUD_CHECKPOINT_BUDGET');
    if(!checkpoint.complete||context.owner.accountId!==trustedOwner.accountId||context.owner.accountGeneration!==trustedOwner.accountGeneration||checkpoint.generation!==trustedOwner.accountGeneration||context.logEpoch&&context.logEpoch!==checkpoint.logEpoch||await sha256Hex(canonicalBytes(checkpoint))!==checkpointDigest)throw cloudError('CLOUD_CHECKPOINT_BINDING');
    const active=await registry.readActive();localGuard();if(!active||active.profile.profileId!==context.profileId||active.pointer.activationRevision!==context.activationRevision)throw cloudError('STALE_ACTIVE_PROFILE');
    const state={context,checkpoint,checkpointDigest,active,stageId:crypto.randomUUID(),closed:false,renewMode:'ordinary'};const initialCut=await guard(state);state.renewToken=ownedWriteInput(initialCut.meta.find(row=>row.key==='syncCoordinatorLease').value);
    // This initial pointer is provenance only, not a business snapshot or a
    // Saved-cut capability. The held final merge captures actual latest rows.
    state.initialPointer=ownedWriteInput(active.pointer);await guard(state);
    let profile;try{profile=await allocatePreverificationSourceStage(registry);}catch(cause){const locator=consumePreverificationAllocationFailure(registry,cause);if(locator&&cause&&typeof cause==='object'&&Object.isExtensible(cause))cause.sourceAllocationDiagnostic=locator;throw cause;}state.profile=profile;
    try{localGuard();state.sourceRegistryBinding=await bindPreverificationSourceRegistry(registry,{stageProfileId:profile.profileId,sourceProfileId:context.profileId,owner:trustedOwner,originalPointer:state.active.pointer,context});await state.sourceRegistryBinding.check();state.journal=validateCloudStageJournal({migrationId:state.stageId,status:'RAW_SAVED',counts:Object.fromEntries(CLOUD_SECTION_PATHS.map(path=>[path,{pages:0,count:0,utf8Bytes:0}])),checkpoint:{format:'qb-cloud-recovery-stage-v1',owner:trustedOwner,profileId:profile.profileId,sourceProfileId:context.profileId,activationRevision:context.activationRevision,exportId:checkpoint.exportId,checkpointDigest,generation:checkpoint.generation,logEpoch:checkpoint.logEpoch,cloudCheckpoint:checkpoint}});state.db=await openCloudNativeDatabase({profile,signal,blockedTimeoutMs,guard:localGuard});await state.db.write({puts:[{store:'migration_journal',value:state.journal}]});await guard(state);const handle=Object.freeze({});handles.set(handle,state);const cancel=()=>{void abortCloudRecovery({handle,reasonCode:'CANCELLED'});};state.removeAbort=()=>signal?.removeEventListener('abort',cancel);signal?.addEventListener('abort',cancel,{once:true});return handle;}catch(cause){state.sourceRegistryBinding?.close();state.db?.close();await registry.quarantineRestore(profile.profileId).catch(()=>{});throw cause;}
  }
  async function stageCloudPage(input){
    const {handle,raw:captured}=capabilityInput(input),state=await checked(handle);const {section,index,records,sha256:digest}=captured;
    if(!CLOUD_SECTION_PATHS.includes(section)||!Number.isSafeInteger(index)||index<0||!Array.isArray(records)||records.length>100)throw cloudError('CLOUD_PAGE_INVALID');
    const sectionSummary=state.checkpoint.sections.find(row=>row.path===section);
    if(!records.length&&(sectionSummary.count!==0||index!==0)||sectionSummary.count===0&&records.length)throw cloudError('CLOUD_PAGE_EMPTY');
    const bytes=ndjson(records);if(await sha256Hex(bytes)!==digest)throw cloudError('CLOUD_PAGE_DIGEST');
    for(const row of records){if(['accepted-changes.ndjson','latest-state.ndjson','tombstones.ndjson'].includes(section)){validateChangeLogRecord(row);if(row.accountGeneration!==state.checkpoint.generation||BigInt(row.serverSeq)>BigInt(state.checkpoint.cut)||await sha256Hex(canonicalBytes({protocolVersion:2,kind:row.kind,entityKey:row.entityKey,payload:row.payload}))!==row.payloadDigest||section==='tombstones.ndjson'&&row.kind!=='entity_tombstone')throw cloudError('CLOUD_FACT_INVALID');}else if(section==='content-manifests.ndjson')validateChunkManifest(row);else if(section==='content-references.ndjson')validateCloudContentReference(row);else{if(Object.keys(row).sort().join()!=='mutation,receipt'||!await verifyMutationDigest(row.mutation))throw cloudError('CLOUD_RECEIPT_CORRUPT');validateMutationReceipt(row.receipt);await validateCloudReceipt({sourceId:`qb-cloud-receipt-v1:${state.checkpoint.generation}:${state.checkpoint.logEpoch}`,sourceRecordId:row.mutation.mutationId,importedAt:Date.now(),provenance:{format:'qb-cloud-receipt-v1',generation:state.checkpoint.generation,logEpoch:state.checkpoint.logEpoch,...row}},{generation:state.checkpoint.generation,logEpoch:state.checkpoint.logEpoch,cut:state.checkpoint.cut});}}
    const before=await journal(state),count=before.counts[section];if(index!==count.pages)throw cloudError('CLOUD_PAGE_SEQUENCE');
    const storageDigest=await cloudTemporaryDigest(state.stageId,'page',`${section}:${index}`),key=[storageDigest,0];if(await state.db.get('content_chunks',key))throw cloudError('CLOUD_STAGE_KEY_COLLISION');
    const receipt=validateCloudPageReceipt({sourceId:`qb-cloud-stage:${state.stageId}`,sourceRecordId:`${section}:${index}`,importedAt:Date.now(),provenance:{format:'qb-cloud-stage-page-v1',stageId:state.stageId,section,index,count:records.length,utf8Bytes:bytes.length,sha256:digest,storageDigest}});
    const indexes=await createCloudStageIndexes({stageId:state.stageId,section,pageIndex:index,records,pageSha256:digest,storageDigest,importedAt:receipt.importedAt});
    const uniqueKeys=new Set();for(const row of indexes){const label=row.sourceRecordId;if(uniqueKeys.has(label))throw cloudError('CLOUD_STAGE_INDEX_COLLISION');uniqueKeys.add(label);if(await state.db.get('import_receipts',[row.sourceId,label]))throw cloudError('CLOUD_STAGE_INDEX_COLLISION');}
    const after=ownedWriteInput(before);after.counts[section]={pages:index+1,count:count.count+records.length,utf8Bytes:count.utf8Bytes+bytes.length};validateCloudStageJournal(after);await guard(state);
    await state.db.write({conditions:[{store:'migration_journal',key:state.stageId,expected:before},{store:'content_chunks',key,expected:undefined},{store:'import_receipts',key:[receipt.sourceId,receipt.sourceRecordId],expected:undefined},...indexes.map(row=>({store:'import_receipts',key:[row.sourceId,row.sourceRecordId],expected:undefined}))],puts:[...(bytes.length?[{store:'content_chunks',value:{contentDigest:storageDigest,chunkIndex:0,bytes}}]:[]),{store:'import_receipts',value:receipt},...indexes.map(value=>({store:'import_receipts',value})),{store:'migration_journal',value:after}]});await guard(state);
    return {status:'staged',section,index};
  }
  async function readStagedContentManifest(input){const {handle,raw:{reference}}=capabilityInput(input);validateContentReference(reference);const state=await checked(handle);const source=await pointer(state).readPointer({sourceRecordId:`manifest:${reference.contentDigest}`,expected:{contentDigest:reference.contentDigest}});await guard(state);if(!source)throw cloudError('CLOUD_MANIFEST_MISSING');const manifest=source.value;validateChunkManifest(manifest);if(await sha256Hex(canonicalBytes(manifest))!==reference.manifestDigest||manifest.totalBytes!==reference.totalBytes||manifest.chunkCount!==reference.chunkCount)throw cloudError('CLOUD_MANIFEST_BINDING');return ownedWriteInput(manifest);}
  async function stageContentChunk(input){const {handle,raw:{reference,chunkIndex,bytes}}=capabilityInput(input);validateContentReference(reference);if(!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>512*1024||!Number.isSafeInteger(chunkIndex)||chunkIndex<0||chunkIndex>=reference.chunkCount)throw cloudError('CLOUD_CHUNK_INVALID');const state=await checked(handle),storageDigest=await cloudTemporaryDigest(state.stageId,'chunk',`${reference.contentDigest}:${chunkIndex}`);if(await state.db.get('content_chunks',[storageDigest,0]))throw cloudError('CLOUD_CHUNK_DUPLICATE');await guard(state);await state.db.write({conditions:[{store:'content_chunks',key:[storageDigest,0],expected:undefined}],puts:[{store:'content_chunks',value:{contentDigest:storageDigest,chunkIndex:0,bytes}}]});await guard(state);return {status:'staged',chunkIndex};}
  async function finishVerifiedContent(input){const {handle,raw:{reference,manifest}}=capabilityInput(input);validateContentReference(reference);validateChunkManifest(manifest);const state=await checked(handle);if(manifest.contentDigest!==reference.contentDigest||manifest.totalBytes!==reference.totalBytes||manifest.chunkCount!==reference.chunkCount||await sha256Hex(canonicalBytes(manifest))!==reference.manifestDigest)throw cloudError('CLOUD_MANIFEST_BINDING');
    if(reference.totalBytes>3*1024*1024)return finishLargeRegisteredBody(state,reference,manifest);
    const hash=sha256.create(),parts=[];let total=0;for(const chunk of manifest.chunks){const digest=await cloudTemporaryDigest(state.stageId,'chunk',`${reference.contentDigest}:${chunk.chunkIndex}`),bytes=(await state.db.get('content_chunks',[digest,0]))?.bytes;if(!bytes||bytes.length!==chunk.byteLength||await sha256Hex(bytes)!==chunk.sha256)throw cloudError('CLOUD_CHUNK_READBACK');hash.update(bytes);total+=bytes.length;parts.push(bytes);}if(total!==reference.totalBytes||hex(hash.digest())!==reference.contentDigest)throw cloudError('CLOUD_CONTENT_DIGEST');
    // Large semantic parsing is not falsely certified by a raw hash. The
    // forthcoming bounded streaming semantic reader must pass the same gate.
    if(total>3*1024*1024)throw cloudError('CLOUD_STREAMING_SEMANTICS_UNAVAILABLE');const bytes=new Uint8Array(total);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}const value=JSON.parse(decoder.decode(bytes));if(!byteEqual(canonicalContentBytes(value),bytes))throw cloudError('CLOUD_NONCANONICAL_CONTENT');
    if(value?.format==='qb-bank-content-v2')await validateBankContent(value);else if(value?.format==='qb-protected-bank-envelope-v2')await validateProtectedBankEnvelopeV2(value);
    let sourceCount=0;
    for await(const row of pointer(state).sources({prefix:`content:${reference.contentDigest}:`,expected:{contentDigest:reference.contentDigest}})){sourceCount++;validateCloudContentReference(row);const accepted=await pointer(state).readPointer({sourceRecordId:`seq:${row.sourceChange.serverSeq.padStart(20,'0')}`,expected:{kind:row.sourceChange.kind,entityKey:row.sourceChange.entityKey,serverSeq:row.sourceChange.serverSeq,payloadDigest:row.sourceChange.payloadDigest}});await guard(state);if(!equal(row.reference,reference)||!accepted||!equal(accepted.value,row.sourceChange))throw cloudError('CLOUD_CONTENT_SOURCE_MISSING');if(row.provenance.kind==='frozen_public_static')await verifyFrozenCloudPublicReference(row);const change=row.sourceChange,p=change.payload;
      if(change.kind==='bank_revision'){if(p.revision!==reference.contentDigest)throw cloudError('CLOUD_BANK_BINDING');if(p.contentManifest.kind==='protected_cipher'){const verified=await validateProtectedBankEnvelopeV2(value);if(verified.envelope.bankUid!==p.bankUid||verified.contentDigest!==p.revision||p.metadata.visibility!=='protected'||p.metadata.questionCount!==verified.questionRefs.length)throw cloudError('CLOUD_BANK_BINDING');}else{const verified=await validateBankContent(value);if(verified.content.bankUid!==p.bankUid||!equal(verified.content.metadata,p.metadata)||verified.contentDigest!==p.revision)throw cloudError('CLOUD_BANK_BINDING');}}
      else if(change.kind==='attempt_scope'){let attempt;const entityHash=await sha256Hex(canonicalBytes(`attempt:${p.attemptId}`));for await(const manifestChange of pointer(state).sources({prefix:`entity:attempt_manifest:${entityHash}:`,expected:{kind:'attempt_manifest',entityKey:`attempt:${p.attemptId}`}})){await guard(state);if(BigInt(manifestChange.serverSeq)>=BigInt(change.serverSeq))break;attempt=manifestChange.payload;}if(!attempt||attempt.scopeDigest!==p.scopeDigest)throw cloudError('CLOUD_SCOPE_BINDING');validateAttemptScope(value,p.attemptId,attempt.scopeCount);if(await sha256Hex(canonicalContentBytes(value))!==p.scopeDigest)throw cloudError('CLOUD_SCOPE_BINDING');}
      else if(change.kind==='resume_state'){validateResumeState(value);if(value.attemptId!==p.attemptId||value.localRevision!==p.localRevision||value.writerStreamId!==p.writerStreamId||value.baseRevision!==p.baseRevision)throw cloudError('CLOUD_RESUME_BINDING');}
      else if(change.kind==='history_snapshot'){await validateHistorySnapshotBinding(p,value,{accountGeneration:state.checkpoint.generation});}
      else if(change.kind!=='content_manifest')throw cloudError('CLOUD_CONTENT_KIND');
    }
    const puts=manifest.chunks.map((chunk,index)=>({store:'content_chunks',value:{contentDigest:reference.contentDigest,chunkIndex:chunk.chunkIndex,bytes:parts[index]}}));puts.push({store:'content_chunks',value:{contentDigest:reference.manifestDigest,chunkIndex:0,bytes:canonicalBytes(manifest)}});for(const put of puts){const prior=await state.db.get('content_chunks',[put.value.contentDigest,put.value.chunkIndex]);if(prior&&!byteEqual(prior.bytes,put.value.bytes))throw cloudError('CLOUD_CONTENT_COLLISION');}await guard(state);await state.db.write({puts});
    if(!sourceCount)throw cloudError('CLOUD_CONTENT_SOURCE_MISSING');
    // Body/source membership only. Genuine distinct-target indexed D12 and
    // all-19-store clean closure are mandatory before final one-use proof.
    await guard(state);return {status:'typed_body_candidate',reference,fullDependencyClosure:false};
  }
  async function finishLargeRegisteredBody(state,reference,manifest){
    // Only the actual registered public bank stream is supported here. Large
    // private/cipher/scope/resume bodies retain their explicit domain refusal.
    async function* chunks(){for(const part of manifest.chunks){await guard(state);const key=await cloudTemporaryDigest(state.stageId,'chunk',`${reference.contentDigest}:${part.chunkIndex}`),row=await state.db.get('content_chunks',[key,0]);await guard(state);if(!row?.bytes||row.bytes.length!==part.byteLength||await sha256Hex(row.bytes)!==part.sha256)throw cloudError('CLOUD_CHUNK_READBACK');yield row.bytes;}}
    if(state.sourceStringActive)throw cloudError('CLOUD_SOURCE_STRING_BUSY');
    state.sourceStringActive=true;let entry,streamer,body,firstError,hasFirstError=false;
    try{
      await guard(state);const capturedProfile=await registry.readProfile(state.profile.profileId),capturedJournal=await journal(state);await guard(state);
      if(!capturedProfile||!equal(capturedProfile,state.profile)||capturedProfile.state!=='staged'||capturedProfile.profileId===state.active.profile.profileId)throw cloudError('CLOUD_SOURCE_STAGE_INVALID');
      const capability=Object.freeze({});
      const assertLive=()=>{localGuard();state.sourceRegistryBinding.assertLive();if(state.closed||!state.sourceStringActive||state.checkpoint.expiresAt<=Date.now())throw cloudError('CLOSED');};
      const check=async()=>{assertLive();await guard(state);const currentProfile=await registry.readProfile(state.profile.profileId),currentJournal=await journal(state);assertLive();if(!equal(currentProfile,capturedProfile)||!equal(currentJournal,capturedJournal))throw cloudError('CLOUD_SOURCE_STAGE_CHANGED');await guard(state);};
      const metadata=ownedWriteInput({owner:trustedOwner,stageProfileId:state.profile.profileId,stageId:state.stageId,originalPointer:state.active.pointer,checkpoint:state.checkpoint,checkpointDigest:state.checkpointDigest});
      entry={state,live:true,assertLive,access:Object.freeze({check,metadata:async()=>{await check();return ownedWriteInput(metadata);}})};preverificationSourceStages.set(capability,entry);
      streamer=await state.db.createSourceBankStreamer(capability);await check();body=await streamer.stream({chunks:chunks(),reference,signal,onQuestion:async()=>{await check();}});await check();
    }catch(cause){firstError=cause;hasFirstError=true;throw cause;}finally{
      try{if(streamer){const cleaned=await streamer.cleanup();if(cleaned?.status!=='source_string_workspace_cleaned')throw cloudError('CLOUD_SOURCE_STRING_CLEANUP_FAILED');}}
      catch(cleanupError){if(hasFirstError){if(firstError&&typeof firstError==='object'&&Object.isExtensible(firstError)){firstError.cleanupRequired=true;firstError.cleanupError=cleanupError.code||'CLOUD_SOURCE_STRING_CLEANUP_FAILED';}}else throw cleanupError;}
      finally{streamer?.close();if(entry)entry.live=false;state.sourceStringActive=false;}
    }
    await guard(state);
    if(body.metadata.visibility!=='public')throw cloudError('CLOUD_STREAMING_SEMANTICS_UNAVAILABLE');
    let count=0;for await(const row of pointer(state).sources({prefix:`content:${reference.contentDigest}:`,expected:{contentDigest:reference.contentDigest}})){await guard(state);validateCloudContentReference(row);const accepted=await pointer(state).readPointer({sourceRecordId:`seq:${row.sourceChange.serverSeq.padStart(20,'0')}`,expected:{kind:row.sourceChange.kind,entityKey:row.sourceChange.entityKey,serverSeq:row.sourceChange.serverSeq,payloadDigest:row.sourceChange.payloadDigest}});await guard(state);if(!accepted||!equal(accepted.value,row.sourceChange)||!equal(row.reference,reference))throw cloudError('CLOUD_CONTENT_SOURCE_MISSING');if(row.provenance.kind==='frozen_public_static')await verifyFrozenCloudPublicReference(row);const change=row.sourceChange,p=change.payload;if(change.kind==='bank_revision'){if(p.contentManifest.kind==='protected_cipher'||p.bankUid!==body.bankUid||p.revision!==body.contentDigest||!equal(p.metadata,body.metadata))throw cloudError('CLOUD_BANK_BINDING');}else if(change.kind!=='content_manifest')throw cloudError('CLOUD_STREAMING_SEMANTICS_UNAVAILABLE');count++;}
    if(!count)throw cloudError('CLOUD_CONTENT_SOURCE_MISSING');
    // Each <=512KiB real chunk is independently conditional; no whole body or
    // accumulated chunk array enters memory/the native write wrapper.
    let index=0;for await(const bytes of chunks()){const value={contentDigest:reference.contentDigest,chunkIndex:index++,bytes},key=[value.contentDigest,value.chunkIndex],old=await state.db.get('content_chunks',key);await guard(state);if(old&&!byteEqual(old.bytes,bytes))throw cloudError('CLOUD_CONTENT_COLLISION');if(!old)await state.db.write({conditions:[{store:'content_chunks',key,expected:undefined}],puts:[{store:'content_chunks',value}]});}
    const value={contentDigest:reference.manifestDigest,chunkIndex:0,bytes:canonicalBytes(manifest)},key=[value.contentDigest,0],old=await state.db.get('content_chunks',key);await guard(state);if(old&&!byteEqual(old.bytes,value.bytes))throw cloudError('CLOUD_CONTENT_COLLISION');if(!old)await state.db.write({conditions:[{store:'content_chunks',key,expected:undefined}],puts:[{store:'content_chunks',value}]});await guard(state);return {status:'typed_body_candidate',reference,fullDependencyClosure:false};
  }
  async function finishCloudRecovery(input){
    const {handle,raw}=capabilityInput(input);if(Object.keys(raw).join()!=='cursorReset')throw cloudError('INVALID_INPUT');
    const {cursorReset}=raw;validateCursorReset(cursorReset);const state=await checked(handle),checkpoint=state.checkpoint;
    if(cursorReset.generation!==checkpoint.generation||cursorReset.logEpoch!==checkpoint.logEpoch||cursorReset.exportCut!==checkpoint.cut||cursorReset.resetExportId!==checkpoint.exportId||cursorReset.manifestDigest!==state.checkpointDigest||cursorReset.expiresAt!==checkpoint.expiresAt||cursorReset.pageUrl!=='/api/v2/export/page')throw cloudError('CLOUD_RESET_BINDING');
    // Genuine complete S1 reread mints only source membership, never Ready.
    const sourceCapability=await prepareCheckpointProjection({handle,cursorReset});await guard(state);
    const target=await registry.createRestoreStage();await guard(state);
    let activated=false;
    // Stop issuing ordinary shared-lock renewals before requesting exclusive.
    // An already started renewal must complete first; waiting timers route only
    // after the genuine held capability has installed its native CAS method.
    const oldRenew=state.renewFlight;state.renewMode='waiting';
    state.renewRouteReady=new Promise((resolve,reject)=>{state.resolveRenewRoute=resolve;state.rejectRenewRoute=reject;});state.renewRouteReady.catch(()=>{});
    try{
      if(oldRenew)await oldRenew;
      return await registry.withActivationLock(async access=>{
        state.finalPhase='held-lease-bind';
        await access.bindCheckpointSourceLease({sourceCapability});
        state.heldRenew=()=>access.renewCheckpointSourceLease();
        state.renewToken=await state.heldRenew();state.renewMode='held';state.resolveRenewRoute();
        await guard(state);const actual=await access.readActive();if(!equal(actual,state.active))throw cloudError('STALE_ACTIVE_PROFILE');
        state.readHeldDiagnostics=()=>access.readRecoveryDiagnostics({profileId:target.profileId});state.finalPhase='project';await access.projectCheckpointFromStage({sourceCapability,targetProfileId:target.profileId});await guard(state);
        state.finalPhase='latest-saved-merge';await access.mergeLatestLocal({profileId:target.profileId});await guard(state);
        const reader=await access.createFinalReader({profileId:target.profileId});state.finalReader=reader;await guard(state);
        let pending=0,conflicts=0,clientStreamId;for await(const row of reader.records('outbox')){pending++;await guard(state);}for await(const row of reader.records('conflicts')){if(row.status==='open')conflicts++;await guard(state);}for await(const row of reader.records('meta')){if(row.key==='clientStreamId')clientStreamId=row.value;await guard(state);}
        // Static trusted full closure performs cleanup, independent clean19
        // readback and one-use binding. No DTO/summary substitutes for it.
        state.finalPhase='full-proof';const proof=await reader.createFinalBundleProof();await guard(state);
        state.finalPhase='control-commit';let complete;
        try{complete=await access.commitFinalBundle({profileId:target.profileId,proof});}catch(cause){
          cause.cloudRecoveryPhase='control-commit';
          if(isFinalControlCommitError(cause,target.profileId)){
            activated=true;state.activated=true;state.activatedProfileId=target.profileId;
            await cleanupCommittedSource(state,access,target.profileId);
            cause.recoveryCommitted=true;if(state.cleanupRequired){cause.cleanupRequired=true;cause.cleanupError=state.cleanupError;}
            try{notifyCommitted(state);}catch{}
          }throw cause;
        }
        activated=true;state.activated=true;state.activatedProfileId=target.profileId;
        const cleanup=await cleanupCommittedSource(state,access,target.profileId);
        notifyCommitted(state);
        const result={status:'complete',...complete,...cleanup,pending,conflicts,...(clientStreamId?{clientStreamId}:{}),capacityQualified:false};committedRecoveryResults.add(result);return result;
      });
    }catch(cause){
      if(cause&&typeof cause==='object')cause.cloudRecoveryPhase??=state.finalPhase??'exclusive-wait';
      if(!activated&&isFinalControlCommitError(cause,target.profileId)){
        // Only registry's private real tx.done witness is authoritative. A
        // caller-thrown recoveryCommitted flag cannot suppress quarantine.
        activated=true;state.activated=true;state.activatedProfileId=target.profileId;
        state.cleanupRequired=true;state.cleanupError='CLOUD_CLEANUP_HELD_ACCESS_RELEASED';
        try{notifyCommitted(state);}catch{}
      }
      if(!activated){await registry.quarantineRestore(target.profileId).catch(()=>{});state.closed=true;state.removeAbort?.();state.sourceRegistryBinding?.close();state.db.close();}
      else {cause.recoveryCommitted=true;if(state.cleanupRequired){cause.cleanupRequired=true;cause.cleanupError=state.cleanupError;}}
      throw cause;
    }finally{
      state.renewMode='terminal';state.heldRenew=null;state.rejectRenewRoute?.(cloudError('CLOUD_HANDLE_CLOSED'));
    }
  }
  async function prepareCheckpointProjection(input){
    const {handle,raw}=capabilityInput(input);if(Object.keys(raw).join()!=='cursorReset')throw cloudError('CLOUD_RESET_REQUIRED');
    const cursorReset=validateCursorReset(raw.cursorReset),state=await checked(handle),checkpoint=state.checkpoint;
    if(cursorReset.generation!==checkpoint.generation||cursorReset.logEpoch!==checkpoint.logEpoch||cursorReset.exportCut!==checkpoint.cut||cursorReset.resetExportId!==checkpoint.exportId||cursorReset.manifestDigest!==state.checkpointDigest||cursorReset.expiresAt!==checkpoint.expiresAt||cursorReset.pageUrl!=='/api/v2/export/page')throw cloudError('CLOUD_RESET_BINDING');
    if(state.projectionReset&&!equal(state.projectionReset,cursorReset))throw cloudError('CLOUD_RESET_BINDING');
    if(state.projectionFlight)return state.projectionFlight;state.projectionReset=ownedWriteInput(cursorReset);
    state.projectionFlight=(async()=>{
      let accepted=0n,latestCount=0,tombstoneCount=0;
      for(const path of CLOUD_SECTION_PATHS){const hash=sha256.create();let count=0,total=0;
        for await(const page of pages(state,path)){await guard(state);hash.update(page.bytes);count+=page.records.length;total+=page.bytes.length;
          for(const row of page.records)if(path==='accepted-changes.ndjson'){validateChangeLogRecord(row);if(BigInt(row.serverSeq)!==++accepted||row.accountGeneration!==state.checkpoint.generation||await sha256Hex(canonicalBytes({protocolVersion:2,kind:row.kind,entityKey:row.entityKey,payload:row.payload}))!==row.payloadDigest)throw cloudError('CLOUD_LOG_GAP');const latest=await pointer(state).lastEntitySource({kind:row.kind,entityKey:row.entityKey});await guard(state);if(!latest)throw cloudError('CLOUD_LATEST_STATE');if(latest.value.serverSeq===row.serverSeq){latestCount++;if(row.kind==='entity_tombstone')tombstoneCount++;}}}
        const expected=state.checkpoint.sections.find(row=>row.path===path);if(count!==expected.count||total!==expected.utf8Bytes||hex(hash.digest())!==expected.sha256)throw cloudError('CLOUD_SECTION_DIGEST');}
      if(accepted!==BigInt(state.checkpoint.cut))throw cloudError('CLOUD_LOG_GAP');
      let checkedLatest=0,checkedTombstones=0;for await(const page of pages(state,'latest-state.ndjson'))for(const row of page.records){const last=await pointer(state).lastEntitySource({kind:row.kind,entityKey:row.entityKey});await guard(state);if(!last||!equal(last.value,row))throw cloudError('CLOUD_LATEST_STATE');checkedLatest++;}if(checkedLatest!==latestCount)throw cloudError('CLOUD_LATEST_STATE');
      for await(const page of pages(state,'tombstones.ndjson'))for(const row of page.records){if(row.kind!=='entity_tombstone')throw cloudError('CLOUD_TOMBSTONE_PROOF');const last=await pointer(state).lastEntitySource({kind:row.kind,entityKey:row.entityKey});await guard(state);if(!last||!equal(last.value,row))throw cloudError('CLOUD_TOMBSTONE_PROOF');checkedTombstones++;}if(checkedTombstones!==tombstoneCount)throw cloudError('CLOUD_TOMBSTONE_PROOF');
      for await(const page of pages(state,'mutation-receipts.ndjson'))for(const row of page.records){let change;if(row.receipt.status!=='conflict'){const original=await pointer(state).readPointer({sourceRecordId:`seq:${row.receipt.serverSeq.padStart(20,'0')}`,expected:{serverSeq:row.receipt.serverSeq}});change=original?.value;if(!change)throw cloudError('CLOUD_RECEIPT_CHANGE');}await validateCloudReceipt({sourceId:`qb-cloud-receipt-v1:${state.checkpoint.generation}:${state.checkpoint.logEpoch}`,sourceRecordId:row.mutation.mutationId,importedAt:Date.now(),provenance:{format:'qb-cloud-receipt-v1',generation:state.checkpoint.generation,logEpoch:state.checkpoint.logEpoch,...row}},{generation:state.checkpoint.generation,logEpoch:state.checkpoint.logEpoch,cut:state.checkpoint.cut,change});await guard(state);}
      // Every source reference is semantically checked, even when its raw body
      // digest was shared by another sourceKind. No hash-only large-body pass.
      for await(const page of pages(state,'content-references.ndjson'))for(const row of page.records){validateCloudContentReference(row);if(!row.reference)throw cloudError('CLOUD_CONTENT_MISSING');let manifest;if(row.provenance.kind==='frozen_public_static'){const acceptedSource=await pointer(state).readPointer({sourceRecordId:`seq:${row.sourceChange.serverSeq.padStart(20,'0')}`,expected:{serverSeq:row.sourceChange.serverSeq}});await guard(state);if(!acceptedSource||!equal(acceptedSource.value,row.sourceChange))throw cloudError('CLOUD_PUBLIC_SOURCE_BINDING');await verifyFrozenCloudPublicReference(row);await guard(state);const stored=await state.db.get('content_chunks',[row.reference.manifestDigest,0]);await guard(state);manifest=await validateCanonicalStoredManifest(row.reference,stored?.bytes);await guard(state);}else manifest=await readStagedContentManifest({handle,reference:row.reference});await finishVerifiedContent({handle,reference:row.reference,manifest});}
      await guard(state);const originalJournal=await journal(state),capability=Object.freeze({});
      const check=async()=>{await guard(state);if(!equal(await journal(state),originalJournal))throw cloudError('CLOUD_PROJECTION_SOURCE_CHANGED');await guard(state);};
      const metadata=ownedWriteInput({owner:trustedOwner,sourceProfileId:state.active.profile.profileId,stageProfileId:state.profile.profileId,stageId:state.stageId,originalPointer:state.active.pointer,checkpoint:state.checkpoint,checkpointDigest:state.checkpointDigest,context:state.context,cursorReset:state.projectionReset});
      const access=Object.freeze({metadata:async()=>{await check();return ownedWriteInput(metadata);},check,
        readMutationReceipt:async mutationId=>{if(!isUuid(mutationId))throw cloudError('INVALID_INPUT');await check();const entry=await pointer(state).readPointer({sourceRecordId:`receipt:${mutationId}`,expected:{}});await check();if(!entry)return undefined;const row=ownedWriteInput(entry.value);if(Object.keys(row).sort().join()!=='mutation,receipt'||row.mutation.mutationId!==mutationId||row.receipt.mutationId!==mutationId||!await verifyMutationDigest(row.mutation))throw cloudError('CLOUD_RECEIPT_CORRUPT');validateMutationReceipt(row.receipt);await check();return row;},
        readAcceptedSource:async serverSeq=>{if(typeof serverSeq!=='string'||!/^[1-9][0-9]{0,19}$/.test(serverSeq)||BigInt(serverSeq)>BigInt(state.checkpoint.cut))throw cloudError('CLOUD_PROJECTION_SOURCE_CUT');await check();const row=await pointer(state).readPointer({sourceRecordId:`seq:${serverSeq.padStart(20,'0')}`,expected:{serverSeq}});await check();if(!row)throw cloudError('CLOUD_PROJECTION_SOURCE_MISSING');const p=row.index.provenance,page=validateCloudPageReceipt(await state.db.get('import_receipts',[`qb-cloud-stage:${state.stageId}`,`${p.section}:${p.pageIndex}`]));await check();if(row.index.importedAt!==page.importedAt)throw cloudError('CLOUD_PROJECTION_SOURCE_TIMESTAMP');return ownedWriteInput({change:row.value,importedAt:page.importedAt});},
        readAcceptedChange:async serverSeq=>(await access.readAcceptedSource(serverSeq)).change,
        async *referencesFor(change){const value=ownedWriteInput(change);validateChangeLogRecord(value);await check();const actual=await access.readAcceptedChange(value.serverSeq);if(!equal(actual,value))throw cloudError('CLOUD_PROJECTION_SOURCE_CHANGED');for await(const row of pointer(state).sources({prefix:`source:${value.serverSeq.padStart(20,'0')}:`,expected:{kind:value.kind,entityKey:value.entityKey,serverSeq:value.serverSeq,payloadDigest:value.payloadDigest}})){await check();if(!equal(row.sourceChange,value)||!row.reference)throw cloudError('CLOUD_CONTENT_SOURCE_MISSING');yield ownedWriteInput(row.reference);}},
        readContentChunk:async key=>{const captured=ownedWriteInput(key);if(!Array.isArray(captured)||captured.length!==2||typeof captured[0]!=='string'||!/^[a-f0-9]{64}$/.test(captured[0])||!Number.isSafeInteger(captured[1])||captured[1]<0)throw cloudError('INVALID_INPUT');await check();const row=await state.db.get('content_chunks',captured);await check();if(!row)throw cloudError('CLOUD_CONTENT_UNVERIFIED');return ownedWriteInput(row);}});
      projectionSources.set(capability,{assertLive:()=>{handleState(handle);localGuard();if(state.checkpoint.expiresAt<=Date.now())throw cloudError('CLOUD_CHECKPOINT_EXPIRED');},access});return capability;
    })();void state.projectionFlight.catch(()=>{});return state.projectionFlight;
  }
  async function abortCloudRecovery(input){const {handle,raw:{reasonCode}}=capabilityInput(input);if(typeof reasonCode!=='string'||!/^[A-Z][A-Z0-9_]{0,63}$/.test(reasonCode))throw cloudError('INVALID_INPUT');const state=handles.get(handle);if(!state)throw cloudError('CLOUD_HANDLE_CLOSED');if(state.activated){const result={status:'complete',profileId:state.activatedProfileId??state.profile.profileId,cleanupRequired:!!state.cleanupRequired,...(state.cleanupRequired?{cleanupError:state.cleanupError}:{})};committedRecoveryResults.add(result);return result;}state.closed=true;state.sourceRegistryBinding?.close();state.renewMode='terminal';state.heldRenew=null;state.rejectRenewRoute?.(cloudError('CLOUD_HANDLE_CLOSED'));state.removeAbort?.();state.db?.close();if(state.abortFlight)return state.abortFlight;state.abortFlight=(async()=>{try{await registry.quarantineRestore(state.profile.profileId);return {status:'quarantined',profileId:state.profile.profileId};}catch{return {status:'cleanup-incomplete',profileId:state.profile.profileId};}})();return state.abortFlight;}
  return Object.freeze({beginCloudRecovery,stageCloudPage,readStagedContentManifest,stageContentChunk,finishVerifiedContent,prepareCheckpointProjection,finishCloudRecovery,abortCloudRecovery,renewCloudRecoveryLease,readCloudRecoveryDiagnostics});
}
