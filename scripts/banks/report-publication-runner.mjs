import {inspectReportData,importReportData} from './report-data-import.mjs';
import {readFile} from 'node:fs/promises';import path from 'node:path';import {execFileSync} from 'node:child_process';import {pathToFileURL} from 'node:url';
import {validateReportPR} from './validate-native-report-pr.mjs';import {assertPublicRequest} from '../../functions/_shared/public-report-contract.js';import {buildReportRelease,deployReportRelease,readWorkerRelease,readProductionPointers} from './report-cloudflare-adapter.mjs';import {verifyOnlineRelease} from './verify-report-online.mjs';
export async function runAutomaticPublication({trustedRoot,dataRoot,prNumber,expectedCommit,operationId}){
 if(!/^\d+$/.test(String(prNumber))||!/^[a-f0-9]{40}$/.test(expectedCommit)||!/^[a-f0-9-]{36}$/.test(operationId))throw Error('REPORT_PUBLICATION_INPUT');
 await inspectReportData(dataRoot);
 const request=assertPublicRequest(JSON.parse(execFileSync('git',['show',expectedCommit+':content/report-requests/'+operationId+'.json'],{cwd:dataRoot,encoding:'utf8',maxBuffer:64*1024})));
 const git=(...args)=>execFileSync('git',args,{cwd:dataRoot,encoding:'utf8'}).trim();if(git('rev-parse','HEAD')!==expectedCommit)throw Error('REPORT_PUBLICATION_HEAD');
 const verified=await validateReportPR({root:dataRoot,base:request.baseCommit,head:expectedCommit,operationId,sourcesFile:'content/report-sources.json'});
 // Data imports are exact generated public files. Never execute proposed scripts,
 // package lifecycle hooks, arbitrary modules, workflow or templates.
 await importReportData({trustedRoot,dataRoot,verified,expectedCommit,requestPath:'content/report-requests/'+operationId+'.json'});
 const manifest=JSON.parse(await readFile(path.join(trustedRoot,verified.siteManifest),'utf8')),entry=manifest.banks.find(b=>b.bankUid===request.pending.bankUid&&b.revision===verified.revision);if(!entry)throw Error('REPORT_RESULT_BANK');
 const content=JSON.parse(await readFile(path.join(trustedRoot,'production-inputs',entry.contentFile),'utf8')),question=content.questions.find(q=>q.questionKey===request.pending.questionKey);if(!question)throw Error('REPORT_RESULT_QUESTION');
 const plan={operationId,prNumber:Number(prNumber),sourceCommit:request.baseCommit,resultCommit:expectedCommit,bankUid:entry.bankUid,questionKey:question.questionKey,revision:entry.revision,questionRevision:question.questionRevision,contentHash:entry.revision,domain:'question-bank-78u.pages.dev',staticRef:entry.staticRef};
 const audience='https://question-bank-78u.pages.dev/api/report-control';
 let fence;
 async function control(action,extras={}){const url=new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);url.searchParams.set('audience',audience);const oidcResponse=await fetch(url,{headers:{authorization:'Bearer '+process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}});if(!oidcResponse.ok)throw Error('REPORT_OIDC_TOKEN_UNAVAILABLE');const {value}=await oidcResponse.json();const response=await fetch(audience,{method:'POST',headers:{authorization:'Bearer '+value,'content-type':'application/json'},body:JSON.stringify({operationId,action,fence,...extras}),signal:AbortSignal.timeout(30000)});if(!response.ok)throw Error('REPORT_CONTROL_REJECTED');return response.json();}
 const state=await control('get');if(state.state==='published')return {state:'published',duplicate:true};
 if(!['pr_created','readback_pending','readback_failed','receipt_pending'].includes(state.state))return {state:state.state,blocked:true};
 // Full local build and exact content validation precede durable publish claim.
 const release=await buildReportRelease({root:trustedRoot,plan});
 const artifact=release.artifact;
 if(state.state==='receipt_pending'){
  const receipt=JSON.parse(state.result);if(receipt.artifact?.sha256!==artifact.sha256||receipt.resultCommit!==expectedCommit||receipt.domain!==plan.domain)throw Error('REPORT_RECOVERY_ARTIFACT_CONFLICT');
  const recorded={deploymentId:receipt.deploymentId,workerVersionId:receipt.workerVersionId,url:receipt.url,shortId:receipt.shortId,resultCommit:receipt.resultCommit,uploadReceipt:receipt.uploadReceipt};
  try{await verifyOnlineRelease({plan:receipt,deployment:recorded,releaseManifest:release.manifest.filter(row=>!['_worker.js','_routes.json','_worker.bundle','_headers','_redirects'].includes(row.path)),readLocal:file=>readFile(path.join(release.output,file)),workerReadback:()=>readWorkerRelease(control,receipt,recorded)});}catch{return {state:'receipt_pending',blocked:true,code:'REPORT_RECEIPT_READBACK_FAILED'};}
  const resumed=await control('resumeReceipt',{expectedResult:state.result,fence:receipt.controlJob.fence,resultCommit:expectedCommit,artifactHash:artifact.sha256,target:plan.domain,...recorded});if(!resumed.resumed)return {state:'receipt_pending',blocked:true};fence=resumed.fence;return control('sendReceipt');
 }
 let deployment,boundPlan;
 if(state.state==='pr_created'){
  const claimed=await control('claim',{plan,artifact,baseline:await readProductionPointers()});if(!claimed.claimed)return {state:'blocked',duplicate:true};fence=claimed.fence;
  boundPlan=JSON.parse((await control('get')).result);
  try{deployment=await deployReportRelease({root:trustedRoot,release,plan:boundPlan,job:boundPlan.uploadJob,recordStage:upload=>control('recordUpload',{upload})});}catch{await control('deploymentUnknown');return {state:'deployment_unknown'};}
  if(!(await control('recordDeployment',{deployment})).changed)return {state:'blocked'};
 }else{
  const saved=JSON.parse(state.result);if(saved.plan?.artifact?.sha256!==artifact.sha256)throw Error('REPORT_RECOVERY_ARTIFACT_CONFLICT');deployment=saved.deployment;
  boundPlan=saved.plan;
  const resumed=await control('resumeReadback',{expectedResult:state.result,fence:saved.plan.controlJob.fence,resultCommit:expectedCommit,artifactHash:artifact.sha256,target:plan.domain,...deployment});if(!resumed.resumed)return {state:'blocked'};fence=resumed.fence;boundPlan=JSON.parse((await control('get')).result).plan;
 }
 let proof;try{proof=await verifyOnlineRelease({plan:boundPlan,deployment,releaseManifest:release.manifest.filter(row=>!['_worker.js','_routes.json','_worker.bundle','_headers','_redirects'].includes(row.path)),readLocal:file=>readFile(path.join(release.output,file)),workerReadback:()=>readWorkerRelease(control,boundPlan,deployment)});}catch{await control('readbackFailure');return {state:'readback_failed',recoverableBy:'resumeReadback'};}
 proof={...proof,artifactHash:artifact.sha256};
 await control('readback',{proof});return control('sendReceipt');
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href){const [dataRoot,prNumber,expectedCommit,operationId]=process.argv.slice(2);const result=await runAutomaticPublication({trustedRoot:process.cwd(),dataRoot:path.resolve(dataRoot),prNumber,expectedCommit,operationId});console.log(JSON.stringify(result));if(result.state!=='published')process.exitCode=1;}
