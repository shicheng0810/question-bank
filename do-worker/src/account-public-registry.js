import {streamRegisteredPublicBankFields} from '../../src/storage/cloud-recovery/bank-content-stream-core.js';
import { validateBankRevisionRecord, validateContentReference } from '../../src/domain/app-data/content-records.js';
import { publicRegistryJson, publicRegistryDigest } from './account-public-registry.generated.js';
import { frozenPublicBanks } from '../../src/domain/question/frozen-public-registry.js';
import { isQuestionKey } from '../../src/domain/question/index.js';
import { canonicalBytes, sha256Hex } from '../../src/domain/app-data/canonical.js';

// Server configuration only. Empty/default configuration grants no public
// revision trust; a client supplied staticRef never becomes trusted by itself.
// Entries are produced from a separately verified immutable publish artifact.
export function loadAccountPublicRegistry(env) {
  const source = env?.GEN06_LOCAL_FIXTURE === '1' ? env.GEN06_PUBLIC_REGISTRY_JSON : publicRegistryJson;
  if (env?.GEN06_PUBLIC_REGISTRY_DIGEST && env.GEN06_PUBLIC_REGISTRY_DIGEST !== publicRegistryDigest) throw new Error('INVALID_PUBLIC_REGISTRY');
  if (source === undefined || source === '') return new Map();
  if (typeof source !== 'string' || new TextEncoder().encode(source).length > 3 * 1024 * 1024) throw new Error('INVALID_PUBLIC_REGISTRY');
  const values = env?.GEN06_LOCAL_FIXTURE === '1' ? JSON.parse(source) : structuredClone(frozenPublicBanks);
  if (!Array.isArray(values) || values.length > 100) throw new Error('INVALID_PUBLIC_REGISTRY');
  const registry = new Map();
  for (const entry of values) {
    if (!entry || Object.keys(entry).sort().join(',') !== 'bankUid,contentManifest,metadata,publicContentReference,questionsrefs,revision') throw new Error('INVALID_PUBLIC_REGISTRY');
    validateContentReference(entry.publicContentReference);
    if (entry.publicContentReference.contentDigest !== entry.revision) throw new Error('INVALID_PUBLIC_REGISTRY');
    const record = validateBankRevisionRecord({ bankUid: entry.bankUid, revision: entry.revision, metadata: entry.metadata, contentManifest: entry.contentManifest });
    if (record.metadata.visibility !== 'public' || record.contentManifest.kind !== 'public_static' || record.revision !== record.contentManifest.contentDigest || !Array.isArray(entry.questionsrefs) || entry.questionsrefs.length !== record.metadata.questionCount) throw new Error('INVALID_PUBLIC_REGISTRY');
    const questions = new Map();
    for (const question of entry.questionsrefs) {
      if (!question || Object.keys(question).sort().join(',') !== 'questionKey,questionRevision' || !isQuestionKey(question.questionKey) || !question.questionKey.startsWith(`${record.bankUid}/`) || !/^[0-9a-f]{64}$/.test(question.questionRevision)) throw new Error('INVALID_PUBLIC_REGISTRY');
      if (questions.has(question.questionKey)) throw new Error('INVALID_PUBLIC_REGISTRY');
      questions.set(question.questionKey, question.questionRevision);
    }
    const key = `${record.bankUid}:${record.revision}`;
    if (registry.has(key)) throw new Error('INVALID_PUBLIC_REGISTRY');
    registry.set(key, { record: structuredClone(record), questions, publicContentReference: structuredClone(entry.publicContentReference) });
  }
  // Bound the configuration snapshot before it is used across any awaits.
  canonicalBytes(values);
  return registry;
}

/** Read only a server-frozen public revision. Neither a client URL nor the
 * current catalog substitutes for the exact immutable registry member.
 * The original body and every question projection are fully stream-verified.
 * content.questions retains only the input fields used by snapshot baselines;
 * it is not a renderable body or an input to validateBankContent. Images,
 * answer keys and unknown fields participate in the original SHA but are not
 * cached. Public limits: 20MiB body, 8MiB leaves/question, 2MiB retained input
 * index; existing field/depth/count limits and private3MiB rule still apply.
 * @param {{ASSETS?:{fetch:(request:Request)=>Promise<Response>},GEN06_LOCAL_FIXTURE?:string}} env
 * @param {import('../../src/domain/app-data/contracts').BankRevisionRecord} record
 * @param {Map<string,{record:import('../../src/domain/app-data/contracts').BankRevisionRecord,questions:Map<string,string>,publicContentReference:import('../../src/domain/app-data/contracts').ContentReference}>} registry
 */
