import {canonicalBytes,sha256Hex,validateExportManifest} from '../domain/app-data/index.js';
import {validateCloudCheckpoint} from '../../do-worker/src/account-cloud-checkpoint.js';
import {validateCloudReceipt} from '../storage/cloud-recovery/metadata.js';
import {createCloudNdjsonDigest} from './cloud-recovery-v2.js';
import {openDB} from 'idb';
import {controlDbName,validateCleanupJob,validateCleanupCommitment,validateProfileJournalPair} from '../storage/profiles/control-schema.js';

const fail=code=>{throw Object.assign(new Error(code),{code});};
// Uses the ordinary signed-in controller; no bearer token, mutation POST,
// cursor reset, staging writes, or manager authority is exposed here.
export async function readMigrationPermanentReceipts({account,owner,guard,recoveredCheckpoint}) {
 const deadline=Date.now()+120000;
 const http=async command=>{guard();if(Date.now()>deadline)fail('RECEIPT_READ_DEADLINE');const r=await account.authenticatedTransport(command);guard();if(r.status!==200)fail(r.body?.error||'RECEIPT_READ_UNAVAILABLE');return r.body;};
 const started=await http({path:'/v2/export/start',method:'POST',body:{}});
 if(started?.ok!==true)fail('INVALID_CLOUD_CHECKPOINT');
 const manifest=validateExportManifest(started.manifest);if(await sha256Hex(canonicalBytes(manifest))!==started.manifestDigest||manifest.complete||!manifest.partial)fail('INVALID_FILE_MANIFEST');
 const c=structuredClone(validateCloudCheckpoint(started.checkpoint));
 if(manifest.exportId!==c.exportId||manifest.accountGeneration!==c.generation||manifest.serverLogEpoch!==c.logEpoch||manifest.exportCut!==c.cut||manifest.throughServerSeq!==c.cut)fail('INVALID_FILE_MANIFEST');
 if(!c.complete||c.exportId!==started.exportId||c.generation!==owner.accountGeneration||c.expiresAt!==started.expiresAt||c.expiresAt<=Date.now()||await sha256Hex(canonicalBytes(c))!==started.checkpointDigest)fail('INVALID_CLOUD_CHECKPOINT');
 if(!recoveredCheckpoint||recoveredCheckpoint.generation!==c.generation||recoveredCheckpoint.logEpoch!==c.logEpoch)fail('RECOVERY_CUT_BINDING');
 const section=c.sections.find(s=>s.path==='mutation-receipts.ndjson'),digest=createCloudNdjsonDigest(),rows=new Map();let after='0',bytes=0,count=0;
 // Explicit bounded read. Larger exports remain pending; never infer absence
 // or acceptance from partial pagination.
 if(section.count>20000||section.utf8Bytes>32*1024*1024)fail('RECEIPT_READ_BUDGET');
 for(;;){
  if(c.expiresAt<=Date.now())fail('EXPORT_EXPIRED');
  const p=await http({path:`/v2/export/page?${new URLSearchParams({exportId:c.exportId,section:section.path,after,limit:'100'})}`,method:'GET'});
  if(p.exportId!==c.exportId||p.section!==section.path||p.exportCut!==c.cut||!Array.isArray(p.records)||p.records.length>100||typeof p.hasMore!=='boolean'||!/^(0|[1-9][0-9]{0,19})$/.test(p.next)||BigInt(p.next)<BigInt(after)||p.hasMore&&BigInt(p.next)===BigInt(after))fail('INVALID_EXPORT_PAGE');
  for(const raw of p.records){
   if(!raw||Object.keys(raw).sort().join()!=='mutation,receipt')fail('INVALID_CLOUD_RECEIPT');
   const row=JSON.parse(new TextDecoder().decode(canonicalBytes(raw)));bytes+=canonicalBytes(row).length+1;count++;
   if(bytes>32*1024*1024||count>20000||rows.has(row.mutation.mutationId))fail('RECEIPT_READ_BUDGET_OR_DUPLICATE');
   await validateCloudReceipt({sourceId:`qb-cloud-receipt-v1:${c.generation}:${c.logEpoch}`,sourceRecordId:row.mutation.mutationId,importedAt:0,provenance:{format:'qb-cloud-receipt-v1',generation:c.generation,logEpoch:c.logEpoch,...row}},{generation:c.generation,logEpoch:c.logEpoch,cut:c.cut});
   guard();digest.add(row);rows.set(row.mutation.mutationId,row);
  }
  after=p.next;if(!p.hasMore)break;
 }
 const actual=digest.finish();if(actual.count!==section.count||actual.utf8Bytes!==section.utf8Bytes||actual.sha256!==section.sha256)fail('EXPORT_SECTION_DIGEST');guard();
 return {generation:c.generation,logEpoch:c.logEpoch,cut:recoveredCheckpoint.cut,rows};
}

// Read the existing terminal control commitment bound to the genuine recovery
// result. This reads metadata only and never mints or changes proof authority.
export async function readCommittedMigrationCheckpoint({boot,result,owner,guard}){
 guard();const name=controlDbName(boot.controlId,'production');if(!(await indexedDB.databases()).some(r=>r.name===name&&r.version===1))fail('RECOVERY_CONTROL_MISSING');
 let late=false,timer;const opening=openDB(name,undefined,{upgrade(_d,_o,_n,tx){tx.abort();}});opening.then(db=>{if(late)db.close();},()=>{});
 const db=await Promise.race([opening,new Promise((_,reject)=>{timer=setTimeout(()=>{late=true;reject(Object.assign(new Error('RECOVERY_CONTROL_TIMEOUT'),{code:'RECOVERY_CONTROL_TIMEOUT'}));},5000);})]).finally(()=>clearTimeout(timer));
 try{guard();const tx=db.transaction(['profiles','meta'],'readonly'),m=tx.objectStore('meta'),pointer=await m.get('activeProfile'),profile=await tx.objectStore('profiles').get(result.profile.profileId),journal=await m.get('fresh:'+result.profile.profileId);const pair=validateProfileJournalPair(profile,journal),commitment=validateCleanupCommitment(journal.cleanupCommitment),job=validateCleanupJob(await m.get('cleanup:'+commitment.jobId));await tx.done;guard();
 const b=job.binding,same=(a,v)=>new TextDecoder().decode(canonicalBytes(a))===new TextDecoder().decode(canonicalBytes(v));
 if(pair.phase!=='completed'||!same(pointer,result.pointer)||!same(profile,result.profile)||!same(pair.owner,owner)||job.phase==='prepared'||job.bindingDigest!==commitment.bindingDigest||await sha256Hex(canonicalBytes(b))!==job.bindingDigest||!same(b.owner,owner)||!same(b.finalPointer,pointer)||b.targetProfileId!==profile.profileId||b.targetJobId!==journal.jobId||b.targetContentDigest!==pair.verification.contentDigest)fail('RECOVERY_CUT_BINDING');
 const c=validateCloudCheckpoint(b.metadata.checkpoint);if(c.generation!==owner.accountGeneration||await sha256Hex(canonicalBytes(c))!==b.metadata.checkpointDigest)fail('RECOVERY_CUT_BINDING');guard();return {generation:c.generation,logEpoch:c.logEpoch,cut:c.cut};
 }finally{db.close();}
}
