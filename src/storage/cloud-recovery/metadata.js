import {canonicalBytes,sha256Hex,validateMutation,verifyMutationDigest,validateMutationReceipt,validateMigrationJournalRecord,validateImportReceiptRecord,validateChangeLogRecord} from '../../domain/app-data/index.js';
import {isUuid} from '../../domain/question/index.js';
import {snapshotOwner} from '../profiles/control-schema.js';
import {ownedWriteInput} from '../idb/write-input.js';
import {validateCloudCheckpoint,CLOUD_SECTION_PATHS} from '../../../do-worker/src/account-cloud-checkpoint.js';

export const cloudError=code=>Object.assign(new Error(code),{code});
const exact=(value,keys)=>value&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).sort().join()===keys.split(',').sort().join();
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const integer=value=>Number.isSafeInteger(value)&&value>=0;
export function validateCloudStageJournal(input){
  const row=ownedWriteInput(input);validateMigrationJournalRecord(row);
  if(!exact(row,'migrationId,status,counts,checkpoint')||!['RAW_SAVED','VERIFIED','QUARANTINED'].includes(row.status))throw cloudError('CLOUD_STAGE_JOURNAL');
  const p=row.checkpoint;
  if(!exact(p,'format,owner,profileId,sourceProfileId,activationRevision,exportId,checkpointDigest,generation,logEpoch,cloudCheckpoint')||p.format!=='qb-cloud-recovery-stage-v1'||!isUuid(p.profileId)||!isUuid(p.sourceProfileId)||!integer(p.activationRevision)||!hash(p.checkpointDigest))throw cloudError('CLOUD_STAGE_JOURNAL');
  const owner=snapshotOwner(p.owner),checkpoint=validateCloudCheckpoint(p.cloudCheckpoint);
  if(owner.ownerKind!=='account'||owner.accountGeneration!==p.generation||checkpoint.generation!==p.generation||checkpoint.logEpoch!==p.logEpoch||checkpoint.exportId!==p.exportId||!checkpoint.complete)throw cloudError('CLOUD_STAGE_OWNER');
  if(!exact(row.counts,CLOUD_SECTION_PATHS.join(',')))throw cloudError('CLOUD_STAGE_JOURNAL');
  for(const path of CLOUD_SECTION_PATHS){const count=row.counts[path];if(!exact(count,'pages,count,utf8Bytes')||!integer(count.pages)||!integer(count.count)||!integer(count.utf8Bytes))throw cloudError('CLOUD_STAGE_JOURNAL');const expected=checkpoint.sections.find(section=>section.path===path);if(count.count>expected.count||count.utf8Bytes>expected.utf8Bytes)throw cloudError('CLOUD_STAGE_BUDGET');}
  return row;
}
export function validateCloudPageReceipt(input){
  const row=ownedWriteInput(input);validateImportReceiptRecord(row);const p=row.provenance;
  if(!exact(p,'format,stageId,section,index,count,utf8Bytes,sha256,storageDigest')||p.format!=='qb-cloud-stage-page-v1'||!isUuid(p.stageId)||!CLOUD_SECTION_PATHS.includes(p.section)||!integer(p.index)||!integer(p.count)||p.count>100||!integer(p.utf8Bytes)||p.utf8Bytes>480*1024||!hash(p.sha256)||!hash(p.storageDigest)||row.sourceId!==`qb-cloud-stage:${p.stageId}`||row.sourceRecordId!==`${p.section}:${p.index}`)throw cloudError('CLOUD_STAGE_PAGE');
  return row;
}
// Business chunk primary keys are SHA256, so the UUID namespace is part of a
// canonical preimage, not an invalid textual prefix or an existing body digest.
export async function cloudTemporaryDigest(stageId,kind,key){
  if(!isUuid(stageId)||!['page','chunk'].includes(kind)||typeof key!=='string'||key.length>512)throw cloudError('CLOUD_STAGE_KEY');
  return sha256Hex(canonicalBytes({format:'qb-cloud-stage-key-v1',stageId,kind,key}));
}
export async function validateCloudReceipt(input,{generation,logEpoch,cut,change}={}){
  const row=ownedWriteInput(input);validateImportReceiptRecord(row);const p=row.provenance;
  if(!exact(p,'format,generation,logEpoch,mutation,receipt')||p.format!=='qb-cloud-receipt-v1'||!isUuid(p.generation)||!isUuid(p.logEpoch)||row.sourceId!==`qb-cloud-receipt-v1:${p.generation}:${p.logEpoch}`)throw cloudError('CLOUD_RECEIPT_CORRUPT');
  validateMutation(p.mutation);validateMutationReceipt(p.receipt);
  if(row.sourceRecordId!==p.mutation.mutationId||p.receipt.mutationId!==p.mutation.mutationId||p.receipt.payloadDigest!==p.mutation.payloadDigest||!await verifyMutationDigest(p.mutation)||p.receipt.status==='missing_dependency'||generation&&generation!==p.generation||logEpoch&&logEpoch!==p.logEpoch)throw cloudError('CLOUD_RECEIPT_CORRUPT');
  if(p.receipt.status!=='conflict'){
    if(['bank_revision','history_snapshot','attempt_manifest','resume_state','user_state'].includes(p.mutation.kind)&&p.receipt.currentRevision!==undefined&&p.receipt.currentRevision!==p.mutation.payload.baseRevision+1)throw cloudError('CLOUD_RECEIPT_REVISION');
    if(cut!==undefined&&BigInt(p.receipt.serverSeq)>BigInt(cut))throw cloudError('CLOUD_RECEIPT_CUT');
    if(change){validateChangeLogRecord(change);if(change.accountGeneration!==p.generation||change.serverSeq!==p.receipt.serverSeq||change.kind!==p.mutation.kind||change.entityKey!==p.mutation.entityKey||new TextDecoder().decode(canonicalBytes(change.payload))!==new TextDecoder().decode(canonicalBytes(p.mutation.payload))||await sha256Hex(canonicalBytes({protocolVersion:2,kind:change.kind,entityKey:change.entityKey,payload:change.payload}))!==change.payloadDigest)throw cloudError('CLOUD_RECEIPT_CHANGE');}
  }
  return row;
}
