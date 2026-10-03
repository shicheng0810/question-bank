import {RELEASE_HEAD} from './report-release-contract.js';
import {reportError} from './native-report.js';
import {sha256Hex,canonicalContentBytes} from '../../src/domain/app-data/canonical.js';
export const REPORT_SOURCE_BASE='9aa96ebdef680e580c4cdbc232f6a0de82d65071';
export async function approvalPacket(pending,env){
 const approverIds=String(env.TELEGRAM_APPROVER_IDS||'').split(',').map(v=>v.trim()).filter(v=>/^\d+$/.test(v));if(!approverIds.length)throw reportError('REPORT_APPROVER_NOT_CONFIGURED');
 const head=await env.REPORT_OPERATIONS?.getByName(RELEASE_HEAD).releaseHead();
 const sourceBase=head?.commit;if(head?.inflight||!/^[a-f0-9]{40}$/.test(sourceBase||''))throw reportError('REPORT_RELEASE_HEAD_UNAVAILABLE');
 const digest=await sha256Hex(canonicalContentBytes(pending)),nonce=crypto.randomUUID().replace(/-/g,'').slice(0,16),expiresAt=Date.now()+24*60*60*1000;
 const text=`✏️ 完整题目修正待批准\n题目身份: ${pending.questionKey}\n题库版本: ${pending.revision}\n题目版本: ${pending.questionRevision}\n来源提交: ${sourceBase}\n修正全文: ${JSON.stringify(pending.corrected)}\n备注: ${pending.note}\n内容摘要: ${digest}\n操作: ${pending.operationId}\n批准截止: ${new Date(expiresAt).toISOString()}`;
 // Fail before sending/claiming: never attach approval to a partial correction.
 if(text.length>4000)throw reportError('REPORT_APPROVAL_TOO_LONG');
 return {text,approval:{approverIds,nonce,digest,sourceBase,releaseGeneration:head.generation,expiresAt,chatId:String(env.TELEGRAM_CHAT_ID)},callbackData:`nr:${pending.operationId}:${nonce}`};
}
export async function assertApprovalCallback(row,callback,id){
 const saved=JSON.parse(row.result||'null'),a=saved?.approval;
 if(row.state!=='pending_approval'||!a||!a.approverIds?.includes(String(callback.from?.id))||a.expiresAt<=Date.now()||Date.now()-row.updated_at>24*60*60*1000||String(callback.message?.chat?.id)!==a.chatId||callback.message?.message_id!==saved.messageId||callback.data!==`nr:${id}:${a.nonce}`||a.digest!==await sha256Hex(canonicalContentBytes(JSON.parse(row.payload))))throw Error('REPORT_APPROVAL_STALE');
 return a;
}
