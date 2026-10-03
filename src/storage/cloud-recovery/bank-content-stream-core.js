import {JSONParser,TokenType} from '@streamparser/json';
import {sha256} from '@noble/hashes/sha2.js';
import {canonicalBytes,canonicalContentBytes} from '../../domain/app-data/canonical.js';
import {validateBankMetadata,validateContentReference} from '../../domain/app-data/content-records.js';
import {validateQuestionSemanticFields} from '../../domain/question/content-identity.js';
import {isUuid,isQuestionKey} from '../../domain/question/index.js';
import {streamCanonicalJSONString} from './canonical-string-stream-core.js';

/** @typedef {{chunks:AsyncIterable<Uint8Array>,reference:import('../../domain/app-data/contracts').ContentReference,onQuestion:(row:import('../../domain/app-data/contracts').EquivalentSourceRef)=>unknown|Promise<unknown>,onQuestionContent?:(question:import('../../domain/question/bank-content').RegisteredQuestionContent)=>unknown|Promise<unknown>,signal?:AbortSignal,check?:()=>void}} BankStreamInput */
/** @typedef {{stage:(input:{chunks:AsyncIterable<Uint8Array>,signal?:AbortSignal})=>Promise<object>,owns:(value:unknown)=>boolean,open:(value:unknown)=>Promise<{chunks:()=>AsyncIterable<Uint8Array>}>,imagePresence:(value:unknown)=>Promise<boolean>,releaseQuestion?:()=>void}} StringStore */
/** @param {string} code @returns {never} */
const fail=code=>{throw Object.assign(new Error(code),{code});};
const MAX=100*1048576,ROW=3*1048576,PART=512*1024;
const fields=['bankUid','format','metadata','questions','schemaVersion'];
const hex=bytes=>Array.from(bytes,v=>v.toString(16).padStart(2,'0')).join('');

/** Bounded typed bank-body component, never account/storage/Ready authority.
 * Derives the full field-stream projection, preserving unknown safe content.
 * A single field or retained semantic aggregate >3MiB remains unsupported.
 * The sink observes validated refs only; its return value grants no authority.
 */
/** @param {BankStreamInput} input */
export async function streamRegisteredBankContent({chunks,reference,onQuestion,signal}){
 return streamRegisteredBankFields({chunks,reference,onQuestion,signal});
}

const IDENTITY=new Set(['id','source','banks','bankUid','questionUid','questionKey','questionRevision','optionIds','provenance']);
const SEMANTIC=new Set(['type','question','image','choices','answer','answers','blanks','answer_sets','bankUid','questionUid','questionKey','questionRevision','optionIds']);
/** Complete field projection, without constructing a whole question. Every
 * field is original-canonical-validated; unknown safe fields remain in SHA.
 * A >3MiB individual field/token still fails closed before parser growth. */
/** @param {BankStreamInput} input */
export async function streamRegisteredBankFields(input){return fieldStream(input,null);}
/** @param {BankStreamInput} input @param {StringStore} strings */
export async function streamRegisteredBankFieldsWithStringStore(input,strings){return fieldStream(input,strings);}
/** Public static bodies use the existing canonical leaf validator with an
 * ephemeral, opaque store. At most 8MiB of leaf bytes survive within one
 * question; they are released after that question is fully validated. */
