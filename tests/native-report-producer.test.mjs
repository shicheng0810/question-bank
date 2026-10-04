import { publicCorrection } from '../functions/_shared/public-report-contract.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { reportFixture } from './report-runtime/fixture.js';
import { validateReport } from '../functions/_shared/native-report.js';
import { applyRequest,produceCorrection,parseReportExtension } from '../scripts/banks/apply-native-report-request.mjs';
import { validateReportPR } from '../scripts/banks/validate-native-report-pr.mjs';
import { retainedReportArtifacts } from '../scripts/banks/copy-retained-report-assets.mjs';
import { assertReportCIContext,runReportCI } from '../scripts/banks/native-report-ci-controller.mjs';
import { encodeContent } from '../src/domain/attempt/commands.js';
import { canonicalContentBytes,sha256Hex } from '../src/domain/app-data/canonical.js';

async function fixture(){
  const f=await reportFixture(),bytes=canonicalContentBytes(f.content),encoded=await encodeContent(f.content);
  const manifest={format:'qb-site-registered-banks-v1',schemaVersion:1,banks:[{slug:'test',bankUid:f.source.bankUid,revision:f.source.revision,contentFile:'test.registered.json',sha256:await sha256Hex(bytes),questionCount:1,staticRef:`banks/v2/test.${f.source.revision}.json`}]};
  const registry={questions:f.content.questions.map(q=>({questionKey:q.questionKey,questionRevision:q.questionRevision}))};
  const receiver=[{bankUid:f.source.bankUid,revision:f.source.revision,metadata:f.content.metadata,contentManifest:{kind:'public_static',staticRef:manifest.banks[0].staticRef,contentDigest:f.source.revision},publicContentReference:encoded.reference,questionsrefs:registry.questions}];
  return {...f,manifest,registry,receiver,bytes};
}
test('controlled producer uses pinned base and emits exact five-file closure plus prior receiver trust',async()=>{
  const f=await fixture(),request={format:'qb-native-report-request-v1',baseCommit:'a'.repeat(40),pending:publicCorrection(validateReport(f.body,[f.source]))};
  const files=new Map([[f.source.sourcePath,f.content],[f.source.manifestPath,f.manifest],[f.source.registryPath,f.registry],['do-worker/src/account-public-registry.generated.js',f.receiver]]);
  const result=await produceCorrection(request,[f.source],async(commit,file)=>{assert.equal(commit,request.baseCommit);return files.get(file);},'content/report-sources.json',f.receiver);
  assert.equal(result.files.length,5);assert.equal(new Set(result.files.map(file=>file.path)).size,5);assert.ok(result.files[0].path.startsWith('content/test.'));assert.notEqual(result.files[0].path,f.source.sourcePath);
  const mapping=JSON.parse(result.files[4].content);assert.equal(mapping[0].revision,result.revision);assert.equal(mapping[0].sourcePath,result.files[0].path);
  const nextManifest=JSON.parse(result.files[1].content);assert.deepEqual(nextManifest.retainedBanks[0],f.manifest.banks[0]);const retained=await retainedReportArtifacts(nextManifest,async file=>{assert.equal(file,'test.registered.json');return f.bytes;});assert.equal(retained[0].path,f.manifest.banks[0].staticRef);assert.deepEqual(retained[0].bytes,f.bytes);
  const receiver=parseReportExtension(result.files[3].content).snapshots[0].banks;
  assert.equal(receiver.length,2);assert.deepEqual(receiver[0],f.receiver[0]);assert.equal(receiver[1].revision,result.revision);assert.equal(receiver[1].questionsrefs[0].questionKey,f.body.questionKey);
});
test('real git pinned-base CLI never overwrites historical body or trusts modified live source config',async()=>{
  const f=await fixture(),root=await mkdtemp(path.join(tmpdir(),'qb-report-producer-'));
  await mkdir(path.join(root,'content'),{recursive:true});await mkdir(path.join(root,'do-worker/src'),{recursive:true});
  const writes={'content/test.registered.json':new TextDecoder().decode(f.bytes),'content/manifest.json':JSON.stringify(f.manifest),'content/registry.json':JSON.stringify(f.registry),'content/report-sources.json':JSON.stringify([f.source]),'do-worker/src/account-public-registry.generated.js':`export const publicRegistryJson = ${JSON.stringify(JSON.stringify(f.receiver))};\n`,'do-worker/src/reviewed-report-public-registry.generated.js':'export const reviewedReportPublicRegistry = [];\nexport const reviewedReportPublicRegistrySnapshots = [];\n'};
  for(const [file,content]of Object.entries(writes))await writeFile(path.join(root,file),content);
  const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();git('init','--quiet');git('add','.');git('-c','user.name=Local Test','-c','user.email=test@example.invalid','commit','--quiet','-m','fixture');const base=git('rev-parse','HEAD');
  const request={format:'qb-native-report-request-v1',baseCommit:base,pending:publicCorrection(validateReport(f.body,[f.source]))};await writeFile(path.join(root,'request.json'),JSON.stringify(request));
  await writeFile(path.join(root,'content/report-sources.json'),'[]');
  const result=await applyRequest({requestFile:path.join(root,'request.json'),sourcesFile:'content/report-sources.json',root,baselineBanks:f.receiver});
  assert.equal(result.files.length,5);assert.equal(await readFile(path.join(root,f.source.sourcePath),'utf8'),writes[f.source.sourcePath]);
  const next=JSON.parse(await readFile(path.join(root,result.files[0]),'utf8'));assert.equal(next.questions[0].questionUid,f.body.questionUid);assert.equal(next.questions[0].answer,1);
  await mkdir(path.join(root,'content/report-requests'),{recursive:true});const requestPath=`content/report-requests/${f.body.operationId}.json`;await writeFile(path.join(root,requestPath),JSON.stringify(request));
  git('add','--',requestPath,...result.files);git('-c','user.name=Local Test','-c','user.email=test@example.invalid','commit','--quiet','-m','generated report');
  const head=git('rev-parse','HEAD');const checked=await validateReportPR({root,base,head,operationId:f.body.operationId,sourcesFile:'content/report-sources.json',baselineBanks:f.receiver});assert.equal(checked.files.length,5);
  const calls=[],repo='shicheng0810/question-bank',pr={state:'open',draft:false,user:{id:123},base:{ref:'main',sha:base,repo:{full_name:repo}},head:{ref:`codex/report-${f.body.operationId}`,sha:head,repo:{full_name:repo}}};
  let buildVerified=false;const controlled=await runReportCI({mode:'verify',prNumber:'1',expectedHead:head,root,expectedBot:'123',baselineBanks:f.receiver,siteVerifier:async({manifestPath})=>{assert.equal(manifestPath,'content/manifest.json');buildVerified=true;},requestAPI:async(method,route,body)=>{calls.push({method,route,body});if(route.endsWith('/protection/required_status_checks'))return {contexts:['native-report-content']};if(method==='PUT'){assert.equal(body.sha,head);return {merged:true,sha:'c'.repeat(40)};}if(method==='POST')return {};return route.endsWith('/pulls/1')?pr:{object:{sha:base}};}});
  assert.equal(controlled.state,'publication_dispatched');assert.equal(buildVerified,true);assert.equal(calls.filter(call=>call.body?.state==='success').length,1);assert.equal(calls.filter(call=>call.method==='PUT'&&call.route.endsWith('/merge')).length,1);assert.equal(calls.filter(call=>call.route.includes('report-publication.yml/dispatches')).length,1);
  await writeFile(path.join(root,'evil.js'),'process.exit(0)');git('add','evil.js');git('-c','user.name=Local Test','-c','user.email=test@example.invalid','commit','--quiet','-m','unreviewed extra');
  await assert.rejects(validateReportPR({root,base,head:git('rev-parse','HEAD'),operationId:f.body.operationId,sourcesFile:'content/report-sources.json',baselineBanks:f.receiver}),/FILE_CLOSURE_INVALID/);
});
test('CI rejects unauthorized/fork/moving base or head contexts before content writes',()=>{
  const repo='shicheng0810/question-bank',pr={state:'open',draft:false,user:{id:123},base:{ref:'main',sha:'a'.repeat(40),repo:{full_name:repo}},head:{ref:'codex/report-11111111-1111-4111-8111-111111111111',sha:'b'.repeat(40),repo:{full_name:repo}}};
  const input={pr,sourceHead:pr.base.sha,expectedBot:'123',expectedRepo:repo,expectedHead:pr.head.sha};assert.equal(assertReportCIContext(input).base,pr.base.sha);
  for(const mutated of [{...input,expectedBot:'other'},{...input,sourceHead:'c'.repeat(40)},{...input,expectedHead:'c'.repeat(40)},{...input,pr:{...pr,draft:true}},{...input,pr:{...pr,head:{...pr.head,repo:{full_name:'attacker/fork'}}}},{...input,pr:{...pr,base:{...pr.base,ref:'source'}}}])assert.throws(()=>assertReportCIContext(mutated),/REPORT_CI_/);
});
test('CI producer commits exact outputs then pushes once and dispatches verification at the generated SHA',async()=>{
  const f=await fixture(),root=await mkdtemp(path.join(tmpdir(),'qb-report-ci-writeback-'));
  const writes={[f.source.sourcePath]:new TextDecoder().decode(f.bytes),[f.source.manifestPath]:JSON.stringify(f.manifest),[f.source.registryPath]:JSON.stringify(f.registry),'content/report-sources.json':JSON.stringify([f.source]),'do-worker/src/account-public-registry.generated.js':`export const publicRegistryJson = ${JSON.stringify(JSON.stringify(f.receiver))};\n`,'do-worker/src/reviewed-report-public-registry.generated.js':'export const reviewedReportPublicRegistry = [];\nexport const reviewedReportPublicRegistrySnapshots = [];\n'};
  for(const [file,content]of Object.entries(writes)){await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),content);}
  const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();git('init','--quiet');git('add','.');git('-c','user.name=Local Test','-c','user.email=test@example.invalid','commit','--quiet','-m','base');const base=git('rev-parse','HEAD');
  const requestPath=`content/report-requests/${f.body.operationId}.json`;await mkdir(path.dirname(path.join(root,requestPath)),{recursive:true});await writeFile(path.join(root,requestPath),JSON.stringify({format:'qb-native-report-request-v1',baseCommit:base,pending:publicCorrection(validateReport(f.body,[f.source]))}));git('add','--',requestPath);git('-c','user.name=Local Test','-c','user.email=test@example.invalid','commit','--quiet','-m','request');const head=git('rev-parse','HEAD');
  const repo='shicheng0810/question-bank',pr={state:'open',draft:false,user:{id:123},base:{ref:'main',sha:base,repo:{full_name:repo}},head:{ref:`codex/report-${f.body.operationId}`,sha:head,repo:{full_name:repo}}},calls=[],pushes=[];
  const result=await runReportCI({mode:'produce',prNumber:'1',expectedHead:head,root,expectedBot:'123',baselineBanks:f.receiver,gitRunner:(...args)=>{if(args.includes('push')){pushes.push(args);return '';}return git(...args);},requestAPI:async(method,route,body)=>{calls.push({method,route,body});return method==='GET'?(route.endsWith('/pulls/1')?pr:{object:{sha:base}}):null;}});
  assert.equal(result.state,'validation_dispatched');assert.notEqual(result.head,head);assert.equal(pushes.length,1);assert.equal(pushes[0].at(-1),`HEAD:refs/heads/${pr.head.ref}`);assert.equal(await readFile(path.join(root,f.source.sourcePath),'utf8'),writes[f.source.sourcePath]);
  const checked=await validateReportPR({root,base,head:result.head,operationId:f.body.operationId,sourcesFile:'content/report-sources.json',baselineBanks:f.receiver});assert.equal(checked.files.length,5);
  const dispatches=calls.filter(call=>call.route.endsWith('/dispatches'));assert.equal(dispatches.length,1);assert.deepEqual(dispatches[0].body,{ref:'main',inputs:{mode:'verify',pr_number:'1',expected_head:result.head}});assert.equal(calls.some(call=>call.body?.state==='success'),false);
});

test('retired source repository is rejected before any CI API call',async()=>{let calls=0;await assert.rejects(runReportCI({mode:'produce',prNumber:1,expectedBot:'123',repository:'shicheng0810/question-bank-source',requestAPI:async()=>{calls++;throw Error('unexpected API');}}),/REPORT_CI_INPUT_INVALID/);assert.equal(calls,0);});
