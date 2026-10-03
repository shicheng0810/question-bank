import { openDataV2 } from './data-v2-entry.js';
import { validateBankContent } from '../domain/question/bank-content.js';
import { canonicalBytes } from '../domain/app-data/index.js';
import { validateProtectedBankFileV2 } from './protected-file.js';
import { ownedWriteInput } from '../storage/idb/write-input.js';
import { validateBrowserLearningExport } from '../browser/local-storage-migration.js';

const fail = code => Object.assign(new Error(code), { code });
const snapshot = value => { canonicalBytes(value); return structuredClone(value); };
const id = () => crypto.randomUUID();

/** Small UI bridge. No answer is reported saved until the repository transaction
 * completes. It owns the lease/renew timer and closes before identity switches.
 */
export async function createLearningSession({ owner = null, signal, isCurrent = () => true, onStatus = () => {}, onRestore = () => {}, onCleanup = () => {}, authorizeSnapshotInitialization } = {}) {
  let closed = false, attemptId = null, lease = null, queue = Promise.resolve(), renewal = null, failed = null, pendingCount = 0, lastWriteError = null, lastCommitted = null, cleanupOverride = null;
  const context = await openDataV2({ owner, signal, isCurrent, onCleanup, authorizeSnapshotInitialization });
  const repository = context.repository;
  const continuations = new Map();
  function guard() { if (closed || signal?.aborted || !isCurrent()) throw fail('CLOSED'); if (failed) throw failed; }
  function status(state, error) { onStatus({ state, error: error?.code || error?.message || null, attemptId }); }
  const close = () => { if (closed) return; closed = true; clearInterval(renewal); renewal = null; context.close(); status('closed'); };
  signal?.addEventListener('abort', close, { once: true });
  function enqueue(work, learningWrite = true) {
    guard(); if (learningWrite) { pendingCount++; status('saving'); }
    const result = queue.then(async () => { guard(); const value = await work(); guard(); if (learningWrite) { lastCommitted = Date.now(); lastWriteError = null; } return value; }).catch(error => {
      if (learningWrite) lastWriteError = error;
      status('error', error); if (['CLOSED', 'STALE_LEASE', 'CLOCK_HISTORY_NOT_COMMITTED', 'STALE_ACTIVE_PROFILE'].includes(error.code)) { failed = error; close(); }
      throw error;
    }).finally(() => { if (learningWrite) { pendingCount--; if (!closed) status(pendingCount ? 'saving' : lastWriteError ? 'error' : 'saved', lastWriteError); } });
    queue = result.catch(() => {});
    return result;
  }
  async function ownAttempt(selectedId, operationGuard = guard) {
    operationGuard();
    clearInterval(renewal); renewal = null;
    if (lease) { try { await repository.releaseWriter({ token: lease }); } catch { /* do not retain a failed previous writer */ } }
    operationGuard(); lease = null; attemptId = selectedId;
    const deadline = Date.now() + 16000;
    while (true) {
      try { lease = await repository.acquireWriter({ attemptId }); break; }
      catch (error) {
        if (error.code !== 'LEASE_BUSY' || Date.now() >= deadline) throw error;
        status('waiting-writer'); await new Promise(resolve => setTimeout(resolve, 250)); operationGuard();
      }
    }
    try { operationGuard(); }
    catch (error) { if (lease) await repository.releaseWriter({ token: lease }).catch(() => {}); lease = null; throw error; }
    renewal = setInterval(() => {
      if (closed || !lease) return;
      enqueue(async () => { lease = await repository.renewWriter({ token: lease }); }, false).catch(() => {});
    }, 5000);
  }
  async function startBank(contentValue, { staticRef, newAttempt = false, scope: requestedScope } = {}) {
    const entries = Array.isArray(contentValue) ? contentValue : [{ content: contentValue, staticRef }];
    const verifiedBanks = [];
    for (const entry of entries) {
      const verified=await validateBankContent(entry.content),protectedFile=entry.protectedFile?await validateProtectedBankFileV2(entry.protectedFile):null;
      if(protectedFile&&(verified.content.bankUid!==protectedFile.record.bankUid||verified.content.metadata.title!==protectedFile.record.metadata.title||verified.content.metadata.questionCount!==protectedFile.record.metadata.questionCount||JSON.stringify(verified.questionRefs)!==JSON.stringify(protectedFile.envelope.questionRefs)))throw fail('PROTECTED_BANK_BINDING');
      verifiedBanks.push({...verified,staticRef:entry.staticRef,protectedFile});
    }
    guard();
    const registered = new Map(verifiedBanks.flatMap(bank => bank.questionRefs).map(ref => [ref.questionKey, ref.questionRevision]));
    const scope = snapshot(requestedScope || verifiedBanks.flatMap(bank => bank.questionRefs)).map(ref => ({ ...ref, equivalentSourceRefs: ref.equivalentSourceRefs || [{ questionKey: ref.questionKey, questionRevision: ref.questionRevision }] }));
    if (scope.some(ref => registered.get(ref.questionKey) !== ref.questionRevision || ref.equivalentSourceRefs.some(source => registered.get(source.questionKey) !== source.questionRevision))) throw fail('UNREGISTERED_SCOPE');
    const stream = await repository.initializeStream();
    let existing = null;
    if (!newAttempt) {
      const attempts = (await repository.readRecords('attempts')).filter(row => ['active','completed'].includes(row.status) && row.writerStreamId === stream.clientStreamId).sort((a, b) => b.startedAt - a.startedAt);
      for (const row of attempts) {
        const bundle = await repository.readAttempt(row.attemptId);
        if (bundle.scope.length === scope.length && bundle.scope.every((row, index) => row.questionKey === scope[index].questionKey && row.questionRevision === scope[index].questionRevision && JSON.stringify(row.equivalentSourceRefs) === JSON.stringify(scope[index].equivalentSourceRefs))) { existing = bundle; break; }
      }
    }
    await ownAttempt(existing?.attempt.attemptId || id());
    for (const verified of verifiedBanks) {
      const revision=verified.protectedFile?.record.revision||verified.contentDigest;
      const stored = await repository.readRecords('bank_revisions', [verified.content.bankUid, revision]);
      if(verified.protectedFile){
        if(stored)await repository.readProtectedBankEnvelopeV2(verified.content.bankUid,revision);
        else await repository.storeProtectedBankEnvelopeV2({commandId:id(),lease,bankUid:verified.protectedFile.record.bankUid,revision,metadata:verified.protectedFile.record.metadata,envelope:verified.protectedFile.envelope});
      }else if (stored) await repository.readBankContent(verified.content.bankUid, revision);
      else await repository.storeBankContent({ commandId: id(), lease, bankUid: verified.content.bankUid, revision, metadata: verified.content.metadata, content: verified.content, ...(verified.staticRef ? { staticRef: verified.staticRef } : {}) });
    }
    if (!existing) await repository.createAttempt({ commandId: id(), attemptId, lease, scope });
    const bundle = await repository.resumeAttempt(attemptId); guard();
    const stars = (await repository.readRecords('user_state')).filter(row => row.field === 'starred' && row.value).map(row => row.questionKey);
    const contents = verifiedBanks.map(bank => bank.content);
    onRestore({ bundle, stars, contents });
    return { bundle, stars, contents };
  }
  function command(method, value) {
    const captured = snapshot(value);
    return enqueue(async () => repository[method]({ ...captured, commandId: id(), attemptId, lease }));
  }
  async function continueSelected(selectedId,operationGuard,operationCurrent,confirmCloud){
        operationGuard();
        let plan = await repository.prepareHistoryContinuation(selectedId); operationGuard();
        if(plan.requiresCloudConfirmation){
          if(typeof confirmCloud!=='function')throw fail('AWAITING_CLOUD_CONFIRMATION');
          const confirmation=await confirmCloud();operationGuard();
          if(!confirmation?.reachedCut||confirmation.awaitingResume||confirmation.reason==='AWAITING_RESUME')throw fail('AWAITING_CLOUD_CONFIRMATION');
          plan=await repository.prepareHistoryContinuation(selectedId,{cloudConfirmed:true});operationGuard();
        }
        // Verify exact registered revisions before taking ownership or creating
        // a child. Missing original content must never make an empty attempt.
        const records = await repository.readRecords('bank_revisions'); operationGuard();
        const checked = new Map();
        for (const scope of plan.bundle.scope) {
          for (const ref of scope.equivalentSourceRefs) {
            let found = false;
            for (const record of records.filter(row => row.bankUid === ref.questionKey.split('/')[0])) {
              const key = `${record.bankUid}:${record.revision}`;
              if (!checked.has(key)) {
                const loaded = record.contentManifest.kind === 'protected_cipher'
                  ? await repository.readProtectedBankEnvelopeV2(record.bankUid, record.revision)
                  : await repository.readBankContent(record.bankUid, record.revision);
                operationGuard(); checked.set(key, loaded.questionRefs || loaded.envelope.questionRefs);
              }
              if (checked.get(key).some(row => row.questionKey === ref.questionKey && row.questionRevision === ref.questionRevision)) { found = true; break; }
            }
            if (!found) throw fail('HISTORY_CONTENT_MISSING');
          }
        }
        await ownAttempt(plan.attemptId, operationGuard); operationGuard();
        // A second tab may have committed the same child while we waited for
        // its lease; replay the existing atomic fork command in that case.
        if (!plan.inPlace && !plan.existing) {
          await repository.forkAttempt({ commandId: plan.commandId, attemptId, lease, parentAttemptId: plan.parentAttemptId, parentResumeContentDigest: plan.parentResumeContentDigest }, { isCurrent: operationCurrent }); operationGuard();
        }
        const bundle = await repository.resumeAttempt(attemptId); operationGuard();
        if (bundle.attempt.status !== 'active') throw fail('CONTINUATION_COMPLETED');
        const stars = (await repository.readRecords('user_state')).filter(row => row.field === 'starred' && row.value).map(row => row.questionKey); operationGuard();
        const historyView=await repository.historyAncestry(attemptId);operationGuard();
        return { bundle:{...bundle,historyView}, stars, continuedFrom: selectedId, inPlace: plan.inPlace, foreignBranch:plan.foreign===true };
  }
  const pagehide = () => { if (lease && !closed) repository.releaseWriter({ token: lease }).catch(() => {}).finally(close); else close(); };
  globalThis.addEventListener?.('pagehide', pagehide, { once: true });
  return Object.freeze({ owner: context.owner, repository,
    startStoredBank(value,options={}) {
      const captured=snapshot(value),capturedOptions=snapshot(options);if(Object.keys(capturedOptions).some(key=>!['newAttempt','scope'].includes(key))||(capturedOptions.newAttempt!==undefined&&typeof capturedOptions.newAttempt!=='boolean'))throw fail('INVALID_INPUT');const newAttempt=capturedOptions.newAttempt===true;
      return enqueue(async()=>{
        const selected=await repository.readRegisteredQuestion(captured);guard();
        const registered=new Map(selected.questionRefs.map(ref=>[ref.questionKey,ref.questionRevision]));
        const scope=(capturedOptions.scope||selected.questionRefs).map(ref=>({...ref,equivalentSourceRefs:ref.equivalentSourceRefs||[{questionKey:ref.questionKey,questionRevision:ref.questionRevision}]}));
        if(scope.some(ref=>registered.get(ref.questionKey)!==ref.questionRevision||ref.equivalentSourceRefs.some(source=>registered.get(source.questionKey)!==source.questionRevision)))throw fail('UNREGISTERED_SCOPE');
        const stream=await repository.initializeStream();guard();let existing;
        if(!newAttempt){
          const attempts=(await repository.readRecords('attempts')).filter(row=>['active','completed'].includes(row.status)&&row.writerStreamId===stream.clientStreamId).sort((a,b)=>b.startedAt-a.startedAt);
          for(const row of attempts){const bundle=await repository.readAttempt(row.attemptId);guard();if(bundle.scope.length===scope.length&&bundle.scope.every((ref,index)=>ref.questionKey===scope[index].questionKey&&ref.questionRevision===scope[index].questionRevision&&JSON.stringify(ref.equivalentSourceRefs)===JSON.stringify(scope[index].equivalentSourceRefs))){existing=bundle;break;}}
        }
        await ownAttempt(existing?.attempt.attemptId||id());guard();
        if(!existing)await repository.createAttempt({commandId:id(),attemptId,lease,scope});
        const bundle=await repository.resumeAttempt(attemptId);guard();
        const stars=(await repository.readRecords('user_state')).filter(row=>row.field==='starred'&&row.value).map(row=>row.questionKey);guard();
        return{bundle,stars,selected,ready:false,wholeBankMaterialized:false};
      });
    },
    startBank: (content, options={}) => {const captured=ownedWriteInput({content,options});return enqueue(() => startBank(captured.content,captured.options));},
    startBanks: (entries, options={}) => {const captured=ownedWriteInput({entries,options});return enqueue(() => startBank(captured.entries,captured.options));},
    saveDraft: value => command('saveDraft', value), submit: value => command('submit', value), redo: value => command('redo', value), hint: value => command('hint', value), finalize: value => command('finalize', value), savePosition: value => command('savePosition', value),
    restartInheritedDraft: value => command('restartInheritedDraft', value),
    forkHistory(value, { isCurrent: operationCurrent = () => true } = {}) {
      const captured=snapshot(value);
      const operationGuard=()=>{guard();if(!operationCurrent())throw fail('STALE_REQUEST');};
      return enqueue(async()=>{
        await ownAttempt(id(),operationGuard);
        const result=await repository.forkAttempt({...captured,commandId:id(),attemptId,lease},{isCurrent:operationCurrent});operationGuard();
        const bundle=await repository.resumeAttempt(attemptId);operationGuard();
        const stars=(await repository.readRecords('user_state')).filter(row=>row.field==='starred'&&row.value).map(row=>row.questionKey);
        return {...result,bundle,stars};
      });
    },
    continueSnapshotHistory(snapshotId,{isCurrent:operationCurrent=()=>true,confirmCloud}={}){
      guard();const key='snapshot:'+snapshotId;if(continuations.has(key))return continuations.get(key);
      const operationGuard=()=>{guard();if(!operationCurrent())throw fail('STALE_REQUEST');};
      const result=enqueue(async()=>{operationGuard();const plan=await repository.prepareSnapshotContinuation(snapshotId,{allowForeign:true});operationGuard();if(!plan.existing){await repository.authorizeSnapshotContinuation({isCurrent:()=>{operationGuard();return true;}});operationGuard();}if(plan.existing){const stream=await repository.initializeStream();operationGuard();if(plan.existing.attempt.writerStreamId!==stream.clientStreamId){const continued=await continueSelected(plan.attemptId,operationGuard,operationCurrent,confirmCloud);return {...continued,baselineEntry:plan.entry};}if(plan.existing.attempt.status!=='active')throw fail('CONTINUATION_COMPLETED');}await ownAttempt(plan.attemptId,operationGuard);operationGuard();await repository.createSnapshotContinuation({snapshotId,attemptId,commandId:plan.commandId,lease},{isCurrent:operationCurrent});operationGuard();const bundle=await repository.resumeAttempt(attemptId);operationGuard();const stars=(await repository.readRecords('user_state')).filter(row=>row.field==='starred'&&row.value).map(row=>row.questionKey);operationGuard();return {bundle,stars,baselineEntry:plan.entry};});
      continuations.set(key,result);result.finally(()=>{if(continuations.get(key)===result)continuations.delete(key);}).catch(()=>{});return result;
    },
    continueHistory(selectedId, { isCurrent: operationCurrent = () => true, confirmCloud } = {}) {
      guard();
      if (continuations.has(selectedId)) return continuations.get(selectedId);
      const operationGuard = () => { guard(); if (!operationCurrent()) throw fail('STALE_REQUEST'); };
      const result = enqueue(async () => {
        return continueSelected(selectedId,operationGuard,operationCurrent,confirmCloud);
      });
      continuations.set(selectedId, result);
      result.finally(() => { if (continuations.get(selectedId) === result) continuations.delete(selectedId); }).catch(() => {});
      return result;
    },
    setStar(value) { const captured = snapshot(value); return enqueue(() => repository.setStar({ ...captured, commandId: id(), lease })); },
    async starConflicts(){await queue;guard();const views=await repository.listStarConflicts();guard();return views;},
    async starConflictGroups(){await queue;guard();const views=await repository.listStarConflictGroups();guard();return views;},
    resolveStarConflict(value){const captured=snapshot(value);return enqueue(()=>repository.resolveStarConflict({...captured,commandId:id(),lease}));},
    resolveStarConflictGroup(value){const captured=snapshot(value);return enqueue(()=>repository.resolveStarConflictGroup({...captured,commandId:id(),lease}));},
    async history({includeSnapshots=false}={}) {
      await queue;guard();
      const stream=await repository.initializeStream(),outbox=await repository.readRecords('outbox');guard();
      const attempts=await Promise.all((await repository.readRecords('attempts')).map(async row=>{const bundle=await repository.readAttempt(row.attemptId);return {...bundle,device:row.writerStreamId===stream.clientStreamId?'local':'foreign',syncPending:outbox.some(intent=>intent.entityKey===`attempt:${row.attemptId}`)};}));guard();
      const imported=includeSnapshots?await Promise.all((await repository.readRecords('history_snapshots')).map(row=>repository.readHistorySnapshot(row.snapshotId))):[];guard();
      return [...attempts,...imported].sort((a,b)=>((b.device==='local')-(a.device==='local'))||(b.kind==='imported_snapshot'?b.body.recordedAt:b.attempt.startedAt)-(a.kind==='imported_snapshot'?a.body.recordedAt:a.attempt.startedAt));
    },
    async loadSnapshotHistory(snapshotId) { await queue;guard();const result=await repository.readHistorySnapshot(snapshotId);guard();return result; },
    async resolveHistorySnapshotQuestion(value) { const input=snapshot(value);await queue;guard();const result=await repository.resolveHistorySnapshotQuestion(input);guard();return result; },
    importHistorySnapshot(body) {
      const captured=snapshot(body);guard();
      if(context.owner?.ownerKind!=='account')throw fail('ACCOUNT_PROFILE_REQUIRED');
      return enqueue(async()=>{
        guard();let importLease;
        try{importLease=await repository.acquireWriter({attemptId:id()});guard();const result=await repository.storeHistorySnapshot({commandId:id(),lease:importLease,body:captured});guard();return result;}
        finally{if(importLease)await repository.releaseWriter({token:importLease});}
      },false);
    },
    async loadHistory(selectedId) { guard(); const bundle = await repository.resumeAttempt(selectedId); guard(); return bundle; },
    async readStoredQuestion(value) {
      const captured=snapshot(value);await queue;guard();
      if(attemptId){const bundle=await repository.readAttempt(attemptId);guard();const matches=ref=>ref.questionKey===captured.questionKey&&ref.questionRevision===captured.questionRevision;if(!bundle.scope.some(ref=>matches(ref)||ref.equivalentSourceRefs.some(matches)))throw fail('QUESTION_NOT_IN_SCOPE');}
      const result=await repository.readRegisteredQuestion(captured);guard();return result;
    },
    async readStoredDisplayCatalog(value){const captured=snapshot(value);await queue;guard();const result=await repository.readRegisteredDisplayCatalog(captured);guard();return result;},
    async storedBanks() { await queue;guard();const rows=await repository.readRecords('bank_revisions');guard();return rows; },
    async readStoredBank(bankUid,revision) { await queue;guard();const result=await repository.readBankContent(bankUid,revision);guard();return result; },
    storeRegisteredBank(content,{staticRef}={}) {
      const captured=snapshot(content);guard();
      return enqueue(async()=>{
        guard();let importLease;
        try{const checked=await validateBankContent(captured);guard();importLease=await repository.acquireWriter({attemptId:id()});guard();const result=await repository.storeBankContent({commandId:id(),lease:importLease,bankUid:checked.content.bankUid,revision:checked.contentDigest,metadata:checked.content.metadata,content:checked.content,...(staticRef?{staticRef}:{})});guard();return result;}
        finally{if(importLease)await repository.releaseWriter({token:importLease});}
      },false);
    },
    async importLegacyBrowserExport(value) {
      guard(); if (context.owner?.ownerKind !== 'account') throw fail('ACCOUNT_PROFILE_REQUIRED');
      const verified = await validateBrowserLearningExport(value); guard();
      const unknownCount = verified.records.filter(row => { try { JSON.parse(row.rawValue); return true; } catch { return false; } }).length;
      const quarantinedCount = verified.records.length - unknownCount;
      return enqueue(async () => {
        guard(); const migrationAttemptId = id(); let importLease;
        try {
          importLease = await repository.acquireWriter({ attemptId: migrationAttemptId }); guard();
          const result = await repository.importLegacyBrowserEvidence({ value: verified, lease: importLease }); guard();
          return { ...result, rawCount: verified.records.length, unknownCount, quarantinedCount };
        } finally { if (importLease) await repository.releaseWriter({ token: importLease }).catch(() => {}); }
      }, false);
    },
    exportBackup() { return enqueue(() => context.exportBackup(), false); },
    async retryCleanup(){await queue;guard();if(lease||attemptId){cleanupOverride=Object.freeze({status:'cleanup-reopen-required',cleanupRequired:true,error:'CLOUD_CLEANUP_REOPEN_REQUIRED'});onCleanup(cleanupOverride);return cleanupOverride;}const result=await context.retryCleanup();guard();cleanupOverride=null;return result;},
    cleanupSnapshot:()=>cleanupOverride||context.cleanupSnapshot(),
    async importBackup(archive) { await queue; guard(); clearInterval(renewal); try { return await context.restoreBackup(archive); } finally { close(); } },
    async recoverCloud(options){await queue;guard();try{const result=await context.recoverCloud(options);close();return result;}catch(error){if(error.recoveryCommitted)close();throw error;}},
    async cleanupDeletedOwner(receipt) { clearInterval(renewal); closed = true; return context.cleanupDeletedOwner(receipt); },
    pauseWriting() { return enqueue(async () => { clearInterval(renewal); renewal = null; if (lease) { await repository.releaseWriter({ token: lease }); lease = null; } }, false); },
    async flush() { await queue; guard();if(lastWriteError)throw lastWriteError; }, close,
    snapshot() { return { owner: context.owner, attemptId, closed, pendingCount, lastCommitted, saved: !failed && !closed && !pendingCount && !lastWriteError && lastCommitted !== null, error: failed?.code || lastWriteError?.code || null }; },
  });
}

