const EXACT_ROUTES = new Map([
  ['/api/local/publish-bank', new Set(['GET', 'POST'])],
  ['/api/local/bank-admin', new Set(['POST'])],
  ['/api/local/users', new Set(['GET', 'POST'])],
  ['/api/local/special-banks', new Set(['GET', 'POST'])],
  ['/api/local/rapidocr', new Set(['POST'])],
  ['/api/openai/vision-ocr', new Set(['POST'])],
]);

const PROTECTED_PREFIXES = ['/api/local', '/api/openai'];
const FETCH_METADATA_HEADERS = ['sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest'];

function requirePort(port) {
  const value = Number(port);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error('local request guard requires a port from 1 through 65535');
  }
  return value;
}

function headerValues(req, name) {
  const lowerName = name.toLowerCase();
  if (Array.isArray(req.rawHeaders)) {
    const values = [];
    for (let index = 0; index + 1 < req.rawHeaders.length; index += 2) {
      if (String(req.rawHeaders[index]).toLowerCase() === lowerName) values.push(String(req.rawHeaders[index + 1]));
    }
    return values;
  }
  const value = req.headers?.[lowerName];
  if (Array.isArray(value)) return value.map(String);
  return value === undefined ? [] : [String(value)];
}

function exactlyOneHeader(req, name) {
  const values = headerValues(req, name);
  return values.length === 1 ? values[0] : null;
}

