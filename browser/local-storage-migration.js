const FORMAT = 'qb-browser-localstorage-export-v1';
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_RECORD_BYTES = 1024 * 1024;
const MAX_RECORDS = 128;
const SAFE_KEY = /^(?:amt_(?:starred_questions|wrong_questions|attempt_count_map_v1|conquered_questions_v1)|qb_(?:activity_days_v1|local_banks_v1|daily_goal_v1)|[A-Za-z0-9_-]{1,64}_(?:starred_questions|wrong_questions|attempt_count_map_v1|conquered_questions_v1|last_active_v1))$/;

export class BrowserMigrationError extends Error {
  constructor(code) { super(code); this.name = 'BrowserMigrationError'; this.code = code; }
}
const fail = (code) => { throw new BrowserMigrationError(code); };
const enc = new TextEncoder();
async function digest(value, subtle = globalThis.crypto?.subtle) {
  if (!subtle) fail('DIGEST_UNAVAILABLE');
  const bytes = typeof value === 'string' ? enc.encode(value) : value;
  return Array.from(new Uint8Array(await subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
}
function payloadFor(value) { return JSON.stringify({ format: FORMAT, version: 1, sourceOrigin: value.sourceOrigin, createdAt: value.createdAt, records: value.records }); }
function stablePayloadFor(value) { return JSON.stringify({ format: FORMAT, version: 1, sourceOrigin: value.sourceOrigin, records: value.records }); }

/** Scan only known learning-state key families; auth/session and unrelated app keys are never read. */
export async function scanBrowserLearningState(storage = globalThis.localStorage, { sourceOrigin = globalThis.location?.origin || 'unknown', subtle } = {}) {
  if (!storage || typeof storage.length !== 'number' || typeof storage.key !== 'function' || typeof storage.getItem !== 'function') fail('STORAGE_UNAVAILABLE');
  if (typeof sourceOrigin !== 'string' || sourceOrigin.length > 2048) fail('INVALID_ORIGIN');
  const records = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (typeof key !== 'string' || !SAFE_KEY.test(key)) continue;
    const rawValue = storage.getItem(key);
    if (typeof rawValue !== 'string') continue;
    const byteLength = enc.encode(rawValue).byteLength;
    if (byteLength > MAX_RECORD_BYTES) fail('RECORD_TOO_LARGE');
    records.push({ key, rawValue, byteLength, sha256: await digest(rawValue, subtle) });
    if (records.length > MAX_RECORDS) fail('TOO_MANY_RECORDS');
  }
  records.sort((a, b) => a.key.localeCompare(b.key));
  const value = { format: FORMAT, version: 1, sourceOrigin, createdAt: Date.now(), records };
  const body = payloadFor(value), byteLength = enc.encode(body).byteLength;
  if (byteLength > MAX_TOTAL_BYTES) fail('EXPORT_TOO_LARGE');
  return { ...value, byteLength, sha256: await digest(body, subtle), dataDigest: await digest(stablePayloadFor(value), subtle) };
}

export async function validateBrowserLearningExport(input, { subtle } = {}) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype || input.format !== FORMAT || input.version !== 1
    || typeof input.sourceOrigin !== 'string' || input.sourceOrigin.length > 2048 || !Number.isSafeInteger(input.createdAt)
    || !Array.isArray(input.records) || input.records.length > MAX_RECORDS || !/^[0-9a-f]{64}$/.test(input.sha256 || '') || !/^[0-9a-f]{64}$/.test(input.dataDigest || '')) fail('INVALID_EXPORT');
  const records = [], seen = new Set(); let total = 0;
  for (const item of input.records) {
    if (!item || Object.getPrototypeOf(item) !== Object.prototype || typeof item.key !== 'string' || !SAFE_KEY.test(item.key)
      || seen.has(item.key) || typeof item.rawValue !== 'string' || !Number.isSafeInteger(item.byteLength) || item.byteLength < 0
      || !/^[0-9a-f]{64}$/.test(item.sha256 || '')) fail('INVALID_EXPORT');
    const byteLength = enc.encode(item.rawValue).byteLength;
    if (byteLength !== item.byteLength || byteLength > MAX_RECORD_BYTES || await digest(item.rawValue, subtle) !== item.sha256) fail('DIGEST_MISMATCH');
    total += byteLength; if (total > MAX_TOTAL_BYTES) fail('EXPORT_TOO_LARGE');
    seen.add(item.key); records.push({ key: item.key, rawValue: item.rawValue, byteLength, sha256: item.sha256 });
  }
  const value = { format: FORMAT, version: 1, sourceOrigin: input.sourceOrigin, createdAt: input.createdAt, records };
  const body = payloadFor(value);
  if (enc.encode(body).byteLength > MAX_TOTAL_BYTES || await digest(body, subtle) !== input.sha256 || await digest(stablePayloadFor(value), subtle) !== input.dataDigest) fail('DIGEST_MISMATCH');
  if (enc.encode(JSON.stringify(input)).byteLength > MAX_TOTAL_BYTES) fail('EXPORT_TOO_LARGE');
  return { ...value, sha256: input.sha256, dataDigest: input.dataDigest, byteLength: enc.encode(body).byteLength, records: structuredClone(records) };
}

