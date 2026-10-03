import {assertSnapshotContinuationReceipt,deriveSnapshotContinuationCommandId} from '../../domain/app-data/snapshot-continuation.js';
import {createSnapshotBaselineReader} from '../history/snapshot-baseline-proof.js';
import { APP_DATA_DB_SCHEMA_VERSION, APP_DATA_STORES, canonicalBytes, canonicalContentBytes, canonicalDigest, sha256Hex, validateHistorySnapshotBinding, validateHistorySnapshotPayload, validateStoreRecord, verifyMutationDigest, validateChunkManifest, validateResumeDependencies } from '../../domain/app-data/index.js';
import { loadHistoricalResumeProof } from '../sync/resume-proof.js';
import { validateForkOriginReceipt,assertForkOriginProof } from '../sync/fork-origin.js';
import { validateSyncChangeReceipt } from '../sync/protocol.js';
import {validateCloudReceipt} from '../cloud-recovery/metadata.js';
import {validateStarResolutionReceipt} from '../sync/star-resolution.js';
import {STAR_GROUP_FORMAT,validateStarGroupResolutionReceipt} from '../sync/star-group-resolution.js';
import { openProfileContext } from '../idb/profile-context.js';
import { validateBundle, equal, resumeState, derivedId } from '../../domain/attempt/commands.js';
import {isUuid} from '../../domain/question/index.js';
import { resolveImmutableBank } from '../history/immutable-bank-resolver.js';

