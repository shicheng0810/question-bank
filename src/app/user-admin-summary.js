// Pure display adapter: do not infer native counts from legacy fields or zeros.
export function userAdminSummary(user) {
  const phase = user.accountKind === 'native'
    ? user.accountPhase === 'deleting' ? '新版账号 · 删除处理中 · 本次观测' : user.accountPhase === 'active' ? '新版账号 · 活跃 · 本次观测' : '账号状态未知'
    : '仅旧源库存 · 未观察到新版账号';
  const stats = user.nativeStats;
  const proven = stats?.status === 'verified' && Number.isSafeInteger(stats.historySnapshotCount) && stats.historySnapshotCount >= 0
    && Number.isSafeInteger(stats.activePrivateBankCount) && stats.activePrivateBankCount >= 0;
  const native = proven ? `新版历史快照 ${stats.historySnapshotCount} · 新版私库 ${stats.activePrivateBankCount}`
    : '新版历史/私库数量未知';
  const old = user.legacyCounts;
  const valid = old && Number.isSafeInteger(old.historyCount) && old.historyCount >= 0
    && Number.isSafeInteger(old.bankCount) && old.bankCount >= 0;
  const label = old?.scope === 'legacy-archive' ? '遗留归档' : old?.scope === 'legacy-kv-mirror' ? '遗留镜像' : '旧源';
  return { phase, native, legacy: valid ? `${label}：历史 ${old.historyCount} · 私库 ${old.bankCount}` : '旧源数量未确认' };
}
