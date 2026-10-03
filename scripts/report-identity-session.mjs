// Temporary in-memory session; concrete owner wiring is report-identity-owner.mjs.
import {identityHash, randomHex, randomNonce, IDENTITY_SEED_PREFIX,CONFIGURED_REPORT_CHAT} from '../functions/_shared/report-identity-challenge.js';

export async function createIdentitySession({chatId, seedTrusted, postTrusted, now=Date.now()}) {
  if (typeof seedTrusted !== 'function' || typeof postTrusted !== 'function' || (chatId!==CONFIGURED_REPORT_CHAT && (!/^-?[1-9][0-9]{0,15}$/.test(String(chatId)) || !Number.isSafeInteger(Number(chatId))))) throw Error('TRUSTED_IDENTITY_ADAPTER_REQUIRED');
  const challengeId=randomHex(16), capability=randomHex(32);
  const seed={schema:1,challengeId,capHash:await identityHash(capability),nonce:randomNonce(),chatId:String(chatId),createdAt:now,expiresAt:now+600000};
  // No raw capability in a file, argument, log, receipt, or returned object.
  // Never expose provider transport exceptions; they may include request headers.
  try { await seedTrusted({key:IDENTITY_SEED_PREFIX+challengeId,value:seed,expiration:Math.ceil(seed.expiresAt/1000)}); } catch { throw Error('IDENTITY_SEED_UNCERTAIN_STOP'); }
  let started=false, stopped=false;
  async function call(action,code) {
    if(stopped || Date.now()>=seed.expiresAt)throw Error('IDENTITY_SESSION_STOPPED');
    try {
      const response=await postTrusted({authorization:'Bearer '+capability,body:{action,challengeId,...(code===undefined?{}:{code})}});
      const safeStates=['prepared','sending','bound','exposing','armed','answering','awaiting_confirmation','confirmed','send_unknown','visibility_unknown','answer_unknown','confirmation_locked','denied','missing','expired'];
      if(!response || !safeStates.includes(response.state))throw Error('IDENTITY_RESPONSE_INVALID');
      const status={challengeId,state:response.state,expiresAt:seed.expiresAt};
      if(response.state==='confirmed'){
        const r=response.receipt;
        const exactChat=seed.chatId===CONFIGURED_REPORT_CHAT ? /^-?[1-9][0-9]{0,15}$/.test(r?.chatId||'') && Number.isSafeInteger(Number(r?.chatId)) : r?.chatId===seed.chatId;
        if(r?.schema!==1 || r.purpose!=='telegram-noop-identity' || r.challengeId!==challengeId || !exactChat || !/^[1-9][0-9]{0,15}$/.test(r.telegramUserId||'') || !Number.isSafeInteger(Number(r.telegramUserId)) || !Number.isSafeInteger(r.messageId) || r.messageId<=0 || !Number.isSafeInteger(r.confirmedAt) || r.confirmedAt<seed.createdAt || r.confirmedAt>=seed.expiresAt || r.authorityGranted!==false)throw Error('IDENTITY_RECEIPT_INVALID');
        status.receipt={schema:1,purpose:r.purpose,challengeId,telegramUserId:r.telegramUserId,chatId:r.chatId,messageId:r.messageId,confirmedAt:r.confirmedAt,authorityGranted:false};
      }
      if(['send_unknown','visibility_unknown','answer_unknown','confirmation_locked','expired','missing'].includes(status.state))stopped=true;
      return status;
    } catch {stopped=true;throw Error('IDENTITY_TRANSPORT_UNCERTAIN_STOP');}
  }
  return Object.freeze({challengeId,expiresAt:seed.expiresAt,
    async start(){if(started)throw Error('IDENTITY_START_ALREADY_ATTEMPTED');started=true;return call('start');},
    status(){return call('status');},
    // Invoke only with the code the human returned in the CURRENT trusted
    // conversation. No polling of callback updates and no code retrieval API.
    confirmFromCurrentConversation(code){if(!started || !/^[A-F0-9]{4}-[A-F0-9]{4}$/.test(code||''))throw Error('IDENTITY_USER_REPLY_REQUIRED');return call('confirm',code);},
    stop(){stopped=true;}
  });
}

if(process.argv[1] && import.meta.url===new URL('file:'+process.argv[1]).href){
  // No top-level-await cycle: owner imports this session module in turn.
  import('./report-identity-owner.mjs').then(({identityOwnerMain})=>identityOwnerMain()).catch(()=>{process.stderr.write('IDENTITY_OWNER_ENTRY_STOP\n');process.exitCode=2;});
}
