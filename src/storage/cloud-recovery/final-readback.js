import {sha256} from '@noble/hashes/sha2.js';
import {APP_DATA_STORES,canonicalBytes,sha256Hex,validateStoreRecord} from '../../domain/app-data/index.js';
import {assertBusinessSchema,BUSINESS_SCHEMA_VERSION} from '../idb/schema.js';
import {ownedWriteInput} from '../idb/write-input.js';
import {wrap} from 'idb';

const names=Object.freeze(Object.keys(APP_DATA_STORES).sort());
const legacyNames=Object.freeze(names.filter(name=>name!=='history_snapshots'));
const MAX_BATCH=3*1024*1024,MAX_TOTAL=100*1024*1024;
const failure=code=>Object.assign(new Error(code),{code});
const hex=bytes=>Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('');
const primaryKey=(store,row)=>{const path=APP_DATA_STORES[store].keyPath;return Array.isArray(path)?path.map(part=>row[part]):row[path];};
export function validateNativeManifestV2(input){
  const value=ownedWriteInput(input);
  if(Object.keys(value).sort().join()!=='businessSchemaVersion,format,keyOrder,rowEncoding,stores'||value.format!=='qb-v2-native-manifest-v2'||value.keyOrder!=='indexeddb-primary-key-v1'||value.rowEncoding!=='canonical-ndjson-v1'||!Array.isArray(value.stores))throw failure('NATIVE_MANIFEST_INPUT');
  const expected=value.businessSchemaVersion===1&&value.stores.length===19?legacyNames:value.businessSchemaVersion===BUSINESS_SCHEMA_VERSION&&value.stores.length===names.length?names:null;
  if(!expected)throw failure('NATIVE_MANIFEST_INPUT');
  let count=0;for(let index=0;index<expected.length;index++){const row=value.stores[index];if(!row||Object.keys(row).sort().join()!=='name,recordCount,sha256'||row.name!==expected[index]||!Number.isSafeInteger(row.recordCount)||row.recordCount<0||typeof row.sha256!=='string'||!/^[0-9a-f]{64}$/.test(row.sha256))throw failure('NATIVE_MANIFEST_INPUT');count+=row.recordCount;if(count>200000)throw failure('NATIVE_MANIFEST_INPUT');}return value;
}

/** Unintegrated native readback SUMMARY only. V1 remains unchanged. No ready,
 * activation, typed closure, authority, or full-snapshot verification is implied.
 * Caller must own the private inactive DB and hold an appropriate stable cut.
 */
