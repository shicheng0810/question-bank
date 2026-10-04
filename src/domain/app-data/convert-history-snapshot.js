import { canonicalContentBytes, sha256Hex } from './canonical.js';
import { validateBankContent } from '../question/bank-content.js';
import { dedupeLegacyQuestionBank } from '../question/legacy-runtime-identity.js';
import { deriveHistorySnapshotId, validateHistorySnapshotSource, validateImportedHistorySnapshot } from './history-snapshot-records.js';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const freeze = value => { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; };

/** Pure conversion only: never writes storage, creates events, or deletes source.
 * legacyDedupe is the actual frozen legacy runtime deduper, not a replacement
 * positional matcher. Bank array order must be the original selected order.
 * Verified source bytes are rechecked independently at this boundary.
 */
export async function convertVerifiedHistorySnapshot({ verifiedSource, source, accountGeneration, bankContents, legacyDedupe = dedupeLegacyQuestionBank }) {
  validateHistorySnapshotSource(source);
  if (typeof verifiedSource?.rawJson !== 'string' || typeof legacyDedupe !== 'function' || !Array.isArray(bankContents) || !bankContents.length) fail('HISTORY_SOURCE_INVALID');
  const bytes = new TextEncoder().encode(verifiedSource.rawJson);
  if (bytes.length > 3 * 1024 * 1024 || bytes.length !== verifiedSource.byteLength || await sha256Hex(bytes) !== source.digest || verifiedSource.sha256 !== source.digest) fail('HISTORY_SOURCE_DIGEST_MISMATCH');
  let snapshot; try { snapshot = JSON.parse(verifiedSource.rawJson); } catch { fail('HISTORY_SOURCE_INVALID'); }
  if (!snapshot || snapshot.id !== source.recordId || verifiedSource.sourceKey !== `history:${source.recordId}` || !Array.isArray(snapshot.scope) || !snapshot.state || typeof snapshot.state !== 'object' || Array.isArray(snapshot.state)) fail('HISTORY_SOURCE_INVALID');
  if (snapshot.scope.length > 5000) fail('HISTORY_SCOPE_LIMIT');
  const questions = [], refs = new Map();
  for (const bank of bankContents) {
    const checked = await validateBankContent(bank);
    for (const q of checked.content.questions) {
      if (refs.has(q.questionKey)) fail('HISTORY_MAPPING_AMBIGUOUS');
      refs.set(q.questionKey, { questionKey:q.questionKey, questionRevision:q.questionRevision, bankRevision:checked.contentDigest });
      questions.push({ ...structuredClone(q), id:q.questionKey });
    }
  }
  const deduped = legacyDedupe(questions);
  if (!Array.isArray(deduped?.bank) || !deduped.alias) fail('HISTORY_MAPPING_INVALID');
  const groups = new Map();
  for (const q of questions) {
    const canonicalId = deduped.alias[q.questionKey];
    if (typeof canonicalId !== 'string') fail('HISTORY_MAPPING_INVALID');
    const group = groups.get(canonicalId) || [];
    group.push(q); groups.set(canonicalId, group);
  }
  const scope = [], ids = new Set();
  for (const id of snapshot.scope) {
    if (typeof id !== 'string' || ids.has(id)) fail('HISTORY_MAPPING_AMBIGUOUS'); ids.add(id);
    const group = groups.get(id);
    if (!group?.length) fail('HISTORY_MAPPING_MISSING');
    // Compare complete grading-relevant source semantics as well as ordered
    // choices. A hash match alone cannot prove collision-free input meaning.
    const signature = q => new TextDecoder().decode(canonicalContentBytes([q.question, q.question_html || null, q.type || null, q.choices || [], q.blanks || [], q.answer ?? null, q.answers || [], q.image || null, q.passage || null, q.section || null, q.explanation || null]));
    if (group.some(q => signature(q) !== signature(group[0]))) fail('HISTORY_MAPPING_AMBIGUOUS');
    const primary = group[0];
    scope.push({ legacyQuestionId:id, questionKey:primary.questionKey, questionRevision:primary.questionRevision,
      equivalentSourceRefs:group.map(q => refs.get(q.questionKey)).sort((a,b)=>a.questionKey.localeCompare(b.questionKey)) });
  }
  const answers = [];
  for (const [id, state] of Object.entries(snapshot.state)) {
    if (!ids.has(id)) fail('HISTORY_MAPPING_MISSING');
    if (!state || typeof state !== 'object' || Array.isArray(state)) fail('HISTORY_INPUT_INVALID');
    const choices = groups.get(id)[0].choices || [];
    const validIndex = n => Number.isSafeInteger(n) && n >= 0 && n < choices.length;
    if (state.selectedIndex != null && !validIndex(state.selectedIndex)) fail('HISTORY_INPUT_INVALID');
    if (state.selectedSet !== undefined && (!Array.isArray(state.selectedSet) || state.selectedSet.some(n => !validIndex(n)))) fail('HISTORY_INPUT_INVALID');
    answers.push({legacyQuestionId:id,savedInput:{selectedIndex:state.selectedIndex ?? null,
      selectedSet:state.selectedSet === undefined ? [] : structuredClone(state.selectedSet),
      fillInputs:state.fillInputs === undefined ? [] : structuredClone(state.fillInputs),
      submitted:state.submitted === undefined ? false : state.submitted,
      showKeys:state.showKeys === undefined ? false : state.showKeys}});
  }
  const body = {schemaVersion:1,type:'imported_history_snapshot',snapshotId:await deriveHistorySnapshotId(accountGeneration,source),accountGeneration,
    source:structuredClone(source),recordedAt:snapshot.ts,summary:structuredClone(snapshot.score),scope,answers};
  validateImportedHistorySnapshot(body);
  return freeze(body);
}
