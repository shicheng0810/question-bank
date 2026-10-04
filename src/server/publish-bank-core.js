// 发布核心：校验 →（可选加密）→ 写 public/banks/<id> → upsert public/banks/index.json。
// 两个入口共用这一份实现，杜绝漂移：
//   - 双击命令 commands/publish-bank.command（scripts/publish-bank.mjs 的交互壳）
//   - 提取器内的「发布到站点」按钮（src/server/local-publish-proxy.js 的 dev 接口）
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { validateQuestionBankRecords } from '../lib/testable-core.js';
import { slugifyBankId } from '../lib/site-package.js';
import { encryptQuestionBankPayload, decryptQuestionBankPayload } from '../lib/qbpack.js';
import { canonicalContentBytes } from '../domain/app-data/canonical.js';
import { finalizeRegisteredQuestions } from '../domain/question/registered-identity.js';

const REGISTERED_PUBLICATION_FIELDS = ['bankUid', 'questionUid', 'questionKey', 'questionRevision', 'optionIds'];
function hasRegisteredPublicationDeclaration(value) {
  return value !== null && typeof value === 'object' && REGISTERED_PUBLICATION_FIELDS.some((key) => Object.hasOwn(value, key));
}
function registeredPublicationError(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}
function sameCanonical(left, right) {
  const a = canonicalContentBytes(left); const b = canonicalContentBytes(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function readBankManifest(root) {
  try {
    const parsed = JSON.parse(readFileSync(path.join(root, 'public/banks/index.json'), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (_e) {
    return [];
  }
}

// 读回某个已发布题库的完整题目（公开 = 直接读 .json；加密 = 用密码解密 .qbpack）。
// 给「站主本地编辑线上题库」用：读出来 → 提取器编辑 → 用同 id 重新发布覆盖。
export async function readBankContent({ root, id, password = '' }) {
  const manifest = readBankManifest(root);
  const entry = manifest.find((e) => e && e.id === id);
  if (!entry) throw new Error(`找不到题库 "${id}"`);
  let questions;
  if (entry.mode === 'protected') {
    const srcPath = path.join(root, 'public', entry.payload || `banks/${id}.qbpack`);
    if (!existsSync(srcPath)) throw new Error(`找不到 ${entry.payload || `banks/${id}.qbpack`}`);
    try {
      questions = await decryptQuestionBankPayload(readFileSync(srcPath, 'utf8'), password);
    } catch (_e) {
      throw new Error('密码不对或文件损坏，无法解密');
    }
  } else {
    const srcPath = path.join(root, 'public', entry.json || `banks/${id}.json`);
    if (!existsSync(srcPath)) throw new Error(`找不到 ${entry.json || `banks/${id}.json`}`);
    questions = JSON.parse(readFileSync(srcPath, 'utf8'));
  }
  if (!Array.isArray(questions)) throw new Error('题目数据格式不对');
  return { entry, questions };
}

export async function publishBankToRepo({ root, questions, id, title, description, tags, mode = 'public', password = '', allowRegistered = false }) {
  if (!root) throw new Error('缺少项目根目录 root');
  if (!Array.isArray(questions) || !questions.length) throw new Error('questions 必须是非空题目数组');
  const hasRegistered = questions.some(hasRegisteredPublicationDeclaration);
  let questionsForPublish = questions;
  if (hasRegistered) {
    if (allowRegistered !== true) throw registeredPublicationError('REGISTERED_PUBLISH_DISABLED', 'registered publication is disabled');
    let detached;
    try { canonicalContentBytes(questions); detached = structuredClone(questions); }
    catch (cause) { throw registeredPublicationError('REGISTERED_INVALID_INPUT', 'registered publication input is not a bounded JSON snapshot', cause); }
    const registeredIndexes = detached.map((record, index) => hasRegisteredPublicationDeclaration(record) ? index : -1).filter((index) => index >= 0);
    let finalized;
    try { finalized = await finalizeRegisteredQuestions(registeredIndexes.map((index) => detached[index])); }
    catch (cause) { throw cause?.code ? cause : registeredPublicationError('REGISTERED_INVALID_INPUT', 'registered publication finalization failed', cause); }
    const finalizedByIndex = new Map(registeredIndexes.map((index, position) => [index, finalized[position]]));
    for (const index of registeredIndexes) {
      const before = detached[index]; const after = finalizedByIndex.get(index);
      let sameOptions = false;
      try { sameOptions = sameCanonical(before.optionIds, after.optionIds); } catch (cause) { throw registeredPublicationError('REGISTERED_DERIVED_STALE', `registered optionIds are invalid at index ${index}`, cause); }
      if (!Object.hasOwn(before, 'questionRevision') || !Object.hasOwn(before, 'optionIds')
        || before.questionRevision !== after.questionRevision || !sameOptions) {
        throw registeredPublicationError('REGISTERED_DERIVED_STALE', `registered derived fields are missing or stale at index ${index}`);
      }
    }
    questionsForPublish = detached.map((record, index) => finalizedByIndex.get(index) || record);
  }
  const { valid, rejected } = validateQuestionBankRecords(questionsForPublish);
  if (hasRegistered) {
    const rejectedRegistered = rejected.filter((entry) => hasRegisteredPublicationDeclaration(entry.record));
    if (rejectedRegistered.length) throw registeredPublicationError('REGISTERED_VALIDATION_REJECTED', 'registered records were rejected by the publication validator', rejectedRegistered);
  }
  if (!valid.length) throw new Error('没有可发布的有效题目（全部被校验剔除）');

  const slug = slugifyBankId(String(id || '').trim());
  if (!slug) throw new Error('缺少题库 id');
  const isProtected = mode === 'protected';
  if (isProtected && !String(password || '')) throw new Error('密码保护模式需要设置密码');

  const manifest = readBankManifest(root);
  const existing = manifest.find((e) => e && e.id === slug) || null;
  const bankRel = `banks/${slug}.${isProtected ? 'qbpack' : 'json'}`;
  const entry = {
    id: slug,
    title: String(title || '').trim() || (existing ? existing.title : slug),
    mode: isProtected ? 'protected' : 'public',
    description: String(description != null ? description : (existing ? existing.description : '') || ''),
    tags: Array.isArray(tags) ? tags : (existing && Array.isArray(existing.tags) ? existing.tags : []),
    question_count: valid.length,
    has_images: valid.some((q) => !!q.image),
    ...(isProtected ? { payload: bankRel } : { json: bankRel }),
  };
  // 同 id 覆盖发布：只换题目内容，保留旧条目的下架(deploy:false)与旧库(archived)标记——
  // 否则整对象替换会把这两个字段丢掉，悄悄把已下架的库重新上线、或把 Old 分组里的库拽回主列表。
  if (existing && existing.deploy === false) entry.deploy = false;
  if (existing && existing.archived === true) entry.archived = true;
  const nextManifest = existing
    ? manifest.map((e) => (e && e.id === slug ? entry : e))
    : [...manifest, entry];

  const fileBody = isProtected
    ? await encryptQuestionBankPayload(valid, password) // qbpack-v1：AES-GCM-256 + PBKDF2 + gzip
    : JSON.stringify(valid, null, 2);
  writeFileSync(path.join(root, 'public', bankRel), fileBody);

  // 覆盖更新且模式切换时，清掉旧格式的孤儿文件（如 public→protected 留下的 .json）
  let removedOld = '';
  const oldRel = existing ? (existing.json || existing.payload || '') : '';
  if (oldRel && oldRel !== bankRel) {
    const oldPath = path.join(root, 'public', oldRel);
    if (existsSync(oldPath)) {
      unlinkSync(oldPath);
      removedOld = oldRel;
    }
  }
  writeFileSync(path.join(root, 'public/banks/index.json'), JSON.stringify(nextManifest, null, 2) + '\n');

  return {
    id: slug,
    entry,
    bankRel,
    count: valid.length,
    rejectedCount: rejected.length,
    rejected,
    replaced: !!existing,
    removedOld,
  };
}

function writeManifest(root, manifest) {
  writeFileSync(path.join(root, 'public/banks/index.json'), JSON.stringify(manifest, null, 2) + '\n');
}

// 下架（deploy:false，可恢复）/ 恢复上架 / 删除（登记移除；数据文件**移入回收目录**而非抹掉）
// 教训（2026-06-11）：用户在界面里逐个试按钮，把全部题库真删了——幸有 git/镜像才找回。
// 此后删除一律进 .bank-trash/<时间戳>-<文件名>，随时可手动拖回 public/banks/ 恢复。
export function removeBankFromRepo({ root, id, mode = 'unlist' }) {
  const manifest = readBankManifest(root);
  const entry = manifest.find((e) => e && e.id === id);
  if (!entry) throw new Error(`找不到题库 "${id}"`);
  if (mode === 'delete') {
    const rel = entry.json || entry.payload || '';
    let trashedTo = '';
    if (rel) {
      const filePath = path.join(root, 'public', rel);
      if (existsSync(filePath)) {
        const trashDir = path.join(root, '.bank-trash');
        mkdirSync(trashDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        trashedTo = `.bank-trash/${stamp}-${path.basename(rel)}`;
        renameSync(filePath, path.join(root, trashedTo));
      }
    }
    writeManifest(root, manifest.filter((e) => !(e && e.id === id)));
    return { id, action: 'delete', trashedTo };
  }
  const restore = mode === 'restore';
  writeManifest(root, manifest.map((e) => {
    if (!e || e.id !== id) return e;
    if (restore) {
      const next = { ...e };
      delete next.deploy; // 默认即上架
      return next;
    }
    return { ...e, deploy: false };
  }));
  return { id, action: restore ? 'restore' : 'unlist' };
}

// 移入 / 移出「Old Question Banks」旧库分组（archive → 写 archived:true；unarchive → 删键）。
// 与 removeBankFromRepo 里 unlist(deploy:false)/restore(删键)完全同构；archived 与 deploy 互不影响：
// 旧库照常部署（有自己的播放器页），只是目录页里被收进折叠的「Old Question Banks」组。
export function archiveBankInRepo({ root, id, mode = 'archive' }) {
  const manifest = readBankManifest(root);
  const entry = manifest.find((e) => e && e.id === id);
  if (!entry) throw new Error(`找不到题库 "${id}"`);
  const unarchive = mode === 'unarchive';
  writeManifest(root, manifest.map((e) => {
    if (!e || e.id !== id) return e;
    if (unarchive) {
      const next = { ...e };
      delete next.archived; // 移出旧库分组
      return next;
    }
    return { ...e, archived: true };
  }));
  return { id, action: unarchive ? 'unarchive' : 'archive' };
}

// 目录页展示顺序 = 清单顺序：上移/下移一格（delta = -1 | +1）
export function moveBankInRepo({ root, id, delta }) {
  const manifest = readBankManifest(root);
  const index = manifest.findIndex((e) => e && e.id === id);
  if (index < 0) throw new Error(`找不到题库 "${id}"`);
  const target = index + (delta < 0 ? -1 : 1);
  if (target < 0 || target >= manifest.length) {
    return { id, moved: false, index }; // 已在边界，原样返回
  }
  const next = manifest.slice();
  [next[index], next[target]] = [next[target], next[index]];
  writeManifest(root, next);
  return { id, moved: true, index: target };
}

// 公开(.json) ⇄ 密码保护(.qbpack) 原地转换：
//   → 加密：需 newPassword；→ 公开：需现有 password 解密
export async function convertBankInRepo({ root, id, password = '', newPassword = '' }) {
  const manifest = readBankManifest(root);
  const entry = manifest.find((e) => e && e.id === id);
  if (!entry) throw new Error(`找不到题库 "${id}"`);
  const toProtected = entry.mode !== 'protected';

  let questions;
  if (toProtected) {
    if (!String(newPassword || '')) throw new Error('转加密需要设置新密码');
    const srcPath = path.join(root, 'public', entry.json || `banks/${id}.json`);
    if (!existsSync(srcPath)) throw new Error(`找不到 ${entry.json || `banks/${id}.json`}`);
    questions = JSON.parse(readFileSync(srcPath, 'utf8'));
  } else {
    const srcPath = path.join(root, 'public', entry.payload || `banks/${id}.qbpack`);
    if (!existsSync(srcPath)) throw new Error(`找不到 ${entry.payload || `banks/${id}.qbpack`}`);
    try {
      questions = await decryptQuestionBankPayload(readFileSync(srcPath, 'utf8'), password);
    } catch (_e) {
      throw new Error('密码不对或文件损坏，无法解密');
    }
  }
  if (!Array.isArray(questions) || !questions.length) throw new Error('题目数据为空');
  if (questions.some(hasRegisteredPublicationDeclaration)) {
    throw registeredPublicationError('REGISTERED_PUBLISH_DISABLED', 'registered format conversion is disabled');
  }

  const newRel = toProtected ? `banks/${id}.qbpack` : `banks/${id}.json`;
  const oldRel = toProtected ? (entry.json || '') : (entry.payload || '');
  const newEntry = { ...entry, mode: toProtected ? 'protected' : 'public', question_count: questions.length };
  delete newEntry.json;
  delete newEntry.payload;
  delete newEntry.password_hint;
  if (toProtected) newEntry.payload = newRel; else newEntry.json = newRel;

  const body = toProtected
    ? await encryptQuestionBankPayload(questions, newPassword)
    : JSON.stringify(questions, null, 2);
  writeFileSync(path.join(root, 'public', newRel), body);
  if (oldRel && oldRel !== newRel) {
    const oldPath = path.join(root, 'public', oldRel);
    if (existsSync(oldPath)) unlinkSync(oldPath);
  }
  writeManifest(root, manifest.map((e) => (e && e.id === id ? newEntry : e)));
  return { id, toProtected, count: questions.length, entry: newEntry };
}

export const DEPLOY_SCRIPTS = { all: 'deploy:cf', cf: 'deploy:cloudflare', gh: 'deploy:github', preview: 'deploy:preview' };

export const SITE_URLS = {
  cf: 'https://question-bank-78u.pages.dev',
  gh: 'https://shicheng0810.github.io/question-bank',
};

// capture=true 时收集输出返回（供浏览器端展示）；否则直通终端（CLI 实时进度）
export function runDeploy(root, target, { capture = false, allowEmpty = false } = {}) {
  const script = DEPLOY_SCRIPTS[target];
  if (!script) return { deployed: false, target: 'none' };
  // allowEmpty：有意把站点清空（全部解除部署）时放行 build-pages 的防误清空保护
  const env = allowEmpty ? { ...process.env, ALLOW_EMPTY_SITE: '1' } : process.env;
  if (capture) {
    const output = execSync(`npm run ${script}`, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env });
    return { deployed: true, target, script, output };
  }
  execSync(`npm run ${script}`, { cwd: root, stdio: 'inherit', env });
  return { deployed: true, target, script };
}
