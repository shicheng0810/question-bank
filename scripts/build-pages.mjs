// 方案乙站点构建：纯静态「目录页 + 每个题库一个单文件全平铺播放器」。
//
// - 每个可发布题库 → <id>.html（与提取器导出同模板：全部题目一页、逐题提交、错题/收藏），
//   题库数据构建时内嵌，无需 fetch/manifest，离线可用、任意子路径可托管。
// - index.html → 题库目录页（静态生成，带各题库的本地做题进度提示）。
// - 每个播放器注入独立 localStorage 命名空间（__BANK_STORAGE_NS__ = 题库 id），
//   同域名多题库互不串档。
//
// 输出 docs/（GitHub Pages「Deploy from a branch → /docs」兼容），Cloudflare Pages 用
// `npm run deploy:cf` 直传同一目录。PAGES_OUT 可覆盖输出目录。

import { writeFileSync, mkdirSync, readFileSync, realpathSync, readdirSync } from 'node:fs';
import { pinBrowserModuleReferences } from './browser-module-pins.mjs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { beginSafeBuild, recoverInterruptedBuild, validateBuildInputs } from './build-pages-safety.mjs';
import { validateBankContent } from '../src/domain/question/bank-content.js';
import { sha256Hex, canonicalContentBytes } from '../src/domain/app-data/canonical.js';

// testable-core 的合并 key 归一化要用 DOM 剥 HTML（cleanHTML），Node 下用 jsdom 垫片
const dom = new JSDOM('');
globalThis.document = dom.window.document;
globalThis.DOMParser = dom.window.DOMParser;

const { buildUniqueMergedQuestionBankFromCollections, safeJSONStringForScript } = await import('../src/lib/testable-core.js');

const ROOT = process.cwd();
const TARGET_OUT = path.resolve(ROOT, process.env.PAGES_OUT || 'docs');
const MARKER = '__QUESTION_BANK_JSON__';
const NS_MARKER = '__BANK_STORAGE_NS__';
const FB_MARKER = '__FEEDBACK_CONFIG_JSON__';
const UI_MARKER = '__UI_FEATURES_JSON__';
const ACCOUNT_UI_MARKER = '__QB_ACCOUNT_V2_UI__';
const TEMPLATE_PATH = path.join(ROOT, 'src/templates/question-bank-template.html');
const ACCOUNT_V2_SOURCE_PATH = path.join(ROOT, 'src/browser/account-v2.js');
const LEGACY_MIGRATION_SOURCE_PATH = path.join(ROOT, 'src/browser/legacy-migration-client.js');
const LOCAL_STORAGE_MIGRATION_SOURCE_PATH = path.join(ROOT, 'src/browser/local-storage-migration.js');
const ACCOUNT_V2_UI_ENABLED = process.env.QB_ACCOUNT_V2_UI === '1';
const V2_CONTENT_MANIFEST_PATH = process.env.QB_V2_BANK_CONTENT_MANIFEST ? path.resolve(ROOT, process.env.QB_V2_BANK_CONTENT_MANIFEST) : null;
const DATA_V2_ENABLED = ACCOUNT_V2_UI_ENABLED && !!V2_CONTENT_MANIFEST_PATH;
const NATIVE_HISTORY_SNAPSHOTS_ENABLED = process.env.QB_NATIVE_HISTORY_SNAPSHOTS === '1';
const SNAPSHOT_BASELINE_INIT_ENABLED=process.env.QB_SNAPSHOT_BASELINE_INIT==='1';
const NATIVE_ONLY_MODE = process.env.QB_NATIVE_ONLY === '1';
if (NATIVE_HISTORY_SNAPSHOTS_ENABLED && !DATA_V2_ENABLED) throw new Error('Native history requires registered v2 storage');
if (NATIVE_ONLY_MODE && (!DATA_V2_ENABLED || !NATIVE_HISTORY_SNAPSHOTS_ENABLED)) throw new Error('Native-only mode requires account v2 and native history snapshots');
const V2_RUNTIME_BANKS = [];
const MANIFEST_PATH = process.env.BANKS_MANIFEST
  ? path.resolve(ROOT, process.env.BANKS_MANIFEST)
  : path.join(ROOT, 'public/banks/index.json');
const BANKS_ROOT = process.env.BANKS_ROOT ? path.resolve(ROOT, process.env.BANKS_ROOT) : path.join(ROOT, 'public');
const ALLOW_EMPTY = process.env.ALLOW_EMPTY_SITE === '1';

function positiveIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error(`${name} must be a positive safe integer`);
  return Number(raw);
}

const PRODUCTION_API_ORIGIN = new URL('https://question-bank-78u.pages.dev/api').origin;

function normalizeApiBase(value, label) {
  const raw = String(value || '').trim();
  if (!raw || raw.startsWith('//') || raw.includes('\\')) throw new Error(`${label} must be a non-empty same-origin path or absolute http(s) API base`);
  if (raw.startsWith('/')) {
    const url = new URL(raw, 'https://same-origin.invalid');
    if (url.search || url.hash) throw new Error(`${label} must not contain a query or fragment`);
    return `${url.pathname.replace(/\/+$/, '') || '/'}`;
  }
  let url;
  try { url = new URL(raw); } catch (_error) { throw new Error(`${label} must be a valid http(s) URL`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} must be an http(s) origin/path without credentials, query, or fragment`);
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function normalizeFeedbackEndpoint(value, label) {
  const endpoint = normalizeApiBase(value, label);
  if (!endpoint.endsWith('/feedback')) throw new Error(`${label} must end in /feedback`);
  return endpoint;
}

function isProductionOrigin(value) {
  return value.startsWith('/') ? false : new URL(value).origin === PRODUCTION_API_ORIGIN;
}

function resolveBuildEnvironment() {
  const name = process.env.QB_BUILD_ENV;
  if (!['local', 'preview', 'production'].includes(name)) {
    throw new Error('QB_BUILD_ENV must be explicitly local, preview, or production; refusing an ambiguous release build');
  }
  const feedbackEndpoint = normalizeFeedbackEndpoint(
    process.env.FEEDBACK_ENDPOINT || (name === 'production' ? 'https://question-bank-78u.pages.dev/api/feedback' : '/api/feedback'),
    'FEEDBACK_ENDPOINT',
  );
  const inferredApiBase = feedbackEndpoint.slice(0, -'/feedback'.length) || '/api';
  const effectiveApiBase = normalizeApiBase(process.env.QB_API_BASE || inferredApiBase, 'QB_API_BASE');
  if (name !== 'production' && (isProductionOrigin(feedbackEndpoint) || isProductionOrigin(effectiveApiBase))) {
    throw new Error(`${name} build may not use the production API origin`);
  }
  const schemaVersion = positiveIntegerEnv('QB_DATA_SCHEMA_VERSION', 2);
  const minimumSchemaVersion = positiveIntegerEnv('QB_MINIMUM_DATA_SCHEMA_VERSION', 1);
  if (minimumSchemaVersion > schemaVersion) throw new Error('QB_MINIMUM_DATA_SCHEMA_VERSION cannot exceed QB_DATA_SCHEMA_VERSION');
  return {
    name,
    feedbackEndpoint,
    effectiveApiBase,
    compatibility: {
      environment: name,
      clientProtocolVersion: positiveIntegerEnv('QB_CLIENT_PROTOCOL_VERSION', 2),
      dataSchemaVersion: schemaVersion,
      minimumSupportedDataSchemaVersion: minimumSchemaVersion,
      unknownDataVersionPolicy: 'read-only-or-refuse',
      resumeStateSchemaVersions:[1,2],
      snapshotBaselineInitializationEnabled:SNAPSHOT_BASELINE_INIT_ENABLED,
      effectiveApiBase,
    },
  };
}

const BUILD_ENV = resolveBuildEnvironment();
const INPUT_PLAN = validateBuildInputs({
  root: ROOT,
  output: TARGET_OUT,
  manifestPath: MANIFEST_PATH,
  banksRoot: BANKS_ROOT,
  templatePath: TEMPLATE_PATH,
  allowEmpty: ALLOW_EMPTY,
  markers: [MARKER, NS_MARKER, FB_MARKER, UI_MARKER, ACCOUNT_UI_MARKER],
});
if (process.env.QB_BUILD_RECOVER_OWNER_TOKEN) {
  const recovered = recoverInterruptedBuild(INPUT_PLAN, process.env.QB_BUILD_RECOVER_OWNER_TOKEN);
  console.log(`Recovered prior output via explicit owner token; journal archived at ${recovered.archive}`);
  process.exit(0);
}
const BUILD = beginSafeBuild(INPUT_PLAN, {
  failDuringSwapForTest: process.env.QB_BUILD_TEST_FAIL_DURING_SWAP === '1',
  pauseAfterBackupForTest: process.env.QB_BUILD_TEST_PAUSE_AFTER_BACKUP_FILE,
});
process.on('exit', () => BUILD.abort());
const OUT = BUILD.stagingOutput;
// Test-only fault seam: proves a failure after staging is created cannot erase
// the last good release. It is intentionally inert unless a test names it.
if (process.env.QB_BUILD_TEST_FAIL_AFTER_STAGE === '1') {
  throw new Error('intentional build-pages failure after staging creation');
}
// 站点（player.html / local.html）：所有功能开启（反馈/报错、新手教程、三语）。
// 离线单文件导出走另一条路径（site-package-export.js），那里会关掉这些。
// ☕ 打赏：默认 PayPal.Me（美国受众最顺手）。把 handle 换成你的 PayPal.Me 用户名即可全站生效。
// provider 决定金额能否预填：'paypal' 时三档会拼成 paypal.me/<handle>/<amount><currency>（如 /5USD）。
// env 覆盖：DONATION_HANDLE=用户名、DONATION_URL=完整链接、DONATION_PROVIDER=paypal|bmc|stripe|other、DONATION_OFF=1 全站关闭。
const DONATION_HANDLE = process.env.DONATION_HANDLE || 'LiuShicheng';
const DONATION_PROVIDER = process.env.DONATION_PROVIDER || 'paypal';
const DONATION_DEFAULT_URL = {
  paypal: `https://www.paypal.me/${DONATION_HANDLE}`,
  bmc: `https://www.buymeacoffee.com/${DONATION_HANDLE}`,
  stripe: '', other: '',
}[DONATION_PROVIDER] || '';
const DONATION = process.env.DONATION_OFF === '1' ? null : {
  provider: DONATION_PROVIDER,
  url: process.env.DONATION_URL || DONATION_DEFAULT_URL,
  amounts: [5, 10, 20],   // 三档预设金额（仅 paypal 会拼进链接；其它平台仅作标签展示）
  currency: 'USD',
};
const UI_FEATURES = { feedback: true, tutorial: true, languages: ['en', 'zh', 'es'], donation: DONATION };
// 反馈配置（构建时由环境变量注入；未设则 endpoint 为空 → 前端降级为 mailto/剪贴板，按钮不失效）
const FEEDBACK_CONFIG = {
  // 默认指向 CF Pages 的反馈 Function（GitHub 镜像也跨域打到这里，CORS 已放行）。
  // 反馈 → 站主 Telegram（密钥存在 CF secret）。可用 env 覆盖。
  endpoint: BUILD_ENV.feedbackEndpoint,
  email: process.env.FEEDBACK_EMAIL || '',                // mailto 降级收件人（选填）
  turnstile_site_key: process.env.TURNSTILE_SITE_KEY || '', // 选填：配了才显示验证码
  app_version: process.env.GIT_SHA || process.env.APP_VERSION || 'site',
  build_environment: BUILD_ENV.name,
  effective_api_base: BUILD_ENV.effectiveApiBase,
  client_protocol_version: BUILD_ENV.compatibility.clientProtocolVersion,
  data_schema_version: BUILD_ENV.compatibility.dataSchemaVersion,
  minimum_supported_data_schema_version: BUILD_ENV.compatibility.minimumSupportedDataSchemaVersion,
  unknown_data_version_policy: BUILD_ENV.compatibility.unknownDataVersionPolicy,
};
// 登录/历史 API 基址：与反馈同一组 CF Function（/auth、/history），从 endpoint 推导。
const API_BASE = BUILD_ENV.effectiveApiBase;

const template = INPUT_PLAN.template;

function escapeHTML(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function playerHtml(payload, bankId) {
  const ns = /^[A-Za-z0-9_-]{1,64}$/.test(String(bankId)) ? String(bankId) : 'amt';
  // 本地导入题库（local.html）去掉反馈/报错：那些反馈会进站主 Telegram，但访客自己导入的
  // 私有题库报错没有意义、只会变噪声。站点发布的题库（remote = player.html）保留反馈。
  const isLocal = payload && payload.mode === 'local-bank';
  const uiFeatures = isLocal ? Object.assign({}, UI_FEATURES, { feedback: false, donation: null }) : UI_FEATURES;
  // <script> 内联转义的唯一权威实现在 testable-core（不再维护镜像拷贝）。
  // 用函数式替换 (() => value)：否则注入值里的 $&、$`、$'、$$ 等会被 String.replace 当成替换模式、
  // 破坏内容（题目文本里出现这些字符就会被改坏）。
  const lit = (s) => () => s;
  return template
    .replace(MARKER, lit(safeJSONStringForScript(JSON.stringify(payload))))
    .replace(NS_MARKER, lit(ns))
    .replace(FB_MARKER, lit(safeJSONStringForScript(JSON.stringify(FEEDBACK_CONFIG))))
    .replace(UI_MARKER, lit(safeJSONStringForScript(JSON.stringify(uiFeatures))))
    .replace(ACCOUNT_UI_MARKER, lit(ACCOUNT_V2_UI_ENABLED ? 'true' : 'false'))
    .replace('/*QB_NATIVE_SYNC_IMPORT__*/', lit(NATIVE_ONLY_MODE ? "import('./browser/native-history-sync.js')" : "Promise.reject(Object.assign(new Error('NATIVE_SYNC_NOT_BUILT'),{code:'NATIVE_SYNC_NOT_BUILT'}))"))
    .replace('</head>', lit(`<script>globalThis.QB_DATA_V2_CONFIG=${safeJSONStringForScript(JSON.stringify({ enabled: DATA_V2_ENABLED, historySnapshotsEnabled:NATIVE_HISTORY_SNAPSHOTS_ENABLED, resumeStateSchemaVersions:[1,2], snapshotBaselineInitializationEnabled:SNAPSHOT_BASELINE_INIT_ENABLED, nativeOnlyMode:NATIVE_ONLY_MODE, manifest: DATA_V2_ENABLED ? 'banks/v2/manifest.json' : null, banks: V2_RUNTIME_BANKS, accountApiBase: API_BASE }))};</script></head>`));
}

const manifest = INPUT_PLAN.manifest;
mkdirSync(OUT, { recursive: true });

mkdirSync(path.join(OUT, 'banks'), { recursive: true });
mkdirSync(path.join(OUT, 'browser'), { recursive: true });
writeFileSync(path.join(OUT, 'browser/account-v2.js'), readFileSync(ACCOUNT_V2_SOURCE_PATH));
if (!NATIVE_ONLY_MODE) {
  writeFileSync(path.join(OUT, 'browser/legacy-migration-client.js'), readFileSync(LEGACY_MIGRATION_SOURCE_PATH));
  writeFileSync(path.join(OUT, 'browser/local-storage-migration.js'), readFileSync(LOCAL_STORAGE_MIGRATION_SOURCE_PATH));
}
// Display safety is always bundled, independent of account/storage rollout flags.
const { build: buildHtmlSanitizer } = await import('vite');
await buildHtmlSanitizer({configFile:false,root:ROOT,...(NATIVE_ONLY_MODE?{publicDir:false}:{}),logLevel:'warn',build:{outDir:path.join(OUT,'browser'),emptyOutDir:false,minify:true,lib:{entry:path.join(ROOT,'src/player/html-sanitizer-entry.js'),formats:['es'],fileName:()=> 'html-sanitizer.js'},rollupOptions:{output:{inlineDynamicImports:true}}}});
if (DATA_V2_ENABLED) {
  const sourceDirectory = path.dirname(realpathSync(V2_CONTENT_MANIFEST_PATH));
  const registered = JSON.parse(readFileSync(V2_CONTENT_MANIFEST_PATH, 'utf8'));
  if (registered.format !== 'qb-site-registered-banks-v1' || registered.schemaVersion !== 1 || !Array.isArray(registered.banks)) throw new Error('invalid fixed v2 registration sidecar');
  mkdirSync(path.join(OUT, 'banks/v2'), { recursive: true });
  const runtimeBanks = [], seenSlugs = new Set();
  for (const entry of registered.banks) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(entry.slug) || seenSlugs.has(entry.slug) || entry.staticRef !== `banks/v2/${entry.slug}.${entry.revision}.json`) throw new Error('invalid immutable v2 bank reference');
    seenSlugs.add(entry.slug);
    const sourcePath = realpathSync(path.resolve(sourceDirectory, entry.contentFile));
    const relative = path.relative(sourceDirectory, sourcePath);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('v2 content is outside its sidecar directory');
    const bytes = new Uint8Array(readFileSync(sourcePath));
    const verified = await validateBankContent(JSON.parse(new TextDecoder().decode(bytes)));
    if (await sha256Hex(bytes) !== entry.sha256 || verified.contentDigest !== entry.revision || verified.content.bankUid !== entry.bankUid || verified.content.questions.length !== entry.questionCount) throw new Error('fixed v2 bank sidecar/content mismatch');
    const oldEntry = INPUT_PLAN.manifest.find(bank => bank.id === entry.slug);
    const oldSource = oldEntry && INPUT_PLAN.entrySources.get(oldEntry);
    if (!oldSource || oldSource.isProtected || await sha256Hex(new TextEncoder().encode(oldSource.rawText)) !== entry.input.sha256) throw new Error('legacy public input changed since explicit v2 registration');
    writeFileSync(path.join(OUT, entry.staticRef), canonicalContentBytes(verified.content));
    runtimeBanks.push({ slug: entry.slug, bankUid: entry.bankUid, revision: entry.revision, staticRef: entry.staticRef, questionCount: entry.questionCount, title: verified.content.metadata.title });
  }
  writeFileSync(path.join(OUT, 'banks/v2/manifest.json'), JSON.stringify({ format: registered.format, schemaVersion: 1, scopeId: registered.scopeId, banks: runtimeBanks, physicalQuestionCount: runtimeBanks.reduce((sum, bank) => sum + bank.questionCount, 0), mergedIdentityPolicy: 'reuse registered source identities; merge equivalent refs without minting' }));
  V2_RUNTIME_BANKS.push(...runtimeBanks);
  const { build } = await import('vite');
  await build({ configFile: false, root: ROOT, ...(NATIVE_ONLY_MODE ? { publicDir: false } : {}), logLevel: 'warn', build: { outDir: path.join(OUT, 'browser'), emptyOutDir: false, minify: true, lib: { entry: path.join(ROOT, 'src/player/browser-entry.js'), formats: ['es'], fileName: () => 'data-v2.js' }, rollupOptions: { output: { inlineDynamicImports: true } } } });
  await build({ configFile: false, root: ROOT, ...(NATIVE_ONLY_MODE ? { publicDir: false } : {}), logLevel: 'warn', build: { outDir: path.join(OUT, 'browser'), emptyOutDir: false, minify: true, lib: { entry: ACCOUNT_V2_SOURCE_PATH, formats: ['es'], fileName: () => 'account-v2.js' }, rollupOptions: { output: { inlineDynamicImports: true } } } });
  if (NATIVE_ONLY_MODE) {
    await build({ configFile: false, root: ROOT, publicDir: false, logLevel: 'warn', build: { outDir: path.join(OUT, 'browser'), emptyOutDir: false, minify: true, lib: { entry: path.join(ROOT, 'src/player/native-history-sync.js'), formats: ['es'], fileName: () => 'native-history-sync.js' }, rollupOptions: { output: { inlineDynamicImports: true } } } });
  }
}

const generated = [];
const siteManifest = []; // docs/banks/index.json：通用播放器按 ?bank= 查这个清单
const publicBankQuestions = []; // 供「全部题库合并练习」使用
for (const entry of Array.isArray(manifest) ? manifest : []) {
  const id = String(entry && entry.id || '').trim();
  if (!id) continue;
  // Opt-out: real banks publish by default; dev/test fixtures set "deploy": false.
  if (entry.deploy === false) {
    console.log(`· skip ${id} (deploy: false)`);
    continue;
  }
  const source = INPUT_PLAN.entrySources.get(entry);
  // deploy:false entries are deliberately not consumed; every published entry
  // was structurally validated above and is therefore never silently skipped.
  if (!source) throw new Error(`published bank ${id} was not prevalidated`);
  const { isProtected, rawText, parsed } = source;
  if (!isProtected && Array.isArray(parsed)) publicBankQuestions.push(parsed);

  // 题库数据原样进 banks/ 文件夹（公开 .json / 加密 .qbpack），播放器运行时拉取
  const dataFile = `banks/${id}.${isProtected ? 'qbpack' : 'json'}`;
  writeFileSync(path.join(OUT, dataFile), rawText);

  const count = isProtected ? (entry.question_count || 0) : (Array.isArray(parsed) ? parsed.length : 0);
  // 旧库标记（Old Question Banks 分组）：透传进 docs 清单与目录卡片；archived 与 deploy 无关，
  // 旧库照常部署、照常进合并练习，只是目录页把它收进折叠的「Old Question Banks」组。
  const archived = entry.archived === true;
  siteManifest.push({
    id,
    title: entry.title || id,
    mode: isProtected ? 'protected' : 'public',
    description: entry.description || '',
    tags: Array.isArray(entry.tags) ? entry.tags : [],
    question_count: count,
    has_images: !!entry.has_images,
    ...(archived ? { archived: true } : {}),
    ...(isProtected ? { payload: dataFile } : { json: dataFile }),
  });
  generated.push({
    id,
    file: `player.html?bank=${id}`,
    title: entry.title || id,
    description: entry.description || '',
    tags: Array.isArray(entry.tags) ? entry.tags : [],
    count,
    protected: isProtected,
    archived,
  });
  console.log(`✓ ${dataFile}  (${count} 题${isProtected ? ', 🔒 protected' : ''})`);
}

if (!generated.length && !ALLOW_EMPTY) {
  throw new Error('banks/index.json 里没有可发布的题库');
}
if (!generated.length) console.log('· 空站点构建（全部题库已解除部署）');

// 「多题库一起做」入口：运行时按所选题库现场合并（智能去重：题干+答案），不再预生成文件。
// 页内用「筛选题库」勾选任意组合练习。密码保护题库不参与合并。
let mergedEntry = null;
if (generated.length > 1) {
  // 选择式入口：新播放器打开 all-banks 会先弹「选择题库」，按所选集合现场拉取合并。
  // 仅保留清单条目（含题数）供目录卡片与播放器分流；不再写 all-banks.json。
  // 注意：极旧的缓存播放器曾直接 fetch all-banks.json，删文件后它们会 404；
  // 若要兼容这类旧缓存，恢复下面的 writeFileSync 与 json 字段即可。
  const merged = publicBankQuestions.length
    ? buildUniqueMergedQuestionBankFromCollections(publicBankQuestions)
    : [];
  const mergedCount = merged.length;
  siteManifest.push({
    id: 'all-banks',
    title: 'All Banks · Merged Practice',
    mode: 'public',
    virtual: true,
    description: 'Pick any combination of banks and practice them together.',
    tags: [],
    question_count: mergedCount,
    has_images: merged.some((q) => !!q.image),
  });
  mergedEntry = {
    id: 'all-banks',
    file: 'player.html?bank=all-banks',
    // 目录页 UI 默认英文；这两段文案带 data-i18n，随语言切换（真实题库的标题/描述是内容，不翻译）
    title: 'All Banks · Merged Practice',
    description: 'Pick any combination of banks and practice them together (duplicates merged automatically).',
    tags: [],
    count: mergedCount,
    protected: false,
  };
  console.log(`✓ all-banks 选择式入口（${mergedCount} 题；运行时现场合并，不再生成 all-banks.json）`);
}

// 通用播放器（remote 模式：按 ?bank=<id> 从 banks/ 拉数据）+ 站点题库清单
writeFileSync(path.join(OUT, 'player.html'), playerHtml({ mode: 'remote' }, 'remote'));
writeFileSync(path.join(OUT, 'banks/index.json'), JSON.stringify(siteManifest, null, 2) + '\n');
console.log(`✓ player.html + banks/index.json（${siteManifest.length} 个题库条目）`);

// 格式文档两页（format.html / format-ielts.html）共用的样式与转义。抽出来是为了防漂移：
// 以前样式内联在 formatHtml 里，加第二页就会出现两份各自演化的 CSS。
const DOC_STYLE = `  <style>
    :root{--ink:#2d3b45;--muted:#6b7280;--border:#e5e7eb;--bg:#f9fafb;--brand:#2563eb;--card:#fff}
    *{box-sizing:border-box}
    body{font-family:system-ui,-apple-system,sans-serif;color:var(--ink);background:var(--bg);max-width:860px;margin:20px auto;line-height:1.7;padding:0 12px}
    h1{font-size:1.4rem;margin:8px 0}
    h2{font-size:1.15rem;margin:28px 0 8px;border-bottom:1px solid var(--border);padding-bottom:6px}
    h3{font-size:1rem;margin:18px 0 6px}
    code{background:#eef2ff;border:1px solid #e0e7ff;border-radius:4px;padding:1px 5px;font-size:13px}
    pre{background:#0f172a;color:#e2e8f0;border-radius:10px;padding:16px;overflow-x:auto;font-size:13px;line-height:1.6}
    pre code{background:none;border:none;color:inherit;padding:0}
    table{border-collapse:collapse;width:100%;font-size:14px}
    th,td{border:1px solid var(--border);padding:8px 10px;text-align:left;vertical-align:top}
    th{background:#f3f4f6}
    .muted{color:var(--muted)}
    .back{display:inline-block;margin-bottom:10px;color:var(--brand);font-weight:600;text-decoration:none}
    .pill{display:inline-block;font-weight:600;font-size:12px;background:#eef2ff;color:#3730a3;border:1px solid #e0e7ff;padding:2px 10px;border-radius:999px}
    .callout{background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;padding:4px 16px 14px;margin:18px 0}
    .callout h2{border:none;margin-top:12px}
    .copybtn{background:var(--brand);color:#fff;border:none;border-radius:6px;padding:7px 13px;font-weight:600;cursor:pointer;font-size:13px}
    .copybtn:hover{background:#1d4ed8}
    kbd{background:#fff;border:1px solid var(--border);border-radius:4px;padding:0 5px;font-size:12px}
    .xlink{display:block;background:#fff;border:1px solid var(--border);border-left:4px solid var(--brand);border-radius:8px;padding:12px 14px;margin:16px 0;text-decoration:none;color:inherit}
    .xlink:hover{border-color:var(--brand)}
    .xlink strong{color:var(--brand)}
  </style>`;
const escDoc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// 复制按钮：把某个 <pre><code id> 的文本塞进剪贴板（两页共用，避免各写一份内联 onclick）
const copyBtnHtml = (targetId, label) =>
  `<button class="copybtn" type="button" data-label="${label}" onclick="(function(b){navigator.clipboard.writeText(document.getElementById('${targetId}').textContent).then(function(){var o=b.getAttribute('data-label');b.textContent='Copied \\u2713';setTimeout(function(){b.textContent=o;},1500);});})(this)">${label}</button>`;

