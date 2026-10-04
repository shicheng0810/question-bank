// Canvas archive extraction: MHTML MIME layer + Classic Quiz results-page DOM layer.
// Pure functions over (string | DOM) inputs — no app/UI state. Browser & jsdom compatible
// (requires DOMParser / document / NodeFilter globals). Extracted from src/app/core.js init()
// closure so the most boundary-sensitive logic in the project is unit-testable against real
// archives (see tests/canvas-extract.test.js + tests/fixtures/archives/).
import {
  cleanHTML, cleanHTMLString, uniqueNonEmptyStrings, getQuestionImages,
  parseHeaders, base64ToBytes, bytesToBase64, qpToBytes, strToBytes, bytesToUTF8,
} from './testable-core.js';
import { shouldUseSelectedAnswersAsCorrectFallback } from './canvas-answer-fallback.js';
import { parseNewQuizzesHTML, looksLikeNewQuizzesResults } from './newquizzes-extract.js';

function extractMatchingQuestionData(blk){
  const rows = Array.from(blk.querySelectorAll('.answer .answer_match'));
  if (!rows.length) return null;

  const pairs = [];
  const pool = [];

  rows.forEach(row => {
    let left = '';
    const leftHtml = row.querySelector('.answer_match_left_html');
    if (leftHtml) left = cleanHTML(leftHtml).trim();
    if (!left){
      const leftText = row.querySelector('.answer_match_left');
      if (leftText) left = cleanHTML(leftText).trim();
    }

    const select = row.querySelector('.answer_match_right select');
    const options = select ? Array.from(select.querySelectorAll('option')) : [];
    // 只认显式 selected 属性：存档是静态 HTML，真实选择只会以 selected 属性形式存在。
    // 不要用 selectedOptions/options[0] 兜底——<select> 语义下没有 selected 时第一项默认
    // “被选中”，会把“缺答”悄悄变成“第一项=正确答案”的错答。取不到就留空走人工确认。
    const isPlaceholderOption = (t) => /^\[\s*(choose|select|no answer)/i.test(t);
    const selectedOpt = options.find(opt => opt.hasAttribute('selected')) || null;
    const selectedText = cleanHTMLString(selectedOpt ? (selectedOpt.textContent || selectedOpt.value || '') : '').trim();
    const right = isPlaceholderOption(selectedText) ? '' : selectedText;

    options.forEach(opt => {
      const t = cleanHTMLString(opt.textContent || opt.value || '').trim();
      if (t && !isPlaceholderOption(t)) pool.push(t);
    });
    if (right) pool.push(right);

    if (left || right) pairs.push({ left, right });
  });

  if (!pairs.length) return null;
  return { pairs, choicePool: uniqueNonEmptyStrings(pool) };
}

/* -------------------- MHTML 解析（内嵌图片） -------------------- */
function scoreMHTMLHtmlCandidate(html, loc=''){
  const src = String(html || '');
  const where = String(loc || '');
  let score = 0;
  if (/display_question\s+question/i.test(src)) score += 10000;
  if (/question_text|original_question_text|question_name/i.test(src)) score += 6000;
  if (/assessment_results|id=["']questions["']/i.test(src)) score += 4000;
  if (/quiz-submission|quiz_sortable|question_holder/i.test(src)) score += 2500;
  if (/Question\s+1/i.test(src)) score += 1200;
  if (/\/quizzes\/|headless=1/i.test(where)) score += 1500;
  score += Math.min(src.length, 200000) / 1000;
  return score;
}

function parseMHTML(text){
  const firstHeaderEnd = text.indexOf('\r\n\r\n') >= 0 ? text.indexOf('\r\n\r\n') : text.indexOf('\n\n');
  if (firstHeaderEnd < 0) return { html:'', htmlParts:[], cidMap:{}, subject:'' };
  const head = text.slice(0, firstHeaderEnd + 2);
  // MHTML 信封头的 Subject = 保存时的真实页面标题，比 DOM <title> 可靠（后者常是嵌入 iframe/LTI 的标题）。
  const subject = String((parseHeaders(head)['subject'] || '')).replace(/\s+/g, ' ').trim();
  const m = head.match(/boundary="?([^"\r\n]+)"?/i);
  if(!m) return { html:'', htmlParts:[], cidMap:{}, subject };

  const boundary = m[1];
  const sep = '--' + boundary;
  const parts = text.split(sep).slice(1).filter(p => !p.startsWith('--'));

  const cidMap = {};
  const htmlParts = [];
  let html = '';
  let bestHtmlScore = -Infinity;

  for (let raw of parts){
    raw = raw.replace(/^\s+|\s+$/g,'').replace(/--\s*$/,'').trim();
    const split = raw.search(/\r?\n\r?\n/);
    if (split < 0) continue;

    const headerText = raw.slice(0, split);
    const bodyText   = raw.slice(split).replace(/^\r?\n/,'');

    const h = parseHeaders(headerText);
    const ctype = (h['content-type']||'').toLowerCase();
    const enc   = (h['content-transfer-encoding']||'').toLowerCase();
    const cid   = (h['content-id']||'').replace(/[<>]/g,'').trim();
    const loc   = (h['content-location']||'').trim();

    let bytes;
    if (enc.includes('base64')){
      const b64 = bodyText.replace(/\s+/g,'');
      bytes = base64ToBytes(b64);
    }else if (enc.includes('quoted-printable')){
      bytes = qpToBytes(bodyText);
    }else{
      bytes = strToBytes(bodyText);
    }

    if (ctype.startsWith('text/html')){
      const htmlDecoded = bytesToUTF8(bytes);
      if (htmlDecoded) {
        htmlParts.push(htmlDecoded);
        const score = scoreMHTMLHtmlCandidate(htmlDecoded, loc);
        if (score > bestHtmlScore) {
          bestHtmlScore = score;
          html = htmlDecoded;
        }
      }
    }else if (ctype.startsWith('image/') || ctype.startsWith('application/')){
      const b64 = bytesToBase64(bytes);
      const dataURL = `data:${ctype};base64,${b64}`;
      if (cid) cidMap['cid:'+cid] = dataURL;
      if (loc) cidMap[loc] = dataURL;
    }
  }
  return { html, htmlParts, cidMap, subject };
}

function rewriteSources(html, map){
  return html.replace(/(<img[^>]+src=["'])([^"']+)(["'][^>]*>)/gi,(m,p1,src,p3)=>{
    const key=(src||'').replace(/&amp;/g,'&');
    if(map[key]) return p1+map[key]+p3;
    if(key.startsWith('cid:') && map[key.slice(4)]) return p1+map[key.slice(4)]+p3;
    return m;
  });
}

function parseQuestionScore(blk){
  const holder = blk.querySelector('.user_points');
  if (!holder) return null;
  const txt = cleanHTML(holder).replace(/pts?\b/gi, '').trim();
  const m = txt.match(/(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)/);
  if (!m) return null;
  const earned = Number(m[1]);
  const possible = Number(m[2]);
  if (!Number.isFinite(earned) || !Number.isFinite(possible)) return null;
  return { earned, possible };
}

function hasFullCredit(scoreInfo){
  return !!(scoreInfo && Number.isFinite(scoreInfo.earned) && Number.isFinite(scoreInfo.possible) && scoreInfo.possible > 0 && Math.abs(scoreInfo.earned - scoreInfo.possible) < 1e-9);
}

function hasAnyBlankAnswers(blanks){
  if (!Array.isArray(blanks) || !blanks.length) return false;
  return blanks.some(arr => Array.isArray(arr) && arr.some(v => String(v || '').trim()));
}

function extractSelectedChoiceInfo(li){
  const cls = li.className || '';
  const input = li.querySelector('input[type="radio"],input[type="checkbox"]');
  const titleStr = li.getAttribute('title') || '';
  return /\bselected_answer\b/i.test(cls) || !!(input && input.checked) || /\byou selected this answer\b/i.test(titleStr);
}

/* -------------------- Canvas HTML 解析（灰箭头=正确） -------------------- */
function parseCanvasHTML(html){
  const dom = new DOMParser().parseFromString(html,'text/html');
  const blocks = dom.querySelectorAll('.display_question.question');
  const tmp = [];

  blocks.forEach((blk, idx)=>{
    const nameEl = blk.querySelector('.question_name');
    const scoreInfo = parseQuestionScore(blk);
    const numStr = nameEl ? (nameEl.textContent.match(/\d+/)||[])[0] : (idx+1);
    const num = Number(numStr);
    // 题块的 DOM id（如 question_201392816）是页面内真正唯一的标识；
    // 题名里的数字只用于展示，不再用作去重 key（教师自定义题名会撞号吞题）。
    const domId = String(blk.id || '').trim();
    // Canvas 每个题块自带权威题型字段，优先于 class 正则猜测
    const qTypeEl = blk.querySelector('.question_type');
    const qType = qTypeEl ? String(qTypeEl.textContent || '').trim().toLowerCase() : '';

    let qtext = '';
    const visibleText = blk.querySelector('.question_text.user_content') || blk.querySelector('.question_text');
    if (visibleText) qtext = cleanHTML(visibleText).trim();
    if (!qtext){
      const ta = blk.querySelector('.original_question_text textarea');
      if (ta) qtext = cleanHTMLString(ta.value || ta.textContent || '').trim();
    }

    // 只统计题干图片：`.text img` 会把选项/教师反馈区的图片也算进 expectedImageCount，
    // 造成永远清不掉的“缺图 N 题”。用 closest('.answers') 把答案区图片排除。
    const rawImageSources = Array.from(blk.querySelectorAll('.question_text img, .text img'))
      .filter(img => !(img.closest && img.closest('.answers')))
      .map(img=>(img.getAttribute('src')||'').trim())
      .filter(s=>{
        if (!s) return false;
        if (/^(javascript:|about:blank)/i.test(s)) return false;
        return true;
      });
    const images = rawImageSources.filter(s => /^(data:image\/|data:application\/)/i.test(s));
    const missingImageSources = rawImageSources.filter(s => !/^(data:image\/|data:application\/)/i.test(s));
    const expectedImageCount = rawImageSources.length;
    const missingImageCount = missingImageSources.length;

    const clsAll = blk.className || '';

    // -------- 选择题：带 answer 类且含 radio/checkbox --------
    const rawItems = Array.from(blk.querySelectorAll('li,div')).filter(el=>{
      const cls = el.className || '';
      if (!/\banswer\b/i.test(cls)) return false;
      return !!el.querySelector('input[type="radio"],input[type="checkbox"]');
    });

    if (rawItems.length){
      const isMulti =
        qType === 'multiple_answers_question' ||
        /\bmultiple_answers_question\b/i.test(clsAll) ||
        rawItems.some(li => !!li.querySelector('input[type="checkbox"]'));

      const choices = rawItems.map(li=>{
        let txt = '';
        // 选项文案在 .answer_text（纯文本）或 .answer_html（富文本）里二选一：教师用富文本
        // 编辑器写的选项，Canvas 会把 .answer_text 置空 + display:none，内容放进 .answer_html。
        // 只认 .answer_text 时这类选项会掉进「整块 li」兜底，把 li 里隐藏的 Canvas 元数据
        // （exact_answer / numerical_* / 选项 id）当成选项文案导出。.answer_text + .answer_html
        // 配对读法本文件已用在填空与正确答案块（见 extractFillBlanks* / canvas correct 块）。
        for (const sel of ['.answer_text', '.answer_html']){
          const el = li.querySelector(sel);
          if (!el) continue;
          txt = cleanHTML(el).trim();
          if (txt) break;
        }
        if (!txt) txt = cleanHTML(li).trim();

        const cls = li.className || '';
        const hasCorrectClass = /\bcorrect\b/i.test(cls) || /\bcorrect_answer\b/i.test(cls);

        const icon = li.querySelector('[class*="icon-"], .ic-Icon, svg, [data-icon], [data-testid]');
        let iconStr = '';
        if (icon){
          iconStr = [
            icon.className || '',
            icon.getAttribute && (icon.getAttribute('aria-label')||''),
            icon.getAttribute && (icon.getAttribute('title')||''),
            icon.getAttribute && (icon.getAttribute('data-icon')||''),
            icon.getAttribute && (icon.getAttribute('data-testid')||''),
            icon.getAttribute && (icon.getAttribute('name')||''),
          ].join(' ');
        }

        // 收紧图标判定：以前的 /right|arrow/ 会被装饰性图标（下拉箭头 icon-arrow-down、
        // arrow-right 等）误触发，把错误选项标成正确。实测样本的正确性信号全部由
        // .correct_answer class 或 answer_arrow.correct 提供，图标只留精确词。
        const iconCorrect =
          /\bcorrect\b|\bsuccess\b|icon-check(?![a-z])/i.test(iconStr) &&
          !/wrong|error|incorrect|cross|x_icon|x(?![a-z])/i.test(iconStr);

        // NOTE: do NOT treat option text containing the word "correct" as correctness signal
        // (e.g. choice text itself may include "correct", which caused false positives).
        const titleStr = li.getAttribute('title') || '';
        const hintCorrect =
          /\b(correct|正确)\b/i.test(li.getAttribute('aria-label')||'') ||
          !!li.querySelector(
            '.answer_arrow.correct, .answer_indicator.correct,' +
            ' .answer_arrow[aria-label*="Correct"], .answer_arrow[aria-label*="正确"],' +
            ' .answer_indicator[aria-label*="Correct"], .answer_indicator[aria-label*="正确"]'
          ) ||
          /(this was the correct answer|was the correct answer|正确答案)/i.test(titleStr);

        const isCorrect = !!(hasCorrectClass || iconCorrect || hintCorrect);
        const isSelected = extractSelectedChoiceInfo(li);

        return { text: txt, isCorrect, isSelected };
      });

      let answerDerivedFromScore = false;
      let answerDerivedFromCanvasCorrectBlock = false;
      let answerConflict = false;
      let conflictSelectedIndexes = null;
      const selectedIndexes = choices.map((c,i)=> c.isSelected ? i : -1).filter(i => i >= 0);
      const explicitCorrectIndexes = choices.map((c,i)=> c.isCorrect ? i : -1).filter(i => i >= 0);
      if (hasFullCredit(scoreInfo)) {
        const sameAnswerSet =
          selectedIndexes.length === explicitCorrectIndexes.length &&
          selectedIndexes.every((idx, pos) => idx === explicitCorrectIndexes[pos]);

        if (!explicitCorrectIndexes.length && selectedIndexes.length) {
          // 页面没有标注任何正确项但拿了满分 ⇒ 用“你勾选的选项”当标准答案（score 推断）
          answerDerivedFromScore = true;
          if (isMulti){
            choices.forEach((c,i)=>{ c.isCorrect = selectedIndexes.includes(i); });
          }else{
            choices.forEach((c,i)=> c.isCorrect = (i === selectedIndexes[0]));
          }
        } else if (selectedIndexes.length && !sameAnswerSet) {
          // 满分但勾选≠页面标注的正确项。以前直接用勾选覆盖标注——遇到 regrade 全员给分、
          // survey、fudge points 会把错误选项静默写成正确答案。现在：保留页面标注为准，
          // 打 answerConflict 标记进“答案冲突”人工确认（UI 黄标 + 状态栏计数 + 导出 answer_source）。
          answerConflict = true;
          conflictSelectedIndexes = selectedIndexes.slice();
        }
      } else if (shouldUseSelectedAnswersAsCorrectFallback({ clsAll, explicitCorrectIndexes, selectedIndexes })) {
        answerDerivedFromCanvasCorrectBlock = true;
        if (isMulti){
          choices.forEach((c,i)=>{ c.isCorrect = selectedIndexes.includes(i); });
        }else{
          choices.forEach((c,i)=> c.isCorrect = (i === selectedIndexes[0]));
        }
      }

      choices.forEach(c=>{ delete c.isSelected; });
      const cleanedQtext = stripDuplicatedChoicesFromQtext(qtext, choices);
      const answerSource = answerConflict ? 'conflict'
        : answerDerivedFromScore ? 'score'
        : answerDerivedFromCanvasCorrectBlock ? 'canvas-correct-block'
        : 'explicit';
      tmp.push({ num, domId, qtext: cleanedQtext, images, uploadedImages: [], expectedImageCount, missingImageCount, missingImageSources, kind:'choice', isMulti, choices, scoreInfo, answerDerivedFromScore, answerDerivedFromCanvasCorrectBlock, answerConflict, conflictSelectedIndexes, answerSource });
      return;
    }


    // -------- 配对题：matching_question -> 每个左侧子项后续导出为 1 道单选题 --------
    const isMatching = qType === 'matching_question' || /matching_question/i.test(clsAll);
    if (isMatching){
      const matchData = extractMatchingQuestionData(blk);
      if (matchData && matchData.pairs && matchData.pairs.length){
        tmp.push({
          num,
          domId,
          qtext,
          images,
          uploadedImages: [],
          expectedImageCount,
          missingImageCount,
          missingImageSources,
          kind:'matching',
          pairs: matchData.pairs,
          choicePool: matchData.choicePool,
          scoreInfo,
        });
        return;
      }
    }

    // -------- 填空题：short_answer / fill_in / numerical / calculated --------
    const isFill =
      /^(short_answer|numerical|calculated)_question$/.test(qType) || /fill_in/.test(qType) ||
      /short_answer_question|fill_in.*question|numerical_question|calculated_question/i.test(clsAll);

    if (isFill){
      // 优先“多空题 Answer 1/2/3...”分组；无 heading 时按每个答案自带的 .blank_id 分组
      const groupBlanks = extractFillBlanksFromAnswerGroups(blk) || extractFillBlanksByBlankId(blk);
      let blanks = (groupBlanks && groupBlanks.length)
        ? groupBlanks
        : normalizeBlankSets(extractTextAnswerSets(blk));

      // numerical/calculated：input value 取不到时退回 Canvas 的精确答案元数据
      if (!hasAnyBlankAnswers(blanks)){
        const exacts = Array.from(blk.querySelectorAll('.answers .answer .answer_exact'))
          .map(el => String(el.textContent || '').trim())
          .filter(Boolean);
        if (exacts.length) blanks = [Array.from(new Set(exacts))];
      }

      let answerDerivedFromScore = false;
      if (!hasAnyBlankAnswers(blanks) && hasFullCredit(scoreInfo)) {
        const selectedBlanks = extractSelectedFillAnswers(blk);
        if (hasAnyBlankAnswers(selectedBlanks)) {
          blanks = selectedBlanks;
          answerDerivedFromScore = true;
        }
      }

      // 生成可用于题库做题的「带空格输入框」HTML（后续 question_bank 用）
      const qhtml = buildFillQuestionHTML(blk, blanks.length);

      tmp.push({ num, domId, qtext, images, uploadedImages: [], expectedImageCount, missingImageCount, missingImageSources, kind:'fill', blanks, qhtml, scoreInfo, answerDerivedFromScore });
      return;
    }

    // -------- 问答题（无标准答案）--------
    // 以前直接丢弃导致“题号有洞且无人知”；现在保留进预览（渲染为“问答题”），
    // 导出时由 buildQuestionBank 跳过，数量在状态栏显式计数。
    const isEssay = qType === 'essay_question' || /essay_question/i.test(clsAll);
    if (isEssay){
      tmp.push({ num, domId, qtext, images, uploadedImages: [], expectedImageCount, missingImageCount, missingImageSources, kind:'essay', scoreInfo });
      return;
    }

    tmp.push({ num, domId, qtext, images, uploadedImages: [], expectedImageCount, missingImageCount, missingImageSources, kind:'unknown', qTypeName: qType, scoreInfo });
  });

  // 去重 key 用题块 DOM id（页面内真正唯一）：同一题块重复渲染时取信息量大的那份；
  // 教师自定义题名导致的题号相同不再吞题（A11）。
  const byKey = new Map();
  const score = (q) => {
    const base =
      q.kind === 'choice'
        ? (q.choices?.length||0)
        : q.kind === 'fill'
          ? (q.blanks?.reduce((s,b)=>s+(b?.length||0),0) || 0)
          : q.kind === 'matching'
            ? (q.pairs?.length || 0)
            : 0;
    return base + getQuestionImages(q).length;
  };

  for (const q of tmp){
    const key = q.domId || `num_${q.num}`;
    const old = byKey.get(key);
    if (!old) byKey.set(key, q);
    else if (score(q) > score(old)) byKey.set(key, q);
  }

  const result = Array.from(byKey.values()).sort((a,b)=>a.num-b.num);

  // 撞号消歧：题号只用于展示，但导出 id = prefix-题号，必须唯一。
  // 撞号的后来者拿到 idSuffix "N_2"、"N_3"…（展示仍是 Question N）。
  const usedSuffixes = new Set();
  for (const q of result){
    let suffix = String(q.idSuffix || q.num);
    let n = 2;
    while (usedSuffixes.has(suffix)) suffix = `${q.num}_${n++}`;
    if (suffix !== String(q.idSuffix || q.num)) q.idSuffix = suffix;
    usedSuffixes.add(suffix);
  }

  return result;
}

function extractSelectedFillBlanksFromAnswerGroups(blk){
  const groups = Array.from(blk.querySelectorAll('.answers .answer_group'));
  if (!groups.length) return null;

  const hasHeading = groups.some(g => !!g.querySelector('.answer-group-heading'));
  if (!hasHeading) return null;

  const blanks = [];
  groups.forEach(g=>{
    const set = new Set();

    g.querySelectorAll('.answer.selected_answer .answer_type.short_answer input[name="answer_text"], .answer.selected_answer .answer_type.short_answer textarea[name="answer_text"]').forEach(el=>{
      const v = (el.value || el.getAttribute('value') || '').trim();
      if (v) set.add(v);
    });

    g.querySelectorAll('.answer.selected_answer .select_answer .answer_text, .answer.selected_answer .answer_text').forEach(el=>{
      const t = cleanAnswerText(el);
      if (t) set.add(t);
    });

    blanks.push(Array.from(set));
  });

  return blanks;
}

function extractSelectedTextAnswerSets(blk){
  const nodes = Array.from(blk.querySelectorAll('.answers .answer.selected_answer'));
  const sets = [];

  nodes.forEach(node=>{
    const vals = [];
    node.querySelectorAll('input[type="text"], textarea').forEach(el=>{
      const v = (el.value || el.getAttribute('value') || el.textContent || '').trim();
      if (!v) return;
      if (!vals.includes(v)) vals.push(v);
    });

    if (!vals.length){
      const txts = Array.from(node.querySelectorAll('.answer_text, .answer_html'))
        .map(el=>cleanHTML(el).trim())
        .filter(Boolean);
      if (txts.length) vals.push(txts[0]);
    }

    if (vals.length) sets.push(vals);
  });

  const seen = new Set();
  const out = [];
  for (const s of sets){
    const key = s.join('||');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function extractSelectedFillAnswers(blk){
  const groupBlanks = extractSelectedFillBlanksFromAnswerGroups(blk);
  if (groupBlanks && groupBlanks.length) return groupBlanks;
  return normalizeBlankSets(extractSelectedTextAnswerSets(blk));
}

// 多空题的兜底分组：页面没有 Answer 1/2/3 heading 时，按每个答案自带的 .blank_id 分组
// （实测每个 answer 节点都带 <span class="blank_id">，单空题值为 "none"）。
function extractFillBlanksByBlankId(blk){
  let nodes = Array.from(blk.querySelectorAll('.answers .answer.correct_answer'));
  if (!nodes.length) nodes = Array.from(blk.querySelectorAll('.answers .answer'));
  if (!nodes.length) return null;

  const order = [];
  const byBlank = new Map();
  for (const node of nodes){
    const bidEl = node.querySelector('.blank_id');
    const bid = bidEl ? String(bidEl.textContent || '').trim() : '';
    if (!bid || bid.toLowerCase() === 'none') return null; // 非多空结构，走原路径
    if (!byBlank.has(bid)){ byBlank.set(bid, new Set()); order.push(bid); }
    const set = byBlank.get(bid);
    node.querySelectorAll('input[name="answer_text"], textarea[name="answer_text"], input[type="text"]').forEach(el=>{
      const v = (el.value || el.getAttribute('value') || '').trim();
      if (v) set.add(v);
    });
    const at = node.querySelector('.answer_text');
    if (at){
      const t = cleanAnswerText(at);
      if (t) set.add(t);
    }
  }
  if (order.length < 2) return null; // 只有一个空：原单空路径已覆盖
  return order.map(bid => Array.from(byBlank.get(bid)));
}

// 多空填空题（Answer 1/2/3...）抽取：每个空独立收集可接受答案（含“灰箭头”给的替代答案）
function extractFillBlanksFromAnswerGroups(blk){
  const groups = Array.from(blk.querySelectorAll('.answers .answer_group'));
  if (!groups.length) return null;

  // 只有存在 Answer 1/2/... heading 才认为是“多空题分组结构”
  const hasHeading = groups.some(g => !!g.querySelector('.answer-group-heading'));
  if (!hasHeading) return null;

  const blanks = [];
  groups.forEach(g=>{
    const set = new Set();

    // 1) Canvas 给出的 canonical correct（灰箭头）——只抓 answer_text
    g.querySelectorAll('.answer.correct_answer .select_answer .answer_text').forEach(el=>{
      const t = cleanAnswerText(el);
      if (t) set.add(t);
    });

    // 2) 有些页面正确值在 input/textarea value 里
    g.querySelectorAll('.answer.correct_answer .answer_type.short_answer input[name="answer_text"], .answer.correct_answer .answer_type.short_answer textarea[name="answer_text"]').forEach(el=>{
      const v = (el.value || el.getAttribute('value') || '').trim();
      if (v) set.add(v);
    });

    // 3) 如果“你填写的答案”本身也判对（绿色✅），也作为可接受答案（排除 answer_for_* 元数据容器）
    g.querySelectorAll('.answer.selected_answer.correct_answer .select_answer .answer_text, .answer.selected_answer.correct_answer .answer_text').forEach(el=>{
      const t = cleanAnswerText(el);
      if (t) set.add(t);
    });

    blanks.push(Array.from(set));
  });

  return blanks;
}

// 清洗答案文本：去掉 icon / hidden / screenreader-only / arrow 等，只保留可见文字
function cleanAnswerText(el){
  if (!el) return '';
  const clone = el.cloneNode(true);
  clone.querySelectorAll('.hidden,.screenreader-only,span.hidden,span.id,.id,.answer_arrow,[class*="icon-"],svg,i').forEach(n=>n.remove());
  return (clone.textContent || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// 生成“题干里带输入框”的 HTML：把 Canvas 原来的 input（含正确答案 value）替换成空白输入框
// 这个字段会导出为 question_html，之后更新 question_bank 用它把输入框放在正确位置
function buildFillQuestionHTML(blk, expectedBlankCount){
  const qt = blk.querySelector('.question_text.user_content') || blk.querySelector('.question_text');
  if (!qt) return '';

  const clone = qt.cloneNode(true);
  clone.querySelectorAll('script,style,button,a,.links,.move,.regrade_option').forEach(n=>n.remove());

  // 1) 如果题干里本身就有 input/textarea（少见，但存在），直接替换成 qb-blank
  let i = 1;
  const rawInputs = Array.from(clone.querySelectorAll('input.question_input, input[type="text"], textarea'));
  rawInputs.forEach(inp=>{
    const el = document.createElement('input');
    el.type = 'text';
    el.className = 'qb-blank';
    el.setAttribute('data-blank', String(i));
    el.setAttribute('autocomplete', 'off');
    el.setAttribute('spellcheck', 'false');
    el.setAttribute('placeholder', '_____');
    el.value = '';
    inp.replaceWith(el);
    i++;
  });

  // 2) 题干里没有 input 的场景：用“_____/---”占位替换成 qb-blank（典型：单空短答题）
  if (!rawInputs.length && expectedBlankCount && expectedBlankCount > 0){
    // 3+ 下划线/长破折号、空的 [ ] 或 ( )，以及"字母开头的命名占位"如 [a]/[label]。
    // 字母开头排除引用标号 [1]；不含 \s 排除正文 [see figure 3]（含空格不匹配）。
    const placeholderRe = /_{3,}|\[\s*\]|\(\s*\)|[‐‑‒–—―-]{3,}|\[[A-Za-z][A-Za-z0-9_]{0,19}\]/;
    let inserted = 0;

    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT, null);
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);

    for (const tn of textNodes){
      if (inserted >= expectedBlankCount) break;
      const original = tn.textContent || '';
      if (!placeholderRe.test(original)) continue;

      // 逐段拆分：每次只替换一个占位，剩余部分再作为新的 text node 继续处理（while 循环）
      let rest = original;
      const frag = document.createDocumentFragment();

      while (inserted < expectedBlankCount){
        const m = rest.match(placeholderRe);
        if (!m) break;
        const idx = rest.search(placeholderRe);
        if (idx > 0) frag.appendChild(document.createTextNode(rest.slice(0, idx)));

        const el = document.createElement('input');
        el.type = 'text';
        el.className = 'qb-blank';
        el.setAttribute('data-blank', String(inserted + 1));
        el.setAttribute('autocomplete', 'off');
        el.setAttribute('spellcheck', 'false');
        el.setAttribute('placeholder', '_____');
        el.value = '';
        frag.appendChild(el);

        rest = rest.slice(idx + m[0].length);
        inserted += 1;
      }

      if (rest) frag.appendChild(document.createTextNode(rest));
      tn.parentNode.replaceChild(frag, tn);
    }

    // 3) 如果题干里没有足够占位，则把剩余空补到末尾（不中断流程）
    if (inserted < expectedBlankCount){
      const p = document.createElement('p');
      p.textContent = ' ';
      for (let k=inserted+1;k<=expectedBlankCount;k++){
        const el = document.createElement('input');
        el.type = 'text';
        el.className = 'qb-blank';
        el.setAttribute('data-blank', String(k));
        el.setAttribute('placeholder', '_____');
        el.value = '';
        p.appendChild(el);
        p.appendChild(document.createTextNode(' '));
      }
      clone.appendChild(p);
    }
  }

  return clone.innerHTML;
}

// 从 Canvas 回顾页抽取填空题的正确答案（兼容 multiple blanks）
function extractTextAnswerSets(blk){
  // 优先：正确答案区域
  const nodes = Array.from(blk.querySelectorAll('.answers .answer.correct_answer'));
  const sets = [];

  nodes.forEach(node=>{
    const vals = [];
    node.querySelectorAll('input[type="text"], textarea').forEach(el=>{
      const v = (el.value || el.getAttribute('value') || el.textContent || '').trim();
      if (!v) return;
      if (!vals.includes(v)) vals.push(v);
    });
    if (vals.length) sets.push(vals);
  });

  // 兜底：部分页面可能没有 input/textarea，而是纯文本
  if (!sets.length){
    const txts = Array.from(blk.querySelectorAll('.answers .answer.correct_answer .answer_text, .answers .answer.correct_answer .answer_html'))
      .map(el=>cleanHTML(el).trim())
      .filter(Boolean);
    if (txts.length) sets.push([txts[0]]);
  }

  // 去重（按整组）
  const seen = new Set();
  const out = [];
  for (const s of sets){
    const key = s.join('||');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

// 把「每一组可接受答案」归并成「每一空的可接受答案集合」：blanks[blankIndex] = [a,b,c...]
function normalizeBlankSets(sets){
  const max = Math.max(0, ...sets.map(s=>s.length));
  if (!max) return [];
  const blanks = Array.from({length:max}, ()=>[]);
  sets.forEach(s=>{
    for (let i=0;i<max;i++){
      const v = (s[i]||'').trim();
      if (!v) continue;
      if (!blanks[i].includes(v)) blanks[i].push(v);
    }
  });
  return blanks;
}



// Canvas \u7684 .question_text \u6709\u65f6\u4f1a\u628a\u9009\u9879\u4e5f\u5199\u5728\u9898\u5e72\u672b\u5c3e\uff0c\u5bfc\u81f4 qtext \u4e0e choices \u91cd\u590d\u3002
// \u8fd9\u91cc\u68c0\u6d4b qtext \u672b\u5c3e\u82e5\u5e72\u884c\u662f\u5426\u80fd\u5728 choices \u91cc\u9010\u4e00\u5339\u914d\u5230\uff0c\u82e5 \u22652 \u884c\u5339\u914d\u5219\u5265\u79bb\u3002
function stripDuplicatedChoicesFromQtext(qtext, choices){
  const text = String(qtext || '');
  if (!text) return text;
  const choiceTexts = (Array.isArray(choices) ? choices : [])
    .map(c => normChoiceLine(c && (c.text != null ? c.text : c)))
    .filter(Boolean);
  if (choiceTexts.length < 2) return text;
  const choiceSet = new Set(choiceTexts);

  const lines = text.split(/\r?\n/);
  let cutAt = lines.length;
  let matched = 0;
  for (let i = lines.length - 1; i >= 0; i--){
    const norm = normChoiceLine(lines[i]);
    if (!norm){ cutAt = i; continue; } // skip blank/whitespace line
    if (choiceSet.has(norm)){
      cutAt = i;
      matched++;
      continue;
    }
    break;
  }
  if (matched < 2) return text;
  return lines.slice(0, cutAt).join('\n').replace(/[ \t]+$/,'');
}
function normChoiceLine(value){
  return String(value == null ? '' : value)
    .replace(/\u00a0/g, ' ')
    .replace(/^[\s\u2022\u00b7\u25cf\u25cb\u25e6\-*]+/, '')
    .replace(/^[(\[]?\s*[A-Ha-h0-9]{1,2}\s*[).\uff0e\u3001:\uff1a\-]\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/* -------------------- 存档级解析入口（选 html 候选 + 选解析引擎） --------------------
   一份 MHTML 存档常有多个 text/html part（主页面 + LTI 转发壳等空壳），要挑出真正含题的那份；
   而 Canvas 有两种测验：经典测验（.display_question）和 New Quizzes（Learnosity DOM）。
   这两件事以前散在每个调用方各写一遍（core.js 的 parseDataset、scripts/extract-mhtml.mjs），
   现在收敛到这里，保证 UI 与 CLI 走完全同一条路。

   注意选引擎的顺序：先用经典解析器把**所有**候选扫一遍，一道题都没有才整体回退 New Quizzes。
   不逐个候选混用两种引擎 —— 否则某个候选里 3 道经典题会盖掉另一个候选里 10 道 New Quizzes 题。 */
function parseQuizArchive(candidates, cidMap){
  const list = (Array.isArray(candidates) ? candidates : [candidates]).filter((c) => c && String(c).trim());
  const withData = list.map((c) => rewriteSources(c, cidMap || {}));

  const pick = (engine, parse) => {
    let best = { parsed: [], html: '', engine };
    for (const html of withData){
      const parsed = parse(html);
      if ((parsed?.length || 0) > best.parsed.length) best = { parsed, html, engine };
    }
    return best;
  };

  const classic = pick('classic', parseCanvasHTML);
  if (classic.parsed.length) return classic;

  const newQuizzes = pick('new-quizzes', parseNewQuizzesHTML);
  if (newQuizzes.parsed.length) return newQuizzes;

  return { parsed: [], html: withData[0] || '', engine: 'none' };
}

// 解析出 0 题时的诊断信息：以前一律报「New Quizzes（LTI/iframe）页面，MHTML 不包含题目内容」，
// 但那句话对真正的 New Quizzes 成绩页是错的（内容在存档里，只是当时没有解析器）。现在区分：
// 真·LTI 空壳（题目确实没被存下来） / 根本不是测验结果页。
function describeUnparsableArchive(candidates){
  const joined = (Array.isArray(candidates) ? candidates : [candidates]).join('\n');
  if (looksLikeNewQuizzesResults(joined)){
    return 'New Quizzes 成绩页解析失败：页面结构可能又变了（题块锚点 data-automation="sdk-item-wrapper" / "Results for question N" 没找到）';
  }
  if (/quiz_lti|external_tool|lti_iframe|tool_form/i.test(joined)){
    return '该存档只存下了 LTI 外挂壳，题目内容不在其中——请在成绩页完全渲染出题目后再保存';
  }
  return '未识别到测验题块（经典测验的 .display_question / New Quizzes 的 sdk-item-wrapper 都没有）——这可能不是测验结果页';
}

// Canvas 面包屑/页头里的"课程码 + 班号"（如 <div>AMT&amp;205 34077</div>）——即便页面标题是
// 学生姓名视图（"<作业>: 学生名"），课程码仍在面包屑里。用班号(4-6 位)兜底锚定，避免误抓正文里散落的 AMT。
function extractCourseFromHTML(html){
  const s = String(html || '');
  const m = s.match(/\b([A-Za-z]{2,6})\s*&(?:amp;)?\s*(\d{2,4})\s+\d{4,6}\b/);
  return m ? `${m[1]}&${m[2]}` : '';
}

export {
  scoreMHTMLHtmlCandidate, parseMHTML, rewriteSources,
  parseQuestionScore, hasFullCredit, hasAnyBlankAnswers, extractSelectedChoiceInfo,
  parseCanvasHTML, extractMatchingQuestionData, extractCourseFromHTML,
  parseQuizArchive, describeUnparsableArchive, parseNewQuizzesHTML, looksLikeNewQuizzesResults,
  extractFillBlanksFromAnswerGroups, extractFillBlanksByBlankId, extractTextAnswerSets, normalizeBlankSets,
  extractSelectedFillAnswers, extractSelectedFillBlanksFromAnswerGroups, extractSelectedTextAnswerSets,
  cleanAnswerText, buildFillQuestionHTML, stripDuplicatedChoicesFromQtext, normChoiceLine,
};
