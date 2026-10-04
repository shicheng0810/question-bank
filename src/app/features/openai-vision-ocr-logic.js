export const DEFAULT_OPENAI_VISION_MODEL = 'gpt-5.4-mini';
export const DEFAULT_OPENAI_VISION_FALLBACK_MODEL = 'gpt-5.4-nano';
export const DEFAULT_OPENAI_VISION_DETAIL = 'high';
export const DEFAULT_OPENAI_VISION_REASONING = 'low';

const QUESTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'kind',
    'question',
    'choices',
    'answer_indices',
    'confidence',
    'needs_review',
    'review_reasons',
    'raw_visible_text',
  ],
  properties: {
    kind: {
      type: 'string',
      enum: ['choice', 'multi_choice', 'fill', 'matching', 'unknown'],
    },
    question: { type: 'string' },
    choices: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'text', 'is_correct'],
        properties: {
          label: { type: 'string' },
          text: { type: 'string' },
          is_correct: { type: 'boolean' },
        },
      },
    },
    answer_indices: {
      type: 'array',
      items: { type: 'integer' },
    },
    blanks: {
      type: 'array',
      items: {
        type: 'array',
        items: { type: 'string' },
      },
    },
    pairs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['left', 'right'],
        properties: {
          left: { type: 'string' },
          right: { type: 'string' },
        },
      },
    },
    confidence: { type: 'number' },
    needs_review: { type: 'boolean' },
    review_reasons: {
      type: 'array',
      items: { type: 'string' },
    },
    raw_visible_text: { type: 'string' },
  },
};

export function buildOpenAiVisionOcrRequest(options = {}) {
  const imageDataUrl = String(options.imageDataUrl || '').trim();
  if (!/^data:image\//i.test(imageDataUrl)) {
    throw new Error('OpenAI vision OCR requires a data:image URL');
  }

  return {
    model: options.model || DEFAULT_OPENAI_VISION_MODEL,
    reasoning: { effort: options.reasoningEffort || DEFAULT_OPENAI_VISION_REASONING },
    input: [
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: buildVisionPrompt(options),
          },
          {
            type: 'input_image',
            image_url: imageDataUrl,
            detail: options.detail || DEFAULT_OPENAI_VISION_DETAIL,
          },
        ],
      },
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'question_bank_screenshot',
        strict: true,
        schema: QUESTION_SCHEMA,
      },
    },
  };
}

export function parseOpenAiVisionOcrResponse(respJson) {
  const text = extractOpenAiOutputText(respJson);
  const raw = parseJsonObject(text);
  const choices = normalizeChoices(raw);
  const answerIndexes = Array.isArray(raw.answer_indices)
    ? raw.answer_indices.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value >= 0)
    : [];

  if (answerIndexes.length) {
    choices.forEach((choice, index) => {
      choice.is_correct = answerIndexes.includes(index);
    });
  }

  const kind = normalizeKind(raw.kind, choices);
  const confidence = clamp01(raw.confidence);
  const needsReview = Boolean(raw.needs_review)
    || confidence < 0.6
    || (kind === 'choice' && choices.length < 2);

  return {
    kind,
    question: cleanText(raw.question),
    choices,
    answer_indices: choices.map((choice, index) => (choice.is_correct ? index : -1)).filter((index) => index >= 0),
    blanks: Array.isArray(raw.blanks) ? raw.blanks.map((set) => Array.isArray(set) ? set.map(cleanText).filter(Boolean) : []) : [],
    pairs: Array.isArray(raw.pairs)
      ? raw.pairs.map((pair) => ({
        left: cleanText(pair && pair.left),
        right: cleanText(pair && pair.right),
      })).filter((pair) => pair.left || pair.right)
      : [],
    confidence,
    needs_review: needsReview,
    review_reasons: Array.isArray(raw.review_reasons) ? raw.review_reasons.map(cleanText).filter(Boolean) : [],
    raw_visible_text: cleanText(raw.raw_visible_text),
  };
}

export function openAiVisionExtractionToParsedQuestion(extraction, options = {}) {
  const kind = normalizeKind(extraction && extraction.kind, extraction && extraction.choices);
  const rawText = cleanText((extraction && extraction.raw_visible_text) || (extraction && extraction.question) || '');
  const common = {
    num: 1,
    idSuffix: '1',
    sourceNum: '1',
    ocrSourceImage: options.dataUrl || '',
    images: [],
    uploadedImages: [],
    expectedImageCount: 0,
    missingImageCount: 0,
    missingImageSources: [],
    importedId: '',
    importedSource: '',
    preserveOriginalMeta: false,
    ocrText: rawText,
  };

  const ocrMeta = {
    questionKind: 'openai-vision',
    aiVisionUsed: true,
    aiVisionModel: options.model || DEFAULT_OPENAI_VISION_MODEL,
    aiVisionConfidence: clamp01(extraction && extraction.confidence),
    aiVisionNeedsReview: Boolean(extraction && extraction.needs_review),
    aiVisionReviewReasons: Array.isArray(extraction && extraction.review_reasons) ? extraction.review_reasons : [],
    rawText: options.debug ? rawText : undefined,
  };

  if (kind === 'matching') {
    return {
      ...common,
      kind: 'matching',
      qtext: cleanText(extraction && extraction.question) || '(OpenAI 未提取出题干)',
      pairs: Array.isArray(extraction && extraction.pairs) ? extraction.pairs : [],
      choicePool: [],
      scoreInfo: null,
      ocrMeta,
    };
  }

  if (kind === 'fill') {
    const blanks = Array.isArray(extraction && extraction.blanks) && extraction.blanks.length
      ? extraction.blanks
      : [[]];
    return {
      ...common,
      kind: 'fill',
      qtext: cleanText(extraction && extraction.question) || '(OpenAI 未提取出题干)',
      blanks,
      qhtml: buildFillQuestionHTML(cleanText(extraction && extraction.question), blanks.length),
      scoreInfo: null,
      answerDerivedFromScore: false,
      ocrMeta,
    };
  }

  const choices = normalizeChoices(extraction).map((choice) => ({
    text: choice.text,
    isCorrect: !!choice.is_correct,
  }));
  const correctCount = choices.filter((choice) => choice.isCorrect).length;

  return {
    ...common,
    kind: 'choice',
    isMulti: kind === 'multi_choice' || correctCount > 1,
    qtext: cleanText(extraction && extraction.question) || '(OpenAI 未提取出题干)',
    choices,
    scoreInfo: null,
    answerDerivedFromScore: false,
    ocrMeta,
  };
}

