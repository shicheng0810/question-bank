const FEATURE = "1";
const ORIGIN = /^https:\/\/[^/?#]+$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const BODY_LIMIT = 1024;
const COOKIE = "__Host-qb_admin";
const MAX_DATE = 8_640_000_000_000_000;
const RPC_DISPOSER = Symbol.dispose;

function response(body, status, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}
function failure(status = 401) {
  return response(
    { ok: false, error: status === 503 ? "UNAVAILABLE" : "AUTH_FAILED" },
    status,
  );
}
function clearCookie() {
  return `${COOKIE}=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}
function sessionCookie(value) {
  return `${COOKIE}=${value}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`;
}

function origin(env) {
  if (typeof env?.ADMIN_ORIGIN !== "string" || !ORIGIN.test(env.ADMIN_ORIGIN))
    return null;
  try {
    return new URL(env.ADMIN_ORIGIN).origin === env.ADMIN_ORIGIN
      ? env.ADMIN_ORIGIN
      : null;
  } catch {
    return null;
  }
}
function configured(env) {
  return (
    env?.ADMIN_AUTH_ENABLED === FEATURE &&
    origin(env) &&
    env.ADMIN_AUTH &&
    typeof env.ADMIN_AUTH.getByName === "function"
  );
}
function exact(value, keys) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return null;
  const actual = Reflect.ownKeys(value);
  if (
    actual.some((key) => typeof key !== "string") ||
    actual.length !== keys.length ||
    keys.some((key) => !actual.includes(key))
  )
    return null;
  return keys.every(
    (key) => Object.getOwnPropertyDescriptor(value, key)?.value !== undefined,
  )
    ? value
    : null;
}
async function boundedJson(request) {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > BODY_LIMIT))
    return null;
  if (
    request.headers.get("content-type") !== "application/json" ||
    !request.body
  )
    return null;
  const reader = request.body.getReader();
  let total = 0;
  const chunks = [];
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > BODY_LIMIT) {
        await reader.cancel();
        return null;
      }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}
function cookie(request) {
  const raw = request.headers.get("cookie") || "";
  if (raw.length > 4096) return null;
  const values = [];
  for (const part of raw.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) {
      if (part.trim() === COOKIE) return null;
      continue;
    }
    const name = part.slice(0, separator).trim();
    if (name === COOKIE) values.push(part.slice(separator + 1));
  }
  return values.length === 1 && TOKEN.test(values[0]) ? values[0] : null;
}
function validExpiry(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_DATE;
}
async function sha256Hex(value) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}
function canonicalIP(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 45 ||
    /[\s[\]%]/.test(value)
  )
    return null;
  const ipv4 = value.split(".");
  if (
    ipv4.length === 4 &&
    ipv4.every(
      (part) =>
        /^\d+$/.test(part) &&
        (part.length === 1 || !part.startsWith("0")) &&
        Number(part) <= 255,
    )
  )
    return ipv4.join(".");
  if (!value.includes(":") || !/^[0-9a-fA-F:.]+$/.test(value)) return null;
  try {
    let hostname = new URL(`http://[${value}]`).hostname;
    if (hostname.startsWith("[") && hostname.endsWith("]"))
      hostname = hostname.slice(1, -1);
    return hostname.includes(":") ? hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}
function trustedPost(request, expected) {
  return request.headers.get("origin") === expected;
}
function trustedGet(request, expected) {
  const requestOrigin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  return (
    (requestOrigin === null || requestOrigin === expected) &&
    site !== "cross-site"
  );
}
function rpcResult(outcome, successKeys) {
  if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)) {
    throw new Error("UNAVAILABLE");
  }
  const prototype = Object.getPrototypeOf(outcome);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("UNAVAILABLE");
  }
  const keys = Reflect.ownKeys(outcome);
  const symbols = keys.filter((key) => typeof key === "symbol");
  if (
    symbols.length > 1 ||
    (symbols.length === 1 &&
      (RPC_DISPOSER === undefined || symbols[0] !== RPC_DISPOSER))
  ) {
    throw new Error("UNAVAILABLE");
  }
  if (symbols.length === 1) {
    const descriptor = Object.getOwnPropertyDescriptor(outcome, RPC_DISPOSER);
    if (
      !descriptor ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "function"
    ) {
      throw new Error("UNAVAILABLE");
    }
  }
  const ok = Object.getOwnPropertyDescriptor(outcome, "ok");
  if (!ok || !("value" in ok) || typeof ok.value !== "boolean") {
    throw new Error("UNAVAILABLE");
  }
  const expected = ok.value ? ["ok", ...successKeys] : ["ok", "error"];
  const strings = keys.filter((key) => typeof key === "string");
  if (
    strings.length !== expected.length ||
    strings.some((key) => !expected.includes(key))
  ) {
    throw new Error("UNAVAILABLE");
  }
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(outcome, key);
    if (!descriptor || !("value" in descriptor)) throw new Error("UNAVAILABLE");
  }
  if (!ok.value) {
    if (typeof outcome.error !== "string") throw new Error("UNAVAILABLE");
    return { ok: false, error: outcome.error };
  }
  const result = { ok: true };
  for (const key of successKeys) result[key] = outcome[key];
  return result;
}
async function callRpc(stub, method, command, successKeys) {
  if (!stub || typeof stub[method] !== "function")
    throw new Error("UNAVAILABLE");
  let outcome;
  try {
    outcome = await stub[method](command);
    return rpcResult(outcome, successKeys);
  } finally {
    if (outcome && typeof outcome === "object" && RPC_DISPOSER !== undefined) {
      const descriptor = Object.getOwnPropertyDescriptor(outcome, RPC_DISPOSER);
      if (
        descriptor &&
        "value" in descriptor &&
        typeof descriptor.value === "function"
      ) {
        try {
          await descriptor.value.call(outcome);
        } catch {
          throw new Error("UNAVAILABLE");
        }
      }
    }
  }
}

