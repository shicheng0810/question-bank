import { sha256 } from '@noble/hashes/sha2.js';
import { canonicalBytes, canonicalContentBytes, sha256Hex } from '../domain/app-data/canonical.js';
import { validateChangeLogRecord, validateMutationReceipt } from '../domain/app-data/sync-wire.js';
import { verifyMutationDigest } from '../domain/app-data/mutation-records.js';
import { validateChunkManifest, validateContentReference } from '../domain/app-data/content-records.js';
import { validateCursorReset } from '../domain/app-data/auth-recovery.js';
import { validateCloudCheckpoint, validateCloudContentReference, CLOUD_SECTION_PATHS } from '../../do-worker/src/account-cloud-checkpoint.js';
import { validateExportManifest } from '../domain/app-data/export-manifest.js';
import { validateBankContent, validateProtectedBankEnvelopeV2 } from '../domain/question/bank-content.js';
import { frozenPublicRegistrySnapshots } from '../domain/question/frozen-public-registry.js';
import {isCommittedNativeCloudRecoveryResult} from '../storage/cloud-recovery/index.js';

const error = code => Object.assign(new Error(code), { name: 'CloudRecoveryV2Error', code });
const hex = bytes => Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
const same = (a, b) => new TextDecoder().decode(canonicalBytes(a)) === new TextDecoder().decode(canonicalBytes(b));
const byteEqual = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
// Download progress only. This never consumes or creates final Ready authority.
export function validateStagedContentResult(input,expectedReference){
  try{
    canonicalBytes(input);const value=structuredClone(input),reference=validateContentReference(value.reference);validateContentReference(expectedReference);
    const keys=Object.keys(value).sort().join();
    if(!same(reference,expectedReference))throw error('STAGED_CONTENT_UNVERIFIED');
    if(value.status==='typed_body_candidate'){
      if(keys!=='fullDependencyClosure,reference,status'||value.fullDependencyClosure!==false)throw error('STAGED_CONTENT_UNVERIFIED');
      return {status:'typed_body_candidate',reference,fullDependencyClosure:false};
    }
    if(value.status!=='verified'||!['reference,status','fullDependencyClosure,reference,status'].includes(keys)||Object.hasOwn(value,'fullDependencyClosure')&&value.fullDependencyClosure!==true)throw error('STAGED_CONTENT_UNVERIFIED');
    return value;
  }catch{throw error('STAGED_CONTENT_UNVERIFIED');}
}
// Match the server's pinned registry projection, not the larger builder JSON.
// Consumers (including the native provider) must independently call this
// helper; a transport success label is not registry provenance.
export async function verifyFrozenCloudPublicReference(row) {
  const owned = JSON.parse(new TextDecoder().decode(canonicalBytes(row)));
  validateCloudContentReference(owned);
  if (owned.provenance.kind !== 'frozen_public_static') throw error('UNTRUSTED_PUBLIC_REFERENCE');
  let matchingSnapshot = null;
  for (const snapshot of frozenPublicRegistrySnapshots) {
    if (owned.provenance.registryDigest === snapshot.digest) matchingSnapshot = snapshot.banks;
  }
  if (!matchingSnapshot) throw error('UNTRUSTED_PUBLIC_REGISTRY');
  const known = matchingSnapshot.find(bank => bank.bankUid === owned.provenance.bankUid && bank.revision === owned.provenance.revision && bank.contentManifest.staticRef === owned.provenance.staticRef && same(bank.publicContentReference, owned.reference));
  if (!known) throw error('UNTRUSTED_PUBLIC_REFERENCE');
  return structuredClone(known);
}

export function createCloudNdjsonDigest() {
  const hash = sha256.create(); let count = 0, utf8Bytes = 0, ended = false;
  return {
    add(record) { if (ended) throw error('HASH_FINISHED'); const bytes = canonicalBytes(record); hash.update(bytes).update(new Uint8Array([10])); count++; utf8Bytes += bytes.length + 1; },
    finish() { if (ended) throw error('HASH_FINISHED'); ended = true; return { count, utf8Bytes, sha256: hex(hash.digest()) }; },
  };
}

/** Native provider contract is documented alongside the finite fixture.
 * Stage APIs must not activate data. Their final transaction independently
 * validates receipts/content/tombstones and merges exact local pending wire.
 * Missing actual native APIs are an error, never a fake successful recovery.
 */
