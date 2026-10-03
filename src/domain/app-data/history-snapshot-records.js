import { isQuestionKey, isUuid } from '../question/index.js';
import { AppDataValidationError, canonicalBytes, sha256Hex, utf8ByteLength } from './canonical.js';
import { validateContentReference } from './content-records.js';
import { APP_DATA_LIMITS } from './constants.js';

const DIGEST = /^[0-9a-f]{64}$/;
const MAX_SCOPE = APP_DATA_LIMITS.maxArrayItems;
const fail = (code, path) => { throw new AppDataValidationError(code, path, 'Invalid imported history snapshot'); };
function exact(value, keys, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail('type', path);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.length) fail('fields', path);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !keys.includes(key) || !Object.hasOwn(descriptors[key], 'value') || !descriptors[key].enumerable) fail('fields', path);
  }
  for (const key of keys) if (!Object.hasOwn(value, key)) fail('required', `${path}.${key}`);
  return value;
}
function integer(value, path) { if (!Number.isSafeInteger(value) || value < 0) fail('range', path); return value; }
function text(value, path, max = 128) { if (typeof value !== 'string' || !value.length || utf8ByteLength(value) > max) fail('text', path); return value; }
function uuid(value, path) { if (!isUuid(value)) fail('uuid', path); return value; }
function digest(value, path) { if (typeof value !== 'string' || !DIGEST.test(value)) fail('digest', path); return value; }
function array(value, path, max = MAX_SCOPE) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max) fail('array', path);
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d || !Object.hasOwn(d, 'value') || !d.enumerable) fail('array', path);
  }
  if (Reflect.ownKeys(value).length !== value.length + 1) fail('array', path);
  return value;
}
/** UUIDv8: first 128 SHA-256 bits of the canonical identity tuple, with UUID
 * version/variant bits set. Source bytes/digest are not identity components. */
