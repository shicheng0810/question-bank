import {APP_DATA_STORES,canonicalContentBytes,validateStoreRecord} from '../../domain/app-data/index.js';
import {assertBusinessSchema,BUSINESS_SCHEMA_VERSION} from '../idb/schema.js';
import {assertBusinessDbName} from '../profiles/control-schema.js';
import {ownedWriteInput} from '../idb/write-input.js';
import {wrap} from 'idb';
import {createCloudPointerProjector} from './pointer-projector.js';
import {createFinalDependencyReader} from './final-dependency-reader.js';
import {createNativeCheckpointProjector} from './native-projector.js';
import {consumeFinalBundleProof} from './final-bundle-closure.js';
import {createSourceStringWorkspace} from './source-string-workspace.js';
import {createSourceRegisteredBankStreamer} from './bank-content-stream.js';

// Static trusted registry delegate only. The registry's private identity matcher
// must exist and bind both handles; DTOs never substitute for its capability.
export async function consumeSourceCapability(input){
  if(!input||Object.getPrototypeOf(input)!==Object.prototype||Reflect.ownKeys(input).sort().join()!=='sourceCapability,targetCapability,targetDatabase')throw error('INVALID_INPUT');
  const descriptors=Object.getOwnPropertyDescriptors(input);if(Object.values(descriptors).some(row=>!row.enumerable||!Object.hasOwn(row,'value')))throw error('INVALID_INPUT');
  const sourceCapability=descriptors.sourceCapability.value,targetCapability=descriptors.targetCapability.value,targetDatabase=descriptors.targetDatabase.value;
  const registry=await import('../profiles/managed-profile-registry.js');
  if(typeof registry.assertHeldProjectionTarget!=='function')throw error('PROJECTOR_PRIVATE_TARGET_UNAVAILABLE');
  const target=registry.assertHeldProjectionTarget(targetCapability,targetDatabase);
  const {consumeCloudProjectionSource}=await import('./index.js'),source=consumeCloudProjectionSource(sourceCapability);
  await target.recheck();await source.check();
  const metadata=await source.metadata();
  if(!same(target.metadata.owner,metadata.owner)||target.metadata.profileId===metadata.stageProfileId||!same(target.metadata.originalPointer,metadata.originalPointer)||target.metadata.sourceProfileId!==metadata.sourceProfileId)throw error('PROJECTOR_PRIVATE_TARGET_BINDING');
  const projector=await createNativeCheckpointProjector(targetDatabase,{owner:metadata.owner,checkpoint:metadata.checkpoint,checkpointDigest:metadata.checkpointDigest,proofWorkspace:target.proofWorkspace,sourceCapability});
  let next=1n,closed=false,running=false,sourcesPrepared=false;
  return Object.freeze({status:'inactive_projector_source_only',ready:false,
    async readDiagnostics(...args){if(args.length)throw error('INVALID_INPUT');if(closed)throw error('CLOSED');await target.recheck();await source.check();const actual=await projector.readDiagnostics();await target.recheck();await source.check();if(closed)throw error('CLOSED');return actual;},
    async projectNext(input){const row=ownedWriteInput(input);if(Object.keys(row).join()!=='limit'||!Number.isSafeInteger(row.limit)||row.limit<1||row.limit>100)throw error('INVALID_INPUT');if(closed)throw error('CLOSED');if(running)throw error('PROJECTOR_BUSY');running=true;try{await target.recheck();await source.check();if(!sourcesPrepared){const prepared=await projector.prepareNext({limit:row.limit});await target.recheck();await source.check();sourcesPrepared=!prepared.hasMore;return {status:'authentic_sources_staged_no_ready',sourceRecordsStaged:prepared.staged,projected:0,kinds:[],nextSeq:next.toString(),hasMore:true,ready:false};}let projected=0;const kinds=[];while(projected<row.limit&&next<=BigInt(metadata.checkpoint.cut)){const result=await projector.apply({serverSeq:next.toString()});await target.recheck();await source.check();kinds.push(result.kind);next++;projected++;}return {status:'source_projected_unverified',projected,kinds,nextSeq:next.toString(),hasMore:next<=BigInt(metadata.checkpoint.cut),ready:false};}finally{running=false;}},
    close(){if(closed)return;closed=true;projector.close();}});
}

