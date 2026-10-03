import { registerLegacyBank, legacyBankIdentity } from './register-legacy-bank.js';
import { convertVerifiedHistorySnapshot } from '../domain/app-data/convert-history-snapshot.js';
import { validateBankContent } from '../domain/question/bank-content.js';
const fail = code => { throw Object.assign(new Error(code), {code}); };

/** Recoverable local preparation only. Original remote archive is never mutated.
 * UI wires this behind the default-off native snapshot feature gate. Every
 * await is followed by the caller's exact owner/epoch predicate.
 */
export async function prepareUnifiedHistory({session,client,resolvePublicBanks,legacyDedupe,isCurrent,onStatus=()=>{}}) {
  const owner=session.snapshot().owner;
  const guard=()=>{if(!isCurrent()||session.snapshot().closed||JSON.stringify(session.snapshot().owner)!==JSON.stringify(owner))fail('STALE_REQUEST');};
  guard();if(owner?.ownerKind!=='account')fail('ACCOUNT_PROFILE_REQUIRED');
  const status=(state,counts)=>{guard();onStatus({state,...counts});};
  async function list(method,max){const items=[];let cursor=null;for(let page=0;page<20;page++){const result=await client[method]({limit:5,cursor});guard();items.push(...result.items);if(items.length>max)fail('HISTORY_PREPARATION_LIMIT');if(result.nextCursor===null)return items;cursor=result.nextCursor;}fail('HISTORY_PREPARATION_LIMIT');}
  status('preparing');
  const bankItems=await list('listBanks',15), historyItems=await list('listHistory',100), banks=new Map();
  const stored=await session.storedBanks();guard();
  const storedContents=new Map();
  for(const item of bankItems){
    const stableUid=await legacyBankIdentity(owner.accountGeneration,item.id);guard();
    const matches=[];
    for(const record of stored.filter(row=>row.metadata.visibility==='private')){
      const key=record.bankUid+':'+record.revision;
      if(!storedContents.has(key))storedContents.set(key,session.readStoredBank(record.bankUid,record.revision));
      const value=await storedContents.get(key);guard();
      const questions=value.content.questions;
      if(questions.length===item.questionCount&&questions.every(q=>q.legacyArchiveSource?.sourceKey===item.sourceKey&&q.legacyArchiveSource.questionsSha256===item.sha256&&q.legacyArchiveSource.metaSha256===item.metaSha256))matches.push(value.content);
    }
    const stableMatch=matches.find(bank=>bank.bankUid===stableUid);
    if(stableMatch){banks.set(item.id,stableMatch);continue;}
    if(stored.some(record=>record.bankUid===stableUid))fail('LEGACY_BANK_SOURCE_CONFLICT');
    const loaded=await client.readBank(item.id,{chunkCount:item.chunkCount,sha256:item.sha256,byteLength:item.byteLength,sourceKey:item.sourceKey,metaByteLength:item.metaByteLength,metaSha256:item.metaSha256});guard();
    const imported=await registerLegacyBank(loaded.questions,{title:item.title,accountGeneration:owner.accountGeneration,recordId:item.id,legacyArchive:{sourceKey:item.sourceKey,sha256:item.sha256,metaSha256:item.metaSha256}});guard();
    await session.storeRegisteredBank(imported.content);guard();banks.set(item.id,imported.content);
  }
  let converted=0;
  for(const item of historyItems){
    const loaded=await client.readHistory(item.id);guard();const bankId=String(loaded.record.bank_id||'');let contents;
    if(bankId.startsWith('u-')){const bank=banks.get(bankId.slice(2));if(!bank)fail('HISTORY_BANK_MISSING');contents=[bank];}
    else{contents=await resolvePublicBanks(loaded.record);guard();for(const bank of contents){await validateBankContent(bank.content);guard();await session.storeRegisteredBank(bank.content,{staticRef:bank.staticRef});guard();}contents=contents.map(bank=>bank.content);}
    const body=await convertVerifiedHistorySnapshot({verifiedSource:loaded,source:{namespace:'legacy_account',deviceNamespace:null,recordId:item.id,digest:loaded.sha256,conversionVersion:1},accountGeneration:owner.accountGeneration,bankContents:contents,legacyDedupe});guard();
    await session.importHistorySnapshot(body);guard();converted++;status('preparing',{converted,total:historyItems.length});
  }
  status('prepared',{converted,total:historyItems.length,banks:bankItems.length});
  return {converted,total:historyItems.length,banks:bankItems.length,sourceDeleted:false,cloudConfirmed:false};
}

export function createUnifiedHistoryPreparation(options) {
  let flight=null,complete=false;
  const guard=()=>{if(!options.isCurrent()||options.session.snapshot().closed)fail('STALE_REQUEST');};
  async function syncCut(){for(let i=0;i<3;i++){guard();const result=await options.runSync();guard();if(result.synced)return;if(result.paused){options.onStatus?.({state:'pending',reason:result.reason,retryAfter:result.retryAfter});throw Object.assign(new Error(result.reason||'HISTORY_SYNC_PAUSED'),{code:result.reason||'HISTORY_SYNC_PAUSED',retryAfter:result.retryAfter});}}fail('HISTORY_SYNC_PENDING');}
  return Object.freeze({async run(){guard();if(complete)return{cloudConfirmed:true,sourceDeleted:false};if(flight)return flight;
    flight=(async()=>{options.onStatus?.({state:'preparing'});await syncCut();const prepared=await prepareUnifiedHistory(options);guard();options.onStatus?.({state:'saving'});await syncCut();guard();complete=true;options.onStatus?.({state:'ready'});return{...prepared,cloudConfirmed:true};})().finally(()=>{flight=null;});return flight;
  }});
}