/** Stable option IDs and fill field ordinals are the persisted answer format;
 * the template keeps its existing numeric DOM IDs and display positions.
 */
export function answerFromUI(question, state) {
  if (question.type === 'fill') return { kind: 'fill', fields: (state.fillInputs || []).map((value, index) => ({ fieldId: `blank-${index}`, value: String(value ?? '') })) };
  const indices = Array.isArray(question.answers) ? [...(state.selectedSet || [])] : state.selectedIndex === null || state.selectedIndex === undefined ? [] : [state.selectedIndex];
  return { kind: 'choice', selectedOptionIds: indices.map(index => question.optionIds[index]) };
}
export function uiFromDraft(question, draft, latestSubmit) {
  const state = { selectedIndex: null, selectedSet: new Set(), fillInputs: [], submitted: draft?.submitted || false, showKeys: draft?.showKeys || false, assisted: draft?.assisted || false, inheritedFrom: draft?.inheritedFrom || null };
  if (draft?.input.kind === 'fill') state.fillInputs = draft.input.fields.map(field => field.value);
  else if (draft) {
    const indices = draft.input.selectedOptionIds.map(option => question.optionIds.indexOf(option));
    if (indices.some(index => index < 0)) throw fail('OPTION_REVISION_MISMATCH');
    state.selectedSet = new Set(indices); state.selectedIndex = indices[0] ?? null;
  }
  return { ...state, gradeAtTime: latestSubmit?.gradeAtTime || null };
}
