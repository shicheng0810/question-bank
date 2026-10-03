import {
  canonicalBytes,
  validateBankRevisionRecord,
  validateContentReference,
  validateChangeLogRecord,
  validateMutationRecord,
  verifyMutationDigest,
} from '../../domain/app-data/index.js';
import { validateBankContent, validateProtectedBankEnvelopeV2 } from '../../domain/question/bank-content.js';
import { validateSyncChangeReceipt } from '../sync/protocol.js';
import { frozenPublicBanks } from '../../domain/question/frozen-public-registry.js';

const fail = code => Object.assign(new Error(code), { code, name: 'ImmutableBankResolutionError' });
const same = (a, b) => {
  if (a === undefined || b === undefined) return a === b;
  const left = canonicalBytes(a), right = canonicalBytes(b);
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
};

/**
 * Resolve one immutable bank revision without restoring it into the catalog.
 *
 * `readBankRevision(bankUid, bankRevision)` may return the current native row,
 * or null when that row was retired. `sourceChanges(bankUid, bankRevision)`
 * returns the bounded set of source records for that exact revision. Members
 * may be local mutation records, verified sync-change import receipts, or
 * change-log records already authenticated by the caller. The resolver still
 * checks their shape, identity, content reference, and digest binding.
 *
 * `readContent(reference)` returns either the decoded content or the standard
 * `{ value }` verified-content result. This function is read-only: it never
 * writes bank_revisions, tombstones, or catalog state.
 */
export async function resolveImmutableBank({ bankUid, bankRevision, readBankRevision, sourceChanges, readContent }) {
  if (typeof bankUid !== 'string' || typeof bankRevision !== 'string'
    || typeof readBankRevision !== 'function' || typeof sourceChanges !== 'function'
    || typeof readContent !== 'function') throw fail('HISTORY_BANK_RESOLVER_INPUT');

  const current = await readBankRevision(bankUid, bankRevision);
  let record = null;
  if (current) {
    validateBankRevisionRecord(current);
    if (current.bankUid !== bankUid || current.revision !== bankRevision) throw fail('HISTORY_BANK_BINDING');
    record = current;
  }

  const inputSources = await sourceChanges(bankUid, bankRevision);
  if (!Array.isArray(inputSources)) throw fail('HISTORY_BANK_SOURCE_BUDGET');
  // Callers can expose a broad immutable-source index. Filter before applying
  // the bounded distinct-proof budget, so unrelated records cannot make a
  // valid historical bank unreadable.
  const filteredSources = inputSources.filter(raw => {
    if (!raw || typeof raw !== 'object') return false;
    const change = raw.provenance?.format === 'qb-sync-change-v1' ? raw.provenance.change : raw;
    if (change?.kind === 'bank_revision') return change.payload?.bankUid === bankUid && change.payload?.revision === bankRevision;
    if (change?.kind === 'content_manifest') return change.payload?.reference?.contentDigest === bankRevision;
    return false;
  });
  const exactSources = new Map();
  for (const raw of filteredSources) {
    let key;
    try { key = canonicalBytes(raw).toString(); } catch { throw fail('HISTORY_BANK_SOURCE_INVALID'); }
    if (!exactSources.has(key)) exactSources.set(key, raw);
  }
  const rawSources = [...exactSources.values()];
  let sourceRecord = null;
  const sourceSeen = new Set();
  for (const raw of rawSources) {
    const candidate = await verifiedBankChange(raw);
    if (!candidate || candidate.bankUid !== bankUid || candidate.revision !== bankRevision) continue;
    if (sourceRecord && !same(sourceRecord, candidate)) throw fail('HISTORY_BANK_SOURCE_CONFLICT');
    sourceRecord = candidate;
    sourceSeen.add(new TextDecoder().decode(canonicalBytes(candidate)));
  }
  if (sourceSeen.size > 1) throw fail('HISTORY_BANK_SOURCE_CONFLICT');

  if (!record && !sourceRecord) throw fail('HISTORY_BANK_SOURCE_MISSING');
  if (record && sourceRecord && !same(record, sourceRecord)) throw fail('HISTORY_BANK_SOURCE_CONFLICT');
  record ||= sourceRecord;

  const references = [];
  if (record.contentManifest.kind === 'private_chunks' || record.contentManifest.kind === 'protected_cipher') {
    references.push(record.contentManifest.reference);
  } else if (record.contentManifest.kind === 'public_static') {
    const contentSeen = new Set();
    for (const raw of rawSources) {
      const contentReference = await verifiedContentChange(raw);
      if (contentReference?.contentDigest === record.contentManifest.contentDigest) {
        references.push(contentReference);
        contentSeen.add(new TextDecoder().decode(canonicalBytes(contentReference)));
      }
    }
    if (contentSeen.size > 1) throw fail('HISTORY_BANK_SOURCE_CONFLICT');
    // A normal public bank_revision carries a static manifest, not a chunk
    // reference mutation. Its exact compiled immutable registry record binds
    // the reference that cloud export used to restore verified chunks.
    const known = frozenPublicBanks.find(bank => bank.bankUid === bankUid && bank.revision === bankRevision
      && same(bank.metadata, record.metadata) && same(bank.contentManifest, record.contentManifest));
    if (!references.length && known) references.push(structuredClone(validateContentReference(known.publicContentReference)));
    else if (known && references.some(reference => !same(reference, known.publicContentReference))) throw fail('HISTORY_BANK_SOURCE_CONFLICT');
  }
  const uniqueReferences = [...new Map(references.map(reference => [reference.manifestDigest, reference])).values()];
  if (record.contentManifest.kind === 'unavailable' || uniqueReferences.length !== 1) throw fail('HISTORY_BANK_CONTENT_REFERENCE');
  const reference = uniqueReferences[0];
  if (reference.contentDigest !== bankRevision) throw fail('HISTORY_BANK_BINDING');

  const loaded = await readContent(reference);
  const content = loaded && typeof loaded === 'object' && Object.hasOwn(loaded, 'value') ? loaded.value : loaded;
  let questionRefs, proofClass;
  if (record.contentManifest.kind === 'protected_cipher') {
    const protectedBody = await validateProtectedBankEnvelopeV2(content);
    if (protectedBody.envelope.bankUid !== bankUid || protectedBody.contentDigest !== bankRevision
      || !same(protectedBody.questionRefs, loaded?.questionRefs ?? protectedBody.questionRefs)) throw fail('HISTORY_BANK_BINDING');
    questionRefs = protectedBody.questionRefs;
    proofClass = protectedBody.proofClass;
  } else {
    const verified = await validateBankContent(content);
    if (verified.content.bankUid !== bankUid || verified.contentDigest !== bankRevision
      || !same(verified.content.metadata, record.metadata)) throw fail('HISTORY_BANK_BINDING');
    questionRefs = verified.questionRefs;
    proofClass = 'registered-content-verified';
  }
  return Object.freeze({ record, content, questionRefs, reference, proofClass });
}

