const HEX64 = /^[0-9a-f]{64}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDENTITY_EMPTY_KEYS = ['ok', 'status'];
const IDENTITY_OBSERVED_KEYS = ['ok', 'status', 'principal', 'phase', 'incarnation', 'fence'];
const STAT_KEYS = ['ok', 'status', 'principal', 'incarnation', 'fence', 'generation', 'highWater',
  'historySnapshotCount', 'attemptCount', 'activePrivateBankCount', 'tombstoneCount', 'coverageStatus'];

function exactDataRecord(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && own.every(key => typeof key === 'string' && keys.includes(key))
    && keys.every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor && 'value' in descriptor;
    });
}

function invalid() { throw new Error('NATIVE_IDENTITY_INVALID'); }

/** Validate the proposed GEN05-only, binding-safe authority identity DTO. */
export function validateNativeIdentityStatus(value) {
  if (exactDataRecord(value, IDENTITY_EMPTY_KEYS)) {
    if (value.ok === true && value.status === 'empty') return { ok: true, status: 'empty' };
    return invalid();
  }
  if (!exactDataRecord(value, IDENTITY_OBSERVED_KEYS) || value.ok !== true || value.status !== 'observed'
    || !HEX64.test(value.principal) || !['active', 'deleting', 'retired'].includes(value.phase)
    || !HEX64.test(value.incarnation) || !Number.isSafeInteger(value.fence) || value.fence < 1) return invalid();
  return {
    ok: true, status: 'observed', principal: value.principal, phase: value.phase,
    incarnation: value.incarnation, fence: value.fence,
  };
}

function unknownStats() {
  return { status: 'unknown', generation: null, highWater: null,
    historySnapshotCount: null, attemptCount: null, activePrivateBankCount: null,
    tombstoneCount: null, coverageStatus: 'unknown' };
}

function checkedStats(value, identity) {
  if (!exactDataRecord(value, STAT_KEYS) || value.ok !== true || value.status !== 'verified'
    || value.principal !== identity.principal || value.incarnation !== identity.incarnation
    || value.fence !== identity.fence || !UUID_V4.test(value.generation)
    || typeof value.highWater !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(value.highWater)
    || value.coverageStatus !== 'unknown'
    || !['historySnapshotCount', 'attemptCount', 'activePrivateBankCount', 'tombstoneCount']
      .every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)) {
    return unknownStats();
  }
  return { status: 'verified', generation: value.generation, highWater: value.highWater,
    historySnapshotCount: value.historySnapshotCount, attemptCount: value.attemptCount,
    activePrivateBankCount: value.activePrivateBankCount, tombstoneCount: value.tombstoneCount,
    coverageStatus: 'unknown' };
}

/**
 * Map an observed namespace page to manager rows using only an injected safe
 * binding reader. Namespace enumeration is observational, never a total-count
 * proof. Identity failures fail the read; stats failures remain explicitly
 * unknown and can never become zero.
 */
export async function mapNativeIdentityRows(objects, { readIdentity, readStats }) {
  if (!Array.isArray(objects) || typeof readIdentity !== 'function'
    || (readStats !== undefined && typeof readStats !== 'function')) throw new Error('NATIVE_CENSUS_INVALID');
  const rows = [];
  const seenIds = new Set();
  const seenPrincipals = new Set();
  for (const object of objects) {
    if (!object || typeof object !== 'object' || Array.isArray(object)
      || typeof object.id !== 'string' || object.id.length < 1 || object.id.length > 128
      || typeof object.hasStoredData !== 'boolean' || seenIds.has(object.id)) throw new Error('NATIVE_CENSUS_INVALID');
    seenIds.add(object.id);
    if (!object.hasStoredData) continue;
    const identity = validateNativeIdentityStatus(await readIdentity(object.id));
    if (identity.status === 'empty') continue;
    if (seenPrincipals.has(identity.principal)) throw new Error('NATIVE_CENSUS_DUPLICATE_PRINCIPAL');
    seenPrincipals.add(identity.principal);
    let nativeStats = unknownStats();
    if (identity.phase === 'active' && readStats) {
      try { nativeStats = checkedStats(await readStats(identity.principal), identity); } catch { /* unavailable stays unknown */ }
    }
    rows.push({ objectId: object.id, principal: identity.principal, phase: identity.phase,
      incarnation: identity.incarnation, fence: identity.fence, deleting: identity.phase === 'deleting', nativeStats });
  }
  return rows.sort((a, b) => a.principal.localeCompare(b.principal));
}
