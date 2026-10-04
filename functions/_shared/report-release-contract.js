import {reportError} from './native-report.js';
import {sha256Hex} from '../../src/domain/app-data/canonical.js';
export const RELEASE_HEAD='report-production-head-v1';
const hash=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const uuid=v=>typeof v==='string'&&/^[a-f0-9-]{36}$/.test(v);
export async function assertArtifact(artifact){
 if(artifact?.schema!==3||!Array.isArray(artifact.manifest)||artifact.manifest.length>100||artifact.manifest.some(r=>!/^[-\w./]+$/.test(r.path)||r.path.startsWith('/')||r.path.split('/').some(p=>p==='..'||p==='.'||!p)||!hash(r.sha256))||new Set(artifact.manifest.map(r=>r.path)).size!==artifact.manifest.length||!artifact.manifest.some(r=>r.path==='_worker.js')||!artifact.manifest.some(r=>r.path==='_routes.json')||!artifact.manifest.some(r=>r.path==='_worker.bundle')||artifact.worker?.entry!=='index.js'||!hash(artifact.worker.sha256)||!hash(artifact.worker.metadataHash)||!hash(artifact.pagesBundleHash)||!hash(artifact.pagesContractHash))throw reportError('REPORT_ARTIFACT_INVALID');
 const {sha256,...typed}=artifact;if(await sha256Hex(new TextEncoder().encode(JSON.stringify(typed)))!==sha256)throw reportError('REPORT_ARTIFACT_HASH');
 if(artifact.manifest.find(r=>r.path==='_worker.bundle').sha256!==artifact.pagesBundleHash)throw reportError('REPORT_ARTIFACT_BUNDLE');
}
export function assertUploadReceipt(receipt,plan,deployment){
 const a=plan.artifact,j=plan.uploadJob||plan.controlJob;
 if(!/^[a-f0-9]{40}$/.test(j?.runSha||'')||receipt?.schema!==3||receipt.operationId!==plan.operationId||receipt.resultCommit!==plan.resultCommit||receipt.artifactHash!==a?.sha256||receipt.target!==plan.domain||receipt.runId!==j?.runId||receipt.runAttempt!==j.runAttempt||receipt.workflowSha!==j.workflowSha||receipt.runSha!==j.runSha||receipt.fence!==j.fence||receipt.workerHash!==a.worker.sha256||receipt.workerMetadataHash!==a.worker.metadataHash||receipt.pagesContractHash!==a.pagesContractHash||receipt.pagesBundleHash!==a.pagesBundleHash||receipt.workerVersionId!==deployment.workerVersionId||receipt.deploymentId!==deployment.deploymentId||receipt.workerUploadResponseId!==deployment.workerVersionId||receipt.pagesUploadResponseId!==deployment.deploymentId||!uuid(receipt.workerDeploymentId)||!hash(receipt.staticManifestHash))throw reportError('REPORT_UPLOAD_RECEIPT_CONFLICT');
 return receipt;
}
export function assertActivePointers(p,receipt,plan){
 if(!p||p.workerVersionId!==receipt.workerVersionId||p.workerDeploymentId!==receipt.workerDeploymentId||p.workerPercentage!==100||p.workerVersions!==1||p.pagesDeploymentId!==receipt.deploymentId||p.project!=='question-bank'||p.environment!=='production'||p.commit!==plan.resultCommit||p.status!=='success'||p.pagesBundleHash!==receipt.pagesBundleHash||p.workerHash!==receipt.workerHash)throw reportError('REPORT_ACTIVE_POINTER_CONFLICT');
 return p;
}
export function assertBaseline(head,observed,source){
 if(!head||head.inflight||head.commit!==source||observed?.commit!==head.commit||observed.pagesDeploymentId!==head.pagesDeploymentId||observed.workerVersionId!==head.workerVersionId||observed.workerDeploymentId!==head.workerDeploymentId)throw reportError('REPORT_RELEASE_HEAD_DRIFT');
}
