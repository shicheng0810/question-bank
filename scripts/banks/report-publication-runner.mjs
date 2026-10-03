import {readFile,writeFile,cp,lstat,realpath} from 'node:fs/promises';import path from 'node:path';import {execFileSync} from 'node:child_process';import {pathToFileURL} from 'node:url';
import {validateReportPR} from './validate-native-report-pr.mjs';import {assertPublicRequest} from '../../functions/_shared/public-report-contract.js';import {buildReportRelease,deployReportRelease,readWorkerRelease} from './report-cloudflare-adapter.mjs';import {verifyOnlineRelease} from './verify-report-online.mjs';
export async function runAutomaticPublication({trustedRoot,dataRoot,prNumber,expectedCommit,operationId}){
 if(!/^\d+$/.test(String(prNumber))||!/^[a-f0-9]{40}$/.test(expectedCommit)||!/^[a-f0-9-]{36}$/.test(operationId))throw Error('REPORT_PUBLICATION_INPUT');
 const request=assertPublicRequest(JSON.parse(await readFile(path.join(dataRoot,'content/report-requests/'+operationId+'.json'),'utf8')));
 const git=(...args)=>execFileSync('git',args,{cwd:dataRoot,encoding:'utf8'}).trim();if(git('rev-parse','HEAD')!==expectedCommit)throw Error('REPORT_PUBLICATION_HEAD');
 const verified=await validateReportPR({root:dataRoot,base:request.baseCommit,head:expectedCommit,operationId,sourcesFile:'content/report-sources.json'});
 // Data imports are exact generated public files. Never execute proposed scripts,
 // package lifecycle hooks, arbitrary modules, workflow or templates.
 for(const directory of ['production-inputs','content']){const source=path.join(dataRoot,directory);if((await lstat(source)).isSymbolicLink()||await realpath(source)!==source)throw Error('REPORT_PUBLICATION_SYMLINK');await cp(source,path.join(trustedRoot,directory),{recursive:true,dereference:false});}
 const extension='do-worker/src/reviewed-report-public-registry.generated.js';await cp(path.join(dataRoot,extension),path.join(trustedRoot,extension));
 const manifest=JSON.parse(await readFile(path.join(dataRoot,verified.siteManifest),'utf8')),entry=manifest.banks.find(b=>b.bankUid===request.pending.bankUid&&b.revision===verified.revision);if(!entry)throw Error('REPORT_RESULT_BANK');
 const content=JSON.parse(await readFile(path.join(dataRoot,'production-inputs',entry.contentFile),'utf8')),question=content.questions.find(q=>q.questionKey===request.pending.questionKey);if(!question)throw Error('REPORT_RESULT_QUESTION');
 const plan={operationId,prNumber:Number(prNumber),sourceCommit:request.baseCommit,resultCommit:expectedCommit,bankUid:entry.bankUid,questionKey:question.questionKey,revision:entry.revision,questionRevision:question.questionRevision,contentHash:entry.revision,domain:'question-bank-78u.pages.dev',staticRef:entry.staticRef};
 const audience='https://question-bank-78u.pages.dev/api/report-control';
 async function control(action,extras={}){const url=new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);url.searchParams.set('audience',audience);const oidcResponse=await fetch(url,{headers:{authorization:'Bearer '+process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}});if(!oidcResponse.ok)throw Error('REPORT_OIDC_TOKEN_UNAVAILABLE');const {value}=await oidcResponse.json();const response=await fetch(audience,{method:'POST',headers:{authorization:'Bearer '+value,'content-type':'application/json'},body:JSON.stringify({operationId,action,...extras}),signal:AbortSignal.timeout(30000)});if(!response.ok)throw Error('REPORT_CONTROL_REJECTED');return response.json();}
 const state=await control('get');if(state.state==='published')return {state:'published',duplicate:true};
 if(state.state==='receipt_pending'){const resumed=await control('resumeReceipt',{resultCommit:expectedCommit});if(!resumed.resumed)return {state:'receipt_pending',blocked:true};return control('sendReceipt');}
 if(state.state!=='pr_created')return {state:state.state,blocked:true};
 // Full local build and exact content validation precede durable publish claim.
 const release=await buildReportRelease({root:trustedRoot,plan});
 if(!(await control('claim',{plan})).claimed)return {state:'blocked',duplicate:true};
 let deployment;try{deployment=await deployReportRelease({root:trustedRoot,release,plan});}catch{await control('deploymentUnknown');return {state:'deployment_unknown'};}
 await control('recordDeployment',{deployment});
 const proof=await verifyOnlineRelease({plan,deployment,releaseManifest:release.manifest.filter(row=>row.path!=='_worker.js'&&row.path!=='_routes.json'),readLocal:file=>readFile(path.join(release.output,file)),workerReadback:()=>readWorkerRelease(control,plan,deployment)});
 await control('readback',{proof});return control('sendReceipt');
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href){const [dataRoot,prNumber,expectedCommit,operationId]=process.argv.slice(2);const result=await runAutomaticPublication({trustedRoot:process.cwd(),dataRoot:path.resolve(dataRoot),prNumber,expectedCommit,operationId});console.log(JSON.stringify(result));if(result.state!=='published')process.exitCode=1;}
