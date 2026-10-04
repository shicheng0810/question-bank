import {APP_DATA_DB_SCHEMA_VERSION,canonicalBytes,sha256Hex,validateStoreRecord,validateDraftForAttempt,validateAnswerEvent,verifyMutationDigest,validateHistorySnapshotBinding,validateHistorySnapshotPayload,APP_DATA_STORES} from '../../domain/app-data/index.js';
import {sha256} from '@noble/hashes/sha2.js';
import {isUuid} from '../../domain/question/index.js';
import {snapshotOwner} from '../profiles/control-schema.js';
import {assertFinalProofWorkspace,assertFinalProofBinding} from '../profiles/managed-profile-registry.js';
import {createFinalDependencyReader} from './final-dependency-reader.js';
import {createBoundedNativeAccess,nativeRecordKey} from './bounded-native.js';
import {mutationWire,validateSyncChangeReceipt} from '../sync/protocol.js';
import {validateCloudReceipt} from './metadata.js';
import {validateStarResolutionReceipt} from '../sync/star-resolution.js';
import {STAR_GROUP_FORMAT,validateStarGroupResolutionReceipt} from '../sync/star-group-resolution.js';
import {validateForkOriginReceipt} from '../sync/fork-origin.js';
import {ownedWriteInput} from '../idb/write-input.js';
import {validateChunkManifest,validateContentReference} from '../../domain/app-data/index.js';
import {validateProtectedBankEnvelopeV2} from '../../domain/question/bank-content.js';
import {frozenPublicBanks as PUBLIC} from '../../domain/question/frozen-public-registry.js';
import {streamRegisteredBankContent,createNativeRegisteredBankStreamer} from './bank-content-stream.js';
import {validateNativeManifestV2} from './final-readback.js';
import {resolveImmutableBank} from '../history/immutable-bank-resolver.js';

const fail=code=>Object.assign(new Error(code),{code}),PAGE=1048576,ROW=3*PAGE;
const same=(a,b)=>{const x=canonicalBytes(a),y=canonicalBytes(b);return x.length===y.length&&x.every((v,i)=>v===y[i]);};
const hex=bytes=>Array.from(bytes,v=>v.toString(16).padStart(2,'0')).join('');
const TEMP=['qb-cloud-stage-page-v1','qb-cloud-stage-index-v1','qb-final-proof-index-v1','qb-final-proof-part-v1','qb-final-proof-reservation-v1'];
const terminalProofs=new WeakMap();

/** Static registry-only consume: token has no serializable authority. Delete
 * before any await/identity check, so failed consumption is one-use too. */
export async function consumeFinalBundleProof(token,database,binding){
 const state=terminalProofs.get(token);if(!state)throw fail('FINAL_TERMINAL_PROOF_INVALID');terminalProofs.delete(token);
 if(state.database!==database||state.binding!==binding||assertFinalProofBinding(state.workspace,database)!==binding)throw fail('FINAL_TERMINAL_PROOF_BINDING');
 await binding.check();const current=await binding.snapshot();if(!same(current,state.bindingSnapshot)||current.sourceVerified!==true)throw fail('FINAL_TERMINAL_PROOF_BINDING');
 const reread=await state.reread();await binding.check();if(!same(reread,state.clean))throw fail('FINAL_CLEAN_BUSINESS_CUT_MISMATCH');
 return ownedWriteInput({format:'qb-native-final-cut-proof-v1',businessCutFormat:'qb-native-business-cut-v1',businessCut:state.clean.cut,nativeSummary:state.clean.nativeSummary,bindingSnapshot:current,verifiedPerCut:true,capacityQualified:false});
}

// Pure one-row relationships, never a storage/full-bundle authority.
export function checkFinalBundleDraft(draft,attempt,scope){
 validateDraftForAttempt(draft,{attemptId:attempt.attemptId,...(attempt.parentAttemptId?{parentAttemptId:attempt.parentAttemptId}:{})});
 if(!scope||scope.questionKey!==draft.questionKey||scope.questionRevision!==draft.questionRevision||draft.writerStreamId!==attempt.writerStreamId||draft.localRevision>attempt.localRevision)throw fail('CORRUPT_ATTEMPT');
}
export function checkFinalBundleEvent(event,attempt,scope,actionSeq){
 validateAnswerEvent(event);
 if(event.attemptId!==attempt.attemptId||!scope||scope.questionKey!==event.questionKey||scope.questionRevision!==event.questionRevision||event.writerStreamId!==attempt.writerStreamId||event.actionSeq!==actionSeq)throw fail('CORRUPT_ATTEMPT');
}

/** UNIMPORTED candidate. Only a genuine private paired workspace can enter.
 * All summaries remain NoReady; the ordinary static reader's full gate remains
 * untouched. No caller facts, predicate callback, hash or Ready token exists.
 */
