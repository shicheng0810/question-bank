import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ReportLedger,validateReport } from '../functions/_shared/native-report.js';
import { nativeReportWebhook } from '../functions/_shared/native-report-webhook.js';
import { reportFixture } from './report-runtime/fixture.js';
import { runReportPublication } from '../scripts/banks/native-report-publication-controller.mjs';
async function fixture(){
 const f=await reportFixture(),db=new DatabaseSync(':memory:');
 const ledger=new ReportLedger({sql:{exec(q,...args){const st=db.prepare(q);const rows=st.columns().length?st.all(...args):(st.run(...args),[]);return {toArray:()=>rows};}}});
 await ledger.receive(validateReport(f.body,[f.source]));
 for(const [a,b] of [['received','delivering'],['delivering','pending_approval'],['pending_approval','creating_pr']])await ledger.transition(f.body.operationId,a,b);
 await ledger.transition(f.body.operationId,'creating_pr','pr_created',{number:7,base:'a'.repeat(40),head:'b'.repeat(40)});
 const plan={operationId:f.body.operationId,prNumber:7,sourceCommit:'a'.repeat(40),resultCommit:'c'.repeat(40),bankUid:f.body.bankUid,questionKey:f.body.questionKey,revision:'d'.repeat(64),questionRevision:'e'.repeat(64),contentHash:'d'.repeat(64),domain:'fixture.invalid'};
 let deploys=0,sends=0;
 const args={ledger,plan,authorize:async()=>true,verify:async()=>({resultCommit:plan.resultCommit,contentHash:plan.contentHash,testsPassed:true,retainedRevisionsVerified:true}),deploy:async()=>{deploys++;return {deploymentId:'local-deploy'};},readback:async()=>({...plan,deploymentId:'local-deploy',readbackVerified:true}),sendReceipt:async()=>{sends++;}};
 return {f,ledger,plan,args,counts:()=>({deploys,sends})};
}
test('publication receipt failure retries only receipt; duplicate/concurrent runs deploy once',async()=>{
 const x=await fixture();let fail=true;
 x.args.sendReceipt=async(receipt,key)=>{assert.equal(key.idempotencyKey,x.plan.operationId);assert.equal(receipt.resultCommit,x.plan.resultCommit);if(fail)throw Error('receipt unavailable');};
 const states=await Promise.all([runReportPublication(x.args),runReportPublication(x.args)]);
 assert.ok(states.some(r=>r.state==='receipt_pending'));assert.equal(x.counts().deploys,1);
 fail=false;assert.equal((await runReportPublication(x.args)).state,'published');
 assert.equal((await runReportPublication(x.args)).duplicate,true);assert.equal(x.counts().deploys,1);
});
test('test failure prevents deployment and keeps PR state',async()=>{
 const x=await fixture();x.args.verify=async()=>{throw Error('tests failed');};
 await assert.rejects(runReportPublication(x.args),/tests failed/);assert.equal(x.counts().deploys,0);assert.equal(x.ledger.get(x.plan.operationId).state,'pr_created');
});
test('deployment failure is unknown, never blindly redeployed',async()=>{
 const x=await fixture();let attempts=0;x.args.deploy=async()=>{attempts++;throw Error('timeout');};
 assert.equal((await runReportPublication(x.args)).state,'deployment_unknown');assert.equal((await runReportPublication(x.args)).blocked,true);assert.equal(attempts,1);
});
test('every receipt binding and deployment ID must match protected plan',async()=>{
 for(const key of ['operationId','prNumber','sourceCommit','resultCommit','bankUid','questionKey','revision','questionRevision','contentHash','domain','deploymentId','readbackVerified']){
  const x=await fixture();x.args.readback=async()=>({...x.plan,deploymentId:'local-deploy',readbackVerified:true,[key]:key==='prNumber'?99:key==='readbackVerified'?false:'wrong'});
  assert.equal((await runReportPublication(x.args)).state,'readback_failed',key);assert.equal(x.counts().sends,0);assert.equal((await runReportPublication(x.args)).blocked,true);
 }
});
test('wrong PR/base/native identity and missing authorization fail before deployment',async()=>{
 for(const mutation of [{prNumber:8},{sourceCommit:'f'.repeat(40)},{bankUid:crypto.randomUUID()},{questionKey:'wrong'}]){
  const x=await fixture();x.args.plan={...x.plan,...mutation};await assert.rejects(runReportPublication(x.args),/BINDING_CONFLICT/);assert.equal(x.counts().deploys,0);
 }
 const x=await fixture();x.args.authorize=async()=>{throw Error('not authorized');};await assert.rejects(runReportPublication(x.args),/not authorized/);assert.equal(x.counts().deploys,0);
});
test('unknown approver, duplicate approval and stale revision never create PR',async()=>{
 const x=await fixture(),original=globalThis.fetch;let writes=0;
 const env={TELEGRAM_WEBHOOK_SECRET:'fixture-secret',TELEGRAM_APPROVER_IDS:'1',TELEGRAM_CHAT_ID:'2',REPORT_OPERATIONS:{getByName:()=>x.ledger},GITHUB_TOKEN:'fake',REPORT_SOURCES_JSON:JSON.stringify([{...x.f.source,revision:'f'.repeat(64)}])};
 globalThis.fetch=async(url,options)=>{if(String(url).includes('api.github.com')){writes++;throw Error('unexpected provider');}return Response.json({ok:true});};
 const call=async user=>nativeReportWebhook({env,request:new Request('https://fixture.invalid',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':'fixture-secret'},body:JSON.stringify({callback_query:{id:'callback',from:{id:user},message:{chat:{id:2},message_id:3},data:`nr:${x.plan.operationId}`}})})});
 try{
  await call(99);assert.equal(x.ledger.get(x.plan.operationId).state,'pr_created');await call(1);assert.equal(writes,0);
  // New pending operation uses the original immutable payload but stale mapping.
  const f=await reportFixture();await x.ledger.receive(validateReport(f.body,[f.source]));await x.ledger.transition(f.body.operationId,'received','delivering');await x.ledger.transition(f.body.operationId,'delivering','pending_approval');x.plan.operationId=f.body.operationId;
  await call(1);assert.equal(x.ledger.get(f.body.operationId).state,'conflict');await call(1);assert.equal(writes,0);
 }finally{globalThis.fetch=original;}
});
