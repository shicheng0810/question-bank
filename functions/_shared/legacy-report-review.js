/** Owner-only server helper. Caller must enforce local manager authentication;
 * never mount this on a public Pages GET endpoint. No stem-based auto mapping. */
export async function listLegacyReportReview(env,{cursor,limit=50}={}) {
  if(!env.EDITS)throw new Error('REPORT_ARCHIVE_NOT_CONFIGURED');
  if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error('REPORT_REVIEW_LIMIT_INVALID');
  const page=await env.EDITS.list({prefix:'edit:',limit,...(cursor?{cursor}:{})});
  const items=await Promise.all(page.keys.map(async key=>{
    const raw=await env.EDITS.get(key.name);if(!raw)return {id:key.name,state:'expired_during_read'};
    try{const pending=JSON.parse(raw);return {id:key.name,state:'needs_identity_review',createdAt:pending.ts||null,bankId:pending.bank_id||null,hasOriginal:!!pending.original,hasCorrection:!!pending.corrected};}
    catch{return {id:key.name,state:'corrupt_record'};}
  }));
  return {items,cursor:page.list_complete?null:page.cursor,complete:page.list_complete,policy:'manual exact native identity review required; no source deletion'};
}
