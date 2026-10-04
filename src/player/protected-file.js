import {canonicalBytes,canonicalContentBytes,validateBankRevisionRecord} from '../domain/app-data/index.js';
import {validateProtectedBankEnvelopeV2} from '../domain/question/bank-content.js';
import {encodeContent} from '../domain/attempt/commands.js';
import {encryptProtectedBankV2,decryptProtectedBankV2} from '../browser/protected-bank-v2.js';
const fail=code=>Object.assign(new Error(code),{code});
const equal=(a,b)=>new TextDecoder().decode(canonicalBytes(a))===new TextDecoder().decode(canonicalBytes(b));
export const PROTECTED_FILE_FORMAT='qb-protected-bank-file-v2';
/** Explicit v2 file only. Never reinterpret a legacy qbpack or mint identities
 * while reopening. Password and decrypted body never enter this file DTO.
 */
export async function validateProtectedBankFileV2(input){
  const bytes=canonicalContentBytes(input);if(bytes.length>16*1024*1024)throw fail('PROTECTED_FILE_BUDGET');const owned=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  if(!owned||Object.keys(owned).sort().join()!=='envelope,format,record,version'||owned.format!==PROTECTED_FILE_FORMAT||owned.version!==2)throw fail('PROTECTED_FILE_FORMAT');
  validateBankRevisionRecord(owned.record);
  const verified=await validateProtectedBankEnvelopeV2(owned.envelope),record=owned.record,encoded=await encodeContent(verified.envelope);
  if(record.contentManifest.kind!=='protected_cipher'||record.metadata.visibility!=='protected'||record.bankUid!==verified.envelope.bankUid||record.revision!==verified.contentDigest||record.metadata.questionCount!==verified.questionRefs.length||!equal(record.contentManifest.reference,encoded.reference))throw fail('PROTECTED_BANK_BINDING');
  return {...owned,envelope:verified.envelope};
}
export async function encodeProtectedBankFileV2(input){
  const file=await validateProtectedBankFileV2(input);return {file,bytes:canonicalContentBytes(file)};
}
export async function decodeProtectedBankFileV2(input){
  if(!(input instanceof Uint8Array)||Object.getPrototypeOf(input)!==Uint8Array.prototype)throw fail('PROTECTED_FILE_BUDGET');
  const typed=Object.getPrototypeOf(Uint8Array.prototype),length=Object.getOwnPropertyDescriptor(typed,'byteLength').get.call(input),buffer=Object.getOwnPropertyDescriptor(typed,'buffer').get.call(input);
  if(length<1||length>16*1024*1024||Object.getPrototypeOf(buffer)!==ArrayBuffer.prototype||Reflect.ownKeys(input).some(key=>typeof key!=='string'||!/^(0|[1-9][0-9]*)$/.test(key)))throw fail('PROTECTED_FILE_BUDGET');
  const bytes=Uint8Array.prototype.slice.call(input);let value;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw fail('PROTECTED_FILE_FORMAT');}
  return validateProtectedBankFileV2(value);
}
export async function createProtectedBankFileV2(input){
  const encrypted=await encryptProtectedBankV2(input);
  const file={format:PROTECTED_FILE_FORMAT,version:2,record:encrypted.record,envelope:encrypted.envelope};
  return {...await encodeProtectedBankFileV2(file),records:encrypted.records,proofClass:encrypted.proofClass};
}
export async function unlockProtectedBankFileV2(input,password){
  const file=await validateProtectedBankFileV2(input);
  const unlocked=await decryptProtectedBankV2({record:file.record,envelope:file.envelope,password});
  return {content:unlocked.content,questionRefs:unlocked.questionRefs,protectedFile:file,proofClass:unlocked.proofClass};
}
