// Account-owned sharing uses the existing sb:code index; payload stays in this
// GenerationStore. Revocation is authoritative here, even with stale KV reads.
import {exactAdminRecord} from './native-admin-items-dto.js';
const HEX=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const BANK_UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const SHARE_TYPE='native-generation-share-v1';
export const failShare=code=>{throw Object.assign(new Error(code),{code});};
export function validShareInput(c){
 if(!c||![Object.prototype,null].includes(Object.getPrototypeOf(c)))return false;const action=Object.getOwnPropertyDescriptor(c,'action');if(!action||!('value' in action)||!['create','list','revoke'].includes(action.value))return false;
 if(c.action==='list')return exactAdminRecord(c,['action']);
 return exactAdminRecord(c,c.action==='create'?['action','opId','bankUid','bankRevision']:['action','opId','shareId'])&&typeof c.opId==='string'&&UUID.test(c.opId)&& (c.action==='create'?typeof c.bankUid==='string'&&BANK_UUID.test(c.bankUid)&&typeof c.bankRevision==='string'&&HEX.test(c.bankRevision):typeof c.shareId==='string'&&UUID.test(c.shareId));
}
export function validSharePointer(p){return exactAdminRecord(p,['type','principal','incarnation','generation','fence','shareId','codeHash'])&&['type','principal','incarnation','generation','shareId','codeHash'].every(k=>typeof p[k]==='string')&&p.type===SHARE_TYPE&&HEX.test(p.principal)&&HEX.test(p.incarnation)&&UUID.test(p.generation)&&Number.isSafeInteger(p.fence)&&p.fence>=1&&UUID.test(p.shareId)&&HEX.test(p.codeHash);}
export async function shareCodeHash(code){if(typeof code!=='string'||code.length<6||code.length>80)failShare('INVALID_SHARE_INPUT');return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('qbshare:v1:'+code))),b=>b.toString(16).padStart(2,'0')).join('');}
export function newShareCode(){return 'n1-'+Array.from(crypto.getRandomValues(new Uint8Array(24)),b=>b.toString(16).padStart(2,'0')).join('');}
export function sharingRepository(sql){
 sql.exec('CREATE TABLE IF NOT EXISTS gen_share_records (share_id TEXT PRIMARY KEY, generation TEXT NOT NULL, create_op TEXT NOT NULL UNIQUE, command_json TEXT NOT NULL, record_json TEXT NOT NULL)');
 sql.exec('CREATE TABLE IF NOT EXISTS gen_share_revoke_ops (op_id TEXT PRIMARY KEY,generation TEXT NOT NULL,share_id TEXT NOT NULL)');
 const rows=(q,...a)=>Array.from(sql.exec(q,...a));
 return {
  get(id){const r=rows('SELECT record_json FROM gen_share_records WHERE share_id=?',id)[0];return r?JSON.parse(r.record_json):null;},
  byOperation(op){const r=rows('SELECT command_json,record_json FROM gen_share_records WHERE create_op=?',op)[0];return r?{command:JSON.parse(r.command_json),record:JSON.parse(r.record_json)}:null;},
  insert(command,record){if(rows('SELECT share_id FROM gen_share_records WHERE generation=? LIMIT 251',record.generation).length>=250)failShare('SHARE_LIMIT');if(rows('SELECT share_id FROM gen_share_records LIMIT 1001').length>=1000)failShare('SHARE_LIMIT');sql.exec('INSERT INTO gen_share_records VALUES(?,?,?,?,?)',record.shareId,record.generation,command.opId,JSON.stringify(command),JSON.stringify(record));return record;},
  rememberRevoke(command,generation){const old=rows('SELECT generation,share_id FROM gen_share_revoke_ops WHERE op_id=?',command.opId)[0];if(old){if(old.generation!==generation||old.share_id!==command.shareId)failShare('SHARE_CONFLICT');return;}if(rows('SELECT op_id FROM gen_share_revoke_ops LIMIT 2001').length>=2000)failShare('SHARE_LIMIT');sql.exec('INSERT INTO gen_share_revoke_ops VALUES(?,?,?)',command.opId,generation,command.shareId);},
  put(record){sql.exec('UPDATE gen_share_records SET record_json=? WHERE share_id=?',JSON.stringify(record),record.shareId);return record;},
  list(generation){return rows('SELECT record_json FROM gen_share_records WHERE generation=? ORDER BY share_id LIMIT 1001',generation).map(r=>JSON.parse(r.record_json));}
 };
}
export function shareDTO(r){return {shareId:r.shareId,generation:r.generation,bankUid:r.bankUid,bankRevision:r.bankRevision,status:r.status,code:r.code,createdAt:r.createdAt,revokedAt:r.revokedAt};}
