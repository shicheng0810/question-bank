import {sha256} from '@noble/hashes/sha2.js';
import {assertFinalProofWorkspace} from '../profiles/managed-profile-registry.js';
import {assertSourceStringWorkspace} from './source-string-workspace.js';
import {ownedWriteInput} from '../idb/write-input.js';

import {streamCanonicalJSONString} from './canonical-string-stream-core.js';
export {streamCanonicalJSONString} from './canonical-string-stream-core.js';
const fail=code=>{throw Object.assign(new Error(code),{code});};
const hex=bytes=>Array.from(bytes,v=>v.toString(16).padStart(2,'0')).join('');
const nativeLeaves=new WeakMap();
/** Genuine private native leaf storage. This is neither a question admission
 * nor a final proof mint. A descriptor is an opaque locator, never a JSON DTO. */
export async function createNativeCanonicalStringStore(database,workspace){
 return createBoundStringStore(database,workspace,assertFinalProofWorkspace);
}
// The static source matcher is distinct; callers cannot supply an assertion.
export async function createSourceCanonicalStringStore(database,workspace){
 return createBoundStringStore(database,workspace,assertSourceStringWorkspace);
}
async function createBoundStringStore(database,workspace,assertWorkspace){
 assertWorkspace(workspace,database);const metadata=ownedWriteInput(await workspace.metadata());assertWorkspace(workspace,database);let closed=false;
 const check=async()=>{if(closed)fail('CLOSED');assertWorkspace(workspace,database);await workspace.check();if(closed)fail('CLOSED');assertWorkspace(workspace,database);};
 /** @param {{chunks:AsyncIterable<Uint8Array>,signal?:AbortSignal}} input */
 const stage=async({chunks,signal})=>{await check();const leafId=crypto.randomUUID(),parts=[];const summary=await streamCanonicalJSONString({chunks,signal,onCanonicalBytes:async bytes=>{await check();const label=`canonicalString:${leafId}:${parts.length}`,written=await workspace.writePart({label,bytes});await check();parts.push({label,byteLength:written.byteLength,sha256:written.sha256});}});await check();const descriptor=Object.freeze({});nativeLeaves.set(descriptor,{database,workspace,workspaceId:metadata.workspaceId,parts,summary});return descriptor;};
 const stateFor=async descriptor=>{await check();const state=nativeLeaves.get(descriptor);if(!state||state.database!==database||state.workspace!==workspace||state.workspaceId!==metadata.workspaceId)fail('CANONICAL_STRING_LOCATOR');return state;};
 async function* actualChunks(state){for(const part of state.parts){await check();const bytes=await workspace.readPart({label:part.label});await check();if(bytes.length!==part.byteLength||hex(sha256(bytes))!==part.sha256)fail('CANONICAL_STRING_LOCATOR');yield bytes;}await check();}
 const open=async descriptor=>{const state=await stateFor(descriptor),actual=await streamCanonicalJSONString({chunks:actualChunks(state)});await check();if(JSON.stringify(actual)!==JSON.stringify(state.summary))fail('CANONICAL_STRING_LOCATOR');return Object.freeze({summary:state.summary,chunks:()=>actualChunks(state),ready:false});};
 const owns=descriptor=>{const state=nativeLeaves.get(descriptor);return !!state&&state.database===database&&state.workspace===workspace&&state.workspaceId===metadata.workspaceId;};
 // Only genuine same-handle leaf locators can supply this pure semantic fact.
 // open re-reads every original native part and canonical spelling first.
 const imagePresence=async descriptor=>{const leaf=await open(descriptor);await check();return leaf.summary.utf16Length>0;};
 return Object.freeze({stage,open,owns,imagePresence,close:()=>{closed=true;},ready:false});
}
