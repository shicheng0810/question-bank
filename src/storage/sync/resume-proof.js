import {canonicalBytes,canonicalContentBytes,validateMutationRecord,validateChangeLogRecord,validateAnswerEvent,verifyMutationDigest,sha256Hex,validateResumeDependencies} from '../../domain/app-data/index.js';
import {mutationWire,syncError} from './protocol.js';
const equal=(a,b)=>new TextDecoder().decode(canonicalBytes(a))===new TextDecoder().decode(canonicalBytes(b));
const before=(a,b)=>a.length<b.length||a.length===b.length&&a<=b;
/** @param {import('../../domain/app-data/contracts').MutationRecord | import('../../domain/app-data/contracts').ChangeLogRecord} left
 * @param {import('../../domain/app-data/contracts').MutationRecord | import('../../domain/app-data/contracts').ChangeLogRecord} right */
const withinCut=(left,right)=>'serverSeq' in right?'serverSeq' in left&&before(left.serverSeq,right.serverSeq):!('serverSeq' in left)&&left.clientStreamId===right.clientStreamId&&left.clientSeq<=right.clientSeq;

/** Historical resume proofs are anchored in actual local mutation or verified
 * server ChangeLog references. No current parent draft is substituted for the
 * exact immutable ancestor digest named by inheritedFrom.
 */
