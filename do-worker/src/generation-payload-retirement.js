// Internal local-candidate primitive. Not wired to a public HTTP route.
// A prepared capability is process-local, SQL-instance-bound and not serializable.
import { canonicalBytes, canonicalContentBytes, sha256Hex } from '../../src/domain/app-data/canonical.js';
import { computeMutationDigest } from '../../src/domain/app-data/mutation-records.js';
import { validateHistorySnapshotBinding, deriveHistorySnapshotId } from '../../src/domain/app-data/history-snapshot-records.js';
import { convertVerifiedHistorySnapshot } from '../../src/domain/app-data/convert-history-snapshot.js';
import { validateBankContent } from '../../src/domain/question/bank-content.js';
import { registerLegacyBank } from '../../src/player/register-legacy-bank.js';
import { dedupeWorkerLegacyQuestionBank } from './legacy-worker-dedupe.js';
import { frozenLegacyPublicScope } from './legacy-public-scope.js';
import { loadAccountPublicRegistry } from './account-public-registry.js';
import { validateCloudCheckpoint } from './account-cloud-checkpoint.js';
import { validateChunkManifest } from '../../src/domain/app-data/content-records.js';

const capabilities = new WeakMap();
const fail = code => { throw Object.assign(new Error(code), { code }); };
const rows = (sql, query, ...args) => sql.exec(query, ...args).toArray();
const tableExists = (sql, table) => rows(sql, "SELECT name FROM sqlite_master WHERE type='table' AND name=?", table).length === 1;
const equal = (a, b) => new TextDecoder().decode(canonicalBytes(a)) === new TextDecoder().decode(canonicalBytes(b));
const hex = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[48][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const sameBytes = (a, b) => {
  const x = new Uint8Array(a), y = new Uint8Array(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
};
const bytesText = value => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(value);

function assertProofJson(value, path = '$') {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') fail(`INVALID_PROOF_FIELD_${path.replace(/[^A-Za-z0-9]/g, '_').slice(-48)}`);
  if (value && typeof value === 'object') {
    if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('INVALID_PROOF_SHAPE');
    for (const [key, child] of Object.entries(value)) assertProofJson(child, `${path}.${key}`);
  }
}

function exactKeys(value, keys) {
  return value && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function validateCommand(command) {
  const keys = ['operationId', 'principal', 'incarnation', 'accountGeneration', 'authorityFence',
    'sealedManifestSha256', 'nativeExportId', 'nativeCheckpointDigest', 'independentRecoveryReceiptSha256'];
  if (!exactKeys(command, keys) || !uuid(command.operationId) || !hex(command.principal) || !hex(command.incarnation)
    || command.principal === command.incarnation || !uuid(command.accountGeneration) || !Number.isSafeInteger(command.authorityFence)
    || command.authorityFence < 0 || !hex(command.sealedManifestSha256) || !uuid(command.nativeExportId)
    || !hex(command.nativeCheckpointDigest) || !hex(command.independentRecoveryReceiptSha256)) fail('INVALID_RETIREMENT_INPUT');
  return structuredClone(command);
}

function binding(sql, command) {
  const owner = rows(sql, 'SELECT principal,incarnation FROM gen05_data_binding WHERE id=1')[0];
  const state = JSON.parse(rows(sql, 'SELECT state_json FROM gen02_generation_state WHERE id=1')[0]?.state_json || 'null');
  const job = rows(sql, 'SELECT * FROM gen05_legacy_migration WHERE id=1')[0];
  if (!owner || owner.principal !== command.principal || owner.incarnation !== command.incarnation
    || state?.generation !== command.accountGeneration || state.status !== 'active') fail('STALE_RETIREMENT_OWNER');
  if (!job || job.principal !== command.principal || job.incarnation !== command.incarnation
    || job.generation !== command.accountGeneration || job.authority_fence !== command.authorityFence
    || job.status !== 'sealed' || job.phase !== 'complete' || job.history_done !== job.history_total
    || job.bank_done !== job.bank_total || JSON.parse(job.receipt_json || 'null')?.manifestSha256 !== command.sealedManifestSha256) fail('SOURCE_NOT_SEALED');
  return { owner, state, job };
}

function readArchiveManifest(sql, job) {
  const descriptors = rows(sql, 'SELECT * FROM gen05_legacy_manifest ORDER BY source_key');
  const histories = descriptors.filter(row => row.section === 'history' && row.part === 'record');
  const banks = descriptors.filter(row => row.section === 'banks' && row.part === 'questions');
  if (descriptors.length > 40 || histories.length !== job.history_total || banks.length !== job.bank_total
    || descriptors.length !== histories.length + banks.length * 2
    || new Set(descriptors.map(row => row.source_key)).size !== descriptors.length
    || descriptors.some(row => row.complete !== 1 || !hex(row.source_sha256) || !Number.isSafeInteger(row.byte_length)
      || row.byte_length < 1 || !Number.isSafeInteger(row.chunk_count) || row.chunk_count < 1
      || !(row.section === 'history' && row.part === 'record' && row.source_key === `history:${row.id}`
        || row.section === 'banks' && row.part === 'meta' && row.source_key === `bank:${row.id}:meta`
        || row.section === 'banks' && row.part === 'questions' && row.source_key === `bank:${row.id}:questions`))) fail('SOURCE_MANIFEST_MISMATCH');
  if (new Set(banks.map(row => row.id)).size !== banks.length) fail('SOURCE_MANIFEST_MISMATCH');
  const bankIds = new Set(banks.map(row => row.id));
  const metaRows = descriptors.filter(row => row.section === 'banks' && row.part === 'meta');
  if (metaRows.length !== banks.length || new Set(metaRows.map(row => row.id)).size !== metaRows.length
    || metaRows.some(row => !bankIds.has(row.id))) fail('SOURCE_MANIFEST_MISMATCH');
  const manifest = descriptors.map(row => ({ sourceKey: row.source_key, section: row.section, id: row.id,
    part: row.part, sourceSha256: row.source_sha256, byteLength: row.byte_length,
    chunkCount: row.chunk_count, metadata: JSON.parse(row.meta_json) }));
  return { descriptors, manifest };
}

// Async digest checks are deliberately kept out of SQL transactions.
async function readSource(sql, descriptor, capturedManifest) {
  const chunks = rows(sql, 'SELECT chunk_index,chunk_sha256,data FROM gen05_legacy_chunk WHERE source_key=? ORDER BY chunk_index', descriptor.source_key);
  if (chunks.length !== descriptor.chunk_count || descriptor.byte_length > (descriptor.section === 'history' ? 409600 : descriptor.part === 'meta' ? 262144 : 1900000)) fail('SOURCE_BYTES_MISMATCH');
  const sourceBytes = new Uint8Array(descriptor.byte_length); let offset = 0;
  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index], data = new Uint8Array(chunk.data);
    if (chunk.chunk_index !== index || await sha256Hex(data) !== chunk.chunk_sha256 || offset + data.length > sourceBytes.length) fail('SOURCE_BYTES_MISMATCH');
    sourceBytes.set(data, offset); offset += data.length;
  }
  if (offset !== sourceBytes.length || await sha256Hex(sourceBytes) !== descriptor.source_sha256) fail('SOURCE_BYTES_MISMATCH');
  let value; try { value = JSON.parse(bytesText(sourceBytes)); } catch { fail('SOURCE_BYTES_INVALID'); }
  return { descriptor, chunks, sourceBytes, value };
}

async function acceptedReceipt(sql, kind, key, generation, captures) {
  const entity = rows(sql, 'SELECT * FROM gen06_entities WHERE kind=? AND entity_key=?', kind, key)[0];
  if (!entity) fail('NATIVE_ACCEPTANCE_MISSING');
  const changeRow = rows(sql, 'SELECT record_json FROM gen06_change_log WHERE server_seq=?', entity.server_seq)[0];
  const receipts = rows(sql, 'SELECT receipt_json,mutation_json,digest FROM gen06_mutation_receipts WHERE digest=? AND json_extract(receipt_json,\'$.serverSeq\')=?', entity.digest, entity.server_seq);
  captures.push({ kind, key, entity, change: changeRow, receipts });
  let change; try { change = JSON.parse(changeRow?.record_json || 'null'); } catch { change = null; }
  if (!change || change.kind !== kind || change.entityKey !== key || change.accountGeneration !== generation
    || change.payloadDigest !== entity.digest) fail('NATIVE_ACCEPTANCE_MISSING');
  let payload; try { payload = JSON.parse(entity.payload_json); } catch { fail('NATIVE_ACCEPTANCE_MISSING'); }
  if (kind === 'bank_revision') {
    const proof = captures[captures.length - 1];
    proof.bankRevision = rows(sql, 'SELECT * FROM gen06_bank_revisions WHERE bank_uid=? AND revision=?', payload.bankUid, payload.revision)[0];
    if (!proof.bankRevision || JSON.parse(proof.bankRevision.record_json).bankUid !== payload.bankUid) fail('NATIVE_ACCEPTANCE_MISSING');
  }
  if (!equal(change.payload, payload)) fail('NATIVE_ACCEPTANCE_MISSING');
  let accepted = false;
  for (const row of receipts) {
    let receipt, mutation; try { receipt = JSON.parse(row.receipt_json); mutation = JSON.parse(row.mutation_json || 'null'); } catch { continue; }
    if (receipt?.status === 'accepted' && receipt.payloadDigest === entity.digest && mutation?.kind === kind
      && mutation.entityKey === key && equal(mutation.payload, payload) && await computeMutationDigest(mutation) === entity.digest) accepted = true;
  }
  if (!accepted) fail('NATIVE_ACCEPTANCE_MISSING');
  return { entity, payload };
}

async function readContent(sql, reference, proof) {
  const cached = proof.get(reference.contentDigest);
  if (cached) {
    if (!equal(cached.reference, reference) || !cached.value) fail('NATIVE_CONTENT_NOT_PROVEN');
    return cached.value;
  }
  const manifestRows = rows(sql, 'SELECT * FROM gen06_content_manifests WHERE content_digest=?', reference.contentDigest);
  const chunkRows = rows(sql, 'SELECT * FROM gen06_content_chunks WHERE content_digest=? ORDER BY chunk_index', reference.contentDigest);
  if (manifestRows.length !== 1 || reference.totalBytes > 3 * 1024 * 1024) fail('NATIVE_CONTENT_NOT_PROVEN');
  let manifest;
  try { manifest = validateChunkManifest(JSON.parse(manifestRows[0].manifest_json)); } catch { fail('NATIVE_CONTENT_NOT_PROVEN'); }
  if (manifestRows[0].manifest_digest !== reference.manifestDigest || manifest.contentDigest !== reference.contentDigest
    || manifest.totalBytes !== reference.totalBytes || manifest.chunkCount !== reference.chunkCount
    || await sha256Hex(canonicalBytes(manifest)) !== reference.manifestDigest || chunkRows.length !== manifest.chunks.length) fail('NATIVE_CONTENT_NOT_PROVEN');
  const data = new Uint8Array(reference.totalBytes); let offset = 0;
  for (let index = 0; index < manifest.chunks.length; index++) {
    const expected = manifest.chunks[index], chunk = chunkRows[index], chunkBytes = new Uint8Array(chunk.bytes);
    if (chunk.chunk_index !== index || chunk.byte_length !== expected.byteLength || chunk.chunk_digest !== expected.sha256
      || chunkBytes.byteLength !== expected.byteLength || await sha256Hex(chunkBytes) !== expected.sha256
      || offset + chunkBytes.length > data.length) fail('NATIVE_CONTENT_NOT_PROVEN');
    data.set(chunkBytes, offset); offset += chunkBytes.length;
  }
  if (offset !== data.length || await sha256Hex(data) !== reference.contentDigest) fail('NATIVE_CONTENT_NOT_PROVEN');
  let value; try { value = JSON.parse(bytesText(data)); } catch { fail('NATIVE_CONTENT_NOT_PROVEN'); }
  if (await sha256Hex(canonicalContentBytes(value)) !== reference.contentDigest) fail('NATIVE_CONTENT_NOT_PROVEN');
  proof.set(reference.contentDigest, { manifestRows, chunkRows, reference: structuredClone(reference), value });
  return value;
}

function readRetirementCheckpoint(sql, command) {
  const exported = rows(sql, 'SELECT * FROM gen06_exports WHERE export_id=?', command.nativeExportId)[0];
  if (!exported || exported.generation !== command.accountGeneration || exported.expires_at <= Date.now()
    || exported.checkpoint_digest !== command.nativeCheckpointDigest || !exported.checkpoint_json) fail('NATIVE_CHECKPOINT_NOT_PROVEN');
  let checkpoint;
  try { checkpoint = validateCloudCheckpoint(JSON.parse(exported.checkpoint_json)); } catch { fail('NATIVE_CHECKPOINT_NOT_PROVEN'); }
  if (!checkpoint.complete || checkpoint.generation !== command.accountGeneration || checkpoint.exportId !== command.nativeExportId
    || checkpoint.cut !== exported.export_cut || checkpoint.cut == null) fail('NATIVE_CHECKPOINT_NOT_PROVEN');
  return { exported, checkpoint };
}

function readRetiredDescriptors(sql, originalManifest) {
  const descriptors = rows(sql, 'SELECT * FROM gen05_legacy_manifest ORDER BY source_key');
  const expected = new Map(originalManifest.map(row => [row.sourceKey, row]));
  if (!descriptors.length || descriptors.length !== originalManifest.length) fail('RETIREMENT_DRIFT');
  for (const row of descriptors) {
    const proof = expected.get(row.source_key);
    if (!proof || row.section !== proof.section || row.id !== proof.id || row.part !== proof.part
      || row.source_sha256 !== proof.sourceSha256 || row.byte_length !== proof.byteLength || row.chunk_count !== proof.chunkCount
      || row.complete !== 1 || !equal(JSON.parse(row.meta_json), safeSourceMeta({ source_key: row.source_key,
        source_sha256: row.source_sha256, byte_length: row.byte_length, chunk_count: row.chunk_count }))) fail('RETIREMENT_DRIFT');
    if (rows(sql, 'SELECT 1 FROM gen05_legacy_chunk WHERE source_key=? LIMIT 1', row.source_key).length) fail('RETIREMENT_DRIFT');
  }
  return descriptors;
}

async function prepareCompletedRetry(sql, command, owner, journal) {
  if (journal.operation_id !== command.operationId || journal.command_json !== JSON.stringify(command) || journal.status !== 'complete') fail('RETIREMENT_CONFLICT');
  let proof; try { proof = JSON.parse(journal.proof_json); } catch { fail('RETIREMENT_CONFLICT'); }
  if (!proof || !Array.isArray(proof.manifest) || !Array.isArray(proof.sourceProofs) || !Array.isArray(proof.nativeEntities)
    || await sha256Hex(canonicalContentBytes(proof.manifest)) !== command.sealedManifestSha256
    || proof.nativeExportId !== command.nativeExportId || proof.nativeCheckpointDigest !== command.nativeCheckpointDigest
    || await sha256Hex(canonicalBytes(proof)) !== journal.proof_digest) fail('RETIREMENT_CONFLICT');
  const descriptors = readRetiredDescriptors(sql, proof.manifest);
  if (proof.sourceProofs.length !== descriptors.length || new Set(proof.sourceProofs.map(row => row.sourceKey)).size !== descriptors.length
    || descriptors.some(row => !proof.sourceProofs.some(item => item.sourceKey === row.source_key && item.sourceSha256 === row.source_sha256))) fail('RETIREMENT_CONFLICT');
  const { exported, checkpoint } = readRetirementCheckpoint(sql, command);
  const acceptedProofs = [], native = [], contentProof = new Map(), registry = loadAccountPublicRegistry({});
  for (const expected of proof.nativeEntities) {
    const result = await acceptedReceipt(sql, expected.kind, expected.key, command.accountGeneration, acceptedProofs);
    if (result.entity.digest !== expected.digest) fail('RETIREMENT_DRIFT');
    native.push({ kind: expected.kind, key: expected.key });
    if (expected.kind === 'history_snapshot') {
      const payload = result.payload, body = await readContent(sql, payload.reference, contentProof);
      await validateHistorySnapshotBinding(payload, body, { accountGeneration: command.accountGeneration });
    } else if (expected.kind === 'bank_revision') {
      const reference = result.payload.contentManifest;
      if (reference.kind === 'private_chunks') {
        const body = await readContent(sql, reference.reference, contentProof);
        await validateBankContent(body);
      } else if (reference.kind === 'public_static') {
        const item = registry.get(`${result.payload.bankUid}:${result.payload.revision}`);
        const { schemaVersion, baseRevision, ...record } = result.payload;
        if (!item || schemaVersion !== 1 || baseRevision !== 0 || !equal(record, item.record)) fail('NATIVE_PUBLIC_BANK_MISMATCH');
      } else fail('NATIVE_CONTENT_NOT_PROVEN');
    }
    const sequence = BigInt(result.entity.server_seq);
    if (sequence > BigInt(checkpoint.cut)) fail('NATIVE_CHECKPOINT_NOT_PROVEN');
  }
  const afterOwner = binding(sql, command);
  if (!equal(owner, afterOwner)) fail('RETIREMENT_DRIFT');
  const nativeSnapshots = new Map(), changeSnapshots = new Map(), receiptSnapshots = new Map();
  for (const item of acceptedProofs) {
    nativeSnapshots.set(`${item.kind}:${item.key}`, item.entity);
    if (item.change) changeSnapshots.set(item.entity.server_seq, { server_seq: item.entity.server_seq, ...item.change });
    receiptSnapshots.set(`${item.entity.digest}:${item.entity.server_seq}`, { digest: item.entity.digest,
      serverSeq: item.entity.server_seq, rows: item.receipts });
  }
  const before = { descriptors, chunks: descriptors.map(row => ({ sourceKey: row.source_key, chunks: [] })),
    native: [...nativeSnapshots.values()], changes: [...changeSnapshots.values()], receipts: [...receiptSnapshots.values()],
    bankRevisions: acceptedProofs.filter(item => item.bankRevision).map(item => item.bankRevision),
    content: [...contentProof].map(([digest, item]) => ({ digest, manifest: item.manifestRows, chunks: item.chunkRows })),
    export: exported, journal };
  return { command, owner, descriptors, before, sourceProofs: proof.sourceProofs,
    proofDigest: journal.proof_digest, duplicateFresh: true };
}

function safeSourceMeta(descriptor) {
  return { schemaVersion: 1, retired: true, sourceKey: descriptor.source_key,
    sourceSha256: descriptor.source_sha256, byteLength: descriptor.byte_length, chunkCount: descriptor.chunk_count };
}

function sourceKeyRows(sql, descriptors) {
  return descriptors.map(row => ({ sourceKey: row.source_key,
    chunks: rows(sql, 'SELECT chunk_index,chunk_sha256,data FROM gen05_legacy_chunk WHERE source_key=? ORDER BY chunk_index', row.source_key) }));
}

function byteRowsEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((row, index) => Object.keys(row).every(key => {
    const left = row[key], right = b[index]?.[key];
    if (left instanceof ArrayBuffer || ArrayBuffer.isView(left)) return right != null && sameBytes(left, right);
    return left === right;
  }));
}

