import { JSONParser, TokenType } from '@streamparser/json';
import { sha256 } from '@noble/hashes/sha2.js';
import { canonicalBytes, canonicalContentBytes } from './canonical.js';
import { validateContentReference } from './content-records.js';
import { validateAttemptScopeRecord } from './core-records.js';
import { APP_DATA_CONTENT_LIMITS, APP_DATA_LIMITS } from './constants.js';
import { isUuid } from '../question/index.js';

/** @param {string} code @returns {never} */
const fail = code => { throw Object.assign(new Error(code), { code }); };
/** @param {Uint8Array} value @returns {string} */
const hex = value => Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('');
/** Stream ONE canonical scope array, with no retained whole-body array.
 * This is a byte/typed-row reader, NOT a complete dependency proof: onRow
 * must write INACTIVE, quarantinable native staging only: full byte equality
 * is not known until the stream ends. That sink must enforce global
 * representative/source uniqueness and registered bank dependencies before
 * any final transaction can publish a dependency proof. No production
 * handler currently consumes this helper. There is no client proof DTO.
 * @param {{chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>, reference: import('./contracts').ContentReference, expectedAttemptId:string, expectedScopeCount:number, onRow:(row:import('./contracts').AttemptScopeRecord)=>unknown | Promise<unknown>, signal?:AbortSignal}} input
 */
export async function streamCanonicalScopeRows({ chunks, reference, expectedAttemptId, expectedScopeCount, onRow, signal }) {
  const ownedReference = JSON.parse(new TextDecoder().decode(canonicalBytes(reference)));
  validateContentReference(ownedReference);
  if (!isUuid(expectedAttemptId) || !Number.isSafeInteger(expectedScopeCount) || expectedScopeCount < 1 || expectedScopeCount > APP_DATA_CONTENT_LIMITS.maxArrayItems || typeof onRow !== 'function') fail('SCOPE_STREAM_BINDING');
  const rawHash = sha256.create(), canonicalHash = sha256.create(); canonicalHash.update(new Uint8Array([91]));
  let received = 0, count = 0, depth = 0, first = true, bytesSinceRow = 0;
  /** @type {import('./contracts').AttemptScopeRecord[]} */
  const pending = [];
  const parser = new JSONParser({ paths: ['$.*'], keepStack: false, stringBufferSize: 65536 });
  // Exact installed 0.0.26 runtime members already used by this reader. This
  // local type view does not change callback/write ordering or accept a parser
  // supplied by callers; its member types are the official exported classes.
  const internals = /** @type {{tokenParser:import('@streamparser/json').TokenParser,tokenizer:import('@streamparser/json').Tokenizer}} */(/** @type {unknown} */(parser));
  const writeToken = internals.tokenParser.write.bind(internals.tokenParser);
  internals.tokenizer.onToken = token => {
    if (first) { first = false; if (token.token !== TokenType.LEFT_BRACKET) fail('SCOPE_STREAM_ARRAY_REQUIRED'); }
    if (token.token === TokenType.LEFT_BRACKET || token.token === TokenType.LEFT_BRACE) { if (++depth > APP_DATA_CONTENT_LIMITS.maxDepth + 1) fail('SCOPE_STREAM_DEPTH'); }
    writeToken(token);
    if (token.token === TokenType.RIGHT_BRACKET || token.token === TokenType.RIGHT_BRACE) depth--;
  };
  parser.onValue = ({ value, key, parent }) => {
    if (!Array.isArray(parent) || key !== count) fail('SCOPE_STREAM_ARRAY_REQUIRED');
    const bytes = canonicalContentBytes(value), row = JSON.parse(new TextDecoder().decode(bytes));
    validateAttemptScopeRecord(row);
    if (row.attemptId !== expectedAttemptId || row.ordinal !== count || count >= expectedScopeCount) fail('SCOPE_STREAM_ROW_BINDING');
    if (count++) canonicalHash.update(new Uint8Array([44]));
    canonicalHash.update(bytes); pending.push(row); bytesSinceRow = 0;
  };
  const guard = () => { if (signal?.aborted) fail('CANCELLED'); };
  for await (const source of chunks) {
    guard();
    if (!(source instanceof Uint8Array) || !source.length || source.length > APP_DATA_LIMITS.maxContentChunkBytes) fail('SCOPE_STREAM_CHUNK');
    const bytes = new Uint8Array(source); received += bytes.length; bytesSinceRow += bytes.length;
    if (received > ownedReference.totalBytes || received > APP_DATA_CONTENT_LIMITS.maxCanonicalUtf8Bytes) fail('SCOPE_STREAM_SIZE');
    // Scope rows use the EXISTING small-record budget. This bounds malformed
    // tokens before they can grow to the full 100 MiB content budget; the
    // additional one chunk allows for a row beginning inside a prior chunk.
    if (bytesSinceRow > APP_DATA_LIMITS.maxCanonicalUtf8Bytes + APP_DATA_LIMITS.maxContentChunkBytes) fail('SCOPE_STREAM_ROW_SIZE');
    rawHash.update(bytes); parser.write(bytes);
    while (pending.length) { const row = /** @type {import('./contracts').AttemptScopeRecord} */(pending.shift()); await onRow(row); guard(); }
  }
  guard(); if (!parser.isEnded) parser.end();
  if (first || depth !== 0 || count !== expectedScopeCount || received !== ownedReference.totalBytes) fail('SCOPE_STREAM_SIZE');
  canonicalHash.update(new Uint8Array([93]));
  if (hex(rawHash.digest()) !== ownedReference.contentDigest || hex(canonicalHash.digest()) !== ownedReference.contentDigest) fail('SCOPE_STREAM_CANONICAL_DIGEST');
  return { status: 'canonical_rows_streamed', attemptId: expectedAttemptId, count, contentDigest: ownedReference.contentDigest, dependencyStatus: 'native_indexed_sink_required' };
}
