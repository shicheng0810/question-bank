const SOURCE_ID = 'legacy-account-v1';
const CHUNK_LIMIT = 256 * 1024;
const HISTORY_LIMIT = 10;
const BANK_LIMIT = 15;
const HEX64 = /^[0-9a-f]{64}$/;
const BANK_ID = /^[a-z0-9_][a-z0-9_-]{0,47}$/;

function fail(code) { const error = new Error(code); error.code = code; throw error; }
function rows(sql, statement, ...values) { return sql.exec(statement, ...values).toArray(); }
function exists(sql, table) { return rows(sql, "SELECT name FROM sqlite_master WHERE type='table' AND name=?", table).length > 0; }
function sha256(bytes) { return crypto.subtle.digest('SHA-256', bytes); }
function hex(bytes) { return Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join(''); }

export function ensureLegacyArchiveSchema(sql) {
  sql.exec(`CREATE TABLE IF NOT EXISTS gen05_legacy_migration(
    id INTEGER PRIMARY KEY CHECK(id=1), source_id TEXT NOT NULL, principal TEXT NOT NULL,
    incarnation TEXT NOT NULL, generation TEXT NOT NULL, authority_fence INTEGER NOT NULL,
    freeze_id TEXT NOT NULL, source_kind TEXT NOT NULL, status TEXT NOT NULL,
    phase TEXT NOT NULL, history_total INTEGER NOT NULL, bank_total INTEGER NOT NULL,
    history_done INTEGER NOT NULL, bank_done INTEGER NOT NULL, receipt_json TEXT
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS gen05_legacy_manifest(
    source_key TEXT PRIMARY KEY, section TEXT NOT NULL, id TEXT NOT NULL, part TEXT NOT NULL,
    source_sha256 TEXT NOT NULL, byte_length INTEGER NOT NULL, chunk_count INTEGER NOT NULL,
    meta_json TEXT NOT NULL, complete INTEGER NOT NULL DEFAULT 0,
    UNIQUE(section,id,part)
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS gen05_legacy_chunk(
    source_key TEXT NOT NULL, chunk_index INTEGER NOT NULL, chunk_sha256 TEXT NOT NULL,
    data BLOB NOT NULL, PRIMARY KEY(source_key,chunk_index),
    FOREIGN KEY(source_key) REFERENCES gen05_legacy_manifest(source_key)
  )`);
}

export function clearLegacyArchive(sql) {
  for (const table of ['gen05_legacy_chunk', 'gen05_legacy_manifest', 'gen05_legacy_migration']) {
    if (exists(sql, table)) sql.exec(`DELETE FROM ${table}`);
  }
}

function target(sql, binding, generation) {
  ensureLegacyArchiveSchema(sql);
  const bindingRows = rows(sql, 'SELECT principal,incarnation FROM gen05_data_binding WHERE id=1');
  const stateRows = rows(sql, 'SELECT state_json FROM gen02_generation_state WHERE id=1');
  if (bindingRows.length !== 1 || bindingRows[0].principal !== binding.principal
    || bindingRows[0].incarnation !== binding.incarnation || stateRows.length !== 1) fail('INVALID_CREDENTIALS');
  let state;
  try { state = JSON.parse(stateRows[0].state_json); } catch { fail('INVALID_INPUT'); }
  if (!state || state.status === 'deleted') fail('ACCOUNT_DELETED');
  if (state.status !== 'active' || state.generation !== generation) fail('STALE_GENERATION');
  return state;
}

function readJob(sql) {
  const result = rows(sql, 'SELECT * FROM gen05_legacy_migration WHERE id=1');
  return result[0] || null;
}

function assertJob(job, binding, command) {
  if (!job || job.source_id !== SOURCE_ID || job.principal !== binding.principal
    || job.incarnation !== binding.incarnation || job.generation !== command.generation
    || job.authority_fence !== command.authorityFence || job.freeze_id !== command.freezeId) fail('MIGRATION_UNCERTAIN');
  if (job.status === 'deleted') fail('ACCOUNT_DELETED');
  if (job.status === 'quarantined') fail('MIGRATION_QUARANTINED');
  return job;
}

function assertStaging(sql, binding, command) {
  target(sql, binding, command.generation);
  const job = assertJob(readJob(sql), binding, command);
  if (job.status !== 'staging') fail('MIGRATION_UNCERTAIN');
  return job;
}

