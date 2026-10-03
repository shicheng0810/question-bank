import {loadVerifiedAccountIdentity,guardAccountSyncRate,decodeAccountRpcOutcome,disposeAccountRpcOutcome} from './account-session-handler.js';
import {accountOriginAllowed} from './account-http-origin.js';
import {validShareInput} from '../../do-worker/src/generation-sharing.js';
const response=(body,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
export async function handleAccountSharing({request,env}){
 if(env.GEN05_ACCOUNT_HTTP!=='1'||env.GEN06_SYNC_HTTP!=='1')return response({ok:false,error:'NOT_FOUND'},404);
 if(!['GET','POST'].includes(request.method))return response({ok:false,error:'METHOD_NOT_ALLOWED'},405);
 if(!accountOriginAllowed(request,env,request.method==='GET'))return response({ok:false,error:'ORIGIN_NOT_ALLOWED'},403);
 try{
  const url=new URL(request.url);if(url.search)return response({ok:false,error:'INVALID_REQUEST'},422);
  let input={action:'list'};
  if(request.method==='POST'){
   if(request.headers.has('content-encoding')||!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers.get('content-type')||''))return response({ok:false,error:'INVALID_REQUEST'},415);
   const reader=request.body?.getReader();if(!reader)return response({ok:false,error:'INVALID_REQUEST'},422);const chunks=[];let size=0;
   try{while(true){const r=await reader.read();if(r.done)break;size+=r.value.length;if(size>4096){await reader.cancel();return response({ok:false,error:'REQUEST_TOO_LARGE'},413);}chunks.push(r.value);}}finally{reader.releaseLock();}
   const bytes=new Uint8Array(size);let at=0;for(const c of chunks){bytes.set(c,at);at+=c.length;}input=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  }
  if(!validShareInput(input))return response({ok:false,error:'INVALID_REQUEST'},422);
  const limited=await guardAccountSyncRate(request,env);if(limited)return limited;
  const identity=await loadVerifiedAccountIdentity(request,env),stub=env.GENERATION_STORE.getByName(identity.incarnation);let raw,result;
  try{raw=await stub.accountSharesTrusted(identity,input);result=decodeAccountRpcOutcome(raw,['ok','response']);if(result.ok)result.response=structuredClone(result.response);}finally{await disposeAccountRpcOutcome(raw);try{stub[Symbol.dispose]?.();}catch{}}
  if(!result.ok){const code=result.error;return response({ok:false,error:code},['INVALID_CREDENTIALS','STALE_AUTHORITY','STALE_GENERATION','ACCOUNT_DELETED'].includes(code)?401:code==='SHARE_NOT_FOUND'?404:code==='INVALID_SHARE_INPUT'?422:code.startsWith('SHARE_')?409:503);}
  return response({ok:true,...result.response});
 }catch(error){return response({ok:false,error:error instanceof SyntaxError?'INVALID_REQUEST':['INVALID_CREDENTIALS','STALE_AUTHORITY','STALE_GENERATION','ACCOUNT_DELETED'].includes(error.message)?'AUTH_FAILED':'UNAVAILABLE'},error instanceof SyntaxError?422:['INVALID_CREDENTIALS','STALE_AUTHORITY','STALE_GENERATION','ACCOUNT_DELETED'].includes(error.message)?401:503);}
}
