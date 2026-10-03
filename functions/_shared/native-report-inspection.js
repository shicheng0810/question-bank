import { reconcileNativeReportPR } from './native-report-publisher.js';
/** Owner-only manager service helper. Always read-only: a crashed delivering or
 * creating_pr state can be inspected without obtaining another write lease. */
export async function inspectNativeReportOperation(env,operationId) {
  const row=await env.REPORT_OPERATIONS.getByName(operationId).get(operationId);
  if(!row)return {operationId,state:'not_found'};
  const result={operationId,state:row.state,updatedAt:row.updated_at};
  if(['creating_pr','provider_unknown','reconciling'].includes(row.state)){
    try{result.external=await reconcileNativeReportPR(env,JSON.parse(row.payload));}
    catch(error){result.error=error.code||'REPORT_RECONCILE_FAILED';}
  }else if(['delivering','delivery_unknown'].includes(row.state))result.action='needs_delivery_review_no_automatic_resend';
  return result;
}
