import {validateSnapshotBaselineShape} from './snapshot-continuation.js';
import { JSONParser, TokenType } from '@streamparser/json';
import { sha256 } from '@noble/hashes/sha2.js';
import { canonicalBytes, canonicalContentBytes } from './canonical.js';
import { validateContentReference, validateResumeReference } from './content-records.js';
import { validateAttemptScopeRecord, validateResumeDraftForAttempt } from './core-records.js';
import { validateResumeAttemptBinding } from './resume-dependencies.js';
import { APP_DATA_CONTENT_LIMITS, APP_DATA_LIMITS } from './constants.js';
import { isUuid } from '../question/index.js';

const fields = ['attemptId', 'baseRevision', 'effectiveElapsedMs', 'localRevision', 'position', 'questionDrafts', 'schemaVersion', 'scope', 'scopeDigest', 'submittedEventIds', 'writerStreamId'];
const v2Fields = [...fields, 'snapshotBaseline'].sort();
const arrays = ['questionDrafts', 'scope', 'submittedEventIds'];
/** @param {string} code @returns {never} */
const fail = code => { throw Object.assign(new Error(code), { code }); };
/** @param {Uint8Array} value @returns {string} */
const hex = value => Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('');
/** @template T @param {T} value @returns {T} */
const capture = value => JSON.parse(new TextDecoder().decode(canonicalBytes(value)));
/** @param {number} value @returns {boolean} */
const integer = value => Number.isSafeInteger(value) && value >= 0;
/** Unimported streaming component, not payload_verified.
 * Official parser owns all JSON grammar; token observations only enforce
 * this ONE frozen ResumeState root schema and encode its canonical framing.
 * Every callback must write inactive native staging. The indexed consumer
 * still owes uniqueness, scope/draft membership, immutable event/grade and
 * exact historical D12 parent proofs before publishing or activating data.
 * @param {{chunks:AsyncIterable<Uint8Array>|Iterable<Uint8Array>,contentReference:import('./contracts').ContentReference,resumeReference:import('./contracts').ResumeReference,expectedAttempt:import('./contracts').ResumeAttemptBinding,onDraft:(row:import('./contracts').ResumeDraft)=>unknown|Promise<unknown>,onScope:(row:import('./contracts').AttemptScopeRecord)=>unknown|Promise<unknown>,onSubmittedEventId:(id:string)=>unknown|Promise<unknown>,onSnapshotBaseline?:(baseline:unknown)=>unknown|Promise<unknown>,signal?:AbortSignal}} input
 */