export async function deriveHistorySnapshotId(accountGeneration, source) {
  uuid(accountGeneration, '$.accountGeneration'); validateHistorySnapshotSource(source);
  const hash = await sha256Hex(canonicalBytes(['qb-history-snapshot-v1', accountGeneration, source.namespace, source.deviceNamespace, source.recordId, source.conversionVersion]));
  const chars = hash.slice(0, 32).split(''); chars[12] = '8'; chars[16] = (8 + (parseInt(chars[16], 16) & 3)).toString(16);
  const s = chars.join(''); return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;
}
export function validateHistorySnapshotSource(value, path = '$.source') {
  const source = exact(value, ['namespace', 'deviceNamespace', 'recordId', 'digest', 'conversionVersion'], path);
  if (source.namespace !== 'legacy_account' && source.namespace !== 'legacy_device') fail('enum', `${path}.namespace`);
  if (source.namespace === 'legacy_account') { if (source.deviceNamespace !== null) fail('invariant', `${path}.deviceNamespace`); }
  else text(source.deviceNamespace, `${path}.deviceNamespace`);
  text(source.recordId, `${path}.recordId`); digest(source.digest, `${path}.digest`);
  if (source.conversionVersion !== 1) fail('version', `${path}.conversionVersion`);
  return source;
}
export function validateHistorySnapshotSummary(value, path = '$.summary') {
  exact(value, ['correct', 'answered', 'total'], path);
  for (const key of ['correct', 'answered', 'total']) integer(value[key], `${path}.${key}`);
  // Legacy answered can count repeated submissions; do not infer <= total.
  return value;
}
function header(record, path) {
  if (record.schemaVersion !== 1) fail('version', `${path}.schemaVersion`);
  uuid(record.snapshotId, `${path}.snapshotId`); uuid(record.accountGeneration, `${path}.accountGeneration`);
  validateHistorySnapshotSource(record.source, `${path}.source`);
  integer(record.recordedAt, `${path}.recordedAt`);
  validateHistorySnapshotSummary(record.summary, `${path}.summary`);
}
export function validateHistorySnapshotPayload(value, path = '$.payload') {
  const record = exact(value, ['schemaVersion', 'snapshotId', 'accountGeneration', 'source', 'recordedAt', 'summary', 'scopeCount', 'reference', 'baseRevision'], path);
  header(record, path); integer(record.scopeCount, `${path}.scopeCount`);
  if (record.scopeCount > MAX_SCOPE || record.baseRevision !== 0) fail('range', path);
  validateContentReference(record.reference, `${path}.reference`);
  if (record.reference.totalBytes > APP_DATA_LIMITS.maxCanonicalUtf8Bytes) fail('utf8_limit', `${path}.reference`);
  canonicalBytes(record);
  return record;
}
export function validateImportedHistorySnapshot(value, path = '$') {
  const record = exact(value, ['schemaVersion', 'type', 'snapshotId', 'accountGeneration', 'source', 'recordedAt', 'summary', 'scope', 'answers'], path);
  header(record, path);
  if (record.type !== 'imported_history_snapshot') fail('enum', `${path}.type`);
  const seen = new Set();
  for (const [i, entry] of array(record.scope, `${path}.scope`).entries()) {
    const p = `${path}.scope[${i}]`;
    exact(entry, ['legacyQuestionId', 'questionKey', 'questionRevision', 'equivalentSourceRefs'], p);
    text(entry.legacyQuestionId, `${p}.legacyQuestionId`);
    if (seen.has(entry.legacyQuestionId)) fail('duplicate', p); seen.add(entry.legacyQuestionId);
    if (!isQuestionKey(entry.questionKey)) fail('question_key', p);
    digest(entry.questionRevision, `${p}.questionRevision`);
    const refs = array(entry.equivalentSourceRefs, `${p}.equivalentSourceRefs`);
    if (!refs.length) fail('range', p);
    let prior = ''; let representative = false;
    for (const ref of refs) {
      exact(ref, ['questionKey', 'questionRevision', 'bankRevision'], p);
      if (!isQuestionKey(ref.questionKey) || ref.questionKey <= prior) fail('order', p);
      prior = ref.questionKey;
      digest(ref.questionRevision, p); digest(ref.bankRevision, p);
      if (ref.questionKey === entry.questionKey && ref.questionRevision === entry.questionRevision) representative = true;
    }
    if (!representative) fail('invariant', p);
  }
  const answers = new Set();
  for (const [i, answer] of array(record.answers, `${path}.answers`).entries()) {
    const p = `${path}.answers[${i}]`;
    exact(answer, ['legacyQuestionId', 'savedInput'], p);
    if (!seen.has(answer.legacyQuestionId) || answers.has(answer.legacyQuestionId)) fail('invariant', p);
    answers.add(answer.legacyQuestionId);
    const input = exact(answer.savedInput, ['selectedIndex', 'selectedSet', 'fillInputs', 'submitted', 'showKeys'], `${p}.savedInput`);
    if (input.selectedIndex !== null) integer(input.selectedIndex, p);
    const selection = new Set();
    for (const n of array(input.selectedSet, p)) { integer(n, p); if (selection.has(n)) fail('duplicate', p); selection.add(n); }
    for (const s of array(input.fillInputs, p)) if (typeof s !== 'string' || utf8ByteLength(s) > 65536) fail('text', p);
    if (typeof input.submitted !== 'boolean' || typeof input.showKeys !== 'boolean') fail('type', p);
  }
  canonicalBytes(record); // Snapshot typed body remains within the 3 MiB semantic budget.
  return record;
}
/** All content consumers must use this binding, not only separate validators. */
export async function validateHistorySnapshotBinding(payload, body, { accountGeneration }) {
  validateHistorySnapshotPayload(payload); validateImportedHistorySnapshot(body); uuid(accountGeneration, '$.accountGeneration');
  if (payload.accountGeneration !== accountGeneration || body.accountGeneration !== accountGeneration) fail('generation', '$');
  for (const field of ['snapshotId', 'recordedAt']) if (payload[field] !== body[field]) fail('binding', `$.${field}`);
  for (const field of ['source', 'summary']) if (new TextDecoder().decode(canonicalBytes(payload[field])) !== new TextDecoder().decode(canonicalBytes(body[field]))) fail('binding', `$.${field}`);
  if (payload.scopeCount !== body.scope.length || payload.snapshotId !== await deriveHistorySnapshotId(accountGeneration, payload.source)) fail('binding', '$');
  const bytes = canonicalBytes(body);
  if (payload.reference.totalBytes !== bytes.byteLength || payload.reference.contentDigest !== await sha256Hex(bytes)) fail('content_digest', '$.reference');
  return body;
}
