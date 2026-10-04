import { validGeneration } from './generation-transition.js';

// This read-only projection deliberately proves only bounded counts in the
// current generation. Source-cohort coverage remains unknown until each
// snapshot is compared against its sealed conversion descriptor.
const MAX_ROWS = 100_000;
const REQUIRED_TABLES = [
  'gen06_sync_meta', 'gen06_change_log', 'gen06_entities',
  'gen06_entity_tombstones', 'gen06_mutation_receipts',
  'gen06_bank_revisions', 'gen06_bank_questions', 'gen06_scope_rows',
  'gen06_event_actions', 'gen06_content_chunks', 'gen06_content_manifests',
];
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const rows = (sql, statement, ...args) => Array.from(sql.exec(statement, ...args));

function unknown(generation) {
  return {
    status: 'unknown', generation: validGeneration(generation) ? generation : null,
    highWater: null, historySnapshotCount: null, attemptCount: null,
    activePrivateBankCount: null, tombstoneCount: null, coverageStatus: 'unknown',
  };
}

function boundedCount(sql, statement, ...args) {
  const result = rows(sql, statement, ...args, MAX_ROWS + 1);
  if (result.length > MAX_ROWS) return null;
  return result.length;
}

/**
 * Read bounded native AppData counts from an already owner- and generation-
 * bound AccountGenerationStore SQL database. The caller must verify the
 * principal/incarnation/fence before and after this synchronous read.
 * No payload or identity fields are returned.
 */
export function readNativeAdminStatus(sql, { generation } = {}) {
  if (!sql || typeof sql.exec !== 'function' || !validGeneration(generation)) return unknown(generation);
  try {
    for (const table of REQUIRED_TABLES) {
      if (!rows(sql, "SELECT name FROM sqlite_master WHERE type='table' AND name=?", table).length) return unknown(generation);
    }

    const metaRows = rows(sql, 'SELECT id,generation,log_epoch,high_water FROM gen06_sync_meta');
    if (metaRows.length !== 1) return unknown(generation);
    const meta = metaRows[0];
    if (meta.id !== 1 || meta.generation !== generation || !UUID_V4.test(meta.log_epoch)
      || typeof meta.high_water !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(meta.high_water)) return unknown(generation);

    const highWaterBig = BigInt(meta.high_water);
    if (highWaterBig > BigInt(MAX_ROWS)) return unknown(generation);
    const changes = rows(sql, 'SELECT server_seq FROM gen06_change_log ORDER BY length(server_seq),server_seq LIMIT ?', MAX_ROWS + 1);
    if (changes.length !== Number(highWaterBig)
      || changes.some((row, index) => row.server_seq !== String(index + 1))) return unknown(generation);

    const activeRows = (kind) => boundedCount(sql,
      `SELECT entity_key FROM gen06_entities AS e WHERE kind=?
        AND NOT EXISTS (SELECT 1 FROM gen06_entity_tombstones t WHERE t.entity_key=e.entity_key AND t.generation=?)
        LIMIT ?`, kind, generation);
    const historySnapshotCount = activeRows('history_snapshot');
    const attemptCount = activeRows('attempt_manifest');
    const invalidVisibility = boundedCount(sql,
      `SELECT entity_key FROM gen06_entities
        WHERE kind='bank_revision'
          AND (json_extract(payload_json,'$.metadata.visibility') IS NULL
            OR json_extract(payload_json,'$.metadata.visibility') NOT IN ('public','private','protected'))
        LIMIT ?`);
    if (invalidVisibility === null || invalidVisibility !== 0) return unknown(generation);
    const privateRows = boundedCount(sql,
      `SELECT entity_key FROM gen06_entities AS e WHERE kind='bank_revision'
        AND json_extract(payload_json,'$.metadata.visibility')='private'
        AND NOT EXISTS (SELECT 1 FROM gen06_entity_tombstones t WHERE t.entity_key=e.entity_key AND t.generation=?)
        LIMIT ?`, generation);
    const tombstoneRows = boundedCount(sql,
      'SELECT entity_key FROM gen06_entity_tombstones WHERE generation=? LIMIT ?', generation);
    if ([historySnapshotCount, attemptCount, privateRows, tombstoneRows].some(value => value === null)) return unknown(generation);

    return {
      status: 'verified', generation, highWater: meta.high_water,
      historySnapshotCount, attemptCount, activePrivateBankCount: privateRows,
      tombstoneCount: tombstoneRows, coverageStatus: 'unknown',
    };
  } catch {
    return unknown(generation);
  }
}