// format.html = 题库 JSON 格式文档（英文在前、中文在后，静态双语页）
function formatHtml() {
  const example = `[
  {
    "id": "demo-1",
    "question": "Which fabric is approved for aircraft covering?",
    "choices": ["Polyester", "Cotton bedsheet", "Nylon tarp", "Canvas drop cloth"],
    "answer": 0,
    "source": "Chapter 3 – Coverings"
  },
  {
    "id": "demo-2",
    "question": "Select ALL tools required for fabric testing. (multiple answers)",
    "choices": ["Punch tester", "Hammer", "Maule tester", "Torque wrench"],
    "answers": [0, 2]
  },
  {
    "id": "demo-3",
    "type": "fill",
    "question": "A hole smaller than ____ inches may be repaired with a doped-on patch.",
    "blanks": [["8", "eight"]]
  },
  {
    "id": "demo-4",
    "question": "Identify the part shown in the image.",
    "image": "https://example.com/part-diagram.png",
    "choices": ["Rib", "Spar", "Longeron"],
    "answer": 1,
    "explanation": "The vertical member running spanwise along the wing is the spar; ribs give the airfoil its shape.",
    "source": "Chapter 5 – Structures"
  }
]`;
  // AI / 自动化工具「可直接粘贴」的提示词——嵌进页面（带复制按钮）。
  // 注意：本字符串在 formatHtml 的模板字符串里，禁止出现裸反引号或 ${ }。提到代码围栏一律用文字描述。
  const aiPrompt = `Turn the material at the bottom into a question-bank JSON array. Reply with JSON only — do not restate these instructions.

BATCHES (important — free ChatGPT/Gemini cut long replies off): give me AT MOST 15 questions per reply. Stop after 15, and end that reply with the single line: MORE AVAILABLE. When I type "more", continue with the NEXT questions in the same format, never repeating ones you already gave. If everything fits in 15, end with: DONE.

FORMAT — a bare JSON array, one object per question:
[
  {"id":"q1","question":"Which fabric is approved for aircraft covering?","choices":["Polyester","Cotton bedsheet","Nylon tarp"],"answer":0},
  {"id":"q2","question":"Select ALL tools required. (multiple answers)","choices":["Punch tester","Hammer","Maule tester"],"answers":[0,2]},
  {"id":"q3","type":"fill","question":"A hole smaller than ____ inches may be patched.","blanks":[["8","eight"]]}
]

RULES
1. "id": unique short string. "question": the stem as plain text.
2. One correct answer: "choices" (2 or more strings) + "answer" = the 0-based index (first choice = 0). A plain integer, not [2], not the answer text, not 1-based.
3. Several correct answers: use the plural key "answers" = array of indexes, e.g. [0,2].
4. Fill in the blank: "type":"fill", put ____ in the question where the blank goes, and "blanks" = one array per blank listing every accepted answer, e.g. [["8","eight"]].
5. Optional: "explanation" (one short sentence of why), "source" (where it came from).
6. Include every question in this batch. Use the answer the material marks correct; if none is marked, pick the best-supported one and add "source":"answer unverified".
7. Straight ASCII quotes. No trailing commas. Do not wrap the array in an object.

You may put the JSON in a code block and write a sentence before it — the importer strips that. Just never split one batch across two replies.

=== MATERIAL ===
`;
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Question Bank JSON Format / 题库 JSON 格式说明</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
${DOC_STYLE}
</head>
<body>
  <a class="back" href="./">← Back to catalog / 返回目录</a>
  <h1>Question Bank JSON Format <span class="muted">/ 题库 JSON 格式说明</span></h1>
  <p class="muted">Write your own bank as a <code>.json</code> file (UTF-8) and import it on the catalog page — or skip the file entirely and <strong>paste an AI’s reply straight into the catalog’s “📋 Paste the AI’s reply” box</strong>. Nothing is uploaded; it stays in your browser. <span>/ 可以写成 <code>.json</code> 文件导入，也可以完全不碰文件——<strong>把 AI 的回复直接粘进目录页的「📋 直接粘贴 AI 的回复」</strong>。内容不上传，只存在你的浏览器里。</span></p>

  <div class="callout" id="ai">
    <h2>🤖 Using an AI to extract questions? <span class="muted">/ 用 AI 提取题目？</span></h2>
    <p style="margin:0 0 8px"><strong>No paid plan, no file download needed.</strong> Free ChatGPT / Gemini can do this — you just copy their reply. <span class="muted">/ <strong>不需要付费、不需要下载文件</strong>，免费版 ChatGPT / Gemini 就够——把它的回复复制过来即可。</span></p>
    <ol style="margin:0 0 10px;padding-left:20px;line-height:1.75">
      <li><strong>Copy</strong> the prompt below. <span class="muted">/ 复制下面的提示词。</span></li>
      <li>Paste it into the AI, then <strong>put your questions (or attach screenshots) right after the <code>=== MATERIAL ===</code> line</strong> at the very end. <span class="muted">/ 粘进 AI，再把你的题目（或贴截图）接在最后那行 <code>=== MATERIAL ===</code> 后面。</span></li>
      <li><strong>Select the AI’s whole reply, copy it</strong>, and paste it into <strong>“📋 No file? Paste the AI’s reply instead”</strong> on the catalog page. No saving, no <kbd>.json</kbd> file, works on a phone. <span class="muted">/ <strong>把 AI 的整段回复选中复制</strong>，粘进目录页的<strong>「📋 没有文件？直接粘贴 AI 的回复」</strong>。不用存文件、不用弄 <kbd>.json</kbd>，手机上也行。</span></li>
      <li>The prompt makes the AI stop every 15 questions and print <code>MORE AVAILABLE</code>. Type <strong>more</strong>, then paste that batch too with <strong>“add to the same bank”</strong> ticked. Repeat until it prints <code>DONE</code>. <span class="muted">/ 提示词会让 AI 每 15 题停一次并打印 <code>MORE AVAILABLE</code>。回一句 <strong>more</strong>，把这批也粘进去（勾上<strong>「并入同名题库」</strong>），直到它打印 <code>DONE</code>。</span></li>
    </ol>
    <p class="muted" style="margin:0 0 10px">Why batches: a free account’s reply gets cut off partway through a long bank. Fifteen at a time never hits the limit — and if one does get cut off, the importer still recovers every complete question and tells you to ask for the rest. <span>/ 为什么分批：免费账号的回复在长题库上会被截断。每次 15 题不会触顶；万一还是被截断，导入器也会把已完整的题全部抢救出来并提示你去要剩下的。</span></p>
    <p class="muted" style="margin:0 0 10px">Tip: cheap models read <strong>pasted text and screenshots</strong> far better than a raw saved <kbd>.mhtml</kbd> (those are huge and encoded — that’s usually why an AI just echoes the prompt back). Open the page and copy the visible questions, or screenshot them. <span>/ 提示：便宜模型对<strong>粘贴的文字、截图</strong>的识别远好于直接丢原始 .mhtml（又大又是编码——AI 复读提示词多半就是这个原因）。打开网页复制可见题目，或截图即可。</span></p>
    <button class="copybtn" type="button" onclick="(function(b){navigator.clipboard.writeText(document.getElementById('ai-prompt').textContent).then(function(){var o=b.getAttribute('data-label');b.textContent='Copied \\u2713';setTimeout(function(){b.textContent=o;},1500);});})(this)" data-label="Copy prompt / 复制提示词">Copy prompt / 复制提示词</button>
    <pre style="margin-top:10px"><code id="ai-prompt">${esc(aiPrompt)}</code></pre>
    <p class="muted" style="margin:8px 0 2px">The importer auto-handles a few common AI slips (code fences, an outer <code>{"questions":[…]}</code> wrapper, a missing <code>id</code>) — but the rules below still matter. <span>/ 导入器会自动兜底几种常见小毛病（代码围栏、外层 <code>{"questions":[…]}</code> 包裹、缺 <code>id</code>），但下面的规则仍需遵守。</span></p>
  </div>

  <a class="xlink" href="format-ielts.html" data-testid="ielts-link">
    <strong>📖 Building an IELTS-style reading bank? Read the IELTS page →</strong><br>
    <span class="muted">Reading passages, <code>section</code> grouping (passage first, then its questions — never shuffled), and how each IELTS task type maps onto the fields below. / 雅思式阅读题库：阅读文章、<code>section</code> 分组（先文章再作答、不打乱），以及各雅思题型怎么落到下面的字段上。</span>
  </a>

  <h2>English</h2>
  <p>A bank is a <strong>JSON array of question objects</strong>. Three <em>graded</em> question types are supported: single-choice, multiple-answer, and fill-in-the-blank. Any question can also carry an image, an explanation, and a section (for reading-passage banks).</p>

  <h3>Fields</h3>
  <table>
    <tr><th>Field</th><th>Required</th><th>Meaning</th></tr>
    <tr><td><code>id</code></td><td>✅ every question</td><td>Unique string within the file, e.g. <code>"ch3-12"</code>. Progress (wrong/star records) is keyed on it.</td></tr>
    <tr><td><code>question</code></td><td>✅ (unless <code>image</code> present)</td><td>The stem, plain text. <code>\\n</code> makes a line break.</td></tr>
    <tr><td><code>choices</code></td><td>✅ for choice questions</td><td>Array of <strong>at least 2</strong> strings.</td></tr>
    <tr><td><code>answer</code></td><td>single-choice</td><td><strong>0-based</strong> index into <code>choices</code> (first choice = 0).</td></tr>
    <tr><td><code>answers</code></td><td>multiple-answer</td><td>Array of 0-based indexes, e.g. <code>[0,2]</code>. Player switches to checkboxes automatically; all must match.</td></tr>
    <tr><td><code>type</code></td><td>fill-in only</td><td>Set <code>"fill"</code> (or just provide <code>blanks</code>).</td></tr>
    <tr><td><code>blanks</code></td><td>fill-in</td><td>One array per blank, each listing the accepted answers: <code>[["8","eight"]]</code> = 1 blank with 2 accepted spellings; <code>[["a"],["b"]]</code> = 2 blanks.</td></tr>
    <tr><td><code>question_html</code></td><td>optional (fill-in)</td><td>HTML stem with <code>&lt;input data-blank="1"&gt;</code> placed where blanks belong (1-based). Omit it and inputs are appended below the stem.</td></tr>
    <tr><td><code>answer_sets</code></td><td>optional (fill-in)</td><td>Alternative whole-row combinations; any ONE set matching counts as correct.</td></tr>
    <tr><td><code>image</code></td><td>optional</td><td>Image URL or base64 <code>data:image/...</code> string — or an array of them. Shown above the choices.</td></tr>
    <tr><td><code>source</code></td><td>optional</td><td>Where the question came from; shown small under the card. May also be an <strong>array</strong> of strings (a merged question keeps every origin; they render joined by <code>|</code>).</td></tr>
    <tr><td><code>explanation</code></td><td>optional</td><td>Why the answer is right. Shown with a 💡 only after the learner submits <strong>and then taps <kbd>Show Correct Answers</kbd></strong> — it shares one reveal gate with the correct answer, so it can never leak the answer early. Plain text (HTML is escaped, not rendered).</td></tr>
    <tr><td><code>section</code></td><td>optional</td><td>Group name, e.g. a reading passage title. Turns the bank into a <strong>section bank</strong>: questions keep their array order (never shuffled) and the filter panel lists sections instead of id prefixes. See the <a href="format-ielts.html">IELTS page</a>.</td></tr>
    <tr><td><code>passage</code></td><td>optional</td><td>The reading text for this <code>section</code>, shown in a collapsible “Reading Passage” box above the section’s first question. Read from the <strong>first question of each section</strong>. See the <a href="format-ielts.html">IELTS page</a>.</td></tr>
    <tr><td><code>banks</code></td><td>optional</td><td>Array of filter-group keys this question belongs to. Defaults to the part of <code>id</code> before the first <code>-</code>. Use it when one question should appear under several groups.</td></tr>
  </table>
  <p class="muted">Anything else you add is ignored, so extra bookkeeping fields are harmless. <code>type:"essay"</code> renders as an ungraded free-text card in the player, but the <strong>importer drops it</strong> (a record needs <code>choices</code> or <code>blanks</code>) — so don’t put essay questions in a bank you plan to import.</p>

  <h3>Grading rules</h3>
  <ul>
    <li>Multiple-answer questions require the exact set — no partial credit.</li>
    <li>Fill-in matching ignores <strong>case</strong>, extra spaces, and spacing differences (<code>check list</code> = <code>checklist</code>). It also normalizes typography before comparing: curly quotes → straight, en/em dashes → <code>-</code>, non-breaking space → space, and a trailing <code>. , ; : ! ?</code> is dropped (<code>8.</code> = <code>8</code>).</li>
    <li>Numbers compare as numbers, but <strong>only when the expected answer is itself numeric</strong> (so text answers are never loosened): thousands separators, a percent sign, one trailing unit word and scientific notation are tolerated — <code>1,000</code> = <code>1000</code>, <code>8 RPM</code> = <code>8</code>, <code>8%</code> = <code>8</code>. No unit conversion — <code>1 ft</code> ≠ <code>12 in</code>.</li>
    <li><code>blanks</code> matches each blank independently. <code>answer_sets</code> instead matches whole rows: any one set matching all blanks counts as correct. Every blank must be filled before the answer is graded.</li>
    <li>Files are validated on import; invalid records are skipped with a reason (fewer than 2 choices, out-of-range <code>answer</code>, fill-in without accepted answers, neither <code>choices</code> nor <code>blanks</code>…).</li>
  </ul>

  <h3>Fixed for you automatically on import</h3>
  <p class="muted" style="margin-top:0">These common slips (mostly from cheap AI output) are repaired rather than rejected — but a clean file is still safer:</p>
  <ul>
    <li>Markdown <strong>code fences</strong> around the JSON, and an outer <code>{"questions":[…]}</code> wrapper, are stripped.</li>
    <li>A missing <code>id</code> is auto-filled (<code>auto-1</code>, <code>auto-2</code>…). Give real ids anyway: wrong/star history is keyed on them, so auto ids shift if you re-order the file.</li>
    <li>A numeric <code>id</code> becomes a string; index written as a string (<code>"2"</code>) becomes a number.</li>
    <li><code>answer:[2]</code> becomes <code>answer:2</code>; <code>answer:[0,2]</code> becomes <code>answers:[0,2]</code>.</li>
  </ul>

  <h3>If it says “invalid / no valid questions” — why a record is skipped, and the fix</h3>
  <table>
    <tr><th>Symptom</th><th>Fix</th></tr>
    <tr><td>Whole file rejected (“Not valid JSON”)</td><td>It must be valid JSON. Remove markdown <strong>code fences</strong>, comments, and trailing commas; use straight <code>"</code> quotes.</td></tr>
    <tr><td>“No valid questions found”</td><td>Top level must be a <strong>bare array</strong> <code>[…]</code>. Don’t wrap it as <code>{"questions":[…]}</code>. (The importer tries to unwrap, but a bare array is safest.)</td></tr>
    <tr><td>Every question skipped</td><td>Usually a missing <code>id</code> or a bad <code>answer</code>. Give each a unique <code>id</code>; make <code>answer</code> a <strong>0-based integer</strong> in range (not the text, not 1-based).</td></tr>
    <tr><td>One question skipped</td><td>Choice Q needs <code>choices</code> (2+) and a valid <code>answer</code>/<code>answers</code>; fill-in needs <code>blanks</code> with at least one accepted answer; or give it an <code>image</code> if there’s no stem text.</td></tr>
  </table>

  <h2>中文</h2>
  <p>题库就是一个 <strong>JSON 数组</strong>，每个元素是一道题。<strong>可判分</strong>的题型有三种：单选、多选、填空；任何题都还能带图片、解析、以及 section（阅读文章型题库用）。</p>
  <ul>
    <li><code>id</code>：文件内唯一（错题/收藏记录靠它存）。缺了会自动补 <code>auto-1</code>…，但仍建议自己给——自动 id 会随文件顺序变动，历史就断了。</li>
    <li><code>question</code>：题干纯文本（有 <code>image</code> 时可留空）；<code>\\n</code> 换行。</li>
    <li>单选：<code>choices</code>（≥2 个选项）+ <code>answer</code>（正确选项的下标，<strong>从 0 开始</strong>）。</li>
    <li>多选：用 <code>answers: [0,2]</code> 数组代替 <code>answer</code>，播放器自动变复选框，需全对（无部分分）。</li>
    <li>填空：<code>type:"fill"</code> + <code>blanks</code>——每个空一个数组，列出全部可接受答案，如 <code>[["8","eight"]]</code>。</li>
    <li><code>explanation</code>（解析）：提交后<strong>再点卡片上的「Show Correct Answers」</strong>才以 💡 显示——与正确答案共用同一道揭示闸，绝不会提前泄题；纯文本（写 HTML 会被转义）。</li>
    <li><code>section</code> + <code>passage</code>：阅读文章型题库（雅思等）。带 <code>section</code> 的库<strong>不打乱</strong>、筛选面板按篇分组；<code>passage</code> 是该篇的文章，显示在该篇第一题上方的可折叠框里。详见 <a href="format-ielts.html">雅思专页</a>。</li>
    <li>其他可选：<code>image</code>（图片 URL 或 base64 data-URI，可数组）、<code>source</code>（来源，可为数组）、<code>question_html</code>（题干内嵌输入框 <code>&lt;input data-blank="1"&gt;</code>）、<code>answer_sets</code>（多组合答案，任一组全匹配即对）、<code>banks</code>（自定义筛选分组，默认取 id 第一个 <code>-</code> 之前的部分）。</li>
    <li>判分细节：忽略大小写、多余空格、空格有无（<code>check list</code> = <code>checklist</code>）；比较前统一弯引号/破折号/不换行空格，去掉句尾标点（<code>8.</code> = <code>8</code>）；<strong>期望答案本身是数字时</strong>才按数值比（<code>1,000</code>=<code>1000</code>、<code>8 RPM</code>=<code>8</code>、<code>8%</code>=<code>8</code>），但不做单位换算。</li>
    <li>导入时自动校验，不合格的题会被跳过并提示原因（选项不足 2 个 / answer 越界 / 填空没有可接受答案 / 既无 choices 也无 blanks 等）。代码围栏、外层 <code>{"questions":[…]}</code>、缺 id、数字 id、<code>answer:[2]</code> 这类常见毛病会自动兜底修好。</li>
    <li><code>type:"essay"</code>（问答题）播放器能显示但不判分，且<strong>导入时会被剔除</strong>——要导入的题库别放问答题。</li>
  </ul>

  <h2>Complete example / 完整示例</h2>
  <pre><code>${esc(example)}</code></pre>
  <p class="muted">Save as e.g. <code>my-bank.json</code> → catalog page → “Import your own bank”. The Extractor's “导出全部合并 JSON” produces exactly this format. / 保存为 <code>.json</code> 后到目录页导入即可；提取器导出的合并 JSON 就是这个格式。</p>
</body>
</html>
`;
}

// format-ielts.html = format.html 的雅思子页：阅读文章型题库（section + passage）怎么写，
// 以及各雅思题型怎么落到现有三种可判分题型上。独立成页是因为这套字段只有阅读类题库用得到，
// 塞进主文档会把「随便写个选择题库」的门槛抬高。
function formatIeltsHtml() {
  const example = `[
  {
    "id": "ielts-r1-1",
    "section": "Passage 1 — The History of Glass",
    "passage": "Glass has been made by humans for at least 5,000 years. The earliest known objects are beads, which may have been made by accident during metalworking.\\n\\nBy the 15th century BC, hollow glass vessels were being produced in Egypt. The technique of glass blowing, however, was not developed until the 1st century BC, somewhere along the Syro-Palestinian coast.\\n\\nIt was the Romans who began to use glass for architectural purposes, and clear glass windows have been found in the most important buildings of Pompeii.",
    "question": "The earliest glass objects were probably produced by accident while people were working with ____.",
    "type": "fill",
    "blanks": [["metal", "metals", "metalworking"]],
    "explanation": "Paragraph 1: beads \\"may have been made by accident during metalworking\\"."
  },
  {
    "id": "ielts-r1-2",
    "section": "Passage 1 — The History of Glass",
    "question": "Glass blowing was invented in Egypt.",
    "choices": ["True", "False", "Not Given"],
    "answer": 1,
    "explanation": "Paragraph 2 places glass blowing on the Syro-Palestinian coast, not Egypt — the passage contradicts the statement, so False (not Not Given)."
  },
  {
    "id": "ielts-r1-3",
    "section": "Passage 1 — The History of Glass",
    "question": "Which TWO uses of glass are mentioned in the passage? (Choose TWO)",
    "choices": ["Beads", "Hollow vessels", "Mirrors", "Spectacle lenses"],
    "answers": [0, 1]
  },
  {
    "id": "ielts-r2-1",
    "section": "Passage 2 — Urban Farming",
    "passage": "Rooftop farms are appearing on warehouses and apartment blocks in cities from Tokyo to Toronto.\\n\\nSupporters argue that growing food where it is eaten cuts transport emissions and gives residents fresh produce within walking distance. Critics counter that the yields are too small to matter and that the water and energy costs of a rooftop greenhouse can exceed those of a rural field.",
    "question": "Choose the best heading for the second paragraph.",
    "choices": [
      "The two sides of the rooftop-farming debate",
      "How to build a rooftop greenhouse",
      "Why cities are running out of food"
    ],
    "answer": 0
  },
  {
    "id": "ielts-r2-2",
    "section": "Passage 2 — Urban Farming",
    "type": "fill",
    "question": "Complete the summary with NO MORE THAN TWO WORDS for each blank.",
    "question_html": "Supporters say local growing reduces <input data-blank=\\"1\\"> and puts fresh food within <input data-blank=\\"2\\"> of residents.",
    "blanks": [
      ["transport emissions", "emissions"],
      ["walking distance"]
    ]
  }
]`;

  const aiPrompt = `Turn the IELTS reading material at the bottom into a question-bank JSON array. Reply with JSON only — do not restate these instructions.

BATCHES (important — free ChatGPT/Gemini cut long replies off): do ONE passage per reply, and at most 15 questions. End the reply with the line MORE AVAILABLE if a passage is still left, otherwise DONE. When I type "more", do the next passage in the same format.

GROUPING — this is what makes it a reading bank:
- Every question gets "section": the passage title, written IDENTICALLY for every question of that passage. Same wording and spacing every time — one typo splits the passage in two.
- The FIRST question of each passage also gets "passage": the full reading text, paragraphs separated by a blank line. Do not repeat it on the other questions, and do not shorten or summarise it.
- Keep the questions in the order the test asks them.

FORMAT
[
  {"id":"p1-q1","section":"Passage 1 - The History of Glass","passage":"Paragraph one...\n\nParagraph two...","question":"Glass blowing was invented in Egypt.","choices":["True","False","Not Given"],"answer":1,"explanation":"Paragraph 2 places it on the Syro-Palestinian coast."},
  {"id":"p1-q2","section":"Passage 1 - The History of Glass","type":"fill","question":"Beads may have been made during ____.","blanks":[["metalworking","metal working"]]}
]

TASK TYPES
- Multiple choice: "choices" + "answer" = 0-based index (a plain integer).
- Choose TWO/THREE: "choices" + plural "answers" = [0,2].
- True/False/Not Given: "choices":["True","False","Not Given"]. Yes/No/Not Given: ["Yes","No","Not Given"]. Keep the test's own wording.
- Matching headings/features: one question per item, "choices" = the whole list of options offered, "answer" = the right index.
- Any completion or short answer: "type":"fill" + "blanks" = one array per blank listing every accepted answer (include plurals and equally correct wordings). Respect the word limit stated in the test.
- Diagram labelling: same as completion, plus "image" if a picture is given.
- Writing/speaking tasks: skip them, they cannot be graded.

Optional and very useful: "explanation" — one sentence naming the paragraph and quoting the few words that prove the answer.

Straight ASCII quotes. No trailing commas. Do not wrap the array in an object. A sentence before the JSON or a code block around it is fine — the importer strips those.

=== MATERIAL ===
`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>IELTS Reading Banks / 雅思阅读题库格式</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
${DOC_STYLE}
</head>
<body>
  <a class="back" href="format.html">← Back to the JSON format guide / 返回 JSON 格式说明</a>
  <h1>IELTS-style Reading Banks <span class="muted">/ 雅思式阅读题库</span></h1>
  <p class="muted">Two extra fields — <code>section</code> and <code>passage</code> — turn an ordinary bank into a reading test: each passage is shown once, followed by its own questions, in order. Everything else on the <a href="format.html">main format page</a> still applies.</p>

  <h2>English</h2>

  <h3>What the two fields do</h3>
  <table>
    <tr><th>Field</th><th>Where it goes</th><th>Effect</th></tr>
    <tr><td><code>section</code></td><td>On <strong>every</strong> question of a passage, spelled identically</td><td>Groups the questions under a heading. The heading is printed once, above the first question of the group.</td></tr>
    <tr><td><code>passage</code></td><td>On the <strong>first</strong> question of each section</td><td>Renders a collapsible “📖 Reading Passage” box (open by default) above that section’s questions. Blank line = new paragraph; a single newline = line break.</td></tr>
  </table>

  <h3>What changes once any question has a <code>section</code></h3>
  <ul>
    <li><strong>Questions are never shuffled.</strong> The array order is the reading order, so every passage stays with its own questions. The <kbd>Randomize + Reset</kbd> button is therefore relabelled <kbd>Retest</kbd> — it clears this round’s answers and keeps the order.</li>
    <li><strong>The filter panel lists passages instead of id prefixes</strong>, so you can practice one passage at a time.</li>
    <li>Everything else is unchanged: wrong-only / starred-only views, the answer sheet, progress saving, and per-question <code>explanation</code> all work the same.</li>
  </ul>

  <h3>Rules worth getting right</h3>
  <ul>
    <li>The <code>section</code> string is the group key — it must be <strong>byte-identical</strong> across a passage’s questions. <code>"Passage 1"</code> and <code>"Passage 1 "</code> become two groups.</li>
    <li>Only the first question of a section is read for <code>passage</code>. Repeating it on later questions is harmless but pointless; putting a <em>different</em> text there silently does nothing.</li>
    <li><code>section</code> and <code>passage</code> are <strong>plain text</strong> — HTML in them is escaped and shown literally, not rendered. Use blank lines for paragraphs.</li>
    <li>Don’t mix: give <em>every</em> question a <code>section</code>. One sectioned question is enough to stop the whole bank from shuffling, and the un-sectioned ones then fall back to grouping by id prefix — a confusing mix in the filter panel.</li>
    <li>A long passage repeated as a paragraph inside <code>question</code> instead of <code>passage</code> will still work, but it shows once per question and can’t be collapsed.</li>
  </ul>

  <h3>Mapping IELTS task types onto the three supported shapes</h3>
  <table>
    <tr><th>IELTS task</th><th>Write it as</th></tr>
    <tr><td>Multiple choice (one answer)</td><td><code>choices</code> + <code>answer</code> (0-based index)</td></tr>
    <tr><td>Choose TWO / THREE</td><td><code>choices</code> + <code>answers: [0,2]</code> — checkboxes, exact set required</td></tr>
    <tr><td>True / False / Not Given</td><td><code>choices: ["True","False","Not Given"]</code> + <code>answer</code>. Yes/No/Not Given: use <code>["Yes","No","Not Given"]</code> — keep the test’s own wording so the distinction is preserved.</td></tr>
    <tr><td>Matching headings / features / sentence endings</td><td>One question per item; <code>choices</code> = the whole list offered; <code>answer</code> = the right index. (Re-listing the full option set on each item is what makes each one answerable on its own.)</td></tr>
    <tr><td>Sentence / summary / note / table / flow-chart completion, short answer</td><td><code>type:"fill"</code> + <code>blanks</code>, one array per blank listing every accepted answer. Use <code>question_html</code> with <code>&lt;input data-blank="1"&gt;</code> to place the boxes <em>inside</em> the sentence; omit it and the boxes appear under the stem.</td></tr>
    <tr><td>Diagram / map / plan labelling</td><td>Same as completion, plus <code>image</code>.</td></tr>
    <tr><td>Writing / speaking tasks</td><td>Not supported — there is nothing to grade. <code>type:"essay"</code> displays but is dropped on import.</td></tr>
  </table>

  <h3>Word limits and accepted answers</h3>
  <ul>
    <li>Keep the instruction (“NO MORE THAN TWO WORDS AND/OR A NUMBER”) in the <code>question</code> text — the player does not enforce it, so the learner needs to see it.</li>
    <li>List every equally-correct form in that blank’s array: singular and plural, a hyphenated and spaced variant, a number and its word. Grading already ignores case, extra spaces, spacing (<code>check list</code> = <code>checklist</code>), curly quotes/dashes and a trailing full stop.</li>
    <li>Use <code>answer_sets</code> when blanks are only correct <em>in combination</em> — e.g. two blanks that may be filled in either order. Each set lists one acceptable value per blank; any one matching set is correct.</li>
  </ul>

  <h3>Explanations earn their keep here</h3>
  <p>IELTS reading is won on <em>where</em> the answer is, so <code>explanation</code> is worth more than in an ordinary bank. Name the paragraph and quote the handful of words that decide it — that is exactly what turns a wrong True/False/Not Given into a lesson:</p>
  <pre><code>"explanation": "Paragraph 2 places glass blowing on the Syro-Palestinian coast, not Egypt — the passage contradicts the statement, so False (not Not Given)."</code></pre>
  <p class="muted">The reveal is gated: after submitting, the learner taps <kbd>Show Correct Answers</kbd> and the 💡 explanation appears together with the correct answer. Because both sit behind the same gate, a full set of explanations can never spoil a first attempt. <span>/ 揭示是有闸的：提交后点「Show Correct Answers」，💡 解析与正确答案一起出现——两者共用同一道闸，所以写满解析也不会毁掉第一次作答。</span></p>

  <div class="callout" id="ai">
    <h2>🤖 Turn a whole reading test into a bank with an AI <span class="muted">/ 用 AI 把整套阅读转成题库</span></h2>
    <p style="margin:0 0 8px">This prompt adds the IELTS-specific rules (identical <code>section</code> strings, <code>passage</code> on the first question only, task-type mapping) to the general one. <span class="muted">/ 这份提示词在通用版之上加了雅思专属规则（section 字符串必须完全一致、passage 只放每篇第一题、题型映射）。</span></p>
    ${copyBtnHtml('ai-prompt', 'Copy IELTS prompt / 复制雅思提示词')}
    <pre style="margin-top:10px"><code id="ai-prompt">${escDoc(aiPrompt)}</code></pre>
    <p class="muted" style="margin:8px 0 2px">Paste the passages <strong>and</strong> the question list after <code>=== MATERIAL ===</code>. Include the answer key if you have one — otherwise the AI guesses and marks those questions <code>"source": "answer unverified"</code>. <span>/ 把文章<strong>和</strong>题目一起贴在 <code>=== MATERIAL ===</code> 之后；有答案就一并给，否则 AI 会猜并标记 <code>answer unverified</code>。</span></p>
  </div>

  <h2>中文</h2>
  <p>两个额外字段 <code>section</code> 和 <code>passage</code> 就能把普通题库变成阅读测试：每篇文章只显示一次，后面紧跟它自己的题目，按原顺序作答。<a href="format.html">主格式页</a>的其他规则照旧适用。</p>
  <ul>
    <li><code>section</code>：<strong>每一道</strong>属于这篇的题都要写，且写法必须<strong>完全一致</strong>（多一个空格就会拆成两组）。它是分组键，篇名只在该组第一题上方打印一次。</li>
    <li><code>passage</code>：只放在<strong>每篇的第一题</strong>上，渲染成可折叠的「📖 阅读文章」框（默认展开）。<strong>空行分段</strong>，单个换行 = 换行。放在后面的题上不起作用。</li>
    <li>两个字段都是<strong>纯文本</strong>，写 HTML 会被转义原样显示，不会渲染。</li>
    <li>只要有一道题带 <code>section</code>，整个题库就<strong>不再打乱</strong>（保证文章与题目不脱节），「Randomize + Reset」按钮改叫「Retest」＝只清空本轮作答、不改顺序；筛选面板也从「按 id 前缀」变成「按篇」，可以一篇一篇练。</li>
    <li>别混着写：给<strong>每道题</strong>都加 <code>section</code>。漏掉的那些会退回按 id 前缀分组，筛选面板会出现两套口径。</li>
  </ul>
  <h3>雅思题型 → 三种可判分题型</h3>
  <ul>
    <li>单选 → <code>choices</code> + <code>answer</code>（下标从 0 开始）</li>
    <li>Choose TWO/THREE → <code>choices</code> + <code>answers:[0,2]</code>（自动变复选框，需全对）</li>
    <li>True/False/Not Given → <code>choices:["True","False","Not Given"]</code> + <code>answer</code>；Yes/No/Not Given 用 <code>["Yes","No","Not Given"]</code>，按原卷用词，别混用</li>
    <li>Matching headings / features / endings → 每个小题一条记录，<code>choices</code> 放<strong>完整选项表</strong>，<code>answer</code> 指向正确项</li>
    <li>各类 completion / 短答 → <code>type:"fill"</code> + <code>blanks</code>（每空一个数组，列出所有可接受写法：单复数、连字符/空格、数字与英文）；想把输入框放进句子中间就用 <code>question_html</code> 配 <code>&lt;input data-blank="1"&gt;</code></li>
    <li>图/地图标注 → 同 completion，再加 <code>image</code></li>
    <li>写作/口语 → 不支持（无从判分）；<code>type:"essay"</code> 能显示但导入时会被剔除</li>
    <li>字数限制（NO MORE THAN TWO WORDS）播放器<strong>不强制</strong>，务必把这句话留在题干里让人看见；同时确认 <code>blanks</code> 里列的每个写法都符合限制</li>
    <li>两个空只有<strong>组合起来</strong>才算对（如可互换顺序）→ 用 <code>answer_sets</code>，每组给出各空一个值，任一组全中即对</li>
  </ul>

  <h2>Complete example / 完整示例</h2>
  <p class="muted" style="margin-top:0">Two passages; passage text only on each section’s first question; True/False/Not Given, Choose TWO, matching headings, gap fill and an inline-blank summary. <span>/ 两篇文章；<code>passage</code> 只出现在每篇第一题；含 TFNG、多选、标题匹配、填空、句中内嵌空。</span></p>
  <pre><code>${escDoc(example)}</code></pre>
  <p class="muted">Save as e.g. <code>ielts-reading-1.json</code> and import it — or paste the AI reply straight into the catalog’s “📋 Paste the AI’s reply” box, one passage per batch with “add to the same bank” ticked. <span>/ 可存成 <code>.json</code> 导入；也可以把 AI 回复直接粘进目录页的「📋 直接粘贴 AI 的回复」——一篇一批，勾上「并入同名题库」。</span></p>
</body>
</html>
`;
}

