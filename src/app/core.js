import {captureDeletionScope} from '../server/confirmed-deletion-scope.js';
import { mountLocalNativeLifecycle } from './local-native-lifecycle-ui.js';
import { mountPublicationEvidence, publicationEvidenceSummary } from './publication-evidence-ui.js';
import { mountNativeManager, confirmAccountRemoval } from './native-manager-ui.js';
import { initAiMCQFeature } from './features/ai-mcq.js';
import { userAdminSummary } from './user-admin-summary.js';
import { slugifyBankId } from '../lib/site-package.js';
import {
  buildPublishMeta as buildPublishMetaHelper,
  canGenerateQuestionBank as canGenerateQuestionBankHelper,
  getPublishButtonState as getPublishButtonStateHelper,
  guessPublishDefaults as guessPublishDefaultsHelper,
} from '../lib/publish-settings.js';
import { buildLegacyQuestionBankHtml } from '../services/site-package-export.js';
import { shouldUseSelectedAnswersAsCorrectFallback } from '../lib/canvas-answer-fallback.js';
import { finalizeRegisteredQuestions } from '../domain/question/registered-identity.js';
import { buildReviewReport } from '../lib/content-review.js';
// 候选选择 + 引擎选择（经典测验 / New Quizzes）都收在 parseQuizArchive 里，
// 所以这里不再直接用 rewriteSources / parseCanvasHTML。
import { parseMHTML, extractCourseFromHTML, parseQuizArchive, describeUnparsableArchive } from '../lib/canvas-extract.js';
import {
  applyAiAnswerSuggestion,
  buildDeepSeekAnswerFillPayload,
  callDeepSeekAnswerFill,
  parseDeepSeekAnswerFillResponse,
  questionCanUseAiAnswer,
} from './features/ai-answer-fill-logic.js';

// Shared, unit-tested core (single source of truth — see src/lib/testable-core.js).
// These were previously duplicated inline below; consolidated here to avoid drift.
import {
  tryParseJSONArray, extractBracketedJSONArray, extractQuestionBankArrayFromText,
  makeSafeJSONForScript, injectQuestionBankJSON, downloadTextAsFile, safeJSONStringForScript,
  countCorrectChoiceAnswers, normalizeChoiceQuestionShape, uniqueNonEmptyStrings,
  getQuestionImages, getMatchingChoicePool, buildMatchingSubQuestionText, buildMatchingChoicesForPair,
  buildQuestionBank, flattenSourceList, normalizeTextForMerge, hashStringForMerge,
  normalizeImageFingerprints, getAnswerSignature, applyAnswerSignature, mergeAnswerSignature,
  makeUniqueQuestionKey, mergeUniqueQuestionRecord, guessMetaFromFilename, guessMetaFromTitle,
  isGenericQuizResultsTitle,
  validateQuestionBankRecords,
  extractIdPrefix, extractIdSuffix, extractSourcePrefix, extractSourceNum,
  normalizeImportedImageList, convertQuestionBankItemToParsed,
  parseHeaders, base64ToBytes, bytesToBase64, qpToBytes, strToBytes, bytesToUTF8,
  parseFillInputToAnswers, cleanHTML, cleanHTMLString,
  buildUniqueMergedQuestionBankFromCollections,
} from '../lib/testable-core.js';

export let appContext = null;

// Registered records keep their source identity in testable-core's private carrier.
// This marker is only for the UI guard and checkbox policy; it is never exported.
const registeredParsedQuestions = new WeakSet();
function hasRegisteredIdentity(value){
  return !!(value && typeof value === 'object' && (
    Object.prototype.hasOwnProperty.call(value, 'bankUid') ||
    Object.prototype.hasOwnProperty.call(value, 'questionUid') ||
    Object.prototype.hasOwnProperty.call(value, 'questionKey')
  ));
}

