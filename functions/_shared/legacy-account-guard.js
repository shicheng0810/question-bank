const FEATURE = '1';
const UPGRADE_BODY = JSON.stringify({ ok: false, error: 'ACCOUNT_UPGRADE_REQUIRED' });

// A4c2a deliberately refuses legacy private account operations while the
// generation-backed account API is enabled. Keep this check before any
// binding, body, limiter, KV, or Durable Object work in the caller.
export function legacyAccountApiGuard(context) {
  if (context?.env?.GEN05_ACCOUNT_API !== FEATURE) return null;
  return new Response(UPGRADE_BODY, {
    status: 409,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
