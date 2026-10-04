// Private scheduler component. It selects wakeups, not cleanup authority.
import {earliestAuthorityWake} from './account-secret-retention.js';
export function createAuthorityAlarmQueue(storage){
  if(typeof storage?.getAlarm!=='function'||typeof storage?.setAlarm!=='function')throw Error('NOT_CONFIGURED');
  let queue=Promise.resolve();
  function ensureDue(input){
    if(!input||Object.getPrototypeOf(input)!==Object.prototype||Reflect.ownKeys(input).sort().join()!=='deletionRetryAt,registrationExpiryAt,ticketExpiryAt,v2ExpiryAt')throw Error('INVALID_INPUT');
    const descriptors=Object.getOwnPropertyDescriptors(input);
    if(Object.values(descriptors).some(row=>!Object.hasOwn(row,'value')||!row.enumerable))throw Error('INVALID_INPUT');
    const due=Object.values(descriptors).map(row=>row.value);
    // Owned primitive capture happens before the first async wait.
    earliestAuthorityWake(due,Date.now());
    const task=queue.catch(()=>{}).then(async()=>{
      const current=await storage.getAlarm(),now=Date.now();
      if(current!==null&&(!Number.isSafeInteger(current)||current<0))throw Error('INVALID_ALARM');
      const requested=earliestAuthorityWake(due,now);
      if(requested!==null&&(current===null||current>requested))await storage.setAlarm(requested);
      return {scheduled:requested!==null,cleanupAuthorized:false};
    });
    queue=task;return task;
  }
  return Object.freeze({ensureDue});
}
