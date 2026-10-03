export { ReportOperationStore } from '../../functions/_shared/report-operation-store.js';
import { onRequestPost as feedback } from '../../functions/api/feedback.js';
import { nativeReportWebhook } from '../../functions/_shared/native-report-webhook.js';
import { reportFixture } from './fixture.js';
export default {async fetch(request,env){
  const fixture=await reportFixture();
  const configured={...env,REPORT_SOURCES_JSON:JSON.stringify([fixture.source])};
  if(new URL(request.url).pathname==='/api/feedback')return feedback({request,env:configured});
  if(new URL(request.url).pathname==='/api/tg-webhook')return nativeReportWebhook({request,env:configured});
  return new Response('not found',{status:404});
}};
