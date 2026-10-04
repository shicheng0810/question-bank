const HEX64 = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();
const CHUNK_BYTES = 256 * 1024;
const LIMITS = Object.freeze({ historyItems: 10, bankItems: 15, historyBytes: 409_600, bankBytes: 1_900_000, bankQuestions: 5000 });

function fail(code) { const error = new Error(code); error.code = code; throw error; }
function rows(sql, statement, ...values) { return sql.exec(statement, ...values).toArray(); }

function byteView(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

async function readBytes(kv, key) {
  let value;
  try { value = await kv.get(key, { type: 'arrayBuffer' }); }
  catch { fail('SOURCE_UNAVAILABLE'); }
  if (value == null) return null;
  const bytes = byteView(value);
  if (!bytes) fail('MIGRATION_QUARANTINED');
  return bytes;
}

function decode(bytes, missingValue, code = 'MIGRATION_QUARANTINED') {
  if (bytes === null) return missingValue;
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); }
  catch { fail(code); }
}

function splitArray(bytes, key) {
  if (bytes === null) return [];
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const totalLimit = key.startsWith('h:') ? LIMITS.historyItems * LIMITS.historyBytes : LIMITS.bankItems * LIMITS.bankBytes;
  if (encoder.encode(text).byteLength > totalLimit) fail('MIGRATION_QUARANTINED');
  let parsed;
  try { parsed = JSON.parse(text); } catch { fail('MIGRATION_QUARANTINED'); }
  if (!Array.isArray(parsed)) fail('MIGRATION_QUARANTINED');
  if (parsed.length > (key.startsWith('h:') ? LIMITS.historyItems : LIMITS.bankItems)) fail('MIGRATION_QUARANTINED');
  const result = [];
  let start = 0; let depth = 0; let inString = false; let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === '[' || char === '{') {
      if (char === '[' && depth === 0) start = index + 1;
      depth += 1;
    }
    else if (char === ']' || char === '}') {
      depth -= 1;
      if (depth < 0) fail('MIGRATION_QUARANTINED');
      if (char === ']' && depth === 0) {
        const raw = text.slice(start, index).trim();
        if (raw) result.push({ value: JSON.parse(raw), raw });
      }
    } else if (char === ',' && depth === 1) {
      const raw = text.slice(start, index).trim();
      if (raw) result.push({ value: JSON.parse(raw), raw });
      start = index + 1;
    }
  }
  if (parsed.length === 0) return [];
  if (result.length !== parsed.length) fail('MIGRATION_QUARANTINED');
  return result;
}

async function digest(bytes) {
  const value = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(value), byte => byte.toString(16).padStart(2, '0')).join('');
}

function boundedIdentity(expectedSub, freezeId) {
  if (typeof expectedSub !== 'string' || !HEX64.test(expectedSub)
    || typeof freezeId !== 'string' || freezeId.length < 16 || freezeId.length > 128) fail('INVALID_INPUT');
}

function readFrozenState(sql, expectedSub, freezeId) {
  const meta = rows(sql, 'SELECT k,v FROM meta WHERE k IN (?,?,?,?)', 'sub', 'imported', 'legacyMigrationFreeze', 'migrationDeleted');
  const values = new Map(meta.map(row => [row.k, row.v]));
  if (values.get('sub') !== expectedSub) fail('MIGRATION_UNCERTAIN');
  let stored;
  try { stored = JSON.parse(values.get('legacyMigrationFreeze') || 'null'); } catch { fail('MIGRATION_QUARANTINED'); }
  if (!stored || stored.version !== 1 || stored.expectedSub !== expectedSub || stored.freezeId !== freezeId) fail('MIGRATION_UNCERTAIN');
  const deleted = values.get('migrationDeleted') === '1';
  if (deleted) fail('ACCOUNT_DELETED');
  return { imported: values.get('imported') === '1', freeze: stored };
}

