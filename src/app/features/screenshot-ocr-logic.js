const DEFAULT_MODEL = 'deepseek-v4-flash';

export function ocrBinaryPixelValue(r, g, b) {
  const red = Number(r) || 0;
  const green = Number(g) || 0;
  const blue = Number(b) || 0;
  const lum = 0.299 * red + 0.587 * green + 0.114 * blue;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const sat = max ? (max - min) / max : 0;

  const darkInk = lum < 190;
  const saturatedInk = sat > 0.35 && lum < 210;
  return darkInk || saturatedInk ? 0 : 255;
}

export function findUnlabeledChoiceRowSplit(rows, options = {}) {
  const cleanRows = Array.from(rows || [])
    .filter((row) => row && row.bbox && normalizeText(row.text));
  if (cleanRows.length < 3) return null;

  const imageWidth = Math.max(1, Number(options.imageWidth) || 1);
  let best = null;
  for (let start = 1; start <= cleanRows.length - 2; start += 1) {
    const questionRows = cleanRows.slice(0, start);
    const optionRows = cleanRows.slice(start);
    if (optionRows.length < 2 || optionRows.length > 6) continue;

    const optionTexts = optionRows.map((row) => normalizeText(row.text));
    const x0s = optionRows.map((row) => Number(row.bbox && row.bbox.x0) || 0);
    const maxDx = Math.max(...x0s) - Math.min(...x0s);
    const maxLen = Math.max(...optionTexts.map((text) => text.length));
    const avgLen = optionTexts.reduce((sum, text) => sum + text.length, 0) / optionTexts.length;
    if (maxDx > Math.max(42, imageWidth * 0.08)) continue;
    if (maxLen > 180 || avgLen > 130) continue;
    if (optionTexts.some((text) => /[?？]\s*$/.test(text) && !looksLikeChoiceLine(text))) continue;

    const labeledCount = optionTexts.filter(looksLikeChoiceLine).length;
    const questionText = normalizeText(questionRows.map((row) => row.text).join(' '));
    const questionEndBonus = /[?？:：]\s*$/.test(questionText) ? 40 : 0;
    const boundaryGap = rowGap(cleanRows[start - 1], cleanRows[start]);
    const previousGap = start > 1 ? rowGap(cleanRows[start - 2], cleanRows[start - 1]) : 0;
    const gapBonus = Math.max(0, Math.min(45, boundaryGap - previousGap));
    const questionPenalty = Math.max(0, questionRows.length - 2) * 8;
    const score = optionRows.length * 18
      + labeledCount * 18
      + questionEndBonus
      + gapBonus
      - maxDx * 0.8
      - avgLen * 0.04
      - start
      - questionPenalty;

    if (!best || score > best.score) {
      best = { score, questionRows, optionRows };
    }
  }

  return best ? {
    questionRows: best.questionRows,
    optionRows: best.optionRows,
    score: best.score,
  } : null;
}

export function buildRapidOcrDebugMeta(recognition, options = {}) {
  if (!(recognition && recognition.rapidOcr)) return {};

  const data = recognition.data && typeof recognition.data === 'object' ? recognition.data : {};
  const meta = data.rapidOcrMeta && typeof data.rapidOcrMeta === 'object' ? data.rapidOcrMeta : {};
  const lines = normalizeOcrTextList(data.lines, options.maxLines || 80);
  const words = normalizeOcrTextList(data.words, options.maxWords || 200);
  const lineCount = finiteCount(meta.lineCount, lines.length);
  const wordCount = finiteCount(meta.wordCount, words.length);

  return {
    rapidOcrUsed: true,
    rapidOcrModel: String(recognition.model || ''),
    rapidOcrLineCount: lineCount,
    rapidOcrWordCount: wordCount,
    rapidOcrLineText: lines,
    rapidOcrWordText: words,
  };
}

