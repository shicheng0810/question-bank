import {boundedJson} from './native-report-publisher.js';
import {reportError} from './native-report.js';
const fail=()=>{throw reportError('REPORT_OIDC_DENIED');};
const decode=value=>Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
export async function verifyReportOIDC(token,policy,{now=Math.floor(Date.now()/1000),fetchKeys=async()=>boundedJson(await fetch('https://token.actions.githubusercontent.com/.well-known/jwks',{signal:AbortSignal.timeout(10000)}),64*1024)}={}) {
 if(typeof token!=='string'||token.length>16000||token.split('.').length!==3)fail();
 const [h,p,s]=token.split('.');let header,claims;try{header=JSON.parse(new TextDecoder().decode(decode(h)));claims=JSON.parse(new TextDecoder().decode(decode(p)));}catch{fail();}
 if(header.alg!=='RS256'||typeof header.kid!=='string'||!policy||!Array.isArray(policy.workflowPaths)||!/^[a-f0-9]{40}$/.test(policy.workflowSha))fail();
 const expected={iss:'https://token.actions.githubusercontent.com',aud:policy.audience,repository:'shicheng0810/question-bank-source',repository_id:'1403515803',repository_owner_id:'74512891',ref:'refs/heads/main',environment:'report-production',event_name:'workflow_dispatch',sub:'repo:shicheng0810/question-bank-source:environment:report-production'};
 for(const [key,value] of Object.entries(expected))if(!value||String(claims[key])!==value)fail();
 if(claims.workflow_sha!==policy.workflowSha||claims.sha!==policy.workflowSha||!policy.workflowPaths.includes(claims.workflow_ref)||!/^\d+$/.test(claims.run_id)||!/^\d+$/.test(claims.run_attempt))fail();
 if(!Number.isInteger(claims.exp)||!Number.isInteger(claims.iat)||claims.exp<=now||claims.iat>now+30||claims.exp-claims.iat>600||!Number.isInteger(claims.nbf)||claims.nbf>now+30||typeof claims.jti!=='string'||!claims.jti)fail();
 const jwks=await fetchKeys(),keys=jwks?.keys?.filter(k=>k.kid===header.kid&&k.kty==='RSA'&&(!k.alg||k.alg==='RS256')&&(!k.use||k.use==='sig'));
 if(keys?.length!==1)fail();
 const key=await crypto.subtle.importKey('jwk',keys[0],{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
 if(!await crypto.subtle.verify('RSASSA-PKCS1-v1_5',key,decode(s),new TextEncoder().encode(h+'.'+p)))fail();
 return {issuedAt:claims.iat,runId:claims.run_id,runAttempt:claims.run_attempt,workflowSha:claims.workflow_sha,jti:claims.jti};
}

export function assertReportRunBinding(job,binding,operationId,fence) {
 if(!binding || binding.operationId!==operationId || binding.runId!==job.runId || binding.runAttempt!==job.runAttempt || binding.workflowSha!==job.workflowSha || !Number.isSafeInteger(binding.fence) || binding.fence<1 || fence!==binding.fence)throw reportError('REPORT_RUN_BINDING_DENIED');
}

// Only a strictly newer signed execution can recover. Caller must also supply
// the precise snapshot/fence it observed; CAS defeats delayed racing snapshots.
export function nextRecoveryJob(job,binding,id,body,row){
 if(!binding||binding.operationId!==id||binding.workflowSha!==job.workflowSha||body.expectedResult!==row.result||body.fence!==binding.fence||!Number.isSafeInteger(binding.fence)||binding.fence<1)throw reportError('REPORT_RECOVERY_FENCE');
 if(!/^\d+$/.test(binding.runId)||!/^\d+$/.test(binding.runAttempt))throw reportError('REPORT_RECOVERY_OWNER');
 const newer=BigInt(job.runId)>BigInt(binding.runId)||(job.runId===binding.runId&&BigInt(job.runAttempt)>BigInt(binding.runAttempt));
 if(!newer||job.issuedAt<binding.issuedAt)throw reportError('REPORT_RECOVERY_STALE');
 return {...job,operationId:id,fence:binding.fence+1};
}
