import{sha256}from'@noble/hashes/sha2.js';
import{streamCanonicalJSONString}from'./canonical-string-stream.js';
import{assertReadonlyStringWorkspace}from'../idb/readonly-content-ranges.js';
import{assertReadonlyAuthorityPair}from'../idb/learning-authority.js';
const fail=code=>{throw Object.assign(new Error(code),{code});};
const readonlyLeaves=new WeakMap();
/** Genuine readonly source ranges. No binary writes, Final brand or Ready.
 * Range boundaries are captured by the internal bank parser, not a caller DTO
 * accepted as registered-question authority. Every open rereads source PKs. */
export async function createReadonlyCanonicalStringStore(database,workspace){
 let closed=false;const check=async()=>{if(closed)fail('CLOSED');const state=assertReadonlyStringWorkspace(workspace,database);await assertReadonlyAuthorityPair(state.authorityToken,database);if(closed)fail('CLOSED');assertReadonlyStringWorkspace(workspace,database);};await check();
 async function* actualChunks(start,end){await check();for await(const bytes of workspace.range(start,end)){await check();yield bytes;await check();}await check();}
 const stage=async({chunks,signal,sourceRange})=>{await check();const summary=await streamCanonicalJSONString({chunks,signal});await check();const start=sourceRange?.start,end=sourceRange?.end;if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<=start||end-start!==summary.canonicalBytes||end>workspace.reference.totalBytes)fail('CANONICAL_STRING_SOURCE_RANGE');const actual=await streamCanonicalJSONString({chunks:actualChunks(start,end),signal});await check();if(JSON.stringify(actual)!==JSON.stringify(summary))fail('CANONICAL_STRING_LOCATOR');const descriptor=Object.freeze({});readonlyLeaves.set(descriptor,{database,workspace,start,end,summary});return descriptor;};
 const stateFor=async descriptor=>{await check();const state=readonlyLeaves.get(descriptor);if(!state||state.database!==database||state.workspace!==workspace)fail('CANONICAL_STRING_LOCATOR');return state;};
 const open=async descriptor=>{const state=await stateFor(descriptor),actual=await streamCanonicalJSONString({chunks:actualChunks(state.start,state.end)});await check();if(JSON.stringify(actual)!==JSON.stringify(state.summary))fail('CANONICAL_STRING_LOCATOR');return Object.freeze({summary:state.summary,chunks:()=>actualChunks(state.start,state.end),ready:false});};
 const owns=descriptor=>{const state=readonlyLeaves.get(descriptor);return!!state&&state.database===database&&state.workspace===workspace;};
 const imagePresence=async descriptor=>(await open(descriptor)).summary.utf16Length>0;
 return Object.freeze({stage,open,owns,imagePresence,close:()=>{closed=true;},ready:false});
}