/** @param {BankStreamInput} input */
export async function streamRegisteredPublicBankFields(input){
 /** @type {WeakMap<object,{parts:Uint8Array[],summary:Awaited<ReturnType<typeof streamCanonicalJSONString>>}>} */
 const leaves=new WeakMap();/** @type {Set<object>} */const current=new Set();let retained=0,peakLeafBytes=0;
 const guard=()=>{if(input.signal?.aborted)fail('CANCELLED');input.check?.();};
 /** @type {StringStore} */
 const strings={
  async stage({chunks,signal}){const parts=/** @type {Uint8Array[]} */([]);const summary=await streamCanonicalJSONString({chunks,signal,check:guard,onCanonicalBytes:bytes=>{retained+=bytes.length;if(retained>8*1048576)fail('PUBLIC_STRING_LIMIT');peakLeafBytes=Math.max(peakLeafBytes,retained);parts.push(bytes);}});const locator=Object.freeze({});leaves.set(locator,{parts,summary});current.add(locator);return locator;},
  owns(value){return value!==null&&typeof value==='object'&&leaves.has(value);},
  async open(value){guard();const leaf=value!==null&&typeof value==='object'?leaves.get(value):undefined;if(!leaf)fail('PUBLIC_STRING_LOCATOR');return {summary:leaf.summary,async *chunks(){for(const bytes of leaf.parts){guard();yield bytes;}}};},
  async imagePresence(value){const leaf=value!==null&&typeof value==='object'?leaves.get(value):undefined;if(!leaf)fail('PUBLIC_STRING_LOCATOR');guard();return leaf.summary.utf16Length>0;},
  releaseQuestion(){for(const value of current)leaves.delete(value);current.clear();retained=0;}
 };
 try{return {...await fieldStream(input,strings),peakLeafBytes};}finally{strings.releaseQuestion?.();}
}
/** @param {BankStreamInput} input @param {StringStore|null} privateStrings */
async function fieldStream({chunks,reference,onQuestion,onQuestionContent,signal,check},privateStrings){
 const ref=JSON.parse(new TextDecoder().decode(canonicalBytes(reference)));validateContentReference(ref);if(typeof onQuestion!=='function')fail('BANK_STREAM_INPUT');
 const rawHash=sha256.create(),bodyHash=sha256.create(),header={},rootKeys=[],seen=new Set(),pending=[],operations=[];
 const update=(hash,bytes)=>operations.push(async()=>{hash.update(bytes);});
 let first=true,depth=0,topString=null,rootKey=null,inQuestions=false,question=null,count=0,received=0,sinceValue=0,lastToken=null;const containers=[];
 const encode=text=>new TextEncoder().encode(text),guard=()=>{if(signal?.aborted)fail('CANCELLED');if(typeof check==='function')check();};
 const parser=new JSONParser({paths:['$.bankUid','$.format','$.metadata','$.schemaVersion','$.questions.*.*'],keepStack:false,stringBufferSize:65536}),writeToken=parser.tokenParser.write.bind(parser.tokenParser);
 parser.tokenizer.onToken=token=>{const before=depth;
  if(first){first=false;if(token.token!==TokenType.LEFT_BRACE)fail('BANK_STREAM_WRAPPER');update(bodyHash,encode('{'));}
  else if(before===1&&token.token===TokenType.STRING)topString=token.value;
  else if(before===1&&token.token===TokenType.COLON){if(typeof topString!=='string'||!fields.includes(topString)||rootKeys.length&&topString<=rootKeys.at(-1))fail('BANK_STREAM_ROOT_FIELDS');rootKey=topString;rootKeys.push(rootKey);if(rootKeys.length>1)update(bodyHash,encode(','));update(bodyHash,encode(JSON.stringify(rootKey)+':'));topString=null;}
  else if(before===3&&question&&token.token===TokenType.STRING)question.keyToken=token.value;
  else if(before===3&&question&&token.token===TokenType.COLON){const key=question.keyToken;if(typeof key!=='string'||['__proto__','prototype','constructor'].includes(key)||question.keys.length&&key<=question.keys.at(-1))fail('BANK_STREAM_QUESTION_FIELDS');if(question.keys.length>=1000)fail('BANK_STREAM_QUESTION_FIELDS');question.keys.push(key);question.field=key;if(question.keys.length>1)update(bodyHash,encode(','));update(bodyHash,encode(JSON.stringify(key)+':'));if(!IDENTITY.has(key)){if(question.projected++)update(question.hash,encode(','));update(question.hash,encode(JSON.stringify(key)+':'));}question.keyToken=null;}
  if(token.token===TokenType.LEFT_BRACE||token.token===TokenType.LEFT_BRACKET){containers.push(token.token);if(++depth>33)fail('BANK_STREAM_DEPTH');if(before===1){if(rootKey==='questions'){if(token.token!==TokenType.LEFT_BRACKET)fail('BANK_STREAM_WRAPPER');inQuestions=true;update(bodyHash,encode('['));}else if(rootKey!=='metadata'||token.token!==TokenType.LEFT_BRACE)fail('BANK_STREAM_WRAPPER');}
   else if(before===2&&inQuestions){if(token.token!==TokenType.LEFT_BRACE||question||count>=5000)fail('BANK_STREAM_QUESTION_COUNT');if(count)update(bodyHash,encode(','));update(bodyHash,encode('{'));question={keys:[],field:null,keyToken:null,projected:0,semantic:{},retained:0,hash:sha256.create()};update(question.hash,encode('{"content":{'));}}
  writeToken(token);
  if(token.token===TokenType.RIGHT_BRACE&&before===3&&question){if(question.field!==null)fail('BANK_STREAM_QUESTION_FIELDS');update(bodyHash,encode('}'));update(question.hash,encode('},"projectionVersion":1}'));const completed=question;operations.push(async()=>{pending.push({value:completed.semantic,revision:hex(completed.hash.digest())});});question=null;count++;sinceValue=0;}
  if(token.token===TokenType.RIGHT_BRACKET&&before===2&&inQuestions){if(question)fail('BANK_STREAM_WRAPPER');update(bodyHash,encode(']'));inQuestions=false;sinceValue=0;}
  if(token.token===TokenType.RIGHT_BRACE&&before===1)update(bodyHash,encode('}'));
  if(token.token===TokenType.RIGHT_BRACE||token.token===TokenType.RIGHT_BRACKET){depth--;containers.pop();}lastToken=token.token;
 };
 parser.onValue=({value,key})=>{
  if(inQuestions){if(!question||typeof key!=='string'||key!==question.field)fail('BANK_STREAM_QUESTION_FIELDS');const bytes=canonicalContentBytes(value);if(bytes.length>ROW)fail('FINAL_BANK_QUESTION_STREAMING_UNIMPLEMENTED');const current=question;operations.push(async()=>{for await(const bytes of canonicalField(value)){bodyHash.update(bytes);if(!IDENTITY.has(key))current.hash.update(bytes);}});if(SEMANTIC.has(key)){question.retained+=bytes.length;if(question.retained>ROW)fail('FINAL_BANK_SEMANTIC_FIELDS_STREAMING_UNIMPLEMENTED');question.semantic[key]=value;}question.field=null;}
  else{if(typeof key!=='string'||key==='questions'||!fields.includes(key)||Object.hasOwn(header,key))fail('BANK_STREAM_ROOT_FIELDS');const bytes=canonicalBytes(value);(/** @type {Record<string,unknown>} */(header))[key]=JSON.parse(new TextDecoder().decode(bytes));update(bodyHash,bytes);}sinceValue=0;
 };
 async function* canonicalField(value){guard();if(privateStrings?.owns(value)){const leaf=await privateStrings.open(value);for await(const bytes of leaf.chunks()){guard();yield bytes;}return;}if(value===null||typeof value!=='object'){yield canonicalContentBytes(value);return;}if(Array.isArray(value)){yield encode('[');for(let i=0;i<value.length;i++){if(i)yield encode(',');yield* canonicalField(value[i]);}yield encode(']');return;}yield encode('{');let first=true;for(const key of Object.keys(value).sort()){if(!first)yield encode(',');first=false;yield encode(JSON.stringify(key)+':');yield* canonicalField(value[key]);}yield encode('}');}
 async function flush(){while(operations.length){guard();await operations.shift()();}while(pending.length){guard();const {value:q,revision}=pending.shift();if(header.format!=='qb-bank-content-v2'||!isUuid(header.bankUid)||q.bankUid!==header.bankUid||!isUuid(q.questionUid)||!isQuestionKey(q.questionKey)||q.questionKey!==`${header.bankUid}/${q.questionUid}`||seen.has(q.questionKey))fail('registered_identity');if(q.type!==undefined&&!['choice','fill'].includes(q.type))fail('unsupported_type');seen.add(q.questionKey);
   // Reuse original semantics on all semantic fields. Unknown fields were
   // validated and streamed into the full original projection SHA above.
   const image=q.image;
   const imageMedia=async value=>{if(privateStrings?.owns(value))return privateStrings.imagePresence(value);return Boolean(value&&typeof value==='string');};
   let hasMedia;if(Array.isArray(image))hasMedia=image.length>0;else hasMedia=await imageMedia(image);
   validateQuestionSemanticFields(q,hasMedia);guard();if(q.questionRevision!==revision||!Array.isArray(q.optionIds))fail('question_revision');const choices=q.type==='fill'?[]:q.choices;if(q.optionIds.length!==choices.length)fail('question_revision');for(let index=0;index<choices.length;index++){const id=`opt_${hex(sha256(canonicalContentBytes({optionIdentityVersion:1,questionRevision:revision,index})))}`;if(q.optionIds[index]!==id)fail('question_revision');}await onQuestion({questionKey:q.questionKey,questionRevision:revision});if(typeof onQuestionContent==='function')await onQuestionContent(q);guard();privateStrings?.releaseQuestion?.();}}
 // Only string boundaries are framed here; official parser retains all JSON
 // structure/grammar. Giant unknown STRING values are genuine private native
 // leaf locators, never placeholder semantic/identity strings.
 function channel(){let waiting=null,queued=null,ended=false,error=null;return {push:bytes=>new Promise((resolve,reject)=>{if(error){reject(error);return;}if(ended||queued){reject(new Error('BANK_STREAM_CHANNEL'));return;}if(waiting){const next=waiting;waiting=null;resolve();next({value:bytes,done:false});}else queued={bytes,resolve,reject};}),end:()=>{ended=true;if(waiting){waiting({done:true});waiting=null;}},fail:cause=>{error=cause;queued?.reject(cause);queued=null;if(waiting){waiting(Promise.reject(cause));waiting=null;}},[Symbol.asyncIterator](){return this;},next(){if(error)return Promise.reject(error);if(queued){const item=queued;queued=null;item.resolve();return Promise.resolve({value:item.bytes,done:false});}if(ended)return Promise.resolve({done:true});return new Promise(resolve=>{waiting=resolve;});}};}
 let inString=false,escaped=false,held=[],stringBytes=0,pipe=null,flight=null;
 async function feed(bytes){if(!bytes.length)return;sinceValue+=bytes.length;if(sinceValue>ROW+PART)fail('FINAL_BANK_QUESTION_STREAMING_UNIMPLEMENTED');parser.write(bytes);await flush();}
 async function stringPart(bytes,complete){if(!privateStrings)fail('BANK_STREAM_INPUT');if(bytes.length){stringBytes+=bytes.length;const part=new Uint8Array(bytes);if(!pipe&&stringBytes>ROW){const isValue=lastToken===TokenType.COLON||lastToken===TokenType.LEFT_BRACKET||lastToken===TokenType.COMMA&&containers.at(-1)===TokenType.LEFT_BRACKET;
    if(!question||!question.field||SEMANTIC.has(question.field)&&question.field!=='image'||IDENTITY.has(question.field)||!isValue)fail('FINAL_BANK_SEMANTIC_FIELDS_STREAMING_UNIMPLEMENTED');pipe=channel();flight=privateStrings.stage({chunks:pipe,signal});void flight.catch(cause=>pipe?.fail(cause));for(const prior of held)await pipe.push(prior);held=[];}
   if(pipe)await pipe.push(part);else held.push(part);}
  if(complete){if(pipe){pipe.end();const locator=await flight;parser.tokenizer.onToken({token:TokenType.STRING,value:locator});await flush();}else{const bytes=new Uint8Array(stringBytes);let offset=0;for(const part of held){bytes.set(part,offset);offset+=part.length;}await feed(bytes);}held=[];stringBytes=0;pipe=null;flight=null;}}
 try{for await(const source of chunks){guard();if(!(source instanceof Uint8Array)||!source.length||source.length>PART)fail('BANK_STREAM_CHUNK');const bytes=new Uint8Array(source);received+=bytes.length;if(received>ref.totalBytes||received>MAX)fail('BANK_STREAM_SIZE');rawHash.update(bytes);
   if(!privateStrings){sinceValue+=bytes.length;if(sinceValue>ROW+PART)fail('FINAL_BANK_QUESTION_STREAMING_UNIMPLEMENTED');parser.write(bytes);await flush();continue;}
   let start=0;for(let index=0;index<bytes.length;index++){const byte=bytes[index];if(!inString){if(byte===34){await feed(bytes.slice(start,index));inString=true;escaped=false;start=index;}}
    else if(escaped)escaped=false;else if(byte===92)escaped=true;else if(byte===34){await stringPart(bytes.slice(start,index+1),true);inString=false;start=index+1;}}
   if(inString)await stringPart(bytes.slice(start),false);else await feed(bytes.slice(start));
  }if(inString)fail('BANK_STREAM_WRAPPER');
 }catch(cause){pipe?.fail(cause);if(flight)await flight.catch(()=>{});throw cause;}
 guard();if(!parser.isEnded)parser.end();await flush();if(first||depth!==0||question||rootKeys.join()!==fields.join()||received!==ref.totalBytes||header.format!=='qb-bank-content-v2'||header.schemaVersion!==1||!isUuid(header.bankUid))fail('BANK_STREAM_WRAPPER');validateBankMetadata(header.metadata);if(header.metadata.visibility==='protected')fail('protected_plaintext');if(count!==header.metadata.questionCount)fail('BANK_STREAM_QUESTION_COUNT');if(header.metadata.visibility==='private'&&received>ROW)fail('bank_content_limit');if(hex(rawHash.digest())!==ref.contentDigest||hex(bodyHash.digest())!==ref.contentDigest)fail('BANK_STREAM_CANONICAL_DIGEST');return {status:'registered_bank_questions_verified',bankUid:header.bankUid,metadata:header.metadata,questionCount:count,contentDigest:ref.contentDigest,proofClass:'registered-full-body-derived',ready:false};
}
