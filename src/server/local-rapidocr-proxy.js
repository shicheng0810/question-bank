import { rapidOcrResultToTesseractData } from '../app/features/rapidocr-logic.js';

const DEFAULT_RAPIDOCR_URL = 'http://127.0.0.1:8765';

export async function recognizeWithRapidOcr(options = {}) {
  const imageDataUrl = String(options.imageDataUrl || '').trim();
  if (!/^data:image\//i.test(imageDataUrl)) {
    throw new Error('RapidOCR local proxy requires a data:image URL');
  }

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch is not available in this Node runtime');
  }

  const baseUrl = normalizeServerUrl(options.serverUrl || DEFAULT_RAPIDOCR_URL);
  let response;
  try {
    response = await fetchImpl(`${baseUrl}/ocr`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageDataUrl }),
    });
  } catch (error) {
    throw new Error(`RapidOCR local service is not reachable at ${baseUrl}: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`RapidOCR local service error ${response.status}: ${String(text || '').slice(0, 300)}`);
  }

  const raw = await response.json();
  return {
    engine: raw && raw.engine ? String(raw.engine) : 'rapidocr',
    model: raw && raw.model ? String(raw.model) : '',
    data: rapidOcrResultToTesseractData(raw),
  };
}

export function createRapidOcrMiddleware(options = {}) {
  return async function rapidOcrMiddleware(req, res) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }

    try {
      const body = await readJsonBody(req);
      const result = await recognizeWithRapidOcr({
        imageDataUrl: body.imageDataUrl,
        serverUrl: typeof options.getServerUrl === 'function' ? options.getServerUrl() : options.serverUrl,
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

export function createRapidOcrVitePlugin(options = {}) {
  return {
    name: 'question-bank-local-rapidocr-proxy',
    configureServer(server) {
      server.middlewares.use('/api/local/rapidocr', createRapidOcrMiddleware(options));
    },
  };
}

function normalizeServerUrl(value) {
  const text = String(value || DEFAULT_RAPIDOCR_URL).trim() || DEFAULT_RAPIDOCR_URL;
  return text.replace(/\/+$/, '');
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
