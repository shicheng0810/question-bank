import {APP_DATA_STORES,canonicalBytes,sha256Hex,validateStoreRecord,validateMutation,validateMutationRecord,verifyMutationDigest,validateImportReceiptRecord,decodeCursor} from '../../domain/app-data/index.js';
import {isUuid,isQuestionKey} from '../../domain/question/index.js';
import {snapshotOwner} from '../profiles/control-schema.js';
import {ownedWriteInput} from '../idb/write-input.js';
import {mutationWire,validateSyncReceipt,validateSyncChangeReceipt,syncError} from './protocol.js';

export const STAR_GROUP_FORMAT='qb-star-conflict-group-resolution-v1';
export const STAR_GROUP_STORES=Object.freeze(['meta','mutations','outbox','conflicts','import_receipts','user_state']);
export const STAR_GROUP_READ_BYTES=3*1024*1024;
const eq=(a,b)=>new TextDecoder().decode(canonicalBytes(a))===new TextDecoder().decode(canonicalBytes(b));
const exact=(value,keys)=>value&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).sort().join()===keys.split(',').sort().join();
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const capture=value=>{canonicalBytes(value);return ownedWriteInput(value);};
function star(wire){validateMutation(wire);if(wire.kind!=='user_state'||wire.payload.field!=='starred'||wire.entityKey!==`user_state:${wire.payload.questionKey}:starred`)throw syncError('STAR_GROUP_SOURCE_UNAVAILABLE');}
function validateState(state){
  if(!exact(state,STAR_GROUP_STORES.join(',')))throw syncError('STAR_GROUP_STATE');
  for(const store of STAR_GROUP_STORES){if(!Array.isArray(state[store]))throw syncError('STAR_GROUP_STATE');const keys=new Set();for(const row of state[store]){validateStoreRecord(store,row);const path=APP_DATA_STORES[store].keyPath,key=JSON.stringify(Array.isArray(path)?path.map(k=>row[k]):row[path]);if(keys.has(key))throw syncError('STAR_GROUP_STATE');keys.add(key);}}
}
/** Synchronous exact projection, also recomputed INSIDE the final native tx.
 * It grants no cloud authority: async original-wire/source validation follows. */