export function beginLegacyArchive(sql, binding, command) {
  try {
    target(sql, binding, command?.generation);
    if (!command || typeof command.freezeId !== 'string' || command.freezeId.length < 16 || command.freezeId.length > 128
      || !Number.isSafeInteger(command.authorityFence) || command.authorityFence < 0
      || !['user-store-sqlite', 'edits-kv-unimported'].includes(command.sourceKind)
      || !Number.isSafeInteger(command.historyTotal) || command.historyTotal < 0 || command.historyTotal > HISTORY_LIMIT
      || !Number.isSafeInteger(command.bankTotal) || command.bankTotal < 0 || command.bankTotal > BANK_LIMIT) fail('INVALID_INPUT');
    const previous = readJob(sql);
    if (previous) {
      assertJob(previous, binding, command);
      if (previous.source_kind !== command.sourceKind || previous.history_total !== command.historyTotal
        || previous.bank_total !== command.bankTotal) fail('OPERATION_CONFLICT');
      return { ok: true, status: previous.status, phase: previous.phase, historyDone: previous.history_done, bankDone: previous.bank_done };
    }
    sql.exec(`INSERT INTO gen05_legacy_migration(id,source_id,principal,incarnation,generation,authority_fence,freeze_id,source_kind,status,phase,history_total,bank_total,history_done,bank_done,receipt_json)
      VALUES(1,?,?,?,?,?,?,?,'staging','history',?,?,0,0,NULL)`, SOURCE_ID, binding.principal, binding.incarnation,
    command.generation, command.authorityFence, command.freezeId, command.sourceKind, command.historyTotal, command.bankTotal);
    return { ok: true, status: 'staging', phase: 'history', historyDone: 0, bankDone: 0 };
  } catch (error) { return { ok: false, error: error?.code || 'UNAVAILABLE' }; }
}

export async function recordLegacyNoImport(sql, binding, command) {
  try {
    target(sql, binding, command?.generation);
    if (!command || !Number.isSafeInteger(command.authorityFence) || command.authorityFence < 0
      || !['no-legacy-source', 'orphaned-source', 'retired-re-registration', 'legacy-deleted-re-registration'].includes(command.reason)) fail('INVALID_INPUT');
    const previous = readJob(sql);
    if (previous) {
      if (previous.principal !== binding.principal || previous.incarnation !== binding.incarnation
        || previous.generation !== command.generation) fail('MIGRATION_UNCERTAIN');
      if (previous.source_kind !== 'none' || previous.status !== 'sealed') fail('MIGRATION_UNCERTAIN');
      return { ok: true, status: 'sealed', receipt: JSON.parse(previous.receipt_json) };
    }
    const manifestSha256 = hex(await sha256(canonicalContentBytes([])));
    target(sql, binding, command.generation);
    const receipt = { sourceId: SOURCE_ID, sourceKind: 'none', historyCount: 0, bankCount: 0, manifestSha256, reason: command.reason };
    sql.exec(`INSERT INTO gen05_legacy_migration(id,source_id,principal,incarnation,generation,authority_fence,freeze_id,source_kind,status,phase,history_total,bank_total,history_done,bank_done,receipt_json)
      VALUES(1,?,?,?,?,?,?,'none','sealed','complete',0,0,0,0,?)`, SOURCE_ID, binding.principal, binding.incarnation,
    command.generation, command.authorityFence, `none:${binding.principal}:${binding.incarnation}`, JSON.stringify(receipt));
    return { ok: true, status: 'sealed', receipt };
  } catch (error) { return { ok: false, error: error?.code || 'UNAVAILABLE' }; }
}

