import { reportError } from '../../functions/_shared/native-report.js';

// No provider implementation or CLI: the protected integration must explicitly
// supply trusted adapters. Ambiguous deployment results are never replayed.
export function assertPublicationReceipt(receipt, plan) {
  const keys=['operationId','prNumber','sourceCommit','resultCommit','bankUid','questionKey','revision','questionRevision','contentHash','domain'];
  if(keys.some(key=>receipt?.[key]!==plan[key]) || !/^[a-f0-9]{40}$/.test(plan.sourceCommit) || !/^[a-f0-9]{40}$/.test(plan.resultCommit) || !/^[a-f0-9]{64}$/.test(plan.contentHash) || plan.contentHash!==plan.revision || !/^[a-f0-9]{64}$/.test(plan.questionRevision) || !Number.isSafeInteger(plan.prNumber) || plan.prNumber<1 || !/^[a-z0-9.-]+$/.test(plan.domain) || typeof receipt.deploymentId!=='string' || !receipt.deploymentId || receipt.readbackVerified!==true)throw reportError('REPORT_PUBLICATION_RECEIPT_REQUIRED');
  return receipt;
}
export async function runReportPublication({ledger,plan,authorize,verify,deploy,readback,sendReceipt}) {
  const id=plan.operationId;
  let row=await ledger.get(id);
  if(!row)throw reportError('REPORT_OPERATION_MISSING');
  if(row.state==='published')return {state:'published',duplicate:true};
  if(row.state==='receipt_pending')return deliver();
  if(row.state!=='pr_created')return {state:row.state,blocked:true};
  const pending=JSON.parse(row.payload),pr=JSON.parse(row.result);
  if(pr.number!==plan.prNumber || pr.base!==plan.sourceCommit || pending.bankUid!==plan.bankUid || pending.questionKey!==plan.questionKey)throw reportError('REPORT_PUBLICATION_BINDING_CONFLICT');
  // Authorization and exact protected commit verification happen before CAS.
  assertPublicationReceipt({...plan,deploymentId:'preflight',readbackVerified:true},plan);
  if(await authorize(plan)!==true)throw reportError('REPORT_PUBLICATION_NOT_AUTHORIZED');
  const proof=await verify(plan);
  if(proof?.resultCommit!==plan.resultCommit || proof.testsPassed!==true || proof.retainedRevisionsVerified!==true || proof.contentHash!==plan.contentHash)throw reportError('REPORT_PUBLICATION_VERIFICATION_REQUIRED');
  if(!await ledger.transition(id,'pr_created','awaiting_deployment',plan))return {state:(await ledger.get(id)).state,duplicate:true};
  let deployment;
  try{deployment=await deploy(plan);}catch(error){await ledger.transition(id,'awaiting_deployment','deployment_unknown',{plan,code:'REPORT_DEPLOYMENT_UNKNOWN'});return {state:'deployment_unknown'};}
  let receipt;
  try{
    receipt=assertPublicationReceipt(await readback(plan,deployment),plan);
    if(receipt.deploymentId!==deployment?.deploymentId)throw reportError('REPORT_DEPLOYMENT_BINDING_CONFLICT');
  }catch(error){await ledger.transition(id,'awaiting_deployment','readback_failed',{plan,deployment,code:error.code||'REPORT_READBACK_FAILED'});return {state:'readback_failed'};}
  await ledger.transition(id,'awaiting_deployment','receipt_pending',receipt);
  return deliver();
  async function deliver(){
    row=await ledger.get(id);
    const receipt=assertPublicationReceipt(JSON.parse(row.result),plan);
    // Claim prevents concurrent receipt delivery. Unknown receipt send may be
    // retried with operationId as provider idempotency key, never redeployed.
    if(!await ledger.transition(id,'receipt_pending','sending_receipt',receipt))return {state:(await ledger.get(id)).state,duplicate:true};
    try{await sendReceipt(receipt,{idempotencyKey:id});}catch{await ledger.transition(id,'sending_receipt','receipt_pending',receipt);return {state:'receipt_pending'};}
    await ledger.transition(id,'sending_receipt','published',receipt);
    return {state:'published',receipt};
  }
}
