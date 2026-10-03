import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {frozenPublicBanks} from '../../src/domain/question/frozen-public-registry.js';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
// Actual HTTP bytes; no callback adapter substitutes for online acceptance.
export async function verifyOnlineRelease({plan,deployment,releaseManifest,readLocal,fetchHTTP=fetch,workerReadback}){
 if(plan.domain!=='question-bank-78u.pages.dev'||!/^[-a-f0-9]{36}$/.test(deployment.deploymentId))throw Error('REPORT_READBACK_TARGET');
 for(const root of [`https://${deployment.deploymentId}.question-bank-78u.pages.dev/`,'https://question-bank-78u.pages.dev/']){
  for(const row of releaseManifest){if(!/^[\w./-]+$/.test(row.path)||row.path.split('/').includes('..'))throw Error('REPORT_READBACK_PATH');const response=await fetchHTTP(new URL(row.path,root),{cache:'no-store',signal:AbortSignal.timeout(30000)});if(!response.ok)throw Error('REPORT_READBACK_HTTP');const bytes=new Uint8Array(await response.arrayBuffer());if(hash(bytes)!==row.sha256)throw Error('REPORT_READBACK_BYTES');}
  const content=JSON.parse(new TextDecoder().decode(await readLocal(plan.staticRef)));if(hash(await readLocal(plan.staticRef))!==plan.revision||!content.questions.some(q=>q.questionKey===plan.questionKey&&q.questionRevision===plan.questionRevision))throw Error('REPORT_READBACK_IDENTITY');
 }
 for(const bank of frozenPublicBanks)if(!releaseManifest.some(row=>row.path===bank.contentManifest.staticRef&&row.sha256===bank.revision))throw Error('REPORT_RETAINED_DEPENDENCY');
 const worker=await workerReadback();if(worker.versionId!==deployment.workerVersionId||worker.gatesVerified!==true||worker.registryVerified!==true)throw Error('REPORT_WORKER_READBACK');
 return {operationId:plan.operationId,resultCommit:plan.resultCommit,contentHash:plan.contentHash,workerVersionId:deployment.workerVersionId,retainedRevisionsVerified:true,allPublishedBytesVerified:true};
}
