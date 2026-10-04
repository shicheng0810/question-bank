import {canonicalBytes,canonicalContentBytes,sha256Hex} from '../../src/domain/app-data/index.js';
import {validateCloudCheckpoint,CLOUD_SECTION_PATHS} from './account-cloud-checkpoint.js';
import {validateExportManifest} from '../../src/domain/app-data/export-manifest.js';
import {validateCursorReset} from '../../src/domain/app-data/auth-recovery.js';
const hex=x=>typeof x==='string'&&/^[0-9a-f]{64}$/.test(x);
const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[48][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(x);
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Reflect.ownKeys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k)&&'value'in Object.getOwnPropertyDescriptor(x,k));
export function validNativeProofCommand(x){
 if(!exact(x,['principal','incarnation','generation','authorityFence','manifestSha256','operation','exportId','section','after','contentDigest','chunkIndex'])||!hex(x.principal)||!hex(x.incarnation)||x.principal===x.incarnation||!uuid(x.generation)||!hex(x.manifestSha256)||!Number.isSafeInteger(x.authorityFence)||x.authorityFence<0)return false;
 if(x.operation==='start')return[x.exportId,x.section,x.after,x.contentDigest,x.chunkIndex].every(v=>v===null);
 if(x.operation==='source-chunk')return x.exportId===null&&typeof x.section==='string'&&new TextEncoder().encode(x.section).length<=128&&/^(history:.+|bank:.+:(meta|questions))$/.test(x.section)&&x.after===null&&hex(x.contentDigest)&&Number.isSafeInteger(x.chunkIndex)&&x.chunkIndex>=0&&x.chunkIndex<200;
 if(!uuid(x.exportId))return false;
 if(x.operation==='page')return CLOUD_SECTION_PATHS.includes(x.section)&&typeof x.after==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(x.after)&&x.contentDigest===null&&x.chunkIndex===null;
 if(x.operation==='chunk')return x.section===null&&x.after===null&&hex(x.contentDigest)&&Number.isSafeInteger(x.chunkIndex)&&x.chunkIndex>=0&&x.chunkIndex<200;
 if(x.operation==='reset')return[x.section,x.after,x.contentDigest,x.chunkIndex].every(v=>v===null);return false;
}
export async function safeNativeProofResult(value,command){
 if(!exact(value,['ok','operation','body'])||value.ok!==true||value.operation!==command.operation)return null;
 const body=value.body;
 try{
  if(command.operation==='source-chunk'){
   if(!exact(body,['ok','sourceKey','sourceDigest','totalBytes','chunkCount','chunkIndex','digest','byteLength','bytes'])||body.ok!==true||body.sourceKey!==command.section||body.sourceDigest!==command.contentDigest||body.chunkIndex!==command.chunkIndex||!(body.bytes instanceof Uint8Array)||body.bytes.length<1||body.bytes.length>256*1024||body.byteLength!==body.bytes.length||!Number.isSafeInteger(body.totalBytes)||body.totalBytes<body.byteLength||body.totalBytes>1900000||!Number.isSafeInteger(body.chunkCount)||body.chunkCount<1||body.chunkCount>8||body.chunkIndex>=body.chunkCount||!hex(body.digest)||await sha256Hex(body.bytes)!==body.digest)return null;
  }else if(command.operation==='chunk'){
   if(!exact(body,['ok','bytes','byteLength','digest'])||body.ok!==true||!(body.bytes instanceof Uint8Array)||body.bytes.length<1||body.bytes.length>512*1024||body.byteLength!==body.bytes.length||!hex(body.digest)||await sha256Hex(body.bytes)!==body.digest)return null;
  }else{
   if(canonicalContentBytes(body).length>768*1024)return null;
   if(command.operation==='start'){if(!exact(body,['ok','exportId','expiresAt','manifest','manifestDigest','checkpoint','checkpointDigest'])||body.ok!==true||!hex(body.manifestDigest)||!hex(body.checkpointDigest))return null;const manifest=validateExportManifest(body.manifest),checkpoint=validateCloudCheckpoint(body.checkpoint);if(!checkpoint.complete||checkpoint.generation!==command.generation||checkpoint.exportId!==body.exportId||checkpoint.expiresAt!==body.expiresAt||body.expiresAt<=Date.now()||manifest.exportId!==checkpoint.exportId||manifest.accountGeneration!==command.generation||manifest.serverLogEpoch!==checkpoint.logEpoch||manifest.exportCut!==checkpoint.cut||manifest.throughServerSeq!==checkpoint.cut||await sha256Hex(canonicalBytes(manifest))!==body.manifestDigest||await sha256Hex(canonicalBytes(checkpoint))!==body.checkpointDigest)return null;}
   if(command.operation==='page'){if(!exact(body,['ok','exportId','section','records','next','hasMore','exportCut'])||body.ok!==true||body.exportId!==command.exportId||body.section!==command.section||!Array.isArray(body.records)||body.records.length>100||typeof body.hasMore!=='boolean'||typeof body.next!=='string'||!/^(0|[1-9][0-9]{0,19})$/.test(body.next)||typeof body.exportCut!=='string'||!/^(0|[1-9][0-9]{0,19})$/.test(body.exportCut))return null;}
   if(command.operation==='reset'){if(!exact(body,['ok','reset'])||body.ok!==true)return null;const reset=validateCursorReset(body.reset);if(reset.resetExportId!==command.exportId||reset.generation!==command.generation)return null;}
  }
  return structuredClone(value);
 }catch{return null;}
}
