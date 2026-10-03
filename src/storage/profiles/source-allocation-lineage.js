import {canonicalBytes} from '../../domain/app-data/index.js';
import {validateProfileJournalPair,validateCleanupJob,validateCleanupCommitment,validateCleanupPrepare,sameOwner,profileError} from './control-schema.js';
const equal=(a,b)=>{const x=canonicalBytes(a),y=canonicalBytes(b);return x.length===y.length&&x.every((v,i)=>v===y[i]);};
const immutableJournal=journal=>{const {cleanupCommitment,...immutable}=journal;return immutable;};
/** Pure constraints only. Actual registry reads the native rows; this function
 * does not mint deletion/Ready/native capabilities or trust caller summaries. */
export function validateTrackedAllocationLineage({commit,targetProfile,targetJournal,pointer,job,prepare}){
 const before=validateProfileJournalPair(commit.targetProfile,commit.targetJournal);
 const current=validateProfileJournalPair(targetProfile,targetJournal);
 const old=validateCleanupCommitment(before.journal.cleanupCommitment);
 const latest=validateCleanupCommitment(current.journal.cleanupCommitment);
 const checkedJob=validateCleanupJob(job),b=checkedJob.binding;
 if(!['committed','complete'].includes(checkedJob.phase)||before.phase!=='completed'||current.phase!=='completed'||!equal(commit.targetProfile,targetProfile)||!equal(immutableJournal(before.journal),immutableJournal(current.journal))||!equal(commit.targetPointer,pointer)||latest.jobId!==old.jobId||latest.bindingDigest!==old.bindingDigest||checkedJob.jobId!==latest.jobId||checkedJob.bindingDigest!==latest.bindingDigest||!equal(b.sourceProfile,commit.sourceProfile)||!equal(b.sourceJournal,commit.sourceJournal)||!equal(b.finalPointer,pointer)||b.targetProfileId!==current.profile.profileId||b.targetJobId!==current.journal.jobId||b.targetDbName!==current.profile.dbName||b.targetContentDigest!==current.verification.contentDigest||!sameOwner(b.owner,current.owner)||!sameOwner(b.owner,commit.marker.owner)||!equal(b.originalPointer,commit.marker.originalPointer)||b.originalProfileId!==commit.marker.sourceProfileId)throw profileError('CLOUD_CLEANUP_BINDING','tracked allocation immutable lineage differs');
 if(old.prepareAnchor!==undefined&&!equal(old.prepareAnchor,latest.prepareAnchor))throw profileError('CLOUD_CLEANUP_BINDING','original preparation anchor changed');
 if(latest.initialInventory!==null&&!equal(latest.initialInventory,checkedJob.inventory))throw profileError('CLOUD_CLEANUP_BINDING','current inventory differs from durable job');
 if(latest.prepareAnchor!==undefined&&latest.initialInventory===null){
  const marker=validateCleanupPrepare(prepare);
  if(marker.phase!=='terminal-referenced'||marker.jobId!==latest.jobId||marker.job.bindingDigest!==latest.bindingDigest||marker.inventory.sha256!==latest.prepareAnchor.inventoryRoot||!equal(marker.targetProfile,targetProfile)||!equal(marker.targetJournal,targetJournal))throw profileError('CLOUD_CLEANUP_BINDING','current anchor lacks exact durable preparation');
 }
 return checkedJob;
}

