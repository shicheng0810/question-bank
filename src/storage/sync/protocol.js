import { canonicalBytes, sha256Hex, validateMutationRecord, validateMutation, validateImportReceiptRecord, validateChangeLogRecord } from '../../domain/app-data/index.js';
import { isUuid, isQuestionKey } from '../../domain/question/index.js';

export const syncError = code => Object.assign(new Error(code), { code });
export function mutationWire(record) {
  validateMutationRecord(record);
  const { protocolVersion, mutationId, clientStreamId, clientSeq, kind, entityKey, payload, payloadDigest } = record;
  return structuredClone(validateMutation({ protocolVersion, mutationId, clientStreamId, clientSeq, kind, entityKey, payload, payloadDigest }));
}
export function validateSyncReceipt(value) {
  canonicalBytes(value); validateImportReceiptRecord(value);
  const p = value.provenance;
  const fields = 'entityKey,format,generation,kind,logEpoch,payloadDigest,serverRevision';
  if (Object.keys(p || {}).sort().join() !== fields || !isUuid(p.generation) || !isUuid(p.logEpoch) || value.sourceId !== `qb-sync-v2:${p.generation}:${p.logEpoch}`) throw syncError('SYNC_RECEIPT_CORRUPT');
  if (p.format !== 'qb-sync-entity-v1' || !['bank_revision', 'attempt_manifest', 'resume_state', 'user_state'].includes(p.kind) || typeof p.entityKey !== 'string' || value.sourceRecordId !== `entity:${p.kind}:${p.entityKey}` || !Number.isSafeInteger(p.serverRevision) || p.serverRevision < 1 || typeof p.payloadDigest !== 'string' || !/^[0-9a-f]{64}$/.test(p.payloadDigest)) throw syncError('SYNC_RECEIPT_CORRUPT');
  const validEntity = p.kind === 'bank_revision' ? p.entityKey.startsWith('bank:') && isUuid(p.entityKey.slice(5)) : p.kind === 'user_state' ? p.entityKey.startsWith('user_state:') && p.entityKey.endsWith(':starred') && isQuestionKey(p.entityKey.slice(11, -8)) : p.entityKey.startsWith('attempt:') && isUuid(p.entityKey.slice(8));
  if (!validEntity) throw syncError('SYNC_RECEIPT_CORRUPT');
  return value;
}
export async function validateSyncChangeReceipt(value) {
  canonicalBytes(value); validateImportReceiptRecord(value);
  const owned=structuredClone(value), p=owned.provenance;
  if(Object.keys(p||{}).sort().join()!=='change,format,generation,logEpoch' || p.format!=='qb-sync-change-v1' || !isUuid(p.generation) || !isUuid(p.logEpoch))throw syncError('SYNC_CHANGE_CORRUPT');
  validateChangeLogRecord(p.change);
  if(p.change.accountGeneration!==p.generation || owned.sourceId!==`qb-sync-v2:${p.generation}:${p.logEpoch}` || owned.sourceRecordId!==`change:${p.change.serverSeq}`)throw syncError('SYNC_CHANGE_CORRUPT');
  const digest=await sha256Hex(canonicalBytes({protocolVersion:2,kind:p.change.kind,entityKey:p.change.entityKey,payload:p.change.payload}));
  if(digest!==p.change.payloadDigest)throw syncError('SYNC_CHANGE_DIGEST');
  return owned;
}
/** A single writer may chain only attempt CAS kinds. Stars/banks use applied
 * server receipts only; no prediction can overwrite another device's state.
 */
export function deriveCasBaseline(state, { owner, kind, entityKey, writerStreamId }) {
  const seqRow = state.meta.find(row => row.key === 'clientSeq');
  const streamRow = state.meta.find(row => row.key === 'clientStreamId');
  if (!seqRow || !streamRow) throw syncError('CORRUPT_META_INIT');
  const epoch = state.meta.find(row => row.key === 'serverLogEpoch')?.value;
  const receipt = state.receipts.find(row => row.sourceId === `qb-sync-v2:${owner.accountGeneration}:${epoch}` && row.sourceRecordId === `entity:${kind}:${entityKey}`);
  if (receipt) validateSyncReceipt(receipt);
  let revision = receipt?.provenance.serverRevision ?? 0;
  const conditions = [{ store: 'meta', key: 'clientSeq', expected: seqRow }, { store: 'meta', key: 'serverLogEpoch', expected: state.meta.find(row => row.key === 'serverLogEpoch') }, { store: 'meta', key: 'appliedPullCursor', expected: state.meta.find(row => row.key === 'appliedPullCursor') }];
  if (owner.ownerKind === 'account' && epoch) conditions.push({ store: 'import_receipts', key: [`qb-sync-v2:${owner.accountGeneration}:${epoch}`, `entity:${kind}:${entityKey}`], expected: receipt });
  if (['attempt_manifest', 'resume_state'].includes(kind)) {
    const pending = new Set(state.outbox.map(row => row.mutationId));
    const conflicts = new Set(state.conflicts.filter(row => row.status === 'open').map(row => row.mutation.mutationId));
    const chain = state.mutations.filter(row => pending.has(row.mutationId) && row.kind === kind && row.entityKey === entityKey).sort((a, b) => a.clientSeq - b.clientSeq);
    for (const row of chain) {
      if (conflicts.has(row.mutationId)) throw syncError('CAS_PREDECESSOR_CONFLICT');
      if (row.clientStreamId !== streamRow.value || row.payload.writerStreamId !== writerStreamId || row.payload.baseRevision !== revision) throw syncError('CAS_CHAIN_UNVERIFIED');
      if (revision === Number.MAX_SAFE_INTEGER) throw syncError('REVISION_EXHAUSTED'); revision++;
      conditions.push({ store: 'outbox', key: row.mutationId, expected: state.outbox.find(item => item.mutationId === row.mutationId) });
    }
  }
  return { baseRevision: revision, conditions };
}
