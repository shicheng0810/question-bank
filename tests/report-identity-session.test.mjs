import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createIdentitySession} from '../scripts/report-identity-session.mjs';
import {identityHash} from '../functions/_shared/report-identity-challenge.js';

test('temporary client exposes no capability; seed contains only hash; start is once and receipt is sanitized',async()=>{
 let seed,headersSeen,starts=0,confirmed=0;
 const session=await createIdentitySession({chatId:'-100123',seedTrusted:async input=>{seed=input.value;},postTrusted:async input=>{
  headersSeen=input.authorization;
  if(input.body.action==='start'){starts++;return {state:'armed',leak:'discard'};}
  if(input.body.action==='status')return {state:'awaiting_confirmation',candidateId:'999',capHash:'discard',codeHash:'discard'};
  confirmed++;return {state:'confirmed',receipt:{schema:1,purpose:'telegram-noop-identity',challengeId:input.body.challengeId,telegramUserId:'999',chatId:'-100123',messageId:71,confirmedAt:Date.now(),authorityGranted:false,extra:'discard'}};
 }});
 assert.equal('capability' in session,false);
 assert.equal((await session.start()).state,'armed');
 assert.equal(await identityHash(headersSeen.slice(7))===seed.capHash,true);
 assert.equal(JSON.stringify(seed).includes(headersSeen.slice(7)),false);
 assert.equal(JSON.stringify(session).includes(headersSeen.slice(7)),false);
 await assert.rejects(session.start(),/IDENTITY_START_ALREADY_ATTEMPTED/);
 assert.equal(starts,1);
 const waiting=await session.status();assert.equal('candidateId' in waiting || 'capHash' in waiting || 'codeHash' in waiting,false);
 assert.throws(()=>session.confirmFromCurrentConversation(),/IDENTITY_USER_REPLY_REQUIRED/);
 const result=await session.confirmFromCurrentConversation('ABCD-1234');
 assert.equal(result.receipt.authorityGranted,false);assert.equal('extra' in result.receipt,false);assert.equal(confirmed,1);
 session.stop();await assert.rejects(session.status(),/IDENTITY_SESSION_STOPPED/);
});
test('client sanitizes transport errors that might contain bearer values and permanently stops',async()=>{
 const session=await createIdentitySession({chatId:'-100123',seedTrusted:async()=>{},postTrusted:async input=>{throw Error(input.authorization);}});
 await assert.rejects(session.start(),e=>e.message==='IDENTITY_TRANSPORT_UNCERTAIN_STOP');
 await assert.rejects(session.status(),e=>e.message==='IDENTITY_SESSION_STOPPED');
});
test('uncertain seed prevents any HTTP transport and exposes no provider exception',async()=>{
 let posted=false;
 await assert.rejects(createIdentitySession({chatId:'-100123',seedTrusted:async()=>{throw Error('synthetic provider payload');},postTrusted:async()=>{posted=true;}}),e=>e.message==='IDENTITY_SEED_UNCERTAIN_STOP');
 assert.equal(posted,false);
});
test('missing trusted adapters fail at the safety boundary without requests',async()=>{
 await assert.rejects(createIdentitySession({chatId:'-100123'}),/TRUSTED_IDENTITY_ADAPTER_REQUIRED/);
});
test('unknown server send or popup and forged receipt stop the temporary session',async()=>{
 for(const state of ['send_unknown','visibility_unknown','answer_unknown','confirmation_locked']){
  const session=await createIdentitySession({chatId:'-100123',seedTrusted:async()=>{},postTrusted:async()=>({state})});
  assert.equal((await session.start()).state,state);await assert.rejects(session.status(),/IDENTITY_SESSION_STOPPED/);
 }
 const session=await createIdentitySession({chatId:'-100123',seedTrusted:async()=>{},postTrusted:async()=>({state:'confirmed',receipt:{authorityGranted:true}})});
 await assert.rejects(session.start(),e=>e.message==='IDENTITY_TRANSPORT_UNCERTAIN_STOP');
});
