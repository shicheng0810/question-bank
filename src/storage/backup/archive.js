import { Zip, AsyncZipDeflate, Unzip, UnzipInflate } from 'fflate';
import { canonicalBytes, sha256Hex, validateChunkManifest, validateExportManifest } from '../../domain/app-data/index.js';
import { snapshotOwner, sameOwner } from '../profiles/control-schema.js';
import { LIMITS, LEGACY_STORE_NAMES, STORE_NAMES, backupError, validateSnapshot, ownSnapshot } from './snapshot.js';

const encoder = new TextEncoder();
const decoder = () => new TextDecoder('utf-8', { fatal: true });
const safePath = path => /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(path) && !path.split('/').some(part => part === '.' || part === '..');
const concat = parts => { const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0)); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length; } return bytes; };
const yieldTurn = () => new Promise(resolve => setTimeout(resolve, 0));
const guard = signal => { if (signal?.aborted) throw backupError('CLOSED'); };
async function hasImportedHistorySnapshotBody(rows) {
  const chunks = new Map(rows.map(row => [`${row.contentDigest}:${row.chunkIndex}`, row.bytes]));
  for (const row of rows) {
    if (row.chunkIndex !== 0 || await sha256Hex(row.bytes) !== row.contentDigest) continue;
    let manifest;
    try { manifest = JSON.parse(decoder().decode(row.bytes)); } catch { continue; }
    try { validateChunkManifest(manifest); } catch { continue; }
    if (manifest.contentDigest !== row.contentDigest || manifest.totalBytes > 3 * 1024 * 1024) continue;
    const body = new Uint8Array(manifest.totalBytes); let offset = 0, complete = true;
    for (const part of manifest.chunks) {
      const bytes = chunks.get(`${manifest.contentDigest}:${part.chunkIndex}`);
      if (!bytes || bytes.byteLength !== part.byteLength || await sha256Hex(bytes) !== part.sha256) { complete = false; break; }
      body.set(bytes, offset); offset += bytes.byteLength;
    }
    if (complete && offset === body.byteLength && await sha256Hex(body) === manifest.contentDigest) {
      try { if (JSON.parse(decoder().decode(body))?.type === 'imported_history_snapshot') return true; } catch { /* referenced malformed content fails normal validation */ }
    }
  }
  return false;
}

/** No credentials, running lease, device clock/stream or server cursor is exported.
 * Historical facts, their original stream/sequence and pending outbox are retained.
 */
