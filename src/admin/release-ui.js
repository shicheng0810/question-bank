const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function byId(id) {
  return document.getElementById(id);
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function readResponse(response) {
  return response
    .json()
    .catch(() => {
      throw new Error("发布服务返回了无效响应。");
    });
}

function allValid(state) {
  const summary = state?.report?.summary;
  return (
    Number.isInteger(summary?.total) &&
    summary.total > 0 &&
    summary.total === summary.valid &&
    summary.review === 0 &&
    summary.rejected === 0
  );
}

/**
 * Browser-only release controls. The caller owns draft state and supplies its
 * authenticated mutation function; this module never stores a credential.
 */
export function initReleaseUi({
  getState,
  getSavedState,
  getCloudDraft,
  getDraftBusy,
  getGeneration,
  mutation,
}) {
  const elements = {
    publish: byId("publish-cloud"),
    refresh: byId("refresh-releases"),
    next: byId("next-release-history"),
    status: byId("release-status"),
    history: byId("release-history"),
    publicLink: byId("public-release-link"),
  };
  let displayed = null;
  let busyOperation = null;
  let nextOperationId = 0;

  function setStatus(value) {
    elements.status.textContent = value;
  }

  function currentDraft() {
    const draft = getCloudDraft();
    return draft && UUID.test(draft.draftId) ? draft : null;
  }

  function activeOperation(draft = currentDraft()) {
    if (
      busyOperation &&
      (busyOperation.generation !== getGeneration() ||
        busyOperation.draftId !== draft?.draftId)
    )
      busyOperation = null;
    return busyOperation;
  }

  function beginOperation(generation, draftId) {
    const operation = { id: ++nextOperationId, generation, draftId };
    busyOperation = operation;
    return operation;
  }

  function endOperation(operation) {
    if (busyOperation?.id === operation.id) busyOperation = null;
    update();
  }

  function eligible() {
    const state = getState();
    const draft = currentDraft();
    return Boolean(
      draft &&
        state &&
        state === getSavedState() &&
        state.edited === false &&
        !getDraftBusy() &&
        allValid(state),
    );
  }

  function sameOperation(generation, draftId) {
    return generation === getGeneration() && currentDraft()?.draftId === draftId;
  }

  function resetDisplayForDraft(draftId) {
    if (displayed?.draftId !== draftId) {
      displayed = null;
      clear(elements.history);
      elements.publicLink.hidden = true;
      elements.publicLink.removeAttribute("href");
    }
  }

  function update() {
    const draft = currentDraft();
    resetDisplayForDraft(draft?.draftId);
    const busy = Boolean(activeOperation(draft));
    const mutationsAllowed = eligible();
    elements.publish.disabled = busy || !mutationsAllowed;
    elements.refresh.disabled = busy || !draft || getDraftBusy();
    elements.next.disabled =
      busy ||
      !draft ||
      getDraftBusy() ||
      displayed?.draftId !== draft.draftId ||
      !displayed?.cursor;
    for (const button of elements.history.querySelectorAll(
      "[data-release-rollback]",
    ))
      button.disabled =
        busy || !mutationsAllowed || !displayed?.headEtag || !draft;
    if (!draft) {
      elements.publish.disabled = true;
      elements.refresh.disabled = true;
      elements.next.disabled = true;
      return;
    }
    if (!eligible()) {
      setStatus(
        "发布前需保存当前未修改且全部合格的审核版本；重新审核后也必须再次保存。",
      );
    }
  }

  async function get(path) {
    const response = await fetch(path, {
      credentials: "same-origin",
      cache: "no-store",
    });
    const body = await readResponse(response);
    return { response, body };
  }

  function renderHistory(items, draftId, headEtag) {
    clear(elements.history);
    for (const item of items) {
      if (!item || !UUID.test(item.releaseId)) continue;
      const row = document.createElement("article");
      row.dataset.releaseId = item.releaseId;
      const label = document.createElement("p");
      label.textContent = `发布版本 ${item.releaseId}（草稿修订 ${item.draftRevisionId || "未知"}）`;
      const rollback = document.createElement("button");
      rollback.type = "button";
      rollback.textContent = "回滚到此版本";
      rollback.dataset.releaseRollback = "true";
      rollback.disabled =
        Boolean(activeOperation()) || !headEtag || !eligible();
      rollback.addEventListener("click", () => rollbackRelease(item.releaseId));
      row.append(label, rollback);
      elements.history.append(row);
    }
  }

  async function refresh() {
    const draft = currentDraft();
    if (!draft || getDraftBusy() || activeOperation(draft)) return;
    const generation = getGeneration();
    const draftId = draft.draftId;
    const operation = beginOperation(generation, draftId);
    update();
    setStatus("正在读取当前发布版本与历史…");
    try {
      const current = await get(`/api/admin/releases/${encodeURIComponent(draftId)}`);
      if (!sameOperation(generation, draftId)) return;
      if (current.response.status === 404) {
        displayed = {
          draftId,
          headEtag: null,
          releaseId: null,
          cursor: null,
          items: [],
        };
        clear(elements.history);
        elements.publicLink.hidden = true;
        elements.publicLink.removeAttribute("href");
        setStatus("此草稿尚未发布。发布只会公开合格题目 JSON，原文件和私有草稿不会公开。");
        return;
      }
      if (!current.response.ok || current.body?.ok !== true || !current.body.release)
        throw new Error(
          current.response.status === 401
            ? "管理员会话已失效，请重新登录。"
            : "无法读取当前发布版本。",
        );
      if (typeof current.body.etag !== "string" || !UUID.test(current.body.release.releaseId))
        throw new Error("当前发布版本响应无效。");
      const history = await get(`/api/admin/releases/${encodeURIComponent(draftId)}/history`);
      if (!sameOperation(generation, draftId)) return;
      if (!history.response.ok || history.body?.ok !== true || !Array.isArray(history.body.items))
        throw new Error("无法读取发布历史。");
      displayed = {
        draftId,
        headEtag: current.body.etag,
        releaseId: current.body.release.releaseId,
        cursor: history.body.truncated === true ? history.body.cursor : null,
        items: history.body.items,
      };
      elements.publicLink.href = new URL(
        `/api/published/${encodeURIComponent(draftId)}`,
        window.location.origin,
      ).href;
      elements.publicLink.hidden = false;
      elements.publicLink.textContent = "查看当前公开题目 JSON（不会自动上架到学习者目录）";
      renderHistory(displayed.items, draftId, displayed.headEtag);
      setStatus(
        `当前发布版本 ${displayed.releaseId}；已显示 ${history.body.items.length} 条历史${displayed.cursor ? "，可继续读取更多。" : "。"}`,
      );
    } catch (error) {
      if (sameOperation(generation, draftId))
        setStatus(`未读取发布状态：${error?.message || "请求失败。"}`);
    } finally {
      endOperation(operation);
    }
  }

  async function moreHistory() {
    const draft = currentDraft();
    if (
      !draft ||
      !displayed ||
      displayed.draftId !== draft.draftId ||
      !displayed.cursor ||
      getDraftBusy() ||
      activeOperation(draft)
    )
      return;
    const generation = getGeneration();
    const draftId = draft.draftId;
    const cursor = displayed.cursor;
    const operation = beginOperation(generation, draftId);
    update();
    setStatus("正在读取更多发布历史…");
    try {
      const history = await get(
        `/api/admin/releases/${encodeURIComponent(draftId)}/history?cursor=${encodeURIComponent(cursor)}`,
      );
      if (!sameOperation(generation, draftId) || displayed?.cursor !== cursor)
        return;
      if (!history.response.ok || history.body?.ok !== true || !Array.isArray(history.body.items))
        throw new Error("无法读取更多发布历史。");
      const existing = new Set(displayed.items.map((item) => item.releaseId));
      const appended = history.body.items.filter(
        (item) => item && !existing.has(item.releaseId),
      );
      displayed.items = [...displayed.items, ...appended];
      renderHistory(displayed.items, draftId, displayed.headEtag);
      displayed.cursor = history.body.truncated === true ? history.body.cursor : null;
      setStatus(
        `已继续读取 ${appended.length} 条历史${displayed.cursor ? "；仍可继续读取。" : "；已到历史末尾。"}`,
      );
    } catch (error) {
      if (sameOperation(generation, draftId))
        setStatus(`未读取更多历史：${error?.message || "请求失败。"}`);
    } finally {
      endOperation(operation);
    }
  }

  async function publish() {
    const draft = currentDraft();
    const state = getState();
    if (!draft || !state || !eligible() || activeOperation(draft)) return;
    const generation = getGeneration();
    const draftId = draft.draftId;
    const expectedHeadEtag =
      displayed?.draftId === draftId ? displayed.headEtag : null;
    const count = state.report.summary.valid;
    if (
      !window.confirm(
        `确认发布草稿 ${draftId} 的 ${count} 道合格题？这会使题目 JSON 可公开读取；原文件和私有草稿不会公开。`,
      )
    )
      return;
    const operation = beginOperation(generation, draftId);
    update();
    setStatus("正在发布当前已保存的审核版本…");
    try {
      const result = await mutation("/api/admin/releases/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          draftId,
          expectedDraftEtag: draft.etag,
          expectedHeadEtag,
          confirm: true,
        }),
      });
      if (!sameOperation(generation, draftId)) return;
      if (typeof result.etag !== "string" || !UUID.test(result.releaseId))
        throw new Error("发布服务响应无效。");
      displayed = {
        draftId,
        headEtag: result.etag,
        releaseId: result.releaseId,
        cursor: null,
        items: [],
      };
      elements.publicLink.href = new URL(
        `/api/published/${encodeURIComponent(draftId)}`,
        window.location.origin,
      ).href;
      elements.publicLink.hidden = false;
      elements.publicLink.textContent = "查看当前公开题目 JSON（不会自动上架到学习者目录）";
      setStatus(`已发布版本 ${result.releaseId}。请刷新发布历史以核对版本链。`);
    } catch (error) {
      if (sameOperation(generation, draftId)) {
        setStatus(
          error?.status === 409
            ? "发布冲突：请先刷新发布状态后确认，不会自动重试。"
            : `未发布：${error?.message || "请求失败。"}`,
        );
      }
    } finally {
      endOperation(operation);
    }
  }

  async function rollbackRelease(releaseId) {
    const draft = currentDraft();
    if (
      !draft ||
      !displayed ||
      displayed.draftId !== draft.draftId ||
      !eligible() ||
      getDraftBusy() ||
      activeOperation(draft)
    )
      return;
    const generation = getGeneration();
    const draftId = draft.draftId;
    const expectedHeadEtag = displayed.headEtag;
    if (
      !window.confirm(
        `确认将草稿 ${draftId} 的公开版本回滚到 ${releaseId}？系统会创建一个新的不可变发布版本；原文件和私有草稿不会公开。`,
      )
    )
      return;
    const operation = beginOperation(generation, draftId);
    update();
    setStatus("正在创建回滚发布版本…");
    try {
      const result = await mutation("/api/admin/releases/rollback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          draftId,
          releaseId,
          expectedHeadEtag,
          confirm: true,
        }),
      });
      if (!sameOperation(generation, draftId)) return;
      if (typeof result.etag !== "string" || !UUID.test(result.releaseId))
        throw new Error("回滚服务响应无效。");
      displayed = {
        draftId,
        headEtag: result.etag,
        releaseId: result.releaseId,
        cursor: null,
        items: [],
      };
      setStatus(`已创建回滚发布版本 ${result.releaseId}。请刷新历史核对版本链。`);
    } catch (error) {
      if (sameOperation(generation, draftId)) {
        setStatus(
          error?.status === 409
            ? "回滚冲突：请先刷新发布状态后确认，不会自动重试。"
            : `未回滚：${error?.message || "请求失败。"}`,
        );
      }
    } finally {
      endOperation(operation);
    }
  }

  elements.publish.addEventListener("click", publish);
  elements.refresh.addEventListener("click", refresh);
  elements.next.addEventListener("click", moreHistory);
  update();
  return { update, refresh };
}
