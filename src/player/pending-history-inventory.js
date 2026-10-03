const failure=code=>Object.assign(new Error(code),{code});
/** Read-only source inventory. Native session reads supply already-validated
 * immutable bindings. This object never reads raw source bodies or writes.
 * Its lifetime belongs to one exact owner/session epoch, not an open modal. */
export function createPendingHistoryInventory({session,client,isCurrent}){
  const identity=JSON.stringify(session.snapshot().owner);let histories=null,banks=null,flight=null,last=null;
  const guard=()=>{if(!isCurrent()||session.snapshot().closed||JSON.stringify(session.snapshot().owner)!==identity)throw failure('STALE_REQUEST');};
  async function list(method,max){const values=[];let cursor=null;for(let page=0;page<20;page++){const result=await client[method]({limit:5,cursor});guard();values.push(...result.items);if(values.length>max)throw failure('HISTORY_INVENTORY_LIMIT');if(result.nextCursor===null)return values;cursor=result.nextCursor;}throw failure('HISTORY_INVENTORY_LIMIT');}
  function errorCode(error){return error?.code==='RATE_LIMITED'?'RATE_LIMITED':'HISTORY_INVENTORY_UNAVAILABLE';}
  return Object.freeze({peek(){guard();return last;},async refresh({reload=false,visibleHistoryBindings=null,visibleBankUids=null}={}){
    guard();if(flight)return flight;
    flight=(async()=>{
      const errors=[];let retryAfter=0;
      const reads=await Promise.allSettled([histories!==null&&!reload?histories:list('listHistory',100),banks!==null&&!reload?banks:list('listBanks',15)]);guard();
      if(reads[0].status==='fulfilled')histories=reads[0].value;else errors.push(errorCode(reads[0].reason));
      if(reads[1].status==='fulfilled')banks=reads[1].value;else errors.push(errorCode(reads[1].reason));
      for(const result of reads)if(result.status==='rejected'){const wait=result.reason?.retryAfter??result.reason?.details?.retryAfter;if(Number.isSafeInteger(wait)&&wait>0&&wait<=86400)retryAfter=Math.max(retryAfter,wait);}
      const owner=session.snapshot().owner,coveredHistory=new Set(),coveredBanks=new Set();
      try{const entries=await session.history({includeSnapshots:true});guard();for(const entry of entries){if(entry.kind!=='imported_snapshot'||entry.body.accountGeneration!==owner.accountGeneration||entry.body.source.namespace!=='legacy_account')continue;coveredHistory.add(entry.body.source.recordId+':'+entry.body.source.digest);}}catch(error){guard();errors.push(errorCode(error));}
      try{const records=await session.storedBanks();guard();for(const record of records.filter(row=>row.metadata.visibility==='private'&&(visibleBankUids===null||visibleBankUids.includes(row.bankUid)))){const value=await session.readStoredBank(record.bankUid,record.revision);guard();const qs=value.content.questions;for(const item of banks||[]){if(qs.length===item.questionCount&&qs.length>0&&qs.every(q=>q.legacyArchiveSource?.sourceKey===item.sourceKey&&q.legacyArchiveSource.questionsSha256===item.sha256&&q.legacyArchiveSource.metaSha256===item.metaSha256))coveredBanks.add(item.id+':'+item.sha256+':'+item.metaSha256);}}}catch(error){guard();errors.push(errorCode(error));}
      const title=item=>typeof item.title==='string'&&item.title.length<=1024?item.title:null;
      const time=item=>Number.isSafeInteger(item.ts)&&item.ts>=0?item.ts:null;
      // Existing list DTO has no authenticated score field. Never use an
      // incidental/extra score, guess 0/0, or fetch source bodies for display.
      const pendingHistory=(histories||[]).filter(item=>{const key=item.id+':'+item.sha256;return !coveredHistory.has(key)||(visibleHistoryBindings!==null&&!visibleHistoryBindings.includes(key));}).map(item=>Object.freeze({id:item.id,title:title(item),recordedAt:time(item),summary:null,status:'pending'}));
      const pendingBanks=(banks||[]).filter(item=>{const key=item.id+':'+item.sha256+':'+item.metaSha256;return !coveredBanks.has(key);}).map(item=>Object.freeze({id:item.id,title:title(item),questionCount:item.questionCount,status:'pending'}));
      guard();last=Object.freeze({history:Object.freeze(pendingHistory),banks:Object.freeze(pendingBanks),historyKnown:histories!==null,banksKnown:banks!==null,errors:Object.freeze(errors),retryAfter,sourceRetained:true,cloudConfirmed:false});return last;
    })().finally(()=>{flight=null;});return flight;
  }});
}
