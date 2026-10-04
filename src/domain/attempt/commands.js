import { canonicalBytes, canonicalContentBytes, sha256Hex, validateAttemptRecord, validateAttemptScope, validateDraftForAttempt, validateAnswerEvent, validateAnswerInput, validateGradeAtTime, validateResumeState } from '../app-data/index.js';

export const commandError = code => Object.assign(new Error(code), { name: 'LearningCommandError', code });
export const clone = value => structuredClone(value);
const binding = ({ attemptId, parentAttemptId }) => ({ attemptId, ...(parentAttemptId ? { parentAttemptId } : {}) });
export const equal = (a, b) => new TextDecoder().decode(canonicalBytes(a)) === new TextDecoder().decode(canonicalBytes(b));
export function nextRevision(n) { if (!Number.isSafeInteger(n) || n < 0 || n === Number.MAX_SAFE_INTEGER) throw commandError('REVISION_EXHAUSTED'); return n + 1; }
export async function derivedId(commandId, name) {
  const digest = await sha256Hex(new TextEncoder().encode(`${commandId}:${name}`));
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}
export function manifestPayload(attempt, baseRevision) {
  const { attemptId, writerStreamId, startedAt, scopeDigest, scopeCount, status, parentAttemptId } = attempt;
  return { schemaVersion: 1, attemptId, writerStreamId, startedAt, scopeDigest, scopeCount, status, baseRevision, ...(parentAttemptId ? { parentAttemptId } : {}) };
}
export async function encodeContent(value) {
  const bytes = canonicalContentBytes(value);
  const contentDigest = await sha256Hex(bytes); const records = []; const chunks = [];
  for (let offset = 0, chunkIndex = 0; offset < bytes.length; offset += 512 * 1024, chunkIndex++) {
    const part = bytes.slice(offset, offset + 512 * 1024);
    records.push({ store: 'content_chunks', value: { contentDigest, chunkIndex, bytes: part } });
    chunks.push({ chunkIndex, byteLength: part.length, sha256: await sha256Hex(part) });
  }
  const manifest = { schemaVersion: 1, contentDigest, chunkCount: chunks.length, totalBytes: bytes.length, chunks };
  const manifestBytes = canonicalBytes(manifest); const manifestDigest = await sha256Hex(manifestBytes);
  records.push({ store: 'content_chunks', value: { contentDigest: manifestDigest, chunkIndex: 0, bytes: manifestBytes } });
  return { records, reference: { contentDigest, manifestDigest, chunkCount: chunks.length, totalBytes: bytes.length }, manifest };
}
export function validateBundle(bundle) {
  if (!bundle.attempt) throw commandError('ATTEMPT_NOT_FOUND');
  validateAttemptRecord(bundle.attempt); validateAttemptScope(bundle.scope, bundle.attempt.attemptId, bundle.attempt.scopeCount);
  const scope = new Map(bundle.scope.map(row => [row.questionKey, row.questionRevision]));
  const draftKeys = new Set();
  bundle.drafts.forEach(draft => {
    validateDraftForAttempt(draft, binding(bundle.attempt));
    if (draftKeys.has(draft.questionKey) || scope.get(draft.questionKey) !== draft.questionRevision || draft.writerStreamId !== bundle.attempt.writerStreamId || draft.localRevision > bundle.attempt.localRevision) throw commandError('CORRUPT_ATTEMPT');
    draftKeys.add(draft.questionKey);
  });
  const ids = new Set(); const actions = new Set();
  bundle.events.forEach(event => {
    validateAnswerEvent(event);
    if (event.attemptId !== bundle.attempt.attemptId || scope.get(event.questionKey) !== event.questionRevision || event.writerStreamId !== bundle.attempt.writerStreamId || ids.has(event.eventId) || actions.has(event.actionSeq)) throw commandError('CORRUPT_ATTEMPT');
    ids.add(event.eventId); actions.add(event.actionSeq);
  });
  if (bundle.events.length !== bundle.attempt.actionSeq || [...actions].sort((a, b) => a - b).some((seq, index) => seq !== index + 1)) throw commandError('CORRUPT_ATTEMPT');
  return bundle;
}
/** Pure state transition. Scoring is supplied before this function and before IDB writes. */
export function transition(bundle, command, lease, nowMs, eventId) {
  validateBundle(bundle);
  const old = bundle.attempt;
  if (old.status !== 'active') throw commandError('ATTEMPT_COMPLETED');
  if (command.expectedRevision !== undefined && command.expectedRevision !== old.localRevision) throw commandError('REVISION_CONFLICT');
  const attempt = { ...old, localRevision: nextRevision(old.localRevision) };
  if (command.position !== undefined) attempt.position = command.position;
  if (command.effectiveElapsedMs !== undefined) {
    if (command.effectiveElapsedMs < old.effectiveElapsedMs) throw commandError('ELAPSED_ROLLBACK');
    attempt.effectiveElapsedMs = command.effectiveElapsedMs;
  }
  const drafts = clone(bundle.drafts); const events = clone(bundle.events); let event; let draft;
  if (command.kind === 'finalize') attempt.status = 'completed';
  else if (command.kind !== 'position') {
    const row = bundle.scope.find(item => item.questionKey === command.questionKey);
    if (!row || row.questionRevision !== command.questionRevision) throw commandError('QUESTION_REVISION_MISMATCH');
    const index = drafts.findIndex(item => item.questionKey === row.questionKey);
    const prior = drafts[index];
    if (!prior && !command.input) throw commandError('DRAFT_REQUIRED');
    const input = clone(command.input ?? prior.input); validateAnswerInput(input);
    draft = { ...(prior || {}), attemptId: old.attemptId, questionKey: row.questionKey, questionRevision: row.questionRevision, input,
      localRevision: attempt.localRevision, dirty: false, submitted: prior?.submitted || false, showKeys: prior?.showKeys || false, assisted: prior?.assisted || false,
      writerStreamId: old.writerStreamId, fence: lease.fence };
    if(command.kind==='restartInherited'){
      if(!prior?.inheritedFrom)throw commandError('INHERITED_DRAFT_REQUIRED');
      delete draft.inheritedFrom;draft.submitted=false;
    }else if (command.kind === 'draft') {
      if(prior?.inheritedFrom)throw commandError('INHERITED_RESTART_REQUIRED');
      if (draft.submitted) throw commandError('ANSWER_IMMUTABLE');
    } else {
      attempt.actionSeq = nextRevision(old.actionSeq);
      event = { eventId, attemptId: old.attemptId, questionKey: row.questionKey, writerStreamId: old.writerStreamId, actionSeq: attempt.actionSeq,
        occurredAt: nowMs, questionRevision: row.questionRevision, assisted: draft.assisted };
      if (command.kind === 'submit') {
        if(prior?.inheritedFrom)throw commandError('INHERITED_RESTART_REQUIRED');
        if (draft.submitted) throw commandError('ALREADY_SUBMITTED');
        if (input.kind === 'choice' && !input.selectedOptionIds.length) throw commandError('ANSWER_REQUIRED');
        if (input.kind === 'fill' && (!input.fields.length || input.fields.some(field => !field.value.trim()))) throw commandError('ANSWER_REQUIRED');
        validateGradeAtTime(command.gradeAtTime);
        event = { ...event, kind: 'answer_submitted', answer: input, gradeAtTime: clone(command.gradeAtTime), graderVersion: command.graderVersion, gradingBasisDigest: command.gradingBasisDigest };
        draft.submitted = true;
      } else if (command.kind === 'redo') {
        const previous = events.filter(item => item.questionKey === row.questionKey && item.kind === 'answer_submitted').at(-1);
        if (!draft.submitted || !previous) throw commandError('SUBMITTED_ANSWER_REQUIRED');
        if (command.redoOfEventId && command.redoOfEventId !== previous.eventId) throw commandError('REDO_TARGET_MISMATCH');
        event = { ...event, kind: 'redo', redoOfEventId: previous.eventId };
        draft.submitted = false; draft.showKeys = false;
      } else if (command.kind === 'hint') {
        draft.assisted = true; draft.showKeys = true;
        event = { ...event, kind: 'hint', assisted: true, hintKind: command.hintKind || 'reveal' };
      } else throw commandError('INVALID_COMMAND');
      validateAnswerEvent(event); events.push(event);
    }
    validateDraftForAttempt(draft, binding(attempt));
    if (index < 0) drafts.push(draft); else drafts[index] = draft;
  }
  validateAttemptRecord(attempt);
  return { attempt, scope: bundle.scope, drafts, events, event, draft, ...(bundle.snapshotBaseline ? {snapshotBaseline: clone(bundle.snapshotBaseline)} : {}) };
}
export function resumeState(bundle, baseRevision = 0) {
  const state = { schemaVersion: bundle.snapshotBaseline ? 2 : 1, ...(bundle.snapshotBaseline ? {snapshotBaseline: clone(bundle.snapshotBaseline)} : {}), attemptId: bundle.attempt.attemptId, writerStreamId: bundle.attempt.writerStreamId, localRevision: bundle.attempt.localRevision,
    baseRevision, scopeDigest: bundle.attempt.scopeDigest, questionDrafts: [...bundle.drafts].sort((a,b)=>a.questionKey<b.questionKey?-1:a.questionKey>b.questionKey?1:0).map(({ attemptId, writerStreamId, fence, dirty, ...draft }) => draft),
    submittedEventIds: [...bundle.events].sort((a,b)=>a.actionSeq-b.actionSeq).filter(event => event.kind === 'answer_submitted').map(event => event.eventId), position: bundle.attempt.position,
    effectiveElapsedMs: bundle.attempt.effectiveElapsedMs, scope: bundle.scope };
  validateResumeState(state); return state;
}
/** First submission, assisted work and redo submissions are separate facts. */
export function projectProgress(events) {
  const first = new Set(); const result = { firstAnswered: 0, firstCorrect: 0, assistedAnswers: 0, redoAnswers: 0, wrongQuestionKeys: [] };
  const latest = new Map();
  for (const event of [...events].sort((a, b) => a.actionSeq - b.actionSeq)) {
    if (event.kind !== 'answer_submitted') continue;
    if (first.has(event.questionKey)) result.redoAnswers++;
    else { first.add(event.questionKey); if (!event.assisted) { result.firstAnswered++; if (event.gradeAtTime.status === 'graded' && event.gradeAtTime.correct) result.firstCorrect++; } }
    if (event.assisted) result.assistedAnswers++;
    latest.set(event.questionKey, event);
  }
  result.wrongQuestionKeys = [...latest].filter(([, event]) => event.gradeAtTime.status === 'graded' && !event.gradeAtTime.correct).map(([key]) => key);
  return result;
}