function sourceChunksFrom(sources) {
  return sources.map(source => ({ sourceKey: source.descriptor.source_key, chunks: source.chunks }));
}

function rowsStillEqual(sql, snapshot) {
  const currentDescriptors = rows(sql, 'SELECT * FROM gen05_legacy_manifest ORDER BY source_key');
  if (!byteRowsEqual(currentDescriptors, snapshot.descriptors)) return false;
  for (const { sourceKey, chunks } of snapshot.chunks) if (!byteRowsEqual(rows(sql, 'SELECT chunk_index,chunk_sha256,data FROM gen05_legacy_chunk WHERE source_key=? ORDER BY chunk_index', sourceKey), chunks)) return false;
  for (const row of snapshot.native) if (!row || !byteRowsEqual(rows(sql, 'SELECT * FROM gen06_entities WHERE kind=? AND entity_key=?', row.kind, row.entity_key), [row])) return false;
  for (const row of snapshot.changes) if (!row || !byteRowsEqual(rows(sql, 'SELECT record_json FROM gen06_change_log WHERE server_seq=?', row.server_seq), [row])) return false;
  for (const group of snapshot.receipts) if (!byteRowsEqual(rows(sql, 'SELECT receipt_json,mutation_json,digest FROM gen06_mutation_receipts WHERE digest=? AND json_extract(receipt_json,\'$.serverSeq\')=?', group.digest, group.serverSeq), group.rows)) return false;
  for (const bank of snapshot.bankRevisions) if (!bank || !byteRowsEqual(rows(sql, 'SELECT * FROM gen06_bank_revisions WHERE bank_uid=? AND revision=?', bank.bank_uid, bank.revision), [bank])) return false;
  for (const { digest, manifest, chunks } of snapshot.content) if (!byteRowsEqual(rows(sql, 'SELECT * FROM gen06_content_manifests WHERE content_digest=?', digest), manifest)
    || !byteRowsEqual(rows(sql, 'SELECT * FROM gen06_content_chunks WHERE content_digest=? ORDER BY chunk_index', digest), chunks)) return false;
  if (!byteRowsEqual(rows(sql, 'SELECT * FROM gen06_exports WHERE export_id=?', snapshot.export.export_id), [snapshot.export])) return false;
  if (snapshot.journal && !byteRowsEqual(rows(sql, 'SELECT * FROM gen10_payload_retirement WHERE id=1'), [snapshot.journal])) return false;
  return true;
}

