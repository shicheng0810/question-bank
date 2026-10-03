import {createSnapshotBaselineReader} from '../history/snapshot-baseline-proof.js';
import {canonicalBytes,canonicalContentBytes,sha256Hex,validateContentReference,validateChunkManifest,verifyMutationDigest,validateAttemptScope,validateDraftForAttempt,APP_DATA_STORES,validateStoreRecord} from '../../domain/app-data/index.js';
import {streamCanonicalResumeRows} from '../../domain/app-data/resume-content-stream.js';
import {createFinalAttemptSemantics} from './final-attempt-semantics.js';
import {createFinalBundleClosure} from './final-bundle-closure.js';
import {sha256} from '@noble/hashes/sha2.js';
import {snapshotOwner} from '../profiles/control-schema.js';
import {assertFinalProofWorkspace} from '../profiles/managed-profile-registry.js';
import {ownedWriteInput} from '../idb/write-input.js';
import {mutationWire,validateSyncChangeReceipt} from '../sync/protocol.js';
import {loadHistoricalResumeProof} from '../sync/resume-proof.js';
import {createBoundedNativeAccess} from './bounded-native.js';
import {validateCloudReceipt} from './metadata.js';
import {validateStarResolutionReceipt} from '../sync/star-resolution.js';
import {STAR_GROUP_FORMAT,validateStarGroupResolutionReceipt} from '../sync/star-group-resolution.js';
import {validateForkOriginReceipt} from '../sync/fork-origin.js';
import {derivedId} from '../../domain/attempt/commands.js';
import {validateBankContent} from '../../domain/question/bank-content.js';
import {isUuid} from '../../domain/question/index.js';
import {createNativeRegisteredBankStreamer} from './bank-content-stream.js';
import {frozenPublicBanks} from '../../domain/question/frozen-public-registry.js';
const fail=code=>Object.assign(new Error(code),{code});
const BUDGET=3*1024*1024;
const PAGE_BYTES=1024*1024,NAMES=Object.freeze(Object.keys(APP_DATA_STORES).sort());
const equal=(a,b)=>a===undefined||b===undefined?a===b:sameBytes(canonicalBytes(a),canonicalBytes(b));
const hex=bytes=>Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('');
const keyOf=(store,row)=>Array.isArray(APP_DATA_STORES[store].keyPath)?APP_DATA_STORES[store].keyPath.map(key=>row[key]):row[APP_DATA_STORES[store].keyPath];
const sameBytes=(a,b)=>a.length===b.length&&a.every((byte,index)=>byte===b[index]);
/** Native original-content and small-proof reader, never a ready capability.
 * Full-profile closure and large semantic streaming are intentionally unavailable.
 */
