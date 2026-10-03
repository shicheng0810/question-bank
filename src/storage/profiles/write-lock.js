import {storageError} from '../idb/transaction.js';
const keyPattern=/^qb-profile-write:qb-(?:v2|b1a-test)-control-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function validateProfileWriteLockKey(key){if(typeof key!=='string'||!keyPattern.test(key))throw storageError('INVALID_INPUT','invalid profile lock key');return key;}
/** Native Web Locks only. The budget covers queueing, not a granted native
 * transaction; callers abort their transactions on authority closure.
 */
export async function withProfileWriteLock(key,mode,work,{signal,timeoutMs=5000}={}){
  validateProfileWriteLockKey(key);
  if(!['shared','exclusive'].includes(mode)||typeof work!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>2147483647)throw storageError('INVALID_INPUT','invalid profile lock request');
  if(!globalThis.navigator?.locks?.request)throw storageError('STORAGE_LOCKS_UNAVAILABLE','native Web Locks are required');
  const cancellation=new AbortController();let acquired=false,timedOut=false;
  const cancel=()=>cancellation.abort();signal?.addEventListener('abort',cancel,{once:true});
  if(signal?.aborted)cancel();
  const timer=setTimeout(()=>{if(!acquired){timedOut=true;cancel();}},timeoutMs);
  try{return await navigator.locks.request(key,{mode,signal:cancellation.signal},async()=>{acquired=true;clearTimeout(timer);if(signal?.aborted)throw storageError('CLOSED','profile lock cancelled');return work();});}
  catch(error){if(!acquired&&cancellation.signal.aborted)throw storageError(timedOut?'LOCK_WAIT_TIMEOUT':'CLOSED',timedOut?'profile lock wait expired':'profile lock cancelled',error);throw error;}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
}