export function repairOcrQuestionText(raw) {
  let text = String(raw || '');
  if (!text.trim()) return text;
  text = text.replace(/^\s*(?:Question|Problem|Q\.?)\s*\d+\s*[:.\-)]\s*/i, '');
  text = text.replace(/^\s*\d+\s*[:.\-)]\s+/, '');
  text = text.replace(/ /g, ' ');
  text = text.replace(/[ \t]+\n/g, '\n');
  text = text.replace(/[ \t]{2,}/g, ' ');
  text = text.replace(/\n{3,}/g, '\n\n');
  text = removeOcrFragmentTokens(text);
  return text.trim();
}

export function repairOcrChoiceText(raw) {
  let text = String(raw || '');
  if (!text.trim()) return text;
  text = text.replace(/^\s*[(\[]?\s*[A-Ha-h]\s*[)\].:\-]\s+/, '');
  text = text.replace(/ /g, ' ');
  text = text.replace(/\s+/g, ' ');
  text = removeOcrFragmentTokens(text);
  return text.trim();
}

export function buildDeepSeekOcrRepairPayload(parsed, options = {}) {
  const choices = Array.isArray(parsed && parsed.choices)
    ? parsed.choices.map((choice, index) => ({
      index,
      text: String(choice && choice.text || '').trim(),
    }))
    : [];
  const body = {
    question: String(parsed && parsed.qtext || '').trim(),
    choices,
    raw_text: String(parsed && parsed.ocrMeta && parsed.ocrMeta.rawText || '').trim(),
  };
  return {
    model: options.model || DEFAULT_MODEL,
    temperature: 0,
    response_format: { type: 'json_object' },
    thinking: { type: 'enabled' },
    reasoning_effort: options.reasoningEffort || 'high',
    messages: [
      {
        role: 'system',
        content: [
          'You repair OCR errors for English aviation maintenance quiz questions.',
          'CHARACTER repair: fix obvious misreads (O/0, l/1/I, m/rn), broken spacing, stray punctuation.',
          'BOUNDARY repair: OCR sometimes splits a question wrong, treating a short connector word (e.g. "with", "in", "a", "are", "is", "the") as a separate choice when it actually belongs at the end of the question stem.',
          'When the FIRST choice (index 0) is such a stray fragment:',
          ' (a) append that fragment to the end of the question text (with a space),',
          ' (b) set that choice slot to "" (empty string) to signal it should be dropped.',
          'Do the same for the LAST choice if it is similarly a stray fragment.',
          'Preserve original meaning. Do not paraphrase, translate, or reorder real choices.',
          'Return STRICT JSON only: {"question":"...","choices":["...","..."]}.',
          'choices length MUST equal the input choices length; use "" for slots you intentionally cleared.',
          'If the input is already clean, return it unchanged.',
        ].join(' '),
      },
      {
        role: 'user',
        content: JSON.stringify(body),
      },
    ],
  };
}

export function parseDeepSeekOcrRepairResponse(respJson, choiceCount) {
  const content = extractChatContent(respJson);
  let raw = null;
  try {
    raw = JSON.parse(content);
  } catch (_error) {
    const match = String(content || '').match(/\{[\s\S]*\}/);
    if (!match) throw new Error('DeepSeek OCR repair response is not valid JSON');
    raw = JSON.parse(match[0]);
  }

  const repairedQuestion = typeof (raw && raw.question) === 'string' ? raw.question.trim() : '';
  const repairedChoices = Array.isArray(raw && raw.choices)
    ? raw.choices.map((value) => String(value || '').trim())
    : [];

  const expected = Number(choiceCount);
  if (Number.isFinite(expected) && expected > 0 && repairedChoices.length !== expected) {
    throw new Error(
      `DeepSeek OCR repair returned ${repairedChoices.length} choices, expected ${expected}`,
    );
  }

  return { question: repairedQuestion, choices: repairedChoices };
}

