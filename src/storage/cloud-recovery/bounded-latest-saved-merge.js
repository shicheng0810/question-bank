import {sha256} from '@noble/hashes/sha2.js';
import {APP_DATA_STORES,canonicalBytes,verifyMutationDigest,validateMetaRecord} from '../../domain/app-data/index.js';
import {createBoundedNativeAccess,nativeRecordKey,nativeRecordSize,NATIVE_BATCH_BYTES} from './bounded-native.js';
import {mutationWire} from '../sync/protocol.js';
import {assertLatestMergePair} from '../profiles/managed-profile-registry.js';
import {planExactCloudReceipt,planSyncEntityReceipt,planCloudRuntimeCut} from './cloud-receipt-reconcile.js';

const fail=code=>Object.assign(new Error(code),{code});
const hex=bytes=>Array.from(bytes,x=>x.toString(16).padStart(2,'0')).join('');
const same=(a,b)=>{if(a===undefined||b===undefined)return a===b;if(a?.bytes instanceof Uint8Array||b?.bytes instanceof Uint8Array)return a?.contentDigest===b?.contentDigest&&a?.chunkIndex===b?.chunkIndex&&a.bytes?.length===b.bytes?.length&&a.bytes.every((x,i)=>x===b.bytes[i]);const x=canonicalBytes(a),y=canonicalBytes(b);return x.length===y.length&&x.every((v,i)=>v===y[i]);};
const runtime=new Set(['syncCoordinatorLease','serverLogEpoch','appliedPullCursor','projectionVersion','projectionInvalidationRevision','projectionAppliedRevision']);
const privateMergeDiagnostics=new WeakMap();
export async function readLatestSavedMergeDiagnostics(pair,sourceDatabase,targetDatabase){const binding=assertLatestMergePair(pair,sourceDatabase,targetDatabase),state=privateMergeDiagnostics.get(pair);if(!state)throw fail('CLOSED');await binding.recheck();if(!state.live)throw fail('CLOSED');const result=Object.freeze({...state.metrics});await binding.recheck();if(!state.live)throw fail('CLOSED');return result;}

/** Native ordered cut; only bounded pages and fixed-size hashes survive a page. */
async function fingerprint(native,recheck,operationalMetaKeys=[],metrics){
  const stores={};let records=0,bytes=0,businessBytes=0;
  for(const store of Object.keys(APP_DATA_STORES)){
    const hash=sha256.create();let after=null,count=0;
    do{await recheck();const page=await native.readPage({store,after,limit:100});await recheck();
      bytes+=page.bytes;if(bytes>100*1024*1024)throw fail('BOUNDED_MERGE_TOTAL_BUDGET');
      for(const row of page.rows){if(++records>200000)throw fail('BOUNDED_MERGE_COUNT_BUDGET');count++;
        const operational=store==='meta'&&operationalMetaKeys.includes(row.key);if(!operational)businessBytes+=nativeRecordSize(store,row);
        const frame=canonicalBytes({key:nativeRecordKey(store,row),value:operational?{format:'genuine-held-operational-meta-v1'}:store==='content_chunks'?{contentDigest:row.contentDigest,chunkIndex:row.chunkIndex,byteLength:row.bytes.length}:row});
        hash.update(canonicalBytes(frame.length));hash.update(frame);if(metrics){metrics.mergeHashBytes+=frame.length;metrics.mergeHashRows++;}if(store==='content_chunks'){hash.update(row.bytes);if(metrics)metrics.mergeHashBytes+=row.bytes.length;}
      }after=page.after;
    }while(after!==null);stores[store]={count,sha256:hex(hash.digest())};
  }return {stores,records,bytes,businessBytes};
}

/** Genuine registry-paired source copy. Complex divergent bundles are refused,
 * not guessed. RAW preservation has no ACK/cursor authority; the separately
 * verified projected source can reconcile exact receipts. No Ready is minted. */