export async function streamCanonicalResumeRows({ chunks, contentReference, resumeReference, expectedAttempt, onDraft, onScope, onSubmittedEventId, onSnapshotBaseline, signal }) {
  const content = capture(contentReference), reference = capture(resumeReference), binding = capture(expectedAttempt);
  validateContentReference(content); validateResumeReference(reference); validateResumeAttemptBinding(binding);
  if (content.contentDigest !== reference.contentDigest || content.manifestDigest !== reference.chunkManifestDigest || reference.attemptId !== binding.attemptId || reference.writerStreamId !== binding.writerStreamId || [onDraft, onScope, onSubmittedEventId].some(fn => typeof fn !== 'function')) fail('RESUME_STREAM_BINDING');
  const rawHash = sha256.create(), canonicalHash = sha256.create(), scopeHash = sha256.create();
  let received = 0, bytesSinceValue = 0, depth = 0, first = true;
  /** @type {string|null} */ let rootKey = null;
  /** @type {unknown} */ let topString = null;
  /** @type {'questionDrafts'|'scope'|'submittedEventIds'|null} */ let activeArray = null;
  /** @type {string[]} */ const keys = [];
  /** @type {Record<string,unknown>} */ const header = {};
  const counts = { questionDrafts: 0, scope: 0, submittedEventIds: 0 };
  /** @type {({kind:'scope',value:import('./contracts').AttemptScopeRecord}|{kind:'questionDrafts',value:import('./contracts').ResumeDraft}|{kind:'submittedEventIds',value:string})[]} */ const pending = [];
  const paths = v2Fields.filter(field => !arrays.includes(field)).map(field => `$.${field}`).concat(arrays.map(field => `$.${field}.*`));
  const parser = new JSONParser({ paths, keepStack: false, stringBufferSize: 65536 });
  // Exact installed 0.0.26 runtime members already used by this reader. This
  // local type view preserves the before/after write observation ordering;
  // it is not a public package API or a caller-provided parser authority.
  const internals = /** @type {{tokenParser:import('@streamparser/json').TokenParser,tokenizer:import('@streamparser/json').Tokenizer}} */(/** @type {unknown} */(parser));
  const writeToken = internals.tokenParser.write.bind(internals.tokenParser);
  internals.tokenizer.onToken = token => {
    const before = depth;
    if (first) { first = false; if (token.token !== TokenType.LEFT_BRACE) fail('RESUME_STREAM_OBJECT_REQUIRED'); canonicalHash.update(new Uint8Array([123])); }
    else if (before === 1 && token.token === TokenType.STRING) topString = token.value;
    else if (before === 1 && token.token === TokenType.COLON) {
      if (typeof topString !== 'string' || !v2Fields.includes(topString) || (keys.length && topString <= /** @type {string} */(keys[keys.length - 1]))) fail('RESUME_STREAM_ROOT_FIELDS');
      rootKey = topString; keys.push(rootKey); if (keys.length > 1) canonicalHash.update(new Uint8Array([44]));
      canonicalHash.update(new TextEncoder().encode(JSON.stringify(rootKey) + ':')); topString = null;
    }
    if (token.token === TokenType.LEFT_BRACE || token.token === TokenType.LEFT_BRACKET) {
      if (++depth > APP_DATA_CONTENT_LIMITS.maxDepth + 1) fail('RESUME_STREAM_DEPTH');
      if (!first && before === 1) {
        if (rootKey === 'snapshotBaseline') { if (token.token !== TokenType.LEFT_BRACE) fail('RESUME_STREAM_SCALAR_REQUIRED'); } else {
        if (token.token !== TokenType.LEFT_BRACKET || !arrays.includes(/** @type {string} */(rootKey))) fail('RESUME_STREAM_SCALAR_REQUIRED');
        activeArray = /** @type {'questionDrafts'|'scope'|'submittedEventIds'} */(rootKey); canonicalHash.update(new Uint8Array([91])); if (activeArray === 'scope') scopeHash.update(new Uint8Array([91])); }
      }
    }
    writeToken(token);
    if (token.token === TokenType.RIGHT_BRACKET && before === 2 && activeArray) {
      canonicalHash.update(new Uint8Array([93])); if (activeArray === 'scope') scopeHash.update(new Uint8Array([93]));
      activeArray = null; bytesSinceValue = 0;
    }
    if (token.token === TokenType.RIGHT_BRACE && before === 1) canonicalHash.update(new Uint8Array([125]));
    if (token.token === TokenType.RIGHT_BRACE || token.token === TokenType.RIGHT_BRACKET) depth--;
  };
  parser.onValue = ({ value, key, parent }) => {
    if (activeArray) {
      if (!Array.isArray(parent) || key !== counts[activeArray] || counts[activeArray] >= APP_DATA_CONTENT_LIMITS.maxArrayItems) fail('RESUME_STREAM_ARRAY');
      const bytes = canonicalContentBytes(value), owned = JSON.parse(new TextDecoder().decode(bytes));
      if (activeArray === 'scope') {
        validateAttemptScopeRecord(owned); if (owned.attemptId !== binding.attemptId || owned.ordinal !== counts.scope) fail('RESUME_STREAM_SCOPE_BINDING');
        if (counts.scope) scopeHash.update(new Uint8Array([44])); scopeHash.update(bytes);
      } else if (activeArray === 'questionDrafts') validateResumeDraftForAttempt(owned, { attemptId: binding.attemptId, ...(binding.parentAttemptId ? { parentAttemptId: binding.parentAttemptId } : {}) });
      else if (!isUuid(owned)) fail('RESUME_STREAM_EVENT_ID');
      if (counts[activeArray]++) canonicalHash.update(new Uint8Array([44])); canonicalHash.update(bytes);
      pending.push(/** @type {(typeof pending)[number]} */({ kind: activeArray, value: owned }));
    } else {
      if (typeof key !== 'string' || arrays.includes(key) || !v2Fields.includes(key) || Object.hasOwn(header, key)) fail('RESUME_STREAM_HEADER');
      const bytes = canonicalBytes(value); header[key] = JSON.parse(new TextDecoder().decode(bytes)); canonicalHash.update(bytes);
    }
    bytesSinceValue = 0;
  };
  const guard = () => { if (signal?.aborted) fail('CANCELLED'); };
  for await (const source of chunks) {
    guard(); if (!(source instanceof Uint8Array) || !source.length || source.length > APP_DATA_LIMITS.maxContentChunkBytes) fail('RESUME_STREAM_CHUNK');
    const bytes = new Uint8Array(source); received += bytes.length; bytesSinceValue += bytes.length;
    if (received > content.totalBytes || received > APP_DATA_CONTENT_LIMITS.maxCanonicalUtf8Bytes) fail('RESUME_STREAM_SIZE');
    // Legal typed draft/scope rows are <=3 MiB and field strings <=1 MiB.
    // One-chunk slack handles a row starting midway through a previous feed.
    if (bytesSinceValue > APP_DATA_LIMITS.maxCanonicalUtf8Bytes + APP_DATA_LIMITS.maxContentChunkBytes) fail('RESUME_STREAM_RECORD_SIZE');
    rawHash.update(bytes); parser.write(bytes);
    while (pending.length) { const row = /** @type {(typeof pending)[number]} */(pending.shift()); await (row.kind === 'scope' ? onScope(row.value) : row.kind === 'questionDrafts' ? onDraft(row.value) : onSubmittedEventId(row.value)); guard(); }
  }
  guard(); if (!parser.isEnded) parser.end();
  if (keys.join(',') !== (header.schemaVersion === 2 ? v2Fields : fields).join(',') || first || depth !== 0 || received !== content.totalBytes || counts.scope !== binding.scopeCount || counts.scope < 1 || counts.questionDrafts > counts.scope) fail('RESUME_STREAM_SIZE');
  if ((header.schemaVersion !== 1 && header.schemaVersion !== 2) || header.attemptId !== binding.attemptId || header.writerStreamId !== binding.writerStreamId || header.scopeDigest !== binding.scopeDigest || header.localRevision !== reference.localRevision || header.baseRevision !== reference.baseRevision || !integer(/** @type {number} */(header.localRevision)) || /** @type {number} */(header.localRevision) < 1 || !integer(/** @type {number} */(header.baseRevision)) || !integer(/** @type {number} */(header.position)) || /** @type {number} */(header.position) >= counts.scope || !integer(/** @type {number} */(header.effectiveElapsedMs))) fail('RESUME_STREAM_HEADER_BINDING');
  if (hex(rawHash.digest()) !== content.contentDigest || hex(canonicalHash.digest()) !== content.contentDigest || hex(scopeHash.digest()) !== binding.scopeDigest) fail('RESUME_STREAM_CANONICAL_DIGEST');
  if(header.schemaVersion === 2){validateSnapshotBaselineShape(header.snapshotBaseline);if(typeof onSnapshotBaseline !== 'function') fail('MISSING_SNAPSHOT_BASELINE_DEPENDENCY');await onSnapshotBaseline(header.snapshotBaseline);guard();}
  return { status: 'canonical_rows_streamed', header, counts, contentDigest: content.contentDigest, dependencyStatus: 'native_indexed_D12_sink_required' };
}
