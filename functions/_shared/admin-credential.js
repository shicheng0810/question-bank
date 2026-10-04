/**
 * Narrow verifier for a separately enrolled administrator machine credential.
 *
 * This module intentionally has no route, cookie, session, rate-limit, or
 * enrollment behavior. Callers must treat a true result only as proof that the
 * supplied credential matches the configured verifier for this instant.
 */

export const ADMIN_CREDENTIAL_BYTE_LENGTH = 32;
export const ADMIN_CREDENTIAL_BASE64URL_LENGTH = 43;

const VERIFIER_MAX_LENGTH = 512;
const CREDENTIAL = /^[A-Za-z0-9_-]{43}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function exactRecord(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const actual = Reflect.ownKeys(value);
  if (actual.some((key) => typeof key !== 'string')
    || actual.length !== keys.length || keys.some((key) => !actual.includes(key))) return false;
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor;
  });
}

function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function credentialBytes(value) {
  if (typeof value !== 'string' || value.length !== ADMIN_CREDENTIAL_BASE64URL_LENGTH
    || !CREDENTIAL.test(value)) return null;
  let binary;
  try {
    binary = atob(`${value.replace(/-/g, '+').replace(/_/g, '/')}=`);
  } catch {
    return null;
  }
  if (binary.length !== ADMIN_CREDENTIAL_BYTE_LENGTH) return null;
  const bytes = new Uint8Array(ADMIN_CREDENTIAL_BYTE_LENGTH);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return base64url(bytes) === value ? bytes : null;
}

function verifierDigest(verifierJson) {
  if (typeof verifierJson !== 'string' || verifierJson.length === 0
    || verifierJson.length > VERIFIER_MAX_LENGTH) return null;
  let parsed;
  try {
    parsed = JSON.parse(verifierJson);
  } catch {
    return null;
  }
  if (!exactRecord(parsed, ['version', 'credentialId', 'sha256'])
    || parsed.version !== 1 || typeof parsed.credentialId !== 'string'
    || !UUID_V4.test(parsed.credentialId) || typeof parsed.sha256 !== 'string'
    || !SHA256.test(parsed.sha256)) return null;
  const digest = new Uint8Array(32);
  for (let index = 0; index < digest.length; index += 1) {
    digest[index] = Number.parseInt(parsed.sha256.slice(index * 2, index * 2 + 2), 16);
  }
  return digest;
}

async function equalDigests(expected, actual) {
  // WebCrypto verifies the MAC internally. The ephemeral key is only a
  // constant-time comparison mechanism; it is not an administrator secret.
  const comparisonKeyBytes = new Uint8Array(32);
  crypto.getRandomValues(comparisonKeyBytes);
  const comparisonKey = await crypto.subtle.importKey(
    'raw',
    comparisonKeyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
  comparisonKeyBytes.fill(0);
  const expectedMac = await crypto.subtle.sign('HMAC', comparisonKey, expected);
  return crypto.subtle.verify('HMAC', comparisonKey, expectedMac, actual);
}

/**
 * Returns true only for the canonical unpadded base64url encoding of 32 bytes.
 */
export function isStrictAdminCredential(credential) {
  try {
    return credentialBytes(credential) !== null;
  } catch {
    return false;
  }
}

/**
 * Verify a credential against the JSON value of a server-side secret binding.
 * Malformed input, malformed configuration, and WebCrypto failures fail closed.
 */
export async function verifyAdminCredential(credential, verifierJson) {
  try {
    const supplied = credentialBytes(credential);
    const expected = verifierDigest(verifierJson);
    if (!supplied || !expected) return false;
    const actual = await crypto.subtle.digest('SHA-256', supplied);
    return await equalDigests(expected, actual);
  } catch {
    return false;
  }
}
