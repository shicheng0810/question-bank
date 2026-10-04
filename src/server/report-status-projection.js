// R3 ledger observation only. Never accepts browser payload or emits a ledger row.
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const states=new Set('received delivering pending_approval delivery_unknown creating_pr pr_created conflict provider_unknown reconciling awaiting_deployment deployment_unknown readback_pending readback_failed reconciling_readback receipt_pending sending_receipt receipt_unknown reconciling_receipt published'.split(' '));
const plain=v=>v && typeof v==='object' && !Array.isArray(v) && [Object.prototype,null].includes(Object.getPrototypeOf(v));
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)?v:null;
const sha=v=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v)?v:null;
const id=v=>typeof v==='string'&&uuid.test(v)?v:null;
export const validReportOperationId=v=>id(v)!==null;
const stamp=v=>Number.isSafeInteger(v)&&v>=0?new Date(v).toISOString():null;
export function projectReportStatus(row,operationId,observedAt=Date.now()) {
 if(!id(operationId)||!stamp(observedAt))throw Error('REPORT_STATUS_INPUT_INVALID');
 const base={schema:1,operationId,observedAt:stamp(observedAt),source:'r3-ledger-observation',state:'not_found',recordedAt:null,publicPR:null,resultCommit:null,deployment:null,artifact:null,verification:{status:'notchecked',recordedAt:null,verifiedAt:null},currentPointer:{status:'notchecked',checkedAt:null},receipt:{status:'notchecked',recordedAt:null},cas:{status:'notchecked'},pagination:{status:'unavailable',reason:'R3_STORE_HAS_NO_LIST_OR_CURSOR'}};
 if(row===null)return base;
 if(!plain(row)||row.operation_id!==operationId||!states.has(row.state)||!stamp(row.updated_at)||!(row.result===null||typeof row.result==='string'&&row.result.length<=131072))throw Error('REPORT_STATUS_SHAPE_INVALID');
 let result=row.result===null?null:JSON.parse(row.result);if(result!==null&&!plain(result))throw Error('REPORT_STATUS_SHAPE_INVALID');
 result=result||{};const plan=plain(result.plan)?result.plan:result;const dep=plain(result.deployment)?result.deployment:result;
 base.state=row.state;base.recordedAt=stamp(row.updated_at);base.resultCommit=sha(plan.resultCommit);
 const pr=Number.isSafeInteger(plan.prNumber)&&plan.prNumber>0?plan.prNumber:Number.isSafeInteger(result.number)&&result.number>0?result.number:null;
 if(pr)base.publicPR={number:pr,url:`https://github.com/shicheng0810/question-bank/pull/${pr}`,status:'recorded'};
 if(id(dep.deploymentId)||id(dep.workerVersionId))base.deployment={status:'recorded',pagesDeploymentId:id(dep.deploymentId),workerVersionId:id(dep.workerVersionId),workerDeploymentId:id(dep.uploadReceipt?.workerDeploymentId),recordedAt:base.recordedAt};
 if(plain(plan.artifact)&&digest(plan.artifact.sha256))base.artifact={status:'recorded',sha256:plan.artifact.sha256,workerSha256:digest(plan.artifact.worker?.sha256),pagesBundleHash:digest(plan.artifact.pagesBundleHash)};
 // Even published is not proof: require the exact R3 admitted receipt identity.
 const receiptStates=['receipt_pending','sending_receipt','receipt_unknown','reconciling_receipt','published'];
 const upload=result.uploadReceipt,artifact=result.artifact,job=result.uploadJob||result.controlJob;
 const exactUpload=plain(upload)&&upload.schema===3&&upload.operationId===operationId&&upload.resultCommit===base.resultCommit&&upload.artifactHash===base.artifact?.sha256&&upload.target==='question-bank-78u.pages.dev'&&upload.deploymentId===base.deployment?.pagesDeploymentId&&upload.pagesUploadResponseId===upload.deploymentId&&upload.workerVersionId===base.deployment?.workerVersionId&&upload.workerUploadResponseId===upload.workerVersionId&&id(upload.workerDeploymentId)&&upload.workerHash===artifact?.worker?.sha256&&digest(upload.workerHash)&&upload.workerMetadataHash===artifact?.worker?.metadataHash&&digest(upload.workerMetadataHash)&&upload.pagesBundleHash===artifact?.pagesBundleHash&&digest(upload.pagesBundleHash)&&upload.pagesContractHash===artifact?.pagesContractHash&&digest(upload.pagesContractHash)&&digest(upload.staticManifestHash)&&plain(job)&&upload.runId===job.runId&&upload.runAttempt===job.runAttempt&&upload.workflowSha===job.workflowSha&&sha(upload.workflowSha)&&upload.fence===job.fence&&Number.isSafeInteger(upload.fence)&&upload.fence>0;
 const admitted=exactUpload&&receiptStates.includes(row.state)&&result.operationId===operationId&&result.readbackVerified===true&&base.resultCommit&&base.publicPR&&base.artifact&&base.deployment?.pagesDeploymentId&&base.deployment?.workerVersionId&&result.domain==='question-bank-78u.pages.dev'&&digest(result.revision)&&result.contentHash===result.revision&&digest(result.questionRevision);
 if(admitted)base.verification={status:'recorded_verified',recordedAt:base.recordedAt,verifiedAt:null};
 else if(row.state==='readback_failed')base.verification.status='failed';
 else if(receiptStates.includes(row.state))base.verification.status='unknown_receipt_identity';
 base.receipt.status=row.state==='published'&&admitted?'recorded_delivered':row.state==='receipt_unknown'?'unknown':row.state==='sending_receipt'?'inflight':row.state==='receipt_pending'?'pending':'notchecked';
 if(base.receipt.status!=='notchecked')base.receipt.recordedAt=base.recordedAt;
 // No provider request performed; updated_at is not verification time. CAS cannot
 // be inferred from a single row and no current public pointer is read here.
 return base;
}
export function validateReportStatusDTO(v){
 if(!plain(v)||Reflect.ownKeys(v).some(k=>typeof k!=='string'||!('value'in Object.getOwnPropertyDescriptor(v,k))))throw Error('REPORT_STATUS_SHAPE_INVALID');
 if(!plain(v)||v.schema!==1||!id(v.operationId)||v.source!=='r3-ledger-observation'||!(states.has(v.state)||v.state==='not_found')||typeof v.observedAt!=='string'||!Number.isFinite(Date.parse(v.observedAt)))throw Error('REPORT_STATUS_SHAPE_INVALID');
 const allowed=['schema','operationId','observedAt','source','state','recordedAt','publicPR','resultCommit','deployment','artifact','verification','currentPointer','receipt','cas','pagination'];
 if(Object.keys(v).length!==allowed.length||Object.keys(v).some(k=>!allowed.includes(k))||!plain(v.verification)||!['notchecked','recorded_verified','failed','unknown_receipt_identity'].includes(v.verification.status)||!plain(v.currentPointer)||v.currentPointer.status!=='notchecked'||v.currentPointer.checkedAt!==null||!plain(v.receipt)||!['notchecked','recorded_delivered','pending','inflight','unknown'].includes(v.receipt.status)||!plain(v.cas)||v.cas.status!=='notchecked'||!plain(v.pagination)||v.pagination.status!=='unavailable')throw Error('REPORT_STATUS_SHAPE_INVALID');
 const shapes={publicPR:['number','url','status'],deployment:['status','pagesDeploymentId','workerVersionId','workerDeploymentId','recordedAt'],artifact:['status','sha256','workerSha256','pagesBundleHash'],verification:['status','recordedAt','verifiedAt'],currentPointer:['status','checkedAt'],receipt:['status','recordedAt'],cas:['status'],pagination:['status','reason']};
 for(const [key,keys]of Object.entries(shapes))if(v[key]!==null&&(!plain(v[key])||Reflect.ownKeys(v[key]).length!==keys.length||Reflect.ownKeys(v[key]).some(k=>typeof k!=='string'||!keys.includes(k)||!('value'in Object.getOwnPropertyDescriptor(v[key],k)))))throw Error('REPORT_STATUS_SHAPE_INVALID');
 for(const key of ['recordedAt'])if(v[key]!==null&&(typeof v[key]!=='string'||!Number.isFinite(Date.parse(v[key]))))throw Error('REPORT_STATUS_SHAPE_INVALID');
 if(v.resultCommit!==null&&!sha(v.resultCommit))throw Error('REPORT_STATUS_SHAPE_INVALID');
 if(v.verification.verifiedAt!==null||v.pagination.reason!=='R3_STORE_HAS_NO_LIST_OR_CURSOR')throw Error('REPORT_STATUS_SHAPE_INVALID');
 if(v.artifact && (v.artifact.status!=='recorded'||!digest(v.artifact.sha256)||[v.artifact.workerSha256,v.artifact.pagesBundleHash].some(x=>x!==null&&!digest(x))))throw Error('REPORT_STATUS_SHAPE_INVALID');
 if(v.deployment && (v.deployment.status!=='recorded'||[v.deployment.pagesDeploymentId,v.deployment.workerVersionId,v.deployment.workerDeploymentId].some(x=>x!==null&&!id(x))))throw Error('REPORT_STATUS_SHAPE_INVALID');
 for(const key of ['deployment','verification','receipt'])if(v[key]&&Object.hasOwn(v[key],'recordedAt')&&v[key].recordedAt!==null&&(typeof v[key].recordedAt!=='string'||!Number.isFinite(Date.parse(v[key].recordedAt))))throw Error('REPORT_STATUS_SHAPE_INVALID');
 if(v.publicPR && (!Number.isSafeInteger(v.publicPR.number)||v.publicPR.number<1||v.publicPR.status!=='recorded'||v.publicPR.url!==`https://github.com/shicheng0810/question-bank/pull/${v.publicPR.number}`))throw Error('REPORT_STATUS_SHAPE_INVALID');
 return v;
}