function requestPath(rawTarget) {
  const raw = String(rawTarget || '');
  if (!raw || raw.includes('#')) return { path: '', invalid: true };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      const absolute = new URL(raw);
      return { path: absolute.pathname, invalid: true };
    } catch {
      return { path: '', invalid: true };
    }
  }
  if (!raw.startsWith('/') || raw.startsWith('//')) return { path: '', invalid: true };
  const path = raw.slice(0, raw.search(/[?#]/) === -1 ? raw.length : raw.search(/[?#]/));
  return { path, invalid: /[\\%]/.test(path) || path.includes('/./') || path.includes('/../') };
}

function looksProtected(path) {
  return PROTECTED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function potentiallyProtected(rawTarget, parsed) {
  if (looksProtected(parsed.path)) return true;
  try {
    const raw = String(rawTarget || '');
    const path = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? new URL(raw).pathname : raw.split(/[?#]/, 1)[0];
    const decoded = decodeURIComponent(path);
    return [path, decoded].some((candidate) => (
      looksProtected(candidate) || /^\/+api\/(?:local|openai)(?:\/|%|\\|$)/i.test(candidate)
    ));
  } catch {
    return /^\/?api(?:%2f|\/)(?:local|openai)/i.test(String(rawTarget || ''));
  }
}

function isLoopbackPeer(req) {
  const address = String(req.socket?.remoteAddress || req.connection?.remoteAddress || '').toLowerCase();
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function hasExactFetchMetadata(req) {
  const site = exactlyOneHeader(req, 'sec-fetch-site');
  const mode = exactlyOneHeader(req, 'sec-fetch-mode');
  const destination = exactlyOneHeader(req, 'sec-fetch-dest');
  return site === 'same-origin' && (mode === 'cors' || mode === 'same-origin') && destination === 'empty';
}

function reject(res, status, code) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('vary', 'Origin');
  res.end(JSON.stringify({ ok: false, error: code }));
}

function acceptsJson(req) {
  const contentType = exactlyOneHeader(req, 'content-type');
  return contentType !== null && /^application\/json\s*(?:;\s*charset\s*=\s*[^;\s]+\s*)?$/i.test(contentType);
}

/**
 * Guard only controls browser reachability of local privileged proxies. It is
 * intentionally not a local-process authentication mechanism: binding the
 * socket to loopback is the network boundary; a process can forge headers.
 */
export function createLocalRequestGuard({ host = '127.0.0.1', port = 5173 } = {}) {
  if (host !== '127.0.0.1') {
    throw new Error('local request guard host must be 127.0.0.1');
  }
  const normalizedPort = requirePort(port);
  const expectedHost = `${host}:${normalizedPort}`;
  const expectedOrigin = `http://${expectedHost}`;

  return function localRequestGuard(req, res, next) {
    const parsed = requestPath(req.url);
    if (!potentiallyProtected(req.url, parsed)) {
      next();
      return;
    }
    if (parsed.invalid || !EXACT_ROUTES.has(parsed.path)) {
      reject(res, 404, 'LOCAL_ROUTE_NOT_FOUND');
      return;
    }

    const method = String(req.method || '').toUpperCase();
    if (method === 'OPTIONS' || !EXACT_ROUTES.get(parsed.path).has(method)) {
      reject(res, 405, 'LOCAL_METHOD_NOT_ALLOWED');
      return;
    }
    if (!isLoopbackPeer(req)) {
      reject(res, 403, 'LOCAL_PEER_REQUIRED');
      return;
    }
    if (exactlyOneHeader(req, 'host') !== expectedHost) {
      reject(res, 403, 'LOCAL_HOST_REQUIRED');
      return;
    }
    if (['origin', ...FETCH_METADATA_HEADERS, 'content-type'].some((name) => headerValues(req, name).length > 1)) {
      reject(res, 403, 'LOCAL_DUPLICATE_HEADER');
      return;
    }

    const origin = exactlyOneHeader(req, 'origin');
    if (origin !== null && origin !== expectedOrigin) {
      reject(res, 403, 'LOCAL_ORIGIN_REQUIRED');
      return;
    }

    const fetchSite = headerValues(req, 'sec-fetch-site');
    if (fetchSite.length === 1 && fetchSite[0] !== 'same-origin') {
      reject(res, 403, 'LOCAL_FETCH_SITE_REQUIRED');
      return;
    }

    if (method === 'GET') {
      if (origin === null && !hasExactFetchMetadata(req)) {
        reject(res, 403, 'LOCAL_FETCH_METADATA_REQUIRED');
        return;
      }
    } else {
      if (origin !== expectedOrigin) {
        reject(res, 403, 'LOCAL_ORIGIN_REQUIRED');
        return;
      }
      if (!acceptsJson(req)) {
        reject(res, 415, 'LOCAL_JSON_REQUIRED');
        return;
      }
    }

    next();
  };
}

function assertResolvedConfig(config) {
  const server = config.server || {};
  const preview = config.preview || {};
  const assertListener = (settings, label, defaultPort) => {
    if (settings.host !== '127.0.0.1') throw new Error(`${label}.host must be 127.0.0.1`);
    requirePort(settings.port ?? defaultPort);
    if (settings.strictPort !== true) throw new Error(`${label}.strictPort must be true`);
    if (settings.cors !== false) throw new Error(`${label}.cors must be false`);
    if (!Array.isArray(settings.allowedHosts) || settings.allowedHosts.some((value) => value !== '127.0.0.1')) {
      throw new Error(`${label}.allowedHosts contains a non-loopback host`);
    }
  };
  if (process.env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS) {
    throw new Error('__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS is not allowed for local administration');
  }
  assertListener(server, 'server', 5173);
  assertListener(preview, 'preview', 4173);
  return requirePort(server.port ?? 5173);
}

function assertRawConfig(config) {
  const assertRawListener = (settings, label) => {
    if (!settings) return;
    if (settings.allowedHosts !== undefined
      && (settings.allowedHosts === true || !Array.isArray(settings.allowedHosts) || settings.allowedHosts.length !== 0)) {
      throw new Error(`${label}.allowedHosts must be an empty explicit allowlist`);
    }
    if (settings.hmr && typeof settings.hmr === 'object' && settings.hmr.host !== undefined) {
      throw new Error(`${label}.hmr.host is not allowed for local administration`);
    }
    if (settings.origin !== undefined) throw new Error(`${label}.origin is not allowed for local administration`);
  };
  assertRawListener(config.server, 'server');
  assertRawListener(config.preview, 'preview');
}

export function createLocalRequestGuardVitePlugin() {
  let guard;
  return {
    name: 'question-bank-local-request-guard',
    enforce: 'pre',
    config(config) {
      assertRawConfig(config);
    },
    configResolved(config) {
      guard = createLocalRequestGuard({ port: assertResolvedConfig(config) });
    },
    configureServer(server) {
      if (!guard) throw new Error('local request guard was not configured');
      server.middlewares.use(guard);
    },
  };
}

export const localRequestGuardRoutes = Object.freeze([...EXACT_ROUTES.keys()]);
