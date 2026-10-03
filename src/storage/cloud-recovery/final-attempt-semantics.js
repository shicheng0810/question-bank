import {validateSnapshotContinuationBaseline,assertSnapshotContinuationScope,assertSnapshotContinuationDraft,snapshotContinuationCounts,rebuildSnapshotContinuationReceipt} from '../../domain/app-data/snapshot-continuation.js';
import {canonicalBytes,canonicalContentBytes,sha256Hex,validateStoreRecord,validateAttemptScopeRecord,validateChunkManifest,validateContentReference,verifyMutationDigest,APP_DATA_STORES} from '../../domain/app-data/index.js';
import {sha256} from '@noble/hashes/sha2.js';
import {isUuid,isQuestionKey} from '../../domain/question/index.js';
import {validateBankContent,validateProtectedBankEnvelopeV2} from '../../domain/question/bank-content.js';
import {frozenPublicBanks as frozenPublic} from '../../domain/question/frozen-public-registry.js';
import {snapshotOwner} from '../profiles/control-schema.js';
import {assertFinalProofWorkspace} from '../profiles/managed-profile-registry.js';
import {createBoundedNativeAccess,NATIVE_BATCH_BYTES,nativeRecordSize} from './bounded-native.js';
import {mutationWire,validateSyncChangeReceipt} from '../sync/protocol.js';
import {ownedWriteInput} from '../idb/write-input.js';
import {streamCanonicalResumeRows} from '../../domain/app-data/resume-content-stream.js';
import {validateForkOriginReceipt} from '../sync/fork-origin.js';
import {derivedId} from '../../domain/attempt/commands.js';
import {createNativeRegisteredBankStreamer} from './bank-content-stream.js';

const fail=code=>Object.assign(new Error(code),{code});
/** Pure exact binding identity, NOT a body validation or cache authority.
 * The actual private consumer must separately reread every native body byte. */
export function publicBankSemanticBindingDigest(bank,reference,manifest){const hash=sha256.create();for(const [tag,value]of[['bank',bank],['reference',reference],['manifest',manifest]]){hash.update(canonicalBytes(tag));hash.update(canonicalBytes(value));}return Array.from(hash.digest(),byte=>byte.toString(16).padStart(2,'0')).join('');}
const PAGE=1024*1024,ROW=3*PAGE,CHUNK=512*1024;
/** Pure partition only. A descriptor is not native-read or semantic authority. */
export function groupNativeBankChunks(manifest){
 validateChunkManifest(manifest);const groups=[];let group=[],bytes=0;
 for(const descriptor of manifest.chunks){const retained=descriptor.byteLength+canonicalBytes({contentDigest:manifest.contentDigest,chunkIndex:descriptor.chunkIndex}).length+128;if(retained>NATIVE_BATCH_BYTES)throw fail('NATIVE_BATCH_BUDGET');if(group.length&&(group.length===100||bytes+retained>NATIVE_BATCH_BYTES)){groups.push(group);group=[];bytes=0;}group.push(descriptor);bytes+=retained;}if(group.length)groups.push(group);return groups;
}
const bytesEqual=(a,b)=>a.length===b.length&&a.every((value,index)=>value===b[index]);
const equal=(a,b)=>bytesEqual(canonicalBytes(a),canonicalBytes(b));
const hex=bytes=>Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('');
// One immutable derived membership entry per genuine private workspace/raw
// pair. It contains no content, leaf, locator or temporary part reference.
// Workspace lifetime/reset does not authorize it: every reuse below first
// verifies the actual source row, manifest and every new native chunk SHA.
// The first full body SHA/typed proof may be reused only for the same complete
// actual ordered chunk vector and private binding, never for a claimed digest.
const workspaceBankSemantics=new WeakMap();
const freezeDerived=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freezeDerived(child);Object.freeze(value);}return value;};
const pad=value=>String(value).padStart(20,'0');
const before=(left,right)=>left.length<right.length||left.length===right.length&&left<=right;

/** Pure predicates only: no authority, storage or payload-verification result. */
export function checkInheritedDraftRelation(child,parent){
  canonicalBytes(child);canonicalBytes(parent);
  if(child.questionRevision!==parent.questionRevision||!equal(child.input,parent.input)||child.submitted!==parent.submitted||parent.assisted&&!child.assisted||parent.showKeys&&!child.showKeys)throw fail('RESUME_INHERITED_DRAFT_MISMATCH');
}
export function checkHistoricalSourceCut(event,resume){
  if(Object.hasOwn(resume.reference,'serverSeq'))return Object.hasOwn(event.reference,'serverSeq')&&event.logEpoch===resume.logEpoch&&before(event.reference.serverSeq,resume.reference.serverSeq);
  return !Object.hasOwn(event.reference,'serverSeq')&&event.reference.clientStreamId===resume.reference.clientStreamId&&event.reference.clientSeq<=resume.reference.clientSeq;
}
/** Cloud ancestry must be admitted no later than the child's actual cut.
 * Local cross-stream forks have no shared server clock; retain their original
 * typed ancestry proof rather than inventing an ordering between streams. */
export function checkHistoricalParentCut(parent,child){
  if(Object.hasOwn(child.reference,'serverSeq'))return Object.hasOwn(parent.reference,'serverSeq')&&parent.logEpoch===child.logEpoch&&before(parent.reference.serverSeq,child.reference.serverSeq);
  return !Object.hasOwn(parent.reference,'serverSeq');
}
export function checkExpectedResumeSource(context,expected,owner){
  return context.pointer.store==='import_receipts'&&equal(context.pointer.key,[expected.sourceId,expected.sourceRecordId])&&context.pointer.rowDigest===expected.rowDigest&&owner.ownerKind==='account'&&owner.accountGeneration===expected.generation&&context.logEpoch===expected.logEpoch&&context.reference.serverSeq===expected.serverSeq&&context.reference.entityKey===expected.entityKey&&context.reference.payloadDigest===expected.payloadDigest;
}

/** Pure typed relationship, not a native/global/provenance proof. */
export function checkScopeRowBinding(row,attempt,ordinal){
  validateAttemptScopeRecord(row);
  if(row.attemptId!==attempt.attemptId||row.ordinal!==ordinal||row.displayOrdinal!==ordinal||ordinal>=attempt.scopeCount)throw fail('FINAL_SCOPE_BINDING');
}
/** Navigation key only; uniqueness is enforced by real native absence-CAS. */
export function scopeSourceIndexLabel(attemptId,questionKey){if(!isUuid(attemptId)||!isQuestionKey(questionKey))throw fail('FINAL_DEPENDENCY_INPUT');return `scope:${attemptId}:source:${questionKey}`;}

/** Pure byte layout only. It never authorizes a workspace/source/Ready result. */
export function packScopeCanonicalRows(rows){
  if(!Array.isArray(rows)||rows.length<1||rows.length>100)throw fail('FINAL_SCOPE_PACK_INPUT');
  let total=0;for(const row of rows){if(!row||Object.keys(row).sort().join()!=='bytes,ordinal'||!Number.isSafeInteger(row.ordinal)||row.ordinal<0||!(row.bytes instanceof Uint8Array)||row.bytes.length<1||row.bytes.length>ROW)throw fail('FINAL_SCOPE_PACK_INPUT');total+=row.bytes.length;}
  if(total>PAGE&&rows.length!==1)throw fail('FINAL_SCOPE_PACK_INPUT');
  const parts=[],locators=[];let part=null,used=0;
  for(const row of rows){let offset=0;const segments=[];while(offset<row.bytes.length){if(part===null||used===CHUNK){part=new Uint8Array(Math.min(CHUNK,total-parts.reduce((sum,value)=>sum+value.length,0)));parts.push(part);used=0;}
    const length=Math.min(part.length-used,row.bytes.length-offset);part.set(row.bytes.subarray(offset,offset+length),used);segments.push({partIndex:parts.length-1,offset:used,length});used+=length;offset+=length;
  }locators.push({ordinal:row.ordinal,byteLength:row.bytes.length,segments});}
  return {parts,rows:locators};
}
/** Pure schema/slice/hash check; caller-provided parts are not native proof. */
export async function checkPackedScopeRow(value,parts,expected){
  if(!value||Object.keys(value).sort().join()!=='attemptId,byteLength,format,ordinal,parts,rowDigest'||value.format!=='qb-final-scope-row-packed-v1'||!isUuid(value.attemptId)||!Number.isSafeInteger(value.ordinal)||value.ordinal<0||!Number.isSafeInteger(value.byteLength)||value.byteLength<1||value.byteLength>ROW||typeof value.rowDigest!=='string'||!/^[0-9a-f]{64}$/.test(value.rowDigest)||!Array.isArray(value.parts)||value.parts.length<1||value.parts.length>7||!(parts instanceof Map)||!(expected instanceof Uint8Array)||expected.length!==value.byteLength)throw fail('FINAL_SOURCE_INDEX_CORRUPT');
  const bytes=new Uint8Array(value.byteLength);let offset=0,previous=null;
  for(const segment of value.parts){if(!segment||Object.keys(segment).sort().join()!=='byteLength,label,length,offset,sha256'||typeof segment.label!=='string'||!Number.isSafeInteger(segment.byteLength)||segment.byteLength<1||segment.byteLength>CHUNK||!Number.isSafeInteger(segment.offset)||segment.offset<0||!Number.isSafeInteger(segment.length)||segment.length<1||segment.offset+segment.length>segment.byteLength||offset+segment.length>bytes.length||typeof segment.sha256!=='string'||!/^[0-9a-f]{64}$/.test(segment.sha256))throw fail('FINAL_SOURCE_INDEX_CORRUPT');
    const match=new RegExp(`^scope:${value.attemptId}:pack:(0|[1-9][0-9]*):part:(0|[1-9][0-9]*)$`).exec(segment.label);
    if(!match||!Number.isSafeInteger(Number(match[1]))||Number(match[1])>value.ordinal||!Number.isSafeInteger(Number(match[2]))||previous&&(match[1]!==previous.start||Number(match[2])!==previous.index+1||segment.offset!==0||previous.offset+previous.length!==previous.byteLength))throw fail('FINAL_SOURCE_INDEX_CORRUPT');
    const actual=parts.get(segment.label);if(!(actual instanceof Uint8Array)||actual.length!==segment.byteLength||await sha256Hex(actual)!==segment.sha256)throw fail('FINAL_SOURCE_INDEX_CORRUPT');bytes.set(actual.subarray(segment.offset,segment.offset+segment.length),offset);offset+=segment.length;previous={start:match[1],index:Number(match[2]),offset:segment.offset,length:segment.length,byteLength:segment.byteLength};
  }
  if(offset!==bytes.length||await sha256Hex(bytes)!==value.rowDigest||!bytesEqual(bytes,expected))throw fail('FINAL_SOURCE_INDEX_CORRUPT');
}