export function shouldUseOpenAiVisionFallback(parsed, options = {}) {
  const questions = Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  if (!questions.length) return true;
  const q = questions[0];
  if (q && q.ocrMeta && q.ocrMeta.aiVisionUsed) return false;

  const questionText = cleanText(q && q.qtext);
  if (!questionText || /OCR\s*未|未提取出题干/i.test(questionText)) return true;

  if (q.kind === 'choice') {
    const choices = Array.isArray(q.choices) ? q.choices : [];
    if (choices.length < 3) return true;
    if (choices.some((choice) => !cleanText(choice && choice.text))) return true;
    const hasCorrect = choices.some((choice) => !!(choice && choice.isCorrect));
    if (options.requireAnswer !== false && !hasCorrect) return true;
  }

  const metaKind = cleanText(q && q.ocrMeta && q.ocrMeta.questionKind);
  if (/fallback|rawtext/i.test(metaKind)) return true;
  if (q && q.ocrMeta && q.ocrMeta.aiRepairError) return true;
  return false;
}

export function extractOpenAiOutputText(respJson) {
  if (typeof (respJson && respJson.output_text) === 'string') return respJson.output_text;
  const chatContent = respJson
    && Array.isArray(respJson.choices)
    && respJson.choices[0]
    && respJson.choices[0].message
    && respJson.choices[0].message.content;
  if (typeof chatContent === 'string') return chatContent;
  if (Array.isArray(chatContent)) {
    return chatContent.map((part) => typeof part === 'string' ? part : (part && (part.text || part.content || ''))).join('');
  }
  if (Array.isArray(respJson && respJson.output)) {
    return respJson.output.map((item) => {
      if (typeof item === 'string') return item;
      if (Array.isArray(item && item.content)) {
        return item.content.map((part) => part && (part.text || part.output_text || part.content || '')).join('');
      }
      return item && (item.text || item.output_text || item.content || '');
    }).join('');
  }
  return '';
}

function buildVisionPrompt() {
  return [
    'Extract exactly one quiz question from this screenshot.',
    'Return only the JSON object required by the schema.',
    'Do not solve the question from world knowledge.',
    'Mark choices as correct only when the screenshot visibly indicates the correct/selected answer with highlight, check mark, arrow, label, or review feedback.',
    'If the correct answer is not visible, leave all is_correct values false, answer_indices empty, needs_review true, and add a review reason.',
    'Preserve the original language, spelling, units, symbols, and option order.',
    'Use kind="multi_choice" only when multiple correct answers are visibly indicated.',
  ].join(' ');
}

function normalizeKind(kind, choices) {
  const value = cleanText(kind);
  if (value === 'multi_choice') return 'multi_choice';
  if (value === 'fill') return 'fill';
  if (value === 'matching') return 'matching';
  if (value === 'unknown') return 'unknown';
  return Array.isArray(choices) && choices.length ? 'choice' : 'unknown';
}

function normalizeChoices(raw) {
  const values = Array.isArray(raw && raw.choices) ? raw.choices : [];
  return values.map((entry, index) => {
    if (typeof entry === 'string') {
      return { label: labelFor(index), text: cleanText(entry), is_correct: false };
    }
    return {
      label: cleanText(entry && entry.label) || labelFor(index),
      text: cleanText(entry && entry.text),
      is_correct: Boolean(entry && entry.is_correct),
    };
  }).filter((choice) => choice.text);
}

function parseJsonObject(text) {
  const value = String(text || '').trim();
  if (!value) throw new Error('OpenAI vision OCR response is empty');
  try {
    return JSON.parse(value);
  } catch (_error) {
    const match = value.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('OpenAI vision OCR response is not valid JSON');
    return JSON.parse(match[0]);
  }
}

function cleanText(value) {
  return String(value == null ? '' : value)
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function labelFor(index) {
  return String.fromCharCode(65 + Math.max(0, index));
}

function buildFillQuestionHTML(question, blankCount) {
  const count = Math.max(1, Number(blankCount) || 1);
  const text = cleanText(question) || '(OpenAI 未提取出题干)';
  if (/_{2,}|\[\s*\]/.test(text)) return text;
  return `${text} ${Array.from({ length: count }, () => '<input>').join(' ')}`;
}