async function assertSourceCurrent({ sql, kv, expectedSub, freezeId }) {
  const state = readFrozenState(sql, expectedSub, freezeId);
  let tombstone; let accountBytes; let epoch;
  try {
    [tombstone, accountBytes, epoch] = await Promise.all([
      kv.get(`del:${expectedSub}`, { type: 'arrayBuffer' }),
      readBytes(kv, `u:${expectedSub}`),
      kv.get(`uepoch:${expectedSub}`),
    ]);
  } catch { fail('SOURCE_UNAVAILABLE'); }
  if (tombstone != null) fail('ACCOUNT_DELETED');
  if (accountBytes === null || !(epoch === null || (typeof epoch === 'string' && /^(?:0|[1-9]\d*)$/.test(epoch)))) fail('MIGRATION_UNCERTAIN');
  const account = decode(accountBytes, null);
  if (!account || account.sub !== expectedSub) fail('MIGRATION_UNCERTAIN');
  if (state.freeze.epoch !== epoch) fail('ACCOUNT_DELETED');
  const finalState = readFrozenState(sql, expectedSub, freezeId);
  if (finalState.freeze.epoch !== state.freeze.epoch || finalState.imported !== state.imported) fail('ACCOUNT_DELETED');
  return finalState;
}

export function legacyMigrationMetadata(sql) {
  const values = new Map(rows(sql, 'SELECT k,v FROM meta WHERE k IN (?,?,?,?)', 'sub', 'imported', 'legacyMigrationFreeze', 'migrationDeleted').map(row => [row.k, row.v]));
  return {
    ok: true,
    sub: typeof values.get('sub') === 'string' ? values.get('sub') : null,
    imported: values.get('imported') === '1',
    historyCount: Number(rows(sql, 'SELECT COUNT(*) AS count FROM history')[0]?.count || 0),
    bankCount: Number(rows(sql, 'SELECT COUNT(*) AS count FROM banks')[0]?.count || 0),
    frozen: values.has('legacyMigrationFreeze'),
  };
}

