// Canvas「New Quizzes」(Learnosity SDK) 成绩页的 DOM 解析层。
//
// 为什么单独成模块：New Quizzes 与经典测验（Classic Quizzes）是两套毫不相干的 DOM 方言 ——
// 经典测验认 `.display_question.question`，New Quizzes 是 React/emotion 渲染，一个都没有。
// 把它塞进 canvas-extract.js 只会让那份已经很长的经典解析器更难读。
//
// 一个曾经的错误认知（值得记住）：core.js 原来把这类存档报成「New Quizzes（LTI/iframe）页面，
// MHTML 不包含题目内容」。实际上**内容就在存档的主 text/html part 里** —— Learnosity 是内联
// 渲染的，不在 iframe 里，题图也照常内嵌（inst-fs / quiz-api S3 的 Content-Location）。
// 之前拿不到题只是因为没有对应的解析器。
//
// 锚点选择原则：只用稳定锚点 —— `data-automation` 属性、`data-cid` 属性、无障碍固定文案。
// **绝不要用 emotion 的哈希类名**（`css-1p1o175` 这种），它们每次 Canvas 发版都会变。
//
// 输出与 parseCanvasHTML 同形的 parsed 记录，可直接喂 buildQuestionBank。
import { cleanHTML } from './testable-core.js';

// 题块入口的固定文案（无障碍标题）。Canvas 给每道题都渲染 "Results for question N."
const QUESTION_HEADING = /results for question\s+(\d+)/i;
// "2 / 2 points"。必须整块精确匹配某个元素的文本：题块容器的整体文本是
// "Results for question 1.1 2 / 2 points …"，松匹配会把题号并进得分（"1.12 / 2"）。
const SCORE_TEXT = /^(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)\s*points?$/i;
const CORRECT_LABEL = /^correct answer\s*:?$/i;      // 注意：不会误命中 "Incorrect answer:"
const INCORRECT_LABEL = /^incorrect answer\s*:?$/i;

const text = (el) => (el ? cleanHTML(el).replace(/\s+/g, ' ').trim() : '');
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

// 页面级判定：给「解析不出题目时该报什么错」用，也给上层选引擎用。
export function looksLikeNewQuizzesResults(html){
  const s = String(html || '');
  return /Results for question\s+\d+/i.test(s) ||
    /data-automation="sdk-(item-wrapper|position-box-text|interaction-type-name-div)"/i.test(s);
}

