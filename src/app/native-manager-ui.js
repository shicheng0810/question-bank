import {safeNativeConversionInventory,safeNativeConversionResult} from '../../do-worker/src/native-conversion-dto.js';
import {mountReportStatus} from './report-status-ui.js';
import {mountAccountSharing} from './account-sharing-ui.js';
import { safeAdminItemsResult } from '../../do-worker/src/native-admin-items-dto.js';
export function mountNativeManager({ listElement, renderUsers, fetchImpl = fetch, legacySelected = () => false }) {
  const document = listElement.ownerDocument;
  const controls = document.createElement('div');
  const search = document.createElement('input'); search.placeholder = '搜索完整或部分账号 ID（十六进制）'; search.setAttribute('aria-label','搜索新版账号');
  const submit = document.createElement('button'); submit.type = 'button'; submit.textContent = '搜索';
  const previous = document.createElement('button'); previous.type = 'button'; previous.textContent = '上一页';
  const next = document.createElement('button'); next.type = 'button'; next.textContent = '下一页';
  const status = document.createElement('p'); status.role = 'status';
  const detail = document.createElement('pre'); detail.dataset.testid = 'native-account-detail'; detail.style.whiteSpace = 'pre-wrap';
  const itemSections = document.createElement('div'); itemSections.dataset.testid='native-items';
  controls.append(search, submit, previous, next, status, detail, itemSections); listElement.before(controls);mountReportStatus({container:controls,fetchImpl});if(typeof window!=='undefined')mountAccountSharing({container:controls});
  let cursors = [null], page = 0, nextCursor = null, epoch = 0, detailEpoch = 0;
  async function request(query) {
    const response = await fetchImpl('/api/local/users?' + query);
    const data = await response.json();
    if (!response.ok || data?.ok !== true) throw new Error(data?.error || `HTTP ${response.status}`);
    return data;
  }
  function query() { return new URLSearchParams({ view:'manager', q:search.value.trim(), limit:'25', ...(legacySelected() ? { includeLegacy:'1' } : {}) }); }
  async function load(reset = true) {
    const current = ++epoch; ++detailEpoch; detail.textContent = ''; itemSections.replaceChildren();
    if (reset) { cursors = [null]; page = 0; }
    previous.disabled = next.disabled = true; status.textContent = '读取中…';
    try {
      const params = query(); if (cursors[page]) params.set('cursor',cursors[page]);
      const data = await request(params);
      if (!Array.isArray(data.users) || !Number.isSafeInteger(data.observedMatches)
        || !(data.nextCursor === null || typeof data.nextCursor === 'string')) throw new Error('CENSUS_SHAPE_INVALID');
      if (current !== epoch) return;
      renderUsers(data.users); nextCursor = data.nextCursor;
      status.textContent = `第 ${page+1} 页 · 本次匹配 ${data.observedMatches} 条 · 完整性未知（每页重新观测）`;
      previous.disabled = page === 0; next.disabled = !nextCursor;
    } catch (error) { if (current === epoch) status.textContent = `读取失败；数量未知，保留先前观测：${error.message}`; }
  }
  async function show(sub) {
    const current = ++detailEpoch;
    detail.textContent = '详情读取中…'; itemSections.replaceChildren();
    try {
      const params = query(); params.set('sub',sub);
      const data = await request(params);
      if (data.binding?.principal !== sub || data.user?.sub !== sub || !data.counts
        || !data.history || !data.privateBanks || !data.report) throw new Error('DETAIL_SHAPE_INVALID');
      if (current !== detailEpoch) return;
      const counts = data.counts.status === 'verified'
        ? `历史快照 ${data.counts.historySnapshotCount} · 尝试 ${data.counts.attemptCount} · 私库 ${data.counts.activePrivateBankCount}` : '新版数量未知';
      detail.textContent = `账号 ${sub}\nowner/incarnation ${data.binding.incarnation ?? 'unknown'}\nfence ${data.binding.fence ?? 'unknown'}\ngeneration ${data.binding.generation ?? 'unknown'}\n${counts}\n计数来源 ${data.counts.source}\n历史快照/学习尝试/活跃私库条目：下方分别读取；只有验证成功才显示列表\n云保存：${data.save.status} — ${data.save.reason}\nReport：全局只读面板按 operationID 查询；不从账号数量推断发布状态\n本地保存/预览/正式发布/线上读回：unknown（没有对应状态凭据）`;

      const preflight=document.createElement('section'),pfTitle=document.createElement('p'),pfButton=document.createElement('button'),pfOutput=document.createElement('pre'),pfRecords=document.createElement('div');pfTitle.textContent='旧源迁移 / 退役预检（仅 plan，不执行）';pfButton.type='button';pfButton.textContent='读取迁移 / 退役预检';pfButton.dataset.testid='manager-preflight';pfOutput.dataset.testid='manager-preflight-status';pfOutput.style.whiteSpace='pre-wrap';preflight.append(pfTitle,pfButton,pfOutput,pfRecords);itemSections.append(preflight);let pfEpoch=0;
      async function inspectPreflight(kind,recordId){const pfCurrent=++pfEpoch;pfOutput.textContent='只读预检中…';try{const params=query();params.set('sub',sub);params.set('preflight','1');params.set('incarnation',data.binding.incarnation);params.set('fence',String(data.binding.fence));params.set('generation',data.binding.generation);if(recordId){params.set('conversionKind',kind);params.set('recordId',recordId);}const r=await request(params);if(r.ok!==true||r.applyEnabled!==false||r.binding?.principal!==sub||r.binding.incarnation!==data.binding.incarnation||r.binding.generation!==data.binding.generation||r.binding.fence!==data.binding.fence||!['unknown','inventory-verified','planned','plan-unavailable'].includes(r.status)||r.retirement?.sourceDeleted!==false||r.retirement.status!=='blocked')throw Error('PREFLIGHT_SHAPE_INVALID');if(r.inventory&&!safeNativeConversionInventory(r.inventory))throw Error('PREFLIGHT_SHAPE_INVALID');if(r.plan){const {kind:planKind,recordId:planRecord,...value}=r.plan;if(!['history','bank'].includes(planKind)||typeof planRecord!=='string'||!safeNativeConversionResult(value,planKind)||value.status!=='planned')throw Error('PREFLIGHT_SHAPE_INVALID');}if(current!==detailEpoch||pfCurrent!==pfEpoch)return;
       pfOutput.textContent=`对象 ${sub}\nowner ${r.binding.incarnation} · generation ${r.binding.generation} · fence ${r.binding.fence}\n迁移预检 ${r.status}${r.reason?' — '+r.reason:''}\n旧源清单：${r.inventory?'sealed manifest '+r.inventory.manifestSha256+'（历史 '+r.inventory.histories.length+' / 私库 '+r.inventory.banks.length+'；不是新版统计）':'unknown'}\n${r.plan?'计划 '+r.plan.kind+' '+r.plan.recordId+' → '+(r.plan.bankUid||r.plan.snapshotId)+' · '+r.plan.contentDigest+'；源未删除':''}\n退役 blocked：需完整新版导出/checkpoint、独立恢复回执、逐记录接受凭据及精确旧副本退役接口；不能用删除账号替代。\napply 未开放；rotation 无现有管理接口。账号自删沿用原确认票据协议，管理员删除沿用双确认及 incarnation/fence 检查。`;
       if(r.inventory&&!recordId){pfRecords.replaceChildren();for(const [k,rows]of [['history',r.inventory.histories],['bank',r.inventory.banks]])for(const row of rows){const button=document.createElement('button');button.type='button';button.textContent=`预检 ${k} ${row.recordId}`;button.onclick=()=>void inspectPreflight(k,row.recordId);pfRecords.append(button);}}
      }catch(error){if(current===detailEpoch&&pfCurrent===pfEpoch)pfOutput.textContent=`预检未知/失败：${error.message}；未执行迁移、退役或删除。`;}}
      pfButton.onclick=()=>void inspectPreflight();
      for (const [kind,label] of [['history_snapshot','导入历史快照'],['attempt_manifest','新版学习尝试'],['private_bank','活跃私库（每库当前 revision）'],['attempt_diagnostics','云端 resume / 保存回执诊断（不代表设备已全部同步）']]) {
        const section=document.createElement('section');const heading=document.createElement('h4');heading.textContent=label;
        const output=document.createElement('pre');output.dataset.kind=kind;
        const more=document.createElement('button');more.type='button';more.textContent='下一页';more.disabled=true;
        const restart=document.createElement('button');restart.type='button';restart.textContent='重新读取';
        section.append(heading,output,more,restart);itemSections.append(section);
        let cursor=null, itemEpoch=0;
        async function items(reset=false) {
          if (current!==detailEpoch) return;
          const itemCurrent=++itemEpoch;if(reset)cursor=null;more.disabled=true;output.textContent='读取中…';
          const command={principal:sub,incarnation:data.binding.incarnation,expectedFence:data.binding.fence,
            expectedGeneration:data.binding.generation,kind,limit:25,cursor};
          try {
            const params=query();params.set('sub',sub);params.set('kind',kind);params.set('incarnation',command.incarnation);
            params.set('fence',String(command.expectedFence));params.set('generation',command.expectedGeneration);
            if(cursor)params.set('cursor',cursor);
            const result=await request(params);const safe=safeAdminItemsResult(result,command);
            if(!safe || safe.ok!==true)throw new Error(safe?.error || 'ADMIN_ITEMS_SHAPE_INVALID');
            if(current!==detailEpoch || itemCurrent!==itemEpoch)return;
            output.textContent=`观测水位 ${safe.watermark.highWater} · generation ${safe.generation}\n`+
              (safe.items.length ? safe.items.map(item=>`${item.id} · revision ${item.revision} · seq ${item.serverSeq}${item.diagnostic ? '\n  resume revision '+(item.diagnostic.resumeRevision??'unknown')+' · '+item.diagnostic.resumeStatus+' · 服务端接受的 resume 序号 '+(item.diagnostic.serverConfirmedCut??'unknown')+' · payloadDigest '+(item.diagnostic.resumePayloadDigest??'unknown')+' · receipt '+(item.diagnostic.receiptType??'unknown')+' · 更新时间 unknown · '+item.diagnostic.unknownReason : ''}`).join('\n') : '已验证：本页无条目');
            cursor=safe.nextCursor;more.disabled=!cursor;
          } catch(error){if(current===detailEpoch && itemCurrent===itemEpoch)output.textContent=`条目未知/读取失败：${error.message}；重新读取需同一账号 binding，变更后请重新打开详情。`;}
        }
        more.onclick=()=>items();restart.onclick=()=>items(true);void items();
      }
    } catch (error) { if (current === detailEpoch) detail.textContent = `详情不可用；数量未知：${error.message}`; }
  }
  submit.onclick = () => load(); search.onkeydown = event => { if (event.key === 'Enter') load(); };
  previous.onclick = () => { if (page > 0) { page--; load(false); } };
  next.onclick = () => { if (nextCursor) { cursors[++page] = nextCursor; load(false); } };
  listElement.addEventListener('click', event => { const button = event.target.closest('[data-user-act="detail"]'); if (button) show(button.dataset.userSub); });
  return { load, show, search, submit, next, previous, status, detail, itemSections };
}

export function confirmAccountRemoval(users, confirmImpl = confirm) {
  const scope = users.map(user => `对象 ${user.sub}\n类型 ${user.accountKind}\ngeneration ${user.nativeStats?.generation ?? 'unknown'}\n影响：${user.accountKind === 'native' ? '账号及当前账号数据；不是仅删除旧副本' : '旧源库存（需后端核实无当前账号）'}`).join('\n\n');
  return confirmImpl(scope + '\n删除不可撤销。是否继续？') && confirmImpl(scope + '\n第二次确认删除上述对象？');
}