export function putLegacyArchiveManifest(sql, binding, command) {
  try {
    target(sql, binding, command?.generation);
    const job = assertJob(readJob(sql), binding, command);
    if (job.status !== 'staging') fail('MIGRATION_UNCERTAIN');
    const m = command.manifest;
    if (!m || !['history', 'banks'].includes(m.section) || typeof m.id !== 'string'
      || m.id.length < 1 || m.id.length > 64 || (m.section === 'banks' && !BANK_ID.test(m.id))
      || typeof m.sourceKey !== 'string' || !HEX64.test(m.sourceSha256)
      || !Number.isSafeInteger(m.byteLength) || m.byteLength < 1 || m.byteLength > 1_900_000
      || !Number.isSafeInteger(m.chunkCount) || m.chunkCount < 1 || m.chunkCount > 8
      || m.chunkCount !== Math.ceil(m.byteLength / CHUNK_LIMIT)
      || !m.metadata || typeof m.metadata !== 'object' || Array.isArray(m.metadata)) fail('MIGRATION_QUARANTINED');
    const expectedSourceKey = m.section === 'history' ? `history:${m.id}` : `bank:${m.id}:${m.part}`;
    if (m.sourceKey !== expectedSourceKey || (m.section === 'history' && m.part !== 'record')
      || (m.section === 'banks' && !['meta', 'questions'].includes(m.part))) fail('MIGRATION_QUARANTINED');
    const existing = rows(sql, 'SELECT * FROM gen05_legacy_manifest WHERE source_key=?', m.sourceKey)[0];
    const metadata = JSON.stringify(m.metadata);
    if (existing) {
      if (existing.section !== m.section || existing.id !== m.id || existing.source_sha256 !== m.sourceSha256
        || existing.byte_length !== m.byteLength || existing.chunk_count !== m.chunkCount || existing.meta_json !== metadata) fail('OPERATION_CONFLICT');
      return { ok: true, existing: true, complete: existing.complete === 1 };
    }
    sql.exec('INSERT INTO gen05_legacy_manifest(source_key,section,id,part,source_sha256,byte_length,chunk_count,meta_json,complete) VALUES(?,?,?,?,?,?,?,?,0)',
      m.sourceKey, m.section, m.id, m.part, m.sourceSha256, m.byteLength, m.chunkCount, metadata);
    return { ok: true, existing: false, complete: false };
  } catch (error) { return { ok: false, error: error?.code || 'UNAVAILABLE' }; }
}

export async function putLegacyArchiveChunk(sql, binding, command) {
  try {
    target(sql, binding, command?.generation);
    const job = assertJob(readJob(sql), binding, command);
    if (job.status !== 'staging') fail('MIGRATION_UNCERTAIN');
    const c = command.chunk;
    if (!c || typeof c.sourceKey !== 'string' || !Number.isSafeInteger(c.index) || c.index < 0
      || !(c.bytes instanceof Uint8Array) || c.bytes.byteLength > CHUNK_LIMIT
      || !HEX64.test(c.sha256) || !HEX64.test(c.chunkSha256)) fail('INVALID_INPUT');
    const manifest = rows(sql, 'SELECT * FROM gen05_legacy_manifest WHERE source_key=?', c.sourceKey)[0];
    if (!manifest || c.index >= manifest.chunk_count) fail('MIGRATION_QUARANTINED');
    const expectedLength = c.index === manifest.chunk_count - 1
      ? manifest.byte_length - CHUNK_LIMIT * c.index : CHUNK_LIMIT;
    if (c.bytes.byteLength !== expectedLength || c.sha256 !== manifest.source_sha256) fail('MIGRATION_QUARANTINED');
    const chunkDigest = hex(await sha256(c.bytes));
    assertStaging(sql, binding, command);
    if (chunkDigest !== c.chunkSha256) fail('MIGRATION_QUARANTINED');
    const existing = rows(sql, 'SELECT chunk_sha256,data FROM gen05_legacy_chunk WHERE source_key=? AND chunk_index=?', c.sourceKey, c.index)[0];
    if (existing) {
      const data = new Uint8Array(existing.data);
      if (existing.chunk_sha256 !== c.chunkSha256 || data.byteLength !== c.bytes.byteLength) fail('OPERATION_CONFLICT');
      const existingDigest = hex(await sha256(data));
      assertStaging(sql, binding, command);
      if (existingDigest !== c.chunkSha256) fail('OPERATION_CONFLICT');
      return { ok: true, existing: true };
    }
    assertStaging(sql, binding, command);
    sql.exec('INSERT INTO gen05_legacy_chunk(source_key,chunk_index,chunk_sha256,data) VALUES(?,?,?,?)', c.sourceKey, c.index, c.chunkSha256, c.bytes);
    return { ok: true, existing: false };
  } catch (error) { return { ok: false, error: error?.code || 'UNAVAILABLE' }; }
}