export async function mergeLatestSavedNative({pair,sourceDatabase,targetDatabase,signal,timeoutMs}){
  const binding=assertLatestMergePair(pair,sourceDatabase,targetDatabase);
  const {recheck:originalRecheck,assertLive,trackTransaction,verifiedSource,checkpoint,operationalMetaKeys=[]}=binding;
  const state={live:true,metrics:{mergeChecks:0,mergeCheckMs:0,mergeNativeOps:0,mergeNativeMs:0,mergeRowsRead:0,mergePageBytes:0,mergeHashRows:0,mergeHashBytes:0}},metrics=state.metrics;privateMergeDiagnostics.set(pair,state);
  const recheck=async()=>{const start=performance.now();metrics.mergeChecks++;try{return await originalRecheck();}finally{metrics.mergeCheckMs+=performance.now()-start;}};
  const observe=actual=>Object.freeze(Object.fromEntries(Object.entries(actual).map(([key,value])=>[key,typeof value==='function'?['readPage','readKeys','write'].includes(key)?async(...args)=>{const start=performance.now();metrics.mergeNativeOps++;try{const result=await Reflect.apply(value,actual,args);if(key==='readPage'){metrics.mergeRowsRead+=result.rows.length;metrics.mergePageBytes+=result.bytes;}else if(key==='readKeys')metrics.mergeRowsRead+=result.filter(row=>row!==undefined).length;return result;}finally{metrics.mergeNativeMs+=performance.now()-start;}}:(...args)=>Reflect.apply(value,actual,args):value])));
  await recheck();const source=observe(await createBoundedNativeAccess(sourceDatabase,{signal,guard:assertLive,timeoutMs}));let target;
  try{
    target=observe(await createBoundedNativeAccess(targetDatabase,{signal,guard:assertLive,timeoutMs}));await recheck();
    const before=await fingerprint(source,recheck,operationalMetaKeys,metrics);let copied=0;
    // Resolve membership from original native outbox/mutation identities. No
    // payload-digest heuristic, ordinal ordering, or caller-supplied membership.
    async function pending(predicate){let after=null;do{await recheck();const page=await source.readPage({store:'outbox',after,limit:100});await recheck();for(const row of page.rows){const [original]=await source.readKeys([{store:'mutations',key:row.mutationId}]);await recheck();if(!original||!await verifyMutationDigest(mutationWire(original)))throw fail('CLOUD_LOCAL_ORIGINAL_MISSING');await recheck();if(predicate(original))return true;}after=page.after;}while(after!==null);return false;}
    async function preserveAttempt(id){const [local]=await source.readKeys([{store:'attempts',key:id}]);const [remote]=await target.readKeys([{store:'attempts',key:id}]);await recheck();if(!local)return false;return !remote||remote.writerStreamId===local.writerStreamId&&remote.localRevision<local.localRevision||await pending(m=>(m.payload.attemptId||m.payload.event?.attemptId)===id);}
    async function deleteExact(store,row){await recheck();await new Promise((resolve,reject)=>{let tx,timer,untrack=()=>{},done=false;const finish=error=>{if(done)return;done=true;clearTimeout(timer);untrack();error?reject(error):resolve();};try{assertLive();tx=targetDatabase.transaction([store],'readwrite');untrack=trackTransaction(tx);timer=setTimeout(()=>{try{tx.abort();}catch{}finish(fail('NATIVE_STORE_NOT_COMMITTED'));},timeoutMs);tx.oncomplete=()=>{try{assertLive();finish();}catch(e){finish(e);}};tx.onabort=()=>finish(fail('NATIVE_STORE_NOT_COMMITTED'));tx.onerror=()=>{};const request=tx.objectStore(store).get(nativeRecordKey(store,row));request.onsuccess=()=>{try{assertLive();if(!same(request.result,row))throw fail('NATIVE_FACT_CHANGED');tx.objectStore(store).delete(nativeRecordKey(store,row));}catch(e){try{tx.abort();}catch{}finish(e);}};}catch(e){try{tx?.abort();}catch{}finish(e);}});await recheck();}
    // Final projected cut: logical bank retirement removes star projections,
    // never immutable grades/history/chunks. RAW first-page preservation is
    // not a full tombstone projection and cannot authorize this deletion.
    if(verifiedSource){let after=null;do{const page=await target.readPage({store:'user_state',after,limit:100});await recheck();for(const row of page.rows){const bank=row.questionKey.split('/')[0];const [dead]=await target.readKeys([{store:'entity_tombstones',key:'bank:'+bank}]);await recheck();if(dead?.entityKind==='bank'&&dead.status==='confirmed'){if(await pending(m=>m.entityKey===dead.entityKey||m.payload.bankUid===bank||m.kind==='user_state'&&m.payload.questionKey.split('/')[0]===bank))throw fail('CLOUD_TOMBSTONE_PENDING_CONFLICT');await deleteExact('user_state',row);}}after=page.after;}while(after!==null);}
    // Exhaust remote scope/drafts for an actually preserved local attempt.
    // One real native conditional delete per row; no getAll or grade rewrite.
    for(const store of ['attempt_scope','drafts']){let after=null;do{const page=await target.readPage({store,after,limit:100});await recheck();for(const row of page.rows)if(await preserveAttempt(row.attemptId)){const [original]=await source.readKeys([{store,key:nativeRecordKey(store,row)}]);await recheck();if(original===undefined)await deleteExact(store,row);}after=page.after;}while(after!==null);}
    // Keep the original remote header until all associated scope/draft rows
    // have been considered; the header is copied last, not used as a forecast.
    const order=Object.keys(APP_DATA_STORES).filter(name=>name!=='attempts').concat('attempts');
    for(const store of order){
      let after=null;do{await recheck();const page=await source.readPage({store,after,limit:100});await recheck();
        for(const row of page.rows){
          if(store==='writer_leases'||store==='meta'&&runtime.has(row.key))continue;
          if(store==='mutations'){if(!await verifyMutationDigest(mutationWire(row)))throw fail('CORRUPT_MUTATION');await recheck();}
          const bank=store==='bank_revisions'?row.bankUid:store==='user_state'?row.questionKey.split('/')[0]:null;
          const entity=bank?'bank:'+bank:row.attemptId?'attempt:'+row.attemptId:null;
          let dead;if(entity){[dead]=await target.readKeys([{store:'entity_tombstones',key:entity}]);await recheck();}
          if(dead?.entityKind==='attempt')throw fail('CLOUD_TOMBSTONE_LOCAL_CONFLICT');
          if(dead?.entityKind==='bank'){
            if(await pending(m=>m.payload.bankUid===bank||m.kind==='user_state'&&m.payload.questionKey.split('/')[0]===bank))throw fail('CLOUD_TOMBSTONE_PENDING_CONFLICT');
            continue; // retirement is not grade/history/chunk purge authority
          }
          const [remote]=await target.readKeys([{store,key:nativeRecordKey(store,row)}]);await recheck();
          if(store==='user_state'&&!await pending(m=>m.kind==='user_state'&&m.payload.questionKey===row.questionKey))continue;
          if(['attempts','attempt_scope','drafts'].includes(store)){
            if(!await preserveAttempt(row.attemptId))continue;
          }
          if(remote&&!same(row,remote)){
            if(store==='meta'||store==='user_state'||['attempts','attempt_scope','drafts'].includes(store)){/* local metadata / actual pending star / preserved whole bundle */}
            else if(store==='entity_tombstones'&&remote.status==='confirmed'&&row.status==='pending')continue;
            else if(store==='import_receipts'&&row.provenance?.format==='qb-sync-entity-v1'&&remote.provenance?.format==='qb-sync-entity-v1'){if(planSyncEntityReceipt({local:row,remote}).action==='keep_remote')continue;}
            else if(store==='import_receipts'&&same(row.provenance,remote.provenance)){/* original provenance, local timestamp */}
            else throw fail('CLOUD_LOCAL_FACT_DIVERGENCE');
          }
          // Transport reconciliation is deliberately not an ACK: an exact
          // original outbox remains until a separately verified receipt phase.
          if(!same(row,remote)){await target.putExact([{store,value:row,expected:remote}]);await recheck();copied++;}
        }after=page.after;
      }while(after!==null);
    }
    let reconciled=0,receiptConflicts=0;
    async function commitReceipt(conditions,puts,deletes){
      let bytes=0;for(const row of conditions)if(row.expected!==undefined)bytes+=nativeRecordSize(row.store,row.expected);for(const row of puts)bytes+=nativeRecordSize(row.store,row.value);if(bytes>NATIVE_BATCH_BYTES)throw fail('NATIVE_BATCH_BUDGET');
      await recheck();await new Promise((resolve,reject)=>{let tx,timer,untrack=()=>{},done=false;const finish=error=>{if(done)return;done=true;clearTimeout(timer);untrack();error?reject(error):resolve();};try{assertLive();tx=targetDatabase.transaction([...new Set(conditions.concat(puts,deletes).map(row=>row.store))],'readwrite');untrack=trackTransaction(tx);timer=setTimeout(()=>{try{tx.abort();}catch{}finish(fail('NATIVE_STORE_NOT_COMMITTED'));},timeoutMs);tx.oncomplete=()=>{try{assertLive();finish();}catch(error){finish(error);}};tx.onabort=()=>finish(fail('NATIVE_STORE_NOT_COMMITTED'));tx.onerror=()=>{};let left=conditions.length;for(const row of conditions){const request=tx.objectStore(row.store).get(row.key);request.onsuccess=()=>{try{assertLive();if(!same(request.result,row.expected))throw fail('NATIVE_FACT_CHANGED');if(!--left){for(const item of puts)tx.objectStore(item.store).put(item.value);for(const item of deletes)tx.objectStore(item.store).delete(item.key);}}catch(error){try{tx.abort();}catch{}finish(error);}};}}catch(error){try{tx?.abort();}catch{}finish(error);}});await recheck();
    }
    if(verifiedSource){
      const context={generation:checkpoint.generation,logEpoch:checkpoint.logEpoch,cut:checkpoint.cut};let after=null;
      do{const page=await source.readPage({store:'mutations',after,limit:100});await recheck();for(const original of page.rows){
        const actual=await verifiedSource.readMutationReceipt(original.mutationId);await recheck();if(actual===undefined)continue;
        const receipt={sourceId:`qb-cloud-receipt-v1:${context.generation}:${context.logEpoch}`,sourceRecordId:original.mutationId,importedAt:Date.now(),provenance:{format:'qb-cloud-receipt-v1',generation:context.generation,logEpoch:context.logEpoch,...actual}};
        const change=['accepted','duplicate'].includes(actual.receipt.status)?await verifiedSource.readAcceptedChange(actual.receipt.serverSeq):undefined;await recheck();
        const [outbox,previousConflict,previousReceipt,targetOriginal]=await target.readKeys([{store:'outbox',key:original.mutationId},{store:'conflicts',key:original.mutationId},{store:'import_receipts',key:[receipt.sourceId,receipt.sourceRecordId]},{store:'mutations',key:original.mutationId}]);await recheck();
        if(!same(original,targetOriginal))throw fail('CLOUD_LOCAL_ORIGINAL_MISSING');
        const plan=await planExactCloudReceipt({mutation:original,outbox,previousConflict,receipt,change,context});await recheck();
        if(previousReceipt&&!same(previousReceipt.provenance,receipt.provenance))throw fail('CLOUD_LOCAL_RECEIPT_MISMATCH');
        const conditions=[{store:'mutations',key:original.mutationId,expected:targetOriginal},{store:'outbox',key:original.mutationId,expected:outbox},{store:'conflicts',key:original.mutationId,expected:previousConflict},{store:'import_receipts',key:[receipt.sourceId,receipt.sourceRecordId],expected:previousReceipt}];
        const puts=previousReceipt?[]:[{store:'import_receipts',value:receipt}],deletes=[];
        if(plan.action==='delete_exact_outbox'&&outbox)deletes.push({store:'outbox',key:original.mutationId});
        if(plan.action==='retain_outbox_with_conflict'&&!previousConflict)puts.push({store:'conflicts',value:plan.conflict});
        if(puts.length||deletes.length)await commitReceipt(conditions,puts,deletes);
        if(deletes.length)reconciled++;
        if(plan.action==='retain_outbox_with_conflict')receiptConflicts++;
      }after=page.after;}while(after!==null);
      const [invalidation]=await source.readKeys([{store:'meta',key:'projectionInvalidationRevision'}]);await recheck();
      const runtimePlan=planCloudRuntimeCut({context,invalidation:invalidation?.value??0});for(const row of runtimePlan.records){const [prior]=await target.readKeys([{store:'meta',key:row.key}]);await recheck();await target.putExact([{store:'meta',value:row,expected:prior}]);await recheck();}
    }
    const after=await fingerprint(source,recheck,operationalMetaKeys,metrics);
    const stable=cut=>operationalMetaKeys.length?{stores:cut.stores,records:cut.records,businessBytes:cut.businessBytes}:cut;
    if(!same(stable(before),stable(after)))throw fail('LATEST_SOURCE_CHANGED');await recheck();
    if(operationalMetaKeys.length){
      const [sourceClock]=await source.readKeys([{store:'meta',key:'clockHighWaterMs'}]),[targetClock]=await target.readKeys([{store:'meta',key:'clockHighWaterMs'}]);await recheck();validateMetaRecord(sourceClock);validateMetaRecord(targetClock);
      const value=Math.max(sourceClock.value,targetClock.value);await target.putExact([{store:'meta',value:{key:'clockHighWaterMs',value},expected:targetClock}]);await recheck();
    }
    return {status:'latest_source_merged_unverified',copied,sourceFingerprint:after,sourceOperationalMetaMayChange:operationalMetaKeys.length>0,ready:false,fullSemanticClosure:false,transportReconciled:Boolean(verifiedSource),reconciled,receiptConflicts};
  }finally{state.live=false;target?.close();source.close();}
}
