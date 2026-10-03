const DEFAULT_MODEL = 'deepseek-v4-flash';

export function buildDeepSeekAnswerFillPayload(q, options = {}) {
  const kind = normalizeKind(q && q.kind);
  const source = String(options.source || (q && (q.importedSource || q.source || '')) || '').trim();
  const body = {
    kind,
    question: String(q && (q.qtext || q.question) || '').trim(),
    source,
    ocr_text: String(q && q.ocrText || '').trim(),
  };

  if (kind === 'choice') {
    body.is_multi = !!(q && q.isMulti);
    body.choices = Array.isArray(q && q.choices)
      ? q.choices.map((choice, index) => ({
        index,
        text: String(choice && choice.text || '').trim(),
      }))
      : [];
  } else if (kind === 'fill') {
    body.blank_count = Math.max(1, Array.isArray(q && q.blanks) ? q.blanks.length : 1);
    body.question_html = stripHtmlInputs(String(q && q.qhtml || ''));
  }

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
          'You answer aviation maintenance quiz questions.',
          'Use only the given question, choices, source, and OCR text.',
          'Return strict JSON only.',
          'For choice questions return {"answer_indexes":[0-based indexes],"confidence":0..1,"explanation":"short reason"}.',
          'For fill questions return {"blanks":[["accepted answer"]],"confidence":0..1,"explanation":"short reason"}.',
          'Do not translate the question or choices. Do not change choice order.',
        ].join(' '),
      },
      {
        role: 'user',
        content: JSON.stringify(body),
      },
    ],
  };
}

export function parseDeepSeekAnswerFillResponse(respJson, q) {
  const content = extractChatContent(respJson);
  let raw = null;
  try {
    raw = JSON.parse(content);
  } catch (_error) {
    const match = String(content || '').match(/\{[\s\S]*\}/);
    if (!match) throw new Error('DeepSeek answer response is not valid JSON');
    raw = JSON.parse(match[0]);
  }

  const kind = normalizeKind(q && q.kind);
  const confidence = clampConfidence(raw && raw.confidence);
  const explanation = String(raw && raw.explanation || '').trim();

  if (kind === 'choice') {
    const choiceCount = Array.isArray(q && q.choices) ? q.choices.length : 0;
    const values = Array.isArray(raw && raw.answer_indexes)
      ? raw.answer_indexes
      : Array.isArray(raw && raw.answerIndexes)
        ? raw.answerIndexes
        : raw && raw.answer_index != null
          ? [raw.answer_index]
          : [];
    const answerIndexes = normalizeAnswerIndexes(values, choiceCount);
    if (!answerIndexes.length) throw new Error('DeepSeek answer response has no answer indexes');
    if (!(q && q.isMulti) && answerIndexes.length !== 1) {
      throw new Error('DeepSeek answer response returned multiple indexes for single-choice question');
    }
    return { kind: 'choice', answerIndexes, confidence, explanation };
  }

  if (kind === 'fill') {
    const expected = Math.max(1, Array.isArray(q && q.blanks) ? q.blanks.length : 1);
    const blanks = normalizeBlankAnswers(raw && raw.blanks, expected);
    if (!blanks.some((answers) => answers.length)) throw new Error('DeepSeek answer response has no fill answers');
    return { kind: 'fill', blanks, confidence, explanation };
  }

  throw new Error(`Unsupported question kind for AI answer fill: ${kind}`);
}

export function applyAiAnswerSuggestion(q, suggestion, meta = {}) {
  const usable = questionCanUseAiAnswer(q);
  if (!usable.ok) {
    setAiAnswerMeta(q, meta, suggestion, usable.reason);
    return { applied: false, reason: usable.reason };
  }

  const kind = normalizeKind(q && q.kind);
  if (kind === 'choice') {
    const indexes = normalizeAnswerIndexes(suggestion && suggestion.answerIndexes, (q.choices || []).length);
    if (!indexes.length) {
      setAiAnswerMeta(q, meta, suggestion, 'invalid-answer');
      return { applied: false, reason: 'invalid-answer' };
    }
    if (!q.isMulti && indexes.length !== 1) {
      setAiAnswerMeta(q, meta, suggestion, 'invalid-single-choice-answer');
      return { applied: false, reason: 'invalid-single-choice-answer' };
    }
    q.choices.forEach((choice, index) => {
      choice.isCorrect = indexes.includes(index);
    });
    setAiAnswerMeta(q, meta, suggestion, '');
    return { applied: true, reason: 'applied' };
  }

  if (kind === 'fill') {
    const expected = Math.max(1, Array.isArray(q.blanks) ? q.blanks.length : 1);
    const blanks = normalizeBlankAnswers(suggestion && suggestion.blanks, expected);
    if (!blanks.some((answers) => answers.length)) {
      setAiAnswerMeta(q, meta, suggestion, 'invalid-fill-answer');
      return { applied: false, reason: 'invalid-fill-answer' };
    }
    q.blanks = blanks;
    setAiAnswerMeta(q, meta, suggestion, '');
    return { applied: true, reason: 'applied' };
  }

  setAiAnswerMeta(q, meta, suggestion, 'unsupported-kind');
  return { applied: false, reason: 'unsupported-kind' };
}

