import {ownedWriteInput} from '../idb/write-input.js';
import {canonicalBytes,validateImportReceiptRecord} from '../../domain/app-data/index.js';
import {isUuid} from '../../domain/question/index.js';
import {BUSINESS_SCHEMA_VERSION} from '../idb/schema.js';

const failure=code=>Object.assign(new Error(code),{code});
const exact=(value,keys)=>Object.keys(value).sort().join()===keys.split(',').sort().join();
const key=value=>Array.isArray(value)&&value.length===2&&value.every(part=>typeof part==='string'&&part.length>0&&part.length<=512);
/** Pure bounds preparation; input is captured before native lock/transaction waits.
 * Only existing import_receipts compound primary keys are scanned. No schema or
 * secondary index is invented and no arbitrary binary business row is collected.
 */
export function prepareCloudPrimaryScan(input){
  const value=ownedWriteInput(input);
  if(!exact(value,'sourceId,lower,upper,after,limit,maxBytes')||typeof value.sourceId!=='string'||!value.sourceId.startsWith('qb-cloud-stage-index:')||!isUuid(value.sourceId.slice('qb-cloud-stage-index:'.length))||!key(value.lower)||!key(value.upper)||value.lower[0]!==value.sourceId||value.upper[0]!==value.sourceId||(value.after!==null&&(!key(value.after)||value.after[0]!==value.sourceId))||!Number.isSafeInteger(value.limit)||value.limit<1||value.limit>100||!Number.isSafeInteger(value.maxBytes)||value.maxBytes<1||value.maxBytes>1024*1024)throw failure('CLOUD_SCAN_INPUT');
  if(value.lower[1]>value.upper[1]||value.after!==null&&(value.after[1]<value.lower[1]||value.after[1]>value.upper[1]))throw failure('CLOUD_SCAN_INPUT');
  return value;
}
/** Real native cursor, not a callback provider or an array map. Integration must
 * supply its private opened inactive IDBDatabase and synchronous lifecycle guard.
 * Every success awaits native tx.complete; cancellation always settles once.
 */
export function scanCloudPrimaryPage(database,input,{signal,guard=()=>{},timeoutMs=5000}={}){
  const bounds=prepareCloudPrimaryScan(input);
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>2147483647)throw failure('CLOUD_SCAN_INPUT');
  guard();if(signal?.aborted)throw failure('CLOSED');
  if(!database||typeof database.transaction!=='function'||database.version!==BUSINESS_SCHEMA_VERSION||!database.objectStoreNames.contains('import_receipts'))throw failure('SCHEMA_MISMATCH');
  return new Promise((resolve,reject)=>{
    let transaction,ended=false,timer;const rows=[];let byteCount=0,lastKey=null,more=false;
    const finish=cause=>{if(ended)return;ended=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);if(cause)reject(cause);else{try{guard();if(signal?.aborted)throw failure('CLOSED');resolve({rows,byteCount,continuation:more?lastKey:null});}catch(error){reject(error);}}};
    const cancel=()=>{try{transaction?.abort();}catch{}finish(failure('CLOUD_SCAN_NOT_COMMITTED'));};
    try{
      transaction=database.transaction(['import_receipts'],'readonly');
      transaction.oncomplete=()=>finish();transaction.onabort=()=>finish(failure('CLOUD_SCAN_NOT_COMMITTED'));transaction.onerror=()=>{};
      signal?.addEventListener('abort',cancel,{once:true});timer=setTimeout(cancel,timeoutMs);
      if(bounds.after?.[1]===bounds.upper[1])return;
      const lower=bounds.after??bounds.lower;
      const request=transaction.objectStore('import_receipts').openCursor(IDBKeyRange.bound(lower,bounds.upper,bounds.after!==null,false));
      request.onerror=cancel;
      request.onsuccess=()=>{try{guard();if(signal?.aborted)throw failure('CLOSED');const cursor=request.result;if(!cursor)return;
        if(!key(cursor.primaryKey)||cursor.primaryKey[0]!==bounds.sourceId)throw failure('CLOUD_SCAN_NAMESPACE');
        // The extra witness determines continuation without retaining its row.
        if(rows.length===bounds.limit){more=true;return;}
        const row=cursor.value;validateImportReceiptRecord(row);const bytes=canonicalBytes(row).length;
        if(bytes>bounds.maxBytes)throw failure('CLOUD_SCAN_ROW_BUDGET');
        if(byteCount+bytes>bounds.maxBytes){if(!lastKey)throw failure('CLOUD_SCAN_ROW_BUDGET');more=true;return;}
        rows.push(row);byteCount+=bytes;lastKey=[...cursor.primaryKey];cursor.continue();
      }catch(error){try{transaction.abort();}catch{}finish(error);}};
    }catch(error){try{transaction?.abort();}catch{}finish(error);}
  });
}