export function projectStarConflictGroup(state,ownerValue,entityKey){
  validateState(state);const owner=snapshotOwner(ownerValue);
  if(owner.ownerKind!=='account'||typeof entityKey!=='string'||!entityKey.startsWith('user_state:')||!entityKey.endsWith(':starred')||!isQuestionKey(entityKey.slice(11,-8)))throw syncError('INVALID_INPUT');
  const streamRow=state.meta.find(r=>r.key==='clientStreamId'),seqRow=state.meta.find(r=>r.key==='clientSeq'),epochRow=state.meta.find(r=>r.key==='serverLogEpoch'),cursorRow=state.meta.find(r=>r.key==='appliedPullCursor')||null;
  if(!streamRow||!seqRow||!epochRow||!cursorRow||!isUuid(epochRow.value))throw syncError('PULL_REQUIRED');
  const cursor=decodeCursor(cursorRow.value);if(cursor.accountGeneration!==owner.accountGeneration||cursor.logEpoch!==epochRow.value)throw syncError('PULL_REQUIRED');
  const pending=[];
  for(const outbox of state.outbox){const mutation=state.mutations.find(r=>r.mutationId===outbox.mutationId);if(!mutation)throw syncError('STAR_GROUP_SOURCE_UNAVAILABLE');if(mutation.kind!=='user_state'||mutation.entityKey!==entityKey)continue;star(mutationWire(mutation));if(mutation.accountGeneration!==owner.accountGeneration)throw syncError('STAR_GROUP_SOURCE_UNAVAILABLE');if(mutation.clientStreamId!==streamRow.value)throw syncError('STAR_GROUP_FOREIGN_STREAM');const conflict=state.conflicts.find(r=>r.conflictId===mutation.mutationId)||null;if(conflict&&(!eq(conflict.mutation,mutationWire(mutation))||conflict.entityKey!==entityKey||conflict.status!=='open'))throw syncError('STAR_GROUP_SOURCE_UNAVAILABLE');pending.push({originalMutation:mutationWire(mutation),originalRecord:mutation,outbox,conflict});}
  pending.sort((a,b)=>a.originalMutation.clientSeq-b.originalMutation.clientSeq);
  if(!pending.length||!pending.some(r=>r.conflict))throw syncError('STAR_GROUP_NOT_OPEN');
  if(pending.at(-1).originalMutation.clientSeq>seqRow.value||new Set(pending.map(r=>r.originalMutation.clientSeq)).size!==pending.length)throw syncError('STAR_GROUP_SOURCE_UNAVAILABLE');
  const localState=state.user_state.find(r=>r.questionKey===pending[0].originalMutation.payload.questionKey&&r.field==='starred');if(!localState||localState.value!==pending.at(-1).originalMutation.payload.value)throw syncError('STAR_GROUP_LOCAL_CHANGED');
  const sourceId=`qb-sync-v2:${owner.accountGeneration}:${epochRow.value}`,entityReceipt=state.import_receipts.find(r=>r.sourceId===sourceId&&r.sourceRecordId===`entity:user_state:${entityKey}`);
  if(!entityReceipt)throw syncError('PULL_REQUIRED');validateSyncReceipt(entityReceipt);
  const sources=state.import_receipts.filter(r=>r.sourceId===sourceId&&r.provenance?.format==='qb-sync-change-v1'&&r.provenance.change?.kind==='user_state'&&r.provenance.change.entityKey===entityKey).sort((a,b)=>a.provenance.change.serverRevision-b.provenance.change.serverRevision||(BigInt(a.provenance.change.serverSeq)<BigInt(b.provenance.change.serverSeq)?-1:BigInt(a.provenance.change.serverSeq)>BigInt(b.provenance.change.serverSeq)?1:0));
  const sourceReceipt=sources.at(-1),change=sourceReceipt?.provenance.change;
  if(!change||change.serverRevision!==entityReceipt.provenance.serverRevision||change.payloadDigest!==entityReceipt.provenance.payloadDigest||BigInt(change.serverSeq)>BigInt(cursor.serverSeq))throw syncError('PULL_REQUIRED');
  // Equal payloads from another mutation are NOT acknowledgement of this wire.
  for(const member of pending)for(const receipt of state.import_receipts)if(receipt.provenance?.format==='qb-cloud-receipt-v1'&&receipt.provenance.mutation?.mutationId===member.originalMutation.mutationId&&['accepted','duplicate'].includes(receipt.provenance.receipt?.status))throw syncError('STAR_GROUP_ACCEPTED_MEMBER');
  return {format:'qb-star-conflict-group-view-v1',owner,entityKey,members:pending,localState,streamRow,seqRow,epochRow,cursorRow,entityReceipt,sourceReceipt};
}
async function verifyGroup(group){
  if(!exact(group,'format,owner,entityKey,members,localState,streamRow,seqRow,epochRow,cursorRow,entityReceipt,sourceReceipt')||group.format!=='qb-star-conflict-group-view-v1')throw syncError('STAR_GROUP_ORIGIN_CORRUPT');
  const owner=snapshotOwner(group.owner);if(owner.ownerKind!=='account'||!Array.isArray(group.members)||!group.members.length)throw syncError('STAR_GROUP_ORIGIN_CORRUPT');
  const state={meta:[group.streamRow,group.seqRow,group.epochRow,...(group.cursorRow?[group.cursorRow]:[])],mutations:[],outbox:[],conflicts:[],user_state:[group.localState],import_receipts:[group.entityReceipt,group.sourceReceipt]};
  for(const m of group.members){if(!exact(m,'originalMutation,originalRecord,outbox,conflict'))throw syncError('STAR_GROUP_ORIGIN_CORRUPT');star(m.originalMutation);validateMutationRecord(m.originalRecord);if(!eq(mutationWire(m.originalRecord),m.originalMutation)||!await verifyMutationDigest(m.originalMutation)||m.outbox.mutationId!==m.originalMutation.mutationId)throw syncError('STAR_GROUP_ORIGIN_CORRUPT');state.mutations.push(m.originalRecord);state.outbox.push(m.outbox);if(m.conflict)state.conflicts.push(m.conflict);}
  const projected=projectStarConflictGroup(state,owner,group.entityKey);if(!eq(projected,group))throw syncError('STAR_GROUP_ORIGIN_CORRUPT');
  await validateSyncChangeReceipt(group.sourceReceipt);return group;
}
export async function validateStarGroupResolutionReceipt(input){
  const row=capture(input);validateImportReceiptRecord(row);const p=row.provenance;
  if(!exact(p,'format,commandId,choice,generation,logEpoch,groupDigest,group,sourceChange,newMutationId')||p.format!==STAR_GROUP_FORMAT||!isUuid(p.commandId)||p.newMutationId!==p.commandId||!isUuid(p.generation)||!isUuid(p.logEpoch)||!['local','cloud'].includes(p.choice)||!digest(p.groupDigest)||row.sourceId!==STAR_GROUP_FORMAT||row.sourceRecordId!==p.commandId)throw syncError('STAR_GROUP_ORIGIN_CORRUPT');
  await verifyGroup(p.group);
  if(p.group.members.some(member=>member.originalMutation.mutationId===p.commandId))throw syncError('STAR_GROUP_ORIGIN_CORRUPT');
  if(p.generation!==p.group.owner.accountGeneration||p.logEpoch!==p.group.epochRow.value||!eq(p.sourceChange,p.group.sourceReceipt.provenance.change)||await sha256Hex(canonicalBytes(p.group))!==p.groupDigest)throw syncError('STAR_GROUP_ORIGIN_CORRUPT');return row;
}
export async function viewStarConflictGroup(value){
  const input=capture(value);if(!exact(input,'state,owner,entityKey'))throw syncError('INVALID_INPUT');const group=projectStarConflictGroup(input.state,input.owner,input.entityKey);await verifyGroup(group);
  return {entityKey:group.entityKey,questionKey:group.localState.questionKey,available:true,pendingCount:group.members.length,openConflictCount:group.members.filter(m=>m.conflict).length,localValue:group.localState.value,cloudValue:group.sourceReceipt.provenance.change.payload.value,expectedCloudDigest:group.sourceReceipt.provenance.change.payloadDigest,expectedCloudRevision:group.sourceReceipt.provenance.change.serverRevision,groupDigest:await sha256Hex(canonicalBytes(group))};
}
export async function prepareStarConflictGroupResolution(value){
  const input=capture(value);if(!exact(input,'state,owner,commandId,entityKey,groupDigest,choice,nowMs')||!isUuid(input.commandId)||!digest(input.groupDigest)||!['local','cloud'].includes(input.choice)||!Number.isSafeInteger(input.nowMs)||input.nowMs<0)throw syncError('INVALID_INPUT');
  const owner=snapshotOwner(input.owner),state=input.state;validateState(state);
  const old=state.import_receipts.find(r=>r.sourceId===STAR_GROUP_FORMAT&&r.sourceRecordId===input.commandId);
  if(old){const p=(await validateStarGroupResolutionReceipt(old)).provenance,created=state.mutations.find(r=>r.mutationId===input.commandId);if(!eq(p.group.owner,owner)||p.generation!==owner.accountGeneration||p.logEpoch!==state.meta.find(r=>r.key==='serverLogEpoch')?.value||p.groupDigest!==input.groupDigest||p.choice!==input.choice||p.group.entityKey!==input.entityKey||!created||created.accountGeneration!==owner.accountGeneration||created.clientStreamId!==p.group.streamRow.value||created.clientSeq!==p.group.seqRow.value+1||created.kind!=='user_state'||created.entityKey!==input.entityKey||created.payload.baseRevision!==p.sourceChange.serverRevision||created.payload.value!==(p.choice==='local'?p.group.localState.value:p.sourceChange.payload.value)||!await verifyMutationDigest(mutationWire(created)))throw syncError('COMMAND_ID_CONFLICT');for(const member of p.group.members){const original=state.mutations.find(r=>r.mutationId===member.originalMutation.mutationId),conflict=state.conflicts.find(r=>r.conflictId===member.originalMutation.mutationId);if(!original||!eq(original,member.originalRecord)||state.outbox.some(r=>r.mutationId===member.originalMutation.mutationId)||!eq(conflict||null,member.conflict?{...member.conflict,status:'resolved'}:null))throw syncError('COMMAND_ID_CONFLICT');}return {duplicate:true,mutation:created,receipt:old};}
  if(state.mutations.some(r=>r.mutationId===input.commandId))throw syncError('COMMAND_ID_CONFLICT');
  const group=projectStarConflictGroup(state,owner,input.entityKey);await verifyGroup(group);const groupDigest=await sha256Hex(canonicalBytes(group));if(groupDigest!==input.groupDigest)throw syncError('STAR_GROUP_VIEW_STALE');
  const sourceChange=group.sourceReceipt.provenance.change,selected=input.choice==='local'?group.localState.value:sourceChange.payload.value;
  const receipt=await validateStarGroupResolutionReceipt({sourceId:STAR_GROUP_FORMAT,sourceRecordId:input.commandId,importedAt:input.nowMs,provenance:{format:STAR_GROUP_FORMAT,commandId:input.commandId,choice:input.choice,generation:owner.accountGeneration,logEpoch:group.epochRow.value,groupDigest,group,sourceChange,newMutationId:input.commandId}});
  const conditions=[{store:'user_state',key:[group.localState.questionKey,'starred'],expected:group.localState},{store:'import_receipts',key:[group.entityReceipt.sourceId,group.entityReceipt.sourceRecordId],expected:group.entityReceipt},{store:'import_receipts',key:[group.sourceReceipt.sourceId,group.sourceReceipt.sourceRecordId],expected:group.sourceReceipt},{store:'import_receipts',key:[STAR_GROUP_FORMAT,input.commandId],expected:undefined}];
  for(const row of [group.streamRow,group.seqRow,group.epochRow,group.cursorRow])conditions.push({store:'meta',key:row.key,expected:row});
  for(const member of group.members)conditions.push({store:'mutations',key:member.originalMutation.mutationId,expected:member.originalRecord},{store:'outbox',key:member.originalMutation.mutationId,expected:member.outbox},{store:'conflicts',key:member.originalMutation.mutationId,expected:member.conflict||undefined});
  return {duplicate:false,group,mutationDraft:{protocolVersion:2,mutationId:input.commandId,kind:'user_state',entityKey:input.entityKey,payload:{schemaVersion:1,questionKey:group.localState.questionKey,field:'starred',value:selected,baseRevision:sourceChange.serverRevision}},records:[{store:'user_state',value:{questionKey:group.localState.questionKey,field:'starred',value:selected,starredKey:selected?1:0,serverRevision:sourceChange.serverRevision}},...group.members.filter(m=>m.conflict).map(m=>({store:'conflicts',value:{...m.conflict,status:'resolved'}})),{store:'import_receipts',value:receipt}],conditions,withdrawOutboxes:group.members.map(m=>({mutationId:m.originalMutation.mutationId,expected:m.outbox}))};
}