export async function readFrozenAccountPublicBank(env, record, registry) {
  const trusted = registry.get(`${record.bankUid}:${record.revision}`);
  const same = (/** @type {unknown} */ a, /** @type {unknown} */ b) => new TextDecoder().decode(canonicalBytes(a)) === new TextDecoder().decode(canonicalBytes(b));
  if (!trusted || !same(trusted.record, record)) throw new Error('UNTRUSTED_PUBLIC_REFERENCE');
  if(trusted.record.contentManifest.kind!=='public_static')throw new Error('UNTRUSTED_PUBLIC_REFERENCE');
  const reference = trusted.publicContentReference, path = trusted.record.contentManifest.staticRef;
  if (typeof path !== 'string' || !/^banks\/v2\/[a-z0-9-]+\.[0-9a-f]{64}\.json$/.test(path) || !path.endsWith(`.${record.revision}.json`)
      || reference.contentDigest !== record.revision || reference.totalBytes > 20 * 1024 * 1024) throw new Error('INVALID_PUBLIC_REFERENCE');
  // Same canonical static origin already used by the account/mirror routing.
  // In local fixtures the existing asset binding supplies exactly these bytes.
  const signal=AbortSignal.timeout(30000),started=Date.now();
  const check=()=>{if(signal.aborted||Date.now()-started>30000)throw new Error('PUBLIC_CONTENT_TIMEOUT');};
  /** @template T @param {Promise<T>} operation @returns {Promise<T>} */
  async function bounded(operation){check();/** @type {()=>void} */let abort=()=>{};try{return await Promise.race([operation,new Promise((/** @type {(value:never)=>void} */ resolve,reject)=>{abort=()=>reject(new Error('PUBLIC_CONTENT_TIMEOUT'));signal.addEventListener('abort',abort,{once:true});})]);}finally{signal.removeEventListener('abort',abort);}}
  const request = new Request(new URL(path, 'https://question-bank-78u.pages.dev/'), {redirect:'manual',signal,headers:{'Accept-Encoding':'identity'}});
  if (env.GEN06_LOCAL_FIXTURE === '1' && !env.ASSETS) throw new Error('MISSING_PUBLIC_CONTENT');
  const response = await bounded(env.ASSETS ? env.ASSETS.fetch(request) : fetch(request));
  try{
  if (response.status!==200 || !response.body || response.redirected) throw new Error('MISSING_PUBLIC_CONTENT');
  const length=response.headers.get('content-length');
  if(length!==null&&(!/^(0|[1-9][0-9]*)$/.test(length)||Number(length)!==reference.totalBytes))throw new Error('PUBLIC_CONTENT_LENGTH');
  const encoding=response.headers.get('content-encoding');
  if(encoding&&encoding!=='identity')throw new Error('PUBLIC_CONTENT_ENCODING');
  }catch(error){await response.body?.cancel().catch(()=>{});throw error;}
  const reader=response.body.getReader();
  /** @type {{chunkIndex:number,byteLength:number,sha256:string}[]} */const chunks=[];
  /** @type {import('../../src/domain/question/bank-content').RegisteredQuestionContent[]} */const questions=[];
  /** @type {import('../../src/domain/app-data/contracts').EquivalentSourceRef[]} */const questionRefs=[];
  let received=0,part=new Uint8Array(512*1024),used=0,retainedProjectionBytes=0;
  async function finishPart(){const bytes=part.subarray(0,used);chunks.push({chunkIndex:chunks.length,byteLength:used,sha256:await sha256Hex(bytes)});part=new Uint8Array(512*1024);used=0;return bytes;}
  async function* body(){try{for(;;){check();const next=await bounded(reader.read());check();if(next.done)break;const bytes=next.value;if(!(bytes instanceof Uint8Array))throw new Error('PUBLIC_CONTENT_DIGEST');received+=bytes.length;if(received>reference.totalBytes||received>20*1048576)throw new Error('PUBLIC_CONTENT_DIGEST');for(let offset=0;offset<bytes.length;){const take=Math.min(part.length-used,bytes.length-offset);part.set(bytes.subarray(offset,offset+take),used);offset+=take;used+=take;if(used===part.length)yield await finishPart();}}if(used)yield await finishPart();if(received!==reference.totalBytes)throw new Error('PUBLIC_CONTENT_DIGEST');}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}}
  const checked=await streamRegisteredPublicBankFields({chunks:body(),reference,signal,check,
    onQuestion:row=>{if(trusted.questions.get(row.questionKey)!==row.questionRevision)throw new Error('PUBLIC_CONTENT_BINDING');questionRefs.push(row);},
    onQuestionContent:question=>{const projection=/** @type {Record<string,unknown>} */({});for(const key of ['bankUid','questionUid','questionKey','questionRevision','type','question','choices','optionIds','blanks'])if(Object.hasOwn(question,key))projection[key]=question[key];retainedProjectionBytes+=canonicalBytes(projection).length;if(retainedProjectionBytes>2*1048576)throw new Error('PUBLIC_PROJECTION_LIMIT');questions.push(/** @type {import('../../src/domain/question/bank-content').RegisteredQuestionContent} */(projection));}
  });
  if(checked.bankUid!==record.bankUid||!same(checked.metadata,record.metadata)||questionRefs.length!==trusted.questions.size)throw new Error('PUBLIC_CONTENT_BINDING');
  const manifest={schemaVersion:1,contentDigest:reference.contentDigest,totalBytes:received,chunkCount:chunks.length,chunks};
  if(manifest.chunkCount!==reference.chunkCount||await sha256Hex(canonicalBytes(manifest))!==reference.manifestDigest)throw new Error('PUBLIC_MANIFEST_BINDING');
  return {content:/** @type {import('../../src/domain/question/bank-content').RegisteredBankContent} */({format:'qb-bank-content-v2',schemaVersion:1,bankUid:checked.bankUid,metadata:checked.metadata,questions}),contentDigest:checked.contentDigest,questionRefs,retainedProjectionBytes,peakLeafBytes:checked.peakLeafBytes};
}
