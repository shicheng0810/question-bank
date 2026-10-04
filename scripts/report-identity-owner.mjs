// Temporary resident client. This is NOT a Worker/service/admin deployment.
// Fixed existing owner/EDITS/Pages; only already logged-in Wrangler OAuth.
import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createIdentitySession} from './report-identity-session.mjs';
import {CONFIGURED_REPORT_CHAT,IDENTITY_SEED_PREFIX,identityBoundedJson,identityHash} from '../functions/_shared/report-identity-challenge.js';

export const OWNER_TARGET=Object.freeze({accountId:'1cb5e6e63a6b3c3ea0ad9bb01dac30e9',namespaceId:'defda68cdf274d2cad85b40066232daf',endpoint:'https://question-bank-78u.pages.dev/api/report-identity-challenge'});
const config=fileURLToPath(new URL('./report-identity-owner.wrangler.json',import.meta.url));
const wrangler=fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js',import.meta.url));
const runtime=fileURLToPath(new URL('../.identity-owner-runtime/',import.meta.url));

export function ownerChildEnvironment(logPath){
  const env={};
  for(const key of ['PATH','HOME','TMPDIR','LANG','LC_ALL','XDG_CONFIG_HOME','XDG_DATA_HOME'])if(process.env[key])env[key]=process.env[key];
  // No environment API tokens, auth-domain overrides, proxy, debug, browser or
  // arbitrary target overrides. Wrangler alone handles its existing OAuth.
  return {...env,CI:'true',CLOUDFLARE_ACCOUNT_ID:OWNER_TARGET.accountId,WRANGLER_LOG:'log',WRANGLER_LOG_SANITIZE:'true',WRANGLER_LOG_PATH:logPath,WRANGLER_SEND_METRICS:'false',XDG_CACHE_HOME:runtime};
}
export async function runOwnerCommand(args,{spawnImpl=spawn,executable=process.execPath,cli=wrangler}={}){
  await mkdir(runtime,{recursive:true,mode:0o700});
  const directory=await mkdtemp(runtime+'command-');
  try{
    // Only package metadata, never an auth file/token, is read by this adapter.
    if(cli===wrangler && JSON.parse(await readFile(new URL('../node_modules/wrangler/package.json',import.meta.url),'utf8')).version!=='4.72.0')throw Error('OWNER_WRANGLER_VERSION');
    return await new Promise((resolve,reject)=>{
      let stdout='',total=0,settled=false;
      const child=spawnImpl(executable,[cli,...args,'--config',config],{cwd:fileURLToPath(new URL('../',import.meta.url)),env:ownerChildEnvironment(directory+'/wrangler.log'),stdio:['ignore','pipe','pipe']});
      const fail=()=>{if(settled)return;settled=true;child.kill('SIGKILL');clearTimeout(timer);reject(Error('OWNER_COMMAND_UNAVAILABLE'));};
      const timer=setTimeout(fail,20000);
      child.stdout.on('data',chunk=>{total+=chunk.length;if(total>131072)return fail();stdout+=chunk.toString('utf8');});
      child.stderr.on('data',chunk=>{total+=chunk.length;if(total>131072)fail();});
      child.on('error',fail);
      child.on('close',code=>{if(settled)return;settled=true;clearTimeout(timer);if(code===0)resolve(stdout);else reject(Error('OWNER_COMMAND_UNAVAILABLE'));});
    });
  }catch{throw Error('OWNER_COMMAND_UNAVAILABLE');}
  finally{await rm(directory,{recursive:true,force:true});}
}
const sameSeed=(a,b)=>a && Object.keys(a).sort().join(',')===Object.keys(b).sort().join(',') && Object.keys(b).every(k=>a[k]===b[k]);