// index.html = 题库目录页（点卡片进入对应单文件播放器）。
// UI 默认英文，右上角语言切换（en/zh/es），与播放器共用 qb_ui_lang 偏好；
// 题库标题/描述是内容不翻译，仅合并卡和 UI 文案随语言切换。
function catalogHtml(banks) {
  const cardHtml = (bank) => `
    <a class="card" href="${escapeHTML(bank.file)}" data-bank-id="${escapeHTML(bank.id)}" data-testid="bank-card">
      ${bank.id === 'all-banks' ? '<span class="catalog-eyebrow" data-i18n="catalog_feature">Your practice, your mix</span>' : ''}
      <div class="card-head">
        <h2${bank.id === 'all-banks' ? ' data-i18n="merged_title"' : ''}>${escapeHTML(bank.title)}</h2>
        <span class="pill ${bank.protected ? 'locked' : ''}" data-i18n="${bank.protected ? 'badge_protected' : 'badge_public'}">${bank.protected ? '🔒 Protected' : 'Public'}</span>
      </div>
      ${bank.description ? `<p class="desc"${bank.id === 'all-banks' ? ' data-i18n="merged_desc"' : ''}>${escapeHTML(bank.description)}</p>` : ''}
      <div class="meta-row">
        <span class="pill muted" data-qcount="${bank.count}">${bank.count} questions</span>
        <span class="pill muted progress" data-progress-for="${escapeHTML(bank.id)}" hidden></span>
        ${bank.tags.slice(0, 4).map((tag) => `<span class="pill muted">${escapeHTML(tag)}</span>`).join('')}
      </div>
      <span class="go" data-i18n="start">Start practicing →</span>
    </a>`;

  // 分两组：active（非旧库）照旧进主 grid；archived 收进折叠的「Old Question Banks」组。
  // 合并卡（all-banks）没有 archived，始终在主 grid。
  const activeBanks = banks.filter((b) => !b.archived);
  const archivedBanks = banks.filter((b) => b.archived);
  const cards = activeBanks.map(cardHtml).join('\n');
  const oldBanksSection = archivedBanks.length ? `
  <details class="old-banks" data-testid="old-banks">
    <summary>Old Question Banks (${archivedBanks.length})</summary>
    <div class="grid">
${archivedBanks.map(cardHtml).join('\n')}
    </div>
  </details>` : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>AMT Question Bank Practice</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="color-scheme" content="light dark" />
  <script>globalThis.QB_ACCOUNT_V2_UI = "__QB_ACCOUNT_V2_UI__" === "true"; (function(){try{var k="qb_theme",s=localStorage.getItem(k),m=window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches,t=(s==="dark"||s==="light")?s:(m?"dark":"light");document.documentElement.setAttribute("data-theme",t);}catch(e){}})();</script>
  <script>globalThis.QB_DATA_V2_CONFIG=${safeJSONStringForScript(JSON.stringify({enabled:DATA_V2_ENABLED,historySnapshotsEnabled:NATIVE_HISTORY_SNAPSHOTS_ENABLED,resumeStateSchemaVersions:[1,2],snapshotBaselineInitializationEnabled:SNAPSHOT_BASELINE_INIT_ENABLED,nativeOnlyMode:NATIVE_ONLY_MODE,manifest:DATA_V2_ENABLED?'banks/v2/manifest.json':null,banks:V2_RUNTIME_BANKS,accountApiBase:API_BASE}))};</script>
  <style>
    :root{
      color-scheme: light;
      --bg:#eef1f6; --card:#ffffff; --card-2:#f6f8fc;
      --ink:#1e293b; --ink-soft:#3b4860; --muted:#64748b;
      --border:#e4e8f0; --border-strong:#d3d9e4;
      --brand:#2563eb; --brand-strong:#1d4ed8; --glow:rgba(37,99,235,.06); --particle-rgb:37,99,235;
      --badge-bg:#eef2ff; --badge-ink:#3730a3; --badge-border:#e0e7ff;
      --muted-bg:#eef1f6;
      --locked-bg:#fef3c7; --locked-ink:#92400e; --locked-border:#fde68a;
      --ok-bg:#e7f8f0; --ok-ink:#047857; --ok-border:#b6ead2;
      --danger-ink:#b91c1c; --danger-bg:#fee2e2; --danger-border:#fecaca;
      --shadow-sm:0 1px 2px rgba(16,24,40,.06); --shadow-md:0 12px 30px rgba(16,24,40,.10);
      --radius:16px; --radius-sm:10px; --pill:999px;
    }
    html[data-theme="dark"]{
      color-scheme: dark;
      --bg:#0b1020; --card:#141b2d; --card-2:#0f1626;
      --ink:#e8edf6; --ink-soft:#c4cee0; --muted:#93a0b8;
      --border:#26304a; --border-strong:#33415f;
      --brand:#6f9bff; --brand-strong:#5b8cff; --glow:rgba(111,155,255,.12); --particle-rgb:111,155,255;
      --badge-bg:rgba(99,102,241,.20); --badge-ink:#c7d2fe; --badge-border:rgba(129,140,248,.32);
      --muted-bg:rgba(148,163,184,.12);
      --locked-bg:rgba(245,158,11,.16); --locked-ink:#fcd34d; --locked-border:rgba(245,158,11,.35);
      --ok-bg:rgba(16,185,129,.15); --ok-ink:#6ee7b7; --ok-border:rgba(52,211,153,.34);
      --danger-ink:#fca5a5; --danger-bg:rgba(239,68,68,.16); --danger-border:rgba(248,113,113,.35);
      --shadow-sm:0 1px 2px rgba(0,0,0,.4); --shadow-md:0 16px 38px rgba(0,0,0,.5);
    }
    *{box-sizing:border-box}
    [hidden]{display:none !important} /* 否则 .login-reminder / .card 等的 display 会盖过 hidden 属性，登录后绿提醒框还会显示 */
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif; color:var(--ink); background:radial-gradient(1100px 560px at 100% -12%, var(--glow), transparent 60%), var(--bg); background-attachment:fixed; min-height:100vh; max-width:940px; margin:0 auto; line-height:1.6; padding:22px 16px 64px; -webkit-font-smoothing:antialiased}
    h1{font-size:1.7rem; font-weight:780; letter-spacing:-.02em; margin:0 0 4px}
    .topbar{display:flex; justify-content:space-between; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:6px}
    .topbar-controls{display:flex; align-items:center; gap:8px; flex-wrap:wrap}
    .lang{display:flex; align-items:center; gap:8px; color:var(--muted); font-size:13px}
    .lang select{font:inherit; height:36px; padding:8px 10px; border:1px solid var(--border-strong); border-radius:10px; background:var(--card); color:var(--ink); font-size:13px; cursor:pointer; box-shadow:var(--shadow-sm)}
    #theme-toggle{width:36px; height:36px; border-radius:10px; padding:0; border:1px solid var(--border-strong); background:var(--card); color:var(--ink); font-size:16px; cursor:pointer; display:inline-flex; align-items:center; justify-content:center; box-shadow:var(--shadow-sm)}
    #theme-toggle:hover{background:var(--muted-bg)}
    /* ☕ 打赏：浮动按钮 + 扭蛋弹窗 + 彩带 */
    .coffee-fab{position:fixed;right:18px;bottom:18px;z-index:55;display:inline-flex;align-items:center;gap:8px;padding:11px 16px;border-radius:999px;border:1px solid var(--brand);background:var(--brand);color:#fff;font:inherit;font-weight:700;font-size:14px;cursor:pointer;box-shadow:var(--shadow-md)}
    .coffee-fab[hidden]{display:none}
    .coffee-fab:hover{filter:brightness(1.07);transform:translateY(-2px)}
    .coffee-fab.wiggle{animation:cfWiggle 3.4s ease-in-out infinite} /* 目录页：一直跳，但幅度小 */
    .coffee-fab .cf-emoji{font-size:17px}
    @keyframes cfWiggle{0%,86%,100%{transform:rotate(0)}90%{transform:rotate(-2.5deg)}94%{transform:rotate(2.5deg)}}
    @media (max-width:560px){.coffee-fab .cf-text{display:none}.coffee-fab{padding:13px;border-radius:50%;font-size:18px}}
    /* 咖啡师现做 */
    .barista{height:118px;position:relative;display:flex;align-items:flex-end;justify-content:center;margin:6px 0 2px}
    .barista .machine{position:absolute;top:2px;left:50%;transform:translateX(-50%);width:56px;height:15px;background:var(--ink);border-radius:4px}
    .barista .machine:after{content:"";position:absolute;left:50%;top:13px;transform:translateX(-50%);width:11px;height:8px;background:var(--ink);border-radius:0 0 3px 3px}
    .barista .bean{position:absolute;top:-4px;left:50%;transform:translateX(-50%);font-size:17px;opacity:0}
    .barista.brewing .bean{animation:beanDrop .5s ease-in forwards}
    @keyframes beanDrop{0%{opacity:1;top:-4px}70%{opacity:1}100%{opacity:0;top:16px}}
    .barista .stream{position:absolute;top:22px;left:50%;width:4px;height:44px;background:linear-gradient(#6f4e37,#3b2a1d);border-radius:2px;transform:translateX(-50%) scaleY(0);transform-origin:top;opacity:0}
    .barista.brewing .stream{animation:streamPour 1.2s ease-in .45s forwards}
    @keyframes streamPour{0%{opacity:0;transform:translateX(-50%) scaleY(0)}12%{opacity:1;transform:translateX(-50%) scaleY(1)}85%{opacity:1;transform:translateX(-50%) scaleY(1)}100%{opacity:0;transform:translateX(-50%) scaleY(1)}}
    .barista .cup{position:relative;width:60px;height:46px;background:linear-gradient(#ffffff,#eef2f8);border:3px solid var(--ink);border-radius:5px 5px 14px 14px;overflow:hidden;z-index:2}
    .barista .cup:before{content:"";position:absolute;right:-16px;top:8px;width:14px;height:18px;border:3px solid var(--ink);border-left:none;border-radius:0 12px 12px 0}
    .barista .cup .fill{position:absolute;left:0;right:0;bottom:0;height:0;background:linear-gradient(#6f4e37,#4a3526)}
    .barista.brewing .cup .fill{animation:cupFill 1.15s ease-in .5s forwards}
    @keyframes cupFill{from{height:0}to{height:74%}}
    .barista .steam{position:absolute;top:12px;width:5px;height:20px;background:linear-gradient(rgba(148,163,184,0),rgba(148,163,184,.6));border-radius:3px;filter:blur(1px);opacity:0}
    .barista .steam.s1{left:calc(50% - 11px)} .barista .steam.s2{left:calc(50% - 2px);height:24px} .barista .steam.s3{left:calc(50% + 9px)}
    .barista.brewed .steam{animation:qbSteam 2.2s ease-in-out infinite}
    .barista.brewed .steam.s2{animation-delay:.6s} .barista.brewed .steam.s3{animation-delay:1.1s}
    @keyframes qbSteam{0%{opacity:0;transform:translateY(8px) scaleY(.6)}35%{opacity:.7}100%{opacity:0;transform:translateY(-16px) scaleY(1.2)}}
    .coffee-brewline{font-weight:800;font-size:1.05rem;color:var(--brand);margin:2px 0 2px;min-height:1.3em;animation:qbPop .4s}
    .coffee-reveal[hidden]{display:none}
    .coffee-reveal{animation:revealUp .5s cubic-bezier(.2,.9,.3,1.1)}
    @keyframes revealUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}
    .coffee-tiers{display:flex;gap:8px;margin:8px 0 12px}
    .coffee-tiers .qb-btn{flex:1;flex-direction:column;gap:3px;padding:11px 6px;height:auto;line-height:1.2;display:inline-flex;align-items:center}
    .coffee-tiers .qb-btn .ct-emoji{font-size:17px}
    .coffee-tiers .qb-btn .ct-amt{font-size:11px;color:var(--muted);font-weight:700}
    .coffee-tiers .qb-btn:hover{border-color:var(--brand);transform:translateY(-2px)}
    .coffee-custom{display:flex;align-items:center;gap:8px;margin:0 0 2px}
    .coffee-custom[hidden]{display:none}
    .coffee-custom .cc-prefix{font-weight:800;color:var(--ink-soft)}
    .coffee-custom input{width:88px;flex:0 0 auto;font:inherit;font-size:14px;font-weight:700;padding:9px 10px;border:1px solid var(--border-strong);border-radius:10px;background:var(--card-2);color:var(--ink);text-align:center}
    .coffee-custom input::-webkit-outer-spin-button,.coffee-custom input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
    #coffee-thanks{animation:qbPop .45s cubic-bezier(.2,.9,.3,1.3)}
    @keyframes qbPop{from{opacity:0;transform:scale(.8)}to{opacity:1;transform:scale(1)}}
    @media (prefers-reduced-motion: reduce){.coffee-fab.wiggle{animation:none}.barista .cup .fill{height:74%!important}.coffee-brewline,.coffee-reveal{animation:none}}
    .sub{color:var(--muted); margin:0 0 20px; font-size:14.5px; max-width:70ch}
    .grid{display:grid; gap:14px}
    .card{display:block; background:var(--card); border:1px solid var(--border); border-radius:var(--radius); padding:20px; text-decoration:none; color:inherit; box-shadow:var(--shadow-sm); transition:box-shadow .18s, transform .18s, border-color .18s}
    .card:hover{box-shadow:var(--shadow-md); transform:translateY(-2px); border-color:var(--border-strong)}
    .card-head{display:flex; justify-content:space-between; gap:12px; align-items:flex-start}
    .card h2{font-size:1.18rem; font-weight:720; margin:0; letter-spacing:-.01em}
    .desc{color:var(--muted); font-size:14px; margin:8px 0 0; line-height:1.55}
    .meta-row{display:flex; gap:8px; flex-wrap:wrap; margin-top:14px; align-items:center}
    .pill{display:inline-flex; align-items:center; font-weight:650; font-size:12px; background:var(--badge-bg); color:var(--badge-ink); border:1px solid var(--badge-border); padding:3px 11px; border-radius:var(--pill); white-space:nowrap}
    .pill.muted{background:var(--muted-bg); color:var(--muted); border-color:var(--border)}
    .pill.locked{background:var(--locked-bg); color:var(--locked-ink); border-color:var(--locked-border)}
    .pill.progress{background:var(--ok-bg); color:var(--ok-ink); border-color:var(--ok-border)}
    button.pill{cursor:pointer; font:inherit}
    .go{display:inline-flex; align-items:center; gap:6px; margin-top:14px; color:var(--brand); font-weight:700; font-size:14px}
    .card:hover .go{gap:9px}
    /* Old Question Banks：默认折叠的旧库分组，样式低调 */
    .old-banks{margin-top:20px}
    .old-banks>summary{cursor:pointer; color:var(--muted); font-size:14px; font-weight:650; padding:8px 2px; list-style:none; user-select:none}
    .old-banks>summary::-webkit-details-marker{display:none}
    .old-banks>summary::before{content:"▸"; display:inline-block; margin-right:8px; transition:transform .15s}
    .old-banks[open]>summary::before{transform:rotate(90deg)}
    .old-banks>summary:hover{color:var(--ink-soft)}
    .old-banks .grid{margin-top:12px}
    input[type=file]{font:inherit; font-size:13px; color:var(--muted)}
    /* 登录 / 做题历史 */
    #account-btn{height:36px; padding:0 12px; border-radius:10px; border:1px solid var(--border-strong); background:var(--card); color:var(--ink); font-size:13px; font-weight:650; cursor:pointer; display:inline-flex; align-items:center; gap:6px; box-shadow:var(--shadow-sm); max-width:260px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis}
    #account-btn:hover{background:var(--muted-bg)}
    .login-reminder{display:flex; align-items:center; gap:12px; flex-wrap:wrap; background:var(--ok-bg); border:1px solid var(--ok-border); color:var(--ok-ink); padding:10px 14px; border-radius:12px; margin:-6px 0 18px; font-size:13.5px; line-height:1.5}
    .login-reminder span{flex:1; min-width:200px}
    .qb-ov{position:fixed; inset:0; background:rgba(0,0,0,.45); display:flex; align-items:center; justify-content:center; padding:18px; z-index:50}
    .qb-ov[hidden]{display:none}
    .qb-card{background:var(--card); border:1px solid var(--border-strong); border-radius:16px; box-shadow:var(--shadow-md); width:100%; max-width:440px; padding:20px; max-height:86vh; overflow:auto}
    .qb-card h2{font-size:1.1rem; margin:0; font-weight:720}
    .qb-card .row{display:flex; justify-content:space-between; align-items:center; gap:12px}
    .qb-card input[type=text]{width:100%; font:inherit; font-size:14px; padding:9px 11px; border:1px solid var(--border-strong); border-radius:10px; background:var(--card); color:var(--ink); margin-top:8px}
    .qb-x{width:34px; height:34px; border-radius:50%; border:1px solid var(--border-strong); background:var(--card); color:var(--ink); cursor:pointer; flex:0 0 auto; font-size:15px; line-height:1}
    .qb-acts{display:flex; gap:8px; align-items:center; margin-top:16px}
    .qb-acts .spacer{flex:1}
    .qb-btn{height:38px; padding:0 16px; border-radius:10px; border:1px solid var(--border-strong); background:var(--card); color:var(--ink); font:inherit; font-weight:650; cursor:pointer}
    .qb-btn:hover{background:var(--muted-bg)}
    .qb-btn.primary{background:var(--brand); border-color:var(--brand); color:#fff}
    .qb-btn.primary:hover{filter:brightness(1.05)}
    .qb-danger{color:var(--danger-ink); border-color:var(--danger-ink)}
    .special-mode [data-testid="bank-list"], .special-mode #local-grid, .special-mode [data-testid="import-box"]{opacity:.38; filter:grayscale(1); pointer-events:none; user-select:none}
    .special-mode .sub{opacity:.55}
    .qb-status{font-size:13px; min-height:1.2em; margin-top:8px}
    .qb-status.ok{color:var(--ok-ink)} .qb-status.err{color:var(--danger-ink)}
    .qb-hint{color:var(--muted); font-size:13px; margin:8px 0 0; line-height:1.5}
    .hist-list{display:flex; flex-direction:column; gap:8px; margin-top:10px; max-height:54vh; overflow:auto}
    .hist-row{display:flex; align-items:center; gap:8px; padding:9px 11px; border:1px solid var(--border); border-radius:10px; background:var(--card)}
    .hist-main{flex:1; min-width:0}
    .hist-title{font-weight:650; font-size:14px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis}
    .hist-sub{font-size:12px; color:var(--muted); margin-top:2px}
    .hist-row .qb-btn{height:30px; padding:0 10px; font-size:13px}
    .hist-row .qb-x{width:28px; height:28px; font-size:13px}
    /* P16 目录卡片升级：覆盖率小环 / 错题 pill / 上次练习时间 */
    .pill.wrongs{background:var(--danger-bg); color:var(--danger-ink); border-color:var(--danger-border)}
    .qb-ring{vertical-align:-3px; margin-right:4px; flex:0 0 auto}
    .qb-last{font-size:11.5px; color:var(--muted); white-space:nowrap}
    /* CATALOG WORKBENCH — portable presentation layer; no learning-state changes. */
    :root{
      --bg:#f7f5ef; --card:#fffefa; --card-2:#f0eee6;
      --ink:#132b3a; --ink-soft:#314b56; --muted:#61716f;
      --border:#dedfd6; --border-strong:#b8c5be;
      --brand:#19685a; --brand-strong:#135448; --glow:transparent; --particle-rgb:25,104,90;
      --badge-bg:#edf3ed; --badge-ink:#19685a; --badge-border:#d1dfd4; --muted-bg:#f2f2eb;
      --shadow-sm:none; --shadow-md:0 6px 18px rgba(19,43,58,.06);
      --radius:10px; --radius-sm:7px;
    }
    html[data-theme="dark"]{
      --bg:#111e25; --card:#182a32; --card-2:#20333b;
      --ink:#ecf0e8; --ink-soft:#c4d4ce; --muted:#a4b6af;
      --border:#31454b; --border-strong:#607c77;
      --brand:#8dd2b7; --brand-strong:#a5e0c7; --glow:transparent; --particle-rgb:141,210,183;
      --badge-bg:#244039; --badge-ink:#a5e0c7; --badge-border:#395e50; --muted-bg:#20343c;
      --shadow-sm:none; --shadow-md:0 6px 18px rgba(0,0,0,.12);
    }
    body{max-width:1120px;padding:26px 32px 80px;background:var(--bg);line-height:1.55}
    .topbar{padding-bottom:22px;margin-bottom:28px;border-bottom:1px solid var(--border);gap:16px}
    .catalog-brand{display:flex;align-items:center;gap:12px;min-width:0}
    .catalog-mark{width:32px;height:32px;flex:none;color:var(--brand)}
    .topbar h1{font-size:14px;font-weight:750;letter-spacing:-.015em;margin:0;max-width:32ch}
    .topbar-controls{gap:7px}
    .lang select,#theme-toggle,#account-btn{height:34px;border-radius:6px;box-shadow:none;background:transparent}
    .catalog-eyebrow{display:block;font-size:10px;line-height:1.4;font-weight:750;letter-spacing:.14em;text-transform:uppercase;color:var(--brand)}
    .catalog-intro{margin-bottom:24px}
    .catalog-intro h2{font-size:clamp(26px,3.2vw,36px);font-weight:650;letter-spacing:-.045em;line-height:1.18;margin:9px 0 10px}
    .sub{font-size:14px;max-width:77ch;margin:0}
    .grid{grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;align-items:stretch}
    .card{padding:19px;border-radius:10px;box-shadow:none;min-width:0}
    a.card{display:flex;flex-direction:column;position:relative}
    a.card:hover{transform:translateY(-2px);border-color:var(--brand);box-shadow:var(--shadow-md)}
    a.card:focus-visible,button:focus-visible,select:focus-visible,summary:focus-visible,input:focus-visible,textarea:focus-visible{outline:2px solid var(--brand);outline-offset:4px}
    .card-head{gap:8px;flex-wrap:wrap}
    .card h2{font-size:17px;font-weight:680;line-height:1.3;letter-spacing:-.025em;overflow-wrap:anywhere}
    .card-head>.pill{font-size:10px;padding:2px 7px}
    .desc{font-size:13px;line-height:1.6;margin-top:9px}
    .meta-row{gap:5px;margin-top:16px}
    .pill{font-size:10px;font-weight:600;padding:2px 7px;border-radius:5px}
    a.card>.go{margin-top:auto;padding-top:18px;font-size:12px}
    .qb-last{font-size:10px;white-space:normal}
    .card[data-bank-id="all-banks"]{grid-column:1/-1;padding:24px 28px;background:#132b3a;color:#f7f5ef;overflow:hidden;min-height:200px}
    .card[data-bank-id="all-banks"]::after{content:"";position:absolute;width:220px;height:220px;right:30px;top:-18px;border:1px solid rgba(160,201,184,.2);border-radius:50%;box-shadow:0 0 0 28px rgba(160,201,184,.06),0 0 0 56px rgba(160,201,184,.04);pointer-events:none}
    .card[data-bank-id="all-banks"]>*{position:relative;z-index:1}
    .card[data-bank-id="all-banks"] .catalog-eyebrow{color:#9cceb7;margin-bottom:12px}
    .card[data-bank-id="all-banks"] h2{font-size:25px;letter-spacing:-.035em}
    .card[data-bank-id="all-banks"] .desc{color:#bdcfcf;max-width:70ch}
    .card[data-bank-id="all-banks"] .card-head>.pill{background:transparent;border-color:#587269;color:#c7dfd2}
    .card[data-bank-id="all-banks"] .pill.muted{background:#233e48;color:#d0dfdd;border-color:#3c5660}
    .card[data-bank-id="all-banks"] .go{color:#a7ddbf}
    .login-reminder{font-size:12px;border-radius:7px;padding:9px 12px;margin:0 0 18px;background:var(--card-2);border-color:var(--border);color:var(--ink-soft)}
    .old-banks{border-bottom:1px solid var(--border);margin:22px 0 18px;padding-bottom:12px}
    .old-banks>summary{font-size:12px;letter-spacing:.02em}
    .old-banks .card{background:var(--card-2)}
    section.card[data-testid="import-box"],#cloud-box{background:transparent;padding:20px;border:1px solid var(--border);box-shadow:none}
    section.card[data-testid="import-box"] h2,#cloud-box h2{font-size:15px}
    [data-testid="paste-box"]{border-top:1px solid var(--border);padding-top:14px;font-size:12px}
    [data-testid="import-box"] .meta-row{gap:12px}
    [data-testid="import-box"] input[type=text],[data-testid="import-box"] textarea{background:var(--card);color:var(--ink)}
    .qb-btn,.qb-card,.qb-card input[type=text]{border-radius:7px}
    html[data-theme="dark"] .qb-btn.primary{color:#132b3a}
    #coffee-btn{font-size:12px;padding:9px 13px;box-shadow:none;background:var(--card);color:var(--brand);border-color:var(--border-strong);animation:none}
    #coffee-btn.wiggle{animation:none}
    @media(max-width:900px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}.topbar h1{max-width:24ch}.card[data-bank-id="all-banks"] .desc{max-width:58ch}}
    @media(max-width:600px){
      body{padding:20px 18px 80px}.topbar{align-items:flex-start;margin-bottom:23px;padding-bottom:16px}.topbar-controls{width:100%}.catalog-brand{gap:9px}.topbar h1{max-width:none;font-size:14px}
      .lang select,#theme-toggle,#account-btn{height:44px;min-height:44px}#theme-toggle{width:44px}.lang select{padding:8px 12px}
      .catalog-intro{margin-bottom:20px}.catalog-intro h2{font-size:28px}.grid{grid-template-columns:minmax(0,1fr)}.card{padding:18px}
      .card[data-bank-id="all-banks"]{padding:22px;min-height:0}.card[data-bank-id="all-banks"] h2{font-size:22px}.card[data-bank-id="all-banks"]::after{right:-115px;top:18px}
      .card-head>.pill{white-space:normal}.login-reminder span{min-width:0;flex-basis:100%}section.card[data-testid="import-box"],#cloud-box{padding:17px}#coffee-btn{padding:11px}
    }
    @media(prefers-reduced-motion:reduce){a.card{transition:none}a.card:hover{transform:none}}
    /* END CATALOG WORKBENCH */
  </style>
</head>
<body>
  <div class="topbar">
    <div class="catalog-brand">
      <svg class="catalog-mark" viewBox="0 0 32 32" fill="none" aria-hidden="true"><rect x="1" y="1" width="30" height="30" rx="6" stroke="currentColor"/><path d="M7 23L16 7l9 16M11 17h10M7 25h18" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
    <h1 data-i18n="title">AMT Question Bank Practice</h1>
    </div>
    <div class="topbar-controls">
      <button id="theme-toggle" type="button" onclick="toggleTheme()" title="Toggle theme" aria-label="Toggle theme">🌙</button>
      <button id="account-btn" type="button" onclick="onAccountBtn()" data-testid="account-btn" title="Sign in / history">👤 <span id="account-label">Sign in</span></button>
      <label class="lang">🌐
        <select id="ui-lang" onchange="setLang(this.value)" data-testid="ui-lang-select">
          <option value="en">English</option>
          <option value="zh">中文</option>
          <option value="es">Español</option>
        </select>
      </label>
    </div>
  </div>
  <div class="catalog-intro">
    <span class="catalog-eyebrow" data-i18n="catalog_eyebrow">Aviation maintenance · study workbench</span>
    <h2 data-i18n="catalog_heading">Build confidence, one question at a time.</h2>
    <p id="catalog-sub" class="sub" data-i18n="sub">Pick a bank to start — every question on one page, submit one by one; wrong answers and stars are saved on this device.</p>
  </div>
  <div id="login-reminder" class="login-reminder" hidden data-testid="login-reminder">
    <span data-i18n="login_reminder">💡 Sign in to save every practice round and reload your history on any device.</span>
    <button class="qb-btn primary" style="height:32px;padding:0 14px" onclick="openLoginModal()" data-i18n="login_btn">Sign in</button>
  </div>
  <div class="grid" data-testid="bank-list">
${cards}
  </div>
  ${activeBanks.length ? '' : '<div class="desc" data-i18n="catalog_empty" data-testid="catalog-empty" style="padding:18px;text-align:center">No banks are published right now. You can still import your own JSON below.</div>'}
${oldBanksSection}

  <div class="grid" id="local-grid" data-testid="local-grid" style="margin-top:14px"></div>

  <section class="card" id="cloud-box" hidden data-testid="cloud-box" style="margin-top:14px">
    <div class="card-head">
      <h2 data-i18n="cloud_title">My account banks</h2>
      <span class="pill progress" data-i18n="cloud_badge_section">☁️ Private · any device</span>
    </div>
    <p class="desc" data-i18n="cloud_desc">Banks you uploaded to your account. Only you, signed in with your code, can see and open them.</p>
    <div class="grid" id="cloud-grid" data-testid="cloud-grid" style="margin-top:12px"></div>
  </section>

  <section class="card" style="margin-top:14px" data-testid="import-box">
    <div class="card-head">
      <h2 data-i18n="import_title">Import your own bank (local)</h2>
      <span class="pill muted" data-i18n="import_badge">Stays on this device</span>
    </div>
    <p class="desc" data-i18n="import_desc">Pick a question-bank .json file — it is saved in this browser only (nothing is uploaded) and appears above as a Local bank.</p>
    <div class="meta-row" style="margin-top:12px;align-items:center">
      <input type="file" id="import-file" accept=".json,application/json" data-testid="import-file">
      <a class="go" style="margin-top:0" href="format.html" data-i18n="format_link" data-testid="format-link">JSON format guide →</a>
    </div>

    <details style="margin-top:14px" data-testid="paste-box">
      <summary style="cursor:pointer;font-weight:650" data-i18n="paste_title">📋 No file? Paste the AI’s reply instead (works on free ChatGPT / Gemini)</summary>
      <p class="desc" style="margin:8px 0" data-i18n="paste_desc">Copy the whole reply and paste it here — leading/trailing chatter, code fences and even a reply cut off halfway are handled. Long test? Ask for 15 questions at a time, tick “add to the same bank” and paste each batch.</p>
      <div class="meta-row" style="align-items:center;gap:8px">
        <input type="text" id="paste-name" data-testid="paste-name" data-i18n-ph="paste_name_ph" placeholder="Bank name" style="flex:1;min-width:160px;padding:7px 9px;border:1px solid var(--border);border-radius:6px">
        <button class="go" style="margin-top:0" id="paste-go" data-testid="paste-go" data-i18n="paste_go">Import pasted text</button>
      </div>
      <label style="display:flex;align-items:center;gap:8px;margin-top:8px;font-size:13px;cursor:pointer">
        <input type="checkbox" id="paste-append" data-testid="paste-append" checked>
        <span data-i18n="paste_append">Add to the same bank (for pasting a long test in batches)</span>
      </label>
      <textarea id="paste-text" data-testid="paste-text" rows="7" data-i18n-ph="paste_ph" placeholder="Paste the AI reply here…" style="width:100%;margin-top:8px;padding:9px;border:1px solid var(--border);border-radius:6px;font-family:ui-monospace,monospace;font-size:12px"></textarea>
    </details>
    <label id="import-cloud-row" style="display:flex;align-items:center;gap:8px;margin-top:10px;font-size:13px;color:var(--ink);cursor:pointer">
      <input type="checkbox" id="import-to-account" data-testid="import-to-account">
      <span data-i18n="import_to_account">☁️ Save to my account instead — private, opens on any device after you sign in</span>
    </label>
    <p class="desc" id="import-msg" style="margin-top:8px" hidden data-testid="import-msg"></p>
  </section>

  <div class="qb-ov" id="login-modal" hidden data-testid="login-modal" onclick="if(event.target===this)closeLoginModal()">
    <div class="qb-card">
      <div class="row"><h2 id="catalog-login-title" data-i18n="login_title">Sign in to save your history</h2>
        <button class="qb-x" onclick="closeLoginModal()" aria-label="Close">✕</button></div>
      <p id="catalog-login-hint" class="qb-hint" data-i18n="login_hint">Pick a code and remember it.</p>
      <input type="text" id="login-code" maxlength="64" autocomplete="off" autocapitalize="off" spellcheck="false" data-i18n-ph="login_ph" oninput="loginInputChanged()" onkeydown="if(event.key==='Enter'){event.preventDefault();doLogin();}">
      <div class="qb-acts">
        <button class="qb-btn" onclick="closeLoginModal()" data-i18n="login_cancel">Cancel</button>
        <span class="spacer"></span>
        <button class="qb-btn primary" id="login-go" onclick="doLogin()" data-i18n="login_go">Enter</button>
      </div>
      <div class="qb-status" id="login-status"></div>
    </div>
  </div>

  <div class="qb-ov" id="history-modal" hidden data-testid="history-modal" onclick="if(event.target===this)closeHistory()">
    <div class="qb-card">
      <div class="row"><h2 data-i18n="history_title">Your practice history</h2>
        <button class="qb-x" onclick="closeHistory()" aria-label="Close">✕</button></div>
      <p class="qb-hint" data-i18n="history_sub">Your latest 10 rounds.</p>
      <div class="hist-list" id="history-list"></div>
      <section id="account-recovery-panel" hidden aria-live="assertive" style="margin:10px 0;padding:12px;border:1px solid var(--warn-border,var(--border));border-radius:10px;background:var(--card)">
        <p id="account-recovery-message" class="qb-hint" style="margin:0 0 10px"></p>
        <button class="qb-btn" id="account-recovery-ack" type="button" onclick="acknowledgeAccountRecovery()" hidden></button>
      </section>
      <div class="qb-acts">
        <button class="qb-btn" onclick="logout()" data-i18n="hist_logout">Sign out</button>
        <button class="qb-btn qb-danger" onclick="deleteMyAccount()" data-testid="del-account-btn" data-i18n="del_account_btn">Delete my data</button>
        <button class="qb-btn" id="account-delete-retry" onclick="retryAccountDeletion()" type="button" hidden>Retry deletion</button>
        <span class="spacer"></span>
        <button class="qb-btn" onclick="closeHistory()" data-i18n="login_cancel">Close</button>
      </div>
    </div>
  </div>
  <div id="account-v2-learning-notice" hidden></div>
${DONATION ? `
  <button class="coffee-fab" id="coffee-btn" type="button" onclick="openCoffee()" data-testid="coffee-btn" aria-label="Buy me a coffee">
    <span class="cf-emoji" aria-hidden="true">☕</span><span class="cf-text" data-i18n="coffee_fab">Click me for fun!</span>
  </button>
  <canvas id="qb-confetti" hidden style="position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:60"></canvas>
  <div class="qb-ov" id="coffee-modal" hidden data-testid="coffee-modal" onclick="if(event.target===this)closeCoffee()">
    <div class="qb-card" style="max-width:430px;text-align:center;position:relative;overflow:hidden">
      <button class="qb-x" onclick="closeCoffee()" data-testid="coffee-close-btn" aria-label="Close" style="position:absolute;top:14px;right:14px;z-index:3">✕</button>
      <div class="barista" id="coffee-barista" aria-hidden="true">
        <span class="machine"></span>
        <span class="bean">🫘</span>
        <span class="stream"></span>
        <div class="cup"><span class="fill"></span></div>
        <span class="steam s1"></span><span class="steam s2"></span><span class="steam s3"></span>
      </div>
      <p class="coffee-brewline" id="coffee-roll" hidden></p>
      <div class="coffee-reveal" id="coffee-reveal" hidden>
        <h2 data-i18n="coffee_title" style="margin:4px 0 6px">Buy me a coffee ☕</h2>
        <p class="qb-hint" id="coffee-stat" hidden style="margin:0 0 6px;color:var(--brand);font-weight:600"></p>
        <p class="qb-hint" data-i18n="coffee_blurb" style="margin:0 0 4px;line-height:1.6">This question bank is free. If it helped, buy me a coffee.</p>
        <div class="coffee-tiers">
          <button class="qb-btn" onclick="coffeeGo(event)" data-testid="coffee-tier-s"><span class="ct-emoji">☕</span><span data-i18n="coffee_tier_s">Espresso</span></button>
          <button class="qb-btn" onclick="coffeeGo(event)" data-testid="coffee-tier-m"><span class="ct-emoji">☕☕</span><span data-i18n="coffee_tier_m">Latte</span></button>
          <button class="qb-btn" onclick="coffeeGo(event)" data-testid="coffee-tier-l"><span class="ct-emoji">🫘</span><span data-i18n="coffee_tier_l">Whole bag</span></button>
        </div>
        <div class="coffee-custom" id="coffee-custom-row">
          <span class="cc-prefix">$</span>
          <input type="number" id="coffee-custom" min="1" step="1" inputmode="decimal" data-testid="coffee-custom" data-i18n-ph="coffee_custom_ph" aria-label="Custom amount" onkeydown="if(event.key==='Enter'){event.preventDefault();coffeeGo(event);}">
          <button class="qb-btn primary" onclick="coffeeGo(event)" data-i18n="coffee_go" data-testid="coffee-go-btn" style="flex:1;justify-content:center;white-space:nowrap">Buy me a coffee →</button>
        </div>
        <p class="qb-hint" id="coffee-thanks" hidden data-i18n="coffee_thanks" style="margin:12px 0 0;color:var(--ok-ink);font-weight:600">Thank you!</p>
      </div>
    </div>
  </div>` : ''}
  <script>
    const ACCOUNT_V2_CANDIDATE = globalThis.QB_ACCOUNT_V2_UI === true;
    let ACCOUNT_V2 = null;
    let ACCOUNT_V2_STATE = null;
    let ACCOUNT_V2_LOAD_ERROR = false;
    let ACCOUNT_V2_RESUME_EPOCH = null;
    let ACCOUNT_V2_UI_OPERATION = null;
    let ACCOUNT_V2_UI_OPERATION_SEQUENCE = 0;
    function beginAccountV2UiOperation(controller){
      const operation = { id: ++ACCOUNT_V2_UI_OPERATION_SEQUENCE, epoch: controller ? controller.snapshot().epoch : null, acceptsNextEpoch: false };
      ACCOUNT_V2_UI_OPERATION = operation;
      return operation;
    }
    function accountV2UiOperationOwns(operation){ return !!(operation && ACCOUNT_V2_UI_OPERATION === operation); }
    function bindAccountV2UiOperation(operation, controller){ if (!accountV2UiOperationOwns(operation)) return false; operation.epoch = controller.snapshot().epoch; return true; }
    function accountV2UiOperationAcceptsTransition(operation){ if (!accountV2UiOperationOwns(operation)) return false; operation.acceptsNextEpoch = true; return true; }
    function accountV2ObserveUiOperation(next){
      const operation = ACCOUNT_V2_UI_OPERATION;
      if (!operation || operation.epoch === null || operation.epoch === next.epoch) return;
      if (operation.acceptsNextEpoch && next.epoch === operation.epoch + 1){ operation.epoch = next.epoch; operation.acceptsNextEpoch = false; return; }
      ACCOUNT_V2_UI_OPERATION = null;
    }
    function accountV2UiOperationIsCurrent(operation){ return !!(operation && operation.epoch !== null && ACCOUNT_V2_UI_OPERATION === operation && ACCOUNT_V2 && ACCOUNT_V2.snapshot().epoch === operation.epoch); }
    function finishAccountV2UiOperation(operation){ if (ACCOUNT_V2_UI_OPERATION === operation) ACCOUNT_V2_UI_OPERATION = null; }
    function invalidateAccountV2UiOperation(){ ACCOUNT_V2_UI_OPERATION = null; }
    function candidateRecoveryCode(state){ return state && state.deletionRecovery === "error" ? state.deletionRecoveryError : null; }
    function candidateRecoveryAckAllowed(code){ return code === "INVALID_DELETION_JOURNAL" || code === "DELETION_TICKET_EXPIRED" || code === "DELETION_JOURNAL_CLEAR_UNCERTAIN"; }
    function candidateRecoveryBlocksControls(state){ return !!(ACCOUNT_V2_CANDIDATE && state && (state.pendingDeletion || state.deletionRecovery === "error")); }
    function candidateRecoveryText(code){
      if (code === "INVALID_DELETION_JOURNAL") return T("account_recovery_invalid");
      if (code === "DELETION_TICKET_EXPIRED") return T("account_recovery_expired");
      if (code === "DELETION_JOURNAL_CLEAR_UNCERTAIN") return T("account_recovery_uncertain");
      if (code === "STORAGE_UNAVAILABLE") return T("account_recovery_storage");
      return T("account_recovery_unavailable");
    }
    function renderCandidateAccountRecovery(state){
      if (!ACCOUNT_V2_CANDIDATE) return;
      var panel = document.getElementById("account-recovery-panel");
      var message = document.getElementById("account-recovery-message");
      var ack = document.getElementById("account-recovery-ack");
      var retry = document.getElementById("account-delete-retry");
      var code = candidateRecoveryCode(state);
      var blocked = candidateRecoveryBlocksControls(state) || ACCOUNT_V2_LOAD_ERROR;
      var cleanup=!!(state&&state.cleanupRequired);
      var visible = !!(blocked || cleanup || (state && state.pendingDeletion));
      if (panel) panel.hidden = !visible;
      if (message) message.textContent = cleanup ? (lang==='zh'?'账号已删除，本机旧资料清理尚未完成。请重试；其他账号和访客资料不会删除。':lang==='es'?'Cuenta eliminada; la limpieza local sigue pendiente. Reintenta. Otras cuentas e invitados se conservan.':'Account deleted; local cleanup is pending. Retry. Other accounts and guest data are preserved.') : ACCOUNT_V2_LOAD_ERROR ? T("account_recovery_unavailable") : (code ? candidateRecoveryText(code) : (state && state.pendingDeletion ? T("account_recovery_pending") : ""));
      if (ack) { ack.textContent = T("account_recovery_ack"); ack.hidden = !candidateRecoveryAckAllowed(code) || ACCOUNT_V2_LOAD_ERROR; }
      if (retry) retry.hidden = !cleanup && (!(state && state.pendingDeletion && state.phase === "error") || candidateRecoveryAckAllowed(code) || code === "STORAGE_UNAVAILABLE");
      if (visible){ var modal = document.getElementById("history-modal"); if (modal) modal.hidden = false; }
    }
    function resumeCandidateAccountRecovery(source){
      if (!ACCOUNT_V2 || ACCOUNT_V2_UI_OPERATION) return Promise.resolve(null);
      var before = ACCOUNT_V2.snapshot();
      if (before.deletionRecovery === "error") { renderCandidateAccountRecovery(before); return Promise.resolve(before); }
      if (source !== "bootstrap" && ACCOUNT_V2_RESUME_EPOCH === before.epoch){ renderCandidateAccountRecovery(before); return Promise.resolve(before); }
      ACCOUNT_V2_RESUME_EPOCH = before.epoch;
      return ACCOUNT_V2.resume().then(function(next){ if (ACCOUNT_V2) { ACCOUNT_V2_STATE = next; renderCandidateAccountRecovery(next); } return next; }).catch(function(error){
        if (!ACCOUNT_V2 || (error && error.code === "STALE_REQUEST")) return;
        var next = ACCOUNT_V2.snapshot(); ACCOUNT_V2_STATE = next; renderCandidateAccountRecovery(next); return next;
      });
    }
    const ACCOUNT_V2_READY = ACCOUNT_V2_CANDIDATE
      ? import("./browser/account-v2.js").then(function(mod){
          ACCOUNT_V2 = mod.createAccountV2Controller({ enabled: true, apiBase: globalThis.QB_DATA_V2_CONFIG.accountApiBase, allowMirrorApi: location.origin === 'https://shicheng0810.github.io' && globalThis.QB_DATA_V2_CONFIG.accountApiBase === 'https://question-bank-78u.pages.dev/api' });
          if(globalThis.QB_DATA_V2_CONFIG.enabled && ACCOUNT_V2.subscribeDeletionComplete)ACCOUNT_V2.subscribeDeletionComplete(async function(event){
            if(!event.owner)throw Object.assign(new Error('LOCAL_CLEANUP_OWNER_UNKNOWN'),{code:'LOCAL_CLEANUP_OWNER_UNKNOWN'});
            const storage=await import('./browser/data-v2.js');
            return storage.deleteCompletedOwnerData({ownerKind:'account',accountId:event.owner.accountId,accountGeneration:event.owner.accountGeneration},{receipt:event.receipt});
          });
          ACCOUNT_V2.subscribe(function(next){
            accountV2ObserveUiOperation(next);
            ACCOUNT_V2_STATE = next;
            updateAuthUI();
            renderCandidateAccountRecovery(next);
          });
          resumeCandidateAccountRecovery("bootstrap");
          ["focus", "pageshow"].forEach(function(eventName){ globalThis.addEventListener(eventName, function(){
            if (!ACCOUNT_V2 || ACCOUNT_V2_UI_OPERATION) { if (ACCOUNT_V2) updateAuthUI(); return; }
            resumeCandidateAccountRecovery(eventName);
          }); });
          return ACCOUNT_V2;
        }).catch(function(){ ACCOUNT_V2_LOAD_ERROR = true; updateAuthUI(); renderCandidateAccountRecovery(null); return null; })
      : Promise.resolve(null);
    function accountV2ErrorText(error){
      if (error && error.code === "RATE_LIMITED") return "Too many attempts. Please wait and retry.";
      if (error && error.code === "STALE_REQUEST") return "This action was superseded by another account change.";
      if (error && error.code === "AUTH_FAILED") return "The code or session was not accepted.";
      return "Account service unavailable. Nothing was saved or synced; please retry.";
    }
    var I18N = {
      en: {my_account:"My account",share_code_summary:"Have a bank sharing code?",share_code_label:"Bank sharing code",share_code_open:"Open bank",share_bank_label:"Shared bank", title:"AMT Question Bank Practice", sub:"Pick a bank to start — every question on one page, submit one by one; wrong answers and stars are saved on this device.",
            merged_title:"All Banks · Merged Practice", merged_desc:"Every public bank merged into one page (duplicates removed). Use \\u201CFilter Question Banks\\u201D inside to pick any combination.",
            badge_public:"Public", badge_protected:"\\uD83D\\uDD12 Protected", count:"{n} questions", progress:"{n} practiced", start:"Start practicing \\u2192",
            catalog_eyebrow:"Aviation maintenance · study workbench", catalog_heading:"Build confidence, one question at a time.", catalog_feature:"Your practice, your mix",
            ring_title:"{p}/{t} practiced", wrong_pill_title:"Wrong questions", prog_today:"today", prog_yesterday:"yesterday", prog_days_ago:"{n}d ago",
            import_title:"Import your own bank (local)", import_badge:"Stays on this device",
            import_desc:"Pick a question-bank .json file \\u2014 it is saved in this browser only (nothing is uploaded) and appears above as a Local bank.",
            format_link:"JSON format guide \\u2192", local_badge:"Local", local_practice:"Practice \\u2192", local_delete:"Delete", local_to_account:"\\u2601\\uFE0F Save to account",
            import_ok:"Imported \\u201C{t}\\u201D: {n} questions ready.", import_rej:" ({r} invalid skipped \\u2014 see format guide)",
            paste_title:"\\u1F4CB No file? Paste the AI\\u2019s reply instead (works on free ChatGPT / Gemini)", paste_desc:"Copy the whole reply and paste it here \\u2014 chatter around it, code fences, even a reply cut off halfway are handled. Long test? Ask for 15 questions at a time, tick \\u201Cadd to the same bank\\u201D and paste each batch.", paste_go:"Import pasted text", paste_append:"Add to the same bank (for pasting a long test in batches)", paste_name_ph:"Bank name", paste_ph:"Paste the AI reply here\\u2026", paste_default_name:"My bank", err_paste_empty:"Nothing pasted yet.", import_appended:"Added {a} new \\u2014 this bank now has {n} questions.", import_dup:" ({d} already in the bank, skipped)", import_salvaged:" \\u26A0 The reply looked cut off, so complete questions were recovered one by one \\u2014 ask the AI to continue, then paste the rest with \\u201Cadd to the same bank\\u201D ticked.", err_parse:"Not valid JSON \\u2014 check the file.", err_shape:"No valid questions found \\u2014 see the JSON format guide.", err_quota:"Browser storage is full \\u2014 delete a local bank or shrink images.",
            confirm_delete:"Delete this local bank? Its practice records stay until re-imported with the same file name.",
            login_btn:"Sign in", account_history:"History", login_title:"Sign in to save your history", login_hint:"Pick a code and remember it - use the same code on any device to find your history. Anyone who knows the code can see that history, so do not reuse a real password.", login_ph:"your code (4+ characters)", login_go:"Enter", login_cancel:"Cancel", login_ing:"Signing in...", login_ok:"\\u2705 Signed in", login_fail:"Couldn't sign in, try again.", login_too_short:"Code needs at least 4 characters.", login_rate:"Too many tries - wait a minute.", login_neterr:"Network error, try again later.", login_reminder:"\\uD83D\\uDCA1 Sign in to save every practice round and reload your history on any device.",
            history_title:"Your practice history", history_sub:"Your latest 10 rounds (oldest dropped). Tap Load to reopen a round with your answers.", hist_loading:"Loading...", hist_empty:"No saved rounds yet - answer a few questions and they will show up here.", hist_load:"Load", hist_neterr:"Couldn't load history.", hist_del_confirm:"Delete this record?", hist_load_fail:"Couldn't load that round.", hist_logout:"Sign out", hist_unanswered:"not started", account_recovery_tab_session:"If deletion was interrupted, reloading this tab may resume recovery. Closing the browser, another tab, or another device is not guaranteed.", account_recovery_invalid:"This tab's deletion-recovery record cannot be read. Account actions are blocked. Acknowledgement only forgets this tab's unusable marker.", account_recovery_expired:"This tab's deletion-recovery period ended before completion could be confirmed. No account or learning data was restored. Acknowledgement only removes this tab's expired marker.", account_recovery_uncertain:"This tab cannot verify whether deletion finished. No account request will be sent from this screen, and acknowledgement does not confirm deletion.", account_recovery_storage:"Deletion-recovery storage is unavailable. Account actions remain blocked; reload after browser storage is available.", account_recovery_unavailable:"The account service is unavailable. Account actions remain blocked; public practice is still available.", account_recovery_ack:"Acknowledge recovery state", account_recovery_ack_confirm:"This only clears this tab's recovery marker when it is safe to do so. It does not confirm deletion, restore your account, or recover learning data.", account_recovery_pending:"Deletion is pending. Reloading this tab may resume this deletion recovery; another tab, browser close, or another device is not guaranteed.",
            cloud_title:"My account banks", cloud_badge_section:"\\u2601\\uFE0F Private \\u00B7 any device", cloud_badge:"\\u2601\\uFE0F Private", cloud_desc:"Banks you uploaded to your account. Only you, signed in with your code, can see and open them.", cloud_empty:"No account banks yet. Tick \\u201CSave to my account\\u201D below when you import a file.", cloud_delete:"Remove", cloud_del_confirm:"Remove this bank from your account? It is deleted from the cloud.", import_to_account:"\\u2601\\uFE0F Save to my account instead - private, opens on any device after you sign in", cloud_need_login:"Sign in first to upload to your account.", cloud_uploading:"Uploading to your account...", cloud_uploaded:"Uploaded \\u201C{t}\\u201D: {n} questions to your account.", cloud_moved:"Moved \\u201C{t}\\u201D ({n} questions) to your account; the local copy and its progress were removed.", cloud_limit:"Account bank limit reached ({n}). Remove one first.", cloud_too_large:"This bank is too large to upload - try removing large images.", cloud_fail:"Upload failed, please try again.", cloud_neterr:"Network error, try again later.", del_account_btn:"Delete my data", del_account_confirm:"Permanently delete your account and ALL your data (history + private banks)? This cannot be undone. You can sign in again later with the same code to start fresh.", del_account_done:"\\u2705 Your account and all your data were deleted.", del_account_fail:"Couldn't delete - please try again.", special_ok:"\\u2705 Opening the shared bank...", special_badge:"\\uD83D\\uDD11 Shared", special_exit:"Exit", special_exit_confirm:"Exit this shared bank? Your practice here is not saved.",
            coffee_title:"Buy me a coffee ☕", coffee_fab:"Buy me a coffee", coffee_brewing:"Brewing your coffee… ☕", coffee_brew_done:"Fresh brew, just for you! ☕", coffee_blurb:"This question bank is free and ad-free, built by one person. If it helped your studying, a coffee keeps it caffeinated and growing. 🙏", coffee_stat:"You've practiced {n} banks here. ☕", coffee_tier_s:"Espresso", coffee_tier_m:"Latte", coffee_tier_l:"Whole bag", coffee_go:"Buy me a coffee →", coffee_custom_ph:"other", coffee_thanks:"You're the best — thank you! ☕✨" },
      zh: {my_account:"我的账号",share_code_summary:"有题库分享码？",share_code_label:"题库分享码",share_code_open:"打开题库",share_bank_label:"分享题库", title:"AMT \\u9898\\u5E93\\u7EC3\\u4E60", sub:"\\u9009\\u62E9\\u4E00\\u4E2A\\u9898\\u5E93\\u5F00\\u59CB \\u2014 \\u6240\\u6709\\u9898\\u76EE\\u4E00\\u9875\\u5E73\\u94FA\\uFF0C\\u9010\\u9898\\u63D0\\u4EA4\\uFF0C\\u9519\\u9898/\\u6536\\u85CF\\u81EA\\u52A8\\u4FDD\\u5B58\\u5728\\u672C\\u673A\\u3002",
            merged_title:"\\u5168\\u90E8\\u9898\\u5E93 \\u00B7 \\u5408\\u5E76\\u7EC3\\u4E60", merged_desc:"\\u6240\\u6709\\u516C\\u5F00\\u9898\\u5E93\\u5408\\u5E76\\u5230\\u4E00\\u9875\\uFF08\\u91CD\\u590D\\u9898\\u5DF2\\u667A\\u80FD\\u53BB\\u91CD\\uFF09\\u3002\\u6253\\u5F00\\u540E\\u5728\\u300C\\u7B5B\\u9009\\u9898\\u5E93\\u300D\\u91CC\\u52FE\\u9009\\u4EFB\\u610F\\u7EC4\\u5408\\u4E00\\u8D77\\u505A\\u3002",
            badge_public:"\\u516C\\u5F00", badge_protected:"\\uD83D\\uDD12 \\u5BC6\\u7801\\u4FDD\\u62A4", count:"{n} \\u9898", progress:"\\u5DF2\\u505A {n} \\u9898", start:"\\u5F00\\u59CB\\u505A\\u9898 \\u2192",
            catalog_eyebrow:"航空维修 · 学习工作台", catalog_heading:"每一道练习，积累一份信心。", catalog_feature:"自由组合，专注练习",
            ring_title:"已练 {p}/{t}", wrong_pill_title:"错题数", prog_today:"今天", prog_yesterday:"昨天", prog_days_ago:"{n} 天前",
            import_title:"\\u5BFC\\u5165\\u81EA\\u5DF1\\u7684\\u9898\\u5E93\\uFF08\\u672C\\u5730\\uFF09", import_badge:"\\u4EC5\\u5B58\\u672C\\u8BBE\\u5907",
            import_desc:"\\u9009\\u4E00\\u4E2A\\u9898\\u5E93 .json \\u6587\\u4EF6 \\u2014 \\u53EA\\u5B58\\u5728\\u8FD9\\u4E2A\\u6D4F\\u89C8\\u5668\\u91CC\\uFF08\\u4E0D\\u4E0A\\u4F20\\uFF09\\uFF0C\\u5BFC\\u5165\\u540E\\u5728\\u4E0A\\u65B9\\u4EE5\\u300C\\u672C\\u5730\\u300D\\u5361\\u7247\\u51FA\\u73B0\\u3002",
            format_link:"JSON \\u683C\\u5F0F\\u8BF4\\u660E \\u2192", local_badge:"\\u672C\\u5730", local_practice:"\\u5F00\\u59CB\\u505A\\u9898 \\u2192", local_delete:"\\u5220\\u9664", local_to_account:"\\u2601\\uFE0F 存到账号",
            import_ok:"\\u5DF2\\u5BFC\\u5165\\u300C{t}\\u300D\\uFF1A{n} \\u9898\\u53EF\\u7528\\u3002", import_rej:"\\uFF08\\u8DF3\\u8FC7 {r} \\u6761\\u4E0D\\u5408\\u683C\\u8BB0\\u5F55\\uFF0C\\u89C1\\u683C\\u5F0F\\u8BF4\\u660E\\uFF09",
            paste_title:"\\u1F4CB \\u6CA1\\u6709\\u6587\\u4EF6\\uFF1F\\u76F4\\u63A5\\u7C98\\u8D34 AI \\u7684\\u56DE\\u590D\\uFF08\\u514D\\u8D39\\u7248 ChatGPT / Gemini \\u53EF\\u7528\\uFF09", paste_desc:"\\u628A\\u6574\\u6BB5\\u56DE\\u590D\\u590D\\u5236\\u8FC7\\u6765\\u7C98\\u5728\\u8FD9\\u91CC\\u2014\\u2014\\u524D\\u540E\\u7684\\u5BA2\\u5957\\u8BDD\\u3001\\u4EE3\\u7801\\u56F4\\u6805\\u3001\\u751A\\u81F3\\u88AB\\u622A\\u65AD\\u5728\\u534A\\u53E5\\u7684\\u56DE\\u590D\\u90FD\\u80FD\\u5904\\u7406\\u3002\\u9898\\u591A\\u5C31\\u8BA9 AI \\u6BCF\\u6B21\\u53EA\\u7ED9 15 \\u9898\\uFF0C\\u52FE\\u4E0A\\u300C\\u5E76\\u5165\\u540C\\u540D\\u9898\\u5E93\\u300D\\u9010\\u6279\\u7C98\\u3002", paste_go:"\\u5BFC\\u5165\\u7C98\\u8D34\\u5185\\u5BB9", paste_append:"\\u5E76\\u5165\\u540C\\u540D\\u9898\\u5E93\\uFF08\\u5206\\u6279\\u7C98\\u957F\\u5377\\u65F6\\u52FE\\u4E0A\\uFF09", paste_name_ph:"\\u9898\\u5E93\\u540D\\u79F0", paste_ph:"\\u628A AI \\u7684\\u56DE\\u590D\\u7C98\\u5728\\u8FD9\\u91CC\\u2026", paste_default_name:"\\u6211\\u7684\\u9898\\u5E93", err_paste_empty:"\\u8FD8\\u6CA1\\u7C98\\u8D34\\u5185\\u5BB9\\u3002", import_appended:"\\u65B0\\u589E {a} \\u9898\\u2014\\u2014\\u8BE5\\u9898\\u5E93\\u73B0\\u6709 {n} \\u9898\\u3002", import_dup:"\\uFF08{d} \\u9898\\u5DF2\\u5B58\\u5728\\uFF0C\\u5DF2\\u8DF3\\u8FC7\\uFF09", import_salvaged:" \\u26A0 \\u56DE\\u590D\\u770B\\u8D77\\u6765\\u88AB\\u622A\\u65AD\\u4E86\\uFF0C\\u5DF2\\u9010\\u6761\\u62A2\\u6551\\u51FA\\u5B8C\\u6574\\u7684\\u9898\\u2014\\u2014\\u8BF7\\u8BA9 AI \\u63A5\\u7740\\u5199\\uFF0C\\u5269\\u4E0B\\u7684\\u52FE\\u4E0A\\u300C\\u5E76\\u5165\\u540C\\u540D\\u9898\\u5E93\\u300D\\u518D\\u7C98\\u4E00\\u6B21\\u3002", err_parse:"\\u4E0D\\u662F\\u5408\\u6CD5\\u7684 JSON \\u6587\\u4EF6\\u3002", err_shape:"\\u6CA1\\u6709\\u627E\\u5230\\u53EF\\u7528\\u9898\\u76EE \\u2014 \\u8BF7\\u770B JSON \\u683C\\u5F0F\\u8BF4\\u660E\\u3002", err_quota:"\\u6D4F\\u89C8\\u5668\\u5B58\\u50A8\\u5DF2\\u6EE1 \\u2014 \\u5220\\u4E2A\\u672C\\u5730\\u9898\\u5E93\\u6216\\u51CF\\u5C0F\\u56FE\\u7247\\u3002",
            confirm_delete:"\\u5220\\u9664\\u8FD9\\u4E2A\\u672C\\u5730\\u9898\\u5E93\\uFF1F\\uFF08\\u505A\\u9898\\u8BB0\\u5F55\\u4FDD\\u7559\\uFF0C\\u540C\\u540D\\u91CD\\u65B0\\u5BFC\\u5165\\u53EF\\u63A5\\u7EED\\uFF09",
            login_btn:"登录", account_history:"历史", login_title:"登录以保存历史", login_hint:"自定义一个码并记住它——换设备也用同一个码就能找回历史。知道码的人就能看到那份历史，别用你别处的真实密码。", login_ph:"你的码（4 位以上）", login_go:"进入", login_cancel:"取消", login_ing:"登录中...", login_ok:"\\u2705 已登录", login_fail:"登录失败，请重试。", login_too_short:"码至少要 4 位。", login_rate:"尝试太频繁，请稍等一分钟。", login_neterr:"网络错误，请稍后再试。", login_reminder:"\\uD83D\\uDCA1 登录后可保存每次做题、并在任意设备重新加载你的历史。",
            history_title:"你的做题历史", history_sub:"最近 10 轮（超出删最旧）。点「载入」回到那一轮、带上你的作答。", hist_loading:"加载中...", hist_empty:"还没有记录——做几道题就会出现在这里。", hist_load:"载入", hist_neterr:"加载历史失败。", hist_del_confirm:"删除这条记录？", hist_load_fail:"载入这一轮失败。", hist_logout:"退出登录", hist_unanswered:"未开始", account_recovery_tab_session:"如果删除被中断，重新加载本标签页可能继续恢复。关闭浏览器、换标签页或换设备不保证能恢复。", account_recovery_invalid:"此标签页的删除恢复记录无法读取。账号操作已阻止。确认只会忘记此标签页无法使用的标记。", account_recovery_expired:"此标签页的删除恢复期限已结束，无法确认是否完成。没有账号或学习数据被恢复。确认只会移除此标签页已过期的标记。", account_recovery_uncertain:"此标签页无法确认删除是否完成。本页面不会发送账号请求，确认也不代表删除已完成。", account_recovery_storage:"删除恢复存储不可用。账号操作仍被阻止；请在浏览器存储恢复后重新加载。", account_recovery_unavailable:"账号服务不可用。账号操作仍被阻止，但仍可进行公开练习。", account_recovery_ack:"确认恢复状态", account_recovery_ack_confirm:"这只会在安全时清除此标签页的恢复标记。它不确认删除、不恢复账号，也不恢复学习数据。", account_recovery_pending:"删除仍在处理中。重新加载此标签页可能继续恢复；换标签页、关闭浏览器或换设备不保证能继续。",
            cloud_title:"我的账号题库", cloud_badge_section:"\\u2601\\uFE0F 私有 \\u00B7 任意设备", cloud_badge:"\\u2601\\uFE0F 私有", cloud_desc:"你上传到账号的题库。只有用你的码登录的你，才能看到和打开。", cloud_empty:"账号里还没有题库。导入文件时勾选下面的「传到账号」即可。", cloud_delete:"移除", cloud_del_confirm:"从账号移除这个题库？（会从云端删除。）", import_to_account:"\\u2601\\uFE0F 改为传到我的账号 —— 私有，登录后任意设备都能打开", cloud_need_login:"请先登录再上传到账号。", cloud_uploading:"正在上传到账号...", cloud_uploaded:"已上传「{t}」：{n} 题到你的账号。", cloud_moved:"已把「{t}」（{n} 题）移到你的账号；本地副本和进度已一并移走。", cloud_limit:"账号题库数量已达上限（{n}）。请先移除一个。", cloud_too_large:"题库太大无法上传 —— 试试去掉大图片。", cloud_fail:"上传失败，请重试。", cloud_neterr:"网络错误，请稍后再试。", del_account_btn:"删除我的数据", del_account_confirm:"永久删除你的账号和全部数据（历史 + 私有题库）？此操作无法撤销。之后仍可用同一个码重新登录、从空账号开始。", del_account_done:"\\u2705 你的账号和全部数据已删除。", del_account_fail:"删除失败，请重试。", special_ok:"\\u2705 正在打开分享题库...", special_badge:"\\uD83D\\uDD11 分享", special_exit:"退出", special_exit_confirm:"退出这个分享题库？这里的做题不会保存。",
            coffee_title:"请我喝杯咖啡 ☕", coffee_fab:"请我喝杯咖啡", coffee_brewing:"正在为你现做… ☕", coffee_brew_done:"刚出炉，专属你的一杯！☕", coffee_blurb:"这个题库免费、无广告，一个人做的。如果它帮到了你的复习，一杯咖啡能让它继续有咖啡因、继续长大。🙏", coffee_stat:"你已经在这里练过 {n} 个题库。☕", coffee_tier_s:"浓缩", coffee_tier_m:"拿铁", coffee_tier_l:"一整袋豆", coffee_go:"请我喝咖啡 →", coffee_custom_ph:"自定义", coffee_thanks:"你最好了 —— 谢谢你！☕✨" },
      es: {my_account:"Mi cuenta",share_code_summary:"¿Tienes un código de banco?",share_code_label:"Código del banco",share_code_open:"Abrir banco",share_bank_label:"Banco compartido", title:"Pr\\u00E1ctica del banco de preguntas AMT", sub:"Elige un banco para empezar: todas las preguntas en una p\\u00E1gina, env\\u00EDa una por una; errores y favoritas se guardan en este dispositivo.",
            merged_title:"Todos los bancos \\u00B7 Pr\\u00E1ctica combinada", merged_desc:"Todos los bancos p\\u00FAblicos en una sola p\\u00E1gina (sin duplicados). Usa \\u201CFiltrar bancos\\u201D dentro para elegir cualquier combinaci\\u00F3n.",
            badge_public:"P\\u00FAblica", badge_protected:"\\uD83D\\uDD12 Protegida", count:"{n} preguntas", progress:"{n} practicadas", start:"Empezar \\u2192",
            catalog_eyebrow:"Mantenimiento aeronáutico · espacio de estudio", catalog_heading:"Gana confianza, pregunta a pregunta.", catalog_feature:"Tu práctica, tu combinación",
            ring_title:"{p}/{t} practicadas", wrong_pill_title:"Preguntas falladas", prog_today:"hoy", prog_yesterday:"ayer", prog_days_ago:"hace {n} días",
            import_title:"Importa tu propio banco (local)", import_badge:"Solo en este dispositivo",
            import_desc:"Elige un archivo .json \\u2014 se guarda solo en este navegador (no se sube nada) y aparece arriba como banco Local.",
            format_link:"Gu\\u00EDa del formato JSON \\u2192", local_badge:"Local", local_practice:"Practicar \\u2192", local_delete:"Eliminar", local_to_account:"\\u2601\\uFE0F Guardar en cuenta",
            import_ok:"Importado \\u201C{t}\\u201D: {n} preguntas listas.", import_rej:" ({r} inv\\u00E1lidas omitidas \\u2014 ver gu\\u00EDa)",
            paste_title:"\\u1F4CB \\u00BFSin archivo? Pega la respuesta de la IA (sirve con ChatGPT / Gemini gratis)", paste_desc:"Copia toda la respuesta y p\\u00E9gala aqu\\u00ED: se admite texto alrededor, bloques de c\\u00F3digo e incluso una respuesta cortada a medias. \\u00BFExamen largo? Pide 15 preguntas cada vez, marca \\u201Ca\\u00F1adir al mismo banco\\u201D y pega cada lote.", paste_go:"Importar lo pegado", paste_append:"A\\u00F1adir al mismo banco (para pegar por lotes)", paste_name_ph:"Nombre del banco", paste_ph:"Pega aqu\\u00ED la respuesta de la IA\\u2026", paste_default_name:"Mi banco", err_paste_empty:"A\\u00FAn no has pegado nada.", import_appended:"{a} nuevas \\u2014 este banco tiene ahora {n} preguntas.", import_dup:" ({d} ya estaban, omitidas)", import_salvaged:" \\u26A0 La respuesta parec\\u00EDa cortada; se recuperaron las preguntas completas una a una \\u2014 pide a la IA que contin\\u00FAe y pega el resto con \\u201Ca\\u00F1adir al mismo banco\\u201D marcado.", err_parse:"JSON no v\\u00E1lido.", err_shape:"No se encontraron preguntas v\\u00E1lidas \\u2014 ver la gu\\u00EDa del formato.", err_quota:"Almacenamiento del navegador lleno.",
            confirm_delete:"\\u00BFEliminar este banco local?",
            login_btn:"Entrar", account_history:"Historial", login_title:"Entra para guardar tu historial", login_hint:"Elige un código y recuérdalo - usa el mismo en cualquier dispositivo para encontrar tu historial. Quien conozca el código verá ese historial, así que no uses una contraseña real.", login_ph:"tu código (4+ caracteres)", login_go:"Entrar", login_cancel:"Cancelar", login_ing:"Entrando...", login_ok:"\\u2705 Sesión iniciada", login_fail:"No se pudo entrar, reinténtalo.", login_too_short:"El código necesita 4+ caracteres.", login_rate:"Demasiados intentos - espera un minuto.", login_neterr:"Error de red, inténtalo más tarde.", login_reminder:"\\uD83D\\uDCA1 Inicia sesión para guardar cada ronda y recargar tu historial en cualquier dispositivo.",
            history_title:"Tu historial de práctica", history_sub:"Tus últimas 10 rondas (se elimina la más antigua). Pulsa Cargar para reabrir una ronda con tus respuestas.", hist_loading:"Cargando...", hist_empty:"Aún no hay rondas - responde algunas preguntas y aparecerán aquí.", hist_load:"Cargar", hist_neterr:"No se pudo cargar el historial.", hist_del_confirm:"¿Eliminar este registro?", hist_load_fail:"No se pudo cargar esa ronda.", hist_logout:"Cerrar sesión", hist_unanswered:"sin empezar", account_recovery_tab_session:"Si la eliminación se interrumpió, recargar esta pestaña puede reanudar la recuperación. No se garantiza al cerrar el navegador, usar otra pestaña u otro dispositivo.", account_recovery_invalid:"No se puede leer el registro de recuperación de eliminación de esta pestaña. Las acciones de cuenta están bloqueadas. Reconocerlo solo olvida el marcador inutilizable de esta pestaña.", account_recovery_expired:"El periodo de recuperación de esta pestaña terminó antes de confirmar el resultado. No se restauraron la cuenta ni los datos de aprendizaje. Reconocerlo solo quita el marcador caducado de esta pestaña.", account_recovery_uncertain:"Esta pestaña no puede verificar si la eliminación terminó. Esta pantalla no enviará ninguna solicitud de cuenta, y reconocerlo no confirma la eliminación.", account_recovery_storage:"El almacenamiento de recuperación no está disponible. Las acciones de cuenta siguen bloqueadas; recarga cuando el almacenamiento del navegador esté disponible.", account_recovery_unavailable:"El servicio de cuenta no está disponible. Las acciones de cuenta siguen bloqueadas, pero la práctica pública continúa disponible.", account_recovery_ack:"Reconocer estado de recuperación", account_recovery_ack_confirm:"Esto solo borra el marcador de recuperación de esta pestaña cuando es seguro hacerlo. No confirma la eliminación, no restaura tu cuenta ni recupera datos de aprendizaje.", account_recovery_pending:"La eliminación está pendiente. Recargar esta pestaña puede reanudarla; otra pestaña, cerrar el navegador u otro dispositivo no ofrecen garantía.",
            cloud_title:"Mis bancos de la cuenta", cloud_badge_section:"\\u2601\\uFE0F Privado \\u00B7 cualquier dispositivo", cloud_badge:"\\u2601\\uFE0F Privado", cloud_desc:"Bancos que subiste a tu cuenta. Solo tú, con tu código, puedes verlos y abrirlos.", cloud_empty:"Aún no hay bancos en la cuenta. Marca \\u201CGuardar en mi cuenta\\u201D al importar un archivo.", cloud_delete:"Quitar", cloud_del_confirm:"\\u00BFQuitar este banco de tu cuenta? Se elimina de la nube.", import_to_account:"\\u2601\\uFE0F Guardar en mi cuenta - privado, se abre en cualquier dispositivo tras iniciar sesión", cloud_need_login:"Inicia sesión primero para subir a tu cuenta.", cloud_uploading:"Subiendo a tu cuenta...", cloud_uploaded:"Subido \\u201C{t}\\u201D: {n} preguntas a tu cuenta.", cloud_moved:"Movido \\u201C{t}\\u201D ({n} preguntas) a tu cuenta; la copia local y su progreso se quitaron.", cloud_limit:"Límite de bancos alcanzado ({n}). Quita uno primero.", cloud_too_large:"Este banco es demasiado grande - quita imágenes grandes.", cloud_fail:"Error al subir, inténtalo de nuevo.", cloud_neterr:"Error de red, inténtalo más tarde.", del_account_btn:"Eliminar mis datos", del_account_confirm:"¿Eliminar permanentemente tu cuenta y TODOS tus datos (historial + bancos privados)? No se puede deshacer. Puedes volver a entrar con el mismo código y empezar de cero.", del_account_done:"\\u2705 Tu cuenta y todos tus datos se eliminaron.", del_account_fail:"No se pudo eliminar - inténtalo de nuevo.", special_ok:"\\u2705 Abriendo el banco compartido...", special_badge:"\\uD83D\\uDD11 Compartido", special_exit:"Salir", special_exit_confirm:"¿Salir de este banco compartido? Tu práctica aquí no se guarda.",
            coffee_title:"Invítame a un café ☕", coffee_fab:"Invítame a un café", coffee_brewing:"Preparando tu café… ☕", coffee_brew_done:"¡Recién hecho, solo para ti! ☕", coffee_blurb:"Este banco de preguntas es gratis y sin anuncios, hecho por una sola persona. Si te ayudó a estudiar, un café lo mantiene con cafeína y creciendo. 🙏", coffee_stat:"Has practicado {n} bancos aquí. ☕", coffee_tier_s:"Espresso", coffee_tier_m:"Latte", coffee_tier_l:"Bolsa entera", coffee_go:"Invítame a un café →", coffee_custom_ph:"otro", coffee_thanks:"¡Eres lo mejor — gracias! ☕✨" }
    };
    var LANG_KEY = "qb_ui_lang"; // 与做题页共用同一偏好
    var lang = (function(){ try{ var v = localStorage.getItem(LANG_KEY); return I18N[v] ? v : "en"; }catch(e){ return "en"; } })();
    I18N.en.cloud_copy_ok = "Uploaded \u201C{t}\u201D ({n} questions); the local copy and all progress remain on this browser.";
    I18N.en.cloud_copy_partial = "Uploaded \u201C{t}\u201D ({n} questions); the local copy remains, but progress copy is incomplete ({c} conflict(s), {f} failure(s)). Retry to continue.";
    I18N.zh.cloud_copy_ok = "已上传「{t}」（{n} 题）；本地副本和全部进度仍保留在本浏览器。";
    I18N.zh.cloud_copy_partial = "已上传「{t}」（{n} 题）；本地副本保留，但进度复制未完成（{c} 个冲突、{f} 个失败），可重试继续。";
    I18N.es.cloud_copy_ok = "Subido \u201C{t}\u201D ({n} preguntas); la copia local y todo el progreso siguen en este navegador.";
    I18N.es.cloud_copy_partial = "Subido \u201C{t}\u201D ({n} preguntas); la copia local sigue aquí, pero la copia del progreso está incompleta ({c} conflicto(s), {f} fallo(s)). Reintenta para continuar.";
    I18N.en.cloud_moved = I18N.en.cloud_copy_ok;
    I18N.zh.cloud_moved = I18N.zh.cloud_copy_ok;
    I18N.es.cloud_moved = I18N.es.cloud_copy_ok;
    var ACCOUNT_RECOVERY_I18N = {
      en: { account_recovery_tab_session:"If deletion was interrupted, reloading this tab may resume recovery. Closing the browser, another tab, or another device is not guaranteed.", account_recovery_invalid:"This tab's deletion-recovery record cannot be read. Account actions are blocked. Acknowledgement only forgets this tab's unusable marker.", account_recovery_expired:"This tab's deletion-recovery period ended before completion could be confirmed. No account or learning data was restored. Acknowledgement only removes this tab's expired marker.", account_recovery_uncertain:"This tab cannot verify whether deletion finished. No account request will be sent from this screen, and acknowledgement does not confirm deletion.", account_recovery_storage:"Deletion-recovery storage is unavailable. Account actions remain blocked; reload after browser storage is available.", account_recovery_unavailable:"The account service is unavailable. Account actions remain blocked; public practice is still available.", account_recovery_ack:"Acknowledge recovery state", account_recovery_ack_confirm:"This only clears this tab's recovery marker when it is safe to do so. It does not confirm deletion, restore your account, or recover learning data.", account_recovery_pending:"Deletion is pending. Reloading this tab may resume this deletion recovery; another tab, browser close, or another device is not guaranteed." },
      zh: { account_recovery_tab_session:"如果删除被中断，重新加载本标签页可能继续恢复。关闭浏览器、换标签页或换设备不保证能恢复。", account_recovery_invalid:"此标签页的删除恢复记录无法读取。账号操作已阻止。确认只会忘记此标签页无法使用的标记。", account_recovery_expired:"此标签页的删除恢复期限已结束，无法确认是否完成。没有账号或学习数据被恢复。确认只会移除此标签页已过期的标记。", account_recovery_uncertain:"此标签页无法确认删除是否完成。本页面不会发送账号请求，确认也不代表删除已完成。", account_recovery_storage:"删除恢复存储不可用。账号操作仍被阻止；请在浏览器存储恢复后重新加载。", account_recovery_unavailable:"账号服务不可用。账号操作仍被阻止，但仍可进行公开练习。", account_recovery_ack:"确认恢复状态", account_recovery_ack_confirm:"这只会在安全时清除此标签页的恢复标记。它不确认删除、不恢复账号，也不恢复学习数据。", account_recovery_pending:"删除仍在处理中。重新加载此标签页可能继续恢复；换标签页、关闭浏览器或换设备不保证能继续。" },
      es: { account_recovery_tab_session:"Si la eliminación se interrumpió, recargar esta pestaña puede reanudar la recuperación. No se garantiza al cerrar el navegador, usar otra pestaña u otro dispositivo.", account_recovery_invalid:"No se puede leer el registro de recuperación de eliminación de esta pestaña. Las acciones de cuenta están bloqueadas. Reconocerlo solo olvida el marcador inutilizable de esta pestaña.", account_recovery_expired:"El periodo de recuperación de esta pestaña terminó antes de confirmar el resultado. No se restauraron la cuenta ni los datos de aprendizaje. Reconocerlo solo quita el marcador caducado de esta pestaña.", account_recovery_uncertain:"Esta pestaña no puede verificar si la eliminación terminó. Esta pantalla no enviará ninguna solicitud de cuenta, y reconocerlo no confirma la eliminación.", account_recovery_storage:"El almacenamiento de recuperación no está disponible. Las acciones de cuenta siguen bloqueadas; recarga cuando el almacenamiento del navegador esté disponible.", account_recovery_unavailable:"El servicio de cuenta no está disponible. Las acciones de cuenta siguen bloqueadas, pero la práctica pública continúa disponible.", account_recovery_ack:"Reconocer estado de recuperación", account_recovery_ack_confirm:"Esto solo borra el marcador de recuperación de esta pestaña cuando es seguro hacerlo. No confirma la eliminación, no restaura tu cuenta ni recupera datos de aprendizaje.", account_recovery_pending:"La eliminación está pendiente. Recargar esta pestaña puede reanudarla; otra pestaña, cerrar el navegador u otro dispositivo no ofrecen garantía." }
    };
    Object.keys(ACCOUNT_RECOVERY_I18N).forEach(function(k){ Object.assign(I18N[k], ACCOUNT_RECOVERY_I18N[k]); });
    function T(k, vars){
      var s = (I18N[lang] && I18N[lang][k]) || I18N.en[k] || k;
      if (vars) Object.keys(vars).forEach(function(key){ s = s.split("{" + key + "}").join(String(vars[key])); });
      return s;
    }
    function escHtml(v){ return String(v == null ? "" : v).replace(/[&<>"']/g, function(m){ return ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[m]; }); }

    /* ---- 本地题库（仅存浏览器，qb_local_banks_v1）---- */
    var LOCAL_KEY = "qb_local_banks_v1";
    function loadLocalBanks(){ if (ACCOUNT_V2_CANDIDATE) return {}; try{ var o = JSON.parse(localStorage.getItem(LOCAL_KEY) || "{}"); return (o && typeof o === "object" && !Array.isArray(o)) ? o : {}; }catch(e){ return {}; } }
    function saveLocalBanks(o){ if (ACCOUNT_V2_CANDIDATE) return; localStorage.setItem(LOCAL_KEY, JSON.stringify(o)); }
    // 与发布脚本同规则的轻量校验（导入侧提示用；详见 format.html）
    function validateBank(list){
      var valid = [], rejected = 0;
      (Array.isArray(list) ? list : []).forEach(function(rec, idx){
        if (!rec || typeof rec !== "object" || Array.isArray(rec)) { rejected++; return; }
        var bad = false;
        // 缺 id 自动补一个（本地练习够用；id 仅用于错题/收藏的存储 key）——AI 产出最常见的“缺字段”
        if (!String(rec.id == null ? "" : rec.id).trim()) rec.id = "auto-" + (idx + 1);
        // —— 归一化便宜 AI 的常见偏差（实测 Gemini 输出）——
        if (rec.id != null && typeof rec.id !== "string") rec.id = String(rec.id); // 数字 id → 字符串
        // 单选答案被包成数组：answer:[2] → answer:2；answer:[0,2] → answers:[0,2]
        if (Array.isArray(rec.answer)){
          if (rec.answer.length === 1) rec.answer = rec.answer[0];
          else { rec.answers = rec.answer; delete rec.answer; }
        }
        // 索引写成字符串数字："2" → 2（answer 与 answers 都兜）
        var toIdx = function(v){ return (typeof v === "string" && /^[0-9]+$/.test(v.trim())) ? parseInt(v, 10) : v; };
        if (rec.answer !== undefined && rec.answer !== null) rec.answer = toIdx(rec.answer);
        if (Array.isArray(rec.answers)) rec.answers = rec.answers.map(toIdx);
        var hasImg = !!(rec.image && (typeof rec.image === "string" || (Array.isArray(rec.image) && rec.image.length)));
        if (!String(rec.question == null ? "" : rec.question).trim() && !hasImg) bad = true;
        var isFill = rec.type === "fill" || Array.isArray(rec.blanks);
        if (isFill){
          var okFill = (Array.isArray(rec.blanks) ? rec.blanks : []).some(function(a){ return Array.isArray(a) && a.some(function(v){ return String(v == null ? "" : v).trim(); }); });
          if (!okFill) bad = true;
        } else if (Array.isArray(rec.choices)){
          var n = rec.choices.length;
          if (n < 2) bad = true;
          else if (Array.isArray(rec.answers)){
            if (!(rec.answers.length >= 1 && rec.answers.every(function(a){ return Number.isInteger(a) && a >= 0 && a < n; }))) bad = true;
          } else if (!(Number.isInteger(rec.answer) && rec.answer >= 0 && rec.answer < n)) bad = true;
        } else bad = true;
        if (bad) rejected++; else valid.push(rec);
      });
      return { valid: valid, rejected: rejected };
    }
    function renderLocalBanks(){
      var grid = document.getElementById("local-grid");
      if (!grid) return;
      if (ACCOUNT_V2_CANDIDATE){ grid.hidden = false; catalogV2Refresh(); return; }
      var banks = loadLocalBanks();
      var ids = Object.keys(banks);
      grid.innerHTML = ids.map(function(id){
        var b = banks[id] || {};
        var count = Array.isArray(b.questions) ? b.questions.length : 0;
        return '<div class="card" data-testid="local-card" data-local-id="' + escHtml(id) + '">' +
          '<div class="card-head"><h2>' + escHtml(b.title || id) + '</h2><span class="pill progress">' + escHtml(T("local_badge")) + '</span></div>' +
          '<div class="meta-row"><span class="pill muted">' + escHtml(T("count", { n: count })) + '</span>' +
          '<span class="pill muted progress" data-progress-for="local-' + escHtml(id) + '" hidden></span></div>' +
          '<div style="display:flex;gap:12px;align-items:center;margin-top:12px;flex-wrap:wrap">' +
          '<a class="go" style="margin-top:0" href="local.html?bank=' + encodeURIComponent(id) + '" data-testid="local-practice-link">' + escHtml(T("local_practice")) + '</a>' +
          '<button class="pill muted" style="cursor:pointer" onclick="saveLocalToAccount(\\'' + escHtml(id) + '\\')" data-testid="local-to-account-btn">' + escHtml(T("local_to_account")) + '</button>' +
          '<button class="pill muted" style="cursor:pointer" onclick="removeLocalBank(\\'' + escHtml(id) + '\\')" data-testid="local-delete-btn">' + escHtml(T("local_delete")) + '</button>' +
          '</div></div>';
      }).join("");
      scanProgress();
    }
    function removeLocalBank(id){
      if (ACCOUNT_V2_CANDIDATE) return;
      if (!confirm(T("confirm_delete"))) return;
      var banks = loadLocalBanks();
      delete banks[id];
      saveLocalBanks(banks);
      renderLocalBanks();
    }
    // 把已有的本地题库上传到账号（私有云端）；未登录先弹登录。本地副本保留，用户可自行删除。
    function saveLocalToAccount(id){
      if (ACCOUNT_V2_CANDIDATE){ importMessage("Local and cloud banks are unavailable in candidate mode.", true); return; }
      if (!isLoggedIn()){ openLoginModal(); importMessage(T("cloud_need_login"), true); return; }
      var b = loadLocalBanks()[id];
      if (!b || !Array.isArray(b.questions) || !b.questions.length){ importMessage(T("cloud_fail"), true); return; }
      uploadBankToAccount(b.title || id, b.questions, 0, { localId: id });
    }
    function importMessage(text, isError){
      var el = document.getElementById("import-msg");
      if (!el) return;
      el.hidden = false;
      el.textContent = text;
      el.style.color = isError ? "var(--danger-ink)" : "var(--ok-ink)";
    }
    /* TEST-EXPORT START */
    // 免费额度的 Gemini/ChatGPT 给不出可下载文件，学生只能**复制聊天回复**。那种文本几乎不会是
    // 干净 JSON：前后带解说（"这是你的题库："）、包在代码围栏里、被输出长度上限**截断在半句**、
    // 有时还被聊天界面把引号变成弯引号。原实现整体 JSON.parse 一失败就全丢，这是同学导不进来的
    // 主因之一。这里改成「层层退让 + 抢救」：能整块解析就整块，不能就把已经完整的题目一条条捞出来，
    // 只丢掉末尾那条残缺的，并把「抢救了/丢了多少」如实报给用户（好让他回去让 AI 续写）。
    //
    // 注意：本段在 catalogHtml 的模板字符串里，绝不能出现裸反引号、也不能出现美元加花括号的插值写法
    // —— 反引号用 String.fromCharCode 取。（这条注释自己写了那个符号就会把模板打断，别问我怎么知道的。）
    var FENCE3 = String.fromCharCode(96, 96, 96); // 三个反引号
    var LANG_W = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_+-";

    // 本地题库 id。以前非 ASCII 字符被整段剥掉后一律回退成 "bank" —— 结果**所有中文命名的题库
    // 都塌成同一个 id**，互相覆盖，而「并入同名题库」还会把两个不相干的库并在一起。
    // 现在：ASCII 部分能留下东西就用它；剥空了就用标题的短哈希，保证不同标题得到不同 id、
    // 同一标题每次都得到相同 id（分批粘贴要靠这个稳定性）。
    function slugLocal(name){
      var raw = String(name || "bank");
      var ascii = raw.toLowerCase().replace(/\\.json$/i, "").replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
      if (ascii) return ascii;
      var h = 2166136261, t = raw.replace(/\\.json$/i, "");
      for (var i = 0; i < t.length; i++){ h ^= t.charCodeAt(i); h = (h * 16777619) >>> 0; }
      return "b-" + h.toString(36);
    }

    // 去掉代码围栏：**不再要求以围栏开头**（AI 常先写一句解说）。取第一个围栏与最后一个围栏之间的内容。
    function stripCodeFences(text){
      var s = String(text == null ? "" : text).trim();
      var open = s.indexOf(FENCE3);
      if (open < 0) return s;
      var rest = s.slice(open + 3);
      var close = rest.lastIndexOf(FENCE3);
      if (close >= 0) rest = rest.slice(0, close);
      rest = rest.replace(/^[ \\t]*/, "");
      // 紧跟围栏的语言标注（json/js…）：取开头连续字母数字，若其后跳过空白是 [ 或 { 就去掉标注
      var m = 0;
      while (m < rest.length && LANG_W.indexOf(rest.charAt(m)) >= 0) m++;
      if (m > 0 && m < rest.length){
        var k2 = m;
        while (k2 < rest.length){ var c = rest.charCodeAt(k2); if (c===32||c===9||c===10||c===13) k2++; else break; }
        var f = rest.charAt(k2);
        if (f === "[" || f === "{") rest = rest.slice(k2);
      }
      return rest.trim();
    }

    // 从夹在解说文字里的内容中切出 JSON 主体：找第一个 [ 或 {，按引号/转义感知配对括号。
    // 括号没配平（= 被截断）时返回到文本末尾，交给下游按「完整对象」抢救。
    function sliceJSONBody(text){
      var s = String(text == null ? "" : text);
      var startA = s.indexOf("["), startO = s.indexOf("{");
      var start = (startA < 0) ? startO : (startO < 0 ? startA : Math.min(startA, startO));
      if (start < 0) return "";
      var open = s.charAt(start), close = (open === "[") ? "]" : "}";
      var depth = 0, inStr = false, esc = false;
      for (var i = start; i < s.length; i++){
        var ch = s.charAt(i);
        if (inStr){
          if (esc) { esc = false; continue; }
          if (ch === "\\\\") { esc = true; continue; }
          if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') { inStr = true; continue; }
        if (ch === open) depth++;
        else if (ch === close){ depth--; if (depth === 0) return s.slice(start, i + 1); }
      }
      return s.slice(start); // 未配平 → 截断了
    }

    // 逐条抢救：扫出**任意层级**的每个 { … } 对象分别 parse。
    // 必须不限层级：AI 常把结果包成 {"questions":[ … ]}，一旦这种输出被截断，外层花括号永不闭合，
    // 只扫顶层就一条也捞不到（题目对象都在第 2 层）。用开括号栈，每遇 } 就把那一段单独 parse。
    // 题目对象内部不会再嵌套题目对象，所以「解析成功且像题目」的判定不会重复计数；
    // 完整的外层壳虽然也会被解析出来，但它不像题目，会被调用方过滤掉。
    function salvageObjects(body){
      var out = [], stack = [], inStr = false, esc = false;
      for (var i = 0; i < body.length; i++){
        var ch = body.charAt(i);
        if (inStr){
          if (esc) { esc = false; continue; }
          if (ch === "\\\\") { esc = true; continue; }
          if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') { inStr = true; continue; }
        if (ch === "{") stack.push({ start: i, childDone: false });
        else if (ch === "}" && stack.length){
          var top = stack.pop();
          try {
            var o = JSON.parse(body.slice(top.start, i + 1));
            if (o && typeof o === "object") out.push(o);
          } catch (e) {}
          if (stack.length) stack[stack.length - 1].childDone = true; // 标记父层「里面已经收下过完整对象」
        }
      }
      // 未闭合的花括号 = 被截断。判据：**内部没有任何完整子对象**的才算丢了一道题；
      // 有完整子对象的是外层壳（{"questions":[…]} 这种），把它也算上会让数字虚高。
      var dropped = 0;
      for (var k = 0; k < stack.length; k++) if (!stack[k].childDone) dropped++;
      return { list: out, dropped: dropped };
    }

    // 弯引号 → 直引号。**只在常规解析都失败后**才尝试，因为题干里正常出现的弯引号不该被改。
    function straightenQuotes(s){
      return String(s).replace(/[\\u201c\\u201d]/g, '"').replace(/[\\u2018\\u2019]/g, "'");
    }
    // 尾随逗号（AI 高频毛病）
    function dropTrailingCommas(s){
      return String(s).replace(/,\\s*([\\]}])/g, "$1");
    }

    function coerceBankArray(parsed){
      if (Array.isArray(parsed)) return parsed;
      if (parsed && typeof parsed === "object"){
        var keys = ["questions","bank","items","data","records","list","banks"];
        for (var i = 0; i < keys.length; i++){ if (Array.isArray(parsed[keys[i]])) return parsed[keys[i]]; }
        // 兜底：取「第一个元素是对象」的数组（避免取到 tags 之类的元数据字符串数组）
        for (var k in parsed){ var v = parsed[k]; if (Array.isArray(v) && v.length && v[0] && typeof v[0] === "object") return v; }
      }
      return null;
    }

    // 把「AI 聊天回复原文」变成题目数组。返回 {list, salvaged, dropped}：
    //   salvaged=true 表示没能整块解析、是逐条捞出来的（UI 会提示可能被截断、让用户让 AI 续写）
    //   dropped = 捞不动的残缺记录条数
    function parseBankFromText(text){
      var raw = stripCodeFences(text);
      var body = sliceJSONBody(raw) || raw;
      var attempts = [body, dropTrailingCommas(body), straightenQuotes(body), dropTrailingCommas(straightenQuotes(body))];
      for (var i = 0; i < attempts.length; i++){
        try{
          var list = coerceBankArray(JSON.parse(attempts[i]));
          if (list) return { list: list, salvaged: i > 0, dropped: 0 };
        }catch(e){}
      }
      // 整块解析全失败（最常见：输出被长度上限截断在半条题目上）→ 逐条抢救。
      // 取「捞得最多」的那个修复变体，**不能**在第一个有结果的变体就返回：
      // 原始文本里若有一条题带尾随逗号，它会被单独跳过，而修过逗号的变体本可以把它救回来。
      var best = null;
      for (var j = 0; j < attempts.length; j++){
        var r = salvageObjects(attempts[j]);
        // 只认「像题目」的对象，避免把 {"questions":…} 这类外层壳当成一条题
        var qs = r.list.filter(function(o){
          return o && (typeof o.question === "string" || Array.isArray(o.choices) || Array.isArray(o.blanks));
        });
        if (qs.length && (!best || qs.length > best.list.length)) best = { list: qs, salvaged: true, dropped: r.dropped };
      }
      if (best) return best;
      return { list: null, salvaged: false, dropped: 0 };
    }

    // 分批粘贴时把新一批并进同名题库：按题干去重（AI 每批都从 q1 开始编号，靠 id 去重会撞车），
    // id 撞到不同题就自动改名，避免后一批覆盖前一批。
    function mergeIntoBank(existing, incoming){
      var out = (existing || []).slice();
      var seenQ = {}, seenId = {};
      out.forEach(function(q){
        seenQ[String(q && q.question || "").replace(/\\s+/g, " ").trim().toLowerCase()] = true;
        seenId[String(q && q.id || "")] = true;
      });
      var added = 0, skipped = 0;
      (incoming || []).forEach(function(q){
        var key = String(q && q.question || "").replace(/\\s+/g, " ").trim().toLowerCase();
        if (key && seenQ[key]) { skipped++; return; }        // 这批里重复给出的同一道题
        var id = String(q && q.id || "");
        if (!id || seenId[id]){                              // id 撞车 → 换一个，不覆盖已有题
          var n = 2, cand = (id || "q") + "-" + n;
          while (seenId[cand]) { n++; cand = (id || "q") + "-" + n; }
          q.id = cand;
        }
        seenQ[key] = true; seenId[String(q.id)] = true;
        out.push(q); added++;
      });
      return { questions: out, added: added, skipped: skipped };
    }
    /* TEST-EXPORT END */
    // 文件导入与粘贴导入共用这一条通道（以前只有文件一条路，而免费额度的 AI 给不出文件）。
    // opts.append=true：把这一批并进同名题库（分批粘贴用），不覆盖。
    function importBankText(text, title, opts){
      if (ACCOUNT_V2_CANDIDATE){ if(!globalThis.QB_DATA_V2_CONFIG.enabled){importMessage('Learning storage is not enabled.',true);return false;}return catalogV2Import(text,title,opts||{}); }
      opts = opts || {};
      var parsed = parseBankFromText(text);
      if (!parsed.list){ importMessage(T("err_parse"), true); return false; }
      var res = validateBank(parsed.list);
      if (!res.valid.length){ importMessage(T("err_shape"), true); return false; }

      var toAcct = document.getElementById("import-to-account");
      if (toAcct && toAcct.checked && !opts.append){
        if (!isLoggedIn()){ openLoginModal(); importMessage(T("cloud_need_login"), true); return false; }
        uploadBankToAccount(title, res.valid, res.rejected);
        return true;
      }

      var id = slugLocal(title);
      var banks = loadLocalBanks();
      var note = "", count = res.valid.length;
      if (opts.append && banks[id] && Array.isArray(banks[id].questions)){
        var merged = mergeIntoBank(banks[id].questions, res.valid);
        count = merged.questions.length;
        note = T("import_appended", { a: merged.added, n: count }) + (merged.skipped ? T("import_dup", { d: merged.skipped }) : "");
        res.valid = merged.questions;
      }
      try{
        banks[id] = { title: title, questions: res.valid, savedAt: new Date().toISOString() };
        saveLocalBanks(banks);
      }catch(e){ importMessage(T("err_quota"), true); return false; }
      renderLocalBanks();
      var msg = note || T("import_ok", { t: title, n: count });
      if (res.rejected) msg += T("import_rej", { r: res.rejected });
      // 抢救模式：如实告诉用户很可能被截断了，让他回去要剩下的（否则会以为已经全导进来了）
      if (parsed.salvaged) msg += T("import_salvaged", { d: parsed.dropped });
      importMessage(msg, false);
      return true;
    }

    (function bindImport(){
      var input = document.getElementById("import-file");
      if (input) input.addEventListener("change", function(){
        var file = input.files && input.files[0];
        input.value = "";
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function(){
          importBankText(reader.result, String(file.name || "bank").replace(/\\.json$/i, ""), { append: false });
        };
        reader.readAsText(file);
      });

      // 粘贴导入：免费额度的主路径 —— 直接把聊天回复整段贴进来，不需要存文件
      var btn = document.getElementById("paste-go");
      if (btn) btn.addEventListener("click", async function(){
        var box = document.getElementById("paste-text");
        var nameEl = document.getElementById("paste-name");
        var appendEl = document.getElementById("paste-append");
        var text = box ? box.value : "";
        if (!String(text).trim()){ importMessage(T("err_paste_empty"), true); return; }
        var title = String((nameEl && nameEl.value) || "").trim() || T("paste_default_name");
        if (await importBankText(text, title, { append: !!(appendEl && appendEl.checked) })){
          if (box) box.value = ""; // 清空好接着贴下一批
        }
      });
    })();

    function applyLang(){
      document.documentElement.lang = lang === "zh" ? "zh-CN" : lang;
      renderLocalBanks(); // 本地卡片直接用 T() 重建
      document.querySelectorAll("[data-i18n]").forEach(function(el){ el.textContent = T(el.getAttribute("data-i18n")); });
      if(ACCOUNT_V2_CANDIDATE&&globalThis.QB_DATA_V2_CONFIG.enabled){var pasteDescription=document.querySelector('[data-i18n="paste_desc"]');if(pasteDescription)pasteDescription.textContent=catalogV2Text('Each import creates a new bank copy. Combine batches before importing; appending is not available yet.','每次导入创建新版副本；请先合并分批内容。分批追加暂不可用。','Cada importación crea una copia nueva. Combina los lotes antes; añadir no está disponible.');var appendLabel=document.querySelector('[data-i18n="paste_append"]');if(appendLabel)appendLabel.textContent=catalogV2Text('Appending is not available in the new system','新版暂不支持分批追加','Añadir lotes no está disponible en el sistema nuevo');}
      document.querySelectorAll("[data-i18n-ph]").forEach(function(el){ el.setAttribute("placeholder", T(el.getAttribute("data-i18n-ph"))); });
      document.querySelectorAll("[data-qcount]").forEach(function(el){ el.textContent = T("count", { n: el.getAttribute("data-qcount") }); });
      document.querySelectorAll("[data-progress-for]").forEach(function(el){
        if (el.dataset.done) el.textContent = T("progress", { n: el.dataset.done });
      });
      var sel = document.getElementById("ui-lang"); if (sel) sel.value = lang;
      if (typeof updateAuthUI === "function") updateAuthUI(); // 语言变了刷新账号按钮/提醒文案
    }
    function setLang(v){ lang = I18N[v] ? v : "en"; try{ localStorage.setItem(LANG_KEY, lang); }catch(e){} applyLang(); }
    // 进度提示：读各题库命名空间下的做题次数表
    function scanProgress(){
      if (ACCOUNT_V2_CANDIDATE) return;
      document.querySelectorAll("[data-progress-for]").forEach(function(el){
        try{
          var id = el.getAttribute("data-progress-for");
          var raw = localStorage.getItem(id + "_attempt_count_map_v1");
          if(!raw) return;
          var map = JSON.parse(raw);
          var done = Object.keys(map && typeof map === "object" ? map : {}).length;
          if(done > 0){ el.dataset.done = String(done); el.hidden = false; el.textContent = T("progress", { n: done }); }
        }catch(_e){}
      });
      decorateProgressExtras(); // P16 目录卡片升级：同一入口追加渲染
    }
    /* ===== P16 目录卡片升级：覆盖率小环 + 错题 pill + 上次练习时间 =====
       只读 localStorage、key 缺失静默跳过；只处理公开题库卡片（data-testid="bank-card"）。
       语言切换时 applyLang → renderLocalBanks → scanProgress 会整体重建，因此幂等重建即可随语言刷新。 */
    function qbCalDaysAgo(ts){ // 按本地日历日算相差天数（不是 24 小时周期）
      var now = new Date(), then = new Date(ts);
      var a = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      var b = new Date(then.getFullYear(), then.getMonth(), then.getDate());
      return Math.round((a.getTime() - b.getTime()) / 86400000);
    }
    function qbLastText(days){
      if (days <= 0) return T("prog_today");
      if (days === 1) return T("prog_yesterday");
      return T("prog_days_ago", { n: days });
    }
    function decorateProgressExtras(){
      try{
        document.querySelectorAll('[data-testid="bank-card"] [data-progress-for]').forEach(function(el){
          try{
            var id = el.getAttribute("data-progress-for");
            var row = el.parentNode;
            if (!id || !row) return;
            // 幂等：重建前清掉上一轮插入的节点（scanProgress 会被多次调用）
            row.querySelectorAll(".qb-ring, .pill.wrongs, .qb-last").forEach(function(n){ if (n.parentNode) n.parentNode.removeChild(n); });
            var anchor = el;
            // 1) 覆盖率小环：practiced / total（total 取卡片 data-qcount）
            try{
              var raw = localStorage.getItem(id + "_attempt_count_map_v1");
              if (raw){
                var map = JSON.parse(raw);
                var done = Object.keys(map && typeof map === "object" ? map : {}).length;
                var qEl = row.querySelector("[data-qcount]");
                var total = qEl ? parseInt(qEl.getAttribute("data-qcount"), 10) : 0;
                if (done > 0 && total > 0){
                  var p = Math.max(0, Math.min(1, done / total));
                  var dash = (p * 50.27).toFixed(1); // 50.27 = 2πr, r=8
                  el.insertAdjacentHTML("beforebegin",
                    '<svg class="qb-ring" viewBox="0 0 20 20" width="18" height="18" role="img">' +
                    '<title>' + escHtml(T("ring_title", { p: done, t: total })) + '</title>' +
                    '<circle cx="10" cy="10" r="8" fill="none" stroke="var(--border)" stroke-width="3"/>' +
                    '<circle cx="10" cy="10" r="8" fill="none" stroke="var(--ok-ink,#059669)" stroke-width="3" stroke-linecap="round" stroke-dasharray="' + dash + ' 50.27" transform="rotate(-90 10 10)"/>' +
                    '</svg>');
                }
              }
            }catch(_e){}
            // 2) 错题 pill：✗ M（红系）
            try{
              var wraw = localStorage.getItem(id + "_wrong_questions");
              if (wraw){
                var arr = JSON.parse(wraw);
                var m = Array.isArray(arr) ? arr.length : 0;
                if (m > 0){
                  var wp = document.createElement("span");
                  wp.className = "pill wrongs";
                  wp.textContent = "✗ " + m;
                  wp.title = T("wrong_pill_title");
                  if (anchor.nextSibling) row.insertBefore(wp, anchor.nextSibling); else row.appendChild(wp);
                  anchor = wp;
                }
              }
            }catch(_e){}
            // 3) 上次练习时间：今天 / 昨天 / N 天前（模板侧写入 _last_active_v1，缺失即跳过）
            try{
              var traw = localStorage.getItem(id + "_last_active_v1");
              var ts = traw ? parseInt(traw, 10) : NaN;
              if (isFinite(ts) && ts > 0){
                var days = qbCalDaysAgo(ts);
                var le = document.createElement("span");
                le.className = "qb-last";
                le.textContent = qbLastText(days);
                if (anchor.nextSibling) row.insertBefore(le, anchor.nextSibling); else row.appendChild(le);
              }
            }catch(_e){}
          }catch(_e){}
        });
      }catch(_e){}
    }
    var THEME_KEY = "qb_theme";
    function currentTheme(){ return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light"; }
    function applyThemeIcon(){
      var b = document.getElementById("theme-toggle");
      if (!b) return;
      var dark = currentTheme() === "dark";
      b.textContent = dark ? "☀️" : "🌙";
      var label = dark ? "Switch to light mode" : "Switch to dark mode";
      b.setAttribute("aria-label", label); b.title = label;
    }
    function setTheme(t){
      t = (t === "dark") ? "dark" : "light";
      document.documentElement.setAttribute("data-theme", t);
      try{ localStorage.setItem(THEME_KEY, t); }catch(e){}
      applyThemeIcon();
    }
    function toggleTheme(){ setTheme(currentTheme() === "dark" ? "light" : "dark"); }
    /* ===== 登录 + 做题历史（目录页：与做题页同源，共用 token / 历史）===== */
    var QB_API_BASE = ${JSON.stringify(API_BASE)};
    var AUTH_KEY = "qb_auth_v1";
    async function probeCandidateShare(code,current){
      if(code.length>64)throw Object.assign(new Error('CODE_LENGTH_INVALID'),{code:'CODE_LENGTH_INVALID'});
      if(code.length<6)return null;
      var response=await fetch(QB_API_BASE+"/special",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code:code})});
      if(!current())throw Object.assign(new Error("STALE_REQUEST"),{code:"STALE_REQUEST"});
      var body;try{body=await response.json();}catch{throw Object.assign(new Error("INVALID_SHARE_RESPONSE"),{code:"INVALID_SHARE_RESPONSE"});}
      if(!current())throw Object.assign(new Error("STALE_REQUEST"),{code:"STALE_REQUEST"});
      if(response.status===404&&body&&body.ok===false&&body.error==="not_found")return null;
      if(response.status===429)throw Object.assign(new Error("RATE_LIMITED"),{code:"RATE_LIMITED"});
      var bank=body&&body.bank;
      if(response.status!==200||!body||Object.keys(body).sort().join(",")!=="bank,ok"||body.ok!==true||!bank||Object.keys(bank).sort().join(",")!=="id,questions,title"||typeof bank.id!=="string"||!bank.id||bank.id.length>128||typeof bank.title!=="string"||bank.title.length>1024||!Array.isArray(bank.questions)||!bank.questions.length||bank.questions.length>100000||bank.questions.some(q=>!q||typeof q!=="object"||Array.isArray(q)||typeof q.question!=="string"||!q.question.trim()))throw Object.assign(new Error("SHARE_UNAVAILABLE"),{code:"SHARE_UNAVAILABLE"});
      return bank;
    }
    var CANDIDATE_LABEL_KEY = "qb_account_display_label_v1";
    function clearCandidateDisplayLabel(){try{sessionStorage.removeItem(CANDIDATE_LABEL_KEY);}catch{}}
    function candidateDisplayLabel(){
      var state=ACCOUNT_V2_STATE;if(!state||state.phase!=="ready"||!state.owner)return "";
      try{var value=JSON.parse(sessionStorage.getItem(CANDIDATE_LABEL_KEY)||"null");if(!value)return "";if(Object.keys(value).sort().join(",")!=="accountGeneration,accountId,label"||typeof value.label!=="string"||!value.label.trim()||value.label.length>64||value.accountId!==state.owner.accountId||value.accountGeneration!==state.owner.accountGeneration){clearCandidateDisplayLabel();return "";}return value.label;}catch{clearCandidateDisplayLabel();return "";}
    }
    function setCandidateDisplayLabel(label,controller){
      var state=controller.snapshot();if(controller!==ACCOUNT_V2||state.phase!=="ready"||!state.owner||state.epoch!==ACCOUNT_V2_STATE?.epoch||typeof label!=="string"||!label.trim()||label.length>64)return;
      try{sessionStorage.setItem(CANDIDATE_LABEL_KEY,JSON.stringify({label:label,accountId:state.owner.accountId,accountGeneration:state.owner.accountGeneration}));}catch{}
      updateAuthUI();
    }
    function getAuth(){ if (ACCOUNT_V2_CANDIDATE) return null; try{ return JSON.parse(localStorage.getItem(AUTH_KEY) || "null"); }catch(e){ return null; } }
    function setAuth(a){ if (ACCOUNT_V2_CANDIDATE) return; try{ localStorage.setItem(AUTH_KEY, JSON.stringify(a)); }catch(e){} updateAuthUI(); }
    function clearAuth(){ if (ACCOUNT_V2_CANDIDATE) return; try{ localStorage.removeItem(AUTH_KEY); }catch(e){} updateAuthUI(); }
    function isLoggedIn(){ if (ACCOUNT_V2_CANDIDATE) return !!(ACCOUNT_V2_STATE && ACCOUNT_V2_STATE.phase === "ready" && ACCOUNT_V2_STATE.owner); var a = getAuth(); return !!(a && a.token); }
    function authHeaders(){ if (ACCOUNT_V2_CANDIDATE) return {}; var a = getAuth(); return (a && a.token) ? { "Authorization": "Bearer " + a.token } : {}; }
    function updateAuthUI(){
      var sp = getSpecial();
      var lbl = document.getElementById("account-label");
      if (ACCOUNT_V2_CANDIDATE){
        var title = document.getElementById("catalog-login-title");
        var hint = document.getElementById("catalog-login-hint");
        var sub = document.getElementById("catalog-sub");
        var notice = document.getElementById("account-v2-learning-notice");
        if(!globalThis.QB_DATA_V2_CONFIG.enabled){
          if(notice)notice.hidden=false;if(title)title.textContent=T('login_btn');if(hint)hint.textContent=T('login_hint')+' Practice is memory-only; learning storage is not enabled.';if(sub)sub.textContent='Public banks remain available. Learning storage is not enabled.';
          ['local-grid','cloud-box'].forEach(function(id){var node=document.getElementById(id);if(node)node.hidden=true;});var disabledImport=document.querySelector('[data-testid="import-box"]');if(disabledImport)disabledImport.hidden=true;
          var accountOnlyReady=ACCOUNT_V2_STATE&&ACCOUNT_V2_STATE.phase==='ready',accountOnlyBusy=!!(ACCOUNT_V2_STATE&&['authenticating','checking','deleting'].includes(ACCOUNT_V2_STATE.phase)),accountOnlyBlocked=candidateRecoveryBlocksControls(ACCOUNT_V2_STATE)||ACCOUNT_V2_LOAD_ERROR;
          if(lbl)lbl.textContent=sp?T('share_bank_label'):accountOnlyReady?(candidateDisplayLabel()?candidateDisplayLabel()+' · '+T('account_history'):T('my_account')):T('login_btn');var accountOnlyButton=document.getElementById('account-btn');if(accountOnlyButton)accountOnlyButton.title=accountOnlyReady?(candidateDisplayLabel()?T('history_title'):T('my_account')):T('login_btn');var accountOnlyRegister=document.getElementById('register-go');if(accountOnlyRegister)accountOnlyRegister.hidden=false;
          ['account-btn','login-go','register-go','catalog-public-share-go'].forEach(function(id){var node=document.getElementById(id);if(node)node.disabled=accountOnlyBusy||accountOnlyBlocked;});var accountOnlyReminder=document.getElementById('login-reminder');if(accountOnlyReminder)accountOnlyReminder.hidden=true;
          renderCandidateAccountRecovery(ACCOUNT_V2_STATE);return;
        }
        if (title) title.textContent = T("login_btn");
        if (hint) hint.textContent = T("login_hint");
        if (sub) sub.textContent = catalogNativeHistory()?catalogV2Text('Private banks, imports and practice history.','私有题库、导入与练习历史。','Bancos privados, importaciones e historial de práctica.'):catalogV2Text('Private banks, imports and scores. Original cloud records remain read-only archives.','新版私有题库、导入与历史成绩。旧云资料保留为只读归档。','Bancos privados, importaciones y notas. Los archivos originales son de solo lectura.');
        if(catalogNativeHistory()){var historySubtitle=document.querySelector('#history-modal [data-i18n="history_sub"]');if(historySubtitle)historySubtitle.textContent=catalogV2Text('View saved practice records, original scores and answers.','查看已保存的练习记录、原成绩与作答。','Consulta tu práctica guardada, las notas y respuestas originales.');}
        if (notice){ notice.hidden = true; notice.textContent = ''; }
        var local = document.getElementById("local-grid"); if (local) local.hidden = false;
        var importer = document.querySelector('[data-testid="import-box"]'); if (importer) importer.hidden = false;
        var append = document.getElementById('paste-append');if(append){append.checked=false;append.disabled=true;append.title='新版每次导入为新题库；分批追加尚未启用，不会覆盖已有题库。';}
        var cloud = document.getElementById("cloud-box"); if (cloud) cloud.hidden = false;
        catalogV2Refresh();
        var reminder = document.getElementById("login-reminder"); if (reminder) reminder.hidden = true;
        if (sp){ if (lbl) lbl.textContent = sp.code || T("share_bank_label"); return; }
        var ready = ACCOUNT_V2_STATE && ACCOUNT_V2_STATE.phase === "ready";
        if (lbl) lbl.textContent = ready ? (candidateDisplayLabel() ? candidateDisplayLabel()+" · "+T("account_history") : T("my_account")) : T("login_btn");
        var candidateButton = document.getElementById("account-btn"); if (candidateButton) candidateButton.title = ready ? (candidateDisplayLabel()?T("history_title"):T("my_account")) : T("login_btn");
        var busy = !!(ACCOUNT_V2_STATE && ["authenticating", "checking", "deleting"].includes(ACCOUNT_V2_STATE.phase));
        var blocked = candidateRecoveryBlocksControls(ACCOUNT_V2_STATE) || ACCOUNT_V2_LOAD_ERROR;
        var learningBlocked=busy||blocked||!ACCOUNT_V2_STATE||!['guest','ready'].includes(ACCOUNT_V2_STATE.phase);
        ['import-file','paste-go','catalog-v2-sync'].forEach(function(id){var control=document.getElementById(id);if(control)control.disabled=learningBlocked||(id==='catalog-v2-sync'&&CATALOG_V2_RETRY_KEY===catalogV2Key()&&Date.now()<CATALOG_V2_RETRY_AT);});
        ["account-btn", "login-go", "register-go", "catalog-public-share-go"].forEach(function(id){ var control = document.getElementById(id); if (control) control.disabled = busy || blocked; });
        renderCandidateAccountRecovery(ACCOUNT_V2_STATE);
        return;
      }
      if (sp){ if (lbl) lbl.textContent = "\\uD83D\\uDD11 " + (sp.code || ""); applySpecialMode(); return; }
      document.body.classList.remove("special-mode");
      var a = getAuth();
      var btn = document.getElementById("account-btn");
      if (a && a.name){ if (lbl) lbl.textContent = a.name + " · " + T("account_history"); if (btn) btn.title = T("history_title"); }
      else { if (lbl) lbl.textContent = T("login_btn"); if (btn) btn.title = T("login_btn"); }
      var rem = document.getElementById("login-reminder");
      if (rem) rem.hidden = !!(a && a.token); // 已登录就不再提醒；未登录（含第一次打开）显示提醒
      renderCloudBanks(); // 已登录显示「我的账号题库」，未登录隐藏
    }
    /* ---- 特殊题库访客模式（分享码进，其他题库全变灰，纯内存，不记历史） ---- */
    function getSpecial(){ try{ var s = sessionStorage.getItem("qb_special"); return s ? JSON.parse(s) : null; }catch(e){ return null; } }
    function clearSpecial(){ try{ sessionStorage.removeItem("qb_special"); }catch(e){} }
    function exitSpecial(){ clearSpecial(); document.body.classList.remove("special-mode"); updateAuthUI(); }
    function enterSpecial(code, bank){
      try{ sessionStorage.setItem("qb_special", JSON.stringify({ code: code, id: bank.id, title: bank.title })); }catch(e){}
      loginStatus(T("special_ok"), "ok");
      setTimeout(function(){ location.href = "player.html?special=1"; }, 500); // 直接进特殊题库，不停在目录页
    }
    function applySpecialMode(){
      var sp = getSpecial();
      if (!sp){ document.body.classList.remove("special-mode"); return; }
      document.body.classList.add("special-mode");
      var rem = document.getElementById("login-reminder"); if (rem) rem.hidden = true;
      var box = document.getElementById("cloud-box"); if (box) box.hidden = false;
      var grid = document.getElementById("cloud-grid");
      if (grid){
        grid.innerHTML = '<div class="card" data-testid="special-card">' +
          '<div class="card-head"><h2>' + escHtml(sp.title || sp.id || "") + '</h2><span class="pill progress">' + escHtml(T("special_badge")) + '</span></div>' +
          '<div style="display:flex;gap:14px;align-items:center;margin-top:12px">' +
          '<a class="go" style="margin-top:0" href="player.html?special=1" data-testid="special-practice-link">' + escHtml(T("local_practice")) + '</a>' +
          '<button class="pill muted" style="cursor:pointer" onclick="exitSpecial()" data-testid="special-exit-btn">' + escHtml(T("special_exit")) + '</button>' +
          '</div></div>';
      }
    }
    function showCandidatePendingDeletion(){ renderCandidateAccountRecovery(ACCOUNT_V2_STATE); }
    async function acknowledgeAccountRecovery(){
      if (!ACCOUNT_V2_CANDIDATE || !ACCOUNT_V2) return;
      var code = candidateRecoveryCode(ACCOUNT_V2_STATE);
      if (!candidateRecoveryAckAllowed(code)) return renderCandidateAccountRecovery(ACCOUNT_V2_STATE);
        clearCandidateDisplayLabel();
      var operation = beginAccountV2UiOperation(ACCOUNT_V2);
      try{
        var result = await ACCOUNT_V2.acknowledgeRecovery(function(){
          if (!accountV2UiOperationIsCurrent(operation)) return false;
          var approved = window.confirm(T("account_recovery_ack_confirm"));
          if (approved) accountV2UiOperationAcceptsTransition(operation);
          return approved;
        });
        if (!accountV2UiOperationOwns(operation)) return;
        if (result && result.cancelled) renderCandidateAccountRecovery(ACCOUNT_V2_STATE);
        else { closeHistory(); updateAuthUI(); }
      }catch(e){
        if (accountV2UiOperationOwns(operation) && (operation.epoch === null || accountV2UiOperationIsCurrent(operation))) renderCandidateAccountRecovery(ACCOUNT_V2.snapshot());
      }finally{ if (accountV2UiOperationOwns(operation)) finishAccountV2UiOperation(operation); }
    }
    function onAccountBtn(){
      if (ACCOUNT_V2_CANDIDATE && (candidateRecoveryBlocksControls(ACCOUNT_V2_STATE) || ACCOUNT_V2_LOAD_ERROR)){ renderCandidateAccountRecovery(ACCOUNT_V2_STATE); return; }
      if (getSpecial()){ if (confirm(T("special_exit_confirm"))) exitSpecial(); return; }
      if (isLoggedIn()) openHistory(); else openLoginModal();
    }
    function loginStatus(text, kind){ var el = document.getElementById("login-status"); if (!el) return; el.textContent = text || ""; el.className = "qb-status" + (kind ? " " + kind : ""); }
    function openLoginModal(){
      var m = document.getElementById("login-modal"); if (!m) return;
      if (ACCOUNT_V2_CANDIDATE) updateAuthUI();
      var inp = document.getElementById("login-code"); if (inp) inp.value = "";
      var shareEntry = document.getElementById("catalog-public-share-entry"); if (shareEntry){shareEntry.hidden = !ACCOUNT_V2_CANDIDATE;shareEntry.open=false;}
      var shareInput = document.getElementById("catalog-public-share-code"); if (shareInput) shareInput.value = "";
      loginStatus("", "");
      m.hidden = false;
      if (inp) setTimeout(function(){ try{ inp.focus(); }catch(e){} }, 60);
    }
    function closeLoginModal(success=false){if(!success&&NEW_ACCOUNT_CANCEL)NEW_ACCOUNT_CANCEL();if(ACCOUNT_V2_CANDIDATE){if(!success&&ACCOUNT_V2_UI_OPERATION)clearCandidateDisplayLabel();if(!success&&ACCOUNT_V2?.snapshot().phase==='authenticating')ACCOUNT_V2.logout();invalidateAccountV2UiOperation();}var m=document.getElementById('login-modal');if(m)m.hidden=true;}
    async function doLogin(){
      if(ACCOUNT_V2_CANDIDATE && ACCOUNT_V2_UI_OPERATION)return;
      var inp = document.getElementById("login-code");
      var code = ((inp && inp.value) || "").trim();
      if (ACCOUNT_V2_CANDIDATE){
        if (candidateRecoveryBlocksControls(ACCOUNT_V2_STATE) || ACCOUNT_V2_LOAD_ERROR){ renderCandidateAccountRecovery(ACCOUNT_V2_STATE); return; }
        if (code.length < 4){ loginStatus(T("login_too_short"), "err"); return; }
        var candidateButton = document.getElementById("login-go"); if (candidateButton) candidateButton.disabled = true;
        var loginOperation = (clearCandidateDisplayLabel(),beginAccountV2UiOperation(null));
        try{
          var controller = await ACCOUNT_V2_READY;
          if (!controller) throw new Error("controller_unavailable");
          if (!bindAccountV2UiOperation(loginOperation, controller)) return;
          var shared=await probeCandidateShare(code,()=>accountV2UiOperationIsCurrent(loginOperation));
          if(!accountV2UiOperationIsCurrent(loginOperation))return;
          if(shared){sessionStorage.setItem('qb_special',JSON.stringify({code:code,id:shared.id,title:shared.title}));if(!getSpecial())throw new Error('SHARE_STORAGE_FAILED');loginStatus(T('special_ok'),'ok');location.href='player.html?special=1';return;}
          if(!accountV2UiOperationAcceptsTransition(loginOperation))return;
          var result=await controller.enter(code,function(){return confirmNewAccount(loginOperation);});
          if(result&&result.cancelled){loginStatus(catalogV2Text('Account creation cancelled.','已取消创建账号。','Creación cancelada.'),'');return;}
          if (!accountV2UiOperationIsCurrent(loginOperation)) return; setCandidateDisplayLabel(code,controller);
          loginStatus(catalogV2Text('Signed in.','已登录。','Sesión iniciada.'), "ok"); closeLoginModal(true);
        }catch(e){ if (accountV2UiOperationOwns(loginOperation) && (loginOperation.epoch === null || accountV2UiOperationIsCurrent(loginOperation))) loginStatus(accountV2ErrorText(e), "err"); }
        finally { if (accountV2UiOperationOwns(loginOperation) && (loginOperation.epoch === null || accountV2UiOperationIsCurrent(loginOperation))){ if (candidateButton) candidateButton.disabled = false; finishAccountV2UiOperation(loginOperation); } }
        return;
      }
      if (code.length < 3){ loginStatus(T("login_too_short"), "err"); return; }
      var btn = document.getElementById("login-go"); if (btn) btn.disabled = true;
      loginStatus(T("login_ing"), "");
      // 先查「特殊题库分享码」——命中即进访客模式（不走账号登录）
      fetch(QB_API_BASE + "/special", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: code }) })
        .then(function(res){ return res.json().then(function(d){ return { status: res.status, d: d }; }, function(){ return { status: res.status, d: {} }; }); })
        .then(function(r){
          if (r.status === 200 && r.d && r.d.ok && r.d.bank){ enterSpecial(code, r.d.bank); return null; }
          if (code.length < 4){ loginStatus(T("login_too_short"), "err"); return null; }
          return fetch(QB_API_BASE + "/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: code }) })
            .then(function(res){ return res.json().then(function(d){ return { ok: res.ok, status: res.status, d: d }; }, function(){ return { ok: res.ok, status: res.status, d: {} }; }); })
            .then(function(r2){
              if (r2.ok && r2.d && r2.d.ok && r2.d.token){
                setAuth({ token: r2.d.token, name: (r2.d.user && r2.d.user.name) || code });
                loginStatus(T("login_ok"), "ok");
                setTimeout(function(){ closeLoginModal(); openHistory(); }, 650);
              } else if (r2.status === 429 || (r2.d && r2.d.error === "rate_limited")){
                loginStatus(T("login_rate"), "err");
              } else {
                loginStatus(T("login_fail"), "err");
              }
            });
        })
        .catch(function(){ loginStatus(T("login_neterr"), "err"); })
        .then(function(){ if (btn) btn.disabled = false; });
    }
    function loginInputChanged(){if(!ACCOUNT_V2_CANDIDATE||!ACCOUNT_V2_UI_OPERATION)return;invalidateAccountV2UiOperation();if(NEW_ACCOUNT_CANCEL)NEW_ACCOUNT_CANCEL();if(ACCOUNT_V2)ACCOUNT_V2.logout();var button=document.getElementById('login-go');if(button)button.disabled=false;}
    var NEW_ACCOUNT_CANCEL = null;
    function confirmNewAccount(operation){
      if(!accountV2UiOperationIsCurrent(operation))return Promise.resolve(false);
      return new Promise(function(resolve){
        var dialog=document.createElement('dialog'),text=document.createElement('p'),cancel=document.createElement('button'),create=document.createElement('button');
        dialog.setAttribute('data-testid','account-create-confirm');dialog.setAttribute('aria-label',lang==='zh'?'创建账号':lang==='es'?'Crear cuenta':'Create account');
        text.textContent=lang==='zh'?'没有找到这个账号。是否创建新的空账号？原来删除的数据不会恢复。':lang==='es'?'No se encontró una cuenta. ¿Crear una cuenta vacía? Los datos eliminados no se restaurarán.':'No account was found. Create a new empty account? Previously deleted data will not be restored.';
        cancel.textContent=lang==='zh'?'取消':lang==='es'?'Cancelar':'Cancel';create.textContent=lang==='zh'?'创建账号':lang==='es'?'Crear cuenta':'Create account';cancel.type=create.type='button';
        function finish(approved){if(NEW_ACCOUNT_CANCEL===abort)NEW_ACCOUNT_CANCEL=null;dialog.close();dialog.remove();resolve(approved&&accountV2UiOperationIsCurrent(operation));}
        function abort(){finish(false);}NEW_ACCOUNT_CANCEL=abort;cancel.onclick=abort;create.onclick=function(){finish(true);};dialog.oncancel=function(event){event.preventDefault();abort();};dialog.append(text,cancel,create);document.body.append(dialog);dialog.showModal();cancel.focus();
      });
    }
    function logout(){ if (ACCOUNT_V2_CANDIDATE){ if (candidateRecoveryBlocksControls(ACCOUNT_V2_STATE) || ACCOUNT_V2_LOAD_ERROR){ renderCandidateAccountRecovery(ACCOUNT_V2_STATE); return; } clearCandidateDisplayLabel();invalidateAccountV2UiOperation(); if (ACCOUNT_V2) ACCOUNT_V2.logout(); closeHistory(); return; } clearAuth(); closeHistory(); }
    async function deleteMyAccount(){
      if (ACCOUNT_V2_CANDIDATE){
        if (!ACCOUNT_V2) { loginStatus("Account service unavailable. Please retry.", "err"); return; }
        if (candidateRecoveryBlocksControls(ACCOUNT_V2_STATE) || ACCOUNT_V2_LOAD_ERROR){ renderCandidateAccountRecovery(ACCOUNT_V2_STATE); return; }
        clearCandidateDisplayLabel();
        var operation = beginAccountV2UiOperation(ACCOUNT_V2);
        try{
          closeHistory();
          var result = await ACCOUNT_V2.deleteAccount(function(){ if (!accountV2UiOperationIsCurrent(operation)) return Promise.resolve(false); var confirmed = window.confirm("Permanently delete this account and all server data? A later registration starts empty."); if (confirmed) accountV2UiOperationAcceptsTransition(operation); return Promise.resolve(confirmed); });
          if (!accountV2UiOperationIsCurrent(operation)) return;
          if (!(result && result.cancelled)){ closeHistory(); alert("Deletion completed. A later registration starts with an empty account."); }
        }catch(e){ if (e && e.code !== "STALE_REQUEST" && accountV2UiOperationIsCurrent(operation)) { loginStatus(accountV2ErrorText(e), "err"); updateAuthUI(); } }
        finally { if (accountV2UiOperationIsCurrent(operation)) finishAccountV2UiOperation(operation); }
        return;
      }
      if (!isLoggedIn()) return;
      if (!confirm(T("del_account_confirm"))) return;
      fetch(QB_API_BASE + "/account", { method:"DELETE", headers: authHeaders() })
        .then(function(res){
          if (res.ok){ clearAuth(); closeHistory(); renderCloudBanks(); alert(T("del_account_done")); }
          else if (res.status === 401){ clearAuth(); closeHistory(); }
          else { alert(T("del_account_fail")); }
        })
        .catch(function(){ alert(T("del_account_fail")); });
    }
    async function retryAccountDeletion(){
      if (!ACCOUNT_V2_CANDIDATE || !ACCOUNT_V2) return;
      if(ACCOUNT_V2_STATE&&ACCOUNT_V2_STATE.cleanupRequired&&!ACCOUNT_V2_STATE.pendingDeletion){try{await ACCOUNT_V2.resume();}finally{renderCandidateAccountRecovery(ACCOUNT_V2.snapshot());}return;}
      var recoveryCode = candidateRecoveryCode(ACCOUNT_V2_STATE);
      if (!ACCOUNT_V2_STATE || !ACCOUNT_V2_STATE.pendingDeletion || candidateRecoveryAckAllowed(recoveryCode) || recoveryCode === "STORAGE_UNAVAILABLE"){ renderCandidateAccountRecovery(ACCOUNT_V2_STATE); return; }
        clearCandidateDisplayLabel();
      var operation = beginAccountV2UiOperation(ACCOUNT_V2);
      try{ var result = await ACCOUNT_V2.continueDeletion(); if (accountV2UiOperationIsCurrent(operation) && !(result && result.pendingDeletion)){ closeHistory(); alert("Deletion completed. A later registration starts with an empty account."); } }
      catch(e){ if (e && e.code !== "STALE_REQUEST" && accountV2UiOperationIsCurrent(operation)) { loginStatus(accountV2ErrorText(e), "err"); updateAuthUI(); } }
      finally { if (accountV2UiOperationIsCurrent(operation)){ updateAuthUI(); finishAccountV2UiOperation(operation); } }
    }
    var CATALOG_V2_SESSION = null, CATALOG_V2_KEY = null, CATALOG_V2_SEQUENCE = 0, CATALOG_V2_FLIGHT = null, CATALOG_V2_HISTORY_SEQUENCE = 0, CATALOG_V2_PAGE_EPOCH = 0, CATALOG_V2_RETRY_KEY = null, CATALOG_V2_RETRY_AT = 0, CATALOG_V2_PAGE_ACTIVE = true;
    function catalogV2Text(en,zh,es){return lang==='zh'?zh:lang==='es'?es:en;}
    function catalogV2Key(){ return JSON.stringify([CATALOG_V2_PAGE_EPOCH,ACCOUNT_V2_STATE && ACCOUNT_V2_STATE.epoch, ACCOUNT_V2_STATE && ACCOUNT_V2_STATE.phase, ACCOUNT_V2_STATE && ACCOUNT_V2_STATE.owner]); }
    function catalogV2Current(key){ return key === catalogV2Key() && !!ACCOUNT_V2_STATE && ['guest','ready'].includes(ACCOUNT_V2_STATE.phase) && !ACCOUNT_V2_LOAD_ERROR && !candidateRecoveryBlocksControls(ACCOUNT_V2_STATE); }
    function catalogV2UICurrent(key){return CATALOG_V2_PAGE_ACTIVE&&catalogV2Current(key);}
    function catalogV2UpgradeNotice(error){
      var node=document.getElementById('catalog-v2-status'),key=catalogV2Key(),session=CATALOG_V2_SESSION;
      import('./browser/data-v2.js').then(function(mod){if(!catalogV2UICurrent(key))return;mod.showResumeUpgradeNotice(node,{error:error,language:lang,isCurrent:function(){return catalogV2UICurrent(key)&&CATALOG_V2_SESSION===session;},flushLocal:async function(){if(!session)throw Object.assign(new Error('LOCAL_SESSION_UNAVAILABLE'),{code:'LOCAL_SESSION_UNAVAILABLE'});await session.flush();}});}).catch(function(){/* retain the visible original error */});
    }
    async function catalogV2Session(){
      await ACCOUNT_V2_READY;
      var key=catalogV2Key();
      if(!catalogV2Current(key) || (ACCOUNT_V2_STATE && ACCOUNT_V2_STATE.owner && ACCOUNT_V2_STATE.phase !== 'ready')) throw new Error('ACCOUNT_RECOVERY_BLOCKED');
      if(CATALOG_V2_SESSION && CATALOG_V2_KEY===key)return CATALOG_V2_SESSION;
      if(CATALOG_V2_FLIGHT && CATALOG_V2_FLIGHT.key===key)return CATALOG_V2_FLIGHT.promise;
      if(CATALOG_V2_SESSION)CATALOG_V2_SESSION.close(); CATALOG_V2_SESSION=null;CATALOG_V2_KEY=key;
      var flight={key:key};CATALOG_V2_FLIGHT=flight;flight.promise=(async function(){
      var mod=await import('./browser/data-v2.js'),state=ACCOUNT_V2_STATE,owner=state&&state.owner?{ownerKind:'account',accountId:state.owner.accountId,accountGeneration:state.owner.accountGeneration}:null;
      if(!catalogV2UICurrent(key))throw new Error('STALE_REQUEST');
      var session=await mod.createLearningSession({owner:owner,isCurrent:function(){return catalogV2Current(key);},authorizeSnapshotInitialization:function(options){return mod.requireSnapshotInitializationCapability(ACCOUNT_V2,{isCurrent:options.isCurrent,buildCompatibility:globalThis.QB_DATA_V2_CONFIG});}});
      if(!catalogV2UICurrent(key)){session.close();throw new Error('STALE_REQUEST');}
      CATALOG_V2_SESSION=session;return session;
      })().finally(function(){if(CATALOG_V2_FLIGHT===flight)CATALOG_V2_FLIGHT=null;});return flight.promise;
    }
    // LearningSession owns pagehide writer-release; do not close before its
    // listener can release the lease. BFCache returns must open a fresh handle.
    globalThis.addEventListener('pagehide',function(){CATALOG_V2_PAGE_ACTIVE=false;CATALOG_V2_SEQUENCE++;CATALOG_V2_HISTORY_SEQUENCE++;CATALOG_V2_SESSION=null;CATALOG_V2_FLIGHT=null;});
    // Advance the page key only on return, after pagehide's writer release.
    globalThis.addEventListener('pageshow',function(event){CATALOG_V2_PAGE_ACTIVE=true;if(event.persisted&&ACCOUNT_V2_CANDIDATE){CATALOG_V2_PAGE_EPOCH++;CATALOG_V2_SESSION=null;CATALOG_V2_FLIGHT=null;catalogV2Refresh();}});
    // Shared by both build modes; native-only stripping removes only legacy
    // preparation helpers below, never these live catalog coordinator slots.
    var CATALOG_HISTORY_SCHEDULE=null;
    var CATALOG_NATIVE_SYNC=null;
    /*QB_NATIVE_ONLY_REMOVE_START*/
    async function catalogV2Legacy(){var mod=await import('./browser/legacy-migration-client.js');return mod.createLegacyMigrationClient({apiBase:QB_API_BASE,allowMirrorApi:location.origin==='https://shicheng0810.github.io'&&QB_API_BASE==='https://question-bank-78u.pages.dev/api',transport:function(command){return ACCOUNT_V2.authenticatedTransport(command);}});}
    var CATALOG_HISTORY_PREPARATION=null;
    var CATALOG_PENDING_INVENTORY=null;
    async function catalogRenderPending(host,kind,session,key,current,reload){
      if(!catalogNativeHistory()||session.owner.ownerKind!=='account')return;
      try{var mod=await import('./browser/data-v2.js');if(!current())return;
        if(!CATALOG_PENDING_INVENTORY||CATALOG_PENDING_INVENTORY.key!==key){var client=await catalogV2Legacy();if(!current())return;CATALOG_PENDING_INVENTORY={key:key,value:mod.createPendingHistoryInventory({session:session,client:client,isCurrent:function(){return catalogV2UICurrent(key);}})};}
        var inventory=await CATALOG_PENDING_INVENTORY.value.refresh({reload:!!reload,visibleBankUids:kind==='banks'?JSON.parse(host.dataset.nativeBankUids||'[]'):null,visibleHistoryBindings:kind==='history'?Array.from(host.querySelectorAll('[data-history-binding]')).map(function(n){return n.dataset.historyBinding;}):null});if(!current())return;
        if(inventory[kind].length||!inventory[kind==='history'?'historyKnown':'banksKnown'])host.querySelectorAll('[data-native-empty]').forEach(function(node){node.remove();});
        host.querySelectorAll('[data-pending-inventory]').forEach(function(node){node.remove();});
        inventory[kind].forEach(function(item){var row=document.createElement(kind==='banks'?'article':'div');row.className=kind==='banks'?'card':'';row.dataset.pendingInventory='1';row.dataset.source='pending';row.dataset.testid=kind==='banks'?'catalog-v2-bank-card':'catalog-v2-history-row';var label=document.createElement(kind==='banks'?'h2':'span');label.textContent=(item.title||catalogV2Text(kind==='banks'?'My bank':'History record',kind==='banks'?'我的题库':'历史记录',kind==='banks'?'Mi banco':'Registro'))+(item.recordedAt!==null&&item.recordedAt!==undefined?' · '+fmtHistTime(item.recordedAt):'');var status=document.createElement('p');status.textContent=catalogV2Text('Waiting to be prepared','等待准备','Pendiente de preparación');row.append(label,status);host.append(row);});
        if(inventory.errors.length||!inventory[kind==='history'?'historyKnown':'banksKnown']){var notice=document.createElement('p');notice.dataset.pendingInventory='1';notice.dataset.testid='catalog-v2-inventory-status';notice.role='status';notice.textContent=catalogV2Text('Some records cannot be checked now; saved and known pending records remain available.','部分记录暂不能核验；已保存与已知待准备记录仍保留。','No se pueden comprobar algunos registros; los guardados y pendientes conocidos se conservan.');var retry=document.createElement('button');retry.className='qb-btn';retry.textContent=catalogV2Text('Retry','重试','Reintentar');retry.onclick=function(){catalogRenderPending(host,kind,session,key,current,true);};if(inventory.retryAfter){retry.disabled=true;notice.textContent+=' '+inventory.retryAfter+' s';setTimeout(function(){if(current())retry.disabled=false;},inventory.retryAfter*1000+20);}notice.append(retry);host.append(notice);}
      }catch(error){if(!current())return;var notice=document.createElement('p');notice.dataset.pendingInventory='1';notice.role='status';notice.textContent=catalogV2Text('Pending records could not be checked; nothing was deleted.','待准备记录暂不能核验；未删除资料。','No se pudieron comprobar registros pendientes; no se eliminó nada.');host.append(notice);}
    }
    /*QB_NATIVE_ONLY_REMOVE_END*/
    function catalogNativeHistory(){return globalThis.QB_DATA_V2_CONFIG.historySnapshotsEnabled===true;}
    async function catalogPrepareHistory(session,key){
      if(!catalogNativeHistory()||!isLoggedIn())return;
      if(globalThis.QB_DATA_V2_CONFIG.nativeOnlyMode===true){
        if(!CATALOG_NATIVE_SYNC||CATALOG_NATIVE_SYNC.key!==key){
          var nativeModule=await /*QB_NATIVE_SYNC_IMPORT__*/ ,syncModule=await import('./browser/data-v2.js');
          if(!catalogV2UICurrent(key))throw Object.assign(new Error('STALE_REQUEST'),{code:'STALE_REQUEST'});
          var currentNative=function(){return catalogV2UICurrent(key);};
          CATALOG_NATIVE_SYNC={key:key,coordinator:nativeModule.createNativeHistorySyncCoordinator({
            runOnce:function(){return syncModule.createSyncV2Coordinator({account:ACCOUNT_V2,repository:session.repository}).runOnce();},
            readPending:function(){return session.repository.readRecords('outbox');},
            isCurrent:currentNative,
            onStatus:function(state){if(!currentNative())return;var node=document.getElementById('catalog-v2-status');if(!node)return;node.dataset.state=state.state;node.textContent=state.state==='synced'?catalogV2Text('Synced','已同步','Sincronizado'):state.state==='syncing'?catalogV2Text('Syncing…','同步中…','Sincronizando…'):state.state==='retry-wait'?catalogV2Text('Waiting to retry cloud sync…','等待重试云同步…','Esperando para reintentar…'):catalogV2Text('Sync pending; local data is safe.','同步待完成；本机数据已保留。','Sincronización pendiente; los datos locales están seguros.')+(state.retryAfter?' '+state.retryAfter+' s':'');catalogV2UpgradeNotice({code:state.reason});}
          })};
        }
        return CATALOG_NATIVE_SYNC.coordinator.run();
      }
      /*QB_NATIVE_ONLY_REMOVE_START*/
      var mod=await import('./browser/data-v2.js'),client=await catalogV2Legacy();if(!catalogV2UICurrent(key))throw Object.assign(new Error('STALE_REQUEST'),{code:'STALE_REQUEST'});
      if(!CATALOG_HISTORY_PREPARATION||CATALOG_HISTORY_PREPARATION.key!==key){var current=function(){return catalogV2UICurrent(key);};CATALOG_HISTORY_PREPARATION={key:key,coordinator:mod.createUnifiedHistoryPreparation({session:session,client:client,isCurrent:current,legacyDedupe:mod.dedupeLegacyQuestionBank,resolvePublicBanks:function(snapshot){return mod.resolveLegacyPublicBanks(snapshot,{entries:globalThis.QB_DATA_V2_CONFIG.banks,session:session,isCurrent:current});},runSync:function(){return mod.createSyncV2Coordinator({account:ACCOUNT_V2,repository:session.repository}).runOnce();},onStatus:function(state){if(!current())return;var node=document.getElementById('catalog-v2-status');if(node){node.dataset.state=state.state;node.textContent=state.state==='ready'?catalogV2Text('History saved and synced','历史已保存并同步','Historial guardado y sincronizado'):catalogV2Text('Preparing history records…','正在准备历史记录…','Preparando historial…')+(state.retryAfter?' '+state.retryAfter+' s':'');}}})};}
      await CATALOG_HISTORY_PREPARATION.coordinator.run();
      /*QB_NATIVE_ONLY_REMOVE_END*/
    }
    function catalogScheduleHistory(session,key,onReady){
      if(!catalogNativeHistory()||!isLoggedIn())return;
      if(CATALOG_HISTORY_SCHEDULE&&CATALOG_HISTORY_SCHEDULE.key===key&&(CATALOG_HISTORY_SCHEDULE.started||CATALOG_HISTORY_SCHEDULE.complete))return;
      var state={key:key,started:true,complete:false};CATALOG_HISTORY_SCHEDULE=state;
      catalogPrepareHistory(session,key).then(function(result){if(!catalogV2UICurrent(key)||CATALOG_HISTORY_SCHEDULE!==state)return;state.complete=true;onReady();if(globalThis.QB_DATA_V2_CONFIG.nativeOnlyMode===true&&result&&result.synced!==true){var node=document.getElementById('catalog-v2-status');if(node){var retry=document.createElement('button');retry.className='qb-btn';retry.dataset.testid='catalog-v2-history-retry';retry.textContent=catalogV2Text('Retry sync','重试同步','Reintentar sincronización');retry.onclick=function(){if(!catalogV2UICurrent(key))return;CATALOG_HISTORY_SCHEDULE=null;CATALOG_NATIVE_SYNC=null;catalogV2Refresh();};node.append(' ',retry);}}}).catch(function(error){if(!catalogV2UICurrent(key)||CATALOG_HISTORY_SCHEDULE!==state)return;state.error=error.code||'HISTORY_PREPARATION_FAILED';onReady();var node=document.getElementById('catalog-v2-status');if(node){node.dataset.state='pending';node.replaceChildren();var message=document.createElement('span');message.textContent=globalThis.QB_DATA_V2_CONFIG.nativeOnlyMode===true?catalogV2Text('Cloud sync is not confirmed; local data is safe.','云同步未确认；本机资料已保留。','Sincronización no confirmada; los datos locales están seguros.'):catalogV2Text('Some history is waiting to be prepared. Saved banks and records remain available.','部分历史待准备；已保存的题库和记录仍可使用。','Hay historial pendiente; los bancos y registros guardados siguen disponibles.');var retry=document.createElement('button');retry.className='qb-btn';retry.dataset.testid='catalog-v2-history-retry';retry.textContent=catalogV2Text('Retry','重试','Reintentar');retry.onclick=function(){if(!catalogV2UICurrent(key))return;state.started=false;CATALOG_NATIVE_SYNC=null;catalogScheduleHistory(session,key,onReady);};node.append(message,retry);if(Number.isSafeInteger(error.retryAfter)&&error.retryAfter>0){retry.disabled=true;message.textContent+=' '+error.retryAfter+' s';setTimeout(function(){if(catalogV2UICurrent(key)&&CATALOG_HISTORY_SCHEDULE===state)retry.disabled=false;},error.retryAfter*1000+20);}catalogV2UpgradeNotice(error);}});
    }
    async function catalogUnifiedHistoryList(){
      var box=document.getElementById('history-list'),key=catalogV2Key(),sequence=++CATALOG_V2_HISTORY_SEQUENCE,current=function(){return sequence===CATALOG_V2_HISTORY_SEQUENCE&&catalogV2UICurrent(key);};
      if(box.dataset.ownerKey!==key){box.replaceChildren();box.dataset.ownerKey=key;}if(!box.children.length)box.textContent=catalogV2Text('Preparing history records…','正在准备历史记录…','Preparando historial…');
      try{var session=await catalogV2Session();var entries=await session.history({includeSnapshots:true}),records=await session.storedBanks();if(!current())return;box.replaceChildren();catalogScheduleHistory(session,key,catalogUnifiedHistoryList);
        entries.forEach(function(entry){var imported=entry.kind==='imported_snapshot',scope=imported?entry.body.scope:entry.scope;var names=Array.from(new Set(scope.map(function(ref){var bank=records.find(function(row){return row.bankUid===ref.questionKey.split('/')[0];});return bank?bank.metadata.title:catalogV2Text('My bank','我的题库','Mi banco');})));var row=document.createElement('div');row.dataset.testid='catalog-v2-history-row';row.dataset.source=imported?'snapshot':'native';row.dataset.device=imported?'snapshot':entry.device;if(imported)row.dataset.historyBinding=entry.body.source.recordId+':'+entry.body.source.digest;var link=document.createElement('a');link.href=imported?'local.html?workbench=history&snapshot='+encodeURIComponent(entry.body.snapshotId):'local.html?workbench=history&attempt='+encodeURIComponent(entry.attempt.attemptId);var score=imported?entry.body.summary:{correct:entry.progress.firstCorrect,answered:entry.progress.firstAnswered,total:entry.attempt.scopeCount};link.textContent=(imported?'':(entry.device==='local'?catalogV2Text('This device','本设备','Este dispositivo'):catalogV2Text('Other device','其他设备','Otro dispositivo'))+' · '+(entry.syncPending?catalogV2Text('Sync pending','待同步','Sincronización pendiente'):catalogV2Text('Sync confirmed','已确认同步','Sincronización confirmada'))+' · ')+names.join(' + ')+' · '+score.correct+'/'+score.answered+' · '+(imported?catalogV2Text('Read-only','只读','Solo lectura'):entry.attempt.status)+' · '+fmtHistTime(imported?entry.body.recordedAt:entry.attempt.startedAt);row.append(link);{var next=document.createElement('a');next.className='qb-btn';next.dataset.testid='catalog-history-continue';next.href=link.href+'&continue=1';next.textContent=catalogV2Text('Continue practice','继续练习','Continuar práctica');row.append(next);}box.append(row);});
        if(!entries.length)box.textContent=isLoggedIn()&&globalThis.QB_DATA_V2_CONFIG.nativeOnlyMode!==true?catalogV2Text('History is being prepared or waiting to retry','历史正在准备或等待重试','Historial en preparación o pendiente'):catalogV2Text('No history yet','暂无历史记录','Sin historial');
        /*QB_NATIVE_ONLY_REMOVE_START*/
        if(globalThis.QB_DATA_V2_CONFIG.nativeOnlyMode!==true)catalogRenderPending(box,'history',session,key,current,false);
        /*QB_NATIVE_ONLY_REMOVE_END*/
      }catch(error){if(!current())return;var status=document.createElement('p');status.role='alert';status.textContent=catalogV2Text('History is not ready; your records are retained.','历史尚未准备好；资料已保留。','El historial no está listo; tus datos se conservan.');var retry=document.createElement('button');retry.className='qb-btn';retry.textContent=catalogV2Text('Retry','重试','Reintentar');retry.onclick=catalogUnifiedHistoryList;box.append(status,retry);if(Number.isSafeInteger(error.retryAfter)&&error.retryAfter>0){retry.disabled=true;status.textContent+=' '+error.retryAfter+' s';setTimeout(function(){if(current())retry.disabled=false;},error.retryAfter*1000+20);}}
    }
    function catalogV2Error(node,text,testid){if(!node)return;node.replaceChildren();var p=document.createElement('p');p.textContent=text;p.dataset.testid=testid;p.setAttribute('role','alert');node.append(p);}
    function catalogV2Card(grid,title,count,href,source){var card=document.createElement('div');card.className='card';card.dataset.testid='catalog-v2-bank-card';card.dataset.source=source;var heading=document.createElement('h2');heading.textContent=title;var note=document.createElement('p');note.textContent=source+' · '+count;var link=document.createElement('a');link.className='go';link.href=href;link.textContent=catalogV2Text('Open bank','打开题库','Abrir banco');card.append(heading,note,link);grid.append(card);return card;}
    async function catalogV2Refresh(){
      if(!globalThis.QB_DATA_V2_CONFIG.enabled)return;
      var key=catalogV2Key(),sequence=++CATALOG_V2_SEQUENCE,grid=document.getElementById('local-grid'),cloud=document.getElementById('cloud-grid');
      if(CATALOG_V2_KEY!==key){if(grid)grid.replaceChildren();if(cloud)cloud.replaceChildren();}
      if(CATALOG_V2_KEY!==key){CATALOG_V2_HISTORY_SEQUENCE++;var oldHistory=document.getElementById('history-list');if(oldHistory)oldHistory.replaceChildren();var modal=document.getElementById('history-modal');if(modal)modal.hidden=true;var statusNode=document.getElementById('catalog-v2-status');if(statusNode){statusNode.dataset.state='idle';statusNode.textContent=catalogV2Text('Identity changed; sync is not confirmed.','身份已更新；云同步状态需重新确认。','Identidad cambiada; sincronización sin confirmar.');}}
      if(CATALOG_V2_KEY!==key && CATALOG_V2_SESSION){CATALOG_V2_SESSION.close();CATALOG_V2_SESSION=null;}
      // The existing account menu owns History; no duplicate sync/recovery panel.
      var historyControl=document.querySelector('[data-testid="catalog-v2-history"]');
      if(globalThis.QB_DATA_V2_CONFIG.nativeOnlyMode===true){var oldArchive=document.getElementById('cloud-grid');if(oldArchive)oldArchive.hidden=true;}
      if(catalogNativeHistory()){if(historyControl)historyControl.textContent=catalogV2Text('History','历史成绩','Historial');var cloudBox=document.getElementById('cloud-box');if(cloudBox)cloudBox.hidden=true;}
      try{var session=await catalogV2Session();var records=await session.repository.readRecords('bank_revisions');if(sequence!==CATALOG_V2_SEQUENCE||!catalogV2Current(key))return;grid.replaceChildren();grid.dataset.nativeBankUids=JSON.stringify(records.map(function(r){return r.bankUid;}));catalogScheduleHistory(session,key,catalogV2Refresh);
        var seen=new Set();records.filter(function(r){return ['private','protected'].includes(r.metadata.visibility);}).reverse().forEach(function(r){if(seen.has(r.bankUid))return;seen.add(r.bankUid);catalogV2Card(grid,r.metadata.title,r.metadata.questionCount,'local.html?bank='+encodeURIComponent(r.bankUid),session.owner.ownerKind==='account'?'account':'device');});
        if(!seen.size){var empty=document.createElement('p');empty.dataset.nativeEmpty='1';empty.textContent=globalThis.QB_DATA_V2_CONFIG.nativeOnlyMode===true?catalogV2Text('No private banks yet. Import a bank to get started.','暂无私有题库。导入题库开始使用。','Aún no hay bancos privados. Importa uno para empezar.'):catalogV2Text('No new private banks for this identity on this device. Import or recover cloud data.','此身份在本设备暂无新版私库；可导入或恢复云端资料。','No hay bancos nuevos locales para esta identidad. Importa o recupera la nube.');grid.append(empty);}
        /*QB_NATIVE_ONLY_REMOVE_START*/
        if(globalThis.QB_DATA_V2_CONFIG.nativeOnlyMode!==true){var old;try{old=JSON.parse(localStorage.getItem(LOCAL_KEY)||'{}');}catch(e){old={};}
          Object.keys(old).forEach(function(id){var r=old[id];if(r&&Array.isArray(r.questions)){var card=catalogV2Card(grid,r.title||id,r.questions.length,'local.html?workbench=legacy-local','legacy-device');if(catalogNativeHistory()){card.querySelector('a').remove();card.querySelector('p').textContent=catalogV2Text('Bank waiting to be prepared','题库待准备','Banco pendiente de preparación')+' · '+r.questions.length;card.dataset.state='pending';return;}card.querySelector('a').textContent=catalogV2Text('Archive original browser data','归档本机原资料','Archivar datos originales');var copy=document.createElement('button');copy.className='qb-btn';copy.dataset.testid='catalog-v2-import-legacy-copy';copy.textContent=catalogV2Text('Keep original & import a new playable copy','保留原数据并导入新版副本','Conservar original e importar copia');copy.onclick=function(){if(!catalogV2Current(key))return;var source;try{source=JSON.parse(localStorage.getItem(LOCAL_KEY)||'{}')[id];}catch(e){}if(!source||!Array.isArray(source.questions)){importMessage('Original bank unavailable; nothing was changed.',true);return;}if(!confirm(catalogV2Text('Import into the current identity? Original data will remain unchanged.','导入到当前身份？原数据保持不变。','¿Importar a la identidad actual? El original no cambia.')))return;catalogV2Import(JSON.stringify(source.questions),source.title||id,{append:false});};card.append(copy);}});
        }
        /*QB_NATIVE_ONLY_REMOVE_END*/
        if(!isLoggedIn()){if(globalThis.QB_DATA_V2_CONFIG.nativeOnlyMode===true)return;cloud.textContent=catalogV2Text('Sign in to read original account archives. Device import is not cloud upload.','登录后可读取账号旧归档；本机导入不等于云端上传。','Inicia sesión para leer archivos originales. Importación local no es subida.');return;}
        if(globalThis.QB_DATA_V2_CONFIG.nativeOnlyMode===true){cloud.hidden=true;if(!document.getElementById('history-modal').hidden)catalogUnifiedHistoryList();return;}
        /*QB_NATIVE_ONLY_REMOVE_START*/
        if(catalogNativeHistory()){cloud.hidden=true;catalogRenderPending(grid,'banks',session,key,function(){return sequence===CATALOG_V2_SEQUENCE&&catalogV2Current(key);},false);if(!document.getElementById('history-modal').hidden)catalogUnifiedHistoryList();return;}
        /*QB_NATIVE_ONLY_REMOVE_END*/
        /*QB_NATIVE_ONLY_REMOVE_START*/
        var client=await catalogV2Legacy(),cursor=null;
        for(var page=0;page<20;page++){var result=await client.listBanks({limit:5,cursor:cursor});if(sequence!==CATALOG_V2_SEQUENCE||!catalogV2Current(key))return;result.items.forEach(function(r){catalogV2Card(cloud,r.title||r.id,r.count,'local.html?workbench=legacy-bank&id='+encodeURIComponent(r.id),'legacy-account (只读来源)');});if(result.nextCursor===null)break;cursor=result.nextCursor;}
        if(!cloud.children.length)cloud.textContent=catalogV2Text('No private banks in original archives. Use cloud recovery for new cloud data.','旧归档中没有私库。新版云资料请使用云端恢复。','No hay bancos en archivos originales. Recupera la nube para datos nuevos.');
        /*QB_NATIVE_ONLY_REMOVE_END*/
      }catch(error){if(sequence!==CATALOG_V2_SEQUENCE||!catalogV2Current(key))return;catalogV2Error(cloud,'资料读取失败，不能据此认定为空；请登录或重试。','catalog-v2-archive-error');}
    }
    async function catalogV2Import(text,title,opts){
      var accountTarget=document.getElementById('import-to-account');
      if((opts.sync||(accountTarget&&accountTarget.checked))&&!isLoggedIn()){importMessage(catalogV2Text('Sign in first, then import an account copy. No guest bank was uploaded.','请先登录，再导入账号副本。没有上传访客题库。','Inicia sesión primero y vuelve a importar una copia de cuenta. No se subió un banco visitante.'),true);openLoginModal();return false;}
      if(typeof text!=='string'||text.length>16*1024*1024){importMessage('导入超过安全大小上限，未保存。',true);return false;}
      if(opts.append){importMessage(catalogV2Text('Appending is not enabled. Combine JSON and import a new bank; existing banks were not overwritten.','新版分批追加尚未启用；请合并 JSON 后导入为新题库。未覆盖任何现有题库。','Añadir lotes no está habilitado. Combina JSON e importa un banco nuevo; nada fue sobrescrito.'),true);return false;}
      var parsed=parseBankFromText(text);if(!parsed.list){importMessage(T('err_parse'),true);return false;}var checked=validateBank(parsed.list);if(!checked.valid.length){importMessage(T('err_shape'),true);return false;}
      var key=catalogV2Key();try{var session=await catalogV2Session(),mod=await import('./browser/data-v2.js');if(!catalogV2UICurrent(key))return false;var imported=await mod.registerImportedBank(checked.valid,{title:title,sourceOrigin:location.origin});if(!catalogV2UICurrent(key))return false;await session.startBank([{content:imported.content}]);await session.pauseWriting();if(!catalogV2UICurrent(key))return false;
        importMessage(catalogV2Text('Saved on this device','已保存到本设备','Guardado en este dispositivo')+' ('+checked.valid.length+'). '+catalogV2Text('Cloud sync is not confirmed.','未确认云同步。','La nube no está confirmada.')+(checked.rejected?' '+catalogV2Text('Rejected','已拒绝','Rechazadas')+': '+checked.rejected:'')+(parsed.salvaged?' '+catalogV2Text('Input may be truncated; combine the remaining content and import a new copy.','输入可能被截断；请补齐合并后导入新副本。','El texto puede estar truncado; combina el resto e importa una copia nueva.'):''),false);await catalogV2Refresh();
        var toAccount=document.getElementById('import-to-account');if(opts.sync||(toAccount&&toAccount.checked))await catalogV2Sync();return true;
      }catch(error){if(catalogV2UICurrent(key))importMessage('导入未完成；请重试或检查账户恢复状态。',true);return false;}
    }
    async function catalogV2Sync(){
      var node=document.getElementById('catalog-v2-status'),key=catalogV2Key();
      if(CATALOG_V2_RETRY_KEY===key&&Date.now()<CATALOG_V2_RETRY_AT)return;
      if(!isLoggedIn()){if(node)node.textContent=catalogV2Text('Sign in; local data has not been uploaded.','需要登录；本机资料尚未上传。','Inicia sesión; los datos locales no se han subido.');openLoginModal();return;}
      try{var session=await catalogV2Session(),mod=await import('./browser/data-v2.js');await session.flush();if(!catalogV2UICurrent(key))return;if(node)node.dataset.state='syncing';if(node)node.textContent=catalogV2Text('Syncing…','同步中…','Sincronizando…');
        var result=await mod.createSyncV2Coordinator({account:ACCOUNT_V2,repository:session.repository}).runOnce();if(!catalogV2UICurrent(key))return;
        if(node)node.dataset.state=result.synced?'synced':result.paused?'paused':'pending';
        if(result.paused&&result.reason==='RATE_LIMITED'){
          var seconds=Number.isSafeInteger(result.retryAfter)&&result.retryAfter>0?result.retryAfter:null;
          if(node)node.textContent=catalogV2Text('Rate limited; retry after ','限流，请在以下秒数后重试：','Límite alcanzado; reintenta después de ')+(seconds===null?'—':seconds)+' s';
          if(seconds!==null){CATALOG_V2_RETRY_KEY=key;CATALOG_V2_RETRY_AT=Date.now()+seconds*1000;var syncButton=document.getElementById('catalog-v2-sync');if(syncButton)syncButton.disabled=true;setTimeout(function(){if(syncButton&&catalogV2UICurrent(key)&&Date.now()>=CATALOG_V2_RETRY_AT)syncButton.disabled=false;},seconds*1000+20);}
        }else if(node)node.textContent=result.synced?catalogV2Text('Cloud confirmed synced','云端已确认同步','Nube sincronizada y confirmada'):catalogV2Text('Pending changes; sync again','仍有待同步资料；请再次同步。','Cambios pendientes; sincroniza otra vez');
        await catalogV2Refresh();if(!catalogV2UICurrent(key))return;var modal=document.getElementById('history-modal');if(modal&&!modal.hidden)await catalogV2History();
      }catch(error){if(catalogV2UICurrent(key)){if(node)node.dataset.state='error';if(node)node.textContent=catalogV2Text('Cloud sync failed; device data is retained.','云同步失败；本机资料仍保留。','Falló la sincronización; los datos locales se conservan.');catalogV2UpgradeNotice(error);}}
    }
    async function catalogV2History(){if(catalogNativeHistory())return catalogUnifiedHistoryList();var box=document.getElementById('history-list'),key=catalogV2Key(),sequence=++CATALOG_V2_HISTORY_SEQUENCE;var current=function(){return sequence===CATALOG_V2_HISTORY_SEQUENCE&&catalogV2UICurrent(key);};box.textContent=catalogV2Text('Loading history…','正在读取历史…','Cargando historial…');try{var session=await catalogV2Session(),bundles=await session.history(),bankRecords=await session.repository.readRecords('bank_revisions');if(!current())return;box.replaceChildren();bundles.forEach(function(bundle){var names=Array.from(new Set(bundle.scope.map(function(ref){var uid=ref.questionKey.split('/')[0],record=bankRecords.find(function(r){return r.bankUid===uid;});return record?record.metadata.title:uid;})));var row=document.createElement('div');row.dataset.testid='catalog-v2-history-row';var link=document.createElement('a');link.href='local.html?workbench=history&attempt='+encodeURIComponent(bundle.attempt.attemptId);link.textContent=names.join(' + ')+' · '+bundle.attempt.status+' · '+bundle.progress.firstCorrect+'/'+bundle.progress.firstAnswered+' · '+fmtHistTime(bundle.attempt.startedAt);row.append(link);box.append(row);});
      /*QB_NATIVE_ONLY_REMOVE_START*/
      if(isLoggedIn()){var client=await catalogV2Legacy(),cursor=null;for(var page=0;page<20;page++){var result=await client.listHistory({limit:5,cursor:cursor});if(!current())return;result.items.forEach(function(r){var row=document.createElement('div');row.dataset.testid='catalog-v2-history-row';row.dataset.source='legacy-account';var link=document.createElement('a');link.href='local.html?workbench=legacy-history&id='+encodeURIComponent(r.id);link.textContent=catalogV2Text('View history (read-only)','查看历史（只读）','Ver historial (solo lectura)')+' · '+(r.title||r.bank_id||'');var score=document.createElement('span');score.dataset.testid='catalog-v2-original-score';score.textContent=catalogV2Text('Original score not loaded','原成绩待读取','Nota original sin cargar');var read=document.createElement('button');read.className='qb-btn';read.dataset.testid='catalog-v2-read-original-score';read.textContent=catalogV2Text('Read original score','读取原成绩','Leer nota original');read.onclick=async function(){read.disabled=true;try{var loaded=await client.readHistory(r.id);if(!current())return;var value=loaded.record.score;score.textContent=value&&Number.isFinite(value.correct)&&Number.isFinite(value.answered)?value.correct+'/'+value.answered+' · '+value.total:catalogV2Text('Original record contains no score','原记录无成绩字段','El original no contiene nota');}catch(error){if(current())score.textContent=catalogV2Text('Original score read failed; retry','原成绩读取失败；请重试','No se pudo leer la nota; reintenta');}finally{if(current())read.disabled=false;}};row.append(link,score,read);box.append(row);});if(result.nextCursor===null)break;cursor=result.nextCursor;}}
      /*QB_NATIVE_ONLY_REMOVE_END*/
      if(!box.children.length)box.textContent='暂无历史记录。';
    }catch(error){if(current()){var p=document.createElement('p');p.dataset.testid='catalog-v2-history-error';p.role='alert';p.textContent='历史读取失败，不能据此认定为空；本机记录未删除。';box.append(p);}}}
    function fmtHistTime(ts){ try{ return new Date(ts).toLocaleString(); }catch(e){ return ""; } }
    function openHistory(){
      if (ACCOUNT_V2_CANDIDATE && (candidateRecoveryBlocksControls(ACCOUNT_V2_STATE) || ACCOUNT_V2_LOAD_ERROR)){ renderCandidateAccountRecovery(ACCOUNT_V2_STATE); return; }
      if (!isLoggedIn()){ openLoginModal(); return; }
      var m = document.getElementById("history-modal"); if (!m) return;
      m.hidden = false; renderHistoryList();
    }
    function closeHistory(){ var m = document.getElementById("history-modal"); if (m) m.hidden = true; }
    function renderHistoryList(){
      var box = document.getElementById("history-list"); if (!box) return;
      if (ACCOUNT_V2_CANDIDATE){ catalogV2History(); return; }
      box.innerHTML = '<div class="qb-hint" style="padding:6px">' + escHtml(T("hist_loading")) + '</div>';
      fetch(QB_API_BASE + "/history", { headers: authHeaders() })
        .then(function(res){
          if (res.status === 401){ clearAuth(); closeHistory(); openLoginModal(); return null; }
          if (res.status !== 200) throw new Error("history_http_" + res.status);
          return res.json().then(function(d){
            if (!d || d.ok !== true || !Array.isArray(d.items)) throw new Error("history_invalid_payload");
            return d;
          });
        })
        .then(function(d){
          if (!d) return;
          var items = (d && d.items) || [];
          if (!items.length){ box.innerHTML = '<div class="qb-hint" style="padding:6px">' + escHtml(T("hist_empty")) + '</div>'; return; }
          box.innerHTML = items.map(function(it){
            var sc = it.score ? (it.score.correct + "/" + it.score.answered + " \\u2713 \\u00B7 " + it.score.answered + "/" + it.score.total) : escHtml(T("hist_unanswered"));
            var id = escHtml(it.id);
            return '<div class="hist-row"><div class="hist-main"><div class="hist-title">' + escHtml(it.title || it.bank_id) + '</div>' +
              '<div class="hist-sub">' + sc + ' \\u00B7 ' + escHtml(fmtHistTime(it.ts)) + '</div></div>' +
              '<button class="qb-btn" onclick="restoreSnapshot(\\'' + id + '\\')">' + escHtml(T("hist_load")) + '</button>' +
              '<button class="qb-x" onclick="deleteSnapshot(\\'' + id + '\\')" aria-label="delete">\\u2715</button></div>';
          }).join("");
        })
        .catch(function(){ box.innerHTML = '<div class="qb-hint" style="padding:6px;color:var(--danger-ink)">' + escHtml(T("hist_neterr")) + '</div>'; });
    }
    function deleteSnapshot(id){
      if (ACCOUNT_V2_CANDIDATE) return;
      if (!confirm(T("hist_del_confirm"))) return;
      fetch(QB_API_BASE + "/history?id=" + encodeURIComponent(id), { method: "DELETE", headers: authHeaders() })
        .then(function(){ renderHistoryList(); }, function(){ renderHistoryList(); });
    }
    function restoreSnapshot(id){
      if (ACCOUNT_V2_CANDIDATE){ loginStatus("History restore is unavailable in candidate mode.", "err"); return; }
      fetch(QB_API_BASE + "/history?id=" + encodeURIComponent(id), { headers: authHeaders() })
        .then(function(res){ if (res.status === 401){ clearAuth(); closeHistory(); openLoginModal(); return null; } return res.json(); })
        .then(function(d){
          var snap = d && d.snapshot;
          if (!snap){ alert(T("hist_load_fail")); return; }
          try{ sessionStorage.setItem("qb_restore", JSON.stringify(snap)); }catch(e){}
          var bid = String(snap.bank_id || "");
          var url;
          if (bid.indexOf("u-") === 0) url = "player.html?mybank=" + encodeURIComponent(bid.slice(2));        // 私有库 → ?mybank
          else if (bid.indexOf("local-") === 0) url = "local.html?bank=" + encodeURIComponent(bid.slice(6));  // 本地库 → 去掉 local- 前缀
          else url = "player.html?bank=" + encodeURIComponent(bid);                                            // 公开库
          location.href = url;
        })
        .catch(function(){ alert(T("hist_load_fail")); });
    }

    /* ---- 私有题库：上传到账号（云端私有），登录后任意设备打开 ---- */
    function uploadBankToAccount(title, questions, rejected, opts){
      if (ACCOUNT_V2_CANDIDATE){ catalogV2Import(JSON.stringify(questions),title,{sync:true}); return; }
      opts = opts || {};
      importMessage(T("cloud_uploading"), false);
      fetch(QB_API_BASE + "/banks", { method:"POST", headers:Object.assign({"Content-Type":"application/json"}, authHeaders()), body: JSON.stringify({ bank: { id: slugLocal(title), title: title, questions: questions } }) })
        .then(function(res){ return res.json().then(function(d){ return { status: res.status, d: d }; }, function(){ return { status: res.status, d: {} }; }); })
        .then(function(r){
          if (r.status === 401){ clearAuth(); openLoginModal(); importMessage(T("cloud_need_login"), true); return; }
          if (r.status >= 200 && r.status < 300 && r.d && r.d.ok === true && isStoredBankId(r.d.saved)){
            var t2 = document.getElementById("import-to-account"); if (t2) t2.checked = false;
            if (opts.localId){
              var copy = migrateLocalProgressToCloud(opts.localId, r.d.saved);
              var copyMessage = copy.failed || copy.conflicts
                ? T("cloud_copy_partial", { t: title, n: questions.length, c: copy.conflicts, f: copy.failed })
                : T("cloud_copy_ok", { t: title, n: questions.length });
              renderCloudBanks();
              importMessage(copyMessage, !!(copy.failed || copy.conflicts));
              return;
            }
            renderCloudBanks();
            importMessage(T("cloud_uploaded", { t: title, n: questions.length }) + (rejected ? T("import_rej", { r: rejected }) : ""), false);
          } else if (r.d && r.d.error === "limit"){ importMessage(T("cloud_limit", { n: (r.d.limit || 15) }), true); }
          else if (r.d && (r.d.error === "too_large" || r.d.error === "too_many_questions")){ importMessage(T("cloud_too_large"), true); }
          else { importMessage(T("cloud_fail"), true); }
        })
        .catch(function(){ importMessage(T("cloud_neterr"), true); });
    }
    // 本地题库做题进度从 local-<id> 命名空间复制到云端 u-<cloudId>（题目内容相同→dedup 出的题 id 相同→进度键通用）
    function localNs(localId){ return "local-" + String(localId).replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 48); }
    function isStoredBankId(value){
      if (typeof value !== "string" || value.length < 1 || value.length > 48 || !/^[a-z0-9_][a-z0-9_-]*$/.test(value)) return false;
      return !value.endsWith("-") || value.length === 48;
    }
    var PROGRESS_SUFFIXES = ["_starred_questions", "_wrong_questions", "_attempt_count_map_v1", "_conquered_questions_v1", "_last_active_v1"];
    function migrateLocalProgressToCloud(localId, cloudId){
      if (ACCOUNT_V2_CANDIDATE) return { copied: 0, skipped: 0, conflicts: 0, failed: 0 };
      var result = { copied: 0, skipped: 0, conflicts: 0, failed: 0 };
      if (!localId || !isStoredBankId(cloudId)) return { copied: 0, skipped: 0, conflicts: 0, failed: PROGRESS_SUFFIXES.length };
      var fromNs = localNs(localId), toNs = "u-" + cloudId;
      PROGRESS_SUFFIXES.forEach(function(suf){
        var sourceValue, targetValue;
        try{ sourceValue = localStorage.getItem(fromNs + suf); }
        catch(e){ result.failed++; return; }
        try{ targetValue = localStorage.getItem(toNs + suf); }
        catch(e){ result.failed++; return; }
        if (sourceValue == null){ result.skipped++; return; }
        if (targetValue != null){
          if (targetValue === sourceValue) result.skipped++;
          else result.conflicts++;
          return;
        }
        try{ localStorage.setItem(toNs + suf, sourceValue); }
        catch(e){ result.failed++; return; }
        try{
          if (localStorage.getItem(toNs + suf) !== sourceValue) result.failed++;
          else result.copied++;
        }catch(e){ result.failed++; }
      });
      return result;
    }
    function renderCloudBanks(){
      var box = document.getElementById("cloud-box");
      var grid = document.getElementById("cloud-grid");
      if (ACCOUNT_V2_CANDIDATE){ if (box) box.hidden = false; catalogV2Refresh(); return; }
      if (!grid) return;
      if (!isLoggedIn()){ if (box) box.hidden = true; return; }
      fetch(QB_API_BASE + "/banks", { headers: authHeaders() })
        .then(function(res){ if (res.status === 401){ clearAuth(); return null; } return res.json(); })
        .then(function(d){
          if (!d){ if (box) box.hidden = true; return; }
          var items = (d && d.items) || [];
          if (box) box.hidden = false;
          if (!items.length){ grid.innerHTML = '<div class="desc" style="padding:6px">' + escHtml(T("cloud_empty")) + '</div>'; return; }
          grid.innerHTML = items.map(function(b){
            var id = escHtml(b.id);
            return '<div class="card" data-testid="cloud-card" data-cloud-id="' + id + '">' +
              '<div class="card-head"><h2>' + escHtml(b.title || b.id) + '</h2><span class="pill progress">' + escHtml(T("cloud_badge")) + '</span></div>' +
              '<div class="meta-row"><span class="pill muted">' + escHtml(T("count", { n: b.count || 0 })) + '</span></div>' +
              '<div style="display:flex;gap:14px;align-items:center;margin-top:12px">' +
              '<a class="go" style="margin-top:0" href="player.html?mybank=' + encodeURIComponent(b.id) + '" data-testid="cloud-practice-link">' + escHtml(T("local_practice")) + '</a>' +
              '<button class="pill muted" style="cursor:pointer" onclick="deleteCloudBank(\\'' + id + '\\')" data-testid="cloud-delete-btn">' + escHtml(T("cloud_delete")) + '</button>' +
              '</div></div>';
          }).join("");
        })
        .catch(function(){ if (box) box.hidden = false; grid.innerHTML = '<div class="desc" style="padding:6px;color:var(--danger-ink)">' + escHtml(T("cloud_neterr")) + '</div>'; });
    }
    function deleteCloudBank(id){
      if (ACCOUNT_V2_CANDIDATE) return;
      if (!confirm(T("cloud_del_confirm"))) return;
      fetch(QB_API_BASE + "/banks?id=" + encodeURIComponent(id), { method:"DELETE", headers: authHeaders() })
        .then(function(){ renderCloudBanks(); }, function(){ renderCloudBanks(); });
    }

    // 分享码（特殊题库）模式：直接进那个题库，不渲染目录页
    var _sp0 = getSpecial();
    if (_sp0 && _sp0.code) {
      location.replace("player.html?special=1");
    } else {
      applyLang();
      applyThemeIcon();
      scanProgress();
    }
${DONATION ? `
    /* ---- ☕ Buy me a coffee（打赏） ---- */
    var DONATION = ${JSON.stringify(DONATION)};
    function coffeeUrl(amount){ var url = (DONATION && DONATION.url) ? DONATION.url : ""; if (url && amount && DONATION.provider === "paypal"){ url = url.replace(/\\/+$/, "") + "/" + amount + (DONATION.currency || ""); } return url; }
    function setupCoffeeTiers(){
      if (!DONATION) return;
      var cr = document.getElementById("coffee-custom-row"); if (cr) cr.hidden = (DONATION.provider !== "paypal");
      if (!Array.isArray(DONATION.amounts) || DONATION.amounts.length < 3) return;
      ["coffee-tier-s","coffee-tier-m","coffee-tier-l"].forEach(function(id, i){
        var btn = document.querySelector('[data-testid="' + id + '"]'); if (!btn) return;
        btn.dataset.amount = String(DONATION.amounts[i]);
        var b = btn.querySelector(".ct-amt"); if (!b){ b = document.createElement("span"); b.className = "ct-amt"; btn.appendChild(b); }
        b.textContent = "$" + DONATION.amounts[i];
      });
    }
    function fireConfetti(x, y){
      try{
        if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        var canvas = document.getElementById("qb-confetti"); if (!canvas || !canvas.getContext) return;
        var ctx = canvas.getContext("2d"), DPR = Math.min(2, window.devicePixelRatio || 1);
        var W = canvas.width = Math.floor(innerWidth * DPR), H = canvas.height = Math.floor(innerHeight * DPR);
        canvas.style.width = innerWidth + "px"; canvas.style.height = innerHeight + "px"; canvas.hidden = false;
        var cx = (x != null ? x : innerWidth / 2) * DPR, cy = (y != null ? y : innerHeight / 2) * DPR;
        var colors = ["#f59e0b","#fbbf24","#6f9bff","#34d399","#f472b6","#a78bfa","#fb7185"], parts = [];
        for (var i = 0; i < 130; i++){ var a = Math.random() * Math.PI * 2, sp = (4 + Math.random() * 9) * DPR;
          parts.push({ x: cx, y: cy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 6 * DPR, g: 0.28 * DPR, w: (5 + Math.random() * 6) * DPR, h: (8 + Math.random() * 7) * DPR, rot: Math.random() * 6.28, vr: (Math.random() - .5) * 0.4, col: colors[i % colors.length], life: 1 }); }
        var frame = 0;
        (function tick(){ frame++; ctx.clearRect(0, 0, W, H); var alive = false;
          for (var j = 0; j < parts.length; j++){ var p = parts[j]; p.vy += p.g; p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.vx *= 0.99; p.life -= 0.012;
            if (p.life > 0 && p.y < H + 40){ alive = true; ctx.save(); ctx.globalAlpha = Math.max(0, p.life); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillStyle = p.col; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); ctx.restore(); } }
          if (alive && frame < 260) requestAnimationFrame(tick); else { ctx.clearRect(0, 0, W, H); canvas.hidden = true; } })();
      }catch(e){}
    }
    function coffeeBankCount(){ if (ACCOUNT_V2_CANDIDATE) return 0; var n = 0; try{ for (var i = 0; i < localStorage.length; i++){ var k = localStorage.key(i); if (k && k.indexOf("_attempt_count_map_v1") > 0){ try{ var m = JSON.parse(localStorage.getItem(k)); if (m && Object.keys(m).length) n++; }catch(e){} } } }catch(e){} return n; }
    function coffeeReset(){
      var b = document.getElementById("coffee-barista"); if (b) b.className = "barista";
      var roll = document.getElementById("coffee-roll"); if (roll){ roll.hidden = true; roll.textContent = ""; }
      var rev = document.getElementById("coffee-reveal"); if (rev) rev.hidden = true;
      var th = document.getElementById("coffee-thanks"); if (th) th.hidden = true;
      var s = document.getElementById("coffee-stat"); if (s){ var n = coffeeBankCount(); if (n > 0){ s.textContent = T("coffee_stat", { n: n }); s.hidden = false; } else s.hidden = true; }
    }
    function coffeeRevealDonate(){ var rev = document.getElementById("coffee-reveal"); if (rev) rev.hidden = false; }
    function runBarista(){
      var b = document.getElementById("coffee-barista");
      var roll = document.getElementById("coffee-roll");
      var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (!b || reduce){ if (b) b.className = "barista brewed"; if (roll){ roll.textContent = T("coffee_brew_done"); roll.hidden = false; } coffeeRevealDonate(); return; }
      b.className = "barista brewing";
      if (roll){ roll.textContent = T("coffee_brewing"); roll.hidden = false; }
      setTimeout(function(){ b.classList.add("brewed"); if (roll) roll.textContent = T("coffee_brew_done"); fireConfetti(innerWidth / 2, innerHeight * 0.42); }, 1650);
      setTimeout(function(){ coffeeRevealDonate(); }, 1850);
    }
    function openCoffee(){ var ov = document.getElementById("coffee-modal"); if (!ov) return; coffeeReset(); ov.hidden = false; runBarista(); }
    // FAB 摆动：目录页一直跳（小幅度），载入即开始
    (function(){ var f = document.getElementById("coffee-btn"); if (f) f.classList.add("wiggle"); })();
    function closeCoffee(){ var ov = document.getElementById("coffee-modal"); if (ov) ov.hidden = true; }
    function coffeeGo(ev){ var t = ev && ev.currentTarget; var amount = (t && t.dataset && t.dataset.amount) ? t.dataset.amount : null;
      if (!amount){ var inp = document.getElementById("coffee-custom"); var v = inp ? parseFloat(inp.value) : NaN; if (isFinite(v) && v > 0) amount = String(Math.round(v * 100) / 100); }
      var url = coffeeUrl(amount);
      try{ if (url) window.open(url, "_blank", "noopener"); }catch(e){}
      var x = innerWidth / 2, y = innerHeight / 2; if (ev && typeof ev.clientX === "number" && (ev.clientX || ev.clientY)){ x = ev.clientX; y = ev.clientY; }
      fireConfetti(x, y); var th = document.getElementById("coffee-thanks"); if (th) th.hidden = false; }
    setupCoffeeTiers(); // DONATION 此处已赋值，给三档写上金额（init 里那次太早、DONATION 还没定义）
` : ''}
  </script>
</body>
</html>
`;
}

// local.html：本地导入题库的通用播放器（题库存在访问者浏览器的 localStorage 里，
// 由目录页「Import your own bank」写入，?bank=<id> 指定）。命名空间启动时按 id 重设。
writeFileSync(path.join(OUT, 'local.html'), playerHtml({ mode: 'local-bank' }, 'local'));
console.log('✓ local.html  (本地导入播放器)');

// format.html：题库 JSON 格式文档（双语），给想自己写题库的人
writeFileSync(path.join(OUT, 'format.html'), formatHtml());
writeFileSync(path.join(OUT, 'format-ielts.html'), formatIeltsHtml());
console.log('✓ format.html + format-ielts.html (JSON 格式文档 / 雅思子页)');

const catalogEntries = mergedEntry ? [mergedEntry, ...generated] : generated;
writeFileSync(path.join(OUT, 'index.html'), catalogHtml(catalogEntries).replace(ACCOUNT_UI_MARKER, ACCOUNT_V2_UI_ENABLED ? 'true' : 'false'));
writeFileSync(path.join(OUT, '.nojekyll'), '');
writeFileSync(path.join(OUT, 'build-compatibility.json'), JSON.stringify(BUILD_ENV.compatibility, null, 2) + '\n');
// Pin actual final module bytes, after bundling, across every generated HTML.
const browserModules = new Map(readdirSync(path.join(OUT, 'browser')).filter(name => name.endsWith('.js')).map(name => [name, readFileSync(path.join(OUT, 'browser', name))]));
for (const entry of readdirSync(OUT).filter(name => name.endsWith('.html'))) {
  const file = path.join(OUT, entry);
  let html = readFileSync(file, 'utf8');
  html = html.replaceAll('/*QB_NATIVE_SYNC_IMPORT__*/', NATIVE_ONLY_MODE ? "import('./browser/native-history-sync.js')" : "Promise.reject(Object.assign(new Error('NATIVE_SYNC_NOT_BUILT'),{code:'NATIVE_SYNC_NOT_BUILT'}))");
  if (NATIVE_ONLY_MODE) {
    // The compatibility build keeps these marked regions. Native-only output
    // physically removes archive readers, old local-format import handlers,
    // and pending inventories before pinning module references.
    html = html.replace(/\/\*QB_NATIVE_ONLY_REMOVE_START\*\/[\s\S]*?\/\*QB_NATIVE_ONLY_REMOVE_END\*\//g, '');
    if (html.includes('QB_NATIVE_ONLY_REMOVE_')) throw new Error('NATIVE_ONLY_STRIP_INCOMPLETE');
  }
  writeFileSync(file, pinBrowserModuleReferences(html, browserModules));
}
const commitResult = BUILD.commit(['index.html', 'player.html', 'local.html', 'banks/index.json', 'browser/account-v2.js', ...(NATIVE_ONLY_MODE ? ['browser/native-history-sync.js'] : ['browser/legacy-migration-client.js','browser/local-storage-migration.js']), 'browser/html-sanitizer.js', 'build-compatibility.json', ...(DATA_V2_ENABLED ? ['browser/data-v2.js', 'banks/v2/manifest.json'] : [])]);
if (commitResult.backupRetained) console.warn(`! new output is active, but prior output backup was retained for manual cleanup: ${commitResult.backupRetained}`);
if (commitResult.ownerRetained) console.warn(`! new output is active, but its owner journal remains for explicit manual cleanup: ${commitResult.ownerRetained}`);
console.log(`\nindex.html → 目录页（${catalogEntries.length} 个入口 + 本地导入）`);
console.log(`Pages site: ${generated.length} bank page(s) + catalog in ${path.relative(ROOT, TARGET_OUT) || '.'}/ (${BUILD_ENV.name}, ${API_BASE || 'no API'})`);