export async function encodeBackup(snapshot, { owner, sourceProfileHint = '', appVersion = 'qb-v2-local', signal } = {}) {
  const binding = snapshotOwner(owner);
  snapshot = ownSnapshot(snapshot);
  await validateSnapshot(snapshot, binding); guard(signal);
  const files = [], sections = [];
  async function add(path, bytes, count) {
    if (bytes.length > LIMITS.fileBytes) throw backupError('BACKUP_BUDGET_EXCEEDED');
    files.push({ path, bytes }); sections.push({ path, count, utf8Bytes: bytes.length, sha256: await sha256Hex(bytes) });
  }
  await add('owner.json', canonicalBytes(binding), 1);
  for (const name of STORE_NAMES) {
    const lines = []; let fileSize = 0, part = 0, rows = 0;
    const flush = async () => { await add(`stores/${name}-${part++}.ndjson`, concat(lines.splice(0)), rows); rows = 0; fileSize = 0; };
    const values = ['writer_leases', 'meta'].includes(name) ? [] : name === 'import_receipts' ? snapshot[name].filter(row => !row.sourceId.startsWith('qb-sync-v2:') || row.provenance?.format==='qb-sync-change-v1') : snapshot[name];
    for (const row of values) {
      guard(signal); let serial = row;
      if (name === 'content_chunks') {
        const path = `content/${row.contentDigest}-${row.chunkIndex}.bin`;
        await add(path, row.bytes, 1);
        serial = { contentDigest: row.contentDigest, chunkIndex: row.chunkIndex, binaryPath: path };
      }
      const bytes = encoder.encode(`${decoder().decode(canonicalBytes(serial))}\n`);
      if (fileSize && fileSize + bytes.length > LIMITS.fileBytes) await flush();
      lines.push(bytes); fileSize += bytes.length; rows++;
    }
    await flush(); // Empty excluded stores remain explicit in the 19-store ledger.
  }
  const manifest = { format: 'qb-appdata-v2', schemaVersion: 2, storeSetVersion: 2, exportId: crypto.randomUUID(), appVersion, sourceProfileHint,
    sections, legacySourceDigests: [], complete: true, partial: false, coverage: { facts: true, attempts: true, drafts: true, mutations: true, outbox: true, conflicts: true, tombstones: true, legacy: true, content: true }, partialReasons: [] };
  validateExportManifest(manifest);
  const expanded = files.reduce((sum, file) => sum + file.bytes.length, 0);
  if (expanded > LIMITS.expandedBytes || files.length + 1 > LIMITS.entries) throw backupError('BACKUP_BUDGET_EXCEEDED');
  files.push({ path: 'manifest.json', bytes: canonicalBytes(manifest) });
  const parts = []; let archiveSize = 0, zip, pendingEntryReject, firstFailure;
  const abort = () => { const error = firstFailure ??= backupError('CLOSED'); zip?.terminate(); pendingEntryReject?.(error); rejectArchive?.(error); };
  let rejectArchive;
  const complete = new Promise((resolve, reject) => {
    rejectArchive = reject;
    zip = new Zip((error, bytes, final) => {
      if (error) { firstFailure ??= error; pendingEntryReject?.(firstFailure); reject(firstFailure); return; }
      archiveSize += bytes.length;
      if (archiveSize > LIMITS.archiveBytes || signal?.aborted) { firstFailure ??= backupError(signal?.aborted ? 'CLOSED' : 'BACKUP_BUDGET_EXCEEDED'); zip.terminate(); pendingEntryReject?.(firstFailure); reject(firstFailure); return; }
      parts.push(bytes); if (final) resolve();
    });
  });
  // A rejection may precede the eventual await (e.g. an abort while pushing).
  void complete.catch(() => {});
  signal?.addEventListener('abort', abort, { once: true });
  try {
    guard(signal);
    // Independent async compressor per file; push bounded blocks, retaining only
    // the already captured consistent slice and compressed Blob parts.
    for (const file of files) {
      guard(signal);
      const stream = new AsyncZipDeflate(file.path, { level: 6 }); zip.add(stream);
      const entryDone = new Promise((resolve, reject) => {
        pendingEntryReject = reject;
        const forward = stream.ondata;
        stream.ondata = (error, bytes, final) => { if (error) firstFailure ??= error; forward(error, bytes, final); if (error) reject(firstFailure); else if (final) resolve(); };
      });
      void entryDone.catch(() => {});
      const length = file.bytes.length;
      if (!length) stream.push(new Uint8Array(), true);
      // fflate transfers d.buffer to its worker. Own each block so neither the
      // captured native slice nor subsequent final-flag/loop bounds detach.
      else for (let offset = 0; offset < length; offset += 256 * 1024) { stream.push(file.bytes.slice(offset, offset + 256 * 1024), offset + 256 * 1024 >= length); await yieldTurn(); guard(signal); }
      await entryDone;
      pendingEntryReject = undefined;
    }
    zip.end(); await complete;
    return { blob: new Blob(parts, { type: 'application/zip' }), manifest, owner: binding };
  } catch (error) { zip.terminate(); throw firstFailure ?? error; }
  finally { signal?.removeEventListener('abort', abort); pendingEntryReject = undefined; }
}

