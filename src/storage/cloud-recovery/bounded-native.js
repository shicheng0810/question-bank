import {APP_DATA_STORES,canonicalBytes,validateStoreRecord} from '../../domain/app-data/index.js';
import {validateContentChunkRecordForFreshNativeRead} from '../../domain/app-data/local-records.js';
import {assertBusinessSchema,BUSINESS_SCHEMA_VERSION} from '../idb/schema.js';
import {ownedWriteInput} from '../idb/write-input.js';
import {wrap} from 'idb';
const fail=code=>Object.assign(new Error(code),{code});
export const NATIVE_BATCH_BYTES=3*1024*1024;
export const nativeRecordKey=(store,row)=>{const path=APP_DATA_STORES[store]?.keyPath;if(!path)throw fail('NATIVE_STORE_INPUT');return Array.isArray(path)?path.map(key=>row[key]):row[path];};
export function nativeRecordSize(store,row){validateStoreRecord(store,row);if(store==='content_chunks'){if(!(row.bytes instanceof Uint8Array)||row.bytes.length<1||row.bytes.length>512*1024)throw fail('NATIVE_ROW_BUDGET');return row.bytes.length+canonicalBytes({contentDigest:row.contentDigest,chunkIndex:row.chunkIndex}).length+128;}return canonicalBytes(row).length;}
const equal=(a,b)=>{if(a===undefined||b===undefined)return a===b;if(a?.bytes instanceof Uint8Array||b?.bytes instanceof Uint8Array)return a?.contentDigest===b?.contentDigest&&a?.chunkIndex===b?.chunkIndex&&a.bytes?.length===b.bytes?.length&&a.bytes.every((byte,index)=>byte===b.bytes[index]);const x=canonicalBytes(a),y=canonicalBytes(b);return x.length===y.length&&x.every((byte,index)=>byte===y[index]);};
// The realm's initial native IDB intrinsics are trusted, as are the public
// validator's initial typed-array intrinsics. Capture platform operations once.
// No caller row, flag, marker or old request
// can opt into the fresh-read validator. Environments without native IDB keep
// the complete public schema path (including test doubles).
const freshReadIntrinsics=typeof IDBDatabase==='function'&&typeof IDBTransaction==='function'&&typeof IDBObjectStore==='function'&&typeof IDBRequest==='function'&&typeof IDBCursor==='function'&&typeof IDBCursorWithValue==='function'?{
  transaction:IDBDatabase.prototype.transaction,
  objectStore:IDBTransaction.prototype.objectStore,
  get:IDBObjectStore.prototype.get,
  openCursor:IDBObjectStore.prototype.openCursor,
  result:Object.getOwnPropertyDescriptor(IDBRequest.prototype,'result')?.get,
  value:Object.getOwnPropertyDescriptor(IDBCursorWithValue.prototype,'value')?.get,
  continue:IDBCursor.prototype.continue,
  primaryKey:Object.getOwnPropertyDescriptor(IDBCursor.prototype,'primaryKey')?.get
}:null;
const freshReads=freshReadIntrinsics&&Object.values(freshReadIntrinsics).every(value=>typeof value==='function')?freshReadIntrinsics:null;
function freshReadsUnchanged(){return Boolean(freshReads
  &&IDBDatabase.prototype.transaction===freshReads.transaction
  &&IDBTransaction.prototype.objectStore===freshReads.objectStore
  &&IDBObjectStore.prototype.get===freshReads.get
  &&IDBObjectStore.prototype.openCursor===freshReads.openCursor
  &&Object.getOwnPropertyDescriptor(IDBRequest.prototype,'result')?.get===freshReads.result
  &&Object.getOwnPropertyDescriptor(IDBCursorWithValue.prototype,'value')?.get===freshReads.value
  &&IDBCursor.prototype.continue===freshReads.continue
  &&Object.getOwnPropertyDescriptor(IDBCursor.prototype,'primaryKey')?.get===freshReads.primaryKey);}