// These defaults are concrete production interfaces, not caller-supplied stubs.
// Test injection is only through imported JS functions; CLI accepts no adapter,
// account, namespace, URL, chat, KV key, token or executable override.
export function createOwnerAdapter({run=runOwnerCommand,fetchImpl=fetch,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
  let verified=false,seedAttempted=false,seedVerified=false,expectedSeed,startAttempted=false;
  async function preflight(){
    try{
      const owner=JSON.parse(await run(['whoami','--json']));
      if(owner.loggedIn!==true || owner.authType!=='OAuth Token' || !owner.accounts?.some(a=>a.id===OWNER_TARGET.accountId) || !owner.tokenPermissions?.includes('workers_kv:write'))throw Error('OWNER_IDENTITY_OR_SCOPE');
      const namespaces=JSON.parse(await run(['kv','namespace','list']));
      if(!Array.isArray(namespaces) || namespaces.filter(n=>n.id===OWNER_TARGET.namespaceId).length!==1)throw Error('OWNER_TARGET_UNAVAILABLE');
      verified=true;return {state:'owner_verified',accountId:OWNER_TARGET.accountId,namespaceId:OWNER_TARGET.namespaceId};
    }catch{throw Error('EXISTING_OWNER_OR_EDITS_UNAVAILABLE_STOP');}
  }
  async function seedTrusted({key,value,expiration}){
    if(!verified || seedAttempted)throw Error('OWNER_SEED_SCOPE');
    seedAttempted=true;
    if(key!==IDENTITY_SEED_PREFIX+value?.challengeId || !/^[a-f0-9]{32}$/.test(value?.challengeId||'') || value.chatId!==CONFIGURED_REPORT_CHAT || value.schema!==1 || !/^[a-f0-9]{64}$/.test(value.capHash||'') || !/^[A-Za-z0-9_-]{22}$/.test(value.nonce||'') || Object.keys(value).sort().join(',')!=='capHash,challengeId,chatId,createdAt,expiresAt,nonce,schema' || value.expiresAt-value.createdAt!==600000 || expiration!==Math.ceil(value.expiresAt/1000) || value.createdAt>Date.now() || value.expiresAt<=Date.now())throw Error('OWNER_SEED_SCOPE');
    await mkdir(runtime,{recursive:true,mode:0o700});const directory=await mkdtemp(runtime+'seed-');
    try{
      const path=directory+'/metadata.json';
      // Exactly seven fields, HASH only. No capability/code/token ever in this file.
      await writeFile(path,JSON.stringify(value),{mode:0o600,flag:'wx'});
      await run(['kv','key','put',key,'--namespace-id',OWNER_TARGET.namespaceId,'--remote','--path',path,'--expiration',String(expiration)]);
      // One write only. Bounded read-only retries cover KV visibility; unknown
      // results, changed data or a later invocation may never seed another ID.
      for(let i=0;i<5;i++){
        let readback;try{readback=JSON.parse(await run(['kv','key','get',key,'--namespace-id',OWNER_TARGET.namespaceId,'--remote']));}catch{throw Error('OWNER_SEED_READBACK_UNCERTAIN');}
        if(sameSeed(readback,value)){expectedSeed={...value};seedVerified=true;return;}
        if(readback!==null)throw Error('OWNER_SEED_READBACK_MISMATCH');
        if(i<4)await wait(500);
      }
      throw Error('OWNER_SEED_NOT_VISIBLE');
    }catch{throw Error('OWNER_SEED_UNCERTAIN_STOP');}
    finally{await rm(directory,{recursive:true,force:true});}
  }
  async function postTrusted({authorization,body}){
    if(!verified || !seedVerified || expectedSeed.expiresAt<=Date.now() || !/^Bearer [a-f0-9]{64}$/.test(authorization||'') || await identityHash(authorization.slice(7))!==expectedSeed.capHash || !['start','status','confirm'].includes(body?.action) || body.challengeId!==expectedSeed.challengeId || Object.keys(body).some(k=>!['action','challengeId','code'].includes(k)) || (body.action==='confirm' ? !/^[A-F0-9]{4}-[A-F0-9]{4}$/.test(body.code||'') : 'code' in body))throw Error('OWNER_POST_SCOPE');
    if(body.action==='start'){if(startAttempted)throw Error('OWNER_START_ALREADY_ATTEMPTED');startAttempted=true;}
    else if(!startAttempted)throw Error('OWNER_START_REQUIRED');
    try{
      const response=await fetchImpl(OWNER_TARGET.endpoint,{method:'POST',redirect:'error',headers:{authorization,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
      const result=await identityBoundedJson(response,8192);
      if(![200,403].includes(response.status) || !result || typeof result.state!=='string')throw Error('OWNER_RESPONSE_UNKNOWN');
      return result;
    }catch{throw Error('OWNER_HTTPS_UNCERTAIN_STOP');}
  }
  return Object.freeze({preflight,seedTrusted,postTrusted});
}

// The same resident closure stays alive across the human's Telegram interaction.
// Its stdin is controlled by the trusted current-task executor. This does not
// cryptographically identify Codex: the executor must forward only this human's
// explicit current-conversation code; never an observed/generated/test OTP.
export async function runIdentityOwner({input=process.stdin,output=process.stdout,adapter=createOwnerAdapter()}={}){
  const emit=value=>output.write(JSON.stringify(value)+'\n');
  let session,timer;
  try{
    await adapter.preflight();
    session=await createIdentitySession({chatId:CONFIGURED_REPORT_CHAT,seedTrusted:adapter.seedTrusted,postTrusted:adapter.postTrusted});
    const initial=await session.start();emit(initial);
    if(['send_unknown','visibility_unknown','answer_unknown','confirmation_locked','denied','missing','expired'].includes(initial.state))return;
    emit({state:'waiting_current_human_reply',challengeId:session.challengeId,commands:['status','confirm XXXX-XXXX','stop']});
    timer=setTimeout(()=>{session.stop();emit({state:'expired_stop'});input.destroy();},Math.max(0,session.expiresAt-Date.now()));
    let pending='';
    for await(const chunk of input){
      const text=typeof chunk==='string'?chunk:chunk.toString('utf8');
      for(const character of text){
        if(character==='\n'){
          const line=pending.replace(/\r$/,'');pending='';
          if(line==='stop'){session.stop();emit({state:'stopped'});return;}
          if(line==='status'){emit(await session.status());continue;}
          const code=line.match(/^confirm ([A-F0-9]{4}-[A-F0-9]{4})$/)?.[1];
          if(!code){emit({error:'CURRENT_HUMAN_REPLY_COMMAND_REQUIRED'});continue;}
          const result=await session.confirmFromCurrentConversation(code);emit(result);
          if(result.state==='confirmed')return;
        }else{pending+=character;if(pending.length>128)throw Error('OWNER_STDIN_LIMIT');}
      }
    }
  }catch{emit({error:'IDENTITY_OWNER_STOP_NO_AUTOMATIC_RESTART'});}
  finally{clearTimeout(timer);session?.stop();}
}
export async function identityOwnerMain(){
  if(process.argv.slice(2).length!==1 || process.argv[2]!=='--start-once'){
    process.stderr.write('Usage: node scripts/report-identity-owner.mjs --start-once\nExisting owner OAuth only. Starts one TEST, then remains resident for current-human stdin status / confirm CODE / stop. No token, URL, account or chat arguments accepted.\n');process.exitCode=2;return;
  }
  await runIdentityOwner();
}
if(process.argv[1] && import.meta.url===new URL('file:'+process.argv[1]).href)await identityOwnerMain();