export function questionCanUseAiAnswer(q) {
  const kind = normalizeKind(q && q.kind);
  if (kind === 'choice') {
    if (!Array.isArray(q && q.choices) || !q.choices.length) return { ok: false, reason: 'missing-choices' };
    if ((q.choices || []).some((choice) => choice && choice.isCorrect)) return { ok: false, reason: 'already-has-answer' };
    return { ok: true, reason: 'missing-answer' };
  }
  if (kind === 'fill') {
    const blanks = Array.isArray(q && q.blanks) ? q.blanks : [];
    if (blanks.some((answers) => Array.isArray(answers) && answers.some((value) => String(value || '').trim()))) {
      return { ok: false, reason: 'already-has-answer' };
    }
    return { ok: true, reason: 'missing-answer' };
  }
  return { ok: false, reason: 'unsupported-kind' };
}

export async function callDeepSeekAnswerFill(baseUrl, apiKey, payload, fetchImpl = fetch) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
  const res = await fetchImpl(baseUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`DeepSeek API error ${res.status}: ${text.slice(0, 200)}`);
  }
  return await res.json();
}

function normalizeKind(kind) {
  const value = String(kind || 'choice').toLowerCase();
  if (value === 'fill') return 'fill';
  if (value === 'matching') return 'matching';
  return 'choice';
}

function normalizeAnswerIndexes(values, choiceCount) {
  const max = Number(choiceCount) || 0;
  const out = [];
  for (const raw of Array.isArray(values) ? values : []) {
    const index = Number(raw);
    if (!Number.isInteger(index)) throw new Error('DeepSeek answer index is not an integer');
    if (index < 0 || index >= max) throw new Error(`DeepSeek answer index out of range: ${index}`);
    if (!out.includes(index)) out.push(index);
  }
  return out;
}

function normalizeBlankAnswers(values, expectedCount) {
  const expected = Math.max(1, Number(expectedCount) || 1);
  if (!Array.isArray(values)) throw new Error('DeepSeek fill response must include blanks array');
  if (values.length !== expected) {
    throw new Error(`DeepSeek fill response blank count mismatch: expected ${expected}, got ${values.length}`);
  }
  return values.map((answers) => {
    const arr = Array.isArray(answers) ? answers : [answers];
    return Array.from(new Set(arr.map((value) => String(value || '').trim()).filter(Boolean)));
  });
}

function clampConfidence(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.max(0, Math.min(1, num));
}

function setAiAnswerMeta(q, meta, suggestion, error) {
  if (!q) return;
  q.aiAnswerMeta = {
    provider: meta.provider || 'deepseek',
    model: meta.model || DEFAULT_MODEL,
    confidence: suggestion && suggestion.confidence != null ? suggestion.confidence : null,
    explanation: String(suggestion && suggestion.explanation || '').trim(),
    error: error || '',
  };
}

function stripHtmlInputs(html) {
  return String(html || '')
    .replace(/<input\b[^>]*>/gi, '[blank]')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractChatContent(respJson) {
  const choiceContent = respJson
    && Array.isArray(respJson.choices)
    && respJson.choices[0]
    && respJson.choices[0].message
    && respJson.choices[0].message.content;
  if (typeof choiceContent === 'string') return choiceContent;
  if (Array.isArray(choiceContent)) {
    return choiceContent.map((entry) => {
      if (typeof entry === 'string') return entry;
      return entry && (entry.text || entry.content || '');
    }).join('');
  }
  return JSON.stringify(respJson || {});
}
