// Restricted binding-only conversion. Authority supplies the current fence;
// frozen public mapping and sealed private source bytes supply question proof.
// Never accept bank bodies/URLs from caller JSON or issue a user login token.
import { canonicalBytes, canonicalContentBytes, computeMutationDigest, sha256Hex } from '../../src/domain/app-data/index.js';
import { convertVerifiedHistorySnapshot } from '../../src/domain/app-data/convert-history-snapshot.js';
import { validateHistorySnapshotBinding } from '../../src/domain/app-data/history-snapshot-records.js';
import {deriveHistorySnapshotId,validateImportedHistorySnapshot} from '../../src/domain/app-data/history-snapshot-records.js';
import {frozenLegacyPublicScope} from './legacy-public-scope.js';
import {loadAccountPublicRegistry} from './account-public-registry.js';
import {registerLegacyBank} from '../../src/player/register-legacy-bank.js';
import {validateBankContent} from '../../src/domain/question/bank-content.js';
import {dedupeWorkerLegacyQuestionBank} from './legacy-worker-dedupe.js';

const plans = new WeakMap();
const fail = code => { throw Object.assign(new Error(code), { code }); };
const rows = (sql, query, ...args) => sql.exec(query, ...args).toArray();
const equal = (a,b) => new TextDecoder().decode(canonicalBytes(a)) === new TextDecoder().decode(canonicalBytes(b));
const hex = x => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x);
const uuid = x => typeof x === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[48][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(x);
export async function readNativeConversionInventory(sql,input){
 if(!equal(Object.keys(input).sort(),['principal','incarnation','authorityFence','manifestSha256'].sort()))fail('INVALID_CONVERSION_INPUT');
 const generation=JSON.parse(rows(sql,'SELECT state_json FROM gen02_generation_state WHERE id=1')[0]?.state_json||'null')?.generation;
 const descriptors=rows(sql,'SELECT * FROM gen05_legacy_manifest ORDER BY source_key');
 const first=descriptors.find(d=>d.section==='history')||descriptors.find(d=>d.section==='banks'&&d.part==='questions');
 if(!first){
  // A sealed empty source is valid; absence alone is not evidence of emptiness.
  const captureEmpty=()=>{
   const binding=rows(sql,'SELECT * FROM gen05_data_binding WHERE id=1')[0];
   const state=JSON.parse(rows(sql,'SELECT state_json FROM gen02_generation_state WHERE id=1')[0]?.state_json||'null');
   const job=rows(sql,'SELECT * FROM gen05_legacy_migration WHERE id=1')[0];
   const manifest=rows(sql,'SELECT * FROM gen05_legacy_manifest ORDER BY source_key');
   const chunkCount=rows(sql,'SELECT COUNT(*) AS n FROM gen05_legacy_chunk')[0]?.n;
   if(!hex(input.principal)||!hex(input.incarnation)||input.principal===input.incarnation||!hex(input.manifestSha256)||!Number.isSafeInteger(input.authorityFence)||input.authorityFence<0||!uuid(generation))fail('INVALID_CONVERSION_INPUT');
   if(binding?.principal!==input.principal||binding?.incarnation!==input.incarnation||state?.generation!==generation||state?.status!=='active')fail('STALE_CONVERSION_OWNER');
   const receipt=job&&JSON.parse(job.receipt_json||'null');
   if(!job||job.principal!==input.principal||job.incarnation!==input.incarnation||job.generation!==generation||job.authority_fence!==input.authorityFence||job.status!=='sealed'||job.phase!=='complete'||job.history_done!==0||job.history_total!==0||job.bank_done!==0||job.bank_total!==0||receipt?.historyCount!==0||receipt?.bankCount!==0||receipt?.manifestSha256!==input.manifestSha256||manifest.length!==0||chunkCount!==0)fail('SOURCE_NOT_SEALED');
   return{binding,state,job,manifest,chunkCount};
  };
  const before=captureEmpty();
  if(await sha256Hex(canonicalContentBytes([]))!==input.manifestSha256)fail('SOURCE_MANIFEST_MISMATCH');
  if(!equal(before,captureEmpty()))fail('CONVERSION_DRIFT');
  return{ok:true,status:'sealed-inventory',...input,generation,histories:[],banks:[]};
 }
 const command={...input,generation,recordId:first.id},before=capture(sql,command,first.section);
 const manifest=before.descriptors.map(d=>({sourceKey:d.source_key,section:d.section,id:d.id,part:d.part,sourceSha256:d.source_sha256,byteLength:d.byte_length,chunkCount:d.chunk_count,metadata:JSON.parse(d.meta_json)}));
 if(await sha256Hex(canonicalContentBytes(manifest))!==input.manifestSha256)fail('SOURCE_MANIFEST_MISMATCH');
 const histories=descriptors.filter(d=>d.section==='history'&&d.part==='record').map(d=>({recordId:d.id,sourceDigest:d.source_sha256}));
 const banks=descriptors.filter(d=>d.section==='banks'&&d.part==='questions').map(d=>{const meta=descriptors.find(m=>m.section==='banks'&&m.id===d.id&&m.part==='meta');if(!meta)fail('PRIVATE_SOURCE_NOT_PROVEN');return{recordId:d.id,sourceDigest:d.source_sha256,metaDigest:meta.source_sha256};});
 sameCapture(sql,{command,before,sourceSection:first.section});
 return{ok:true,status:'sealed-inventory',...input,generation,histories,banks};
}
export async function readFrozenSourceChunk(sql,input){
 const sourceKey=input.section,match=/^bank:(.+):(meta|questions)$/.exec(sourceKey),sourceSection=match?'banks':'history',recordId=match?match[1]:sourceKey.slice('history:'.length);
 const command={principal:input.principal,incarnation:input.incarnation,generation:input.generation,authorityFence:input.authorityFence,manifestSha256:input.manifestSha256,recordId};
 const before=capture(sql,command,sourceSection),manifest=before.descriptors.map(d=>({sourceKey:d.source_key,section:d.section,id:d.id,part:d.part,sourceSha256:d.source_sha256,byteLength:d.byte_length,chunkCount:d.chunk_count,metadata:JSON.parse(d.meta_json)}));
 if(await sha256Hex(canonicalContentBytes(manifest))!==input.manifestSha256)fail('SOURCE_MANIFEST_MISMATCH');
 const proof=await readPrivatePart(sql,sourceKey,sourceSection==='history'?409600:match[2]==='meta'?256*1024:1900000);
 if(proof.descriptor.source_sha256!==input.contentDigest)fail('SOURCE_BYTES_MISMATCH');
 const chunk=proof.chunks.find(c=>c.chunk_index===input.chunkIndex);if(!chunk)fail('SOURCE_NOT_PROVEN');
 const bytes=new Uint8Array(chunk.data);if(bytes.length>256*1024||await sha256Hex(bytes)!==chunk.chunk_sha256)fail('SOURCE_BYTES_MISMATCH');
 sameCapture(sql,{command,before,sourceSection,bankSources:[proof]});
 return{ok:true,sourceKey,sourceDigest:proof.descriptor.source_sha256,totalBytes:proof.descriptor.byte_length,chunkCount:proof.descriptor.chunk_count,chunkIndex:input.chunkIndex,digest:chunk.chunk_sha256,byteLength:bytes.length,bytes};
}
function capture(sql, command, sourceSection='history') {
  const { principal, incarnation, generation, authorityFence, manifestSha256, recordId } = command;
  canonicalBytes(command);
  if (!equal(Object.keys(command).sort(), ['principal','incarnation','generation','authorityFence','manifestSha256','recordId'].sort())
    || !hex(principal) || !hex(incarnation) || principal === incarnation || !uuid(generation)
    || !Number.isSafeInteger(authorityFence) || authorityFence < 0 || !hex(manifestSha256)
    || typeof recordId !== 'string' || !recordId || new TextEncoder().encode(recordId).length > 64) fail('INVALID_CONVERSION_INPUT');
  const binding = rows(sql,'SELECT * FROM gen05_data_binding WHERE id=1')[0];
  const state = JSON.parse(rows(sql,'SELECT state_json FROM gen02_generation_state WHERE id=1')[0]?.state_json || 'null');
  const job = rows(sql,'SELECT * FROM gen05_legacy_migration WHERE id=1')[0];
  if (binding?.principal !== principal || binding?.incarnation !== incarnation || state?.generation !== generation || state.status !== 'active') fail('STALE_CONVERSION_OWNER');
  if (!job || job.principal !== principal || job.incarnation !== incarnation || job.generation !== generation
    || job.authority_fence !== authorityFence || job.status !== 'sealed' || job.phase !== 'complete'
    || JSON.parse(job.receipt_json).manifestSha256 !== manifestSha256) fail('SOURCE_NOT_SEALED');
  const descriptor = rows(sql,'SELECT * FROM gen05_legacy_manifest WHERE source_key=? AND section=? AND part=? AND complete=1',sourceSection==='history'?`history:${recordId}`:`bank:${recordId}:questions`,sourceSection,sourceSection==='history'?'record':'questions')[0];
  if (!descriptor || descriptor.id !== recordId || descriptor.byte_length < 1 || descriptor.byte_length > (sourceSection==='history'?409600:1900000)) fail('SOURCE_NOT_PROVEN');
  const chunks = rows(sql,'SELECT chunk_index,chunk_sha256,data FROM gen05_legacy_chunk WHERE source_key=? ORDER BY chunk_index',descriptor.source_key);
  const descriptors=rows(sql,'SELECT * FROM gen05_legacy_manifest ORDER BY source_key');
  if(descriptors.length>40||descriptors.some(d=>d.complete!==1))fail('SOURCE_NOT_SEALED');
  return {binding,state,job,descriptor,chunks,descriptors};
}
function sameCapture(sql, plan) {
  const now = capture(sql,plan.command,plan.sourceSection), before = plan.before;
  if (!equal([now.binding,now.state,now.job,now.descriptor,now.descriptors],[before.binding,before.state,before.job,before.descriptor,before.descriptors])
    || now.chunks.length !== before.chunks.length
    || now.chunks.some((c,i)=>c.chunk_index!==before.chunks[i].chunk_index||c.chunk_sha256!==before.chunks[i].chunk_sha256
      || !sameBytes(new Uint8Array(c.data),new Uint8Array(before.chunks[i].data)))) fail('CONVERSION_DRIFT');
  for(const proof of plan.bankSources||[]){
   const d=rows(sql,'SELECT * FROM gen05_legacy_manifest WHERE source_key=?',proof.descriptor.source_key)[0];
   const parts=rows(sql,'SELECT chunk_index,chunk_sha256,data FROM gen05_legacy_chunk WHERE source_key=? ORDER BY chunk_index',proof.descriptor.source_key);
   if(!equal(d,proof.descriptor)||parts.length!==proof.chunks.length||parts.some((p,i)=>p.chunk_index!==proof.chunks[i].chunk_index||p.chunk_sha256!==proof.chunks[i].chunk_sha256
    ||!sameBytes(new Uint8Array(p.data),new Uint8Array(proof.chunks[i].data))))fail('CONVERSION_DRIFT');
  }
}
const sameBytes=(a,b)=>a.length===b.length&&a.every((n,i)=>n===b[i]);
async function deterministicUuid(value) {
  const chars=(await sha256Hex(canonicalBytes(value))).slice(0,32).split('');chars[12]='8';chars[16]=(8+(parseInt(chars[16],16)&3)).toString(16);
  const s=chars.join('');return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;
}

/** Read-only prepare. Resolver is an internal dependency, not evidence supplied
 * by JSON: it must prove source bank selection and immutable registered bodies.
 * converter performs the actual legacy dedupe and rejects ambiguity. */
async function readSource(sql, command,sourceSection='history') {
  const owned=structuredClone(command), before=capture(sql,owned,sourceSection);
  const manifest=before.descriptors.map(d=>({sourceKey:d.source_key,section:d.section,id:d.id,part:d.part,sourceSha256:d.source_sha256,byteLength:d.byte_length,chunkCount:d.chunk_count,metadata:JSON.parse(d.meta_json)}));
  if(await sha256Hex(canonicalContentBytes(manifest))!==owned.manifestSha256)fail('SOURCE_MANIFEST_MISMATCH');
  if(before.chunks.length!==before.descriptor.chunk_count)fail('SOURCE_BYTES_MISMATCH');
  const bytes=new Uint8Array(before.descriptor.byte_length);let offset=0;
  for(let i=0;i<before.chunks.length;i++){
    const chunk=before.chunks[i], part=new Uint8Array(chunk.data);
    if(chunk.chunk_index!==i || await sha256Hex(part)!==chunk.chunk_sha256 || offset+part.length>bytes.length)fail('SOURCE_BYTES_MISMATCH');
    bytes.set(part,offset);offset+=part.length;
  }
  if(offset!==bytes.length || await sha256Hex(bytes)!==before.descriptor.source_sha256)fail('SOURCE_BYTES_MISMATCH');
  const rawJson=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes), original=JSON.parse(rawJson);
  return{owned,before,bytes,rawJson,original};
}
export async function prepareLegacyNativeHistory(sql, command, { resolveBankContents }) {
  if(typeof resolveBankContents!=='function')fail('BANK_RESOLVER_REQUIRED');
  const {owned,before,bytes,rawJson,original}=await readSource(sql,command);
  const bankContents=await resolveBankContents(original);
  const body=await convertVerifiedHistorySnapshot({verifiedSource:{rawJson,byteLength:bytes.length,sha256:before.descriptor.source_sha256,sourceKey:before.descriptor.source_key},
    source:{namespace:'legacy_account',deviceNamespace:null,recordId:owned.recordId,digest:before.descriptor.source_sha256,conversionVersion:1},accountGeneration:owned.generation,bankContents});
  return mintPlan(sql,owned,before,body);
}
// Public conversion uses the fixed source-code mapping, not caller bank bodies.
// All content references are subsequently checked by normal gen06 push.
export async function prepareFrozenPublicHistory(sql,command){
 const {owned,before,original}=await readSource(sql,command);
  if(!Array.isArray(original.scope)||original.scope.length>5000||original.scope.some(id=>typeof id!=='string')||!original.state||typeof original.state!=='object'||Array.isArray(original.state))fail('HISTORY_SOURCE_INVALID');
 const mapped=frozenLegacyPublicScope(original),source={namespace:'legacy_account',deviceNamespace:null,recordId:owned.recordId,digest:before.descriptor.source_sha256,conversionVersion:1};
 if(original.id!==owned.recordId)fail('HISTORY_SOURCE_INVALID');
 const answers=Object.entries(original.state).map(([legacyQuestionId,input])=>({legacyQuestionId,savedInput:{selectedIndex:input.selectedIndex??null,
  selectedSet:input.selectedSet===undefined?[]:input.selectedSet,fillInputs:input.fillInputs===undefined?[]:input.fillInputs,
  submitted:input.submitted===undefined?false:input.submitted,showKeys:input.showKeys===undefined?false:input.showKeys}}));
 const body={schemaVersion:1,type:'imported_history_snapshot',snapshotId:await deriveHistorySnapshotId(owned.generation,source),accountGeneration:owned.generation,
  source,recordedAt:original.ts,summary:original.score,scope:mapped.scope,answers};
 validateImportedHistorySnapshot(body);
 const registry=loadAccountPublicRegistry({});
 const banks=mapped.banks.map(bank=>{const proof=registry.get(`${bank.bankUid}:${bank.revision}`);if(!proof||proof.record.contentManifest.staticRef!==bank.staticRef)fail('PUBLIC_BANK_BINDING');return{record:proof.record};});
 return mintPlan(sql,owned,before,body,banks);
}
async function readPrivatePart(sql,key,limit){
 const descriptor=rows(sql,'SELECT * FROM gen05_legacy_manifest WHERE source_key=? AND complete=1',key)[0];
 if(!descriptor||descriptor.byte_length<1||descriptor.byte_length>limit)fail('PRIVATE_SOURCE_NOT_PROVEN');
 const chunks=rows(sql,'SELECT chunk_index,chunk_sha256,data FROM gen05_legacy_chunk WHERE source_key=? ORDER BY chunk_index',key);
 const bytes=new Uint8Array(descriptor.byte_length);let offset=0;
 if(chunks.length!==descriptor.chunk_count)fail('SOURCE_BYTES_MISMATCH');
 for(let i=0;i<chunks.length;i++){const part=new Uint8Array(chunks[i].data);if(chunks[i].chunk_index!==i||await sha256Hex(part)!==chunks[i].chunk_sha256||offset+part.length>bytes.length)fail('SOURCE_BYTES_MISMATCH');bytes.set(part,offset);offset+=part.length;}
 if(offset!==bytes.length||await sha256Hex(bytes)!==descriptor.source_sha256)fail('SOURCE_BYTES_MISMATCH');
 const rawJson=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
 return{descriptor,chunks,rawJson,value:JSON.parse(rawJson)};
}
export async function prepareFrozenNativeHistory(sql,command){
 const source=await readSource(sql,command),{owned,before,original,rawJson,bytes}=source;
 if(rows(sql,"SELECT name FROM sqlite_master WHERE type='table' AND name='gen11_source_dispositions'").length&&rows(sql,"SELECT source_digest FROM gen11_source_dispositions WHERE source_key=? AND generation=? AND incarnation=? AND disposition='discard-authorized'",`history:${owned.recordId}`,owned.generation,owned.incarnation).length)fail('HISTORY_SOURCE_DISCARD_AUTHORIZED');
 if(typeof original.bank_id!=='string'||!original.bank_id.startsWith('u-'))return prepareFrozenPublicHistory(sql,command);
 const id=original.bank_id.slice(2),questions=await readPrivatePart(sql,`bank:${id}:questions`,1900000),meta=await readPrivatePart(sql,`bank:${id}:meta`,256*1024);
 if(!meta.value||meta.value.id!==id||!Array.isArray(questions.value)||meta.value.count!==undefined&&meta.value.count!==questions.value.length
  ||meta.value.bytes!==undefined&&!(meta.value.bytes===questions.descriptor.byte_length||meta.value.bytes===questions.rawJson.length))fail('PRIVATE_SOURCE_NOT_PROVEN');
 const registered=await registerLegacyBank(questions.value,{accountGeneration:owned.generation,recordId:id,title:meta.value.title,
  legacyArchive:{sourceKey:`bank:${id}`,sha256:questions.descriptor.source_sha256,metaSha256:meta.descriptor.source_sha256}});
 const bank=registered.content,checked=await validateBankContent(bank);
 const body=await convertVerifiedHistorySnapshot({verifiedSource:{rawJson,byteLength:bytes.length,sha256:before.descriptor.source_sha256,sourceKey:before.descriptor.source_key},
  source:{namespace:'legacy_account',deviceNamespace:null,recordId:owned.recordId,digest:before.descriptor.source_sha256,conversionVersion:1},accountGeneration:owned.generation,bankContents:[bank],legacyDedupe:dedupeWorkerLegacyQuestionBank});
 const packet=await contentPacket(bank);
 const record={bankUid:bank.bankUid,revision:checked.contentDigest,metadata:bank.metadata,contentManifest:{kind:'private_chunks',reference:packet.reference}};
 return mintPlan(sql,owned,before,body,[{record,packet}],[questions,meta]);
}
// Independent bank inventory is not inferred from history references.
export async function prepareFrozenNativeBank(sql,command){
 const {owned,before}=await readSource(sql,command,'banks'),id=owned.recordId;
 const questions=await readPrivatePart(sql,`bank:${id}:questions`,1900000),meta=await readPrivatePart(sql,`bank:${id}:meta`,256*1024);
 if(!meta.value||meta.value.id!==id||!Array.isArray(questions.value)||meta.value.count!==undefined&&meta.value.count!==questions.value.length
  ||meta.value.bytes!==undefined&&!(meta.value.bytes===questions.descriptor.byte_length||meta.value.bytes===questions.rawJson.length))fail('PRIVATE_SOURCE_NOT_PROVEN');
 const registered=await registerLegacyBank(questions.value,{accountGeneration:owned.generation,recordId:id,title:meta.value.title,
  legacyArchive:{sourceKey:`bank:${id}`,sha256:questions.descriptor.source_sha256,metaSha256:meta.descriptor.source_sha256}});
 const packet=await contentPacket(registered.content),record={bankUid:registered.content.bankUid,revision:packet.manifest.contentDigest,metadata:registered.content.metadata,contentManifest:{kind:'private_chunks',reference:packet.reference}};
 const plan={command:owned,before,sourceSection:'banks',bankSources:[questions,meta],bank:{record,packet}};sameCapture(sql,plan);
 const capability=Object.freeze({bankUid:record.bankUid,contentDigest:record.revision});plans.set(capability,{sql,plan});return capability;
}
export async function executeLegacyNativeBank(sql,capability,{store,claim,checkAuthority=async()=>{}}){
 const minted=plans.get(capability);if(!minted||minted.sql!==sql||minted.plan.sourceSection!=='banks')fail('INVALID_CONVERSION_CAPABILITY');
 const p=minted.plan,{record,packet}=p.bank;
 if(!claim||claim.principal!==p.command.principal||claim.incarnation!==p.command.incarnation||claim.generation!==p.command.generation)fail('STALE_CONVERSION_OWNER');
 const call=async(method,input)=>{sameCapture(sql,p);await checkAuthority();sameCapture(sql,p);const result=await store[method](claim,input);sameCapture(sql,p);await checkAuthority();sameCapture(sql,p);if(result?.ok!==true)fail(result?.error||'NATIVE_CONVERSION_UNAVAILABLE');return result;};
 sameCapture(sql,p);await checkAuthority();sameCapture(sql,p);
 if(rows(sql,"SELECT name FROM sqlite_master WHERE name='gen06_entities'").length){
  if(rows(sql,'SELECT entity_key FROM gen06_entity_tombstones WHERE entity_key=?',`bank:${record.bankUid}`).length)fail('NATIVE_BANK_TOMBSTONED');
  const existing=rows(sql,"SELECT * FROM gen06_entities WHERE kind='bank_revision' AND entity_key=?",`bank:${record.bankUid}`)[0];
  if(existing){
   const payload=JSON.parse(existing.payload_json),{schemaVersion,baseRevision,...storedRecord}=payload;
   if(schemaVersion!==1||!equal(storedRecord,record))fail('NATIVE_SOURCE_CONFLICT');
   const change=rows(sql,'SELECT record_json FROM gen06_change_log WHERE server_seq=?',existing.server_seq)[0];
   if(!change||!equal(JSON.parse(change.record_json).payload,payload)||JSON.parse(change.record_json).payloadDigest!==existing.digest)fail('NATIVE_ACCEPTANCE_PROOF_MISSING');
   const proofs=rows(sql,"SELECT receipt_json,mutation_json FROM gen06_mutation_receipts WHERE digest=? AND json_extract(receipt_json,'$.serverSeq')=? LIMIT 2",existing.digest,existing.server_seq);
   let accepted=false;
   for(const proof of proofs){const r=JSON.parse(proof.receipt_json),m=JSON.parse(proof.mutation_json||'null');if(r.status==='accepted'&&m&&m.kind==='bank_revision'&&m.entityKey===`bank:${record.bankUid}`&&equal(m.payload,payload)&&await computeMutationDigest(m)===existing.digest)accepted=true;}
   if(!accepted)fail('NATIVE_ACCEPTANCE_PROOF_MISSING');
   for(let chunkIndex=0;chunkIndex<packet.chunks.length;chunkIndex++)await call('putChunkTrusted',{contentDigest:record.revision,chunkIndex,bytes:packet.chunks[chunkIndex]});
   await call('publishContentTrusted',packet.manifest);
   return{ok:true,status:'already-accepted',bankUid:record.bankUid,contentDigest:record.revision,sourceDeleted:false};
  }
 }
 for(let chunkIndex=0;chunkIndex<packet.chunks.length;chunkIndex++)await call('putChunkTrusted',{contentDigest:record.revision,chunkIndex,bytes:packet.chunks[chunkIndex]});
 await call('publishContentTrusted',packet.manifest);
 const mutation={protocolVersion:2,mutationId:await deterministicUuid(['qb-operator-bank-v1',claim.generation,record.bankUid,record.revision]),clientStreamId:await deterministicUuid(['qb-operator-bank-stream-v1',claim.generation,record.bankUid,record.revision]),clientSeq:1,kind:'bank_revision',entityKey:`bank:${record.bankUid}`,payload:{schemaVersion:1,...record,baseRevision:0},payloadDigest:'0'.repeat(64)};
 mutation.payloadDigest=await computeMutationDigest(mutation);
 const result=await call('pushTrusted',{protocolVersion:2,accountGeneration:claim.generation,mutations:[mutation]});
 const receipt=result.response?.receipts?.[0];if(!receipt||!['accepted','duplicate'].includes(receipt.status))fail('NATIVE_SOURCE_CONFLICT');
 return{ok:true,status:receipt.status,bankUid:record.bankUid,contentDigest:record.revision,sourceDeleted:false};
}
async function contentPacket(value){
 const bytes=canonicalContentBytes(value);if(bytes.length>3*1024*1024)fail('NATIVE_CONTENT_LIMIT');
 const contentDigest=await sha256Hex(bytes),chunks=[];for(let at=0;at<bytes.length;at+=512*1024)chunks.push(bytes.slice(at,at+512*1024));
 const manifest={schemaVersion:1,contentDigest,totalBytes:bytes.length,chunkCount:chunks.length,chunks:await Promise.all(chunks.map(async(bytes,chunkIndex)=>({chunkIndex,byteLength:bytes.length,sha256:await sha256Hex(bytes)})))};
 return{chunks,manifest,reference:{contentDigest,manifestDigest:await sha256Hex(canonicalBytes(manifest)),totalBytes:bytes.length,chunkCount:chunks.length}};
}
async function mintPlan(sql,owned,before,body,banks=[],bankSources=[]){
  const bodyBytes=canonicalContentBytes(body), contentDigest=await sha256Hex(bodyBytes), chunks=[];
  if(bodyBytes.length>3*1024*1024)fail('HISTORY_BODY_LIMIT');
  for(let at=0;at<bodyBytes.length;at+=512*1024)chunks.push(bodyBytes.slice(at,at+512*1024));
  const manifest={schemaVersion:1,contentDigest,totalBytes:bodyBytes.length,chunkCount:chunks.length,
    chunks:await Promise.all(chunks.map(async(bytes,chunkIndex)=>({chunkIndex,byteLength:bytes.length,sha256:await sha256Hex(bytes)})))};
  const reference={contentDigest,manifestDigest:await sha256Hex(canonicalBytes(manifest)),totalBytes:bodyBytes.length,chunkCount:chunks.length};
  const payload={schemaVersion:1,snapshotId:body.snapshotId,accountGeneration:owned.generation,source:body.source,recordedAt:body.recordedAt,summary:body.summary,scopeCount:body.scope.length,reference,baseRevision:0};
  await validateHistorySnapshotBinding(payload,body,{accountGeneration:owned.generation});
  const mutation={protocolVersion:2,mutationId:await deterministicUuid(['qb-operator-history-v1',owned.generation,body.snapshotId]),
    clientStreamId:await deterministicUuid(['qb-operator-history-stream-v1',owned.generation,body.snapshotId]),clientSeq:1,
    kind:'history_snapshot',entityKey:`history_snapshot:${body.snapshotId}`,payload,payloadDigest:'0'.repeat(64)};
  mutation.payloadDigest=await computeMutationDigest(mutation);
  const plan={command:owned,before,body,chunks,manifest,mutation,banks,bankSources};sameCapture(sql,plan);
  const capability=Object.freeze({snapshotId:body.snapshotId,contentDigest});plans.set(capability,{sql,plan});return capability;
}
async function proveAcceptedSnapshot(sql,p){
 const entity=rows(sql,"SELECT * FROM gen06_entities WHERE kind='history_snapshot' AND entity_key=?",p.mutation.entityKey)[0];
 if(!entity||!equal(JSON.parse(entity.payload_json),p.mutation.payload))fail('NATIVE_SOURCE_CONFLICT');
 const change=rows(sql,'SELECT record_json FROM gen06_change_log WHERE server_seq=?',entity.server_seq)[0];
 const c=change&&JSON.parse(change.record_json);
 if(!c||c.kind!=='history_snapshot'||c.accountGeneration!==p.command.generation||c.entityKey!==p.mutation.entityKey||c.payloadDigest!==entity.digest||!equal(c.payload,p.mutation.payload))fail('NATIVE_ACCEPTANCE_PROOF_MISSING');
 const receipts=rows(sql,"SELECT receipt_json,mutation_json,digest FROM gen06_mutation_receipts WHERE json_extract(receipt_json,'$.serverSeq')=? AND digest=? LIMIT 2",entity.server_seq,entity.digest);
 let accepted=false;
 for(const row of receipts){const receipt=JSON.parse(row.receipt_json),mutation=JSON.parse(row.mutation_json||'null');if(receipt.status==='accepted'&&mutation&&mutation.kind==='history_snapshot'&&mutation.entityKey===p.mutation.entityKey&&equal(mutation.payload,p.mutation.payload)&&await computeMutationDigest(mutation)===entity.digest&&receipt.payloadDigest===entity.digest)accepted=true;}
 if(!accepted)fail('NATIVE_ACCEPTANCE_PROOF_MISSING');
 for(const packet of [{manifest:p.manifest,chunks:p.chunks},...p.banks.flatMap(bank=>bank.packet?[bank.packet]:[])]){
  const stored=rows(sql,'SELECT manifest_json,manifest_digest FROM gen06_content_manifests WHERE content_digest=?',packet.manifest.contentDigest)[0];
  if(!stored||!equal(JSON.parse(stored.manifest_json),packet.manifest)||stored.manifest_digest!==await sha256Hex(canonicalBytes(packet.manifest)))fail('NATIVE_CONTENT_PROOF_MISSING');
  for(const expected of packet.manifest.chunks){const chunk=rows(sql,'SELECT bytes FROM gen06_content_chunks WHERE content_digest=? AND chunk_index=?',packet.manifest.contentDigest,expected.chunkIndex)[0];if(!chunk||await sha256Hex(new Uint8Array(chunk.bytes))!==expected.sha256)fail('NATIVE_CONTENT_PROOF_MISSING');}
 }
 for(const row of p.body.scope)for(const ref of row.equivalentSourceRefs){const bankUid=ref.questionKey.split('/')[0];if(!rows(sql,'SELECT question_key FROM gen06_bank_questions WHERE bank_uid=? AND bank_revision=? AND question_key=? AND question_revision=?',bankUid,ref.bankRevision,ref.questionKey,ref.questionRevision).length)fail('NATIVE_QUESTION_PROOF_MISSING');}
}

