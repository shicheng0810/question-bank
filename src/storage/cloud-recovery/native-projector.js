import {assertSnapshotContinuationReceipt,deriveSnapshotContinuationCommandId} from '../../domain/app-data/snapshot-continuation.js';
import { canonicalBytes, canonicalContentBytes, sha256Hex, validateStoreRecord, validateChunkManifest, validateAttemptScope, validateHistorySnapshotBinding } from '../../domain/app-data/index.js';
import { validateBankContent, validateProtectedBankEnvelopeV2 } from '../../domain/question/bank-content.js';
import { validateCloudCheckpoint } from '../../../do-worker/src/account-cloud-checkpoint.js';
import { snapshotOwner } from '../profiles/control-schema.js';
import { assertFinalProofWorkspace } from '../profiles/managed-profile-registry.js';
import { validateSyncChangeReceipt, validateSyncReceipt } from '../sync/protocol.js';
import { createBoundedNativeAccess, nativeRecordKey, nativeRecordSize } from './bounded-native.js';
import { ownedWriteInput } from '../idb/write-input.js';
import {createFinalDependencyReader} from './final-dependency-reader.js';
import {createNativeRegisteredBankStreamer} from './bank-content-stream.js';
import {frozenPublicBanks} from '../../domain/question/frozen-public-registry.js';
// Pure relation predicate, no source capability or Ready authority. The private
// projector obtains refs only from its authenticated accepted-change accessor.
export function selectPublicBankProjectionReference(payload,input){
 const p=ownedWriteInput(payload),refs=ownedWriteInput(input);
 if(p.contentManifest?.kind!=='public_static'||!Array.isArray(refs)||refs.length!==1)fail('PROJECTOR_PUBLIC_REFERENCE');
 const known=frozenPublicBanks.find(row=>row.bankUid===p.bankUid&&row.revision===p.revision);
 if(!known||!same(known.metadata,p.metadata)||!same(known.contentManifest,p.contentManifest)||!same(known.publicContentReference,refs[0])||refs[0].contentDigest!==p.revision)fail('PROJECTOR_PUBLIC_REFERENCE');
 return ownedWriteInput(refs[0]);
}

const SMALL = 3 * 1024 * 1024;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const same = (a,b) => {
  const x=canonicalBytes(a), y=canonicalBytes(b);
  return x.length===y.length && x.every((v,i)=>v===y[i]);
};
const exact = (value,keys) => value && Object.getPrototypeOf(value)===Object.prototype
  && Reflect.ownKeys(value).length===keys.length
  && keys.every(key=>{const d=Object.getOwnPropertyDescriptor(value,key);return d&&d.enumerable&&Object.hasOwn(d,'value');});

/** SOURCE-only inactive projector. No Ready capability, cursor, ACK, lease or
 * local mutation is produced. The private factory must eventually be called
 * statically by native-stage: a caller raw DB/guard/owner DTO cannot mint access.
 * Existing receipt authenticity and checkpoint completeness are separate gates.
 */
