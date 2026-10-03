import test from 'node:test';import assert from 'node:assert/strict';
import {identityChallengeRequest,identityBoundedJson,randomHex} from '../functions/_shared/report-identity-challenge.js';
const evidence=[];
function streamed({headers={},size=8192,chunks=32,hangingCancel=false}={}){
 const seen={pulls:0,cancelled:0};const body=new ReadableStream({pull(c){if(seen.pulls===chunks)return c.close();seen.pulls++;c.enqueue(new Uint8Array(size).fill(65));},cancel(){seen.cancelled++;if(hangingCancel)return new Promise(()=>{});}},{highWaterMark:0});
 return {seen,request:new Request('https://local/api/report-identity-challenge',{method:'POST',headers,body,duplex:'half'})};
}
function configured(){let calls=0;return {env:{TELEGRAM_CHAT_ID:'-100123',TELEGRAM_BOT_TOKEN:'synthetic',EDITS:{get(){calls++;return null;}},REPORT_OPERATIONS:{getByName(){calls++;throw Error('unexpected');}}},calls:()=>calls};}
test('reviewer original anonymous 32x8192 counterexample is rejected before pull and cancelled',async()=>{
 const {request,seen}=streamed(),f=configured();const r=await identityChallengeRequest({request,env:f.env});
 assert.equal(r.status,403);assert.equal(seen.pulls,0);assert.equal(seen.cancelled,1);assert.equal(f.calls(),0);
 evidence.push({case:'anonymous-original',status:r.status,reads:seen.pulls,cancelled:seen.cancelled,bindingCalls:f.calls()});
});
test('valid bearer shape: missing and lying content-length cannot evade stream cap; cancel on first oversized chunk',async()=>{
 for(const contentLength of [undefined,'1','262144']){
  const headers={authorization:'Bearer '+randomHex(32),...(contentLength?{'content-length':contentLength}:{})};
  const {request,seen}=streamed({headers}),f=configured();const r=await identityChallengeRequest({request,env:f.env});
  assert.equal(r.status,400);assert.equal(seen.pulls,1);assert.equal(seen.cancelled,1);assert.equal(f.calls(),0);
  evidence.push({case:'oversize',contentLength:contentLength??'missing',status:r.status,reads:seen.pulls,cancelled:seen.cancelled,bindingCalls:f.calls()});
 }
});
test('cumulative chunks hit 4096 and cancel without retaining more; unresolved cancel cannot stall denial',async()=>{
 const {request,seen}=streamed({headers:{authorization:'Bearer '+randomHex(32)},size:1024,hangingCancel:true}),f=configured();
 const r=await Promise.race([identityChallengeRequest({request,env:f.env}),new Promise((_,reject)=>setTimeout(()=>reject(Error('reader stalled')),100))]);
 assert.equal(r.status,400);assert.equal(seen.pulls,5);assert.equal(seen.cancelled,1);assert.equal(f.calls(),0);
});
test('bounded reader accepts exact 4096 bytes regardless of header, rejects malformed JSON/UTF8',async()=>{
 const body=JSON.stringify({value:'x'.repeat(4084)});assert.equal(Buffer.byteLength(body),4096);
 assert.equal((await identityBoundedJson(new Request('https://local',{method:'POST',headers:{'content-length':'1'},body}))).value.length,4084);
 await assert.rejects(identityBoundedJson(new Request('https://local',{method:'POST',body:'x'})));
 await assert.rejects(identityBoundedJson(new Request('https://local',{method:'POST',body:new Uint8Array([255])})));
});
test.after(async()=>{const {writeFile}=await import('node:fs/promises');await writeFile('../IDENTITY-R1-BOUNDED-EVIDENCE.json',JSON.stringify(evidence,null,2)+'\n');});
