import { canonicalBytes, canonicalContentBytes, sha256Hex, AppDataValidationError } from './canonical.js';
import { validateContentReference } from './content-records.js';
import { validateHistorySnapshotBinding, validateImportedHistorySnapshot } from './history-snapshot-records.js';
import { validateAnswerInput } from './core-records.js';
import { isUuid } from '../question/index.js';

/** @typedef {import('./contracts').UUID} UUID */
/** @typedef {import('./contracts').SnapshotContinuationBaseline} Baseline */
/** @typedef {import('./contracts').SnapshotContinuationReceipt} Receipt */
/** @typedef {import('./contracts').ImportedHistorySnapshot} Snapshot */
/** @typedef {Snapshot['answers'][number]['savedInput']} SavedInput */
/** @typedef {import('./contracts').AnswerInput} AnswerInput */
/** @typedef {{questionKey:string, questionRevision:string, type:'choice'|'fill', choices:unknown[], optionIds:string[], blanks:unknown[]}} QuestionInputShape */
/** @typedef {{status:'snapshot_baseline_verified', baseline:Baseline}} BaselineProof */
/** @typedef {{baseline:Baseline, body:Snapshot, inputs:Map<string,AnswerInput>}} CapturedProof */
/** @typedef {{owner:{ownerKind:string,accountGeneration?:string}, readSnapshot:(id:UUID)=>Promise<{record:unknown,body:unknown}|null|undefined>, resolveQuestion:(ref:import('./contracts').HistorySnapshotSourceRef)=>Promise<unknown>, isTombstoned:(kind:'bank'|'history_snapshot',id:string)=>Promise<boolean>}} BaselineContext */

/** @param {string} code @returns {never} */
const fail = code => { throw new AppDataValidationError(code, '$.snapshotBaseline', 'Invalid snapshot continuation'); };
/** @param {unknown} a @param {unknown} b @returns {boolean} */
const same = (a, b) => new TextDecoder().decode(canonicalBytes(a)) === new TextDecoder().decode(canonicalBytes(b));
/** @type {WeakMap<object,CapturedProof>} */
const proofs = new WeakMap();

/** @param {unknown} value @param {readonly string[]} keys @returns {Record<string,unknown>} */
function exact(value, keys) {
  canonicalBytes(value);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail('snapshot_fields');
  const record = /** @type {Record<string,unknown>} */ (value);
  if (Object.keys(record).sort().join() !== [...keys].sort().join()) fail('snapshot_fields');
  return record;
}
/** @param {unknown} value @returns {UUID} */
function uuid(value) {
  if (!isUuid(value)) fail('snapshot_identity');
  return /** @type {UUID} */ (value);
}
/** @param {unknown} value @returns {string} */
function digest(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) fail('snapshot_identity');
  return value;
}
/** @param {unknown} value @returns {number} */
function integer(value) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail('snapshot_receipt');
  return value;
}
/** Freeze only owned JSON data; this is not a source/authorization proof.
 * @param {unknown} value @returns {void} */
function freezeOwned(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeOwned(child);
    Object.freeze(value);
  }
}
/** @param {unknown} proof @returns {CapturedProof|undefined} */
function capturedProof(proof) {
  return proof !== null && typeof proof === 'object' ? proofs.get(proof) : undefined;
}
/** @param {unknown} value @returns {Baseline} */
export function validateSnapshotBaselineShape(value) {
  const record = exact(value, ['format', 'accountGeneration', 'snapshotId', 'snapshotReference', 'continuationKey']);
  if (record.format !== 'qb-snapshot-baseline-v1') fail('snapshot_baseline');
  return {
    format: record.format,
    accountGeneration: uuid(record.accountGeneration),
    snapshotId: uuid(record.snapshotId),
    snapshotReference: validateContentReference(record.snapshotReference),
    continuationKey: digest(record.continuationKey)
  };
}
/** @param {unknown} generation @param {unknown} snapshotId @param {unknown} contentDigest @returns {Promise<string>} */
export async function deriveSnapshotContinuationKey(generation, snapshotId, contentDigest) {
  return sha256Hex(canonicalBytes(['qb-snapshot-continue-v1', uuid(generation), uuid(snapshotId), digest(contentDigest)]));
}
/** Read only input-relevant fields from a question already proved by the bank
 * resolver. This does not claim that these fields authenticate a bank body.
 * @param {unknown} value @returns {QuestionInputShape} */
function questionInputShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail('snapshot_question_dependency');
  const record = /** @type {Record<string,unknown>} */ (value);
  for (const key of ['questionKey', 'questionRevision', 'type', 'choices', 'optionIds', 'blanks']) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor && (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable)) fail('snapshot_question_dependency');
  }
  if (typeof record.questionKey !== 'string' || typeof record.questionRevision !== 'string') fail('snapshot_question_dependency');
  const type = record.type ?? 'choice', choices = record.choices ?? [], ids = record.optionIds ?? [], blanks = record.blanks ?? [];
  if (type !== 'choice' && type !== 'fill') fail('snapshot_input');
  if (!Array.isArray(choices) || !Array.isArray(ids) || !Array.isArray(blanks)) fail('snapshot_input');
  const optionIds = validateAnswerInput({kind: 'choice', selectedOptionIds: ids});
  if (optionIds.kind !== 'choice') fail('snapshot_input');
  return {questionKey: record.questionKey, questionRevision: record.questionRevision, type, choices, optionIds: optionIds.selectedOptionIds, blanks};
}
/** Saved input is evidence; it never creates a submission or hint event.
 * @param {SavedInput} saved @param {unknown} question @returns {AnswerInput} */
export function snapshotPrefillInput(saved, question) {
  const q = questionInputShape(question), choices = q.choices, ids = q.optionIds;
  if (saved.selectedIndex !== null && (!Number.isSafeInteger(saved.selectedIndex) || saved.selectedIndex < 0 || saved.selectedIndex >= choices.length)
      || saved.selectedSet.some(n => !Number.isSafeInteger(n) || n < 0 || n >= choices.length)) fail('snapshot_input');
  if (q.type === 'fill') {
    if (saved.selectedIndex !== null || saved.selectedSet.length || saved.fillInputs.length > q.blanks.length) fail('snapshot_input');
    return validateAnswerInput({kind: 'fill', fields: saved.fillInputs.map((value, index) => ({fieldId: `blank-${index}`, value}))});
  }
  if (saved.fillInputs.length || ids.length !== choices.length) fail('snapshot_input');
  const indexes = saved.selectedSet.length ? saved.selectedSet : saved.selectedIndex === null ? [] : [saved.selectedIndex];
  return validateAnswerInput({kind: 'choice', selectedOptionIds: indexes.map(index => {
    const optionId = ids[index];
    if (optionId === undefined) fail('snapshot_input');
    return optionId;
  })});
}
/** Callbacks close over authenticated storage and resolve every immutable
 * equivalent reference. Receipts are not authority.
 * @param {unknown} baseline @param {BaselineContext} context @returns {Promise<BaselineProof>} */