export async function freezeLegacyMigration({ sql, kv, expectedSub, freezeId }) {
  try {
    boundedIdentity(expectedSub, freezeId);
    const current = legacyMigrationMetadata(sql);
    if (rows(sql, 'SELECT v FROM meta WHERE k=?', 'migrationDeleted').length) fail('ACCOUNT_DELETED');
    if (current.sub !== null && current.sub !== expectedSub) fail('MIGRATION_UNCERTAIN');
    const existing = rows(sql, 'SELECT v FROM meta WHERE k=?', 'legacyMigrationFreeze')[0]?.v;
    if (existing) {
      let value;
      try { value = JSON.parse(existing); } catch { fail('MIGRATION_QUARANTINED'); }
      if (value.freezeId !== freezeId || value.expectedSub !== expectedSub) fail('MIGRATION_UNCERTAIN');
    } else {
      // Persist the write fence before external KV reads. Any in-flight writer
      // that resumes after an await must observe it before publishing SQL.
      sql.exec('INSERT INTO meta(k,v) VALUES(?,?)', 'legacyMigrationFreeze', JSON.stringify({ version: 1, expectedSub, freezeId, state: 'frozen' }));
    }

    let tombstone; let accountBytes; let epoch;
    try {
      [tombstone, accountBytes, epoch] = await Promise.all([
        kv.get(`del:${expectedSub}`, { type: 'arrayBuffer' }),
        readBytes(kv, `u:${expectedSub}`),
        kv.get(`uepoch:${expectedSub}`),
      ]);
    } catch { fail('SOURCE_UNAVAILABLE'); }
    if (tombstone != null) fail('ACCOUNT_DELETED');
    if (accountBytes === null) fail('MIGRATION_UNCERTAIN');
    if (!(epoch === null || (typeof epoch === 'string' && /^(?:0|[1-9]\d*)$/.test(epoch)))) fail('MIGRATION_UNCERTAIN');
    const account = decode(accountBytes, null);
    if (!account || account.sub !== expectedSub) fail('MIGRATION_UNCERTAIN');
    // A brand-new but valid UserStore has no prior meta.sub. Bind it to the
    // authenticated legacy principal while the durable freeze is already set.
    const boundSub = rows(sql, 'SELECT v FROM meta WHERE k=?', 'sub')[0]?.v;
    if (boundSub !== undefined && boundSub !== expectedSub) fail('MIGRATION_UNCERTAIN');
    if (boundSub === undefined) sql.exec('INSERT INTO meta(k,v) VALUES(?,?)', 'sub', expectedSub);
    const freezeRow = rows(sql, 'SELECT v FROM meta WHERE k=?', 'legacyMigrationFreeze')[0];
    const freeze = JSON.parse(freezeRow.v);
    if (freeze.epoch !== undefined && freeze.epoch !== epoch) fail('ACCOUNT_DELETED');
    if (freeze.epoch === undefined) {
      freeze.epoch = epoch;
      sql.exec('UPDATE meta SET v=? WHERE k=?', JSON.stringify(freeze), 'legacyMigrationFreeze');
    }
    const after = readFrozenState(sql, expectedSub, freezeId);
    const counts = legacyMigrationMetadata(sql);
    if (!after.imported && (counts.historyCount > 0 || counts.bankCount > 0)) fail('MIGRATION_UNCERTAIN');
    let historyTotal = counts.historyCount;
    let bankTotal = counts.bankCount;
    if (!after.imported) {
      const historyBytes = await readBytes(kv, `h:${expectedSub}`);
      await assertSourceCurrent({ sql, kv, expectedSub, freezeId });
      const history = splitArray(historyBytes, `h:${expectedSub}`);
      const bankBytes = await readBytes(kv, `bl:${expectedSub}`);
      await assertSourceCurrent({ sql, kv, expectedSub, freezeId });
      const banks = splitArray(bankBytes, `bl:${expectedSub}`);
      historyTotal = history.length;
      bankTotal = banks.length;
    }
    await assertSourceCurrent({ sql, kv, expectedSub, freezeId });
    return { ok: true, frozen: true, imported: after.imported, sourceKind: after.imported ? 'user-store-sqlite' : 'edits-kv-unimported', historyTotal, bankTotal };
  } catch (error) {
    const code = ['INVALID_INPUT', 'SOURCE_UNAVAILABLE', 'ACCOUNT_DELETED', 'MIGRATION_UNCERTAIN', 'MIGRATION_QUARANTINED'].includes(error?.code)
      ? error.code : 'SOURCE_UNAVAILABLE';
    return { ok: false, error: code };
  }
}

async function sourceItems({ sql, kv, expectedSub, freezeId, section }) {
  const { imported } = await assertSourceCurrent({ sql, kv, expectedSub, freezeId });

  if (imported) {
    if (section === 'history') {
      return rows(sql, 'SELECT id,ts,bank_id,json FROM history ORDER BY id');
    }
    return rows(sql, 'SELECT id,ts,meta,questions FROM banks ORDER BY id');
  }

  if (section === 'history') {
    const bytes = await readBytes(kv, `h:${expectedSub}`);
    await assertSourceCurrent({ sql, kv, expectedSub, freezeId });
    const items = splitArray(bytes, `h:${expectedSub}`);
    return items.map(({ value, raw }) => ({ id: typeof value?.id === 'string' ? value.id : '', ts: value?.ts, bank_id: value?.bank_id, json: raw }));
  }
  const bytes = await readBytes(kv, `bl:${expectedSub}`);
  await assertSourceCurrent({ sql, kv, expectedSub, freezeId });
  const items = splitArray(bytes, `bl:${expectedSub}`);
  const result = [];
  for (const { value, raw: meta } of items) {
    if (!value || typeof value.id !== 'string' || !/^[a-z0-9_][a-z0-9_-]*$/.test(value.id)) fail('MIGRATION_QUARANTINED');
    const questionBytes = await readBytes(kv, `b:${expectedSub}:${value.id}`);
    await assertSourceCurrent({ sql, kv, expectedSub, freezeId });
    if (questionBytes === null) fail('MIGRATION_QUARANTINED');
    const questions = decode(questionBytes, null);
    if (!Array.isArray(questions) || questions.length < 1 || questions.length > LIMITS.bankQuestions
      || questionBytes.byteLength > LIMITS.bankBytes) fail('MIGRATION_QUARANTINED');
    if (value.count !== undefined && value.count !== questions.length) fail('MIGRATION_QUARANTINED');
    if (!declaredBankLengths(value, questionBytes).accepted) fail('MIGRATION_QUARANTINED');
    result.push({ id: value.id, ts: value.ts, meta, questions: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(questionBytes) });
  }
  return result;
}