function nativeRecordSizeFromRead(store,row){
  if(store!=='content_chunks')return nativeRecordSize(store,row);
  validateContentChunkRecordForFreshNativeRead(row);
  if(!(row.bytes instanceof Uint8Array)||row.bytes.length<1||row.bytes.length>512*1024)throw fail('NATIVE_ROW_BUDGET');
  return row.bytes.length+canonicalBytes({contentDigest:row.contentDigest,chunkIndex:row.chunkIndex}).length+128;
}
/** Private native helper for unintegrated candidates. Does not own/open/activate
 * any profile. The caller supplies an already opened exact inactive/local DB.
 */
export async function createBoundedNativeAccess(database,{signal,guard=()=>{},timeoutMs=5000}={}){
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>2147483647)throw fail('NATIVE_STORE_INPUT');guard();if(signal?.aborted)throw fail('CLOSED');if(database?.version!==BUSINESS_SCHEMA_VERSION)throw fail('SCHEMA_MISMATCH');await assertBusinessSchema(wrap(database));guard();if(signal?.aborted)throw fail('CLOSED');if(database.version!==BUSINESS_SCHEMA_VERSION)throw fail('SCHEMA_MISMATCH');
  let closed=false;const pending=new Map();const check=()=>{if(closed||signal?.aborted)throw fail('CLOSED');guard();};
  const close=()=>{if(closed)return;closed=true;signal?.removeEventListener('abort',close);database.removeEventListener('versionchange',close);for(const [tx,reject]of pending){try{tx.abort();}catch{}reject(fail('NATIVE_STORE_NOT_COMMITTED'));}pending.clear();};
  signal?.addEventListener('abort',close,{once:true});database.addEventListener('versionchange',close);
  function transactionWithBegin(begin,stores,mode,work){check();return new Promise((resolve,reject)=>{let tx,timer,ended=false,result;const finish=cause=>{if(ended)return;ended=true;clearTimeout(timer);pending.delete(tx);if(cause)reject(cause);else{try{check();resolve(result);}catch(error){reject(error);}}};try{tx=begin(stores,mode);pending.set(tx,cause=>finish(cause));tx.oncomplete=()=>finish();tx.onabort=()=>finish(fail('NATIVE_STORE_NOT_COMMITTED'));tx.onerror=()=>{};timer=setTimeout(()=>{try{tx.abort();}catch{}finish(fail('NATIVE_STORE_NOT_COMMITTED'));},timeoutMs);work(tx,value=>result=value,error=>{try{tx.abort();}catch{}finish(error);});}catch(error){try{tx?.abort();}catch{}finish(error);}});}
  const transaction=(stores,mode,work)=>transactionWithBegin((names,kind)=>database.transaction(names,kind),stores,mode,work);
  const freshReadTransaction=(stores,mode,work)=>transactionWithBegin((names,kind)=>freshReads.transaction.call(database,names,kind),stores,mode,work);
  function readPage(input){const value=ownedWriteInput(input);if(Object.keys(value).sort().join()!=='after,limit,store'||!Object.hasOwn(APP_DATA_STORES,value.store)||!Number.isSafeInteger(value.limit)||value.limit<1||value.limit>100)throw fail('NATIVE_STORE_INPUT');const beganFresh=freshReadsUnchanged();return (beganFresh?freshReadTransaction:transaction)([value.store],'readonly',(tx,set,abort)=>{const rows=[];let bytes=0,last=null,more=false;const createdFresh=beganFresh&&freshReadsUnchanged(),store=createdFresh?freshReads.objectStore.call(tx,value.store):tx.objectStore(value.store),bound=value.after===null?null:IDBKeyRange.lowerBound(value.after,true),request=createdFresh?freshReads.openCursor.call(store,bound):store.openCursor(bound);let requestFresh=createdFresh;request.onsuccess=()=>{try{check();requestFresh=requestFresh&&freshReadsUnchanged();const useFresh=requestFresh,cursor=useFresh?freshReads.result.call(request):request.result;if(!cursor){set({rows,bytes,after:null});return;}if(rows.length===value.limit){set({rows,bytes,after:last});return;}const row=useFresh?freshReads.value.call(cursor):cursor.value,size=useFresh?nativeRecordSizeFromRead(value.store,row):nativeRecordSize(value.store,row);if(indexedDB.cmp(nativeRecordKey(value.store,row),cursor.primaryKey)!==0)throw fail('NATIVE_RECORD_KEY');if(size>NATIVE_BATCH_BYTES)throw fail('NATIVE_ROW_BUDGET');if(bytes+size>NATIVE_BATCH_BYTES){if(!rows.length)throw fail('NATIVE_ROW_BUDGET');more=true;set({rows,bytes,after:last});return;}rows.push(row);bytes+=size;last=ownedWriteInput(cursor.primaryKey);requestFresh=requestFresh&&freshReadsUnchanged();cursor.continue();}catch(error){abort(error);}};});}
  function readKeys(input,options={maxBytes:NATIVE_BATCH_BYTES}){const settings=ownedWriteInput(options);if(Object.keys(settings).sort().join()!=="maxBytes"||![1048576,NATIVE_BATCH_BYTES].includes(settings.maxBytes))throw fail("NATIVE_STORE_INPUT");const value=ownedWriteInput(input);if(!Array.isArray(value)||value.length>100||value.some(row=>Object.keys(row).sort().join()!=='key,store'||!Object.hasOwn(APP_DATA_STORES,row.store)))throw fail('NATIVE_STORE_INPUT');if(!value.length)return Promise.resolve([]);const beganFresh=freshReadsUnchanged();return (beganFresh?freshReadTransaction:transaction)([...new Set(value.map(row=>row.store))],'readonly',(tx,set,abort)=>{const rows=Array(value.length);let left=value.length,bytes=0;value.forEach((row,index)=>{const createdFresh=beganFresh&&freshReadsUnchanged(),store=createdFresh?freshReads.objectStore.call(tx,row.store):tx.objectStore(row.store),request=createdFresh?freshReads.get.call(store,row.key):store.get(row.key);request.onsuccess=()=>{try{check();const useFresh=createdFresh&&freshReadsUnchanged(),record=useFresh?freshReads.result.call(request):request.result;if(record!==undefined){bytes+=useFresh?nativeRecordSizeFromRead(row.store,record):nativeRecordSize(row.store,record);if(bytes>settings.maxBytes)throw fail('NATIVE_BATCH_BUDGET');}rows[index]=record;if(!--left)set(rows);}catch(error){abort(error);}};});});}
  // Input rows originate from this helper's capped native cuts or strict bounded
  // projector output; this is not a public arbitrary-user-write API.
  function putExact(input){if(!Array.isArray(input)||input.length>100)throw fail('NATIVE_STORE_INPUT');let bytes=0;for(const row of input){if(Object.keys(row).sort().join()!=='expected,store,value'||!Object.hasOwn(APP_DATA_STORES,row.store))throw fail('NATIVE_STORE_INPUT');bytes+=nativeRecordSize(row.store,row.value)+(row.expected===undefined?0:nativeRecordSize(row.store,row.expected));if(bytes>NATIVE_BATCH_BYTES)throw fail('NATIVE_BATCH_BUDGET');}const rows=ownedWriteInput(input);if(!rows.length)return Promise.resolve({written:0});return transaction([...new Set(rows.map(row=>row.store))],'readwrite',(tx,set,abort)=>{let left=rows.length;for(const row of rows){const request=tx.objectStore(row.store).get(nativeRecordKey(row.store,row.value));request.onsuccess=()=>{try{check();if(!equal(request.result,row.expected))throw fail('NATIVE_FACT_CHANGED');if(!--left){for(const item of rows)tx.objectStore(item.store).put(item.value);set({written:rows.length});}}catch(error){abort(error);}};}});}
  return Object.freeze({readPage,readKeys,putExact,close});
}