/** Read-only proof preparation. Caller must be the reviewed privileged operator;
 * independentRecoveryReceiptSha256 is a binding, not proof by itself. */
export async function prepareConvertedPayloadRetirement(sql, input) {
  const command = validateCommand(input), beforeOwner = binding(sql, command);
  const journal = tableExists(sql, 'gen10_payload_retirement') ? rows(sql, 'SELECT * FROM gen10_payload_retirement WHERE id=1')[0] || null : null;
  if (journal) {
    if (journal.operation_id !== command.operationId || journal.command_json !== JSON.stringify(command)) fail('RETIREMENT_CONFLICT');
    if (journal.status === 'complete') {
      const plan = await prepareCompletedRetry(sql, command, beforeOwner, journal);
      const token = Object.freeze({ operationId: command.operationId, proofDigest: plan.proofDigest });
      capabilities.set(token, { sql, plan });
      return token;
    }
    fail('RETIREMENT_CONFLICT');
  }
  const { descriptors, manifest } = readArchiveManifest(sql, beforeOwner.job);
  if (await sha256Hex(canonicalContentBytes(manifest)) !== command.sealedManifestSha256) fail('SOURCE_MANIFEST_MISMATCH');
  const sources = [];
  for (const descriptor of descriptors) sources.push(await readSource(sql, descriptor, manifest));
  const byKey = new Map(sources.map(row => [row.descriptor.source_key, row]));
  const contentProof = new Map(), acceptedProofs = [], native = [], sourceProofs = [];
  const verifiedPrivateBanks = new Map();
  const registry = loadAccountPublicRegistry({});
  const bankModels = new Map();
  for (const descriptor of descriptors.filter(row => row.section === 'banks' && row.part === 'questions')) {
    const questionSource = byKey.get(descriptor.source_key), metaSource = byKey.get(`bank:${descriptor.id}:meta`);
    if (!questionSource || !metaSource || !Array.isArray(questionSource.value) || metaSource.value?.id !== descriptor.id) fail('PRIVATE_SOURCE_NOT_PROVEN');
    if (metaSource.value.count !== undefined && metaSource.value.count !== questionSource.value.length) fail('PRIVATE_SOURCE_NOT_PROVEN');
    const registration = await registerLegacyBank(questionSource.value, { accountGeneration: command.accountGeneration,
      recordId: descriptor.id, title: metaSource.value.title,
      legacyArchive: { sourceKey: `bank:${descriptor.id}`, sha256: descriptor.source_sha256, metaSha256: metaSource.descriptor.source_sha256 } });
    const checked = await validateBankContent(registration.content);
    const entity = await acceptedReceipt(sql, 'bank_revision', `bank:${checked.content.bankUid}`, command.accountGeneration, acceptedProofs);
    const storedRecord = { bankUid: entity.payload.bankUid, revision: entity.payload.revision, metadata: entity.payload.metadata, contentManifest: entity.payload.contentManifest };
    if (entity.payload.baseRevision !== 0 || !equal(storedRecord, { bankUid: registration.content.bankUid, revision: checked.contentDigest,
      metadata: registration.content.metadata, contentManifest: entity.payload.contentManifest })) fail('NATIVE_BANK_SEMANTICS_MISMATCH');
    if (entity.payload.contentManifest.kind !== 'private_chunks') fail('NATIVE_CONTENT_NOT_PROVEN');
    const nativeBody = await readContent(sql, entity.payload.contentManifest.reference, contentProof);
    const nativeChecked = await validateBankContent(nativeBody);
    if (nativeChecked.contentDigest !== checked.contentDigest || !equal(nativeBody, registration.content)) fail('NATIVE_BANK_SEMANTICS_MISMATCH');
    const ref = entity.payload.contentManifest.reference;
    verifiedPrivateBanks.set(`${entity.payload.bankUid}:${entity.payload.revision}:${ref.contentDigest}:${ref.manifestDigest}`, nativeBody);
    native.push({ kind: 'bank_revision', key: `bank:${entity.payload.bankUid}`, bankUid: entity.payload.bankUid, revision: entity.payload.revision });
    bankModels.set(descriptor.id, { content: registration.content, record: storedRecord, reference: ref, questions: questionSource, meta: metaSource });
    for (const part of [metaSource, questionSource]) sourceProofs.push({ sourceKey: part.descriptor.source_key,
      sourceSha256: part.descriptor.source_sha256, nativeEntityKey: `bank:${entity.payload.bankUid}`,
      nativePayloadDigest: entity.entity.digest, nativeBodyDigest: checked.contentDigest });
  }
  for (const descriptor of descriptors.filter(row => row.section === 'history' && row.part === 'record')) {
    const source = byKey.get(descriptor.source_key), original = source.value;
    if (original?.id !== descriptor.id || !Array.isArray(original.scope) || !original.score || !original.state) fail('HISTORY_SOURCE_INVALID');
    const candidates = rows(sql, "SELECT entity_key,payload_json,server_seq,digest FROM gen06_entities WHERE kind='history_snapshot' AND json_extract(payload_json,'$.source.namespace')='legacy_account' AND json_extract(payload_json,'$.source.recordId')=?", descriptor.id);
    if (candidates.length !== 1) fail('NATIVE_COVERAGE_NOT_PROVEN');
    const stored = candidates[0], payload = JSON.parse(stored.payload_json);
    const receipt = await acceptedReceipt(sql, 'history_snapshot', stored.entity_key, command.accountGeneration, acceptedProofs);
    const body = await readContent(sql, payload.reference, contentProof);
    await validateHistorySnapshotBinding(payload, body, { accountGeneration: command.accountGeneration });
    if (!equal(receipt.payload, payload) || stored.entity_key !== `history_snapshot:${payload.snapshotId}`) fail('NATIVE_ACCEPTANCE_MISSING');
    let expected;
    if (typeof original.bank_id === 'string' && original.bank_id.startsWith('u-')) {
      const bank = bankModels.get(original.bank_id.slice(2)); if (!bank) fail('PRIVATE_SOURCE_NOT_PROVEN');
      expected = await convertVerifiedHistorySnapshot({ verifiedSource: { rawJson: bytesText(source.sourceBytes), byteLength: source.sourceBytes.length,
        sha256: descriptor.source_sha256, sourceKey: descriptor.source_key },
        source: { namespace: 'legacy_account', deviceNamespace: null, recordId: descriptor.id, digest: descriptor.source_sha256, conversionVersion: 1 },
        accountGeneration: command.accountGeneration, bankContents: [bank.content], legacyDedupe: dedupeWorkerLegacyQuestionBank });
    } else {
      const mapped = frozenLegacyPublicScope(original);
      expected = { schemaVersion: 1, type: 'imported_history_snapshot', snapshotId: await deriveHistorySnapshotId(command.accountGeneration,
        { namespace: 'legacy_account', deviceNamespace: null, recordId: descriptor.id, digest: descriptor.source_sha256, conversionVersion: 1 }),
        accountGeneration: command.accountGeneration,
        source: { namespace: 'legacy_account', deviceNamespace: null, recordId: descriptor.id, digest: descriptor.source_sha256, conversionVersion: 1 },
        recordedAt: original.ts, summary: original.score, scope: mapped.scope,
        answers: Object.entries(original.state).map(([legacyQuestionId, state]) => ({ legacyQuestionId, savedInput: {
          selectedIndex: state.selectedIndex ?? null, selectedSet: state.selectedSet ?? [], fillInputs: state.fillInputs ?? [],
          submitted: state.submitted ?? false, showKeys: state.showKeys ?? false } })) };
      for (const bank of mapped.banks) {
        const registered = registry.get(`${bank.bankUid}:${bank.revision}`);
        if (!registered || registered.record.contentManifest.staticRef !== bank.staticRef) fail('PUBLIC_BANK_BINDING');
        const bankEntity = await acceptedReceipt(sql, 'bank_revision', `bank:${bank.bankUid}`, command.accountGeneration, acceptedProofs);
        const { schemaVersion, baseRevision, ...acceptedBank } = bankEntity.payload;
        if (schemaVersion !== 1 || baseRevision !== 0 || !equal(acceptedBank, registered.record)
          || bankEntity.payload.revision !== bank.revision || bankEntity.payload.contentManifest.staticRef !== bank.staticRef) fail('NATIVE_PUBLIC_BANK_MISMATCH');
        native.push({ kind: 'bank_revision', key: `bank:${bank.bankUid}`, bankUid: bank.bankUid, revision: bank.revision });
      }
      for (const row of mapped.scope) for (const ref of row.equivalentSourceRefs) {
        const registered = registry.get(`${ref.questionKey.split('/')[0]}:${ref.bankRevision}`);
        if (!registered || registered.questions.get(ref.questionKey) !== ref.questionRevision) fail('PUBLIC_BANK_BINDING');
      }
    }
    if (!equal(body, expected)) fail('NATIVE_SOURCE_SEMANTICS_MISMATCH');
    for (const scoped of body.scope) for (const ref of scoped.equivalentSourceRefs) {
      const bankUid = ref.questionKey.split('/')[0];
      const bankAccepted = await acceptedReceipt(sql, 'bank_revision', `bank:${bankUid}`, command.accountGeneration, acceptedProofs);
      const { schemaVersion: bankSchema, baseRevision: bankBase, ...bankRecord } = bankAccepted.payload;
      if (bankSchema !== 1 || bankBase !== 0 || bankRecord.bankUid !== bankUid || bankRecord.revision !== ref.bankRevision) fail('NATIVE_QUESTION_CLOSURE_NOT_PROVEN');
      if (bankRecord.contentManifest.kind === 'private_chunks') {
        const contentRef = bankRecord.contentManifest.reference;
        const cacheKey = `${bankUid}:${ref.bankRevision}:${contentRef.contentDigest}:${contentRef.manifestDigest}`;
        let nativeBank = verifiedPrivateBanks.get(cacheKey);
        if (!nativeBank) {
          nativeBank = await readContent(sql, contentRef, contentProof);
          const checkedBank = await validateBankContent(nativeBank);
          if (checkedBank.contentDigest !== ref.bankRevision || nativeBank.bankUid !== bankUid) fail('NATIVE_QUESTION_CLOSURE_NOT_PROVEN');
          verifiedPrivateBanks.set(cacheKey, nativeBank);
        }
        if (!nativeBank.questions.some(question => question.questionKey === ref.questionKey && question.questionRevision === ref.questionRevision)) fail('NATIVE_QUESTION_CLOSURE_NOT_PROVEN');
      } else if (bankRecord.contentManifest.kind === 'public_static') {
        const publicRecord = registry.get(`${bankUid}:${ref.bankRevision}`);
        if (!publicRecord || !equal(bankRecord, publicRecord.record)
          || publicRecord.questions.get(ref.questionKey) !== ref.questionRevision) fail('NATIVE_QUESTION_CLOSURE_NOT_PROVEN');
      } else fail('NATIVE_QUESTION_CLOSURE_NOT_PROVEN');
      if (!native.some(row => row.kind === 'bank_revision' && row.key === `bank:${bankUid}`)) {
        native.push({ kind: 'bank_revision', key: `bank:${bankUid}` });
      }
    }
    native.push({ kind: 'history_snapshot', key: stored.entity_key });
    sourceProofs.push({ sourceKey: descriptor.source_key, sourceSha256: descriptor.source_sha256,
      nativeEntityKey: stored.entity_key, nativeBodyDigest: payload.reference.contentDigest, nativePayloadDigest: stored.digest });
  }
  const exported = rows(sql, 'SELECT * FROM gen06_exports WHERE export_id=?', command.nativeExportId)[0];
  if (!exported || exported.generation !== command.accountGeneration || exported.expires_at <= Date.now()
    || exported.checkpoint_digest !== command.nativeCheckpointDigest || !exported.checkpoint_json) fail('NATIVE_CHECKPOINT_NOT_PROVEN');
  const checkpoint = validateCloudCheckpoint(JSON.parse(exported.checkpoint_json));
  if (!checkpoint.complete || checkpoint.generation !== command.accountGeneration || checkpoint.exportId !== command.nativeExportId
    || checkpoint.cut !== exported.export_cut || await sha256Hex(canonicalBytes(checkpoint)) !== command.nativeCheckpointDigest) fail('NATIVE_CHECKPOINT_NOT_PROVEN');
  for (const row of native) if (row.kind === 'history_snapshot') {
    const seq = rows(sql, 'SELECT server_seq FROM gen06_entities WHERE kind=? AND entity_key=?', row.kind, row.key)[0]?.server_seq;
    if (seq === undefined || BigInt(seq) > BigInt(checkpoint.cut)) fail('NATIVE_CHECKPOINT_NOT_PROVEN');
  } else if (row.kind === 'bank_revision') {
    const seq = rows(sql, 'SELECT server_seq FROM gen06_entities WHERE kind=? AND entity_key=?', row.kind, row.key)[0]?.server_seq;
    if (seq === undefined || BigInt(seq) > BigInt(checkpoint.cut)) fail('NATIVE_CHECKPOINT_NOT_PROVEN');
  }
  if (sourceProofs.length !== descriptors.length || new Set(sourceProofs.map(row => row.sourceKey)).size !== descriptors.length
    || descriptors.some(row => !sourceProofs.some(proof => proof.sourceKey === row.source_key && proof.sourceSha256 === row.source_sha256))) fail('NATIVE_COVERAGE_NOT_PROVEN');
  const nativeSnapshots = new Map(), changeSnapshots = new Map(), receiptSnapshots = new Map();
  for (const proof of acceptedProofs) {
    nativeSnapshots.set(`${proof.kind}:${proof.key}`, proof.entity);
    if (proof.change) changeSnapshots.set(proof.entity.server_seq, { server_seq: proof.entity.server_seq, ...proof.change });
    receiptSnapshots.set(`${proof.entity.digest}:${proof.entity.server_seq}`, { digest: proof.entity.digest, serverSeq: proof.entity.server_seq, rows: proof.receipts });
  }
  const before = {
    descriptors,
    chunks: sourceChunksFrom(sources),
    native: [...nativeSnapshots.values()],
    changes: [...changeSnapshots.values()],
    receipts: [...receiptSnapshots.values()],
    bankRevisions: acceptedProofs.filter(proof => proof.bankRevision).map(proof => proof.bankRevision),
    content: [...contentProof].map(([digest, proof]) => ({ digest, manifest: proof.manifestRows, chunks: proof.chunkRows })),
    export: exported,
    journal: null,
  };
  const afterOwner = binding(sql, command);
  if (!equal(beforeOwner, afterOwner)) fail('RETIREMENT_DRIFT');
  const nativeEntities = [...nativeSnapshots.values()].map(row => {
    const proof = acceptedProofs.find(item => item.entity === row);
    return { kind: proof.kind, key: proof.key, digest: row.digest };
  }).sort((a, b) => `${a.kind}:${a.key}`.localeCompare(`${b.kind}:${b.key}`));
  const proofData = { command, manifest, sourceProofs, nativeEntities, nativeExportId: command.nativeExportId, nativeCheckpointDigest: command.nativeCheckpointDigest };
  assertProofJson(proofData);
  const plan = { command, owner: beforeOwner, manifest, descriptors, before, sourceProofs,
    proofDigest: await sha256Hex(canonicalBytes(proofData)), proofJson: new TextDecoder().decode(canonicalBytes(proofData)) };
  const token = Object.freeze({ operationId: command.operationId, proofDigest: plan.proofDigest });
  capabilities.set(token, { sql, plan });
  return token;
}