// Chunk retries must not materialize every private bank's question payload.
// The source freeze makes both the SQLite and KV index stable; read the bounded
// index, then only the requested record and revalidate the freeze after awaits.
async function sourceItemById({ sql, kv, expectedSub, freezeId, section, id }) {
  const { imported } = await assertSourceCurrent({ sql, kv, expectedSub, freezeId });
  if (imported) {
    const result = section === 'history'
      ? rows(sql, 'SELECT id,ts,bank_id,json FROM history WHERE id=?', id)
      : rows(sql, 'SELECT id,ts,meta,questions FROM banks WHERE id=?', id);
    if (result.length > 1) fail('MIGRATION_QUARANTINED');
    return result[0] || null;
  }

  if (section === 'history') {
    const bytes = await readBytes(kv, `h:${expectedSub}`);
    await assertSourceCurrent({ sql, kv, expectedSub, freezeId });
    const entries = splitArray(bytes, `h:${expectedSub}`);
    const matches = entries.filter(({ value }) => value?.id === id);
    if (matches.length > 1) fail('MIGRATION_QUARANTINED');
    if (!matches.length) return null;
    return { id, ts: matches[0].value?.ts, bank_id: matches[0].value?.bank_id, json: matches[0].raw };
  }

  const indexBytes = await readBytes(kv, `bl:${expectedSub}`);
  await assertSourceCurrent({ sql, kv, expectedSub, freezeId });
  const entries = splitArray(indexBytes, `bl:${expectedSub}`);
  const matches = entries.filter(({ value }) => value?.id === id);
  if (matches.length > 1) fail('MIGRATION_QUARANTINED');
  if (!matches.length) return null;
  const value = matches[0].value;
  if (typeof value.id !== 'string' || !/^[a-z0-9_][a-z0-9_-]{0,47}$/.test(value.id)) fail('MIGRATION_QUARANTINED');
  const questionBytes = await readBytes(kv, `b:${expectedSub}:${value.id}`);
  await assertSourceCurrent({ sql, kv, expectedSub, freezeId });
  if (questionBytes === null) fail('MIGRATION_QUARANTINED');
  const questions = decode(questionBytes, null);
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > LIMITS.bankQuestions
    || questionBytes.byteLength > LIMITS.bankBytes
    || (value.count !== undefined && value.count !== questions.length)
    || !declaredBankLengths(value, questionBytes).accepted) fail('MIGRATION_QUARANTINED');
  return { id: value.id, ts: value.ts, meta: matches[0].raw,
    questions: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(questionBytes) };
}

async function sourceBankDescriptors({ sql, kv, expectedSub, freezeId }) {
  const { imported } = await assertSourceCurrent({ sql, kv, expectedSub, freezeId });
  let descriptors;
  if (imported) {
    descriptors = rows(sql, 'SELECT id,ts,meta FROM banks ORDER BY id').map(row => ({
      id: row.id, ts: row.ts, meta: row.meta,
    }));
  } else {
    const indexBytes = await readBytes(kv, `bl:${expectedSub}`);
    await assertSourceCurrent({ sql, kv, expectedSub, freezeId });
    descriptors = splitArray(indexBytes, `bl:${expectedSub}`).map(({ value, raw }) => ({
      id: typeof value?.id === 'string' ? value.id : '', ts: value?.ts, meta: raw,
    }));
  }
  const sorted = validateAndSort(descriptors, 'banks');
  if (sorted.length > LIMITS.bankItems) fail('MIGRATION_QUARANTINED');
  return { imported, descriptors: sorted };
}

