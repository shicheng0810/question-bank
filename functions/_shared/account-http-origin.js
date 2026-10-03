const MIRROR_ORIGIN = 'https://shicheng0810.github.io';
const API_ORIGIN = 'https://question-bank-78u.pages.dev';
const LOCAL_ORIGINS = new Set(['http://127.0.0.1:4434', 'http://127.0.0.1:4470', 'http://127.0.0.1:4471', 'http://127.0.0.1:4472']);

// No forwarded-header interpretation: the browser Origin is checked against
// explicit source/target pairs, never '*', suffix matching, or arbitrary URLs.
export function accountOriginAllowed(request, env, allowAbsent = false) {
  const origin = request.headers.get('Origin');
  const target = new URL(request.url).origin;
  if (origin === null) return allowAbsent;
  if (origin === target) return true;
  if (env?.GEN06_GH_API_CORS === '1' && origin === MIRROR_ORIGIN && target === API_ORIGIN) return true;
  return env?.GEN06_LOCAL_FIXTURE === '1' && LOCAL_ORIGINS.has(origin) && LOCAL_ORIGINS.has(target);
}

export function accountCorsResponse(request, env, response) {
  const origin = request.headers.get('Origin');
  if (!origin || origin === new URL(request.url).origin || !accountOriginAllowed(request, env)) return response;
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', origin);
  const exposed = new Set((headers.get('Access-Control-Expose-Headers') || '').split(',').map(value => value.trim()).filter(Boolean));
  for (const name of ['X-Legacy-Source-Key', 'X-Legacy-Source-SHA256', 'X-Legacy-Byte-Length',
    'X-Legacy-Chunk-SHA256', 'X-Legacy-Chunk-Index', 'X-Legacy-Chunk-Count', 'Retry-After']) exposed.add(name);
  headers.set('Access-Control-Expose-Headers', Array.from(exposed).join(', '));
  headers.set('Cache-Control', 'no-store');
  const vary = headers.get('Vary');
  headers.set('Vary', vary ? `${vary}, Origin` : 'Origin');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function accountPreflight(request, env) {
  if (!accountOriginAllowed(request, env)) return new Response(JSON.stringify({ ok: false, error: 'ORIGIN_NOT_ALLOWED' }), { status: 403, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin' } });
  const method = request.headers.get('Access-Control-Request-Method');
  const path = new URL(request.url).pathname;
  const allowed = path.endsWith('/content/chunks') ? ['GET', 'PUT'] : path.endsWith('/content/manifests') ? ['GET', 'POST'] : path.endsWith('/sync/capabilities') || path.endsWith('/sync/pull') || path.endsWith('/export/page') || path.endsWith('/export/chunk') || path.endsWith('/legacy/history') || path.endsWith('/legacy/banks') ? ['GET'] : ['POST'];
  const names = (request.headers.get('Access-Control-Request-Headers') || '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
  if (!allowed.includes(method) || names.some(v => !['authorization', 'content-type', ...(path.endsWith('/sync/pull')?['x-qb-resume-reader']:[])].includes(v))) return new Response(null, { status: 403, headers: { 'Cache-Control': 'no-store', Vary: 'Origin' } });
  return accountCorsResponse(request, env, new Response(null, { status: 204, headers: { 'Access-Control-Allow-Methods': allowed.join(', '), 'Access-Control-Allow-Headers': path.endsWith('/sync/pull') ? 'Authorization, Content-Type, X-QB-Resume-Reader' : 'Authorization, Content-Type', 'Cache-Control': 'no-store', Vary: 'Origin' } }));
}