export async function validateSnapshotContinuationBaseline(baseline, {owner, readSnapshot, resolveQuestion, isTombstoned}) {
  const checkedBaseline = validateSnapshotBaselineShape(baseline);
  const owned = validateSnapshotBaselineShape(/** @type {unknown} */ (JSON.parse(new TextDecoder().decode(canonicalBytes(checkedBaseline)))));
  if (owner.ownerKind !== 'account' || owner.accountGeneration !== owned.accountGeneration) fail('snapshot_owner');
  if (typeof readSnapshot !== 'function' || typeof resolveQuestion !== 'function' || typeof isTombstoned !== 'function') fail('snapshot_missing_dependency');
  if (await isTombstoned('history_snapshot', owned.snapshotId)) fail('snapshot_tombstone');
  const snapshot = await readSnapshot(owned.snapshotId);
  if (!snapshot) fail('snapshot_missing_dependency');
  const body = /** @type {Snapshot} */ (await validateHistorySnapshotBinding(snapshot.record, snapshot.body, {accountGeneration: owner.accountGeneration}));
  // The shared binding validator proved the payload and body before this cast.
  const record = /** @type {import('./contracts').HistorySnapshotPayload} */ (snapshot.record);
  if (body.snapshotId !== owned.snapshotId || !same(record.reference, owned.snapshotReference)
      || owned.continuationKey !== await deriveSnapshotContinuationKey(owned.accountGeneration, owned.snapshotId, owned.snapshotReference.contentDigest)) fail('snapshot_binding');
  const captured = /** @type {Snapshot} */ (JSON.parse(new TextDecoder().decode(canonicalBytes(body))));
  validateImportedHistorySnapshot(captured);
  /** @type {Map<string,AnswerInput>} */
  const inputs = new Map();
  for (const row of captured.scope) {
    /** @type {QuestionInputShape|undefined} */
    let representative;
    for (const ref of row.equivalentSourceRefs) {
      const bankUid = ref.questionKey.split('/')[0];
      if (bankUid === undefined) fail('snapshot_question_dependency');
      if (await isTombstoned('bank', bankUid)) fail('snapshot_tombstone');
      const q = questionInputShape(await resolveQuestion(ref));
      if (q.questionKey !== ref.questionKey || q.questionRevision !== ref.questionRevision) fail('snapshot_question_dependency');
      if (ref.questionKey === row.questionKey) representative = q;
    }
    if (representative === undefined) fail('snapshot_question_dependency');
    const answer = captured.answers.find(answer => answer.legacyQuestionId === row.legacyQuestionId);
    if (answer) inputs.set(row.questionKey, snapshotPrefillInput(answer.savedInput, representative));
  }
  freezeOwned(owned);
  /** @type {BaselineProof} */
  const proof = Object.freeze({status: 'snapshot_baseline_verified', baseline: owned});
  proofs.set(proof, {baseline: owned, body: captured, inputs});
  return proof;
}
/** @param {import('./contracts').ResumeState} state @param {unknown} proof @returns {unknown} */
export function assertSnapshotContinuationState(state, proof) {
  canonicalContentBytes(state);
  const checked = capturedProof(proof);
  if (!checked || !same(state.snapshotBaseline, checked.baseline)) fail('snapshot_missing_dependency');
  if (state.scope.length !== checked.body.scope.length) fail('snapshot_scope');
  for (const [index, row] of state.scope.entries()) assertSnapshotContinuationScope(row, index, proof);
  for (const draft of state.questionDrafts) assertSnapshotContinuationDraft(draft, state.localRevision, proof);
  if (state.localRevision === 1 && (state.submittedEventIds.length || state.questionDrafts.length !== checked.inputs.size)) fail('snapshot_initial_events');
  return proof;
}
/** @param {unknown} value @returns {Receipt} */
export function validateSnapshotContinuationReceipt(value) {
  const record = exact(value, ['sourceId', 'sourceRecordId', 'provenance', 'importedAt']);
  const p = exact(record.provenance, ['format', 'generation', 'snapshotId', 'snapshotContentDigest', 'attemptId', 'commandId']);
  if (p.format !== 'qb-snapshot-continuation-receipt-v1' || record.sourceId !== p.format) fail('snapshot_receipt');
  return {sourceId: p.format, sourceRecordId: digest(record.sourceRecordId), importedAt: integer(record.importedAt), provenance: {
    format: p.format, generation: uuid(p.generation), snapshotId: uuid(p.snapshotId), snapshotContentDigest: digest(p.snapshotContentDigest),
    attemptId: uuid(p.attemptId), commandId: uuid(p.commandId)
  }};
}
/** @param {unknown} value @param {unknown} baseline @param {{attemptId:UUID,commandId:UUID}} expected @returns {Promise<Receipt>} */
export async function assertSnapshotContinuationReceipt(value, baseline, {attemptId, commandId}) {
  const receipt = validateSnapshotContinuationReceipt(value), b = validateSnapshotBaselineShape(baseline), p = receipt.provenance;
  if (receipt.sourceRecordId !== b.continuationKey || receipt.sourceRecordId !== await deriveSnapshotContinuationKey(p.generation, p.snapshotId, p.snapshotContentDigest)
      || p.generation !== b.accountGeneration || p.snapshotId !== b.snapshotId || p.snapshotContentDigest !== b.snapshotReference.contentDigest
      || p.attemptId !== attemptId || p.commandId !== commandId || p.commandId !== await deriveSnapshotContinuationCommandId(b.continuationKey)) fail('snapshot_receipt_binding');
  return receipt;
}
/** @param {import('./contracts').AttemptScopeRecord} row @param {number} index @param {unknown} proof @returns {void} */
export function assertSnapshotContinuationScope(row, index, proof) {
  const checked = capturedProof(proof), source = checked?.body.scope[index];
  if (!source || row.ordinal !== index || row.displayOrdinal !== index || row.questionKey !== source.questionKey || row.questionRevision !== source.questionRevision
      || !same(row.equivalentSourceRefs, source.equivalentSourceRefs.map(({bankRevision, ...ref}) => ref))) fail('snapshot_scope');
}
/** @param {import('./contracts').ResumeDraft} draft @param {number} localRevision @param {unknown} proof @returns {void} */
export function assertSnapshotContinuationDraft(draft, localRevision, proof) {
  const checked = capturedProof(proof);
  if (!checked) fail('snapshot_missing_dependency');
  const source = checked.body.scope.find(row => row.questionKey === draft.questionKey);
  const answer = checked.body.answers.find(answer => answer.legacyQuestionId === source?.legacyQuestionId);
  if (!source || draft.inheritedFrom) fail('snapshot_native_parent');
  if (answer?.savedInput.showKeys && (!draft.assisted || localRevision === 1 && !draft.showKeys)) fail('snapshot_assistance_downgrade');
  if (localRevision === 1 && (draft.submitted || !same(draft.input, checked.inputs.get(draft.questionKey)))) fail('snapshot_initial_draft');
}
/** @param {unknown} proof @returns {{scope:number,drafts:number}} */
export function snapshotContinuationCounts(proof) {
  const checked = capturedProof(proof);
  if (!checked) fail('snapshot_missing_dependency');
  return {scope: checked.body.scope.length, drafts: checked.inputs.size};
}
/** @param {string} tag @param {unknown} key @returns {Promise<UUID>} */
async function continuationUuid(tag, key) {
  const hex = (await sha256Hex(canonicalBytes([tag, digest(key)]))).slice(0, 32);
  if (!/^[0-9a-f]{32}$/.test(hex)) fail('snapshot_identity');
  // charAt has a string result, and the length/hex guard establishes this nibble.
  const variant = (8 + (parseInt(hex.charAt(16), 16) & 3)).toString(16);
  return uuid(`${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-${variant}${hex.slice(17,20)}-${hex.slice(20)}`);
}
/** Deterministic identity grants neither CAS nor writer ownership.
 * @param {unknown} key @returns {Promise<UUID>} */
