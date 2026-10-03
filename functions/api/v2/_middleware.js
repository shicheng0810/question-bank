import { accountCorsResponse, accountPreflight } from '../../_shared/account-http-origin.js';
const routes = new Set(['/api/v2/auth', '/api/v2/session', '/api/v2/account', '/api/v2/sync/push', '/api/v2/sync/pull', '/api/v2/sync/capabilities', '/api/v2/content/chunks', '/api/v2/content/manifests', '/api/v2/export/start', '/api/v2/export/page', '/api/v2/export/chunk', '/api/v2/export/reset']);
export async function onRequest(context) {
  if (!routes.has(new URL(context.request.url).pathname)) return context.next();
  if (context.request.method === 'OPTIONS') return accountPreflight(context.request, context.env);
  return accountCorsResponse(context.request, context.env, await context.next());
}
