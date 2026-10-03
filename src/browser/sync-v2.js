import { canonicalBytes, canonicalContentBytes, sha256Hex } from '../domain/app-data/canonical.js';
import { validateContentReference, validateChunkManifest } from '../domain/app-data/content-records.js';
import { validatePushRequest, validatePushResponse, validatePushAcknowledgement, validatePullPage } from '../domain/app-data/sync-wire.js';
import { encodeCursor } from '../domain/app-data/cursor.js';
import { validateBankContent } from '../domain/question/bank-content.js';
import { publicRegistryJson } from '../../do-worker/src/account-public-registry.generated.js';
import { validateMutation } from '../domain/app-data/mutation-records.js';
import {pendingResumeSources} from '../storage/sync/pull.js';
import {validateHistorySnapshotBinding} from '../domain/app-data/history-snapshot-records.js';
import {resolveImmutableBank} from '../storage/history/immutable-bank-resolver.js';

const fail = code => Object.assign(new Error(code), { name: 'SyncV2Error', code });
const equal = (a, b) => new TextDecoder().decode(canonicalBytes(a)) === new TextDecoder().decode(canonicalBytes(b));
const equalBytes = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
const publicBanks = JSON.parse(publicRegistryJson);

/** A finite coordinator. It never writes IDB directly or exposes session tokens.
 * Repository methods perform owner/lease checks in their native transactions.
 * Missing dependencies remain pending; immutable mutation bytes are never rebased.
 */
