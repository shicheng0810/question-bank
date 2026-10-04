const HEX64 = /^[0-9a-f]{64}$/;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_LENGTH = 512;

function exactRecord(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const actual = Reflect.ownKeys(value);
  if (
    actual.some((key) => typeof key !== "string") ||
    actual.length !== keys.length ||
    keys.some((key) => !actual.includes(key))
  )
    return false;
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor;
  });
}

/** Parses only a control-plane rotation transition; it never handles credentials. */
export function parseAdminCredentialTransition(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_LENGTH
  )
    return null;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (
    !exactRecord(parsed, [
      "version",
      "transitionId",
      "expectedFingerprint",
      "nextFingerprint",
    ]) ||
    parsed.version !== 1 ||
    typeof parsed.transitionId !== "string" ||
    !UUID_V4.test(parsed.transitionId) ||
    typeof parsed.expectedFingerprint !== "string" ||
    !HEX64.test(parsed.expectedFingerprint) ||
    typeof parsed.nextFingerprint !== "string" ||
    !HEX64.test(parsed.nextFingerprint) ||
    parsed.expectedFingerprint === parsed.nextFingerprint
  )
    return null;
  return {
    transitionId: parsed.transitionId,
    expectedFingerprint: parsed.expectedFingerprint,
    nextFingerprint: parsed.nextFingerprint,
  };
}