export async function completeLegacyArchiveRecord(sql, binding, command) {
  try {
    target(sql, binding, command?.generation);
    const job = assertJob(readJob(sql), binding, command);
    if (job.status !== 'staging') fail('MIGRATION_UNCERTAIN');
    const sourceKey = command.sourceKey;
    const manifest = rows(sql, 'SELECT * FROM gen05_legacy_manifest WHERE source_key=?', sourceKey)[0];
    if (!manifest) fail('MIGRATION_QUARANTINED');
    const chunks = rows(sql, 'SELECT chunk_index,chunk_sha256,data FROM gen05_legacy_chunk WHERE source_key=? ORDER BY chunk_index', sourceKey);
    if (chunks.length !== manifest.chunk_count) return { ok: true, complete: false };
    const parts = [];
    let bytesTotal = 0;
    for (let index = 0; index < chunks.length; index += 1) {
      const part = new Uint8Array(chunks[index].data);
      if (chunks[index].chunk_index !== index) fail('MIGRATION_QUARANTINED');
      const partDigest = hex(await sha256(part));
      assertStaging(sql, binding, command);
      if (partDigest !== chunks[index].chunk_sha256) fail('MIGRATION_QUARANTINED');
      parts.push(part); bytesTotal += part.byteLength;
    }
    if (bytesTotal !== manifest.byte_length) fail('MIGRATION_QUARANTINED');
    const all = new Uint8Array(bytesTotal); let offset = 0;
    for (const part of parts) { all.set(part, offset); offset += part.byteLength; }
    const wholeDigest = hex(await sha256(all));
    assertStaging(sql, binding, command);
    if (wholeDigest !== manifest.source_sha256) fail('MIGRATION_QUARANTINED');
    const latest = rows(sql, 'SELECT * FROM gen05_legacy_manifest WHERE source_key=?', sourceKey)[0];
    if (!latest || latest.source_sha256 !== manifest.source_sha256 || latest.complete > 1) fail('MIGRATION_UNCERTAIN');
    const wasComplete = latest.complete === 1;
    sql.exec('UPDATE gen05_legacy_manifest SET complete=1 WHERE source_key=?', sourceKey);
    if (!wasComplete && latest.section === 'history') {
      sql.exec('UPDATE gen05_legacy_migration SET history_done=history_done+1 WHERE id=1');
    } else if (!wasComplete && latest.section === 'banks') {
      const parts = rows(sql, 'SELECT COUNT(*) AS count,SUM(complete) AS complete FROM gen05_legacy_manifest WHERE section=? AND id=?', 'banks', latest.id)[0];
      if (parts?.count === 2 && parts.complete === 2) sql.exec('UPDATE gen05_legacy_migration SET bank_done=bank_done+1 WHERE id=1');
    }
    return { ok: true, complete: true };
  } catch (error) { return { ok: false, error: error?.code || 'UNAVAILABLE' }; }
}

export async function sealLegacyArchive(sql, binding, command) {
  try {
    target(sql, binding, command?.generation);
    const job = assertJob(readJob(sql), binding, command);
    if (job.status === 'sealed') return { ok: true, status: 'sealed', receipt: JSON.parse(job.receipt_json) };
    const manifest = rows(sql, 'SELECT section,COUNT(*) AS count,SUM(complete) AS complete FROM gen05_legacy_manifest GROUP BY section');
    const counts = new Map(manifest.map(row => [row.section, row]));
    const history = counts.get('history') || { count: 0, complete: 0 };
    const banks = counts.get('banks') || { count: 0, complete: 0 };
    if (history.count !== job.history_total || banks.count !== job.bank_total * 2
      || history.complete !== history.count || banks.complete !== banks.count) fail('MIGRATION_PENDING');
    const bankParts = rows(sql, 'SELECT id,part,COUNT(*) AS count,SUM(complete) AS complete FROM gen05_legacy_manifest WHERE section=? GROUP BY id,part ORDER BY id,part', 'banks');
    const groupedBanks = new Map();
    for (const row of bankParts) {
      const entry = groupedBanks.get(row.id) || new Set();
      if (row.count !== 1 || row.complete !== 1 || entry.has(row.part)) fail('MIGRATION_QUARANTINED');
      entry.add(row.part); groupedBanks.set(row.id, entry);
    }
    if (groupedBanks.size !== job.bank_total || Array.from(groupedBanks.values()).some(parts => parts.size !== 2 || !parts.has('meta') || !parts.has('questions'))) fail('MIGRATION_PENDING');
    const descriptors = rows(sql, 'SELECT source_key,section,id,part,source_sha256,byte_length,chunk_count,meta_json FROM gen05_legacy_manifest');
    descriptors.sort((left, right) => left.source_key < right.source_key ? -1 : left.source_key > right.source_key ? 1 : 0);
    const entries = descriptors.map(row => ({
      sourceKey: row.source_key, section: row.section, id: row.id, part: row.part,
      sourceSha256: row.source_sha256, byteLength: row.byte_length, chunkCount: row.chunk_count,
      metadata: JSON.parse(row.meta_json),
    }));
    const manifestBytes = canonicalContentBytes(entries);
    const manifestDigest = hex(await sha256(manifestBytes));
    assertStaging(sql, binding, command);
    const latestDescriptors = rows(sql, 'SELECT source_key,section,id,part,source_sha256,byte_length,chunk_count,meta_json FROM gen05_legacy_manifest');
    latestDescriptors.sort((left, right) => left.source_key < right.source_key ? -1 : left.source_key > right.source_key ? 1 : 0);
    if (JSON.stringify(latestDescriptors) !== JSON.stringify(descriptors)) fail('MIGRATION_UNCERTAIN');
    const receipt = command.receipt;
    if (!receipt || receipt.sourceId !== SOURCE_ID || receipt.sourceKind !== job.source_kind
      || receipt.historyCount !== job.history_total || receipt.bankCount !== job.bank_total
      || receipt.manifestSha256 !== manifestDigest) fail('MIGRATION_QUARANTINED');
    sql.exec('UPDATE gen05_legacy_migration SET status=?,phase=?,history_done=?,bank_done=?,receipt_json=? WHERE id=1 AND status=?',
      'sealed', 'complete', history.count, job.bank_total, JSON.stringify(receipt), 'staging');
    return { ok: true, status: 'sealed', receipt };
  } catch (error) { return { ok: false, error: error?.code || 'UNAVAILABLE' }; }
}

