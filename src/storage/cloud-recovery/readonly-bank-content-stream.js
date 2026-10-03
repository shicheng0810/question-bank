import {JSONParser,TokenType} from '@streamparser/json';
import {sha256} from '@noble/hashes/sha2.js';
import {canonicalBytes,canonicalContentBytes} from '../../domain/app-data/canonical.js';
import {validateBankMetadata,validateContentReference} from '../../domain/app-data/content-records.js';
import {validateQuestionSemanticFields} from '../../domain/question/content-identity.js';
import {isUuid,isQuestionKey} from '../../domain/question/index.js';
import{createReadonlyCanonicalStringStore}from'./readonly-canonical-string-store.js';
import{assertReadonlyStringWorkspace,readReadonlySourceChunk}from'../idb/readonly-content-ranges.js';
const fail=code=>{throw Object.assign(new Error(code),{code});},MAX=100*1048576,ROW=3*1048576,PART=512*1024;
const fields=['bankUid','format','metadata','questions','schemaVersion'];
const hex=bytes=>Array.from(bytes,v=>v.toString(16).padStart(2,'0')).join('');

const IDENTITY=new Set(['id','source','banks','bankUid','questionUid','questionKey','questionRevision','optionIds','provenance']);
const SEMANTIC=new Set(['type','question','image','choices','answer','answers','blanks','answer_sets','bankUid','questionUid','questionKey','questionRevision','optionIds']);
// Display-only values, never a registered question or grading input. Large
// media/unknown fields are hydrated from the genuine selected native range.
const DISPLAY=new Set(['id','source','sources','banks','type','question','choices','answer','answers','blanks','answer_sets','optionIds','question_html','section','passage','title','category','subject','translations','question_zh','question_es','image','images']);
const DISPLAY_FIELD=32768,DISPLAY_ROW=65536;
export async function createReadonlyRegisteredBankStreamer(database,workspace){
 assertReadonlyStringWorkspace(workspace,database);const strings=await createReadonlyCanonicalStringStore(database,workspace);let closed=false;
 const check=()=>{if(closed)fail('CLOSED');assertReadonlyStringWorkspace(workspace,database);};
 return Object.freeze({stream:async({onQuestion,signal}={})=>{
  check();if(typeof onQuestion!=='function')fail('BANK_STREAM_INPUT');let inString=false,escaped=false,offset=0,questionStart=null,ordinal=0;const containers=[],ranges=[];
  async function* sourceChunks(){check();let index=0;for await(const token of workspace.tokens()){check();const row=await readReadonlySourceChunk(token,workspace,database);check();if(row.chunkIndex!==index++)fail('READONLY_SOURCE_CHUNK');for(let i=0;i<row.bytes.length;i++){const byte=row.bytes[i];if(inString){if(escaped)escaped=false;else if(byte===92)escaped=true;else if(byte===34)inString=false;continue;}if(byte===34){inString=true;continue;}if(byte===123||byte===91){if(byte===123&&containers.length===2&&containers[1]===91)questionStart=offset+i;containers.push(byte);}else if(byte===125||byte===93){if(byte===125&&containers.length===3&&containers[1]===91){if(questionStart===null||ranges.length>=5000)fail('BANK_STREAM_QUESTION_COUNT');ranges.push({start:questionStart,end:offset+i+1});questionStart=null;}containers.pop();}}offset+=row.bytes.length;yield row.bytes;check();}if(index!==workspace.reference.chunkCount)fail('READONLY_SOURCE_CHUNK');check();}
  const result=await fieldStream({chunks:sourceChunks(),reference:workspace.reference,onQuestion:async ref=>{check();const range=ranges[ordinal];if(!range)fail('BANK_STREAM_QUESTION_RANGE');await onQuestion({...ref,ordinal:ordinal++,sourceRange:Object.freeze({...range})});check();},signal},strings);check();if(ordinal!==ranges.length||offset!==workspace.reference.totalBytes)fail('BANK_STREAM_QUESTION_RANGE');return result;
 },close:()=>{closed=true;strings.close();},ready:false});
}
async function fieldStream({chunks,reference,onQuestion,signal},privateStrings){
 const ref=JSON.parse(new TextDecoder().decode(canonicalBytes(reference)));validateContentReference(ref);if(typeof onQuestion!=='function')fail('BANK_STREAM_INPUT');
 const rawHash=sha256.create(),bodyHash=sha256.create(),header={},rootKeys=[],seen=new Set(),pending=[],operations=[];
 const update=(hash,bytes)=>operations.push(async()=>{hash.update(bytes);});
 let first=true,depth=0,topString=null,rootKey=null,inQuestions=false,question=null,count=0,received=0,sinceValue=0,lastToken=null;const containers=[];
 const encode=text=>new TextEncoder().encode(text),guard=()=>{if(signal?.aborted)fail('CANCELLED');};
 const parser=new JSONParser({paths:['$.bankUid','$.format','$.metadata','$.schemaVersion','$.questions.*.*'],keepStack:false,stringBufferSize:65536}),writeToken=parser.tokenParser.write.bind(parser.tokenParser);
 parser.tokenizer.onToken=token=>{const before=depth;
  if(first){first=false;if(token.token!==TokenType.LEFT_BRACE)fail('BANK_STREAM_WRAPPER');update(bodyHash,encode('{'));}
  else if(before===1&&token.token===TokenType.STRING)topString=token.value;
  else if(before===1&&token.token===TokenType.COLON){if(typeof topString!=='string'||!fields.includes(topString)||rootKeys.length&&topString<=rootKeys.at(-1))fail('BANK_STREAM_ROOT_FIELDS');rootKey=topString;rootKeys.push(rootKey);if(rootKeys.length>1)update(bodyHash,encode(','));update(bodyHash,encode(JSON.stringify(rootKey)+':'));topString=null;}
  else if(before===3&&question&&token.token===TokenType.STRING)question.keyToken=token.value;
  else if(before===3&&question&&token.token===TokenType.COLON){const key=question.keyToken;if(typeof key!=='string'||['__proto__','prototype','constructor'].includes(key)||question.keys.length&&key<=question.keys.at(-1))fail('BANK_STREAM_QUESTION_FIELDS');if(question.keys.length>=1000)fail('BANK_STREAM_QUESTION_FIELDS');question.keys.push(key);question.field=key;if(question.keys.length>1)update(bodyHash,encode(','));update(bodyHash,encode(JSON.stringify(key)+':'));if(!IDENTITY.has(key)){if(question.projected++)update(question.hash,encode(','));update(question.hash,encode(JSON.stringify(key)+':'));}question.keyToken=null;}
  if(token.token===TokenType.LEFT_BRACE||token.token===TokenType.LEFT_BRACKET){containers.push(token.token);if(++depth>33)fail('BANK_STREAM_DEPTH');if(before===1){if(rootKey==='questions'){if(token.token!==TokenType.LEFT_BRACKET)fail('BANK_STREAM_WRAPPER');inQuestions=true;update(bodyHash,encode('['));}else if(rootKey!=='metadata'||token.token!==TokenType.LEFT_BRACE)fail('BANK_STREAM_WRAPPER');}
   else if(before===2&&inQuestions){if(token.token!==TokenType.LEFT_BRACE||question||count>=5000)fail('BANK_STREAM_QUESTION_COUNT');if(count)update(bodyHash,encode(','));update(bodyHash,encode('{'));question={keys:[],field:null,keyToken:null,projected:0,semantic:{},display:{},displayBytes:0,deferred:[],retained:0,hash:sha256.create()};update(question.hash,encode('{"content":{'));}}
  writeToken(token);
  if(token.token===TokenType.RIGHT_BRACE&&before===3&&question){if(question.field!==null)fail('BANK_STREAM_QUESTION_FIELDS');update(bodyHash,encode('}'));update(question.hash,encode('},"projectionVersion":1}'));const completed=question;operations.push(async()=>{pending.push({value:completed.semantic,revision:hex(completed.hash.digest()),displayView:{format:'qb-question-display-v1',fields:completed.display,deferredFields:completed.deferred,hasDeferredContent:completed.deferred.length>0}});});question=null;count++;sinceValue=0;}
  if(token.token===TokenType.RIGHT_BRACKET&&before===2&&inQuestions){if(question)fail('BANK_STREAM_WRAPPER');update(bodyHash,encode(']'));inQuestions=false;sinceValue=0;}
  if(token.token===TokenType.RIGHT_BRACE&&before===1)update(bodyHash,encode('}'));
  if(token.token===TokenType.RIGHT_BRACE||token.token===TokenType.RIGHT_BRACKET){depth--;containers.pop();}lastToken=token.token;
 };
 parser.onValue=({value,key})=>{
  if(inQuestions){if(!question||typeof key!=='string'||key!==question.field)fail('BANK_STREAM_QUESTION_FIELDS');const bytes=canonicalContentBytes(value);if(bytes.length>ROW)fail('FINAL_BANK_QUESTION_STREAMING_UNIMPLEMENTED');const current=question;operations.push(async()=>{for await(const bytes of canonicalField(value)){bodyHash.update(bytes);if(!IDENTITY.has(key))current.hash.update(bytes);}});if(SEMANTIC.has(key)){question.retained+=bytes.length;if(question.retained>ROW)fail('FINAL_BANK_SEMANTIC_FIELDS_STREAMING_UNIMPLEMENTED');question.semantic[key]=value;}const containsLeaf=v=>privateStrings?.owns(v)||v!==null&&typeof v==='object'&&Object.values(v).some(containsLeaf),leaf=containsLeaf(value);if(DISPLAY.has(key)){if(leaf||bytes.length>DISPLAY_FIELD||question.displayBytes+bytes.length>DISPLAY_ROW)question.deferred.push(key);else{question.display[key]=JSON.parse(new TextDecoder().decode(bytes));question.displayBytes+=bytes.length;}}else if(leaf||bytes.length>DISPLAY_FIELD)question.deferred.push(key);question.field=null;}
  else{if(typeof key!=='string'||key==='questions'||!fields.includes(key)||Object.hasOwn(header,key))fail('BANK_STREAM_ROOT_FIELDS');const bytes=canonicalBytes(value);header[key]=JSON.parse(new TextDecoder().decode(bytes));update(bodyHash,bytes);}sinceValue=0;
 };
 async function* canonicalField(value){guard();if(privateStrings?.owns(value)){const leaf=await privateStrings.open(value);for await(const bytes of leaf.chunks()){guard();yield bytes;}return;}if(value===null||typeof value!=='object'){yield canonicalContentBytes(value);return;}if(Array.isArray(value)){yield encode('[');for(let i=0;i<value.length;i++){if(i)yield encode(',');yield* canonicalField(value[i]);}yield encode(']');return;}yield encode('{');let first=true;for(const key of Object.keys(value).sort()){if(!first)yield encode(',');first=false;yield encode(JSON.stringify(key)+':');yield* canonicalField(value[key]);}yield encode('}');}
 async function flush(){while(operations.length){guard();await operations.shift()();}while(pending.length){guard();const {value:q,revision,displayView}=pending.shift();if(header.format!=='qb-bank-content-v2'||!isUuid(header.bankUid)||q.bankUid!==header.bankUid||!isUuid(q.questionUid)||!isQuestionKey(q.questionKey)||q.questionKey!==`${header.bankUid}/${q.questionUid}`||seen.has(q.questionKey))fail('registered_identity');if(q.type!==undefined&&!['choice','fill'].includes(q.type))fail('unsupported_type');seen.add(q.questionKey);
   // Reuse original semantics on all semantic fields. Unknown fields were
   // validated and streamed into the full original projection SHA above.
   if(header.metadata?.visibility!=='public')fail('READONLY_DISPLAY_PUBLIC_ONLY');
   const image=q.image;
   const imageMedia=async value=>{if(privateStrings?.owns(value))return privateStrings.imagePresence(value);return Boolean(value&&typeof value==='string');};
   let hasMedia;if(Array.isArray(image))hasMedia=image.length>0;else hasMedia=await imageMedia(image);
   validateQuestionSemanticFields(q,hasMedia);guard();if(q.questionRevision!==revision||!Array.isArray(q.optionIds))fail('question_revision');const choices=q.type==='fill'?[]:q.choices;if(q.optionIds.length!==choices.length)fail('question_revision');for(let index=0;index<choices.length;index++){const id=`opt_${hex(sha256(canonicalContentBytes({optionIdentityVersion:1,questionRevision:revision,index})))}`;if(q.optionIds[index]!==id)fail('question_revision');}await onQuestion({questionKey:q.questionKey,questionRevision:revision,displayView});guard();}}
 // Only string boundaries are framed here; official parser retains all JSON
 // structure/grammar. Giant unknown STRING values are genuine private native
 // leaf locators, never placeholder semantic/identity strings.
 function channel(){let waiting=null,queued=null,ended=false,error=null;return {push:bytes=>new Promise((resolve,reject)=>{if(error){reject(error);return;}if(ended||queued){reject(new Error('BANK_STREAM_CHANNEL'));return;}if(waiting){const next=waiting;waiting=null;resolve();next({value:bytes,done:false});}else queued={bytes,resolve,reject};}),end:()=>{ended=true;if(waiting){waiting({done:true});waiting=null;}},fail:cause=>{error=cause;queued?.reject(cause);queued=null;if(waiting){waiting(Promise.reject(cause));waiting=null;}},[Symbol.asyncIterator](){return this;},next(){if(error)return Promise.reject(error);if(queued){const item=queued;queued=null;item.resolve();return Promise.resolve({value:item.bytes,done:false});}if(ended)return Promise.resolve({done:true});return new Promise(resolve=>{waiting=resolve;});}};}
 let inString=false,escaped=false,held=[],stringBytes=0,pipe=null,flight=null,sourceRange=null;
 async function feed(bytes){if(!bytes.length)return;sinceValue+=bytes.length;if(sinceValue>ROW+PART)fail('FINAL_BANK_QUESTION_STREAMING_UNIMPLEMENTED');parser.write(bytes);await flush();}
 async function stringPart(bytes,complete){if(bytes.length){stringBytes+=bytes.length;const part=new Uint8Array(bytes);if(!pipe&&stringBytes>ROW){const isValue=lastToken===TokenType.COLON||lastToken===TokenType.LEFT_BRACKET||lastToken===TokenType.COMMA&&containers.at(-1)===TokenType.LEFT_BRACKET;
    if(!question||!question.field||SEMANTIC.has(question.field)&&question.field!=='image'||IDENTITY.has(question.field)||!isValue)fail('FINAL_BANK_SEMANTIC_FIELDS_STREAMING_UNIMPLEMENTED');pipe=channel();flight=privateStrings.stage({chunks:pipe,signal,sourceRange});void flight.catch(cause=>pipe?.fail(cause));for(const prior of held)await pipe.push(prior);held=[];}
   if(pipe)await pipe.push(part);else held.push(part);}
  if(complete){if(pipe){pipe.end();const locator=await flight;parser.tokenizer.onToken({token:TokenType.STRING,value:locator});await flush();}else{const bytes=new Uint8Array(stringBytes);let offset=0;for(const part of held){bytes.set(part,offset);offset+=part.length;}await feed(bytes);}held=[];stringBytes=0;pipe=null;flight=null;}}
 try{for await(const source of chunks){guard();if(!(source instanceof Uint8Array)||!source.length||source.length>PART)fail('BANK_STREAM_CHUNK');const bytes=new Uint8Array(source);received+=bytes.length;if(received>ref.totalBytes||received>MAX)fail('BANK_STREAM_SIZE');rawHash.update(bytes);
   if(!privateStrings){sinceValue+=bytes.length;if(sinceValue>ROW+PART)fail('FINAL_BANK_QUESTION_STREAMING_UNIMPLEMENTED');parser.write(bytes);await flush();continue;}
   let start=0;const absolute=received-bytes.length;for(let index=0;index<bytes.length;index++){const byte=bytes[index];if(!inString){if(byte===34){await feed(bytes.slice(start,index));inString=true;escaped=false;start=index;sourceRange={start:absolute+index,end:null};}}
    else if(escaped)escaped=false;else if(byte===92)escaped=true;else if(byte===34){sourceRange.end=absolute+index+1;await stringPart(bytes.slice(start,index+1),true);inString=false;start=index+1;sourceRange=null;}}
   if(inString)await stringPart(bytes.slice(start),false);else await feed(bytes.slice(start));
  }if(inString)fail('BANK_STREAM_WRAPPER');
 }catch(cause){pipe?.fail(cause);if(flight)await flight.catch(()=>{});throw cause;}
 guard();if(!parser.isEnded)parser.end();await flush();if(first||depth!==0||question||rootKeys.join()!==fields.join()||received!==ref.totalBytes||header.format!=='qb-bank-content-v2'||header.schemaVersion!==1||!isUuid(header.bankUid))fail('BANK_STREAM_WRAPPER');validateBankMetadata(header.metadata);if(header.metadata.visibility==='protected')fail('protected_plaintext');if(count!==header.metadata.questionCount)fail('BANK_STREAM_QUESTION_COUNT');if(header.metadata.visibility==='private'&&received>ROW)fail('bank_content_limit');if(hex(rawHash.digest())!==ref.contentDigest||hex(bodyHash.digest())!==ref.contentDigest)fail('BANK_STREAM_CANONICAL_DIGEST');return {status:'registered_bank_questions_verified',bankUid:header.bankUid,metadata:header.metadata,questionCount:count,contentDigest:ref.contentDigest,proofClass:'registered-full-body-derived',ready:false};
}