async function verifiedBankChange(raw) {
  if (!raw || typeof raw !== 'object') return null;
  let change = null;
  if (raw.provenance?.format === 'qb-sync-change-v1') {
    change = (await validateSyncChangeReceipt(raw)).provenance.change;
  } else if (raw.kind === 'bank_revision' && raw.mutationId) {
    validateMutationRecord(raw);
    if (!await verifyMutationDigest({
      protocolVersion: raw.protocolVersion, mutationId: raw.mutationId,
      clientStreamId: raw.clientStreamId, clientSeq: raw.clientSeq,
      kind: raw.kind, entityKey: raw.entityKey, payload: raw.payload,
      payloadDigest: raw.payloadDigest,
    })) throw fail('HISTORY_BANK_SOURCE_DIGEST');
    change = raw;
  } else if (raw.kind === 'bank_revision' && raw.payloadDigest && raw.payload) {
    validateChangeLogRecord(raw);
    change = raw;
  }
  if (!change || change.kind !== 'bank_revision') return null;
  const payload = change.payload;
  validateBankRevisionRecord({ bankUid: payload.bankUid, revision: payload.revision, metadata: payload.metadata, contentManifest: payload.contentManifest });
  return { bankUid: payload.bankUid, revision: payload.revision, metadata: payload.metadata, contentManifest: payload.contentManifest };
}

async function verifiedContentChange(raw) {
  if (!raw || typeof raw !== 'object') return null;
  let change = null;
  if (raw.provenance?.format === 'qb-sync-change-v1') change = (await validateSyncChangeReceipt(raw)).provenance.change;
  else if (raw.kind === 'content_manifest' && raw.mutationId) {
    validateMutationRecord(raw);
    if (!await verifyMutationDigest({
      protocolVersion: raw.protocolVersion, mutationId: raw.mutationId,
      clientStreamId: raw.clientStreamId, clientSeq: raw.clientSeq,
      kind: raw.kind, entityKey: raw.entityKey, payload: raw.payload,
      payloadDigest: raw.payloadDigest,
    })) throw fail('HISTORY_BANK_SOURCE_DIGEST');
    change = raw;
  } else if (raw.kind === 'content_manifest' && raw.payloadDigest && raw.payload) {
    validateChangeLogRecord(raw);
    change = raw;
  }
  return change?.kind === 'content_manifest' ? change.payload.reference : null;
}
