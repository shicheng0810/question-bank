// Exact tombstone routes prevent a misleading SPA fallback 200. Never read env/body.
const ORIGINS = ['https://question-bank-78u.pages.dev', 'https://shicheng0810.github.io', 'http://localhost:8799'];
export function retiredAccountApi({ request }) {
  const origin = request.headers.get('Origin') || '', options = request.method === 'OPTIONS';
  return new Response(options ? null : JSON.stringify({ ok: false, error: 'LEGACY_ACCOUNT_API_RETIRED' }), {
    status: options ? 204 : 410,
    headers: {
      'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff', 'vary': 'Origin',
      'access-control-allow-origin': ORIGINS.includes(origin) ? origin : ORIGINS[0],
      'access-control-allow-methods': 'GET, POST, DELETE, PUT, PATCH, HEAD, OPTIONS',
      'access-control-allow-headers': 'content-type, authorization', 'access-control-max-age': '86400',
    },
  });
}
