import {storageError} from '../idb/transaction.js';
const control=/^qb-(?:v2|b1a-test)-control-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function cleanupJobLockKey(controlDbName,jobId){
 if(typeof controlDbName!=='string'||!control.test(controlDbName)||typeof jobId!=='string'||!uuid.test(jobId))throw storageError('INVALID_INPUT','invalid cleanup mutex binding');
 return `qb-profile-cleanup:${controlDbName}:${jobId}`;
}
/** Registry-only caller derives actual job/control identities. Queue time counts
 * toward the same real maintenance deadline; no profile grant is held here. */
export async function withCleanupJobLock(controlDbName,jobId,work,{signal,deadline}={}){
 const key=cleanupJobLockKey(controlDbName,jobId);
 if(typeof work!=='function'||!Number.isSafeInteger(deadline)||deadline-Date.now()>60000)throw storageError('INVALID_INPUT','invalid cleanup mutex budget');
 if(!globalThis.navigator?.locks?.request)throw storageError('STORAGE_LOCKS_UNAVAILABLE','native Web Locks required');
 const cancellation=new AbortController(),cancel=()=>cancellation.abort();let granted=false;
 signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
 const timer=setTimeout(cancel,Math.max(0,deadline-Date.now()));
 try{return await navigator.locks.request(key,{mode:'exclusive',signal:cancellation.signal},async()=>{
  granted=true;if(signal?.aborted)throw storageError('CLOSED','cleanup mutex cancelled');
  if(Date.now()>=deadline)throw storageError('CLOUD_CLEANUP_DEADLINE','cleanup mutex deadline');
  return work();
 });}catch(error){if(!granted&&cancellation.signal.aborted)throw storageError(signal?.aborted?'CLOSED':'CLOUD_CLEANUP_DEADLINE','cleanup mutex unavailable',error);throw error;}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
}