export const STORE_NAMES = Object.freeze(Object.keys(APP_DATA_STORES).sort());
// Portable backups written before imported-history snapshots had 19 stores.
// Accept that exact old set on import, then normalize it to the current shape.
export const LEGACY_STORE_NAMES = Object.freeze(STORE_NAMES.filter(name => name !== 'history_snapshots'));
if (STORE_NAMES.length !== 20 || LEGACY_STORE_NAMES.length !== 19) throw new Error('BACKUP_STORE_LAYOUT_UNSUPPORTED');
export const backupError = code => Object.assign(new Error(code), { name: 'LearningBackupError', code });
export const LIMITS = Object.freeze({ archiveBytes: 110 * 1024 * 1024, expandedBytes: 100 * 1024 * 1024, entries: 10000, records: 200000, fileBytes: 16 * 1024 * 1024 });
export function ownSnapshot(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !('value' in Object.getOwnPropertyDescriptor(value, key))) || Object.keys(value).sort().join() !== STORE_NAMES.join()) throw backupError('BACKUP_STORE_SET');
  for (const name of STORE_NAMES) {
    const rows = value[name];
    if (!Array.isArray(rows) || Reflect.ownKeys(rows).some(key => typeof key !== 'string' || !('value' in Object.getOwnPropertyDescriptor(rows, key)))) throw backupError('BACKUP_RECORD_INVALID');
    for (let i = 0; i < rows.length; i++) { if (!Object.hasOwn(rows, i)) throw backupError('BACKUP_RECORD_INVALID'); validateStoreRecord(name, rows[i]); }
  }
  return structuredClone(value);
}
export async function captureProfile(profile, { blockedTimeoutMs = 5000, signal } = {}) {
  const context = await openProfileContext({ profile, openMode: 'existing', blockedTimeoutMs, signal });
  try {
    const requests = [];
    await context.transaction(STORE_NAMES, 'readonly', tx => {
      for (const name of STORE_NAMES) { const request = tx.objectStore(name).getAll(); void request.catch(() => {}); requests.push(request); }
    });
    return Object.fromEntries((await Promise.all(requests)).map((rows, index) => [STORE_NAMES[index], rows]));
  } finally { context.close(); }
}
export async function snapshotManifest(snapshot) {
  const stores = [];
  for (const name of STORE_NAMES) {
    const rows = [];
    const path = APP_DATA_STORES[name].keyPath;
    const key = row => JSON.stringify(Array.isArray(path) ? path.map(field => row[field]) : row[path]);
    for (const row of [...snapshot[name]].sort((a, b) => key(a).localeCompare(key(b), 'en'))) rows.push(name === 'content_chunks' ? { contentDigest: row.contentDigest, chunkIndex: row.chunkIndex, byteLength: row.bytes.byteLength, sha256: await sha256Hex(row.bytes) } : row);
    stores.push({ name, recordCount: rows.length, sha256: await sha256Hex(canonicalContentBytes(rows)) });
  }
  const manifest = { format: 'qb-v2-restored-manifest-v1', businessSchemaVersion: APP_DATA_DB_SCHEMA_VERSION, stores };
  return { manifest, contentDigest: await canonicalDigest(manifest), recordCount: stores.reduce((sum, row) => sum + row.recordCount, 0) };
}
export async function validateSnapshot(snapshot, owner) {
  snapshot = ownSnapshot(snapshot);
  if (Object.keys(snapshot).sort().join() !== STORE_NAMES.join()) throw backupError('BACKUP_STORE_SET');
  let bytes = 0, count = 0;
  for (const name of STORE_NAMES) {
    if (!Array.isArray(snapshot[name])) throw backupError('BACKUP_RECORD_INVALID');
    const keys = new Set();
    for (const row of snapshot[name]) {
      validateStoreRecord(name, row);
      const path = APP_DATA_STORES[name].keyPath;
      const key = JSON.stringify(Array.isArray(path) ? path.map(field => row[field]) : row[path]);
      if (keys.has(key)) throw backupError('BACKUP_DUPLICATE_RECORD'); keys.add(key);
      bytes += name === 'content_chunks' ? row.bytes.byteLength : canonicalBytes(row).byteLength;
      if (++count > LIMITS.records || bytes > LIMITS.expandedBytes) throw backupError('BACKUP_BUDGET_EXCEEDED');
    }
  }
  const mutationIds = new Set(), tuples = new Set();
  for (const mutation of snapshot.mutations) {
    if (owner.ownerKind === 'account' ? mutation.accountGeneration !== owner.accountGeneration : mutation.accountGeneration !== undefined) throw backupError('BACKUP_OWNER_MISMATCH');
    const { protocolVersion, mutationId, clientStreamId, clientSeq, kind, entityKey, payload, payloadDigest } = mutation;
    if (!await verifyMutationDigest({ protocolVersion, mutationId, clientStreamId, clientSeq, kind, entityKey, payload, payloadDigest })) throw backupError('BACKUP_MUTATION_DIGEST');
    const tuple = `${mutation.clientStreamId}:${mutation.clientSeq}`;
    if (tuples.has(tuple)) throw backupError('BACKUP_SEQUENCE_CONFLICT'); tuples.add(tuple); mutationIds.add(mutation.mutationId);
  }
  if (snapshot.outbox.some(row => !mutationIds.has(row.mutationId))) throw backupError('BACKUP_OUTBOX_DEPENDENCY');
  const chunks = new Map(snapshot.content_chunks.map(row => [`${row.contentDigest}:${row.chunkIndex}`, row.bytes]));
  async function content(reference, decode = true) {
    const raw = chunks.get(`${reference.manifestDigest}:0`);
    if (!raw || await sha256Hex(raw) !== reference.manifestDigest) throw backupError('BACKUP_CONTENT_MISSING');
    const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); validateChunkManifest(manifest);
    if (manifest.contentDigest !== reference.contentDigest || manifest.chunkCount !== reference.chunkCount || manifest.totalBytes !== reference.totalBytes) throw backupError('BACKUP_CONTENT_DIGEST');
    const payload = new Uint8Array(reference.totalBytes); let offset = 0;
    for (const item of manifest.chunks) {
      const chunk = chunks.get(`${reference.contentDigest}:${item.chunkIndex}`);
      if (!chunk || chunk.byteLength !== item.byteLength || await sha256Hex(chunk) !== item.sha256) throw backupError('BACKUP_CONTENT_DIGEST');
      payload.set(chunk, offset); offset += chunk.byteLength;
    }
    if (await sha256Hex(payload) !== reference.contentDigest) throw backupError('BACKUP_CONTENT_DIGEST');
    return { reference, manifest, value: decode ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload)) : undefined };
  }
  const learningReferences=[...snapshot.mutations];
  for(const receipt of snapshot.import_receipts)if(receipt.provenance?.format==='qb-sync-change-v1'){
    const verified=await validateSyncChangeReceipt(receipt);
    if(owner.ownerKind!=='account'||verified.provenance.generation!==owner.accountGeneration)throw backupError('BACKUP_OWNER_MISMATCH');
    learningReferences.push(verified.provenance.change);
  }
  for(const receipt of snapshot.import_receipts)if(receipt.provenance?.format==='qb-cloud-receipt-v1'){
    if(owner.ownerKind!=='account')throw backupError('BACKUP_OWNER_MISMATCH');
    const p=receipt.provenance,change=learningReferences.find(row=>row.serverSeq===p.receipt?.serverSeq&&row.accountGeneration===owner.accountGeneration);
    if(p.receipt?.status!=='conflict'&&!change)throw backupError('BACKUP_CLOUD_RECEIPT_DEPENDENCY');
    await validateCloudReceipt(receipt,{generation:owner.accountGeneration,logEpoch:p.logEpoch,change});
  }
  if(snapshot.migration_journal.some(row=>row.checkpoint?.format==='qb-cloud-recovery-stage-v1')||snapshot.import_receipts.some(row=>['qb-cloud-stage-page-v1','qb-cloud-stage-index-v1','qb-final-proof-index-v1','qb-final-proof-part-v1','qb-final-proof-reservation-v1'].includes(row.provenance?.format)||row.sourceId.startsWith('qb-cloud-stage-index:')&&isUuid(row.sourceId.slice('qb-cloud-stage-index:'.length))))throw backupError('BACKUP_UNFINISHED_CLOUD_STAGE');
  const resolvedStarOrigins=new Set();
  for(const receipt of snapshot.import_receipts.filter(row=>row.provenance?.format==='qb-star-conflict-resolution-v1')){
    const p=(await validateStarResolutionReceipt(receipt)).provenance;
    if(owner.ownerKind!=='account'||p.generation!==owner.accountGeneration)throw backupError('BACKUP_OWNER_MISMATCH');
    const original=snapshot.mutations.find(row=>row.mutationId===p.originalMutation.mutationId),created=snapshot.mutations.find(row=>row.mutationId===p.newMutationId),conflict=snapshot.conflicts.find(row=>row.conflictId===p.conflictId);
    if(!created||created.clientStreamId!==p.originalMutation.clientStreamId||created.clientSeq<=p.originalMutation.clientSeq)throw backupError('BACKUP_STAR_RESOLUTION_ORIGIN');
    if(!original||!created||!conflict||conflict.status!=='resolved'||snapshot.outbox.some(row=>row.mutationId===p.originalMutation.mutationId)||!equal(conflict.mutation,p.originalMutation)||created.kind!=='user_state'||created.entityKey!==p.originalMutation.entityKey||created.payload.baseRevision!==p.sourceChange.serverRevision||created.payload.value!==(p.choice==='local'?p.originalMutation.payload.value:p.sourceChange.payload.value))throw backupError('BACKUP_STAR_RESOLUTION_ORIGIN');
    const {protocolVersion,mutationId,clientStreamId,clientSeq,kind,entityKey,payload,payloadDigest}=original;
    if(!equal({protocolVersion,mutationId,clientStreamId,clientSeq,kind,entityKey,payload,payloadDigest},p.originalMutation))throw backupError('BACKUP_STAR_RESOLUTION_ORIGIN');
    resolvedStarOrigins.add(p.conflictId);
  }
  for(const receipt of snapshot.import_receipts.filter(row=>row.provenance?.format===STAR_GROUP_FORMAT||row.sourceId===STAR_GROUP_FORMAT)){
    let p;try{p=(await validateStarGroupResolutionReceipt(receipt)).provenance;}catch{throw backupError('BACKUP_STAR_GROUP_RESOLUTION_ORIGIN');}
    if(!equal(p.group.owner,owner))throw backupError('BACKUP_OWNER_MISMATCH');
    const created=snapshot.mutations.find(row=>row.mutationId===p.newMutationId);
    if(!created||created.accountGeneration!==owner.accountGeneration||created.clientStreamId!==p.group.streamRow.value||created.clientSeq!==p.group.seqRow.value+1||created.kind!=='user_state'||created.entityKey!==p.group.entityKey||created.payload.baseRevision!==p.sourceChange.serverRevision||created.payload.value!==(p.choice==='local'?p.group.localState.value:p.sourceChange.payload.value))throw backupError('BACKUP_STAR_GROUP_RESOLUTION_ORIGIN');
    for(const member of p.group.members){const original=snapshot.mutations.find(row=>row.mutationId===member.originalMutation.mutationId),conflict=snapshot.conflicts.find(row=>row.conflictId===member.originalMutation.mutationId)||null;if(!original||!equal(original,member.originalRecord)||snapshot.outbox.some(row=>row.mutationId===member.originalMutation.mutationId)||!equal(conflict,member.conflict?{...member.conflict,status:'resolved'}:null))throw backupError('BACKUP_STAR_GROUP_RESOLUTION_ORIGIN');if(member.conflict)resolvedStarOrigins.add(member.conflict.conflictId);}
  }
  if(snapshot.conflicts.some(row=>row.status==='resolved'&&row.mutation.kind==='user_state'&&row.mutation.payload.field==='starred'&&!resolvedStarOrigins.has(row.conflictId)))throw backupError('BACKUP_STAR_RESOLUTION_AUDIT_MISSING');
  const references = learningReferences.filter(row => row.kind === 'content_manifest').map(row => row.payload.reference);
  for (const reference of references) await content(reference, false);
  for (const mutation of learningReferences.filter(row => row.kind === 'attempt_scope')) await content(mutation.payload.reference);
  const snapshotChanges = learningReferences.filter(row => row.kind === 'history_snapshot');
  const snapshotById = new Map();
  for (const row of snapshotChanges) {
    const id = row.payload?.snapshotId, prior = snapshotById.get(id);
    if (prior && (!equal(prior.payload, row.payload) || prior.entityKey !== row.entityKey)) throw backupError('BACKUP_HISTORY_SNAPSHOT_CONFLICT');
    if (!prior) snapshotById.set(id, row);
  }
  if (snapshotChanges.length && owner.ownerKind !== 'account') throw backupError('BACKUP_OWNER_MISMATCH');
  for (const mutation of snapshotChanges) {
    const payload = validateHistorySnapshotPayload(mutation.payload);
    if (mutation.entityKey !== `history_snapshot:${payload.snapshotId}` || payload.accountGeneration !== owner.accountGeneration) throw backupError('BACKUP_OWNER_MISMATCH');
    const decoded = await content(payload.reference);
    await validateHistorySnapshotBinding(payload, decoded.value, { accountGeneration: owner.accountGeneration });
    const stored = snapshot.history_snapshots.find(row => row.snapshotId === payload.snapshotId);
    const retired = snapshot.entity_tombstones.some(row => row.entityKind === 'history_snapshot' && row.entityId === payload.snapshotId && row.status === 'confirmed');
    if (stored && !equal(stored, payload) || !stored && !retired) throw backupError('BACKUP_HISTORY_SNAPSHOT_DEPENDENCY');
  }
  for (const stored of snapshot.history_snapshots) {
    if (owner.ownerKind !== 'account' || stored.accountGeneration !== owner.accountGeneration) throw backupError('BACKUP_OWNER_MISMATCH');
    const mutation = snapshotById.get(stored.snapshotId);
    if (!mutation || mutation.entityKey !== `history_snapshot:${stored.snapshotId}` || !equal(mutation.payload, stored)) throw backupError('BACKUP_HISTORY_SNAPSHOT_DEPENDENCY');
  }
  const bankChanges = learningReferences.filter(row => row.kind === 'bank_revision' || row.kind === 'content_manifest');
  const resolvedBanks = new Map();
  const resolveBank = async (bankUid, revision) => {
    const key = `${bankUid}@${revision}`;
    if (!resolvedBanks.has(key)) {
      const resolved = await resolveImmutableBank({
        bankUid,
        bankRevision: revision,
        readBankRevision: async (uid, rev) => snapshot.bank_revisions.find(row => row.bankUid === uid && row.revision === rev) || null,
        sourceChanges: async (uid, rev) => bankChanges.filter(row => row.kind === 'bank_revision'
          ? row.payload?.bankUid === uid && row.payload?.revision === rev
          : row.payload?.reference?.contentDigest === rev),
        readContent: async reference => content(reference),
      });
      resolvedBanks.set(key, resolved);
    }
    return resolvedBanks.get(key);
  };
  for (const bank of snapshot.bank_revisions) {
    try { await resolveBank(bank.bankUid, bank.revision); }
    catch (cause) { throw backupError(cause?.code === 'HISTORY_BANK_CONTENT_REFERENCE' || cause?.code === 'HISTORY_BANK_SOURCE_MISSING' ? 'BACKUP_CONTENT_MISSING' : 'BACKUP_BANK_BINDING'); }
  }
  for (const mutation of snapshotById.values()) {
    const body = (await content(mutation.payload.reference)).value;
    for (const entry of body.scope) for (const ref of entry.equivalentSourceRefs) {
      const [bankUid] = ref.questionKey.split('/'); let resolved;
      try { resolved = await resolveBank(bankUid, ref.bankRevision); }
      catch { throw backupError('BACKUP_HISTORY_SNAPSHOT_BANK_MISSING'); }
      if (!resolved || !resolved.questionRefs.some(question => question.questionKey === ref.questionKey && question.questionRevision === ref.questionRevision)) throw backupError('BACKUP_HISTORY_SNAPSHOT_QUESTION_MISSING');
    }
  }
  const attemptIds = new Set(snapshot.attempts.map(row => row.attemptId));
  const readSnapshotBaseline=createSnapshotBaselineReader({owner,references:learningReferences,
    readSnapshotRecord:async id=>snapshot.history_snapshots.find(row=>row.snapshotId===id),
    readTombstone:async key=>snapshot.entity_tombstones.find(row=>row.entityKey===key),
    readBankRevision:async(uid,revision)=>snapshot.bank_revisions.find(row=>row.bankUid===uid&&row.revision===revision),readContent:content});
  async function historicalProof(contentDigest){return loadHistoricalResumeProof({references:learningReferences,attempts:snapshot.attempts,events:snapshot.answer_events,contentDigest,readSnapshotBaseline,readResumeContent:async payload=>{
    const raw=chunks.get(`${payload.chunkManifestDigest}:0`);if(!raw)throw backupError('BACKUP_CONTENT_MISSING');
    const manifest=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));validateChunkManifest(manifest);
    return content({contentDigest:payload.contentDigest,manifestDigest:payload.chunkManifestDigest,chunkCount:manifest.chunkCount,totalBytes:manifest.totalBytes});
  }});}
  for(const receipt of snapshot.import_receipts.filter(row=>row.provenance?.format==='qb-fork-origin-v1')){
    const p=validateForkOriginReceipt(receipt).provenance,original=snapshot.mutations.find(row=>row.mutationId===p.commandId),resumeId=await derivedId(p.commandId,'resume'),resume=snapshot.mutations.find(row=>row.mutationId===resumeId);
    if(!original||original.kind!=='attempt_manifest'||original.payload.attemptId!==p.childAttemptId||original.payload.parentAttemptId!==p.parentAttemptId||!resume||resume.kind!=='resume_state'||resume.payload.attemptId!==p.childAttemptId||resume.payload.localRevision!==1)throw backupError('BACKUP_FORK_ORIGIN');
    const child=await historicalProof(resume.payload.contentDigest),parent=await historicalProof(p.parentResumeContentDigest);
    try{assertForkOriginProof(p,original.payload,child,parent);}catch(error){throw backupError('BACKUP_FORK_ORIGIN');}
  }
  if ([...snapshot.attempt_scope, ...snapshot.drafts, ...snapshot.answer_events].some(row => !attemptIds.has(row.attemptId))) throw backupError('BACKUP_ATTEMPT_DEPENDENCY');
  for (const attempt of snapshot.attempts) {
    const bundle = validateBundle({ attempt, scope: snapshot.attempt_scope.filter(row => row.attemptId === attempt.attemptId).sort((a, b) => a.ordinal - b.ordinal), drafts: snapshot.drafts.filter(row => row.attemptId === attempt.attemptId), events: snapshot.answer_events.filter(row => row.attemptId === attempt.attemptId) });
    if (await sha256Hex(canonicalContentBytes(bundle.scope)) !== attempt.scopeDigest) throw backupError('BACKUP_SCOPE_DIGEST');
    const mutation = learningReferences.filter(row => row.kind === 'resume_state' && row.payload.attemptId === attempt.attemptId && row.payload.localRevision === attempt.localRevision).at(-1);
    if (!mutation) throw backupError('BACKUP_RESUME_MISSING');
    const raw = chunks.get(`${mutation.payload.chunkManifestDigest}:0`);
    if (!raw) throw backupError('BACKUP_CONTENT_MISSING');
    const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    const ref = { contentDigest: mutation.payload.contentDigest, manifestDigest: mutation.payload.chunkManifestDigest, chunkCount: manifest.chunkCount, totalBytes: manifest.totalBytes };
    const decoded = await content(ref);
    const { attemptId, writerStreamId, scopeDigest, scopeCount, parentAttemptId } = attempt;
    const proof=await historicalProof(mutation.payload.contentDigest);
    const verification = await validateResumeDependencies(decoded.value, mutation.payload, decoded.manifest, bundle.events, { attemptId, writerStreamId, scopeDigest, scopeCount, ...(parentAttemptId ? { parentAttemptId } : {}) },{parents:proof.parents,snapshotProofs:proof.snapshotProofs});
    if (verification.status !== 'payload_verified') throw backupError('BACKUP_RESUME_DEPENDENCY');
    if(decoded.value.snapshotBaseline){const baseline=decoded.value.snapshotBaseline;for(const receipt of snapshot.import_receipts.filter(row=>row.sourceId==='qb-snapshot-continuation-receipt-v1'&&(row.sourceRecordId===baseline.continuationKey||row.provenance?.attemptId===attemptId)))await assertSnapshotContinuationReceipt(receipt,baseline,{attemptId,commandId:await deriveSnapshotContinuationCommandId(baseline.continuationKey)});}

    if (await sha256Hex(canonicalContentBytes(decoded.value)) !== await sha256Hex(canonicalContentBytes(resumeState({...bundle,...(decoded.value.snapshotBaseline?{snapshotBaseline:decoded.value.snapshotBaseline}:{})}, mutation.payload.baseRevision)))) throw backupError('BACKUP_RESUME_FACT_MISMATCH');
  }
  for(const receipt of snapshot.import_receipts.filter(row=>row.sourceId==='qb-snapshot-continuation-receipt-v1')){const id=receipt.provenance.attemptId,attempt=snapshot.attempts.find(row=>row.attemptId===id),current=attempt&&learningReferences.filter(row=>row.kind==='resume_state'&&row.payload.attemptId===id&&row.payload.localRevision===attempt.localRevision).at(-1);if(!current)throw backupError('BACKUP_SNAPSHOT_RECEIPT_DEPENDENCY');const proof=await historicalProof(current.payload.contentDigest);if(!proof.root.state.snapshotBaseline)throw backupError('BACKUP_SNAPSHOT_RECEIPT_DEPENDENCY');await assertSnapshotContinuationReceipt(receipt,proof.root.state.snapshotBaseline,{attemptId:id,commandId:await deriveSnapshotContinuationCommandId(proof.root.state.snapshotBaseline.continuationKey)});}
  return snapshotManifest(snapshot);
}
