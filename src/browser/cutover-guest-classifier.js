import {openDB} from 'idb';
import {inventoryOldNativeProfiles} from './old-origin-native-export.js';
import {controlDbName,assertBusinessDbName} from '../storage/profiles/control-schema.js';
const prefs=new Set(['qb_theme','qb_ui_lang','qb_motion_v1','qb_tutorial_done_v3','qb_coffee_celebrated_v1','amt_auto_submit']);
// Only an unambiguous existing default guest gets automatic navigation.
// No learning payload, credential value, bootstrap, or writes are read/run.
export async function classifyCutoverSource(){
 const hold=reason=>({action:'hold',reason,sourceRetained:true});
 let db;
 const existing=async(name)=>{let late=false,timer;const opening=openDB(name,undefined,{upgrade(_d,_o,_n,tx){tx.abort();}});opening.then(d=>{if(late)d.close();},()=>{});try{return await Promise.race([opening,new Promise((_,reject)=>{timer=setTimeout(()=>{late=true;reject(Error('METADATA_TIMEOUT'));},3000);})]);}finally{clearTimeout(timer);}};
 try{
  const keys=s=>{if(!s||!Number.isSafeInteger(s.length)||s.length<0||s.length>10000)throw Error('STORAGE_UNKNOWN');return Array.from({length:s.length},(_,n)=>{const k=s.key(n);if(typeof k!=='string')throw Error('STORAGE_UNKNOWN');return k;}).sort();};
  const local=keys(localStorage),session=keys(sessionStorage);
  if(local.some(k=>!prefs.has(k))||session.some(k=>!prefs.has(k)))return hold('ACCOUNT_OR_UNKNOWN_KEYS');
  const signature=r=>JSON.stringify(r.map(x=>[x.name,x.version]).sort());
  const list=async()=>{let t;try{return await Promise.race([indexedDB.databases(),new Promise((_,reject)=>{t=setTimeout(()=>reject(Error('METADATA_TIMEOUT')),3000);})]);}finally{clearTimeout(t);}};
  const before=await list();if(!Array.isArray(before)||before.some(r=>typeof r.name!=='string'||!Number.isSafeInteger(r.version)))return hold('DATABASE_UNKNOWN');
  if(!before.length){if(signature(before)!==signature(await list())||JSON.stringify(local)!==JSON.stringify(keys(localStorage))||JSON.stringify(session)!==JSON.stringify(keys(sessionStorage)))return hold('METADATA_CHANGED');return {action:'redirect',reason:'POSITIVE_EMPTY_METADATA',sourceRetained:true};}
  const rows=await inventoryOldNativeProfiles();
  if(rows.length!==1||rows[0].owner.ownerKind!=='guest'||rows[0].state!=='ready'||!rows[0].exportable)return hold('ACCOUNT_OR_UNKNOWN_OWNER');
  const row=rows[0],control=controlDbName(row.controlId,'production');
  const directory=await existing('qb-v2-profile-directory');try{const tx=directory.transaction('meta','readonly'),guest=await tx.store.get('guest');await tx.done;if(!guest||Object.keys(guest).sort().join()!=='guestId,key'||guest.key!=='guest'||guest.guestId!==row.owner.guestId)return hold('GUEST_BINDING_UNKNOWN');}finally{directory.close();}
  db=await existing(control);
  const tx=db.transaction('profiles','readonly');if(await tx.store.count()!==1)return hold('ADDITIONAL_PROFILE_METADATA');const profile=await tx.store.get(row.profileId);await tx.done;const business=assertBusinessDbName(profile.dbName);
  if(before.length!==3||!before.some(r=>r.name==='qb-v2-profile-directory'&&r.version===1)||!before.some(r=>r.name===control&&r.version===1)||!before.some(r=>r.name===business&&r.version===2))return hold('UNCLASSIFIED_DATABASES');

  const again=await inventoryOldNativeProfiles();if(JSON.stringify(rows)!==JSON.stringify(again)||signature(before)!==signature(await list())||JSON.stringify(local)!==JSON.stringify(keys(localStorage))||JSON.stringify(session)!==JSON.stringify(keys(sessionStorage)))return hold('METADATA_CHANGED');
  return {action:'redirect',reason:'RELIABLY_CLASSIFIED_DEFAULT_GUEST',sourceRetained:true,guestBackupRequired:false};
 }catch(e){return hold(e.code||e.message||'STORAGE_UNKNOWN');}finally{db?.close();}
}