// Validate the central directory before decompression, including duplicate names,
// local-name agreement, offsets, encryption/ZIP64, declared budgets and trailing data.
function zipInventory(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (view.getUint32(i, true) === 0x06054b50 && i + 22 + view.getUint16(i + 20, true) === bytes.length) { end = i; break; }
  if (end < 0 || view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) throw backupError('BACKUP_ZIP_INVALID');
  const count = view.getUint16(end + 10, true), size = view.getUint32(end + 12, true), start = view.getUint32(end + 16, true);
  if (count !== view.getUint16(end + 8, true) || !count || count > LIMITS.entries || start + size !== end) throw backupError('BACKUP_ZIP_INVALID');
  const entries = new Map(); let offset = start, total = 0;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) throw backupError('BACKUP_ZIP_INVALID');
    const flags = view.getUint16(offset + 8, true), method = view.getUint16(offset + 10, true), expanded = view.getUint32(offset + 24, true), compressed = view.getUint32(offset + 20, true);
    const nameSize = view.getUint16(offset + 28, true), extra = view.getUint16(offset + 30, true), comment = view.getUint16(offset + 32, true), local = view.getUint32(offset + 42, true);
    if (offset + 46 + nameSize + extra + comment > end) throw backupError('BACKUP_ZIP_INVALID');
    const name = decoder().decode(bytes.subarray(offset + 46, offset + 46 + nameSize));
    if (!safePath(name) || entries.has(name) || flags & 1 || ![0, 8].includes(method) || expanded > LIMITS.fileBytes || (total += expanded) > LIMITS.expandedBytes || local + 30 > start || view.getUint32(local, true) !== 0x04034b50) throw backupError('BACKUP_ZIP_INVALID');
    const localNameSize = view.getUint16(local + 26, true), localExtra = view.getUint16(local + 28, true);
    if (local + 30 + localNameSize + localExtra + compressed > start || decoder().decode(bytes.subarray(local + 30, local + 30 + localNameSize)) !== name || view.getUint16(local + 8, true) !== method || view.getUint16(local + 6, true) !== flags) throw backupError('BACKUP_ZIP_INVALID');
    entries.set(name, expanded); offset += 46 + nameSize + extra + comment;
  }
  if (offset !== end) throw backupError('BACKUP_ZIP_INVALID');
  return entries;
}
export async function decodeBackup(archive, { owner, signal } = {}) {
  const binding = snapshotOwner(owner); guard(signal);
  if (!(archive instanceof Blob) && !(archive instanceof Uint8Array)) throw backupError('BACKUP_ZIP_INVALID');
  if ((archive.size ?? archive.byteLength) > LIMITS.archiveBytes) throw backupError('BACKUP_BUDGET_EXCEEDED');
  const bytes = archive instanceof Blob ? new Uint8Array(await archive.arrayBuffer()) : archive.slice();
  const inventory = zipInventory(bytes), files = new Map(); let expanded = 0;
  const unzip = new Unzip(file => {
    if (!inventory.has(file.name) || files.has(file.name)) throw backupError('BACKUP_ZIP_INVALID');
    const state = { parts: [], size: 0, done: false }; files.set(file.name, state);
    file.ondata = (error, part, final) => {
      if (error) throw error; guard(signal);
      state.size += part.length; expanded += part.length;
      if (state.size > inventory.get(file.name) || expanded > LIMITS.expandedBytes) throw backupError('BACKUP_BUDGET_EXCEEDED');
      state.parts.push(part); state.done = final;
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  for (let offset = 0; offset < bytes.length; offset += 64 * 1024) { guard(signal); unzip.push(bytes.subarray(offset, offset + 64 * 1024), offset + 64 * 1024 >= bytes.length); await yieldTurn(); }
  if (files.size !== inventory.size || [...files].some(([name, file]) => !file.done || file.size !== inventory.get(name))) throw backupError('BACKUP_ZIP_INVALID');
  const data = new Map([...files].map(([name, file]) => [name, concat(file.parts)]));
  const manifest = JSON.parse(decoder().decode(data.get('manifest.json'))); validateExportManifest(manifest);
  if (!manifest.complete) throw backupError('BACKUP_PARTIAL');
  if (data.size !== manifest.sections.length + 1) throw backupError('BACKUP_UNDECLARED_ENTRY');
  const storeSetVersion = manifest.storeSetVersion ?? 1;
  const expectedStores = storeSetVersion === 1 ? LEGACY_STORE_NAMES : STORE_NAMES;
  const indexedStores = new Map();
  for (const section of manifest.sections) {
    const match = /^stores\/([a-z_]+)-(\d+)\.ndjson$/.exec(section.path);
    if (!match) continue;
    const [, name, rawIndex] = match, index = Number(rawIndex);
    if (!expectedStores.includes(name) || !Number.isSafeInteger(index) || index > LIMITS.entries) throw backupError('BACKUP_STORE_SET');
    if (!indexedStores.has(name)) indexedStores.set(name, new Set());
    indexedStores.get(name).add(index);
  }
  if (indexedStores.size !== expectedStores.length || expectedStores.some(name => {
    const indexes = indexedStores.get(name);
    if (!indexes?.has(0)) return true;
    for (let index = 0; index < indexes.size; index++) if (!indexes.has(index)) return true;
    return false;
  })) throw backupError('BACKUP_STORE_SET');
  for (const section of manifest.sections) {
    const raw = data.get(section.path);
    if (!raw || raw.length !== section.utf8Bytes || await sha256Hex(raw) !== section.sha256) throw backupError('BACKUP_SECTION_DIGEST');
  }
  const backupOwner = snapshotOwner(JSON.parse(decoder().decode(data.get('owner.json'))));
  if (!sameOwner(binding, backupOwner)) throw backupError('BACKUP_OWNER_MISMATCH');
  const snapshot = Object.fromEntries(STORE_NAMES.map(name => [name, []])); const usedBinary = new Set(); let recordCount = 0;
  for (const section of manifest.sections) {
    if (section.path === 'owner.json') { if (section.count !== 1) throw backupError('BACKUP_SECTION_COUNT'); continue; }
    if (section.path.startsWith('content/')) { if (section.count !== 1) throw backupError('BACKUP_SECTION_COUNT'); continue; }
    const match = /^stores\/([a-z_]+)-(\d+)\.ndjson$/.exec(section.path);
    if (!match || !STORE_NAMES.includes(match[1])) throw backupError('BACKUP_UNDECLARED_ENTRY');
    const lines = decoder().decode(data.get(section.path)).split('\n');
    if (lines.pop() !== '' || lines.length !== section.count) throw backupError('BACKUP_SECTION_COUNT');
    for (const line of lines) {
      if (++recordCount > LIMITS.records) throw backupError('BACKUP_BUDGET_EXCEEDED');
      let row = JSON.parse(line);
      if (match[1] === 'content_chunks') {
        const expected = `content/${row.contentDigest}-${row.chunkIndex}.bin`;
        if (row.binaryPath !== expected || !data.has(expected) || usedBinary.has(expected) || Object.keys(row).sort().join() !== 'binaryPath,chunkIndex,contentDigest') throw backupError('BACKUP_CONTENT_MISSING');
        usedBinary.add(expected); row = { contentDigest: row.contentDigest, chunkIndex: row.chunkIndex, bytes: data.get(expected) };
      }
      snapshot[match[1]].push(row);
    }
  }
  if (storeSetVersion === 1) {
    if (snapshot.mutations.some(row => row.kind === 'history_snapshot') || await hasImportedHistorySnapshotBody(snapshot.content_chunks)) throw backupError('BACKUP_LEGACY_HISTORY_SNAPSHOT');
    // Schema-2 archives from before imported snapshots are unambiguously the
    // exact 19-store layout. Normalize them only after proving that no new
    // snapshot mutation or typed body was smuggled into the older envelope.
    snapshot.history_snapshots = [];
  }
  if (manifest.sections.some(section => section.path.startsWith('content/') && !usedBinary.has(section.path)) || expectedStores.some(name => !manifest.sections.some(section => section.path === `stores/${name}-0.ndjson`))) throw backupError('BACKUP_UNDECLARED_ENTRY');
  if (snapshot.writer_leases.length || snapshot.meta.length) throw backupError('BACKUP_RUNTIME_STATE');
  if (snapshot.import_receipts.some(row => row.sourceId.startsWith('qb-sync-v2:') && row.provenance?.format!=='qb-sync-change-v1')) throw backupError('BACKUP_RUNTIME_STATE');
  await validateSnapshot(snapshot, binding); guard(signal);
  return { manifest, owner: binding, snapshot };
}
