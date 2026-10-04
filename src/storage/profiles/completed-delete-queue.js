import { openDB } from 'idb';
import { canonicalBytes } from '../../domain/app-data/canonical.js';
import { snapshotOwner, assertBusinessDbName } from './control-schema.js';

const KEY='completedDeletes',MAX=100;
const fail=code=>Object.assign(new Error(code),{code});
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join()===keys.slice().sort().join();
export function cleanupOwner(value){
  canonicalBytes(value);
  if(value===null)return null;
  if(!exact(value,['accountId','accountGeneration'])||!/^[0-9a-f]{64}$/.test(value.accountId)||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.accountGeneration))throw fail('INVALID_CLEANUP_RECEIPT');
  return {...value};
}
const identity=owner=>JSON.stringify(owner&&[owner.accountId,owner.accountGeneration]);
export function validateCompletedDeleteQueue(value){
  if(value===undefined)return{key:KEY,version:1,entries:[]};
  canonicalBytes(value);
  if(!exact(value,['key','version','entries'])||value.key!==KEY||value.version!==1||!Array.isArray(value.entries)||value.entries.length>MAX)throw fail('INVALID_CLEANUP_RECEIPT');
  const seen=new Set(),entries=value.entries.map(entry=>{if(!exact(entry,['owner','status'])||entry.status!=='server-complete')throw fail('INVALID_CLEANUP_RECEIPT');const owner=cleanupOwner(entry.owner),id=identity(owner);if(seen.has(id))throw fail('INVALID_CLEANUP_RECEIPT');seen.add(id);return{owner,status:'server-complete'};});
  return{key:KEY,version:1,entries};
}
export function updateCompletedDeleteQueue(value,owner,remove=false){
  const queue=validateCompletedDeleteQueue(value),captured=cleanupOwner(owner),id=identity(captured);
  const entries=queue.entries.filter(entry=>identity(entry.owner)!==id);
  if(!remove)entries.push({owner:captured,status:'server-complete'});
  if(entries.length>MAX)throw fail('LOCAL_CLEANUP_QUEUE_FULL');
  return{...queue,entries};
}
export function completedOwnerFromBinding(row){
  if(row?.state!=='cleanup_pending')return undefined;
  canonicalBytes(row);
  if(!exact(row,['key','owner','controlId','state','cleanupDbs']))throw fail('INVALID_CLEANUP_RECEIPT');
  const owner=snapshotOwner(row.owner);
  if(owner.ownerKind!=='account')throw fail('INVALID_CLEANUP_RECEIPT');
  const captured=cleanupOwner({accountId:owner.accountId,accountGeneration:owner.accountGeneration});
  if(row.key!==JSON.stringify(['account',captured.accountId,captured.accountGeneration])||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(row.controlId)||!Array.isArray(row.cleanupDbs)||row.cleanupDbs.length>1000||new Set(row.cleanupDbs).size!==row.cleanupDbs.length)throw fail('INVALID_CLEANUP_RECEIPT');
  for(const name of row.cleanupDbs)assertBusinessDbName(name);
  return captured;
}
async function directory(){
  let late=false,timer;
  const opening=openDB('qb-v2-profile-directory',1,{upgrade(db,old,_next,tx){if(late||old!==0){tx.abort();return;}db.createObjectStore('owners',{keyPath:'key'});db.createObjectStore('meta',{keyPath:'key'});}});
  opening.then(db=>{if(late)db.close();},()=>{});
  let db;
  try{db=await Promise.race([opening,new Promise((_resolve,reject)=>{timer=setTimeout(()=>{late=true;reject(fail('STORAGE_UNAVAILABLE'));},5000);})]);}finally{clearTimeout(timer);}
  try{
    if(db.version!==1||db.objectStoreNames.length!==2||!db.objectStoreNames.contains('owners')||!db.objectStoreNames.contains('meta'))throw fail('SCHEMA_MISMATCH');
    const tx=db.transaction(['owners','meta']);
    for(const name of ['owners','meta']){const store=tx.objectStore(name);if(store.keyPath!=='key'||store.autoIncrement||store.indexNames.length){tx.abort();await tx.done.catch(()=>{});throw fail('SCHEMA_MISMATCH');}}
    await tx.done;db.onversionchange=()=>db.close();return db;
  }catch(error){db.close();throw error;}
}
export async function readCompletedDeletes(){const db=await directory();try{return validateCompletedDeleteQueue(await db.get('meta',KEY)).entries;}finally{db.close();}}
export async function migrateCompletedDeleteBindings(){
  const db=await directory();try{const tx=db.transaction(['owners','meta'],'readwrite');try{
    let queue=validateCompletedDeleteQueue(await tx.objectStore('meta').get(KEY)),cursor=await tx.objectStore('owners').openCursor();
    while(cursor){const owner=completedOwnerFromBinding(cursor.value);if(owner)queue=updateCompletedDeleteQueue(queue,owner);cursor=await cursor.continue();}
    await tx.objectStore('meta').put(queue);await tx.done;
  }catch(error){try{tx.abort();}catch{}await tx.done.catch(()=>{});throw error;}}finally{db.close();}
}
async function mutate(owner,remove){const captured=cleanupOwner(owner),db=await directory();try{const tx=db.transaction('meta','readwrite');try{const next=updateCompletedDeleteQueue(await tx.store.get(KEY),captured,remove);await tx.store.put(next);await tx.done;}catch(error){try{tx.abort();}catch{}await tx.done.catch(()=>{});throw error;}}finally{db.close();}}
// Only the validated server-complete controller path and exact legacy receipt
// migration call append. This metadata is not a credential/Ready authority.
export const appendCompletedDelete=owner=>mutate(owner,false);
export const removeCompletedDelete=owner=>mutate(owner,true);