export function init() {
mountLocalNativeLifecycle({ container: document.getElementById("app") || document.body });
const $  = s => document.querySelector(s);
// D2 is an explicit candidate only. Capture the gate once so a late global
// mutation cannot change the editor semantics halfway through a session.
const reviewEditorEnabled = globalThis.QB_REVIEW_EDITOR_V1 === true;
const fileInput = $('#file');
const qbankFileInput = $('#qbankFile');
const extractQBankBtn = $('#extractQBankBtn');
const parseAllBtn = $('#parseAllBtn');
const parseActiveBtn = $('#parseActiveBtn');
const statusEl = $('#status');
const qbankStatusEl = $('#qbankStatus');
const fileTableBody = $('#fileTable tbody');

const list = $('#list');
const out = $('#out');
let uiGeneration = 0;
let exportBusy = false;
let exportTransactionId = 0;
let writingOutput = false;
let reviewExportConfirmEl = null;
function invalidateUiGeneration(){
  uiGeneration += 1;
  if (reviewExportConfirmEl) reviewExportConfirmEl.checked = false;
}
function setOutputValue(value, filename){
  if (filename !== undefined) outDownloadName = filename;
  writingOutput = true;
  try{
    out.value = value;
    out.dispatchEvent(new Event('input'));
  }finally{
    writingOutput = false;
  }
}
out && out.addEventListener('input', () => {
  if (!writingOutput) invalidateUiGeneration();
  try{ updateExportButtons(); }catch(e){}
  try{ updateDownloadOutBtn(); }catch(e){}
});

let outDownloadName = "question_bank.json";
function updateDownloadOutBtn(){
  if(!downloadOutJsonBtn) return;
  const raw = (out && out.value ? String(out.value) : "").trim();
  if(!raw){ downloadOutJsonBtn.disabled = true; return; }
  try{ JSON.parse(raw); downloadOutJsonBtn.disabled = false; }
  catch(e){ downloadOutJsonBtn.disabled = true; }
}
function downloadTextFile(filename, text, mime){
  const blob = new Blob([text], { type: mime || "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || "output.json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1200);
}
function downloadOutAsJSON(){
  const raw = (out && out.value ? String(out.value) : "").trim();
  if(!raw){ alert("输出框为空，无法下载。"); return; }
  try{ JSON.parse(raw); }
  catch(e){ alert("输出框内容不是有效 JSON，无法下载。\n\n请先点击“导出…JSON”或修正输出内容。"); return; }
  downloadTextFile(outDownloadName || "question_bank.json", raw, "application/json;charset=utf-8");
}
const exportActiveBtn = $('#exportActiveBtn');
const exportAllBtn = $('#exportAllBtn');
const exportUniqueBtn = $('#exportUniqueBtn');
const genLegacyQBankBtn = $('#genLegacyQBankBtn');
const publishSiteBtn = $('#publishSiteBtn');
const publishTargetSel = $('#publishTargetSel');
const publishSiteStatusEl = $('#publishSiteStatus');
let publishBridgeAvailable = false; // dev server 本地发布接口是否可用（build/preview 模式下没有）
let publishInFlight = false;
const siteBanksListEl = $('#siteBanksList');
const siteBanksHintEl = $('#siteBanksHint');
const siteBanksOpStatusEl = $('#siteBanksOpStatus');
const siteBanksRefreshBtn = $('#siteBanksRefreshBtn');
const siteDeployTargetSel = $('#siteDeployTargetSel');
const siteDeployBtn = $('#siteDeployBtn');
const usersPanelEl = $('#usersPanel');
const usersListEl = $('#usersList');
const usersHintEl = $('#usersHint');
const usersOpStatusEl = $('#usersOpStatus');
const usersRefreshBtn = $('#usersRefreshBtn');
const usersDelCodeEl = $('#usersDelCode');
const usersDelByCodeBtn = $('#usersDelByCodeBtn');
const usersSelectAllEl = $('#usersSelectAll');
const usersDeleteSelectedBtn = $('#usersDeleteSelectedBtn');
const specialBanksPanelEl = $('#specialBanksPanel');
const specialBanksListEl = $('#specialBanksList');
const specialBanksHintEl = $('#specialBanksHint');
const specialBanksOpStatusEl = $('#specialBanksOpStatus');
const specialBanksRefreshBtn = $('#specialBanksRefreshBtn');
const specialBankFileEl = $('#specialBankFile');
const specialBankTitleEl = $('#specialBankTitle');
const specialBankCodeEl = $('#specialBankCode');
const specialBankCreateBtn = $('#specialBankCreateBtn');
let lastSiteManifest = [];
const downloadOutJsonBtn = $('#downloadOutJsonBtn');
const publishBankIdEl = $('#publishBankId');
const publishTitleEl = $('#publishTitle');
const publishModeEl = $('#publishMode');
const publishDescriptionEl = $('#publishDescription');
const publishTagsEl = $('#publishTags');
const publishCoverEl = $('#publishCover');
const publishPasswordEl = $('#publishPassword');
const publishPasswordHintEl = $('#publishPasswordHint');
const includeLegacyHtmlEl = $('#includeLegacyHtml');
const manifestFileEl = $('#manifestFile');
// AI MCQ controls
const apiKeyEl = $('#apiKey');
const apiBaseUrlEl = $('#apiBaseUrl');
const apiModelEl = $('#apiModel');
const nDistractorsEl = $('#nDistractors');
const temperatureEl = $('#temperature');
const replaceFillEl = $('#replaceFill');
const keepFillCopyEl = $('#keepFillCopy');
const runAiMCQEl = $('#runAiMCQ');
const dryRunAiMCQEl = $('#dryRunAiMCQ');
const aiStatusEl = $('#aiStatus');
const aiAnswerCurrentBtn = $('#aiAnswerCurrentBtn');
const aiAnswerMissingBtn = $('#aiAnswerMissingBtn');
const aiAnswerStatusEl = $('#aiAnswerStatus');
const ocrAiApiKeyEl = $('#ocrAiApiKey');
const ocrAiBaseUrlEl = $('#ocrAiBaseUrl');
const ocrAiModelEl = $('#ocrAiModel');
const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com/chat/completions';
const DEFAULT_DEEPSEEK_MODEL = 'deepseek-v4-flash';

initAiMCQFeature({
  apiKeyEl,
  apiBaseUrlEl,
  apiModelEl,
  nDistractorsEl,
  temperatureEl,
  replaceFillEl,
  keepFillCopyEl,
  runAiMCQEl,
  dryRunAiMCQEl,
  aiStatusEl,
  out,
  getExportArrayOrNull,
  updateExportButtons,
});

const btnSelectAll = $('#selectAll');
const btnClearAll = $('#clearAll');
const activeNameEl = $('#activeName');
const editModeToggle = $('#editModeToggle');
const reviewEditorPanelEl = $('#reviewEditorPanel');
const reviewSummaryEl = $('#reviewSummary');
const reviewSummaryNoteEl = $('#reviewSummaryNote');
const reviewFilterEl = $('#reviewFilter');
const reviewSelectionCountEl = $('#reviewSelectionCount');
const reviewUndoBtn = $('#reviewUndoBtn');
const reviewUndoHintEl = $('#reviewUndoHint');
const reviewExportPreviewBtn = $('#reviewExportPreviewBtn');
reviewExportConfirmEl = $('#reviewExportConfirm');
const reviewExportPreviewTextEl = $('#reviewExportPreviewText');
const reviewStateByDataset = new WeakMap();
let reviewEditingKey = '';
let editMode = false;
if (editModeToggle) {
  editModeToggle.addEventListener('change', () => {
    invalidateUiGeneration();
    editMode = !!editModeToggle.checked;
    renderFileTable();
    const active = datasets[activeIdx];
    if (active && active.parsedReady) renderQuestions(active);
  });
}
if (reviewEditorPanelEl) reviewEditorPanelEl.hidden = !reviewEditorEnabled;
if (reviewFilterEl) {
  reviewFilterEl.addEventListener('change', () => {
    if (!reviewEditorEnabled) return;
    invalidateUiGeneration();
    renderReviewPanel(datasets[activeIdx]);
    if (datasets[activeIdx] && datasets[activeIdx].parsedReady) renderQuestions(datasets[activeIdx]);
  });
}
if (reviewExportConfirmEl) {
  reviewExportConfirmEl.addEventListener('change', () => {
    if (!reviewEditorEnabled) return;
    if (reviewExportPreviewTextEl && !reviewExportConfirmEl.checked) reviewExportPreviewTextEl.dataset.confirmed = 'false';
  });
}
if (reviewExportPreviewBtn) {
  reviewExportPreviewBtn.addEventListener('click', () => {
    if (!reviewEditorEnabled) return;
    const d = datasets[activeIdx];
    renderReviewExportPreview(d, true);
  });
}
if (reviewUndoBtn) {
  reviewUndoBtn.addEventListener('click', () => {
    if (!reviewEditorEnabled) return;
    const d = datasets[activeIdx];
    if (reviewUndo(d)) {
      renderQuestions(d);
      renderFileTable();
      setDatasetStatusMessage(d);
      updateExportButtons();
    }
  });
}
if (reviewEditorPanelEl) {
  reviewEditorPanelEl.addEventListener('click', (event) => {
    if (!reviewEditorEnabled) return;
    const button = event.target.closest('button[data-review-batch]');
    if (!button) return;
    const d = datasets[activeIdx];
    if (!d || !d.parsedReady) return;
    const state = getReviewState(d);
    const selected = Array.from(state.selected).filter(q => d.parsed.includes(q));
    const action = String(button.dataset.reviewBatch || '');
    if (!selected.length) {
      setTopStatus('批量审核前请先选择题目。', true);
      return;
    }
    const label = reviewDecisionLabel(action);
    if (!confirm(`批量审核预览：将对已选 ${selected.length} 题执行“${label}”。\n结构缺失与不可导出原因不会被掩盖。\n继续？`)) return;
    pushReviewUndo(d);
    selected.forEach(q => state.decisions.set(q, action));
    invalidateUiGeneration();
    renderReviewPanel(d);
    renderQuestions(d);
    updateExportButtons();
  });
}
const PUBLISH_SETTINGS_KEY = 'question_bank_publish_settings_v2';

[ocrAiApiKeyEl, ocrAiBaseUrlEl, ocrAiModelEl].forEach((el) => {
  if (!el) return;
  el.addEventListener('input', () => updateAiAnswerButtons());
  el.addEventListener('change', () => updateAiAnswerButtons());
});

if (aiAnswerCurrentBtn) {
  aiAnswerCurrentBtn.addEventListener('click', () => {
    void runAiAnswerForCurrentMissingQuestion();
  });
}

if (aiAnswerMissingBtn) {
  aiAnswerMissingBtn.addEventListener('click', () => {
    void runAiAnswerForActiveDataset();
  });
}

initPublishSettings();

function initPublishSettings(){
  try{
    let saved = {};
    const parsed = JSON.parse(localStorage.getItem(PUBLISH_SETTINGS_KEY) || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.getPrototypeOf(parsed) === Object.prototype){
      saved = parsed;
    }
    if (publishBankIdEl && saved.bankId) publishBankIdEl.value = String(saved.bankId);
    if (publishTitleEl && saved.title) publishTitleEl.value = String(saved.title);
    if (publishModeEl && (saved.mode === 'protected' || saved.mode === 'public')) publishModeEl.value = saved.mode;
    if (publishDescriptionEl && saved.description) publishDescriptionEl.value = String(saved.description);
    if (publishTagsEl && saved.tags) publishTagsEl.value = String(saved.tags);
    if (publishCoverEl && saved.cover) publishCoverEl.value = String(saved.cover);
    if (publishPasswordHintEl && saved.passwordHint) publishPasswordHintEl.value = String(saved.passwordHint);
    if (includeLegacyHtmlEl) includeLegacyHtmlEl.checked = !!saved.includeLegacyHtml;
  }catch(_e){}

  [
    publishBankIdEl,
    publishTitleEl,
    publishModeEl,
    publishDescriptionEl,
    publishTagsEl,
    publishCoverEl,
    publishPasswordHintEl,
    includeLegacyHtmlEl,
  ].forEach((el) => {
    if (!el) return;
    el.addEventListener('input', () => {
      savePublishSettings();
      syncPublishModeUI();
      updateExportButtons();
    });
    el.addEventListener('change', () => {
      savePublishSettings();
      syncPublishModeUI();
      updateExportButtons();
    });
  });

  if (publishPasswordEl){
    publishPasswordEl.addEventListener('input', () => {
      updateExportButtons();
    });
  }

  syncPublishModeUI();
}

function syncPublishModeUI(){
  const protectedMode = !!(publishModeEl && publishModeEl.value === 'protected');
  if (publishPasswordEl) publishPasswordEl.disabled = !protectedMode;
  if (publishPasswordHintEl) publishPasswordHintEl.disabled = !protectedMode;
}

function savePublishSettings(){
  try{
    localStorage.setItem(PUBLISH_SETTINGS_KEY, JSON.stringify({
      bankId: publishBankIdEl && publishBankIdEl.value ? publishBankIdEl.value.trim() : '',
      title: publishTitleEl && publishTitleEl.value ? publishTitleEl.value.trim() : '',
      mode: publishModeEl && publishModeEl.value ? publishModeEl.value : 'public',
      description: publishDescriptionEl && publishDescriptionEl.value ? publishDescriptionEl.value.trim() : '',
      tags: publishTagsEl && publishTagsEl.value ? publishTagsEl.value.trim() : '',
      cover: publishCoverEl && publishCoverEl.value ? publishCoverEl.value.trim() : '',
      passwordHint: publishPasswordHintEl && publishPasswordHintEl.value ? publishPasswordHintEl.value.trim() : '',
      includeLegacyHtml: !!(includeLegacyHtmlEl && includeLegacyHtmlEl.checked),
    }));
  }catch(_e){}
}

// datasets: [{origin:'mhtml'|'qbank', file, name, prefix, sourcePrefix, parsed:[], parsedReady:boolean, parsing:boolean, err?:string}]
let datasets = [];
let activeIdx = -1;

function datasetKey(d){
  return `${(d && d.origin) || 'mhtml'}::${(d && d.name) || ''}`;
}

function upsertDatasets(entries, opts = {}){
  invalidateUiGeneration();
  const items = Array.isArray(entries) ? entries.filter(Boolean) : [];
  if (!items.length) return;

  const currentKey = activeIdx >= 0 && datasets[activeIdx] ? datasetKey(datasets[activeIdx]) : '';
  const touchedKeys = [];
  const indexMap = new Map(datasets.map((d, i) => [datasetKey(d), i]));

  items.forEach(item => {
    const key = datasetKey(item);
    touchedKeys.push(key);
    if (indexMap.has(key)) {
      datasets[indexMap.get(key)] = item;
    } else {
      datasets.push(item);
      indexMap.set(key, datasets.length - 1);
    }
  });

  const preferredKey = opts.keepActive ? currentKey : (touchedKeys[0] || currentKey);
  const nextIdx = preferredKey ? datasets.findIndex(d => datasetKey(d) === preferredKey) : -1;
  activeIdx = nextIdx >= 0 ? nextIdx : (datasets.length ? 0 : -1);
}

function makeMHTMLDataset(file){
  const guess = guessMetaFromFilename(file.name);
  return {
    origin: 'mhtml',
    file,
    name: file.name,
    prefix: guess.prefix,
    sourcePrefix: guess.sourcePrefix,
    parsed: [],
    parsedReady: false,
    parsing: false,
    err: ''
  };
}

function mostCommonNonEmpty(arr){
  const freq = new Map();
  (arr || []).forEach(v => {
    const key = String(v || '').trim();
    if (!key) return;
    freq.set(key, (freq.get(key) || 0) + 1);
  });
  let best = '';
  let bestCount = 0;
  freq.forEach((count, key) => {
    if (count > bestCount){
      best = key;
      bestCount = count;
    }
  });
  return best;
}






function guessQBankMeta(arr, fallbackName){
  const guess = guessMetaFromFilename(fallbackName || '');
  const prefix = mostCommonNonEmpty((arr || []).map(x => extractIdPrefix(x && x.id))) || guess.prefix;
  const sourcePrefix = mostCommonNonEmpty((arr || []).map(x => extractSourcePrefix(x && x.source))) || guess.sourcePrefix;
  return { prefix, sourcePrefix };
}


function makeQBankDataset(file, arr){
  const meta = guessQBankMeta(arr, file && file.name);
  const parsed = (arr || []).map((item, idx) => {
    const question = convertQuestionBankItemToParsed(item, idx, meta);
    if (hasRegisteredIdentity(item)) registeredParsedQuestions.add(question);
    return question;
  });
  return {
    origin: 'qbank',
    file,
    name: file && file.name ? file.name : 'imported_question_bank.json',
    prefix: meta.prefix,
    sourcePrefix: meta.sourcePrefix,
    parsed,
    parsedReady: true,
    parsing: false,
    err: ''
  };
}

fileInput.addEventListener('change', () => {
  invalidateUiGeneration();
  const files = Array.from(fileInput.files || []);
  const items = files.map(makeMHTMLDataset);
  upsertDatasets(items, { keepActive: false });
  renderFileTable();
  updateActiveUI();
  parseAllBtn.disabled = datasets.length === 0;
  parseActiveBtn.disabled = datasets.length === 0;
  setTopStatus(files.length ? `已加入 ${files.length} 个 MHTML 文件` : '', false);
});

qbankFileInput && qbankFileInput.addEventListener('change', () => {
  const files = Array.from(qbankFileInput.files || []);
  extractQBankBtn.disabled = files.length === 0;
  if (qbankStatusEl) qbankStatusEl.textContent = files.length ? `已选择 ${files.length} 个题库文件` : '';
});

extractQBankBtn && extractQBankBtn.addEventListener('click', async () => {
  invalidateUiGeneration();
  const files = Array.from((qbankFileInput && qbankFileInput.files) || []);
  if (!files.length) return;
  extractQBankBtn.disabled = true;
  if (qbankStatusEl) qbankStatusEl.textContent = '提取中…';
  try{
    const imported = [];
    const detail = [];
    let total = 0;
    let skippedEmpty = 0;
    for (const f of files){
      let arr;
      try{
        const raw = await f.text();
        arr = extractQuestionBankArrayFromText(raw);
      }catch(error){
        const message = error && error.message ? String(error.message) : String(error);
        throw new Error(`${f && f.name ? f.name : '未命名文件'}: ${message}`);
      }
      if (!arr.length){
        skippedEmpty += 1;
        detail.push(`${f.name}: 0 题（跳过空文件）`);
        continue;
      }
      imported.push(makeQBankDataset(f, arr));
      total += arr.length;
      detail.push(`${f.name}: ${arr.length} 题`);
    }
    if (!imported.length){
      if (qbankStatusEl) qbankStatusEl.textContent = '未导入：所选文件均无题目';
      setTopStatus('未导入题目：所选文件均无题目', false);
      console.log('Skipped empty question banks:', detail.join(' | '));
      return;
    }
    upsertDatasets(imported, { keepActive: false });
    renderFileTable();
    updateActiveUI();
    parseAllBtn.disabled = datasets.length === 0;
    parseActiveBtn.disabled = datasets.length === 0;
    const skippedText = skippedEmpty ? `，跳过 ${skippedEmpty} 个空文件` : '';
    if (qbankStatusEl) qbankStatusEl.textContent = `提取完成：导入 ${imported.length} 个文件，共 ${total} 题${skippedText}，已加入文件列表`;
    setTopStatus(`已从已生成题库加入 ${total} 题到文件列表${skippedText}`, false);
    console.log('Imported question banks:', detail.join(' | '));
  }catch(e){
    console.error(e);
    if (qbankStatusEl) qbankStatusEl.textContent = '提取失败';
    alert('提取已生成题库失败：' + (e && e.message ? e.message : String(e)));
  }finally{
    extractQBankBtn.disabled = ((qbankFileInput && qbankFileInput.files && qbankFileInput.files.length) || 0) === 0;
  }
});

parseAllBtn.addEventListener('click', async () => {
  if (!datasets.length) return;
  setTopStatus('批量解析中…', false);
  // 顺序解析，避免浏览器卡死
  for (let i=0;i<datasets.length;i++){
    await parseOne(i);
  }

  const autoImportSummary = { files: 0, questions: 0, attempted: 0, imported: 0, failed: 0, errors: [] };
  const datasetsNeedAutoImport = datasets.filter(d => d && d.parsedReady && countImageUploadNeeded(d.parsed) > 0);
  if (datasetsNeedAutoImport.length){
    let fileNo = 0;
    for (const d of datasetsNeedAutoImport){
      fileNo += 1;
      setTopStatus(`解析完成，正在自动补图（${fileNo}/${datasetsNeedAutoImport.length}）：${d.name}`, false);
      const res = await autoImportMissingImagesForDataset(d, {
        onQuestionStart({ index, total }){
          setTopStatus(`解析完成，正在自动补图（${fileNo}/${datasetsNeedAutoImport.length}） ${d.name} · 题目 ${index + 1}/${total}`, false);
        }
      });
      autoImportSummary.files += res.questionCount ? 1 : 0;
      autoImportSummary.questions += res.questionCount;
      autoImportSummary.attempted += res.attempted;
      autoImportSummary.imported += res.imported;
      autoImportSummary.failed += res.failed;
      if (res.errors && res.errors.length) autoImportSummary.errors.push(...res.errors);
      renderFileTable();
      if (activeIdx >= 0 && datasets[activeIdx] === d) updateActiveUI();
    }
  }

  const okFiles = datasets.filter(d=>d.parsedReady).length;
  const missing = datasets.reduce((n, d) => n + (d.parsedReady ? countPendingAnswers(d.parsed) : 0), 0);
  const missingImgs = datasets.reduce((n, d) => n + (d.parsedReady ? countImageUploadNeeded(d.parsed) : 0), 0);
  let msg = `解析完成：${okFiles}/${datasets.length} 个文件`;
  if (autoImportSummary.imported > 0) msg += `；自动补图成功 ${autoImportSummary.imported} 张`;
  if (missing > 0) msg += `；未成功提取答案 ${missing} 题`;
  if (missingImgs > 0) msg += `；仍缺少可导出图片 ${missingImgs} 题`;
  else if (autoImportSummary.questions > 0) msg += '；缺图题已自动处理完成';
  setTopStatus(msg, missing > 0 || missingImgs > 0);
  renderFileTable();
  updateActiveUI();
});

parseActiveBtn.addEventListener('click', async () => {
  if (activeIdx < 0) return;
  await parseOne(activeIdx);
  const d = datasets[activeIdx];
  const missing = d && d.parsedReady ? countPendingAnswers(d.parsed) : 0;
  const missingImgs = d && d.parsedReady ? countImageUploadNeeded(d.parsed) : 0;
  let msg = d && d.parsedReady ? `解析完成：${d.name}` : (d && d.err ? `解析失败：${d.name}` : '');
  if (d && d.parsedReady && missing > 0) msg += `；未成功提取答案 ${missing} 题`;
  if (d && d.parsedReady && missingImgs > 0) msg += `；缺少可导出图片 ${missingImgs} 题`;
  setTopStatus(msg, missing > 0 || missingImgs > 0 || !!(d && d.err));
  renderFileTable();
  updateActiveUI();
});

function datasetHasRegisteredQuestions(d){
  return !!(d && Array.isArray(d.parsed) && d.parsed.some(q => registeredParsedQuestions.has(q)));
}
function readyDatasetHasRegisteredQuestions(){
  return datasets.some(d => d && d.parsedReady && datasetHasRegisteredQuestions(d));
}
function outputDeclaresRegistered(){
  const raw = String((out && out.value) || '');
  if (!raw.trim()) return false;
  const direct = tryParseJSONArray(raw);
  if (direct) return direct.some(hasRegisteredIdentity);
  // For malformed JSON, fail closed only when the raw value has JSON-object shape
  // or HTML-like wrapper and an identity key declaration; ordinary legacy question
  // text is not enough.
  const trimmed = raw.trim();
  const hasIdentityKey = /"(?:bankUid|questionUid|questionKey)"\s*:/i.test(trimmed);
  return hasIdentityKey && (/^[\[{]/.test(trimmed) || /<\/?(?:html|script|body)\b/i.test(trimmed));
}
function registeredPublishBlocked(){
  return readyDatasetHasRegisteredQuestions() || outputDeclaresRegistered();
}
function rejectRegisteredPublish(){
  invalidateUiGeneration();
  setOutputValue('');
  setTopStatus('REGISTERED_PUBLISH_DISABLED', true);
  setPublishSiteStatus('REGISTERED_PUBLISH_DISABLED', true);
  updateExportButtons();
  return false;
}
async function finalizeEditorRecords(records){
  const registered = [];
  const indexes = [];
  records.forEach((record, index) => {
    if (hasRegisteredIdentity(record)) {
      registered.push(record);
      indexes.push(index);
    }
  });
  if (!registered.length) return records;
  const finalized = await finalizeRegisteredQuestions(registered);
  const byIndex = new Map(indexes.map((index, i) => [index, finalized[i]]));
  return records.map((record, index) => byIndex.has(index) ? byIndex.get(index) : record);
}
function exportDatasetsForMode(mode){
  if (mode === 'active') {
    const d = datasets[activeIdx];
    return d && d.parsedReady ? [d] : [];
  }
  return datasets.filter(d => d && d.parsedReady);
}
function isReviewExportBlocker(entry){
  const reasons = Array.isArray(entry && entry.reasons) ? entry.reasons : [];
  return !!(entry && (entry.disposition === 'rejected'
    || (entry.exportability && entry.exportability.status === 'invalid')
    || reasons.includes('missing_image')
    || reasons.includes('missing_answer')));
}
function reviewExportBlockers(sources){
  if (!reviewEditorEnabled) return [];
  return (sources || []).flatMap(d => {
    const report = reviewReportFor(d);
    return report && report.records ? report.records.filter(isReviewExportBlocker).map(entry => ({ dataset: d, entry })) : [];
  });
}
function exportTransactionIsCurrent(tx){
  if (tx.id !== exportTransactionId || uiGeneration !== tx.generation) return false;
  if (tx.mode === 'active' && (activeIdx !== tx.activeIdx || datasets[activeIdx] !== tx.activeDataset)) return false;
  return tx.sources.every(d => datasets.includes(d) && d.parsedReady);
}
async function runEditorExport(mode){
  if (exportBusy){
    setTopStatus('导出忙碌：当前事务仍在进行', true);
    return;
  }
  const sources = exportDatasetsForMode(mode);
  if (!sources.length) return;
  exportBusy = true;
  const tx = {
    id: ++exportTransactionId,
    generation: uiGeneration,
    mode,
    activeIdx,
    activeDataset: datasets[activeIdx],
    sources,
  };
  // A transaction owns the visible export slot while it is busy.  Clear the prior
  // candidate before awaiting so stale JSON cannot be downloaded as this export.
  updateExportButtons();
  setOutputValue('');
  let candidateRecords = [];
  try{
    const active = datasets[activeIdx];
    if (sources.includes(active)) collectFromUI(active);
    const blockers = reviewExportBlockers(sources);
    if (reviewEditorEnabled && blockers.length){
      renderReviewExportPreview(active, true, sources);
      setTopStatus(`导出暂停：有 ${blockers.length} 条不可导出记录。请修复或在编辑模式中显式删除后再导出；不会静默删题。`, true);
      return;
    }
    const collections = sources.map(d => buildQuestionBank(d.parsed, d.prefix, d.sourcePrefix));
    // Build immediately from the live parsed objects so P2's private carrier is used;
    // only the plain candidate records cross the asynchronous P1 boundary.
    candidateRecords = collections.flat();
    const finalized = await finalizeEditorRecords(candidateRecords);
    if (!exportTransactionIsCurrent(tx)) {
      setTopStatus('导出已取消：编辑器状态已变化', true);
      return;
    }
    const result = mode === 'unique'
      ? buildUniqueMergedQuestionBankFromCollections([finalized])
      : finalized;
    if (!exportTransactionIsCurrent(tx)) {
      setTopStatus('导出已取消：编辑器状态已变化', true);
      return;
    }
    const filename = mode === 'active'
      ? (sources[0].prefix ? `${sources[0].prefix}.json` : 'question_bank.json')
      : mode === 'all' ? 'question_bank_all.json' : 'question_bank_merged.json';
    setOutputValue(JSON.stringify(result, null, 2), filename);
    setTopStatus(`导出完成：${result.length} 题`, false);
  }catch(error){
    if (!exportTransactionIsCurrent(tx)) {
      setTopStatus('导出已取消：编辑器状态已变化', true);
      return;
    }
    setOutputValue('');
    const message = error && error.message ? String(error.message) : String(error);
    if (candidateRecords.some(hasRegisteredIdentity) || sources.some(datasetHasRegisteredQuestions)) {
      setTopStatus('REGISTERED_INVALID_INPUT', true);
    } else {
      setTopStatus(`导出失败：${message}`, true);
    }
  }finally{
    if (tx.id === exportTransactionId) {
      exportBusy = false;
      updateExportButtons();
    }
  }
}

exportActiveBtn.addEventListener('click', () => { void runEditorExport('active'); });
exportAllBtn.addEventListener('click', () => { void runEditorExport('all'); });
exportUniqueBtn.addEventListener('click', () => { void runEditorExport('unique'); });

downloadOutJsonBtn && downloadOutJsonBtn.addEventListener('click', downloadOutAsJSON);

// 站点发布包（.zip，多文件 SPA）已随方案乙退役：做题站 = build-pages 目录页 + 单文件播放器。
genLegacyQBankBtn && genLegacyQBankBtn.addEventListener('click', async () => {
  if (registeredPublishBlocked()) {
    rejectRegisteredPublish();
    return;
  }
  try{
    const arr = getExportArrayOrNull();
    if (!arr || !arr.length){
      alert('没有可导出的题库：请先解析并导出 JSON。');
      return;
    }
    const publishMeta = collectPublishMeta(arr);
    const html = await buildLegacyQuestionBankHtml(arr, {
      mode: publishMeta.mode,
      password: publishMeta.password,
      bankId: publishMeta.id,
    });
    const defaults = guessPublishDefaults(arr);
    const fname = buildLegacyExportFilename(defaults.bankId);
    downloadTextAsFile(html, fname, 'text/html;charset=utf-8');
    statusEl.textContent = `已导出做题单 HTML：${fname}（${arr.length} 题，${publishMeta.mode === 'protected' ? '密码保护' : '公开'}）${exportRejectionSuffix()}`;
  }catch(e){
    console.error(e);
    alert('导出做题单 HTML 失败：' + (e && e.message ? e.message : String(e)));
  }
});

/* ---- 「发布到站点」：输出框 JSON 直接写入仓库 + 可选部署 ----
   浏览器写不了文件、跑不了 wrangler，由 dev server 的 /api/local/publish-bank 代办
   （与发布双击命令共用 publish-bank-core，仅 extractor.command / npm run dev 模式可用）。 */
function setPublishSiteStatus(text, isError){
  if (!publishSiteStatusEl) return;
  publishSiteStatusEl.textContent = text || '';
  publishSiteStatusEl.style.color = isError ? '#b91c1c' : '';
}

(async function probePublishBridge(){
  try{
    const res = await fetch('/api/local/publish-bank', { method: 'GET' });
    publishBridgeAvailable = !!res.ok;
  }catch(_e){
    publishBridgeAvailable = false;
  }
  if (!publishBridgeAvailable) setPublishSiteStatus('直接发布需要通过 commands/extractor.command（dev 模式）打开提取器。');
  updateExportButtons();
  refreshSiteBanks();
})();

/* ---- 站点题库管理面板：列表 / 下架·恢复 / 删除 / 公开⇄加密 / 部署 ----
   全部走 /api/local/bank-admin（与双击命令共用 publish-bank-core）。 */
function setSiteBanksOpStatus(text, isError){
  if (!siteBanksOpStatusEl) return;
  siteBanksOpStatusEl.textContent = text || '';
  siteBanksOpStatusEl.style.color = isError ? '#b91c1c' : '';
}

function renderSiteBanksList(manifest){
  if (!siteBanksListEl) return;
  lastSiteManifest = Array.isArray(manifest) ? manifest : [];
  if (!publishBridgeAvailable){
    if (siteBanksHintEl) siteBanksHintEl.textContent = '需要通过 commands/extractor.command（dev 模式）打开才能管理站点题库。';
    siteBanksListEl.innerHTML = '';
    return;
  }
  if (siteBanksHintEl) siteBanksHintEl.textContent = '这是本地 public/banks 题库清单，未必等于线上；新版发布通道尚未接通，当前只能本地编辑和保存。';
  siteBanksListEl.innerHTML = lastSiteManifest.map(e => {
    const online = e.deploy !== false;
    const archived = e.archived === true;
    return `<div class="row" style="gap:8px;align-items:center;flex-wrap:wrap;border-top:1px solid var(--border,#e5e7eb);padding:7px 0" data-bank-row="${escapeHTML(e.id)}">
      <strong style="min-width:150px">${e.mode === 'protected' ? '🔒 ' : ''}${escapeHTML(e.title || e.id)}</strong>
      ${archived ? '<span class="meta" style="background:var(--muted-bg,#eef1f6);color:var(--muted,#6b7280);border:1px solid var(--border,#e5e7eb);border-radius:999px;padding:1px 8px;font-size:11px" data-testid="bank-archived-badge">旧库</span>' : ''}
      <span class="meta">${escapeHTML(e.id)} · ${e.question_count ?? '?'} 题 · ${e.mode === 'protected' ? '加密' : '公开'} · ${online ? '本地构建清单包含' : '本地构建清单排除'}</span>
      <span style="flex:1"></span>
      <button class="btn" data-publication-evidence="${escapeHTML(e.id)}">保存/发布证据</button>
      <button class="btn" data-bank-act="up" data-bank-id="${escapeHTML(e.id)}" title="目录页顺序上移" data-testid="bank-up-btn">↑</button>
      <button class="btn" data-bank-act="down" data-bank-id="${escapeHTML(e.id)}" title="目录页顺序下移" data-testid="bank-down-btn">↓</button>
      <button class="btn" data-bank-act="${online ? 'unlist' : 'restore'}" data-bank-id="${escapeHTML(e.id)}" data-testid="bank-${online ? 'unlist' : 'restore'}-btn">${online ? '下架' : '恢复上架'}</button>
      <button class="btn" data-bank-act="${archived ? 'unarchive' : 'archive'}" data-bank-id="${escapeHTML(e.id)}" data-testid="bank-${archived ? 'unarchive' : 'archive'}-btn" title="${archived ? '移出 Old Question Banks 分组，回到主列表' : '移入 Old Question Banks 分组（目录页折叠区，仍可练习）'}">${archived ? '📤 移出 Old' : '📦 移入 Old'}</button>
      <button class="btn" data-bank-act="convert" data-bank-id="${escapeHTML(e.id)}" data-testid="bank-convert-btn">${e.mode === 'protected' ? '转公开' : '转加密'}</button>
      <button class="btn" data-bank-act="edit" data-bank-id="${escapeHTML(e.id)}" data-testid="bank-edit-btn" title="把这个线上题库载入编辑器改题；改完点🚀发布按同 id 覆盖更新">✏️ 编辑</button>
      <button class="btn danger" data-bank-act="delete" data-bank-id="${escapeHTML(e.id)}" data-testid="bank-delete-btn">删除</button>
    </div>`;
  }).join('') || '<div class="meta">（清单为空）</div>';
}

if (siteBanksListEl) mountPublicationEvidence({listElement:siteBanksListEl});
async function refreshSiteBanks(){
  if (!siteBanksListEl) return;
  if (!publishBridgeAvailable){ renderSiteBanksList([]); return; }
  try{
    const response = await fetch('/api/local/publish-bank');const m=await response.json();
    if (!response.ok || m?.ok !== true || !Array.isArray(m.manifest)) throw new Error(m?.error || '清单响应无效');
    renderSiteBanksList(m.manifest);
  }catch(error){
    setSiteBanksOpStatus('清单读取失败；保留先前观测，保存/发布状态未知：'+error.message,true);
  }
}

async function bankAdmin(payload){
  const res = await fetch('/api/local/bank-admin', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({ ok: false, error: '响应解析失败' }));
  if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
  if (Array.isArray(data.manifest)) renderSiteBanksList(data.manifest);
  return data;
}

// 把一个已发布题库载入右侧编辑器（编辑模式），并预填发布表单 = 改完按同 id 覆盖回去。
function loadBankIntoEditor(entry, questions, password){
  const ds = makeQBankDataset({ name: `${entry.id}.json` }, questions);
  invalidateUiGeneration();
  ds.name = `✏️ ${entry.title || entry.id}（编辑中）`;
  datasets.push(ds);
  activeIdx = datasets.length - 1;
  editMode = true;
  if (editModeToggle) editModeToggle.checked = true;
  renderFileTable();
  updateActiveUI();
  // 预填发布表单：同 id/title/mode（加密库带上刚输入的密码）→「🚀 发布到站点」即原地覆盖更新。
  // 注意：必须在 updateActiveUI()（内部会 maybePrefillPublishFields）之后设置，确保用准确的清单值覆盖。
  if (publishBankIdEl) publishBankIdEl.value = entry.id;
  if (publishTitleEl) publishTitleEl.value = entry.title || entry.id;
  if (publishModeEl) publishModeEl.value = entry.mode === 'protected' ? 'protected' : 'public';
  if (entry.mode === 'protected' && publishPasswordEl) publishPasswordEl.value = password || '';
  try { if (list && list.scrollIntoView) list.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (_e) { /* ignore */ }
}

siteBanksRefreshBtn && siteBanksRefreshBtn.addEventListener('click', refreshSiteBanks);

const siteUnlistAllBtn = $('#siteUnlistAllBtn');
siteUnlistAllBtn && siteUnlistAllBtn.addEventListener('click', async () => {
  const online = lastSiteManifest.filter(e => e && e.deploy !== false);
  if (!online.length){ setSiteBanksOpStatus('当前没有在线题库，无需下架。'); return; }
  if (!confirm(`把全部 ${online.length} 个在线题库下架？\n（文件保留，随时可逐个恢复；之后点部署可把线上清空）`)) return;
  try{
    for (const e of online) await bankAdmin({ action: 'unlist', id: e.id });
    setSiteBanksOpStatus(`✅ 已全部下架（${online.length} 个）。点「🚀 部署当前清单」并确认后，线上将清空。`);
  }catch(err){
    setSiteBanksOpStatus(`❌ 批量下架中断：${err && err.message ? err.message : err}`, true);
  }
});

siteBanksListEl && siteBanksListEl.addEventListener('click', async (ev) => {
  const btn = ev.target && ev.target.closest ? ev.target.closest('[data-bank-act]') : null;
  if (!btn) return;
  const id = btn.dataset.bankId;
  const act = btn.dataset.bankAct;
  const entry = lastSiteManifest.find(e => e && e.id === id);
  if (!entry) return;
  try{
    if (act === 'up' || act === 'down'){
      const r = await bankAdmin({ action: 'move', id, delta: act === 'up' ? -1 : 1 });
      setSiteBanksOpStatus(r.moved
        ? `✅ 已${act === 'up' ? '上移' : '下移'}「${id}」。目录页顺序 = 此列表顺序（All Banks 合并卡固定最前），点部署后线上生效。`
        : `「${id}」已经在${act === 'up' ? '最顶' : '最底'}了。`);
    } else if (act === 'delete'){
      if (!confirm(`删除「${entry.title || id}」？\n登记会移除；数据文件会移入回收目录 .bank-trash/（可手动找回）。`)) return;
      const r = await bankAdmin({ action: 'delete', id });
      setSiteBanksOpStatus(`✅ 已删除「${id}」${r.trashedTo ? `（数据已存入 ${r.trashedTo}，可找回）` : ''}。点「🚀 部署当前清单」后线上生效。`);
    } else if (act === 'unlist'){
      if (!confirm(`下架「${entry.title || id}」？站点上将不可见（文件保留，随时可恢复）。`)) return;
      await bankAdmin({ action: 'unlist', id });
      setSiteBanksOpStatus(`✅ 已下架「${id}」。点「🚀 部署当前清单」后线上生效。`);
    } else if (act === 'restore'){
      await bankAdmin({ action: 'restore', id });
      setSiteBanksOpStatus(`✅ 已恢复上架「${id}」。点「🚀 部署当前清单」后线上生效。`);
    } else if (act === 'archive'){
      await bankAdmin({ action: 'archive', id });
      setSiteBanksOpStatus(`✅ 已把「${id}」移入 Old（目录页折叠的旧库分组，仍可练习）。点「🚀 部署当前清单」后线上生效。`);
    } else if (act === 'unarchive'){
      await bankAdmin({ action: 'unarchive', id });
      setSiteBanksOpStatus(`✅ 已把「${id}」移出 Old，回到主列表。点「🚀 部署当前清单」后线上生效。`);
    } else if (act === 'convert'){
      if (entry.mode === 'protected'){
        const pw = prompt(`「${entry.title || id}」转公开：输入现有密码（用于解密）`);
        if (pw == null || !pw) return;
        await bankAdmin({ action: 'convert', id, password: pw });
        setSiteBanksOpStatus(`✅ 「${id}」已转为公开（任何人可见题目与答案）。点部署后生效。`);
      } else {
        const p1 = prompt(`「${entry.title || id}」转加密：设置密码`);
        if (p1 == null || !p1) return;
        const p2 = prompt('再输一遍确认：');
        if (p1 !== p2){ alert('两次密码不一致，已取消。'); return; }
        await bankAdmin({ action: 'convert', id, newPassword: p1 });
        setSiteBanksOpStatus(`✅ 「${id}」已转为 🔒 加密（不再进入合并练习页）。点部署后生效。`);
      }
    } else if (act === 'edit'){
      let password = '';
      if (entry.mode === 'protected'){
        password = prompt(`「${entry.title || id}」是加密库，输入密码以载入编辑：`) || '';
        if (!password) return;
      }
      setSiteBanksOpStatus('载入题库到编辑器…（加密库要解密，稍候）');
      const r = await bankAdmin({ action: 'read', id, password });
      const questions = (r && r.questions) || [];
      if (!questions.length){ setSiteBanksOpStatus('该库没有题目可编辑。', true); return; }
      loadBankIntoEditor(entry, questions, password);
      setSiteBanksOpStatus(`✅ 已载入「${id}」(${questions.length} 题) 到右侧编辑器。修改后只保存本地，不会上线。`);
    }
  }catch(e){
    setSiteBanksOpStatus(`❌ 操作失败：${e && e.message ? e.message : e}`, true);
  }
});

/* ---- 登录用户后台：本地站主专用，metadata census + trusted deletion operator ---- */
let lastUsers = [];
let usersLoaded = false;
function setUsersOpStatus(text, isError){
  if (!usersOpStatusEl) return;
  usersOpStatusEl.textContent = text || '';
  usersOpStatusEl.style.color = isError ? '#b91c1c' : '';
}
function renderUsersList(users){
  if (!usersListEl) return;
  if (!publishBridgeAvailable){
    if (usersHintEl) usersHintEl.textContent = '需要通过 commands/extractor.command（dev 模式）打开才能管理用户。';
    usersListEl.innerHTML = '';
    return;
  }
  if (usersHintEl) usersHintEl.textContent = '默认仅列出本次从新版账号目录观察到的账号；目录枚举可能延迟，不代表完整账号总数。新版历史快照、进行记录、私库和删除标记来自当前账号代际的只读统计；遗留来源覆盖仍未知。旧库存单独标注，不用于推算新版数量。不会读取用户答案正文或会话 token。';
  lastUsers = Array.isArray(users) ? users : [];
  usersListEl.innerHTML = lastUsers.map(u => {
    const sub = String(u.sub || '');
    const summary = userAdminSummary(u);
    return `<div class="row" style="gap:8px;align-items:center;border-top:1px solid var(--border,#e5e7eb);padding:7px 0">
      <input type="checkbox" data-user-pick data-user-sub="${escapeHTML(sub)}" data-testid="user-pick" title="选中以批量删除">
      <code style="flex:1;min-width:0;overflow-x:auto;white-space:nowrap;font-size:11px" title="完整用户 id（sub = 码的 sha256）：${escapeHTML(sub)}" data-testid="user-sub">${escapeHTML(sub)}</code>
      <button class="btn" data-user-act="copy" data-user-sub="${escapeHTML(sub)}" data-testid="user-copy-btn" title="复制完整 id">📋</button>
      <span class="meta" data-testid="user-stats"><span>${escapeHTML(summary.phase)}</span><br><span data-testid="user-native-stats">${escapeHTML(summary.native)}</span><br><span data-testid="user-legacy-stats">${escapeHTML(summary.legacy)}</span></span>
      <button class="btn" data-user-act="detail" data-user-sub="${escapeHTML(sub)}">详情</button>
      <button class="btn danger" data-user-act="delete" data-user-sub="${escapeHTML(sub)}" data-testid="user-delete-btn">🗑 删除全部数据</button>
    </div>`;
  }).join('') || '<div class="meta" style="padding:6px">本次未观察到该范围账号；不代表云端账号总数为零。</div>';
  syncUsersSelectionUI();
}
// 批量删除选择态：更新「删除选中（N）」按钮 + 全选框
function pickedUserSubs(){
  if (!usersListEl) return [];
  return Array.from(usersListEl.querySelectorAll('input[data-user-pick]:checked')).map(c => c.dataset.userSub).filter(Boolean);
}
function syncUsersSelectionUI(){
  const picks = usersListEl ? Array.from(usersListEl.querySelectorAll('input[data-user-pick]')) : [];
  const checked = picks.filter(c => c.checked);
  if (usersDeleteSelectedBtn){
    usersDeleteSelectedBtn.disabled = checked.length === 0;
    usersDeleteSelectedBtn.textContent = `🗑 删除选中（${checked.length}）`;
  }
  if (usersSelectAllEl){
    usersSelectAllEl.checked = picks.length > 0 && checked.length === picks.length;
    usersSelectAllEl.indeterminate = checked.length > 0 && checked.length < picks.length;
  }
}
async function usersAdmin(payload){
  const res = await fetch('/api/local/users', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({ ok: false, error: '响应解析失败' }));
  if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
  if (Array.isArray(data.users)) renderUsersList(data.users);
  return data;
}
function userDeleteMessage(result, label){
  if (result && result.status === 'complete') return `✅ ${label}删除已完成。`;
  if (result && result.status === 'pending') return `⏳ ${label}删除已受理，仍在处理中；暂不能报告完成。`;
  return `⚠️ ${label}删除结果未确认，暂不能报告完成。`;
}
function userDeleteRefreshWarning(result){
  return result && result.refreshError ? `；删除结果已确认，但名单刷新失败：${result.refreshError}` : '';
}
const nativeManager = usersListEl ? mountNativeManager({ listElement: usersListEl, renderUsers: renderUsersList,
  legacySelected: () => document.getElementById('usersIncludeLegacy')?.checked === true }) : null;
async function refreshUsers(){
  if (!publishBridgeAvailable) { setUsersOpStatus('本地管理接口不可用；数量未知', true); return; }
  await nativeManager?.load(); usersLoaded = true;
}
usersRefreshBtn && usersRefreshBtn.addEventListener('click', refreshUsers);
document.getElementById('usersIncludeLegacy')?.addEventListener('change', refreshUsers);
usersPanelEl && usersPanelEl.addEventListener('toggle', () => {
  if (usersPanelEl.open && !usersLoaded && publishBridgeAvailable) refreshUsers();
});
usersDelByCodeBtn && usersDelByCodeBtn.addEventListener('click', () => {
  setUsersOpStatus('请先按完整账号 ID 搜索并查看 generation，再从账号行发起删除；码直接删除暂不可诊断范围。', true);
});
usersListEl && usersListEl.addEventListener('click', async (ev) => {
  const copyBtn = ev.target && ev.target.closest ? ev.target.closest('[data-user-act="copy"]') : null;
  if (copyBtn){
    const s = copyBtn.dataset.userSub || '';
    try { await navigator.clipboard.writeText(s); setUsersOpStatus('已复制完整 id 到剪贴板。'); }
    catch(_e){ setUsersOpStatus('复制失败——可手动选中那串 id 复制。', true); }
    return;
  }
  const btn = ev.target && ev.target.closest ? ev.target.closest('[data-user-act="delete"]') : null;
  if (!btn) return;
  const sub = btn.dataset.userSub;
  if (!sub) return;
  const user = lastUsers.find(user => user.sub === sub);
  if (!user || !confirmAccountRemoval([user])) return;
  try{
    setUsersOpStatus('删除中…');
    const r = await usersAdmin({ action: 'delete', sub, confirmedScope:captureDeletionScope(user) });
    setUsersOpStatus(`${userDeleteMessage(r, '该用户')}${userDeleteRefreshWarning(r)}`, r.status !== 'complete');
  }catch(e){
    setUsersOpStatus(`❌ 删除失败：${e && e.message ? e.message : e}`, true);
  }
});
// 勾选框变化 → 刷新「删除选中（N）」按钮态
usersListEl && usersListEl.addEventListener('change', (ev) => {
  if (ev.target && ev.target.matches && ev.target.matches('input[data-user-pick]')) syncUsersSelectionUI();
});
// 全选 / 全不选
usersSelectAllEl && usersSelectAllEl.addEventListener('change', () => {
  if (!usersListEl) return;
  usersListEl.querySelectorAll('input[data-user-pick]').forEach(c => { c.checked = usersSelectAllEl.checked; });
  syncUsersSelectionUI();
});
// 批量删除选中
usersDeleteSelectedBtn && usersDeleteSelectedBtn.addEventListener('click', async () => {
  const subs = pickedUserSubs();
  if (!subs.length){ setUsersOpStatus('先勾选要删除的用户。', true); return; }
  if (!confirmAccountRemoval(lastUsers.filter(user => subs.includes(user.sub)))) return;
  try{
    setUsersOpStatus(`批量删除中…（${subs.length} 个用户，逐个执行受限DO删除并核对状态）`);
    const r = await usersAdmin({ action: 'delete-many', subs, confirmedScopes:subs.map(sub=>captureDeletionScope(lastUsers.find(user=>user.sub===sub))) });
    const errN = (r.errors && r.errors.length) || 0;
    const complete = r.status === 'complete' && !errN;
    const pending = r.status === 'pending';
    const summary = complete
      ? `✅ 已完成删除 ${r.deletedUsers || 0}/${r.requested || subs.length} 个用户`
      : pending
        ? `⏳ 批量删除已受理但仍处理中（${r.deletedUsers || 0}/${r.requested || subs.length} 个已完成）`
        : `⚠️ 批量删除未能全部确认完成（${r.deletedUsers || 0}/${r.requested || subs.length} 个已完成）`;
    setUsersOpStatus(`${summary}${errN ? `，${errN} 个失败` : ''}${userDeleteRefreshWarning(r)}。`, !complete);
  }catch(e){
    setUsersOpStatus(`❌ 批量删除失败：${e && e.message ? e.message : e}`, true);
  }
});

/* ---- 特殊题库（站主本地专用，/api/local/special-banks → 本机 wrangler 写 CF KV） ---- */
let lastSpecialBanks = [];
let specialBanksLoaded = false;
function setSpecialOpStatus(text, isError){
  if (!specialBanksOpStatusEl) return;
  specialBanksOpStatusEl.textContent = text || '';
  specialBanksOpStatusEl.style.color = isError ? '#b91c1c' : '';
}
function renderSpecialBanksList(banks){
  if (!specialBanksListEl) return;
  if (!publishBridgeAvailable){
    if (specialBanksHintEl) specialBanksHintEl.textContent = '需要通过 commands/extractor.command（dev 模式）打开才能管理特殊题库。';
    specialBanksListEl.innerHTML = '';
    return;
  }
  if (specialBanksHintEl) specialBanksHintEl.textContent = '独立访客分享库（不属于账号 generation），分享码授予此题库只读访问；不共享账号历史。';
  lastSpecialBanks = Array.isArray(banks) ? banks : [];
  specialBanksListEl.innerHTML = lastSpecialBanks.map(b => {
    const id = String(b.id || '');
    return `<div class="row" style="gap:8px;align-items:center;border-top:1px solid var(--border,#e5e7eb);padding:7px 0">
      <strong style="min-width:120px">${escapeHTML(b.title || id)}</strong>
      <span class="meta">${b.count || 0} 题</span>
      <span style="flex:1"></span>
      <span class="meta">分享码：<code>${escapeHTML(b.shareCode || '')}</code></span>
      <button class="btn" data-special-act="copy" data-special-code="${escapeHTML(b.shareCode || '')}">复制码</button>
      <button class="btn danger" data-special-act="delete" data-special-id="${escapeHTML(id)}">删除</button>
    </div>`;
  }).join('') || '<div class="meta" style="padding:6px">还没有特殊题库。上面选一个题库 .json + 填分享码 → 上传。</div>';
}
async function specialBanksAdmin(payload){
  const res = await fetch('/api/local/special-banks', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({ ok: false, error: '响应解析失败' }));
  if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
  if (Array.isArray(data.banks)) renderSpecialBanksList(data.banks);
  return data;
}
async function refreshSpecialBanks(){
  if (!specialBanksListEl) return;
  if (!publishBridgeAvailable){ renderSpecialBanksList([]); return; }
  setSpecialOpStatus('读取中…（wrangler，稍慢）');
  try{
    const response = await fetch('/api/local/special-banks');
    const d = await response.json();
    if (!response.ok || d?.ok!==true || !Array.isArray(d.banks)) throw new Error(d?.error || 'SHARE_LIST_INVALID');
    renderSpecialBanksList(d.banks);
    specialBanksLoaded = true;
    setSpecialOpStatus('');
  }catch(e){
    setSpecialOpStatus(`读取失败：${e.message}；数量未知，保留上次列表。`, true);
  }
}
specialBanksRefreshBtn && specialBanksRefreshBtn.addEventListener('click', refreshSpecialBanks);
specialBanksPanelEl && specialBanksPanelEl.addEventListener('toggle', () => {
  if (specialBanksPanelEl.open && !specialBanksLoaded && publishBridgeAvailable) refreshSpecialBanks();
});
specialBankCreateBtn && specialBankCreateBtn.addEventListener('click', async () => {
  const f = specialBankFileEl && specialBankFileEl.files && specialBankFileEl.files[0];
  const title = ((specialBankTitleEl && specialBankTitleEl.value) || '').trim();
  const code = ((specialBankCodeEl && specialBankCodeEl.value) || '').trim();
  if (!f){ setSpecialOpStatus('先选一个题库 .json 文件。', true); return; }
  if (code.length < 6 || code.length > 80){ setSpecialOpStatus('先填分享码（6–80 个字符）。', true); return; }
  try{
    setSpecialOpStatus('读取文件…');
    let parsed;
    try{ parsed = JSON.parse(await f.text()); }catch{ setSpecialOpStatus('不是合法 JSON。', true); return; }
    const questions = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.questions) ? parsed.questions : null);
    if (!questions || !questions.length){ setSpecialOpStatus('文件里没有题目数组。', true); return; }
    const finalTitle = title || String(f.name || '特殊题库').replace(/\.json$/i, '');
    setSpecialOpStatus('上传中…');
    const r = await specialBanksAdmin({ action: 'create', title: finalTitle, questions, shareCode: code });
    if (specialBankFileEl) specialBankFileEl.value = '';
    if (specialBankTitleEl) specialBankTitleEl.value = '';
    if (specialBankCodeEl) specialBankCodeEl.value = '';
    setSpecialOpStatus(`✅ 已创建「${r.title}」（${r.count} 题）。分享码：${r.shareCode} —— 把这个码告诉对方即可。`);
  }catch(e){
    setSpecialOpStatus(`❌ 失败：${e && e.message ? e.message : e}`, true);
  }
});
specialBanksListEl && specialBanksListEl.addEventListener('click', async (ev) => {
  const btn = ev.target && ev.target.closest ? ev.target.closest('[data-special-act]') : null;
  if (!btn) return;
  const act = btn.dataset.specialAct;
  if (act === 'copy'){
    const c = btn.dataset.specialCode || '';
    try{ await navigator.clipboard.writeText(c); setSpecialOpStatus('已复制分享码：' + c); }
    catch{ setSpecialOpStatus('复制失败，手动复制：' + c, true); }
    return;
  }
  if (act === 'delete'){
    const id = btn.dataset.specialId;
    const entry = lastSpecialBanks.find(b => b.id === id);
    if (!confirm(`删除特殊题库「${entry ? entry.title : id}」？\n分享码立即失效，已分享给别人的将打不开。`)) return;
    if (prompt(`再次确认删除对象 ${id}（独立访客库，无账号 generation）；输入 DELETE`)!=='DELETE') return;
    try{
      setSpecialOpStatus('删除中…');
      await specialBanksAdmin({ action: 'delete', id });
      setSpecialOpStatus('✅ 已删除。');
    }catch(e){
      setSpecialOpStatus(`❌ 删除失败：${e && e.message ? e.message : e}`, true);
    }
  }
});

siteDeployBtn && siteDeployBtn.addEventListener('click', async () => {
  setSiteBanksOpStatus('新版发布通道尚未接通，不能上线；本地编辑和保存仍可使用。', true);
  return;
  if (!publishBridgeAvailable || publishInFlight) return;
  // 预检查：清单里一个在线题库都没有 = 这次部署会把线上清空——要用户显式确认（防误删保护的放行口）
  const onlineCount = lastSiteManifest.filter(e => e && e.deploy !== false).length;
  let allowEmpty = false;
  if (!onlineCount){
    if (!confirm('当前没有任何在线题库。\n继续部署会把线上站点清空为「暂无题库」状态（目录页保留，访客仍可本地导入 JSON 练习）。\n确定全部解除部署？')) return;
    allowEmpty = true;
  }
  const target = siteDeployTargetSel ? siteDeployTargetSel.value : 'all';
  publishInFlight = true;
  updateExportButtons();
  siteDeployBtn.disabled = true;
  setSiteBanksOpStatus('部署中…（构建 + 上传约需 1 分钟，请勿关闭页面）');
  try{
    const data = await bankAdmin({ action: 'deploy', target, allowEmpty });
    const bits = [allowEmpty ? '✅ 已清空线上站点（全部题库解除部署）' : '✅ 部署完成'];
    if (target !== 'gh') bits.push('Cloudflare：https://question-bank-78u.pages.dev/');
    if (target !== 'cf') bits.push('GitHub：https://shicheng0810.github.io/question-bank/（约 1 分钟生效）');
    setSiteBanksOpStatus(bits.join('　·　'));
  }catch(e){
    setSiteBanksOpStatus(`❌ 部署失败：${e && e.message ? e.message : e}`, true);
  }finally{
    publishInFlight = false;
    siteDeployBtn.disabled = false;
    updateExportButtons();
  }
});

publishSiteBtn && publishSiteBtn.addEventListener('click', async () => {
  if (registeredPublishBlocked()) {
    rejectRegisteredPublish();
    return;
  }
  try{
    const arr = getExportArrayOrNull();
    if (!arr || !arr.length){
      alert('没有可发布的题库：请先解析并导出 JSON。');
      return;
    }
    const publishMeta = collectPublishMeta(arr);
    if (publishMeta.mode === 'protected' && !publishMeta.password){
      alert('密码保护模式需要先在上方填写发布密码。');
      return;
    }
    const target = publishTargetSel ? publishTargetSel.value : 'none';
    if (target !== 'none') {
      setPublishSiteStatus('新版发布通道尚未接通；请选择只保存本地，不会上线。', true);
      return;
    }

    // 撞 id 时先确认覆盖
    let existing = null;
    try{
      const m = await fetch('/api/local/publish-bank').then(r => r.json());
      existing = ((m && m.manifest) || []).find(e => e && e.id === publishMeta.id) || null;
    }catch(_e){}
    if (existing && !confirm(`题库「${existing.title || publishMeta.id}」已存在（${existing.question_count} 题，${existing.mode === 'protected' ? '🔒 加密' : '公开'}）。\n覆盖更新它？`)) return;

    publishInFlight = true;
    updateExportButtons();
    setPublishSiteStatus(target === 'none' ? '写入仓库中…' : '发布中…（构建 + 部署约需 1 分钟，请勿关闭页面）');

    const res = await fetch('/api/local/publish-bank', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        questions: arr,
        id: publishMeta.id,
        title: publishMeta.title,
        description: publishMeta.description,
        tags: publishMeta.tags,
        mode: publishMeta.mode,
        password: publishMeta.password || '',
        target,
      }),
    });
    const data = await res.json().catch(() => ({ ok: false, error: '响应解析失败' }));
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);

    const description = `本地${data.replaced ? '更新' : '保存'}「${data.id}」（${data.count} 题）`;
    let evidenceText = '保存/构建/发布状态未知：响应未提供有效证据';
    try { evidenceText = publicationEvidenceSummary(data.publicationEvidence); } catch { /* Write result and evidence verification are separate. */ }
    setPublishSiteStatus(description + '\n' + evidenceText + (data.deployError ? '\n发布流程失败：'+data.deployError : ''));
    refreshSiteBanks();
  }catch(e){
    console.error(e);
    setPublishSiteStatus(`❌ 发布失败：${e && e.message ? e.message : e}`, true);
  }finally{
    publishInFlight = false;
    updateExportButtons();
  }
});

