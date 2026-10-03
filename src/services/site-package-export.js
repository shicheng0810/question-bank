// 单文件题库导出（方案乙后唯一的发布物形态）。
// 站点发布 = scripts/build-pages.mjs 生成目录页 + 每题库一个单文件播放器；
// 原 buildSitePublishZip（多文件 SPA 打包）已随 SPA 一并退役。
import legacyTemplate from '../templates/question-bank-template.html?raw';
import { encryptQuestionBankPayload } from '../lib/qbpack.js';
import { slugifyBankId } from '../lib/site-package.js';
import { safeJSONStringForScript as escapeJSONForScript } from '../lib/testable-core.js';

function safeJSONStringForScript(value) {
  // Single source of truth for the <script>-literal escaping lives in testable-core.js.
  return escapeJSONForScript(JSON.stringify(value));
}

const LEGACY_MARKER = '__QUESTION_BANK_JSON__';
const NS_MARKER = '__BANK_STORAGE_NS__';
const FB_MARKER = '__FEEDBACK_CONFIG_JSON__';
const UI_MARKER = '__UI_FEATURES_JSON__';

function assertTemplateMarker(template, marker) {
  if (!template.includes(marker)) {
    throw new Error(`Unable to locate template marker: ${marker}`);
  }
}

export async function buildLegacyQuestionBankHtml(questions, options = {}) {
  assertTemplateMarker(legacyTemplate, LEGACY_MARKER);
  assertTemplateMarker(legacyTemplate, UI_MARKER);
  const payload = options.mode === 'protected'
    ? { mode: 'protected', envelope: JSON.parse(await encryptQuestionBankPayload(questions, options.password || '')) }
    : (Array.isArray(questions) ? questions : []);
  // localStorage 命名空间 = 题库 id：同域名/同机器上多个题库单文件互不串档。
  // 没有 bankId 时回退共享的 "amt"（与历史导出兼容；注意 slugifyBankId 对空串有默认值，须先判空）。
  const rawBankId = String(options.bankId || '').trim();
  const ns = rawBankId ? (slugifyBankId(rawBankId) || 'amt') : 'amt';
  // 离线单文件无后端：endpoint 恒空 → 反馈走 mailto（有 feedbackEmail 时）/剪贴板降级
  const feedbackConfig = {
    endpoint: '',
    email: String(options.feedbackEmail || '').trim(),
    turnstile_site_key: '',
    app_version: String(options.appVersion || 'export'),
  };
  // 离线单文件的 UI 取舍：去掉反馈/报错入口 + 新手教程、界面锁英文；Button Guide 保留。
  // （可被 options.uiFeatures 覆盖，便于将来需要时放开。）
  const uiFeatures = Object.assign(
    { feedback: false, tutorial: false, languages: ['en'] },
    (options.uiFeatures && typeof options.uiFeatures === 'object') ? options.uiFeatures : {},
  );
  // 注意：本文件的 safeJSONStringForScript 入参是“对象”（内部已 JSON.stringify）；
  // 故这里直接传对象，不要再 JSON.stringify（早期 FB 行多套了一层，会注入成字符串而失效——已一并修正）。
  // 用函数式替换 (() => value)：单文件把题目数组内联进去，题干里若有 $&、$'、$$ 等会被
  // String.replace 当成替换模式而损坏内容；函数式替换按字面插入。
  const lit = (s) => () => s;
  return legacyTemplate
    .replace(LEGACY_MARKER, lit(safeJSONStringForScript(payload)))
    .replace(NS_MARKER, lit(ns))
    .replace(FB_MARKER, lit(safeJSONStringForScript(feedbackConfig)))
    .replace(UI_MARKER, lit(safeJSONStringForScript(uiFeatures)));
}
