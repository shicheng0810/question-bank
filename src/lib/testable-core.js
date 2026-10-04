export {
  isCanvasCorrectQuestionBlockClass,
  shouldUseSelectedAnswersAsCorrectFallback,
} from './canvas-answer-fallback.js';
import { isOptionId, isQuestionKey, isUuid } from '../domain/question/index.js';
import { canonicalContentBytes } from '../domain/app-data/canonical.js';

const REGISTERED_CARRIER = new WeakMap();
const ABSENT = Symbol('registered-absent');

function registeredError(message = 'invalid registered identity') {
  const error = new Error(message);
  error.code = 'INVALID_REGISTERED_IDENTITY';
  return error;
}

function unsupportedRegisteredTypeError() {
  const error = new Error('unsupported registered type');
  error.code = 'UNSUPPORTED_REGISTERED_TYPE';
  return error;
}

function registeredConflictError() {
  const error = new Error('registered record conflict');
  error.code = 'REGISTERED_RECORD_CONFLICT';
  return error;
}

function hasRegisteredIdentityDescriptor(value) {
  if (value === null || typeof value !== 'object') return false;
  return ['bankUid', 'questionUid', 'questionKey'].some((key) => Object.getOwnPropertyDescriptor(value, key) !== undefined);
}

function cloneRegisteredValue(value) {
  try {
    canonicalContentBytes(value);
    return structuredClone(value);
  } catch (_error) {
    throw registeredError();
  }
}

function sameRegisteredValue(left, right) {
  if (left === ABSENT || right === ABSENT) return left === right;
  const leftBytes = canonicalContentBytes(left);
  const rightBytes = canonicalContentBytes(right);
  return leftBytes.length === rightBytes.length && leftBytes.every((value, index) => value === rightBytes[index]);
}

function registeredKind(record) {
  if (record.type === 'matching' || record.type === 'essay') throw unsupportedRegisteredTypeError();
  if (record.type !== undefined && record.type !== 'choice' && record.type !== 'fill') throw unsupportedRegisteredTypeError();
  return record.type === 'fill' ? 'fill' : 'choice';
}

function assertRegisteredRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || !Object.hasOwn(record, 'bankUid') || !Object.hasOwn(record, 'questionUid') || !Object.hasOwn(record, 'questionKey')
    || !isUuid(record.bankUid) || !isUuid(record.questionUid) || !isQuestionKey(record.questionKey)
    || record.questionKey !== `${record.bankUid}/${record.questionUid}`) {
    throw registeredError();
  }
  return registeredKind(record);
}

function assertStringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function assertStringMatrix(value) {
  return Array.isArray(value) && value.every((row) => assertStringArray(row));
}

function ownDataValue(value, key, fallback = ABSENT) {
  const descriptor = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key) : undefined;
  if (!descriptor) return fallback;
  if (!Object.hasOwn(descriptor, 'value')) throw registeredError('invalid registered edit');
  return descriptor.value;
}

function requiredRegisteredParsedValue(parsed, key) {
  const value = ownDataValue(parsed, key);
  if (value === ABSENT) throw registeredError('invalid registered edit');
  return cloneRegisteredValue(value);
}

function optionalRegisteredParsedValue(parsed, key) {
  const value = ownDataValue(parsed, key);
  return value === ABSENT ? ABSENT : cloneRegisteredValue(value);
}

function assertRegisteredOriginalStructure(record, kind) {
  const question = ownDataValue(record, 'question');
  const questionHtml = ownDataValue(record, 'question_html');
  const image = ownDataValue(record, 'image');
  if ((question !== ABSENT && typeof question !== 'string')
    || (questionHtml !== ABSENT && typeof questionHtml !== 'string')
    || (image !== ABSENT && typeof image !== 'string' && !assertStringArray(image))) {
    throw registeredError('invalid registered content');
  }
  if (kind === 'choice') {
    if (!Array.isArray(record.choices) || record.choices.length < 2 || !record.choices.every((choice) => typeof choice === 'string')) {
      throw registeredError('invalid registered content');
    }
    const answer = ownDataValue(record, 'answer');
    const answers = ownDataValue(record, 'answers');
    if ((answer !== ABSENT && !Number.isInteger(answer))
      || (answers !== ABSENT && (!Array.isArray(answers) || !answers.every((index) => Number.isInteger(index) && index >= 0 && index < record.choices.length)))) {
      throw registeredError('invalid registered content');
    }
    return;
  }
  if (!assertStringMatrix(record.blanks)) throw registeredError('invalid registered content');
  const answerSets = ownDataValue(record, 'answer_sets');
  if (answerSets !== ABSENT && !assertStringMatrix(answerSets)) throw registeredError('invalid registered content');
}

function registeredParsedState(parsed, kind) {
  const parsedKind = requiredRegisteredParsedValue(parsed, 'kind');
  const qtext = requiredRegisteredParsedValue(parsed, 'qtext');
  const qhtml = requiredRegisteredParsedValue(parsed, 'qhtml');
  const images = requiredRegisteredParsedValue(parsed, 'images');
  const uploadedImages = requiredRegisteredParsedValue(parsed, 'uploadedImages');
  if (parsedKind !== kind || typeof qtext !== 'string' || typeof qhtml !== 'string'
    || !assertStringArray(images) || !assertStringArray(uploadedImages)) throw registeredError('invalid registered edit');
  if (kind === 'choice') {
    const choices = requiredRegisteredParsedValue(parsed, 'choices');
    if (!Array.isArray(choices) || choices.length < 2
      || choices.some((choice) => !choice || typeof choice !== 'object' || typeof choice.text !== 'string' || typeof choice.isCorrect !== 'boolean')) {
      throw registeredError('invalid registered edit');
    }
    return { qtext, qhtml, choices, blanks: ABSENT, answerSets: ABSENT, images: cloneRegisteredValue([...images, ...uploadedImages]) };
  }
  const blanks = requiredRegisteredParsedValue(parsed, 'blanks');
  const answerSets = optionalRegisteredParsedValue(parsed, 'answer_sets');
  if (!assertStringMatrix(blanks)) throw registeredError('invalid registered edit');
  if (answerSets !== ABSENT && !assertStringMatrix(answerSets)) throw registeredError('invalid registered edit');
  return { qtext, qhtml, choices: ABSENT, blanks, answerSets, images: cloneRegisteredValue([...images, ...uploadedImages]) };
}

