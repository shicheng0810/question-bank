import {snapshotOwner} from '../profiles/control-schema.js';
import {rebuildSnapshotContinuationReceipt,assertSnapshotContinuationReceipt,deriveSnapshotContinuationCommandId} from '../../domain/app-data/snapshot-continuation.js';
import {createSnapshotBaselineReader} from '../history/snapshot-baseline-proof.js';
import { APP_DATA_STORES, canonicalBytes, canonicalContentBytes, sha256Hex, validatePullPage, validateChunkManifest, validateContentReference, validateStoreRecord, validateResumeDependencies, validateHistorySnapshotBinding } from '../../domain/app-data/index.js';
import { validateBankContent } from '../../domain/question/bank-content.js';
import { validateSyncChangeReceipt, validateSyncReceipt, syncError } from './protocol.js';
import { validateBundle } from '../../domain/attempt/commands.js';
import { loadHistoricalResumeProof } from './resume-proof.js';
import { resolveImmutableBank } from '../history/immutable-bank-resolver.js';

const keyFor=(store,row)=>{const path=APP_DATA_STORES[store].keyPath;return Array.isArray(path)?path.map(key=>row[key]):row[path];};
const eq=(a,b)=>new TextDecoder().decode(canonicalBytes(a))===new TextDecoder().decode(canonicalBytes(b));
const atOrBefore=(left,right)=>left.length<right.length||left.length===right.length&&left<=right;

/** Actual persisted receipts are source facts, not a caller's verification bit.
 * Missing matching resume is an incomplete live projection, not Synced. */
export async function pendingResumeSources(facts,owner,logEpoch){
  const pending=new Set(),sources=[];
  for(const row of facts.import_receipts){
    if(row.provenance?.format!=='qb-sync-change-v1')continue;
    const receipt=await validateSyncChangeReceipt(row),p=receipt.provenance;
    if(p.generation!==owner.accountGeneration||p.logEpoch!==logEpoch)throw syncError('OWNER_MISMATCH');
    sources.push(p.change);
  }
  for(const change of sources){
    if(change.kind!=='answer_event')continue;
    const event=change.payload.event;
    if(facts.entity_tombstones.some(t=>t.entityKind==='attempt'&&t.entityId===event.attemptId&&t.status==='confirmed'))continue;
    const actual=facts.answer_events.find(e=>e.eventId===event.eventId);
    if(actual&&!eq(actual,event))throw syncError('SYNC_EVENT_DIVERGENCE');
    const attempt=facts.attempts.find(a=>a.attemptId===event.attemptId);
    const matching=sources.some(source=>source.kind==='resume_state'&&source.payload.attemptId===event.attemptId&&source.payload.writerStreamId===event.writerStreamId&&source.payload.localRevision===attempt?.localRevision&&atOrBefore(change.serverSeq,source.serverSeq));
    if(!actual||!matching||!attempt||facts.answer_events.filter(e=>e.attemptId===event.attemptId).length!==attempt.actionSeq)pending.add(event.attemptId);
  }
  return {awaitingResume:pending.size>0,awaitingResumeAttempts:pending.size};
}

/** Prepare hashes and dependency proof outside native IDB. Application uses
 * a consistent facts cut and a fenced transaction; no synthetic local mutation.
 */
