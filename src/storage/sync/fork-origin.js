import {canonicalBytes,canonicalContentBytes,validateImportReceiptRecord} from '../../domain/app-data/index.js';
import {isUuid} from '../../domain/question/index.js';
import {syncError} from './protocol.js';
export function validateForkOriginReceipt(value){
  canonicalBytes(value);validateImportReceiptRecord(value);const p=value.provenance;
  if(!p||Object.keys(p).sort().join()!=='childAttemptId,commandId,format,parentAttemptId,parentResumeContentDigest'||p.format!=='qb-fork-origin-v1'||value.sourceId!==p.format||value.sourceRecordId!==p.commandId||![p.parentAttemptId,p.childAttemptId,p.commandId].every(isUuid)||p.parentAttemptId===p.childAttemptId||typeof p.parentResumeContentDigest!=='string'||!/^[0-9a-f]{64}$/.test(p.parentResumeContentDigest))throw syncError('FORK_ORIGIN_CORRUPT');
  return structuredClone(value);
}
export function assertForkOriginProof(origin,manifest,child,parent){
  const cs=child.root.state,ps=parent.root.state;
  if(ps.attemptId!==origin.parentAttemptId||cs.attemptId!==origin.childAttemptId||manifest.attemptId!==origin.childAttemptId||manifest.parentAttemptId!==origin.parentAttemptId||manifest.writerStreamId!==cs.writerStreamId||manifest.scopeDigest!==cs.scopeDigest||manifest.scopeCount!==cs.scope.length)throw syncError('FORK_ORIGIN_CORRUPT');
  const projection=state=>state.scope.map(({attemptId,...row})=>row);
  const same=(a,b)=>new TextDecoder().decode(canonicalContentBytes(a))===new TextDecoder().decode(canonicalContentBytes(b));
  const expected=ps.questionDrafts.map(row=>({...row,localRevision:1,inheritedFrom:{attemptId:origin.parentAttemptId,resumeContentDigest:origin.parentResumeContentDigest}}));
  if(!same(projection(cs),projection(ps))||!same(cs.questionDrafts,expected)||cs.submittedEventIds.length||cs.position!==ps.position||cs.effectiveElapsedMs!==ps.effectiveElapsedMs)throw syncError('FORK_ORIGIN_CORRUPT');
}