function buildRegisteredQuestionRecord(parsed, carrier) {
  const current = registeredParsedState(parsed, carrier.kind);
  const record = cloneRegisteredValue(carrier.original);
  if (current.qtext !== carrier.initial.qtext) record.question = current.qtext;
  if (current.qhtml !== carrier.initial.qhtml) {
    if (current.qhtml === '') delete record.question_html;
    else record.question_html = current.qhtml;
  }
  if (!sameRegisteredValue(current.images, carrier.initial.images)) {
    if (!current.images.length) delete record.image;
    else record.image = current.images.length === 1 ? current.images[0] : current.images;
  }
  if (carrier.kind === 'choice') {
    if (!sameRegisteredValue(current.choices, carrier.initial.choices)) {
      record.choices = current.choices.map((choice) => choice.text);
      const correct = current.choices.reduce((indexes, choice, index) => choice.isCorrect ? indexes.concat(index) : indexes, []);
      delete record.answer;
      delete record.answers;
      if (correct.length === 1) record.answer = correct[0];
      else if (correct.length > 1) record.answers = correct;
      else record.answer = -1;
    }
  } else {
    if (!sameRegisteredValue(current.blanks, carrier.initial.blanks)) record.blanks = current.blanks;
    if (!sameRegisteredValue(current.answerSets, carrier.initial.answerSets)) {
      if (current.answerSets === ABSENT) delete record.answer_sets;
      else record.answer_sets = current.answerSets;
    }
  }
  delete record.questionRevision;
  delete record.optionIds;
  return record;
}

function finalizedRegisteredRecord(value) {
  const record = cloneRegisteredValue(value);
  const kind = assertRegisteredRecord(record);
  assertRegisteredOriginalStructure(record, kind);
  if (typeof record.questionRevision !== 'string' || !/^[0-9a-f]{64}$/.test(record.questionRevision)
    || !Array.isArray(record.optionIds) || record.optionIds.some((optionId) => !isOptionId(optionId))
    || (kind === 'choice' && record.optionIds.length !== record.choices.length)
    || (kind === 'fill' && record.optionIds.length !== 0)) {
    throw registeredError('registered record is not finalized');
  }
  return record;
}

// Derived from the extractor core for automated tests.


export function tryParseJSONArray(s){
  const t = (s || '').trim();
  if (!t) return null;
  try{
    const obj = JSON.parse(t);
    if (Array.isArray(obj)) return obj;
    if (obj && typeof obj === 'object') return [obj];
    return null;
  }catch{
    return null;
  }
}

