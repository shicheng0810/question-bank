import {RELEASE_HEAD} from './report-release-contract.js';
import {validateBankContent} from '../../src/domain/question/bank-content.js';
import { reportError, reportSources } from './native-report.js';
import { publicCorrection, assertPublicRequest } from './public-report-contract.js';

const repo = '/repos/shicheng0810/question-bank-source';
const sourceBranch = 'source';
const fullRepository='shicheng0810/question-bank-source';
function assertStoredRequest(saved,pending,approval) {
  assertPublicRequest(saved);
  if(saved.format!=='qb-native-report-request-v1' || saved.baseCommit!==approval?.sourceBase || JSON.stringify(saved.pending)!==JSON.stringify(publicCorrection(pending)))throw reportError('REPORT_OPERATION_CONFLICT');
}
export async function boundedJson(response,maximum=128*1024) {
  const reader=response.body?.getReader();if(!reader)throw reportError('REPORT_PROVIDER_BODY_MISSING');
  const chunks=[];let size=0;
  try {while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maximum){await reader.cancel();throw reportError('REPORT_PROVIDER_BODY_TOO_LARGE');}chunks.push(value);}}finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return JSON.parse(new TextDecoder().decode(bytes));
}
async function github(env,method,path,body,allow404=false) {
  const response=await fetch(`https://api.github.com${path}`,{method,headers:{authorization:`Bearer ${env.GITHUB_TOKEN}`,accept:'application/vnd.github+json','user-agent':'qb-native-report','content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});
  if(allow404 && response.status===404)return null;
  if(!response.ok)throw reportError('REPORT_GITHUB_FAILED');return boundedJson(response);
}
async function verifyExistingPR(env,pending,pr,approval) {
  if(!/^[a-f0-9]{40}$/.test(approval?.sourceBase))throw reportError('REPORT_APPROVAL_BASE_REQUIRED');
  const branch=`codex/report-${pending.operationId}`;
  if(pr.base?.ref!==sourceBranch || pr.base?.repo?.full_name!==fullRepository || pr.head?.ref!==branch || pr.head?.repo?.full_name!==fullRepository || !/^[a-f0-9]{40}$/.test(pr.head?.sha))throw reportError('REPORT_EXISTING_PR_IDENTITY_CONFLICT');
  if(pr.state==='closed' && !pr.merged_at)throw reportError('REPORT_PR_CLOSED_UNMERGED');
  if(!['open','closed'].includes(pr.state))throw reportError('REPORT_PR_STATE_INVALID');
  const stored=await github(env,'GET',`${repo}/contents/content/report-requests/${pending.operationId}.json?ref=${pr.head.sha}`);
  const saved=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(stored.content.replace(/\s/g,'')),char=>char.charCodeAt(0))));
  assertStoredRequest(saved,pending,approval);
  return {approval,state:'pr_created',number:pr.number,url:pr.html_url,merged:!!pr.merged_at,head:pr.head.sha,base:saved.baseCommit};
}
export async function reconcileNativeReportPR(env,pending,approval) {
  if(!/^[a-f0-9]{40}$/.test(approval?.sourceBase))throw reportError('REPORT_APPROVAL_BASE_REQUIRED');
  const branch=`codex/report-${pending.operationId}`;
  const prs=await github(env,'GET',`${repo}/pulls?state=all&head=shicheng0810:${branch}`);
  if(prs.length===1)return verifyExistingPR(env,pending,prs[0],approval);
  if(prs.length>1)throw reportError('REPORT_PR_AMBIGUOUS');
  const ref=await github(env,'GET',`${repo}/git/ref/heads/${branch}`,null,true);
  if(!ref)return {state:'provider_unknown',reconciliation:'no_visible_result'};
  const stored=await github(env,'GET',`${repo}/contents/content/report-requests/${pending.operationId}.json?ref=${ref.object.sha}`);
  const saved=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(stored.content.replace(/\s/g,'')),char=>char.charCodeAt(0))));
  assertStoredRequest(saved,pending,approval);
  return {state:'provider_unknown',reconciliation:'branch_exists_pull_missing',head:ref.object.sha,base:saved.baseCommit};
}
export async function createNativeReportPR(env,pending,approval) {
  if(!/^[a-f0-9]{40}$/.test(approval?.sourceBase))throw reportError('REPORT_APPROVAL_BASE_REQUIRED');
  const head=await env.REPORT_OPERATIONS?.getByName(RELEASE_HEAD).releaseHead();if(!head||head.inflight||head.commit!==approval.sourceBase||head.generation!==approval.releaseGeneration)throw reportError('REPORT_APPROVAL_RELEASE_CONFLICT');
 const source=reportSources(env).find(row=>row.bankUid===pending.bankUid);
  if(!source || source.revision!==pending.revision)throw reportError('REPORT_REVISION_CONFLICT');
  const branch=`codex/report-${pending.operationId}`,requestPath=`content/report-requests/${pending.operationId}.json`;
  const existing=await github(env,'GET',`${repo}/pulls?state=all&head=shicheng0810:${branch}`);
  const approvedRef=await github(env,'GET',`${repo}/git/ref/heads/${sourceBranch}`);if(approvedRef.object.sha!==approval.sourceBase)throw reportError('REPORT_REVISION_CONFLICT');
  if(existing.length===1)return verifyExistingPR(env,pending,existing[0],approval);
  if(existing.length>1)throw reportError('REPORT_PR_AMBIGUOUS');
  let branchRef=await github(env,'GET',`${repo}/git/ref/heads/${branch}`,null,true),base;
  if(branchRef){
    // Recover a branch created before a pull-creation timeout. Verify this
    // deterministic branch belongs to the exact request before reusing it.
    const stored=await github(env,'GET',`${repo}/contents/${requestPath}?ref=${branchRef.object.sha}`);
    const saved=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(stored.content.replace(/\s/g,'')),char=>char.charCodeAt(0))));
    assertStoredRequest(saved,pending,approval);base=saved.baseCommit;
    const latest=await github(env,'GET',`${repo}/git/ref/heads/${sourceBranch}`);if(latest.object.sha!==base)throw reportError('REPORT_REVISION_CONFLICT');
  }else{
    const ref=await github(env,'GET',`${repo}/git/ref/heads/${sourceBranch}`);base=approval.sourceBase;if(ref.object.sha!==base)throw reportError('REPORT_REVISION_CONFLICT');
    const commit=await github(env,'GET',`${repo}/git/commits/${base}`);
    const request={format:'qb-native-report-request-v1',baseCommit:base,pending:publicCorrection(pending)};
    const blob=await github(env,'POST',`${repo}/git/blobs`,{content:JSON.stringify(request),encoding:'utf-8'});
    const tree=await github(env,'POST',`${repo}/git/trees`,{base_tree:commit.tree.sha,tree:[{path:requestPath,mode:'100644',type:'blob',sha:blob.sha}]});
    const next=await github(env,'POST',`${repo}/git/commits`,{message:`fix: approved report ${pending.operationId}`,tree:tree.sha,parents:[base]});
    const latest=await github(env,'GET',`${repo}/git/ref/heads/${sourceBranch}`);if(latest.object.sha!==base)throw reportError('REPORT_REVISION_CONFLICT');
    branchRef=await github(env,'POST',`${repo}/git/refs`,{ref:`refs/heads/${branch}`,sha:next.sha});
  }
  const pr=await github(env,'POST',`${repo}/pulls`,{title:`fix: approved question report ${pending.operationId}`,head:branch,base:sourceBranch,body:`Approved public report ${pending.operationId}.\n\nQuestion ${pending.questionKey}; base ${base}; original revision ${pending.revision}.\n\nCI must verify the exact native identity, preserve historical content, generate the new immutable content/manifest/registry, and pass the required checks. Cloudflare deployment plus online readback is required before marking published.`});
  const required=String(env.REPORT_REQUIRED_CHECKS||'').split(',').map(value=>value.trim()).filter(Boolean);let autoMerge=false;
  try{const protection=await github(env,'GET',`${repo}/branches/${sourceBranch}/protection/required_status_checks`);const contexts=new Set([...(protection.contexts||[]),...(protection.checks||[]).map(check=>check.context)]);
    if(required.length && required.every(name=>contexts.has(name))){const result=await github(env,'POST','/graphql',{query:'mutation($id:ID!){enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:SQUASH}){pullRequest{number}}}',variables:{id:pr.node_id}});autoMerge=!result.errors?.length;}
  }catch{/* Missing protection cannot bypass CI. */}
  return {approval,number:pr.number,url:pr.html_url,state:'pr_created',autoMerge,head:branchRef.object.sha,base};
}

export async function validateApprovalSource(env,pending,approval){
 const head=await env.REPORT_OPERATIONS?.getByName(RELEASE_HEAD).releaseHead();if(!head||head.inflight||head.commit!==approval.sourceBase||head.generation!==approval.releaseGeneration)throw reportError('REPORT_APPROVAL_RELEASE_CONFLICT');
 const source=reportSources(env).find(s=>s.bankUid===pending.bankUid);if(!source||source.revision!==pending.revision)throw reportError('REPORT_APPROVAL_SOURCE_CONFLICT');
 const latest=await github(env,'GET',`${repo}/git/ref/heads/source`);if(latest.object.sha!==approval.sourceBase)throw reportError('REPORT_APPROVAL_SOURCE_MOVED');
 const file=await github(env,'GET',`${repo}/contents/${source.sourcePath}?ref=${approval.sourceBase}`);
 const content=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(file.content.replace(/\s/g,'')),c=>c.charCodeAt(0))));
 const validated=await validateBankContent(content);if(validated.contentDigest!==pending.revision||!content.questions.some(q=>q.questionKey===pending.questionKey&&q.questionRevision===pending.questionRevision))throw reportError('REPORT_APPROVAL_SOURCE_CONFLICT');
}
