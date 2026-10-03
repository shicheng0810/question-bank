import { canonicalContentBytes, canonicalBytes, sha256Hex, AppDataValidationError } from '../app-data/canonical.js';
import { validateBankMetadata } from '../app-data/content-records.js';
import { isUuid, isQuestionKey } from './index.js';
import { deriveContent } from './content-identity.js';

/** @typedef {Record<string,unknown> & {bankUid:string,questionUid:string,questionKey:string,questionRevision:string,optionIds:string[]}} RegisteredQuestionContent */
/** @typedef {{format:'qb-bank-content-v2',schemaVersion:1,bankUid:string,metadata:import('../app-data/contracts').BankMetadata,questions:RegisteredQuestionContent[]}} RegisteredBankContent */
/** @typedef {{format:'qb-protected-bank-envelope-v2',version:2,bankUid:string,cipher:'AES-GCM-256',compression:'none',indexDigest:string,questionRefs:import('../app-data/contracts').EquivalentSourceRef[],kdf:{name:'PBKDF2',hash:'SHA-256',iterations:number},salt_b64:string,iv_b64:string,ciphertext_b64:string}} ProtectedBankEnvelopeV2 */
/** @param {string} code @param {string} path @param {string} message @returns {never} */
const fail = (code, path, message) => { throw new AppDataValidationError(code, path, message); };

/** New registered bank body only; never interprets legacy numeric IDs.
 * Captures all JSON before the first await. Unknown safe question content
 * fields are preserved and participate in deriveContent's frozen revision.
 * @param {unknown} input
 * @returns {Promise<{content:RegisteredBankContent,bytes:Uint8Array,contentDigest:string,questionRefs:import('../app-data/contracts').EquivalentSourceRef[]}>}
 */
export async function validateBankContent(input) {
  const bytes = canonicalContentBytes(input);
  const content = JSON.parse(new TextDecoder().decode(bytes));
  if (!content || Array.isArray(content) || Object.keys(content).sort().join(',') !== 'bankUid,format,metadata,questions,schemaVersion'
    || content.format !== 'qb-bank-content-v2' || content.schemaVersion !== 1 || !isUuid(content.bankUid)) fail('bank_content', '$', 'invalid registered bank wrapper');
  const metadata = validateBankMetadata(content.metadata);
  if (metadata.visibility === 'protected') fail('protected_plaintext', '$.metadata.visibility', 'protected content accepts ciphertext only');
  if (!Array.isArray(content.questions) || content.questions.length !== metadata.questionCount || content.questions.length > 5000) fail('bank_content', '$.questions', 'question count does not match bounded metadata');
  if (metadata.visibility === 'private' && bytes.byteLength > 3 * 1024 * 1024) fail('bank_content_limit', '$', 'private bank exceeds 3 MiB');
  const keys = new Set(); const questionRefs = [];
  for (let i = 0; i < content.questions.length; i++) {
    const q = content.questions[i]; const path = `$.questions[${i}]`;
    if (!q || Array.isArray(q) || q.bankUid !== content.bankUid || !isUuid(q.questionUid) || !isQuestionKey(q.questionKey)
      || q.questionKey !== `${content.bankUid}/${q.questionUid}` || keys.has(q.questionKey)) fail('registered_identity', path, 'invalid or duplicate registered question identity');
    if (q.type !== undefined && !['choice', 'fill'].includes(q.type)) fail('unsupported_type', path, 'only registered choice/fill content is supported');
    keys.add(q.questionKey);
    const derived = await deriveContent(q);
    if (q.questionRevision !== derived.questionRevision || !Array.isArray(q.optionIds)
      || q.optionIds.length !== derived.optionIds.length || q.optionIds.some((/** @type {unknown} */id, /** @type {number} */index) => id !== derived.optionIds[index])) fail('question_revision', path, 'registered content revision/options do not match complete content');
    questionRefs.push({ questionKey: q.questionKey, questionRevision: q.questionRevision });
  }
  return { content, bytes, contentDigest: await sha256Hex(bytes), questionRefs };
}

/** Shape-only ciphertext envelope validation; does not decrypt or claim that
 * the password works. Rejects plaintext fields and unsupported pack formats.
 * @param {unknown} input
 */
