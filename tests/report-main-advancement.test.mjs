import test, {mock} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,mkdir,writeFile,readFile,symlink,rm,realpath} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {ReportLedger,validateReport} from '../functions/_shared/native-report.js';
import {publicCorrection} from '../functions/_shared/public-report-contract.js';
import {approvalPacket} from '../functions/_shared/report-approval.js';
import {onRequestPost} from '../functions/api/report-control.js';
import {RELEASE_HEAD} from '../functions/_shared/report-release-contract.js';
import {applyRequest,parseReportExtension} from '../scripts/banks/apply-native-report-request.mjs';
import {runReportCI} from '../scripts/banks/native-report-ci-controller.mjs';
import * as adapter from '../scripts/banks/report-cloudflare-adapter.mjs';
import {settings,projectConfig} from './report-r3-fixture.mjs';
const hash=b=>createHash('sha256').update(b instanceof ArrayBuffer?new Uint8Array(b):b).digest('hex');
const codeSha=(await readFile('.github/workflows/report-publication.yml','utf8')).match(/report-publication-executor.yml@([a-f0-9]{40})/)?.[1]||'a'.repeat(40),caller='.github/workflows/report-publication.yml',executor='shicheng0810/question-bank/.github/workflows/report-publication-executor.yml@'+codeSha,aud='https://question-bank-78u.pages.dev/api/report-control';
function store(){const db=new DatabaseSync(':memory:'),ledger=new ReportLedger({sql:{exec(q,...args){const s=db.prepare(q),rows=s.columns().length?s.all(...args):(s.run(...args),[]);return {toArray:()=>rows};}}});ledger.transitionBound=(...a)=>ledger.transition(...a);return {db,ledger};}

