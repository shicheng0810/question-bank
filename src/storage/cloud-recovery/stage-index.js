import {canonicalBytes,sha256Hex,validateImportReceiptRecord,validateChangeLogRecord,validateChunkManifest,verifyMutationDigest,validateMutationReceipt} from '../../domain/app-data/index.js';
import {validateCloudContentReference,CLOUD_SECTION_PATHS} from '../../../do-worker/src/account-cloud-checkpoint.js';
import {isUuid} from '../../domain/question/index.js';
import {ownedWriteInput} from '../idb/write-input.js';
import {cloudError,validateCloudStageJournal,validateCloudPageReceipt,cloudTemporaryDigest} from './metadata.js';
const exact=(value,keys)=>value&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).sort().join()===keys.split(',').sort().join();
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const hash=value=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);
const padded=value=>{if(typeof value!=='string'||!/^(0|[1-9][0-9]{0,19})$/.test(value))throw cloudError('CLOUD_STAGE_INDEX');return value.padStart(20,'0');};
const same=(a,b)=>new TextDecoder().decode(canonicalBytes(a))===new TextDecoder().decode(canonicalBytes(b));
export function cloudStageIndexSource(stageId){if(!isUuid(stageId))throw cloudError('CLOUD_STAGE_INDEX');return `qb-cloud-stage-index:${stageId}`;}

async function indexLabels(section,row){
  if(section==='content-manifests.ndjson'){validateChunkManifest(row);return [`manifest:${row.contentDigest}`];}
  if(section==='mutation-receipts.ndjson'){if(!exact(row,'mutation,receipt')||!await verifyMutationDigest(row.mutation))throw cloudError('CLOUD_STAGE_INDEX');validateMutationReceipt(row.receipt);if(row.receipt.mutationId!==row.mutation.mutationId||row.receipt.payloadDigest!==row.mutation.payloadDigest||row.receipt.status==='missing_dependency')throw cloudError('CLOUD_STAGE_INDEX');return [`receipt:${row.mutation.mutationId}`];}
  if(section==='content-references.ndjson'){validateCloudContentReference(row);if(!row.reference)throw cloudError('CLOUD_STAGE_INDEX');const change=row.sourceChange,entityHash=await sha256Hex(canonicalBytes(change.entityKey));return [`content:${row.reference.contentDigest}:${change.kind}:${entityHash}:${padded(change.serverSeq)}`,`source:${padded(change.serverSeq)}:${row.reference.contentDigest}:${change.kind}:${entityHash}`];}
  validateChangeLogRecord(row);const entityHash=await sha256Hex(canonicalBytes(row.entityKey)),seq=padded(row.serverSeq);
  if(section==='latest-state.ndjson')return [`latest:${row.kind}:${entityHash}`];
  if(section==='tombstones.ndjson'){if(row.kind!=='entity_tombstone')throw cloudError('CLOUD_STAGE_INDEX');return [`tombstone:${entityHash}:${seq}`];}
  if(section!=='accepted-changes.ndjson')throw cloudError('CLOUD_STAGE_INDEX');
  const labels=[`seq:${seq}`,`entity:${row.kind}:${entityHash}:${seq}`,`version:${row.kind}:${entityHash}:${row.payloadDigest}:${seq}`];
  if(row.kind==='resume_state')labels.push(`resume:${row.payload.attemptId}:${row.payload.contentDigest}:${seq}`);
  if(row.kind==='answer_event')labels.push(`events:${row.payload.event.attemptId}:${row.payload.event.writerStreamId}:${seq}`);
  return labels;
}
export function validateCloudStageIndexShape(input){
  const row=ownedWriteInput(input);validateImportReceiptRecord(row);const p=row.provenance;
  if(!exact(p,'format,stageId,section,pageIndex,rowIndex,pageSha256,storageDigest,rowSha256')||p.format!=='qb-cloud-stage-index-v1'||!isUuid(p.stageId)||!CLOUD_SECTION_PATHS.includes(p.section)||!integer(p.pageIndex)||!integer(p.rowIndex)||p.rowIndex>=100||!hash(p.pageSha256)||!hash(p.storageDigest)||!hash(p.rowSha256)||row.sourceId!==cloudStageIndexSource(p.stageId)||typeof row.sourceRecordId!=='string'||row.sourceRecordId.length>512)throw cloudError('CLOUD_STAGE_INDEX');
  return row;
}
/** Only pointers, never another payload copy or authority receipt. Caller must
 * atomically write these with the strict source page receipt/progress. */
