const fail = code => Object.assign(new Error(code), {code});
export function validateResumeCapabilities(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).sort().join(',') !== 'resumeSchemaVersions,snapshotBaselineInitializationEnabled'
      || !Array.isArray(value.resumeSchemaVersions) || value.resumeSchemaVersions.length !== 2 || value.resumeSchemaVersions[0] !== 1 || value.resumeSchemaVersions[1] !== 2
      || typeof value.snapshotBaselineInitializationEnabled !== 'boolean') throw fail('RESUME_CAPABILITY_UNAVAILABLE');
  return Object.freeze({resumeSchemaVersions:Object.freeze([1,2]),snapshotBaselineInitializationEnabled:value.snapshotBaselineInitializationEnabled});
}
/** Fresh authenticated DO response. Never persist it or accept build metadata as proof. */
export async function requireSnapshotInitializationCapability(account, {isCurrent=()=>true, buildCompatibility} = {}) {
  if (buildCompatibility?.snapshotBaselineInitializationEnabled !== true) throw fail('SNAPSHOT_BASELINE_DISABLED');
  if (buildCompatibility?.resumeStateSchemaVersions?.join(',') !== '1,2') throw fail('RESUME_CAPABILITY_UNAVAILABLE');
  const initial = account?.snapshot();
  if (initial?.phase !== 'ready' || !initial.owner) throw fail('RESUME_CAPABILITY_UNAVAILABLE');
  const guard = () => {const current=account.snapshot();if(!isCurrent() || current.epoch!==initial.epoch || current.phase!=='ready' || current.owner?.accountId!==initial.owner.accountId || current.owner?.accountGeneration!==initial.owner.accountGeneration) throw fail('STALE_REQUEST');};
  guard();
  let result;
  try {result=await account.authenticatedTransport({path:'/v2/sync/capabilities',method:'GET'});}
  catch (error) {guard();if(['STALE_REQUEST','STALE_OWNER'].includes(error?.code))throw error;throw fail('RESUME_CAPABILITY_UNAVAILABLE');}
  guard();
  if (result.status!==200 || result.epoch!==initial.epoch || result.owner?.accountId!==initial.owner.accountId || result.owner?.accountGeneration!==initial.owner.accountGeneration) throw fail('RESUME_CAPABILITY_UNAVAILABLE');
  const capabilities=validateResumeCapabilities(result.body);
  if(!capabilities.snapshotBaselineInitializationEnabled)throw fail('SNAPSHOT_BASELINE_DISABLED');
  guard();return capabilities;
}
/** The caller flushes local debounce and the native queue. No cloud ACK is required. */
export async function refreshAfterLocalSave({flushLocal,isCurrent=()=>true,confirmRefresh=()=>globalThis.confirm('Local data is saved. Refresh to update?'),navigate=()=>globalThis.location.reload()}) {
  if(!isCurrent())throw fail('STALE_REQUEST');
  await flushLocal();
  if(!isCurrent())throw fail('STALE_REQUEST');
  if(!await confirmRefresh())return false;
  if(!isCurrent())throw fail('STALE_REQUEST');
  navigate();return true;
}

export function showResumeUpgradeNotice(node,{error,flushLocal,isCurrent,language='en'}) {
  const code=error?.code||error?.reason||error?.error;
  if(!node||!['CLIENT_UPGRADE_REQUIRED','RESUME_CAPABILITY_UNAVAILABLE','SNAPSHOT_BASELINE_DISABLED'].includes(code))return false;
  const messages={
    en:{upgrade:'Update before syncing. Device data is retained; save current input before a manual refresh.',capability:'Receiver capability is not confirmed. No new continuation was created; existing data is retained.',disabled:'New snapshot continuation is disabled. Existing progress can still be saved.',button:'Save locally, then refresh',confirm:'Local data is saved. Refresh to update?',failed:'Local save failed; this page was not refreshed: '},
    zh:{upgrade:'更新后再同步。本机资料保留；手动刷新前先保存当前输入。',capability:'接收端能力未确认。未创建新的续做记录；已有资料保留。',disabled:'新的快照续做暂未启用；已有进度仍可保存。',button:'本机保存后手动刷新',confirm:'本机资料已保存。确认刷新以更新？',failed:'本机保存失败；页面未刷新：'},
    es:{upgrade:'Actualiza antes de sincronizar. Los datos locales se conservan; guarda antes de actualizar.',capability:'Capacidad del receptor sin confirmar. No se creó una continuación; los datos se conservan.',disabled:'Nueva continuación desactivada. El progreso existente puede guardarse.',button:'Guardar localmente y actualizar',confirm:'Datos guardados localmente. ¿Actualizar?',failed:'Error al guardar; la página no se actualizó: '}
  };
  const text=messages[language]||messages.en;
  node.replaceChildren();node.dataset.state='upgrade-required';
  const message=document.createElement('span');message.textContent=code==='CLIENT_UPGRADE_REQUIRED'?text.upgrade:code==='SNAPSHOT_BASELINE_DISABLED'?text.disabled:text.capability;node.append(message);
  if(code==='CLIENT_UPGRADE_REQUIRED'){
    const button=document.createElement('button');button.type='button';button.dataset.testid='resume-upgrade-refresh';button.textContent=text.button;node.append(' ',button);
    button.onclick=async()=>{if(!isCurrent())return;button.disabled=true;try{await refreshAfterLocalSave({flushLocal,isCurrent,confirmRefresh:()=>globalThis.confirm(text.confirm)});}catch(cause){if(isCurrent())message.textContent=text.failed+(cause.code||cause.message);}finally{if(isCurrent())button.disabled=false;}};
  }
  return true;
}