export async function legacyArchiveReceiptPreview(sql, binding, command) {
  try {
    target(sql, binding, command?.generation);
    const job = assertJob(readJob(sql), binding, command);
    const counts = rows(sql, 'SELECT section,COUNT(*) AS count,SUM(complete) AS complete FROM gen05_legacy_manifest GROUP BY section');
    const bySection = new Map(counts.map(row => [row.section, row]));
    const history = bySection.get('history') || { count: 0, complete: 0 };
    const banks = bySection.get('banks') || { count: 0, complete: 0 };
    if (history.count !== job.history_total || banks.count !== job.bank_total * 2
      || history.complete !== history.count || banks.complete !== banks.count) fail('MIGRATION_PENDING');
    const descriptors = rows(sql, 'SELECT source_key,section,id,part,source_sha256,byte_length,chunk_count,meta_json FROM gen05_legacy_manifest');
    descriptors.sort((left, right) => left.source_key < right.source_key ? -1 : left.source_key > right.source_key ? 1 : 0);
    const entries = descriptors.map(row => ({ sourceKey: row.source_key, section: row.section, id: row.id,
      part: row.part, sourceSha256: row.source_sha256, byteLength: row.byte_length,
      chunkCount: row.chunk_count, metadata: JSON.parse(row.meta_json) }));
    const digest = hex(await sha256(canonicalContentBytes(entries)));
    assertStaging(sql, binding, command);
    const latest = rows(sql, 'SELECT source_key,section,id,part,source_sha256,byte_length,chunk_count,meta_json FROM gen05_legacy_manifest');
    latest.sort((left, right) => left.source_key < right.source_key ? -1 : left.source_key > right.source_key ? 1 : 0);
    if (JSON.stringify(latest) !== JSON.stringify(descriptors)) fail('MIGRATION_UNCERTAIN');
    return { ok: true, sourceId: SOURCE_ID, sourceKind: job.source_kind, historyCount: job.history_total, bankCount: job.bank_total, manifestSha256: digest };
  } catch (error) { return { ok: false, error: error?.code || 'UNAVAILABLE' }; }
}

export function legacyArchiveStatus(sql, binding, generation) {
  try {
    target(sql, binding, generation);
    const job = readJob(sql);
    if (!job) return { ok: true, status: 'none' };
    if (job.principal !== binding.principal || job.incarnation !== binding.incarnation || job.generation !== generation) fail('MIGRATION_UNCERTAIN');
    const phase = job.history_done < job.history_total ? 'history'
      : job.bank_done < job.bank_total ? 'banks'
        : job.status === 'staging' ? 'verify' : 'complete';
    const historyIds = rows(sql, 'SELECT id FROM gen05_legacy_manifest WHERE section=? AND complete=1', 'history').map(row => row.id).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    const bankIds = rows(sql, `SELECT q.id FROM gen05_legacy_manifest q JOIN gen05_legacy_manifest m ON m.id=q.id AND m.section='banks' AND m.part='meta' AND m.complete=1 WHERE q.section='banks' AND q.part='questions' AND q.complete=1`)
      .map(row => row.id).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    const processed = phase === 'history' ? job.history_done : phase === 'banks' ? job.bank_done : phase === 'verify' ? 0 : 0;
    const total = phase === 'history' ? job.history_total : phase === 'banks' ? job.bank_total : phase === 'verify' ? 1 : 0;
    return { ok: true, status: job.status, phase, processed, total, historyDone: job.history_done, historyTotal: job.history_total, bankDone: job.bank_done, bankTotal: job.bank_total, historyCursor: historyIds.at(-1) || null, bankCursor: bankIds.at(-1) || null, receipt: job.status === 'sealed' ? JSON.parse(job.receipt_json) : null };
  } catch (error) { return { ok: false, error: error?.code || 'UNAVAILABLE' }; }
}