/** Unimported S2.2 runtime candidate. Only the actual registry WeakMap and
 * SAME native handle authorize temporary indices. No callbacks/facts/hash/
 * Ready DTO are accepted. The public result cannot activate any profile.
 */
export async function createFinalAttemptSemantics(database,workspace){
  assertFinalProofWorkspace(workspace,database);
  const metadata=ownedWriteInput(await workspace.metadata());assertFinalProofWorkspace(workspace,database);
  const owner=snapshotOwner(metadata.owner),sourceId=metadata.sourceId;
  if(sourceId!==`qb-cloud-stage-index:${metadata.workspaceId}`||!isUuid(metadata.workspaceId)||!isUuid(metadata.profileId))throw fail('FINAL_WORKSPACE_BINDING');
  let closed=false,prepared=false,failed=false,bankCache=null,sourceSeal=null,largeBankSemantics=null;const pending=new Map(),bankStreamers=new Set();
  const counters={prepareSourceRows:0,prepareSourceReadBatches:0,prepareSourceReadCompleted:0,scopeRows:0,indexReads:0,indexReadBatches:0,indexWrites:0,indexWriteBatches:0,scopeReadBatches:0,partWrites:0,partReads:0,bankBodyHashes:0,freshFullBodyHashes:0,rawProofReuses:0,actualChunkHashes:0,bankSemanticParses:0,bankSemanticReuses:0,bankRawHashBytes:0,scopeMs:0,sourceCheckMs:0};
  const guard=()=>{if(closed)throw fail('CLOSED');assertFinalProofWorkspace(workspace,database);};
  const check=async()=>{guard();await workspace.check();guard();};
  const native=await createBoundedNativeAccess(database,{guard});
  const close=()=>{if(closed)return;closed=true;largeBankSemantics=null;bankCache=null;database.removeEventListener('versionchange',close);for(const [tx,reject]of pending){try{tx.abort();}catch{}reject(fail('FINAL_NATIVE_NOT_COMMITTED'));}pending.clear();for(const streamer of bankStreamers)streamer.close();bankStreamers.clear();native.close();};
  database.addEventListener('versionchange',close);
  async function get(store,key){await check();const [row]=await native.readKeys([{store,key}]);await check();return row;}
  async function* recordPages(store,range=null){
    let after=null;
    do{
      await check();const page=await new Promise((resolve,reject)=>{
        let tx,ended=false,result,timer;const rows=[];let bytes=64,last=null;
        const finish=cause=>{if(ended)return;ended=true;clearTimeout(timer);pending.delete(tx);if(cause)reject(cause);else resolve(result);};
        const abort=cause=>{try{tx?.abort();}catch{}finish(cause);};
        try{guard();tx=database.transaction([store],'readonly');pending.set(tx,finish);tx.oncomplete=()=>finish();tx.onabort=()=>finish(fail('FINAL_NATIVE_NOT_COMMITTED'));tx.onerror=()=>{};timer=setTimeout(()=>abort(fail('FINAL_NATIVE_NOT_COMMITTED')),5000);
          const bound=after===null?range:range?IDBKeyRange.bound(after,range.upper,true,range.upperOpen):IDBKeyRange.lowerBound(after,true);
          const request=tx.objectStore(store).openCursor(bound);request.onerror=()=>abort(fail('FINAL_NATIVE_NOT_COMMITTED'));
          request.onsuccess=()=>{try{guard();const cursor=request.result;if(!cursor){result={rows,after:null};return;}if(rows.length===100){result={rows,after:last};return;}const row=cursor.value;validateStoreRecord(store,row);const path=APP_DATA_STORES[store].keyPath,key=Array.isArray(path)?path.map(field=>row[field]):row[path];if(indexedDB.cmp(key,cursor.primaryKey)!==0)throw fail('BACKUP_DUPLICATE_RECORD');const size=canonicalBytes(row).length;if(size>ROW)throw fail('FINAL_NATIVE_ROW_BUDGET');if(rows.length&&bytes+size>PAGE){result={rows,after:last};return;}rows.push(row);bytes+=size;last=ownedWriteInput(cursor.primaryKey);if(bytes>PAGE){result={rows,after:last};return;}cursor.continue();}catch(cause){abort(cause);}};
        }catch(cause){abort(cause);}
      });await check();yield page.rows;after=page.after;
    }while(after!==null);
  }
  async function* records(store,range=null){for await(const rows of recordPages(store,range))for(const row of rows)yield row;}
  async function validateSourceRow(pointer,row){
    if(!row)throw fail('FINAL_SOURCE_INDEX_CORRUPT');
    validateStoreRecord(pointer.store,row);
    const path=APP_DATA_STORES[pointer.store].keyPath,key=Array.isArray(path)?path.map(field=>row[field]):row[path];
    if(indexedDB.cmp(key,pointer.key)!==0)throw fail('FINAL_SOURCE_INDEX_CORRUPT');
    if(await sha256Hex(canonicalBytes(row))!==pointer.rowDigest)throw fail('FINAL_SOURCE_INDEX_CORRUPT');await check();
    if(pointer.store==='mutations'){
      if(owner.ownerKind==='account'?row.accountGeneration!==owner.accountGeneration:row.accountGeneration!==undefined)throw fail('BACKUP_OWNER_MISMATCH');
      if(!await verifyMutationDigest(mutationWire(row)))throw fail('BACKUP_MUTATION_DIGEST');await check();return row;
    }
    const verified=await validateSyncChangeReceipt(row);await check();
    if(owner.ownerKind!=='account'||verified.provenance.generation!==owner.accountGeneration)throw fail('BACKUP_OWNER_MISMATCH');return verified.provenance.change;
  }
  async function rereadPreparePage(store,rows){
    const items=[];for(const row of rows){const pointer=await locator(store,row);await check();items.push({pointer,size:nativeRecordSize(store,row)});}
    const result=[];let offset=0;
    while(offset<items.length){
      const group=[];let bytes=64;
      while(offset<items.length&&group.length<100){const item=items[offset];
        if(item.size>ROW)throw fail('FINAL_NATIVE_ROW_BUDGET');
        if(group.length&&bytes+item.size>PAGE)break;
        group.push(item);bytes+=item.size;offset++;if(bytes>PAGE)break;
      }
      await check();counters.prepareSourceReadBatches++;counters.prepareSourceRows+=group.length;
      const actual=await native.readKeys(group.map(item=>({store,key:item.pointer.key})),{maxBytes:group.length===1&&group[0].size+64>PAGE?ROW:PAGE});await check();counters.prepareSourceReadCompleted++;
      if(!Array.isArray(actual)||actual.length!==group.length)throw fail('FINAL_SOURCE_INDEX_CORRUPT');
      const actualBytes=actual.reduce((sum,row)=>sum+(row?canonicalBytes(row).length:0),64);
      if(group.length>1&&actualBytes>PAGE||group.length===1&&actualBytes>ROW+64)throw fail('FINAL_NATIVE_ROW_BUDGET');
      for(let i=0;i<group.length;i++)result.push({pointer:group[i].pointer,source:await validateSourceRow(group[i].pointer,actual[i])});
    }
    return result;
  }
  async function readIndex(label){await check();counters.indexReads++;counters.indexReadBatches++;const row=await workspace.readIndex({label});await check();if(!row)return null;const p=row.provenance;if(row.sourceId!==sourceId||row.sourceRecordId!==`index:${label}`||p?.format!=='qb-final-proof-index-v1'||p.workspaceId!==metadata.workspaceId||p.label!==label)throw fail('FINAL_SOURCE_INDEX_CORRUPT');return p.value;}
  async function indexRows(labels){
    const result=new Map();for(let offset=0;offset<labels.length;offset+=100){const batch=labels.slice(offset,offset+100);await check();counters.indexReads+=batch.length;counters.indexReadBatches++;const rows=await workspace.readIndexes({labels:batch});await check();if(!Array.isArray(rows)||rows.length!==batch.length)throw fail('FINAL_SOURCE_INDEX_CORRUPT');for(let i=0;i<batch.length;i++){const row=rows[i],label=batch[i];if(row){const p=row.provenance;if(row.sourceId!==sourceId||row.sourceRecordId!==`index:${label}`||p?.format!=='qb-final-proof-index-v1'||p.workspaceId!==metadata.workspaceId||p.label!==label)throw fail('FINAL_SOURCE_INDEX_CORRUPT');}result.set(label,row);}}return result;
  }
  async function putIndexes(rows){if(!rows.length)return;await check();counters.indexWriteBatches++;counters.indexWrites+=rows.length;await workspace.writeIndexes({rows});await check();}
  async function putIndex(label,value){await putIndexes([{label,value}]);}
  async function writePart(input){counters.partWrites++;return workspace.writePart(input);}
  async function readPart(input){counters.partReads++;return workspace.readPart(input);}
  async function* indexes(prefix){let after=null;do{await check();const page=await workspace.scanIndexes({prefix:`index:${prefix}`,after,limit:100,maxBytes:PAGE});await check();const labels=page.rows.map(row=>row.provenance?.label);if(new Set(labels).size!==labels.length)throw fail('FINAL_SOURCE_INDEX_CORRUPT');let actual;
    // scanIndexes deliberately permits a legal oversized singleton. Do not
    // feed it to the stricter 1 MiB aggregate batch API or catch budget errors.
    if(page.rows.length===1&&canonicalBytes(page.rows[0]).length>PAGE){const label=labels[0];await check();counters.indexReads++;counters.indexReadBatches++;const row=await workspace.readIndex({label});await check();actual=new Map([[label,row]]);}else actual=await indexRows(labels);
    for(const row of page.rows){const reread=actual.get(row.provenance?.label);if(!reread||!equal(row,reread))throw fail('FINAL_SOURCE_INDEX_CORRUPT');yield reread.provenance.value;}after=page.after;}while(after!==null);}
  async function locator(store,row){return {store,key:store==='mutations'?row.mutationId:store==='bank_revisions'?[row.bankUid,row.revision]:[row.sourceId,row.sourceRecordId],rowDigest:await sha256Hex(canonicalBytes(row))};}
  async function loadSource(pointer){const row=await get(pointer.store,pointer.key);if(!row||await sha256Hex(canonicalBytes(row))!==pointer.rowDigest)throw fail('FINAL_SOURCE_INDEX_CORRUPT');await check();if(pointer.store==='bank_revisions')return row;if(pointer.store==='mutations'){if(owner.ownerKind==='account'?row.accountGeneration!==owner.accountGeneration:row.accountGeneration!==undefined)throw fail('BACKUP_OWNER_MISMATCH');if(!await verifyMutationDigest(mutationWire(row)))throw fail('BACKUP_MUTATION_DIGEST');await check();return row;}const verified=await validateSyncChangeReceipt(row);await check();if(owner.ownerKind!=='account'||verified.provenance.generation!==owner.accountGeneration)throw fail('BACKUP_OWNER_MISMATCH');return verified.provenance.change;}
  async function sourceContext(pointer){const reference=await loadSource(pointer);let logEpoch=null;if(pointer.store==='import_receipts'){const row=await get('import_receipts',pointer.key);if(await sha256Hex(canonicalBytes(row))!==pointer.rowDigest)throw fail('FINAL_SOURCE_INDEX_CORRUPT');logEpoch=row.provenance.logEpoch;}await check();return {reference,logEpoch,pointer};}
  async function prepare(){
    if(prepared)return;if(failed)throw fail('FINAL_PROOF_SESSION_FAILED');
    try{
      let ordinal=0;const seal=sha256.create();
      for(const store of ['mutations','import_receipts'])for await(const rows of recordPages(store)){
        const qualifying=[];for(const row of rows){
        if(store==='import_receipts'){
          const temporary=['qb-cloud-stage-page-v1','qb-cloud-stage-index-v1','qb-final-proof-index-v1','qb-final-proof-part-v1','qb-final-proof-reservation-v1'].includes(row.provenance?.format);
          if(row.sourceId===sourceId){if(!['qb-final-proof-index-v1','qb-final-proof-part-v1','qb-final-proof-reservation-v1'].includes(row.provenance?.format)||row.provenance.workspaceId!==metadata.workspaceId)throw fail('FINAL_SOURCE_INDEX_CORRUPT');continue;}
          if(temporary||row.sourceId.startsWith('qb-cloud-stage-index:')&&isUuid(row.sourceId.slice('qb-cloud-stage-index:'.length)))throw fail('BACKUP_UNFINISHED_CLOUD_STAGE');
        }
        seal.update(canonicalBytes(store));seal.update(canonicalBytes(row));
        if(store==='import_receipts'&&row.provenance?.format!=='qb-sync-change-v1')continue;
        qualifying.push(row);}
        for(const {pointer,source} of await rereadPreparePage(store,qualifying)){
        const rank=String(ordinal++).padStart(10,'0');
        if(source.kind==='content_manifest'){const label=`content:${source.payload.reference.contentDigest}`,old=await readIndex(label);if(old){const previous=await loadSource(old);if(!equal(previous.payload.reference,source.payload.reference))throw fail('BACKUP_CONTENT_DIGEST');}else await putIndex(label,pointer);}
        if(source.kind==='bank_revision')await putIndex(`bank:${source.payload.bankUid}:${source.payload.revision}:${rank}`,pointer);
        if(source.kind==='history_snapshot')await putIndex(`snapshotSource:${source.payload.snapshotId}:${rank}`,pointer);
        if(source.kind==='resume_state'){await putIndex(`resumeSource:${source.payload.contentDigest}:${rank}`,pointer);await putIndex(`currentSource:${source.payload.attemptId}:${pad(source.payload.localRevision)}:${rank}`,pointer);}
        if(source.kind==='answer_event'){const event=source.payload.event,context=await sourceContext(pointer),cut=context.logEpoch?`cloud:${context.logEpoch}:${pad(source.serverSeq)}`:`local:${source.clientStreamId}:${pad(source.clientSeq)}`;await putIndex(`eventSource:${event.attemptId}:${event.writerStreamId}:${cut}:${rank}`,pointer);}
        }
      }
      for await(const bank of records('bank_revisions')){seal.update(canonicalBytes('bank_revisions'));seal.update(canonicalBytes(bank));await putIndex(`bank:${bank.bankUid}:${bank.revision}:physical`,await locator('bank_revisions',bank));}
      sourceSeal=hex(seal.digest());prepared=true;
    }catch(cause){failed=true;throw cause;}
  }
  async function bankBody(pointer){
    const source=await loadSource(pointer),bank=source.kind==='bank_revision'?source.payload:source;
    if(bank.contentManifest.kind==='unavailable')throw fail('BACKUP_CONTENT_MISSING');
    let reference=bank.contentManifest.reference;
    if(bank.metadata.visibility==='public'){
      const known=frozenPublic.find(row=>row.bankUid===bank.bankUid&&row.revision===bank.revision);
      if(!known||!equal(known.metadata,bank.metadata)||!equal(known.contentManifest,bank.contentManifest))throw fail('UNTRUSTED_PUBLIC_REFERENCE');reference=known.publicContentReference;
    }
    if(!reference){const original=await readIndex(`content:${bank.contentManifest.contentDigest}`);if(!original)throw fail('BACKUP_CONTENT_MISSING');reference=(await loadSource(original)).payload.reference;}
    validateContentReference(reference);
    if(reference.contentDigest!==bank.revision)throw fail('BACKUP_BANK_BINDING');
    if(reference.totalBytes>ROW&&bank.metadata.visibility!=='public')throw fail(bank.contentManifest.kind==='protected_cipher'?'protected_cipher_limit':'bank_content_limit');
    // Reuse only a source-bound semantic bank group. Every completed operation
    // below rereads all verified bank bodies before exposing its NoReady result.
    if(bankCache?.digest===reference.contentDigest&&equal(bankCache.metadata,bank.metadata)&&bankCache.bankUid===bank.bankUid)return bankCache;
    const manifestRow=await get('content_chunks',[reference.manifestDigest,0]);if(!manifestRow||await sha256Hex(manifestRow.bytes)!==reference.manifestDigest)throw fail('BACKUP_CONTENT_MISSING');
    const manifest=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(manifestRow.bytes));validateChunkManifest(manifest);
    if(!bytesEqual(canonicalBytes(manifest),manifestRow.bytes)||manifest.contentDigest!==reference.contentDigest||manifest.chunkCount!==reference.chunkCount||manifest.totalBytes!==reference.totalBytes)throw fail('BACKUP_CONTENT_DIGEST');
    let actualVector=[];
    async function* chunks(){actualVector=[];for(const descriptors of groupNativeBankChunks(manifest)){
      await check();const actual=await native.readKeys(descriptors.map(descriptor=>({store:'content_chunks',key:[reference.contentDigest,descriptor.chunkIndex]})));await check();
      if(actual.length!==descriptors.length)throw fail('BACKUP_CONTENT_DIGEST');
      for(let i=0;i<descriptors.length;i++){const descriptor=descriptors[i],chunk=actual[i];if(!chunk||chunk.contentDigest!==reference.contentDigest||chunk.chunkIndex!==descriptor.chunkIndex||chunk.bytes.length!==descriptor.byteLength)throw fail('BACKUP_CONTENT_DIGEST');const actualSha=await sha256Hex(chunk.bytes);counters.actualChunkHashes++;if(actualSha!==descriptor.sha256)throw fail('BACKUP_CONTENT_DIGEST');actualVector.push({chunkIndex:chunk.chunkIndex,byteLength:chunk.bytes.length,sha256:actualSha});if(actualVector.length>200)throw fail('FINAL_BANK_CHUNK_VECTOR_BUDGET');await check();yield chunk.bytes;await check();}
    }}
    // Lexical-only: uses genuine native/workspace/database/check/guard.
    // No exported verifier, callback authority, permission cache or native write.
    async function verifyActualChunkVector(){
      const vector=[];let rawBytes=0;
      for(const descriptors of groupNativeBankChunks(manifest)){
        await check();
        const actual=await native.readKeys(descriptors.map(descriptor=>({store:'content_chunks',key:[reference.contentDigest,descriptor.chunkIndex]})));
        await check();
        if(!Array.isArray(actual)||actual.length!==descriptors.length)throw fail('BACKUP_CONTENT_DIGEST');
        for(let i=0;i<descriptors.length;i++){
          guard();
          const descriptor=descriptors[i],chunk=actual[i];
          if(!chunk)throw fail('BACKUP_CONTENT_DIGEST');
          if(chunk.contentDigest!==reference.contentDigest||chunk.chunkIndex!==descriptor.chunkIndex||!(chunk.bytes instanceof Uint8Array)||chunk.bytes.length!==descriptor.byteLength)throw fail('BACKUP_CONTENT_DIGEST');
          const actualSha=hex(sha256(chunk.bytes));counters.actualChunkHashes++;
          guard();
          if(actualSha!==descriptor.sha256)throw fail('BACKUP_CONTENT_DIGEST');
          vector.push({chunkIndex:chunk.chunkIndex,byteLength:chunk.bytes.length,sha256:actualSha});
          rawBytes+=chunk.bytes.length;
          if(vector.length>200)throw fail('FINAL_BANK_CHUNK_VECTOR_BUDGET');
          guard();
        }
        await check();
      }
      if(rawBytes!==reference.totalBytes||vector.length!==reference.chunkCount)throw fail('BACKUP_CONTENT_DIGEST');
      if(canonicalBytes(vector).length>65536)throw fail('FINAL_BANK_CHUNK_VECTOR_BUDGET');
      await check();
      return vector;
    }
    const readBankEpoch=async()=>{const row=await get('meta','serverLogEpoch');if(row!==undefined&&row.key!=='serverLogEpoch')throw fail('FINAL_BANK_EPOCH_BINDING');return row===undefined?{present:false}:{present:true,row:ownedWriteInput(row)};};
    let verified,installEntry=null,reusedRawProof=false,epochBefore=null;
    if(reference.totalBytes>ROW){
      // The first full raw SHA and parser/derive proof may be reused. Every endpoint still reads
      // the actual typed source PK, frozen relation, manifest and all native
      // chunk PK/schema/actual SHA under the same guards; the complete ordered
      // actual vector must match before reusing the first full body proof.
      // One bounded private entry, never a caller DTO or meta-version cache.
      epochBefore=await readBankEpoch();
      const binding=freezeDerived(ownedWriteInput({metadata,sourceLocator:pointer,serverLogEpoch:epochBefore,bank,reference,manifest})),bindingDigest=publicBankSemanticBindingDigest(bank,reference,manifest);
      const inherited=workspaceBankSemantics.get(workspace);
      const candidate=inherited?.database===database&&inherited.bindingDigest===bindingDigest&&equal(inherited.binding,binding)?inherited:null;
      const rawHash=candidate?null:sha256.create();let rawBytes=0;
      if(candidate){actualVector=await verifyActualChunkVector();rawBytes=reference.totalBytes;}
      else{for await(const bytes of chunks()){if(rawHash){rawHash.update(bytes);counters.bankRawHashBytes+=bytes.length;}rawBytes+=bytes.length;await check();}}
      if(rawBytes!==reference.totalBytes||actualVector.length!==reference.chunkCount)throw fail('BACKUP_CONTENT_DIGEST');if(canonicalBytes(actualVector).length>65536)throw fail('FINAL_BANK_CHUNK_VECTOR_BUDGET');const firstVector=freezeDerived(ownedWriteInput(actualVector));
      if(candidate){if(!equal(candidate.vector,firstVector))throw fail('BACKUP_CONTENT_DIGEST');assertFinalProofWorkspace(workspace,database);verified=candidate.verified;reusedRawProof=true;}
      else{if(hex(rawHash.digest())!==reference.contentDigest)throw fail('BACKUP_CONTENT_DIGEST');counters.freshFullBodyHashes++;await check();counters.bankSemanticParses++;const refs=[],inputShapes={},streamer=await createNativeRegisteredBankStreamer(database,workspace);bankStreamers.add(streamer);try{await check();const streamed=await streamer.stream({chunks:chunks(),reference,onQuestion:ref=>{refs.push(ref);},onQuestionContent:q=>{inputShapes[q.questionKey]={questionKey:q.questionKey,questionRevision:q.questionRevision,type:q.type||"choice",choices:(q.choices||[]).map(()=>null),optionIds:q.optionIds,blanks:(q.blanks||[]).map(()=>null)};}});verified={...streamed,questionRefs:refs,inputShapes};await check();}finally{streamer.close();bankStreamers.delete(streamer);}if(!equal(actualVector,firstVector))throw fail('BACKUP_CONTENT_DIGEST');if(canonicalBytes(refs).length>PAGE)throw fail('FINAL_BANK_MEMBERSHIP_INDEX_BUDGET');installEntry=Object.freeze({database,bindingDigest,binding,vector:firstVector,verified:freezeDerived(ownedWriteInput(verified))});}
    }
    else{const raw=new Uint8Array(reference.totalBytes);let offset=0;for await(const chunk of chunks()){raw.set(chunk,offset);offset+=chunk.length;}if(offset!==raw.length||await sha256Hex(raw)!==reference.contentDigest)throw fail('BACKUP_CONTENT_DIGEST');await check();const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));if(!bytesEqual(canonicalContentBytes(value),raw))throw fail('NON_CANONICAL_CONTENT');verified=bank.contentManifest.kind==='protected_cipher'?await validateProtectedBankEnvelopeV2(value):await validateBankContent(value);}
    await check();const uid=verified.bankUid||verified.content?.bankUid||verified.envelope?.bankUid;
    if(uid!==bank.bankUid||verified.contentDigest!==bank.revision||verified.questionRefs.length!==bank.metadata.questionCount||verified.content&&!equal(verified.content.metadata,bank.metadata)||verified.metadata&&!equal(verified.metadata,bank.metadata))throw fail('BACKUP_BANK_BINDING');
    if(canonicalBytes(verified.questionRefs).length>PAGE)throw fail('FINAL_BANK_MEMBERSHIP_INDEX_BUDGET');
    const verifiedLabel=`verifiedBank:${bank.bankUid}:${bank.revision}`,previous=await readIndex(verifiedLabel);if(!previous)await putIndex(verifiedLabel,pointer);
    if(epochBefore){const epochAfter=await readBankEpoch();if(!equal(epochBefore,epochAfter))throw fail('FINAL_BANK_EPOCH_CHANGED');await check();assertFinalProofWorkspace(workspace,database);if(installEntry)workspaceBankSemantics.set(workspace,installEntry);if(reusedRawProof){counters.rawProofReuses++;counters.bankSemanticReuses++;}}
    counters.bankBodyHashes++;bankCache={digest:reference.contentDigest,bankUid:uid,metadata:bank.metadata,refs:new Map(verified.questionRefs.map(row=>[row.questionKey,row.questionRevision])),inputShapes:verified.inputShapes||Object.fromEntries((verified.content?.questions||[]).map(q=>[q.questionKey,{questionKey:q.questionKey,questionRevision:q.questionRevision,type:q.type||'choice',choices:(q.choices||[]).map(()=>null),optionIds:q.optionIds,blanks:(q.blanks||[]).map(()=>null)}])),proofClass:verified.proofClass||'registered-full-body-derived'};return bankCache;
  }
  async function checkSources(){
    const started=performance.now();try{
    const seal=sha256.create();for(const store of ['mutations','import_receipts','bank_revisions'])for await(const row of records(store)){if(store==='import_receipts'&&row.sourceId===sourceId)continue;seal.update(canonicalBytes(store));seal.update(canonicalBytes(row));}
    if(hex(seal.digest())!==sourceSeal)throw fail('FINAL_SOURCE_INDEX_CORRUPT');
    for await(const pointer of indexes('verifiedBank:')){bankCache=null;await bankBody(pointer);}await check();
    }finally{counters.sourceCheckMs+=performance.now()-started;}
  }
  async function member(source){const bankUid=source.questionKey.split('/')[0];for await(const pointer of indexes(`bank:${bankUid}:`)){const bank=await bankBody(pointer);if(bank.bankUid===bankUid&&bank.refs.get(source.questionKey)===source.questionRevision)return;}throw fail('FINAL_SCOPE_SOURCE_MISSING');}
  async function verifyScopeRows(attemptId){
    const started=performance.now();
    if(!isUuid(attemptId))throw fail('FINAL_DEPENDENCY_INPUT');if(failed)throw fail('FINAL_PROOF_SESSION_FAILED');await check();await prepare();const attempt=await get('attempts',attemptId);if(!attempt)throw fail('BACKUP_ATTEMPT_DEPENDENCY');
    const hash=sha256.create();hash.update(new Uint8Array([91]));let count=0,batchBytes=0;let batch=[],pendingLabels=new Map();
    const flush=async()=>{
      if(!batch.length)return;const additions=[],newRows=batch.filter(row=>!row.existing);
      const packed=newRows.length?packScopeCanonicalRows(newRows.map(row=>({ordinal:row.rowLocator.ordinal,bytes:row.bytes}))):null,partMap=new Map(),descriptors=[];
      if(packed)for(let index=0;index<packed.parts.length;index++){
        const label=`scope:${attemptId}:pack:${newRows[0].rowLocator.ordinal}:part:${index}`,bytes=packed.parts[index];await check();const part=await writePart({label,bytes});await check();const actual=await readPart({label});await check();
        if(!part||part.label!==label||part.byteLength!==bytes.length||part.sha256!==await sha256Hex(actual)||!bytesEqual(actual,bytes))throw fail('FINAL_SOURCE_INDEX_CORRUPT');descriptors.push({label,sha256:part.sha256,byteLength:bytes.length});partMap.set(label,actual);
      }
      let packedIndex=0;for(const entry of batch){
        let value=entry.existing;
        if(!value){const layout=packed.rows[packedIndex++];value={format:'qb-final-scope-row-packed-v1',...entry.rowLocator,byteLength:entry.bytes.length,parts:layout.segments.map(segment=>({...descriptors[segment.partIndex],offset:segment.offset,length:segment.length}))};
          additions.push({label:entry.representative,value},{label:`scope:${attemptId}:ordinal:${String(entry.rowLocator.ordinal).padStart(10,'0')}`,value:entry.rowLocator});
        }else{
          if(!Array.isArray(value.parts))throw fail('FINAL_SOURCE_INDEX_CORRUPT');
          for(const segment of value.parts)if(!partMap.has(segment.label)){await check();const actual=await readPart({label:segment.label});await check();partMap.set(segment.label,actual);}
        }
        await checkPackedScopeRow(value,partMap,entry.bytes);await check();
        if(value.attemptId!==attemptId||value.ordinal!==entry.rowLocator.ordinal||value.rowDigest!==entry.rowLocator.rowDigest)throw fail('FINAL_SOURCE_INDEX_CORRUPT');
        additions.push(...entry.sourceIndexes);
      }
      let writes=[],writeBytes=0;for(const row of additions){const size=canonicalBytes(row).length+2048;if(size>PAGE)throw fail('FINAL_SCOPE_PACK_INPUT');if(writes.length&&(writes.length===100||writeBytes+size>PAGE)){await putIndexes(writes);writes=[];writeBytes=0;}writes.push(row);writeBytes+=size;}await putIndexes(writes);
      for(let offset=0;offset<batch.length;offset+=100){const entries=batch.slice(offset,offset+100);await check();counters.scopeReadBatches++;const reread=await native.readKeys(entries.map(entry=>({store:'attempt_scope',key:[attemptId,entry.rowLocator.ordinal]})));await check();for(let i=0;i<entries.length;i++){const row=reread[i],entry=entries[i];if(!row||row.attemptId!==attemptId||row.ordinal!==entry.rowLocator.ordinal||!bytesEqual(canonicalBytes(row),entry.bytes))throw fail('FINAL_SOURCE_INDEX_CORRUPT');}}
      batch=[];batchBytes=0;pendingLabels=new Map();
    };
    const processRows=async originals=>{
      const labels=[...new Set(originals.flatMap(original=>[`scope:${attemptId}:representative:${original.questionKey}`,...original.equivalentSourceRefs.map(source=>scopeSourceIndexLabel(attemptId,source.questionKey))]))],actual=await indexRows(labels);
      for(const original of originals){
        checkScopeRowBinding(original,attempt,count);const bytes=canonicalBytes(original),rowDigest=await sha256Hex(bytes);await check();counters.scopeRows++;
        const representative=`scope:${attemptId}:representative:${original.questionKey}`,existing=actual.get(representative)?.provenance.value||null,pendingRepresentative=pendingLabels.get(representative);
        if(existing&&(existing.ordinal!==count||existing.rowDigest!==rowDigest)||pendingRepresentative)throw fail('FINAL_SCOPE_DUPLICATE');
        const rowLocator={attemptId,ordinal:count,rowDigest},sourceIndexes=[];
        pendingLabels.set(representative,rowLocator);
        for(const source of original.equivalentSourceRefs){
          const label=scopeSourceIndexLabel(attemptId,source.questionKey),stored=actual.get(label)?.provenance.value||null,previous=pendingLabels.get(label)||stored,value={...rowLocator,questionKey:source.questionKey,questionRevision:source.questionRevision};
          if(previous&&!equal(previous,value))throw fail('FINAL_SCOPE_EQUIVALENT_OVERLAP');await member(source);if(!previous){sourceIndexes.push({label,value});pendingLabels.set(label,value);}
        }
        batch.push({original,bytes,rowLocator,representative,existing,sourceIndexes});batchBytes+=bytes.length;
        if(count++)hash.update(new Uint8Array([44]));hash.update(bytes);
      }
      // Existing locators are reread at the end of this bounded processing cut.
      // Newly absent keys are instead guarded by writeIndexes' native absence
      // conditions; a concurrent insertion cannot authorize their replacement.
      const existingLabels=labels.filter(label=>actual.get(label));if(existingLabels.length){const current=await indexRows(existingLabels);for(const label of existingLabels)if(!equal(actual.get(label),current.get(label)))throw fail('FINAL_SOURCE_INDEX_CORRUPT');}
      await flush();
    };
    try{
      let originals=[],originalBytes=0;for await(const original of records('attempt_scope',IDBKeyRange.bound([attemptId,0],[attemptId,Number.MAX_SAFE_INTEGER]))){const size=canonicalBytes(original).length;if(originals.length&&(originals.length===100||originalBytes+size>PAGE)){await processRows(originals);originals=[];originalBytes=0;}originals.push(original);originalBytes+=size;if(originalBytes>PAGE){await processRows(originals);originals=[];originalBytes=0;}}
      if(originals.length)await processRows(originals);
      await flush();hash.update(new Uint8Array([93]));if(count!==attempt.scopeCount||hex(hash.digest())!==attempt.scopeDigest)throw fail('BACKUP_SCOPE_DIGEST');await check();
      return {status:'scope_rows_verified',attemptId,scopeDigest:attempt.scopeDigest,scopeCount:count,diagnostics:Object.freeze({...counters,scopeMs:counters.scopeMs+performance.now()-started}),fullScopeClosure:true,fullSemanticClosure:false,ready:false};
    }catch(cause){failed=true;throw cause;}finally{counters.scopeMs+=performance.now()-started;}
  }
  async function verifyScope(attemptId){try{const result=await verifyScopeRows(attemptId);await checkSources();return {...result,diagnostics:Object.freeze({...counters})};}catch(cause){failed=true;throw cause;}}
  async function storeParsedRow(label,row,ordinal){
    const bytes=canonicalBytes(row),rowDigest=await sha256Hex(bytes),old=await readIndex(label);await check();
    if(old){if(old.ordinal!==ordinal||old.rowDigest!==rowDigest||!bytesEqual(await parsedBytes(old),bytes))throw fail('RESUME_DUPLICATE_ROW');return old;}
    const parts=[];for(let offset=0,index=0;offset<bytes.length;offset+=CHUNK,index++){const partLabel=`${label}:part:${index}`,expected=bytes.slice(offset,offset+CHUNK);await check();const part=await writePart({label:partLabel,bytes:expected});await check();if(!bytesEqual(await readPart({label:partLabel}),expected))throw fail('FINAL_SOURCE_INDEX_CORRUPT');parts.push({label:partLabel,sha256:part.sha256,byteLength:part.byteLength});}
    const value={label,ordinal,rowDigest,byteLength:bytes.length,parts};await putIndex(label,value);return value;
  }
  async function parsedBytes(value){
    if(!Number.isSafeInteger(value.byteLength)||value.byteLength<1||value.byteLength>ROW||!Array.isArray(value.parts)||value.parts.length!==Math.ceil(value.byteLength/CHUNK))throw fail('FINAL_SOURCE_INDEX_CORRUPT');
    const bytes=new Uint8Array(value.byteLength);let offset=0;
    for(const part of value.parts){await check();const actual=await readPart({label:part.label});await check();if(actual.length!==part.byteLength||await sha256Hex(actual)!==part.sha256||offset+actual.length>bytes.length)throw fail('FINAL_SOURCE_INDEX_CORRUPT');bytes.set(actual,offset);offset+=actual.length;}
    if(offset!==bytes.length||await sha256Hex(bytes)!==value.rowDigest)throw fail('FINAL_SOURCE_INDEX_CORRUPT');await check();return bytes;
  }
  async function parsedRow(label){const value=await readIndex(label);if(!value)throw fail('MISSING_RESUME_DEPENDENCY');const bytes=await parsedBytes(value),row=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));if(!bytesEqual(canonicalBytes(row),bytes))throw fail('NON_CANONICAL_CONTENT');return row;}
  async function scopeMember(attemptId,key,revision){const value=await readIndex(`scope:${attemptId}:representative:${key}`);if(!value)throw fail('RESUME_SCOPE_MEMBER_MISSING');const row=await get('attempt_scope',[attemptId,value.ordinal]);if(!row||await sha256Hex(canonicalBytes(row))!==value.rowDigest||row.questionKey!==key||row.questionRevision!==revision)throw fail('RESUME_SCOPE_MEMBER_MISSING');await check();return row;}
  async function resumeSource(digest,{expectedSource=null,parentCut=null}={}){
    let selected=null;
    for await(const pointer of indexes(`resumeSource:${digest}:`)){
      const context=await sourceContext(pointer);if(context.reference.kind!=='resume_state'||context.reference.payload.contentDigest!==digest)throw fail('FINAL_SOURCE_INDEX_CORRUPT');
      if(expectedSource){
        if(pointer.store!=='import_receipts'||!equal(pointer.key,[expectedSource.sourceId,expectedSource.sourceRecordId]))continue;
        if(!checkExpectedResumeSource(context,expectedSource,owner))throw fail('FINAL_RESUME_SOURCE_MISMATCH');
      }
      if(parentCut&&!checkHistoricalParentCut(context,parentCut))continue;
      if(!selected||parentCut&&before(selected.reference.serverSeq??String(selected.reference.clientSeq),context.reference.serverSeq??String(context.reference.clientSeq)))selected=context;
      if(!parentCut)return context;
    }
    if(selected)return selected;throw fail(expectedSource?'FINAL_RESUME_SOURCE_MISMATCH':'MISSING_RESUME_DEPENDENCY');
  }
  async function resumeContent(context){
    const reference=context.reference.payload,raw=await get('content_chunks',[reference.chunkManifestDigest,0]);if(!raw||await sha256Hex(raw.bytes)!==reference.chunkManifestDigest)throw fail('BACKUP_CONTENT_MISSING');
    const manifest=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw.bytes));validateChunkManifest(manifest);
    if(!bytesEqual(canonicalBytes(manifest),raw.bytes)||manifest.contentDigest!==reference.contentDigest)throw fail('BACKUP_CONTENT_DIGEST');
    const contentReference={contentDigest:manifest.contentDigest,manifestDigest:reference.chunkManifestDigest,chunkCount:manifest.chunkCount,totalBytes:manifest.totalBytes};validateContentReference(contentReference);
    async function* chunks(){for(const descriptor of manifest.chunks){const row=await get('content_chunks',[manifest.contentDigest,descriptor.chunkIndex]);if(!row||row.bytes.length!==descriptor.byteLength||await sha256Hex(row.bytes)!==descriptor.sha256)throw fail('BACKUP_CONTENT_DIGEST');await check();yield row.bytes;}}
    return {reference,manifest,contentReference,chunks};
  }
  async function selectedEvent(value,context){
    const original=await get('answer_events',value.eventId),source=await sourceContext(value.sourcePointer);
    if(!original||await sha256Hex(canonicalBytes(original))!==value.eventDigest||source.reference.kind!=='answer_event'||!equal(original,source.reference.payload.event)||!checkHistoricalSourceCut(source,context)||original.attemptId!==context.reference.payload.attemptId||original.writerStreamId!==context.reference.payload.writerStreamId)throw fail('MISSING_RESUME_DEPENDENCY');await check();return original;
  }
  async function selectEvents(digest,context){
    const reference=context.reference,p=reference.payload,prefix=`eventSource:${p.attemptId}:${p.writerStreamId}:`;
    let count=0,bytes=2;
    for await(const pointer of indexes(prefix)){
      const source=await sourceContext(pointer);if(!checkHistoricalSourceCut(source,context))continue;
      if(source.reference.kind!=='answer_event')throw fail('FINAL_SOURCE_INDEX_CORRUPT');const event=source.reference.payload.event;
      if(event.attemptId!==p.attemptId||event.writerStreamId!==p.writerStreamId)throw fail('FINAL_SOURCE_INDEX_CORRUPT');
      const original=await get('answer_events',event.eventId);if(!original||!equal(original,event))throw fail('MISSING_RESUME_DEPENDENCY');
      const value={eventId:event.eventId,eventDigest:await sha256Hex(canonicalBytes(original)),sourcePointer:pointer},label=`resume:${digest}:ownEvent:${event.eventId}`,old=await readIndex(label);
      if(old){if(old.eventDigest!==value.eventDigest)throw fail('MISSING_RESUME_DEPENDENCY');await selectedEvent(old,context);continue;}
      await putIndex(label,value);await putIndex(`resume:${digest}:ownAction:${pad(event.actionSeq)}:${event.eventId}`,value);
    }
    for await(const value of indexes(`resume:${digest}:ownAction:`)){const original=await selectedEvent(value,context);bytes+=canonicalBytes(original).length+(count++?1:0);}
    return {count,bytes};
  }
  async function snapshotBody(reference){
    if(reference.totalBytes>ROW)throw fail('SNAPSHOT_BODY_BUDGET');
    const loaded=await resumeContent({reference:{payload:{contentDigest:reference.contentDigest,chunkManifestDigest:reference.manifestDigest}}});
    if(!equal(loaded.contentReference,reference))throw fail('BACKUP_CONTENT_DIGEST');
    const bytes=new Uint8Array(reference.totalBytes);let offset=0;for await(const part of loaded.chunks()){bytes.set(part,offset);offset+=part.length;}
    if(offset!==bytes.length||await sha256Hex(bytes)!==reference.contentDigest)throw fail('BACKUP_CONTENT_DIGEST');return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  }
  async function proveBaseline(baseline){return validateSnapshotContinuationBaseline(baseline,{owner,
    isTombstoned:async(kind,id)=>!!await get('entity_tombstones',`${kind}:${id}`),
    readSnapshot:async id=>{const record=await get('history_snapshots',id);if(!record)throw fail('MISSING_SNAPSHOT_BASELINE_DEPENDENCY');let found=false;for await(const pointer of indexes(`snapshotSource:${id}:`)){const source=await loadSource(pointer);if(source.kind!=='history_snapshot'||!equal(source.payload,record))throw fail('SNAPSHOT_IMMUTABLE');found=true;}if(!found)throw fail('MISSING_SNAPSHOT_BASELINE_DEPENDENCY');return {record,body:await snapshotBody(record.reference)};},
    resolveQuestion:async ref=>{for await(const pointer of indexes(`bank:${ref.questionKey.split('/')[0]}:${ref.bankRevision}:`)){const bank=await bankBody(pointer);if(bank.digest===ref.bankRevision&&bank.refs.get(ref.questionKey)===ref.questionRevision)return bank.inputShapes[ref.questionKey];}throw fail('MISSING_SNAPSHOT_BANK_DEPENDENCY');}});}
  async function streamResume(digest,context,attempt){
    await verifyScopeRows(attempt.attemptId);
    const loaded=await resumeContent(context),expectedAttempt={attemptId:attempt.attemptId,writerStreamId:attempt.writerStreamId,scopeDigest:attempt.scopeDigest,scopeCount:attempt.scopeCount,...(attempt.parentAttemptId?{parentAttemptId:attempt.parentAttemptId}:{})};
    let draftOrdinal=0,submittedOrdinal=0;
    /** @type {import('../../domain/app-data/snapshot-continuation.js').BaselineProof|undefined} */ let baselineProof;
    const streamed=await streamCanonicalResumeRows({chunks:loaded.chunks(),contentReference:loaded.contentReference,resumeReference:loaded.reference,expectedAttempt,
      onScope:async row=>{const actual=await get('attempt_scope',[attempt.attemptId,row.ordinal]);if(!actual||!equal(actual,row))throw fail('RESUME_SCOPE_BINDING');},
      onDraft:async row=>{await scopeMember(attempt.attemptId,row.questionKey,row.questionRevision);const label=`resume:${digest}:draft:${row.questionKey}`,value=await storeParsedRow(label,row,draftOrdinal);const order=`resume:${digest}:draftOrder:${pad(draftOrdinal++)}`,old=await readIndex(order);if(old&&!equal(old,value))throw fail('RESUME_DUPLICATE_ROW');if(!old)await putIndex(order,value);},
      onSnapshotBaseline:async baseline=>{baselineProof=await proveBaseline(baseline);},
      onSubmittedEventId:async eventId=>{const label=`resume:${digest}:submitted:${eventId}`,value={eventId,ordinal:submittedOrdinal++},old=await readIndex(label);if(old&&!equal(old,value))throw fail('RESUME_DUPLICATE_SUBMITTED_ID');if(!old)await putIndex(label,value);}});
    let initialHeader;
    if(streamed.header.localRevision>1){let initialContext;for await(const pointer of indexes(`currentSource:${attempt.attemptId}:${pad(1)}:`))initialContext=await sourceContext(pointer);
      if(initialContext){
        if(!checkHistoricalSourceCut(initialContext,context))throw fail('MISSING_SNAPSHOT_INITIAL_RESUME');
        const initial=await resumeContent(initialContext);let initialProof,initialDrafts=0;
        const read=await streamCanonicalResumeRows({chunks:initial.chunks(),contentReference:initial.contentReference,resumeReference:initial.reference,expectedAttempt,
          onDraft:async row=>{if(!baselineProof)return;assertSnapshotContinuationDraft(row,1,baselineProof);initialDrafts++;},
          onScope:async row=>{if(baselineProof)assertSnapshotContinuationScope(row,row.ordinal,baselineProof);},
          onSubmittedEventId:async()=>{if(baselineProof)throw fail('SNAPSHOT_INITIAL_EVENTS');},
          onSnapshotBaseline:async baseline=>{if(!baselineProof||!equal(baseline,streamed.header.snapshotBaseline))throw fail('SNAPSHOT_BASELINE_IMMUTABLE');initialProof=baselineProof;}});
        initialHeader=read.header;
        if(initialHeader.snapshotBaseline&&(!streamed.header.snapshotBaseline||!equal(initialHeader.snapshotBaseline,streamed.header.snapshotBaseline)))throw fail('SNAPSHOT_BASELINE_IMMUTABLE');
        if(baselineProof){const counts=snapshotContinuationCounts(baselineProof),initialEvents=await selectEvents(initial.reference.contentDigest,initialContext);
          if(!initialProof||initialHeader.localRevision!==1||expectedAttempt.parentAttemptId||initialEvents.count||read.counts.submittedEventIds||read.counts.scope!==counts.scope||initialDrafts!==counts.drafts)throw fail('SNAPSHOT_INITIAL_BINDING');}
      }
      if(baselineProof&&(!initialHeader?.snapshotBaseline||!equal(initialHeader.snapshotBaseline,streamed.header.snapshotBaseline)))throw fail('MISSING_SNAPSHOT_INITIAL_RESUME');}
    if(baselineProof){const counts=snapshotContinuationCounts(baselineProof);if(counts.scope!==streamed.counts.scope||streamed.header.localRevision===1&&(counts.drafts!==streamed.counts.questionDrafts||streamed.counts.submittedEventIds))throw fail('SNAPSHOT_INITIAL_BINDING');
      for(let ordinal=0;ordinal<counts.scope;ordinal++)assertSnapshotContinuationScope(await get('attempt_scope',[attempt.attemptId,ordinal]),ordinal,baselineProof);
      for await(const value of indexes(`resume:${digest}:draftOrder:`))assertSnapshotContinuationDraft(await parsedRow(value.label),streamed.header.localRevision,baselineProof);}
    await check();return {...loaded,expectedAttempt,header:streamed.header,counts:streamed.counts,baselineProof};
  }
  async function checkListedSubmissions(digest,bundle,context){
    for await(const listed of indexes(`resume:${digest}:submitted:`)){
      const value=await readIndex(`resume:${digest}:ownEvent:${listed.eventId}`);if(!value)throw fail('MISSING_RESUME_DEPENDENCY');const event=await selectedEvent(value,context);
      if(event.kind!=='answer_submitted')throw fail('RESUME_SUBMIT_EVENT_KIND');await scopeMember(bundle.expectedAttempt.attemptId,event.questionKey,event.questionRevision);
      const inputDigest=await sha256Hex(canonicalBytes(event.answer)),label=`resume:${digest}:submitMatch:${event.questionKey}:${event.questionRevision}:${inputDigest}:${pad(event.actionSeq)}:${event.eventId}`,old=await readIndex(label);
      if(old&&!equal(old,value))throw fail('FINAL_SOURCE_INDEX_CORRUPT');if(!old)await putIndex(label,value);
    }
    for await(const value of indexes(`resume:${digest}:draftOrder:`)){
      const draft=await parsedRow(value.label);if(!draft.submitted||draft.inheritedFrom)continue;
      const inputBytes=canonicalBytes(draft.input),inputDigest=await sha256Hex(inputBytes);let matches=0,assisted=false;
      for await(const submit of indexes(`resume:${digest}:submitMatch:${draft.questionKey}:${draft.questionRevision}:${inputDigest}:`)){
        const event=await selectedEvent(submit,context);
        if(event.kind!=='answer_submitted'||event.questionKey!==draft.questionKey||event.questionRevision!==draft.questionRevision||!bytesEqual(canonicalBytes(event.answer),inputBytes))throw fail('RESUME_SUBMITTED_INPUT_MISMATCH');matches++;assisted=assisted||event.assisted;
      }
      if(!matches)throw fail('RESUME_SUBMITTED_INPUT_MISMATCH');if(assisted&&!draft.assisted)throw fail('RESUME_ASSISTANCE_DOWNGRADE');
    }
  }
  async function proveHistorical(digest,graph,depth=0,path=new Set(),selection={}){
    if(depth>32)throw fail('RESUME_DEPENDENCY_LIMIT');
    const cached=graph.memo.get(digest);if(cached){if(selection.parentCut&&!checkHistoricalParentCut(cached.context,selection.parentCut))throw fail('MISSING_RESUME_DEPENDENCY');if(depth+cached.maxDepth>32)throw fail('RESUME_DEPENDENCY_LIMIT');for(const id of cached.attempts)if(path.has(id))throw fail('RESUME_DEPENDENCY_CYCLE');return cached;}
    if(graph.visiting.has(digest))throw fail('RESUME_DEPENDENCY_CYCLE');if(graph.discovered.size>=33&&!graph.discovered.has(digest))throw fail('RESUME_DEPENDENCY_LIMIT');graph.discovered.add(digest);
    const context=await resumeSource(digest,selection),p=context.reference.payload,attempt=await get('attempts',p.attemptId);
    if(!attempt||attempt.writerStreamId!==p.writerStreamId)throw fail('MISSING_RESUME_DEPENDENCY');if(path.has(attempt.attemptId))throw fail('RESUME_DEPENDENCY_CYCLE');
    graph.visiting.add(digest);const nextPath=new Set(path);nextPath.add(attempt.attemptId);
    try{
      const bundle=await streamResume(digest,context,attempt),events=await selectEvents(digest,context);
      if(bundle.header.snapshotBaseline&&(attempt.parentAttemptId||bundle.header.localRevision===1&&events.count))throw fail("SNAPSHOT_INITIAL_BINDING");
      graph.bytes+=bundle.contentReference.totalBytes+canonicalBytes(p).length+canonicalBytes(bundle.manifest).length+canonicalBytes(bundle.expectedAttempt).length+events.bytes;
      if(graph.bytes>100*PAGE)throw fail('RESUME_DEPENDENCY_LIMIT');await checkListedSubmissions(digest,bundle,context);
      const attempts=new Set([attempt.attemptId]);let maxDepth=0;
      for await(const value of indexes(`resume:${digest}:draftOrder:`)){
        const draft=await parsedRow(value.label);if(!draft.inheritedFrom)continue;
        if(attempt.parentAttemptId!==draft.inheritedFrom.attemptId)throw fail('RESUME_INHERITED_PARENT_MISMATCH');
        const parent=await proveHistorical(draft.inheritedFrom.resumeContentDigest,graph,depth+1,nextPath,{parentCut:context});
        if(parent.bundle.header.attemptId!==draft.inheritedFrom.attemptId)throw fail('RESUME_INHERITED_PARENT_MISMATCH');
        const original=await parsedRow(`resume:${draft.inheritedFrom.resumeContentDigest}:draft:${draft.questionKey}`);checkInheritedDraftRelation(draft,original);
        maxDepth=Math.max(maxDepth,parent.maxDepth+1);for(const id of parent.attempts)attempts.add(id);
      }
      const proof={bundle,context,attempts,maxDepth};graph.memo.set(digest,proof);return proof;
    }finally{graph.visiting.delete(digest);}
  }
  const graph=()=>({memo:new Map(),visiting:new Set(),discovered:new Set(),bytes:0});
  async function rereadHistorical(traversal){
    for(const [digest,proof]of traversal.memo){const context=await sourceContext(proof.context.pointer),loaded=await resumeContent(context),hash=sha256.create();let bytes=0;
      for await(const chunk of loaded.chunks()){hash.update(chunk);bytes+=chunk.length;}if(bytes!==loaded.contentReference.totalBytes||hex(hash.digest())!==digest)throw fail('BACKUP_CONTENT_DIGEST');
      for await(const value of indexes(`resume:${digest}:ownAction:`))await selectedEvent(value,context);
    }await checkSources();
  }
  async function verifyHistoricalResume(contentDigest){
    if(typeof contentDigest!=='string'||!/^[0-9a-f]{64}$/.test(contentDigest))throw fail('FINAL_DEPENDENCY_INPUT');if(failed)throw fail('FINAL_PROOF_SESSION_FAILED');await check();await prepare();
    try{const traversal=graph(),proof=await proveHistorical(contentDigest,traversal);await rereadHistorical(traversal);await check();return {status:'historical_semantics_verified',attemptId:proof.bundle.header.attemptId,contentDigest,scopeDigest:proof.bundle.header.scopeDigest,ancestorDepth:proof.maxDepth,bundleCount:traversal.discovered.size,dependencyBytes:traversal.bytes,fullSemanticClosure:false,ready:false};}catch(cause){failed=true;throw cause;}
  }
  // Private native locator view. No whole resume/events array and no caller
  // facts are retained. Every stream closes over this genuine paired factory.
  async function openHistoricalResume(contentDigest,options){
    const captured=options===undefined?{}:ownedWriteInput(options);
    if(Object.keys(captured).some(key=>key!=='expectedSource'))throw fail('FINAL_DEPENDENCY_INPUT');
    const expectedSource=captured.expectedSource??null;
    if(expectedSource){const keys='entityKey,generation,logEpoch,payloadDigest,rowDigest,serverSeq,sourceId,sourceRecordId';if(Object.keys(expectedSource).sort().join()!==keys||!isUuid(expectedSource.generation)||!isUuid(expectedSource.logEpoch)||!['rowDigest','payloadDigest'].every(key=>typeof expectedSource[key]==='string'&&/^[0-9a-f]{64}$/.test(expectedSource[key]))||typeof expectedSource.serverSeq!=='string'||!/^[1-9][0-9]{0,19}$/.test(expectedSource.serverSeq)||expectedSource.sourceId!==`qb-sync-v2:${expectedSource.generation}:${expectedSource.logEpoch}`||expectedSource.sourceRecordId!==`change:${expectedSource.serverSeq}`||typeof expectedSource.entityKey!=='string'||!expectedSource.entityKey.length)throw fail('FINAL_DEPENDENCY_INPUT');}
    if(typeof contentDigest!=='string'||!/^[0-9a-f]{64}$/.test(contentDigest))throw fail('FINAL_DEPENDENCY_INPUT');if(failed)throw fail('FINAL_PROOF_SESSION_FAILED');await check();await prepare();
    try{const traversal=graph(),proof=await proveHistorical(contentDigest,traversal,0,new Set(),{expectedSource});await rereadHistorical(traversal);let disposed=false,eventCount=0;
      for await(const value of indexes(`resume:${contentDigest}:ownAction:`)){await selectedEvent(value,proof.context);eventCount++;}
      const live=async()=>{if(disposed)throw fail('CLOSED');await check();await sourceContext(proof.context.pointer);};
      const recheck=async()=>{await live();await rereadHistorical(traversal);await live();};
      async function* drafts(){await recheck();try{for await(const value of indexes(`resume:${contentDigest}:draftOrder:`)){await live();yield await parsedRow(value.label);}await recheck();}catch(cause){failed=true;throw cause;}}
      async function* events(){await recheck();try{for await(const value of indexes(`resume:${contentDigest}:ownAction:`)){await live();yield await selectedEvent(value,proof.context);}await recheck();}catch(cause){failed=true;throw cause;}}
      const snapshotContinuationReceipt=proof.bundle.baselineProof?await rebuildSnapshotContinuationReceipt(proof.bundle.baselineProof,{attemptId:proof.bundle.header.attemptId,importedAt:Date.now()}):undefined;
      return Object.freeze({...(snapshotContinuationReceipt?{snapshotContinuationReceipt}:{}),status:'historical_native_locator_view',reference:Object.freeze(ownedWriteInput(proof.context.reference.payload)),header:Object.freeze(ownedWriteInput(proof.bundle.header)),eventCount,ancestorDepth:proof.maxDepth,bundleCount:traversal.discovered.size,dependencyBytes:traversal.bytes,drafts,events,recheck,close:()=>{disposed=true;},fullSemanticClosure:false,ready:false});
    }catch(cause){failed=true;throw cause;}
  }
  async function verifyCurrent(attemptId){
    if(!isUuid(attemptId))throw fail('FINAL_DEPENDENCY_INPUT');if(failed)throw fail('FINAL_PROOF_SESSION_FAILED');await check();await prepare();
    try{const attempt=await get('attempts',attemptId);if(!attempt)throw fail('BACKUP_ATTEMPT_DEPENDENCY');let context=null;
      for await(const pointer of indexes(`currentSource:${attemptId}:${pad(attempt.localRevision)}:`))context=await sourceContext(pointer);
      if(!context||context.reference.kind!=='resume_state'||context.reference.payload.attemptId!==attemptId||context.reference.payload.localRevision!==attempt.localRevision)throw fail('BACKUP_RESUME_MISSING');
      const result=await verifyHistoricalResume(context.reference.payload.contentDigest);const current=await get('attempts',attemptId);if(!current||!equal(current,attempt))throw fail('FINAL_SOURCE_INDEX_CORRUPT');
      return {...result,status:'current_historical_semantics_verified'};
    }catch(cause){failed=true;throw cause;}
  }
  async function verifyFork(commandId){
    if(!isUuid(commandId))throw fail('FINAL_DEPENDENCY_INPUT');if(failed)throw fail('FINAL_PROOF_SESSION_FAILED');await check();await prepare();
    try{
      const stored=await get('import_receipts',['qb-fork-origin-v1',commandId]);if(!stored)throw fail('BACKUP_FORK_ORIGIN');const origin=validateForkOriginReceipt(stored).provenance;
      const manifest=await get('mutations',commandId),resume=await get('mutations',await derivedId(commandId,'resume'));
      if(!manifest||manifest.kind!=='attempt_manifest'||!resume||resume.kind!=='resume_state'||resume.payload.localRevision!==1||manifest.payload.attemptId!==origin.childAttemptId||manifest.payload.parentAttemptId!==origin.parentAttemptId||resume.payload.attemptId!==origin.childAttemptId)throw fail('BACKUP_FORK_ORIGIN');
      if(!await verifyMutationDigest(mutationWire(manifest))||!await verifyMutationDigest(mutationWire(resume))||(owner.ownerKind==='account'&&(manifest.accountGeneration!==owner.accountGeneration||resume.accountGeneration!==owner.accountGeneration)))throw fail('BACKUP_FORK_ORIGIN');
      const childGraph=graph(),parentGraph=graph(),child=await proveHistorical(resume.payload.contentDigest,childGraph),parent=await proveHistorical(origin.parentResumeContentDigest,parentGraph);
      if(child.bundle.header.attemptId!==origin.childAttemptId||parent.bundle.header.attemptId!==origin.parentAttemptId||manifest.payload.writerStreamId!==child.bundle.header.writerStreamId||manifest.payload.scopeDigest!==child.bundle.header.scopeDigest||manifest.payload.scopeCount!==child.bundle.counts.scope||child.bundle.counts.submittedEventIds||child.bundle.header.position!==parent.bundle.header.position||child.bundle.header.effectiveElapsedMs!==parent.bundle.header.effectiveElapsedMs||child.bundle.counts.questionDrafts!==parent.bundle.counts.questionDrafts||child.bundle.counts.scope!==parent.bundle.counts.scope)throw fail('BACKUP_FORK_ORIGIN');
      for(let ordinal=0;ordinal<child.bundle.counts.scope;ordinal++){const c=await get('attempt_scope',[origin.childAttemptId,ordinal]),p=await get('attempt_scope',[origin.parentAttemptId,ordinal]);if(!c||!p)throw fail('BACKUP_FORK_ORIGIN');const {attemptId:ca,...cv}=c,{attemptId:pa,...pv}=p;if(!equal(cv,pv))throw fail('BACKUP_FORK_ORIGIN');}
      const parentRows=indexes(`resume:${origin.parentResumeContentDigest}:draftOrder:`)[Symbol.asyncIterator]();
      try{for await(const value of indexes(`resume:${resume.payload.contentDigest}:draftOrder:`)){const original=await parentRows.next();if(original.done)throw fail('BACKUP_FORK_ORIGIN');const c=await parsedRow(value.label),p=await parsedRow(original.value.label),expected={...p,localRevision:1,inheritedFrom:{attemptId:origin.parentAttemptId,resumeContentDigest:origin.parentResumeContentDigest}};if(!equal(c,expected))throw fail('BACKUP_FORK_ORIGIN');}if(!(await parentRows.next()).done)throw fail('BACKUP_FORK_ORIGIN');}finally{await parentRows.return?.();}
      await rereadHistorical(childGraph);await rereadHistorical(parentGraph);await check();return {status:'fork_semantics_verified',commandId,attemptId:origin.childAttemptId,fullSemanticClosure:false,ready:false};
    }catch(cause){failed=true;throw cause;}
  }
  return Object.freeze({verifyScope,verifyHistoricalResume,openHistoricalResume,verifyCurrent,verifyFork,diagnostics:()=>{guard();return Object.freeze({...counters});},close,status:'historical_semantics_candidate',ready:false});
}
