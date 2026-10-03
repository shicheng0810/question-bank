import { validateChunkManifest } from '../../src/domain/app-data/content-records.js';

export const CONTENT_TABLES = ['gen06_content_chunks', 'gen06_content_manifests'];
const rows = (sql, statement, ...values) => Array.from(sql.exec(statement, ...values));
const failure = code => { throw Object.assign(new Error(code), { code }); };
const HEX = /^[0-9a-f]{64}$/;
const QUOTA = 100 * 1024 * 1024;

export function accountDataBytes(sql) {
  let total = 0;
  // ADR15: only small export coordination metadata has a separate 64KiB cap.
  // Legacy copied payload rows remain business bytes until their fixed expiry.
  for (const [table, column] of [['gen06_export_rows', 'body_json']]) {
    if (!rows(sql, "SELECT name FROM sqlite_master WHERE type='table' AND name=?", table).length) continue;
    const value = rows(sql, `SELECT COALESCE(SUM(length(CAST(${column} AS BLOB))),0) AS bytes FROM ${table}`)[0].bytes;
    if (!Number.isSafeInteger(value) || value < 0) failure('UNAVAILABLE');
    total += value;
  }
  for (const [table, column] of [['gen06_content_chunks', 'byte_length'], ['gen06_content_manifests', 'length(CAST(manifest_json AS BLOB))'], ['gen06_mutation_receipts', 'length(CAST(receipt_json AS BLOB))+COALESCE(length(CAST(mutation_json AS BLOB)),0)'], ['gen06_change_log', 'length(CAST(record_json AS BLOB))'], ['gen06_entities', 'length(CAST(payload_json AS BLOB))'], ['gen06_bank_revisions', 'length(CAST(record_json AS BLOB))'], ['gen06_bank_questions', 'length(question_key)+length(question_revision)+length(bank_revision)'], ['gen06_scope_rows', 'length(question_key)+length(question_revision)'], ['gen06_event_actions', 'length(event_id)+length(digest)+length(server_seq)']]) {
    if (!rows(sql, "SELECT name FROM sqlite_master WHERE type='table' AND name=?", table).length) continue;
    const value = rows(sql, `SELECT COALESCE(SUM(${column}),0) AS bytes FROM ${table}`)[0].bytes;
    if (!Number.isSafeInteger(value) || value < 0) failure('UNAVAILABLE');
    total += value;
  }
  return total;
}
export function assertAccountQuota(sql, additional = 0) {
  if (accountDataBytes(sql) + additional > QUOTA) failure('QUOTA_EXCEEDED');
}

// Immutable chunk keys make asynchronous publication verification safe: no
// request can replace bytes captured before an await. Account namespace and
// current generation are checked by the owning AccountGenerationStore.
export function createAccountContentRepository(sql) {
  sql.exec('CREATE TABLE IF NOT EXISTS gen06_content_chunks (content_digest TEXT NOT NULL, chunk_index INTEGER NOT NULL, byte_length INTEGER NOT NULL, chunk_digest TEXT NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(content_digest,chunk_index))');
  sql.exec('CREATE TABLE IF NOT EXISTS gen06_content_manifests (content_digest TEXT PRIMARY KEY, manifest_digest TEXT NOT NULL, manifest_json TEXT NOT NULL)');
  return {
    putChunk(contentDigest, chunkIndex, digest, bytes) {
      if (!HEX.test(contentDigest) || !HEX.test(digest) || !Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= 200
        || !(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > 512 * 1024) failure('INVALID_CONTENT_INPUT');
      const old = rows(sql, 'SELECT chunk_digest,byte_length FROM gen06_content_chunks WHERE content_digest=? AND chunk_index=?', contentDigest, chunkIndex)[0];
      if (old) {
        if (old.chunk_digest !== digest || old.byte_length !== bytes.byteLength) failure('CONTENT_CONFLICT');
        return { status: 'duplicate' };
      }
      // Sum includes unpublished staging. SQL is synchronous, so concurrent
      // uploads share this exact reservation/commit point.
      assertAccountQuota(sql, bytes.byteLength);
      sql.exec('INSERT INTO gen06_content_chunks VALUES(?,?,?,?,?)', contentDigest, chunkIndex, bytes.byteLength, digest, bytes);
      return { status: 'accepted' };
    },
    readChunk(contentDigest, chunkIndex, publishedOnly = true) {
      if (!HEX.test(contentDigest) || !Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= 200) failure('INVALID_CONTENT_INPUT');
      if (publishedOnly && !rows(sql, 'SELECT content_digest FROM gen06_content_manifests WHERE content_digest=?', contentDigest).length) failure('MISSING_DEPENDENCY');
      const row = rows(sql, 'SELECT byte_length,chunk_digest,bytes FROM gen06_content_chunks WHERE content_digest=? AND chunk_index=?', contentDigest, chunkIndex)[0];
      if (!row) failure('MISSING_DEPENDENCY');
      return { byteLength: row.byte_length, digest: row.chunk_digest, bytes: new Uint8Array(row.bytes) };
    },
    manifest(contentDigest) {
      const row = rows(sql, 'SELECT manifest_digest,manifest_json FROM gen06_content_manifests WHERE content_digest=?', contentDigest)[0];
      return row ? { manifestDigest: row.manifest_digest, manifest: JSON.parse(row.manifest_json) } : null;
    },
    publish(input, manifestDigest) {
      const manifest = validateChunkManifest(input);
      if (!HEX.test(manifestDigest)) failure('INVALID_CONTENT_INPUT');
      const old = this.manifest(manifest.contentDigest);
      if (old) {
        if (old.manifestDigest !== manifestDigest) failure('CONTENT_CONFLICT');
        return { status: 'duplicate' };
      }
      const stored = rows(sql, 'SELECT chunk_index,byte_length,chunk_digest FROM gen06_content_chunks WHERE content_digest=? ORDER BY chunk_index', manifest.contentDigest);
      if (stored.length !== manifest.chunkCount || stored.some((r, i) => r.chunk_index !== i || r.byte_length !== manifest.chunks[i].byteLength || r.chunk_digest !== manifest.chunks[i].sha256)) failure('MISSING_DEPENDENCY');
      sql.exec('INSERT INTO gen06_content_manifests VALUES(?,?,?)', manifest.contentDigest, manifestDigest, JSON.stringify(manifest));
      assertAccountQuota(sql);
      return { status: 'accepted' };
    },
  };
}
