import { validateBankContent } from '../domain/question/bank-content.js';
const fail=code=>{throw Object.assign(new Error(code),{code});};
export async function resolveLegacyPublicBanks(snapshot,{entries,session,isCurrent,fetchImpl=fetch}){
 const guard=()=>{if(!isCurrent()||session.snapshot().closed)fail('STALE_REQUEST');};guard();
 const bankId=String(snapshot.bank_id||'');
 const slugs=Array.isArray(snapshot.merged_banks)?snapshot.merged_banks.map(row=>typeof row==='string'?row:row?.slug):bankId==='all-banks'?entries.map(row=>row.slug):[bankId];
 if(!slugs.length||slugs.some(slug=>typeof slug!=='string')||new Set(slugs).size!==slugs.length)fail('HISTORY_BANK_MISSING');
 const banks=[];
 for(const slug of slugs){
  const entry=entries.find(row=>row.slug===slug);if(!entry||entry.contentManifest?.kind==='protected_cipher')fail('HISTORY_BANK_MISSING');
  let content;
  try{content=(await session.readStoredBank(entry.bankUid,entry.revision)).content;guard();}
  catch(error){guard();if(!['BANK_CONTENT_MISSING','MISSING_CONTENT'].includes(error.code))throw error;const response=await fetchImpl(entry.staticRef,{cache:'no-store'});guard();if(!response.ok)fail('HISTORY_BANK_UNAVAILABLE');
   const reader=response.body.getReader(),parts=[];let length=0;try{for(;;){const part=await reader.read();guard();if(part.done)break;length+=part.value.length;if(length>100*1024*1024){await reader.cancel();fail('HISTORY_BANK_LIMIT');}parts.push(part.value);}}finally{reader.releaseLock();}
   const bytes=new Uint8Array(length);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}content=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  }
  const checked=await validateBankContent(content);guard();if(checked.content.bankUid!==entry.bankUid||checked.contentDigest!==entry.revision)fail('HISTORY_BANK_BINDING');
  banks.push({content:checked.content,staticRef:entry.staticRef});
 }
 return banks;
}