export async function createNativeReadbackSummarizer(database,{signal,guard=()=>{},timeoutMs=5000}={}){
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>2147483647)throw failure('NATIVE_READBACK_INPUT');
  guard();if(signal?.aborted)throw failure('CLOSED');if(database?.version!==BUSINESS_SCHEMA_VERSION)throw failure('SCHEMA_MISMATCH');await assertBusinessSchema(wrap(database));guard();if(signal?.aborted)throw failure('CLOSED');if(database.version!==BUSINESS_SCHEMA_VERSION||names.length!==20)throw failure('SCHEMA_MISMATCH');
  let closed=false;const pending=new Map();
  const check=()=>{if(closed||signal?.aborted)throw failure('CLOSED');guard();};
  const close=()=>{if(closed)return;closed=true;signal?.removeEventListener('abort',close);database.removeEventListener('versionchange',close);for(const [transaction,reject]of pending){try{transaction.abort();}catch{}reject(failure('NATIVE_READBACK_NOT_COMMITTED'));}pending.clear();};
  signal?.addEventListener('abort',close,{once:true});database.addEventListener('versionchange',close);
  function batch(input){
    const value=ownedWriteInput(input);if(Object.keys(value).sort().join()!=='after,maxBatchBytes,maxRows,store'||!names.includes(value.store)||!Number.isSafeInteger(value.maxRows)||value.maxRows<1||value.maxRows>100||!Number.isSafeInteger(value.maxBatchBytes)||value.maxBatchBytes<1||value.maxBatchBytes>MAX_BATCH)throw failure('NATIVE_READBACK_INPUT');check();
    return new Promise((resolve,reject)=>{let transaction,timer,ended=false,after=null,more=false,retainedBytes=0;const rows=[];
      const finish=cause=>{if(ended)return;ended=true;clearTimeout(timer);pending.delete(transaction);if(cause)reject(cause);else{try{check();resolve({rows,after:more?after:null,retainedBytes});}catch(error){reject(error);}}};
      const cancel=()=>{try{transaction?.abort();}catch{}finish(failure('NATIVE_READBACK_NOT_COMMITTED'));};
      try{transaction=database.transaction([value.store],'readonly');pending.set(transaction,cause=>finish(cause));transaction.oncomplete=()=>finish();transaction.onabort=cancel;transaction.onerror=()=>{};timer=setTimeout(cancel,timeoutMs);
        const request=transaction.objectStore(value.store).openCursor(value.after===null?null:IDBKeyRange.lowerBound(value.after,true));
        request.onsuccess=()=>{try{check();const cursor=request.result;if(!cursor)return;if(rows.length===value.maxRows){more=true;return;}
          const row=cursor.value;validateStoreRecord(value.store,row);
          if(indexedDB.cmp(primaryKey(value.store,row),cursor.primaryKey)!==0)throw failure('NATIVE_READBACK_KEY');
          let size;
          if(value.store==='content_chunks'){if(!(row.bytes instanceof Uint8Array)||row.bytes.length<1||row.bytes.length>512*1024)throw failure('NATIVE_READBACK_ROW_BUDGET');size=row.bytes.length+canonicalBytes({contentDigest:row.contentDigest,chunkIndex:row.chunkIndex}).length+128;}
          else size=canonicalBytes(row).length;
          if(size>value.maxBatchBytes)throw failure('NATIVE_READBACK_ROW_BUDGET');if(retainedBytes+size>value.maxBatchBytes){if(!rows.length)throw failure('NATIVE_READBACK_ROW_BUDGET');more=true;return;}
          rows.push(row);retainedBytes+=size;after=ownedWriteInput(cursor.primaryKey);cursor.continue();
        }catch(error){try{transaction.abort();}catch{}finish(error);}};request.onerror=cancel;
      }catch(error){try{transaction?.abort();}catch{}finish(error);}
    });
  }
  async function summarize(input={maxRows:100,maxBatchBytes:MAX_BATCH}){
    const owned=ownedWriteInput(input);if(Object.keys(owned).sort().join()!=='maxBatchBytes,maxRows')throw failure('NATIVE_READBACK_INPUT');check();
    const stores=[];let totalRecords=0,totalReadBytes=0;
    for(const store of names){const hash=sha256.create();let after=null,recordCount=0;
      do{const page=await batch({store,after,...owned});check();totalReadBytes+=page.retainedBytes;if(totalReadBytes>MAX_TOTAL)throw failure('NATIVE_READBACK_TOTAL_BUDGET');
        for(const row of page.rows){const projected=store==='content_chunks'?{contentDigest:row.contentDigest,chunkIndex:row.chunkIndex,byteLength:row.bytes.length,sha256:await sha256Hex(row.bytes)}:row;check();hash.update(canonicalBytes(projected));hash.update(new Uint8Array([10]));recordCount++;if(++totalRecords>200000)throw failure('NATIVE_READBACK_COUNT_BUDGET');}
        after=page.after;
      }while(after!==null);stores.push({name:store,recordCount,sha256:hex(hash.digest())});
    }
    const manifest=validateNativeManifestV2({format:'qb-v2-native-manifest-v2',businessSchemaVersion:BUSINESS_SCHEMA_VERSION,keyOrder:'indexeddb-primary-key-v1',rowEncoding:'canonical-ndjson-v1',stores});check();
    const contentDigest=await sha256Hex(canonicalBytes(manifest));check();return {manifest,contentDigest,recordCount:totalRecords,totalReadBytes,verification:'summary_only'};
  }
  return Object.freeze({summarize,close});
}