test('real runner: two local squash main data commits, signed reusable identity, newer-main recovery, exact bytes, no duplicate deploy',async()=>{
 const scratch=await realpath(await mkdtemp(path.join(tmpdir(),'qb-main-advancement-'))),data=path.join(scratch,'data'),trusted=path.join(scratch,'trusted');
 const git=(...args)=>execFileSync('git',args,{cwd:data,encoding:'utf8',maxBuffer:100*1024*1024}).trim();
 // Archive only tracked/indexed source. Never copy credentials, caches or private
 // checkout files. Both main commits are real generated five-file corrections.
 const tree=execFileSync('git',['write-tree'],{encoding:'utf8'}).trim();
 const archive=path.join(scratch,'tracked-source.tar');execFileSync('git',['archive',tree,'-o',archive]);
 let trustedArchive=archive;try{execFileSync('git',['cat-file','-e',codeSha+'^{commit}']);trustedArchive=path.join(scratch,'trusted-executor.tar');execFileSync('git',['archive',codeSha,'-o',trustedArchive]);}catch{}
 for(const root of [data,trusted]){await mkdir(root);execFileSync('tar',['-xf',root===trusted?trustedArchive:archive,'-C',root]);await symlink(path.resolve('node_modules'),path.join(root,'node_modules'));}
 git('init','-q','-b','main');git('add','--','.',':!node_modules');git('-c','user.name=Synthetic Test','-c','user.email=synthetic@example.invalid','commit','-qm','synthetic main baseline');
 const base=git('rev-parse','HEAD'),op=store(),head=store();op.ledger.capability=async()=>({schema:1,banks:parseReportExtension(await readFile(path.join(trusted,'do-worker/src/reviewed-report-public-registry.generated.js'),'utf8')).entries.map(b=>({bankUid:b.bankUid,revision:b.revision,questions:b.questionsrefs}))});
 let active={commit:base,pagesDeploymentId:crypto.randomUUID(),workerVersionId:crypto.randomUUID(),workerDeploymentId:crypto.randomUUID()};head.ledger.releaseHead(active);
 const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']),jwk={...await crypto.subtle.exportKey('jwk',pair.publicKey),kid:'local-synthetic',alg:'RS256'};
 let run='100',attempt='1',runSha=base,claimPatch={},apiPatch={},operationId,prNumber,release,plan,pr,receiptFailures=0,uploads=0,deploys=0,sends=0;
 const deployments=new Map(),files=new Map(),dispatches=[];
 const env={GITHUB_TOKEN:'synthetic',REPORT_BOT_GITHUB_USER_ID:'17',TELEGRAM_BOT_TOKEN:'synthetic',TELEGRAM_CHAT_ID:'-100123',TELEGRAM_APPROVER_IDS:'456',REPORT_OIDC_POLICY_JSON:JSON.stringify({audience:aud,workflowSha:codeSha,workflowPaths:['shicheng0810/question-bank/'+caller+'@refs/heads/main']}),REPORT_OPERATIONS:{getByName:id=>id===RELEASE_HEAD?head.ledger:op.ledger}};
 const sign=async()=>{const now=Math.floor(Date.now()/1000),enc=v=>Buffer.from(JSON.stringify(v)).toString('base64url'),claims={iss:'https://token.actions.githubusercontent.com',aud,repository:'shicheng0810/question-bank',repository_id:'1164285871',repository_owner_id:'74512891',ref:'refs/heads/main',ref_type:'branch',environment:'report-production',event_name:'workflow_dispatch',sub:'repo:shicheng0810/question-bank:environment:report-production',workflow_sha:runSha,sha:runSha,workflow_ref:'shicheng0810/question-bank/'+caller+'@refs/heads/main',job_workflow_sha:codeSha,job_workflow_ref:executor,head_ref:'',base_ref:'',run_id:run,run_attempt:attempt,iat:now,nbf:now,exp:now+300,jti:crypto.randomUUID(),...claimPatch},input=enc({alg:'RS256',kid:jwk.kid})+'.'+enc(claims);return input+'.'+Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',pair.privateKey,new TextEncoder().encode(input))).toString('base64url');};
 async function control(action,extra={},id=operationId){return onRequestPost({env,request:new Request(aud,{method:'POST',headers:{authorization:'Bearer '+await sign()},body:JSON.stringify({...extra,operationId:id,action})})});}
 const provider=async(route,opts={})=>{
  if(route==='/workers/scripts/qb-do/settings')return settings;
  if(route==='/pages/projects/question-bank')return {...projectConfig,canonical_deployment:{id:active.pagesDeploymentId,environment:'production',latest_stage:{status:'success'},deployment_trigger:{metadata:{commit_hash:active.commit}}}};
  if(route==='/workers/scripts/qb-do/versions'){uploads++;assert.equal(hash(await opts.body.get('index.js').arrayBuffer()),release.artifact.worker.sha256);assert.equal(hash(await opts.body.get('metadata').arrayBuffer()),release.artifact.worker.metadataHash);active.workerVersionId=crypto.randomUUID();return {id:active.workerVersionId};}
  if(route==='/workers/scripts/qb-do/deployments'){if(opts.method==='POST'){assert.equal(JSON.parse(opts.body).versions[0].version_id,active.workerVersionId);active.workerDeploymentId=crypto.randomUUID();return {id:active.workerDeploymentId};}return {deployments:[{id:active.workerDeploymentId,versions:[{version_id:active.workerVersionId,percentage:100}]}]};}
  if(route==='/pages/projects/question-bank/deployments'){deploys++;assert.equal(opts.body.get('commit_hash'),plan.resultCommit);assert.equal(hash(await opts.body.get('_worker.bundle').arrayBuffer()),release.artifact.pagesBundleHash);active.pagesDeploymentId=crypto.randomUUID();active.commit=plan.resultCommit;const result={id:active.pagesDeploymentId,project_name:'question-bank',short_id:'12345678',url:'https://12345678.question-bank-78u.pages.dev/',environment:'production',latest_stage:{status:'success'},deployment_trigger:{metadata:{commit_hash:active.commit}}};deployments.set(result.id,result);for(const row of release.manifest)files.set(row.path,await readFile(path.join(release.output,row.path)));return result;}
  if(route.startsWith('/workers/scripts/qb-do/versions/'))return {id:route.split('/').at(-1)};
  if(route.startsWith('/pages/projects/question-bank/deployments/'))return deployments.get(route.split('/').at(-1));
  throw Error('Unexpected synthetic CF route '+route);
 };
 const originalFetch=fetch,envKeys=['CLOUDFLARE_API_TOKEN','ACTIONS_ID_TOKEN_REQUEST_URL','ACTIONS_ID_TOKEN_REQUEST_TOKEN','WRANGLER_SEND_METRICS'];
 // Set synthetic values in this isolated test subprocess without reading
 // any existing token/credential values. No request reaches a real provider.
 Object.assign(process.env,{CLOUDFLARE_API_TOKEN:'synthetic',ACTIONS_ID_TOKEN_REQUEST_URL:'https://synthetic.invalid/oidc?request=local',ACTIONS_ID_TOKEN_REQUEST_TOKEN:'synthetic',WRANGLER_SEND_METRICS:'false'});
 globalThis.fetch=async(url,opts={})=>{
  const u=new URL(url);
  if(u.hostname==='synthetic.invalid')return Response.json({value:await sign()});
  if(u.hostname==='token.actions.githubusercontent.com')return Response.json({keys:[jwk]});
  if(u.hostname==='api.github.com'){
   if(u.pathname.includes('/actions/runs/'))return Response.json({id:Number(run),run_attempt:Number(attempt),head_branch:'main',head_sha:runSha,status:'in_progress',event:'workflow_dispatch',path:caller+'@main',repository:{id:1164285871,owner:{id:74512891}},referenced_workflows:[{path:executor,sha:codeSha}],...apiPatch});
   if(u.pathname.includes('/pulls/'))return Response.json(pr);
   return Response.json({object:{sha:git('rev-parse','main')}});
  }
  if(u.href===aud){const body=JSON.parse(opts.body),response=await onRequestPost({env,request:new Request(aud,opts)});if(!response.ok)console.log('SYNTHETIC_CONTROL_FAILURE '+body.action+' '+await response.clone().text());return response;}
  if(u.hostname==='api.cloudflare.com')return Response.json({success:true,result:await provider(u.pathname.replace(/^\/client\/v4\/accounts\/[^/]+/,''),opts)});
  if(u.hostname==='api.telegram.org'){sends++;return Response.json(receiptFailures-->0?{ok:false}:{ok:true});}
  if(['question-bank-78u.pages.dev','12345678.question-bank-78u.pages.dev'].includes(u.hostname)){const bytes=files.get(u.pathname.slice(1));return bytes?new Response(bytes):new Response('missing',{status:404});}
  throw Error('Unexpected network: '+u.hostname);
 };
 // Only the static uploader crosses a subprocess boundary whose provider is
 // otherwise remote. Supply its synthetic manifest; all frozen bytes are read
 // by the real adapter and then compared through actual online verifier code.
 const adapterMock=mock.module('../scripts/banks/report-cloudflare-adapter.mjs',{exports:{...adapter,buildReportRelease:async args=>{plan=args.plan;release=await adapter.buildReportRelease(args);return release;},deployReportRelease:async args=>{try{return await adapter.deployReportRelease({...args,uploadStatic:async bytes=>Object.fromEntries([...bytes].filter(([p])=>!['_worker.js','_worker.bundle','_routes.json','_headers','_redirects'].includes(p)).map(([p,b])=>['/'+p,createHash('md5').update(b).digest('hex')]))});}catch(error){console.log('SYNTHETIC_ADAPTER_FAILURE '+error.message);throw error;}}}});
 const {runAutomaticPublication}=await import('../scripts/banks/report-publication-runner.mjs?synthetic-main-test');
 const history=[];
 try{
  for(let index=0;index<2;index++){
   const source=JSON.parse(await readFile(path.join(data,'content/report-sources.json'),'utf8'))[0],content=JSON.parse(await readFile(path.join(data,source.sourcePath),'utf8')),q=content.questions[0];operationId=crypto.randomUUID();prNumber=50+index;
   const pending=validateReport({kind:'question_edit',schema_version:2,operationId,bankUid:source.bankUid,revision:source.revision,questionUid:q.questionUid,questionKey:q.questionKey,questionRevision:q.questionRevision,corrected:{question:'Synthetic P1 correction '+index,choices:['Synthetic A','Synthetic B'],answer:index},note:''},[source]);
   const packet=await approvalPacket(pending,env),request={format:'qb-native-report-request-v1',baseCommit:packet.approval.sourceBase,pending:publicCorrection(pending)},requestPath='content/report-requests/'+operationId+'.json';
   await op.ledger.receive(pending);for(const [from,to]of [['received','delivering'],['delivering','pending_approval'],['pending_approval','creating_pr']])await op.ledger.transition(operationId,from,to,{});await op.ledger.transition(operationId,'creating_pr','pr_created',{number:prNumber,base:request.baseCommit,approval:packet.approval});
   git('checkout','-qb','codex/report-'+operationId);await mkdir(path.dirname(path.join(data,requestPath)),{recursive:true});await writeFile(path.join(data,requestPath),JSON.stringify(request));git('add',requestPath);git('-c','user.name=Synthetic Test','-c','user.email=synthetic@example.invalid','commit','-qm','synthetic request');
   const generated=await applyRequest({root:data,requestFile:path.join(data,requestPath),sourcesFile:'content/report-sources.json'});git('add','--',...generated.files);git('-c','user.name=Synthetic Test','-c','user.email=synthetic@example.invalid','commit','-qm','synthetic generated correction');const reportHead=git('rev-parse','HEAD');
   const repository='shicheng0810/question-bank';pr={state:'open',draft:false,user:{id:17},base:{ref:'main',sha:request.baseCommit,repo:{id:1164285871,full_name:repository}},head:{ref:'codex/report-'+operationId,sha:reportHead,repo:{id:1164285871,full_name:repository}}};
   const ci=await runReportCI({mode:'verify',root:data,prNumber,expectedHead:reportHead,expectedBot:'17',siteVerifier:async()=>{},requestAPI:async(method,route,body)=>{
    if(method==='PUT'){assert.equal(body.sha,reportHead);git('checkout','-q','main');git('merge','--squash',reportHead);git('-c','user.name=Synthetic Test','-c','user.email=synthetic@example.invalid','commit','-qm','synthetic squash Report '+index);const sha=git('rev-parse','HEAD');pr={...pr,merged_at:'synthetic',merge_commit_sha:sha};return {merged:true,sha};}
    if(method==='POST'){if(route.endsWith('/dispatches'))dispatches.push(body);return {};}
    if(route.endsWith('/required_status_checks'))return {contexts:['native-report-content']};
    return route.includes('/pulls/')?pr:{object:{sha:git('rev-parse','main')}};
   }});
   run=String(100+index*10);attempt='1';runSha=ci.resultCommit;assert.notEqual(runSha,codeSha);assert.equal(git('rev-parse',runSha+'^'),request.baseCommit);assert.deepEqual(dispatches.at(-1),{ref:'main',inputs:{pr_number:String(prNumber),expected_commit:runSha,operation_id:operationId}});
   // Every malformed authority is rejected before touching the publication row.
   for(const patch of [{job_workflow_sha:'c54a88d30545964665e43ac50315aca1711a5098'},{job_workflow_ref:executor.replace(codeSha,'refs/heads/main')},{repository:'shicheng0810/question-bank-source'},{repository_id:'1403515803'},{repository_owner_id:'999'},{ref:'refs/heads/source'},{environment:'wrong'},{aud:'wrong'},{event_name:'pull_request'},{workflow_ref:'shicheng0810/question-bank/.github/workflows/other.yml@refs/heads/main'}]){claimPatch=patch;assert.equal((await control('get')).status,403);}claimPatch={};
   const runnerArgs={trustedRoot:trusted,dataRoot:data,prNumber,expectedCommit:runSha,operationId};
   receiptFailures=1;await assert.rejects(runAutomaticPublication(runnerArgs),/REPORT_CONTROL_REJECTED/);assert.equal(op.ledger.get(operationId).state,'receipt_pending');assert.equal(head.ledger.releaseHead().commit,runSha);assert.equal(head.ledger.releaseHead().generation,index+1);
   const saved=op.ledger.get(operationId),receipt=JSON.parse(saved.result),count={uploads,deploys},firstRun=run;
   // Recovery from a newer caller main; the release result and artifact remain
   // the recorded old revision. Restore exact DATA checkout before rerunning.
   if(index===1){await writeFile(path.join(data,'synthetic-main-data.json'),JSON.stringify({index,after:runSha}));git('add','synthetic-main-data.json');git('-c','user.name=Synthetic Test','-c','user.email=synthetic@example.invalid','commit','-qm','synthetic newer main data');}const recoverySha=git('rev-parse','main');git('checkout','--detach','-q',runSha);run=String(Number(run)+1);runSha=recoverySha;
   const extra={...receipt,target:receipt.domain,artifactHash:receipt.artifact.sha256,expectedResult:saved.result,fence:receipt.controlJob.fence};
   for(const patch of [{head_sha:codeSha},{head_branch:'other'},{repository:{id:1403515803,owner:{id:74512891}}},{referenced_workflows:[{path:executor,sha:'d'.repeat(40)}]},{run_attempt:2},{path:'.github/workflows/other.yml'},{status:'completed'}]){apiPatch=patch;assert.equal((await control('resumeReceipt',extra)).status,403);}apiPatch={};
   assert.equal((await control('resumeReceipt',{...extra,resultCommit:base})).status,403);assert.equal((await control('resumeReceipt',extra,crypto.randomUUID())).status,404);
   assert.equal((await runAutomaticPublication(runnerArgs)).state,'published');assert.deepEqual({uploads,deploys},count);const published=JSON.parse(op.ledger.get(operationId).result);assert.equal(published.resultCommit,runnerArgs.expectedCommit);assert.equal(published.controlJob.runSha,recoverySha);assert.equal(published.uploadJob.runSha,runnerArgs.expectedCommit);assert.equal(published.uploadReceipt.runSha,runnerArgs.expectedCommit);
   run=firstRun;attempt='1';assert.equal((await control('sendReceipt',{fence:1})).status,403);run=String(Number(firstRun)+1);attempt='2';assert.equal((await control('sendReceipt',{fence:2})).status,403);attempt='1';assert.equal((await runAutomaticPublication(runnerArgs)).duplicate,true);assert.deepEqual({uploads,deploys},count);
   history.push({operationId,sourceCommit:request.baseCommit,resultCommit:runnerArgs.expectedCommit,recoveryMainCommit:recoverySha,artifactHash:published.artifact.sha256,runId:published.controlJob.runId,deploys,uploads});
   // First recovery keeps main at D1; second follows D2 and a newer data commit.
   git('checkout','-q','main');
   await rm(trusted,{recursive:true,force:true});await mkdir(trusted);execFileSync('tar',['-xf',trustedArchive,'-C',trusted]);await symlink(path.resolve('node_modules'),path.join(trusted,'node_modules'));
  }
  assert.equal(deploys,2);assert.equal(uploads,2);assert.equal(sends,4);console.log('SYNTHETIC_MAIN_ADVANCEMENT_EVIDENCE '+JSON.stringify({base,codeSha,trustedArchiveIsPinnedCommit:trustedArchive!==archive,history,dispatches,uploads,deploys,sends,network:'in-process synthetic providers; no GitHub/CF/TG requests'}));
 }finally{adapterMock.restore();globalThis.fetch=originalFetch;for(const k of envKeys)delete process.env[k];op.db.close();head.db.close();await rm(scratch,{recursive:true,force:true});}
});