export async function createFinalBundleClosure(database,workspace){
 assertFinalProofWorkspace(workspace,database);
 const metadata=ownedWriteInput(await workspace.metadata()),owner=snapshotOwner(metadata.owner);assertFinalProofWorkspace(workspace,database);
 if(metadata.sourceId!==`qb-cloud-stage-index:${metadata.workspaceId}`||!isUuid(metadata.workspaceId))throw fail('FINAL_WORKSPACE_BINDING');
 let closed=false,failed=false,cleanAttempted=false;const pending=new Map(),bankStreamers=new Set();
 const guard=()=>{if(closed)throw fail('CLOSED');assertFinalProofWorkspace(workspace,database);};
 const check=async()=>{guard();await workspace.check();guard();};
 const reader=await createFinalDependencyReader(database,{owner,guard,proofWorkspace:workspace});
 let native;try{native=await createBoundedNativeAccess(database,{guard});guard();}catch(cause){reader.close();native?.close();throw cause;}
 const close=()=>{if(closed)return;closed=true;database.removeEventListener('versionchange',close);for(const [tx,reject]of pending){try{tx.abort();}catch{}reject(fail('FINAL_NATIVE_NOT_COMMITTED'));}pending.clear();for(const streamer of bankStreamers)streamer.close();bankStreamers.clear();reader.close();native.close();};database.addEventListener('versionchange',close);
 const get=async(store,key)=>{await check();const [row]=await native.readKeys([{store,key}]);if(row!==undefined&&indexedDB.cmp(nativeRecordKey(store,row),key)!==0)throw fail('BACKUP_DUPLICATE_RECORD');await check();return row;};
 const readIndex=async label=>{await check();const row=await workspace.readIndex({label});await check();return row?.provenance.value||null;};
const putIndexes=async rows=>{if(!rows.length)return;const labels=rows.map(row=>row.label);if(rows.length>100||new Set(labels).size!==labels.length)throw fail('FINAL_SOURCE_INDEX_CORRUPT');await check();const old=await workspace.readIndexes({labels});await check();if(!Array.isArray(old)||old.length!==rows.length)throw fail('FINAL_SOURCE_INDEX_CORRUPT');const additions=[];for(let i=0;i<rows.length;i++){if(old[i]){if(!same(old[i].provenance.value,rows[i].value))throw fail('FINAL_SOURCE_INDEX_CORRUPT');}else additions.push(rows[i]);}if(additions.length){await check();await workspace.writeIndexes({rows:additions});await check();}const actual=await workspace.readIndexes({labels});await check();if(!Array.isArray(actual)||actual.length!==rows.length)throw fail('FINAL_SOURCE_INDEX_CORRUPT');for(let i=0;i<rows.length;i++){if(!actual[i]||!same(actual[i].provenance.value,rows[i].value)||old[i]&&!same(old[i],actual[i]))throw fail('FINAL_SOURCE_INDEX_CORRUPT');}};
 const putIndex=async(label,value)=>{const old=await readIndex(label);if(old!==null){if(!same(old,value))throw fail('FINAL_SOURCE_INDEX_CORRUPT');return;}await check();await workspace.writeIndexes({rows:[{label,value}]});await check();const actual=await readIndex(label);if(actual===null||!same(actual,value))throw fail('FINAL_SOURCE_INDEX_CORRUPT');};

 // Nonunique secondary-index continuation includes the primary key. No getAll
 // or repeated whole-store scan is used for each attempt.
 async function* indexedRows(store,index,range){let after=null;do{
  await check();const page=await new Promise((resolve,reject)=>{let tx,timer,done=false,result;const rows=[];let bytes=64,last=null;
   const finish=cause=>{if(done)return;done=true;clearTimeout(timer);pending.delete(tx);cause?reject(cause):resolve(result);};
   const abort=cause=>{try{tx?.abort();}catch{}finish(cause);};
   try{guard();tx=database.transaction(store,'readonly');pending.set(tx,finish);tx.oncomplete=()=>finish();tx.onabort=()=>finish(fail('FINAL_NATIVE_NOT_COMMITTED'));tx.onerror=()=>{};timer=setTimeout(()=>abort(fail('FINAL_NATIVE_NOT_COMMITTED')),5000);
    const bound=after===null?range:IDBKeyRange.bound(after.indexKey,range.upper,false,range.upperOpen),request=tx.objectStore(store).index(index).openCursor(bound);request.onerror=()=>abort(fail('FINAL_NATIVE_NOT_COMMITTED'));
    request.onsuccess=()=>{try{guard();const c=request.result;if(!c){result={rows,after:null};return;}if(after&&indexedDB.cmp(c.key,after.indexKey)===0){const compared=indexedDB.cmp(c.primaryKey,after.primaryKey);if(compared<0){c.continuePrimaryKey(after.indexKey,after.primaryKey);return;}if(compared===0){c.continue();return;}}
     if(rows.length===100){result={rows,after:last};return;}const row=c.value;validateStoreRecord(store,row);if(indexedDB.cmp(nativeRecordKey(store,row),c.primaryKey)!==0)throw fail('BACKUP_DUPLICATE_RECORD');const size=canonicalBytes(row).length;if(size>ROW)throw fail('FINAL_NATIVE_ROW_BUDGET');if(rows.length&&bytes+size>PAGE){result={rows,after:last};return;}rows.push(row);bytes+=size;last={indexKey:ownedWriteInput(c.key),primaryKey:ownedWriteInput(c.primaryKey)};if(bytes>PAGE){result={rows,after:last};return;}c.continue();
    }catch(cause){abort(cause);}};
   }catch(cause){abort(cause);}
  });await check();for(const row of page.rows)yield row;after=page.after;
 }while(after!==null);}

 async function scopeFor(attemptId,key){const pointer=await workspace.readIndex({label:`scope:${attemptId}:representative:${key}`});await check();const value=pointer?.provenance.value;if(!value)throw fail('CORRUPT_ATTEMPT');const scope=await get('attempt_scope',[attemptId,value.ordinal]);if(!scope||await sha256Hex(canonicalBytes(scope))!==value.rowDigest)throw fail('FINAL_SOURCE_INDEX_CORRUPT');await check();return scope;}
 async function verifyBundle(attempt){
  const semantic=await reader.verifyAttemptSemantics(attempt.attemptId);await check();let drafts=0,events=0;
  for await(const draft of indexedRows('drafts','attemptId',IDBKeyRange.only(attempt.attemptId))){checkFinalBundleDraft(draft,attempt,await scopeFor(attempt.attemptId,draft.questionKey));drafts++;}
  for await(const event of indexedRows('answer_events','attemptAction',IDBKeyRange.bound([attempt.attemptId,attempt.writerStreamId,0],[attempt.attemptId,attempt.writerStreamId,Number.MAX_SAFE_INTEGER]))){checkFinalBundleEvent(event,attempt,await scopeFor(attempt.attemptId,event.questionKey),++events);}
  // Count the entire attemptId index too: wrong-writer rows must not disappear
  // merely because the correctly ordered writer range excluded them.
  let allEvents=0;for await(const event of indexedRows('answer_events','attemptId',IDBKeyRange.only(attempt.attemptId))){if(event.writerStreamId!==attempt.writerStreamId)throw fail('CORRUPT_ATTEMPT');allEvents++;}
  if(events!==allEvents||events!==attempt.actionSeq)throw fail('CORRUPT_ATTEMPT');
  const current=await get('attempts',attempt.attemptId);if(!current||!same(current,attempt))throw fail('FINAL_SOURCE_INDEX_CORRUPT');
  return {drafts,events,contentDigest:semantic.contentDigest};
 }

 async function indexOwnedParts(){
  for await(const row of reader.records('import_receipts'))if(row.sourceId===metadata.sourceId&&row.provenance?.format==='qb-final-proof-part-v1'){
   const p=row.provenance;if(p.workspaceId!==metadata.workspaceId||row.sourceRecordId!==`part:${p.label}`)throw fail('FINAL_SOURCE_INDEX_CORRUPT');
   const actual=await workspace.readPart({label:p.label});await check();if(actual.length!==p.byteLength||await sha256Hex(actual)!==p.sha256)throw fail('FINAL_SOURCE_INDEX_CORRUPT');
   await putIndex(`closure:ownedPart:${p.contentDigest}`,{label:p.label,contentDigest:p.contentDigest,byteLength:p.byteLength,sha256:p.sha256});
  }
 }
 async function ownedChunk(row){const p=await readIndex(`closure:ownedPart:${row.contentDigest}`);if(!p)return false;const derived=await sha256Hex(canonicalBytes({format:'qb-final-proof-part-key-v1',workspaceId:metadata.workspaceId,label:p.label}));if(derived!==row.contentDigest||p.contentDigest!==row.contentDigest||row.chunkIndex!==0||row.bytes.length!==p.byteLength||await sha256Hex(row.bytes)!==p.sha256)throw fail('FINAL_SOURCE_INDEX_CORRUPT');const bytes=await workspace.readPart({label:p.label});await check();if(bytes.length!==row.bytes.length||!bytes.every((v,i)=>v===row.bytes[i]))throw fail('FINAL_SOURCE_INDEX_CORRUPT');return true;}
 async function* sources(){for await(const row of reader.records('mutations'))yield row;for await(const row of reader.records('import_receipts'))if(row.provenance?.format==='qb-sync-change-v1')yield (await validateSyncChangeReceipt(row)).provenance.change;}
 async function bankReference(bank){
  if(bank.contentManifest.kind==='unavailable')throw fail('BACKUP_CONTENT_MISSING');let reference=bank.contentManifest.reference;
  if(bank.metadata.visibility==='public'){const known=PUBLIC.find(r=>r.bankUid===bank.bankUid&&r.revision===bank.revision);if(!known||!same(known.metadata,bank.metadata)||!same(known.contentManifest,bank.contentManifest))throw fail('UNTRUSTED_PUBLIC_REFERENCE');reference=known.publicContentReference;}
  if(!reference){const indexed=await readIndex(`closure:content:${bank.contentManifest.contentDigest}`);if(!indexed)throw fail('BACKUP_CONTENT_MISSING');reference=indexed.reference;}
  validateContentReference(reference);if(reference.contentDigest!==bank.revision)throw fail('BACKUP_BANK_BINDING');return reference;
 }
 async function verifyPhysicalBank(bank){
  const originalDigest=await sha256Hex(canonicalBytes(bank)),reference=await bankReference(bank),raw=await get('content_chunks',[reference.manifestDigest,0]);if(!raw||await sha256Hex(raw.bytes)!==reference.manifestDigest)throw fail('BACKUP_CONTENT_MISSING');
  const manifest=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw.bytes));validateChunkManifest(manifest);const canonicalManifest=canonicalBytes(manifest);if(canonicalManifest.length!==raw.bytes.length||!raw.bytes.every((v,i)=>canonicalManifest[i]===v)||manifest.contentDigest!==reference.contentDigest||manifest.totalBytes!==reference.totalBytes||manifest.chunkCount!==reference.chunkCount)throw fail('BACKUP_CONTENT_DIGEST');
  async function* chunks(){for(const part of manifest.chunks){const row=await get('content_chunks',[reference.contentDigest,part.chunkIndex]);if(!row||row.bytes.length!==part.byteLength||await sha256Hex(row.bytes)!==part.sha256)throw fail('BACKUP_CONTENT_DIGEST');await check();yield row.bytes;}}
  let verified;
  let members=[],memberBytes=0;const flushMembers=async()=>{if(!members.length)return;await putIndexes(members);members=[];memberBytes=0;};const member=async ref=>{const row={label:`closure:bankMember:${bank.bankUid}:${bank.revision}:${ref.questionKey}`,value:ref},size=canonicalBytes(row).length+2048;if(size>PAGE)throw fail('FINAL_BANK_MEMBERSHIP_INDEX_BUDGET');if(members.length&&(members.length===100||memberBytes+size>PAGE))await flushMembers();members.push(row);memberBytes+=size;};
  if(bank.contentManifest.kind==='protected_cipher'){
   if(reference.totalBytes>ROW)throw fail('protected_cipher_limit');const bytes=new Uint8Array(reference.totalBytes);let offset=0;for await(const chunk of chunks()){bytes.set(chunk,offset);offset+=chunk.length;}if(offset!==bytes.length||await sha256Hex(bytes)!==reference.contentDigest)throw fail('BACKUP_CONTENT_DIGEST');const envelope=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));verified=await validateProtectedBankEnvelopeV2(envelope);if(verified.bytes.length!==bytes.length||!bytes.every((v,i)=>verified.bytes[i]===v)||verified.envelope.bankUid!==bank.bankUid||verified.contentDigest!==bank.revision||verified.questionRefs.length!==bank.metadata.questionCount)throw fail('BACKUP_BANK_BINDING');
   for(const ref of verified.questionRefs)await member(ref);
  }else{if(reference.totalBytes>ROW&&bank.metadata.visibility!=='public')throw fail('bank_content_limit');const input={chunks:chunks(),reference,onQuestion:member};if(reference.totalBytes>ROW){const streamer=await createNativeRegisteredBankStreamer(database,workspace);bankStreamers.add(streamer);try{await check();verified=await streamer.stream(input);await check();}finally{streamer.close();bankStreamers.delete(streamer);}}else verified=await streamRegisteredBankContent(input);if(verified.bankUid!==bank.bankUid||verified.contentDigest!==bank.revision||!same(verified.metadata,bank.metadata))throw fail('BACKUP_BANK_BINDING');}
  await flushMembers();
  const current=await get('bank_revisions',[bank.bankUid,bank.revision]);if(!current||await sha256Hex(canonicalBytes(current))!==originalDigest)throw fail('FINAL_SOURCE_INDEX_CORRUPT');await check();return verified.proofClass;
 }
 async function verifyHistorySnapshot(change){
  const payload=validateHistorySnapshotPayload(change.payload);
  if(owner.ownerKind!=='account'||payload.accountGeneration!==owner.accountGeneration||change.entityKey!==`history_snapshot:${payload.snapshotId}`)throw fail('BACKUP_OWNER_MISMATCH');
  const body=(await reader.readContent(payload.reference)).value;
  await validateHistorySnapshotBinding(payload,body,{accountGeneration:owner.accountGeneration});await check();
  const stored=await get('history_snapshots',payload.snapshotId),tombstone=await get('entity_tombstones',change.entityKey);
  if(stored&&!same(stored,payload)||!stored&&tombstone?.status!=='confirmed')throw fail('BACKUP_HISTORY_SNAPSHOT_DEPENDENCY');
  return body;
 }
 async function verifyHistorySnapshotBankReferences(body,{bankSources,contentSources,resolvedBanks}){
  const requirements=new Map();
  for(const item of body.scope)for(const ref of item.equivalentSourceRefs){
   const bankUid=ref.questionKey.split('/')[0],label=`closure:bankMember:${bankUid}:${ref.bankRevision}:${ref.questionKey}`;
   const prior=requirements.get(label);if(prior&&prior.questionRevision!==ref.questionRevision)throw fail('BACKUP_HISTORY_SNAPSHOT_QUESTION_MISSING');
   requirements.set(label,ref);
  }
  if(requirements.size>10000)throw fail('BACKUP_HISTORY_SNAPSHOT_REFERENCE_BUDGET');
  const labels=[...requirements.keys()];
  for(let offset=0;offset<labels.length;offset+=100){
   const batch=labels.slice(offset,offset+100),rows=await workspace.readIndexes({labels:batch});await check();
   if(!Array.isArray(rows)||rows.length!==batch.length)throw fail('FINAL_SOURCE_INDEX_CORRUPT');
   for(let index=0;index<batch.length;index++){
    const label=batch[index],row=rows[index],ref=requirements.get(label);let member=null;
    if(row){const p=row.provenance;if(row.sourceId!==metadata.sourceId||row.sourceRecordId!==`index:${label}`||p?.format!=='qb-final-proof-index-v1'||p.workspaceId!==metadata.workspaceId||p.label!==label)throw fail('FINAL_SOURCE_INDEX_CORRUPT');member=p.value;}
    if(member){if(member.questionKey!==ref.questionKey||member.questionRevision!==ref.questionRevision)throw fail('BACKUP_HISTORY_SNAPSHOT_QUESTION_MISSING');continue;}
    const bankUid=ref.questionKey.split('/')[0],bankKey=`${bankUid}@${ref.bankRevision}`;
    if(!resolvedBanks.has(bankKey)){
     const candidates=[...(bankSources.get(bankKey)||[]),...(contentSources.get(ref.bankRevision)||[])];
     try{resolvedBanks.set(bankKey,await resolveImmutableBank({bankUid,bankRevision:ref.bankRevision,readBankRevision:(uid,revision)=>get('bank_revisions',[uid,revision]),sourceChanges:async()=>candidates,readContent:reference=>reader.readContent(reference)}));}
     catch{throw fail('BACKUP_HISTORY_SNAPSHOT_BANK_MISSING');}
    }
    if(!resolvedBanks.get(bankKey).questionRefs.some(question=>question.questionKey===ref.questionKey&&question.questionRevision===ref.questionRevision))throw fail('BACKUP_HISTORY_SNAPSHOT_QUESTION_MISSING');
   }
  }
 }
 async function cover(id,row){await putIndex(`closure:resolved:${id}`,{conflictId:id,sourceKey:[row.sourceId,row.sourceRecordId],rowDigest:await sha256Hex(canonicalBytes(row))});}
 async function covered(id){const pointer=await readIndex(`closure:resolved:${id}`);if(!pointer)return false;if(pointer.conflictId!==id)throw fail('FINAL_SOURCE_INDEX_CORRUPT');const original=await get('import_receipts',pointer.sourceKey);if(!original||await sha256Hex(canonicalBytes(original))!==pointer.rowDigest)throw fail('FINAL_SOURCE_INDEX_CORRUPT');const p=original.provenance;if(p?.format==='qb-star-conflict-resolution-v1'?p.conflictId!==id:p?.format!==STAR_GROUP_FORMAT||!p.group.members.some(m=>m.conflict?.conflictId===id))throw fail('BACKUP_STAR_RESOLUTION_AUDIT_MISSING');await audit(original);return true;}
 async function audit(row){const p=row.provenance;
  if(p?.format==='qb-sync-change-v1'){const verified=await validateSyncChangeReceipt(row);if(owner.ownerKind!=='account'||verified.provenance.generation!==owner.accountGeneration)throw fail('BACKUP_OWNER_MISMATCH');}
  if(p?.format==='qb-cloud-receipt-v1'){if(owner.ownerKind!=='account')throw fail('BACKUP_OWNER_MISMATCH');let change;if(p.receipt?.status!=='conflict'){const original=await get('import_receipts',[`qb-sync-v2:${owner.accountGeneration}:${p.logEpoch}`,`change:${p.receipt?.serverSeq}`]);if(!original)throw fail('BACKUP_CLOUD_RECEIPT_DEPENDENCY');change=(await validateSyncChangeReceipt(original)).provenance.change;}await validateCloudReceipt(row,{generation:owner.accountGeneration,logEpoch:p.logEpoch,change});}
  if(p?.format==='qb-star-conflict-resolution-v1'){
   const origin=(await validateStarResolutionReceipt(row)).provenance;if(owner.ownerKind!=='account'||origin.generation!==owner.accountGeneration)throw fail('BACKUP_OWNER_MISMATCH');const original=await get('mutations',origin.originalMutation.mutationId),created=await get('mutations',origin.newMutationId),conflict=await get('conflicts',origin.conflictId),outbox=await get('outbox',origin.originalMutation.mutationId);
   if(!original||!created||!conflict||conflict.status!=='resolved'||outbox||!same(mutationWire(original),origin.originalMutation)||!same(conflict.mutation,origin.originalMutation)||created.clientStreamId!==origin.originalMutation.clientStreamId||created.clientSeq<=origin.originalMutation.clientSeq||created.kind!=='user_state'||created.entityKey!==origin.originalMutation.entityKey||created.payload.baseRevision!==origin.sourceChange.serverRevision||created.payload.value!==(origin.choice==='local'?origin.originalMutation.payload.value:origin.sourceChange.payload.value))throw fail('BACKUP_STAR_RESOLUTION_ORIGIN');await cover(origin.conflictId,row);
  }
  if(p?.format===STAR_GROUP_FORMAT||row.sourceId===STAR_GROUP_FORMAT){
   const origin=(await validateStarGroupResolutionReceipt(row)).provenance;if(!same(origin.group.owner,owner))throw fail('BACKUP_OWNER_MISMATCH');const created=await get('mutations',origin.newMutationId);
   if(!created||created.accountGeneration!==owner.accountGeneration||created.clientStreamId!==origin.group.streamRow.value||created.clientSeq!==origin.group.seqRow.value+1||created.kind!=='user_state'||created.entityKey!==origin.group.entityKey||created.payload.baseRevision!==origin.sourceChange.serverRevision||created.payload.value!==(origin.choice==='local'?origin.group.localState.value:origin.sourceChange.payload.value))throw fail('BACKUP_STAR_GROUP_RESOLUTION_ORIGIN');
   for(const member of origin.group.members){const original=await get('mutations',member.originalMutation.mutationId),conflict=await get('conflicts',member.originalMutation.mutationId)||null,outbox=await get('outbox',member.originalMutation.mutationId);if(!original||!same(original,member.originalRecord)||outbox||!same(conflict,member.conflict?{...member.conflict,status:'resolved'}:null))throw fail('BACKUP_STAR_GROUP_RESOLUTION_ORIGIN');if(member.conflict)await cover(member.conflict.conflictId,row);}
  }
  await check();
 }
 async function physicalCut({auditOrigins}){
  await indexOwnedParts();const hash=sha256.create();let recordCount=0,logicalBytes=0;
  for(const store of Object.keys(APP_DATA_STORES).sort())for await(const row of reader.records(store)){
   if(store==='import_receipts'&&row.sourceId===metadata.sourceId){if(row.provenance?.workspaceId!==metadata.workspaceId||!['qb-final-proof-index-v1','qb-final-proof-part-v1','qb-final-proof-reservation-v1'].includes(row.provenance?.format))throw fail('FINAL_SOURCE_INDEX_CORRUPT');continue;}
   if(store==='content_chunks'&&await ownedChunk(row))continue;
   if(store==='import_receipts'&&(TEMP.includes(row.provenance?.format)||row.sourceId.startsWith('qb-cloud-stage-index:')&&isUuid(row.sourceId.slice(21))))throw fail('BACKUP_UNFINISHED_CLOUD_STAGE');
   if(store==='migration_journal'&&row.checkpoint?.format==='qb-cloud-recovery-stage-v1')throw fail('BACKUP_UNFINISHED_CLOUD_STAGE');
   logicalBytes+=store==='content_chunks'?row.bytes.length:canonicalBytes(row).length;if(++recordCount>200000||logicalBytes>100*PAGE)throw fail('BACKUP_BUDGET_EXCEEDED');
   hash.update(canonicalBytes(store));hash.update(store==='content_chunks'?canonicalBytes({contentDigest:row.contentDigest,chunkIndex:row.chunkIndex,byteLength:row.bytes.length,sha256:await sha256Hex(row.bytes)}):canonicalBytes(row));
   if(store==='mutations'){if(owner.ownerKind==='account'?row.accountGeneration!==owner.accountGeneration:row.accountGeneration!==undefined)throw fail('BACKUP_OWNER_MISMATCH');if(!await verifyMutationDigest(mutationWire(row)))throw fail('BACKUP_MUTATION_DIGEST');}
   if(store==='outbox'&&!await get('mutations',row.mutationId))throw fail('BACKUP_OUTBOX_DEPENDENCY');
   if(['attempt_scope','drafts','answer_events'].includes(store)&&!await get('attempts',row.attemptId))throw fail('BACKUP_ATTEMPT_DEPENDENCY');
   if(auditOrigins&&store==='import_receipts')await audit(row);
  }await check();return {recordCount,logicalBytes,sourceCutDigest:hex(hash.digest())};
 }
 async function verify(){
  guard();if(failed)throw fail('FINAL_PROOF_SESSION_FAILED');try{
   const initial=await physicalCut({auditOrigins:true});let attemptCount=0,draftCount=0,eventCount=0,forkCount=0;
   for await(const conflict of reader.records('conflicts'))if(conflict.status==='resolved'&&conflict.mutation.kind==='user_state'&&conflict.mutation.payload.field==='starred'&&!await covered(conflict.conflictId))throw fail('BACKUP_STAR_RESOLUTION_AUDIT_MISSING');
   const historySources=new Map(),historyPayloads=new Map();
   for await(const source of sources()){
    if(['content_manifest','attempt_scope'].includes(source.kind)){await reader.verifyContentBytes(source.payload.reference);if(source.kind==='content_manifest')await putIndex(`closure:content:${source.payload.reference.contentDigest}`,{reference:source.payload.reference});}
    if(source.kind==='history_snapshot'){
     const id=source.payload?.snapshotId,prior=historySources.get(id);
     if(prior&&(!same(prior.payload,source.payload)||prior.entityKey!==source.entityKey))throw fail('BACKUP_HISTORY_SNAPSHOT_CONFLICT');
     if(!prior){historySources.set(id,source);historyPayloads.set(id,await verifyHistorySnapshot(source));}
    }
   }
   let bankCount=0,protectedBankCount=0;for await(const bank of reader.records('bank_revisions')){const proofClass=await verifyPhysicalBank(bank);bankCount++;if(proofClass==='declared-encrypted-index-shape-and-digest')protectedBankCount++;}
   const neededBanks=new Set();for(const body of historyPayloads.values())for(const item of body.scope)for(const ref of item.equivalentSourceRefs)neededBanks.add(`${ref.questionKey.split('/')[0]}@${ref.bankRevision}`);
   const bankSources=new Map(),neededPublicDigests=new Set();
   for await(const source of sources())if(source.kind==='bank_revision'){
    const key=`${source.payload?.bankUid}@${source.payload?.revision}`;if(!neededBanks.has(key))continue;
    if(!bankSources.has(key))bankSources.set(key,[]);bankSources.get(key).push(source);
    if(source.payload.contentManifest?.kind==='public_static')neededPublicDigests.add(source.payload.contentManifest.contentDigest);
   }
   const contentSources=new Map();
   if(neededPublicDigests.size)for await(const source of sources())if(source.kind==='content_manifest'&&neededPublicDigests.has(source.payload?.reference?.contentDigest)){
    const digest=source.payload.reference.contentDigest;if(!contentSources.has(digest))contentSources.set(digest,[]);contentSources.get(digest).push(source);
   }
   const resolvedBanks=new Map();
   for(const body of historyPayloads.values())await verifyHistorySnapshotBankReferences(body,{bankSources,contentSources,resolvedBanks});
   for await(const row of reader.records('history_snapshots')){const source=historySources.get(row.snapshotId);if(!source||!same(row,source.payload))throw fail('BACKUP_HISTORY_SNAPSHOT_DEPENDENCY');}
   for await(const attempt of reader.records('attempts')){const result=await verifyBundle(attempt);attemptCount++;draftCount+=result.drafts;eventCount+=result.events;}
   for await(const row of reader.records('import_receipts'))if(row.provenance?.format==='qb-fork-origin-v1'){const origin=validateForkOriginReceipt(row).provenance;await reader.verifyAttemptFork(origin.commandId);forkCount++;}
   const final=await physicalCut({auditOrigins:false});if(!same(initial,final))throw fail('FINAL_SOURCE_INDEX_CORRUPT');
   return {status:'bundle_relationships_candidate_verified',...final,attemptCount,draftCount,eventCount,forkCount,bankCount,protectedBankCount,fullSemanticClosure:false,ready:false,unimplemented:['single_question_over3MiB_streaming','post_cleanup_clean19_readback','private_final_manifest_activation']};
  }catch(cause){failed=true;throw cause;}
 }
 // A fresh primary-key cursor, not the semantic reader's indexes/cache. After
 // cleanup there are no exclusions: even an orphan reserved format is fatal.
 async function* cleanRows(store){let after=null;do{
  await check();const page=await new Promise((resolve,reject)=>{let tx,timer,done=false,result;const rows=[];let bytes=64,last=null;
   const finish=cause=>{if(done)return;done=true;clearTimeout(timer);pending.delete(tx);cause?reject(cause):resolve(result);};
   const abort=cause=>{try{tx?.abort();}catch{}finish(cause);};
   try{guard();tx=database.transaction(store,'readonly');pending.set(tx,finish);tx.oncomplete=()=>finish();tx.onabort=()=>finish(fail('FINAL_NATIVE_NOT_COMMITTED'));tx.onerror=()=>{};timer=setTimeout(()=>abort(fail('FINAL_NATIVE_NOT_COMMITTED')),5000);
    const request=tx.objectStore(store).openCursor(after===null?null:IDBKeyRange.lowerBound(after,true));request.onerror=()=>abort(fail('FINAL_NATIVE_NOT_COMMITTED'));
    request.onsuccess=()=>{try{guard();const c=request.result;if(!c){result={rows,after:null};return;}if(rows.length===100){result={rows,after:last};return;}const row=c.value;validateStoreRecord(store,row);if(indexedDB.cmp(nativeRecordKey(store,row),c.primaryKey)!==0)throw fail('BACKUP_DUPLICATE_RECORD');const size=store==='content_chunks'?row.bytes.length:canonicalBytes(row).length;if(size>ROW)throw fail('FINAL_NATIVE_ROW_BUDGET');if(rows.length&&bytes+size>PAGE){result={rows,after:last};return;}rows.push(row);bytes+=size;last=ownedWriteInput(c.primaryKey);if(bytes>PAGE){result={rows,after:last};return;}c.continue();}catch(cause){abort(cause);}};
   }catch(cause){abort(cause);}
  });await check();for(const row of page.rows)yield row;after=page.after;
 }while(after!==null);}
 async function cleanBusinessCut(){const hash=sha256.create(),stores=[];let recordCount=0,logicalBytes=0,ndjsonBytes=0;
  for(const store of Object.keys(APP_DATA_STORES).sort()){const storeHash=sha256.create();let storeCount=0;for await(const row of cleanRows(store)){
   if(store==='import_receipts'&&(TEMP.includes(row.provenance?.format)||row.sourceId.startsWith('qb-cloud-stage-index:')&&isUuid(row.sourceId.slice(21))))throw fail('BACKUP_UNFINISHED_CLOUD_STAGE');
   if(store==='migration_journal'&&row.checkpoint?.format==='qb-cloud-recovery-stage-v1')throw fail('BACKUP_UNFINISHED_CLOUD_STAGE');
   logicalBytes+=store==='content_chunks'?row.bytes.length:canonicalBytes(row).length;if(++recordCount>200000||logicalBytes>100*PAGE)throw fail('BACKUP_BUDGET_EXCEEDED');
   const projected=store==='content_chunks'?canonicalBytes({contentDigest:row.contentDigest,chunkIndex:row.chunkIndex,byteLength:row.bytes.length,sha256:await sha256Hex(row.bytes)}):canonicalBytes(row);
   hash.update(canonicalBytes(store));hash.update(projected);storeHash.update(projected);storeHash.update(new Uint8Array([10]));ndjsonBytes+=projected.length+1;storeCount++;await check();
  }stores.push({name:store,recordCount:storeCount,sha256:hex(storeHash.digest())});}
  const cut={recordCount,logicalBytes,sourceCutDigest:hex(hash.digest())},manifest=validateNativeManifestV2({format:'qb-v2-native-manifest-v2',businessSchemaVersion:APP_DATA_DB_SCHEMA_VERSION,keyOrder:'indexeddb-primary-key-v1',rowEncoding:'canonical-ndjson-v1',stores});
  return {cut,nativeSummary:{manifest,contentDigest:await sha256Hex(canonicalBytes(manifest)),recordCount,logicalBytes,ndjsonBytes,verification:'summary_only'}};
 }
 async function verifyClean(){guard();if(cleanAttempted)throw fail('FINAL_CLEAN_READBACK_ALREADY_USED');cleanAttempted=true;
  try{const semantic=await verify();await check();await workspace.cleanup();await check();const {cut:clean,nativeSummary}=await cleanBusinessCut();
   if(!same(clean,{recordCount:semantic.recordCount,logicalBytes:semantic.logicalBytes,sourceCutDigest:semantic.sourceCutDigest}))throw fail('FINAL_CLEAN_BUSINESS_CUT_MISMATCH');
   // V2 canonical NDJSON remains a separate digest. Only actual business
   // logical bytes use the unchanged 100MiB gate; framing is not business data.
   const final=await cleanBusinessCut();if(!same(clean,final.cut)||!same(nativeSummary,final.nativeSummary))throw fail('FINAL_CLEAN_BUSINESS_CUT_MISMATCH');
   return {...semantic,status:'clean_bundle_readback_candidate_verified',businessCutFormat:'qb-native-business-cut-v1',cleanReadback:clean,nativeSummary,fullSemanticClosure:false,ready:false,terminalProofMinted:false,unimplemented:['single_question_over3MiB_streaming','large_historical_semantic_streaming','trusted_checkpoint_binding','private_final_manifest_activation']};
  }catch(cause){failed=true;throw cause;}
 }
 async function mintProof(){guard();const binding=assertFinalProofBinding(workspace,database);await binding.check();const captured=await binding.snapshot();
  if(captured.sourceVerified!==true)throw fail('FINAL_TRUSTED_CHECKPOINT_BINDING_UNAVAILABLE');
  const verified=await verifyClean();await binding.check();const current=await binding.snapshot();if(!same(current,captured))throw fail('FINAL_TERMINAL_PROOF_BINDING');
  // This call itself executes full admitted-cut semantics. Unsupported large
  // question/proof rows already throw; a caller's summary/boolean never mints.
  const clean={cut:verified.cleanReadback,nativeSummary:verified.nativeSummary};const token=Object.freeze({});terminalProofs.set(token,{database,workspace,binding,bindingSnapshot:captured,clean,reread:cleanBusinessCut});return token;
 }
 return Object.freeze({verify,verifyClean,mintProof,diagnostics:()=>{guard();return reader.readFinalDiagnostics();},close,status:'unintegrated_bundle_closure_candidate',ready:false});
}