export async function createBrowserLearningExport(storage, options) {
  const value = await scanBrowserLearningState(storage, options);
  const file=JSON.stringify({ format: value.format, version: 1, sourceOrigin: value.sourceOrigin, createdAt: value.createdAt, records: value.records, sha256: value.sha256, dataDigest: value.dataDigest }),byteLength=enc.encode(file).byteLength;
  if(byteLength>MAX_TOTAL_BYTES)fail('EXPORT_TOO_LARGE');
  return { file, summary: { sourceOrigin: value.sourceOrigin, createdAt: value.createdAt, keyCount: value.records.length, byteLength, sha256: value.sha256, dataDigest: value.dataDigest, namespaces: [...new Set(value.records.map(row => row.key.replace(/_(?:starred_questions|wrong_questions|attempt_count_map_v1|conquered_questions_v1|last_active_v1)$/, '')))], records: value.records.map(({key,byteLength,sha256})=>({key,byteLength,sha256})) } };
}

/** Prepare a narrow, raw-preserving local archive import. Every known key is
 * retained verbatim; parsed values remain explicitly unmapped legacy evidence. */
export function prepareBrowserLearningImport(value, { importedAt = Date.now() } = {}) {
  if (!value || value.format !== FORMAT || value.version !== 1 || !Array.isArray(value.records) || value.records.length === 0
    || !Number.isSafeInteger(importedAt) || !/^[0-9a-f]{64}$/.test(value.dataDigest || '')) fail('INVALID_EXPORT');
  // Include the stable snapshot digest in sourceId because legacy_aggregates' primary
  // key omits that field; distinct exports from the same browser must coexist.
  const sourceId = `browser-localstorage-v1:${value.dataDigest}`, sourceRecordId = `${value.sourceOrigin}:${value.dataDigest}`;
  const migrationId = `${value.dataDigest.slice(0,8)}-${value.dataDigest.slice(8,12)}-4${value.dataDigest.slice(13,16)}-8${value.dataDigest.slice(17,20)}-${value.dataDigest.slice(20,32)}`;
  const raw = [], aggregates = [];
  for (let chunkIndex = 0; chunkIndex < value.records.length; chunkIndex += 1) {
    const row = value.records[chunkIndex];
    const common = { sourceId, sourceDigest: value.dataDigest, sourceOrigin: value.sourceOrigin, namespace: row.key,
      rawFormat: FORMAT, rawBytes: row.byteLength, disposition: 'unknown' };
    raw.push({ ...common, chunkIndex, raw: row.rawValue });
    let aggregate, mappingStatus = 'unknown', disposition = 'unknown';
    try { aggregate = JSON.parse(row.rawValue); } catch { aggregate = row.rawValue; mappingStatus = disposition = 'quarantined'; }
    aggregates.push({ ...common, disposition, legacyQuestionId: row.key, aggregate, mappingStatus });
  }
  return {
    sourceId, sourceRecordId, sourceDigest: value.dataDigest,
    records: [
      ...raw.map(value => ({ store: 'legacy_raw', value })),
      ...aggregates.map(value => ({ store: 'legacy_aggregates', value })),
      { store: 'migration_journal', value: { migrationId, status: 'COMMITTED', counts: { raw: raw.length, aggregates: aggregates.length, unknown: aggregates.filter(row => row.mappingStatus === 'unknown').length, quarantined: aggregates.filter(row => row.mappingStatus === 'quarantined').length }, checkpoint: { sourceId, sourceRecordId, sourceDigest: value.dataDigest } } },
      { store: 'import_receipts', value: { sourceId, sourceRecordId, provenance: { format: FORMAT, sourceOrigin: value.sourceOrigin, sourceDigest: value.dataDigest, migrationId, recordCount: raw.length, target: 'legacy_raw+legacy_aggregates', answerEventsCreated: 0 }, importedAt } },
    ],
  };
}
