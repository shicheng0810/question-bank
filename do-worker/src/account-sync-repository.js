import { canonicalBytes } from '../../src/domain/app-data/canonical.js';
import { encodeCursor, decodeCursor } from '../../src/domain/app-data/cursor.js';
import { validatePushResponse, validatePullResponse } from '../../src/domain/app-data/sync-wire.js';
import { CONTENT_TABLES, assertAccountQuota, createAccountContentRepository } from './account-content-repository.js';
import { isUuid } from '../../src/domain/question/index.js';

const CAS = new Set(['attempt_manifest', 'resume_state', 'user_state', 'bank_revision']);
export const SYNC_TABLES = ['gen06_sync_meta', 'gen06_mutation_receipts', 'gen06_change_log', 'gen06_entities', 'gen06_entity_tombstones', 'gen06_bank_revisions', 'gen06_bank_questions', 'gen06_scope_rows', 'gen06_event_actions'];
const rows = (sql, statement, ...args) => Array.from(sql.exec(statement, ...args));
const cursor = (generation, logEpoch, serverSeq) => encodeCursor({ protocolVersion: 2, accountGeneration: generation, logEpoch, serverSeq });
const error = (code) => Object.assign(new Error(code), { code });

// All methods are synchronous and called only inside the caller's transactionSync.
// Sequence values are TEXT throughout; no SQLite INTEGER -> JS Number conversion.
export function createAccountSyncRepository(sql, generation, dependencies = {}) {
  const tables = [...SYNC_TABLES, ...CONTENT_TABLES];
  const present = tables.filter(table => rows(sql, "SELECT name FROM sqlite_master WHERE type='table' AND name=?", table).length);
  if (present.length !== 0 && present.length !== tables.length) throw error('INVALID_SYNC_SCHEMA');
  const fresh = present.length === 0;
  sql.exec('CREATE TABLE IF NOT EXISTS gen06_sync_meta (id INTEGER PRIMARY KEY CHECK(id=1), generation TEXT NOT NULL, log_epoch TEXT NOT NULL, high_water TEXT NOT NULL)');
  sql.exec('CREATE TABLE IF NOT EXISTS gen06_mutation_receipts (mutation_id TEXT PRIMARY KEY, stream_id TEXT NOT NULL, client_seq TEXT NOT NULL, digest TEXT NOT NULL, receipt_json TEXT NOT NULL, UNIQUE(stream_id,client_seq))');
  sql.exec('CREATE TABLE IF NOT EXISTS gen06_change_log (server_seq TEXT PRIMARY KEY, record_json TEXT NOT NULL)');
  sql.exec('CREATE TABLE IF NOT EXISTS gen06_entities (kind TEXT NOT NULL, entity_key TEXT NOT NULL, digest TEXT NOT NULL, payload_json TEXT NOT NULL, revision INTEGER NOT NULL, server_seq TEXT NOT NULL, PRIMARY KEY(kind,entity_key))');
  sql.exec('CREATE TABLE IF NOT EXISTS gen06_entity_tombstones (entity_key TEXT PRIMARY KEY, generation TEXT NOT NULL)');
  sql.exec('CREATE TABLE IF NOT EXISTS gen06_bank_revisions (bank_uid TEXT NOT NULL, revision TEXT NOT NULL, record_json TEXT NOT NULL, PRIMARY KEY(bank_uid,revision))');
  sql.exec('CREATE TABLE IF NOT EXISTS gen06_bank_questions (bank_uid TEXT NOT NULL, bank_revision TEXT NOT NULL, question_key TEXT NOT NULL, question_revision TEXT NOT NULL, PRIMARY KEY(bank_uid,bank_revision,question_key))');
  sql.exec('CREATE TABLE IF NOT EXISTS gen06_scope_rows (attempt_id TEXT NOT NULL, ordinal INTEGER NOT NULL, question_key TEXT NOT NULL, question_revision TEXT NOT NULL, PRIMARY KEY(attempt_id,ordinal), UNIQUE(attempt_id,question_key))');
  sql.exec('CREATE TABLE IF NOT EXISTS gen06_event_actions (attempt_id TEXT NOT NULL, writer_stream TEXT NOT NULL, action_seq TEXT NOT NULL, event_id TEXT NOT NULL UNIQUE, digest TEXT NOT NULL, server_seq TEXT NOT NULL, PRIMARY KEY(attempt_id,writer_stream,action_seq))');
  createAccountContentRepository(sql);
  let meta = rows(sql, 'SELECT * FROM gen06_sync_meta WHERE id=1')[0];
  if (!meta) {
    if (!fresh) throw error('INVALID_SYNC_SCHEMA');
    sql.exec('INSERT INTO gen06_sync_meta VALUES(1,?,?,?)', generation, crypto.randomUUID(), '0');
    meta = rows(sql, 'SELECT * FROM gen06_sync_meta WHERE id=1')[0];
  }
  if (!isUuid(meta.generation) || !isUuid(meta.log_epoch) || !/^(0|[1-9][0-9]{0,19})$/.test(meta.high_water)
    || rows(sql, 'SELECT id FROM gen06_sync_meta').length !== 1) throw error('INVALID_SYNC_SCHEMA');
  if (meta.generation !== generation) throw error('STALE_GENERATION');
  const last = rows(sql, 'SELECT server_seq FROM gen06_change_log ORDER BY length(server_seq) DESC,server_seq DESC LIMIT 1')[0]?.server_seq || '0';
  const count = rows(sql, 'SELECT count(*) AS n FROM gen06_change_log')[0].n;
  if (!Number.isSafeInteger(count) || last !== meta.high_water || BigInt(count) !== BigInt(meta.high_water)) throw error('INVALID_SYNC_SCHEMA');
  // Explicit additive provenance migration. Old permanent receipts stay null:
  // absence of their original mutation is never presented as full coverage.
  const receiptColumns = rows(sql, 'PRAGMA table_info(gen06_mutation_receipts)').map(row => row.name);
  if (!receiptColumns.includes('mutation_json')) sql.exec('ALTER TABLE gen06_mutation_receipts ADD COLUMN mutation_json TEXT');
  sql.exec("CREATE INDEX IF NOT EXISTS gen06_receipts_server_seq ON gen06_mutation_receipts(json_extract(receipt_json,'$.serverSeq'),json_extract(receipt_json,'$.payloadDigest'))");
  const entity = (kind, key) => rows(sql, 'SELECT * FROM gen06_entities WHERE kind=? AND entity_key=?', kind, key)[0];
  const payload = (kind, key) => { const row = entity(kind, key); return row ? JSON.parse(row.payload_json) : null; };
  const tombstoned = key => rows(sql, 'SELECT entity_key FROM gen06_entity_tombstones WHERE entity_key=?', key).length !== 0;
  const content = createAccountContentRepository(sql);
  const referenceExists = reference => {
    const stored = content.manifest(reference.contentDigest);
    return stored && stored.manifestDigest === reference.manifestDigest && stored.manifest.chunkCount === reference.chunkCount && stored.manifest.totalBytes === reference.totalBytes;
  };
  const historySnapshotReferenceStatus = (reference, { acceptedAtSeq } = {}) => {
    const slash = reference.questionKey.indexOf('/');
    if (slash < 1) return 'conflict';
    const bankUid = reference.questionKey.slice(0, slash);
    if (acceptedAtSeq === undefined) {
      if (tombstoned(`bank:${bankUid}`)) return 'conflict';
    } else {
      const deleted = rows(sql, "SELECT server_seq FROM gen06_change_log WHERE json_extract(record_json,'$.kind')='entity_tombstone' AND json_extract(record_json,'$.payload.entityKind')='bank' AND json_extract(record_json,'$.payload.entityId')=? ORDER BY length(server_seq),server_seq LIMIT 1", bankUid)[0];
      if (deleted && (BigInt(deleted.server_seq) < BigInt(acceptedAtSeq))) return 'conflict';
    }
    const bankRevision = rows(sql, 'SELECT record_json FROM gen06_bank_revisions WHERE bank_uid=? AND revision=?', bankUid, reference.bankRevision)[0];
    if (!bankRevision) return 'missing_dependency';
    const question = rows(sql, 'SELECT question_revision FROM gen06_bank_questions WHERE bank_uid=? AND bank_revision=? AND question_key=?', bankUid, reference.bankRevision, reference.questionKey)[0];
    return question?.question_revision === reference.questionRevision ? 'ok' : 'conflict';
  };
  const historySnapshotReferencesStatus = (references, options) => {
    const statuses = references.map(reference => historySnapshotReferenceStatus(reference, options));
    return statuses.includes('conflict') ? 'conflict' : statuses.includes('missing_dependency') ? 'missing_dependency' : 'ok';
  };
  const missing = m => ({ mutationId: m.mutationId, payloadDigest: m.payloadDigest, status: 'missing_dependency', error: 'missing_dependency' });
  const conflict = (m, revision) => ({ mutationId: m.mutationId, payloadDigest: m.payloadDigest, status: 'conflict', error: 'conflict', ...(revision === undefined ? {} : { currentRevision: revision }) });
  function storeReceipt(m, receipt) {
    sql.exec('INSERT INTO gen06_mutation_receipts (mutation_id,stream_id,client_seq,digest,receipt_json,mutation_json) VALUES(?,?,?,?,?,?)', m.mutationId, m.clientStreamId, String(m.clientSeq), m.payloadDigest, JSON.stringify(receipt), new TextDecoder().decode(canonicalBytes(m)));
    assertAccountQuota(sql);
    return receipt;
  }
  function apply(m) {
    const known = rows(sql, 'SELECT * FROM gen06_mutation_receipts WHERE mutation_id=? OR (stream_id=? AND client_seq=?)', m.mutationId, m.clientStreamId, String(m.clientSeq));
    if (known.length) {
      const exact = known.find(r => r.mutation_id === m.mutationId && r.stream_id === m.clientStreamId && r.client_seq === String(m.clientSeq) && r.digest === m.payloadDigest);
      if (!exact || known.length !== 1) return conflict(m);
      return JSON.parse(exact.receipt_json); // including the original fixed conflict
    }
    const p = m.payload;
    const deleted = rows(sql, 'SELECT entity_key FROM gen06_entity_tombstones WHERE entity_key=?', m.entityKey)[0];
    if (deleted && m.kind !== 'entity_tombstone') return storeReceipt(m, conflict(m));
    if (m.kind === 'entity_tombstone' && p.entityKind === 'attempt') {
      const liveChild = rows(sql, "SELECT entity_key FROM gen06_entities AS child WHERE kind='attempt_manifest' AND json_extract(payload_json,'$.parentAttemptId')=? AND NOT EXISTS(SELECT 1 FROM gen06_entity_tombstones WHERE entity_key=child.entity_key) LIMIT 1", p.entityId)[0];
      if (liveChild) return storeReceipt(m, conflict(m));
    }
    if (m.kind === 'user_state' && tombstoned(`bank:${p.questionKey.split('/')[0]}`)) return storeReceipt(m, conflict(m));
    const old = entity(m.kind, m.entityKey);
    const proof = dependencies.contents?.get(m.kind === 'resume_state' ? p.contentDigest : p.reference?.contentDigest || p.contentManifest?.reference?.contentDigest);
    if (m.kind === 'content_manifest' && !referenceExists(p.reference)
      && ![...(dependencies.publicRegistry?.values() || [])].some(value => new TextDecoder().decode(canonicalBytes(value.publicContentReference)) === new TextDecoder().decode(canonicalBytes(p.reference)))) return missing(m);
    if (m.kind === 'bank_revision') {
      const immutable = rows(sql, 'SELECT record_json FROM gen06_bank_revisions WHERE bank_uid=? AND revision=?', p.bankUid, p.revision)[0];
      const record = { bankUid: p.bankUid, revision: p.revision, metadata: p.metadata, contentManifest: p.contentManifest };
      if (immutable && immutable.record_json !== JSON.stringify(record)) return storeReceipt(m, conflict(m));
      if (p.contentManifest.kind === 'public_static') {
        const trusted = dependencies.publicRegistry?.get(`${p.bankUid}:${p.revision}`);
        if (!trusted || new TextDecoder().decode(canonicalBytes(trusted.record)) !== new TextDecoder().decode(canonicalBytes(record))) return missing(m);
      } else {
        if (!referenceExists(p.contentManifest.reference) || (p.contentManifest.kind === 'private_chunks' && !proof?.bankQuestions) || (p.contentManifest.kind === 'protected_cipher' && !proof?.cipherEnvelope)) return missing(m);
        if (p.contentManifest.reference.totalBytes > 3 * 1024 * 1024 || (proof?.bankQuestions?.length || 0) > 5000) return storeReceipt(m, conflict(m));
        const count = rows(sql, "SELECT count(DISTINCT bank_uid) AS n FROM gen06_bank_revisions WHERE json_extract(record_json,'$.metadata.visibility')!='public'")[0].n;
        if (!rows(sql, 'SELECT bank_uid FROM gen06_bank_revisions WHERE bank_uid=? LIMIT 1', p.bankUid).length && count >= 15) return storeReceipt(m, conflict(m));
      }
    }
    if (m.kind === 'attempt_scope') {
      const attempt = payload('attempt_manifest', m.entityKey);
      if (!attempt || !referenceExists(p.reference) || !proof?.scope) return missing(m);
      if (attempt.scopeDigest !== p.scopeDigest || proof.scopeDigest !== p.scopeDigest || proof.scope.length !== attempt.scopeCount) return storeReceipt(m, conflict(m));
      for (const row of proof.scope.flatMap(row => [{ questionKey: row.questionKey, questionRevision: row.questionRevision }, ...row.equivalentSourceRefs])) {
        const bankUid = row.questionKey.split('/')[0];
        if (tombstoned(`bank:${bankUid}`)) return storeReceipt(m, conflict(m));
        if (!rows(sql, 'SELECT question_key FROM gen06_bank_questions WHERE bank_uid=? AND question_key=? AND question_revision=? LIMIT 1', bankUid, row.questionKey, row.questionRevision).length) return missing(m);
      }
    }
    if (m.kind === 'answer_event') {
      const event = p.event; const key = `attempt:${event.attemptId}`;
      if (tombstoned(key) || tombstoned(`bank:${event.questionKey.split('/')[0]}`)) return storeReceipt(m, conflict(m));
      const attempt = payload('attempt_manifest', key);
      const scope = rows(sql, 'SELECT question_revision FROM gen06_scope_rows WHERE attempt_id=? AND question_key=?', event.attemptId, event.questionKey)[0];
      if (!attempt || !scope) return missing(m);
      if (attempt.writerStreamId !== event.writerStreamId || scope.question_revision !== event.questionRevision) return storeReceipt(m, conflict(m));
      const action = rows(sql, 'SELECT event_id,digest FROM gen06_event_actions WHERE attempt_id=? AND writer_stream=? AND action_seq=?', event.attemptId, event.writerStreamId, String(event.actionSeq))[0];
      if (action && (action.event_id !== event.eventId || action.digest !== m.payloadDigest)) return storeReceipt(m, conflict(m));
      if (event.kind === 'redo') {
        const source = payload('answer_event', `event:${event.redoOfEventId}`)?.event;
        if (!source) return missing(m);
        if (source.kind !== 'answer_submitted' || source.attemptId !== event.attemptId || source.questionKey !== event.questionKey || source.questionRevision !== event.questionRevision || source.writerStreamId !== event.writerStreamId || source.actionSeq >= event.actionSeq) return storeReceipt(m, conflict(m));
      }
    }
    if (m.kind === 'resume_state') {
      const attempt = payload('attempt_manifest', m.entityKey);
      const stored = content.manifest(p.contentDigest);
      if (!attempt || !stored || stored.manifestDigest !== p.chunkManifestDigest || !proof?.resume) return missing(m);
      const state = proof.resume;
      if (state.attemptId !== p.attemptId || state.writerStreamId !== p.writerStreamId || attempt.writerStreamId !== p.writerStreamId || state.scopeDigest !== attempt.scopeDigest || state.scope.length !== attempt.scopeCount || state.localRevision !== p.localRevision || state.baseRevision !== p.baseRevision) return storeReceipt(m, conflict(m));
      const actualScope = rows(sql, 'SELECT ordinal,question_key,question_revision FROM gen06_scope_rows WHERE attempt_id=? ORDER BY ordinal', p.attemptId);
      const actualScopePayload = payload('attempt_scope', m.entityKey);
      if (!actualScopePayload || actualScope.length !== attempt.scopeCount) return missing(m);
      if (actualScopePayload.scopeDigest !== state.scopeDigest || actualScope.some((row, i) => row.ordinal !== state.scope[i].ordinal || row.question_key !== state.scope[i].questionKey || row.question_revision !== state.scope[i].questionRevision)) return storeReceipt(m, conflict(m));
      if (state.submittedEventIds.some(id => !entity('answer_event', `event:${id}`))) return missing(m);
      // An inherited draft requires an independently verified parent payload;
      // the caller preflights shared validateResumeDependencies outside SQL.
      if (proof.resumeDependencyStatus !== 'payload_verified') return missing(m);
    }
    if (m.kind === 'history_snapshot') {
      if (!referenceExists(p.reference) || !proof?.historySnapshot) return missing(m);
      const body = proof.historySnapshot;
      if (body.snapshotId !== p.snapshotId || body.accountGeneration !== generation || body.scope.length !== p.scopeCount) return storeReceipt(m, conflict(m));
      const status = historySnapshotReferencesStatus(body.scope.flatMap(row => row.equivalentSourceRefs));
      if (status === 'conflict') return storeReceipt(m, conflict(m));
      if (status === 'missing_dependency') return missing(m);
    }
    if (m.kind === 'attempt_manifest' && p.parentAttemptId && !entity('attempt_manifest', `attempt:${p.parentAttemptId}`)) {
      return missing(m);
    }
    if (m.kind === 'attempt_manifest' && p.parentAttemptId && tombstoned(`attempt:${p.parentAttemptId}`)) return storeReceipt(m, conflict(m));
    const revision = old?.revision || 0;
    if (m.kind === 'attempt_manifest' && old) {
      const original = JSON.parse(old.payload_json);
      if (['writerStreamId', 'scopeDigest', 'scopeCount', 'parentAttemptId', 'startedAt'].some(field => original[field] !== p[field]) || (original.status === 'completed' && p.status !== 'completed')) return storeReceipt(m, conflict(m, revision));
    }
    if (CAS.has(m.kind) && (p.baseRevision !== revision || revision === Number.MAX_SAFE_INTEGER)) return storeReceipt(m, conflict(m, revision));
    if (old && !CAS.has(m.kind)) {
      if (old.digest !== m.payloadDigest) return storeReceipt(m, conflict(m));
      return storeReceipt(m, { mutationId: m.mutationId, payloadDigest: m.payloadDigest, status: 'duplicate', serverSeq: old.server_seq });
    }
    const seq = (BigInt(meta.high_water) + 1n).toString();
    if (seq.length > 20) throw error('REVISION_EXHAUSTED');
    const nextRevision = CAS.has(m.kind) ? revision + 1 : 0;
    const record = { serverSeq: seq, accountGeneration: generation, kind: m.kind, entityKey: m.entityKey, payloadDigest: m.payloadDigest, payload: p, ...(CAS.has(m.kind) ? { serverRevision: nextRevision } : {}) };
    sql.exec('INSERT INTO gen06_change_log VALUES(?,?)', seq, JSON.stringify(record));
    sql.exec('INSERT INTO gen06_entities VALUES(?,?,?,?,?,?) ON CONFLICT(kind,entity_key) DO UPDATE SET digest=excluded.digest,payload_json=excluded.payload_json,revision=excluded.revision,server_seq=excluded.server_seq', m.kind, m.entityKey, m.payloadDigest, JSON.stringify(p), nextRevision, seq);
    if (m.kind === 'bank_revision' && !rows(sql, 'SELECT bank_uid FROM gen06_bank_revisions WHERE bank_uid=? AND revision=?', p.bankUid, p.revision).length) {
      sql.exec('INSERT INTO gen06_bank_revisions VALUES(?,?,?)', p.bankUid, p.revision, JSON.stringify({ bankUid: p.bankUid, revision: p.revision, metadata: p.metadata, contentManifest: p.contentManifest }));
      const questions = p.contentManifest.kind === 'public_static' ? [...dependencies.publicRegistry.get(`${p.bankUid}:${p.revision}`).questions].map(([questionKey, questionRevision]) => ({ questionKey, questionRevision })) : p.contentManifest.kind === 'protected_cipher' ? (proof.protectedQuestions || []) : proof.bankQuestions;
      for (const question of questions) sql.exec('INSERT INTO gen06_bank_questions VALUES(?,?,?,?)', p.bankUid, p.revision, question.questionKey, question.questionRevision);
    }
    if (m.kind === 'attempt_scope') for (const row of proof.scope) sql.exec('INSERT INTO gen06_scope_rows VALUES(?,?,?,?)', p.attemptId, row.ordinal, row.questionKey, row.questionRevision);
    if (m.kind === 'answer_event') sql.exec('INSERT INTO gen06_event_actions VALUES(?,?,?,?,?,?)', p.event.attemptId, p.event.writerStreamId, String(p.event.actionSeq), p.event.eventId, m.payloadDigest, seq);
    if (m.kind === 'entity_tombstone') sql.exec('INSERT INTO gen06_entity_tombstones VALUES(?,?)', m.entityKey, generation);
    sql.exec('UPDATE gen06_sync_meta SET high_water=? WHERE id=1', seq);
    meta.high_water = seq;
    return storeReceipt(m, { mutationId: m.mutationId, payloadDigest: m.payloadDigest, status: 'accepted', serverSeq: seq, ...(CAS.has(m.kind) ? { currentRevision: nextRevision } : {}) });
  }
  return {
    readEntity(kind, key) { return payload(kind, key); },
    historySnapshotReferencesStatus,
    readResumeVersion(attemptId, contentDigest) {
      const record = rows(sql, "SELECT record_json FROM gen06_change_log WHERE json_extract(record_json,'$.kind')='resume_state' AND json_extract(record_json,'$.payload.attemptId')=? AND json_extract(record_json,'$.payload.contentDigest')=? LIMIT 1", attemptId, contentDigest)[0];
      return record ? JSON.parse(record.record_json).payload : null;
    },
    readHistoricalResumeProof(attemptId, contentDigest) {
      const record = rows(sql, "SELECT server_seq,record_json FROM gen06_change_log WHERE json_extract(record_json,'$.kind')='resume_state' AND json_extract(record_json,'$.payload.attemptId')=? AND json_extract(record_json,'$.payload.contentDigest')=? ORDER BY length(server_seq),server_seq LIMIT 1", attemptId, contentDigest)[0];
      if (!record) return null;
      const reference = JSON.parse(record.record_json).payload;
      const events = rows(sql, "SELECT record_json FROM gen06_change_log WHERE json_extract(record_json,'$.kind')='answer_event' AND json_extract(record_json,'$.payload.event.attemptId')=? AND json_extract(record_json,'$.payload.event.writerStreamId')=? AND (length(server_seq)<length(?) OR (length(server_seq)=length(?) AND server_seq<=?)) ORDER BY length(server_seq),server_seq", attemptId, reference.writerStreamId, record.server_seq, record.server_seq, record.server_seq).map(row => JSON.parse(row.record_json).payload.event);
      return { reference, serverSeq: record.server_seq, events };
    },
    withDependencies(value) { dependencies = value; return this; },
    info() { return { generation, logEpoch: meta.log_epoch, cursor: cursor(generation, meta.log_epoch, '0'), serverHighWater: meta.high_water }; },
    push(request) {
      const receipts = request.mutations.map(apply);
      return validatePushResponse({ protocolVersion: 2, generation, logEpoch: meta.log_epoch, receipts, serverHighWater: meta.high_water });
    },
    pull(request) {
      const after = decodeCursor(request.after);
      const until = request.until ? decodeCursor(request.until) : { accountGeneration: generation, logEpoch: meta.log_epoch, serverSeq: meta.high_water };
      if ([after, until].some(c => c.accountGeneration !== generation || c.logEpoch !== meta.log_epoch)
        || BigInt(after.serverSeq) > BigInt(until.serverSeq) || BigInt(until.serverSeq) > BigInt(meta.high_water)) throw error('CURSOR_UNAVAILABLE');
      const candidates = rows(sql, 'SELECT server_seq,record_json FROM gen06_change_log WHERE (length(server_seq)>length(?) OR (length(server_seq)=length(?) AND server_seq>?)) AND (length(server_seq)<length(?) OR (length(server_seq)=length(?) AND server_seq<=?)) ORDER BY length(server_seq),server_seq LIMIT ?', after.serverSeq, after.serverSeq, after.serverSeq, until.serverSeq, until.serverSeq, until.serverSeq, request.limit);
      const changes = [];
      const response = () => ({ protocolVersion: 2, changes, nextCursor: cursor(generation, meta.log_epoch, changes.at(-1)?.serverSeq || after.serverSeq), highWater: until.serverSeq, hasMore: BigInt(changes.at(-1)?.serverSeq || after.serverSeq) < BigInt(until.serverSeq), generation, logEpoch: meta.log_epoch });
      for (const row of candidates) {
        changes.push(JSON.parse(row.record_json));
        if (canonicalBytes(response()).byteLength > 512 * 1024) { changes.pop(); break; }
      }
      return validatePullResponse(response());
    },
  };
}

export function clearAccountSyncData(sql) {
  for (const table of [...SYNC_TABLES, ...CONTENT_TABLES, ...EXPORT_TABLES]) if (rows(sql, "SELECT name FROM sqlite_master WHERE type='table' AND name=?", table).length) sql.exec(`DELETE FROM ${table}`);
}
import { EXPORT_TABLES } from './account-export-repository.js';
