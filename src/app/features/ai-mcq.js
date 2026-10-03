import { nextUniqueGeneratedId } from './ai-mcq-logic.js';

let apiKeyEl;
let apiBaseUrlEl;
let apiModelEl;
let nDistractorsEl;
let temperatureEl;
let replaceFillEl;
let keepFillCopyEl;
let runAiMCQEl;
let dryRunAiMCQEl;
let aiStatusEl;
let out;
let getExportArrayOrNull = () => null;
let updateExportButtons = () => {};

export function initAiMCQFeature(options = {}) {
  apiKeyEl = options.apiKeyEl || null;
  apiBaseUrlEl = options.apiBaseUrlEl || null;
  apiModelEl = options.apiModelEl || null;
  nDistractorsEl = options.nDistractorsEl || null;
  temperatureEl = options.temperatureEl || null;
  replaceFillEl = options.replaceFillEl || null;
  keepFillCopyEl = options.keepFillCopyEl || null;
  runAiMCQEl = options.runAiMCQEl || null;
  dryRunAiMCQEl = options.dryRunAiMCQEl || null;
  aiStatusEl = options.aiStatusEl || null;
  out = options.out || null;
  getExportArrayOrNull = options.getExportArrayOrNull || (() => null);
  updateExportButtons = options.updateExportButtons || (() => {});
  initAiMCQ();
}

function initAiMCQ() {
  try {
  if (apiKeyEl) {
    apiKeyEl.addEventListener('input', () => {
      try { updateExportButtons(); } catch (_e) {}
    });
  }
    apiBaseUrlEl && apiBaseUrlEl.addEventListener('input', () => {
      try { updateExportButtons(); } catch (_e) {}
    });
    dryRunAiMCQEl && dryRunAiMCQEl.addEventListener('click', () => {
      const arr = getExportArrayOrNull();
      if (!arr) {
        alert('先导出 JSON 或先解析文件。');
        return;
      }
      const fills = arr.filter(q => q && (q.type === 'fill' || Array.isArray(q.blanks)));
      const blanksCount = fills.reduce((sum, q) => sum + ((q.blanks && q.blanks.length) ? q.blanks.length : 0), 0);
      setAIStatus(`检测到填空题 ${fills.length} 道，总空位 ${blanksCount} 个。`);
      alert(`检测到填空题 ${fills.length} 道（总空位 ${blanksCount} 个）。`);
    });

    runAiMCQEl && runAiMCQEl.addEventListener('click', async () => {
      const arr = getExportArrayOrNull();
      if (!arr) {
        alert('先导出 JSON 或先解析文件。');
        return;
      }

      const baseUrl = (apiBaseUrlEl && apiBaseUrlEl.value ? apiBaseUrlEl.value.trim() : 'https://api.openai.com/v1/responses');
      const apiKey = (apiKeyEl && apiKeyEl.value ? apiKeyEl.value.trim() : '');
      const model = (apiModelEl && apiModelEl.value ? apiModelEl.value.trim() : 'gpt-4o-mini');
      const nDistractors = clampInt(parseInt(nDistractorsEl && nDistractorsEl.value ? nDistractorsEl.value : '3', 10), 2, 6);
      const temperature = clampFloat(parseFloat(temperatureEl && temperatureEl.value ? temperatureEl.value : '0.8'), 0, 2);

      if (baseUrl.includes('api.openai.com') && !apiKey) {
        alert('你在使用直连 OpenAI API，但没有填写 API Key。\n如果你用的是本地代理，请把 API / 代理 URL 改成你的代理地址。');
        return;
      }

      const opts = {
        baseUrl,
        apiKey,
        model,
        nDistractors,
        temperature,
        replaceFill: !!(replaceFillEl && replaceFillEl.checked),
        keepFillCopy: !!(keepFillCopyEl && keepFillCopyEl.checked),
      };

      const fills = arr.filter(q => q && (q.type === 'fill' || Array.isArray(q.blanks)));
      if (!fills.length) {
        alert('当前 JSON 里没有填空题。');
        return;
      }

      const ok = confirm(`将调用 OpenAI API 为 ${fills.length} 道填空题生成迷惑选项（会产生费用）。继续？`);
      if (!ok) return;

      runAiMCQEl.disabled = true;
      setAIStatus('开始生成…');

      try {
        const converted = await convertAllFillToMCQ(arr, opts);
        out.value = JSON.stringify(converted, null, 2);
        out.dispatchEvent(new Event('input'));
        setAIStatus(`完成：已输出 ${converted.length} 题（原 ${arr.length} 题）。现在可以点“生成题库网页”。`);
        try { updateExportButtons(); } catch (_e) {}
        alert('AI 转换完成：已写回 out。');
      } catch (error) {
        console.error(error);
        alert('AI 转换失败：' + (error && error.message ? error.message : String(error)));
        setAIStatus('失败：' + (error && error.message ? error.message : String(error)));
      } finally {
        runAiMCQEl.disabled = false;
        try { updateExportButtons(); } catch (_e) {}
      }
    });
  } catch (error) {
    console.error(error);
  }
}

