import {initial,bootstrapEnv} from './report-r3-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile, mkdtemp, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { encodeContent } from '../src/domain/attempt/commands.js';
import { canonicalContentBytes,sha256Hex } from '../src/domain/app-data/canonical.js';
import { produceCorrection } from '../scripts/banks/apply-native-report-request.mjs';
import { validateReportPR } from '../scripts/banks/validate-native-report-pr.mjs';
import { ReportLedger, validateReport } from '../functions/_shared/native-report.js';
import { receiveNativeReport } from '../functions/_shared/native-report-receiver.js';
import { nativeReportWebhook } from '../functions/_shared/native-report-webhook.js';
import { verifyReportOIDC } from '../functions/_shared/report-oidc.js';
import { publicCorrection } from '../functions/_shared/public-report-contract.js';
import { verifyOnlineRelease } from '../scripts/banks/verify-report-online.mjs';
import { verifyNativeReportSite } from '../scripts/banks/verify-native-report-site.mjs';
import { reportFixture } from './report-runtime/fixture.js';

function store() {
  const db = new DatabaseSync(':memory:');
  return {db, ledger:new ReportLedger({sql:{exec(query,...values){const s=db.prepare(query);const rows=s.columns().length?s.all(...values):(s.run(...values),[]);return {toArray:()=>rows};}}})};
}
const evidence=[];
test('review replay: hidden long correction rejected before any Telegram approval',async()=>{
  const {body,source}=await reportFixture(), {db,ledger}=store();
  body.corrected={question:'Q'.repeat(1000),choices:Array.from({length:50},(_,i)=>String(i).padStart(2,'0')+'C'.repeat(500)),answer:49};
  ledger.releaseHead(initial);const pending=validateReport(body,[source]);let notification,githubReads=0;
  const env={REPORT_SOURCES_JSON:JSON.stringify([source]),REPORT_OPERATIONS:{getByName:()=>ledger},TELEGRAM_BOT_TOKEN:'synthetic',TELEGRAM_CHAT_ID:'-100123',TELEGRAM_APPROVER_IDS:'456',TELEGRAM_WEBHOOK_SECRET:'synthetic-secret',GITHUB_TOKEN:'synthetic'};
  const original=fetch;
  globalThis.fetch=async(url,opts)=>{
    const route=new URL(url).pathname;
    if(route.endsWith('/sendMessage')){notification=JSON.parse(opts.body);return Response.json({ok:true,result:{message_id:7}});}
    if(route.startsWith('/repos/')){githubReads++;if(route.endsWith('/pulls'))return Response.json([{number:19,state:'open',base:{ref:'source',repo:{full_name:'shicheng0810/question-bank-source'}},head:{ref:'codex/report-'+body.operationId,repo:{full_name:'shicheng0810/question-bank-source'},sha:'b'.repeat(40)}}]);return Response.json({content:Buffer.from(JSON.stringify({format:'qb-native-report-request-v1',baseCommit:'a'.repeat(40),pending:publicCorrection(pending)})).toString('base64')});}
    return Response.json({ok:true});
  };
  try {
    await assert.rejects(receiveNativeReport(body,env),/REPORT_APPROVAL_TOO_LONG/);
    assert.equal(notification,undefined);assert.equal(ledger.get(body.operationId),null);assert.equal(githubReads,0);
    evidence.push({case:'approval',longApprovalRejected:true});
  } finally {globalThis.fetch=original;db.close();}
});
test('negative: chat identity cannot substitute for approver user; missing webhook secret denies',async()=>{
  let calls=0;const original=fetch;globalThis.fetch=async()=>{calls++;return Response.json({ok:true});};
  try {const env={TELEGRAM_WEBHOOK_SECRET:'s',TELEGRAM_CHAT_ID:'456',TELEGRAM_APPROVER_IDS:'789',REPORT_OPERATIONS:{getByName:()=>{throw Error('ledger must remain untouched');}}};
    const request=secret=>new Request('https://local',{method:'POST',headers:secret?{'X-Telegram-Bot-Api-Secret-Token':secret}:{},body:JSON.stringify({callback_query:{id:'x',from:{id:456},message:{chat:{id:456}},data:'nr:'+crypto.randomUUID()}})});
    assert.equal((await nativeReportWebhook({env,request:request(null)})).status,403);
    assert.equal(calls,0);assert.equal((await nativeReportWebhook({env,request:request('s')})).status,200);assert.equal(calls,1);
  }finally{globalThis.fetch=original;}
});
test('negative: only eight public fields survive raw metadata injection; private bank cannot be promoted by browser',async()=>{
  const {body,source}=await reportFixture();
  const poisoned={...body,note:'RAW_NOTE',original:{question:'PRIVATE_ORIGINAL'},accountId:'PRIVATE_ACCOUNT',contact:'contact@example.invalid',chatID:'PRIVATE_CHAT',userAgent:'PRIVATE_UA',page_url:'https://private.invalid',credential:'PRIVATE_CREDENTIAL'};
  const pending=validateReport(poisoned,[source]),projected=publicCorrection(pending);
  assert.deepEqual(Object.keys(projected).sort(),['operationId','bankUid','revision','questionUid','questionKey','questionRevision','corrected','question_index'].sort());
  for(const sentinel of ['RAW_NOTE','PRIVATE_ORIGINAL','PRIVATE_ACCOUNT','PRIVATE_CHAT','PRIVATE_UA','private.invalid','PRIVATE_CREDENTIAL'])assert.equal(JSON.stringify(projected).includes(sentinel),false);
  assert.throws(()=>validateReport({...body,visibility:'public'},[{...source,visibility:'private'}]),/PUBLIC_SOURCE_REQUIRED/);
  assert.throws(()=>publicCorrection({...pending,corrected:{question:'contact@example.invalid'}}),/SENSITIVE/);
});
test('negative: one SQLite claimant, conflicting same operation rejected, stale result CAS fails',async()=>{
  const {body,source}=await reportFixture(),{db,ledger}=store(),p=validateReport(body,[source]);
  try {await ledger.receive(p);await assert.rejects(ledger.receive({...p,note:'changed'}),/OPERATION_CONFLICT/);
    const claims=await Promise.all([ledger.transition(p.operationId,'received','delivering'),ledger.transition(p.operationId,'received','delivering')]);assert.equal(claims.filter(Boolean).length,1);
    assert.equal(await ledger.transition(p.operationId,'delivering','pending_approval',{messageId:7},'stale'),false);assert.equal(ledger.get(p.operationId).state,'delivering');
  }finally{db.close();}
});
test('negative: real signature from untrusted key denied; pinned JWKS endpoint ignores token jku',async()=>{
  const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
  const other=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
  const jwk={...await crypto.subtle.exportKey('jwk',pair.publicKey),kid:'synthetic',alg:'RS256'};
  const now=Math.floor(Date.now()/1000),sha='a'.repeat(40),workflow='shicheng0810/question-bank-source/.github/workflows/report-publication.yml@refs/heads/main',policy={audience:'https://question-bank-78u.pages.dev/api/report-control',workflowSha:sha,workflowPaths:[workflow]};
  const claims={iss:'https://token.actions.githubusercontent.com',aud:policy.audience,repository:'shicheng0810/question-bank-source',repository_id:'1403515803',repository_owner_id:'74512891',ref:'refs/heads/main',environment:'report-production',event_name:'workflow_dispatch',sub:'repo:shicheng0810/question-bank-source:environment:report-production',workflow_sha:sha,sha,workflow_ref:workflow,run_id:'123',run_attempt:'1',iat:now,nbf:now,exp:now+300,jti:'synthetic'};
  const enc=v=>Buffer.from(JSON.stringify(v)).toString('base64url');const input=enc({alg:'RS256',kid:'synthetic',jku:'https://attacker.invalid/jwks'})+'.'+enc(claims);
  const token=input+'.'+Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',other.privateKey,new TextEncoder().encode(input))).toString('base64url');
  const original=fetch,urls=[];globalThis.fetch=async url=>{urls.push(String(url));return Response.json({keys:[jwk]});};
  try{await assert.rejects(verifyReportOIDC(token,policy),/DENIED/);assert.deepEqual(urls,['https://token.actions.githubusercontent.com/.well-known/jwks']);}finally{globalThis.fetch=original;}
});
test('review replay: incomplete deployment URL contract rejected before any HTTP fetch',async()=>{
  const id='12345678-1234-4234-8234-123456789abc',url='https://12345678.question-bank-78u.pages.dev/',requests=[];
  await assert.rejects(verifyOnlineRelease({plan:{domain:'question-bank-78u.pages.dev'},deployment:{deploymentId:id,url},releaseManifest:[{path:'index.html',sha256:'a'.repeat(64)}],fetchHTTP:async u=>{requests.push(String(u));return new Response('missing',{status:404});}}),/READBACK_TARGET/);
  assert.equal(requests.length,0);
  evidence.push({case:'deployment-url',apiURL:url,actualRequested:requests[0]});
});
test('review replay: exact CI verifier actually builds approved production-inputs closure',async()=>{
  const result=await verifyNativeReportSite({root:process.cwd(),manifestPath:'production-inputs/registered-banks.json'});assert.equal(result.siteBuildVerified,true);evidence.push({case:'verify-entrypoint',actualBuildPassed:true});
});
test('review replay: exact generated blob with symlink Git mode rejected',async()=>{
  const f=await reportFixture(),root=await mkdtemp(path.join(tmpdir(),'independent-report-mode-'));
  const bytes=canonicalContentBytes(f.content),encoded=await encodeContent(f.content);
  const manifest={format:'qb-site-registered-banks-v1',schemaVersion:1,banks:[{slug:'test',bankUid:f.source.bankUid,revision:f.source.revision,contentFile:'test.registered.json',sha256:await sha256Hex(bytes),questionCount:1,staticRef:`banks/v2/test.${f.source.revision}.json`}]};
  const registry={questions:f.content.questions.map(q=>({questionKey:q.questionKey,questionRevision:q.questionRevision}))};
  const receiver=[{bankUid:f.source.bankUid,revision:f.source.revision,metadata:f.content.metadata,contentManifest:{kind:'public_static',staticRef:manifest.banks[0].staticRef,contentDigest:f.source.revision},publicContentReference:encoded.reference,questionsrefs:registry.questions}];
  const files={ [f.source.sourcePath]:JSON.stringify(f.content),[f.source.manifestPath]:JSON.stringify(manifest),[f.source.registryPath]:JSON.stringify(registry),'content/report-sources.json':JSON.stringify([f.source]),'do-worker/src/account-public-registry.generated.js':`export const publicRegistryJson = ${JSON.stringify(JSON.stringify(receiver))};\n`,'do-worker/src/reviewed-report-public-registry.generated.js':'export const reviewedReportPublicRegistry = [];\nexport const reviewedReportPublicRegistrySnapshots = [];\n'};
  for(const [file,text] of Object.entries(files)){await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),text);}
  const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
  const commit=message=>git('-c','user.name=Independent Local Test','-c','user.email=local@example.invalid','commit','--quiet','-m',message);
  git('init','--quiet');git('add','.');commit('synthetic base');const base=git('rev-parse','HEAD');
  const request={format:'qb-native-report-request-v1',baseCommit:base,pending:publicCorrection(validateReport(f.body,[f.source]))};
  const packet=await produceCorrection(request,[f.source],async(_commit,file)=>file.endsWith('account-public-registry.generated.js')?receiver:file.endsWith('reviewed-report-public-registry.generated.js')?{entries:[],snapshots:[]}:JSON.parse(files[file]),'content/report-sources.json',receiver);
  const requestPath='content/report-requests/'+f.body.operationId+'.json';await mkdir(path.dirname(path.join(root,requestPath)),{recursive:true});await writeFile(path.join(root,requestPath),JSON.stringify(request));
  for(const file of packet.files)await writeFile(path.join(root,file.path),file.content);
  git('add','.');const linkPath=packet.files[0].path,blob=git('hash-object',linkPath);
  git('update-index','--cacheinfo','120000,'+blob+','+linkPath);commit('same JSON blob in symlink mode');const head=git('rev-parse','HEAD');
  await assert.rejects(validateReportPR({root,base,head,operationId:f.body.operationId,sourcesFile:'content/report-sources.json',baselineBanks:receiver}),/REPORT_CI_TREE_MODE_INVALID/);evidence.push({case:'PR-mode',mode:'120000',validatorRejected:true});
});
test.after(async()=>{await writeFile('independent-r2-replay-evidence.json',JSON.stringify(evidence,null,2)+'\n');});
