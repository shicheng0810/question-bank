const HEX64 = /^[0-9a-f]{64}$/;
const KEYS = ['ok', 'status', 'principal', 'phase', 'incarnation', 'fence'];

function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && actual.every(key => typeof key === 'string' && keys.includes(key))
    && keys.every(key => { const d = Object.getOwnPropertyDescriptor(value, key); return d && 'value' in d; });
}

export function safeNativeIdentityStatus(value) {
  if (exact(value, ['ok', 'status']) && value.ok === true && value.status === 'empty') {
    return { ok: true, status: 'empty' };
  }
  if (!exact(value, KEYS) || value.ok !== true || value.status !== 'observed'
    || !HEX64.test(value.principal) || !['active', 'deleting', 'retired'].includes(value.phase)
    || !HEX64.test(value.incarnation) || !Number.isSafeInteger(value.fence) || value.fence < 1) return null;
  return { ok: true, status: 'observed', principal: value.principal, phase: value.phase,
    incarnation: value.incarnation, fence: value.fence };
}