function collectPublishMeta(arr){
  const defaults = guessPublishDefaults(arr);
  const meta = buildPublishMetaHelper({
    bankId: publishBankIdEl && publishBankIdEl.value ? publishBankIdEl.value.trim() : '',
    title: publishTitleEl && publishTitleEl.value ? publishTitleEl.value.trim() : '',
    mode: publishModeEl && publishModeEl.value ? publishModeEl.value : 'public',
    description: publishDescriptionEl && publishDescriptionEl.value ? publishDescriptionEl.value.trim() : '',
    tags: publishTagsEl && publishTagsEl.value ? publishTagsEl.value : '',
    cover: publishCoverEl && publishCoverEl.value ? publishCoverEl.value.trim() : '',
    passwordHint: publishPasswordHintEl && publishPasswordHintEl.value ? publishPasswordHintEl.value.trim() : '',
    password: publishPasswordEl && publishPasswordEl.value ? publishPasswordEl.value : '',
  }, arr, {
    activePrefix: defaults.bankId,
    activeSourcePrefix: defaults.title,
  });

  if (publishBankIdEl) publishBankIdEl.value = meta.id;
  if (publishTitleEl && !publishTitleEl.value.trim()) publishTitleEl.value = meta.title;
  savePublishSettings();
  return meta;
}