async function bankSummary({ sql, kv, expectedSub, freezeId, imported, descriptor }) {
  let questionBytes;
  if (imported) {
    const result = rows(sql, 'SELECT questions FROM banks WHERE id=?', descriptor.id);
    if (result.length !== 1) fail('MIGRATION_QUARANTINED');
    questionBytes = encoder.encode(result[0].questions);
  } else {
    questionBytes = await readBytes(kv, `b:${expectedSub}:${descriptor.id}`);
    await assertSourceCurrent({ sql, kv, expectedSub, freezeId });
    if (questionBytes === null) fail('MIGRATION_QUARANTINED');
  }
  const metaBytes = encoder.encode(descriptor.meta);
  const checked = checkBankPayload(descriptor.id, metaBytes, questionBytes);
  if (checked.stage !== 'OK') fail('MIGRATION_QUARANTINED');
  const { meta, questions } = checked;
  return {
    id: descriptor.id, sourceKey: `bank:${descriptor.id}`, title: typeof meta.title === 'string' ? meta.title : descriptor.id,
    ts: Number.isSafeInteger(meta.ts) ? meta.ts : 0, count: questions.length, questionCount: questions.length,
    byteLength: questionBytes.byteLength, sha256: await digest(questionBytes),
    chunkCount: Math.max(1, Math.ceil(questionBytes.byteLength / CHUNK_BYTES)),
    metaByteLength: metaBytes.byteLength, metaSha256: await digest(metaBytes),
    ...(!checked.checks.bytesMatch ? { reportedByteLengthMismatch:true, lengthDeclarationKind:'legacy-utf16-code-units' } : {}),
  };
}

function declaredBankLengths(meta, questionBytes) {
  const utf8Matches = meta.bytes === undefined || meta.bytes === questionBytes.byteLength;
  // Legacy commit 45e75e4 stored payload.length (UTF-16 code units), not bytes.
  // Accept only these two exact historical declarations; never normalize source.
  const codeUnitsMatch = meta.bytes !== undefined
    && meta.bytes === new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(questionBytes).length;
  return {utf8Matches,codeUnitsMatch,accepted:utf8Matches||codeUnitsMatch};
}

// The export summary and trusted diagnostic share these exact pure predicates.
function checkBankPayload(id, metaBytes, questionBytes) {
  const checks = { questionsWithinBounds:null, questionsBytesWithinBounds:questionBytes.byteLength <= LIMITS.bankBytes,
    metaIdMatches:null, countMatches:null, bytesMatch:null, legacyCodeUnitLengthMatches:null, metaWithinChunkBound:metaBytes.byteLength <= CHUNK_BYTES };
  const failed = stage => ({ stage, checks });
  if (!checks.questionsBytesWithinBounds) return failed('QUESTION_BYTES');
  let questions;
  try { questions = decode(questionBytes, null); } catch { return failed('QUESTIONS_JSON'); }
  checks.questionsWithinBounds = Array.isArray(questions) && questions.length >= 1 && questions.length <= LIMITS.bankQuestions;
  if (!checks.questionsWithinBounds) return failed('QUESTIONS_COUNT');
  let meta;
  try { meta = decode(metaBytes, null); } catch { return failed('META_JSON'); }
  checks.metaIdMatches = !!meta && meta.id === id;
  if (!checks.metaIdMatches) return failed('META_ID');
  checks.countMatches = meta.count === undefined || meta.count === questions.length;
  if (!checks.countMatches) return failed('META_COUNT');
  const lengths = declaredBankLengths(meta, questionBytes);
  checks.bytesMatch = lengths.utf8Matches;
  checks.legacyCodeUnitLengthMatches = lengths.codeUnitsMatch;
  if (!lengths.accepted) return failed('META_BYTES');
  return { stage:'OK', checks, meta, questions };
}

