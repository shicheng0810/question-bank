import {execFileSync} from 'node:child_process';import {writeFile,readFile,mkdir,readdir} from 'node:fs/promises';import path from 'node:path';import {createHash} from 'node:crypto';
const required=['GEN05_AUTH_HTTP','GEN05_ACCOUNT_HTTP','GEN05_ACCOUNT_API','GEN05_AUTH_TRUST_CF_IP','GEN05_SESSION_V3_LOCAL','GEN06_SYNC_HTTP','GEN06_SYNC_API','GEN06_CLOUD_EXPORT_HTTP','GEN06_CLOUD_EXPORT_API','GEN06_GH_API_CORS','GEN06_SNAPSHOT_BASELINE_INIT','GEN06_RESUME_V2_READ_GUARD'];
export function workerReleaseConfig(settings){
 const vars=Object.fromEntries(settings.bindings.filter(b=>b.type==='plain_text').map(b=>[b.name,b.text]));if(required.some(name=>vars[name]!=='1'))throw Error('REPORT_EXISTING_GATES_CHANGED');
 if(!settings.bindings.some(b=>b.type==='durable_object_namespace'&&b.name==='REPORT_OPERATIONS'&&b.class_name==='ReportOperationStore'))throw Error('REPORT_BINDING_NOT_PREPARED');
 if(settings.bindings.some(b=>!['plain_text','secret_text','kv_namespace','durable_object_namespace'].includes(b.type)))throw Error('REPORT_BINDING_UNSUPPORTED');
 return {name:'qb-do',main:'../do-worker/src/index.js',compatibility_date:settings.compatibility_date,compatibility_flags:settings.compatibility_flags||[],keep_vars:true,workers_dev:false,vars,kv_namespaces:settings.bindings.filter(b=>b.type==='kv_namespace').map(b=>({binding:b.name,id:b.namespace_id})),durable_objects:{bindings:settings.bindings.filter(b=>b.type==='durable_object_namespace').map(b=>({name:b.name,class_name:b.class_name,...(b.script_name?{script_name:b.script_name}:{}),...(b.environment?{environment:b.environment}:{})}))}};
}
export async function cloudflareAPI(route,{token=process.env.CLOUDFLARE_API_TOKEN}={}){if(!token)throw Error('REPORT_CF_CREDENTIAL_MISSING');const response=await fetch('https://api.cloudflare.com/client/v4/accounts/1cb5e6e63a6b3c3ea0ad9bb01dac30e9'+route,{headers:{authorization:`Bearer ${token}`},signal:AbortSignal.timeout(20000)});if(!response.ok)throw Error('REPORT_CF_READ_DENIED');const value=await response.json();if(value.success!==true)throw Error('REPORT_CF_READ_FAILED');return value.result;}
export async function buildReportRelease({root,plan}){
 const output=path.join(root,'site-build'),manifest=path.join(root,'production-inputs/registered-banks.json');
 const run=(args,env={})=>execFileSync(process.execPath,args,{cwd:root,env:{...process.env,...env},stdio:'pipe',maxBuffer:20*1024*1024});
 run(['scripts/build-pages.mjs'],{DONATION_OFF:'1',QB_BUILD_ENV:'production',QB_API_BASE:'/api',QB_ACCOUNT_V2_UI:'1',QB_NATIVE_HISTORY_SNAPSHOTS:'1',QB_NATIVE_ONLY:'1',QB_SNAPSHOT_BASELINE_INIT:'1',QB_V2_BANK_CONTENT_MANIFEST:manifest,BANKS_MANIFEST:path.join(root,'production-inputs/banks/index.json'),BANKS_ROOT:path.join(root,'production-inputs'),PAGES_OUT:output});
 run(['scripts/banks/copy-retained-report-assets.mjs',manifest,output]);
 run(['node_modules/wrangler/bin/wrangler.js','pages','functions','build','functions','--outfile='+path.join(output,'_worker.js'),'--compatibility-date=2026-06-10']);
 await mkdir(path.join(output,'report-releases'),{recursive:true});await writeFile(path.join(output,'report-releases',plan.operationId+'.json'),JSON.stringify(plan));
 const rows=[];async function walk(dir){for(const item of await readdir(dir,{withFileTypes:true})){const f=path.join(dir,item.name);if(item.isDirectory())await walk(f);else{const bytes=await readFile(f);rows.push({path:path.relative(output,f).split(path.sep).join('/'),sha256:createHash('sha256').update(bytes).digest('hex')});}}}await walk(output);
 return {output,manifest:rows.sort((a,b)=>a.path.localeCompare(b.path))};
}
export async function deployReportRelease({root,release,plan}){
 const settings=await cloudflareAPI('/workers/scripts/qb-do/settings'),config=workerReleaseConfig(settings);
 await mkdir(path.join(root,'.worker-build'),{recursive:true});await writeFile(path.join(root,'.worker-build/wrangler.json'),JSON.stringify(config));
 const run=args=>execFileSync(process.execPath,['node_modules/wrangler/bin/wrangler.js',...args],{cwd:root,env:{...process.env,WRANGLER_SEND_METRICS:'false',CLOUDFLARE_ACCOUNT_ID:'1cb5e6e63a6b3c3ea0ad9bb01dac30e9'},stdio:'pipe',maxBuffer:10*1024*1024});
 // Global workflow serialization and service CAS must precede this adapter.
 run(['deploy','--config','.worker-build/wrangler.json','--keep-vars']);
 const worker=await cloudflareAPI('/workers/scripts/qb-do/deployments');const active=worker.deployments?.[0];if(active?.versions?.length!==1||active.versions[0].percentage!==100)throw Error('REPORT_WORKER_DEPLOYMENT_UNKNOWN');const workerVersionId=active.versions[0].version_id;
 run(['pages','deploy',release.output,'--project-name=question-bank','--branch=main','--commit-hash='+plan.resultCommit]);
 const pages=await cloudflareAPI('/pages/projects/question-bank/deployments');const matches=pages.filter(row=>row.environment==='production'&&row.deployment_trigger?.metadata?.commit_hash===plan.resultCommit&&row.latest_stage?.status==='success');if(matches.length!==1)throw Error('REPORT_PAGES_DEPLOYMENT_UNKNOWN');return {deploymentId:matches[0].id,workerVersionId};
}
export async function readWorkerRelease(control,plan,deployment){const versions=await cloudflareAPI('/workers/scripts/qb-do/deployments'),active=versions.deployments?.[0];const settings=await cloudflareAPI('/workers/scripts/qb-do/settings');workerReleaseConfig(settings);const registry=await control('workerCapability'),bank=registry.banks?.find(b=>b.bankUid===plan.bankUid&&b.revision===plan.revision);return {versionId:active?.versions?.length===1&&active.versions[0].percentage===100?active.versions[0].version_id:null,gatesVerified:true,registryVerified:bank?.questions.some(q=>q.questionKey===plan.questionKey&&q.questionRevision===plan.questionRevision)===true};}
