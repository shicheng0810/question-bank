const HEX64 = /^[0-9a-f]{64}$/;
const MAX_CODE_UNITS = 256;
const MIN_CODE_LENGTH = 4;
const MAX_CODE_LENGTH = 64;

function invalid() {
  const cause = new Error('INVALID_CREDENTIALS');
  cause.code = 'INVALID_CREDENTIALS';
  return cause;
}

export function normalizeCode(code) {
  if (typeof code !== 'string' || code.length > MAX_CODE_UNITS) throw invalid();
  const normalized = code.trim();
  if (normalized.length < MIN_CODE_LENGTH || normalized.length > MAX_CODE_LENGTH) throw invalid();
  return normalized;
}

export async function principalForCode(code) {
  const normalized = normalizeCode(code);
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`qbcode:v1:${normalized}`),
  );
  const bytes = new Uint8Array(digest);
  let principal = '';
  for (const byte of bytes) principal += byte.toString(16).padStart(2, '0');
  if (!HEX64.test(principal)) throw invalid();
  return principal;
}

export function isPrincipal(value) {
  return typeof value === 'string' && HEX64.test(value);
}