export function createCloudRecoveryV2({ account, repository, provider, fetchImpl = globalThis.fetch.bind(globalThis), assetBase = globalThis.location?.href, onProgress = () => {}, signal }) {
  const required = ['beginCloudRecovery', 'stageCloudPage', 'readStagedContentManifest', 'stageContentChunk', 'finishVerifiedContent', 'finishCloudRecovery', 'abortCloudRecovery'];
  if (!account?.authenticatedTransport || !account?.snapshot || required.some(name => typeof provider?.[name] !== 'function') || !repository?.snapshotSyncContext || !repository?.acquireSyncCoordinator || !repository?.renewSyncCoordinator || !repository?.releaseSyncCoordinator) throw error('CLOUD_RECOVERY_PROVIDER_UNAVAILABLE');
  const assetUrl = new URL(assetBase || 'http://localhost/');
  if (globalThis.location && assetUrl.origin !== globalThis.location.origin) throw error('ASSET_ORIGIN_NOT_ALLOWED');
  let flight = null;
  async function run() {
    const initial = account.snapshot(), deadline = Date.now() + 900000;
    if (initial.phase !== 'ready' || !initial.owner) throw error('AUTH_FAILED');
    let lease = await repository.acquireSyncCoordinator({ ttlMs: 15000 }), renewalError = null, renewing = false, renewalPromise=null;
    let handle = null, completed = false, operationError = null, committedResult=null;
    const guard = () => { const now = account.snapshot(); if (signal?.aborted) throw error('CANCELLED'); if (Date.now() >= deadline) throw error('RECOVERY_DEADLINE'); if (renewalError) throw renewalError; if (now.epoch !== initial.epoch || now.phase !== 'ready' || now.owner?.accountId !== initial.owner.accountId || now.owner?.accountGeneration !== initial.owner.accountGeneration) throw error('STALE_OWNER'); };
    const timer = setInterval(() => { if (renewing) return; renewing = true; renewalPromise=(async()=>{try { guard(); const renewed = handle&&typeof provider.renewCloudRecoveryLease==='function'?await provider.renewCloudRecoveryLease({handle}):await repository.renewSyncCoordinator({ token: lease, ttlMs: 15000 }); if(renewed)lease=renewed;guard(); } catch (cause) { renewalError = cause; } finally { renewing = false; }})(); }, 5000);
    const http = async command => {
      for (;;) {
        guard(); const response = await account.authenticatedTransport(command); guard();
        if (response.status === 200) return response.body;
        if (response.status !== 429 || !Number.isSafeInteger(response.retryAfter) || response.retryAfter < 1 || response.retryAfter > 60 || Date.now() + response.retryAfter * 1000 >= deadline) throw error(response.body?.error || `HTTP_${response.status}`);
        onProgress({ phase: 'rate-limited', retryAfter: response.retryAfter });
        await new Promise((resolve, reject) => {
          const cancel = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(error('CANCELLED')); };
          const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, response.retryAfter * 1000);
          signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel();
        }); guard();
      }
    };
    try {
      const context = await repository.snapshotSyncContext({ token: lease }); guard();
      if (context.owner.accountId !== initial.owner.accountId || context.owner.accountGeneration !== initial.owner.accountGeneration) throw error('STALE_OWNER');
      const started = await http({ path: '/v2/export/start', method: 'POST', body: {} });
      if (!started || Object.keys(started).sort().join(',') !== 'checkpoint,checkpointDigest,expiresAt,exportId,manifest,manifestDigest,ok' || started.ok !== true) throw error('INVALID_CLOUD_CHECKPOINT');
      const fileManifest = validateExportManifest(started.manifest);
      if (await sha256Hex(canonicalBytes(fileManifest)) !== started.manifestDigest || fileManifest.complete || !fileManifest.partial) throw error('INVALID_FILE_MANIFEST');
      const checkpoint = structuredClone(validateCloudCheckpoint(started.checkpoint));
      if (fileManifest.exportId !== checkpoint.exportId || fileManifest.accountGeneration !== checkpoint.generation || fileManifest.serverLogEpoch !== checkpoint.logEpoch || fileManifest.exportCut !== checkpoint.cut || fileManifest.throughServerSeq !== checkpoint.cut) throw error('INVALID_FILE_MANIFEST');
      if (!checkpoint.complete || checkpoint.exportId !== started.exportId || checkpoint.generation !== context.owner.accountGeneration || checkpoint.generation !== initial.owner.accountGeneration || (context.logEpoch && checkpoint.logEpoch !== context.logEpoch) || checkpoint.expiresAt !== started.expiresAt || checkpoint.expiresAt <= Date.now() || await sha256Hex(canonicalBytes(checkpoint)) !== started.checkpointDigest) throw error('INVALID_CLOUD_CHECKPOINT');
      guard();
      handle = await provider.beginCloudRecovery({ context, checkpoint, checkpointDigest: started.checkpointDigest }); guard();
      const downloaded = new Set(); let acceptedSeq = 0n;
      async function finishContent(reference, manifest, chunks, fullHash, sourceKind) {
        if (hex(fullHash.digest()) !== reference.contentDigest || await sha256Hex(canonicalBytes(manifest)) !== reference.manifestDigest) throw error('CONTENT_DIGEST');
        if (chunks && sourceKind !== 'content_manifest') {
          const bytes = new Uint8Array(reference.totalBytes); let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
          const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
          if (!byteEqual(canonicalContentBytes(value), bytes)) throw error('NONCANONICAL_CONTENT');
          if (value?.format === 'qb-bank-content-v2') await validateBankContent(value);
          if (value?.format === 'qb-protected-bank-envelope-v2') await validateProtectedBankEnvelopeV2(value);
        }
        guard(); const verified = await provider.finishVerifiedContent({ handle, reference, manifest }); guard();
        validateStagedContentResult(verified,reference);
      }
      async function download(row) {
        const reference = structuredClone(validateContentReference(row.reference));
        const key = `${reference.contentDigest}:${reference.manifestDigest}`; if (downloaded.has(key)) return;
        const hash = sha256.create(), small = reference.totalBytes <= 3 * 1024 * 1024 ? [] : null;
        let manifest;
        if (row.provenance.kind === 'frozen_public_static') {
          const known = await verifyFrozenCloudPublicReference(row); guard();
          const url = new URL(known.contentManifest.staticRef, assetUrl); if (url.origin !== assetUrl.origin) throw error('ASSET_ORIGIN_NOT_ALLOWED');
          const downloadSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
          const response = await fetchImpl(url.href, { credentials: 'omit', redirect: 'error', cache: 'no-store', signal: downloadSignal }); guard();
          if (!response.ok || !response.body) throw error('MISSING_PUBLIC_CONTENT');
          const reader = response.body.getReader(), parts = []; let total = 0, buffer = new Uint8Array(512 * 1024), used = 0;
          const flush = async () => { const bytes = buffer.slice(0, used), chunkIndex = parts.length; const digest = await sha256Hex(bytes); hash.update(bytes); if (small) small.push(bytes); await provider.stageContentChunk({ handle, reference, chunkIndex, bytes }); guard(); parts.push({ chunkIndex, byteLength: bytes.length, sha256: digest }); buffer = new Uint8Array(512 * 1024); used = 0; };
          try { for (;;) { const part = await reader.read(); guard(); if (part.done) break; total += part.value.length; if (total > reference.totalBytes) throw error('CONTENT_SIZE'); let offset = 0; while (offset < part.value.length) { const count = Math.min(buffer.length - used, part.value.length - offset); buffer.set(part.value.subarray(offset, offset + count), used); used += count; offset += count; if (used === buffer.length) await flush(); } } if (used) await flush(); }
          finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
          if (total !== reference.totalBytes || parts.length !== reference.chunkCount) throw error('CONTENT_SIZE');
          manifest = validateChunkManifest({ schemaVersion: 1, contentDigest: reference.contentDigest, totalBytes: total, chunkCount: parts.length, chunks: parts });
        } else {
          manifest = structuredClone(validateChunkManifest(await provider.readStagedContentManifest({ handle, reference }))); guard();
          if (manifest.contentDigest !== reference.contentDigest || manifest.totalBytes !== reference.totalBytes || manifest.chunkCount !== reference.chunkCount || await sha256Hex(canonicalBytes(manifest)) !== reference.manifestDigest) throw error('CONTENT_MANIFEST_MISMATCH');
          for (const chunk of manifest.chunks) {
            const bytes = await http({ path: `/v2/export/chunk?${new URLSearchParams({ exportId: checkpoint.exportId, contentDigest: reference.contentDigest, chunkIndex: String(chunk.chunkIndex) })}`, method: 'GET' });
            if (!(bytes instanceof Uint8Array) || bytes.length !== chunk.byteLength || await sha256Hex(bytes) !== chunk.sha256) throw error('CONTENT_DIGEST');
            hash.update(bytes); if (small) small.push(bytes);
            await provider.stageContentChunk({ handle, reference, chunkIndex: chunk.chunkIndex, bytes: new Uint8Array(bytes) }); guard();
          }
        }
        await finishContent(reference, manifest, small, hash, row.sourceChange.kind); downloaded.add(key);
      }
      for (const path of CLOUD_SECTION_PATHS) {
        const section = checkpoint.sections.find(item => item.path === path);
        const digest = createCloudNdjsonDigest(); let after = '0', index = 0;
        for (;;) {
          const page = await http({ path: `/v2/export/page?${new URLSearchParams({ exportId: checkpoint.exportId, section: section.path, after, limit: '100' })}`, method: 'GET' });
          if (page.exportId !== checkpoint.exportId || page.section !== section.path || page.exportCut !== checkpoint.cut || !Array.isArray(page.records) || page.records.length > 100 || typeof page.hasMore !== 'boolean' || !/^(0|[1-9][0-9]{0,19})$/.test(page.next) || BigInt(page.next) < BigInt(after) || (page.hasMore && BigInt(page.next) === BigInt(after))) throw error('INVALID_EXPORT_PAGE');
          const records = JSON.parse(new TextDecoder().decode(canonicalBytes(page.records))), pageDigest = createCloudNdjsonDigest();
          for (const row of records) {
            if (['accepted-changes.ndjson', 'latest-state.ndjson', 'tombstones.ndjson'].includes(section.path)) {
              const change = validateChangeLogRecord(row);
              if (change.accountGeneration !== checkpoint.generation || BigInt(change.serverSeq) > BigInt(checkpoint.cut) || await sha256Hex(canonicalBytes({ protocolVersion: 2, kind: change.kind, entityKey: change.entityKey, payload: change.payload })) !== change.payloadDigest) throw error('INVALID_CLOUD_FACT');
              if (section.path === 'accepted-changes.ndjson' && BigInt(change.serverSeq) !== ++acceptedSeq) throw error('CLOUD_LOG_GAP');
              if (section.path === 'tombstones.ndjson' && change.kind !== 'entity_tombstone') throw error('INVALID_TOMBSTONE');
            } else if (section.path === 'mutation-receipts.ndjson') {
              if (!row || Object.keys(row).sort().join(',') !== 'mutation,receipt' || !row.mutation || !await verifyMutationDigest(row.mutation)) throw error('INVALID_CLOUD_RECEIPT');
              const receipt = validateMutationReceipt(row.receipt);
              if (receipt.mutationId !== row.mutation.mutationId || receipt.payloadDigest !== row.mutation.payloadDigest || receipt.status === 'missing_dependency' || (receipt.serverSeq && BigInt(receipt.serverSeq) > BigInt(checkpoint.cut))) throw error('INVALID_CLOUD_RECEIPT');
            } else if (section.path === 'content-manifests.ndjson') validateChunkManifest(row);
            else {
              validateCloudContentReference(row);
              const change = row.sourceChange, p = change.payload;
              if (change.accountGeneration !== checkpoint.generation || BigInt(change.serverSeq) > BigInt(checkpoint.cut) || await sha256Hex(canonicalBytes({ protocolVersion: 2, kind: change.kind, entityKey: change.entityKey, payload: p })) !== change.payloadDigest) throw error('INVALID_CLOUD_FACT');
              if (change.kind === 'content_manifest' || change.kind === 'attempt_scope' || change.kind === 'history_snapshot') { if (!same(row.reference, p.reference)) throw error('CONTENT_REFERENCE_MISMATCH'); }
              else if (change.kind === 'resume_state') { if (row.reference?.contentDigest !== p.contentDigest || row.reference?.manifestDigest !== p.chunkManifestDigest) throw error('CONTENT_REFERENCE_MISMATCH'); }
              else if (p.contentManifest.kind !== 'public_static') { if (!same(row.reference, p.contentManifest.reference)) throw error('CONTENT_REFERENCE_MISMATCH'); }
              else if (row.provenance.kind !== 'frozen_public_static' || row.provenance.bankUid !== p.bankUid || row.provenance.revision !== p.revision || row.provenance.staticRef !== p.contentManifest.staticRef) throw error('CONTENT_REFERENCE_MISMATCH');
            }
            digest.add(row); pageDigest.add(row);
          }
          guard(); await provider.stageCloudPage({ handle, section: section.path, index: index++, records, sha256: pageDigest.finish().sha256 }); guard();
          after = page.next; onProgress({ phase: 'staging', section: section.path, page: index });
          if (!page.hasMore) break;
        }
        if (!same(digest.finish(), { count: section.count, utf8Bytes: section.utf8Bytes, sha256: section.sha256 })) throw error('EXPORT_SECTION_DIGEST');
      }
      if (acceptedSeq !== BigInt(checkpoint.cut)) throw error('CLOUD_LOG_GAP');
      // All reference provenance must exist in inactive native staging before
      // content verification resolves historical dependencies. Replay the
      // immutable pinned section, rather than collecting every ref in memory.
      const referenceSummary = checkpoint.sections.find(section => section.path === 'content-references.ndjson');
      const replayDigest = createCloudNdjsonDigest(); let referenceAfter = '0';
      for (;;) {
        const page = await http({ path: `/v2/export/page?${new URLSearchParams({ exportId: checkpoint.exportId, section: referenceSummary.path, after: referenceAfter, limit: '100' })}`, method: 'GET' });
        if (page.exportId !== checkpoint.exportId || page.section !== referenceSummary.path || page.exportCut !== checkpoint.cut || !Array.isArray(page.records) || page.records.length > 100 || typeof page.hasMore !== 'boolean' || !/^(0|[1-9][0-9]{0,19})$/.test(page.next) || BigInt(page.next) < BigInt(referenceAfter) || (page.hasMore && BigInt(page.next) === BigInt(referenceAfter))) throw error('INVALID_EXPORT_PAGE');
        for (const raw of page.records) { const row = JSON.parse(new TextDecoder().decode(canonicalBytes(raw))); validateCloudContentReference(row); replayDigest.add(row); if (row.provenance.kind === 'missing') throw error('MISSING_CONTENT'); await download(row); }
        if (!page.hasMore) break;
        referenceAfter = page.next;
      }
      if (!same(replayDigest.finish(), { count: referenceSummary.count, utf8Bytes: referenceSummary.utf8Bytes, sha256: referenceSummary.sha256 })) throw error('EXPORT_SECTION_DIGEST');
      const reset = validateCursorReset((await http({ path: '/v2/export/reset', method: 'POST', body: { exportId: checkpoint.exportId } })).reset);
      if (reset.generation !== checkpoint.generation || reset.logEpoch !== checkpoint.logEpoch || reset.exportCut !== checkpoint.cut || reset.resetExportId !== checkpoint.exportId || reset.manifestDigest !== started.checkpointDigest || reset.expiresAt !== checkpoint.expiresAt || reset.expiresAt <= Date.now()) throw error('INVALID_CURSOR_RESET');
      if(renewalPromise)await renewalPromise;guard(); const result = await provider.finishCloudRecovery({ handle, cursorReset: reset });
      if (result?.status !== 'complete'||!isCommittedNativeCloudRecoveryResult(result)) throw error('RECOVERY_NOT_ACTIVATED');
      completed = true;committedResult=result;guard();
      if(result.cleanupRequired)onProgress({phase:'cleanup-required',recoveryCommitted:true,reasonCode:result.cleanupError||'CLOUD_CLEANUP_FAILED'});
      return result;
    } catch (cause) {
      if(!cause||typeof cause!=='object'||!Object.isExtensible(cause)){const wrapped=error(completed?'RECOVERY_COMMITTED_CALLBACK_FAILED':'RECOVERY_FAILED');wrapped.cause=cause;cause=wrapped;}
      if(completed){cause.recoveryCommitted=true;if(committedResult.cleanupRequired){cause.cleanupRequired=true;cause.cleanupError=committedResult.cleanupError;}}
      operationError = cause; throw cause;
    }
    finally {
      clearInterval(timer);
      try {
        if (handle && !completed) {
          try {
            const reasonCode = /^[A-Z][A-Z0-9_]{0,63}$/.test(operationError?.code || '') ? operationError.code : 'RECOVERY_FAILED';
            const result = await provider.abortCloudRecovery({ handle, reasonCode });
            if(result?.status==='complete'&&isCommittedNativeCloudRecoveryResult(result)&&operationError){operationError.recoveryCommitted=true;if(result.cleanupRequired){operationError.cleanupRequired=true;operationError.cleanupError=result.cleanupError;}}
            if (result?.status === 'cleanup-incomplete') {
              if (operationError) operationError.cleanupRequired = true;
              try { onProgress({ phase: 'cleanup-required', reasonCode }); } catch {}
            }
          } catch (cleanupError) {
            if (operationError) operationError.cleanupRequired = true;
            else throw cleanupError;
          }
        }
      } finally { try { await repository.releaseSyncCoordinator({ token: lease }); } catch {} }
    }
  }
  return Object.freeze({ runOnce() { if (!flight) flight = run().finally(() => { flight = null; }); return flight; } });
}