function guessPublishDefaults(arr){
  const fromActive = datasets[activeIdx] || null;
  return guessPublishDefaultsHelper(arr, {
    activePrefix: fromActive && fromActive.prefix ? fromActive.prefix : '',
    activeSourcePrefix: fromActive && fromActive.sourcePrefix ? fromActive.sourcePrefix : '',
  });
}

function buildLegacyExportFilename(bankId){
  // 本地时区日期（toISOString 是 UTC：晚上导出会写成“明天”的日期）
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  return `question_bank_${slugifyBankId(bankId || 'question-bank')}_${stamp}.html`;
}









btnSelectAll.addEventListener('click', () => {
  const d = datasets[activeIdx];
  if (!d || !d.parsedReady) return;
  if (reviewEditorEnabled) pushReviewUndo(d);
  // 对没有正确项的单选题补第一个
  d.parsed.forEach((q, qi) => {
    if ((q.kind||'choice') !== 'choice') return;
    if (q.isMulti) return;
    const hasCorrect = (q.choices||[]).some(c=>c.isCorrect);
    if (!hasCorrect && (q.choices||[]).length){
      q.choices.forEach((c,i)=> c.isCorrect = (i===0));
    }
  });
  renderQuestions(d);
  renderFileTable();
  setDatasetStatusMessage(d);
  updateExportButtons();
});

btnClearAll.addEventListener('click', () => {
  const d = datasets[activeIdx];
  if (!d || !d.parsedReady) return;
  if (reviewEditorEnabled) pushReviewUndo(d);
  d.parsed.forEach(q => {
    if ((q.kind||'choice') !== 'choice') return;
    (q.choices||[]).forEach(c=>c.isCorrect=false);
  });
  renderQuestions(d);
  renderFileTable();
  setDatasetStatusMessage(d);
  updateExportButtons();
});

function getDeepSeekAnswerSettings(){
  return {
    apiKey: ocrAiApiKeyEl && ocrAiApiKeyEl.value ? ocrAiApiKeyEl.value.trim() : '',
    baseUrl: (ocrAiBaseUrlEl && ocrAiBaseUrlEl.value ? ocrAiBaseUrlEl.value.trim() : '') || DEFAULT_DEEPSEEK_BASE_URL,
    model: (ocrAiModelEl && ocrAiModelEl.value ? ocrAiModelEl.value.trim() : '') || DEFAULT_DEEPSEEK_MODEL
  };
}

function setAiAnswerStatus(message, warn){
  if (!aiAnswerStatusEl) return;
  aiAnswerStatusEl.textContent = message || '';
  aiAnswerStatusEl.style.color = warn ? '#b91c1c' : '';
}

function getAiAnswerableQuestionIndexes(d){
  if (!d || !d.parsedReady) return [];
  return (d.parsed || [])
    .map((q, index) => ({ q, index, usable: questionCanUseAiAnswer(q) }))
    .filter(item => item.usable && item.usable.ok)
    .map(item => item.index);
}

function updateAiAnswerButtons(){
  const d = datasets[activeIdx];
  const settings = getDeepSeekAnswerSettings();
  const indexes = getAiAnswerableQuestionIndexes(d);
  const disabled = !(d && d.parsedReady) || !settings.apiKey || !indexes.length;
  if (aiAnswerCurrentBtn) aiAnswerCurrentBtn.disabled = disabled;
  if (aiAnswerMissingBtn) aiAnswerMissingBtn.disabled = disabled;
}

function getQuestionSourceForAi(d, q){
  return String((q && q.importedSource) || (d && d.sourcePrefix ? `${d.sourcePrefix} – Q${(q && (q.sourceNum || q.num)) || ''}` : '') || '').trim();
}

