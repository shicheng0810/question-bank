import {ownedWriteInput} from '../idb/write-input.js';
import {canonicalBytes,sha256Hex} from '../../domain/app-data/index.js';
import {isUuid} from '../../domain/question/index.js';
import {scanCloudPrimaryPage} from './primary-scan.js';
import {cloudStageIndexSource,validateCloudStageIndexShape,verifyCloudStageIndex} from './stage-index.js';
import {validateCloudStageJournal} from './metadata.js';
import {snapshotOwner} from '../profiles/control-schema.js';
import {BUSINESS_SCHEMA_VERSION} from '../idb/schema.js';

const failure=code=>Object.assign(new Error(code),{code});
const digest=value=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);
const equal=(a,b)=>{const x=canonicalBytes(a),y=canonicalBytes(b);return x.length===y.length&&x.every((byte,index)=>byte===y[index]);};

/** Native source reader. It locates provenance, never labels a
 * resume verified without full canonical raw-body/chunk/D12 dependency checking.
 * Each lookup obtains index+journal+page+raw bytes from one real native cut.
 */
export function createCloudPointerProjector(database,input,{signal,guard=()=>{},timeoutMs=5000}={}){
  const context=ownedWriteInput(input);
  if(Object.keys(context).sort().join()!=='checkpointDigest,generation,logEpoch,owner,profileId,stageId'||!isUuid(context.stageId)||!isUuid(context.profileId)||!isUuid(context.generation)||!isUuid(context.logEpoch)||!digest(context.checkpointDigest))throw failure('CLOUD_POINTER_CONTEXT');
  try{context.owner=snapshotOwner(context.owner);}catch{throw failure('CLOUD_POINTER_CONTEXT');}
  if(context.owner.ownerKind!=='account'||context.owner.accountGeneration!==context.generation)throw failure('CLOUD_POINTER_CONTEXT');
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>2147483647)throw failure('CLOUD_POINTER_CONTEXT');
  if(database?.version!==BUSINESS_SCHEMA_VERSION)throw failure('SCHEMA_MISMATCH');
  const sourceId=cloudStageIndexSource(context.stageId);
  const check=()=>{guard();if(signal?.aborted)throw failure('CLOSED');};
  async function readPointer(input){
    const owned=ownedWriteInput(input);if(Object.keys(owned).sort().join()!=='expected,sourceRecordId'||typeof owned.sourceRecordId!=='string'||owned.sourceRecordId.length>510)throw failure('CLOUD_POINTER_INPUT');check();
    const cut=await new Promise((resolve,reject)=>{let transaction,ended=false,timer,result;
      const finish=cause=>{if(ended)return;ended=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);if(cause)reject(cause);else{try{check();resolve(result);}catch(error){reject(error);}}};
      const cancel=()=>{try{transaction?.abort();}catch{}finish(failure('CLOUD_POINTER_NOT_COMMITTED'));};
      try{transaction=database.transaction(['import_receipts','migration_journal','content_chunks'],'readonly');transaction.oncomplete=()=>finish();transaction.onabort=cancel;transaction.onerror=()=>{};signal?.addEventListener('abort',cancel,{once:true});timer=setTimeout(cancel,timeoutMs);
        const indexRequest=transaction.objectStore('import_receipts').get([sourceId,owned.sourceRecordId]);
        indexRequest.onsuccess=()=>{try{check();if(!indexRequest.result){result=null;return;}const index=validateCloudStageIndexShape(indexRequest.result),p=index.provenance;if(p.stageId!==context.stageId)throw failure('CLOUD_POINTER_CONTEXT');result={index};let left=3;
          for(const [store,key,label]of [['migration_journal',context.stageId,'journal'],['import_receipts',[`qb-cloud-stage:${context.stageId}`,`${p.section}:${p.pageIndex}`],'pageReceipt'],['content_chunks',[p.storageDigest,0],'chunk']]){const request=transaction.objectStore(store).get(key);request.onsuccess=()=>{try{check();result[label]=request.result;if(!--left){if(!result.chunk?.bytes||result.chunk.bytes.length>480*1024)throw failure('CLOUD_POINTER_SOURCE');}}catch(error){try{transaction.abort();}catch{}finish(error);}};}
        }catch(error){try{transaction.abort();}catch{}finish(error);}};
      }catch(error){try{transaction?.abort();}catch{}finish(error);}
    });check();if(!cut)return null;
    const journal=validateCloudStageJournal(cut.journal),checkpoint=journal.checkpoint;
    if(journal.status==='QUARANTINED'||journal.migrationId!==context.stageId||checkpoint.profileId!==context.profileId||checkpoint.checkpointDigest!==context.checkpointDigest||checkpoint.generation!==context.generation||checkpoint.logEpoch!==context.logEpoch||!equal(checkpoint.owner,context.owner))throw failure('CLOUD_POINTER_CONTEXT');
    const result=await verifyCloudStageIndex({index:cut.index,journal,pageReceipt:cut.pageReceipt,pageBytes:cut.chunk.bytes,expected:owned.expected});check();return result;
  }
  async function* sources(input){
    const owned=ownedWriteInput(input);if(Object.keys(owned).sort().join()!=='expected,prefix'||typeof owned.prefix!=='string'||!owned.prefix.length||owned.prefix.length>500)throw failure('CLOUD_POINTER_INPUT');let after=null;
    do{check();const page=await scanCloudPrimaryPage(database,{sourceId,lower:[sourceId,owned.prefix],upper:[sourceId,owned.prefix+'\uffff'],after,limit:100,maxBytes:1024*1024},{signal,guard:check,timeoutMs});check();
      for(const pointer of page.rows){const result=await readPointer({sourceRecordId:pointer.sourceRecordId,expected:owned.expected});if(!result)throw failure('CLOUD_POINTER_SOURCE');yield result.value;}
      after=page.continuation;
    }while(after);
  }
  async function lastEntitySource(input){
    const owned=ownedWriteInput(input);if(Object.keys(owned).sort().join()!=='entityKey,kind'||typeof owned.entityKey!=='string'||!['content_manifest','bank_revision','history_snapshot','attempt_manifest','attempt_scope','answer_event','resume_state','user_state','entity_tombstone'].includes(owned.kind))throw failure('CLOUD_POINTER_INPUT');check();
    const entityHash=await sha256Hex(canonicalBytes(owned.entityKey));check();const prefix=`entity:${owned.kind}:${entityHash}:`;
    const label=await new Promise((resolve,reject)=>{let tx,timer,done=false,result=null;const finish=cause=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);cause?reject(cause):resolve(result);};const cancel=()=>{try{tx?.abort();}catch{}finish(failure('CLOUD_POINTER_NOT_COMMITTED'));};try{tx=database.transaction('import_receipts','readonly');tx.oncomplete=()=>finish();tx.onabort=cancel;tx.onerror=()=>{};signal?.addEventListener('abort',cancel,{once:true});timer=setTimeout(cancel,timeoutMs);const req=tx.objectStore('import_receipts').openKeyCursor(IDBKeyRange.bound([sourceId,prefix],[sourceId,prefix+'\uffff']),'prev');req.onsuccess=()=>{try{check();if(req.result)result=req.result.primaryKey[1];}catch(cause){try{tx.abort();}catch{}finish(cause);}};req.onerror=cancel;}catch(cause){cancel();}});check();if(label===null)return null;
    return readPointer({sourceRecordId:label,expected:{kind:owned.kind,entityKey:owned.entityKey}});
  }
  async function historicalResumeSource(input){
    const owned=ownedWriteInput(input);if(Object.keys(owned).sort().join()!=='attemptId,contentDigest'||!isUuid(owned.attemptId)||!digest(owned.contentDigest))throw failure('CLOUD_POINTER_INPUT');
    for await(const value of sources({prefix:`resume:${owned.attemptId}:${owned.contentDigest}:`,expected:{kind:'resume_state',attemptId:owned.attemptId,contentDigest:owned.contentDigest}}))return value;
    throw failure('MISSING_PARENT_RESUME_STATE');
  }
  async function* historicalEventSources(input){
    const owned=ownedWriteInput(input);if(Object.keys(owned).sort().join()!=='attemptId,cut,writerStreamId'||!isUuid(owned.attemptId)||!isUuid(owned.writerStreamId)||typeof owned.cut!=='string'||!/^(0|[1-9][0-9]{0,19})$/.test(owned.cut))throw failure('CLOUD_POINTER_INPUT');
    for await(const value of sources({prefix:`events:${owned.attemptId}:${owned.writerStreamId}:`,expected:{kind:'answer_event',attemptId:owned.attemptId,writerStreamId:owned.writerStreamId}})){if(BigInt(value.serverSeq)>BigInt(owned.cut))break;yield value;}
  }
  return Object.freeze({readPointer,sources,lastEntitySource,historicalResumeSource,historicalEventSources});
}
