import { validateAuthority } from './account-incarnation.js';

const HEX64 = /^[0-9a-f]{64}$/;
const KEYS = ['ok', 'status', 'principal', 'phase', 'incarnation', 'fence'];

function failure(error) { return { ok: false, error }; }
function rows(result) { return result ? Array.from(result) : []; }

function emptyTable(sql) {
  return rows(sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='gen05_authority_state'")).length === 0;
}

/**
 * Read only the account-identity/lifecycle projection from this authority
 * object's GEN05 state. The caller must pass the instance principal derived
 * from the binding and the GEN05 feature gate; this function never reads
 * archive policy, UserStore, or business payload tables.
 */
export function readNativeIdentityStatus(sql, { principal, instancePrincipal, gen05Enabled } = {}) {
  if (gen05Enabled !== true) return failure('FEATURE_DISABLED');
  if (!sql || typeof sql.exec !== 'function'
    || (principal !== undefined && !HEX64.test(principal || ''))) return failure('INVALID_INPUT');
  try {
    if (emptyTable(sql)) return { ok: true, status: 'empty' };
    const stateRows = rows(sql.exec('SELECT state_json FROM gen05_authority_state'));
    if (stateRows.length !== 1 || typeof stateRows[0].state_json !== 'string') return failure('IDENTITY_UNCERTAIN');
    let state;
    try { state = JSON.parse(stateRows[0].state_json); } catch { return failure('IDENTITY_UNCERTAIN'); }
    validateAuthority(state);
    if ((principal !== undefined && state.principal !== principal)
      || (instancePrincipal !== undefined && state.principal !== instancePrincipal)) return failure('IDENTITY_MISMATCH');
    if (state.phase === 'empty') return { ok: true, status: 'empty' };
    const result = { ok: true, status: 'observed', principal: state.principal,
      phase: state.phase, incarnation: state.incarnation, fence: state.fence };
    if (Reflect.ownKeys(result).length !== KEYS.length) return failure('IDENTITY_UNCERTAIN');
    return result;
  } catch {
    return failure('IDENTITY_UNCERTAIN');
  }
}