export async function createNativeCheckpointProjector(database, options) {
  if (!exact(options,['owner','checkpoint','checkpointDigest','proofWorkspace','sourceCapability'])) fail('PROJECTOR_INPUT');
  const input=ownedWriteInput({owner:options.owner,checkpoint:options.checkpoint,checkpointDigest:options.checkpointDigest});
  const workspace=options.proofWorkspace,sourceCapability=options.sourceCapability;
  assertFinalProofWorkspace(workspace,database);
  const {consumeCloudProjectionSource}=await import('./index.js');
  const sourceAccess=consumeCloudProjectionSource(sourceCapability);
  const owner=snapshotOwner(input.owner), checkpoint=validateCloudCheckpoint(input.checkpoint);
  const sourceMetadata=await sourceAccess.metadata();
  if(!same(sourceMetadata.owner,owner)||!same(sourceMetadata.checkpoint,checkpoint)||sourceMetadata.checkpointDigest!==input.checkpointDigest)fail('PROJECTOR_SOURCE_BINDING');
  if(owner.ownerKind!=='account'||owner.accountGeneration!==checkpoint.generation||!checkpoint.complete)fail('PROJECTOR_OWNER');
  if(await sha256Hex(canonicalBytes(checkpoint))!==input.checkpointDigest)fail('PROJECTOR_CHECKPOINT');
  let closed=false;
  const check=async()=>{
    if(closed)fail('PROJECTOR_CLOSED');
    assertFinalProofWorkspace(workspace,database);
    const metadata=await workspace.metadata();
    if(!same(metadata.owner,owner))fail('PROJECTOR_OWNER');
    if(Date.now()>=checkpoint.expiresAt)fail('PROJECTOR_EXPIRED');
    await workspace.check();
    await sourceAccess.check();
  };
  await check();
  // The synchronous native guard supplements, never replaces, the full async
  // control/pointer guard before and after each externally visible operation.
  const native=await createBoundedNativeAccess(database,{guard:()=>{
    if(closed)fail('PROJECTOR_CLOSED');
    assertFinalProofWorkspace(workspace,database);
    if(Date.now()>=checkpoint.expiresAt)fail('PROJECTOR_EXPIRED');
  }});
  const sourceId=`qb-sync-v2:${checkpoint.generation}:${checkpoint.logEpoch}`;
  const pending=new Map();
  const diagnosticKeys=['scopeRows','indexReads','indexReadBatches','indexWrites','indexWriteBatches','partReads','partWrites','bankBodyHashes','bankSemanticParses','bankSemanticReuses','bankRawHashBytes','scopeMs','sourceCheckMs'];
  const totals={},metrics={projectorReaderCreates:0,projectorReaderResets:0,projectorSameRawCreates:0,projectorSameWorkspaceCreates:0};let priorRaw=null,priorWorkspace=null;
  const counters=()=>{const actual=dependencies.readFinalDiagnostics(),values={};for(const source of [actual,actual?.semantics,actual?.diagnostics])if(source)for(const key of diagnosticKeys)if(typeof source[key]==='number'&&Number.isFinite(source[key])&&source[key]>=0)values[key]=source[key];return values;};
  const createDependencies=()=>{metrics.projectorReaderCreates++;if(priorRaw===database)metrics.projectorSameRawCreates++;if(priorWorkspace===workspace)metrics.projectorSameWorkspaceCreates++;priorRaw=database;priorWorkspace=workspace;return createFinalDependencyReader(database,{owner,proofWorkspace:workspace,guard:()=>{
    if(closed)fail('PROJECTOR_CLOSED');assertFinalProofWorkspace(workspace,database);
  }});};
  let dependencies=await createDependencies(),dependenciesDirty=false;
  async function refreshDependencies(){
    if(!dependenciesDirty)return;await check();for(const [key,value]of Object.entries(counters()))totals[key]=(totals[key]??0)+value;dependencies.close();metrics.projectorReaderResets++;
    // Private held inactive capability only; no reset after source registration
    // or terminal proof binding. Exact owned namespace cleanup, not business.
    if(typeof workspace.resetForProjection!=='function')fail('PROJECTOR_PRIVATE_RESET_UNAVAILABLE');
    await workspace.resetForProjection();await check();dependencies=await createDependencies();await check();dependenciesDirty=false;
  }
  async function* range(store,index,key){
    let after;
    for(;;){
      await check();
      const page=await new Promise((resolve,reject)=>{
        let tx,ended=false,timer;const result=[];let bytes=0,continuation;
        const finish=error=>{if(ended)return;ended=true;clearTimeout(timer);pending.delete(tx);error?reject(error):resolve({rows:result,continuation});};
        const abort=error=>{try{tx?.abort();}catch{}finish(error);};
        try{
          tx=database.transaction(store,'readonly');pending.set(tx,abort);timer=setTimeout(()=>abort(Object.assign(new Error('PROJECTOR_NOT_COMMITTED'),{code:'PROJECTOR_NOT_COMMITTED'})),5000);
          tx.onabort=()=>finish(Object.assign(new Error('PROJECTOR_NOT_COMMITTED'),{code:'PROJECTOR_NOT_COMMITTED'}));tx.onerror=()=>{};tx.oncomplete=()=>finish();
          const request=tx.objectStore(store).index(index).openCursor(IDBKeyRange.only(key));
          request.onsuccess=()=>{try{assertFinalProofWorkspace(workspace,database);if(closed)fail('PROJECTOR_CLOSED');const cursor=request.result;if(!cursor)return;
            if(after!==undefined){const compared=indexedDB.cmp(cursor.primaryKey,after);if(compared<0){cursor.continuePrimaryKey(key,after);return;}if(compared===0){cursor.continue();return;}}
            const size=nativeRecordSize(store,cursor.value);
            if(result.length>=100||result.length&&bytes+size>1024*1024){continuation=result[result.length-1].key;return;}
            if(size>SMALL)fail('PROJECTOR_LARGE_SEMANTICS_UNSUPPORTED');
            result.push({key:cursor.primaryKey,value:cursor.value});bytes+=size;cursor.continue();
          }catch(error){abort(error);}};
        }catch(error){abort(error);}
      });
      await check();for(const row of page.rows)yield row;
      if(page.continuation===undefined)return;after=page.continuation;
    }
  }
  async function read(store,key){return (await native.readKeys([{store,key}]))[0];}
  async function commit(records, receipt, extraConditions=[],deletes=[]){
    const conditions=[{store:'import_receipts',key:[receipt.sourceId,receipt.sourceRecordId],expected:receipt},...extraConditions];
    let budget=canonicalBytes(conditions.map(row=>({...row,...(row.expected===undefined?{expected:null}:{})}))).length;
    for(const row of records){budget+=nativeRecordSize(row.store,row.value);}
    // Include expected row bodies in this bounded transaction, not just writes.
    if(records.length+deletes.length>100||budget>(records.length+deletes.length===1?SMALL:1024*1024))fail('PROJECTOR_TRANSACTION_BUDGET');
    await check();
    await new Promise((resolve,reject)=>{
      let tx,settled=false,timer;
      const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);pending.delete(tx);error?reject(error):resolve();};
      const abort=error=>{try{tx?.abort();}catch{}finish(error);};
      try{
        tx=database.transaction([...new Set([...records,...conditions,...deletes].map(row=>row.store))],'readwrite');
        pending.set(tx,abort);timer=setTimeout(()=>abort(Object.assign(new Error('PROJECTOR_NOT_COMMITTED'),{code:'PROJECTOR_NOT_COMMITTED'})),5000);
        tx.onabort=()=>finish(Object.assign(new Error('PROJECTOR_NOT_COMMITTED'),{code:'PROJECTOR_NOT_COMMITTED'}));
        tx.onerror=()=>{};
        tx.oncomplete=()=>{try{assertFinalProofWorkspace(workspace,database);if(closed)fail('PROJECTOR_CLOSED');finish();}catch(error){finish(error);}};
        let left=conditions.length;
        for(const condition of conditions){const request=tx.objectStore(condition.store).get(condition.key);request.onsuccess=()=>{
          try{assertFinalProofWorkspace(workspace,database);if(closed)fail('PROJECTOR_CLOSED');
            if(Date.now()>=checkpoint.expiresAt)fail('PROJECTOR_EXPIRED');
            const actual=request.result;
            if((actual===undefined)!==(condition.expected===undefined)||(actual!==undefined&&!same(actual,condition.expected)))fail('PROJECTOR_FACT_CHANGED');
            if(!--left){for(const row of records)tx.objectStore(row.store).put(row.value);for(const row of deletes)tx.objectStore(row.store).delete(row.key);}
          }catch(error){abort(error);}
        };}
      }catch(error){abort(error);}
    });
    await check();
  }
  async function source(serverSeq){
    if(typeof serverSeq!=='string'||!/^[1-9][0-9]{0,19}$/.test(serverSeq)||BigInt(serverSeq)>BigInt(checkpoint.cut))fail('PROJECTOR_SOURCE_CUT');
    const original=await sourceAccess.readAcceptedSource(serverSeq),change=original.change;
    const row={sourceId,sourceRecordId:`change:${serverSeq}`,importedAt:original.importedAt,provenance:{format:'qb-sync-change-v1',generation:checkpoint.generation,logEpoch:checkpoint.logEpoch,change}};
    const receipt=await validateSyncChangeReceipt(row);
    if(change.serverSeq!==serverSeq||receipt.provenance.generation!==checkpoint.generation||receipt.provenance.logEpoch!==checkpoint.logEpoch)fail('PROJECTOR_SOURCE_BINDING');
    return {receipt,change};
  }
  async function materializeSource(receipt,change){
    const key=[receipt.sourceId,receipt.sourceRecordId],prior=await read('import_receipts',key);
    if(prior&&!same(prior,receipt))fail('PROJECTOR_SOURCE_DIVERGENCE');
    if(!prior){await check();await native.putExact([{store:'import_receipts',value:receipt,expected:undefined}]);await check();}
    for await(const reference of sourceAccess.referencesFor(change)){
      if(reference.totalBytes>SMALL&&!['content_manifest','bank_revision'].includes(change.kind))fail('PROJECTOR_LARGE_SEMANTICS_UNSUPPORTED');
      const header=await sourceAccess.readContentChunk([reference.manifestDigest,0]);
      if(await sha256Hex(header.bytes)!==reference.manifestDigest)fail('PROJECTOR_MANIFEST');
      const manifest=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(header.bytes));validateChunkManifest(manifest);
      if(manifest.contentDigest!==reference.contentDigest||manifest.totalBytes!==reference.totalBytes||manifest.chunkCount!==reference.chunkCount)fail('PROJECTOR_MANIFEST');
      for(const part of [{contentDigest:reference.manifestDigest,chunkIndex:0,bytes:header.bytes},...manifest.chunks.map(row=>({contentDigest:reference.contentDigest,chunkIndex:row.chunkIndex,descriptor:row}))]){
        const chunk=part.bytes?part:await sourceAccess.readContentChunk([part.contentDigest,part.chunkIndex]);
        if(part.descriptor&&(chunk.bytes.length!==part.descriptor.byteLength||await sha256Hex(chunk.bytes)!==part.descriptor.sha256))fail('PROJECTOR_CHUNK');
        const chunkKey=[chunk.contentDigest,chunk.chunkIndex],old=await read('content_chunks',chunkKey);
        if(old&&(old.bytes.length!==chunk.bytes.length||!old.bytes.every((v,i)=>v===chunk.bytes[i])))fail('PROJECTOR_CONTENT_DIVERGENCE');
        if(!old){await commit([{store:'content_chunks',value:chunk}],receipt,[{store:'content_chunks',key:chunkKey,expected:undefined}]);}
      }
    }
  }
  let prepareSeq=1n,preparing=false;
  async function prepareNext(input){
    const captured=ownedWriteInput(input);if(!exact(captured,['limit'])||!Number.isSafeInteger(captured.limit)||captured.limit<1||captured.limit>100)fail('PROJECTOR_INPUT');if(preparing)fail('PROJECTOR_BUSY');preparing=true;
    try{await check();let staged=0;while(staged<captured.limit&&prepareSeq<=BigInt(checkpoint.cut)){const original=await source(prepareSeq.toString());await materializeSource(original.receipt,original.change);const after=await source(prepareSeq.toString());if(!same(original.receipt,after.receipt))fail('PROJECTOR_SOURCE_CHANGED');await check();prepareSeq++;staged++;}return {status:'authentic_sources_staged_no_ready',staged,hasMore:prepareSeq<=BigInt(checkpoint.cut),ready:false};}finally{preparing=false;}
  }
  async function streamedPublicBank(reference){
    const raw=await read('content_chunks',[reference.manifestDigest,0]);if(!raw||await sha256Hex(raw.bytes)!==reference.manifestDigest)fail('PROJECTOR_MANIFEST');const manifest=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw.bytes));validateChunkManifest(manifest);if(manifest.contentDigest!==reference.contentDigest||manifest.totalBytes!==reference.totalBytes||manifest.chunkCount!==reference.chunkCount)fail('PROJECTOR_MANIFEST');
    async function* chunks(){for(const part of manifest.chunks){await check();const row=await read('content_chunks',[reference.contentDigest,part.chunkIndex]);if(!row||row.bytes.length!==part.byteLength||await sha256Hex(row.bytes)!==part.sha256)fail('PROJECTOR_CHUNK');await check();yield row.bytes;}}
    const streamer=await createNativeRegisteredBankStreamer(database,workspace);try{await check();const body=await streamer.stream({chunks:chunks(),reference,onQuestion:async()=>{await check();}});await check();if(body.metadata.visibility!=='public')fail('PROJECTOR_LARGE_SEMANTICS_UNSUPPORTED');return body;}finally{streamer.close();}
  }
  async function smallContent(reference){
    // Reject before allocating a full body. This is deliberately NOT the future
    // 100 MiB streaming semantic adapter.
    if(!reference||reference.totalBytes>SMALL)fail('PROJECTOR_LARGE_SEMANTICS_UNSUPPORTED');
    const raw=await read('content_chunks',[reference.manifestDigest,0]);
    if(!raw||await sha256Hex(raw.bytes)!==reference.manifestDigest)fail('PROJECTOR_MANIFEST');
    const manifest=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw.bytes));
    validateChunkManifest(manifest);
    if(manifest.contentDigest!==reference.contentDigest||manifest.totalBytes!==reference.totalBytes||manifest.chunkCount!==reference.chunkCount)fail('PROJECTOR_MANIFEST');
    const bytes=new Uint8Array(manifest.totalBytes);let offset=0;
    for(const part of manifest.chunks){
      const chunk=await read('content_chunks',[manifest.contentDigest,part.chunkIndex]);
      if(!chunk||chunk.bytes.length!==part.byteLength||await sha256Hex(chunk.bytes)!==part.sha256)fail('PROJECTOR_CHUNK');
      bytes.set(chunk.bytes,offset);offset+=chunk.bytes.length;
    }
    if(offset!==bytes.length||await sha256Hex(bytes)!==reference.contentDigest)fail('PROJECTOR_CONTENT');
    const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    const canonical=canonicalContentBytes(value);
    if(canonical.length!==bytes.length||!canonical.every((v,i)=>v===bytes[i]))fail('PROJECTOR_CANONICAL');
    return {value,manifest};
  }
  async function apply(inputValue){
    const captured=ownedWriteInput(inputValue);
    if(!exact(captured,['serverSeq']))fail('PROJECTOR_INPUT');
    await check();
    if((await native.readPage({store:'outbox',after:null,limit:1})).rows.length||(await native.readPage({store:'conflicts',after:null,limit:1})).rows.length)fail('PROJECTOR_LOCAL_PENDING_TARGET_UNSUPPORTED');
    const {receipt,change}=await source(captured.serverSeq), p=change.payload;
    await materializeSource(receipt,change);
    const writes=[], conditions=[];
    let versionReceipt, priorVersion;
    if(change.serverRevision!==undefined){
      versionReceipt={sourceId,sourceRecordId:`entity:${change.kind}:${change.entityKey}`,importedAt:receipt.importedAt,provenance:{format:'qb-sync-entity-v1',kind:change.kind,entityKey:change.entityKey,serverRevision:change.serverRevision,payloadDigest:change.payloadDigest,generation:checkpoint.generation,logEpoch:checkpoint.logEpoch}};
      validateSyncReceipt(versionReceipt);
      priorVersion=await read('import_receipts',[sourceId,versionReceipt.sourceRecordId]);
      if(priorVersion){validateSyncReceipt(priorVersion);
        if(priorVersion.provenance.serverRevision>change.serverRevision)fail('PROJECTOR_STALE_SOURCE');
        if(priorVersion.provenance.serverRevision===change.serverRevision&&priorVersion.provenance.payloadDigest!==change.payloadDigest)fail('PROJECTOR_REVISION_DIVERGENCE');
      }
      conditions.push({store:'import_receipts',key:[sourceId,versionReceipt.sourceRecordId],expected:priorVersion});
      writes.push({store:'import_receipts',value:versionReceipt});
    }
    async function put(store,value){
      validateStoreRecord(store,value);const key=nativeRecordKey(store,value),old=await read(store,key);
      if(old!==undefined&&!same(old,value)){
        if(!versionReceipt||!priorVersion||change.serverRevision<=priorVersion.provenance.serverRevision||!['attempts','user_state'].includes(store))fail('PROJECTOR_FACT_DIVERGENCE');
      }
      conditions.push({store,key,expected:old});writes.push({store,value});
    }
    const attemptIdentity=p.attemptId??p.event?.attemptId;
    const bankIdentity=p.bankUid??p.questionKey?.split('/')[0];
    const snapshotIdentity=change.kind==='history_snapshot'?p.snapshotId:null;
    const tombstoneKey=attemptIdentity?`attempt:${attemptIdentity}`:bankIdentity?`bank:${bankIdentity}`:snapshotIdentity?`history_snapshot:${snapshotIdentity}`:null;
    if(tombstoneKey&&await read('entity_tombstones',tombstoneKey))fail('PROJECTOR_ENTITY_TOMBSTONED');
    if(tombstoneKey)conditions.push({store:'entity_tombstones',key:tombstoneKey,expected:undefined});
    if(change.kind==='content_manifest'){if(p.reference.totalBytes>SMALL)await streamedPublicBank(p.reference);else await smallContent(p.reference);}
    else if(change.kind==='bank_revision'){
      let ref=p.contentManifest.reference;
      if(p.contentManifest.kind==='public_static'){const refs=[];for await(const reference of sourceAccess.referencesFor(change)){await check();refs.push(reference);if(refs.length>1)fail('PROJECTOR_PUBLIC_REFERENCE');}await check();ref=selectPublicBankProjectionReference(p,refs);await check();}
      if(!ref)fail('PROJECTOR_CONTENT_REFERENCE_UNAVAILABLE');
      const large=ref.totalBytes>SMALL;if(large&&p.contentManifest.kind==='protected_cipher')fail('PROJECTOR_LARGE_SEMANTICS_UNSUPPORTED');
      const entry=large?null:await smallContent(ref);
      const body=large?await streamedPublicBank(ref):p.contentManifest.kind==='protected_cipher'?await validateProtectedBankEnvelopeV2(entry.value):await validateBankContent(entry.value);
      if(large&&(body.bankUid!==p.bankUid||body.contentDigest!==p.revision||!same(body.metadata,p.metadata)))fail('PROJECTOR_BANK_BINDING');
      if(!large&&(body.contentDigest!==p.revision||(body.content?.bankUid??body.envelope?.bankUid)!==p.bankUid))fail('PROJECTOR_BANK_BINDING');
      if(body.content&&!same(body.content.metadata,p.metadata))fail('PROJECTOR_BANK_BINDING');
      if(body.envelope&&(p.metadata.visibility!=='protected'||p.metadata.questionCount!==body.questionRefs.length))fail('PROJECTOR_BANK_BINDING');
      await put('bank_revisions',{bankUid:p.bankUid,revision:p.revision,metadata:p.metadata,contentManifest:p.contentManifest});
    }else if(change.kind==='history_snapshot'){
      if(p.accountGeneration!==checkpoint.generation)fail('PROJECTOR_SNAPSHOT_OWNER');
      const {value}=await smallContent(p.reference);
      await validateHistorySnapshotBinding(p,value,{accountGeneration:checkpoint.generation});
      await put('history_snapshots',p);
    }else if(change.kind==='attempt_manifest'){
      const old=await read('attempts',p.attemptId);
      if(old&&(old.scopeDigest!==p.scopeDigest||old.scopeCount!==p.scopeCount||old.writerStreamId!==p.writerStreamId||old.startedAt!==p.startedAt||old.parentAttemptId!==p.parentAttemptId))fail('PROJECTOR_ATTEMPT_BINDING');
      await put('attempts',{attemptId:p.attemptId,status:p.status,startedAt:p.startedAt,scopeDigest:p.scopeDigest,scopeCount:p.scopeCount,writerStreamId:p.writerStreamId,position:old?.position??0,effectiveElapsedMs:old?.effectiveElapsedMs??0,localRevision:old?.localRevision??1,actionSeq:old?.actionSeq??0,...(p.parentAttemptId?{parentAttemptId:p.parentAttemptId}:{})});
    }else if(change.kind==='attempt_scope'){
      const attempt=await read('attempts',p.attemptId);
      if(!attempt)fail('PROJECTOR_ATTEMPT_MISSING');
      const {value}=await smallContent(p.reference);
      if(await sha256Hex(canonicalContentBytes(value))!==p.scopeDigest||attempt.scopeDigest!==p.scopeDigest)fail('PROJECTOR_SCOPE_BINDING');
      validateAttemptScope(value,p.attemptId,attempt.scopeCount);
      // Each exact CAS is complete before advancing. Partial inactive facts are
      // not published; this method does not certify an attempt bundle.
      conditions.push({store:'attempts',key:p.attemptId,expected:attempt});
      const baseConditions=conditions.slice();
      for(const row of value){
        await put('attempt_scope',row);
        if(writes.length===100){await commit(writes,receipt,conditions);writes.length=0;for(const condition of baseConditions)if(versionReceipt&&condition.store==='import_receipts'&&same(condition.key,[sourceId,versionReceipt.sourceRecordId]))condition.expected=versionReceipt;conditions.splice(0,conditions.length,...baseConditions);}
      }
    }else if(change.kind==='answer_event') await put('answer_events',p.event);
    else if(change.kind==='user_state')await put('user_state',{questionKey:p.questionKey,field:p.field,value:p.value,starredKey:p.value?1:0,serverRevision:change.serverRevision});
    else if(change.kind==='entity_tombstone'){
      const value={entityKey:change.entityKey,entityKind:p.entityKind,entityId:p.entityId,status:'confirmed',accountGeneration:checkpoint.generation,serverSeq:change.serverSeq};
      const old=await read('entity_tombstones',change.entityKey);
      if(old&&(!same(old,value)))fail('PROJECTOR_TOMBSTONE_DIVERGENCE');
      conditions.push({store:'entity_tombstones',key:change.entityKey,expected:old});writes.push({store:'entity_tombstones',value});
      await commit(writes,receipt,conditions);writes.length=0;
      // Explicit confirmed attempt retirement matches normal pull: remove only
      // its live projection. Immutable source receipts/content remain proof;
      // bank retirement is NOT an implicit cascade through learning facts.
      if(p.entityKind==='attempt'){
        for(const store of ['attempt_scope','drafts','answer_events'])for await(const row of range(store,'attemptId',p.entityId))await commit([],receipt,[{store:'entity_tombstones',key:change.entityKey,expected:value},{store,key:row.key,expected:row.value}],[{store,key:row.key}]);
        const oldAttempt=await read('attempts',p.entityId);if(oldAttempt)await commit([],receipt,[{store:'entity_tombstones',key:change.entityKey,expected:value},{store:'attempts',key:p.entityId,expected:oldAttempt}],[{store:'attempts',key:p.entityId}]);
      }
      if(p.entityKind==='bank')for await(const row of range('bank_revisions','bankUid',p.entityId)){
        await commit([],receipt,[{store:'entity_tombstones',key:change.entityKey,expected:value},{store:'bank_revisions',key:row.key,expected:row.value}],[{store:'bank_revisions',key:row.key}]);
      }
      if(p.entityKind==='history_snapshot'){
        const row=await read('history_snapshots',p.entityId);
        if(row)await commit([],receipt,[{store:'entity_tombstones',key:change.entityKey,expected:value},{store:'history_snapshots',key:p.entityId,expected:row}],[{store:'history_snapshots',key:p.entityId}]);
      }
    }else if(change.kind==='resume_state'){
      const attempt=await read('attempts',p.attemptId);if(!attempt)fail('PROJECTOR_ATTEMPT_MISSING');
      if(attempt.writerStreamId!==p.writerStreamId||p.localRevision<attempt.localRevision)fail('PROJECTOR_RESUME_BINDING');
      await refreshDependencies();
      const expectedSource={sourceId:receipt.sourceId,sourceRecordId:receipt.sourceRecordId,rowDigest:await sha256Hex(canonicalBytes(receipt)),generation:checkpoint.generation,logEpoch:checkpoint.logEpoch,serverSeq:change.serverSeq,entityKey:change.entityKey,payloadDigest:change.payloadDigest};await check();
      const view=await dependencies.openIndexedHistoricalResume(p.contentDigest,{expectedSource});
      try {
      await view.recheck();await check();
      if(view.status!=='historical_native_locator_view'||!same(view.reference,p)||view.header.attemptId!==p.attemptId||view.header.writerStreamId!==p.writerStreamId||view.header.localRevision!==p.localRevision||!Number.isSafeInteger(view.eventCount)||view.eventCount<0)fail('PROJECTOR_RESUME_BINDING');
      if(view.header.snapshotBaseline){const b=view.header.snapshotBaseline,index=view.snapshotContinuationReceipt;if(!index)fail('PROJECTOR_SNAPSHOT_BASELINE');await assertSnapshotContinuationReceipt(index,b,{attemptId:p.attemptId,commandId:await deriveSnapshotContinuationCommandId(b.continuationKey)});const key=[index.sourceId,index.sourceRecordId],old=await read('import_receipts',key);if(old)await assertSnapshotContinuationReceipt(old,b,{attemptId:p.attemptId,commandId:index.provenance.commandId});else{conditions.push({store:'import_receipts',key,expected:undefined});writes.push({store:'import_receipts',value:index});}}
      const nextAttempt={...attempt,localRevision:p.localRevision,position:view.header.position,effectiveElapsedMs:view.header.effectiveElapsedMs,actionSeq:view.eventCount};
      for await(const original of range('drafts','attemptId',p.attemptId)){
        await commit([],receipt,[{store:'attempts',key:p.attemptId,expected:attempt},{store:'drafts',key:original.key,expected:original.value}],[{store:'drafts',key:original.key}]);
      }
      // The private generator rechecks native source context/row per yield and
      // full D12 at its endpoints. Do not repeat full ancestor scans per draft.
      for await(const draft of view.drafts()){
        await check();
        const value={...draft,attemptId:p.attemptId,writerStreamId:p.writerStreamId,fence:1,dirty:false};
        await commit([{store:'drafts',value}],receipt,[{store:'attempts',key:p.attemptId,expected:attempt},{store:'drafts',key:nativeRecordKey('drafts',value),expected:undefined}]);
      }
      await view.recheck();await check();
      conditions.push({store:'attempts',key:p.attemptId,expected:attempt});writes.push({store:'attempts',value:nextAttempt});
      } finally { view.close(); }
    }
    else fail('PROJECTOR_KIND');
    if(writes.length)await commit(writes,receipt,conditions);
    // The stable oracle seals ALL non-owned receipts as well as physical
    // banks. Entity revision provenance is a real cut change too. Keep its
    // original seal; correctness-first fresh cuts may be costly at scale.
    if(versionReceipt||change.kind==='bank_revision'||change.kind==='history_snapshot'||change.kind==='entity_tombstone')dependenciesDirty=true;
    // Re-read exact source after writes; a changed original cannot be counted.
    const after=await source(captured.serverSeq);
    if(!same(receipt,after.receipt))fail('PROJECTOR_SOURCE_CHANGED');
    await check();
    return {status:'source_projected_unverified',serverSeq:change.serverSeq,kind:change.kind,ready:false};
  }
  function close(){closed=true;database.removeEventListener('versionchange',close);for(const abort of pending.values())abort(Object.assign(new Error('PROJECTOR_NOT_COMMITTED'),{code:'PROJECTOR_NOT_COMMITTED'}));dependencies.close();native.close();}
  database.addEventListener('versionchange',close);
  async function readDiagnostics(...args){if(args.length)fail('INVALID_INPUT');await check();const current=counters(),result={...metrics};for(const key of diagnosticKeys)result[key]=(totals[key]??0)+(current[key]??0);await check();return Object.freeze(result);}
  return Object.freeze({prepareNext,apply,close,readDiagnostics,status:'inactive_projector_source_only',ready:false});
}