export function extractBracketedJSONArray(source, startIndex){
  const start = String(source || '').indexOf('[', Math.max(0, startIndex || 0));
  if (start < 0) return '';
  let depth = 0;
  let inStr = false;
  let quote = '';
  let esc = false;
  for (let i = start; i < source.length; i++){
    const ch = source[i];
    if (inStr){
      if (esc){ esc = false; continue; }
      if (ch === '\\'){ esc = true; continue; }
      if (ch === quote){ inStr = false; quote = ''; }
      continue;
    }
    if (ch === '"' || ch === "'"){
      inStr = true;
      quote = ch;
      continue;
    }
    if (ch === '[') depth++;
    else if (ch === ']'){
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return '';
}

// Variable names that may hold an embedded question-bank array, in priority order.
// LEGACY_BANK_PAYLOAD is the current single-file export format and must be tried first,
// because those files also declare `let RAW_QUESTION_BANK = []` (an empty placeholder that
// is filled at runtime) — matching that first would wrongly yield an empty bank.
const QUESTION_BANK_TOKENS = [
  'LEGACY_BANK_PAYLOAD',
  'RAW_QUESTION_BANK',
  'QUESTION_BANK',
  'const data =',
  'window.__QUESTION_BANK__',
  'window.QUESTION_BANK',
];

function findQuestionBankArrayByTokens(source){
  const text = String(source || '');
  for (const token of QUESTION_BANK_TOKENS){
    let from = 0;
    let idx;
    while ((idx = text.indexOf(token, from)) >= 0){
      const arrText = extractBracketedJSONArray(text, idx);
      const parsed = tryParseJSONArray(arrText);
      // Skip empty placeholder declarations; keep scanning for a populated array.
      if (parsed && parsed.length) return parsed;
      from = idx + token.length;
    }
  }
  return null;
}

export function extractQuestionBankArrayFromText(raw){
  const text = String(raw || '').trim();
  if (!text) throw new Error('文件为空');

  const direct = tryParseJSONArray(text);
  if (direct && direct.length) return direct;

  const fromText = findQuestionBankArrayByTokens(text);
  if (fromText) return fromText;

  const scripts = Array.from(new DOMParser().parseFromString(text, 'text/html').querySelectorAll('script'));
  for (const script of scripts){
    const fromScript = findQuestionBankArrayByTokens(script.textContent || '');
    if (fromScript) return fromScript;
  }

  // A directly-parsed but empty array is still a valid (empty) bank.
  if (direct) return direct;

  throw new Error('未能从该文件中定位题库 JSON 数组');
}

export function makeSafeJSONForScript(jsonStr){
  // 防止生成的题库网页在 <script> 内注入 JSON 时被某些字符截断或导致语法错误：
  // 1) <\/script> 会提前结束 script 标签
  // 2) U+2028 / U+2029 在 JS 字符串里会被当成换行，导致语法错误（JSON.stringify 可能原样输出）
  return (jsonStr || '')
    .replace(/<\/script>/gi, '<\\/script>')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function injectQuestionBankJSON(tpl, jsonStr){
  // Template uses a marker literal: __QUESTION_BANK_JSON__
  const marker = '__QUESTION_BANK_JSON__';
  if (!tpl.includes(marker)){
    throw new Error('无法在题库模板中定位 QUESTION_BANK marker（__QUESTION_BANK_JSON__）。');
  }
  return tpl.replace(marker, jsonStr);
}

export function downloadTextAsFile(text, filename, mime){
  const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'download.html';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 8000);
}

export function safeJSONStringForScript(jsonStr){
  // Make JSON safe to inline into <script> as JS literal (no literal closing-tag sequences here).
  return (jsonStr || '')
    .replace(/<\/script>/gi, '<\\/script>')
    .replace(/<\//g, '<\\/')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function countCorrectChoiceAnswers(q){
  return ((q && q.choices) || []).reduce((n,c)=> n + (c && c.isCorrect ? 1 : 0), 0);
}

export function normalizeChoiceQuestionShape(q){
  if (!q || q.kind !== 'choice') return q;
  if (!q.isMulti) return q;
  if (countCorrectChoiceAnswers(q) === 1) q.isMulti = false;
  return q;
}

export function uniqueNonEmptyStrings(arr){
  return Array.from(new Set((arr || []).map(v => String(v || '').trim()).filter(Boolean)));
}

export function getQuestionImages(q){
  const base = Array.isArray(q && q.images) ? q.images : [];
  const uploaded = Array.isArray(q && q.uploadedImages) ? q.uploadedImages : [];
  return [...base, ...uploaded].filter(Boolean);
}

export function getMatchingChoicePool(q){
  const pool = [];
  (q && q.choicePool || []).forEach(v => pool.push(v));
  (q && q.pairs || []).forEach(p => {
    if (p && p.right) pool.push(p.right);
  });
  return uniqueNonEmptyStrings(pool);
}

export function buildMatchingSubQuestionText(q, pair){
  const stem = String((q && q.qtext) || '').trim();
  const left = String((pair && pair.left) || '').trim();
  if (!stem) return left || '(配对题子项)';
  if (!left) return stem;
  // 左列是「图上的标号」（裸数字或单字母，如 Canvas 配对题把图中指引框 1…6 当左列）时，
  // 不能只渲染成 "[4]" —— 那看着像脚注标记，而播放器又把选项标成 A/B/C，学生会不知道
  // 「题目给数字、选项给字母」怎么对应（AMT211 钻头图那道题收到三次同样的反馈）。
  // 带图时改写成一句明确的问句；不带图就保持原样（没有图可指，硬说"见图"是撒谎）。
  const label = left.replace(/[.)]$/, '');
  const isFigureRef = /^[0-9]{1,3}$/.test(label) || /^[A-Za-z]$/.test(label);
  if (isFigureRef && getQuestionImages(q).length){
    return `${stem} — which one is labelled ${label} in the image?`;
  }
  return `${stem} [${left}]`;
}


// 配对题拆成单选子题时的选项池。以前把正确项 unshift 到 0 位 —— 播放器只打乱题序、
// 不打乱选项，于是整套配对子题的答案恒为 A，一路点 A 就全对。
// 这里在**生成时**就地打乱（播放阶段不做任何事，行为仍然是纯静态题库）：
// 用配对内容自身派生的种子做 Fisher-Yates，所以同一份存档反复生成结果完全一致
// （题库可复现、题目 id/历史不会漂移），只是正确项落在哪一位变得不可预测。
// 调用方 buildQuestionBank 用 indexOf(correct) 定答案下标，顺序变了答案自动跟着变。
export function buildMatchingChoicesForPair(pair, pool){
  const correct = String((pair && pair.right) || '').trim();
  const arr = uniqueNonEmptyStrings([correct, ...(pool || [])]);
  if (arr.length < 2) return arr;

  // 种子取「左项 + 右项」：同一道配对题的不同子项种子不同，故正确项不会齐刷刷落在同一位
  const seedStr = `${String((pair && pair.left) || '')}|${correct}`;
  let state = parseInt(hashStringForMerge(seedStr).split('_')[0], 36) >>> 0;
  const nextRand = () => {
    // xorshift32：够散、无依赖、纯函数式可复现（不能用 Math.random，否则每次生成都变）
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;  state >>>= 0;
    return state / 4294967296;
  };
  for (let i = arr.length - 1; i > 0; i--){
    const j = Math.floor(nextRand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* -------------------- 导出 QUESTION_BANK -------------------- */
export function buildQuestionBank(data, prefix, sourcePrefix){
  const arr = [];
  data.forEach(q=>{
    const carrier = q && typeof q === 'object' ? REGISTERED_CARRIER.get(q) : null;
    if (carrier) {
      arr.push(buildRegisteredQuestionRecord(q, carrier));
      return;
    }
    normalizeChoiceQuestionShape(q);
    const computedId = `${prefix}-${q.idSuffix || q.num}`;
    const computedSource = `${sourcePrefix} – Q${q.sourceNum || q.num}`;
    const id = q && q.preserveOriginalMeta && q.importedId ? q.importedId : computedId;
    const src = q && q.preserveOriginalMeta && q.importedSource ? q.importedSource : computedSource;
    const qImages = getQuestionImages(q);
    const imgField = qImages.length
      ? (qImages.length===1 ? { image:qImages[0] } : { image:qImages })
      : {};

    const kind = q.kind || 'choice';

    // 透传字段（tags/section/explanation/缺图标记）：所有题型统一带上
    const extraFields = {
      ...(Array.isArray(q.tags) && q.tags.length ? { tags: q.tags } : {}),
      ...(q.section ? { section: q.section } : {}),
      ...(q.explanation ? { explanation: q.explanation } : {}),
      ...(Number(q.missingImageCount) > 0 ? { missing_images: Number(q.missingImageCount) } : {}),
    };

    if (kind === 'fill'){
      const blanks = (q.blanks && q.blanks.length) ? q.blanks : [[]];
      const obj = { id, question:q.qtext, blanks, source:src, type:'fill', ...imgField, ...extraFields };
      if (Array.isArray(q.answer_sets) && q.answer_sets.length) obj.answer_sets = q.answer_sets;
      if (q.qhtml) obj.question_html = q.qhtml; // 题干里带输入框的位置（后续 question_bank 用）
      arr.push(obj);
      return;
    }

    if (kind === 'essay'){
      // 忽略问答/主观题：不导出到题库
      return;
    }

    if (kind === 'matching'){
      const pairs = q.pairs || [];
      const pool = getMatchingChoicePool(q);
      pairs.forEach((pair, idx) => {
        const subId = `${id}_m${idx+1}`;
        const subSrc = `${sourcePrefix} – Q${q.num}.${idx+1}`;
        const choices = buildMatchingChoicesForPair(pair, pool);
        const correctText = String((pair && pair.right) || '').trim();
        const answer = choices.findIndex(c => c === correctText);
        arr.push({
          id: subId,
          question: buildMatchingSubQuestionText(q, pair),
          choices,
          answer,
          source: subSrc,
          ...imgField,
          ...extraFields,
        });
      });
      return;
    }

    // 默认：选择题。未识别题型（multiple_dropdowns/calculated 等落进 kind:'unknown' 的）
    // 或解析不出任何选项的记录，不再导出 {choices:[],answer:-1} 这类坏数据——
    // 它们在提取器预览里以“未知题型/待人工确认”可见，导出端由 validateQuestionBankRecords 兜底。
    if (kind !== 'choice' || !(q.choices || []).length) return;

    const choices = (q.choices || []).map(c=>c.text);
    // 答案信号溯源：非 explicit（score 推断 / Canvas correct 块回退 / 满分冲突）写入
    // answer_source，发布后可追溯哪些题的答案不是页面明确标注的。
    const answerSource = String(q.answerSource || '').trim();
    const sourceField = answerSource && answerSource !== 'explicit' ? { answer_source: answerSource } : {};

    if (q.isMulti){
      const answers = (q.choices || []).reduce((acc,c,i)=> c.isCorrect ? acc.concat(i) : acc, []);
      if (answers.length === 1){
        arr.push({ id, question:q.qtext, choices, answer:answers[0], source:src, ...imgField, ...sourceField, ...extraFields });
      }else{
        arr.push({ id, question:q.qtext, choices, answers, source:src, ...imgField, ...sourceField, ...extraFields });
      }
    }else{
      const answer = (q.choices || []).findIndex(c=>c.isCorrect);
      arr.push({ id, question:q.qtext, choices, answer, source:src, ...imgField, ...sourceField, ...extraFields });
    }
  });
  return arr;
}

// 导出前的 schema 校验闸：把不完整/不可作答的记录从发布物里剔出来并说明原因，
// 替代以前“静默导出坏记录”的行为。valid 原样保序返回；rejected 带 reasons 供 UI 汇报。
export function validateQuestionBankRecords(records){
  const valid = [];
  const rejected = [];
  (Array.isArray(records) ? records : []).forEach(rec => {
    const reasons = [];
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)){
      rejected.push({ record: rec, reasons: ['不是合法的题目对象'] });
      return;
    }
    const id = String(rec.id == null ? '' : rec.id).trim();
    if (!id) reasons.push('缺少 id');

    const hasImage = !!(rec.image && (typeof rec.image === 'string' ? rec.image : (Array.isArray(rec.image) && rec.image.length)));
    const questionText = String(rec.question == null ? '' : rec.question).trim();
    if (!questionText && !hasImage) reasons.push('题干为空且无图片');

    const isFill = rec.type === 'fill' || Array.isArray(rec.blanks);
    if (isFill){
      const blanks = Array.isArray(rec.blanks) ? rec.blanks : [];
      const hasAnswer = blanks.some(arr => Array.isArray(arr) && arr.some(v => String(v == null ? '' : v).trim()));
      if (!hasAnswer) reasons.push('填空题没有任何可接受答案');
    } else if (Array.isArray(rec.choices)){
      const n = rec.choices.length;
      if (n < 2) reasons.push(`选项不足（${n} 个）`);
      if (Array.isArray(rec.answers)){
        const ok = rec.answers.length >= 1 && rec.answers.every(a => Number.isInteger(a) && a >= 0 && a < n);
        if (!ok) reasons.push('多选答案索引非法或为空');
      } else {
        const a = rec.answer;
        if (!(Number.isInteger(a) && a >= 0 && a < n)) reasons.push('缺少正确答案（answer 越界或为 -1）');
      }
    } else {
      reasons.push('未知题型结构（既无 choices 也无 blanks）');
    }

    if (reasons.length) rejected.push({ record: rec, reasons });
    else valid.push(rec);
  });
  return { valid, rejected };
}

export function flattenSourceList(src){
  if (Array.isArray(src)) return src.flatMap(flattenSourceList);
  const s = String(src || '').trim();
  return s ? [s] : [];
}

export function normalizeTextForMerge(v){
  // Case-insensitive: matches the runtime players (site-logic normalizeForKey + the legacy
  // template normText both lowercase), so export-time dedup and load-time dedup agree.
  return cleanHTMLString(String(v || '')).replace(/\s+/g, ' ').trim().toLowerCase();
}

export function hashStringForMerge(str){
  const s = String(str || '');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++){
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36) + '_' + s.length;
}

export function normalizeImageFingerprints(image){
  const arr = Array.isArray(image) ? image : (image ? [image] : []);
  return arr
    .map(v => String(v || '').trim())
    .filter(Boolean)
    .map(v => hashStringForMerge(v))
    .sort();
}

export function getAnswerSignature(item){
  if (Array.isArray(item && item.answers)){
    return item.answers
      .map(v => Number(v))
      .filter(v => Number.isInteger(v) && v >= 0)
      .sort((a,b)=>a-b);
  }
  if (Number.isInteger(item && item.answer) && item.answer >= 0) return [Number(item.answer)];
  return [];
}

export function applyAnswerSignature(item, sig){
  const arr = Array.from(new Set((sig || []).filter(v => Number.isInteger(v) && v >= 0))).sort((a,b)=>a-b);
  delete item.answer;
  delete item.answers;
  if (!arr.length) return item;
  if (arr.length === 1) item.answer = arr[0];
  else item.answers = arr;
  return item;
}

export function mergeAnswerSignature(baseSig, nextSig){
  const a = Array.from(new Set(baseSig || [])).sort((x,y)=>x-y);
  const b = Array.from(new Set(nextSig || [])).sort((x,y)=>x-y);
  if (!a.length) return b;
  if (!b.length) return a;
  const aSet = new Set(a);
  const bSet = new Set(b);
  const aInB = a.every(v => bSet.has(v));
  const bInA = b.every(v => aSet.has(v));
  if (aInB && !bInA) return b;
  if (bInA) return a;
  if (a.length === b.length && a.every((v,i)=>v===b[i])) return a;
  return a;
}

export function makeUniqueQuestionKey(item){
  const type = item && (item.type === 'fill' || Array.isArray(item.blanks))
    ? 'fill'
    : (item && item.type === 'essay')
      ? 'essay'
      : Array.isArray(item && item.answers)
        ? 'multi'
        : 'single';
  const choices = Array.isArray(item && item.choices) ? item.choices.map(normalizeTextForMerge) : [];
  const answerIndexes = getAnswerSignature(item).filter(index => index >= 0 && index < choices.length);
  const answerTexts = answerIndexes.map(index => choices[index]).filter(Boolean).sort();
  const blanks = Array.isArray(item && item.blanks)
    ? item.blanks.map(arr => Array.isArray(arr) ? arr.map(normalizeTextForMerge).filter(Boolean).sort() : [])
    : [];
  const isChoice = type === 'single' || type === 'multi';
  // Smart merge: a question's identity is its stem + correct-answer text, independent of
  // distractor wording. The same question imported from two sources often has reworded /
  // reordered wrong options (OCR or source variation); those should still fuse. We only
  // fall back to the full choice set when the correct answer is unknown, so that distinct
  // unanswered questions sharing a stem are not over-merged.
  const hasAnswer = isChoice && answerTexts.length > 0;
  // 注意：key 不含图片指纹——同一道题一边补到了图、一边没补（或压缩参数不同）也应合并；
  // 图片在 mergeUniqueQuestionRecord 里按“先到优先”补齐。
  return JSON.stringify({
    q: normalizeTextForMerge(item && item.question),
    type,
    choices: isChoice && !hasAnswer ? choices.slice().sort() : [],
    answers: isChoice ? answerTexts : [],
    blanks,
  });
}

export function mergeUniqueQuestionRecord(base, incoming){
  const mergedSources = uniqueNonEmptyStrings([
    ...flattenSourceList(base && base.source),
    ...flattenSourceList(incoming && incoming.source),
  ]);
  base.source = mergedSources;

  if (!base.question_html && incoming && incoming.question_html) base.question_html = incoming.question_html;
  if (!base.image && incoming && incoming.image) base.image = Array.isArray(incoming.image) ? incoming.image.slice() : incoming.image;
  if (!Array.isArray(base.blanks) && Array.isArray(incoming && incoming.blanks)) base.blanks = JSON.parse(JSON.stringify(incoming.blanks));

  const mergedSig = mergeAnswerSignature(getAnswerSignature(base), getAnswerSignature(incoming));
  applyAnswerSignature(base, mergedSig);
  return base;
}


/* -------------------- 题库 JSON ⇄ 提取器内部形态（round-trip 配对） --------------------
   buildQuestionBank 是正向投影（parsed → 题库 JSON），下面这组是反向投影
   （题库 JSON → parsed，供「导入已生成题库」再编辑）。放在一起共测，保证
   导出→导入→导出 不丢字段。 */
export function extractIdPrefix(id){
  const s = String(id || '').trim();
  const m = s.match(/^(.+?)-(.+)$/);
  return m ? m[1].trim() : '';
}

export function extractIdSuffix(id, prefix){
  const s = String(id || '').trim();
  if (!s) return '';
  if (prefix && s.startsWith(prefix + '-')) return s.slice(prefix.length + 1).trim();
  const m = s.match(/^.+?-(.+)$/);
  return m ? m[1].trim() : s;
}

// Source 标签的结构是 "<前缀> – Q<题号>"（题号形如 12 / 16_2 / 32.1，见 buildQuestionBank）。
// 两个坑：
//  ① 分隔符要认「最后一个」—— 前缀本身常含 " – "（"AMT211 – Quiz – … – #1 – Q2"），
//     非贪婪 (.*?) 会切在第一个上；用贪婪 (.*) 让最后一段 Q 号胜出。
//  ② Q 后面必须紧跟数字 —— 否则 "– Quiz –" 里的 Q 会被当成题号标记，
//     "AMT211 – Quiz – Do Not Use References – #1 – Q2" 的前缀被切成 "AMT211"、
//     题号被切成 "uiz – Do Not Use References – #1 – Q2"（导回提取器再导出时污染 Source）。
const SOURCE_Q_SUFFIX = /^(.*)[\s]*[–—-]\s*Q\s*(\d[\w.]*)\s*$/i;

export function extractSourcePrefix(src){
  const s = String(src || '').trim();
  const m = s.match(SOURCE_Q_SUFFIX);
  return m ? m[1].trim() : '';
}

export function extractSourceNum(src){
  const s = String(src || '').trim();
  const m = s.match(SOURCE_Q_SUFFIX);
  return m ? m[2].trim() : '';
}

export function normalizeImportedImageList(item){
  const raw = item && item.image;
  if (Array.isArray(raw)) return raw.map(v => String(v || '').trim()).filter(Boolean);
  if (raw) return [String(raw).trim()].filter(Boolean);
  return [];
}

function convertLegacyQuestionBankItemToParsed(item, idx, meta){
  const images = normalizeImportedImageList(item);
  const prefix = meta && meta.prefix ? meta.prefix : '';
  const idSuffix = extractIdSuffix(item && item.id, prefix) || String(idx + 1);
  const sourceNum = extractSourceNum(item && item.source) || idSuffix;
  const displayNum = sourceNum || idSuffix || String(idx + 1);
  const base = {
    num: displayNum,
    idSuffix,
    sourceNum,
    qtext: String((item && (item.question || item.qtext)) || '').trim(),
    qhtml: String((item && item.question_html) || '').trim(),
    images,
    uploadedImages: [],
    expectedImageCount: images.length,
    missingImageSources: [],
    importedId: String((item && item.id) || '').trim(),
    importedSource: String((item && item.source) || '').trim(),
    preserveOriginalMeta: true,
    // 透传字段：以前 re-import 会静默丢掉这些，导出→导入→导出 不再有损
    ...(Array.isArray(item && item.tags) && item.tags.length ? { tags: item.tags.slice() } : {}),
    ...(item && item.section ? { section: String(item.section) } : {}),
    ...(item && item.explanation ? { explanation: String(item.explanation) } : {}),
    ...(item && item.answer_source ? { answerSource: String(item.answer_source) } : {}),
  };

  if ((item && item.type === 'fill') || Array.isArray(item && item.blanks)){
    const blanks = Array.isArray(item && item.blanks) && item.blanks.length
      ? item.blanks.map(ans => Array.isArray(ans)
          ? ans.map(v => String(v || '').trim()).filter(Boolean)
          : [String(ans || '').trim()].filter(Boolean))
      : [[]];
    const answerSets = Array.isArray(item && item.answer_sets) && item.answer_sets.length
      ? JSON.parse(JSON.stringify(item.answer_sets))
      : null;
    return { kind: 'fill', blanks, ...(answerSets ? { answer_sets: answerSets } : {}), ...base };
  }

  const answers = Array.isArray(item && item.answers)
    ? item.answers.map(v => Number(v)).filter(v => Number.isInteger(v))
    : [];
  const singleAnswer = Number.isInteger(item && item.answer) ? Number(item.answer) : -1;
  const correctSet = new Set(answers.length ? answers : (singleAnswer >= 0 ? [singleAnswer] : []));
  const choiceTexts = Array.isArray(item && item.choices)
    ? item.choices
    : (Array.isArray(item && item.options) ? item.options : []);
  const choices = choiceTexts.map((text, i) => ({
    text: String(text || ''),
    isCorrect: correctSet.has(i)
  }));

  return {
    kind: 'choice',
    isMulti: correctSet.size > 1,
    choices,
    ...base
  };
}

function convertRegisteredQuestionBankItemToParsed(original, idx, meta, kind) {
  assertRegisteredOriginalStructure(original, kind);
  const prefix = meta && meta.prefix ? meta.prefix : '';
  const idSuffix = extractIdSuffix(original.id, prefix) || String(idx + 1);
  const sourceNum = extractSourceNum(original.source) || idSuffix;
  const displayNum = sourceNum || idSuffix || String(idx + 1);
  const initialImages = Object.hasOwn(original, 'image')
    ? (typeof original.image === 'string' ? [original.image] : original.image.slice())
    : [];
  const base = {
    num: displayNum,
    idSuffix,
    sourceNum,
    qtext: Object.hasOwn(original, 'question') ? original.question : '',
    qhtml: Object.hasOwn(original, 'question_html') ? original.question_html : '',
    images: initialImages,
    uploadedImages: [],
    expectedImageCount: initialImages.length,
    missingImageSources: [],
    importedId: typeof original.id === 'string' ? original.id : '',
    importedSource: typeof original.source === 'string' ? original.source : '',
    preserveOriginalMeta: true,
  };
  if (kind === 'fill') {
    return {
      kind,
      blanks: cloneRegisteredValue(original.blanks),
      ...(Object.hasOwn(original, 'answer_sets') ? { answer_sets: cloneRegisteredValue(original.answer_sets) } : {}),
      ...base,
    };
  }
  const answers = Array.isArray(original.answers)
    ? original.answers
    : (Number.isInteger(original.answer) && original.answer >= 0 ? [original.answer] : []);
  const correct = new Set(answers);
  return {
    kind,
    isMulti: correct.size > 1,
    choices: original.choices.map((text, index) => ({ text, isCorrect: correct.has(index) })),
    ...base,
  };
}

export function convertQuestionBankItemToParsed(item, idx, meta){
  if (!hasRegisteredIdentityDescriptor(item)) return convertLegacyQuestionBankItemToParsed(item, idx, meta);
  const original = cloneRegisteredValue(item);
  const kind = assertRegisteredRecord(original);
  const parsed = convertRegisteredQuestionBankItemToParsed(original, idx, meta, kind);
  const initial = registeredParsedState(parsed, kind);
  REGISTERED_CARRIER.set(parsed, { original, kind, initial });
  return parsed;
}

/* -------------------- 自动从文件名抽取前缀 -------------------- */
export function guessMetaFromFilename(name){
  const base = String(name || '').replace(/\.[^.]+$/,'').trim();

  const simpleUnderscoreMatch = base.match(/^(.+?)\s*_\s*([A-Za-z0-9]{1,8})$/);
  if (simpleUnderscoreMatch) {
    const bankPrefix = String(simpleUnderscoreMatch[1] || '').trim();
    const suffixToken = String(simpleUnderscoreMatch[2] || '').trim();
    if (bankPrefix && suffixToken) {
      return {
        prefix: bankPrefix,
        sourcePrefix: `Test_${bankPrefix}_${suffixToken}`
      };
    }
  }

  const left = base.split('_')[0].trim();
  const normalizedLeft = left
    .replace(/[–—]/g, '-')
    .replace(/[_]+/g, ' ')
    .replace(/\s*-\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const courseMatch = base.match(/AMT[&]?\s*(\d{3})/i);
  const courseDigits = courseMatch ? courseMatch[1] : '';
  const courseCode = courseDigits ? `AMT${courseDigits}` : '';

  const word2num = {
    one:1,two:2,three:3,four:4,five:5,
    six:6,seven:7,eight:8,nine:9,ten:10,
    eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,
    sixteen:16,seventeen:17,eighteen:18,nineteen:19,twenty:20
  };
  const numWordsPattern = Object.keys(word2num).join('|');

  const slugify = s => String(s || '')
    .toLowerCase()
    .replace(/&/g,'and')
    .replace(/[^a-z0-9]+/g,'_')
    .replace(/^_+|_+$/g,'')
    .replace(/_+/g,'_');

  const toNum = token => {
    const t = String(token || '').trim().toLowerCase();
    if (!t) return '';
    if (/^\d+$/.test(t)) return String(parseInt(t, 10));
    return word2num[t] ? String(word2num[t]) : '';
  };

  const pickNumber = s => {
    if (!s) return '';
    const m = s.match(new RegExp(`\\b(?:#\\s*)?(\\d+|${numWordsPattern})\\b`, 'i'));
    return m ? toNum(m[1]) : '';
  };

  const pickDay = s => {
    if (!s) return '';
    const m = s.match(new RegExp(`\\b(?:d|day)\\s*[-#]?\\s*(\\d+|${numWordsPattern})\\b`, 'i'));
    const n = m ? toNum(m[1]) : '';
    return n ? `d${n}` : '';
  };

  let typePrefix = 'quiz';
  let typeLabel = 'Quiz';
  let typePattern = /\bquiz\b/i;
  if (/\bhomework\b/i.test(normalizedLeft)) {
    typePrefix = 'hw';
    typeLabel = 'Homework';
    typePattern = /\bhomework\b/i;
  } else if (/\blab\s+quiz\b/i.test(normalizedLeft)) {
    typePrefix = 'labq';
    typeLabel = 'Lab Quiz';
    typePattern = /\blab\s+quiz\b/i;
  } else if (/\blecture\b.*\bquiz\b|\bquiz\b.*\blecture\b/i.test(normalizedLeft)) {
    typePrefix = 'lecq';
    typeLabel = 'Lecture Quiz';
    typePattern = /\blecture\b.*\bquiz\b|\bquiz\b.*\blecture\b/i;
  } else if (/\bpractice\b.*\bquiz\b|\bquiz\b.*\bpractice\b/i.test(normalizedLeft)) {
    typePrefix = 'pquiz';
    typeLabel = 'Practice Quiz';
    typePattern = /\bpractice\b.*\bquiz\b|\bquiz\b.*\bpractice\b/i;
  } else if (/\bassignment\b/i.test(normalizedLeft)) {
    typePrefix = 'ass';
    typeLabel = 'Assignment';
    typePattern = /\bassignment\b/i;
  } else if (/\btest\b/i.test(normalizedLeft)) {
    typePrefix = 'test';
    typeLabel = 'Test';
    typePattern = /\btest\b/i;
  } else if (/\bexam\b/i.test(normalizedLeft)) {
    typePrefix = 'exam';
    typeLabel = 'Exam';
    typePattern = /\bexam\b/i;
  } else if (/\bquiz\b/i.test(normalizedLeft)) {
    typePrefix = 'quiz';
    typeLabel = 'Quiz';
    typePattern = /\bquiz\b/i;
  }

  const dayToken = pickDay(normalizedLeft);
  const noDay = normalizedLeft.replace(new RegExp(`\\b(?:d|day)\\s*[-#]?\\s*(\\d+|${numWordsPattern})\\b`, 'ig'), ' ');
  const numberToken = pickNumber(noDay);

  let sequenceToken = '';
  if (dayToken) sequenceToken = String(dayToken).replace(/^d/i, '');
  else if (numberToken) sequenceToken = numberToken;

  const prefixParts = [typePrefix];
  if (sequenceToken) prefixParts.push(sequenceToken);
  if (courseDigits) prefixParts.push(courseDigits);

  let prefix = prefixParts.filter(Boolean).join('_');
  if (!prefix) prefix = courseDigits ? `bank_${courseDigits}` : 'question_bank';

  let descriptor = normalizedLeft;
  descriptor = descriptor.replace(typePattern, ' ');
  descriptor = descriptor.replace(new RegExp(`\\b(?:d|day)\\s*[-#]?\\s*(\\d+|${numWordsPattern})\\b`, 'ig'), ' ');
  descriptor = descriptor.replace(new RegExp(`\\b(?:#\\s*)?(\\d+|${numWordsPattern})\\b`, 'ig'), ' ');
  descriptor = descriptor.replace(/^[\s\-_:]+|[\s\-_:]+$/g, '');
  descriptor = descriptor.replace(/\s+/g, ' ').trim();

  const sourceBits = [typeLabel];
  if (descriptor) sourceBits.push(descriptor);
  if (sequenceToken) sourceBits.push(`#${sequenceToken}`);
  const sourceLabel = sourceBits.join(' – ').replace(/\s+/g, ' ').trim() || normalizedLeft || 'Question Bank';
  const sourcePrefix = courseCode ? `${courseCode} – ${sourceLabel}` : sourceLabel;

  return { prefix, sourcePrefix };
}

// 从 Canvas 页面标题（MHTML Subject 头）派生 prefix/Source —— 比文件名可靠：标题恒含课程码，
// 文件名可能被改成别的（如学生名）。Canvas 标题结构固定：<作业名>: <课程码> <section> - <学期> - <课程全名>。
// 以课程码为界切出"作业名"（自然丢掉 section/学期/课程全名，否则它们会污染 Source），把
// "作业名 + 课程码"重组成干净串喂给现有 guessMetaFromFilename（类型/序号/课程码全复用它）。
// 标题为空或既无作业名也无课程码 → 返回 null（调用方回退到文件名启发式）。
// 从作业名取"描述词 slug"（去通用词/序号，留最多 2 个有意义词）——给无序号的 section test 去歧义。
// 例：「Fabric Section Test」→ "fabric"；「Test - Comm/Nav」→ "comm-nav"；「Aircraft Fuel Systems」→ "aircraft-fuel"。
function descriptorSlug(name){
  const GENERIC = /^(section|test|tests|quiz|quizzes|exam|exams|midterm|final|finals|assignment|assignments|homework|hw|lab|labs|lecture|lectures|practice|reading|readings|day|part|review|the|of|and|or|a|an|for|to|in|on)$/;
  const words = String(name || '')
    .toLowerCase()
    .replace(/&[a-z]+;/g, ' ')      // 去 HTML 实体
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !GENERIC.test(w) && !/^\d+$/.test(w));
  return words.slice(0, 2).join('-');
}

// New Quizzes 成绩页的页面标题（MHTML Subject）恒为通用文案 "Quizzes - Results"，派生不出
// 作业名 —— 这类标题下文件名才是唯一有意义的标签，调用方应改喂文件名。
// （经典测验的标题是 "<作业名>: <课程码> <班号> - <学期> - <课程全名>"，信息量足够。）
export function isGenericQuizResultsTitle(title){
  // 注意 quiz(?:zes)? 而不是 quizzes? —— 后者是 "quizze" + 可选 "s"，匹配不到单数 "Quiz"
  return /^\s*quiz(?:zes)?\s*[-–—:]\s*results\s*$/i.test(String(title || ''));
}

export function guessMetaFromTitle(title, fallbackCourse){
  const t = String(title == null ? '' : title).replace(/\s+/g, ' ').trim();
  const fc = String(fallbackCourse == null ? '' : fallbackCourse).trim();
  if (!t && !fc) return null;
  const courseRe = /\b([A-Za-z]{2,6})\s*&?\s*(\d{2,4})\b/; // AMT&205 / AMT 205 / BIOL101
  let courseM = t.match(courseRe);
  let courseDigits = courseM ? courseM[2] : '';
  let courseCode = courseM ? `${courseM[1].toUpperCase()}${courseM[2]}` : ''; // AMT205
  // 标题里没课程码 → 用页面面包屑里抓到的课程（学生姓名视图的标题 "<作业>: 学生名" 就靠这个补课程码）。
  if (!courseCode && fc){
    const m2 = fc.match(courseRe);
    if (m2){ courseDigits = m2[2]; courseCode = `${m2[1].toUpperCase()}${m2[2]}`; }
  }
  // 作业名 = 标题里课程码之前的部分（自然丢掉 section/学期/课程全名）；标题无课程码时取冒号左侧或整串。
  let name = courseM
    ? t.slice(0, courseM.index)
    : (t.indexOf(':') >= 0 ? t.slice(0, t.indexOf(':')) : t);
  name = name.replace(/[\s:_–-]+$/, '').trim();
  if (!name && !courseCode) return null;
  // 只把"作业名"喂给现有启发式（不含课程码）→ 干净的 type/序号/描述，不会把课程数字误当序号、
  // 也不残留 "AMT&"。再把课程码注入 prefix 末尾 + sourcePrefix 开头。
  const base = guessMetaFromFilename(name || courseCode || 'bank');
  let prefix = base.prefix;
  let sourcePrefix = base.sourcePrefix;
  const hasSeqNum = /\d/.test(prefix); // base.prefix 自带序号（ass_8 / lecq_5）就够区分，无需描述词
  if (courseDigits && !prefix.split('_').includes(courseDigits)) prefix = `${prefix}_${courseDigits}`;
  if (courseCode && !sourcePrefix.startsWith(courseCode)) sourcePrefix = `${courseCode} – ${sourcePrefix}`;
  // 无序号（section test 等）：同课程下多个会撞同一个 test_205 —— 追加描述词去歧义 → test_205_fabric。
  if (!hasSeqNum){
    const slug = descriptorSlug(name);
    if (slug && !prefix.endsWith(`_${slug}`)) prefix = `${prefix}_${slug}`;
  }
  return { prefix, sourcePrefix };
}


export function parseHeaders(h){
  const out = {};
  h.split(/\r?\n/).forEach(line=>{
    const m=line.match(/^([\w\-]+):\s*(.*)$/);
    if (m) out[m[1].toLowerCase()]=m[2];
  });
  return out;
}
export function base64ToBytes(b64){const bin=atob(b64);const len=bin.length;const bytes=new Uint8Array(len);for(let i=0;i<len;i++)bytes[i]=bin.charCodeAt(i)&0xff;return bytes;}
export function bytesToBase64(bytes){let bin='';for(let i=0;i<bytes.length;i++)bin+=String.fromCharCode(bytes[i]);return btoa(bin);}
export function qpToBytes(qp){qp=qp.replace(/=\r?\n/g,'');const out=[];for(let i=0;i<qp.length;i++){if(qp[i]==='='&&/^[0-9A-Fa-f]{2}$/.test(qp.substr(i+1,2))){out.push(parseInt(qp.substr(i+1,2),16));i+=2;}else{out.push(qp.charCodeAt(i)&0xff);}}return new Uint8Array(out);}
export function strToBytes(str){const arr=new Uint8Array(str.length);for(let i=0;i<str.length;i++)arr[i]=str.charCodeAt(i)&0xff;return arr;}
export function bytesToUTF8(bytes){try{return new TextDecoder('utf-8').decode(bytes);}catch{ return String.fromCharCode.apply(null, bytes);} }


export function parseFillInputToAnswers(str){
  const parts = (str||'').split('|').map(s=>s.trim()).filter(Boolean);
  return Array.from(new Set(parts));
}

export function cleanHTML(el){
  const clone = el.cloneNode(true);
  clone.querySelectorAll('script,style,button,.links,.move,.regrade_option').forEach(n=>n.remove());
  // textContent 把 <br> 和块级边界整个吞掉且不留任何分隔符 —— Canvas 里分行写的多行题干
  // 会粘成一串（"… * K-FactorBend Allowance = …"、"… = .841\"Mold line dimension B = 6\""、
  // "…90 degreesWhat is the bend allowance?"）。存档里 </p> <p> 之间偶然有空白时看不出问题，
  // 靠不住。取文本前显式把 <br> 换成换行、块级元素尾部补一个换行；下面的空白归一化会把
  // 连续空白收成单个换行/空格，所以多补不会留下空行。
  const doc = clone.ownerDocument || (typeof document !== 'undefined' ? document : null);
  if (doc){
    clone.querySelectorAll('br').forEach(n => n.replaceWith(doc.createTextNode('\n')));
    clone.querySelectorAll('p,div,li,tr,h1,h2,h3,h4,h5,h6,blockquote,pre,section,article,figcaption')
      .forEach(n => n.appendChild(doc.createTextNode('\n')));
  }
  return (clone.textContent||'')
    .replace(/\s+\n/g,'\n')
    .replace(/\u00a0/g,' ')
    .replace(/[ \t]{2,}/g,' ')
    .trim();
}
export function cleanHTMLString(s){
  const tmp=document.createElement('div');
  tmp.innerHTML=s;
  return cleanHTML(tmp);
}

export function buildUniqueMergedQuestionBankFromCollections(collections) {
  let all = [];
  for (const items of collections || []) {
    for (const item of items || []) all.push(item);
  }

  const registered = [];
  const legacy = [];
  for (const item of all) {
    if (hasRegisteredIdentityDescriptor(item)) registered.push(finalizedRegisteredRecord(item));
    else legacy.push(item);
  }
  if (registered.length) {
    const byKey = new Map();
    const uniqueRegistered = [];
    for (const item of registered) {
      const previous = byKey.get(item.questionKey);
      if (!previous) {
        byKey.set(item.questionKey, item);
        uniqueRegistered.push(item);
      } else if (!sameRegisteredValue(previous, item)) {
        throw registeredConflictError();
      }
    }
    if (!legacy.length) return uniqueRegistered;
    return [...uniqueRegistered, ...buildUniqueMergedQuestionBankFromCollections([legacy])];
  }
  all = legacy;

  const seen = new Map();
  const merged = [];
  all.forEach(item => {
    const key = makeUniqueQuestionKey(item);
    if (!seen.has(key)) {
      const cloned = JSON.parse(JSON.stringify(item));
      cloned.source = uniqueNonEmptyStrings(flattenSourceList(cloned.source));
      seen.set(key, cloned);
      merged.push(cloned);
      return;
    }
    mergeUniqueQuestionRecord(seen.get(key), item);
  });

  // 二段合并：主 key 对「有答案/无答案」不对称（无答案才带选项集合），导致同一道题
  // 一份来源显示了正确答案、另一份没显示时会双份并存。这里把「无答案」的选择题按
  // 题干+完整选项集合 去匹配「有答案」的同题：恰好命中一条就吸收进去；命中多条
  // （同干同选项但答案不同——本就该分开）则保持独立，不做猜测。
  const choiceShapeKey = (item) => JSON.stringify({
    q: normalizeTextForMerge(item && item.question),
    c: (Array.isArray(item && item.choices) ? item.choices.map(normalizeTextForMerge) : []).slice().sort(),
  });
  const isChoiceRecord = (r) => Array.isArray(r && r.choices) && r.choices.length > 0 && !(r.type === 'fill' || Array.isArray(r.blanks));
  const answeredByShape = new Map();
  for (const r of merged) {
    if (!isChoiceRecord(r) || !getAnswerSignature(r).length) continue;
    const k = choiceShapeKey(r);
    if (!answeredByShape.has(k)) answeredByShape.set(k, []);
    answeredByShape.get(k).push(r);
  }
  const out = [];
  for (const r of merged) {
    if (isChoiceRecord(r) && !getAnswerSignature(r).length) {
      const targets = answeredByShape.get(choiceShapeKey(r)) || [];
      if (targets.length === 1) {
        mergeUniqueQuestionRecord(targets[0], r);
        continue;
      }
    }
    out.push(r);
  }
  return out;
}
