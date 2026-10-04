import { canonicalBytes } from '../../src/domain/app-data/canonical.js';
import { isUuid } from '../../src/domain/question/index.js';
import { validateChangeLogRecord } from '../../src/domain/app-data/sync-wire.js';
import { validateContentReference, validateContentManifest } from '../../src/domain/app-data/content-records.js';

export const CLOUD_COVERAGE = ['acceptedFacts', 'attempts', 'latestDrafts', 'permanentMutationReceipts', 'serverConflicts', 'tombstones', 'contentClosure'];
export const CLOUD_SECTION_PATHS = ['accepted-changes.ndjson', 'mutation-receipts.ndjson', 'content-manifests.ndjson', 'latest-state.ndjson', 'tombstones.ndjson', 'content-references.ndjson'];
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const fail = () => { throw Object.assign(new Error('INVALID_CLOUD_CHECKPOINT'), { code: 'INVALID_CLOUD_CHECKPOINT' }); };
const decimal = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value);
const hash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

// This is NOT the portable qb-appdata-v2 file manifest: it certifies only
// the authenticated generation's server-known gen06 accepted cut.
export function validateCloudCheckpoint(value) {
  canonicalBytes(value);
  if (!exact(value, ['format', 'scope', 'exportId', 'generation', 'logEpoch', 'cut', 'expiresAt', 'sections', 'coverage', 'complete', 'partialReasons'])
    || value.format !== 'qb-cloud-checkpoint-v1' || value.scope !== 'server-known-accepted-state'
    || !isUuid(value.exportId) || !isUuid(value.generation) || !isUuid(value.logEpoch) || !decimal(value.cut)
    || !Number.isSafeInteger(value.expiresAt) || value.expiresAt < 1 || typeof value.complete !== 'boolean'
    || !exact(value.coverage, CLOUD_COVERAGE) || CLOUD_COVERAGE.some(key => typeof value.coverage[key] !== 'boolean')) fail();
  if (!Array.isArray(value.sections) || value.sections.length !== CLOUD_SECTION_PATHS.length) fail();
  const paths = new Set();
  for (const section of value.sections) {
    if (!exact(section, ['path', 'count', 'utf8Bytes', 'sha256']) || !/^[a-z-]+\.ndjson$/.test(section.path) || paths.has(section.path)
      || !Number.isSafeInteger(section.count) || section.count < 0 || !Number.isSafeInteger(section.utf8Bytes) || section.utf8Bytes < 0 || !hash(section.sha256)) fail();
    paths.add(section.path);
  }
  if (CLOUD_SECTION_PATHS.some(path => !paths.has(path))) fail();
  if (!Array.isArray(value.partialReasons) || value.partialReasons.some(reason => typeof reason !== 'string' || !/^[a-z_]{1,128}$/.test(reason)) || new Set(value.partialReasons).size !== value.partialReasons.length) fail();
  if (value.complete !== (CLOUD_COVERAGE.every(key => value.coverage[key]) && value.partialReasons.length === 0) || (!value.complete && value.partialReasons.length === 0)) fail();
  return value;
}

export function validateCloudContentReference(value) {
  canonicalBytes(value);
  if (!exact(value, ['sourceChange', 'reference', 'provenance'])) fail();
  const change = validateChangeLogRecord(value.sourceChange);
  if (!['content_manifest', 'bank_revision', 'attempt_scope', 'resume_state', 'history_snapshot'].includes(change.kind)) fail();
  const provenance = value.provenance;
  if (provenance?.kind === 'missing') {
    if (!exact(provenance, ['kind']) || value.reference !== null) fail();
  } else {
    validateContentReference(value.reference);
    if (provenance?.kind === 'server_chunks') {
      if (!exact(provenance, ['kind'])) fail();
    } else if (provenance?.kind === 'frozen_public_static') {
      if (!exact(provenance, ['kind', 'bankUid', 'revision', 'staticRef', 'registryDigest']) || !isUuid(provenance.bankUid) || !hash(provenance.revision) || provenance.revision !== value.reference.contentDigest || !hash(provenance.registryDigest)
        || !['content_manifest', 'bank_revision'].includes(change.kind)) fail();
      validateContentManifest({ kind: 'public_static', staticRef: provenance.staticRef, contentDigest: provenance.revision });
    } else fail();
  }
  if (change.kind === 'history_snapshot') {
    if (provenance?.kind !== 'missing'
      && new TextDecoder().decode(canonicalBytes(value.reference)) !== new TextDecoder().decode(canonicalBytes(change.payload.reference))) fail();
  }
  return value;
}
