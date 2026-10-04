import { canonicalBytes } from '../../src/domain/app-data/canonical.js';
import { CLOUD_SECTION_PATHS } from './account-cloud-checkpoint.js';

export const EXPORT_TABLES = ['gen06_exports', 'gen06_export_rows', 'gen06_export_rate'];
export const CLOUD_EXPORT_SECTIONS = CLOUD_SECTION_PATHS;
const sections = CLOUD_EXPORT_SECTIONS;
const rows = (sql, query, ...values) => Array.from(sql.exec(query, ...values));
const fail = code => { throw Object.assign(new Error(code), { code }); };
const decimal = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value);

// Fixed SQL snapshots; no whole-account JavaScript array is materialized.
export function createAccountExportRepository(sql, generation, logEpoch, highWater) {
  const present = EXPORT_TABLES.slice(0, 2).map(name => rows(sql, "SELECT name FROM sqlite_master WHERE type='table' AND name=?", name).length > 0);
  if (present.some(Boolean) && !present.every(Boolean)) fail('INVALID_EXPORT_SCHEMA');
  if (!present.some(Boolean)) {
    sql.exec('CREATE TABLE gen06_exports (export_id TEXT PRIMARY KEY, generation TEXT NOT NULL, log_epoch TEXT NOT NULL, export_cut TEXT NOT NULL, expires_at INTEGER NOT NULL, manifest_json TEXT, manifest_digest TEXT)');
    sql.exec('CREATE TABLE gen06_export_rows (export_id TEXT NOT NULL, section TEXT NOT NULL, ordinal TEXT NOT NULL, body_json TEXT NOT NULL, PRIMARY KEY(export_id,section,ordinal))');
  }
  const columns = rows(sql, 'PRAGMA table_info(gen06_exports)').map(row => row.name);
  if (!columns.includes('checkpoint_json')) sql.exec('ALTER TABLE gen06_exports ADD COLUMN checkpoint_json TEXT');
  if (!columns.includes('checkpoint_digest')) sql.exec('ALTER TABLE gen06_exports ADD COLUMN checkpoint_digest TEXT');
  for (const column of ['snapshot_mode', 'receipt_cut', 'registry_json', 'registry_digest']) if (!columns.includes(column)) sql.exec(`ALTER TABLE gen06_exports ADD COLUMN ${column} TEXT`);
  sql.exec('CREATE TABLE IF NOT EXISTS gen06_export_rate (id INTEGER PRIMARY KEY CHECK(id=1), window INTEGER NOT NULL, count INTEGER NOT NULL)');
  const budget = () => {
    const size = rows(sql, "SELECT COALESCE(SUM(length(CAST(COALESCE(manifest_json,'')||COALESCE(checkpoint_json,'')||COALESCE(registry_json,'')||COALESCE(registry_digest,'')||export_id||generation||log_epoch||export_cut||COALESCE(receipt_cut,'') AS BLOB))+256),0) AS n FROM gen06_exports")[0].n;
    if (!Number.isSafeInteger(size) || size > 64 * 1024) fail('EXPORT_METADATA_QUOTA');
  };
  function owned(id) {
    const row = rows(sql, 'SELECT * FROM gen06_exports WHERE export_id=?', id)[0];
    if (!row || row.generation !== generation || row.log_epoch !== logEpoch || row.expires_at <= Date.now()) fail('EXPORT_UNAVAILABLE');
    return row;
  }
  const pinnedQuery = (row, section) => {
    const cut = row.export_cut;
    const atCut = "(length(server_seq)<length(?) OR (length(server_seq)=length(?) AND server_seq<=?))";
    const args = [cut, cut, cut];
    if (section === 'accepted-changes.ndjson' || section === 'tombstones.ndjson' || section === 'content-references.ndjson') {
      const filter = section === 'tombstones.ndjson' ? " AND json_extract(record_json,'$.kind')='entity_tombstone'" : section === 'content-references.ndjson' ? " AND json_extract(record_json,'$.kind') IN ('content_manifest','attempt_scope','resume_state','bank_revision','history_snapshot')" : '';
      return { query: `SELECT server_seq AS ordinal,record_json AS body_json FROM gen06_change_log WHERE ${atCut}${filter}`, args };
    }
    if (section === 'mutation-receipts.ndjson') return { query: "SELECT CAST(rowid AS TEXT) AS ordinal,json_object('receipt',json(receipt_json),'mutation',json(mutation_json)) AS body_json FROM gen06_mutation_receipts WHERE rowid<=CAST(? AS INTEGER)", args: [row.receipt_cut] };
    if (section === 'latest-state.ndjson') return { query: `SELECT CAST(row_number() OVER(ORDER BY kind,entity_key) AS TEXT) AS ordinal,record_json AS body_json FROM (SELECT record_json,json_extract(record_json,'$.kind') AS kind,json_extract(record_json,'$.entityKey') AS entity_key,row_number() OVER(PARTITION BY json_extract(record_json,'$.kind'),json_extract(record_json,'$.entityKey') ORDER BY length(server_seq) DESC,server_seq DESC) AS rank FROM gen06_change_log WHERE ${atCut}) WHERE rank=1`, args };
    return { query: `SELECT CAST(row_number() OVER(ORDER BY content_digest) AS TEXT) AS ordinal,manifest_json AS body_json FROM gen06_content_manifests WHERE content_digest IN (SELECT CASE json_extract(record_json,'$.kind') WHEN 'content_manifest' THEN json_extract(record_json,'$.payload.reference.contentDigest') WHEN 'attempt_scope' THEN json_extract(record_json,'$.payload.reference.contentDigest') WHEN 'history_snapshot' THEN json_extract(record_json,'$.payload.reference.contentDigest') WHEN 'resume_state' THEN json_extract(record_json,'$.payload.contentDigest') WHEN 'bank_revision' THEN json_extract(record_json,'$.payload.contentManifest.reference.contentDigest') END FROM gen06_change_log WHERE ${atCut})`, args };
  };
  return {
    consumeRate() {
      const window = Math.floor(Date.now() / 60000);
      const old = rows(sql, 'SELECT window,count FROM gen06_export_rate WHERE id=1')[0];
      const count = old?.window === window ? old.count + 1 : 1;
      sql.exec('INSERT INTO gen06_export_rate VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET window=excluded.window,count=excluded.count', window, count);
      return { allowed: count <= 60, retryAfter: 60 - Math.floor(Date.now() / 1000) % 60 };
    },
    prepare({ registry = [], registryDigest = '' } = {}) {
      const now = Date.now();
      sql.exec('DELETE FROM gen06_export_rows WHERE export_id IN (SELECT export_id FROM gen06_exports WHERE expires_at<=?)', now);
      sql.exec('DELETE FROM gen06_exports WHERE expires_at<=?', now);
      if (rows(sql, 'SELECT count(*) AS n FROM gen06_exports')[0].n >= 2) fail('EXPORT_LIMIT');
      const exportId = crypto.randomUUID(), expiresAt = now + 15 * 60 * 1000;
      const receiptCut = rows(sql, 'SELECT CAST(COALESCE(max(rowid),0) AS TEXT) AS cut FROM gen06_mutation_receipts')[0].cut;
      sql.exec('INSERT INTO gen06_exports (export_id,generation,log_epoch,export_cut,expires_at,snapshot_mode,receipt_cut,registry_json,registry_digest) VALUES(?,?,?,?,?,?,?,?,?)', exportId, generation, logEpoch, highWater, expiresAt, 'pinned-v1', receiptCut, JSON.stringify(registry), registryDigest);
      budget();
      return { exportId, generation, logEpoch, exportCut: highWater, expiresAt, sections: [...sections] };
    },
    page({ exportId, section, after = '0', limit = 100 }, requireComplete = false) {
      const exportRow = owned(exportId);
      if (requireComplete && !exportRow.manifest_json) fail('EXPORT_NOT_READY');
      if (!sections.includes(section) || !decimal(after) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('INVALID_EXPORT_INPUT');
      const source = exportRow.snapshot_mode === 'pinned-v1' ? pinnedQuery(exportRow, section) : { query: 'SELECT ordinal,body_json FROM gen06_export_rows WHERE export_id=? AND section=?', args: [exportId, section] };
      const candidates = rows(sql, `SELECT ordinal,body_json FROM (${source.query}) WHERE (length(ordinal)>length(?) OR (length(ordinal)=length(?) AND ordinal>?)) ORDER BY length(ordinal),ordinal LIMIT ?`, ...source.args, after, after, after, limit + 1);
      const records = []; let bytes = 0, next = after;
      for (const row of candidates.slice(0, limit)) {
        const value = JSON.parse(row.body_json); const size = canonicalBytes(value).length + 1;
        if (bytes + size > 480 * 1024) break;
        records.push(value); bytes += size; next = row.ordinal;
      }
      if (!records.length && candidates.length) fail('EXPORT_ROW_TOO_LARGE');
      return { exportId, section, records, next, hasMore: candidates.some(row => BigInt(row.ordinal) > BigInt(next)), exportCut: exportRow.export_cut };
    },
    finalize(id, manifest, digest) {
      const row = owned(id);
      if (row.manifest_json || manifest.exportCut !== row.export_cut || manifest.accountGeneration !== generation || manifest.serverLogEpoch !== logEpoch) fail('EXPORT_CONFLICT');
      sql.exec('UPDATE gen06_exports SET manifest_json=?,manifest_digest=? WHERE export_id=?', JSON.stringify(manifest), digest, id);
      budget();
      return { exportId: id, manifest, manifestDigest: digest, expiresAt: row.expires_at };
    },
    finalizeCheckpoint(id, checkpoint, digest) {
      const row = owned(id);
      if (!row.manifest_json || row.checkpoint_json || checkpoint.cut !== row.export_cut || checkpoint.generation !== generation || checkpoint.logEpoch !== logEpoch || checkpoint.expiresAt !== row.expires_at) fail('EXPORT_CONFLICT');
      sql.exec('UPDATE gen06_exports SET checkpoint_json=?,checkpoint_digest=? WHERE export_id=?', JSON.stringify(checkpoint), digest, id);
      budget();
      return this.describe(id);
    },
    setContentReference(id, sourceSeq, value) {
      const row = owned(id);
      if (row.manifest_json || !decimal(sourceSeq) || value.sourceChange?.serverSeq !== sourceSeq) fail('EXPORT_CONFLICT');
      sql.exec("UPDATE gen06_export_rows SET body_json=? WHERE export_id=? AND section='content-references.ndjson' AND ordinal=?", JSON.stringify(value), id, sourceSeq);
      budget();
    },
    registry(id) { const row = owned(id); return { entries: JSON.parse(row.registry_json || '[]'), digest: row.registry_digest || '', mode: row.snapshot_mode || 'copied-v1' }; },
    changeAt(id, seq) {
      const exportRow = owned(id);
      if (!decimal(seq) || BigInt(seq) > BigInt(exportRow.export_cut)) return null;
      const row = exportRow.snapshot_mode === 'pinned-v1' ? rows(sql, 'SELECT record_json AS body_json FROM gen06_change_log WHERE server_seq=?', seq)[0] : rows(sql, "SELECT body_json FROM gen06_export_rows WHERE export_id=? AND section='accepted-changes.ndjson' AND ordinal=?", id, seq)[0];
      return row ? JSON.parse(row.body_json) : null;
    },
    latestChangeAtCut(id, kind, entityKey) {
      const row = owned(id);
      const change = rows(sql, "SELECT record_json FROM gen06_change_log WHERE json_extract(record_json,'$.kind')=? AND json_extract(record_json,'$.entityKey')=? AND (length(server_seq)<length(?) OR (length(server_seq)=length(?) AND server_seq<=?)) ORDER BY length(server_seq) DESC,server_seq DESC LIMIT 1", kind, entityKey, row.export_cut, row.export_cut, row.export_cut)[0];
      return change ? JSON.parse(change.record_json) : null;
    },
    hasAcceptedReceipt(id, seq, digest) {
      const exportRow = owned(id);
      if (exportRow.snapshot_mode === 'pinned-v1') return rows(sql, "SELECT mutation_id FROM gen06_mutation_receipts WHERE rowid<=CAST(? AS INTEGER) AND json_extract(receipt_json,'$.status')='accepted' AND json_extract(receipt_json,'$.serverSeq')=? AND json_extract(receipt_json,'$.payloadDigest')=? LIMIT 1", exportRow.receipt_cut, seq, digest).length === 1;
      return rows(sql, "SELECT ordinal FROM gen06_export_rows WHERE export_id=? AND section='mutation-receipts.ndjson' AND json_extract(body_json,'$.receipt.status')='accepted' AND json_extract(body_json,'$.receipt.serverSeq')=? AND json_extract(body_json,'$.receipt.payloadDigest')=? LIMIT 1", id, seq, digest).length === 1;
    },
    describe(id) { const row = owned(id); if (!row.manifest_json) fail('EXPORT_NOT_READY'); return { exportId: id, manifest: JSON.parse(row.manifest_json), manifestDigest: row.manifest_digest, expiresAt: row.expires_at, ...(row.checkpoint_json ? { checkpoint: JSON.parse(row.checkpoint_json), checkpointDigest: row.checkpoint_digest } : {}) }; },
    permitsChunk(id, digest) {
      const row = owned(id); if (!row.manifest_json) fail('EXPORT_NOT_READY');
      if (row.snapshot_mode === 'pinned-v1') {
        const source = pinnedQuery(row, 'content-manifests.ndjson');
        return rows(sql, `SELECT ordinal FROM (${source.query}) WHERE json_extract(body_json,'$.contentDigest')=? LIMIT 1`, ...source.args, digest).length === 1;
      }
      return rows(sql, "SELECT ordinal FROM gen06_export_rows WHERE export_id=? AND section='content-manifests.ndjson' AND json_extract(body_json,'$.contentDigest')=? LIMIT 1", id, digest).length === 1;
    },
  };
}
