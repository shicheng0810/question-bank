import test from 'node:test';import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';import {PassThrough} from 'node:stream';import {readFile,rm} from 'node:fs/promises';import {fileURLToPath} from 'node:url';
import {createOwnerAdapter,runOwnerCommand,runIdentityOwner,ownerChildEnvironment,OWNER_TARGET} from '../scripts/report-identity-owner.mjs';
import {IdentityChallengeLedger,IDENTITY_PREFIX,IDENTITY_SEED_PREFIX,identityChallengeRequest} from '../functions/_shared/report-identity-challenge.js';
import {nativeReportWebhook} from '../functions/_shared/native-report-webhook.js';
const evidence=[];
const identity={loggedIn:true,authType:'OAuth Token',accounts:[{id:OWNER_TARGET.accountId}],tokenPermissions:['workers_kv:write']};
function ownerRun({owner=identity,namespaces=[{id:OWNER_TARGET.namespaceId}],putUnknown=false,getWrong=false}={}){
 let seed,calls=[];return {calls,run:async args=>{calls.push(args.slice(0,3).join(' '));
  if(args[0]==='whoami')return JSON.stringify(owner);if(args[1]==='namespace')return JSON.stringify(namespaces);
  assert.equal(args[args.indexOf('--namespace-id')+1],OWNER_TARGET.namespaceId);assert(args.includes('--remote'));
  if(args[2]==='put'){seed=JSON.parse(await readFile(args[args.indexOf('--path')+1],'utf8'));assert.equal(args[3],IDENTITY_SEED_PREFIX+seed.challengeId);if(putUnknown)throw Error('unknown write');return 'captured';}
  if(args[2]==='get')return JSON.stringify(getWrong?{...seed,nonce:'changed'}:seed);throw Error('unexpected');
 }};
}
test('fixed concrete adapter refuses wrong owner, new token auth, missing scope or namespace before any seed/HTTPS',async()=>{
 for(const option of [{owner:{...identity,loggedIn:false}},{owner:{...identity,authType:'User API Token'}},{owner:{...identity,accounts:[]}},{owner:{...identity,tokenPermissions:[]}},{namespaces:[]}]){
  const f=ownerRun(option);let http=0;const adapter=createOwnerAdapter({run:f.run,fetchImpl:async()=>{http++;}});
  await assert.rejects(adapter.preflight(),e=>e.message==='EXISTING_OWNER_OR_EDITS_UNAVAILABLE_STOP');assert.equal(http,0);assert.equal(f.calls.some(x=>x==='kv key put'),false);
 }
 const env=ownerChildEnvironment('/tmp/synthetic.log');for(const k of ['CLOUDFLARE_API_TOKEN','CLOUDFLARE_API_KEY','CF_API_TOKEN','NODE_OPTIONS','HTTPS_PROXY','WRANGLER_API_BASE_URL'])assert.equal(k in env,false);
});
test('resident CLI wiring: actual external child commands + same closure + real SQLite handlers; no human input means candidate only',async()=>{
 const db=new DatabaseSync(':memory:');const storage={sql:{exec(q,...v){const s=db.prepare(q),rows=s.columns().length?s.all(...v):[];rows.rowsWritten=s.columns().length?0:s.run(...v).changes;return rows;}}};
 const ledgers=new Map();const ledger=id=>{if(!ledgers.has(id))ledgers.set(id,new IdentityChallengeLedger(storage));return ledgers.get(id);};
 const env={TELEGRAM_CHAT_ID:'-100123',TELEGRAM_BOT_TOKEN:'synthetic-only',TELEGRAM_WEBHOOK_SECRET:'synthetic-secret',TELEGRAM_APPROVER_IDS:'456',EDITS:{get:async key=>{const seed=JSON.parse(await readFile(new URL('../.identity-owner-runtime/local-fixture-metadata.json',import.meta.url),'utf8'));return key===IDENTITY_SEED_PREFIX+seed.challengeId?seed:null;}},REPORT_OPERATIONS:{getByName:name=>{assert(name.startsWith(IDENTITY_PREFIX));const id=name.slice(IDENTITY_PREFIX.length);return {identityChallenge:(id,cmd,input)=>ledger(id).execute(id,cmd,input)};}}};
 const saved=globalThis.fetch,methods=[],seen={},message={message_id:71,from:{id:888,is_bot:true},chat:{id:-100123}};
 globalThis.fetch=async(url,options)=>{
  assert.equal(new URL(url).hostname,'api.telegram.org');const method=new URL(url).pathname.split('/').at(-1),body=JSON.parse(options.body);methods.push(method);
  if(method==='answerCallbackQuery'){seen.code=body.text.match(/[A-F0-9]{4}-[A-F0-9]{4}/)?.[0];return Response.json({ok:true,result:true});}
  return Response.json({ok:true,result:message});
 };
 const input=new PassThrough(),output=new PassThrough();let text='';output.on('data',chunk=>{text+=chunk.toString();});
 const childCommands=[];
 const adapter=createOwnerAdapter({run:async args=>{childCommands.push(args.slice(0,3).join(' '));return runOwnerCommand(args,{cli:fileURLToPath(new URL('./identity-owner-cli-fixture.mjs',import.meta.url))});},fetchImpl:async(url,options)=>{assert.equal(url,OWNER_TARGET.endpoint);assert.equal(options.redirect,'error');return identityChallengeRequest({env,request:new Request(url,options)});}});
 let running;
 try{
  running=runIdentityOwner({input,output,adapter});
  const until=async condition=>{for(let i=0;i<150 && !condition();i++)await new Promise(r=>setTimeout(r,5));assert.equal(condition(),true);};
  await until(()=>text.includes('waiting_current_human_reply'));
  const seed=JSON.parse(await readFile(new URL('../.identity-owner-runtime/local-fixture-metadata.json',import.meta.url),'utf8'));
  const callback={id:'synthetic-callback',from:{id:999,is_bot:false},message,data:`ti:${seed.challengeId}:${seed.nonce}`};
  await nativeReportWebhook({env,request:new Request('https://local/api/tg-webhook',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':'synthetic-secret'},body:JSON.stringify({callback_query:callback})})});
  assert.equal(ledger(seed.challengeId).read(seed.challengeId).state,'awaiting_confirmation');assert.equal(text.includes('telegramUserId'),false);assert.equal(text.includes(seen.code),false);assert.equal(text.includes(seed.capHash),false);
  input.write('status\n');await until(()=>text.includes('awaiting_confirmation'));assert.equal(text.includes('telegramUserId'),false);
  // Synthetic human reply, explicitly injected only AFTER observing candidate.
  input.write('confirm '+seen.code+'\n');await running;
  const receipt=text.trim().split('\n').map(s=>JSON.parse(s)).find(r=>r.state==='confirmed').receipt;
  assert.equal(receipt.telegramUserId,'999');assert.equal(receipt.chatId,'-100123');assert.equal(receipt.authorityGranted,false);assert.equal(env.TELEGRAM_APPROVER_IDS,'456');
  assert.deepEqual(methods,['sendMessage','editMessageReplyMarkup','answerCallbackQuery']);assert.deepEqual(childCommands,['whoami --json','kv namespace list','kv key put','kv key get']);
  evidence.push({case:'resident-external-cli-sqlite-http',fixedTarget:true,actualChildProcesses:4,candidateUntilExplicitStdin:true,onlyOneSend:true,noAuthority:true,capOrCodeLogged:false,production:false});
 }finally{input.end();if(running)await running;globalThis.fetch=saved;db.close();await rm(new URL('../.identity-owner-runtime/local-fixture-metadata.json',import.meta.url),{force:true});}
});
test('uncertain seed write/readback and wrong fixed metadata stop once without start or renewed challenge',async()=>{
 for(const option of [{putUnknown:true},{getWrong:true}]){const f=ownerRun(option),input=new PassThrough(),output=new PassThrough();input.end();let text='',http=0;output.on('data',b=>text+=b.toString());await runIdentityOwner({input,output,adapter:createOwnerAdapter({run:f.run,fetchImpl:async()=>{http++;}})});assert.equal(http,0);assert.equal(f.calls.filter(x=>x==='kv key put').length,1);assert.equal(text.trim(),JSON.stringify({error:'IDENTITY_OWNER_STOP_NO_AUTOMATIC_RESTART'}));}
});
test('actual fixed HTTPS adapter rejects redirects/oversized response and does not expose bearer or exception',async()=>{
 const f=ownerRun();const adapter=createOwnerAdapter({run:f.run,fetchImpl:async(url,options)=>{assert.equal(options.redirect,'error');return new Response(new Uint8Array(9000),{status:200});}});
 await adapter.preflight();const {createIdentitySession}=await import('../scripts/report-identity-session.mjs');
 const session=await createIdentitySession({chatId:'configured-report-chat',seedTrusted:adapter.seedTrusted,postTrusted:adapter.postTrusted});
 await assert.rejects(session.start(),e=>e.message==='IDENTITY_TRANSPORT_UNCERTAIN_STOP');await assert.rejects(session.start(),/IDENTITY_START_ALREADY_ATTEMPTED/);
});
test.after(async()=>{const {writeFile}=await import('node:fs/promises');await writeFile('../IDENTITY-R1-OWNER-EVIDENCE.json',JSON.stringify(evidence,null,2)+'\n');});