export function validateProtectedBankEnvelope(input) {
  const bytes = canonicalContentBytes(input);
  const value = JSON.parse(new TextDecoder().decode(bytes));
  if (!value || Object.keys(value).sort().join(',') !== 'cipher,ciphertext_b64,compression,format,iv_b64,kdf,salt_b64'
    || value.format !== 'qbpack-v1' || value.cipher !== 'AES-GCM-256' || !['gzip', 'none'].includes(value.compression)
    || !value.kdf || Object.keys(value.kdf).sort().join(',') !== 'hash,iterations,name' || value.kdf.name !== 'PBKDF2' || value.kdf.hash !== 'SHA-256'
    || !Number.isSafeInteger(value.kdf.iterations) || value.kdf.iterations < 1) fail('protected_cipher', '$', 'invalid ciphertext envelope');
  for (const [key, length] of /** @type {[string,number|null][]} */([['salt_b64', 16], ['iv_b64', 12], ['ciphertext_b64', null]])) {
    if (typeof value[key] !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value[key])) fail('protected_cipher', `$.${key}`, 'invalid base64');
    const decoded = atob(value[key]);
    if ((length !== null && decoded.length !== length) || (length === null && decoded.length < 16)) fail('protected_cipher', `$.${key}`, 'invalid cryptographic field length');
  }
  return value;
}

export const PROTECTED_BANK_V2_FORMAT = 'qb-protected-bank-envelope-v2';
/** @param {{bankUid:unknown,indexDigest:unknown}} envelope @returns {Uint8Array} */
export function protectedBankV2Aad(envelope) {
  return canonicalBytes({ format: PROTECTED_BANK_V2_FORMAT, version: 2, bankUid: envelope.bankUid, indexDigest: envelope.indexDigest });
}

/** Authenticated owner's declared encrypted index, NOT server plaintext proof.
 * Capture the whole bounded envelope before digest awaits. Browser decryption
 * must independently verify every registered question against this index.
 * @param {unknown} input
 * @returns {Promise<{envelope:ProtectedBankEnvelopeV2,bytes:Uint8Array,contentDigest:string,questionRefs:import('../app-data/contracts').EquivalentSourceRef[],aad:Uint8Array,proofClass:string}>}
 */
export async function validateProtectedBankEnvelopeV2(input) {
  const bytes = canonicalContentBytes(input);
  if (bytes.length > 3 * 1024 * 1024) fail('protected_cipher_limit', '$', 'stored envelope exceeds 3 MiB');
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!value || Object.keys(value).sort().join(',') !== 'bankUid,cipher,ciphertext_b64,compression,format,indexDigest,iv_b64,kdf,questionRefs,salt_b64,version'
    || value.format !== PROTECTED_BANK_V2_FORMAT || value.version !== 2 || !isUuid(value.bankUid)
    || value.cipher !== 'AES-GCM-256' || value.compression !== 'none' || !/^[0-9a-f]{64}$/.test(value.indexDigest || '')
    || !value.kdf || Object.keys(value.kdf).sort().join(',') !== 'hash,iterations,name' || value.kdf.name !== 'PBKDF2' || value.kdf.hash !== 'SHA-256'
    || !Number.isSafeInteger(value.kdf.iterations) || value.kdf.iterations < 600000 || value.kdf.iterations > 1000000
    || !Array.isArray(value.questionRefs) || value.questionRefs.length > 5000) fail('protected_cipher_v2', '$', 'invalid explicit v2 envelope');
  const keys = new Set();
  for (const ref of value.questionRefs) {
    if (!ref || Object.keys(ref).sort().join(',') !== 'questionKey,questionRevision' || !isQuestionKey(ref.questionKey)
      || !ref.questionKey.startsWith(`${value.bankUid}/`) || !/^[0-9a-f]{64}$/.test(ref.questionRevision || '') || keys.has(ref.questionKey)) fail('protected_index', '$.questionRefs', 'invalid or duplicate encrypted question declaration');
    keys.add(ref.questionKey);
  }
  for (const [key, length] of /** @type {[string,number|null][]} */([['salt_b64', 16], ['iv_b64', 12], ['ciphertext_b64', null]])) {
    if (typeof value[key] !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value[key])) fail('protected_cipher_v2', `$.${key}`, 'invalid base64');
    const decoded = atob(value[key]);
    if (btoa(decoded) !== value[key] || (length !== null && decoded.length !== length) || (length === null && decoded.length < 16)) fail('protected_cipher_v2', `$.${key}`, 'invalid cryptographic field');
  }
  if (await sha256Hex(canonicalBytes(value.questionRefs)) !== value.indexDigest) fail('protected_index_digest', '$.indexDigest', 'encrypted index digest mismatch');
  return { envelope: value, bytes, contentDigest: await sha256Hex(bytes), questionRefs: value.questionRefs, aad: protectedBankV2Aad(value), proofClass: 'declared-encrypted-index-shape-and-digest' };
}
