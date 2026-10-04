import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { validateReportPR } from './validate-native-report-pr.mjs';
import { applyRequest } from './apply-native-report-request.mjs';
import { verifyNativeReportSite } from './verify-native-report-site.mjs';

export function assertReportCIContext({pr,sourceHead,expectedBot,expectedRepo,expectedHead}) {
  const ref=pr?.head?.ref,match=String(ref||'').match(/^codex\/report-([a-f0-9-]{36})$/);
  if(!match || pr.state!=='open' || pr.draft || pr.base?.ref!=='main' || pr.base?.repo?.full_name!==expectedRepo || pr.head?.repo?.full_name!==expectedRepo || !expectedBot || String(pr.user?.id)!==String(expectedBot))throw Error('REPORT_CI_UNAUTHORIZED_CONTEXT');
  if(!/^[a-f0-9]{40}$/.test(pr.base.sha)||!/^[a-f0-9]{40}$/.test(pr.head.sha)||sourceHead!==pr.base.sha)throw Error('REPORT_CI_SOURCE_HEAD_CONFLICT');
  if(expectedHead && expectedHead!==pr.head.sha)throw Error('REPORT_CI_HEAD_CONFLICT');
  return {operationId:match[1],base:pr.base.sha,head:pr.head.sha,branch:ref};
}
export async function runReportCI({mode,prNumber,expectedHead,root=process.cwd(),token,expectedBot,repository='shicheng0810/question-bank',requestAPI,gitRunner,baselineBanks,siteVerifier=verifyNativeReportSite}) {
  if(!['produce','verify'].includes(mode)||!/^\d+$/.test(String(prNumber))||repository!=='shicheng0810/question-bank')throw Error('REPORT_CI_INPUT_INVALID');
  const api=requestAPI|| (async(method,route,body)=>{const response=await fetch('https://api.github.com'+route,{method,headers:{authorization:`Bearer ${token}`,accept:'application/vnd.github+json','user-agent':'qb-native-ci','content-type':'application/json'},body:body?JSON.stringify(body):undefined});if(!response.ok)throw Error('REPORT_CI_GITHUB_API_FAILED');return response.status===204?null:response.json();});
  const git=gitRunner||((...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',maxBuffer:80*1024*1024}).trim());
  const prefix='/repos/'+repository;
  const [pr,source]=await Promise.all([api('GET',`${prefix}/pulls/${prNumber}`),api('GET',`${prefix}/git/ref/heads/main`)]);
  const context=assertReportCIContext({pr,sourceHead:source.object.sha,expectedBot,expectedRepo:repository,expectedHead});
  if(git('rev-parse','HEAD')!==context.head)throw Error('REPORT_CI_CHECKOUT_CONFLICT');
  const status=(sha,state,description)=>api('POST',`${prefix}/statuses/${sha}`,{state,context:'native-report-content',description});
  await status(context.head,'pending','Verifying approved report content and exact native identities');
  try{
    if(mode==='produce'){
      const changed=git('diff','--name-only',context.base,context.head).split('\n').filter(Boolean);
      if(changed.length===1){
        await validateReportPR({root,...context,sourcesFile:'content/report-sources.json',stage:'request',baselineBanks});
        const packet=await applyRequest({root,requestFile:path.join(root,`content/report-requests/${context.operationId}.json`),sourcesFile:'content/report-sources.json',baselineBanks});
        git('add','--',...packet.files);
        git('-c','user.name=github-actions[bot]','-c','user.email=41898282+github-actions[bot]@users.noreply.github.com','commit','-m',`build: native report ${context.operationId}`);
        const next=git('rev-parse','HEAD');
        await validateReportPR({root,base:context.base,head:next,operationId:context.operationId,sourcesFile:'content/report-sources.json',baselineBanks});
        // Recheck both actors immediately before the only content branch write.
        const [fresh,current]=await Promise.all([api('GET',`${prefix}/pulls/${prNumber}`),api('GET',`${prefix}/git/ref/heads/main`)]);
        assertReportCIContext({pr:fresh,sourceHead:current.object.sha,expectedBot,expectedRepo:repository,expectedHead:context.head});
        git('-c','credential.helper=!gh auth git-credential','push',`https://github.com/${repository}.git`,`HEAD:refs/heads/${context.branch}`);
        context.head=next;
      }else await validateReportPR({root,...context,sourcesFile:'content/report-sources.json',baselineBanks});
      await status(context.head,'pending','Generated native content; waiting for independent dispatch validation');
      await api('POST',`${prefix}/actions/workflows/native-report-control.yml/dispatches`,{ref:'main',inputs:{mode:'verify',pr_number:String(prNumber),expected_head:context.head}});
      return {...context,state:'validation_dispatched'};
    }
    const verified=await validateReportPR({root,...context,sourcesFile:'content/report-sources.json',baselineBanks});
    await siteVerifier({root,manifestPath:verified.siteManifest});
    const [fresh,current]=await Promise.all([api('GET',`${prefix}/pulls/${prNumber}`),api('GET',`${prefix}/git/ref/heads/main`)]);
    assertReportCIContext({pr:fresh,sourceHead:current.object.sha,expectedBot,expectedRepo:repository,expectedHead:context.head});
    await status(context.head,'success','Exact native correction, old revision trust and asset retention verified');
    const protection=await api('GET',`${prefix}/branches/main/protection/required_status_checks`);
    const names=new Set([...(protection.contexts||[]),...(protection.checks||[]).map(row=>row.context)]);
    if(!names.has('native-report-content'))throw Error('REPORT_CI_BRANCH_PROTECTION_REQUIRED');
    const merged=await api('PUT',`${prefix}/pulls/${prNumber}/merge`,{sha:context.head,merge_method:'squash'});
    if(merged.merged!==true || !/^[a-f0-9]{40}$/.test(merged.sha))throw Error('REPORT_CI_MERGE_UNCONFIRMED');
    await api('POST',`${prefix}/actions/workflows/report-publication.yml/dispatches`,{ref:'main',inputs:{pr_number:String(prNumber),expected_commit:merged.sha,operation_id:context.operationId}});
    return {...verified,state:'publication_dispatched',resultCommit:merged.sha};
  }catch(error){await status(context.head,'failure','Report content validation failed; no merge authorization').catch(()=>{});throw error;}
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href){const [mode,prNumber,expectedHead]=process.argv.slice(2);console.log(JSON.stringify(await runReportCI({mode,prNumber,expectedHead,token:process.env.GH_TOKEN,expectedBot:process.env.REPORT_BOT_GITHUB_USER_ID})));}
