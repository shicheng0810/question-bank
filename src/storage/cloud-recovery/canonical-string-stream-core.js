import {sha256} from '@noble/hashes/sha2.js';
const MAX=100*1024*1024,PART=512*1024;
/** @param {string} code @returns {never} */
const fail=code=>{throw Object.assign(new Error(code),{code});};
const hex=bytes=>Array.from(bytes,v=>v.toString(16).padStart(2,'0')).join('');
const short=new Map([['"',0x22],['\\',0x5c],['b',8],['f',12],['n',10],['r',13],['t',9]]);
/** String-leaf component only, not a JSON document interpreter/Ready proof.
 * Validates the exact original JSON.stringify canonical spelling, fatal UTF8,
 * lone-surrogate rules and original100MiB content limits without retaining the
 * whole scalar. Sink bytes are candidates until the final result succeeds. */
/** @param {{chunks:AsyncIterable<Uint8Array>,onCanonicalBytes?:(bytes:Uint8Array)=>unknown|Promise<unknown>,signal?:AbortSignal,check?:()=>void}} input */
export async function streamCanonicalJSONString({chunks,onCanonicalBytes,signal,check}){
 if(onCanonicalBytes!==undefined&&typeof onCanonicalBytes!=='function')fail('CANONICAL_STRING_INPUT');
 const decoder=new TextDecoder('utf-8',{fatal:true}),hash=sha256.create();let state='OPEN',digits='',canonicalBytes=0,utf8Bytes=0,utf16Length=0,nonBlank=false,previousHigh=false;
 /** @param {number} code */
 const decoded=code=>{if(previousHigh&&code>=0xdc00&&code<=0xdfff)fail('NON_CANONICAL_STRING');previousHigh=code>=0xd800&&code<=0xdbff;const value=String.fromCodePoint(code);utf16Length+=value.length;utf8Bytes+=code<=0x7f?1:code<=0x7ff?2:code<=0xffff?3:4;if(utf8Bytes>MAX)fail('CANONICAL_STRING_LIMIT');if(value.trim().length)nonBlank=true;};
 /** @param {string} value */
 const text=value=>{for(const char of value){const code=char.codePointAt(0);if(code===undefined)fail('CANONICAL_STRING_SYNTAX');
  if(state==='OPEN'){if(char!=='"')fail('CANONICAL_STRING_SYNTAX');state='TEXT';continue;}
  if(state==='DONE')fail('CANONICAL_STRING_SYNTAX');
  if(state==='TEXT'){if(char==='"'){state='DONE';continue;}if(char==='\\'){state='ESCAPE';continue;}if(code<32)fail('CANONICAL_STRING_SYNTAX');decoded(code);continue;}
  if(state==='ESCAPE'){const escaped=short.get(char);if(escaped!==undefined){decoded(escaped);state='TEXT';continue;}if(char==='u'){digits='';state='HEX';continue;}fail('NON_CANONICAL_STRING');}
  if(state==='HEX'){if(!/^[0-9a-f]$/.test(char))fail('NON_CANONICAL_STRING');digits+=char;if(digits.length===4){const value=parseInt(digits,16);if(!(value<32&&![8,9,10,12,13].includes(value)||value>=0xd800&&value<=0xdfff))fail('NON_CANONICAL_STRING');decoded(value);digits='';state='TEXT';}}
 }};
 const guard=()=>{if(signal?.aborted)fail('CANCELLED');if(typeof check==='function')check();};
 for await(const source of chunks){guard();if(!(source instanceof Uint8Array)||!source.length||source.length>PART)fail('CANONICAL_STRING_CHUNK');const bytes=new Uint8Array(source);canonicalBytes+=bytes.length;if(canonicalBytes>MAX)fail('CANONICAL_STRING_LIMIT');try{text(decoder.decode(bytes,{stream:true}));}catch(cause){if(cause?.code==='NON_CANONICAL_STRING'||typeof cause?.code==='string'&&cause.code.startsWith('CANONICAL_STRING_'))throw cause;fail('CANONICAL_STRING_UTF8');}hash.update(bytes);if(onCanonicalBytes)await onCanonicalBytes(bytes);guard();}
 guard();try{text(decoder.decode());}catch(cause){if(cause?.code==='NON_CANONICAL_STRING'||typeof cause?.code==='string'&&cause.code.startsWith('CANONICAL_STRING_'))throw cause;fail('CANONICAL_STRING_UTF8');}if(state!=='DONE')fail('CANONICAL_STRING_SYNTAX');
 return Object.freeze({format:'qb-canonical-string-leaf-v1',canonicalBytes,utf8Bytes,utf16Length,hasNonBlankText:nonBlank,sha256:hex(hash.digest()),ready:false});
}

