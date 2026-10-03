import {validateBrowserLearningExport,prepareBrowserLearningImport} from './local-storage-migration.js';
const fail=code=>{throw Object.assign(new Error(code),{code});};
/** Local read-back ACK; never cloud confirmation or deletion permission. */
export async function verifyBrowserMigrationReadback({value,session,isCurrent,targetOrigin}){
 const verified=await validateBrowserLearningExport(value),owner={...session.owner};
 const guard=()=>{if(!isCurrent()||owner.ownerKind!=='account'||session.owner.accountId!==owner.accountId||session.owner.accountGeneration!==owner.accountGeneration)fail('TARGET_PROFILE_CHANGED');};guard();
 const plan=prepareBrowserLearningImport(verified),rows=await session.repository.readRecords('legacy_raw');guard();
 const expected=plan.records.filter(r=>r.store==='legacy_raw').map(r=>r.value);
 for(const wanted of expected){const found=rows.filter(r=>r.sourceId===wanted.sourceId&&r.chunkIndex===wanted.chunkIndex);if(found.length!==1||Object.keys(wanted).some(k=>found[0][k]!==wanted[k]))fail('READBACK_MISMATCH');}
 const receipts=await session.repository.readRecords('import_receipts');guard();
 const receipt=receipts.find(r=>r.sourceId===plan.sourceId&&r.sourceRecordId===plan.sourceRecordId);
 if(!receipt||receipt.provenance.sourceDigest!==verified.dataDigest||receipt.provenance.sourceOrigin!==verified.sourceOrigin||receipt.provenance.answerEventsCreated!==0)fail('RECEIPT_MISMATCH');
 return {format:'qb-browser-migration-readback-ack-v1',version:1,targetOrigin,owner,sourceOrigin:verified.sourceOrigin,sourceDigest:verified.dataDigest,envelopeDigest:verified.sha256,sourceId:plan.sourceId,sourceRecordId:plan.sourceRecordId,records:verified.records.map(({key,byteLength,sha256})=>({namespace:key,byteLength,sha256})),verifiedAt:Date.now(),persistence:'local-account-profile',cloudConfirmed:false,sourceRetained:true};
}
