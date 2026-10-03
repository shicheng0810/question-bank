import { reportSources, validateReport, reportError } from './native-report.js';

export async function receiveNativeReport(body, env) {
  const pending = validateReport(body, reportSources(env));
  if (!env.REPORT_OPERATIONS) throw reportError('REPORT_LEDGER_NOT_CONFIGURED');
  const ledger = env.REPORT_OPERATIONS.getByName(pending.operationId);
  const row = await ledger.receive(pending);
  if (!await ledger.transition(pending.operationId, 'received', 'delivering')) return { ok: true, stored: true, operationId: pending.operationId, state: row.state, delivered: row.state === 'pending_approval' };
  const esc = text => String(text).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  // Only sanitized public, admitted fields go to the provider. No URL, account,
  // client-supplied original/private body, cookies, or browser identifiers.
  const text = (`✏️ 题目修正建议\n题库: ${pending.bankUid}\n题号: ${pending.question_index ?? '?'}\n题目: ${pending.corrected.question}\n修改: ${JSON.stringify(pending.corrected)}\n备注: ${pending.note}`).slice(0,3400)+`\n操作: ${pending.operationId}`;
  let delivered = false;
  try {
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: 'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:env.TELEGRAM_CHAT_ID,text:esc(text),parse_mode:'HTML',reply_markup:{inline_keyboard:[[{text:'✅ 批准修正',callback_data:'nr:'+pending.operationId}]]}}),signal:AbortSignal.timeout(10000) });
    const result = await response.json(); delivered = response.ok && result.ok === true;
    await ledger.transition(pending.operationId,'delivering',delivered ? 'pending_approval' : 'delivery_unknown', delivered ? {messageId:result.result.message_id} : null);
  } catch { await ledger.transition(pending.operationId,'delivering','delivery_unknown'); }
  return {ok:true,stored:true,delivered,operationId:pending.operationId,state:delivered ? 'pending_approval':'delivery_unknown'};
}