const error=code=>Object.assign(new Error(code),{code});
const same=(a,b)=>{
  if(a===undefined||b===undefined)return a===b;
  if(a?.bytes instanceof Uint8Array&&b?.bytes instanceof Uint8Array)return a.contentDigest===b.contentDigest&&a.chunkIndex===b.chunkIndex&&a.bytes.length===b.bytes.length&&a.bytes.every((byte,index)=>byte===b.bytes[index]);
  return new TextDecoder().decode(canonicalContentBytes(a))===new TextDecoder().decode(canonicalContentBytes(b));
};

/** A real inactive business database, never an in-memory recovery provider.
 * All request chaining is native and synchronous. Closing explicitly rejects
 * pending operations even if WebKit does not deliver a queued abort event.
 */
export async function openCloudNativeDatabase({profile,blockedTimeoutMs=5000,signal,guard=()=>{}}){
  const dbName=assertBusinessDbName(ownedWriteInput(profile).dbName);
  if(!Number.isSafeInteger(blockedTimeoutMs)||blockedTimeoutMs<1||blockedTimeoutMs>2147483647)throw error('INVALID_INPUT');
  guard();if(signal?.aborted)throw error('CLOSED');
  if(typeof indexedDB.databases!=='function')throw error('STORAGE_INVENTORY_UNAVAILABLE');
  const inventory=await indexedDB.databases();guard();
  if(!inventory.some(row=>row.name===dbName&&row.version===BUSINESS_SCHEMA_VERSION))throw error('SCHEMA_MISMATCH');
  let closed=false,db,rejectOpening=null;const pending=new Map(),projections=new Set();
  function close(){if(closed)return;closed=true;for(const projection of projections)projection.close();projections.clear();signal?.removeEventListener('abort',close);rejectOpening?.(error('CLOSED'));for(const [tx,reject]of pending){try{tx.abort();}catch{}reject(error('CLOUD_RECOVERY_NOT_COMMITTED'));}pending.clear();db?.close();}
  signal?.addEventListener('abort',close,{once:true});
  const assertOpen=()=>{if(closed||signal?.aborted)throw error('CLOSED');guard();};
  try{db=await new Promise((resolve,reject)=>{
    const request=indexedDB.open(dbName,BUSINESS_SCHEMA_VERSION);let ended=false,openingDb;
    const finish=(cause,value)=>{if(ended){value?.close();return;}ended=true;rejectOpening=null;clearTimeout(timer);if(cause){openingDb?.close();reject(cause);}else resolve(value);};
    const timer=setTimeout(()=>finish(error('STORAGE_OPEN_TIMEOUT')),blockedTimeoutMs);
    rejectOpening=cause=>finish(cause);
    request.onupgradeneeded=()=>{request.transaction.abort();finish(error('SCHEMA_MISMATCH'));};
    request.onerror=()=>finish(error('STORAGE_UNAVAILABLE'));
    request.onsuccess=async()=>{openingDb=request.result;try{assertOpen();await assertBusinessSchema(wrap(openingDb));assertOpen();finish(null,openingDb);}catch(cause){openingDb.close();finish(cause);}};
  });assertOpen();}catch(cause){close();throw cause;}
  db.onversionchange=close;
  function transact(stores,mode,work){
    assertOpen();if(!Array.isArray(stores)||stores.some(name=>!Object.hasOwn(APP_DATA_STORES,name)))throw error('INVALID_INPUT');
    return new Promise((resolve,reject)=>{
      let tx,result,ended=false,workFailure;
      const finish=(cause)=>{if(ended)return;ended=true;pending.delete(tx);if(cause)reject(cause);else{try{assertOpen();resolve(result);}catch(failure){reject(failure);}}};
      try{tx=db.transaction(stores,mode);pending.set(tx,cause=>finish(cause));
        tx.oncomplete=()=>finish(workFailure);tx.onabort=()=>finish(workFailure??error(tx.error?.name==='QuotaExceededError'?'QUOTA_EXCEEDED':'CLOUD_RECOVERY_NOT_COMMITTED'));tx.onerror=()=>{};
        const set=value=>{result=value;},failWork=cause=>{workFailure??=cause;try{tx.abort();}catch{}finish(workFailure);};work(tx,set,failWork);
      }catch(cause){try{tx?.abort();}catch{}finish(cause);}
    });
  }
  return Object.freeze({close,
    hasStoreRows(input){const value=ownedWriteInput(input);if(Object.keys(value).join()!=='store'||typeof value.store!=='string'||!Object.hasOwn(APP_DATA_STORES,value.store))throw error('INVALID_INPUT');return transact([value.store],'readonly',(tx,set,failWork)=>{const request=tx.objectStore(value.store).openKeyCursor();request.onsuccess=()=>{try{assertOpen();set(request.result!==null);}catch(cause){failWork(cause);}};});},
    readSourceContext(){return transact(['meta'],'readonly',(tx,set,failWork)=>{const keys=['syncCoordinatorLease','serverLogEpoch','appliedPullCursor'],rows=new Array(3);let left=3,bytes=0;for(let index=0;index<keys.length;index++){const request=tx.objectStore('meta').get(keys[index]);request.onsuccess=()=>{try{assertOpen();const row=request.result;if(row!==undefined){validateStoreRecord('meta',row);if(row.key!==keys[index])throw error('CORRUPT');bytes+=canonicalContentBytes(row).length;if(bytes>1024*1024)throw error('PROOF_ROW_BUDGET');}rows[index]=row;if(!--left)set({lease:rows[0]?.value??null,logEpoch:rows[1]?.value??null,appliedPullCursor:rows[2]?.value??null});}catch(cause){failWork(cause);}};}});},
    async createSourceBankStreamer(capability){assertOpen();const workspace=await createSourceStringWorkspace(db,capability);let streamer;try{assertOpen();streamer=await createSourceRegisteredBankStreamer(db,workspace);assertOpen();return Object.freeze({stream:input=>{assertOpen();return streamer.stream(input);},cleanup:()=>workspace.cleanup(),close:()=>{streamer.close();workspace.close();},ready:false});}catch(cause){try{await workspace.cleanup();}catch(cleanupError){if(cause&&typeof cause==='object'&&Object.isExtensible(cause)){cause.cleanupRequired=true;cause.cleanupError=cleanupError.code||'CLOUD_SOURCE_STRING_CLEANUP_FAILED';}}streamer?.close();workspace.close();throw cause;}},
    async createCheckpointProjection(sourceCapability,targetCapability){assertOpen();let projection;try{projection=await consumeSourceCapability({sourceCapability,targetCapability,targetDatabase:db});assertOpen();projections.add(projection);return projection;}catch(cause){projection?.close();throw cause;}},
    async consumeFinalProof(token,bindingIdentity){assertOpen();const result=await consumeFinalBundleProof(token,db,bindingIdentity);assertOpen();await bindingIdentity.check();assertOpen();return result;},
    ownsDatabaseIdentity(candidate){assertOpen();return candidate===db;},
    assertProofNamespace(sourceId){if(typeof sourceId!=='string'||!/^qb-cloud-stage-index:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(sourceId))throw error('INVALID_INPUT');return transact(['import_receipts'],'readonly',(tx,set)=>{const request=tx.objectStore('import_receipts').openKeyCursor(IDBKeyRange.bound(['qb-cloud-stage-index:',''],['qb-cloud-stage-index:\uffff','\uffff']));request.onsuccess=()=>{try{assertOpen();const cursor=request.result;if(!cursor){set(true);return;}if(cursor.primaryKey[0]!==sourceId){tx.abort();return;}cursor.continue([sourceId+'\uffff','']);}catch{try{tx.abort();}catch{}}};});},
    createPointerProjector(context){assertOpen();return createCloudPointerProjector(db,context,{signal,guard:assertOpen,timeoutMs:blockedTimeoutMs});},
    createFinalReader(owner,proofWorkspace){assertOpen();return createFinalDependencyReader(db,{owner,proofWorkspace,signal,guard:assertOpen,timeoutMs:blockedTimeoutMs});},
    proofPage(input){const value=ownedWriteInput(input);if(Object.keys(value).sort().join()!=='after,limit,maxBytes,prefix,sourceId'||typeof value.sourceId!=='string'||!/^qb-cloud-stage-index:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.sourceId)||typeof value.prefix!=='string'||value.prefix.length>400||value.prefix.length&&!/^[A-Za-z0-9:_.\/-]+$/.test(value.prefix)||value.after!==null&&(typeof value.after!=='string'||value.after.length>512||value.after<value.prefix||value.after>value.prefix+'\uffff')||!Number.isSafeInteger(value.limit)||value.limit<1||value.limit>100||!Number.isSafeInteger(value.maxBytes)||value.maxBytes<1||value.maxBytes>1024*1024)throw error('INVALID_INPUT');return transact(['import_receipts'],'readonly',(tx,set)=>{const rows=[];let bytes=0,last=null;const lower=[value.sourceId,value.after??value.prefix],request=tx.objectStore('import_receipts').openCursor(IDBKeyRange.bound(lower,[value.sourceId,value.prefix+'\uffff'],value.after!==null,false));request.onsuccess=()=>{try{assertOpen();const cursor=request.result;if(!cursor){set({rows,after:null});return;}if(rows.length>=value.limit){set({rows,after:last});return;}validateStoreRecord('import_receipts',cursor.value);const size=canonicalContentBytes(cursor.value).length;if(size>3*1024*1024)throw error('PROOF_ROW_BUDGET');if(rows.length&&bytes+size>value.maxBytes){set({rows,after:last});return;}rows.push(cursor.value);bytes+=size;last=cursor.primaryKey[1];if(size>value.maxBytes){set({rows,after:last});return;}cursor.continue();}catch(cause){try{tx.abort();}catch{}set(undefined);}};});},
    read(stores){return transact(stores,'readonly',(tx,set)=>{const rows={};let left=stores.length;if(!left){set(rows);return;}for(const store of stores){const request=tx.objectStore(store).getAll();request.onsuccess=()=>{rows[store]=request.result;if(!--left)set(rows);};}});},
    get(store,key){return transact([store],'readonly',(tx,set)=>{const request=tx.objectStore(store).get(key);request.onsuccess=()=>set(request.result);});},
    getProofIndexes(input){
      const value=ownedWriteInput(input);
      if(Object.keys(value).sort().join()!=='labels,sourceId'||typeof value.sourceId!=='string'||!/^qb-cloud-stage-index:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.sourceId)||!Array.isArray(value.labels)||value.labels.length<1||value.labels.length>100||new Set(value.labels).size!==value.labels.length||value.labels.some(id=>typeof id!=='string'||!id.length||id.length>400||!/^[A-Za-z0-9:_.\/-]+$/.test(id)||id==='reservation'))throw error('INVALID_INPUT');
      return transact(['import_receipts'],'readonly',(tx,set,failWork)=>{
        const rows=new Array(value.labels.length);let remaining=rows.length,bytes=0;
        value.labels.forEach((id,index)=>{const request=tx.objectStore('import_receipts').get([value.sourceId,'index:'+id]);request.onsuccess=()=>{try{assertOpen();const row=request.result;if(row!==undefined){validateStoreRecord('import_receipts',row);if(row.sourceId!==value.sourceId||row.sourceRecordId!=='index:'+id||row.provenance?.format!=='qb-final-proof-index-v1'||row.provenance.label!==id)throw error('CORRUPT');bytes+=canonicalContentBytes(row).length;if(bytes>1024*1024)throw error('PROOF_ROW_BUDGET');}rows[index]=row??null;if(!--remaining)set(rows);}catch(cause){failWork(cause);}};});
      });
    },
    clear(stores){return transact(stores,'readwrite',tx=>{for(const store of stores)tx.objectStore(store).clear();});},
    write(input){
      const {puts=[],deletes=[],conditions=[]}=ownedWriteInput(input);
      puts.forEach(row=>validateStoreRecord(row.store,row.value));
      const stores=[...new Set([...puts,...deletes,...conditions].map(row=>row.store))];
      if(!stores.length)return Promise.resolve();
      return transact(stores,'readwrite',(tx,set)=>{
        const apply=()=>{for(const row of puts)tx.objectStore(row.store).put(row.value);for(const row of deletes)tx.objectStore(row.store).delete(row.key);set({written:puts.length});};
        if(!conditions.length){apply();return;}let left=conditions.length,valid=true;
        for(const row of conditions){const request=tx.objectStore(row.store).get(row.key);request.onsuccess=()=>{try{if(!same(request.result,row.expected))valid=false;}catch{valid=false;}if(!--left){if(!valid){tx.abort();return;}apply();}};}
      });
    }
  });
}
