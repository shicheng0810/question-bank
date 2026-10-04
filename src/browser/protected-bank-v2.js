import { canonicalBytes, sha256Hex } from '../domain/app-data/canonical.js';
import { validateBankRevisionRecord } from '../domain/app-data/content-records.js';
import { validateBankContent, validateProtectedBankEnvelopeV2, protectedBankV2Aad, PROTECTED_BANK_V2_FORMAT } from '../domain/question/bank-content.js';
import { encodeContent } from '../domain/attempt/commands.js';
const fail = code => Object.assign(new Error(code), { name: 'ProtectedBankV2Error', code });
const equal = (a, b) => new TextDecoder().decode(canonicalBytes(a)) === new TextDecoder().decode(canonicalBytes(b));
const decode = value => Uint8Array.from(atob(value), character => character.charCodeAt(0));
function base64(bytes) { let value = ''; for (let offset = 0; offset < bytes.length; offset += 8192) value += String.fromCharCode(...bytes.subarray(offset, offset + 8192)); return btoa(value); }
function passwordBytes(value) {
  if (typeof value !== 'string') throw fail('INVALID_PASSWORD');
  const bytes = new TextEncoder().encode(value);
  if (!bytes.length || bytes.length > 1024) throw fail('INVALID_PASSWORD');
  return bytes;
}
async function keyFor(password, envelope, usage) {
  try {
    const source = await crypto.subtle.importKey('raw', password, 'PBKDF2', false, ['deriveKey']);
    return await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: decode(envelope.salt_b64), iterations: envelope.kdf.iterations, hash: 'SHA-256' }, source, { name: 'AES-GCM', length: 256 }, false, [usage]);
  } finally { password.fill(0); }
}

/** Explicit new-format creation. Caller persists ONLY returned cipher records;
 * neither password, CryptoKey, nor plaintext body is returned in those records.
 */
export async function encryptProtectedBankV2({ content, password }) {
  const captured = passwordBytes(password);
  try {
    const bank = await validateBankContent(content);
    if (bank.content.metadata.visibility !== 'private') throw fail('PRIVATE_CONTENT_REQUIRED');
    const envelope = { format: PROTECTED_BANK_V2_FORMAT, version: 2, bankUid: bank.content.bankUid, questionRefs: bank.questionRefs,
      indexDigest: await sha256Hex(canonicalBytes(bank.questionRefs)), cipher: 'AES-GCM-256', compression: 'none', kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 600000 }, salt_b64: base64(crypto.getRandomValues(new Uint8Array(16))), iv_b64: base64(crypto.getRandomValues(new Uint8Array(12))) };
    const key = await keyFor(captured, envelope, 'encrypt');
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: decode(envelope.iv_b64), additionalData: protectedBankV2Aad(envelope), tagLength: 128 }, key, bank.bytes);
    envelope.ciphertext_b64 = base64(new Uint8Array(encrypted));
    const verified = await validateProtectedBankEnvelopeV2(envelope);
    const encoded = await encodeContent(verified.envelope);
    const record = validateBankRevisionRecord({ bankUid: bank.content.bankUid, revision: verified.contentDigest, metadata: { ...bank.content.metadata, visibility: 'protected' }, contentManifest: { kind: 'protected_cipher', reference: encoded.reference } });
    return { record, records: encoded.records, envelope: verified.envelope, proofClass: verified.proofClass };
  } finally { captured.fill(0); }
}

/** Memory-only decryption. This helper has no IDB/cloud/ZIP/log capabilities.
 * A valid AEAD tag alone is insufficient: all full question revisions/options
 * and the declared index must match before a learning view is returned.
 */
export async function decryptProtectedBankV2({ envelope: input, record: inputRecord, password }) {
  canonicalBytes(inputRecord); const record = structuredClone(validateBankRevisionRecord(inputRecord));
  const captured = passwordBytes(password);
  let plaintext;
  try {
    const verified = await validateProtectedBankEnvelopeV2(input);
    if (record.contentManifest.kind !== 'protected_cipher' || record.metadata.visibility !== 'protected' || record.bankUid !== verified.envelope.bankUid
      || record.revision !== verified.contentDigest || record.contentManifest.reference.contentDigest !== verified.contentDigest || record.metadata.questionCount !== verified.questionRefs.length) throw fail('PROTECTED_BANK_BINDING');
    const encoded = await encodeContent(verified.envelope);
    if (!equal(encoded.reference, record.contentManifest.reference)) throw fail('PROTECTED_BANK_BINDING');
    const key = await keyFor(captured, verified.envelope, 'decrypt');
    try { plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(verified.envelope.iv_b64), additionalData: verified.aad, tagLength: 128 }, key, decode(verified.envelope.ciphertext_b64))); }
    catch { throw fail('DECRYPTION_FAILED'); }
    const bank = await validateBankContent(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)));
    if (bank.content.bankUid !== record.bankUid || bank.content.metadata.visibility !== 'private' || !equal({ ...bank.content.metadata, visibility: 'protected' }, record.metadata) || !equal(bank.questionRefs, verified.questionRefs)) throw fail('DECRYPTED_INDEX_MISMATCH');
    return { content: bank.content, questionRefs: bank.questionRefs, proofClass: 'browser-decrypted-full-registered-content-verified' };
  } finally { captured.fill(0); plaintext?.fill(0); }
}