export async function createFinalDependencyReader(database,{owner,signal,guard,timeoutMs=5000,proofWorkspace}){
  if(typeof guard!=='function')throw fail('FINAL_DEPENDENCY_INPUT');const trustedOwner=snapshotOwner(owner);
  const check=()=>{guard();if(signal?.aborted)throw fail('CLOSED');if(proofWorkspace!==undefined)assertFinalProofWorkspace(proofWorkspace,database);};
  check();
  if(proofWorkspace!==undefined){
    // The WeakMap matcher verifies the SAME private native handle before any
    // method on this value is invoked. Owner metadata is independently owned
    // and rechecked across the await; a genuine other-owner cap is not enough.
    const metadata=ownedWriteInput(await proofWorkspace.metadata());check();
    if(!equal(snapshotOwner(metadata.owner),trustedOwner))throw fail('BACKUP_OWNER_MISMATCH');
  }
  const native=await createBoundedNativeAccess(database,{signal,guard:check,timeoutMs});
  try{check();}catch(cause){native.close();throw cause;}
  // This is a genuine native cursor. A granted stable/exclusive cut is the
  // caller's PRIVATE obligation; this reader can never mint readiness.
  const transactions=new Map(),bankStreamers=new Set();let closed=false,semantics=null,semanticsFlight=null,bundleClosure=null,bundleFlight=null;
  const live=()=>{if(closed)throw fail('CLOSED');check();};
  const close=()=>{if(closed)return;closed=true;signal?.removeEventListener('abort',close);database.removeEventListener('versionchange',close);semantics?.close();bundleClosure?.close();for(const streamer of bankStreamers)streamer.close();bankStreamers.clear();for(const [tx,reject]of transactions){try{tx.abort();}catch{}reject(fail('FINAL_NATIVE_NOT_COMMITTED'));}transactions.clear();native.close();};
  signal?.addEventListener('abort',close,{once:true});database.addEventListener('versionchange',close);
  async function getSemantics(){
    live();if(proofWorkspace===undefined)throw fail('FINAL_PRIVATE_WORKSPACE_UNAVAILABLE');
    if(semantics)return semantics;
    if(!semanticsFlight){
      semanticsFlight=(async()=>{let created;
        try{created=await createFinalAttemptSemantics(database,proofWorkspace);live();semantics=created;return created;}
        catch(cause){created?.close();if(closed)throw fail('CLOSED');throw cause;}
      })();
      // Observe internal factory failure even if the reader closes while its
      // public operation is still pending. Do not leave a rejected finally()
      // promise, or let a late factory retain its native access after close.
      void semanticsFlight.catch(()=>{});
    }
    const value=await semanticsFlight;live();return value;
  }
  async function verifyAttemptScope(attemptId){
    if(!isUuid(attemptId))throw fail('FINAL_DEPENDENCY_INPUT');
    const verifier=await getSemantics();live();const result=await verifier.verifyScope(attemptId);live();return result;
  }
  async function verifyAttemptSemantics(attemptId){
    if(!isUuid(attemptId))throw fail('FINAL_DEPENDENCY_INPUT');
    const verifier=await getSemantics();live();
    const projection=await verifyCurrentResumeProjection(attemptId);live();
    const historical=await verifier.verifyCurrent(attemptId);live();
    if(projection.contentDigest!==historical.contentDigest)throw fail('FINAL_SOURCE_INDEX_CORRUPT');
    return {...historical,status:'attempt_semantics_candidate_verified',currentProjection:true,fullSemanticClosure:false,ready:false};
  }
  async function verifyHistoricalAttemptResume(contentDigest){const verifier=await getSemantics();live();const result=await verifier.verifyHistoricalResume(contentDigest);live();return result;}
  async function openIndexedHistoricalResume(contentDigest,options){const captured=options===undefined?undefined:ownedWriteInput(options);const verifier=await getSemantics();live();const result=await verifier.openHistoricalResume(contentDigest,captured);live();return result;}
  async function verifyAttemptFork(commandId){const verifier=await getSemantics();live();const result=await verifier.verifyFork(commandId);live();return result;}
  async function getBundleClosure(){
    live();if(proofWorkspace===undefined)throw fail('FINAL_PRIVATE_WORKSPACE_UNAVAILABLE');
    if(!bundleFlight){bundleFlight=(async()=>{let created;try{created=await createFinalBundleClosure(database,proofWorkspace);live();bundleClosure=created;return created;}catch(cause){created?.close();if(closed)throw fail('CLOSED');throw cause;}})();void bundleFlight.catch(()=>{});}
    const verifier=await bundleFlight;live();return verifier;
  }
  async function verifyBundleClosure(){const verifier=await getBundleClosure();const result=await verifier.verify();live();return result;}
  function readFinalDiagnostics(){live();if(bundleClosure)return bundleClosure.diagnostics();return Object.freeze({status:'final_dependency_diagnostics',available:semantics!==null,semantics:semantics?semantics.diagnostics():null,fullSemanticClosure:false,ready:false});}
  async function verifyCleanBundleClosure(){try{const verifier=await getBundleClosure();const result=await verifier.verifyClean();live();return {...result,diagnostics:readFinalDiagnostics()};}catch(cause){try{const diagnostics=readFinalDiagnostics();if(cause&&typeof cause==='object')cause.finalDiagnostics=diagnostics;}catch{/* Closed private access is never revived just for diagnostics. */}throw cause;}}
  async function createFinalBundleProof(){const verifier=await getBundleClosure();const result=await verifier.mintProof();live();return result;}
  async function verifyStoredPublicBankStream(input){
    const value=ownedWriteInput(input);if(Object.keys(value).sort().join()!=='bankUid,revision'||!isUuid(value.bankUid)||typeof value.revision!=='string'||!/^[0-9a-f]{64}$/.test(value.revision))throw fail('FINAL_DEPENDENCY_INPUT');
    live();if(proofWorkspace===undefined)throw fail('FINAL_PRIVATE_WORKSPACE_UNAVAILABLE');
    const boundary=async()=>{live();await proofWorkspace.check();live();};await boundary();
    const bank=await get('bank_revisions',[value.bankUid,value.revision]);if(!bank||bank.metadata.visibility!=='public')throw fail('BACKUP_BANK_BINDING');
    const known=frozenPublicBanks.find(row=>row.bankUid===value.bankUid&&row.revision===value.revision);
    if(!known||!equal(known.metadata,bank.metadata)||!equal(known.contentManifest,bank.contentManifest))throw fail('UNTRUSTED_PUBLIC_REFERENCE');
    const reference=ownedWriteInput(known.publicContentReference);validateContentReference(reference);if(reference.contentDigest!==value.revision)throw fail('BACKUP_BANK_BINDING');
    const bankSHA=await sha256Hex(canonicalBytes(bank));await boundary();const {manifest}=await verifyContentBytes(reference);await boundary();
    let streamer;try{streamer=await createNativeRegisteredBankStreamer(database,proofWorkspace);await boundary();bankStreamers.add(streamer);const refs=[];
      async function* chunks(){for(const part of manifest.chunks){await boundary();const row=await get('content_chunks',[reference.contentDigest,part.chunkIndex]);if(!row||row.bytes.length!==part.byteLength||await sha256Hex(row.bytes)!==part.sha256)throw fail('BACKUP_CONTENT_DIGEST');await boundary();yield row.bytes;await boundary();}}
      const result=await streamer.stream({chunks:chunks(),reference,signal,onQuestion:async ref=>{await boundary();refs.push(ref);}});await boundary();
      if(result.bankUid!==bank.bankUid||result.contentDigest!==bank.revision||!equal(result.metadata,bank.metadata)||!equal(refs,known.questionsrefs))throw fail('BACKUP_BANK_BINDING');
      const current=await get('bank_revisions',[value.bankUid,value.revision]);if(!current||await sha256Hex(canonicalBytes(current))!==bankSHA)throw fail('FINAL_SOURCE_INDEX_CORRUPT');await boundary();await verifyContentBytes(reference);await boundary();
      return Object.freeze({...result,questionRefs:refs,fullSemanticClosure:false,ready:false});
    }finally{streamer?.close();bankStreamers.delete(streamer);}
  }
  async function nativePage(store,after,{index=null,range=null}={}){
    if(!Object.hasOwn(APP_DATA_STORES,store))throw fail('FINAL_DEPENDENCY_INPUT');live();
    return new Promise((resolve,reject)=>{let tx,result,ended=false,timer;const rows=[];let bytes=64,last=null;
      const finish=cause=>{if(ended)return;ended=true;clearTimeout(timer);transactions.delete(tx);if(cause)reject(cause);else{try{live();resolve(result);}catch(error){reject(error);}}};
      const abort=cause=>{try{tx?.abort();}catch{}finish(cause);};
      try{tx=database.transaction([store],'readonly');transactions.set(tx,finish);tx.oncomplete=()=>finish();tx.onabort=()=>finish(fail('FINAL_NATIVE_NOT_COMMITTED'));tx.onerror=()=>{};timer=setTimeout(()=>abort(fail('FINAL_NATIVE_NOT_COMMITTED')),timeoutMs);
        const source=index===null?tx.objectStore(store):tx.objectStore(store).index(index);
        // Index continuation uses BOTH index and primary key. A nonunique
        // attemptId index cannot use lowerBound(last.indexKey,true), which
        // would silently omit the rest of the same attempt's facts.
        const lower=after===null?null:index===null?after:after.indexKey;
        const cursorRange=range===null?(lower===null?null:IDBKeyRange.lowerBound(lower,index===null)):(lower===null?range:IDBKeyRange.bound(lower,range.upper,index===null,range.upperOpen));
        const request=source.openCursor(cursorRange);
        request.onerror=()=>abort(fail('FINAL_NATIVE_NOT_COMMITTED'));
        request.onsuccess=()=>{try{
          live();const cursor=request.result;if(!cursor){result={rows,after:null,bytes};return;}
          if(after!==null&&index!==null&&indexedDB.cmp(cursor.key,after.indexKey)===0){const compared=indexedDB.cmp(cursor.primaryKey,after.primaryKey);if(compared<0){cursor.continuePrimaryKey(after.indexKey,after.primaryKey);return;}if(compared===0){cursor.continue();return;}}
          if(rows.length===100){result={rows,after:last,bytes};return;}
          const row=cursor.value;validateStoreRecord(store,row);if(indexedDB.cmp(keyOf(store,row),cursor.primaryKey)!==0)throw fail('BACKUP_DUPLICATE_RECORD');
          const size=store==='content_chunks'?row.bytes.length+canonicalBytes({contentDigest:row.contentDigest,chunkIndex:row.chunkIndex}).length+128:canonicalBytes(row).length+16;
          // Ordinary DTOs retain their 3 MiB domain cap. The normal page is
          // still 100 rows / 1 MiB; a legal larger row is a SINGLETON page,
          // never an excuse to collect a larger batch or raise a field cap.
          if(size-16>BUDGET)throw fail('FINAL_NATIVE_ROW_BUDGET');
          if(bytes+size>PAGE_BYTES&&rows.length){result={rows,after:last,bytes};return;}
          rows.push(row);bytes+=size;last=index===null?ownedWriteInput(cursor.primaryKey):{indexKey:ownedWriteInput(cursor.key),primaryKey:ownedWriteInput(cursor.primaryKey)};
          if(bytes>PAGE_BYTES){result={rows,after:last,bytes,singleton:true};return;}
          cursor.continue();
        }catch(error){abort(error);}};
      }catch(error){abort(error);}
    });
  }
  async function get(store,key){live();const [row]=await native.readKeys([{store,key}]);live();return row;}
  async function sourceReference(store,row){
    let reference;
    if(store==='mutations'){
      if(trustedOwner.ownerKind==='account'?row.accountGeneration!==trustedOwner.accountGeneration:row.accountGeneration!==undefined)throw fail('BACKUP_OWNER_MISMATCH');
      if(!await verifyMutationDigest(mutationWire(row)))throw fail('BACKUP_MUTATION_DIGEST');reference=row;
    }else{
      const verified=await validateSyncChangeReceipt(row);
      if(trustedOwner.ownerKind!=='account'||verified.provenance.generation!==trustedOwner.accountGeneration)throw fail('BACKUP_OWNER_MISMATCH');reference=verified.provenance.change;
    }
    live();return reference;
  }
  // A locator is an internal navigation record, NOT verified facts. The future
  // private workspace index stores this bounded value and every consumption
  // must reread the exact original source key/body through loadSourceLocator.
  async function* sourceReferences(){
    let ordinal=0;
    for(const store of ['mutations','import_receipts'])for await(const row of records(store)){
      if(store==='import_receipts'&&row.provenance?.format!=='qb-sync-change-v1')continue;
      const reference=await sourceReference(store,row),rowDigest=await sha256Hex(canonicalBytes(row));live();
      yield {reference,locator:{store,key:keyOf(store,row),rowDigest,ordinal:ordinal++}};
    }
  }
  async function loadSourceLocator(locator){
    if(!locator||!['mutations','import_receipts'].includes(locator.store)||!Number.isSafeInteger(locator.ordinal)||locator.ordinal<0||!/^[0-9a-f]{64}$/.test(locator.rowDigest))throw fail('FINAL_SOURCE_INDEX_CORRUPT');
    const row=await get(locator.store,locator.key);
    if(!row||!equal(keyOf(locator.store,row),locator.key)||await sha256Hex(canonicalBytes(row))!==locator.rowDigest||locator.store==='import_receipts'&&row.provenance?.format!=='qb-sync-change-v1')throw fail('FINAL_SOURCE_INDEX_CORRUPT');
    live();return sourceReference(locator.store,row);
  }
  async function* references(){for await(const source of sourceReferences())yield source.reference;}
  async function verifyContentBytes(input){const reference=ownedWriteInput(input);validateContentReference(reference);live();const row=await get('content_chunks',[reference.manifestDigest,0]);if(!row||await sha256Hex(row.bytes)!==reference.manifestDigest)throw fail('BACKUP_CONTENT_MISSING');live();const manifest=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(row.bytes));validateChunkManifest(manifest);if(manifest.contentDigest!==reference.contentDigest||manifest.chunkCount!==reference.chunkCount||manifest.totalBytes!==reference.totalBytes)throw fail('BACKUP_CONTENT_DIGEST');const hash=sha256.create();let total=0;for(const chunk of manifest.chunks){const part=await get('content_chunks',[reference.contentDigest,chunk.chunkIndex]);if(!part||part.bytes.length!==chunk.byteLength||await sha256Hex(part.bytes)!==chunk.sha256)throw fail('BACKUP_CONTENT_DIGEST');live();hash.update(part.bytes);total+=part.bytes.length;}if(total!==reference.totalBytes||hex(hash.digest())!==reference.contentDigest)throw fail('BACKUP_CONTENT_DIGEST');live();return {reference,manifest,status:'raw_bytes_verified',ready:false};}
  async function readContent(input){
    const reference=ownedWriteInput(input);validateContentReference(reference);if(reference.totalBytes>BUDGET)throw fail('FINAL_STREAMING_SEMANTICS_UNAVAILABLE');check();
    const [manifestRow]=await native.readKeys([{store:'content_chunks',key:[reference.manifestDigest,0]}]);check();if(!manifestRow||await sha256Hex(manifestRow.bytes)!==reference.manifestDigest)throw fail('CORRUPT_CONTENT');
    const manifest=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(manifestRow.bytes));validateChunkManifest(manifest);if(manifest.contentDigest!==reference.contentDigest||manifest.totalBytes!==reference.totalBytes||manifest.chunkCount!==reference.chunkCount)throw fail('CORRUPT_CONTENT');
    const bytes=new Uint8Array(reference.totalBytes);let offset=0;
    for(const chunk of manifest.chunks){const [row]=await native.readKeys([{store:'content_chunks',key:[reference.contentDigest,chunk.chunkIndex]}]);check();if(!row||row.bytes.length!==chunk.byteLength||await sha256Hex(row.bytes)!==chunk.sha256)throw fail('CORRUPT_CONTENT');bytes.set(row.bytes,offset);offset+=row.bytes.length;}
    if(offset!==reference.totalBytes||await sha256Hex(bytes)!==reference.contentDigest)throw fail('CORRUPT_CONTENT');check();const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));if(!sameBytes(canonicalContentBytes(value),bytes))throw fail('NON_CANONICAL_CONTENT');check();return {reference,manifest,value};
  }
  async function* records(store){let after=null;do{live();const page=await nativePage(store,after);live();for(const row of page.rows)yield row;after=page.after;}while(after!==null);}
  // Static known-schema indexes only. No public selector, alternate database
  // or caller-supplied range can change what an attempt proof consumes.
  async function* attemptRecords(store,attemptId,{actionOrder=false,writerStreamId}={}){
    if(!isUuid(attemptId)||!['attempt_scope','drafts','answer_events'].includes(store))throw fail('FINAL_DEPENDENCY_INPUT');
    const index=actionOrder?'attemptAction':'attemptId';
    if(actionOrder&&(store!=='answer_events'||!isUuid(writerStreamId)))throw fail('FINAL_DEPENDENCY_INPUT');
    const range=actionOrder?IDBKeyRange.bound([attemptId,writerStreamId,0],[attemptId,writerStreamId,Number.MAX_SAFE_INTEGER]):IDBKeyRange.only(attemptId);
    let after=null;do{const page=await nativePage(store,after,{index,range});live();for(const row of page.rows)yield row;after=page.after;}while(after!==null);
  }
  async function resumeContent(reference){
    const row=await get('content_chunks',[reference.chunkManifestDigest,0]);
    if(!row||await sha256Hex(row.bytes)!==reference.chunkManifestDigest)throw fail('BACKUP_CONTENT_MISSING');live();
    const manifest=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(row.bytes));validateChunkManifest(manifest);
    if(!sameBytes(canonicalBytes(manifest),row.bytes)||manifest.contentDigest!==reference.contentDigest)throw fail('BACKUP_CONTENT_DIGEST');
    const contentReference={contentDigest:manifest.contentDigest,manifestDigest:reference.chunkManifestDigest,chunkCount:manifest.chunkCount,totalBytes:manifest.totalBytes};
    validateContentReference(contentReference);
    async function* chunks(){for(const descriptor of manifest.chunks){const part=await get('content_chunks',[contentReference.contentDigest,descriptor.chunkIndex]);if(!part||part.bytes.length!==descriptor.byteLength||await sha256Hex(part.bytes)!==descriptor.sha256)throw fail('BACKUP_CONTENT_DIGEST');live();yield part.bytes;}}
    return {contentReference,manifest,chunks};
  }
  /** Read-only current projection check. This performs NO temporary writes,
   * does not waive scope global uniqueness or historical D12, and never emits
   * payload_verified/Ready. The reference is selected from genuine source
   * records in the SAME encounter order as the original snapshot oracle.
   */
  async function verifyCurrentResumeProjection(attemptId){
    if(!isUuid(attemptId))throw fail('FINAL_DEPENDENCY_INPUT');live();
    const attempt=await get('attempts',attemptId);if(!attempt)throw fail('BACKUP_ATTEMPT_DEPENDENCY');
    let source;
    for await(const candidate of sourceReferences())if(candidate.reference.kind==='resume_state'&&candidate.reference.payload.attemptId===attemptId&&candidate.reference.payload.localRevision===attempt.localRevision)source=candidate.locator;
    if(!source)throw fail('BACKUP_RESUME_MISSING');
    const reference=(await loadSourceLocator(source)).payload;
    if(reference.writerStreamId!==attempt.writerStreamId)throw fail('BACKUP_RESUME_BINDING');
    let allEventCount=0;
    for await(const event of attemptRecords('answer_events',attemptId)){if(event.writerStreamId!==attempt.writerStreamId)throw fail('CORRUPT_ATTEMPT');allEventCount++;}
    if(allEventCount!==attempt.actionSeq)throw fail('CORRUPT_ATTEMPT');
    const scopes=attemptRecords('attempt_scope',attemptId)[Symbol.asyncIterator](),drafts=attemptRecords('drafts',attemptId)[Symbol.asyncIterator]();
    const events=attemptRecords('answer_events',attemptId,{actionOrder:true,writerStreamId:attempt.writerStreamId})[Symbol.asyncIterator]();
    let actionSeq=0,scopeCount=0,draftCount=0,submittedCount=0;
    async function nextSubmission(){for(;;){const entry=await events.next();if(entry.done)return entry;if(entry.value.actionSeq!==++actionSeq)throw fail('CORRUPT_ATTEMPT');if(entry.value.kind==='answer_submitted')return entry;}}
    const loaded=await resumeContent(reference);
    try{
      const streamed=await streamCanonicalResumeRows({chunks:loaded.chunks(),contentReference:loaded.contentReference,resumeReference:reference,onSnapshotBaseline:async()=>{},expectedAttempt:{attemptId,writerStreamId:attempt.writerStreamId,scopeDigest:attempt.scopeDigest,scopeCount:attempt.scopeCount,...(attempt.parentAttemptId?{parentAttemptId:attempt.parentAttemptId}:{})},signal,
        onScope:async row=>{live();const original=await scopes.next();if(original.done||original.value.ordinal!==scopeCount++||!equal(row,original.value))throw fail('BACKUP_RESUME_FACT_MISMATCH');},
        onDraft:async row=>{live();const original=await drafts.next();if(original.done)throw fail('BACKUP_RESUME_FACT_MISMATCH');validateDraftForAttempt(original.value,{attemptId,...(attempt.parentAttemptId?{parentAttemptId:attempt.parentAttemptId}:{})});if(original.value.writerStreamId!==attempt.writerStreamId||original.value.localRevision>attempt.localRevision)throw fail('CORRUPT_ATTEMPT');const {attemptId:ignoredAttempt,writerStreamId:ignoredWriter,fence:ignoredFence,dirty:ignoredDirty,...projection}=original.value;if(!equal(row,projection))throw fail('BACKUP_RESUME_FACT_MISMATCH');draftCount++;},
        onSubmittedEventId:async id=>{live();const original=await nextSubmission();if(original.done||original.value.eventId!==id)throw fail('BACKUP_RESUME_FACT_MISMATCH');submittedCount++;}});
      // Exhaustion checks include trailing hint/redo facts and reject omitted
      // native drafts/scope/submissions. No grade is recalculated or changed.
      if(!(await scopes.next()).done||!(await drafts.next()).done||!(await nextSubmission()).done||actionSeq!==attempt.actionSeq||scopeCount!==attempt.scopeCount||streamed.header.position!==attempt.position||streamed.header.effectiveElapsedMs!==attempt.effectiveElapsedMs)throw fail('BACKUP_RESUME_FACT_MISMATCH');
      live();return {status:'current_projection_verified',attemptId,contentDigest:reference.contentDigest,scopeCount,draftCount,submittedCount,fullSemanticClosure:false,ready:false};
    }finally{await Promise.allSettled([scopes.return?.(),drafts.return?.(),events.return?.()]);}
  }
  async function historicalProof(input){
    const digest=ownedWriteInput(input);if(typeof digest!=='string'||!/^[0-9a-f]{64}$/.test(digest))throw fail('FINAL_DEPENDENCY_INPUT');check();const references=[];let budget=0;
    function retain(row,target){budget+=canonicalBytes(row).length;if(budget>BUDGET)throw fail('FINAL_SMALL_PROOF_BUDGET');target.push(row);}
    // This bounded small oracle candidate still scans source refs once. Large
    // indexed per-entity proof assembly is a separate integration work order.
    for await(const row of records('mutations')){if(['resume_state','answer_event','history_snapshot','bank_revision','content_manifest'].includes(row.kind)){if(!await verifyMutationDigest(mutationWire(row)))throw fail('CORRUPT_MUTATION');if(trustedOwner.ownerKind==='account'&&row.accountGeneration!==trustedOwner.accountGeneration)throw fail('OWNER_MISMATCH');retain(row,references);}}
    for await(const row of records('import_receipts'))if(row.provenance?.format==='qb-sync-change-v1'){const verified=await validateSyncChangeReceipt(row);if(trustedOwner.ownerKind!=='account'||verified.provenance.generation!==trustedOwner.accountGeneration)throw fail('OWNER_MISMATCH');if(['resume_state','answer_event','history_snapshot','bank_revision','content_manifest'].includes(verified.provenance.change.kind))retain(verified.provenance.change,references);}
    const selected=new Set(),visited=new Set();
    async function visit(contentDigest,depth){if(depth>32||visited.size>=33&&!visited.has(contentDigest))throw fail('RESUME_DEPENDENCY_LIMIT');if(visited.has(contentDigest))return;visited.add(contentDigest);const ref=references.find(row=>row.kind==='resume_state'&&row.payload.contentDigest===contentDigest);if(!ref)throw fail('MISSING_RESUME_DEPENDENCY');selected.add(ref.payload.attemptId);const loaded=await readResumeContent(ref.payload);budget+=canonicalContentBytes(loaded.value).length;if(budget>BUDGET)throw fail('FINAL_SMALL_PROOF_BUDGET');for(const draft of loaded.value.questionDrafts||[])if(draft.inheritedFrom)await visit(draft.inheritedFrom.resumeContentDigest,depth+1);}
    async function readResumeContent(payload){const [row]=await native.readKeys([{store:'content_chunks',key:[payload.chunkManifestDigest,0]}]);check();if(!row||await sha256Hex(row.bytes)!==payload.chunkManifestDigest)throw fail('CORRUPT_CONTENT');const manifest=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(row.bytes));validateChunkManifest(manifest);return readContent({contentDigest:payload.contentDigest,manifestDigest:payload.chunkManifestDigest,chunkCount:manifest.chunkCount,totalBytes:manifest.totalBytes});}
    await visit(digest,0);const attempts=[],events=[];
    for(const attemptId of selected){const [attempt]=await native.readKeys([{store:'attempts',key:attemptId}]);if(!attempt)throw fail('MISSING_RESUME_DEPENDENCY');retain(attempt,attempts);const scope=[];for(let ordinal=0;ordinal<attempt.scopeCount;ordinal+=100){const keys=Array.from({length:Math.min(100,attempt.scopeCount-ordinal)},(_,index)=>({store:'attempt_scope',key:[attemptId,ordinal+index]}));for(const row of await native.readKeys(keys)){if(!row)throw fail('MISSING_SCOPE_DEPENDENCY');retain(row,scope);}}validateAttemptScope(scope,attemptId,attempt.scopeCount);if(await sha256Hex(canonicalContentBytes(scope))!==attempt.scopeDigest)throw fail('CORRUPT_SCOPE');check();}
    for await(const event of records('answer_events'))if(selected.has(event.attemptId))retain(event,events);
    check();const proof=await loadHistoricalResumeProof({references,attempts,events,contentDigest:digest,readResumeContent,readSnapshotBaseline:createSnapshotBaselineReader({owner:trustedOwner,references,readContent,
      readSnapshotRecord:async id=>get('history_snapshots',id),readTombstone:async key=>get('entity_tombstones',key),readBankRevision:async(uid,revision)=>get('bank_revisions',[uid,revision])})});check();return {status:'historical_payload_verified',proof,ready:false};
  }
  /** Static cross-store admission, NOT a full-semantic/activation result.
   * No callback, caller summary or supplied hash can waive missing full proof.
   */
  async function verifyStaticSnapshot(){
    live();let recordCount=0,logicalBytes=0,attemptCount=0,requiresForkProof=false;
    const coverage=new Set();let coverageBytes=0;
    const cover=id=>{if(!coverage.has(id)){coverageBytes+=id.length+1;if(coverageBytes>PAGE_BYTES)throw fail('FINAL_AUDIT_COVERAGE_INDEX_UNAVAILABLE');coverage.add(id);}};
    for(const store of NAMES)for await(const row of records(store)){
      logicalBytes+=store==='content_chunks'?row.bytes.length:canonicalBytes(row).length;
      if(++recordCount>200000||logicalBytes>100*1024*1024)throw fail('BACKUP_BUDGET_EXCEEDED');
      if(store==='mutations'){
        if(trustedOwner.ownerKind==='account'?row.accountGeneration!==trustedOwner.accountGeneration:row.accountGeneration!==undefined)throw fail('BACKUP_OWNER_MISMATCH');
        if(!await verifyMutationDigest(mutationWire(row)))throw fail('BACKUP_MUTATION_DIGEST');live();
      }
      if(store==='outbox'&&!await get('mutations',row.mutationId))throw fail('BACKUP_OUTBOX_DEPENDENCY');
      if(['attempt_scope','drafts','answer_events'].includes(store)&&!await get('attempts',row.attemptId))throw fail('BACKUP_ATTEMPT_DEPENDENCY');
      if(store==='attempts')attemptCount++;
      if(store==='migration_journal'&&row.checkpoint?.format==='qb-cloud-recovery-stage-v1')throw fail('BACKUP_UNFINISHED_CLOUD_STAGE');
      if(store!=='import_receipts')continue;
      const p=row.provenance;
      if(['qb-cloud-stage-page-v1','qb-cloud-stage-index-v1','qb-final-proof-index-v1','qb-final-proof-part-v1','qb-final-proof-reservation-v1'].includes(p?.format)||row.sourceId.startsWith('qb-cloud-stage-index:')&&isUuid(row.sourceId.slice('qb-cloud-stage-index:'.length)))throw fail('BACKUP_UNFINISHED_CLOUD_STAGE');
      if(p?.format==='qb-sync-change-v1'){const verified=await validateSyncChangeReceipt(row);live();if(trustedOwner.ownerKind!=='account'||verified.provenance.generation!==trustedOwner.accountGeneration)throw fail('BACKUP_OWNER_MISMATCH');}
      if(p?.format==='qb-cloud-receipt-v1'){
        if(trustedOwner.ownerKind!=='account')throw fail('BACKUP_OWNER_MISMATCH');let change;
        if(p.receipt?.status!=='conflict'){const source=await get('import_receipts',[`qb-sync-v2:${trustedOwner.accountGeneration}:${p.logEpoch}`,`change:${p.receipt?.serverSeq}`]);if(!source)throw fail('BACKUP_CLOUD_RECEIPT_DEPENDENCY');change=(await validateSyncChangeReceipt(source)).provenance.change;live();}
        await validateCloudReceipt(row,{generation:trustedOwner.accountGeneration,logEpoch:p.logEpoch,change});live();
      }
      if(p?.format==='qb-star-conflict-resolution-v1'){
        const origin=(await validateStarResolutionReceipt(row)).provenance;live();if(trustedOwner.ownerKind!=='account'||origin.generation!==trustedOwner.accountGeneration)throw fail('BACKUP_OWNER_MISMATCH');
        const original=await get('mutations',origin.originalMutation.mutationId),created=await get('mutations',origin.newMutationId),conflict=await get('conflicts',origin.conflictId),outbox=await get('outbox',origin.originalMutation.mutationId);
        if(!original||!created||!conflict||conflict.status!=='resolved'||outbox||!equal(mutationWire(original),origin.originalMutation)||!equal(conflict.mutation,origin.originalMutation)||created.clientStreamId!==origin.originalMutation.clientStreamId||created.clientSeq<=origin.originalMutation.clientSeq||created.kind!=='user_state'||created.entityKey!==origin.originalMutation.entityKey||created.payload.baseRevision!==origin.sourceChange.serverRevision||created.payload.value!==(origin.choice==='local'?origin.originalMutation.payload.value:origin.sourceChange.payload.value))throw fail('BACKUP_STAR_RESOLUTION_ORIGIN');cover(origin.conflictId);
      }
      if(p?.format===STAR_GROUP_FORMAT||row.sourceId===STAR_GROUP_FORMAT){
        let origin;try{origin=(await validateStarGroupResolutionReceipt(row)).provenance;}catch{throw fail('BACKUP_STAR_GROUP_RESOLUTION_ORIGIN');}live();if(!equal(origin.group.owner,trustedOwner))throw fail('BACKUP_OWNER_MISMATCH');
        const created=await get('mutations',origin.newMutationId);
        if(!created||created.accountGeneration!==trustedOwner.accountGeneration||created.clientStreamId!==origin.group.streamRow.value||created.clientSeq!==origin.group.seqRow.value+1||created.kind!=='user_state'||created.entityKey!==origin.group.entityKey||created.payload.baseRevision!==origin.sourceChange.serverRevision||created.payload.value!==(origin.choice==='local'?origin.group.localState.value:origin.sourceChange.payload.value))throw fail('BACKUP_STAR_GROUP_RESOLUTION_ORIGIN');
        for(const member of origin.group.members){const original=await get('mutations',member.originalMutation.mutationId),conflict=await get('conflicts',member.originalMutation.mutationId)||null,outbox=await get('outbox',member.originalMutation.mutationId);if(!original||!equal(original,member.originalRecord)||outbox||!equal(conflict,member.conflict?{...member.conflict,status:'resolved'}:null))throw fail('BACKUP_STAR_GROUP_RESOLUTION_ORIGIN');if(member.conflict)cover(member.conflict.conflictId);}
      }
      if(p?.format==='qb-fork-origin-v1'){
        const origin=validateForkOriginReceipt(row).provenance,original=await get('mutations',origin.commandId),resume=await get('mutations',await derivedId(origin.commandId,'resume'));live();
        if(!original||original.kind!=='attempt_manifest'||original.payload.attemptId!==origin.childAttemptId||original.payload.parentAttemptId!==origin.parentAttemptId||!resume||resume.kind!=='resume_state'||resume.payload.attemptId!==origin.childAttemptId||resume.payload.localRevision!==1)throw fail('BACKUP_FORK_ORIGIN');requiresForkProof=true;
      }
    }
    for await(const row of records('conflicts'))if(row.status==='resolved'&&row.mutation.kind==='user_state'&&row.mutation.payload.field==='starred'&&!coverage.has(row.conflictId))throw fail('BACKUP_STAR_RESOLUTION_AUDIT_MISSING');
    for await(const ref of references())if(ref.kind==='content_manifest')await verifyContentBytes(ref.payload.reference);else if(ref.kind==='attempt_scope')await verifyContentBytes(ref.payload.reference);
    for await(const bank of records('bank_revisions')){
      if(bank.contentManifest.kind==='unavailable')throw fail('BACKUP_CONTENT_MISSING');let reference=bank.contentManifest.reference;
      if(!reference)for await(const source of references())if(source.kind==='content_manifest'&&source.payload.reference.contentDigest===bank.contentManifest.contentDigest){reference=source.payload.reference;break;}
      if(!reference)throw fail('BACKUP_CONTENT_MISSING');await verifyContentBytes(reference);
      if(bank.contentManifest.kind!=='protected_cipher'){const loaded=await readContent(reference),verified=await validateBankContent(loaded.value);live();if(verified.content.bankUid!==bank.bankUid||verified.contentDigest!==bank.revision||!equal(verified.content.metadata,bank.metadata))throw fail('BACKUP_BANK_BINDING');}
    }
    const progress={recordCount,logicalBytes,attemptCount,ready:false};
    // Small historicalProof remains separately callable, but its success does
    // not waive full physical bundle/current-resume/fork checks for this cut.
    if(attemptCount||requiresForkProof){const error=fail('FINAL_FULL_SEMANTICS_UNIMPLEMENTED');error.progress=progress;error.unimplemented=['bounded_bundle_relations','full_historical_D12','current_resume_fact_equality',...(requiresForkProof?['fork_creation_parent_equality']:[])];throw error;}
    live();return {status:'static_checks_verified',...progress,fullSemanticClosure:false};
  }
  return Object.freeze({readContent,historicalProof,openIndexedHistoricalResume,records,verifyContentBytes,verifyStoredPublicBankStream,verifyCurrentResumeProjection,verifyAttemptScope,verifyAttemptSemantics,verifyHistoricalAttemptResume,verifyAttemptFork,verifyBundleClosure,verifyCleanBundleClosure,readFinalDiagnostics,createFinalBundleProof,verifyStaticSnapshot,close,status:'static_verifier_only'});
}
