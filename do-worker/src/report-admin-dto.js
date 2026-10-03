import {validReportOperationId,validateReportStatusDTO} from '../../src/server/report-status-projection.js';
export const REPORT_ADMIN_MAX_BYTES=16384;
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v))&&Reflect.ownKeys(v).length===keys.length&&Reflect.ownKeys(v).every(k=>typeof k==='string'&&keys.includes(k)&&Object.getOwnPropertyDescriptor(v,k)?.get===undefined&&Object.getOwnPropertyDescriptor(v,k)?.set===undefined);
export function validReportAdminCommand(v){return exact(v,['operationIds','limit','cursor'])&&Array.isArray(v.operationIds)&&Object.getPrototypeOf(v.operationIds)===Array.prototype&&v.operationIds.length>0&&v.operationIds.length<=64&&Reflect.ownKeys(v.operationIds).length===v.operationIds.length+1&&Array.from({length:v.operationIds.length},(_,i)=>Object.getOwnPropertyDescriptor(v.operationIds,String(i))).every(d=>d&&'value'in d&&validReportOperationId(d.value))&&new Set(v.operationIds).size===v.operationIds.length&&Number.isSafeInteger(v.limit)&&v.limit>=1&&v.limit<=8&&(v.cursor===null||typeof v.cursor==='string'&&/^[a-f0-9]{64}:[0-9]{1,2}$/.test(v.cursor));}
export async function reportAdminPage(command){
 if(!validReportAdminCommand(command))throw Error('INVALID_INPUT');const ids=[...command.operationIds].sort(),bytes=new TextEncoder().encode(JSON.stringify(ids)),scope=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');let offset=0;
 if(command.cursor!==null){const [hash,index]=command.cursor.split(':');offset=Number(index);if(hash!==scope||offset>=ids.length||String(offset)!==index)throw Error('REPORT_CURSOR_STALE');}
 return {ids,scope,offset,selected:ids.slice(offset,offset+command.limit)};
}
export async function safeReportAdminResult(result,command){try{
 if(exact(result,['ok','error'])&&result.ok===false&&/^(NOT_CONFIGURED|UNAVAILABLE|INVALID_INPUT|REPORT_CURSOR_STALE)$/.test(result.error))return {ok:false,error:result.error};
 const p=await reportAdminPage(command);if(!exact(result,['ok','scope','partial','knownOperationCount','items','cursor','snapshot'])||result.ok!==true||result.scope!=='provided-operation-ids'||result.partial!==true||result.knownOperationCount!==p.ids.length||result.snapshot!=='live-read-not-snapshot'||!Array.isArray(result.items)||result.items.length<1||result.items.length>p.selected.length||result.items.some((v,i)=>validateReportStatusDTO(v).operationId!==p.selected[i]))return null;
 const end=p.offset+result.items.length,expected=end<p.ids.length?`${p.scope}:${end}`:null;if(result.cursor!==expected||new TextEncoder().encode(JSON.stringify(result)).byteLength>REPORT_ADMIN_MAX_BYTES)return null;return JSON.parse(JSON.stringify(result));
 }catch{return null;}}
