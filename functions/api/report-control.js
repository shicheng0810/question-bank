import {RELEASE_HEAD,assertArtifact,assertUploadReceipt,assertActivePointers,assertBaseline} from '../_shared/report-release-contract.js';
import {reportDeploymentURL} from '../_shared/report-deployment-url.js';
import {authorizeReadbackRecovery} from '../_shared/report-readback-recovery.js';
import {verifyReportOIDC,assertReportRunBinding,nextRecoveryJob} from '../_shared/report-oidc.js';
import {boundedJson} from '../_shared/native-report-publisher.js';
import {publicCorrection} from '../_shared/public-report-contract.js';
const json=(value,status=200)=>Response.json(value,{status});
async function github(env,path,publicRead=false){const response=await fetch('https://api.github.com/repos/shicheng0810/question-bank-source/'+path,{headers:{...(publicRead?{}:{authorization:`Bearer ${env.GITHUB_TOKEN}`}),accept:'application/vnd.github+json','user-agent':'qb-report-control'},signal:AbortSignal.timeout(15000)});if(!response.ok)throw Error('REPORT_CONTROL_GITHUB_DENIED');return boundedJson(response);}
export async function onRequestPost({request,env}) {
 try {
  const policy=JSON.parse(env.REPORT_OIDC_POLICY_JSON||'null');
  const job=await verifyReportOIDC(request.headers.get('authorization')?.replace(/^Bearer /,''),policy);
  if(!env.REPORT_OPERATIONS)throw Error('REPORT_LEDGER_NOT_CONFIGURED');
  const body=await boundedJson(request,64*1024),id=body.operationId;
  if(!/^[a-f0-9-]{36}$/.test(id||'')||!['releaseHead','get','claim','recordUpload','recordDeployment','readback','sendReceipt','deploymentUnknown','workerCapability','resumeReceipt','resumeReadback','readbackFailure'].includes(body.action))throw Error('REPORT_CONTROL_INPUT_INVALID');
  const headLedger=env.REPORT_OPERATIONS.getByName(RELEASE_HEAD);
  if(body.action==='releaseHead')return json(await headLedger.releaseHead());
  const ledger=env.REPORT_OPERATIONS.getByName(id),row=await ledger.get(id);if(!row)return json({error:'REPORT_OPERATION_MISSING'},404);
  if(body.action==='workerCapability')return json(await ledger.capability());
  if(body.action==='get')return json({...row,payload:JSON.stringify(publicCorrection(JSON.parse(row.payload)))});
  if(body.action==='claim'){
   if(row.state!=='pr_created')return json({claimed:false,state:row.state});
   const plan=body.plan,pending=JSON.parse(row.payload),prResult=JSON.parse(row.result);
   if(plan?.operationId!==id||plan.prNumber!==prResult.number||plan.sourceCommit!==prResult.base||prResult.approval?.sourceBase!==plan.sourceCommit||plan.bankUid!==pending.bankUid||plan.questionKey!==pending.questionKey||plan.domain!=='question-bank-78u.pages.dev'||plan.revision!==plan.contentHash||!/^[a-f0-9]{64}$/.test(plan.revision)||!/^[a-f0-9]{64}$/.test(plan.questionRevision)||!/^[a-f0-9]{40}$/.test(plan.resultCommit)||!/^banks\/v2\/[\w.-]+\.json$/.test(plan.staticRef||''))throw Error('REPORT_CONTROL_PLAN_CONFLICT');
   const pr=await github(env,'pulls/'+plan.prNumber);
   if(!pr.merged_at||pr.merge_commit_sha!==plan.resultCommit||pr.base.ref!=='source'||pr.base.repo.id!==1403515803||pr.head.repo.id!==1403515803||pr.head.ref!=='codex/report-'+id||String(pr.user.id)!==String(env.REPORT_BOT_GITHUB_USER_ID))throw Error('REPORT_CONTROL_PR_CONFLICT');
   const current=await github(env,'git/ref/heads/source');if(current.object.sha!==plan.resultCommit)throw Error('REPORT_CONTROL_SOURCE_MOVED');
   const artifact=body.artifact;await assertArtifact(artifact);
   const releaseHead=await headLedger.releaseHead();assertBaseline(releaseHead,body.baseline,plan.sourceCommit);
   if(prResult.approval.releaseGeneration!==releaseHead.generation)throw Error('REPORT_APPROVAL_RELEASE_CONFLICT');
   const controlJob={...job,operationId:id,fence:1};
   // Global release-head CAS serializes across distinct operation DOs. A crash
   // leaves the head locked, never grants permission to repeat an upload.
   const claimedHead={...releaseHead,inflight:{operationId:id,resultCommit:plan.resultCommit,artifactHash:artifact.sha256}};
   if(!await headLedger.releaseCAS(releaseHead,claimedHead))return json({claimed:false});
   return json({claimed:await ledger.transitionBound(id,'pr_created','awaiting_deployment',{...plan,artifact,releaseHead:claimedHead,uploadJob:controlJob,uploads:[],controlJob},row.result),fence:1});
  }
  const result=JSON.parse(row.result||'null');
  const transition=(from,to,value)=>ledger.transitionBound(id,from,to,value,row.result);
  async function trustedRecoveryExecution(){
   const run=await github(env,'actions/runs/'+job.runId,true);
   const attempt=await github(env,'actions/runs/'+job.runId+'/attempts/'+job.runAttempt,true);
   for(const value of [run,attempt])if(String(value.id)!==job.runId||String(value.run_attempt)!==job.runAttempt||value.status!=='in_progress'||value.event!=='workflow_dispatch'||value.head_sha!==job.workflowSha||!policy.workflowPaths.some(p=>p===('shicheng0810/question-bank-source/'+value.path+'@refs/heads/main')))throw Error('REPORT_RECOVERY_EXECUTION_DENIED');
  }
  if(body.action==='resumeReadback'){
   const saved=authorizeReadbackRecovery(row,body,id);
   const nextJob=nextRecoveryJob(job,saved.plan.controlJob,id,body,row);await trustedRecoveryExecution();
   const rebound={...saved,plan:{...saved.plan,controlJob:nextJob}};
   if(!await transition(row.state,'reconciling_readback',rebound))return json({blocked:true});
   const resumed=await ledger.transitionBound(id,'reconciling_readback','readback_pending',rebound,JSON.stringify(rebound));return json({resumed,fence:nextJob.fence,state:resumed?'readback_pending':'reconciling_readback'});
  }
  if(body.action==='resumeReceipt'){
   if(row.state!=='receipt_pending')return json({blocked:true,state:row.state});
   const {controlJob,...receipt}=result;
   if(receipt.resultCommit!==body.resultCommit||receipt.operationId!==id||receipt.readbackVerified!==true||body.target!==receipt.domain||body.artifactHash!==receipt.artifact?.sha256||body.deploymentId!==receipt.deploymentId||body.workerVersionId!==receipt.workerVersionId||body.url!==receipt.url||body.shortId!==receipt.shortId)throw Error('REPORT_RECEIPT_RECOVERY_CONFLICT');
   const nextJob=nextRecoveryJob(job,result.controlJob,id,body,row);await trustedRecoveryExecution();
   if(!await transition('receipt_pending','reconciling_receipt',result))return json({blocked:true});
   return json({resumed:await ledger.transitionBound(id,'reconciling_receipt','receipt_pending',{...receipt,controlJob:nextJob},JSON.stringify(result)),fence:nextJob.fence});
  }
  assertReportRunBinding(job,result?.controlJob||result?.plan?.controlJob,id,body.fence);
  if(body.action==='readbackFailure'){if(row.state!=='readback_pending')return json({blocked:true,state:row.state});return json({changed:await transition('readback_pending','readback_failed',{...result,failure:{code:'REPORT_READBACK_VERIFICATION_FAILED',recoverableBy:'resumeReadback'}})});}
  if(body.action==='deploymentUnknown')return json({changed:await transition('awaiting_deployment','deployment_unknown',{plan:result,code:'REPORT_DEPLOYMENT_UNKNOWN'})});
  if(body.action==='recordUpload'){
   const event=body.upload,stages=['workerUploaded','workerActivated','pagesUploaded'],uploads=result.uploads||[];
   if(row.state!=='awaiting_deployment'||event?.stage!==stages[uploads.length]||event.artifactHash!==result.artifact.sha256||event.resultCommit!==result.resultCommit||event.workerHash!==result.artifact.worker.sha256||event.pagesBundleHash!==result.artifact.pagesBundleHash||!/^[a-f0-9-]{36}$/.test(event.providerId||''))throw Error('REPORT_UPLOAD_STAGE_CONFLICT');
   return json({changed:await ledger.updateBound(id,'awaiting_deployment',{...result,uploads:[...uploads,{...event,runId:job.runId,runAttempt:job.runAttempt,fence:body.fence}]},row.result)});
  }
  if(body.action==='recordDeployment'){
   if(row.state!=='awaiting_deployment'||!/^[-a-f0-9]{36}$/.test(body.deployment?.deploymentId||'')||!/^[-a-f0-9]{36}$/.test(body.deployment?.workerVersionId||''))throw Error('REPORT_CONTROL_DEPLOYMENT_INVALID');
   reportDeploymentURL(body.deployment,result.resultCommit);
   const upload=assertUploadReceipt(body.deployment.uploadReceipt,result,body.deployment);
   if(result.uploads?.length!==3||result.uploads[0].providerId!==upload.workerVersionId||result.uploads[1].providerId!==upload.workerDeploymentId||result.uploads[2].providerId!==upload.deploymentId)throw Error('REPORT_UPLOAD_STAGE_CONFLICT');
   return json({changed:await transition('awaiting_deployment','readback_pending',{plan:result,deployment:body.deployment})});
  }
  if(body.action==='readback'){
   if(row.state!=='readback_pending')return json({state:row.state,blocked:true});
   const {plan,deployment}=result;
   try {
    // Read the exact unique Pages deployment and canonical origin, no browser URL.
    const receiptURL=reportDeploymentURL(deployment,plan.resultCommit);
    const upload=assertUploadReceipt(deployment.uploadReceipt,plan,deployment);
    assertActivePointers(body.proof?.activePointers,upload,plan);
    for(const origin of [receiptURL,'https://question-bank-78u.pages.dev/']){
     // Large immutable bytes are hashed by the SHA-pinned trusted CI verifier.
     // Edge admission rechecks the unique release marker/catalog at both origins.
     const proof=body.proof;
     if(proof?.artifactHash!==plan.artifact?.sha256||proof?.operationId!==id||proof.resultCommit!==plan.resultCommit||proof.contentHash!==plan.contentHash||proof.workerVersionId!==deployment.workerVersionId||proof.retainedRevisionsVerified!==true||proof.allPublishedBytesVerified!==true)throw Error('REPORT_READBACK_PROOF');
     const marker=await boundedJson(await fetch(new URL('report-releases/'+id+'.json',origin),{cache:'no-store',signal:AbortSignal.timeout(10000)}));
     for(const key of ['operationId','resultCommit','bankUid','questionKey','revision','questionRevision','contentHash'])if(marker[key]!==plan[key])throw Error('REPORT_READBACK_MARKER');
     const manifest=await boundedJson(await fetch(new URL('banks/v2/manifest.json',origin),{cache:'no-store',signal:AbortSignal.timeout(10000)}));
     if(!manifest.banks?.some(b=>b.bankUid===plan.bankUid&&b.revision===plan.revision))throw Error('REPORT_READBACK_CATALOG');
    }
    const currentHead=await headLedger.releaseHead(),expectedHead=plan.releaseHead;
    const nextHead={commit:plan.resultCommit,pagesDeploymentId:deployment.deploymentId,workerVersionId:deployment.workerVersionId,workerDeploymentId:upload.workerDeploymentId,generation:expectedHead.generation+1,inflight:null,operationId:id,artifactHash:plan.artifact.sha256};
    // Idempotent completion handles crash between global head and operation CAS.
    if(JSON.stringify(currentHead)!==JSON.stringify(nextHead)&&!await headLedger.releaseCAS(expectedHead,nextHead))throw Error('REPORT_RELEASE_HEAD_CAS');
    const receipt={...plan,...deployment,readbackVerified:true};if(!await transition('readback_pending','receipt_pending',receipt))return json({blocked:true,state:'readback_pending'},409);return json({state:'receipt_pending',receipt});
   }catch{await transition('readback_pending','readback_failed',result);return json({state:'readback_failed'},409);}
  }
  if(body.action==='sendReceipt'){
   if(row.state!=='receipt_pending')return json({state:row.state,blocked:true});
   if(!await transition('receipt_pending','sending_receipt',result))return json({blocked:true});
   try {const response=await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:env.TELEGRAM_CHAT_ID,text:`✅ Cloudflare 正式站已核验纠错\n操作: ${id}\n题目: ${result.questionKey}\n版本: ${result.revision}\n部署: ${result.deploymentId}\nhttps://question-bank-78u.pages.dev/`}),signal:AbortSignal.timeout(10000)});const value=await boundedJson(response);if(value.ok!==false && (!response.ok||value.ok!==true))throw Error('REPORT_RECEIPT_UNKNOWN');if(value.ok===false){await ledger.transitionBound(id,'sending_receipt','receipt_pending',result,JSON.stringify(result));return json({state:'receipt_pending'},502);}await ledger.transitionBound(id,'sending_receipt','published',result,JSON.stringify(result));return json({state:'published'});}catch{await ledger.transitionBound(id,'sending_receipt','receipt_unknown',result,JSON.stringify(result));return json({state:'receipt_unknown'},502);}
  }
  return json({blocked:true},409);
 }catch(error){return json({error:error.code||'REPORT_CONTROL_DENIED'},403);}
}
