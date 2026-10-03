import {verifyReportOIDC,assertReportRunBinding} from '../_shared/report-oidc.js';
import {boundedJson} from '../_shared/native-report-publisher.js';
import {publicCorrection} from '../_shared/public-report-contract.js';
const json=(value,status=200)=>Response.json(value,{status});
async function github(env,path){const response=await fetch('https://api.github.com/repos/shicheng0810/question-bank-source/'+path,{headers:{authorization:`Bearer ${env.GITHUB_TOKEN}`,accept:'application/vnd.github+json','user-agent':'qb-report-control'},signal:AbortSignal.timeout(15000)});if(!response.ok)throw Error('REPORT_CONTROL_GITHUB_DENIED');return boundedJson(response);}
export async function onRequestPost({request,env}) {
 try {
  const policy=JSON.parse(env.REPORT_OIDC_POLICY_JSON||'null');
  const job=await verifyReportOIDC(request.headers.get('authorization')?.replace(/^Bearer /,''),policy);
  if(!env.REPORT_OPERATIONS)throw Error('REPORT_LEDGER_NOT_CONFIGURED');
  const body=await boundedJson(request,64*1024),id=body.operationId;
  if(!/^[a-f0-9-]{36}$/.test(id||'')||!['get','claim','recordDeployment','readback','sendReceipt','deploymentUnknown','workerCapability','resumeReceipt'].includes(body.action))throw Error('REPORT_CONTROL_INPUT_INVALID');
  const ledger=env.REPORT_OPERATIONS.getByName(id),row=await ledger.get(id);if(!row)return json({error:'REPORT_OPERATION_MISSING'},404);
  if(body.action==='workerCapability')return json(await ledger.capability());
  if(body.action==='get')return json({...row,payload:JSON.stringify(publicCorrection(JSON.parse(row.payload)))});
  if(body.action==='claim'){
   if(row.state!=='pr_created')return json({claimed:false,state:row.state});
   const plan=body.plan,pending=JSON.parse(row.payload),prResult=JSON.parse(row.result);
   if(plan?.operationId!==id||plan.prNumber!==prResult.number||plan.sourceCommit!==prResult.base||plan.bankUid!==pending.bankUid||plan.questionKey!==pending.questionKey||plan.domain!=='question-bank-78u.pages.dev'||plan.revision!==plan.contentHash||!/^[a-f0-9]{64}$/.test(plan.revision)||!/^[a-f0-9]{64}$/.test(plan.questionRevision)||!/^[a-f0-9]{40}$/.test(plan.resultCommit)||!/^banks\/v2\/[\w.-]+\.json$/.test(plan.staticRef||''))throw Error('REPORT_CONTROL_PLAN_CONFLICT');
   const pr=await github(env,'pulls/'+plan.prNumber);
   if(!pr.merged_at||pr.merge_commit_sha!==plan.resultCommit||pr.base.ref!=='source'||pr.base.repo.id!==1403515803||pr.head.repo.id!==1403515803||pr.head.ref!=='codex/report-'+id||String(pr.user.id)!==String(env.REPORT_BOT_GITHUB_USER_ID))throw Error('REPORT_CONTROL_PR_CONFLICT');
   const current=await github(env,'git/ref/heads/source');if(current.object.sha!==plan.resultCommit)throw Error('REPORT_CONTROL_SOURCE_MOVED');
   return json({claimed:await ledger.transition(id,'pr_created','awaiting_deployment',{...plan,controlJob:{...job,operationId:id}})});
  }
  const result=JSON.parse(row.result||'null');
  const transition=(from,to,value)=>ledger.transitionBound(id,from,to,value,row.result);
  if(body.action==='resumeReceipt'){
   if(row.state!=='receipt_pending')return json({blocked:true,state:row.state});
   const {controlJob,...receipt}=result;
   if(receipt.resultCommit!==body.resultCommit||receipt.operationId!==id||receipt.readbackVerified!==true)throw Error('REPORT_RECEIPT_RECOVERY_CONFLICT');
   if(!await transition('receipt_pending','reconciling_receipt',result))return json({blocked:true});
   return json({resumed:await ledger.transitionBound(id,'reconciling_receipt','receipt_pending',{...receipt,controlJob:{...job,operationId:id}},JSON.stringify(result))});
  }
  assertReportRunBinding(job,result?.controlJob||result?.plan?.controlJob,id);
  if(body.action==='deploymentUnknown')return json({changed:await transition('awaiting_deployment','deployment_unknown',{plan:result,code:'REPORT_DEPLOYMENT_UNKNOWN'})});
  if(body.action==='recordDeployment'){
   if(row.state!=='awaiting_deployment'||!/^[-a-f0-9]{36}$/.test(body.deployment?.deploymentId||'')||!/^[-a-f0-9]{36}$/.test(body.deployment?.workerVersionId||''))throw Error('REPORT_CONTROL_DEPLOYMENT_INVALID');
   return json({changed:await transition('awaiting_deployment','readback_pending',{plan:result,deployment:body.deployment})});
  }
  if(body.action==='readback'){
   if(row.state!=='readback_pending')return json({state:row.state,blocked:true});
   const {plan,deployment}=result;
   try {
    // Read the exact unique Pages deployment and canonical origin, no browser URL.
    const receiptURL=`https://${deployment.deploymentId}.question-bank-78u.pages.dev/`;
    for(const origin of [receiptURL,'https://question-bank-78u.pages.dev/']){
     // Large immutable bytes are hashed by the SHA-pinned trusted CI verifier.
     // Edge admission rechecks the unique release marker/catalog at both origins.
     const proof=body.proof;
     if(proof?.operationId!==id||proof.resultCommit!==plan.resultCommit||proof.contentHash!==plan.contentHash||proof.workerVersionId!==deployment.workerVersionId||proof.retainedRevisionsVerified!==true||proof.allPublishedBytesVerified!==true)throw Error('REPORT_READBACK_PROOF');
     const marker=await boundedJson(await fetch(new URL('report-releases/'+id+'.json',origin),{cache:'no-store',signal:AbortSignal.timeout(10000)}));
     for(const key of ['operationId','resultCommit','bankUid','questionKey','revision','questionRevision','contentHash'])if(marker[key]!==plan[key])throw Error('REPORT_READBACK_MARKER');
     const manifest=await boundedJson(await fetch(new URL('banks/v2/manifest.json',origin),{cache:'no-store',signal:AbortSignal.timeout(10000)}));
     if(!manifest.banks?.some(b=>b.bankUid===plan.bankUid&&b.revision===plan.revision))throw Error('REPORT_READBACK_CATALOG');
    }
    const receipt={...plan,...deployment,readbackVerified:true};await transition('readback_pending','receipt_pending',receipt);return json({state:'receipt_pending',receipt});
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