async function runAiAnswerForQuestion(d, qIndex, settings){
  const q = d && d.parsed ? d.parsed[qIndex] : null;
  const usable = questionCanUseAiAnswer(q);
  if (!usable.ok) {
    return { applied: false, reason: usable.reason };
  }
  const source = getQuestionSourceForAi(d, q);
  const payload = buildDeepSeekAnswerFillPayload(q, {
    model: settings.model,
    source
  });
  const respJson = await callDeepSeekAnswerFill(settings.baseUrl, settings.apiKey, payload);
  const suggestion = parseDeepSeekAnswerFillResponse(respJson, q);
  return applyAiAnswerSuggestion(q, suggestion, {
    provider: 'deepseek',
    model: settings.model
  });
}

async function runAiAnswerForCurrentMissingQuestion(){
  const d = datasets[activeIdx];
  if (!d || !d.parsedReady) return;
  collectFromUI(d);
  const settings = getDeepSeekAnswerSettings();
  if (!settings.apiKey){
    setAiAnswerStatus('请先填写 DeepSeek API Key。', true);
    updateAiAnswerButtons();
    return;
  }
  const indexes = getAiAnswerableQuestionIndexes(d);
  if (!indexes.length){
    setAiAnswerStatus('当前文件没有可由 AI 补全的缺答案题。', false);
    updateAiAnswerButtons();
    return;
  }

  const qIndex = indexes[0];
  setAiAnswerStatus(`DeepSeek 正在补全 Q${(d.parsed[qIndex] && d.parsed[qIndex].num) || qIndex + 1}…`, false);
  aiAnswerCurrentBtn && (aiAnswerCurrentBtn.disabled = true);
  aiAnswerMissingBtn && (aiAnswerMissingBtn.disabled = true);
  try{
    const result = await runAiAnswerForQuestion(d, qIndex, settings);
    if (result.applied){
      setAiAnswerStatus(`已补全 Q${(d.parsed[qIndex] && d.parsed[qIndex].num) || qIndex + 1}`, false);
    }else{
      setAiAnswerStatus(`未补全 Q${(d.parsed[qIndex] && d.parsed[qIndex].num) || qIndex + 1}：${result.reason}`, true);
    }
  }catch(err){
    const q = d.parsed[qIndex];
    if (q) {
      q.aiAnswerMeta = {
        provider: 'deepseek',
        model: settings.model,
        confidence: null,
        explanation: '',
        error: String(err && err.message ? err.message : err).slice(0, 300)
      };
    }
    setAiAnswerStatus(`AI 补答案失败：${err && err.message ? err.message : err}`, true);
  }
  renderQuestions(d);
  renderFileTable();
  setDatasetStatusMessage(d);
  updateExportButtons();
}

async function runAiAnswerForActiveDataset(){
  const d = datasets[activeIdx];
  if (!d || !d.parsedReady) return;
  collectFromUI(d);
  const settings = getDeepSeekAnswerSettings();
  if (!settings.apiKey){
    setAiAnswerStatus('请先填写 DeepSeek API Key。', true);
    updateAiAnswerButtons();
    return;
  }
  const indexes = getAiAnswerableQuestionIndexes(d);
  if (!indexes.length){
    setAiAnswerStatus('当前文件没有可由 AI 补全的缺答案题。', false);
    updateAiAnswerButtons();
    return;
  }

  aiAnswerCurrentBtn && (aiAnswerCurrentBtn.disabled = true);
  aiAnswerMissingBtn && (aiAnswerMissingBtn.disabled = true);
  let applied = 0;
  let failed = 0;
  let skipped = 0;
  for (let i = 0; i < indexes.length; i += 1){
    const qIndex = indexes[i];
    const q = d.parsed[qIndex];
    setAiAnswerStatus(`DeepSeek 正在补全 ${i + 1}/${indexes.length}：Q${(q && q.num) || qIndex + 1}`, false);
    try{
      const result = await runAiAnswerForQuestion(d, qIndex, settings);
      if (result.applied) applied += 1;
      else skipped += 1;
    }catch(err){
      failed += 1;
      if (q) {
        q.aiAnswerMeta = {
          provider: 'deepseek',
          model: settings.model,
          confidence: null,
          explanation: '',
          error: String(err && err.message ? err.message : err).slice(0, 300)
        };
      }
    }
  }
  setAiAnswerStatus(`AI 补答案完成：已补全 ${applied}，跳过 ${skipped}，失败 ${failed}`, failed > 0);
  renderQuestions(d);
  renderFileTable();
  setDatasetStatusMessage(d);
  updateExportButtons();
}

async function parseOne(i){
  const d = datasets[i];
  if (!d) return;
  if (d.origin === 'qbank'){
    d.err = '';
    d.parsing = false;
    d.parsedReady = true;
    if (i === activeIdx) updateActiveUI();
    return;
  }
  d.parsing = true; d.err = '';
  renderFileTable();

  try{
    setTopStatus(`解析：${d.name}`, false);
    // latin1 保字节解码：MHTML 是字节格式，按 UTF-8 整体解码会把 QP/base64 体之外的高位字节
    // 折叠成 >0xFF 码点，后续 charCodeAt&0xff 即截坏。文本 part 的真实编码由 part 自身还原。
    const fileBytes = new Uint8Array(await d.file.arrayBuffer());
    const raw = new TextDecoder('latin1').decode(fileBytes);
    const { html, htmlParts, cidMap, subject } = parseMHTML(raw);

    const candidates = [];
    const seen = new Set();
    [html, ...(Array.isArray(htmlParts) ? htmlParts : [])].forEach(part => {
      const normalized = String(part || '');
      if (!normalized || seen.has(normalized)) return;
      seen.add(normalized);
      candidates.push(normalized);
    });
    // 非 MHTML（直接保存的 .html 页面）：整个文件按 UTF-8 当 HTML 解析
    if (!candidates.length){
      const plain = new TextDecoder('utf-8').decode(fileBytes);
      if (plain.trim()) candidates.push(plain);
    }

    // 选 html 候选 + 选解析引擎（经典测验 / New Quizzes）统一由 parseQuizArchive 负责，
    // 与 scripts/extract-mhtml.mjs 共用同一条路，避免 UI 与 CLI 解析结果漂移。
    const { parsed: bestParsed, html: bestHtml, engine } = parseQuizArchive(candidates, cidMap);

    // 0 题不再静默当成功：明确报出这份存档为什么提不出题
    if (!bestParsed.length) throw new Error(describeUnparsableArchive(candidates));

    d.parsed = bestParsed;
    d.parsedReady = true;
    d.engine = engine;

    // 用页面标题（MHTML Subject 头）派生 prefix/Source —— 比文件名可靠（文件名可能被改成学生名等，
    // 标题恒含课程码）。只在用户没手动改过这两个字段时回填；标题解析不出有效值就保留文件名启发式初值。
    d.subject = subject || '';
    // 课程码兜底：标题是学生姓名视图（"<作业>: 学生名"）时，从页面面包屑（AMT&205 34077）补课程码。
    const pageCourse = extractCourseFromHTML(bestHtml);
    // New Quizzes 成绩页的标题恒为通用文案 "Quizzes - Results"，派生不出作业名 → 改喂文件名
    // （课程码仍由 pageCourse 从面包屑补上，所以 prefix 里的课程号不会丢）。
    const titleForMeta = isGenericQuizResultsTitle(subject) ? (d.name || '') : subject;
    if (titleForMeta || pageCourse){
      const tg = guessMetaFromTitle(titleForMeta, pageCourse);
      if (tg && tg.prefix){
        if (!d.prefixTouched) d.prefix = tg.prefix;
        if (!d.sourceTouched) d.sourcePrefix = tg.sourcePrefix;
      }
    }
  }catch(e){
    d.err = String(e && e.message ? e.message : e);
    d.parsedReady = false;
  }finally{
    d.parsing = false;
  }

  // 如果正在预览这个文件，刷新右侧
  if (i === activeIdx) updateActiveUI();
}

/* --------- 文件表格 --------- */
function renderFileTable(){
  fileTableBody.innerHTML = '';
  datasets.forEach((d, idx) => {
    const tr = document.createElement('tr');
    tr.dataset.testid = 'dataset-row';
    tr.dataset.datasetIndex = String(idx);
    tr.dataset.origin = String((d && d.origin) || 'mhtml');

    const info = formatDatasetStatus(d);
    const statusBadge = d.parsing
      ? `<span class="badge">解析中…</span>`
      : d.err
        ? `<span class="badge wait">失败</span>`
        : d.parsedReady
          ? `<span class="badge ${(info.pending || info.missingImgs || info.unsupported || info.conflicts) ? 'wait' : 'ok'}">${info.text}</span>`
          : `<span class="badge">未解析</span>`;

    tr.innerHTML = `
      <td>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <button class="btn ${idx===activeIdx?'primary':''}" data-act="preview" data-idx="${idx}" data-testid="preview-dataset-btn">预览</button>
          ${editMode ? `<button class="btn danger" data-act="delete-dataset" data-idx="${idx}" data-testid="delete-dataset-btn" title="删除该题库">删除</button>` : ''}
          <div style="min-width:240px">
            <div style="font-weight:600;word-break:break-word">${escapeHTML(d.name)}</div>
            ${d.err ? `<div class="meta" style="color:#b91c1c">Error: ${escapeHTML(d.err)}</div>` : ``}
          </div>
        </div>
      </td>
      <td>
        <input class="small" type="text" value="${escapeHTML(d.prefix)}" data-act="prefix" data-idx="${idx}" data-testid="dataset-prefix-input">
      </td>
      <td>
        <input type="text" value="${escapeHTML(d.sourcePrefix)}" data-act="source" data-idx="${idx}" data-testid="dataset-source-input">
      </td>
      <td>${statusBadge}</td>
    `;
    fileTableBody.appendChild(tr);
  });
}

fileTableBody.addEventListener('click', (e) => {
  const delBtn = e.target.closest('button[data-act="delete-dataset"]');
  if (delBtn) {
    const idx = Number(delBtn.dataset.idx);
    const d = datasets[idx];
    if (!d) return;
    if (!confirm(`确定删除题库「${d.name}」？此操作不可撤销。`)) return;
    invalidateUiGeneration();
    const wasActive = activeIdx === idx;
    datasets.splice(idx, 1);
    if (wasActive) {
      activeIdx = datasets.length ? Math.min(idx, datasets.length - 1) : -1;
    } else if (activeIdx > idx) {
      activeIdx -= 1;
    }
    renderFileTable();
    updateActiveUI();
    updateExportButtons();
    return;
  }
  const btn = e.target.closest('button[data-act="preview"]');
  if (!btn) return;
  const idx = Number(btn.dataset.idx);
  if (Number.isNaN(idx)) return;
  invalidateUiGeneration();
  activeIdx = idx;
  renderFileTable();
  updateActiveUI();
});

fileTableBody.addEventListener('input', (e) => {
  const inp = e.target;
  if (!(inp instanceof HTMLInputElement)) return;
  const act = inp.dataset.act;
  const idx = Number(inp.dataset.idx);
  const d = datasets[idx];
  if (!d) return;
  invalidateUiGeneration();
  if (act === 'prefix') { d.prefix = inp.value.trim(); d.prefixTouched = true; }
  if (act === 'source') { d.sourcePrefix = inp.value.trim(); d.sourceTouched = true; }
  updateExportButtons();
});

/* --------- 右侧预览 --------- */
function updateActiveUI(){
  const d = datasets[activeIdx];
  activeNameEl.textContent = d ? d.name : '(未选择)';
  if (reviewEditorEnabled) renderReviewPanel(d);
  if (!d || !d.parsedReady){
    list.innerHTML = '';
    setDatasetStatusMessage(d || null);
    maybePrefillPublishFields();
    updateExportButtons();
    return;
  }
  renderQuestions(d);
  setDatasetStatusMessage(d);
  maybePrefillPublishFields();
  updateExportButtons();
}

function updateExportButtons(){
  const d = datasets[activeIdx];
  const parsedCount = datasets.filter(x=>x.parsedReady).length;
  const registeredBlocked = registeredPublishBlocked();

  exportActiveBtn.disabled = exportBusy || !(d && d.parsedReady);
  exportAllBtn.disabled = exportBusy || parsedCount === 0;
  if (exportUniqueBtn) exportUniqueBtn.disabled = exportBusy || parsedCount === 0;

  const buttonState = getPublishButtonStateHelper({
    parsedCount,
    outValue: out && out.value ? out.value : '',
    publishMode: publishModeEl && publishModeEl.value ? publishModeEl.value : 'public',
    publishPassword: publishPasswordEl && publishPasswordEl.value ? publishPasswordEl.value : '',
    apiBaseUrl: apiBaseUrlEl && apiBaseUrlEl.value ? apiBaseUrlEl.value : '',
    apiKey: apiKeyEl && apiKeyEl.value ? apiKeyEl.value : '',
  });
  if (genLegacyQBankBtn) genLegacyQBankBtn.disabled = registeredBlocked || buttonState.disableLegacyHtml;
  if (publishSiteBtn) publishSiteBtn.disabled = registeredBlocked || buttonState.disableLegacyHtml || !publishBridgeAvailable || publishInFlight;

  if (dryRunAiMCQEl) dryRunAiMCQEl.disabled = buttonState.disableAiDryRun;
  if (runAiMCQEl) runAiMCQEl.disabled = buttonState.disableAiRun;
  updateAiAnswerButtons();
}

function maybePrefillPublishFields(){
  if (registeredPublishBlocked()) return;
  const arr = getExportArrayOrNull();
  if (!arr || !arr.length) return;
  const defaults = guessPublishDefaults(arr);
  if (publishBankIdEl && !publishBankIdEl.value.trim()) publishBankIdEl.value = defaults.bankId;
  if (publishTitleEl && !publishTitleEl.value.trim()) publishTitleEl.value = defaults.title;
  savePublishSettings();
}

// 最近一次导出被校验闸剔除的记录（供导出成功提示补充说明；详单进 console.warn）
let lastExportRejected = [];
function applyExportValidation(merged){
  const { valid, rejected } = validateQuestionBankRecords(merged);
  lastExportRejected = rejected;
  if (rejected.length){
    console.warn('[export] 剔除不完整记录：', rejected.map(r => ({ id: r.record && r.record.id, reasons: r.reasons })));
  }
  return valid;
}
function exportRejectionSuffix(){
  if (!lastExportRejected.length) return '';
  const sample = lastExportRejected[0];
  const why = sample && sample.reasons && sample.reasons[0] ? sample.reasons[0] : '不完整';
  return `；已剔除 ${lastExportRejected.length} 条无法作答的记录（如：${why}，详见控制台）`;
}

function clearStaleOutputForReviewPublishBlock(){
  if (out && out.value) {
    writingOutput = true;
    try { out.value = ''; }
    finally { writingOutput = false; }
  }
  updateDownloadOutBtn();
}

function getExportArrayOrNull(){
  if (registeredPublishBlocked()) return null;
  if (reviewEditorEnabled) {
    const exportSources = exportDatasetsForMode('all');
    const blockers = reviewExportBlockers(exportSources);
    if (blockers.length) {
      clearStaleOutputForReviewPublishBlock();
      renderReviewExportPreview(datasets[activeIdx], true, exportSources);
      setTopStatus(`发布暂停：${blockers.length} 条记录不可导出。请修复或在编辑模式中显式删除后再发布。`, true);
      return null;
    }
  }
  // Always merge/dedup before handing off to the publish ZIP or single-file HTML builders,
  // so a published bank never carries duplicate questions (the root cause of duplicated
  // questions in older exports). The merge fuses the same question across sources and keeps
  // every source reference; see buildUniqueMergedQuestionBankFromCollections.
  // 出口统一过 schema 校验闸：不完整记录（缺答案/选项不足/未知结构）不再静默进发布物。
  const direct = tryParseJSONArray(out.value);
  if (direct){
    const merged = applyExportValidation(buildUniqueMergedQuestionBankFromCollections([direct]));
    return merged.length ? merged : null;
  }
  const collections = [];
  for (const d of datasets){
    if (!d.parsedReady) continue;
    collectFromUI(d);
    collections.push(buildQuestionBank(d.parsed, d.prefix, d.sourcePrefix));
  }
  const merged = applyExportValidation(buildUniqueMergedQuestionBankFromCollections(collections));
  return merged.length ? merged : null;
}



function canGenerateQBank(){
  return canGenerateQuestionBankHelper({
    parsedCount: datasets.filter(x=>x.parsedReady).length,
    outValue: out && out.value ? out.value : '',
  });
}




function getQuestionSourceScreenshot(q){
  return String((q && q.ocrSourceImage) || '').trim();
}

function questionNeedsImageUpload(q){
  const expected = Number((q && q.expectedImageCount) || 0);
  if (!expected) return false;
  return getQuestionImages(q).length < expected;
}

function countImageUploadNeeded(parsed){
  return ((parsed || []).reduce((n, q) => n + (questionNeedsImageUpload(q) ? 1 : 0), 0));
}

function formatDatasetStatus(d){
  const pending = d && d.parsedReady ? countPendingAnswers(d.parsed) : 0;
  const missingImgs = d && d.parsedReady ? countImageUploadNeeded(d.parsed) : 0;
  const parsed = (d && d.parsedReady && Array.isArray(d.parsed)) ? d.parsed : [];
  const unsupported = parsed.reduce((n, q) => n + ((q && q.kind) === 'unknown' ? 1 : 0), 0);
  const essays = parsed.reduce((n, q) => n + ((q && q.kind) === 'essay' ? 1 : 0), 0);
  const conflicts = parsed.reduce((n, q) => n + (q && q.answerConflict ? 1 : 0), 0);
  const reviewSummary = reviewEditorEnabled && d && d.parsedReady ? reviewReportFor(d).summary : null;
  const parts = [];
  if (d && d.parsedReady) parts.push(`${d.parsed.length} 题`);
  if (pending) parts.push(`缺答 ${pending}`);
  if (missingImgs) parts.push(`缺图 ${missingImgs}`);
  if (conflicts) parts.push(`答案冲突 ${conflicts}（请核对）`);
  if (unsupported) parts.push(`不支持题型 ${unsupported}（不导出）`);
  if (essays) parts.push(`问答 ${essays}（不导出）`);
  if (reviewSummary) parts.push(`审核 valid/review/rejected ${reviewSummary.valid}/${reviewSummary.review}/${reviewSummary.rejected}`);
  return { pending, missingImgs, unsupported, essays, conflicts, text: parts.join(' · ') };
}

