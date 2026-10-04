import { canonicalBytes } from '../../domain/app-data/index.js';
import { snapshotOwner, sameOwner } from '../profiles/control-schema.js';
import { openProfileContext } from '../idb/profile-context.js';
import { captureProfile, validateSnapshot, STORE_NAMES, backupError } from './snapshot.js';
import { encodeBackup, decodeBackup } from './archive.js';
import { mergeGuestSnapshots } from './merge.js';

const same = (a, b) => new TextDecoder().decode(canonicalBytes(a)) === new TextDecoder().decode(canonicalBytes(b));
function bind(registry, owner, signal, isCurrent) {
  const capturedOwner = snapshotOwner(owner);
  if (!registry || !sameOwner(registry.ownerSnapshot(), capturedOwner)) throw backupError('BACKUP_OWNER_MISMATCH');
  const guard = () => { if (signal?.aborted || !isCurrent()) throw backupError('CLOSED'); if (!sameOwner(registry.ownerSnapshot(), capturedOwner)) throw backupError('BACKUP_OWNER_MISMATCH'); };
  guard(); return { owner: capturedOwner, guard };
}
/** One readonly 19-store slice, then bounded ZIP work outside IDB transactions. */
export async function exportLocalBackup({ registry, owner, signal, isCurrent = () => true, blockedTimeoutMs = 5000, appVersion = 'qb-v2-local' }) {
  const bound = bind(registry, owner, signal, isCurrent);
  const before = await registry.readActive(); bound.guard();
  if (!before) throw backupError('BACKUP_ACTIVE_MISSING');
  const snapshot = await captureProfile(before.profile, { blockedTimeoutMs, signal }); bound.guard();
  const after = await registry.readActive(); bound.guard();
  if (!same(before, after)) throw backupError('STALE_ACTIVE_PROFILE');
  return encodeBackup(snapshot, { owner: bound.owner, sourceProfileHint: before.profile.profileId, appVersion, signal });
}
/** Restore never writes the active DB. A new staged DB is read back, hashed and
 * dependency-checked before the existing registry activation CAS is allowed.
 * History retains its original writerStreamId; current device stream is new,
 * so continuing old-stream attempts requires an explicit fork.
 */
export async function restoreLocalBackup({ registry, owner, archive, expectedRevision, signal, isCurrent = () => true, blockedTimeoutMs = 5000, nowMs = Date.now() }) {
  const bound = bind(registry, owner, signal, isCurrent);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !Number.isSafeInteger(nowMs) || nowMs < 0) throw backupError('INVALID_INPUT');
  const capturedArchive = archive instanceof Uint8Array ? archive.slice() : archive;
  const decoded = await decodeBackup(capturedArchive, { owner: bound.owner, signal }); bound.guard();
  const before = await registry.readActive(); bound.guard();
  if ((before?.pointer.activationRevision ?? 0) !== expectedRevision) throw backupError('REVISION_CONFLICT');
  let mergeConflicts=[], targetCut=null;
  if(bound.owner.ownerKind==='guest'&&before){targetCut=await captureProfile(before.profile,{blockedTimeoutMs,signal});bound.guard();const merged=mergeGuestSnapshots(targetCut,decoded.snapshot);mergeConflicts=merged.conflicts;if(!mergeConflicts.length)decoded.snapshot=merged.snapshot;}
  const clientStreamId = crypto.randomUUID();
  decoded.snapshot.meta = [{ key: 'clientStreamId', value: clientStreamId }, { key: 'clientSeq', value: 0 }, { key: 'clockHighWaterMs', value: nowMs },{key:'projectionVersion',value:1},{key:'projectionInvalidationRevision',value:1},{key:'projectionAppliedRevision',value:0}];
  const expected = await validateSnapshot(decoded.snapshot, bound.owner); bound.guard();
  const profile = await registry.createRestoreStage(); bound.guard();
  let activated = false;
  try {
  if (bound.owner.ownerKind === 'account' || mergeConflicts.length) {
    // File bytes are not a current server tombstone/epoch proof. Preserve the
    // package in a non-active staged DB only; no old transport can run from it.
    const context = await openProfileContext({ profile, openMode: 'existing', blockedTimeoutMs, signal });
    try { await context.transaction(STORE_NAMES, 'readwrite', tx => { bound.guard(); for (const name of STORE_NAMES) for (const row of decoded.snapshot[name]) { const request = tx.objectStore(name).add(row); void request.catch(() => {}); } }); }
    finally { context.close(); }
    await registry.quarantineRestore(profile.profileId); bound.guard();
    return { status: 'quarantined', profileId: profile.profileId, error: bound.owner.ownerKind==='account'?'ACCOUNT_RESTORE_REQUIRES_TOMBSTONES':'GUEST_RESTORE_MERGE_CONFLICT', conflicts:mergeConflicts, manifest: decoded.manifest };
  }
  const context = await openProfileContext({ profile, openMode: 'existing', blockedTimeoutMs, signal });
  try {
    await context.transaction(STORE_NAMES, 'readwrite', tx => {
      bound.guard();
      for (const name of STORE_NAMES) for (const row of decoded.snapshot[name]) { const request = tx.objectStore(name).add(row); void request.catch(() => {}); }
    });
  } finally { context.close(); }
  bound.guard();
  const verified = await registry.finalizeRestore({ profileId: profile.profileId, expectedContentDigest: expected.contentDigest }); bound.guard();
  const active=await registry.withActivationLock(async access=>{
    bound.guard();const currentActive=await access.readActive();if(!same(currentActive,before))throw backupError('REVISION_CONFLICT');
    if(targetCut){const current=await captureProfile(before.profile,{blockedTimeoutMs,signal});const original=await validateSnapshot(targetCut,bound.owner),latest=await validateSnapshot(current,bound.owner);bound.guard();if(original.contentDigest!==latest.contentDigest)throw backupError('RESTORE_TARGET_CHANGED');}
    const value=await access.activate({profileId:verified.profileId,expectedRevision});activated=true;bound.guard();return value;
  });
  return { ...active, clientStreamId, manifest: decoded.manifest, recordCount: expected.recordCount };
  } catch (error) {
    if (!activated) { try { await registry.quarantineRestore(profile.profileId); } catch { /* interrupted stage is preserved; never delete/recreate */ } }
    throw error;
  }
}
export { encodeBackup, decodeBackup, captureProfile, validateSnapshot };