function setAIStatus(text) {
  if (aiStatusEl) aiStatusEl.textContent = text || '';
}

function clampInt(value, min, max) {
  if (Number.isNaN(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function clampFloat(value, min, max) {
  if (Number.isNaN(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function normKeepSpace(value) {
  return String(value ?? '').replace(/\u00a0/g, ' ').trim().toLowerCase().replace(/\s+/g, ' ');
}

function normNoSpace(value) {
  return normKeepSpace(value).replace(/\s+/g, '');
}

function eqLoose(a, b) {
  const a1 = normKeepSpace(a);
  const b1 = normKeepSpace(b);
  return (a1 === b1) || (normNoSpace(a) === normNoSpace(b));
}

function htmlToClozeText(questionHtml) {
  if (!questionHtml) return '';
  try {
    const text = String(questionHtml);
    let idx = 0;
    const replaced = text.replace(/<input\b[^>]*>/gi, () => {
      idx += 1;
      return ` ____(${idx}) `;
    });
    const div = document.createElement('div');
    div.innerHTML = replaced;
    return (div.textContent || '').replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

function safePickCanonical(correctList) {
  const arr = Array.isArray(correctList) ? correctList : [];
  for (const value of arr) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function convertAllFillToMCQ(arr, opts) {
  const replaceFill = !!opts.replaceFill;
  const keepFillCopy = !!opts.keepFillCopy;
  const usedIds = new Set((Array.isArray(arr) ? arr : []).map((item) => String(item && item.id || '')).filter(Boolean));

  const outArr = [];
  const fillCopies = [];

  let done = 0;
  const total = arr.filter(q => q && (q.type === 'fill' || Array.isArray(q.blanks))).length;

  for (const q of arr) {
    if (!q || !(q.type === 'fill' || Array.isArray(q.blanks))) {
      outArr.push(q);
      continue;
    }

    done += 1;
    setAIStatus(`生成中… ${done}/${total}（${q.id || ''}）`);

    const mcqs = await convertOneFillToMCQ(q, opts, usedIds);

    if (keepFillCopy) fillCopies.push(q);

    if (replaceFill) outArr.push(...mcqs);
    else outArr.push(q, ...mcqs);

    await sleep(150);
  }

  if (keepFillCopy && replaceFill) {
    outArr.push(...fillCopies);
  }
  return outArr;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function convertOneFillToMCQ(q, opts, usedIds) {
  const blanks = Array.isArray(q.blanks) ? q.blanks : [];
  const n = blanks.length;
  const cloze = htmlToClozeText(q.question_html) || (q.question || '');
  const context = (cloze || q.question || '').slice(0, 1800);

  const nd = opts.nDistractors || 3;

  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['blanks'],
    properties: {
      blanks: {
        type: 'array',
        minItems: n,
        maxItems: n,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['blank_index', 'distractors'],
          properties: {
            blank_index: { type: 'integer', minimum: 1 },
            distractors: {
              type: 'array',
              minItems: nd,
              maxItems: nd,
              items: { type: 'string' },
            },
          },
        },
      },
    },
  };

  const payload = {
    model: opts.model,
    input: [
      {
        role: 'system',
        content: `You are an expert exam-item writer for aviation maintenance / FAA regulations quizzes.
Task: For each blank in a fill-in-the-blank question, generate highly plausible multiple-choice distractors.
Rules:
- Distractors must be plausible in context.
- Same part of speech/format as the correct answer.
- Avoid jokes or "none of the above".
- Do NOT include any correct synonyms in distractors.
- For numbers: use common confusions and nearby values.
Return STRICT JSON that matches the provided schema.`,
      },
      {
        role: 'user',
        content: `Question id: ${q.id || ''}

Context with numbered blanks: ${context}

Correct acceptable answers per blank:
${blanks.map((blank, i) => `Blank ${i + 1}: ${(Array.isArray(blank) ? blank : []).join(' | ')}`).join('\n')}

Generate exactly ${nd} distractors per blank.`,
      },
    ],
    temperature: opts.temperature ?? 0.8,
    text: {
      format: {
        type: 'json_schema',
        name: 'distractors',
        strict: true,
        schema,
      },
    },
  };

  const respJson = await callOpenAIResponses(opts.baseUrl, opts.apiKey, payload);
  const outText = extractOutputText(respJson);

  let parsed = null;
  try {
    parsed = JSON.parse(outText);
  } catch {
    const match = outText && outText.match(/\{[\s\S]*\}/);
    if (match) parsed = JSON.parse(match[0]);
    else throw new Error('无法解析模型返回 JSON：' + String(outText || '').slice(0, 200));
  }

  const byIndex = new Map();
  (parsed.blanks || []).forEach(item => {
    const blankIndex = Number(item.blank_index);
    if (Number.isFinite(blankIndex)) byIndex.set(blankIndex, item.distractors || []);
  });

  const mcqs = [];
  for (let i = 0; i < n; i += 1) {
    const correctList = Array.isArray(blanks[i]) ? blanks[i] : [];
    const canonical = safePickCanonical(correctList) || '';
    const distsRaw = byIndex.get(i + 1) || [];

    const dists = [];
    for (const value of distsRaw) {
      const text = String(value || '').trim();
      if (!text) continue;
      if (correctList.some(correct => eqLoose(correct, text))) continue;
      if (dists.some(existing => eqLoose(existing, text))) continue;
      dists.push(text);
    }

    while (dists.length < nd) {
      dists.push(makeFallbackDistractor(canonical, dists.length));
    }
    dists.length = nd;

    const choices = [canonical, ...dists].filter(Boolean);
    shuffleInPlace(choices);

    const answer = choices.findIndex(choice => eqLoose(choice, canonical));
    const qText = `[Blank ${i + 1}] ${context}`;

    const item = {
      id: nextUniqueGeneratedId(`${String(q && q.id || 'fill-question')}_b${i + 1}`, usedIds),
      question: qText,
      choices,
      answer,
      source: q.source ? `${q.source} – Blank ${i + 1}` : '',
      image: q.image,
      from_fill_id: q.id,
      accepted: correctList,
    };
    if (!item.image) delete item.image;
    mcqs.push(item);
  }

  return mcqs;
}

function makeFallbackDistractor(correct, k) {
  const text = String(correct || '').trim();
  if (!text) return `Option ${k + 1}`;
  if (/^\d+(\.\d+)?$/.test(text)) {
    const value = parseFloat(text);
    const candidates = [value + 1, value - 1, value * 2, Math.max(0, value / 2), value + 10, Math.max(0, value - 10)];
    return String(candidates[k % candidates.length]);
  }
  const variants = [
    text + 's',
    'non-' + text,
    text.replace(/ing$/, 'ed'),
    text.replace(/ed$/, 'ing'),
    text.replace(/\bflight\b/i, 'operating'),
    text.replace(/\boperating\b/i, 'flight'),
  ];
  return variants[k % variants.length];
}

async function callOpenAIResponses(baseUrl, apiKey, payload) {
  const url = baseUrl || 'https://api.openai.com/v1/responses';
  const headers = { 'Content-Type': 'application/json' };
  if (url.includes('api.openai.com')) headers.Authorization = 'Bearer ' + apiKey;

  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API error ${res.status}: ${text.slice(0, 300)}`);
  }
  return await res.json();
}

function extractOutputText(respJson) {
  try {
    const out = respJson && respJson.output ? respJson.output : [];
    for (const item of out) {
      if (!item || item.type !== 'message') continue;
      const content = item.content || [];
      for (const entry of content) {
        if (entry && entry.type === 'output_text' && typeof entry.text === 'string') return entry.text;
      }
    }
  } catch (_e) {}
  return JSON.stringify(respJson || {});
}