/** Synchronous final CAS/removal. Must be called only within transactionSync. */
export function commitPreparedRetirement(sql, token) {
  const prepared = capabilities.get(token);
  if (!prepared || prepared.sql !== sql) fail('INVALID_RETIREMENT_CAPABILITY');
  const { plan } = prepared;
  const existing = tableExists(sql, 'gen10_payload_retirement') ? rows(sql, 'SELECT * FROM gen10_payload_retirement WHERE id=1')[0] : null;
  if (existing?.status === 'complete') {
    if (!plan.duplicateFresh || existing.operation_id !== plan.command.operationId || existing.proof_digest !== plan.proofDigest
      || !rowsStillEqual(sql, plan.before) || !byteRowsEqual(rows(sql, 'SELECT * FROM gen10_payload_retirement WHERE id=1'), [plan.before.journal])
      || plan.before.export.expires_at <= Date.now()) fail('RETIREMENT_CONFLICT');
    const currentOwner = binding(sql, plan.command);
    if (!equal(currentOwner, plan.owner)) fail('RETIREMENT_DRIFT');
    return { ok: true, status: 'complete', duplicate: true };
  }
  if (!rowsStillEqual(sql, plan.before)) fail('RETIREMENT_DRIFT');
  if (plan.before.export.expires_at <= Date.now()) fail('NATIVE_CHECKPOINT_NOT_PROVEN');
  const owner = rows(sql, 'SELECT principal,incarnation FROM gen05_data_binding WHERE id=1')[0];
  const state = JSON.parse(rows(sql, 'SELECT state_json FROM gen02_generation_state WHERE id=1')[0]?.state_json || 'null');
  const job = rows(sql, 'SELECT * FROM gen05_legacy_migration WHERE id=1')[0];
  if (owner?.principal !== plan.command.principal || owner?.incarnation !== plan.command.incarnation
    || state?.generation !== plan.command.accountGeneration || state.status !== 'active'
    || !job || !byteRowsEqual(rows(sql, 'SELECT * FROM gen05_legacy_migration WHERE id=1'), [plan.owner.job])
    || job.status !== 'sealed' || job.phase !== 'complete' || job.authority_fence !== plan.command.authorityFence
    || job.history_done !== job.history_total || job.bank_done !== job.bank_total
    || JSON.parse(job.receipt_json || 'null')?.manifestSha256 !== plan.command.sealedManifestSha256) fail('RETIREMENT_DRIFT');
  sql.exec('CREATE TABLE IF NOT EXISTS gen10_payload_retirement(id INTEGER PRIMARY KEY CHECK(id=1),operation_id TEXT NOT NULL,command_json TEXT NOT NULL,proof_digest TEXT NOT NULL,proof_json TEXT NOT NULL,status TEXT NOT NULL,source_count INTEGER NOT NULL,native_count INTEGER NOT NULL,completed_at INTEGER NOT NULL)');
  sql.exec('INSERT INTO gen10_payload_retirement(id,operation_id,command_json,proof_digest,proof_json,status,source_count,native_count,completed_at) VALUES(1,?,?,?,?,\'complete\',?,?,?)',
    plan.command.operationId, JSON.stringify(plan.command), plan.proofDigest, plan.proofJson, plan.descriptors.length, plan.sourceProofs.length, Date.now());
  for (const descriptor of plan.descriptors) {
    sql.exec('DELETE FROM gen05_legacy_chunk WHERE source_key=?', descriptor.source_key);
    sql.exec('UPDATE gen05_legacy_manifest SET meta_json=? WHERE source_key=? AND source_sha256=? AND byte_length=? AND chunk_count=?',
      JSON.stringify(safeSourceMeta(descriptor)), descriptor.source_key, descriptor.source_sha256, descriptor.byte_length, descriptor.chunk_count);
  }
  return { ok: true, status: 'complete', duplicate: false };
}