export async function deriveSnapshotContinuationCommandId(key) {
  return continuationUuid('qb-snapshot-continuation-command-v1', key);
}
/** @param {unknown} proof @param {{attemptId:UUID,importedAt:number}} input @returns {Promise<Receipt>} */
export async function rebuildSnapshotContinuationReceipt(proof, {attemptId, importedAt}) {
  const checked = capturedProof(proof);
  if (!checked) fail('snapshot_missing_dependency');
  const b = checked.baseline, commandId = await deriveSnapshotContinuationCommandId(b.continuationKey);
  return validateSnapshotContinuationReceipt({sourceId: 'qb-snapshot-continuation-receipt-v1', sourceRecordId: b.continuationKey, importedAt, provenance: {
    format: 'qb-snapshot-continuation-receipt-v1', generation: b.accountGeneration, snapshotId: b.snapshotId,
    snapshotContentDigest: b.snapshotReference.contentDigest, attemptId, commandId
  }});
}
/** @param {unknown} key @returns {Promise<UUID>} */
export async function deriveSnapshotContinuationAttemptId(key) {
  return continuationUuid('qb-snapshot-continuation-attempt-v1', key);
}
/** @param {unknown} proof @returns {string|undefined} */
export function snapshotContinuationProofKey(proof) {
  return capturedProof(proof)?.baseline.continuationKey;
}