export function legacyArchiveManifestPage(sql, binding, generation, section, afterId = null, limit = 5) {
  try {
    target(sql, binding, generation);
    const job = readJob(sql);
    if (!job) return { ok: true, items: [], nextCursor: null };
    if (job.status !== 'sealed') fail(job.status === 'deleted' ? 'ACCOUNT_DELETED' : 'MIGRATION_PENDING');
    if (job.principal !== binding.principal || job.incarnation !== binding.incarnation) fail('MIGRATION_UNCERTAIN');
    if (!['history', 'banks'].includes(section) || !(afterId === null || (typeof afterId === 'string' && afterId.length <= 64)) || !Number.isSafeInteger(limit) || limit < 1 || limit > 5) fail('INVALID_INPUT');
    const items = rows(sql, `SELECT source_key,section,id,part,source_sha256,byte_length,chunk_count,meta_json FROM gen05_legacy_manifest WHERE section=? AND part=? AND complete=1 AND id>? ORDER BY id LIMIT ?`, section, section === 'history' ? 'record' : 'questions', afterId || '', limit + 1);
    const page = items.slice(0, limit).map((item) => {
      const meta = JSON.parse(item.meta_json);
      if (section === 'banks') {
        const metadata = rows(sql, 'SELECT meta_json,source_sha256,byte_length FROM gen05_legacy_manifest WHERE source_key=? AND complete=1', `bank:${item.id}:meta`)[0];
        if (!metadata) fail('MIGRATION_QUARANTINED');
        Object.assign(meta, JSON.parse(metadata.meta_json));
        meta.metaSha256 = metadata.source_sha256;
        meta.metaByteLength = metadata.byte_length;
      }
      return { ...meta, id: item.id, sourceKey: section === 'history' ? `history:${item.id}` : `bank:${item.id}`, sha256: item.source_sha256, byteLength: item.byte_length, chunkCount: item.chunk_count };
    });
    return { ok: true, items: page, nextCursor: items.length > limit ? page.at(-1).id : null };
  } catch (error) { return { ok: false, error: error?.code || 'UNAVAILABLE' }; }
}

export function legacyArchiveReadChunk(sql, binding, generation, sourceKey, chunkIndex) {
  try {
    target(sql, binding, generation);
    const job = readJob(sql);
    if (!job) return { ok: true, found: false };
    if (job.status !== 'sealed') fail(job.status === 'deleted' ? 'ACCOUNT_DELETED' : 'MIGRATION_PENDING');
    if (job.principal !== binding.principal || job.incarnation !== binding.incarnation) fail('MIGRATION_UNCERTAIN');
    const manifest = rows(sql, 'SELECT source_sha256,byte_length,chunk_count,complete FROM gen05_legacy_manifest WHERE source_key=?', sourceKey)[0];
    if (!manifest || manifest.complete !== 1) return { ok: true, found: false };
    if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= manifest.chunk_count) fail('INVALID_INPUT');
    const row = rows(sql, 'SELECT chunk_sha256,data FROM gen05_legacy_chunk WHERE source_key=? AND chunk_index=?', sourceKey, chunkIndex)[0];
    if (!row) fail('MIGRATION_QUARANTINED');
    return { ok: true, found: true, sourceSha256: manifest.source_sha256, byteLength: manifest.byte_length, chunkCount: manifest.chunk_count, chunkIndex, chunkSha256: row.chunk_sha256, bytes: new Uint8Array(row.data) };
  } catch (error) { return { ok: false, error: error?.code || 'UNAVAILABLE' }; }
}
import { canonicalContentBytes } from '../../src/domain/app-data/canonical.js';
