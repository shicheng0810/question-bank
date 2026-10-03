import { canonicalBytes, sha256Hex } from '../domain/app-data/canonical.js';
import { isUuid } from '../domain/question/index.js';
import { registerImportedBank } from './register-import.js';
async function identity(tuple){const hash=await sha256Hex(canonicalBytes(tuple)),chars=hash.slice(0,32).split('');chars[12]='8';chars[16]=(8+(parseInt(chars[16],16)&3)).toString(16);const s=chars.join('');return`${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;}
export async function legacyBankIdentity(accountGeneration,recordId){
 if(!isUuid(accountGeneration)||typeof recordId!=='string'||!recordId||new TextEncoder().encode(recordId).length>128)throw Object.assign(new Error('LEGACY_BANK_IDENTITY'),{code:'LEGACY_BANK_IDENTITY'});
 return identity(['qb-legacy-bank-v1',accountGeneration,recordId]);
}
/** Stable across site origin and interrupted preparation. Digest is immutable
 * evidence, not a mechanism to allocate a second identity for changed source. */
export async function registerLegacyBank(questions,{accountGeneration,recordId,title,legacyArchive}){
 const bankUid=await legacyBankIdentity(accountGeneration,recordId);
 const tuple=['qb-legacy-bank-v1',accountGeneration,recordId];
 const questionUids=await Promise.all(questions.map((q,i)=>identity([...tuple,'question',i,String(q.id??i)])));
 return registerImportedBank(questions,{title,sourceOrigin:'https://question-bank-78u.pages.dev',namespace:`legacy-v1-${accountGeneration}-${recordId}`,legacyArchive,
 registrationIdentity:{bankUid,scopeId:await identity([...tuple,'scope']),planId:await identity([...tuple,'plan']),questionUids}});
}
