const stages=['localSave','build','preview','publication','onlineReadback','syncReceipt','report'];
export function publicationEvidenceSummary(evidence) {
  if(!evidence || evidence.schemaVersion!==1 || evidence.scope!=='local-publication-files'
    || typeof evidence.id!=='string' || stages.some(key=>!evidence[key] || !['verified','artifact-match','stale','unknown'].includes(evidence[key].status))) throw new Error('PUBLICATION_EVIDENCE_SHAPE_INVALID');
  const labels={localSave:'本地保存读回',build:'本地构建产物',preview:'预览发布',publication:'Cloudflare 正式发布',onlineReadback:'线上读回',syncReceipt:'账号同步 receipt',report:'Report 关联'};
  const allowed={localSave:['verified','unknown'],build:['artifact-match','stale','unknown']};
  for(const key of stages)if(!(allowed[key] || ['unknown']).includes(evidence[key].status))throw new Error('PUBLICATION_EVIDENCE_UNSUPPORTED_CLAIM');
  const states={verified:'已核验', 'artifact-match':'题库产物匹配（整站构建未知）',stale:'产物已过期',unknown:'未知'};
  const lines=stages.map(key=>`${labels[key]}：${states[evidence[key].status]}${evidence[key].reason?' — '+evidence[key].reason:''}`).join('\n');
  const site=evidence.sitePublication;
  if(site?.status==='recorded')return lines+`\n既有站点发布记录：${site.completedAt} · ${site.deploymentURL}（当前生产指针/此库绑定仍未知）`;
  return lines;
}
export function mountPublicationEvidence({listElement,fetchImpl=fetch}) {
  const document=listElement.ownerDocument;const output=document.createElement('pre');output.dataset.testid='publication-evidence';output.style.whiteSpace='pre-wrap';listElement.after(output);let epoch=0;
  async function show(id){const current=++epoch;output.textContent='证据读取中…';try{
    const response=await fetchImpl('/api/local/publish-bank?'+new URLSearchParams({evidence:'1',id}));const data=await response.json();
    if(!response.ok || data?.ok!==true || data.evidence?.id!==id)throw new Error(data?.error || 'EVIDENCE_READ_UNAVAILABLE');
    const text=publicationEvidenceSummary(data.evidence);if(current===epoch)output.textContent=`题库 ${id}（本地文件范围）\n${text}`;
  }catch(error){if(current===epoch)output.textContent=`证据读取失败；保存/发布状态未知：${error.message}`;}}
  listElement.addEventListener('click',event=>{const button=event.target.closest('[data-publication-evidence]');if(button)void show(button.dataset.publicationEvidence);});
  return {show,output};
}
