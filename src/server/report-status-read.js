import {projectReportStatus,validReportOperationId} from './report-status-projection.js';
// No production credential, file-path reader, namespace, or fallback. Injection
// is a server-owned test seam, not a browser-controlled bridge selection.
export async function readManagerReportStatus(query,readRow){
 const keys=[...query.keys()];const operationId=query.get('operationId');
 if(keys.length!==1||keys[0]!=='operationId'||!validReportOperationId(operationId))return {status:400,body:{ok:false,error:'REPORT_STATUS_INPUT_INVALID'}};
 if(!readRow)return {status:503,body:{ok:false,error:'REPORT_STATUS_BRIDGE_UNAVAILABLE'}};
 try{return {status:200,body:{ok:true,report:projectReportStatus(await readRow(operationId),operationId)}};}
 catch(error){const safe=['REPORT_STATUS_FORBIDDEN','REPORT_STATUS_STALE','REPORT_STATUS_CAS_CONFLICT'].includes(error?.code)?error.code:'REPORT_STATUS_UNAVAILABLE';return {status:safe==='REPORT_STATUS_FORBIDDEN'?403:safe==='REPORT_STATUS_STALE'||safe==='REPORT_STATUS_CAS_CONFLICT'?409:503,body:{ok:false,error:safe}};}
}

import {validReportAdminCommand,safeReportAdminResult} from '../../do-worker/src/report-admin-dto.js';
export async function readManagerReportSummaries(query,readSummaries){
 const keys=[...query.keys()];let command;
 if(keys.length===1&&keys[0]==='operationId')command={operationIds:[query.get('operationId')],limit:1,cursor:null};
 else if(keys.length===3&&['operationIds','limit','cursor'].every(k=>keys.includes(k)))command={operationIds:query.get('operationIds').split(','),limit:Number(query.get('limit')),cursor:query.get('cursor')||null};
 else return {status:400,body:{ok:false,error:'REPORT_STATUS_INPUT_INVALID'}};
 if(!validReportAdminCommand(command))return {status:400,body:{ok:false,error:'REPORT_STATUS_INPUT_INVALID'}};
 try{const result=await safeReportAdminResult(await readSummaries(command),command);if(!result)return {status:503,body:{ok:false,error:'REPORT_STATUS_UNAVAILABLE'}};
 if(result.ok===false)return {status:result.error==='REPORT_CURSOR_STALE'?409:503,body:result};
 return {status:200,body:keys[0]==='operationId'?{ok:true,report:result.items[0],scope:result.scope,partial:true}:{ok:true,reports:result}};
 }catch{return {status:503,body:{ok:false,error:'REPORT_STATUS_UNAVAILABLE'}};}
}
