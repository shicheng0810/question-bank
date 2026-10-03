const target='question-bank-78u.pages.dev';
export function authorizeReadbackRecovery(row,body,id){
 if(!['readback_pending','readback_failed'].includes(row.state))throw Error('REPORT_READBACK_RECOVERY_STATE');
 const saved=JSON.parse(row.result||'null'),plan=saved?.plan,deployment=saved?.deployment;
 if(!plan||!deployment||plan.operationId!==id||plan.domain!==target||body.target!==target||body.resultCommit!==plan.resultCommit||body.artifactHash!==plan.artifact?.sha256||!/^[a-f0-9]{64}$/.test(body.artifactHash||'')||body.deploymentId!==deployment.deploymentId||body.workerVersionId!==deployment.workerVersionId||body.url!==deployment.url||body.shortId!==deployment.shortId)throw Error('REPORT_READBACK_RECOVERY_CONFLICT');
 return saved;
}