function setDatasetStatusMessage(d){
  if (!d) {
    setTopStatus('', false);
    return;
  }
  if (d.err) {
    setTopStatus(`解析失败：${d.name}`, true);
    return;
  }
  if (!d.parsedReady) {
    setTopStatus(`未解析：${d.name}`, false);
    return;
  }
  const info = formatDatasetStatus(d);
  const head = d.origin === 'qbank' ? '已导入' : '解析完成';
  const msg = info.text ? `${head}：${d.name} · ${info.text}` : `${head}：${d.name}`;
  setTopStatus(msg, info.pending > 0 || info.missingImgs > 0 || info.unsupported > 0 || info.conflicts > 0);
}



function questionNeedsAnswerReview(q){
  if (!q || typeof q !== 'object' || Array.isArray(q)) return true;
  const kind = (q && q.kind) || 'choice';
  if (kind === 'choice') return !Array.isArray(q.choices) || !q.choices.length || !(q.choices.some(c => c && c.isCorrect));
  if (kind === 'fill') return !Array.isArray(q.blanks) || !q.blanks.length || !q.blanks.every(arr => Array.isArray(arr) && arr.some(v => String(v || '').trim()));
  if (kind === 'matching') return !Array.isArray(q.pairs) || !q.pairs.length || !q.pairs.every(p => String((p && p.right) || '').trim());
  return false;
}

function countPendingAnswers(parsed){
  return ((parsed || []).reduce((n, q) => n + (questionNeedsAnswerReview(q) ? 1 : 0), 0));
}

function renderAiAnswerMeta(q){
  const meta = q && q.aiAnswerMeta;
  if (!meta) return '';
  const parts = [];
  if (meta.model) parts.push(`model: ${meta.model}`);
  if (meta.confidence != null) parts.push(`confidence: ${Math.round(Number(meta.confidence) * 100)}%`);
  if (meta.explanation) parts.push(meta.explanation);
  if (meta.error) parts.push(`error: ${meta.error}`);
  if (!parts.length) return '';
  const warn = meta.error ? ' style="color:#b91c1c"' : '';
  return `<div class="meta"${warn}>AI 答案诊断：${escapeHTML(parts.join(' · '))}</div>`;
}

function setTopStatus(message, hasWarn){
  statusEl.textContent = message || '';
  statusEl.style.color = hasWarn ? '#b91c1c' : '';
  statusEl.dataset.kind = hasWarn ? 'warning' : 'neutral';
}

function cloneReviewValue(value, seen = new WeakMap()){
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  if (value instanceof Date) return new Date(value.getTime());
  const copy = Array.isArray(value) ? [] : {};
  seen.set(value, copy);
  if (Array.isArray(value)) copy.length = value.length;
  Reflect.ownKeys(value).forEach(key => {
    if (Array.isArray(value) && key === 'length') return;
    try { Object.defineProperty(copy, key, { value: cloneReviewValue(value[key], seen), enumerable: true, writable: true, configurable: true }); }
    catch (_e) { /* an exotic diagnostic field is not allowed to abort undo */ }
  });
  return copy;
}

function restoreReviewObject(target, snapshot){
  if (!target || typeof target !== 'object' || !snapshot || typeof snapshot !== 'object') return false;
  let complete = true;
  const snapshotKeys = Reflect.ownKeys(snapshot);
  Reflect.ownKeys(target).forEach(key => {
    if (!snapshotKeys.includes(key) && (!(Array.isArray(target) && key === 'length'))) {
      try { delete target[key]; } catch (_e) { complete = false; }
    }
  });
  snapshotKeys.forEach(key => {
    if (Array.isArray(target) && key === 'length') return;
      try { Object.defineProperty(target, key, { value: cloneReviewValue(snapshot[key]), enumerable: true, writable: true, configurable: true }); } catch (_e) {
      // A non-configurable host property is retained rather than silently
      // pretending that the full record was restored.
      complete = false;
    }
  });
  if (Array.isArray(target)) target.length = snapshot.length;
  return complete;
}

function getReviewState(d){
  if (!d || typeof d !== 'object') return { selected: new Set(), decisions: new Map(), undo: [] };
  let state = reviewStateByDataset.get(d);
  if (!state){
    state = { selected: new Set(), decisions: new Map(), undo: [] };
    reviewStateByDataset.set(d, state);
  }
  return state;
}

function reviewKeyFor(d, index){
  return `review:${encodeURIComponent(datasetKey(d))}:record:${index}`;
}

function reviewDecisionLabel(value){
  return value === 'confirmed' ? '确认' : value === 'cannot_determine' ? '无法判断' : '待核';
}

function captureReviewSnapshot(d){
  const state = getReviewState(d);
  return {
    order: Array.isArray(d && d.parsed) ? d.parsed.slice() : [],
    records: (Array.isArray(d && d.parsed) ? d.parsed : []).map(q => ({ ref: q, value: cloneReviewValue(q) })),
    selected: Array.from(state.selected),
    decisions: Array.from(state.decisions.entries()),
  };
}

function pushReviewUndo(d){
  if (!reviewEditorEnabled || !d) return;
  const state = getReviewState(d);
  state.undo.push(captureReviewSnapshot(d));
  if (state.undo.length > 20) state.undo.splice(0, state.undo.length - 20);
  updateReviewUndoUI(d);
}

function restoreReviewSnapshot(d, snapshot){
  if (!d || !snapshot) return false;
  const state = getReviewState(d);
  const complete = snapshot.records.every(entry => {
    if (!entry.ref || typeof entry.ref !== 'object') return entry.ref === entry.value;
    return restoreReviewObject(entry.ref, entry.value);
  });
  if (!complete) {
    state.undo.push(snapshot);
    setTopStatus('撤销未完成：存在不可改写字段，保留本步供后续处理。', true);
    updateReviewUndoUI(d);
    return false;
  }
  d.parsed.length = 0;
  snapshot.order.forEach(q => d.parsed.push(q));
  state.selected = new Set(snapshot.selected || []);
  state.decisions = new Map(snapshot.decisions || []);
  reviewEditingKey = '';
  invalidateUiGeneration();
  updateReviewUndoUI(d);
  return true;
}

function reviewUndo(d){
  if (!d) return false;
  const state = getReviewState(d);
  const snapshot = state.undo.pop();
  if (!snapshot) return false;
  return restoreReviewSnapshot(d, snapshot);
}

function updateReviewUndoUI(d){
  if (!reviewEditorEnabled) return;
  const state = getReviewState(d);
  if (reviewUndoBtn) reviewUndoBtn.disabled = !state.undo.length;
  if (reviewUndoHintEl) reviewUndoHintEl.textContent = `会话撤销 ${state.undo.length}/20 步（不持久化）`;
}

function reviewReportFor(d){
  if (!reviewEditorEnabled || !d || !d.parsedReady) return null;
  try {
    return buildReviewReport(d.parsed, {
      sourceId: datasetKey(d),
      sourcePrefix: d.sourcePrefix,
      exportPrefix: d.prefix,
    });
  } catch (error) {
    return { summary: { total: d.parsed.length, valid: 0, review: 0, rejected: d.parsed.length }, records: d.parsed.map((q, index) => ({ key: reviewKeyFor(d, index), index, disposition: 'rejected', reasons: [String(error && error.message ? error.message : error)] })) };
  }
}

function renderReviewExportPreview(d, explicit = false, sources = null){
  if (!reviewEditorEnabled || !reviewExportPreviewTextEl) return;
  if (!d || !d.parsedReady){
    reviewExportPreviewTextEl.textContent = '暂无可预览的当前文件。';
    return;
  }
  const previewSources = Array.isArray(sources) && sources.length ? sources : [d];
  const records = previewSources.flatMap(source => {
    const report = reviewReportFor(source);
    return report && report.records ? report.records.map(entry => ({ ...entry, datasetName: source.name })) : [];
  });
  const blocked = records.filter(isReviewExportBlocker);
  const unsupported = records.filter(entry => (entry.reasons || []).some(reason => /unsupported_kind|未知题型|essay|unknown/.test(String(reason))));
  const reasonText = blocked.slice(0, 4).map(entry => `${entry.datasetName || '当前文件'} Q${entry.index + 1}：${(entry.reasons || []).join('、')}`).join('；');
  reviewExportPreviewTextEl.textContent = `导出预览（${previewSources.map(source => source.name).join('、')}）：${records.length} 条输入，${blocked.length} 条当前不可导出，${unsupported.length} 条不支持题型。${reasonText ? `原因示例：${reasonText}` : '未发现结构拒绝。'}${explicit ? ' 已生成本次预览；编辑或撤销后需重新生成。' : ''}`;
  reviewExportPreviewTextEl.dataset.generation = String(uiGeneration);
  reviewExportPreviewTextEl.dataset.confirmed = 'false';
  if (reviewExportConfirmEl) reviewExportConfirmEl.checked = false;
}

function renderReviewPanel(d){
  if (!reviewEditorEnabled || !reviewEditorPanelEl) return;
  reviewEditorPanelEl.hidden = false;
  if (!d || !d.parsedReady){
    if (reviewSummaryEl) reviewSummaryEl.textContent = '未选择可审核文件';
    if (reviewSummaryNoteEl) reviewSummaryNoteEl.textContent = '选择并解析文件后，审核分类与理由会显示在这里。';
    if (reviewSelectionCountEl) reviewSelectionCountEl.textContent = '已选 0 题';
    if (reviewUndoBtn) reviewUndoBtn.disabled = true;
    return;
  }
  const state = getReviewState(d);
  Array.from(state.selected).forEach(q => { if (!d.parsed.includes(q)) state.selected.delete(q); });
  const report = reviewReportFor(d);
  const summary = report.summary;
  if (reviewSummaryEl) reviewSummaryEl.innerHTML = `<span class="badge">总计 ${summary.total}</span><span class="badge ok">valid ${summary.valid}</span><span class="badge wait">review ${summary.review}</span><span class="badge wait">rejected ${summary.rejected}</span>`;
  if (reviewSummaryNoteEl) reviewSummaryNoteEl.textContent = `当前文件 ${d.name}：valid 表示结构上可进入候选 schema，不代表答案已人工确认；review/rejected 仍保留在列表中。`;
  if (reviewSelectionCountEl) reviewSelectionCountEl.textContent = `已选 ${state.selected.size} 题`;
  updateReviewUndoUI(d);
  renderReviewExportPreview(d, false);
}

function renderReviewEditForm(q, qIndex){
  const kind = (q && q.kind) || 'choice';
  const choiceList = Array.isArray(q && q.choices) ? q.choices : [];
  const blankList = Array.isArray(q && q.blanks) ? q.blanks : [];
  const pairList = Array.isArray(q && q.pairs) ? q.pairs : [];
  const choices = kind === 'choice' ? choiceList.map((choice, aidx) => `
    <div class="review-choice-row" data-review-choice-row data-original-aidx="${aidx}">
      <input type="${q.isMulti ? 'checkbox' : 'radio'}" name="review-q${qIndex}-answer" data-review-field="choice-answer" data-review-aidx="${aidx}" ${choice && choice.isCorrect ? 'checked' : ''} aria-label="${String.fromCharCode(65 + aidx)} 答案">
      <input type="text" data-review-field="choice-text" data-review-aidx="${aidx}" value="${escapeHTML(choice && choice.text || '')}" aria-label="选项 ${String.fromCharCode(65 + aidx)}">
      <button class="btn" type="button" data-act="review-staged-move" data-direction="up" data-aidx="${aidx}" ${aidx === 0 ? 'disabled' : ''}>↑</button>
      <button class="btn" type="button" data-act="review-staged-move" data-direction="down" data-aidx="${aidx}" ${aidx === choiceList.length - 1 ? 'disabled' : ''}>↓</button>
    </div>`).join('') : '';
  const blanks = kind === 'fill' ? (blankList.length ? blankList : [[]]).map((answers, bidx) => `
    <div class="review-field"><label class="meta">第 ${bidx + 1} 个空（多个答案用 | 分隔）</label><input type="text" data-review-field="fill-answer" data-review-bidx="${bidx}" value="${escapeHTML((answers || []).join(' | '))}"></div>`).join('') : '';
  const pairs = kind === 'matching' ? pairList.map((pair, pidx) => `
    <div class="review-pair-row"><span class="badge">${pidx + 1}</span><input type="text" data-review-field="pair-left" data-review-pidx="${pidx}" value="${escapeHTML(pair && pair.left || '')}"><input type="text" data-review-field="pair-right" data-review-pidx="${pidx}" value="${escapeHTML(pair && pair.right || '')}"></div>`).join('') : '';
  const originalChoices = kind === 'choice' ? choiceList.map((choice, index) => `${String.fromCharCode(65 + index)}. ${escapeHTML(choice && choice.text || '')}${choice && choice.isCorrect ? ' ✓' : ''}`).join('<br>') : '';
  const originalAnswer = kind === 'fill' ? blankList.map((answers, index) => `${index + 1}. ${escapeHTML((answers || []).join(' | '))}`).join('<br>') : kind === 'matching' ? pairList.map(pair => `${escapeHTML(pair && pair.left || '')} → ${escapeHTML(pair && pair.right || '')}`).join('<br>') : originalChoices;
  return `<div class="review-edit-form" data-review-form="${qIndex}" data-testid="review-edit-form">
    <div class="meta"><strong>原始字段</strong></div>
    <div class="review-original"><div>${escapeHTML(q.qtext || '(无题干)')}</div>${originalAnswer ? `<div class="meta" style="margin-top:6px">${originalAnswer}</div>` : ''}</div>
    <div class="review-field"><label class="meta" for="review-qtext-${qIndex}">拟议题干</label><textarea id="review-qtext-${qIndex}" rows="3" data-review-field="qtext">${escapeHTML(q.qtext || '')}</textarea></div>
    ${kind === 'choice' ? `<div class="meta review-field"><strong>拟议选项与答案</strong>（整行移动会保留 isCorrect）</div>${choices}` : ''}
    ${blanks}${pairs}
    <div class="row" style="margin-top:10px"><button class="btn primary" type="button" data-act="review-apply" data-qidx="${qIndex}">应用拟议修改</button><button class="btn" type="button" data-act="review-cancel" data-qidx="${qIndex}">取消</button></div>
  </div>`;
}

function canReviewEditQuestion(q){
  if (!q || typeof q !== 'object' || Array.isArray(q)) return false;
  if (q.kind === 'choice' || (!q.kind && Array.isArray(q.choices))) return Array.isArray(q.choices) && q.choices.length >= 2 && q.choices.every(choice => choice && typeof choice === 'object' && typeof choice.text === 'string' && typeof choice.isCorrect === 'boolean');
  if (q.kind === 'fill') return Array.isArray(q.blanks) && q.blanks.length > 0 && q.blanks.every(answers => Array.isArray(answers));
  if (q.kind === 'matching') return Array.isArray(q.pairs) && q.pairs.length > 0 && q.pairs.every(pair => pair && typeof pair === 'object');
  return false;
}

