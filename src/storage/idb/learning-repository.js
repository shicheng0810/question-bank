import { canonicalBytes, canonicalContentBytes, sha256Hex, validateAttemptRecord, validateAttemptScope, validateContentReference, validateChunkManifest, validateResumeState, validateResumeDependencies, validateBankRevisionRecord, validateImportedHistorySnapshot, validateHistorySnapshotBinding } from '../../domain/app-data/index.js';
import { openB1bAuthority } from './learning-authority.js';
import { commandError, clone, equal, derivedId, manifestPayload, encodeContent, transition, resumeState, validateBundle, projectProgress } from '../../domain/attempt/commands.js';
import { validateBankContent, validateProtectedBankEnvelopeV2 } from '../../domain/question/bank-content.js';
import { deriveCasBaseline, validateSyncChangeReceipt } from '../sync/protocol.js';
import { applyPullPage } from '../sync/pull.js';
import {loadHistoricalResumeProof} from '../sync/resume-proof.js';
import {validateForkOriginReceipt,assertForkOriginProof} from '../sync/fork-origin.js';
import {prepareStarConflictResolution} from '../sync/star-resolution.js';
import {viewStarConflictGroup} from '../sync/star-group-resolution.js';
import {deriveContent} from '../../domain/question/content-identity.js';
import {frozenPublicBanks} from '../../domain/question/frozen-public-registry.js';
import { validateBrowserLearningExport, prepareBrowserLearningImport } from '../../browser/local-storage-migration.js';
import { createSnapshotBaselineReader } from '../history/snapshot-baseline-proof.js';
import { deriveSnapshotContinuationKey,deriveSnapshotContinuationCommandId,deriveSnapshotContinuationAttemptId,snapshotPrefillInput,rebuildSnapshotContinuationReceipt,assertSnapshotContinuationReceipt,assertSnapshotContinuationState } from '../../domain/app-data/index.js';
import { decodeCursor } from '../../domain/app-data/cursor.js';
import { resolveImmutableBank } from '../history/immutable-bank-resolver.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function commandSnapshot(value) {
  canonicalBytes(value); // Reject accessors/unknown JSON before cloning or awaiting.
  if (!UUID.test(value.commandId)) throw commandError('INVALID_COMMAND_ID');
  return clone(value);
}
const wire = (mutationId, kind, entityKey, payload) => ({ protocolVersion: 2, mutationId, kind, entityKey, payload });
const condition = (store, key, expected) => ({ store, key, expected });

/** Learning commands operate only on registered questionKey/revision scope.
 * A lease is acquired before create/each command. All facts and outbox intents
 * commit in the authority transaction; typed content is chunked, not a legacy snapshot.
 */
