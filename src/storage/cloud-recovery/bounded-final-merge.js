import {canonicalBytes,verifyMutationDigest,validateStoreRecord} from '../../domain/app-data/index.js';
import {ownedWriteInput} from '../idb/write-input.js';
import {mutationWire} from '../sync/protocol.js';
import {createBoundedNativeAccess,nativeRecordKey} from './bounded-native.js';
const fail=code=>Object.assign(new Error(code),{code});
const same=(a,b)=>{if(a===undefined||b===undefined)return a===b;if(a?.bytes instanceof Uint8Array||b?.bytes instanceof Uint8Array)return a?.contentDigest===b?.contentDigest&&a?.chunkIndex===b?.chunkIndex&&a.bytes?.length===b.bytes?.length&&a.bytes.every((byte,index)=>byte===b.bytes[index]);const x=canonicalBytes(a),y=canonicalBytes(b);return x.length===y.length&&x.every((byte,index)=>byte===y[index]);};
const runtime=new Set(['syncCoordinatorLease','serverLogEpoch','appliedPullCursor','projectionVersion','projectionInvalidationRevision','projectionAppliedRevision']);
/** Conservative per-row source merge. No guessed winner, new grade or ACK.
 * Divergent mutable bundles require the not-yet-implemented bounded bundle policy.
 */
export function planBoundedSourceMerge(input){
  const value=ownedWriteInput(input);if(Object.keys(value).sort().join()!=='local,remote,store,tombstone')throw fail('BOUNDED_MERGE_INPUT');const {store,local,remote,tombstone}=value;validateStoreRecord(store,local);if(remote!==undefined)validateStoreRecord(store,remote);if(tombstone!==undefined)validateStoreRecord('entity_tombstones',tombstone);
  if(store==='writer_leases'||store==='meta'&&runtime.has(local.key))return {action:'skip'};
  if(tombstone?.status==='confirmed'){
    const bank=store==='bank_revisions'?local.bankUid:store==='user_state'?local.questionKey.split('/')[0]:null;
    if(bank===tombstone.entityId&&tombstone.entityKind==='bank')return {action:'skip'};
    if(local.attemptId===tombstone.entityId&&tombstone.entityKind==='attempt')throw fail('CLOUD_TOMBSTONE_LOCAL_CONFLICT');
  }
  if(remote===undefined)return {action:'put',value:local};if(same(local,remote))return {action:'keep'};
  if(store==='meta')return {action:'put',value:local};
  if(store==='entity_tombstones'&&remote.status==='confirmed'&&local.status==='pending')return {action:'keep'};
  if(store==='import_receipts'&&same(local.provenance,remote.provenance))return {action:'put',value:local};
  throw fail(['attempts','attempt_scope','drafts','user_state'].includes(store)?'BOUNDED_BUNDLE_MERGE_UNAVAILABLE':'CLOUD_LOCAL_FACT_DIVERGENCE');
}
/** Actual native source-only merge into an already owned inactive DB. Both DBs
 * must remain under the caller's real exclusive maintenance capability; guard
 * checks it for every request/async boundary. This candidate never activates.
 */
export async function mergeBoundedNativeSources({localDatabase,inactiveDatabase,signal,guard,timeoutMs=5000}){
  if(typeof guard!=='function'||localDatabase===inactiveDatabase)throw fail('BOUNDED_MERGE_INPUT');guard();
  const local=await createBoundedNativeAccess(localDatabase,{signal,guard,timeoutMs});let target;
  try{target=await createBoundedNativeAccess(inactiveDatabase,{signal,guard,timeoutMs});let copied=0,records=0,bytes=0;
    const stores=['entity_tombstones','mutations','outbox','conflicts','meta','bank_revisions','content_chunks','question_aliases','attempts','attempt_scope','drafts','answer_events','user_state','legacy_raw','legacy_aggregates','migration_journal','import_receipts','checkpoints','writer_leases'];
    for(const store of stores){let after=null;do{const page=await local.readPage({store,after,limit:100});guard();bytes+=page.bytes;if(bytes>100*1024*1024)throw fail('BOUNDED_MERGE_TOTAL_BUDGET');
      for(const row of page.rows){if(++records>200000)throw fail('BOUNDED_MERGE_COUNT_BUDGET');guard();
        if(store==='mutations'&&!await verifyMutationDigest(mutationWire(row)))throw fail('CORRUPT_MUTATION');
        if(store==='outbox'||store==='conflicts'){const id=store==='outbox'?row.mutationId:row.conflictId,[original]=await local.readKeys([{store:'mutations',key:id}]);if(!original||!await verifyMutationDigest(mutationWire(original))||store==='conflicts'&&!same(mutationWire(original),row.mutation))throw fail('CLOUD_LOCAL_ORIGINAL_MISSING');
          const p=original.payload,bank=p.bankUid||p.questionKey?.split('/')[0],attempt=p.attemptId||p.event?.attemptId;const refs=[...(bank?[{store:'entity_tombstones',key:'bank:'+bank}]:[]),...(attempt?[{store:'entity_tombstones',key:'attempt:'+attempt}]:[])];if((await target.readKeys(refs)).some(item=>item?.status==='confirmed'))throw fail('CLOUD_TOMBSTONE_PENDING_CONFLICT');}
        const key=nativeRecordKey(store,row),[remote]=await target.readKeys([{store,key}]);let tombstone;
        const bank=store==='bank_revisions'?row.bankUid:store==='user_state'?row.questionKey.split('/')[0]:null;
        const entity=bank?'bank:'+bank:row.attemptId?'attempt:'+row.attemptId:null;if(entity)[tombstone]=await target.readKeys([{store:'entity_tombstones',key:entity}]);
        const plan=planBoundedSourceMerge({store,local:row,remote,tombstone});guard();if(plan.action==='put'){await target.putExact([{store,value:plan.value,expected:remote}]);guard();copied++;}
      }after=page.after;
    }while(after!==null);}
    return {status:'source_merged_unverified',copied,records,bytes,ready:false};
  }finally{target?.close();local.close();}
}
