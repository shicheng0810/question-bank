import { createNativeReportPR, reconcileNativeReportPR } from './native-report-publisher.js';

async function telegram(env,method,body) {
  try {const response=await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});return await response.json();}catch{return null;}
}
async function sameSecret(actual,expected) {
  if(!actual || !expected)return false;
  const encode=value=>new TextEncoder().encode(value);
  const [a,b]=await Promise.all([crypto.subtle.digest('SHA-256',encode(actual)),crypto.subtle.digest('SHA-256',encode(expected))]);
  const x=new Uint8Array(a),y=new Uint8Array(b);let diff=0;for(let i=0;i<x.length;i++)diff|=x[i]^y[i];return diff===0;
}
export async function nativeReportWebhook({request,env}) {
  if(!await sameSecret(request.headers.get('X-Telegram-Bot-Api-Secret-Token'),env.TELEGRAM_WEBHOOK_SECRET))return new Response('forbidden',{status:403});
  let update;try{update=await request.json();}catch{return new Response('bad request',{status:400});}
  const callback=update?.callback_query;if(!callback)return new Response('ok');
  const answer=text=>telegram(env,'answerCallbackQuery',{callback_query_id:callback.id,text,show_alert:true});
  // Delivery chat may be a group. Approval users are configured separately.
  const allowed=String(env.TELEGRAM_APPROVER_IDS||'').split(',').map(value=>value.trim()).filter(Boolean);
  if(!allowed.includes(String(callback.from?.id)) || String(callback.message?.chat?.id)!==String(env.TELEGRAM_CHAT_ID)){await answer('无权操作');return new Response('ok');}
  const id=String(callback.data||'').match(/^nr:([a-f0-9-]{36})$/)?.[1];
  if(!id){const legacy=String(callback.data||'').match(/^ap:([a-f0-9]{16})$/)?.[1];if(legacy){const stored=await env.EDITS?.get('edit:'+legacy);await answer(stored?'旧报告已保留，需要管理器复核补齐新版身份':'旧报告已过期或不存在；请核查反馈保留记录');}else await answer('未知审批操作');return new Response('ok');}
  if(!env.REPORT_OPERATIONS || !env.GITHUB_TOKEN){await answer('审批后端尚未配置');return new Response('ok');}
  const ledger=env.REPORT_OPERATIONS.getByName(id),row=await ledger.get(id);
  if(!row){await answer('报告不存在');return new Response('ok');}
  if(row.state==='provider_unknown' && await ledger.transition(id,'provider_unknown','reconciling')){
    try{const result=await reconcileNativeReportPR(env,JSON.parse(row.payload));await ledger.transition(id,'reconciling',result.state,result);await answer(result.state==='pr_created'?`已查到 PR #${result.number}；尚未上线`:result.reconciliation==='branch_exists_pull_missing'?'分支已存在，PR 待受控恢复；没有重复创建':'尚未查到外部结果，继续保留报告');}
    catch(error){await ledger.transition(id,'reconciling','provider_unknown',{code:error.code||'REPORT_RECONCILE_FAILED'});await answer('结果核查失败，报告仍保留');}
    return new Response('ok');
  }
  if(!await ledger.transition(id,'pending_approval','creating_pr')){await answer(`当前状态：${row.state}；重复点击不会重复创建 PR`);return new Response('ok');}
  try {
    const result=await createNativeReportPR(env,JSON.parse(row.payload));
    await ledger.transition(id,'creating_pr','pr_created',result);
    await answer(`已批准，PR #${result.number}${result.autoMerge?' 等待 CI 自动合并':' 等待校验/合并'}；尚未上线`);
    await telegram(env,'editMessageReplyMarkup',{chat_id:callback.message.chat.id,message_id:callback.message.message_id,reply_markup:{inline_keyboard:[]}});
  }catch(error){
    const state=error.code?.includes('CONFLICT')?'conflict':'provider_unknown';
    await ledger.transition(id,'creating_pr',state,{code:error.code||'REPORT_PROVIDER_UNKNOWN'});
    await answer(state==='conflict'?'题库版本已变化，需要重新复核':'外部结果待核查；保留报告，禁止盲目重复提交');
  }
  return new Response('ok');
}