function renderQuestions(d){
  list.innerHTML = '';
  const reviewReport = reviewEditorEnabled ? reviewReportFor(d) : null;
  d.parsed.forEach((rawQ, qIndex) => {
    const qIsObject = !!(rawQ && typeof rawQ === 'object' && !Array.isArray(rawQ));
    const displayQ = qIsObject ? rawQ : { kind: 'unknown', qtext: '', num: qIndex + 1, choices: [], pairs: [], blanks: [] };
    const q = displayQ;
    const reviewEntry = reviewReport && reviewReport.records ? reviewReport.records[qIndex] : null;
    const reviewState = reviewEditorEnabled ? getReviewState(d) : null;
    const reviewDecision = qIsObject && reviewState && reviewState.decisions.get(q);
    const reviewFilter = reviewEditorEnabled && reviewFilterEl ? reviewFilterEl.value : 'all';
    if (reviewEditorEnabled && reviewFilter !== 'all' && reviewEntry && reviewEntry.disposition !== reviewFilter) return;
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.testid = 'question-editor-card';
    card.dataset.questionIndex = String(qIndex);
    card.dataset.questionKind = String((q && q.kind) || 'choice');
    card.dataset.fileidx = String(activeIdx);
    if (reviewEditorEnabled && !canReviewEditQuestion(q)) {
      const diagnosticNum = String(qIsObject && q.num != null ? q.num : qIndex + 1);
      const diagnosticText = String(qIsObject && q.qtext != null ? q.qtext : '(原记录没有可编辑结构)');
      const diagnosticSource = qIsObject && q.importedSource != null
        ? String(q.importedSource)
        : `${String(d.sourcePrefix == null ? '' : d.sourcePrefix)} – Q${String(qIsObject && q.sourceNum != null ? q.sourceNum : diagnosticNum)}`;
      card.innerHTML = `<div class="qhead">${qIsObject ? `<input class="review-check" type="checkbox" data-review-field="select" data-qidx="${qIndex}" ${reviewState.selected.has(q) ? 'checked' : ''} aria-label="选择 Q${escapeHTML(diagnosticNum)}">` : ''}<span class="qid">Q${escapeHTML(diagnosticNum)}</span><span class="meta">只读诊断 · ${reviewEntry ? reviewEntry.disposition : 'rejected'}</span>${editMode ? `<button class="btn danger" data-act="delete-question" data-qidx="${qIndex}" data-testid="delete-question-btn" title="删除此题">删除</button>` : ''}${qIsObject ? `<select class="small" data-review-field="decision" data-qidx="${qIndex}" aria-label="Q${escapeHTML(diagnosticNum)} 审核决定"><option value="">审核决定…</option><option value="confirmed" ${reviewDecision === 'confirmed' ? 'selected' : ''}>confirmed · 确认</option><option value="needs_review" ${reviewDecision === 'needs_review' ? 'selected' : ''}>needs_review · 待核</option><option value="cannot_determine" ${reviewDecision === 'cannot_determine' ? 'selected' : ''}>cannot_determine · 无法判断</option></select>` : ''}</div><div class="qtext">${escapeHTML(diagnosticText)}</div>${reviewEntry && reviewEntry.reasons && reviewEntry.reasons.length ? `<ul class="review-reasons">${reviewEntry.reasons.map(reason => `<li>${escapeHTML(String(reason))}</li>`).join('')}</ul>` : '<div class="meta">原记录保留，但结构不满足 D2 编辑 schema。</div>'}<div class="meta">Source: ${escapeHTML(diagnosticSource)}</div>`;
      list.appendChild(card);
      return;
    }
    if (qIsObject && !registeredParsedQuestions.has(rawQ)) normalizeChoiceQuestionShape(rawQ);
    const kind = q.kind || 'choice';

    const autoOK =
      kind === 'choice'
        ? (Array.isArray(q.choices) && q.choices.some(c=>c && c.isCorrect))
        : kind === 'fill'
          ? (Array.isArray(q.blanks) && q.blanks.some(b => Array.isArray(b) && b.length))
          : kind === 'matching'
            ? (Array.isArray(q.pairs) && q.pairs.length > 0 && q.pairs.every(p => String((p && p.right) || '').trim()))
            : false;

    const conflictLetters = Array.isArray(q.conflictSelectedIndexes)
      ? q.conflictSelectedIndexes.map(i => String.fromCharCode(65 + i)).join('、')
      : '';
    const badge = q.answerConflict
      ? `<span class="bad" title="该题拿了满分，但你当时勾选的选项（${conflictLetters || '?'}）≠ 页面标注的正确项。已按页面标注保留，请人工核对是哪种情况（regrade/全员给分/标注错误）。">答案冲突：满分但勾选(${conflictLetters || '?'})≠标注，请核对</span>`
      : autoOK ? `<span class="good">已自动识别</span>` : `<span class="bad">待人工确认</span>`;
    const mergedImages = getQuestionImages(q);
    const sourceScreenshot = getQuestionSourceScreenshot(q);
    const compareImg = sourceScreenshot
      ? `<div class="review-image-compare"><div class="panel"><div class="meta" style="font-weight:600">原始截图 / source（仅预览）</div><div class="img"><img src="${sourceScreenshot}" alt="OCR source screenshot"></div></div><div class="panel"><div class="meta" style="font-weight:600">当前字段 / proposed</div><div class="qtext">${escapeHTML(q.qtext || '(无题干)')}</div></div></div>`
      : '';
    const imgs = mergedImages.map(src=>`<div class="img"><img src="${src}" alt=""></div>`).join('');
    const imageWarnNeeded = questionNeedsImageUpload(q);
    const remainingImageCount = Math.max(0, Number(q.expectedImageCount || 0) - mergedImages.length);

    const typeLabel =
      kind === 'choice'
        ? (q.isMulti ? '多选题' : '单选题')
        : kind === 'fill'
          ? '填空题'
          : kind === 'matching'
            ? '配对题（将拆成多道单选）'
            : kind === 'essay'
              ? '问答题'
              : (q.qTypeName ? `未知题型（${q.qTypeName}）` : '未知题型');

    card.innerHTML = `
      <div class="qhead">
        ${reviewEditorEnabled && qIsObject ? `<input class="review-check" type="checkbox" data-review-field="select" data-qidx="${qIndex}" ${reviewState.selected.has(q) ? 'checked' : ''} aria-label="选择 Q${q.num || qIndex + 1}">` : ''}
        <span class="qid">Q${q.num || qIndex + 1}</span>
        <span class="meta">${typeLabel} · ${badge}${reviewEntry ? ` · <span class="review-disposition badge ${reviewEntry.disposition === 'valid' ? 'ok' : 'wait'}">${reviewEntry.disposition}</span>` : ''}${reviewDecision ? ` · <span class="badge">${reviewDecisionLabel(reviewDecision)}</span>` : ''}</span>
        ${editMode ? `<button class="btn danger" data-act="delete-question" data-qidx="${qIndex}" data-testid="delete-question-btn" title="删除此题">删除</button>` : ''}
        ${reviewEditorEnabled && qIsObject ? `<select class="small" data-review-field="decision" data-qidx="${qIndex}" aria-label="Q${q.num || qIndex + 1} 审核决定"><option value="">审核决定…</option><option value="confirmed" ${reviewDecision === 'confirmed' ? 'selected' : ''}>confirmed · 确认</option><option value="needs_review" ${reviewDecision === 'needs_review' ? 'selected' : ''}>needs_review · 待核</option><option value="cannot_determine" ${reviewDecision === 'cannot_determine' ? 'selected' : ''}>cannot_determine · 无法判断</option></select>${canReviewEditQuestion(q) ? `<button class="btn" type="button" data-act="review-edit" data-qidx="${qIndex}">编辑题目</button>` : ''}` : ''}
      </div>
      <div class="qtext">${escapeHTML(q.qtext || '(无题干)')}</div>
      ${reviewEntry && reviewEntry.reasons && reviewEntry.reasons.length ? `<ul class="review-reasons">${reviewEntry.reasons.map(reason => `<li>${escapeHTML(reason)}</li>`).join('')}</ul>` : ''}
      ${reviewEditingKey === reviewKeyFor(d, qIndex) ? renderReviewEditForm(q, qIndex) : ''}
      ${compareImg}
      ${imgs ? `<div class="review-image-compare"><div class="panel"><div class="meta" style="font-weight:600">可导出图片</div>${imgs}</div></div>` : ''}
      ${imageWarnNeeded || ((q.uploadedImages || []).length > 0) ? `
        <div class="warnbox">
          <div class="title">检测到该题原始 HTML 有图片，但缺少可导出的 data 图片</div>
          <div class="meta">原始图片位数：${Number(q.expectedImageCount || 0)}；当前可导出：${mergedImages.length}；仍需补传：${remainingImageCount}。这里上传的图片会转成 base64 写入 JSON。</div>
          ${renderMissingImageSourceLinks(q.missingImageSources, qIndex)}
          <div class="row" style="margin-top:8px">
            <input type="file" accept="image/*" multiple data-kind="imgupload" data-testid="imgupload-input" data-qidx="${qIndex}">
            ${(q.uploadedImages || []).length ? `<button type="button" class="btn" data-act="clear-uploaded-images" data-testid="clear-uploaded-images-btn" data-qidx="${qIndex}">清空补传</button>` : ''}
          </div>
        </div>
      ` : ''}
      <div class="qbody"></div>
      <div class="meta">Source: ${escapeHTML((q.importedSource || `${d.sourcePrefix} – Q${q.sourceNum || q.num}`))}</div>
      ${renderAiAnswerMeta(q)}
    `;

    const body = card.querySelector('.qbody');

    if (kind === 'choice'){
      const ol = document.createElement('ol');
      ol.className = 'choices';
      Array.from({ length: Array.isArray(q.choices) ? q.choices.length : 0 }, (_, aidx) => q.choices[aidx]).forEach((rawChoice, aidx) => {
        const c = rawChoice && typeof rawChoice === 'object' ? rawChoice : { text: '', isCorrect: false };
        const li = document.createElement('li');
        li.className = 'choice';
        const inputType = q.isMulti ? 'checkbox' : 'radio';
        const name = `f${activeIdx}_q${qIndex}`;
        li.innerHTML = `
          <label>
            <input type="${inputType}"
                   name="${name}"
                   data-testid="choice-correct-input"
                    data-qidx="${qIndex}"
                    data-aidx="${aidx}"
                    ${c.isCorrect ? 'checked' : ''}>
            <span>${String.fromCharCode(65+aidx)}. ${escapeHTML(c.text)}</span>
          </label>
        `;
        ol.appendChild(li);
      });
      body.appendChild(ol);
    }else if (kind === 'fill'){
      const wrap = document.createElement('div');
      wrap.innerHTML = `<div class="meta" style="margin-top:8px">填空答案：同一空多个可用 <code>|</code> 分隔</div>`;
      const blanks = (q.blanks && q.blanks.length) ? q.blanks : [[]];

      blanks.forEach((ansArr, bidx) => {
        const row = document.createElement('div');
        row.className = 'row';
        row.style.gap = '8px';
        row.style.marginTop = '8px';
        row.innerHTML = `
          <span class="badge">${bidx+1}</span>
          <input type="text"
                 data-kind="fill"
                 data-testid="fill-answer-input"
                 data-qidx="${qIndex}"
                 data-bidx="${bidx}"
                 value="${escapeHTML((ansArr||[]).join(' | '))}"
                  style="flex:1;min-width:200px">
        `;
        wrap.appendChild(row);
      });

      body.appendChild(wrap);
    }else if (kind === 'matching'){
      const wrap = document.createElement('div');
      const pool = getMatchingChoicePool(q);
      wrap.innerHTML = `<div class="meta" style="margin-top:8px">将导出为 ${(q.pairs || []).length} 道单选题；每个左侧子项拆成 1 题，并继承原题图片。选项池大小：${pool.length}</div>`;
      const ol = document.createElement('ol');
      ol.className = 'choices';
      (q.pairs || []).forEach((pair, midx) => {
        const li = document.createElement('li');
        li.className = 'choice';
        li.innerHTML = `<div><strong>${escapeHTML((pair && pair.left) || `子项 ${midx+1}`)}</strong> <span class="meta">→ ${escapeHTML((pair && pair.right) || '(未识别)')}</span></div>`;
        ol.appendChild(li);
      });
      wrap.appendChild(ol);
      body.appendChild(wrap);
    }else{
      body.innerHTML = `<div class="meta" style="margin-top:8px">（此题型暂无标准答案可抽取）</div>`;
    }

    card.dataset.fileidx = String(activeIdx);
    list.appendChild(card);
  });
}

function applyReviewEditFromCard(d, qIndex, card){
  if (!reviewEditorEnabled || !d || !card || !d.parsed[qIndex] || !canReviewEditQuestion(d.parsed[qIndex])) return false;
  const q = d.parsed[qIndex];
  pushReviewUndo(d);
  const qtext = card.querySelector('[data-review-field="qtext"]');
  if (qtext) q.qtext = qtext.value;
  const kind = q.kind || 'choice';
  if (kind === 'choice') {
    const rows = Array.from(card.querySelectorAll('[data-review-choice-row]'));
    const originalChoices = q.choices.slice();
    const reorderedChoices = rows.map(row => {
      const originalIndex = Number(row.dataset.originalAidx);
      const choice = originalChoices[originalIndex] || { text: '', isCorrect: false };
      const textInput = row.querySelector('[data-review-field="choice-text"]');
      const answerInput = row.querySelector('[data-review-field="choice-answer"]');
      choice.text = textInput ? textInput.value : choice.text;
      choice.isCorrect = !!(answerInput && answerInput.checked);
      return choice;
    });
    q.choices.length = 0;
    reorderedChoices.forEach(choice => q.choices.push(choice));
  } else if (kind === 'fill') {
    q.blanks = Array.from(card.querySelectorAll('[data-review-field="fill-answer"]')).map(input => parseFillInputToAnswers(input.value));
  } else if (kind === 'matching') {
    const left = Array.from(card.querySelectorAll('[data-review-field="pair-left"]'));
    const right = Array.from(card.querySelectorAll('[data-review-field="pair-right"]'));
    const originalPairs = q.pairs.slice();
    q.pairs = left.map((input, index) => {
      const pair = originalPairs[index] && typeof originalPairs[index] === 'object' ? originalPairs[index] : {};
      pair.left = input.value;
      pair.right = right[index] ? right[index].value : '';
      return pair;
    });
  }
  reviewEditingKey = '';
  invalidateUiGeneration();
  return true;
}

function moveReviewStagedChoice(card, direction, aidx){
  if (!card) return;
  const rows = Array.from(card.querySelectorAll('.review-choice-row'));
  const row = rows.find(entry => Number(entry.dataset.originalAidx) === aidx);
  const currentIndex = row ? rows.indexOf(row) : -1;
  const target = direction === 'up' ? rows[currentIndex - 1] : rows[currentIndex + 1];
  if (!row || !target) return;
  if (direction === 'up') target.before(row); else target.after(row);
  Array.from(card.querySelectorAll('.review-choice-row')).forEach((entry, index) => {
    const up = entry.querySelector('[data-direction="up"]');
    const down = entry.querySelector('[data-direction="down"]');
    if (up) up.disabled = index === 0;
    if (down) down.disabled = index === rows.length - 1;
  });
}

function readFileAsDataURL(file){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
}

function blobToDataURL(blob){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('读取图片失败'));
    reader.readAsDataURL(blob);
  });
}

// 图片自动压缩：位图体积 >150KB 时缩到长边 ≤1200px、JPEG 85%，
// 防 base64 撑爆导出 JSON / localStorage。SVG/GIF 保持原样；压缩无收益就保留原图。
const IMG_MAX_DIM = 1200;
const IMG_COMPRESS_THRESHOLD = 150 * 1024;
async function compressImageBlobToDataURL(blob){
  const type = String((blob && blob.type) || '').toLowerCase();
  if (/svg|gif/.test(type) || !blob || blob.size <= IMG_COMPRESS_THRESHOLD) return blobToDataURL(blob);
  try{
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, IMG_MAX_DIM / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
    const compressed = canvas.toDataURL('image/jpeg', 0.85);
    const original = await blobToDataURL(blob);
    return compressed.length < original.length ? compressed : original;
  }catch(_e){
    return blobToDataURL(blob);
  }
}

function isLikelyImageBlob(blob, href){
  const type = String((blob && blob.type) || '').toLowerCase();
  if (/^image\//.test(type)) return true;
  if (/octet-stream|binary/.test(type)) return true;
  const path = String(href || '').split('?')[0].toLowerCase();
  return /\.(png|jpe?g|webp|gif|bmp|svg|avif)(?:$|#)/i.test(path);
}

async function fetchBlobOnce(href, opts){
  const res = await fetch(href, Object.assign({ method:'GET', credentials:'include', redirect:'follow', cache:'no-store' }, opts || {}));
  if (!res.ok) throw new Error(`下载失败（HTTP ${res.status}）`);
  const blob = await res.blob();
  if (!blob || !blob.size) throw new Error('返回内容为空');
  if (!isLikelyImageBlob(blob, href)){
    throw new Error(`返回内容不是图片：${String(blob.type || 'unknown')}`);
  }
  return blob;
}

function xhrBlobOnce(href, withCredentials){
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', href, true);
    xhr.responseType = 'blob';
    xhr.withCredentials = !!withCredentials;
    xhr.timeout = 20000;
    try{ xhr.setRequestHeader('Accept', 'image/*,*/*;q=0.8'); }catch(_e){}
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300){
        reject(new Error(`下载失败（HTTP ${xhr.status || 0}）`));
        return;
      }
      const blob = xhr.response;
      if (!blob || !blob.size){
        reject(new Error('返回内容为空'));
        return;
      }
      if (!isLikelyImageBlob(blob, href)){
        reject(new Error(`返回内容不是图片：${String(blob.type || 'unknown')}`));
        return;
      }
      resolve(blob);
    };
    xhr.onerror = () => reject(new Error('XHR 下载失败'));
    xhr.ontimeout = () => reject(new Error('XHR 下载超时'));
    xhr.send();
  });
}

