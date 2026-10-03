import {onRequestPost as control} from '../../functions/api/report-control.js';
export { ReportOperationStore } from '../../functions/_shared/report-operation-store.js';
import { onRequestPost as feedback } from '../../functions/api/feedback.js';
import { nativeReportWebhook } from '../../functions/_shared/native-report-webhook.js';
import {identityChallengeRequest} from '../../functions/_shared/report-identity-challenge.js';
import { reportFixture } from './fixture.js';
export default {async fetch(request,env){
  const fixture=await reportFixture();
  const policy={audience:'https://question-bank-78u.pages.dev/api/report-control',workflowSha:'a'.repeat(40),workflowPaths:['shicheng0810/question-bank-source/.github/workflows/report-publication.yml@refs/heads/main']};
 const configured={...env,REPORT_OIDC_POLICY_JSON:JSON.stringify(policy),REPORT_SOURCES_JSON:JSON.stringify([fixture.source])};
  if(new URL(request.url).pathname==='/api/report-control')return control({request,env:configured});
  if(new URL(request.url).pathname==='/api/feedback')return feedback({request,env:configured});
  if(new URL(request.url).pathname==='/api/tg-webhook')return nativeReportWebhook({request,env:configured});
  if(new URL(request.url).pathname==='/api/report-identity-challenge')return identityChallengeRequest({request,env:configured});
  return new Response('not found',{status:404});
}};
