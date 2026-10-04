import {canonicalContentBytes,canonicalBytes,canonicalDigest,sha256Hex,validateMutationRecord,verifyMutationDigest} from '../domain/app-data/index.js';
import {validateCloudReceipt} from '../storage/cloud-recovery/metadata.js';
import {snapshotOwner} from '../storage/profiles/control-schema.js';
import {validateSyncChangeReceipt,mutationWire} from '../storage/sync/protocol.js';
export const MIGRATION_SOURCE_ORIGIN='https://shicheng0810.github.io',MIGRATION_TARGET_ORIGIN='https://question-bank-78u.pages.dev';
const fail=code=>{throw Object.assign(new Error(code),{code});};
const same=(a,b)=>new TextDecoder().decode(canonicalBytes(a))===new TextDecoder().decode(canonicalBytes(b));
export async function verifySourceDeclaration(source,manifest,owner){snapshotOwner(owner);if(source?.format!=='qb-old-native-export-v1'||source.sourceOrigin!==MIGRATION_SOURCE_ORIGIN||!same(source.owner,owner)||source.manifestDigest!==await canonicalDigest(manifest)||!/^[a-f0-9]{64}$/.test(source.sourceContentDigest||''))fail('SOURCE_DECLARATION_INVALID');return {sourceOriginDeclared:source.sourceOrigin,sourceSnapshotDigestDeclared:source.sourceContentDigest,sourceProfileIdDeclared:source.profileId,sourceControlIdDeclared:source.controlId,sourceActivationRevisionDeclared:source.activationRevision,sourceWindowIdDeclared:source.sourceWindowId??null,sourceBindingAuthenticated:false,sourceRecaptureRequired:true,portableManifestDigestVerified:await canonicalDigest(manifest)};}
export const normalizedPortableRow=async(store,row)=>store==='content_chunks'?{contentDigest:row.contentDigest,chunkIndex:row.chunkIndex,byteLength:row.bytes.byteLength,sha256:await sha256Hex(row.bytes)}:row;
export async function portableObjectComparison(source,target,{allowReconstructedMetadata=false,permanentReceipts=null,owner,isCurrent=()=>true}={}){
 const objects=[],derived=[],missing=[];if(source.mutations&&new Set(source.mutations.map(r=>r.mutationId)).size!==source.mutations.length)fail('SOURCE_MUTATION_DUPLICATE');const guard=()=>{if(!isCurrent())fail('STALE_OWNER');};guard();
 for(const [namespace,rows] of Object.entries(source)){if(['meta','writer_leases'].includes(namespace))continue;const actual=target[namespace];const dig=async row=>sha256Hex(canonicalContentBytes(await normalizedPortableRow(namespace,row)));const counts=new Map();for(const row of actual){const d=await dig(row);counts.set(d,(counts.get(d)||0)+1);}const originalDigests=[];
 for(const row of rows){guard();const original=await dig(row);originalDigests.push(original);if((counts.get(original)||0)>0&&!(allowReconstructedMetadata&&namespace==='mutations')){counts.set(original,counts.get(original)-1);continue;}let changed=null,rule=null;
 if(allowReconstructedMetadata&&namespace==='import_receipts'&&row.provenance?.format==='qb-sync-change-v1'){const matches=actual.filter(r=>r.sourceId===row.sourceId&&r.sourceRecordId===row.sourceRecordId);if(matches.length===1){const received=matches[0];await validateSyncChangeReceipt(row);await validateSyncChangeReceipt(received);if(row.provenance.generation===owner.accountGeneration&&same(row.provenance,received.provenance)&&same({...row,importedAt:0},{...received,importedAt:0})){changed=received;rule='validated-sync-change-new-local-importedAt';}}}
 if(allowReconstructedMetadata&&namespace==='mutations'){
 validateMutationRecord(row);if(row.accountGeneration!==owner.accountGeneration||!await verifyMutationDigest(mutationWire(row)))fail('SOURCE_MUTATION_INVALID');const wire=mutationWire(row),permanent=permanentReceipts?.rows.get(row.mutationId);
 if(permanent&&permanentReceipts.generation===owner.accountGeneration&&BigInt(permanent.receipt.serverSeq||'0')<=BigInt(permanentReceipts.cut)&&same(permanent.mutation,wire)&&['accepted','duplicate'].includes(permanent.receipt.status)){
 const candidates=target.import_receipts.filter(r=>r.provenance?.format==='qb-sync-change-v1'&&r.provenance.generation===owner.accountGeneration&&r.provenance.logEpoch===permanentReceipts.logEpoch&&r.provenance.change?.serverSeq===permanent.receipt.serverSeq);
 if(candidates.length===1){const accepted=await validateSyncChangeReceipt(candidates[0]);
 await validateCloudReceipt({sourceId:`qb-cloud-receipt-v1:${owner.accountGeneration}:${permanentReceipts.logEpoch}`,sourceRecordId:row.mutationId,importedAt:0,provenance:{format:'qb-cloud-receipt-v1',generation:owner.accountGeneration,logEpoch:permanentReceipts.logEpoch,...permanent}},{generation:owner.accountGeneration,logEpoch:permanentReceipts.logEpoch,cut:permanentReceipts.cut,change:accepted.provenance.change});
 derived.push({namespace,rule:'original-local-journal-archived-only; exact-original-wire-permanent-cloud-receipt',sourceObjectDigest:original,sourceMutationId:row.mutationId,clientStreamId:wire.clientStreamId,clientSeq:wire.clientSeq,permanentReceiptDigest:await sha256Hex(canonicalBytes(permanent)),activeReceiptDigest:await sha256Hex(canonicalContentBytes(accepted)),serverSeq:permanent.receipt.serverSeq,logEpoch:permanentReceipts.logEpoch});continue;}
 }
 }

 if(changed)derived.push({namespace,rule,sourceObjectDigest:original,targetObjectDigest:await dig(changed),sourceOperationTime:row.importedAt??row.createdAt,targetOperationTime:changed.importedAt??changed.createdAt});else missing.push({namespace,sourceObjectDigest:original});
 }
 objects.push({namespace,objectDigests:originalDigests.sort()});
 }guard();return {objects,derived,missing};
}