async function importImageFromSourceURL(rawUrl){
  const candidates = buildImportImageUrlCandidates(rawUrl);
  if (!candidates.length) throw new Error('无效图片链接');
  if (/^data:image\//i.test(candidates[0])) return candidates[0];

  let lastErr = null;
  for (const href of candidates){
    const attempts = [
      () => fetchBlobOnce(href, { credentials:'include', mode:'cors' }),
      () => fetchBlobOnce(href, { credentials:'omit', mode:'cors' }),
      () => xhrBlobOnce(href, true),
      () => xhrBlobOnce(href, false)
    ];
    for (const run of attempts){
      try{
        const blob = await run();
        return await compressImageBlobToDataURL(blob);
      }catch(err){
        lastErr = err;
      }
    }
  }
  throw lastErr || new Error('无法直接抓取图片');
}

async function tryAutoImportMissingImagesForQuestion(q, guard = null){
  if (!q || !questionNeedsImageUpload(q)) {
    return { attempted: 0, imported: 0, failed: 0, errors: [] };
  }

  const sources = uniqueNonEmptyStrings(q.missingImageSources || []);
  if (!sources.length) {
    return { attempted: 0, imported: 0, failed: 0, errors: [] };
  }

  const uploaded = Array.isArray(q.uploadedImages) ? q.uploadedImages.slice() : [];
  const errors = [];
  let attempted = 0;
  let imported = 0;
  let failed = 0;

  for (const rawUrl of sources){
    if (!questionNeedsImageUpload({ ...q, uploadedImages: uploaded })) break;
    attempted += 1;
    try{
      const dataUrl = await importImageFromSourceURL(rawUrl);
      if (guard && !guard()) return { attempted, imported, failed, errors, cancelled: true };
      if (!uploaded.includes(dataUrl)) {
        uploaded.push(dataUrl);
        imported += 1;
      }
    }catch(err){
      failed += 1;
      errors.push({
        url: rawUrl,
        message: err && err.message ? String(err.message) : '未知错误'
      });
    }
  }

  q.uploadedImages = uploaded;
  return { attempted, imported, failed, errors };
}

async function autoImportMissingImagesForDataset(d, hooks = {}){
  if (!d || !d.parsedReady) {
    return { questionCount: 0, attempted: 0, imported: 0, failed: 0, errors: [] };
  }

  const questions = (d.parsed || []).filter(q => questionNeedsImageUpload(q) && uniqueNonEmptyStrings(q.missingImageSources || []).length > 0);
  let attempted = 0;
  let imported = 0;
  let failed = 0;
  const errors = [];

  for (let i = 0; i < questions.length; i++){
    const q = questions[i];
    const capturedGeneration = uiGeneration;
    if (typeof hooks.onQuestionStart === 'function') {
      try{ hooks.onQuestionStart({ dataset: d, question: q, index: i, total: questions.length }); }catch(_e){}
    }
    const res = await tryAutoImportMissingImagesForQuestion(q, () => uiGeneration === capturedGeneration && datasets.includes(d) && d.parsed.includes(q));
    if (res.cancelled) break;
    attempted += res.attempted;
    imported += res.imported;
    failed += res.failed;
    if (res.errors && res.errors.length) errors.push(...res.errors.map(e => ({ ...e, dataset: d.name, qnum: q.num })));
    if (typeof hooks.onQuestionDone === 'function') {
      try{ hooks.onQuestionDone({ dataset: d, question: q, index: i, total: questions.length, result: res }); }catch(_e){}
    }
  }

  return { questionCount: questions.length, attempted, imported, failed, errors };
}

/* 事件：改答案 / 补传图片 */
list.addEventListener('change', async (e) => {
  const t = e.target;
  if (!(t instanceof HTMLInputElement)) return;
  // D2 staged fields are intentionally detached from the parsed object until
  // the user presses Apply. The legacy answer handler must not consume them.
  if (t.dataset.reviewField) return;

  const fileCard = t.closest('.card');
  if (!fileCard) return;
  const fidx = Number(fileCard.dataset.fileidx);
  const d = datasets[fidx];
  if (!d || !d.parsedReady) return;
  if (reviewEditorEnabled) pushReviewUndo(d);
  invalidateUiGeneration();

  if (t.dataset.kind === 'imgupload'){
    const qidx = Number(t.dataset.qidx);
    const q = d.parsed[qidx];
    if (!q) return;
    const files = Array.from(t.files || []).filter(file => {
      return /^image\//i.test(file.type || '') || /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(file.name || '');
    });
    if (!files.length) return;

    const capturedGeneration = uiGeneration;
    const capturedDataset = d;
    const capturedQuestion = q;
    const urls = (await Promise.all(files.map(compressImageBlobToDataURL))).filter(Boolean);
    if (uiGeneration !== capturedGeneration || datasets[fidx] !== capturedDataset || capturedDataset.parsed[qidx] !== capturedQuestion || datasets[activeIdx] !== capturedDataset) {
      setTopStatus('补图结果已丢弃：题目或编辑器状态已变化。', true);
      return;
    }
    q.uploadedImages = urls;
    renderQuestions(d);
    renderFileTable();
    if (fidx === activeIdx) setDatasetStatusMessage(d);
    return;
  }

  if (t.type !== 'radio' && t.type !== 'checkbox') return;

  const qidx = Number(t.dataset.qidx);
  const aidx = Number(t.dataset.aidx);
  const q = d.parsed[qidx];
  if (!q || q.kind !== 'choice') return;

  if (q.isMulti){
    q.choices[aidx].isCorrect = t.checked;
    if (!registeredParsedQuestions.has(q)) {
      normalizeChoiceQuestionShape(q);
      if (!q.isMulti) renderQuestions(d);
    }
  }else{
    q.choices.forEach((c,i)=> c.isCorrect = (i===aidx));
    const group = list.querySelectorAll(`input[name="${t.name}"]`);
    group.forEach((el,i)=> el.checked = (i===aidx));
  }
});

if (reviewEditorEnabled) {
  list.addEventListener('change', (e) => {
    const t = e.target;
    const field = t && t.dataset ? t.dataset.reviewField : '';
    if (field !== 'select' && field !== 'decision') return;
    const card = t.closest('.card');
    if (!card) return;
    const fidx = Number(card.dataset.fileidx);
    const d = datasets[fidx];
    const qidx = Number(t.dataset.qidx);
    const q = d && d.parsed ? d.parsed[qidx] : null;
    if (!d || !q || d !== datasets[activeIdx]) return;
    const state = getReviewState(d);
    if (field === 'select') {
      if (t.checked) state.selected.add(q); else state.selected.delete(q);
      if (reviewSelectionCountEl) reviewSelectionCountEl.textContent = `已选 ${state.selected.size} 题`;
      return;
    }
    pushReviewUndo(d);
    if (t.value) state.decisions.set(q, t.value); else state.decisions.delete(q);
    invalidateUiGeneration();
    renderReviewPanel(d);
    renderQuestions(d);
  });
}

list.addEventListener('click', async (e) => {
  if (reviewEditorEnabled) {
    const reviewEditBtn = e.target.closest('button[data-act="review-edit"]');
    const reviewApplyBtn = e.target.closest('button[data-act="review-apply"]');
    const reviewCancelBtn = e.target.closest('button[data-act="review-cancel"]');
    const reviewMoveBtn = e.target.closest('button[data-act="review-staged-move"]');
    const card = e.target.closest('.card');
    if (reviewMoveBtn && card) {
      moveReviewStagedChoice(card, reviewMoveBtn.dataset.direction, Number(reviewMoveBtn.dataset.aidx));
      return;
    }
    if ((reviewEditBtn || reviewApplyBtn || reviewCancelBtn) && card) {
      const fidx = Number(card.dataset.fileidx);
      const d = datasets[fidx];
      const qidx = Number((reviewEditBtn || reviewApplyBtn || reviewCancelBtn).dataset.qidx);
      if (!d || d !== datasets[activeIdx] || !d.parsed[qidx]) return;
      if (reviewEditBtn) {
        reviewEditingKey = reviewKeyFor(d, qidx);
        renderQuestions(d);
        return;
      }
      if (reviewCancelBtn) {
        reviewEditingKey = '';
        renderQuestions(d);
        return;
      }
      if (reviewApplyBtn && applyReviewEditFromCard(d, qidx, card)) {
        renderReviewPanel(d);
        renderQuestions(d);
        renderFileTable();
        setDatasetStatusMessage(d);
        updateExportButtons();
      }
      return;
    }
  }
  const importLink = e.target.closest('a[data-act="import-missing-image"]');
  if (importLink){
    e.preventDefault();
    const fileCard = importLink.closest('.card');
    if (!fileCard) return;
    const fidx = Number(fileCard.dataset.fileidx);
    const d = datasets[fidx];
    if (!d || !d.parsedReady) return;
    const qidx = Number(importLink.dataset.qidx);
    const q = d.parsed[qidx];
    if (!q) return;

    const rawUrl = String(importLink.dataset.src || importLink.getAttribute('href') || '');
    if (reviewEditorEnabled) pushReviewUndo(d);
    invalidateUiGeneration();
    const capturedGeneration = uiGeneration;
    const capturedDataset = d;
    const capturedQuestion = q;
    const oldText = importLink.textContent;
    importLink.textContent = '正在导入图片…';
    importLink.style.pointerEvents = 'none';
    try{
      const dataUrl = await importImageFromSourceURL(rawUrl);
      if (uiGeneration !== capturedGeneration || datasets[fidx] !== capturedDataset || capturedDataset.parsed[qidx] !== capturedQuestion || datasets[activeIdx] !== capturedDataset) {
        setTopStatus('图片结果已丢弃：题目或编辑器状态已变化。', true);
        return;
      }
      const uploaded = Array.isArray(q.uploadedImages) ? q.uploadedImages.slice() : [];
      if (!uploaded.includes(dataUrl)) uploaded.push(dataUrl);
      q.uploadedImages = uploaded;
      renderQuestions(d);
      renderFileTable();
      if (fidx === activeIdx) setDatasetStatusMessage(d);
    }catch(err){
      console.warn('import missing image failed:', err);
      const msg = err && err.message ? String(err.message) : '未知错误';
      importLink.textContent = `${oldText}（自动导入失败）`;
      importLink.style.pointerEvents = '';
      importLink.title = `自动导入失败：${msg}`;
      if (fidx === activeIdx) {
        setTopStatus(`自动导入图片失败：${msg}。该站点可能允许浏览器下载，但阻止脚本直接读取；请改用下方上传框导入刚下载的图片。`, true);
      }
    }
    return;
  }

  const delQBtn = e.target.closest('button[data-act="delete-question"]');
  if (delQBtn) {
    const qidx = Number(delQBtn.dataset.qidx);
    const d = datasets[activeIdx];
    if (!editMode || !d || !Array.isArray(d.parsed) || !Number.isInteger(qidx) || qidx < 0 || qidx >= d.parsed.length) return;
    const record = d.parsed[qidx];
    const qNum = String(record && typeof record === 'object' && !Array.isArray(record) && record.num != null ? record.num : (qidx + 1));
    const deleteNotice = reviewEditorEnabled
      ? '此操作可通过“撤销”恢复（仅当前会话）。'
      : '此操作不可撤销。';
    if (!confirm(`确定删除 Q${qNum}？${deleteNotice}`)) return;
    if (reviewEditorEnabled) pushReviewUndo(d);
    invalidateUiGeneration();
    d.parsed.splice(qidx, 1);
    renderQuestions(d);
    renderFileTable();
    updateExportButtons();
    return;
  }

  const btn = e.target.closest('button[data-act="clear-uploaded-images"]');
  if (!btn) return;
  const qidx = Number(btn.dataset.qidx);
  const fileCard = btn.closest('.card');
  if (!fileCard) return;
  const fidx = Number(fileCard.dataset.fileidx);
  const d = datasets[fidx];
  if (!d || !d.parsedReady) return;
  const q = d.parsed[qidx];
  if (!q) return;
  if (reviewEditorEnabled) pushReviewUndo(d);
  invalidateUiGeneration();
  q.uploadedImages = [];
  renderQuestions(d);
  renderFileTable();
  if (fidx === activeIdx) setDatasetStatusMessage(d);
});

list.addEventListener('input', (e) => {
  const t = e.target;
  if (!(t instanceof HTMLInputElement)) return;
  if (t.dataset.kind !== 'fill') return;

  const qidx = Number(t.dataset.qidx);
  const bidx = Number(t.dataset.bidx);
  const fileCard = t.closest('.card');
  if (!fileCard) return;
  const fidx = Number(fileCard.dataset.fileidx);
  const d = datasets[fidx];
  if (!d || !d.parsedReady) return;
  if (reviewEditorEnabled) pushReviewUndo(d);
  invalidateUiGeneration();

  const q = d.parsed[qidx];
  if (!q || q.kind !== 'fill') return;

  q.blanks = q.blanks || [];
  q.blanks[bidx] = parseFillInputToAnswers(t.value);
});

function collectFromUI(d){
  if (!d || datasets[activeIdx] !== d) return;

  // 选择题
  list.querySelectorAll('input[type=radio],input[type=checkbox]').forEach(inp=>{
    if (inp.dataset.reviewField) return;
    const qidx = Number(inp.dataset.qidx);
    const aidx = Number(inp.dataset.aidx);
    const q = d.parsed[qidx];
    if (!q || q.kind !== 'choice') return;

    if (q.isMulti){
      q.choices[aidx].isCorrect = inp.checked;
    }else if (inp.checked){
      q.choices.forEach((c,i)=> c.isCorrect = (i===aidx));
    }
  });

  // 填空题
  list.querySelectorAll('input[data-kind="fill"]').forEach(inp=>{
    const qidx = Number(inp.dataset.qidx);
    const bidx = Number(inp.dataset.bidx);
    const q = d.parsed[qidx];
    if (!q || q.kind !== 'fill') return;
    if (registeredParsedQuestions.has(q)) {
      const rendered = Array.isArray(q.blanks && q.blanks[bidx]) ? q.blanks[bidx].join(' | ') : '';
      if (inp.value === rendered) return;
    }
    q.blanks = q.blanks || [];
    q.blanks[bidx] = parseFillInputToAnswers(inp.value);
  });
}




/* -------------------- 导出 QUESTION_BANK -------------------- */










function buildUniqueMergedQuestionBank(){
  const collections = [];
  for (const d of datasets){
    if (!d.parsedReady) continue;
    collectFromUI(d);
    collections.push(buildQuestionBank(d.parsed, d.prefix, d.sourcePrefix));
  }
  return buildUniqueMergedQuestionBankFromCollections(collections);
}


function sanitizeDisplayHref(raw){
  const s = String(raw || '').trim();
  if (!s) return '';
  if (/^javascript:/i.test(s)) return '';
  return s;
}

function buildImportImageUrlCandidates(raw){
  const href = sanitizeDisplayHref(raw);
  if (!href) return [];
  const out = [];
  const push = (u) => {
    const s = sanitizeDisplayHref(u);
    if (!s) return;
    if (!out.includes(s)) out.push(s);
  };
  push(href);
  try{
    const u = new URL(href, location.href);
    const path = u.pathname || '';
    const isCanvasLike = /(?:^|\.)instructure\.com$/i.test(u.hostname) || /\/files\/\d+\//.test(path);
    if (isCanvasLike){
      const mScopedPreview = path.match(/^(.*\/files\/\d+)\/preview\/?$/i);
      if (mScopedPreview){
        const scoped = new URL(u.href);
        scoped.pathname = `${mScopedPreview[1]}/download`;
        if (!scoped.searchParams.has('download_frd')) scoped.searchParams.set('download_frd', '1');
        push(scoped.toString());
      }
      const mAnyFile = path.match(/\/files\/(\d+)(?:\/(preview|download))?\/?$/i);
      if (mAnyFile){
        const fileId = mAnyFile[1];
        const direct = new URL(u.origin + `/files/${fileId}/download`);
        if (u.searchParams.has('verifier')) direct.searchParams.set('verifier', u.searchParams.get('verifier'));
        direct.searchParams.set('download_frd', '1');
        push(direct.toString());
      }
      if (/\/preview\/?$/i.test(path)){
        const alt = new URL(u.href);
        alt.pathname = alt.pathname.replace(/\/preview\/?$/i, '/download');
        if (!alt.searchParams.has('download_frd')) alt.searchParams.set('download_frd', '1');
        push(alt.toString());
      }
    }
  }catch(_e){}
  return out;
}

function renderMissingImageSourceLinks(sources, qIndex){
  const arr = Array.isArray(sources) ? sources.filter(Boolean) : [];
  if (!arr.length) return '';
  const items = arr.map(src => {
    const text = escapeHTML(src);
    const href = sanitizeDisplayHref(src);
    return href
      ? `<div><a href="${escapeHTML(href)}" data-act="import-missing-image" data-qidx="${qIndex}" data-src="${escapeHTML(href)}" title="点击后优先尝试直接导入到当前题目；Canvas 的 /preview 链接会自动改写成可抓取的 /download 链接；若目标站点仍禁止脚本读取，则不会再自动打开下载链接，请改用下方上传框导入刚下载的图片">${text}</a></div>`
      : `<div>${text}</div>`;
  }).join('');
  return `<details style="margin-top:6px"><summary class="meta">查看缺失图片来源</summary><div class="meta" style="margin-top:6px;word-break:break-all">${items}</div></details>`;
}

function escapeHTML(s){
  return (s||'').replace(/[&<>"']/g,m=>({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[m]));
}

/* -------------------- 拖拽调整宽度逻辑 -------------------- */
(function(){
  const split = document.querySelector('.split');
  const resizer = document.getElementById('dragHandle');
  let isResizing = false;

  if(!split || !resizer) return;

  resizer.addEventListener('mousedown', (e) => {
    isResizing = true;
    resizer.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    const splitRect = split.getBoundingClientRect();
    let newWidth = e.clientX - splitRect.left;
    if (newWidth < 300) newWidth = 300;
    if (newWidth > 800) newWidth = 800;
    split.style.setProperty('--lw', newWidth + 'px');
  });

  document.addEventListener('mouseup', () => {
    if(isResizing){
      isResizing = false;
      resizer.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  });
})();






appContext = {
  get datasets() { return datasets; },
  get activeIdx() { return activeIdx; },
  set activeIdx(value) { invalidateUiGeneration(); activeIdx = value; },
  get list() { return list; },
  get fileTableBody() { return fileTableBody; },
  get out() { return out; },
  get datasetKey() { return datasetKey; },
  set datasetKey(value) { datasetKey = value; },
  get parseOne() { return parseOne; },
  set parseOne(value) { parseOne = value; },
  get renderQuestions() { return renderQuestions; },
  set renderQuestions(value) { renderQuestions = value; },
  get updateActiveUI() { return updateActiveUI; },
  set updateActiveUI(value) { updateActiveUI = value; },
  get renderFileTable() { return renderFileTable; },
  set renderFileTable(value) { renderFileTable = value; },
  upsertDatasets,
  updateExportButtons,
  setTopStatus,
  guessMetaFromFilename,
  escapeHTML,
};

if (typeof window !== 'undefined') {
  window.__QB_EXTRACTOR_READY__ = true;
}
}
