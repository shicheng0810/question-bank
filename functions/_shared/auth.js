// 多个 /api/* Function 共用的鉴权 + Durable Object 调用工具。
// 放在 functions/_shared/（下划线目录不会成为路由；即使被当成路由也没有 onRequest 处理器，无害），
// 由各 Function 以相对路径 import。

// Bearer token → sub。token 形如 "<epoch>.<rand>"；epoch 用于「删账号即吊销所有设备会话」。
// 解析 s:<token>→sub（与旧实现一致），再校验 token 的 epoch 前缀 == 当前 uepoch:<sub>。
export async function subFromAuth(env, request) {
  // GEN05 mode cuts over legacy private routes; never touch legacy KV here.
  if (env?.GEN05_ACCOUNT_API === '1') return null;
  const token = bearerToken(request);
  if (!token) return null;
  // A generation-backed session must never be interpreted as a legacy KV key.
  if (token.startsWith('v2.')) return null;
  const sub = await env.EDITS.get('s:' + token);
  if (!sub) return null;
  // 删账号会 bump uepoch:<sub>，使其它设备上旧 epoch 的 token 立刻失效（含写操作，不只是读空）。
  const cur = await env.EDITS.get('uepoch:' + sub);
  if (cur == null) return sub; // 该用户还没设过 epoch（极老 token / 迁移期）→ 放行（向后兼容）
  const dot = token.indexOf('.');
  const tokEpoch = dot > 0 ? token.slice(0, dot) : null;
  if (tokEpoch == null || tokEpoch !== cur) return null; // 无 epoch 前缀或 epoch 已过期 → 失效
  return sub;
}

export function bearerToken(request) {
  const h = request.headers.get('Authorization') || '';
  const m = h.match(/^Bearer\s+(\S+)$/i);
  return m ? m[1] : null;
}

// 每个 sub 一个 UserStore DO 实例（idFromName(sub)）。
export function userStore(env, sub) {
  return env.USER_STORE.get(env.USER_STORE.idFromName(sub));
}

// 调 DO：用 fetch 形式（跨 Worker 最稳，不依赖 RPC 方法调用），op 走路径、参数走 JSON body。
export async function doCall(stub, op, payload) {
  const res = await stub.fetch('https://do/' + op, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  if (!res.ok) throw new Error('do_' + op + '_' + res.status);
  return res.json();
}

// 原子限流（RateLimiter DO，按 key=用途+IP 分实例）。失败 fail-open（与旧 KV 限流行为一致）。
export async function rateLimitOk(env, key, limit, periodSec) {
  try {
    const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(key));
    const r = await doCall(stub, 'hit', { limit, periodSec });
    return !!r.allowed;
  } catch (_e) {
    return true; // 限流不可用时不阻断主流程
  }
}
