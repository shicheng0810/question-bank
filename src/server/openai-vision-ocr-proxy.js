import {
  buildOpenAiVisionOcrRequest,
  parseOpenAiVisionOcrResponse,
} from '../app/features/openai-vision-ocr-logic.js';

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

export async function recognizeQuestionScreenshot(options = {}) {
  const apiKey = String(options.apiKey || '').trim();
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured for the local extractor proxy');
  }
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch is not available in this Node runtime');
  }

  const request = buildOpenAiVisionOcrRequest({
    imageDataUrl: options.imageDataUrl,
    model: options.model,
    detail: options.detail,
    reasoningEffort: options.reasoningEffort,
  });

  const response = await fetchImpl(OPENAI_RESPONSES_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`OpenAI API error ${response.status}: ${String(text || '').slice(0, 300)}`);
  }

  const respJson = await response.json();
  return {
    responseId: respJson && respJson.id ? String(respJson.id) : '',
    model: request.model,
    extraction: parseOpenAiVisionOcrResponse(respJson),
  };
}

export function createOpenAiVisionOcrMiddleware(options = {}) {
  return async function openAiVisionOcrMiddleware(req, res) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }

    try {
      const body = await readJsonBody(req);
      const result = await recognizeQuestionScreenshot({
        imageDataUrl: body.imageDataUrl,
        model: body.model,
        detail: body.detail,
        reasoningEffort: body.reasoningEffort,
        apiKey: typeof options.getApiKey === 'function' ? options.getApiKey() : options.apiKey,
        fetchImpl: options.fetchImpl,
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

export function createOpenAiVisionOcrVitePlugin(options = {}) {
  return {
    name: 'question-bank-openai-vision-ocr-proxy',
    configureServer(server) {
      server.middlewares.use('/api/openai/vision-ocr', createOpenAiVisionOcrMiddleware(options));
    },
  };
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}