export function applyDeepSeekOcrRepair(parsed, repair) {
  if (!parsed || !repair) return parsed;
  const next = { ...parsed };
  if (repair.question) {
    next.qtext = repair.question;
  }
  if (Array.isArray(repair.choices) && Array.isArray(parsed.choices)) {
    const remapped = [];
    let droppedCount = 0;
    parsed.choices.forEach((choice, index) => {
      const candidate = repair.choices[index];
      const isDropSignal = typeof candidate === 'string' && candidate.trim() === '';
      if (isDropSignal) {
        droppedCount += 1;
        return;
      }
      const text = typeof candidate === 'string' && candidate ? candidate : (choice && choice.text) || '';
      remapped.push({ ...choice, text });
    });
    if (remapped.length >= 2) {
      next.choices = remapped;
      if (droppedCount > 0) {
        next.ocrMeta = {
          ...(next.ocrMeta || {}),
          boundaryFragmentsRemoved: droppedCount,
        };
      }
    } else {
      next.choices = parsed.choices.map((choice, index) => {
        const candidate = repair.choices[index];
        const text = typeof candidate === 'string' && candidate ? candidate : (choice && choice.text) || '';
        return { ...choice, text };
      });
    }
  }
  return next;
}

function normalizeText(value) {
  return String(value == null ? '' : value)
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikeChoiceLine(value) {
  const s = normalizeText(value);
  if (!s) return false;
  if (/^\s*[A-H][\)\.、\:：-]\s+/i.test(s)) return true;
  if (/^\s*[1-9][0-9]?\s*[\)）、\:：-]\s+/.test(s)) return true;
  if (/^\s*[1-9][0-9]?\.(?=\s)/.test(s)) return true;
  if (/^\s*(?:\d+[\d,]*\.\d+|\d+[\d,]*|\d+\/\d+)\s+\S+/.test(s)) return true;
  return false;
}

function rowGap(prev, next) {
  const prevY = Number(prev && prev.bbox && prev.bbox.y1);
  const nextY = Number(next && next.bbox && next.bbox.y0);
  if (!Number.isFinite(prevY) || !Number.isFinite(nextY)) return 0;
  return Math.max(0, nextY - prevY);
}

function finiteCount(value, fallback) {
  const n = Number(value);
  if (Number.isFinite(n) && n >= 0) return Math.round(n);
  return fallback;
}

function normalizeOcrTextList(items, limit) {
  const max = Math.max(1, Number(limit) || 1);
  return Array.from(Array.isArray(items) ? items : [])
    .map((item) => normalizeText(item && (item.text || item.symbol || item.rec_txt || item.recText)))
    .filter(Boolean)
    .slice(0, max);
}

function removeOcrFragmentTokens(value) {
  const tokens = String(value || '').split(/\s+/).filter(Boolean);
  if (tokens.length < 3) return String(value || '');
  const kept = [];
  tokens.forEach((token, index) => {
    const prev = kept[kept.length - 1] || '';
    const next = tokens[index + 1] || '';
    const bare = token.replace(/[^A-Za-z]/g, '');
    const isSingleLetter = bare.length === 1 && token.length <= 2;
    const repeatsPrevTail = isSingleLetter && prev && prev.replace(/[^A-Za-z]/g, '').toLowerCase().endsWith(bare.toLowerCase());
    const repeatsNextHead = isSingleLetter && next && next.replace(/[^A-Za-z]/g, '').toLowerCase().startsWith(bare.toLowerCase());
    if (isSingleLetter && (repeatsPrevTail || repeatsNextHead)) return;
    kept.push(token.replace(/\bof[1lI]\b/g, 'of'));
  });
  return kept.join(' ');
}

function extractChatContent(respJson) {
  const content = respJson
    && Array.isArray(respJson.choices)
    && respJson.choices[0]
    && respJson.choices[0].message
    && respJson.choices[0].message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((entry) => {
      if (typeof entry === 'string') return entry;
      return entry && (entry.text || entry.content || '');
    }).join('');
  }
  return JSON.stringify(respJson || {});
}