/** Use existing normal content+push validators and acceptance receipts. This
 * function never deletes source, changes account lifecycle, or creates events.
 * SQL binding, generation and sealed fence are rechecked after every await.
 * A future cross-Authority adapter still needs atomic identity serialization. */
export async function executeLegacyNativeHistory(sql, capability, {store,claim,checkAuthority=async()=>{}}) {
  const minted=plans.get(capability);if(!minted||minted.sql!==sql)fail('INVALID_CONVERSION_CAPABILITY');
  const p=minted.plan;
  if(!claim||claim.principal!==p.command.principal||claim.incarnation!==p.command.incarnation||claim.generation!==p.command.generation)fail('STALE_CONVERSION_OWNER');
  const guard=()=>sameCapture(sql,p);
  const call=async(method,input)=>{guard();await checkAuthority();guard();const r=await store[method](claim,input);guard();await checkAuthority();guard();if(r?.ok!==true)fail(r?.error||'NATIVE_CONVERSION_UNAVAILABLE');return r;};
  guard();
  const initialized=rows(sql,"SELECT name FROM sqlite_master WHERE type='table' AND name='gen06_entities'").length===1;
  const existing=initialized?rows(sql,"SELECT payload_json FROM gen06_entities WHERE kind='history_snapshot' AND entity_key=?",p.mutation.entityKey)[0]:null;
  if(existing){await proveAcceptedSnapshot(sql,p);guard();await checkAuthority();guard();return{ok:true,status:'already-accepted',snapshotId:p.body.snapshotId,sourceDeleted:false};}
  for(const bank of p.banks){
   const record=bank.record,current=initialized?rows(sql,'SELECT record_json FROM gen06_bank_revisions WHERE bank_uid=? AND revision=?',record.bankUid,record.revision)[0]:null;
   if(bank.packet){for(let chunkIndex=0;chunkIndex<bank.packet.chunks.length;chunkIndex++)await call('putChunkTrusted',{contentDigest:bank.packet.manifest.contentDigest,chunkIndex,bytes:bank.packet.chunks[chunkIndex]});await call('publishContentTrusted',bank.packet.manifest);}
   if(current){if(!equal(JSON.parse(current.record_json),record))fail('NATIVE_SOURCE_CONFLICT');continue;}
   const bankMutation={protocolVersion:2,mutationId:await deterministicUuid(['qb-operator-bank-v1',claim.generation,record.bankUid,record.revision]),
    clientStreamId:await deterministicUuid(['qb-operator-bank-stream-v1',claim.generation,record.bankUid,record.revision]),clientSeq:1,kind:'bank_revision',entityKey:`bank:${record.bankUid}`,payload:{schemaVersion:1,...record,baseRevision:0},payloadDigest:'0'.repeat(64)};
   bankMutation.payloadDigest=await computeMutationDigest(bankMutation);
   const result=await call('pushTrusted',{protocolVersion:2,accountGeneration:claim.generation,mutations:[bankMutation]});
   if(!['accepted','duplicate'].includes(result.response?.receipts?.[0]?.status))fail('NATIVE_SOURCE_CONFLICT');
  }
  for(let chunkIndex=0;chunkIndex<p.chunks.length;chunkIndex++)await call('putChunkTrusted',{contentDigest:p.manifest.contentDigest,chunkIndex,bytes:p.chunks[chunkIndex]});
  await call('publishContentTrusted',p.manifest);
  const pushed=await call('pushTrusted',{protocolVersion:2,accountGeneration:claim.generation,mutations:[p.mutation]});
  const receipt=pushed.response?.receipts?.[0];
  if(!receipt||!['accepted','duplicate'].includes(receipt.status))fail('NATIVE_SOURCE_CONFLICT');
  return{ok:true,status:receipt.status,snapshotId:p.body.snapshotId,sourceDeleted:false};
}
