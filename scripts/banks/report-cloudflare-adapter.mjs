import {assertArtifact,assertUploadReceipt,assertActivePointers} from '../../functions/_shared/report-release-contract.js';
import {build as bundleWorker,transform} from 'esbuild';
import {reportDeploymentURL} from '../../functions/_shared/report-deployment-url.js';
import {execFileSync} from 'node:child_process';import {writeFile,readFile,mkdir,readdir,rm} from 'node:fs/promises';import path from 'node:path';import {createHash} from 'node:crypto';
const required=['GEN05_AUTH_HTTP','GEN05_ACCOUNT_HTTP','GEN05_ACCOUNT_API','GEN05_AUTH_TRUST_CF_IP','GEN05_SESSION_V3_LOCAL','GEN06_SYNC_HTTP','GEN06_SYNC_API','GEN06_CLOUD_EXPORT_HTTP','GEN06_CLOUD_EXPORT_API','GEN06_GH_API_CORS','GEN06_SNAPSHOT_BASELINE_INIT','GEN06_RESUME_V2_READ_GUARD'];
export function workerReleaseConfig(settings){
 const vars=Object.fromEntries(settings.bindings.filter(b=>b.type==='plain_text').map(b=>[b.name,b.text]));if(required.some(name=>vars[name]!=='1'))throw Error('REPORT_EXISTING_GATES_CHANGED');
 if(!settings.bindings.some(b=>b.type==='durable_object_namespace'&&b.name==='REPORT_OPERATIONS'&&b.class_name==='ReportOperationStore'))throw Error('REPORT_BINDING_NOT_PREPARED');
 if(settings.bindings.some(b=>!['plain_text','secret_text','kv_namespace','durable_object_namespace'].includes(b.type)))throw Error('REPORT_BINDING_UNSUPPORTED');
 return {name:'qb-do',main:'../do-worker/src/index.js',compatibility_date:settings.compatibility_date,compatibility_flags:settings.compatibility_flags||[],keep_vars:true,workers_dev:false,vars,kv_namespaces:settings.bindings.filter(b=>b.type==='kv_namespace').map(b=>({binding:b.name,id:b.namespace_id})),durable_objects:{bindings:settings.bindings.filter(b=>b.type==='durable_object_namespace').map(b=>({name:b.name,class_name:b.class_name,...(b.script_name?{script_name:b.script_name}:{}),...(b.environment?{environment:b.environment}:{})}))}};
}
const account='/accounts/1cb5e6e63a6b3c3ea0ad9bb01dac30e9';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
// No automatic retries for any activation/deployment request. Ambiguous result
// belongs to deployment_unknown; the runner cannot issue another deployment.
export async function cloudflareAPI(route,{token=process.env.CLOUDFLARE_API_TOKEN,method='GET',body,headers={}}={}){
 if(!token)throw Error('REPORT_CF_CREDENTIAL_MISSING');const response=await fetch('https://api.cloudflare.com/client/v4'+account+route,{method,body,headers:{authorization:`Bearer ${token}`,...headers},signal:AbortSignal.timeout(20000)});
 if(!response.ok)throw Error('REPORT_CF_REQUEST_DENIED');const value=await response.json();if(value.success!==true)throw Error('REPORT_CF_REQUEST_FAILED');return value.result;
}
export function pagesContract(project){
 const c=project.deployment_configs?.production;if(!c)throw Error('REPORT_PAGES_CONTRACT_MISSING');
 const value={...c,env_vars:Object.fromEntries(Object.entries(c.env_vars||{}).map(([k,v])=>[k,v.type==='secret_text'?{type:v.type}:v]))};
 return hash(JSON.stringify(value));
}
export function workerMetadata(settings){workerReleaseConfig(settings);return {main_module:'index.js',compatibility_date:settings.compatibility_date,compatibility_flags:settings.compatibility_flags||[],bindings:settings.bindings.filter(b=>b.type!=='secret_text'),keep_bindings:['secret_text']};}
export function pagesWorkerBundle(bytes){
 const boundary='qb-report-frozen-bundle-v3';
 return Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n{"main_module":"_worker.js"}\r\n--${boundary}\r\nContent-Disposition: form-data; name="_worker.js"; filename="_worker.js"\r\nContent-Type: application/javascript+module\r\n\r\n`),bytes,Buffer.from(`\r\n--${boundary}--\r\n`)]);
}
export async function readProductionPointers(api=cloudflareAPI){
 const project=await api('/pages/projects/question-bank');const pages=project.canonical_deployment;
 const worker=await api('/workers/scripts/qb-do/deployments');const active=worker.deployments?.[0];
 if(!pages||pages.environment!=='production'||pages.latest_stage?.status!=='success'||active?.versions?.length!==1||active.versions[0].percentage!==100)throw Error('REPORT_PRODUCTION_POINTER_INVALID');
 return {commit:pages.deployment_trigger?.metadata?.commit_hash,pagesDeploymentId:pages.id,workerVersionId:active.versions[0].version_id,workerDeploymentId:active.id};
}
export async function buildReportRelease({root,plan,api=cloudflareAPI,settings}){
 const output=path.join(root,'site-build'),manifest=path.join(root,'production-inputs/registered-banks.json');
 await rm(output,{recursive:true,force:true});
 const run=(args,env={})=>execFileSync(process.execPath,args,{cwd:root,env:{...process.env,...env},stdio:'pipe',maxBuffer:20*1024*1024});
 run(['scripts/build-pages.mjs'],{DONATION_OFF:'1',QB_BUILD_ENV:'production',QB_API_BASE:'/api',QB_ACCOUNT_V2_UI:'1',QB_NATIVE_HISTORY_SNAPSHOTS:'1',QB_NATIVE_ONLY:'1',QB_SNAPSHOT_BASELINE_INIT:'1',QB_V2_BANK_CONTENT_MANIFEST:manifest,BANKS_MANIFEST:path.join(root,'production-inputs/banks/index.json'),BANKS_ROOT:path.join(root,'production-inputs'),PAGES_OUT:output});
 run(['scripts/banks/copy-retained-report-assets.mjs',manifest,output]);
 const functionsOutput=path.join(root,'.pages-build');await rm(functionsOutput,{recursive:true,force:true});
 run(['node_modules/wrangler/bin/wrangler.js','pages','functions','build','functions','--outdir='+functionsOutput,'--output-routes-path='+path.join(output,'_routes.json'),'--compatibility-date=2026-06-10']);
 const modules=await readdir(functionsOutput);if(modules.length!==1||!modules[0].endsWith('.js'))throw Error('REPORT_PAGES_MODULES_UNSUPPORTED');
 // Remove compiler temporary-path comments with the locked JS parser before
 // freezing; identical input must rebuild identically for read-only recovery.
 const normalized=await transform(await readFile(path.join(functionsOutput,modules[0]),'utf8'),{format:'esm',legalComments:'none',minifyWhitespace:true,sourcefile:'_worker.js'});
 await writeFile(path.join(output,'_worker.js'),normalized.code);
 await writeFile(path.join(output,'_worker.bundle'),pagesWorkerBundle(await readFile(path.join(output,'_worker.js'))));
 await mkdir(path.join(output,'report-releases'),{recursive:true});await writeFile(path.join(output,'report-releases',plan.operationId+'.json'),JSON.stringify(plan));
 const rows=[];async function walk(dir){for(const item of await readdir(dir,{withFileTypes:true})){const f=path.join(dir,item.name);if(item.isDirectory())await walk(f);else{const bytes=await readFile(f);rows.push({path:path.relative(output,f).split(path.sep).join('/'),sha256:createHash('sha256').update(bytes).digest('hex')});}}}await walk(output);
 settings??=await api('/workers/scripts/qb-do/settings');workerReleaseConfig(settings);
 const built=await bundleWorker({absWorkingDir:root,entryPoints:['do-worker/src/index.js'],bundle:true,write:false,format:'esm',platform:'browser',target:'es2022',external:['cloudflare:*','node:*'],conditions:['workerd','worker','browser'],legalComments:'none'});
 if(built.outputFiles.length!==1)throw Error('REPORT_WORKER_MODULES_UNSUPPORTED');
 const workerBytes=Buffer.from(built.outputFiles[0].contents);
 const metadata=workerMetadata(settings);
 const metadataBytes=Buffer.from(JSON.stringify(metadata));
 await mkdir(path.join(root,'.worker-build'),{recursive:true});await writeFile(path.join(root,'.worker-build/index.js'),workerBytes);await writeFile(path.join(root,'.worker-build/metadata.json'),metadataBytes);
 const typed={schema:3,manifest:rows.sort((a,b)=>a.path.localeCompare(b.path)),worker:{entry:'index.js',sha256:hash(workerBytes),metadataHash:hash(metadataBytes)},pagesContractHash:pagesContract(await api('/pages/projects/question-bank')),pagesBundleHash:hash(await readFile(path.join(output,'_worker.bundle')))};
 const artifact={...typed,sha256:hash(JSON.stringify(typed))};await assertArtifact(artifact);
 return {output,manifest:typed.manifest,artifact,workerBytes,metadataBytes};
}
export async function deployReportRelease({root,release,plan,artifact=release.artifact,job,api=cloudflareAPI,uploadStatic,recordStage}){
 await assertArtifact(artifact);if(typeof recordStage!=='function')throw Error('REPORT_DURABLE_UPLOAD_LEDGER_REQUIRED');
 const persist=async(stage,providerId)=>{if(!(await recordStage({stage,providerId,artifactHash:artifact.sha256,resultCommit:plan.resultCommit,workerHash:artifact.worker.sha256,pagesBundleHash:artifact.pagesBundleHash})).changed)throw Error('REPORT_UPLOAD_LEDGER_UNCONFIRMED');};
 // Read all frozen input bytes before side effects. Uploads consume these buffers;
 // Wrangler's static uploader receives a separate snapshot of the same buffers.
 const files=new Map();for(const row of artifact.manifest){const bytes=await readFile(path.join(release.output,row.path));if(hash(bytes)!==row.sha256)throw Error('REPORT_FROZEN_BYTES_CHANGED');files.set(row.path,bytes);}
 const workerBytes=release.workerBytes??await readFile(path.join(root,'.worker-build/index.js'));
 const metadataBytes=release.metadataBytes??await readFile(path.join(root,'.worker-build/metadata.json'));
 if(hash(workerBytes)!==artifact.worker.sha256||hash(metadataBytes)!==artifact.worker.metadataHash||hash(files.get('_worker.bundle'))!==artifact.pagesBundleHash)throw Error('REPORT_FROZEN_BYTES_CHANGED');
 const observed=await readProductionPointers(api),base=plan.releaseHead;
 if(base&&(observed.commit!==base.commit||observed.pagesDeploymentId!==base.pagesDeploymentId||observed.workerVersionId!==base.workerVersionId||observed.workerDeploymentId!==base.workerDeploymentId))throw Error('REPORT_RELEASE_HEAD_DRIFT');
 if(hash(JSON.stringify(workerMetadata(await api('/workers/scripts/qb-do/settings'))))!==artifact.worker.metadataHash||pagesContract(await api('/pages/projects/question-bank'))!==artifact.pagesContractHash)throw Error('REPORT_BINDING_CONTRACT_DRIFT');
 const workerForm=new FormData();workerForm.set('metadata',new Blob([metadataBytes],{type:'application/json'}),'metadata.json');workerForm.set('index.js',new Blob([workerBytes],{type:'application/javascript+module'}),'index.js');
 const workerResponse=await api('/workers/scripts/qb-do/versions',{method:'POST',body:workerForm});
 if(!/^[a-f0-9-]{36}$/.test(workerResponse.id||''))throw Error('REPORT_WORKER_UPLOAD_UNKNOWN');
 await persist('workerUploaded',workerResponse.id);
 const activation=await api('/workers/scripts/qb-do/deployments',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({strategy:'percentage',versions:[{version_id:workerResponse.id,percentage:100}]})});
 if(!/^[a-f0-9-]{36}$/.test(activation.id||''))throw Error('REPORT_WORKER_ACTIVATION_UNKNOWN');
 await persist('workerActivated',activation.id);
 if(!uploadStatic)uploadStatic=async()=>{
  const snapshot=path.join(root,'.worker-build/static-upload');await rm(snapshot,{recursive:true,force:true});await mkdir(snapshot,{recursive:true});
  for(const [file,bytes]of files){if(['_worker.js','_worker.bundle','_routes.json','_headers','_redirects'].includes(file))continue;await mkdir(path.dirname(path.join(snapshot,file)),{recursive:true});await writeFile(path.join(snapshot,file),bytes);}
  const {jwt}=await api('/pages/projects/question-bank/upload-token');const mapPath=path.join(root,'.worker-build/static-upload-manifest.json');
  execFileSync(process.execPath,['node_modules/wrangler/bin/wrangler.js','pages','project','upload',snapshot,'--output-manifest-path='+mapPath],{cwd:root,env:{...process.env,CF_PAGES_UPLOAD_JWT:jwt,WRANGLER_SEND_METRICS:'false'},stdio:'pipe',maxBuffer:10*1024*1024});
  return JSON.parse(await readFile(mapPath,'utf8'));
 };
 const staticManifest=await uploadStatic(files);
 const staticPaths=[...files.keys()].filter(p=>!['_worker.js','_worker.bundle','_routes.json','_headers','_redirects'].includes(p)).sort();
 if(JSON.stringify(Object.keys(staticManifest).map(p=>p.replace(/^\//,'')).sort())!==JSON.stringify(staticPaths)||Object.values(staticManifest).some(h=>!/^[a-f0-9]{32}$/.test(h)))throw Error('REPORT_STATIC_UPLOAD_MANIFEST');
 const pagesForm=new FormData();pagesForm.set('manifest',JSON.stringify(staticManifest));pagesForm.set('branch','main');pagesForm.set('commit_hash',plan.resultCommit);pagesForm.set('commit_dirty','false');
 pagesForm.set('_worker.bundle',new Blob([files.get('_worker.bundle')],{type:'multipart/form-data; boundary=qb-report-frozen-bundle-v3'}),'_worker.bundle');
 for(const file of ['_routes.json','_headers','_redirects'])if(files.has(file))pagesForm.set(file,new Blob([files.get(file)]),file);
 const pagesResponse=await api('/pages/projects/question-bank/deployments',{method:'POST',body:pagesForm});
 const deployment={deploymentId:pagesResponse.id,shortId:pagesResponse.short_id,url:pagesResponse.url,resultCommit:plan.resultCommit,workerVersionId:workerResponse.id};reportDeploymentURL(deployment,plan.resultCommit);
 if(pagesResponse.environment!=='production'||pagesResponse.deployment_trigger?.metadata?.commit_hash!==plan.resultCommit)throw Error('REPORT_PAGES_UPLOAD_UNKNOWN');
 await persist('pagesUploaded',pagesResponse.id);
 deployment.uploadReceipt={schema:3,operationId:plan.operationId,resultCommit:plan.resultCommit,artifactHash:artifact.sha256,target:plan.domain,runId:job.runId,runAttempt:job.runAttempt,workflowSha:job.workflowSha,fence:job.fence,workerHash:hash(workerBytes),workerMetadataHash:hash(metadataBytes),pagesBundleHash:hash(files.get('_worker.bundle')),staticManifestHash:hash(JSON.stringify(staticManifest)),pagesContractHash:artifact.pagesContractHash,workerVersionId:workerResponse.id,workerDeploymentId:activation.id,deploymentId:pagesResponse.id,workerUploadResponseId:workerResponse.id,pagesUploadResponseId:pagesResponse.id};
 assertUploadReceipt(deployment.uploadReceipt,{...plan,artifact,uploadJob:job,controlJob:job},deployment);return deployment;
}
export async function readWorkerRelease(control,plan,deployment,api=cloudflareAPI){
 const receipt=deployment.uploadReceipt;assertUploadReceipt(receipt,plan,deployment);
 const observed=await readProductionPointers(api);
 const version=await api('/workers/scripts/qb-do/versions/'+receipt.workerVersionId);
 const page=await api('/pages/projects/question-bank/deployments/'+receipt.deploymentId);
 if(version.id!==receipt.workerVersionId||page.id!==receipt.deploymentId||page.project_name!=='question-bank'||page.environment!=='production'||page.deployment_trigger?.metadata?.commit_hash!==plan.resultCommit||page.latest_stage?.status!=='success')throw Error('REPORT_EXACT_PROVIDER_METADATA');
 const settings=await api('/workers/scripts/qb-do/settings');if(hash(JSON.stringify(workerMetadata(settings)))!==receipt.workerMetadataHash||pagesContract(await api('/pages/projects/question-bank'))!==receipt.pagesContractHash)throw Error('REPORT_BINDING_CONTRACT_DRIFT');
 const again=await readProductionPointers(api);if(JSON.stringify(observed)!==JSON.stringify(again))throw Error('REPORT_POINTER_DRIFT_DURING_READBACK');
 const activePointers={...observed,pagesBundleHash:receipt.pagesBundleHash,workerHash:receipt.workerHash,workerPercentage:100,workerVersions:1,project:page.project_name,environment:page.environment,commit:page.deployment_trigger.metadata.commit_hash,status:page.latest_stage.status};assertActivePointers(activePointers,receipt,plan);
 const registry=await control('workerCapability'),bank=registry.banks?.find(b=>b.bankUid===plan.bankUid&&b.revision===plan.revision);
 return {versionId:observed.workerVersionId,gatesVerified:true,registryVerified:bank?.questions.some(q=>q.questionKey===plan.questionKey&&q.questionRevision===plan.questionRevision)===true,activePointers};
}