export async function loadHistoricalResumeProof({references:inputRefs,attempts:inputAttempts,events:inputEvents,contentDigest,readResumeContent,readSnapshotBaseline}){
  canonicalContentBytes(inputRefs);canonicalContentBytes(inputAttempts);canonicalContentBytes(inputEvents);canonicalBytes(contentDigest);
  const references=structuredClone(inputRefs),attempts=structuredClone(inputAttempts),events=structuredClone(inputEvents);
  if(!/^[0-9a-f]{64}$/.test(contentDigest)||typeof readResumeContent!=='function')throw syncError('INVALID_INPUT');
  for(const ref of references)Object.hasOwn(ref,'serverSeq')?validateChangeLogRecord(ref):validateMutationRecord(ref);
  events.forEach(validateAnswerEvent);
  for(const ref of references){
    if(Object.hasOwn(ref,'serverSeq')){if(await sha256Hex(canonicalBytes({protocolVersion:2,kind:ref.kind,entityKey:ref.entityKey,payload:ref.payload}))!==ref.payloadDigest)throw syncError('SYNC_CHANGE_DIGEST');}
    else if(!await verifyMutationDigest(mutationWire(ref)))throw syncError('CORRUPT_MUTATION');
  }
  const bundles=new Map(),visiting=new Set(),snapshotProofs=[];
  /** @param {Extract<import('../../domain/app-data/contracts').MutationRecord | import('../../domain/app-data/contracts').ChangeLogRecord,{kind:'resume_state'}>} ref */
  function selectEvents(ref){
    const selected=[];
    for(const eventRef of references.filter(row=>row.kind==='answer_event'&&row.payload.event.attemptId===ref.payload.attemptId&&row.payload.event.writerStreamId===ref.payload.writerStreamId)){
      const within='serverSeq' in ref?Object.hasOwn(eventRef,'serverSeq')&&before(eventRef.serverSeq,ref.serverSeq):eventRef.clientStreamId===ref.clientStreamId&&eventRef.clientSeq<=ref.clientSeq;
      if(!within)continue;
      const event=events.find(row=>row.eventId===eventRef.payload.event.eventId);
      if(!event||!equal(event,eventRef.payload.event))throw syncError('MISSING_RESUME_DEPENDENCY');
      if(!selected.some(row=>row.eventId===event.eventId))selected.push(event);
    }
    selected.sort((a,b)=>a.actionSeq-b.actionSeq);
    return selected;
  }
  async function load(digest,depth){
    if(depth>32||bundles.size>32)throw syncError('RESUME_DEPENDENCY_LIMIT');
    if(visiting.has(digest))throw syncError('RESUME_DEPENDENCY_CYCLE');
    if(bundles.has(digest))return bundles.get(digest);
    const ref=references.find(row=>row.kind==='resume_state'&&row.payload.contentDigest===digest);
    if(!ref)throw syncError('MISSING_RESUME_DEPENDENCY');
    const p=ref.payload,attempt=attempts.find(row=>row.attemptId===p.attemptId);
    if(!attempt||attempt.writerStreamId!==p.writerStreamId)throw syncError('MISSING_RESUME_DEPENDENCY');
    visiting.add(digest);
    const loaded=await readResumeContent(structuredClone(p));
    if(loaded.reference.contentDigest!==digest||loaded.reference.manifestDigest!==p.chunkManifestDigest)throw syncError('CORRUPT_CONTENT');
    const selected=selectEvents(ref);
    const bundle={state:loaded.value,reference:structuredClone(p),manifest:loaded.manifest,events:selected,expectedAttempt:{attemptId:attempt.attemptId,writerStreamId:attempt.writerStreamId,scopeDigest:attempt.scopeDigest,scopeCount:attempt.scopeCount,...(attempt.parentAttemptId?{parentAttemptId:attempt.parentAttemptId}:{})}};
    bundles.set(digest,bundle);
    if(bundle.state.localRevision>1){const initial=references.find(row=>row.kind==='resume_state'&&row.payload.attemptId===p.attemptId&&row.payload.writerStreamId===p.writerStreamId&&row.payload.localRevision===1&&withinCut(row,ref));if(initial){const original=await readResumeContent(structuredClone(initial.payload));if(await sha256Hex(canonicalContentBytes(original.value))!==initial.payload.contentDigest)throw syncError('CORRUPT_CONTENT');if(original.value.snapshotBaseline&&!bundle.state.snapshotBaseline)throw syncError('SNAPSHOT_BASELINE_IMMUTABLE');}}

    if(bundle.state.snapshotBaseline){
      if(typeof readSnapshotBaseline!=="function")throw syncError("MISSING_SNAPSHOT_BASELINE_DEPENDENCY");
      const snapshotProof=await readSnapshotBaseline(bundle.state.snapshotBaseline);snapshotProofs.push(snapshotProof);
      if(bundle.state.localRevision>1){
        const initial=references.find(row=>row.kind==='resume_state'&&row.payload.attemptId===p.attemptId&&row.payload.writerStreamId===p.writerStreamId&&row.payload.localRevision===1&&withinCut(row,ref));
        if(!initial)throw syncError('MISSING_SNAPSHOT_INITIAL_RESUME');
        const original=await readResumeContent(structuredClone(initial.payload));
        if(!original.value.snapshotBaseline||!equal(original.value.snapshotBaseline,bundle.state.snapshotBaseline))throw syncError('SNAPSHOT_BASELINE_IMMUTABLE');
        if(!equal(original.reference,{contentDigest:initial.payload.contentDigest,manifestDigest:initial.payload.chunkManifestDigest,chunkCount:original.manifest.chunkCount,totalBytes:original.manifest.totalBytes}))throw syncError('CORRUPT_CONTENT');
        // The immutable initialization is an independent snapshot proof, never
        // an extra native parent. Validate its own event cut and full body.
        const initialized=await validateResumeDependencies(original.value,initial.payload,original.manifest,selectEvents(initial),bundle.expectedAttempt,{parents:[],snapshotProofs:[snapshotProof]});
        if(initialized.status!=='payload_verified')throw syncError('MISSING_SNAPSHOT_INITIAL_RESUME');
      }
    }
    for(const draft of bundle.state.questionDrafts)if(draft.inheritedFrom)await load(draft.inheritedFrom.resumeContentDigest,depth+1);
    visiting.delete(digest);return bundle;
  }
  const root=await load(contentDigest,0),parents=[...bundles.entries()].filter(([digest])=>digest!==contentDigest).map(([,bundle])=>bundle);
  const validation=await validateResumeDependencies(root.state,root.reference,root.manifest,root.events,root.expectedAttempt,{parents,snapshotProofs});
  if(validation.status!=='payload_verified')throw syncError('MISSING_RESUME_DEPENDENCY');
  return {root,parents,snapshotProofs,validation};
}
