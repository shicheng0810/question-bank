import {
  parseMHTML,
  parseQuizArchive,
  describeUnparsableArchive,
} from "../lib/canvas-extract.js";
import {
  buildQuestionBank,
  buildUniqueMergedQuestionBankFromCollections,
  convertQuestionBankItemToParsed,
  validateQuestionBankRecords,
} from "../lib/testable-core.js";
import { buildReviewReport } from "../lib/content-review.js";
import { initReleaseUi } from "./release-ui.js";

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_QUESTIONS = 2000;
const $ = (id) => document.getElementById(id);
const elements = Object.freeze({
  file: $("source-file"),
  cancel: $("cancel"),
  fresh: $("new-import"),
  status: $("status"),
  summary: $("summary"),
  issues: $("issues"),
  preview: $("preview"),
  editor: $("json-editor"),
  recheck: $("recheck"),
  acknowledge: $("acknowledge"),
  download: $("download"),
  saveCloud: $("save-cloud"),
  listCloud: $("list-cloud"),
  nextCloud: $("next-cloud"),
  cloudStatus: $("cloud-status"),
  cloudList: $("cloud-list"),
});
let state = null;
let importGeneration = 0;
let jsonDraft = null;
let sourceFile = null;
let cloudDraft = null;
let cloudCursor = null;
let cloudGeneration = 0;
let cloudSaveBusy = false;
let cloudLoadBusy = false;
let cloudListBusy = false;
let savedState = null;
let releaseUi = null;

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}
function text(node, value) {
  node.textContent = String(value ?? "");
  return node;
}
function setStatus(message) {
  text(elements.status, message);
}
function setCloudStatus(message) {
  text(elements.cloudStatus, message);
}
function updateCloudControls() {
  elements.saveCloud.disabled =
    !state || state.edited || cloudSaveBusy || cloudLoadBusy;
  elements.listCloud.disabled = cloudListBusy;
  elements.nextCloud.disabled = cloudListBusy || !cloudCursor;
  releaseUi?.update();
}
function sourceId(name) {
  return (
    String(name || "browser-import")
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "browser-import"
  );
}
function setBusy(value) {
  elements.file.disabled = value;
  elements.cancel.disabled = !(value || state || jsonDraft);
  elements.saveCloud.disabled =
    value || !state || state.edited || cloudSaveBusy || cloudLoadBusy;
}
function reset(message = "等待导入。") {
  importGeneration += 1;
  cloudGeneration += 1;
  cloudSaveBusy = false;
  cloudLoadBusy = false;
  cloudListBusy = false;
  state = null;
  jsonDraft = null;
  sourceFile = null;
  cloudDraft = null;
  savedState = null;
  cloudCursor = null;
  elements.file.value = "";
  elements.editor.value = "";
  elements.editor.disabled = true;
  elements.recheck.disabled = true;
  elements.acknowledge.checked = false;
  elements.acknowledge.disabled = true;
  elements.download.disabled = true;
  clear(elements.summary);
  clear(elements.issues);
  clear(elements.preview);
  clear(elements.cloudList);
  setCloudStatus("尚未读取或保存云草稿。");
  setStatus(message);
  setBusy(false);
  updateCloudControls();
}
function invalidate(message) {
  state = null;
  elements.acknowledge.checked = false;
  elements.acknowledge.disabled = true;
  elements.download.disabled = true;
  clear(elements.summary);
  clear(elements.issues);
  clear(elements.preview);
  setStatus(message);
  setBusy(false);
  updateCloudControls();
}
function addMetric(label, value, className = "") {
  const item = document.createElement("div");
  item.className = `metric ${className}`;
  text(item, `${label}：${value}`);
  elements.summary.append(item);
}
function previewText(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return "此记录不是可预览的题目对象，已拒绝；请在 JSON 编辑器中修正后重新审核。";
  }
  const lines = [
    `题干：${record.qtext || "（空）"}`,
    `题型：${record.kind || "unknown"}`,
  ];
  if (Array.isArray(record.choices))
    record.choices.forEach((choice, index) =>
      lines.push(
        `${index + 1}. ${choice && typeof choice === "object" ? choice.text || "（空选项）" : "（畸形选项）"}${choice?.isCorrect === true ? "  [标记为正确]" : ""}`,
      ),
    );
  if (Array.isArray(record.blanks))
    lines.push(
      `可接受答案：${record.blanks.map((row) => (Array.isArray(row) ? row.join(" / ") : "（畸形答案）")).join("；") || "（未提供）"}`,
    );
  if (Array.isArray(record.pairs))
    record.pairs.forEach((pair) =>
      lines.push(
        `${pair && typeof pair === "object" ? pair.left || "" : "（畸形配对）"} → ${pair && typeof pair === "object" ? pair.right || "" : ""}`,
      ),
    );
  return lines.join("\n");
}
function render(report) {
  clear(elements.summary);
  clear(elements.issues);
  clear(elements.preview);
  addMetric("总题数", report.summary.total);
  addMetric("合格", report.summary.valid, "valid");
  addMetric("待审核", report.summary.review, "review");
  addMetric("拒绝", report.summary.rejected, "rejected");
  report.records.forEach((entry, index) => {
    const question = document.createElement("article");
    question.className = "question";
    const title = document.createElement("h3");
    text(title, `第 ${index + 1} 题 · ${entry.disposition}`);
    question.append(title);
    const body = document.createElement("pre");
    text(body, previewText(entry.record));
    question.append(body);
    elements.preview.append(question);
    if (entry.disposition !== "valid") {
      const issue = document.createElement("article");
      issue.className = `issue ${entry.disposition}`;
      text(
        issue,
        `第 ${index + 1} 题（${entry.disposition}）：${Array.isArray(entry.reasons) ? entry.reasons.join("、") : "需要人工确认"}`,
      );
      elements.issues.append(issue);
    }
  });
  if (!elements.issues.childElementCount)
    text(elements.issues, "没有待审核或拒绝项。");
}
function review(parsed, name, rawJson = null) {
  if (!Array.isArray(parsed) || parsed.length === 0)
    throw new Error("没有可审核的题目。");
  if (parsed.length > MAX_QUESTIONS)
    throw new Error(`题目数量超过 ${MAX_QUESTIONS} 题上限。`);
  const id = sourceId(name);
  const report = buildReviewReport(parsed, {
    sourceId: id,
    sourcePrefix: name,
    exportPrefix: id,
  });
  state = { name, id, parsed, report, rawJson, edited: false };
  if (rawJson !== null) jsonDraft = { name, previousRecords: rawJson };
  render(report);
  elements.cancel.disabled = false;
  elements.acknowledge.disabled = false;
  elements.editor.disabled = rawJson === null;
  elements.recheck.disabled = rawJson === null;
  if (rawJson !== null)
    elements.editor.value = JSON.stringify(rawJson, null, 2);
  setStatus(
    `已完成浏览器本地解析：${report.summary.total} 题。请先处理待审核/拒绝提示。`,
  );
  updateCloudControls();
}
function registeredIdentity(record) {
  if (!record || typeof record !== "object" || Array.isArray(record))
    return null;
  const keys = ["bankUid", "questionUid", "questionKey"];
  if (!keys.some((key) => Object.hasOwn(record, key))) return null;
  if (!keys.every((key) => typeof record[key] === "string"))
    throw new Error("注册题身份字段不完整，拒绝作为普通题继续编辑。");
  return keys.map((key) => record[key]).join("\u0000");
}
function preserveRegisteredIdentities(previous, next) {
  if (!previous) return;
  previous.forEach((record, index) => {
    const identity = registeredIdentity(record);
    if (identity !== null && registeredIdentity(next[index]) !== identity) {
      throw new Error(
        `第 ${index + 1} 题的注册身份已更改或无法恢复，编辑被拒绝。`,
      );
    }
  });
}
function parseJson(raw, name, previousRecords = null) {
  if (new TextEncoder().encode(raw).byteLength > MAX_BYTES) {
    throw new Error("JSON 编辑内容超过 10 MiB 上限。");
  }
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    throw new Error("JSON 格式无效，无法审核。");
  }
  const records = Array.isArray(input)
    ? input
    : Array.isArray(input?.questions)
      ? input.questions
      : null;
  if (!records) throw new Error("JSON 必须是题目数组，或包含 questions 数组。");
  if (records.length > MAX_QUESTIONS)
    throw new Error(`题目数量超过 ${MAX_QUESTIONS} 题上限。`);
  preserveRegisteredIdentities(previousRecords, records);
  const parsed = records.map((item, index) =>
    convertQuestionBankItemToParsed(item, index, {
      prefix: sourceId(name),
      sourcePrefix: name,
    }),
  );
  review(parsed, name, records);
}
function parseCanvas(raw, name) {
  const mhtml = parseMHTML(raw);
  const candidates = [];
  const seen = new Set();
  [
    mhtml.html,
    ...(Array.isArray(mhtml.htmlParts) ? mhtml.htmlParts : []),
  ].forEach((part) => {
    const value = String(part || "");
    if (value.trim() && !seen.has(value)) {
      seen.add(value);
      candidates.push(value);
    }
  });
  if (!candidates.length && raw.trim()) candidates.push(raw);
  const result = parseQuizArchive(candidates, mhtml.cidMap);
  if (!result.parsed.length)
    throw new Error(describeUnparsableArchive(candidates));
  review(result.parsed, name);
}
async function importFile(file) {
  if (!file) return;
  if (file.size > MAX_BYTES) {
    reset("文件超过 10 MiB 上限，未读取内容。");
    return;
  }
  // A new selection supersedes both any pending File.text() and a JSON draft.
  // The captured generation prevents a stale read from rendering later.
  const generation = ++importGeneration;
  cloudGeneration += 1;
  cloudSaveBusy = false;
  cloudLoadBusy = false;
  cloudListBusy = false;
  jsonDraft = null;
  sourceFile = file;
  cloudDraft = null;
  savedState = null;
  elements.editor.value = "";
  elements.editor.disabled = true;
  elements.recheck.disabled = true;
  invalidate("正在仅在浏览器内解析文件…");
  setBusy(true);
  setStatus("正在仅在浏览器内解析文件…");
  try {
    const raw = await file.text();
    if (generation !== importGeneration) return;
    if (/\.json$/i.test(file.name) || /^\s*[\[{]/.test(raw))
      parseJson(raw, file.name);
    else parseCanvas(raw, file.name);
  } catch (error) {
    if (generation === importGeneration) {
      reset(`导入失败：${error?.message || "无法解析文件"}`);
    }
  } finally {
    if (generation === importGeneration) {
      setBusy(false);
      elements.cancel.disabled = !state;
    }
  }
}
function recheckJson() {
  if (!jsonDraft) return;
  const { name, previousRecords } = jsonDraft;
  // A local recheck also supersedes a File.text() read which may still resolve.
  importGeneration += 1;
  cloudGeneration += 1;
  cloudSaveBusy = false;
  cloudLoadBusy = false;
  cloudListBusy = false;
  invalidate("正在重新审核 JSON…");
  try {
    parseJson(elements.editor.value, name, previousRecords);
  } catch (error) {
    jsonDraft = { name, previousRecords };
    elements.editor.disabled = false;
    elements.recheck.disabled = false;
    setStatus(
      `重新审核失败：${error?.message || "JSON 无效"}。旧候选已清除；可继续编辑后重试。`,
    );
  }
}
async function responseJson(response) {
  try {
    return await response.json();
  } catch {
    throw new Error("服务器返回了无效响应。");
  }
}
async function adminSession() {
  const response = await fetch("/api/admin/session", {
    credentials: "same-origin",
    cache: "no-store",
  });
  const body = await responseJson(response);
  if (!response.ok || body?.ok !== true || typeof body.csrf !== "string") {
    throw new Error(
      response.status === 401
        ? "管理员会话已失效，请重新登录。"
        : "管理员服务暂不可用。",
    );
  }
  return body.csrf;
}
async function mutation(path, init = {}) {
  const csrf = await adminSession();
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    cache: "no-store",
    headers: { ...init.headers, "x-qb-admin-csrf": csrf },
  });
  const body = await responseJson(response);
  if (!response.ok || body?.ok !== true) {
    const error = new Error(
      response.status === 409
        ? "云草稿已被其他窗口更新；请先重新读取后再保存。"
        : response.status === 401
          ? "管理员会话已失效，请重新登录。"
          : response.status === 413
            ? "内容超过云端限制。"
            : "云端保存未完成。",
    );
    error.status = response.status;
    throw error;
  }
  return body;
}
function cloudTitle(snapshot) {
  if (!snapshot || Array.from(snapshot.name).length > 120)
    throw new Error(
      "文件名超过云草稿标题的 120 字限制，请使用较短文件名重新导入。",
    );
  return snapshot.name;
}
function frozenDraftQuestions(snapshot) {
  if (!snapshot) throw new Error("请先完成本地解析与审核。");
  try {
    return JSON.parse(JSON.stringify(snapshot.rawJson ?? snapshot.parsed));
  } catch {
    throw new Error("当前候选无法安全保存为云草稿。");
  }
}
function uploadFilename(file) {
  return (
    String(file?.name || "upload.bin")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120) || "upload.bin"
  );
}
function isParsedDraft(records) {
  return (
    Array.isArray(records) &&
    records.every(
      (record) =>
        record &&
        typeof record === "object" &&
        !Array.isArray(record) &&
        typeof record.qtext === "string" &&
        typeof record.kind === "string",
    )
  );
}
function currentCloudOperation(operation, snapshot) {
  return operation === cloudGeneration && state === snapshot;
}
async function saveCloud() {
  if (!state || state.edited || cloudSaveBusy) return;
  const operation = cloudGeneration;
  const snapshot = state;
  const previousDraft = cloudDraft && { ...cloudDraft };
  const file = sourceFile;
  let questions;
  let title;
  try {
    title = cloudTitle(snapshot);
    questions = frozenDraftQuestions(snapshot);
  } catch (error) {
    setCloudStatus(`未保存：${error?.message || "当前候选不可保存。"}`);
    return;
  }
  cloudSaveBusy = true;
  updateCloudControls();
  try {
    let sourceId = previousDraft?.sourceId ?? null;
    if (!sourceId) {
      if (!file)
        throw new Error("当前没有可上传的原文件；请重新导入后再保存。");
      setCloudStatus("正在上传当前内存中的原文件…");
      const source = await mutation("/api/admin/content/sources", {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-qb-source-filename": uploadFilename(file),
        },
        body: file,
      });
      sourceId = source.sourceId;
    }
    if (!currentCloudOperation(operation, snapshot)) return;
    setCloudStatus("正在保存私有云草稿…");
    const base = { title, sourceId, questions };
    const saved = await mutation("/api/admin/content/drafts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        previousDraft
          ? {
              draftId: previousDraft.draftId,
              expectedEtag: previousDraft.etag,
              ...base,
            }
          : base,
      ),
    });
    if (!currentCloudOperation(operation, snapshot)) return;
    cloudDraft = {
      draftId: saved.draftId,
      revisionId: saved.revisionId,
      etag: saved.etag,
      sourceId,
    };
    savedState = snapshot;
    setCloudStatus(
      `已保存私有草稿 ${saved.draftId}，修订 ${saved.revisionId}。未发布。`,
    );
  } catch (error) {
    if (currentCloudOperation(operation, snapshot))
      setCloudStatus(`未保存：${error?.message || "云端请求失败。"}`);
  } finally {
    if (operation === cloudGeneration) {
      cloudSaveBusy = false;
      updateCloudControls();
    }
  }
}
function appendCloudDraft(item) {
  if (!item || typeof item.draftId !== "string") return;
  const button = document.createElement("button");
  button.type = "button";
  text(button, `读取草稿 ${item.draftId}`);
  button.addEventListener("click", () => loadCloudDraft(item.draftId));
  elements.cloudList.append(button);
}
async function listCloud(next = false) {
  if (next && !cloudCursor) return;
  const operation = cloudGeneration;
  const cursor = next ? cloudCursor : null;
  cloudListBusy = true;
  updateCloudControls();
  try {
    if (!next) {
      cloudCursor = null;
      clear(elements.cloudList);
    }
    const query = next ? `?cursor=${encodeURIComponent(cursor)}` : "";
    const response = await fetch(`/api/admin/content/drafts${query}`, {
      credentials: "same-origin",
      cache: "no-store",
    });
    const body = await responseJson(response);
    if (!response.ok || body?.ok !== true || !Array.isArray(body.items))
      throw new Error(
        response.status === 401
          ? "管理员会话已失效，请重新登录。"
          : "无法读取云草稿列表。",
      );
    if (operation !== cloudGeneration) return;
    body.items.forEach(appendCloudDraft);
    cloudCursor =
      body.truncated === true && typeof body.cursor === "string"
        ? body.cursor
        : null;
    setCloudStatus(
      `已读取 ${body.items.length} 个草稿${cloudCursor ? "；可继续读取下一页。" : "。"}`,
    );
  } catch (error) {
    if (operation === cloudGeneration)
      setCloudStatus(`未读取：${error?.message || "云端请求失败。"}`);
  } finally {
    if (operation === cloudGeneration) {
      cloudListBusy = false;
      updateCloudControls();
    }
  }
}
async function loadCloudDraft(draftId) {
  if (typeof draftId !== "string") return;
  const operation = ++cloudGeneration;
  importGeneration += 1;
  cloudSaveBusy = false;
  cloudLoadBusy = true;
  cloudListBusy = false;
  updateCloudControls();
  setCloudStatus("正在读取并重新审核云草稿…");
  try {
    const response = await fetch(
      `/api/admin/content/drafts/${encodeURIComponent(draftId)}`,
      {
        credentials: "same-origin",
        cache: "no-store",
      },
    );
    const body = await responseJson(response);
    if (operation !== cloudGeneration) return;
    if (
      !response.ok ||
      body?.ok !== true ||
      !body.draft ||
      !Array.isArray(body.draft.questions)
    )
      throw new Error(
        response.status === 401
          ? "管理员会话已失效，请重新登录。"
          : "云草稿内容无效或不可用。",
      );
    const name = body.draft.title;
    const records = body.draft.questions;
    const raw = JSON.stringify(records, null, 2);
    if (new TextEncoder().encode(raw).byteLength > MAX_BYTES)
      throw new Error("云草稿超过浏览器审核上限。");
    sourceFile = null;
    elements.file.value = "";
    cloudDraft = {
      draftId: body.draftId,
      revisionId: body.revisionId,
      etag: body.etag,
      sourceId: body.draft.sourceId,
    };
    jsonDraft = null;
    elements.editor.value = "";
    elements.editor.disabled = true;
    elements.recheck.disabled = true;
    invalidate("正在重新审核已加载的云草稿…");
    try {
      if (isParsedDraft(records)) review(records, name);
      else parseJson(raw, name, records);
      savedState = state;
      setCloudStatus(
        `已读取草稿 ${body.draftId} 并重新审核；修改后需显式保存。`,
      );
    } catch (error) {
      jsonDraft = { name, previousRecords: records };
      elements.editor.disabled = false;
      elements.recheck.disabled = false;
      setStatus(
        `云草稿未通过浏览器审核：${error?.message || "请编辑后重试。"}`,
      );
      setCloudStatus(
        `已读取草稿 ${body.draftId}；旧候选未载入，可编辑 JSON 后重新审核。`,
      );
    }
  } catch (error) {
    if (operation === cloudGeneration)
      setCloudStatus(`未读取草稿：${error?.message || "云端请求失败。"}`);
  } finally {
    if (operation === cloudGeneration) {
      cloudLoadBusy = false;
      updateCloudControls();
    }
  }
}
function download() {
  if (!state || state.edited || !elements.acknowledge.checked) return;
  try {
    const accepted = state.report.records
      .filter((entry) => entry.disposition === "valid")
      .map((entry) => state.parsed[entry.index]);
    const projected = buildQuestionBank(accepted, state.id, state.name);
    const checked = validateQuestionBankRecords(projected);
    if (checked.rejected.length)
      throw new Error("合格项在导出校验中失败；请回到审核列表处理。");
    const unique = buildUniqueMergedQuestionBankFromCollections([
      checked.valid,
    ]);
    const blob = new Blob([JSON.stringify(unique, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${state.id}-qualified.json`;
    link.click();
    URL.revokeObjectURL(url);
    setStatus(
      `已下载 ${unique.length} 道合格题；待审核 ${state.report.summary.review}、拒绝 ${state.report.summary.rejected} 未包含。`,
    );
  } catch (error) {
    setStatus(`下载前校验失败：${error?.message || "无法生成题库"}`);
  }
}
elements.file.addEventListener("change", () =>
  importFile(elements.file.files?.[0]),
);
elements.cancel.addEventListener("click", () =>
  reset("已取消并清空当前导入。"),
);
elements.fresh.addEventListener("click", () => reset("请选择新的文件导入。"));
elements.recheck.addEventListener("click", recheckJson);
elements.acknowledge.addEventListener("change", () => {
  elements.download.disabled =
    !state || state.edited || !elements.acknowledge.checked;
});
elements.editor.addEventListener("input", () => {
  if (jsonDraft) {
    cloudGeneration += 1;
    cloudSaveBusy = false;
    cloudLoadBusy = false;
    cloudListBusy = false;
    if (state) state.edited = true;
    elements.download.disabled = true;
    if (
      new TextEncoder().encode(elements.editor.value).byteLength > MAX_BYTES
    ) {
      elements.recheck.disabled = true;
      setStatus("JSON 编辑内容超过 10 MiB 上限；请缩小后再审核。");
    } else {
      elements.recheck.disabled = false;
      setStatus("JSON 已修改；请重新审核后才可下载。");
    }
    updateCloudControls();
  }
});
elements.saveCloud.addEventListener("click", saveCloud);
elements.listCloud.addEventListener("click", () => listCloud(false));
elements.nextCloud.addEventListener("click", () => listCloud(true));
elements.download.addEventListener("click", download);
releaseUi = initReleaseUi({
  getState: () => state,
  getSavedState: () => savedState,
  getCloudDraft: () => cloudDraft,
  getDraftBusy: () => cloudSaveBusy || cloudLoadBusy,
  getGeneration: () => cloudGeneration,
  mutation,
});
reset();