export function legacyMigrationSourceDiagnostics(sql) {
  try {
    const metadata = legacyMigrationMetadata(sql);
    const source = rows(sql, 'SELECT id,length(CAST(meta AS BLOB)) AS meta_bytes,length(CAST(questions AS BLOB)) AS question_bytes,typeof(meta) AS meta_type,typeof(questions) AS question_type FROM banks ORDER BY id LIMIT 16');
    const seen = new Set();
    const banks = source.slice(0, LIMITS.bankItems).map((row, ordinal) => {
      const idValid = typeof row.id === 'string' && /^[a-z0-9_][a-z0-9_-]{0,47}$/.test(row.id);
      const duplicateId = seen.has(row.id); seen.add(row.id);
      const checks = {questionsWithinBounds:null,questionsBytesWithinBounds:Number.isSafeInteger(row.question_bytes)&&row.question_bytes<=LIMITS.bankBytes,
        metaIdMatches:null,countMatches:null,bytesMatch:null,legacyCodeUnitLengthMatches:null,metaWithinChunkBound:Number.isSafeInteger(row.meta_bytes)&&row.meta_bytes<=CHUNK_BYTES};
      let checked;
      if (!checks.questionsBytesWithinBounds) checked={stage:'QUESTION_BYTES',checks};
      else if (!checks.metaWithinChunkBound) checked={stage:'META_CHUNK_BOUND',checks};
      else if (row.question_type!=='text') checked={stage:'QUESTIONS_JSON',checks};
      else if (row.meta_type!=='text') checked={stage:'META_JSON',checks};
      else {
        const payload=rows(sql,'SELECT meta,questions FROM banks WHERE id=?',row.id)[0];
        if (!payload) return {ordinal,stage:'QUESTIONS_JSON',idValid,duplicateId,...checks};
        checked=checkBankPayload(row.id,encoder.encode(payload.meta),encoder.encode(payload.questions));
      }
      const stage = !idValid ? 'BANK_ID' : duplicateId ? 'BANK_DUPLICATE' : checked.stage !== 'OK' ? checked.stage
        : checked.checks.bytesMatch===false ? 'META_BYTES'
        : !checked.checks.metaWithinChunkBound ? 'META_CHUNK_BOUND' : 'OK';
      return { ordinal, stage, idValid, duplicateId, ...checked.checks };
    });
    return { ok:true, imported:metadata.imported, frozen:metadata.frozen, deleted:isLegacyMigrationDeleted(sql),
      historyCount:metadata.historyCount, bankCount:metadata.bankCount, truncated:source.length > LIMITS.bankItems, banks };
  } catch { return {ok:false,error:'UNAVAILABLE'}; }
}