export async function openLearningRepository(options) {
  const authority = await openB1bAuthority(options);
  const owner = authority.snapshot().owner;
  const now = options.now || Date.now;
  let readonlyCatalog=null;
  const historyBankProofs=new Map();
  const historySnapshotProofs=new Map();
  async function readAttempt(attemptId) {
    const bundle = await authority.readAttempt(attemptId);
    if(!bundle.attempt)return null;
    const latest=(await learningReferences()).filter(row=>row.kind==='resume_state'&&row.payload.attemptId===attemptId&&row.payload.localRevision===bundle.attempt.localRevision)[0];
    if(latest){const state=(await readResumeContent(latest.payload)).value;validateResumeState(state);if(state.snapshotBaseline)bundle.snapshotBaseline=state.snapshotBaseline;}
    const historyView=bundle.attempt.parentAttemptId?await historyAncestry(attemptId):null;
    return {...validateBundle(bundle),progress:projectProgress(bundle.events),...(historyView?{historyView}:{})};
  }
  async function readVerifiedContent(value, { bytesOnly=false } = {}) {
    canonicalBytes(value);validateContentReference(value);const reference=clone(value);
    const manifestRow = await authority.readRecords('content_chunks', [reference.manifestDigest, 0]);
    if (!manifestRow || await sha256Hex(manifestRow.bytes) !== reference.manifestDigest) throw commandError('MISSING_CONTENT');
    const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestRow.bytes));
    validateChunkManifest(manifest);
    if (manifest.contentDigest !== reference.contentDigest || manifest.chunkCount !== reference.chunkCount || manifest.totalBytes !== reference.totalBytes) throw commandError('CORRUPT_CONTENT');
    const rows = await authority.readRecords('content_chunks', reference.contentDigest, 'contentDigest');
    if (rows.length !== manifest.chunkCount) throw commandError('MISSING_CONTENT');
    rows.sort((a, b) => a.chunkIndex - b.chunkIndex);
    const bytes = new Uint8Array(reference.totalBytes); let offset = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i], expected = manifest.chunks[i];
      if (row.chunkIndex !== i || row.bytes.length !== expected.byteLength || await sha256Hex(row.bytes) !== expected.sha256) throw commandError('CORRUPT_CONTENT');
      bytes.set(row.bytes, offset); offset += row.bytes.length;
    }
    if (await sha256Hex(bytes) !== reference.contentDigest) throw commandError('CORRUPT_CONTENT');
    return {reference,manifest,bytes,...(!bytesOnly?{value:JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))}:{})};
  }
  async function readContent(reference){return (await readVerifiedContent(reference)).value;}
  async function existingCommand(commandId) { return authority.readRecords('mutations', commandId); }
  async function learningReferences() {
    const local=await authority.readRecords('mutations'),receipts=await authority.readRecords('import_receipts'),changes=[];
    for(const receipt of receipts)if(receipt.provenance?.format==='qb-sync-change-v1')changes.push((await validateSyncChangeReceipt(receipt)).provenance.change);
    return [...local,...changes];
  }
  async function readResumeContent(payload){
    const row=await authority.readRecords('content_chunks',[payload.chunkManifestDigest,0]);
    if(!row||await sha256Hex(row.bytes)!==payload.chunkManifestDigest)throw commandError('MISSING_CONTENT');
    const manifest=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(row.bytes));validateChunkManifest(manifest);
    return readVerifiedContent({contentDigest:payload.contentDigest,manifestDigest:payload.chunkManifestDigest,chunkCount:manifest.chunkCount,totalBytes:manifest.totalBytes});
  }
  async function historicalProof(contentDigest,references=undefined){
    references=references||await learningReferences();
    return loadHistoricalResumeProof({readSnapshotBaseline:snapshotReader(references),references,attempts:await authority.readRecords('attempts'),events:await authority.readRecords('answer_events'),contentDigest,readResumeContent});
  }
  function snapshotReader(references,conditions=[]){
    return createSnapshotBaselineReader({owner,references,readContent,
      readSnapshotRecord:async id=>{const row=await authority.readRecords('history_snapshots',id);conditions.push(condition('history_snapshots',id,row));return row;},
      readBankRevision:async(uid,revision)=>{const row=await authority.readRecords('bank_revisions',[uid,revision]);conditions.push(condition('bank_revisions',[uid,revision],row));return row;},
      readTombstone:async key=>{const row=await authority.readRecords('entity_tombstones',key);conditions.push(condition('entity_tombstones',key,row));return row;}});
  }
  async function prepareSnapshotContinuation(snapshotId,{allowForeign=false}={}){
    const entry=await readHistorySnapshot(snapshotId);if(!entry)throw commandError('HISTORY_NOT_FOUND');
    const continuationKey=await deriveSnapshotContinuationKey(owner.accountGeneration,snapshotId,entry.record.reference.contentDigest);
    const snapshotBaseline={format:'qb-snapshot-baseline-v1',accountGeneration:owner.accountGeneration,snapshotId,snapshotReference:entry.record.reference,continuationKey};
    const conditions=[],proof=await snapshotReader(await learningReferences(),conditions)(snapshotBaseline);
    const commandId=await deriveSnapshotContinuationCommandId(continuationKey),attemptId=await deriveSnapshotContinuationAttemptId(continuationKey);
    const receipt=await authority.readRecords('import_receipts',['qb-snapshot-continuation-receipt-v1',continuationKey]);
    const existing=await resumeAttempt(attemptId);
    if(existing){if(!receipt)throw commandError('COMMAND_ORIGIN_UNAVAILABLE');await assertSnapshotContinuationReceipt(receipt,snapshotBaseline,{attemptId,commandId});if(!equal(existing.snapshotBaseline,snapshotBaseline))throw commandError('COMMAND_ID_CONFLICT');const stream=await authority.initializeStream();if(!allowForeign){if(existing.attempt.writerStreamId!==stream.clientStreamId)throw commandError('FORK_REQUIRED');if(existing.attempt.status!=='active')throw commandError('CONTINUATION_COMPLETED');}}
    else if(receipt)throw commandError('COMMAND_ORIGIN_UNAVAILABLE');
    return {entry,snapshotBaseline,proof,conditions,commandId,attemptId,existing};
  }
  async function authorizeSnapshotContinuation({isCurrent=()=>true}={}) {
    if(!isCurrent())throw commandError('STALE_REQUEST');
    if(owner.ownerKind!=='account'||typeof options.authorizeSnapshotInitialization!=='function')throw commandError('RESUME_CAPABILITY_UNAVAILABLE');
    await options.authorizeSnapshotInitialization({isCurrent});
    if(!isCurrent())throw commandError('STALE_REQUEST');
  }
  async function createSnapshotContinuation({snapshotId,attemptId,commandId,lease},{isCurrent=()=>true}={}){
    if(!isCurrent())throw commandError('STALE_REQUEST');
    // Re-verify after acquiring the lease, including a possible concurrent commit.
    const plan=await prepareSnapshotContinuation(snapshotId);if(!isCurrent())throw commandError('STALE_REQUEST');
    if(plan.attemptId!==attemptId||plan.commandId!==commandId||lease.attemptId!==attemptId)throw commandError('COMMAND_ID_CONFLICT');
    if(plan.existing)return {bundle:plan.existing,duplicate:true};
    await authorizeSnapshotContinuation({isCurrent});
    const stream=await authority.initializeStream(),stamp=now();
    const scope=plan.entry.body.scope.map((row,ordinal)=>({attemptId,ordinal,displayOrdinal:ordinal,questionKey:row.questionKey,questionRevision:row.questionRevision,equivalentSourceRefs:row.equivalentSourceRefs.map(({bankRevision,...ref})=>ref)}));
    const attempt={attemptId,status:'active',startedAt:stamp,scopeDigest:await sha256Hex(canonicalContentBytes(scope)),scopeCount:scope.length,position:Math.max(0,plan.entry.body.scope.findIndex(row=>!plan.entry.body.answers.find(a=>a.legacyQuestionId===row.legacyQuestionId)?.savedInput.submitted)),effectiveElapsedMs:0,localRevision:1,actionSeq:0,writerStreamId:stream.clientStreamId};
    const drafts=[];
    for(const answer of plan.entry.body.answers){const row=plan.entry.body.scope.find(r=>r.legacyQuestionId===answer.legacyQuestionId),loaded=await resolveHistorySnapshotQuestion({snapshotId,legacyQuestionId:row.legacyQuestionId});if(!isCurrent())throw commandError('STALE_REQUEST');drafts.push({attemptId,questionKey:row.questionKey,questionRevision:row.questionRevision,input:snapshotPrefillInput(answer.savedInput,loaded.question),submitted:false,showKeys:answer.savedInput.showKeys,assisted:answer.savedInput.showKeys,localRevision:1,dirty:false,writerStreamId:stream.clientStreamId,fence:lease.fence});}
    const bundle={attempt,scope,drafts,events:[],snapshotBaseline:plan.snapshotBaseline};validateBundle(bundle);assertSnapshotContinuationState(resumeState(bundle),plan.proof);
    const scopeContent=await encodeContent(scope),resumeContent=await encodeContent(resumeState(bundle));
    const receipt=await rebuildSnapshotContinuationReceipt(plan.proof,{attemptId,importedAt:stamp});await assertSnapshotContinuationReceipt(receipt,plan.snapshotBaseline,{attemptId,commandId});
    const manifestBase=await baseline('attempt_manifest',`attempt:${attemptId}`,stream.clientStreamId,0);
    if(!isCurrent())throw commandError('STALE_REQUEST');
    const outcome=await authority.commit({lease,conditions:[condition('attempts',attemptId,undefined),condition('entity_tombstones',`attempt:${attemptId}`,undefined),condition('import_receipts',[receipt.sourceId,receipt.sourceRecordId],undefined),...manifestBase.conditions,...plan.conditions],records:[{store:'attempts',value:attempt},...scope.map(value=>({store:'attempt_scope',value})),...drafts.map(value=>({store:'drafts',value})),{store:'import_receipts',value:receipt},...scopeContent.records,...resumeContent.records],mutationDrafts:[wire(commandId,'attempt_manifest',`attempt:${attemptId}`,manifestPayload(attempt,0)),wire(await derivedId(commandId,'scope'),'attempt_scope',`attempt:${attemptId}`,{schemaVersion:1,attemptId,scopeDigest:attempt.scopeDigest,reference:scopeContent.reference,baseRevision:0}),wire(await derivedId(commandId,'resume'),'resume_state',`attempt:${attemptId}`,{schemaVersion:1,attemptId,writerStreamId:stream.clientStreamId,contentDigest:resumeContent.reference.contentDigest,chunkManifestDigest:resumeContent.reference.manifestDigest,localRevision:1,baseRevision:0})]});
    return {bundle:await resumeAttempt(attemptId),duplicate:outcome.duplicate};
  }
  async function baseline(kind, entityKey, writerStreamId, supplied) {
    const state = await authority.readSyncState();
    const value = deriveCasBaseline(state, { owner, kind, entityKey, writerStreamId });
    if (supplied !== undefined && supplied !== value.baseRevision) throw commandError('CAS_BASELINE_MISMATCH');
    return value;
  }
  async function createAttempt(value, { isCurrent = () => true } = {}) {
    if (!isCurrent()) throw commandError('STALE_REQUEST');
    const input = commandSnapshot(value);
    const stream = await authority.initializeStream({ ...(input.nowMs===undefined?{}:{nowMs:input.nowMs}) });
    if (input.writerStreamId && input.writerStreamId !== stream.clientStreamId) throw commandError('WRITER_STREAM_MISMATCH');
    const previous = await existingCommand(input.commandId);
    const attemptId = input.attemptId || previous?.payload.attemptId || crypto.randomUUID();
    if (input.lease.attemptId !== attemptId) throw commandError('LEASE_ATTEMPT_MISMATCH');
    const scope = input.scope.map((row, ordinal) => ({ attemptId, ordinal, displayOrdinal: ordinal, questionKey: row.questionKey,
      questionRevision: row.questionRevision, equivalentSourceRefs: row.equivalentSourceRefs || [{ questionKey: row.questionKey, questionRevision: row.questionRevision }] }));
    validateAttemptScope(scope, attemptId, scope.length);
    const scopeDigest = await sha256Hex(canonicalContentBytes(scope));
    if (previous) {
      if (previous.kind !== 'attempt_manifest' || previous.payload.attemptId !== attemptId || previous.payload.scopeDigest !== scopeDigest || previous.payload.parentAttemptId !== input.parentAttemptId) throw commandError('COMMAND_ID_CONFLICT');
      if(input.parentAttemptId){
        const receipt=await authority.readRecords('import_receipts',['qb-fork-origin-v1',input.commandId]);if(!receipt)throw commandError('COMMAND_ORIGIN_UNAVAILABLE');const origin=validateForkOriginReceipt(receipt).provenance;
        if(origin.childAttemptId!==attemptId||origin.parentAttemptId!==input.parentAttemptId||input.parentResumeContentDigest&&origin.parentResumeContentDigest!==input.parentResumeContentDigest)throw commandError('COMMAND_ID_CONFLICT');
        const firstResume=await existingCommand(await derivedId(input.commandId,'resume'));if(!firstResume||firstResume.kind!=='resume_state'||firstResume.payload.attemptId!==attemptId||firstResume.payload.localRevision!==1)throw commandError('COMMAND_ORIGIN_UNAVAILABLE');
        const childProof=await historicalProof(firstResume.payload.contentDigest),parentProof=await historicalProof(origin.parentResumeContentDigest);
        assertForkOriginProof(origin,previous.payload,childProof,parentProof);
      }
      return { bundle: await readAttempt(attemptId), duplicate: true };
    }
    if(input.parentAttemptId&&await authority.readRecords('attempts',attemptId))throw commandError('COMMAND_ORIGIN_UNAVAILABLE');
    const stamp = input.nowMs ?? now();
    const attempt = { attemptId, status: 'active', startedAt: stamp, scopeDigest, scopeCount: scope.length, position: 0, effectiveElapsedMs: 0,
      localRevision: 1, actionSeq: 0, writerStreamId: stream.clientStreamId, ...(input.parentAttemptId ? { parentAttemptId: input.parentAttemptId } : {}) };
    validateAttemptRecord(attempt);
    let parent=null,parentProof=null,drafts=[],origin=null;
    if (input.parentAttemptId) {
      parent = await readAttempt(input.parentAttemptId);
      if (!parent) throw commandError('PARENT_ATTEMPT_NOT_FOUND');
      const references=await learningReferences(),reference=references.filter(row=>row.kind==='resume_state'&&row.payload.attemptId===input.parentAttemptId&&(!input.parentResumeContentDigest||row.payload.contentDigest===input.parentResumeContentDigest)).sort((a,b)=>b.payload.localRevision-a.payload.localRevision)[0];
      if(!reference)throw commandError('MISSING_RESUME_DEPENDENCY');
      parentProof=await historicalProof(reference.payload.contentDigest);
      origin=validateForkOriginReceipt({sourceId:'qb-fork-origin-v1',sourceRecordId:input.commandId,importedAt:stamp,provenance:{format:'qb-fork-origin-v1',parentAttemptId:input.parentAttemptId,parentResumeContentDigest:reference.payload.contentDigest,childAttemptId:attemptId,commandId:input.commandId}});
      if(parentProof.root.state.scope.length!==scope.length||scope.some((row,index)=>row.questionKey!==parentProof.root.state.scope[index].questionKey||row.questionRevision!==parentProof.root.state.scope[index].questionRevision||!equal(row.equivalentSourceRefs,parentProof.root.state.scope[index].equivalentSourceRefs)))throw commandError('FORK_SCOPE_MISMATCH');
      attempt.position=parentProof.root.state.position;attempt.effectiveElapsedMs=parentProof.root.state.effectiveElapsedMs;
      drafts=parentProof.root.state.questionDrafts.map(draft=>({...draft,attemptId,writerStreamId:stream.clientStreamId,localRevision:1,fence:input.lease.fence,dirty:false,inheritedFrom:{attemptId:input.parentAttemptId,resumeContentDigest:reference.payload.contentDigest}}));
    }
    const scopeContent = await encodeContent(scope);
    const bundle = { attempt, scope, drafts, events: [] };validateBundle(bundle);
    const resumeContent = await encodeContent(resumeState(bundle));
    if (!isCurrent()) throw commandError('STALE_REQUEST');
    const outcome = await authority.commit({ lease: input.lease, ...(input.nowMs===undefined?{}:{nowMs:input.nowMs}),
      conditions: [condition('attempts', attemptId, undefined),...(parent?[condition('attempts',parent.attempt.attemptId,parent.attempt),condition('entity_tombstones',`attempt:${parent.attempt.attemptId}`,undefined),condition('import_receipts',['qb-fork-origin-v1',input.commandId],undefined)]:[])],
      records: [{ store: 'attempts', value: attempt }, ...scope.map(row => ({ store: 'attempt_scope', value: row })),...drafts.map(value=>({store:'drafts',value})),...(origin?[{store:'import_receipts',value:origin}]:[]), ...scopeContent.records, ...resumeContent.records],
      mutationDrafts: [wire(input.commandId, 'attempt_manifest', `attempt:${attemptId}`, manifestPayload(attempt, 0)),
        wire(await derivedId(input.commandId, 'scope'), 'attempt_scope', `attempt:${attemptId}`, { schemaVersion: 1, attemptId, scopeDigest, reference: scopeContent.reference, baseRevision: 0 }),
        wire(await derivedId(input.commandId, 'resume'), 'resume_state', `attempt:${attemptId}`, { schemaVersion: 1, attemptId, writerStreamId: attempt.writerStreamId,
          contentDigest: resumeContent.reference.contentDigest, chunkManifestDigest: resumeContent.reference.manifestDigest, localRevision: 1, baseRevision: 0 })] });
    return { bundle: await readAttempt(attemptId), duplicate: outcome.duplicate };
  }
  async function forkAttempt(value, options){
    const input=commandSnapshot(value),parent=await readAttempt(input.parentAttemptId);
    if(!parent)throw commandError('PARENT_ATTEMPT_NOT_FOUND');
    return createAttempt({...input,scope:parent.scope.map(({questionKey,questionRevision,equivalentSourceRefs})=>({questionKey,questionRevision,equivalentSourceRefs}))}, options);
  }
  // The existing fork transaction persists the origin and the deterministic
  // command/child IDs together. No browser-only continuation pointer is needed.
  async function confirmedReferences() {
    if(owner.ownerKind!=='account')throw commandError('AWAITING_CLOUD_CONFIRMATION');
    const state=await authority.readSyncState(),cursorRow=state.meta.find(row=>row.key==='appliedPullCursor'),epoch=state.meta.find(row=>row.key==='serverLogEpoch')?.value;
    if(!cursorRow)throw commandError('AWAITING_CLOUD_CONFIRMATION');
    const cut=decodeCursor(cursorRow.value);
    if(cut.accountGeneration!==owner.accountGeneration||cut.logEpoch!==epoch)throw commandError('AWAITING_CLOUD_CONFIRMATION');
    const references=[];
    for(const receipt of state.receipts)if(receipt.provenance?.format==='qb-sync-change-v1'){
      const p=(await validateSyncChangeReceipt(receipt)).provenance;
      if(p.generation===cut.accountGeneration&&p.logEpoch===cut.logEpoch&&BigInt(p.change.serverSeq)<=BigInt(cut.serverSeq))references.push(p.change);
    }
    return references.sort((a,b)=>BigInt(a.serverSeq)<BigInt(b.serverSeq)?-1:1);
  }
  async function prepareHistoryContinuation(parentAttemptId,{cloudConfirmed=false}={}) {
    if(!UUID.test(parentAttemptId))throw commandError('INVALID_INPUT');
    if(await authority.readRecords('entity_tombstones',`attempt:${parentAttemptId}`))throw commandError('ATTEMPT_NOT_FOUND');
    const stream=await authority.initializeStream();
    const commandId=await derivedId(parentAttemptId,new TextDecoder().decode(canonicalBytes(['device-history-continuation-v1',owner.accountId||'guest',owner.accountGeneration||'guest',stream.clientStreamId])));
    const attemptId=await derivedId(commandId,'active-attempt');
    const references=await learningReferences(),existing=await resumeAttempt(attemptId);
    if(existing){
      const receipt=await authority.readRecords('import_receipts',['qb-fork-origin-v1',commandId]);
      if(!receipt)throw commandError('COMMAND_ORIGIN_UNAVAILABLE');
      const origin=validateForkOriginReceipt(receipt).provenance;
      if(origin.parentAttemptId!==parentAttemptId||origin.childAttemptId!==attemptId||origin.commandId!==commandId)throw commandError('COMMAND_ID_CONFLICT');
      const initial=references.find(row=>row.kind==='resume_state'&&row.payload.attemptId===attemptId&&row.payload.localRevision===1);
      const manifest=references.find(row=>row.kind==='attempt_manifest'&&row.mutationId===commandId&&row.payload.baseRevision===0);
      if(!initial||!manifest)throw commandError('COMMAND_ORIGIN_UNAVAILABLE');
      assertForkOriginProof(origin,manifest.payload,await historicalProof(initial.payload.contentDigest),await historicalProof(origin.parentResumeContentDigest));
      if(existing.attempt.writerStreamId!==stream.clientStreamId)throw commandError('COMMAND_ID_CONFLICT');
      if(existing.attempt.status!=='active')throw commandError('CONTINUATION_COMPLETED');
      return {attemptId,commandId,parentAttemptId,parentResumeContentDigest:origin.parentResumeContentDigest,bundle:existing,inPlace:false,existing:true};
    }
    if(await authority.readRecords('import_receipts',['qb-fork-origin-v1',commandId]))throw commandError('COMMAND_ORIGIN_UNAVAILABLE');
    const parent=await resumeAttempt(parentAttemptId);
    if(!parent)throw commandError('ATTEMPT_NOT_FOUND');
    const foreign=parent.attempt.writerStreamId!==stream.clientStreamId;
    if(!foreign&&parent.attempt.status!=='active'&&(parent.attempt.parentAttemptId||parent.snapshotBaseline))throw commandError('CONTINUATION_COMPLETED');
    if(!foreign&&parent.attempt.status==='active')return {attemptId:parentAttemptId,bundle:parent,inPlace:true};
    if(foreign&&!cloudConfirmed)return {requiresCloudConfirmation:true,bundle:parent};
    const sourceRefs=foreign?await confirmedReferences():references;
    const source=sourceRefs.filter(row=>row.kind==='resume_state'&&row.payload.attemptId===parentAttemptId).sort((a,b)=>b.payload.localRevision-a.payload.localRevision)[0];
    if(!source||source.payload.localRevision!==parent.attempt.localRevision)throw commandError('AWAITING_CLOUD_CONFIRMATION');
    // Complete immutable proof at the authenticated receipt cut, never the highest local revision.
    await historicalProof(source.payload.contentDigest,sourceRefs);
    return {attemptId,commandId,parentAttemptId,parentResumeContentDigest:source.payload.contentDigest,bundle:parent,inPlace:false,existing:false,foreign};
  }
  // UI-only ancestry view. Never becomes a native resume field or copied answer event.
  async function historyAncestry(attemptId){
    const refs=await learningReferences(),seen=new Set();let selected=attemptId;
    while(!seen.has(selected)&&seen.size<32){
      seen.add(selected);const initial=refs.find(row=>row.kind==='resume_state'&&row.payload.attemptId===selected&&row.payload.localRevision===1);
      if(!initial)return null;
      const proof=await historicalProof(initial.payload.contentDigest);
      if(proof.root.state.snapshotBaseline)return {snapshotBaseline:proof.root.state.snapshotBaseline};
      const inherited=proof.root.state.questionDrafts.find(row=>row.inheritedFrom)?.inheritedFrom;
      if(!inherited)return null;
      const parentProof=await historicalProof(inherited.resumeContentDigest);
      const manifest=refs.find(row=>row.kind==='attempt_manifest'&&row.payload.attemptId===selected&&row.payload.baseRevision===0);
      if(!manifest)throw commandError('COMMAND_ORIGIN_UNAVAILABLE');
      assertForkOriginProof({parentAttemptId:inherited.attemptId,parentResumeContentDigest:inherited.resumeContentDigest,childAttemptId:selected},manifest.payload,proof,parentProof);
      if(parentProof.root.state.snapshotBaseline)return {snapshotBaseline:parentProof.root.state.snapshotBaseline,snapshotCompletionKeys:parentProof.root.state.questionDrafts.filter(row=>row.localRevision===1&&!row.submitted&&!parentProof.root.events.some(event=>event.questionKey===row.questionKey&&event.kind==='answer_submitted')).map(row=>row.questionKey)};
      selected=inherited.attemptId;
    }
    return null;
  }
  async function replayMatches(previous, input) {
    if (input.kind === 'finalize') return previous.kind === 'attempt_manifest' && previous.payload.attemptId === input.attemptId && previous.payload.status === 'completed';
    if (['draft', 'position','restartInherited'].includes(input.kind)) {
      if (previous.kind !== 'resume_state' || previous.payload.attemptId !== input.attemptId) return false;
      const rows = await authority.readRecords('content_chunks', [previous.payload.chunkManifestDigest, 0]);
      if (!rows || await sha256Hex(rows.bytes) !== previous.payload.chunkManifestDigest) return false;
      const manifest = JSON.parse(new TextDecoder().decode(rows.bytes));
      const state = await readContent({ contentDigest: previous.payload.contentDigest, manifestDigest: previous.payload.chunkManifestDigest, chunkCount: manifest.chunkCount, totalBytes: manifest.totalBytes });
      validateResumeState(state);
      if (input.position !== undefined && state.position !== input.position) return false;
      if (input.effectiveElapsedMs !== undefined && state.effectiveElapsedMs !== input.effectiveElapsedMs) return false;
      if (input.kind === 'position') return true;
      const draft = state.questionDrafts.find(item => item.questionKey === input.questionKey);
      if(input.kind==='restartInherited')return !!draft&&draft.questionRevision===input.questionRevision&&!draft.inheritedFrom&&!draft.submitted&&(!input.input||equal(draft.input,input.input));
      return !!draft && draft.questionRevision === input.questionRevision && equal(draft.input, input.input);
    }
    const event = previous.payload.event;
    if (previous.kind !== 'answer_event' || event.attemptId !== input.attemptId || event.questionKey !== input.questionKey || event.questionRevision !== input.questionRevision) return false;
    if (input.kind === 'submit') return event.kind === 'answer_submitted' && (!input.input || equal(event.answer, input.input)) && equal(event.gradeAtTime, input.gradeAtTime) && event.graderVersion === input.graderVersion && event.gradingBasisDigest === input.gradingBasisDigest;
    if (input.kind === 'redo') return event.kind === 'redo' && (!input.redoOfEventId || event.redoOfEventId === input.redoOfEventId);
    if (input.kind === 'hint') return event.kind === 'hint' && event.hintKind === (input.hintKind || 'reveal');
    return false;
  }
  async function execute(value) {
    const input = commandSnapshot(value);
    if (input.lease.attemptId !== input.attemptId) throw commandError('LEASE_ATTEMPT_MISMATCH');
    const previous = await existingCommand(input.commandId);
    if (previous) {
      if (!(await replayMatches(previous, input))) throw commandError('COMMAND_ID_CONFLICT');
      return { bundle: await readAttempt(input.attemptId), duplicate: true };
    }
    const bundle = await resumeAttempt(input.attemptId);
    if (!bundle) throw commandError('ATTEMPT_NOT_FOUND');
    const stream = await authority.initializeStream({ ...(input.nowMs===undefined?{}:{nowMs:input.nowMs}) });
    if (bundle.attempt.writerStreamId !== stream.clientStreamId) throw commandError('FORK_REQUIRED');
    const stamp = input.nowMs ?? now();
    const next = transition(bundle, input, input.lease, stamp, await derivedId(input.commandId, 'event'));
    const resumeBase = await baseline('resume_state', `attempt:${input.attemptId}`, next.attempt.writerStreamId, input.kind === 'finalize' ? undefined : input.baseRevision);
    const manifestBase = input.kind === 'finalize' ? await baseline('attempt_manifest', `attempt:${input.attemptId}`, next.attempt.writerStreamId, input.baseRevision) : null;
    const resumeContent = await encodeContent(resumeState(next, resumeBase.baseRevision));
    const records = [{ store: 'attempts', value: next.attempt }, ...resumeContent.records];
    if (next.draft) records.push({ store: 'drafts', value: next.draft });
    if (next.event) records.push({ store: 'answer_events', value: next.event });
    const resumePayload = { schemaVersion: 1, attemptId: next.attempt.attemptId, writerStreamId: next.attempt.writerStreamId,
      contentDigest: resumeContent.reference.contentDigest, chunkManifestDigest: resumeContent.reference.manifestDigest,
      localRevision: next.attempt.localRevision, baseRevision: resumeBase.baseRevision };
    const mutationDrafts = [];
    if (next.event) mutationDrafts.push(wire(input.commandId, 'answer_event', `event:${next.event.eventId}`, { schemaVersion: 1, event: next.event }));
    else if (input.kind === 'finalize') mutationDrafts.push(wire(input.commandId, 'attempt_manifest', `attempt:${next.attempt.attemptId}`, manifestPayload(next.attempt, manifestBase.baseRevision)));
    mutationDrafts.push(wire(mutationDrafts.length ? await derivedId(input.commandId, 'resume') : input.commandId, 'resume_state', `attempt:${next.attempt.attemptId}`, resumePayload));
    const outcome = await authority.commit({ lease: input.lease, ...(input.nowMs===undefined?{}:{nowMs:input.nowMs}), records, mutationDrafts,
      conditions: [condition('attempts', input.attemptId, bundle.attempt), ...resumeBase.conditions, ...(manifestBase?.conditions || [])] });
    return { bundle: await readAttempt(input.attemptId), duplicate: outcome.duplicate };
  }
  async function setStar(value) {
    const input = commandSnapshot(value);
    const previous = await existingCommand(input.commandId);
    const entityKey = `user_state:${input.questionKey}:starred`;
    if (previous) {
      if (previous.kind !== 'user_state' || previous.entityKey !== entityKey || previous.payload.value !== input.value) throw commandError('COMMAND_ID_CONFLICT');
      return { duplicate: true };
    }
    const bundle = await readAttempt(input.lease.attemptId);
    if (!bundle?.scope.some(row => row.questionKey === input.questionKey)) throw commandError('QUESTION_NOT_IN_SCOPE');
    const old = await authority.readRecords('user_state', [input.questionKey, 'starred']);
    const base = await baseline('user_state', entityKey, undefined, input.baseRevision);
    const payload = { schemaVersion: 1, questionKey: input.questionKey, field: 'starred', value: input.value, baseRevision: base.baseRevision };
    const result = await authority.commit({ lease: input.lease, ...(input.nowMs===undefined?{}:{nowMs:input.nowMs}),
      mutationDrafts: [wire(input.commandId, 'user_state', entityKey, payload)],
      records: [{ store: 'user_state', value: { questionKey: input.questionKey, field: 'starred', value: input.value, starredKey: input.value ? 1 : 0, ...(old?.serverRevision !== undefined ? { serverRevision: old.serverRevision } : {}) } }],
      conditions: [condition('user_state', [input.questionKey, 'starred'], old), ...base.conditions] });
    return { duplicate: result.duplicate };
  }
  async function listStarConflicts(){
    if(owner.ownerKind!=='account')return [];
    const state=await authority.readStarResolutionState(),epoch=state.meta.find(row=>row.key==='serverLogEpoch')?.value,views=[];
    for(const conflict of state.conflicts.filter(row=>row.status==='open'&&row.mutation.kind==='user_state')){
      const view={conflictId:conflict.conflictId,questionKey:conflict.mutation.payload.questionKey,localValue:conflict.mutation.payload.value,available:false};
      try{const proofs=[];for(const row of state.import_receipts)if(row.provenance?.format==='qb-sync-change-v1'&&row.provenance.generation===owner.accountGeneration&&row.provenance.logEpoch===epoch&&row.provenance.change?.kind==='user_state'&&row.provenance.change.entityKey===conflict.entityKey)proofs.push((await validateSyncChangeReceipt(row)).provenance.change);proofs.sort((a,b)=>a.serverRevision-b.serverRevision);const source=proofs.at(-1);if(!source)throw commandError('PULL_REQUIRED');const plan=await prepareStarConflictResolution({commandId:crypto.randomUUID(),conflictId:conflict.conflictId,choice:'local',expectedCloudDigest:source.payloadDigest,expectedCloudRevision:source.serverRevision,state,owner,nowMs:now()});const p=plan.records.find(row=>row.store==='import_receipts').value.provenance;views.push({...view,available:true,cloudValue:p.sourceChange.payload.value,expectedCloudDigest:p.sourceChange.payloadDigest,expectedCloudRevision:p.sourceChange.serverRevision});}
      catch(cause){views.push({...view,error:cause.code||cause.message});}
    }
    return views;
  }
  async function listStarConflictGroups(){
    if(owner.ownerKind!=='account')return [];
    const state=await authority.readStarGroupResolutionState(),entities=[...new Set(state.conflicts.filter(row=>row.status==='open'&&row.mutation.kind==='user_state'&&row.mutation.payload.field==='starred').map(row=>row.entityKey))],views=[];
    for(const entityKey of entities){try{views.push(await viewStarConflictGroup({state,owner,entityKey}));}catch(cause){const members=state.mutations.filter(row=>row.kind==='user_state'&&row.entityKey===entityKey&&state.outbox.some(p=>p.mutationId===row.mutationId)).sort((a,b)=>a.clientSeq-b.clientSeq);views.push({entityKey,questionKey:entityKey.slice(11,-8),available:false,pendingCount:members.length,openConflictCount:state.conflicts.filter(row=>row.entityKey===entityKey&&row.status==='open').length,...(members.length?{localValue:members.at(-1).payload.value}:{}),error:cause.code||cause.message});}}
    return views;
  }
  async function resumeAttempt(attemptId) {
    const bundle = await readAttempt(attemptId);
    if (!bundle) return null;
    const mutations = await learningReferences();
    const latest = mutations.filter(m => m.kind === 'resume_state' && m.payload.attemptId === attemptId).sort((a, b) => b.payload.localRevision - a.payload.localRevision)[0];
    if (!latest || latest.payload.localRevision !== bundle.attempt.localRevision) throw commandError('MISSING_RESUME_STATE');
    const reference = latest.payload;
    const row = await authority.readRecords('content_chunks', [reference.chunkManifestDigest, 0]);
    if (!row || await sha256Hex(row.bytes) !== reference.chunkManifestDigest) throw commandError('MISSING_CONTENT');
    const manifest = JSON.parse(new TextDecoder().decode(row.bytes));
    const state = await readContent({ contentDigest: reference.contentDigest, manifestDigest: reference.chunkManifestDigest, chunkCount: manifest.chunkCount, totalBytes: manifest.totalBytes });
    const { writerStreamId, scopeDigest, scopeCount, parentAttemptId } = bundle.attempt;
    const proof=await historicalProof(reference.contentDigest);
    const validation = await validateResumeDependencies(state, reference, manifest, bundle.events, { attemptId, writerStreamId, scopeDigest, scopeCount, ...(parentAttemptId ? { parentAttemptId } : {}) },{parents:proof.parents,snapshotProofs:proof.snapshotProofs});
    if (validation.status !== 'payload_verified') throw commandError('MISSING_RESUME_DEPENDENCY');
    if (await sha256Hex(canonicalContentBytes(state)) !== await sha256Hex(canonicalContentBytes(resumeState(bundle, reference.baseRevision)))) throw commandError('CORRUPT_RESUME_STATE');
    const current = await authority.readRecords('attempts', attemptId);
    if (!equal(current, bundle.attempt)) throw commandError('REVISION_CONFLICT');
    return { ...bundle, resumeValidation: validation.status };
  }
  async function storeBankContent(value) {
    // Full bodies use the content budget, not the smaller mutation envelope budget.
    canonicalContentBytes(value);
    if (!UUID.test(value.commandId)) throw commandError('INVALID_COMMAND_ID');
    const input = clone(value);
    if (input.metadata.visibility === 'protected') throw commandError('PROTECTED_CONTENT_REQUIRES_CIPHER_API');
    const verified = await validateBankContent(input.content);
    if (verified.content.bankUid !== input.bankUid || verified.contentDigest !== input.revision || !equal(verified.content.metadata, input.metadata)) throw commandError('BANK_CONTENT_BINDING_MISMATCH');
    // Caller supplies registered bank identity and full canonical body. Media,
    // passage, explanation and sources are preserved without transformation.
    const content = await encodeContent(verified.content);
    const record = { bankUid: input.bankUid, revision: input.revision, metadata: input.metadata,
      contentManifest: input.metadata.visibility === 'public' ? { kind: 'public_static', staticRef: input.staticRef, contentDigest: content.reference.contentDigest } : { kind: 'private_chunks', reference: content.reference } };
    validateBankRevisionRecord(record);
    const previous = await existingCommand(input.commandId);
    if (previous) { if (previous.kind !== 'bank_revision' || !equal(previous.payload.metadata, record.metadata) || !equal(previous.payload.contentManifest, record.contentManifest) || previous.payload.bankUid !== record.bankUid || previous.payload.revision !== record.revision) throw commandError('COMMAND_ID_CONFLICT'); return { record, duplicate: true }; }
    const old = await authority.readRecords('bank_revisions', [record.bankUid, record.revision]);
    if (old && !equal(old, record)) throw commandError('BANK_REVISION_IMMUTABLE');
    if (old) { await readBankContent(record.bankUid,record.revision); return {record:old,duplicate:true}; }
    const base = await baseline('bank_revision', `bank:${record.bankUid}`, undefined, input.baseRevision);
    const result = await authority.commit({ lease: input.lease, ...(input.nowMs===undefined?{}:{nowMs:input.nowMs}), conditions: [condition('bank_revisions', [record.bankUid, record.revision], old), ...base.conditions],
      records: [{ store: 'bank_revisions', value: record }, ...content.records], mutationDrafts: [wire(input.commandId, 'bank_revision', `bank:${record.bankUid}`, { schemaVersion: 1, ...record, baseRevision: base.baseRevision }), wire(await derivedId(input.commandId, 'content'), 'content_manifest', `content:${content.reference.contentDigest}`, { schemaVersion: 1, reference: content.reference })] });
    return { record, duplicate: result.duplicate };
  }
  async function storeProtectedBankEnvelopeV2(value){
    const input=commandSnapshot(value),verified=await validateProtectedBankEnvelopeV2(input.envelope);
    if(input.bankUid!==verified.envelope.bankUid||input.revision!==verified.contentDigest||input.metadata.visibility!=='protected'||input.metadata.questionCount!==verified.questionRefs.length)throw commandError('PROTECTED_BANK_BINDING');
    const encoded=await encodeContent(verified.envelope),record={bankUid:input.bankUid,revision:input.revision,metadata:input.metadata,contentManifest:{kind:'protected_cipher',reference:encoded.reference}};
    validateBankRevisionRecord(record);
    const previous=await existingCommand(input.commandId);
    if(previous){if(previous.kind!=='bank_revision'||!equal(previous.payload.metadata,record.metadata)||!equal(previous.payload.contentManifest,record.contentManifest)||previous.payload.bankUid!==record.bankUid||previous.payload.revision!==record.revision)throw commandError('COMMAND_ID_CONFLICT');return {record,duplicate:true};}
    const old=await authority.readRecords('bank_revisions',[record.bankUid,record.revision]);if(old&&!equal(old,record))throw commandError('BANK_REVISION_IMMUTABLE');
    const base=await baseline('bank_revision',`bank:${record.bankUid}`,undefined,input.baseRevision);
    const result=await authority.commit({lease:input.lease,...(input.nowMs===undefined?{}:{nowMs:input.nowMs}),conditions:[condition('bank_revisions',[record.bankUid,record.revision],old),...base.conditions],records:[{store:'bank_revisions',value:record},...encoded.records],mutationDrafts:[wire(input.commandId,'bank_revision',`bank:${record.bankUid}`,{schemaVersion:1,...record,baseRevision:base.baseRevision}),wire(await derivedId(input.commandId,'content'),'content_manifest',`content:${encoded.reference.contentDigest}`,{schemaVersion:1,reference:encoded.reference})]});
    return {record,duplicate:result.duplicate};
  }
  async function readProtectedBankEnvelopeV2(bankUid,revision){
    const record=await authority.readRecords('bank_revisions',[bankUid,revision]);if(!record||record.contentManifest.kind!=='protected_cipher')throw commandError('BANK_CONTENT_MISSING');validateBankRevisionRecord(record);
    const loaded=await readVerifiedContent(record.contentManifest.reference,{bytesOnly:true});
    const verified=await validateProtectedBankEnvelopeV2(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(loaded.bytes)));
    if(verified.contentDigest!==record.revision||verified.envelope.bankUid!==bankUid||record.metadata.visibility!=='protected'||record.metadata.questionCount!==verified.questionRefs.length)throw commandError('PROTECTED_BANK_BINDING');
    return {record,envelope:verified.envelope,questionRefs:verified.questionRefs,proofClass:verified.proofClass};
  }
  // Candidate-only native range opening. No question/Ready admission yet.
  async function openRegisteredBankRanges(value){
    canonicalBytes(value);const input=clone(value);if(Object.keys(input).sort().join()!=='bankUid,reference,revision'||!UUID.test(input.bankUid)||!/^[0-9a-f]{64}$/.test(input.revision))throw commandError('INVALID_INPUT');
    const record=await authority.readRecords('bank_revisions',[input.bankUid,input.revision]);
    if(!record)throw commandError('BANK_CONTENT_MISSING');validateBankRevisionRecord(record);
    if(record.metadata.visibility==='protected')throw commandError('PROTECTED_REQUIRES_MEMORY_DECRYPTION');
    validateContentReference(input.reference);
    if(input.reference.contentDigest!==record.revision)throw commandError('BANK_CONTENT_BINDING_MISMATCH');
    if(record.contentManifest.kind==='private_chunks'&&!equal(record.contentManifest.reference,input.reference))throw commandError('BANK_CONTENT_BINDING_MISMATCH');
    if(record.contentManifest.kind==='public_static'){
      const known=frozenPublicBanks.find(bank=>bank.bankUid===record.bankUid&&bank.revision===record.revision);
      if(!known||!equal(known.metadata,record.metadata)||!equal(known.contentManifest,record.contentManifest)||!equal(known.publicContentReference,input.reference))throw commandError('UNTRUSTED_PUBLIC_REFERENCE');
    }
    const workspace=await authority.createReadonlyBankRanges({reference:input.reference});
    try{const current=await authority.readRecords('bank_revisions',[input.bankUid,input.revision]);if(!equal(current,record))throw commandError('BANK_CONTENT_BINDING_MISMATCH');return Object.freeze({record,workspace,verification:'bytes_candidate',ready:false});}catch(cause){workspace.close();throw cause;}
  }
  async function readRegisteredQuestion(value) {
    canonicalBytes(value);const input=clone(value);
    if(Object.keys(input).sort().join()!=='bankUid,questionKey,questionRevision,reference,revision'||typeof input.questionKey!=='string'||!/^[0-9a-f]{64}$/.test(input.questionRevision))throw commandError('INVALID_INPUT');
    const opened=await openRegisteredBankRanges({bankUid:input.bankUid,revision:input.revision,reference:input.reference});
    try{
      if(opened.record.metadata.visibility==='private'){
        const loaded=await readBankContent(input.bankUid,input.revision),question=loaded.content.questions.find(q=>q.questionKey===input.questionKey);
        if(!question)throw commandError('QUESTION_NOT_IN_SCOPE');if(question.questionRevision!==input.questionRevision)throw commandError('QUESTION_REVISION_MISMATCH');
        return{record:loaded.record,question,questionRefs:loaded.questionRefs,ordinal:loaded.content.questions.indexOf(question),selectedBytes:canonicalContentBytes(question).length,totalBytes:input.reference.totalBytes,verification:'registered-full-body-derived',ready:false,readPath:'legacy-private-bounded-body'};
      }
      const catalog=await scanReadonlyCatalog(input,opened),questionRefs=catalog.questionRefs,selected=catalog.rows.find(ref=>ref.questionKey===input.questionKey);
      if(!selected)throw commandError('QUESTION_NOT_IN_SCOPE');
      if(selected.questionRevision!==input.questionRevision)throw commandError('QUESTION_REVISION_MISMATCH');
      const bytes=new Uint8Array(selected.sourceRange.end-selected.sourceRange.start);let offset=0;
      for await(const part of opened.workspace.range(selected.sourceRange.start,selected.sourceRange.end)){bytes.set(part,offset);offset+=part.length;}
      if(offset!==bytes.length)throw commandError('QUESTION_CONTENT_MISSING');
      const question=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),canonical=canonicalContentBytes(question);
      if(canonical.length!==bytes.length||!canonical.every((v,i)=>v===bytes[i]))throw commandError('QUESTION_CANONICAL_MISMATCH');
      const derived=await deriveContent(question);
      if(question.bankUid!==input.bankUid||question.questionKey!==input.questionKey||question.questionRevision!==input.questionRevision||derived.questionRevision!==input.questionRevision||!equal(question.optionIds,derived.optionIds))throw commandError('QUESTION_REVISION_MISMATCH');
      const current=await authority.readRecords('bank_revisions',[input.bankUid,input.revision]);if(!equal(current,opened.record))throw commandError('BANK_CONTENT_BINDING_MISMATCH');
      return {record:clone(opened.record),question,questionRefs:clone(questionRefs),ordinal:selected.ordinal,selectedBytes:bytes.length,totalBytes:input.reference.totalBytes,verification:'registered-full-body-derived',ready:false};
    }finally{opened.workspace.close();}
  }
  async function scanReadonlyCatalog(input,opened){
    const publicBank=opened.record.contentManifest.kind==='public_static';
    if(publicBank&&readonlyCatalog&&equal(readonlyCatalog.record,opened.record)&&equal(readonlyCatalog.reference,input.reference)){await opened.workspace.verifyBytes();return readonlyCatalog;}
    const streamer=await authority.createReadonlyBankStreamer(opened.workspace),rows=[];
    try{
      const verified=await streamer.stream({onQuestion:row=>{rows.push(row);}});
      const questionRefs=rows.map(({questionKey,questionRevision})=>({questionKey,questionRevision}));
      if(verified.bankUid!==input.bankUid||verified.contentDigest!==input.revision||!equal(verified.metadata,opened.record.metadata)||questionRefs.length!==opened.record.metadata.questionCount)throw commandError('BANK_CONTENT_BINDING_MISMATCH');
      if(publicBank){const known=frozenPublicBanks.find(bank=>bank.bankUid===input.bankUid&&bank.revision===input.revision);if(!known||!equal(known.questionsrefs,questionRefs))throw commandError('UNTRUSTED_PUBLIC_REFERENCE');}
      const value={record:opened.record,reference:input.reference,questionRefs,rows};if(publicBank)readonlyCatalog=value;return value;
    }finally{streamer.close();}
  }
  async function readRegisteredDisplayCatalog(value){
    canonicalBytes(value);const captured=clone(value);if(Object.keys(captured).sort().join()!=='bankUid,revision')throw commandError('INVALID_INPUT');const known=frozenPublicBanks.find(bank=>bank.bankUid===captured.bankUid&&bank.revision===captured.revision);if(!known)throw commandError('UNTRUSTED_PUBLIC_REFERENCE');const input={...captured,reference:clone(known.publicContentReference)},opened=await openRegisteredBankRanges(input);
    try{
      if(opened.record.contentManifest.kind!=='public_static')throw commandError('PUBLIC_DISPLAY_CATALOG_ONLY');
      const catalog=await scanReadonlyCatalog(input,opened);
      if(catalog.rows.some(row=>row.displayView?.format!=='qb-question-display-v1'))throw commandError('DISPLAY_CATALOG_UNAVAILABLE');
      const current=await authority.readRecords('bank_revisions',[input.bankUid,input.revision]);if(!equal(current,opened.record))throw commandError('BANK_CONTENT_BINDING_MISMATCH');
      return{record:clone(catalog.record),reference:clone(catalog.reference),questionRefs:clone(catalog.questionRefs),views:catalog.rows.map(row=>({questionKey:row.questionKey,questionRevision:row.questionRevision,ordinal:row.ordinal,displayView:clone(row.displayView)})),ready:false,verification:'display_only'};
    }finally{opened.workspace.close();}
  }
  async function importLegacyBrowserEvidence(input) {
    canonicalBytes(input);
    if (!input || Object.keys(input).sort().join(',') !== 'lease,value' || !input.value) throw commandError('INVALID_INPUT');
    const { lease } = input, verified = await validateBrowserLearningExport(input.value), plan = prepareBrowserLearningImport(verified);
    if (plan.records.length > 258) throw commandError('INVALID_INPUT');
    const receiptRow = plan.records.find(row => row.store === 'import_receipts')?.value;
    if (!receiptRow || receiptRow.sourceId !== plan.sourceId || receiptRow.sourceRecordId !== plan.sourceRecordId
      || receiptRow.provenance?.sourceDigest !== plan.sourceDigest || receiptRow.provenance?.format !== 'qb-browser-localstorage-export-v1') throw commandError('INVALID_INPUT');
    const oldReceipt = await authority.readRecords('import_receipts',[plan.sourceId,plan.sourceRecordId]);
    if (oldReceipt) {
      if (!equal(oldReceipt.provenance,receiptRow.provenance)) throw commandError('LEGACY_IMPORT_CONFLICT');
      for (const row of plan.records.filter(value => value.store !== 'import_receipts')) {
        const value = row.value;
        const key = row.store === 'legacy_raw' ? [value.sourceId,value.sourceDigest,value.chunkIndex]
          : row.store === 'legacy_aggregates' ? [value.sourceId,value.namespace,value.legacyQuestionId]
            : value.migrationId;
        const existing = await authority.readRecords(row.store,key);
        if (!equal(existing,value)) throw commandError('LEGACY_IMPORT_CONFLICT');
      }
      return { duplicate: true, sourceDigest: plan.sourceDigest, rawCount: receiptRow.provenance.recordCount, answerEventsCreated: 0 };
    }
    const conditions = plan.records.map(row => ({ store: row.store, key: row.store === 'legacy_raw'
      ? [row.value.sourceId,row.value.sourceDigest,row.value.chunkIndex]
      : row.store === 'legacy_aggregates' ? [row.value.sourceId,row.value.namespace,row.value.legacyQuestionId]
        : row.store === 'migration_journal' ? row.value.migrationId : [row.value.sourceId,row.value.sourceRecordId], expected: undefined }));
    await authority.commit({ lease, records: plan.records, conditions });
    return { duplicate: false, sourceDigest: plan.sourceDigest, rawCount: receiptRow.provenance.recordCount, answerEventsCreated: 0 };
  }
  async function readBankContent(bankUid, revision) {
    const record = await authority.readRecords('bank_revisions', [bankUid, revision]);
    if (!record) throw commandError('BANK_CONTENT_MISSING');
    validateBankRevisionRecord(record);
    let reference = record.contentManifest.reference;
    if (record.contentManifest.kind === 'public_static') {
      const mutations = await learningReferences();
      reference = mutations.find(m => m.kind === 'content_manifest' && m.payload.reference.contentDigest === record.contentManifest.contentDigest)?.payload.reference;
    }
    if (!reference) throw commandError('BANK_CONTENT_MISSING');
    const content = await readContent(reference);
    const verified = await validateBankContent(content);
    if (verified.content.bankUid !== record.bankUid || verified.contentDigest !== record.revision || !equal(verified.content.metadata, record.metadata)) throw commandError('BANK_CONTENT_BINDING_MISMATCH');
    return { record, content: verified.content, questionRefs: verified.questionRefs };
  }
  async function readHistorySnapshot(snapshotId) {
    const record = await authority.readRecords('history_snapshots', snapshotId);
    if (!record) return null;
    if (owner.ownerKind !== 'account') throw commandError('ACCOUNT_PROFILE_REQUIRED');
    const key=snapshotId+':'+JSON.stringify(record);
    let proof=historySnapshotProofs.get(key);
    if(!proof){proof=(async()=>{const body=await readContent(record.reference);await validateHistorySnapshotBinding(record,body,{accountGeneration:owner.accountGeneration});const immutable=value=>{if(value&&typeof value==='object'){for(const child of Object.values(value))immutable(child);Object.freeze(value);}return value;};return immutable(body);})();historySnapshotProofs.set(key,proof);proof.catch(()=>historySnapshotProofs.delete(key));}
    const body=await proof;
    // The authority read above remains mandatory on every lookup: cached
    // immutable content is not permission to bypass owner or deletion fences.
    return {kind:'imported_snapshot',record,body};
  }
  async function resolveHistorySnapshotQuestion({snapshotId,legacyQuestionId}) {
    const snapshot=await readHistorySnapshot(snapshotId);
    const scope=snapshot?.body.scope.find(row=>row.legacyQuestionId===legacyQuestionId);
    if(!scope)throw commandError('QUESTION_NOT_IN_SCOPE');
    const ref=scope.equivalentSourceRefs.find(row=>row.questionKey===scope.questionKey&&row.questionRevision===scope.questionRevision);
    const bankUid=ref.questionKey.split('/')[0];
    const proofKey=`${bankUid}:${ref.bankRevision}`;
    if(!historyBankProofs.has(proofKey)){const proof=resolveImmutableBank({bankUid,bankRevision:ref.bankRevision,readBankRevision:(uid,revision)=>authority.readRecords('bank_revisions',[uid,revision]),sourceChanges:async(uid,revision)=>(await learningReferences()).filter(row=>row.kind==='bank_revision'&&row.payload.bankUid===uid&&row.payload.revision===revision||row.kind==='content_manifest'&&row.payload.reference.contentDigest===revision),readContent}).catch(error=>{historyBankProofs.delete(proofKey);throw error;});historyBankProofs.set(proofKey,proof);}
    const bank=await historyBankProofs.get(proofKey);
    const question=bank.content.questions?.find(row=>row.questionKey===ref.questionKey&&row.questionRevision===ref.questionRevision);
    if(!question)throw commandError('HISTORY_QUESTION_DEPENDENCY');
    return {question,bankUid,bankRevision:ref.bankRevision,title:bank.record.metadata.title};
  }
  async function storeHistorySnapshot(value) {
    canonicalBytes(value); const input = clone(value);
    if (!UUID.test(input.commandId)) throw commandError('INVALID_COMMAND_ID');
    if (owner.ownerKind !== 'account' || input.body.accountGeneration !== owner.accountGeneration) throw commandError('OWNER_MISMATCH');
    validateImportedHistorySnapshot(input.body);
    const encoded = await encodeContent(input.body);
    const body = input.body;
    const record = {schemaVersion:1,snapshotId:body.snapshotId,accountGeneration:body.accountGeneration,source:body.source,recordedAt:body.recordedAt,summary:body.summary,scopeCount:body.scope.length,reference:encoded.reference,baseRevision:0};
    await validateHistorySnapshotBinding(record,body,{accountGeneration:owner.accountGeneration});
    const banks = new Map(), bankConditions = [];
    for (const row of body.scope) for (const ref of row.equivalentSourceRefs) {
      const bankUid=ref.questionKey.split('/')[0], key=`${bankUid}:${ref.bankRevision}`;
      if(!banks.has(key)){
        const bank=await readBankContent(bankUid,ref.bankRevision),deleted=await authority.readRecords('entity_tombstones',`bank:${bankUid}`);
        if(deleted)throw commandError('ENTITY_TOMBSTONED');
        banks.set(key,new Set(bank.questionRefs.map(q=>`${q.questionKey}:${q.questionRevision}`)));
        bankConditions.push(condition('bank_revisions',[bankUid,ref.bankRevision],bank.record),condition('entity_tombstones',`bank:${bankUid}`,deleted));
      }
      if (!banks.get(key).has(`${ref.questionKey}:${ref.questionRevision}`)) throw commandError('HISTORY_QUESTION_DEPENDENCY');
    }
    const entityKey = `history_snapshot:${body.snapshotId}`;
    const tombstone = await authority.readRecords('entity_tombstones',entityKey);
    if (tombstone) throw commandError('ENTITY_TOMBSTONED');
    const old = await authority.readRecords('history_snapshots',body.snapshotId);
    if (old) { if (!equal(old,record)) throw commandError('HISTORY_SNAPSHOT_IMMUTABLE'); return {...await readHistorySnapshot(body.snapshotId),duplicate:true}; }
    const previous = await existingCommand(input.commandId);
    if (previous) throw commandError('COMMAND_ID_CONFLICT');
    const result = await authority.commit({lease:input.lease,...(input.nowMs===undefined?{}:{nowMs:input.nowMs}),conditions:[condition('history_snapshots',body.snapshotId,old),condition('entity_tombstones',entityKey,tombstone),...bankConditions],records:[{store:'history_snapshots',value:record},...encoded.records],mutationDrafts:[wire(input.commandId,'history_snapshot',entityKey,record),wire(await derivedId(input.commandId,'content'),'content_manifest',`content:${encoded.reference.contentDigest}`,{schemaVersion:1,reference:encoded.reference})]});
    return {...await readHistorySnapshot(body.snapshotId),duplicate:result.duplicate};
  }
  return Object.freeze({ ...authority, openRegisteredBankRanges, readRegisteredQuestion, readRegisteredDisplayCatalog, readAttempt, readContent, readVerifiedContent, historicalProof, historyAncestry, resumeAttempt, authorizeSnapshotContinuation,prepareSnapshotContinuation,createSnapshotContinuation, prepareHistoryContinuation, storeBankContent, storeProtectedBankEnvelopeV2,readProtectedBankEnvelopeV2,readBankContent, readHistorySnapshot,resolveHistorySnapshotQuestion,storeHistorySnapshot,createAttempt, forkAttempt, execute,listStarConflicts,listStarConflictGroups, importLegacyBrowserEvidence,
    applyPullPage: input => applyPullPage(authority,input),
    saveDraft: input => execute({ ...commandSnapshot(input), kind: 'draft' }), submit: input => execute({ ...commandSnapshot(input), kind: 'submit' }),
    redo: input => execute({ ...commandSnapshot(input), kind: 'redo' }), hint: input => execute({ ...commandSnapshot(input), kind: 'hint' }),
    restartInheritedDraft:input=>execute({...commandSnapshot(input),kind:'restartInherited'}),
    finalize: input => execute({ ...commandSnapshot(input), kind: 'finalize' }), savePosition: input => execute({ ...commandSnapshot(input), kind: 'position' }), setStar });
}
