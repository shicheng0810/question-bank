import { validateExportManifest } from '../domain/app-data/export-manifest.js';
import { snapshotOwner } from '../storage/profiles/control-schema.js';
import { createLocalNativeLifecycle } from './local-native-lifecycle.js';
function download(value, name, type) {
  const url = URL.createObjectURL(value instanceof Blob ? value : new Blob([value], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function validateBackupDownload(result) {
  if (!result || Object.getPrototypeOf(result) !== Object.prototype || !(result.blob instanceof Blob)
      || result.blob.type !== 'application/zip' || result.blob.size === 0 || result.blob.size > 64 * 1024 * 1024) throw new Error('BACKUP_DOWNLOAD_SHAPE');
  validateExportManifest(result.manifest);
  const owner = snapshotOwner(result.owner);
  if (owner.ownerKind !== 'guest') throw new Error('LOCAL_GUEST_REQUIRED');
  // Preserve the validated envelope; the original restore still verifies its
  // embedded manifest, owner, hashes and dependency closure independently.
  return result;
}
export function mountLocalNativeLifecycle({ container, lifecycle = createLocalNativeLifecycle(), confirm = window.confirm.bind(window), prompt = window.prompt.bind(window) }) {
  const panel = document.createElement('details'); panel.id = 'localNativeLifecycle';
  panel.innerHTML = `<summary>本机新版私库 / 备份恢复 / 进度诊断</summary>
<p>仅当前浏览器、当前本地 origin 的新版访客数据；不会读取正式站账号。访客无云同步回执。</p>
<button data-native-refresh>读取本机数据</button><label>导入题目 JSON <input data-native-import type="file" accept="application/json,.json"></label>
<button data-native-backup>导出完整本机备份</button><label>隔离恢复 ZIP <input data-native-restore type="file" accept=".zip"></label>
<p data-native-status role="status"></p><pre data-native-diagnostics></pre><div data-native-banks></div><div data-native-history></div>`;
  container.append(panel); const q = selector => panel.querySelector(selector); let busy = false, snapshot;
  async function run(action) {
    if (busy) return;
    busy = true; panel.querySelectorAll('button,input').forEach(el => el.disabled = true);
    try { await action(); } catch (e) { q('[data-native-status]').textContent = `失败：${e.code || e.message}。保留上次读取；数量未验证。`; }
    finally { busy = false; panel.querySelectorAll('button,input').forEach(el => el.disabled = false); }
  }
  async function refresh() {
    snapshot = await lifecycle.inspect();
    q('[data-native-diagnostics]').textContent = JSON.stringify({ source:snapshot.source,observedAt:snapshot.observedAt,owner:snapshot.owner,sync:snapshot.sync },null,2);
    q('[data-native-status]').textContent = `已读回：私库版本 ${snapshot.banks.length}，历史 ${snapshot.history.length}；来源为本机 native profile。`;
    const banks=q('[data-native-banks]'), history=q('[data-native-history]');banks.replaceChildren();history.replaceChildren();
    for (const bank of snapshot.banks) {
      const row=document.createElement('p');row.textContent=`${bank.title} / ${bank.bankUid} / ${bank.revision} / ${bank.questionCount}题 / ${bank.visibility} `;
      const exportBtn=document.createElement('button');exportBtn.textContent='导出此版本';exportBtn.onclick=()=>run(async()=>download(JSON.stringify(await lifecycle.exportBank(bank.bankUid,bank.revision),null,2),`${bank.bankUid}.json`,'application/json'));row.append(exportBtn);
      const start=document.createElement('button');start.textContent='在本机创建学习进度';start.onclick=()=>run(async()=>{await lifecycle.startBank(bank.bankUid,bank.revision);await refresh();});row.append(start);banks.append(row);
    }
    for(const entry of snapshot.history){
      const row=document.createElement('p');row.textContent=`${entry.attemptId} / ${entry.status} / ${entry.scopeCount}题 / ${entry.device} / 待同步 ${entry.syncPending} `;
      const detail=document.createElement('button');detail.textContent='详情 / 继续';detail.onclick=()=>run(async()=>{const result=await lifecycle.continueHistory(entry.attemptId);await refresh();q('[data-native-status]').textContent=`已由既有学习 session 继续：${result.bundle.attempt.attemptId}，范围 ${result.bundle.scope.length}题。`;});row.append(detail);history.append(row);
    }
  }
  q('[data-native-refresh]').onclick=()=>run(refresh);
  q('[data-native-import]').onchange=()=>run(async()=>{
    const file=q('[data-native-import]').files[0];if(!file)return;
    if(file.size>32*1024*1024)throw new Error('IMPORT_TOO_LARGE');
    const title=prompt('本机私库标题',file.name);if(title===null)return;
    await lifecycle.importQuestions(JSON.parse(await file.text()),title);await refresh();q('[data-native-import]').value='';
  });
  q('[data-native-backup]').onclick=()=>run(async()=>{
    const result = validateBackupDownload(await lifecycle.exportBackup());
    download(result.blob,'native-local-backup.zip','application/zip');
  });
  q('[data-native-restore]').onchange=()=>run(async()=>{
    const file=q('[data-native-restore]').files[0];if(!file)return;
    if(file.size>64*1024*1024)throw new Error('BACKUP_TOO_LARGE');
    const s=await lifecycle.inspect(), object=JSON.stringify(s.owner);
    if(!confirm(`恢复 ${file.name} 到 ${object}：创建隔离 profile 并由既有服务验证合并，成功后切换当前本机数据；不上传。`))return;
    if(prompt(`再次确认对象 ${object}；输入 RESTORE`)!=='RESTORE')return;
    const result=await lifecycle.restoreBackup(new Uint8Array(await file.arrayBuffer()));await refresh();
    q('[data-native-status]').textContent=`恢复服务结果：${result.status || 'activated'} ${result.profileId || ''} ${result.error || ''}；已重新读回当前 profile。`;
    q('[data-native-restore]').value='';
  });
  return { panel, refresh:()=>run(refresh), close:()=>lifecycle.close() };
}
