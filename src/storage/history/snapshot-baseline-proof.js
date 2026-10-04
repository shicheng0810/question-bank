import {canonicalBytes,validateSnapshotContinuationBaseline} from '../../domain/app-data/index.js';
import {resolveImmutableBank} from './immutable-bank-resolver.js';
/** @typedef {import('../../domain/app-data/contracts').ContentReference} ContentReference */
/** @typedef {import('../../domain/app-data/contracts').MutationRecord | import('../../domain/app-data/contracts').ChangeLogRecord} SourceReference */
/** @typedef {{owner:{ownerKind:string,accountGeneration?:string},references:SourceReference[],readSnapshotRecord:(id:import('../../domain/app-data/contracts').UUID)=>Promise<import('../../domain/app-data/contracts').HistorySnapshotPayload|null|undefined>,readContent:(reference:ContentReference)=>Promise<unknown>,readBankRevision:(uid:string,revision:string)=>Promise<import('../../domain/app-data/contracts').BankRevisionRecord|null|undefined>,readTombstone:(key:string)=>Promise<unknown>}} ReaderOptions */
/** @param {unknown} a @param {unknown} b */
const same=(a,b)=>new TextDecoder().decode(canonicalBytes(a))===new TextDecoder().decode(canonicalBytes(b));
/** @returns {never} */
const fail=()=>{throw Object.assign(new Error('SNAPSHOT_BASELINE_DEPENDENCY'),{code:'SNAPSHOT_BASELINE_DEPENDENCY'});};
/** Storage adapter. References must already be authenticated, exact cut source
 * records. This reader independently reuses immutable bank/body validation.
 * @param {ReaderOptions} options
 * @returns {(baseline:unknown)=>Promise<import('../../domain/app-data/snapshot-continuation.js').BaselineProof>}
 */
export function createSnapshotBaselineReader({owner,references,readSnapshotRecord,readContent,readBankRevision,readTombstone}){
 return baseline=>validateSnapshotContinuationBaseline(baseline,{owner,
  isTombstoned:async(kind,id)=>!!await readTombstone(`${kind}:${id}`),
  readSnapshot:async id=>{
   const record=await readSnapshotRecord(id),sources=references.filter(row=>row.kind==='history_snapshot'&&row.payload.snapshotId===id);
   if(!record||!sources.length||sources.some(row=>!same(row.payload,record)))fail();
   const loaded=await readContent(record.reference);
   const body=loaded!==null&&typeof loaded==='object'&&'value' in loaded?loaded.value:loaded;
   return {record,body};
  },
  resolveQuestion:async ref=>{
   const bankUid=ref.questionKey.split('/')[0];
   if(bankUid===undefined)fail();
   const bank=await resolveImmutableBank({bankUid,bankRevision:ref.bankRevision,readBankRevision,sourceChanges:async()=>references,readContent});
   const content=/** @type {import('../../domain/question/bank-content.js').RegisteredBankContent} */ (bank.content);
   return content.questions?.find(q=>q.questionKey===ref.questionKey&&q.questionRevision===ref.questionRevision);
  }
 });
}