function validateAndSort(items, section) {
  const seen = new Set();
  for (const item of items) {
    const valid = section === 'history'
      ? typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 64
      : typeof item.id === 'string' && /^[a-z0-9_][a-z0-9_-]{0,47}$/.test(item.id);
    if (!valid || seen.has(item.id)) fail('MIGRATION_QUARANTINED');
    seen.add(item.id);
  }
  return items.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

export async function legacyMigrationExportPage({ sql, kv, expectedSub, freezeId, section, cursor = null, limit = 5 }) {
  try {
    boundedIdentity(expectedSub, freezeId);
    if (!['history', 'banks'].includes(section) || !(cursor === null || (typeof cursor === 'string' && cursor.length <= 256))
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 5) fail('INVALID_INPUT');
    if (section === 'banks') {
      const source = await sourceBankDescriptors({ sql, kv, expectedSub, freezeId });
      const filtered = source.descriptors.filter(item => cursor === null || item.id > cursor);
      const page = filtered.slice(0, limit);
      const items = [];
      for (const descriptor of page) items.push(await bankSummary({ sql, kv, expectedSub, freezeId, imported: source.imported, descriptor }));
      const currentState = await assertSourceCurrent({ sql, kv, expectedSub, freezeId });
      return { ok: true, sourceKind: currentState.imported ? 'user-store-sqlite' : 'edits-kv-unimported', items,
        nextCursor: filtered.length > page.length ? page.at(-1).id : null };
    }
    const source = validateAndSort(await sourceItems({ sql, kv, expectedSub, freezeId, section }), section);
    if (source.length > (section === 'history' ? LIMITS.historyItems : LIMITS.bankItems)) fail('MIGRATION_QUARANTINED');
    const filtered = source.filter(item => cursor === null || item.id > cursor);
    const page = filtered.slice(0, limit);
    const items = [];
    for (const item of page) {
      if (section === 'history') {
        const bytes = encoder.encode(item.json);
        if (bytes.byteLength > LIMITS.historyBytes) fail('MIGRATION_QUARANTINED');
        const parsed = decode(bytes, null);
        if (!parsed || typeof parsed.id !== 'string' || parsed.id !== item.id) fail('MIGRATION_QUARANTINED');
        items.push({
          id: item.id, sourceKey: `history:${item.id}`, bank_id: String(parsed.bank_id || ''),
          title: typeof parsed.title === 'string' ? parsed.title : String(parsed.bank_id || ''),
          ts: Number.isSafeInteger(parsed.ts) ? parsed.ts : 0,
          viewMode: typeof parsed.viewMode === 'string' ? parsed.viewMode : 'all',
          count: Number.isSafeInteger(parsed.count) && parsed.count >= 0 ? parsed.count : 0,
          byteLength: bytes.byteLength, sha256: await digest(bytes),
          chunkCount: Math.max(1, Math.ceil(bytes.byteLength / CHUNK_BYTES)),
        });
      } else {
        const metaBytes = encoder.encode(item.meta);
        const questionsBytes = encoder.encode(item.questions);
        if (questionsBytes.byteLength > LIMITS.bankBytes) fail('MIGRATION_QUARANTINED');
        const meta = decode(metaBytes, null);
        const questions = decode(questionsBytes, null);
        if (!meta || meta.id !== item.id || !Array.isArray(questions)) fail('MIGRATION_QUARANTINED');
        const questionCount = questions.length;
        if (meta.count !== undefined && meta.count !== questionCount) fail('MIGRATION_QUARANTINED');
        items.push({
          id: item.id, sourceKey: `bank:${item.id}`, title: typeof meta.title === 'string' ? meta.title : item.id,
          ts: Number.isSafeInteger(meta.ts) ? meta.ts : 0, count: questionCount, questionCount,
          byteLength: questionsBytes.byteLength, sha256: await digest(questionsBytes),
          chunkCount: Math.max(1, Math.ceil(questionsBytes.byteLength / CHUNK_BYTES)),
          metaByteLength: metaBytes.byteLength, metaSha256: await digest(metaBytes),
        });
      }
    }
    const currentState = await assertSourceCurrent({ sql, kv, expectedSub, freezeId });
    return { ok: true, sourceKind: currentState.imported ? 'user-store-sqlite' : 'edits-kv-unimported', items, nextCursor: filtered.length > page.length ? page.at(-1).id : null };
  } catch (error) {
    const code = ['INVALID_INPUT', 'SOURCE_UNAVAILABLE', 'ACCOUNT_DELETED', 'MIGRATION_UNCERTAIN', 'MIGRATION_QUARANTINED'].includes(error?.code)
      ? error.code : 'MIGRATION_QUARANTINED';
    return { ok: false, error: code };
  }
}

export async function legacyMigrationExportChunk({ sql, kv, expectedSub, freezeId, section, id, part = null, chunkIndex = 0 }) {
  try {
    boundedIdentity(expectedSub, freezeId);
    if (!['history', 'banks'].includes(section) || typeof id !== 'string' || id.length < 1 || id.length > 80
      || !Number.isSafeInteger(chunkIndex) || chunkIndex < 0
      || (section === 'banks' && !['meta', 'questions'].includes(part))) fail('INVALID_INPUT');
    const item = await sourceItemById({ sql, kv, expectedSub, freezeId, section, id });
    if (!item) return { ok: true, found: false };
    const sourceKey = section === 'history' ? `history:${id}` : `bank:${id}:${part}`;
    const raw = section === 'history' ? item.json : part === 'meta' ? item.meta : item.questions;
    const rawBytes = encoder.encode(raw);
    if ((section === 'history' && rawBytes.byteLength > LIMITS.historyBytes)
      || (section === 'banks' && part === 'meta' && rawBytes.byteLength > CHUNK_BYTES)
      || (section === 'banks' && part === 'questions' && rawBytes.byteLength > LIMITS.bankBytes)) fail('MIGRATION_QUARANTINED');
    const sourceDigest = await digest(rawBytes);
    if (section === 'history' && rawBytes.byteLength > LIMITS.historyBytes) fail('MIGRATION_QUARANTINED');
    if (section === 'banks' && part === 'meta' && rawBytes.byteLength > CHUNK_BYTES) fail('MIGRATION_QUARANTINED');
    if (section === 'banks' && part === 'questions' && rawBytes.byteLength > LIMITS.bankBytes) fail('MIGRATION_QUARANTINED');
    const chunkCount = Math.max(1, Math.ceil(rawBytes.byteLength / CHUNK_BYTES));
    if (chunkIndex >= chunkCount) fail('INVALID_INPUT');
    const bytes = rawBytes.slice(chunkIndex * CHUNK_BYTES, Math.min((chunkIndex + 1) * CHUNK_BYTES, rawBytes.byteLength));
    const chunkDigest = await digest(bytes);
    await assertSourceCurrent({ sql, kv, expectedSub, freezeId });
    return { ok: true, found: true, sourceKey, sourceDigest, byteLength: rawBytes.byteLength, chunkIndex, chunkCount, chunkDigest, bytes };
  } catch (error) {
    const code = ['INVALID_INPUT', 'SOURCE_UNAVAILABLE', 'ACCOUNT_DELETED', 'MIGRATION_UNCERTAIN', 'MIGRATION_QUARANTINED'].includes(error?.code)
      ? error.code : 'MIGRATION_QUARANTINED';
    return { ok: false, error: code };
  }
}

export function isLegacyMigrationFrozen(sql) {
  return rows(sql, 'SELECT v FROM meta WHERE k=?', 'legacyMigrationFreeze').length > 0;
}

export function isLegacyMigrationDeleted(sql) {
  return rows(sql, 'SELECT v FROM meta WHERE k=?', 'migrationDeleted').length > 0;
}

export function markLegacyMigrationDeleted(sql, sub) {
  const currentSub = rows(sql, 'SELECT v FROM meta WHERE k=?', 'sub')[0]?.v;
  if (currentSub !== undefined && currentSub !== sub) fail('MIGRATION_UNCERTAIN');
  sql.exec('INSERT OR REPLACE INTO meta(k,v) VALUES(?,?)', 'sub', sub);
  sql.exec('INSERT OR REPLACE INTO meta(k,v) VALUES(?,?)', 'migrationDeleted', '1');
  // Keep the freeze identity and source epoch across purges. If deletion races
  // export, all later source reads observe this marker and cannot seal/import.
  const freeze = rows(sql, 'SELECT v FROM meta WHERE k=?', 'legacyMigrationFreeze')[0]?.v;
  if (!freeze) sql.exec('INSERT INTO meta(k,v) VALUES(?,?)', 'legacyMigrationFreeze', JSON.stringify({ version: 1, expectedSub: sub, freezeId: `deleted:${sub}`, state: 'deleted' }));
  sql.exec('DELETE FROM history');
  sql.exec('DELETE FROM banks');
  sql.exec("INSERT OR REPLACE INTO meta(k,v) VALUES('imported','1')");
  sql.exec("DELETE FROM meta WHERE k='statsig'");
}
