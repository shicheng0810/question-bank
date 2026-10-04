import {APP_DATA_STORES,canonicalBytes,validateStoreRecord} from '../../domain/app-data/index.js';
import {ownedWriteInput} from '../idb/write-input.js';
import {mutationWire} from '../sync/protocol.js';
import {cloudError,validateCloudReceipt} from './metadata.js';

const key=(name,row)=>JSON.stringify(Array.isArray(APP_DATA_STORES[name].keyPath)?APP_DATA_STORES[name].keyPath.map(field=>row[field]):row[APP_DATA_STORES[name].keyPath]);
const same=(name,a,b)=>name==='content_chunks'?a.bytes.length===b.bytes.length&&a.bytes.every((byte,index)=>byte===b.bytes[index]):new TextDecoder().decode(canonicalBytes(a))===new TextDecoder().decode(canonicalBytes(b));
/** The final cut is captured while holding the actual exclusive profile lock.
 * No original wire, original event grade, or uncertain intent is regenerated.
 */
export async function mergeCloudRecoveryCut(local,cloud,{generation,logEpoch,cut}){
  const snapshot=ownedWriteInput(cloud),current=ownedWriteInput(local);
  for(const name of Object.keys(APP_DATA_STORES)){if(!Array.isArray(snapshot[name])||!Array.isArray(current[name]))throw cloudError('CLOUD_STORE_SET');for(const row of [...snapshot[name],...current[name]])validateStoreRecord(name,row);}
  const receipts=new Map();for(const row of snapshot.import_receipts)if(row.provenance?.format==='qb-cloud-receipt-v1'){const receipt=await validateCloudReceipt(row,{generation,logEpoch,cut});if(receipts.has(receipt.sourceRecordId))throw cloudError('CLOUD_RECEIPT_DUPLICATE');receipts.set(receipt.sourceRecordId,receipt);}
  const pending=current.mutations.filter(row=>current.outbox.some(item=>item.mutationId===row.mutationId));
  const pendingAttempts=new Set(pending.map(row=>row.payload.attemptId||row.payload.event?.attemptId).filter(Boolean));
  const pendingStars=new Set(pending.filter(row=>row.kind==='user_state').map(row=>row.payload.questionKey));
  const deadBanks=new Set(snapshot.entity_tombstones.filter(row=>row.entityKind==='bank').map(row=>row.entityId));
  const deadAttempts=new Set(snapshot.entity_tombstones.filter(row=>row.entityKind==='attempt').map(row=>row.entityId));
  const deadHistorySnapshots=new Set(snapshot.entity_tombstones.filter(row=>row.entityKind==='history_snapshot').map(row=>row.entityId));
  // Bank retirement is not authority to erase learner attempt/grade history.
  // Historical typed content remains proof until the separately approved
  // physical-purge/live-reference policy exists.
  const preserved=new Set([...pendingAttempts,...current.attempts.filter(row=>{if(deadAttempts.has(row.attemptId))return false;const remote=snapshot.attempts.find(other=>other.attemptId===row.attemptId);return !remote||remote.writerStreamId===row.writerStreamId&&remote.localRevision<row.localRevision;}).map(row=>row.attemptId)]);
  // Tombstones cannot silently discard a local pending command. Preserve the
  // original profile and quarantine until the user has an explicit resolution.
  for(const tombstone of snapshot.entity_tombstones)if(pending.some(row=>row.entityKey===tombstone.entityKey||tombstone.entityKind==='attempt'&&(row.payload.attemptId||row.payload.event?.attemptId)===tombstone.entityId||tombstone.entityKind==='bank'&&row.payload.bankUid===tombstone.entityId||tombstone.entityKind==='history_snapshot'&&row.payload.snapshotId===tombstone.entityId))throw cloudError('CLOUD_TOMBSTONE_PENDING_CONFLICT');
  if(pending.some(row=>row.kind==='user_state'&&deadBanks.has(row.payload.questionKey.split('/')[0])))throw cloudError('CLOUD_TOMBSTONE_PENDING_CONFLICT');
  if([...pendingAttempts].some(id=>deadAttempts.has(id)))throw cloudError('CLOUD_TOMBSTONE_PENDING_CONFLICT');
  if(current.attempts.some(row=>deadAttempts.has(row.attemptId)))throw cloudError('CLOUD_TOMBSTONE_LOCAL_CONFLICT');
  for(const name of ['attempts','attempt_scope','drafts','answer_events'])snapshot[name]=snapshot[name].filter(row=>!deadAttempts.has(row.attemptId));
  snapshot.bank_revisions=snapshot.bank_revisions.filter(row=>!deadBanks.has(row.bankUid));current.bank_revisions=current.bank_revisions.filter(row=>!deadBanks.has(row.bankUid));
  snapshot.history_snapshots=snapshot.history_snapshots.filter(row=>!deadHistorySnapshots.has(row.snapshotId));current.history_snapshots=current.history_snapshots.filter(row=>!deadHistorySnapshots.has(row.snapshotId));
  snapshot.user_state=snapshot.user_state.filter(row=>!deadBanks.has(row.questionKey.split('/')[0]));current.user_state=current.user_state.filter(row=>!deadBanks.has(row.questionKey.split('/')[0]));
  for(const name of Object.keys(APP_DATA_STORES)){
    if(name==='meta'){snapshot.meta=current.meta.filter(row=>!['syncCoordinatorLease','serverLogEpoch','appliedPullCursor','projectionVersion','projectionInvalidationRevision','projectionAppliedRevision'].includes(row.key));continue;}
    if(name==='writer_leases'){snapshot.writer_leases=[];continue;}
    if(['mutations','outbox','conflicts','legacy_raw','legacy_aggregates','migration_journal'].includes(name)){snapshot[name]=current[name];continue;}
    if(['attempts','attempt_scope','drafts','answer_events'].includes(name)){
      for(const id of preserved)if(snapshot.entity_tombstones.some(row=>row.entityKind==='attempt'&&row.entityId===id))throw cloudError('CLOUD_TOMBSTONE_LOCAL_CONFLICT');
      if(name!=='answer_events'){snapshot[name]=snapshot[name].filter(row=>!preserved.has(row.attemptId));snapshot[name].push(...current[name].filter(row=>preserved.has(row.attemptId)));continue;}
      // Immutable historical grades are unioned, never recomputed. Remote
      // attempt proof may include the same event, which must be exactly equal.
    }
    if(name==='user_state'){snapshot[name]=snapshot[name].filter(row=>!pendingStars.has(row.questionKey));snapshot[name].push(...current[name].filter(row=>pendingStars.has(row.questionKey)));continue;}
    const rows=new Map(snapshot[name].map(row=>[key(name,row),row]));
    for(const row of current[name]){const id=key(name,row),prior=rows.get(id);if(prior&&!same(name,prior,row)){
      if(name==='import_receipts'&&row.provenance?.format==='qb-sync-entity-v1'&&prior.provenance?.format==='qb-sync-entity-v1'){if(row.provenance.serverRevision>prior.provenance.serverRevision)rows.set(id,row);else if(row.provenance.serverRevision===prior.provenance.serverRevision&&row.provenance.payloadDigest!==prior.provenance.payloadDigest)throw cloudError('CLOUD_LOCAL_FACT_DIVERGENCE');continue;}
      if(name==='import_receipts'&&new TextDecoder().decode(canonicalBytes(row.provenance))===new TextDecoder().decode(canonicalBytes(prior.provenance))){rows.set(id,row);continue;}
      if(name==='entity_tombstones'&&prior.status==='confirmed'&&row.status==='pending')continue;
      throw cloudError('CLOUD_LOCAL_FACT_DIVERGENCE');
    }if(!prior)rows.set(id,row);}snapshot[name]=[...rows.values()];
  }
  const accepted=new Set();for(const mutation of current.mutations){const row=receipts.get(mutation.mutationId);if(!row)continue;const p=row.provenance;if(!same('mutations',mutationWire(mutation),p.mutation))throw cloudError('CLOUD_LOCAL_RECEIPT_MISMATCH');if(['accepted','duplicate'].includes(p.receipt.status))accepted.add(mutation.mutationId);else{const conflict={conflictId:mutation.mutationId,entityKey:mutation.entityKey,status:'open',mutation:p.mutation,...(p.receipt.currentRevision!==undefined?{currentRevision:p.receipt.currentRevision}:{})};validateStoreRecord('conflicts',conflict);const previous=snapshot.conflicts.find(item=>item.conflictId===conflict.conflictId);if(previous&&!same('conflicts',previous,conflict))throw cloudError('CLOUD_CONFLICT_DIVERGENCE');if(!previous)snapshot.conflicts.push(conflict);}}
  snapshot.outbox=snapshot.outbox.filter(row=>!accepted.has(row.mutationId));
  const invalidation=current.meta.find(row=>row.key==='projectionInvalidationRevision')?.value??0;if(invalidation===Number.MAX_SAFE_INTEGER)throw cloudError('REVISION_EXHAUSTED');
  snapshot.meta.push({key:'serverLogEpoch',value:logEpoch},{key:'appliedPullCursor',value:`v2.${generation}.${logEpoch}.${cut}`},{key:'projectionVersion',value:1},{key:'projectionInvalidationRevision',value:invalidation+1},{key:'projectionAppliedRevision',value:0});
  return snapshot;
}