export async function createCloudStageIndexes(input){
  const value=ownedWriteInput(input);if(!exact(value,'stageId,section,pageIndex,records,pageSha256,storageDigest,importedAt')||!isUuid(value.stageId)||!CLOUD_SECTION_PATHS.includes(value.section)||!integer(value.pageIndex)||!Array.isArray(value.records)||value.records.length>100||!hash(value.pageSha256)||!hash(value.storageDigest)||!integer(value.importedAt))throw cloudError('CLOUD_STAGE_INDEX');
  if(value.storageDigest!==await cloudTemporaryDigest(value.stageId,'page',`${value.section}:${value.pageIndex}`))throw cloudError('CLOUD_STAGE_INDEX');
  const pieces=value.records.map(row=>canonicalBytes(row));const byteLength=pieces.reduce((sum,bytes)=>sum+bytes.length+1,0);if(byteLength>480*1024)throw cloudError('CLOUD_PAGE_BUDGET');const pageBytes=new Uint8Array(byteLength);let offset=0;for(const bytes of pieces){pageBytes.set(bytes,offset);offset+=bytes.length;pageBytes[offset++]=10;}if(await sha256Hex(pageBytes)!==value.pageSha256)throw cloudError('CLOUD_STAGE_INDEX_SOURCE');
  const rows=[];for(let index=0;index<value.records.length;index++){const record=value.records[index],rowSha256=await sha256Hex(canonicalBytes(record));for(const label of await indexLabels(value.section,record))rows.push(validateCloudStageIndexShape({sourceId:cloudStageIndexSource(value.stageId),sourceRecordId:label,importedAt:value.importedAt,provenance:{format:'qb-cloud-stage-index-v1',stageId:value.stageId,section:value.section,pageIndex:value.pageIndex,rowIndex:index,pageSha256:value.pageSha256,storageDigest:value.storageDigest,rowSha256}}));}return rows;
}
/** Reader independently obtains all arguments from real native storage, then
 * rechecks page and row hashes and semantic lookup conditions. */
export async function verifyCloudStageIndex(input){
  const captured=ownedWriteInput(input);if(!exact(captured,'index,journal,pageReceipt,pageBytes,expected'))throw cloudError('CLOUD_STAGE_INDEX');
  const row=validateCloudStageIndexShape(captured.index),journal=validateCloudStageJournal(captured.journal),page=validateCloudPageReceipt(captured.pageReceipt),p=row.provenance,bytes=captured.pageBytes;
  if(!(bytes instanceof Uint8Array)||!bytes.length||bytes.length>480*1024||journal.migrationId!==p.stageId||page.provenance.stageId!==p.stageId||page.provenance.section!==p.section||page.provenance.index!==p.pageIndex||journal.counts[p.section].pages<=p.pageIndex||page.provenance.sha256!==p.pageSha256||page.provenance.storageDigest!==p.storageDigest||bytes.length!==page.provenance.utf8Bytes||await sha256Hex(bytes)!==p.pageSha256||p.storageDigest!==await cloudTemporaryDigest(p.stageId,'page',`${p.section}:${p.pageIndex}`))throw cloudError('CLOUD_STAGE_INDEX_SOURCE');
  const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(!text.endsWith('\n'))throw cloudError('CLOUD_STAGE_INDEX_SOURCE');const lines=text.slice(0,-1).split('\n');if(lines.length!==page.provenance.count||p.rowIndex>=lines.length)throw cloudError('CLOUD_STAGE_INDEX_SOURCE');
  const value=JSON.parse(lines[p.rowIndex]);if(new TextDecoder().decode(canonicalBytes(value))!==lines[p.rowIndex]||await sha256Hex(canonicalBytes(value))!==p.rowSha256||!(await indexLabels(p.section,value)).includes(row.sourceRecordId))throw cloudError('CLOUD_STAGE_INDEX_SOURCE');
  const change=p.section==='content-references.ndjson'?value.sourceChange:['accepted-changes.ndjson','latest-state.ndjson','tombstones.ndjson'].includes(p.section)?value:null;
  if(change&&(change.accountGeneration!==journal.checkpoint.generation||BigInt(change.serverSeq)>BigInt(journal.checkpoint.cloudCheckpoint.cut)||await sha256Hex(canonicalBytes({protocolVersion:2,kind:change.kind,entityKey:change.entityKey,payload:change.payload}))!==change.payloadDigest))throw cloudError('CLOUD_STAGE_INDEX_SOURCE');
  const expected=captured.expected;if(!exact(expected,Object.keys(expected).join(','))||Object.keys(expected).some(key=>!['kind','entityKey','serverSeq','payloadDigest','contentDigest','attemptId','writerStreamId','parentAttemptId'].includes(key)))throw cloudError('CLOUD_STAGE_INDEX_CONDITION');
  for(const [key,wanted]of Object.entries(expected)){let actual;if(['kind','entityKey','serverSeq','payloadDigest'].includes(key))actual=change?.[key];else if(key==='contentDigest')actual=value.reference?.contentDigest||value.contentDigest||change?.payload.contentDigest;else actual=change?.payload[key]||change?.payload.event?.[key];if(actual!==wanted)throw cloudError('CLOUD_STAGE_INDEX_CONDITION');}
  return {index:row,value};
}
export function assertCloudStageIndexCollision(existing,incoming){const a=validateCloudStageIndexShape(existing),b=validateCloudStageIndexShape(incoming);if(a.sourceId!==b.sourceId||a.sourceRecordId!==b.sourceRecordId||!same(a.provenance,b.provenance))throw cloudError('CLOUD_STAGE_INDEX_COLLISION');return a;}
