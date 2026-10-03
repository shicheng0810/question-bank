// Local candidate: exact source disposition journal, NOT source deletion.
// Calling code must separately validate the reviewed privileged authorization
// receipt. A SHA identifies that receipt; it is not proof of user approval.
import {canonicalContentBytes,sha256Hex} from '../../src/domain/app-data/canonical.js';
import {readNativeConversionInventory,readFrozenSourceChunk} from './legacy-native-conversion.js';
import {deriveHistorySnapshotId} from '../../src/domain/app-data/history-snapshot-records.js';
const prepared=new WeakMap(),fail=code=>{throw Object.assign(Error(code),{code});};
const hex=v=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v);
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k)&&'value' in Object.getOwnPropertyDescriptor(v,k));
const equal=(a,b)=>new TextDecoder().decode(canonicalContentBytes(a))===new TextDecoder().decode(canonicalContentBytes(b));
const rows=(sql,q,...args)=>sql.exec(q,...args).toArray();
function freeze(v){if(v&&typeof v==='object'&&!ArrayBuffer.isView(v)&&!(v instanceof ArrayBuffer)){Object.values(v).forEach(freeze);Object.freeze(v);}return v;}
export function validateSourceDispositionCommand(value){
 if(!exact(value,['operationId','authorizationReceiptSha256','principal','incarnation','generation','authorityFence','manifestSha256','histories'])||!uuid(value.operationId)||![value.authorizationReceiptSha256,value.principal,value.incarnation,value.manifestSha256].every(hex)||value.principal===value.incarnation||!uuid(value.generation)||!Number.isSafeInteger(value.authorityFence)||value.authorityFence<0||!Array.isArray(value.histories)||Object.getPrototypeOf(value.histories)!==Array.prototype||value.histories.length>15)fail('INVALID_DISPOSITION_COMMAND');
 const seen=new Set();for(const h of value.histories){if(!exact(h,['recordId','sourceDigest','disposition'])||typeof h.recordId!=='string'||!h.recordId||new TextEncoder().encode(h.recordId).length>64||!hex(h.sourceDigest)||!['convert','discard-authorized'].includes(h.disposition)||seen.has(h.recordId))fail('INVALID_DISPOSITION_COMMAND');seen.add(h.recordId);}
 return structuredClone(value);
}
export function validateDispositionCoverage(inventory,command){
 if(inventory.principal!==command.principal||inventory.incarnation!==command.incarnation||inventory.generation!==command.generation||inventory.authorityFence!==command.authorityFence||inventory.manifestSha256!==command.manifestSha256||inventory.histories.length!==command.histories.length)fail('DISPOSITION_OWNER_OR_COVERAGE');
 for(const source of inventory.histories)if(!command.histories.some(h=>h.recordId===source.recordId&&h.sourceDigest===source.sourceDigest))fail('DISPOSITION_SOURCE_MISMATCH');
 return true;
}
export function safeSourceDispositionResult(value,command){
 if(!exact(value,['ok','status','historyCount','discardCount','sourceDeleted'])||value.ok!==true||value.status!=='declared-not-deleted'||value.sourceDeleted!==false||value.historyCount!==command.histories.length||value.discardCount!==command.histories.filter(h=>h.disposition==='discard-authorized').length)return null;
 return {ok:true,status:value.status,historyCount:value.historyCount,discardCount:value.discardCount,sourceDeleted:false};
}
function capture(sql){
 if(rows(sql,"SELECT name FROM sqlite_master WHERE type='table' AND name='gen06_entities'").length!==1)fail('DISPOSITION_NATIVE_NOT_INITIALIZED');
 const exists=rows(sql,"SELECT name FROM sqlite_master WHERE type='table' AND name='gen11_source_dispositions'").length===1;
 return {binding:rows(sql,'SELECT * FROM gen05_data_binding'),state:rows(sql,'SELECT * FROM gen02_generation_state'),job:rows(sql,'SELECT * FROM gen05_legacy_migration'),manifest:rows(sql,'SELECT * FROM gen05_legacy_manifest ORDER BY source_key'),chunks:rows(sql,'SELECT source_key,chunk_index,chunk_sha256,data FROM gen05_legacy_chunk ORDER BY source_key,chunk_index').map(({data,...r})=>({...r,data:new Uint8Array(data).slice()})),native:rows(sql,"SELECT * FROM gen06_entities WHERE kind='history_snapshot' ORDER BY entity_key"),journal:exists?rows(sql,'SELECT * FROM gen11_source_dispositions ORDER BY source_key'):[]};
}
function sameCapture(a,b){const{chunks:x,...left}=a,{chunks:y,...right}=b;return equal(left,right)&&x.length===y.length&&x.every((r,i)=>{const{data:p,...m}=r,{data:q,...n}=y[i];return equal(m,n)&&p.length===q.length&&p.every((v,j)=>v===q[j]);});}
export async function prepareLegacySourceDisposition(sql,value){
 const command=validateSourceDispositionCommand(value),before=capture(sql);
 const inventory=await readNativeConversionInventory(sql,{principal:command.principal,incarnation:command.incarnation,authorityFence:command.authorityFence,manifestSha256:command.manifestSha256});validateDispositionCoverage(inventory,command);
 for(const h of command.histories.filter(h=>h.disposition==='discard-authorized')){
  const snapshotId=await deriveHistorySnapshotId(command.generation,{namespace:'legacy_account',deviceNamespace:null,recordId:h.recordId,digest:h.sourceDigest,conversionVersion:1});
  if(before.native.some(r=>r.entity_key===`history:${snapshotId}`||JSON.parse(r.payload_json)?.snapshotId===snapshotId))fail('DISCARD_NATIVE_RECORD_EXISTS');
  const parts=[];let total=null,count=1;
  for(let i=0;i<count;i++){const b=await readFrozenSourceChunk(sql,{...command,section:`history:${h.recordId}`,contentDigest:h.sourceDigest,chunkIndex:i});if(i===0){total=b.totalBytes;count=b.chunkCount;if(total>409600||count>2)fail('DISPOSITION_SOURCE_BOUND');}if(b.totalBytes!==total||b.chunkCount!==count||b.sourceDigest!==h.sourceDigest||b.chunkIndex!==i||await sha256Hex(b.bytes)!==b.digest)fail('DISPOSITION_SOURCE_BYTES');parts.push(b.bytes);}
  const full=new Uint8Array(total);let offset=0;for(const p of parts){full.set(p,offset);offset+=p.length;}if(offset!==total||await sha256Hex(full)!==h.sourceDigest)fail('DISPOSITION_SOURCE_BYTES');
 }
 if(!sameCapture(before,capture(sql)))fail('DISPOSITION_DRIFT');
 const token=Object.freeze({});prepared.set(token,{sql,command:freeze(command),before:freeze(before)});return token;
}
export function commitPreparedSourceDisposition(sql,token){
 const plan=prepared.get(token);if(!plan||plan.sql!==sql)fail('INVALID_DISPOSITION_CAPABILITY');if(!sameCapture(plan.before,capture(sql)))fail('DISPOSITION_DRIFT');
 const c=plan.command;for(const row of plan.before.journal){const h=c.histories.find(h=>`history:${h.recordId}`===row.source_key);if(!h||row.operation_id!==c.operationId||row.authority_fence!==c.authorityFence||row.incarnation!==c.incarnation||row.generation!==c.generation||row.manifest_sha256!==c.manifestSha256||row.source_digest!==h.sourceDigest||row.disposition!==h.disposition||row.authorization_sha256!==c.authorizationReceiptSha256)fail('DISPOSITION_JOURNAL_CONFLICT');}
 sql.exec('CREATE TABLE IF NOT EXISTS gen11_source_dispositions(source_key TEXT PRIMARY KEY,operation_id TEXT NOT NULL,incarnation TEXT NOT NULL,generation TEXT NOT NULL,authority_fence INTEGER NOT NULL,manifest_sha256 TEXT NOT NULL,source_digest TEXT NOT NULL,disposition TEXT NOT NULL,authorization_sha256 TEXT NOT NULL)');
 for(const h of c.histories)sql.exec('INSERT OR IGNORE INTO gen11_source_dispositions VALUES(?,?,?,?,?,?,?,?,?)',`history:${h.recordId}`,c.operationId,c.incarnation,c.generation,c.authorityFence,c.manifestSha256,h.sourceDigest,h.disposition,c.authorizationReceiptSha256);
 return {ok:true,status:'declared-not-deleted',historyCount:c.histories.length,discardCount:c.histories.filter(h=>h.disposition==='discard-authorized').length,sourceDeleted:false};
}
