import {approvalPacket} from './report-approval.js';
import { reportSources, validateReport, reportError } from './native-report.js';

export async function receiveNativeReport(body, env) {
  const pending = validateReport(body, reportSources(env));
  const packet=await approvalPacket(pending,env);
  if (!env.REPORT_OPERATIONS) throw reportError('REPORT_LEDGER_NOT_CONFIGURED');
  const ledger = env.REPORT_OPERATIONS.getByName(pending.operationId);
  const row = await ledger.receive(pending);
  if (!await ledger.transition(pending.operationId, 'received', 'delivering')) return { ok: true, stored: true, operationId: pending.operationId, state: row.state, delivered: row.state === 'pending_approval' };
  let delivered = false;
  try {
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: 'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:env.TELEGRAM_CHAT_ID,text:packet.text,reply_markup:{inline_keyboard:[[{text:'✅ 批准修正',callback_data:packet.callbackData}]]}}),signal:AbortSignal.timeout(10000) });
    const result = await response.json(); delivered = response.ok && result.ok === true && Number.isSafeInteger(result.result?.message_id) && result.result.message_id>0 && String(result.result?.chat?.id)===String(env.TELEGRAM_CHAT_ID);
    await ledger.transition(pending.operationId,'delivering',delivered ? 'pending_approval' : 'delivery_unknown', delivered ? {messageId:result.result.message_id,approval:packet.approval} : null);
  } catch { await ledger.transition(pending.operationId,'delivering','delivery_unknown'); }
  return {ok:true,stored:true,delivered,operationId:pending.operationId,state:delivered ? 'pending_approval':'delivery_unknown'};
}