/** Pure, unwired Pages handler. Callers must route only the four fixed admin paths here. */
export async function handleAdminAuth(request, env) {
  if (env?.ADMIN_AUTH_ENABLED !== FEATURE)
    return response({ ok: false, error: "NOT_FOUND" }, 404);
  const expected = origin(env);
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return failure();
  }
  if (
    !expected ||
    url.origin !== expected ||
    url.search !== "" ||
    !configured(env)
  )
    return failure(503);
  const routes = {
    "/api/admin/login": "login",
    "/api/admin/session": "check",
    "/api/admin/logout": "logout",
    "/api/admin/revoke-all": "revokeAll",
  };
  const action = routes[url.pathname];
  if (!action) return response({ ok: false, error: "NOT_FOUND" }, 404);
  if (
    (action === "check" && request.method !== "GET") ||
    (action !== "check" && request.method !== "POST")
  )
    return response({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405, {
      allow: action === "check" ? "GET" : "POST",
    });
  if (
    action === "check"
      ? !trustedGet(request, expected)
      : !trustedPost(request, expected)
  )
    return failure();
  try {
    const stub = env.ADMIN_AUTH.getByName("primary");
    if (!stub || typeof stub[action] !== "function") return failure(503);
    if (action === "login") {
      const body = exact(await boundedJson(request), ["credential"]);
      if (!body || typeof body.credential !== "string") return failure();
      const ip = canonicalIP(request.headers.get("CF-Connecting-IP"));
      if (!ip) return failure(503);
      const result = await callRpc(
        stub,
        "login",
        {
          credential: body.credential,
          ipHash: await sha256Hex(`qb-admin-ip:v1:${ip}`),
        },
        ["token", "csrf", "expiresAt"],
      );
      if (
        result.ok &&
        (typeof result.token !== "string" ||
          typeof result.csrf !== "string" ||
          !TOKEN.test(result.token) ||
          !TOKEN.test(result.csrf) ||
          !validExpiry(result.expiresAt))
      ) {
        return failure(503);
      }
      return result.ok
        ? response(
            { ok: true, csrf: result.csrf, expiresAt: result.expiresAt },
            200,
            { "set-cookie": sessionCookie(result.token) },
          )
        : result?.error === "RATE_LIMITED"
          ? response({ ok: false, error: "RATE_LIMITED" }, 429, {
              "retry-after": "60",
            })
          : failure(result?.error === "UNAVAILABLE" ? 503 : 401);
    }
    const token = cookie(request);
    if (!token) return failure();
    if (action === "check") {
      const result = await callRpc(stub, "check", { token }, [
        "csrf",
        "expiresAt",
      ]);
      if (
        result.ok &&
        (typeof result.csrf !== "string" ||
          !TOKEN.test(result.csrf) ||
          !validExpiry(result.expiresAt))
      ) {
        return failure(503);
      }
      return result.ok
        ? response(
            { ok: true, csrf: result.csrf, expiresAt: result.expiresAt },
            200,
          )
        : failure(result?.error === "UNAVAILABLE" ? 503 : 401);
    }
    const body = exact(await boundedJson(request), []);
    if (!body) return failure();
    const csrf = request.headers.get("x-qb-admin-csrf");
    if (typeof csrf !== "string" || !TOKEN.test(csrf)) return failure();
    const result = await callRpc(stub, action, { token, csrf }, []);
    return result.ok
      ? response({ ok: true }, 200, { "set-cookie": clearCookie() })
      : failure(result?.error === "UNAVAILABLE" ? 503 : 401);
  } catch {
    return failure(503);
  }
}