export function createSyncV2Coordinator({ account, repository, fetchImpl = globalThis.fetch.bind(globalThis), assetBase = globalThis.location?.href }) {
  const required = ['acquireSyncCoordinator', 'renewSyncCoordinator', 'releaseSyncCoordinator', 'snapshotSyncContext', 'snapshotSyncStatus', 'readOutboxBatch', 'applyExactAck', 'applyPullPage', 'readRecords', 'readVerifiedContent', 'readFacts'];
  if (!account?.authenticatedTransport || required.some(name => typeof repository?.[name] !== 'function')) throw fail('SYNC_REPOSITORY_UNAVAILABLE');
  let flight = null;
  const assetUrl = new URL(assetBase || 'http://localhost/');
  if (globalThis.location && assetUrl.origin !== globalThis.location.origin) throw fail('ASSET_ORIGIN_NOT_ALLOWED');
  async function run() {
    const initial = account.snapshot();
    if (initial.phase !== 'ready' || !initial.owner) throw fail('AUTH_FAILED');
    let lease = await repository.acquireSyncCoordinator({ ttlMs: 15000 });
    let renewalError = null;
    let renewing = false;
    const guard = () => {
      const current = account.snapshot();
      if (renewalError) throw renewalError;
      if (current.epoch !== initial.epoch || current.phase !== 'ready' || current.owner?.accountId !== initial.owner.accountId || current.owner?.accountGeneration !== initial.owner.accountGeneration) throw fail('STALE_OWNER');
    };
    const timer = setInterval(async () => {
      if (renewing) return;
      renewing = true;
      try { guard(); lease = await repository.renewSyncCoordinator({ token: lease, ttlMs: 15000 }); guard(); }
      catch (error) { renewalError = error; }
      finally { renewing = false; }
    }, 5000);
    const context = async () => { guard(); const value = await repository.snapshotSyncContext({ token: lease }); guard(); if (value.owner.accountId !== initial.owner.accountId || value.owner.accountGeneration !== initial.owner.accountGeneration) throw fail('STALE_OWNER'); return value; };
    const http = async command => {
      guard(); const result = await account.authenticatedTransport(command); guard();
      if (result.status !== 200) { const error = fail(result.body?.error || `HTTP_${result.status}`); error.retryAfter = result.retryAfter; throw error; }
      return result.body;
    };
    const contentReferences = new Map();
    const uploaded = new Set();
    const verifiedDownloads = new Map();
    const remoteManifests = new Map();
    async function remoteManifest(digest) {
      if (!remoteManifests.has(digest)) remoteManifests.set(digest, await http({ path: `/v2/content/manifests?contentDigest=${digest}`, method: 'GET' }));
      return remoteManifests.get(digest);
    }
    async function upload(reference) {
      validateContentReference(reference);
      const uploadKey = `${reference.contentDigest}:${reference.manifestDigest}`;
      if (uploaded.has(uploadKey)) return;
      if (publicBanks.some(bank => equal(bank.publicContentReference, reference))) { uploaded.add(uploadKey); return; }
      const row = await repository.readRecords('content_chunks', [reference.manifestDigest, 0]); guard();
      if (!row || await sha256Hex(row.bytes) !== reference.manifestDigest) throw fail('MISSING_CONTENT');
      const manifest = validateChunkManifest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(row.bytes)));
      if (manifest.contentDigest !== reference.contentDigest || manifest.chunkCount !== reference.chunkCount || manifest.totalBytes !== reference.totalBytes) throw fail('CORRUPT_CONTENT');
      for (const part of manifest.chunks) {
        const stored = await repository.readRecords('content_chunks', [reference.contentDigest, part.chunkIndex]); guard();
        if (!stored || stored.bytes.length !== part.byteLength || await sha256Hex(stored.bytes) !== part.sha256) throw fail('CORRUPT_CONTENT');
        await http({ path: `/v2/content/chunks?${new URLSearchParams({ contentDigest: reference.contentDigest, chunkIndex: String(part.chunkIndex) })}`, method: 'PUT', body: new Uint8Array(stored.bytes) });
      }
      await http({ path: '/v2/content/manifests', method: 'POST', body: manifest });
      uploaded.add(uploadKey);
    }
    async function download(reference, protectedCipher = false) {
      validateContentReference(reference);
      const cacheKey = `${reference.contentDigest}:${reference.manifestDigest}`;
      const cached = verifiedDownloads.get(cacheKey);
      if (cached) {
        if (!protectedCipher && !Object.hasOwn(cached, 'value')) {
          cached.value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(cached.bytes));
          if (!equalBytes(canonicalContentBytes(cached.value), cached.bytes)) throw fail('NONCANONICAL_CONTENT');
        }
        guard(); return cached;
      }
      try {
        const local = await repository.readVerifiedContent(reference, { bytesOnly: protectedCipher }); guard();
        verifiedDownloads.set(cacheKey, local); return local;
      } catch (error) { guard(); if (error?.code !== 'MISSING_CONTENT') throw error; }
      const knownPublic = publicBanks.find(bank => equal(bank.publicContentReference, reference));
      let manifest, bytes;
      if (!bytes && knownPublic) {
        const url = new URL(knownPublic.contentManifest.staticRef, assetUrl);
        if (url.origin !== assetUrl.origin || !/^banks\/v2\/[a-z0-9-]+\.[0-9a-f]{64}\.json$/.test(knownPublic.contentManifest.staticRef)) throw fail('INVALID_PUBLIC_REFERENCE');
        const response = await fetchImpl(url.href, { credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(30000) }); guard();
        if (!response.ok || !response.body) throw fail('MISSING_PUBLIC_CONTENT');
        const reader = response.body.getReader(); const parts = []; let length = 0;
        try { for (;;) { const part = await reader.read(); guard(); if (part.done) break; length += part.value.length; if (length > reference.totalBytes) { await reader.cancel(); throw fail('CORRUPT_CONTENT'); } parts.push(part.value); } } finally { reader.releaseLock(); }
        bytes = new Uint8Array(length); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length; }
        const verified = await validateBankContent(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); guard();
        if (verified.contentDigest !== reference.contentDigest || verified.content.bankUid !== knownPublic.bankUid) throw fail('CORRUPT_CONTENT');
        const chunks = []; for (let offset = 0, index = 0; offset < bytes.length; offset += 512 * 1024, index++) { const part = bytes.subarray(offset, offset + 512 * 1024); chunks.push({ chunkIndex: index, byteLength: part.length, sha256: await sha256Hex(part) }); }
        manifest = { schemaVersion: 1, contentDigest: reference.contentDigest, chunkCount: chunks.length, totalBytes: bytes.length, chunks };
      } else if (!bytes) {
        const result = await remoteManifest(reference.contentDigest);
        manifest = validateChunkManifest(result.manifest);
        if (result.manifestDigest !== reference.manifestDigest || manifest.contentDigest !== reference.contentDigest
          || manifest.totalBytes !== reference.totalBytes || manifest.chunkCount !== reference.chunkCount
          || await sha256Hex(canonicalBytes(manifest)) !== reference.manifestDigest) throw fail('CORRUPT_CONTENT');
        bytes = new Uint8Array(reference.totalBytes); let offset = 0;
        for (const part of manifest.chunks) {
          const value = await http({ path: `/v2/content/chunks?${new URLSearchParams({ contentDigest: reference.contentDigest, chunkIndex: String(part.chunkIndex) })}`, method: 'GET' });
          if (!(value instanceof Uint8Array) || value.length !== part.byteLength || await sha256Hex(value) !== part.sha256) throw fail('CORRUPT_CONTENT');
          bytes.set(value, offset); offset += value.length;
        }
      }
      if (manifest.contentDigest !== reference.contentDigest || manifest.totalBytes !== reference.totalBytes || manifest.chunkCount !== reference.chunkCount || bytes.length !== reference.totalBytes || await sha256Hex(canonicalBytes(manifest)) !== reference.manifestDigest || await sha256Hex(bytes) !== reference.contentDigest) throw fail('CORRUPT_CONTENT');
      let value;
      if (!protectedCipher) { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); if (!equalBytes(canonicalContentBytes(value), bytes)) throw fail('NONCANONICAL_CONTENT'); }
      guard(); const verified = { reference: structuredClone(reference), manifest, bytes, ...(value === undefined ? {} : { value }) };
      verifiedDownloads.set(cacheKey, verified); return verified;
    }
    try {
      const results = { accepted: 0, conflicts: 0, pending: 0, pages: 0 };
      const bootstrap = await context();
      if (!bootstrap.logEpoch) {
        const request = { protocolVersion: 2, accountGeneration: bootstrap.owner.accountGeneration, mutations: [] };
        const response = validatePushResponse(await http({ path: '/v2/sync/push', method: 'POST', body: request }));
        if (response.generation !== bootstrap.owner.accountGeneration || response.receipts.length !== 0) throw fail('INVALID_BOOTSTRAP_ACK');
        await repository.applyExactAck({ context: bootstrap, request, response }); guard();
      }
      for (let round = 0; round < 3; round++) {
        const ctx = await context();
        const rows = await repository.readOutboxBatch({ maxMutations: 100, maxBytes: 262144 }); guard();
        // Repository performs shared mutationWire projection; validate envelopes
        // here without rebuilding/rebasing their already-digested payloads.
        const seenCas = new Set();
        const mutations = rows.map(validateMutation).filter(row => {
          if (!['attempt_manifest', 'resume_state', 'user_state', 'bank_revision'].includes(row.kind)) return true;
          const key = `${row.kind}:${row.entityKey}`;
          if (seenCas.has(key)) return false;
          seenCas.add(key); return true;
        });
        if (!mutations.length) break;
        for (const mutation of mutations) {
          const payload = mutation.payload;
          let reference = payload.reference || payload.contentManifest?.reference;
          if (mutation.kind === 'resume_state') {
            const row = await repository.readRecords('content_chunks', [payload.chunkManifestDigest, 0]); guard();
            if (!row || await sha256Hex(row.bytes) !== payload.chunkManifestDigest) throw fail('MISSING_CONTENT');
            const manifest = validateChunkManifest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(row.bytes)));
            if (manifest.contentDigest !== payload.contentDigest) throw fail('CORRUPT_CONTENT');
            reference = { contentDigest: manifest.contentDigest, manifestDigest: payload.chunkManifestDigest, chunkCount: manifest.chunkCount, totalBytes: manifest.totalBytes };
          }
          if (reference) { contentReferences.set(reference.contentDigest, reference); await upload(reference); }
        }
        const request = validatePushRequest({ protocolVersion: 2, accountGeneration: ctx.owner.accountGeneration, mutations });
        const response = await http({ path: '/v2/sync/push', method: 'POST', body: request });
        validatePushAcknowledgement(response, request, ctx.logEpoch);
        const applied = await repository.applyExactAck({ context: ctx, request, response }); guard();
        results.accepted += applied.accepted; results.conflicts += applied.conflicts; results.pending = applied.pending;
        // A conflict stops the finite pass; never let a same-base successor overwrite.
        if (applied.conflicts || !mutations.length || !applied.accepted) break;
      }
      let ctx = await context();
      if (!ctx.logEpoch) throw fail('LOG_EPOCH_UNAVAILABLE');
      let after = ctx.appliedPullCursor || encodeCursor({ protocolVersion: 2, accountGeneration: ctx.owner.accountGeneration, logEpoch: ctx.logEpoch, serverSeq: '0' });
      let until;
      let reachedCut = false;
      for (let page = 0; page < 8; page++) {
        ctx = await context();
        const request = { protocolVersion: 2, after, limit: 100, ...(until ? { until } : {}) };
        const response = await http({ path: `/v2/sync/pull?${new URLSearchParams({ after, limit: '100', ...(until ? { until } : {}) })}`, method: 'GET' });
        validatePullPage(response, request);
        if (!until) until = encodeCursor({ protocolVersion: 2, accountGeneration: ctx.owner.accountGeneration, logEpoch: response.logEpoch, serverSeq: response.highWater });
        const verifiedContents = new Map();
        for (const change of response.changes) {
          const p = change.payload;
          if (change.kind === 'content_manifest') contentReferences.set(p.reference.contentDigest, p.reference);
          let reference = p.reference || p.contentManifest?.reference || contentReferences.get(p.contentDigest);
          if (!reference && change.kind === 'bank_revision' && p.contentManifest?.kind === 'public_static') {
            const bank = publicBanks.find(value => value.bankUid === p.bankUid && value.revision === p.revision
              && equal(value.contentManifest, p.contentManifest) && equal(value.metadata, p.metadata));
            if (!bank) throw fail('UNTRUSTED_PUBLIC_REFERENCE');
            reference = bank.publicContentReference;
          }
          if (!reference && change.kind === 'resume_state') {
            const local = await repository.readRecords('content_chunks', [p.chunkManifestDigest, 0]); guard();
            const found = local ? { manifestDigest: p.chunkManifestDigest, manifest: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(local.bytes)) } : await remoteManifest(p.contentDigest);
            if (local && await sha256Hex(local.bytes) !== p.chunkManifestDigest) throw fail('CORRUPT_CONTENT');
            const manifest = validateChunkManifest(found.manifest);
            if (found.manifestDigest !== p.chunkManifestDigest || manifest.contentDigest !== p.contentDigest) throw fail('CORRUPT_CONTENT');
            reference = { contentDigest: manifest.contentDigest, manifestDigest: found.manifestDigest, chunkCount: manifest.chunkCount, totalBytes: manifest.totalBytes };
          }
          const bytesOnly = change.kind === 'content_manifest' || p.contentManifest?.kind === 'protected_cipher';
          if (reference && (!verifiedContents.has(reference.contentDigest) || (!bytesOnly && !Object.hasOwn(verifiedContents.get(reference.contentDigest), 'value')))) verifiedContents.set(reference.contentDigest, await download(reference, bytesOnly));
        }
        // A snapshot is not usable merely because its own typed body arrived.
        // Fetch its exact immutable bank closure before committing the page,
        // including retained sources whose catalog row was tombstoned.
        const snapshots=response.changes.filter(change=>change.kind==='history_snapshot');
        if(snapshots.length){
          const facts=await repository.readFacts();guard();const banks=new Map();
          for(const change of snapshots){const body=verifiedContents.get(change.payload.reference.contentDigest)?.value;await validateHistorySnapshotBinding(change.payload,body,{accountGeneration:ctx.owner.accountGeneration});guard();
            for(const scope of body.scope)for(const ref of scope.equivalentSourceRefs){const uid=ref.questionKey.split('/')[0],key=uid+':'+ref.bankRevision;
              if(!banks.has(key))banks.set(key,resolveImmutableBank({bankUid:uid,bankRevision:ref.bankRevision,
                readBankRevision:async()=>facts.bank_revisions.find(bank=>bank.bankUid===uid&&bank.revision===ref.bankRevision)||null,
                sourceChanges:async()=>[...facts.mutations,...facts.import_receipts,...response.changes].filter(raw=>{const source=raw.provenance?.format==='qb-sync-change-v1'?raw.provenance.change:raw;return source?.kind==='bank_revision'&&source.payload?.bankUid===uid&&source.payload?.revision===ref.bankRevision||source?.kind==='content_manifest'&&source.payload?.reference?.contentDigest===ref.bankRevision;}),
                readContent:async reference=>{let entry=verifiedContents.get(reference.contentDigest);if(!entry||!Object.hasOwn(entry,'value')){entry=await download(reference);guard();verifiedContents.set(reference.contentDigest,entry);}if(!equal(entry.reference,reference))throw fail('CORRUPT_CONTENT');return entry.value;}
              }));
              const bank=await banks.get(key);guard();if(!bank.questionRefs.some(question=>question.questionKey===ref.questionKey&&question.questionRevision===ref.questionRevision))throw fail('HISTORY_QUESTION_DEPENDENCY');
            }
          }
        }
        await repository.applyPullPage({ context: ctx, request, response, verifiedContents }); guard();
        after = response.nextCursor; results.pages++;
        if (!response.hasMore) { reachedCut = true; break; }
      }
      guard();const beforeProjection=await context(),facts=await repository.readFacts();guard();
      const projection=await pendingResumeSources(facts,beforeProjection.owner,beforeProjection.logEpoch);guard();
      const afterProjection=await context();if(!equal(beforeProjection,afterProjection))throw fail('SYNC_CONTEXT_CHANGED');
      const status = await repository.snapshotSyncStatus({ token: lease }); guard();
      return { ...results, ...projection, ...(projection.awaitingResume?{reason:'AWAITING_RESUME'}:{}), pending: status.outboxCount, openConflicts: status.openConflictCount, appliedPullCursor: status.appliedPullCursor, fixedCut: until, reachedCut,
        synced: reachedCut && !projection.awaitingResume && status.outboxCount === 0 && status.openConflictCount === 0 };
    } catch (error) {
      if (error?.code !== 'RATE_LIMITED') throw error;
      guard(); const status = await repository.snapshotSyncStatus({ token: lease }); guard();
      return { synced: false, paused: true, reason: 'RATE_LIMITED', retryAfter: Number.isSafeInteger(error.retryAfter) ? error.retryAfter : null,
        pending: status.outboxCount, openConflicts: status.openConflictCount, appliedPullCursor: status.appliedPullCursor, reachedCut: false };
    } finally { clearInterval(timer); await repository.releaseSyncCoordinator({ token: lease }); }
  }
  return Object.freeze({ runOnce() { if (!flight) flight = run().finally(() => { flight = null; }); return flight; } });
}