// 题干/题图：题干区的 <img>，与经典解析器同样按「是不是 data: URI」区分已内嵌 / 缺图
// （缺图交给调用方按 missingImageSources 去补抓）。选项里的图（label 内）不算题图。
function collectImages(root){
  const raw = Array.from(root ? root.querySelectorAll('img') : [])
    .filter((img) => !(img.closest && img.closest('label')))
    .map((img) => String(img.getAttribute('src') || '').trim())
    .filter((s) => s && !/^(javascript:|about:blank)/i.test(s));
  return {
    images: raw.filter((s) => /^data:(image|application)\//i.test(s)),
    missingImageSources: raw.filter((s) => !/^data:(image|application)\//i.test(s)),
    expectedImageCount: raw.length,
  };
}

// 从某个选项往上找它的「答案反馈包裹层」：Canvas 把正确项 / 学生错选项分别包一层，层内挂一个
// 无障碍标签（"Correct answer: " / "Incorrect answer: "）。只认「层内恰好一个选项」的包裹层，
// 否则外层（含全部选项）的标签会被误判到某一个选项头上。
function feedbackLabelFor(choiceEl){
  let node = choiceEl.parentElement;
  for (let depth = 0; node && depth < 5; depth++, node = node.parentElement){
    if (node.querySelectorAll('[data-cid="RadioInput"],[data-cid="CheckboxInput"]').length !== 1) break;
    for (const el of node.querySelectorAll('div,span')){
      const t = text(el);
      if (INCORRECT_LABEL.test(t)) return 'incorrect';
      if (CORRECT_LABEL.test(t)) return 'correct';
    }
  }
  return '';
}

// 学生答错时，正确答案不是某个选项控件，而是一块纯文本 "Correct Answer: <文案>" ——
// 收集这些文案，稍后按文案回填到选项上。
function correctAnswerTexts(container){
  const out = [];
  for (const el of container.querySelectorAll('span,div')){
    if (!CORRECT_LABEL.test(text(el))) continue;
    const block = el.closest('div');
    const holder = (block && block.parentElement) || block;
    if (!holder) continue;
    for (const rich of holder.querySelectorAll('.user_content')){
      if (rich.closest('label')) continue;   // label 内的是选项本身，不是这块反馈文案
      const t = text(rich);
      if (t) out.push(t);
    }
  }
  return out;
}

export function parseNewQuizzesHTML(html){
  const dom = new DOMParser().parseFromString(String(html || ''), 'text/html');
  const out = [];

  const heads = Array.from(dom.querySelectorAll('h1,h2,h3,h4')).filter((h) => QUESTION_HEADING.test(text(h)));

  heads.forEach((h) => {
    const num = Number((text(h).match(QUESTION_HEADING) || [])[1]);

    // 往上找**最小的**、同时包含题目主体的祖先（再往上就是包住所有题的外层容器了）
    let container = h.parentElement;
    while (container && !container.querySelector('[data-automation="sdk-item-wrapper"]')) container = container.parentElement;
    if (!container) return;
    const wrapper = container.querySelector('[data-automation="sdk-item-wrapper"]');

    const qTypeName = text(container.querySelector('[data-automation="sdk-interaction-type-name-div"]')) || '(未标注)';

    let scoreInfo = null;
    for (const el of container.querySelectorAll('span,div')){
      const m = text(el).match(SCORE_TEXT);
      if (m){ scoreInfo = { earned: Number(m[1]), possible: Number(m[2]) }; break; }
    }

    // 题干 = 主体里第一个不在 <label> 内的富文本块（label 内的都是选项）
    let stemEl = null;
    for (const rich of wrapper.querySelectorAll('.user_content')){
      if (rich.closest('label')) continue;
      stemEl = rich;
      break;
    }
    const qtext = cleanHTML(stemEl || wrapper);
    const imgInfo = collectImages(stemEl || wrapper);
    const base = {
      num, domId: '', qtext, ...imgInfo,
      missingImageCount: imgInfo.missingImageSources.length,
      uploadedImages: [], scoreInfo, qTypeName,
    };

    const radios = Array.from(wrapper.querySelectorAll('[data-cid="RadioInput"]'));
    const checkboxes = Array.from(wrapper.querySelectorAll('[data-cid="CheckboxInput"]'));

    // 只有单选（Multiple Choice / True-False）能无损转成题库选择题。
    // Hot Spot（在图上点位置）、Categorization、Ordering、Matching 等交互题没有可作答的选项
    // 列表；多选（CheckboxInput）目前没有真实样本可回归，猜实现只会产出静默错答的坏数据。
    // 一律标 kind:'unknown' —— buildQuestionBank 不导出它，提取器预览里以「未知题型/待人工
    // 确认」可见，与经典解析器对未识别题型的处理一致。
    if (!radios.length || checkboxes.length){
      out.push({ ...base, kind: 'unknown' });
      return;
    }

    const wanted = correctAnswerTexts(container).map(norm);
    const choices = radios.map((r) => {
      const rich = r.querySelector('.user_content');
      const input = r.querySelector('input[type="radio"]');
      return {
        text: text(rich) || text(r),
        isCorrect: feedbackLabelFor(r) === 'correct',
        // checked = **学生的选择**，不是正确答案（答错的题上它挂在错选项上）——只作 isSelected 用
        isSelected: !!(input && input.hasAttribute('checked')),
        feedback: feedbackLabelFor(r),
      };
    });

    // 答错的题：正确项以纯文本给出 → 按文案回填
    if (!choices.some((c) => c.isCorrect) && wanted.length){
      for (const c of choices) if (wanted.includes(norm(c.text))) c.isCorrect = true;
    }

    // 答案信号溯源，与经典解析器同一套语义：选项上带 "Correct answer:" 标记 = 页面明确标注；
    // 靠纯文本回填 = canvas-correct-block（导出时会写进 answer_source，发布后可追溯）。
    const answerSource = choices.some((c) => c.feedback === 'correct')
      ? 'explicit'
      : (choices.some((c) => c.isCorrect) ? 'canvas-correct-block' : '');

    out.push({ ...base, kind: 'choice', isMulti: false, choices, answerSource });
  });

  return out;
}