export async function applyPullPage(authority,input) {
  if(!input||Object.getPrototypeOf(input)!==Object.prototype||Reflect.ownKeys(input).some(key=>typeof key!=='string'||!Object.hasOwn(Object.getOwnPropertyDescriptor(input,key),'value')))throw syncError('INVALID_INPUT');
  canonicalBytes(input.context);canonicalBytes(input.request);canonicalBytes(input.response);
  const context=structuredClone(input.context),request=structuredClone(input.request),response=structuredClone(input.response);
  validatePullPage(response,request);
  if(response.generation!==context.owner.accountGeneration||response.logEpoch!==context.logEpoch)throw syncError('OWNER_MISMATCH');
  if(!(input.verifiedContents instanceof Map))throw syncError('INVALID_INPUT');
  const contents=new Map();
  for(const [digest,entry] of input.verifiedContents){
    if(!entry||Object.getPrototypeOf(entry)!==Object.prototype||Reflect.ownKeys(entry).some(key=>typeof key!=='string'||!Object.hasOwn(Object.getOwnPropertyDescriptor(entry,key),'value')))throw syncError('INVALID_INPUT');
    canonicalBytes(entry.reference);canonicalBytes(entry.manifest);
    validateContentReference(entry.reference);validateChunkManifest(entry.manifest);
    validateStoreRecord('content_chunks',{contentDigest:digest,chunkIndex:0,bytes:entry.bytes.length<=512*1024?entry.bytes:entry.bytes.slice(0,512*1024)});
    const owned={reference:structuredClone(entry.reference),manifest:structuredClone(entry.manifest),bytes:entry.bytes.slice()};
    contents.set(digest,owned);
  }
  for(const [digest,owned] of contents){
    if(digest!==owned.reference.contentDigest||owned.manifest.contentDigest!==digest||owned.bytes.length!==owned.reference.totalBytes||owned.manifest.totalBytes!==owned.bytes.length||owned.manifest.chunkCount!==owned.reference.chunkCount||await sha256Hex(owned.bytes)!==digest||await sha256Hex(canonicalBytes(owned.manifest))!==owned.reference.manifestDigest)throw syncError('SYNC_CONTENT_DIGEST');
    let offset=0;for(const chunk of owned.manifest.chunks){const bytes=owned.bytes.slice(offset,offset+chunk.byteLength);if(bytes.length!==chunk.byteLength||await sha256Hex(bytes)!==chunk.sha256)throw syncError('SYNC_CONTENT_DIGEST');offset+=chunk.byteLength;}
    if(offset!==owned.bytes.length)throw syncError('SYNC_CONTENT_DIGEST');
  }
  const facts=await authority.readFacts(),before=structuredClone(facts),records=[],deletes=[],resumed=new Set(),changedAttempts=new Set();
  const pendingIds=new Set(facts.outbox.map(row=>row.mutationId)),pending=facts.mutations.filter(row=>pendingIds.has(row.mutationId));
  function put(store,value){validateStoreRecord(store,value);const key=keyFor(store,value),index=facts[store].findIndex(row=>eq(keyFor(store,row),key));if(index>=0)facts[store][index]=value;else facts[store].push(value);records.push({store,value});}
  function remove(store,predicate){for(const row of facts[store].filter(predicate))deletes.push({store,key:keyFor(store,row)});facts[store]=facts[store].filter(row=>!predicate(row));for(let index=records.length-1;index>=0;index--)if(records[index].store===store&&predicate(records[index].value))records.splice(index,1);}
  function content(reference){const entry=contents.get(reference.contentDigest);if(!entry||!eq(entry.reference,reference))throw syncError('MISSING_CONTENT');return entry;}
  function parsed(entry){return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(entry.bytes));}
  async function historicalContent(payload){
    const raw=facts.content_chunks.find(row=>row.contentDigest===payload.chunkManifestDigest&&row.chunkIndex===0)?.bytes;
    if(!raw||await sha256Hex(raw)!==payload.chunkManifestDigest)throw syncError('MISSING_CONTENT');
    const manifest=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));validateChunkManifest(manifest);
    if(manifest.contentDigest!==payload.contentDigest)throw syncError('SYNC_CONTENT_DIGEST');
    const bytes=new Uint8Array(manifest.totalBytes);let offset=0;
    for(const item of manifest.chunks){const chunk=facts.content_chunks.find(row=>row.contentDigest===payload.contentDigest&&row.chunkIndex===item.chunkIndex)?.bytes;if(!chunk||chunk.length!==item.byteLength||await sha256Hex(chunk)!==item.sha256)throw syncError('MISSING_CONTENT');bytes.set(chunk,offset);offset+=chunk.length;}
    if(offset!==manifest.totalBytes||await sha256Hex(bytes)!==payload.contentDigest)throw syncError('SYNC_CONTENT_DIGEST');
    return {reference:{contentDigest:payload.contentDigest,manifestDigest:payload.chunkManifestDigest,chunkCount:manifest.chunkCount,totalBytes:manifest.totalBytes},manifest,value:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))};
  }
  for(const entry of contents.values()){
    let offset=0;for(const chunk of entry.manifest.chunks){put('content_chunks',{contentDigest:entry.reference.contentDigest,chunkIndex:chunk.chunkIndex,bytes:entry.bytes.slice(offset,offset+chunk.byteLength)});offset+=chunk.byteLength;}
    put('content_chunks',{contentDigest:entry.reference.manifestDigest,chunkIndex:0,bytes:canonicalBytes(entry.manifest)});
  }
  for(const change of response.changes){
    const receipt=await validateSyncChangeReceipt({sourceId:`qb-sync-v2:${response.generation}:${response.logEpoch}`,sourceRecordId:`change:${change.serverSeq}`,importedAt:Date.now(),provenance:{format:'qb-sync-change-v1',generation:response.generation,logEpoch:response.logEpoch,change}});
    const existingSource=facts.import_receipts.find(row=>row.sourceId===receipt.sourceId&&row.sourceRecordId===receipt.sourceRecordId);
    if(existingSource){const actual=await validateSyncChangeReceipt(existingSource);if(!eq(actual.provenance,receipt.provenance))throw syncError('SYNC_CHANGE_DIVERGENCE');}
    else put('import_receipts',receipt);
    const p=change.payload;
    if(change.serverRevision!==undefined){const entity={sourceId:receipt.sourceId,sourceRecordId:`entity:${change.kind}:${change.entityKey}`,importedAt:receipt.importedAt,provenance:{format:'qb-sync-entity-v1',kind:change.kind,entityKey:change.entityKey,serverRevision:change.serverRevision,payloadDigest:change.payloadDigest,generation:response.generation,logEpoch:response.logEpoch}};validateSyncReceipt(entity);const prior=facts.import_receipts.find(row=>row.sourceId===entity.sourceId&&row.sourceRecordId===entity.sourceRecordId);if(prior)validateSyncReceipt(prior);if(!prior||prior.provenance.serverRevision<change.serverRevision)put('import_receipts',entity);else if(prior.provenance.serverRevision===change.serverRevision&&prior.provenance.payloadDigest!==change.payloadDigest)throw syncError('SYNC_RECEIPT_DIVERGENCE');}
    const locallyPending=pending.some(row=>row.kind===change.kind&&row.entityKey===change.entityKey);
    if(change.kind==='content_manifest'){content(p.reference);continue;}
    if(change.kind==='entity_tombstone'){
      put('entity_tombstones',{entityKey:change.entityKey,entityKind:p.entityKind,entityId:p.entityId,status:'confirmed',accountGeneration:response.generation,serverSeq:change.serverSeq});
      if(p.entityKind==='attempt'){for(const store of ['attempts','attempt_scope','drafts','answer_events'])remove(store,row=>row.attemptId===p.entityId);}else if(p.entityKind==='history_snapshot')remove('history_snapshots',row=>row.snapshotId===p.entityId);else remove('bank_revisions',row=>row.bankUid===p.entityId);
      continue;
    }
    const entity=p.snapshotId?`history_snapshot:${p.snapshotId}`:p.attemptId?`attempt:${p.attemptId}`:p.bankUid?`bank:${p.bankUid}`:null;
    if(p.attemptId)changedAttempts.add(p.attemptId);if(p.event)changedAttempts.add(p.event.attemptId);
    if(entity&&facts.entity_tombstones.some(row=>row.entityKey===entity))throw syncError('SYNC_ENTITY_TOMBSTONED');
    if(change.kind==='history_snapshot'){
      const body=parsed(content(p.reference));await validateHistorySnapshotBinding(p,body,{accountGeneration:response.generation});
      const old=facts.history_snapshots.find(row=>row.snapshotId===p.snapshotId);
      if(old&&!eq(old,p))throw syncError('SYNC_HISTORY_DIVERGENCE');
      put('history_snapshots',p);
    }else if(change.kind==='bank_revision'){
      const reference=p.contentManifest.reference||[...contents.values()].find(entry=>entry.reference.contentDigest===p.contentManifest.contentDigest)?.reference;
      if(!reference)throw syncError('MISSING_CONTENT');const entry=content(reference);
      if(p.contentManifest.kind!=='protected_cipher'){const body=await validateBankContent(parsed(entry));if(body.content.bankUid!==p.bankUid||body.contentDigest!==p.revision||!eq(body.content.metadata,p.metadata))throw syncError('SYNC_BANK_BINDING');}
      put('bank_revisions',{bankUid:p.bankUid,revision:p.revision,metadata:p.metadata,contentManifest:p.contentManifest});
    }else if(change.kind==='attempt_manifest'){
      if(locallyPending)continue;
      const old=facts.attempts.find(row=>row.attemptId===p.attemptId);
      put('attempts',{attemptId:p.attemptId,status:p.status,startedAt:p.startedAt,scopeDigest:p.scopeDigest,scopeCount:p.scopeCount,writerStreamId:p.writerStreamId,position:old?.position??0,effectiveElapsedMs:old?.effectiveElapsedMs??0,localRevision:old?.localRevision??1,actionSeq:old?.actionSeq??0,...(p.parentAttemptId?{parentAttemptId:p.parentAttemptId}:{})});
    }else if(change.kind==='attempt_scope'){
      const scope=parsed(content(p.reference));if(await sha256Hex(canonicalContentBytes(scope))!==p.scopeDigest)throw syncError('SYNC_SCOPE_DIGEST');
      for(const row of scope)put('attempt_scope',row);
    }else if(change.kind==='answer_event'){
      const old=facts.answer_events.find(row=>row.eventId===p.event.eventId);if(old&&!eq(old,p.event))throw syncError('SYNC_EVENT_DIVERGENCE');
      for(const row of facts.import_receipts)if(row.provenance?.format==='qb-sync-change-v1'){
        const source=await validateSyncChangeReceipt(row);
        if(source.provenance.change.kind==='answer_event'&&source.provenance.change.payload.event.eventId===p.event.eventId&&!eq(source.provenance.change.payload.event,p.event))throw syncError('SYNC_EVENT_DIVERGENCE');
      }
      // The authenticated receipt above is durable. Exposing this event before
      // its resume would create an invalid live actionSeq/draft bundle across
      // legal page boundaries. Materialize only with that exact resume proof.
    }else if(change.kind==='user_state'){
      if(!locallyPending)put('user_state',{questionKey:p.questionKey,field:p.field,value:p.value,starredKey:p.value?1:0,serverRevision:change.serverRevision});
    }else if(change.kind==='resume_state'){
      if(locallyPending)continue;
      const entry=contents.get(p.contentDigest);if(!entry||entry.reference.manifestDigest!==p.chunkManifestDigest)throw syncError('MISSING_CONTENT');
      const state=parsed(entry),attempt=facts.attempts.find(row=>row.attemptId===p.attemptId);if(!attempt)throw syncError('MISSING_ATTEMPT');
      if(attempt.writerStreamId===p.writerStreamId&&p.localRevision<attempt.localRevision)continue;
      const references=[],candidateEvents=[...facts.answer_events];
      for(const row of facts.import_receipts)if(row.provenance?.format==='qb-sync-change-v1'){
        const source=await validateSyncChangeReceipt(row),provenance=source.provenance;
        if(provenance.generation!==response.generation||provenance.logEpoch!==response.logEpoch)throw syncError('OWNER_MISMATCH');
        if(!atOrBefore(provenance.change.serverSeq,change.serverSeq))continue;
        references.push(provenance.change);
        if(provenance.change.kind==='answer_event'){
          const event=provenance.change.payload.event,old=candidateEvents.find(row=>row.eventId===event.eventId);
          if(old&&!eq(old,event))throw syncError('SYNC_EVENT_DIVERGENCE');
          if(!old)candidateEvents.push(event);
        }
      }
      // Root reference is the actual current receipt, never a same-digest
      // future source. All parent/event references are actual same-epoch cut.
      references.sort((a,b)=>a.serverSeq===change.serverSeq?-1:b.serverSeq===change.serverSeq?1:0);
      const readSnapshotBaseline=createSnapshotBaselineReader({owner:snapshotOwner({ownerKind:'account',accountId:context.owner.accountId,accountGeneration:context.owner.accountGeneration}),references,
        readSnapshotRecord:async id=>facts.history_snapshots.find(row=>row.snapshotId===id),
        readTombstone:async key=>facts.entity_tombstones.find(row=>row.entityKey===key),
        readBankRevision:async(uid,revision)=>facts.bank_revisions.find(row=>row.bankUid===uid&&row.revision===revision),
        readContent:async ref=>{const loaded=await historicalContent({contentDigest:ref.contentDigest,chunkManifestDigest:ref.manifestDigest});if(!eq(loaded.reference,ref))throw syncError('SYNC_CONTENT_DIGEST');return loaded;}});
      const historical=await loadHistoricalResumeProof({references,attempts:facts.attempts,events:candidateEvents,contentDigest:p.contentDigest,readResumeContent:historicalContent,readSnapshotBaseline});
      const events=candidateEvents.filter(row=>row.attemptId===p.attemptId),proof=await validateResumeDependencies(state,p,entry.manifest,events,{attemptId:attempt.attemptId,writerStreamId:attempt.writerStreamId,scopeDigest:attempt.scopeDigest,scopeCount:attempt.scopeCount,...(attempt.parentAttemptId?{parentAttemptId:attempt.parentAttemptId}:{})},{parents:historical.parents,snapshotProofs:historical.snapshotProofs});
      if(proof.status!=='payload_verified')throw syncError('MISSING_RESUME_DEPENDENCY');
      if(state.snapshotBaseline){const key=state.snapshotBaseline.continuationKey,old=facts.import_receipts.find(row=>row.sourceId==='qb-snapshot-continuation-receipt-v1'&&row.sourceRecordId===key),commandId=await deriveSnapshotContinuationCommandId(key);
        if(old)await assertSnapshotContinuationReceipt(old,state.snapshotBaseline,{attemptId:p.attemptId,commandId});
        else put('import_receipts',await rebuildSnapshotContinuationReceipt(historical.snapshotProofs.find(row=>row.baseline.continuationKey===key),{attemptId:p.attemptId,importedAt:Date.now()}));}

      for(const event of events)put('answer_events',event);
      remove('drafts',row=>row.attemptId===p.attemptId);
      for(const draft of state.questionDrafts)put('drafts',{...draft,attemptId:p.attemptId,writerStreamId:p.writerStreamId,fence:1,dirty:false});
      put('attempts',{...attempt,localRevision:p.localRevision,position:state.position,effectiveElapsedMs:state.effectiveElapsedMs,actionSeq:events.length});
      resumed.add(p.attemptId);
    }
  }
  const historyBanks=new Map();
  for(const change of response.changes.filter(row=>row.kind==='history_snapshot')){
    const body=parsed(content(change.payload.reference));
    for(const row of body.scope)for(const ref of row.equivalentSourceRefs){
      const uid=ref.questionKey.split('/')[0],key=uid+':'+ref.bankRevision;
      if(!historyBanks.has(key))historyBanks.set(key,resolveImmutableBank({bankUid:uid,bankRevision:ref.bankRevision,
        readBankRevision:async()=>facts.bank_revisions.find(bank=>bank.bankUid===uid&&bank.revision===ref.bankRevision)||null,
        sourceChanges:async()=>[...facts.mutations,...facts.import_receipts,...response.changes].filter(raw=>{const source=raw.provenance?.format==='qb-sync-change-v1'?raw.provenance.change:raw;return source?.kind==='bank_revision'&&source.payload?.bankUid===uid&&source.payload?.revision===ref.bankRevision||source?.kind==='content_manifest'&&source.payload?.reference?.contentDigest===ref.bankRevision;}),
        readContent:async reference=>{const entry=contents.get(reference.contentDigest);if(entry){if(!eq(entry.reference,reference))throw syncError('SYNC_CONTENT_DIGEST');return parsed(entry);}const restored=await historicalContent({contentDigest:reference.contentDigest,chunkManifestDigest:reference.manifestDigest});if(!eq(restored.reference,reference))throw syncError('SYNC_CONTENT_DIGEST');return restored.value;}
      }));
      const checked=await historyBanks.get(key);
      if(!checked.questionRefs.some(q=>q.questionKey===ref.questionKey&&q.questionRevision===ref.questionRevision))throw syncError('HISTORY_QUESTION_DEPENDENCY');
    }
  }
  for(const attempt of facts.attempts){const scope=facts.attempt_scope.filter(row=>row.attemptId===attempt.attemptId).sort((a,b)=>a.ordinal-b.ordinal);if(resumed.has(attempt.attemptId)||!changedAttempts.has(attempt.attemptId)&&scope.length===attempt.scopeCount)validateBundle({attempt,scope,drafts:facts.drafts.filter(row=>row.attemptId===attempt.attemptId),events:facts.answer_events.filter(row=>row.attemptId===attempt.attemptId)});}
  const conditions=[{store:'meta',key:'clientSeq',expected:before.meta.find(row=>row.key==='clientSeq')}];
  for(const store of ['attempts','attempt_scope','drafts','answer_events','user_state','entity_tombstones','import_receipts','history_snapshots'])for(const row of before[store])conditions.push({store,key:keyFor(store,row),expected:row});
  return authority.commitPullFacts({context,records,deletes,conditions,nextCursor:response.nextCursor,applied:response.changes.length});
}
