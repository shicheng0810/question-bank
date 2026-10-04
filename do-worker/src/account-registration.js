const TABLE = 'gen05_registration_intents';
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const INTENT_TTL_MS = 10 * 60 * 1000;
const HEX64 = /^[0-9a-f]{64}$/;
const INTENT = /^ri1\.[0-9a-f]{64}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function corruption() {
  return failure('STORAGE_CORRUPT');
}

function exactRecord(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw failure('INVALID_INPUT');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw failure('INVALID_INPUT');
  const actual = Reflect.ownKeys(value);
  if (actual.some((key) => typeof key !== 'string')
    || actual.length !== keys.length || keys.some((key) => !actual.includes(key))) throw failure('INVALID_INPUT');
  const result = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) throw failure('INVALID_INPUT');
    result[key] = descriptor.value;
  }
  return result;
}

function rows(result) {
  if (!result) return [];
  if (typeof result.toArray === 'function') return result.toArray();
  return Array.from(result);
}

function query(sql, statement, ...bindings) {
  return rows(sql.exec(statement, ...bindings));
}

function safeTime(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function safeFence(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function makeIntent() {
  const bytes = new Uint8Array(32);
  try {
    crypto.getRandomValues(bytes);
  } catch {
    throw failure('UNAVAILABLE');
  }
  let value = '';
  for (const byte of bytes) value += byte.toString(16).padStart(2, '0');
  if (!HEX64.test(value)) throw failure('UNAVAILABLE');
  return `ri1.${value}`;
}

function canonical(row) {
  return {
    principal: row.principal,
    opId: row.opId,
    intent: row.intent,
    expectedFence: row.expectedFence,
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
    status: row.status,
    incarnation: row.incarnation,
  };
}

function parseRow(row) {
  if (!row || typeof row.principal !== 'string' || !HEX64.test(row.principal)
    || typeof row.op_id !== 'string' || !UUID_V4.test(row.op_id)
    || typeof row.intent !== 'string' || !INTENT.test(row.intent)
    || !safeFence(row.expected_fence) || !safeTime(row.issued_at)
    || !safeTime(row.expires_at) || row.expires_at <= row.issued_at
    || row.expires_at - row.issued_at !== INTENT_TTL_MS
    || (row.status !== 'pending' && row.status !== 'consumed')
    || (row.incarnation !== null && (typeof row.incarnation !== 'string' || !HEX64.test(row.incarnation)))) {
    throw corruption();
  }
  if ((row.status === 'pending' && row.incarnation !== null)
    || (row.status === 'consumed' && row.incarnation === null)) throw corruption();
  const parsed = canonical({
    principal: row.principal,
    opId: row.op_id,
    intent: row.intent,
    expectedFence: row.expected_fence,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    status: row.status,
    incarnation: row.incarnation,
  });
  if (parsed.incarnation === parsed.principal) throw corruption();
  return parsed;
}

function schemaExists(sql) {
  return query(sql, "SELECT name FROM sqlite_master WHERE type='table' AND name=?", TABLE).length > 0;
}

export function createRegistrationSchema(sql) {
  sql.exec(`CREATE TABLE IF NOT EXISTS ${TABLE}(
    op_id TEXT PRIMARY KEY,
    principal TEXT NOT NULL,
    intent TEXT NOT NULL UNIQUE,
    expected_fence INTEGER NOT NULL,
    issued_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    incarnation TEXT
  )`);
}

function rowByOp(sql, opId) {
  if (!schemaExists(sql)) return null;
  const found = query(sql, `SELECT op_id,principal,intent,expected_fence,issued_at,expires_at,status,incarnation
    FROM ${TABLE} WHERE op_id=?`, opId);
  if (found.length > 1) throw corruption();
  return found.length === 1 ? parseRow(found[0]) : null;
}

function intentExists(sql, intent) {
  if (!schemaExists(sql)) return false;
  const found = query(sql, `SELECT op_id FROM ${TABLE} WHERE intent=?`, intent);
  if (found.length > 1) throw corruption();
  return found.length === 1;
}

function validateState(state, principal) {
  if (!state || state.principal !== principal || !safeFence(state.fence)
    || !['empty', 'retired', 'active', 'deleting'].includes(state.phase)) throw failure('INVALID_INPUT');
  if (state.phase === 'empty' && (state.fence !== 0 || state.incarnation !== null)) throw failure('INVALID_INPUT');
  if ((state.phase !== 'empty') && (typeof state.incarnation !== 'string' || !HEX64.test(state.incarnation))) {
    throw failure('INVALID_INPUT');
  }
  return state;
}

function ensureClock(now) {
  if (!safeTime(now) || now > MAX_SAFE - INTENT_TTL_MS) throw failure('UNAVAILABLE');
  return now;
}

function assertCreateReceipt(sql, opId, expectedFence) {
  const found = query(sql, `SELECT op_id,command_json,applied_fence FROM gen05_authority_receipts WHERE op_id=?`, opId);
  if (found.length !== 1 || found[0].op_id !== opId || found[0].applied_fence !== expectedFence + 1
    || typeof found[0].command_json !== 'string') throw corruption();
  let parsed;
  try { parsed = JSON.parse(found[0].command_json); } catch { throw corruption(); }
  let command;
  try { command = exactRecord(parsed, ['type', 'opId', 'expectedFence']); } catch { throw corruption(); }
  if (command.type !== 'create' || command.opId !== opId || command.expectedFence !== expectedFence
    || JSON.stringify(command) !== found[0].command_json) throw corruption();
}

export function createRegistrationRepository(storage, { principal, now = () => Date.now(), issueIntent = makeIntent } = {}) {
  if (!storage || typeof storage.transactionSync !== 'function' || !storage.sql
    || typeof storage.sql.exec !== 'function' || typeof principal !== 'string' || !HEX64.test(principal)
    || typeof now !== 'function' || typeof issueIntent !== 'function') throw failure('NOT_CONFIGURED');
  const sql = storage.sql;

  return {
    prepare({ opId, readState }) {
      if (typeof opId !== 'string' || !UUID_V4.test(opId) || typeof readState !== 'function') throw failure('INVALID_INPUT');
      return storage.transactionSync(() => {
        createRegistrationSchema(sql);
        const current = validateState(readState(), principal);
        if (current.phase === 'active' || current.phase === 'deleting') throw failure('STALE_AUTHORITY');
        const existing = rowByOp(sql, opId);
        const timestamp = ensureClock(now());
        if (existing) {
          if (existing.principal !== principal) throw failure('INVALID_INPUT');
          if (existing.status !== 'pending' || existing.expectedFence !== current.fence
            || timestamp >= existing.expiresAt) throw failure('STALE_AUTHORITY');
          return { ok: true, intent: existing.intent, expiresAt: existing.expiresAt };
        }
        let intent = null;
        for (let attempt = 0; attempt < 4 && intent === null; attempt += 1) {
          const candidate = issueIntent();
          if (typeof candidate !== 'string' || !INTENT.test(candidate)) throw failure('UNAVAILABLE');
          if (!intentExists(sql, candidate)) intent = candidate;
        }
        if (!intent) throw failure('UNAVAILABLE');
        const expiresAt = timestamp + INTENT_TTL_MS;
        sql.exec(`INSERT INTO ${TABLE}(op_id,principal,intent,expected_fence,issued_at,expires_at,status,incarnation)
          VALUES(?,?,?,?,?,?,?,?)`, opId, principal, intent, current.fence, timestamp, expiresAt, 'pending', null);
        return { ok: true, intent, expiresAt };
      });
    },

    commit({ opId, intent, readState, applyCreate = null }) {
      if (typeof opId !== 'string' || !UUID_V4.test(opId) || typeof intent !== 'string' || !INTENT.test(intent)
        || typeof readState !== 'function') throw failure('INVALID_INPUT');
      return storage.transactionSync(() => {
        const current = validateState(readState(), principal);
        const record = rowByOp(sql, opId);
        if (!record || record.principal !== principal || record.intent !== intent) throw failure('STALE_AUTHORITY');
        const timestamp = ensureClock(now());
        if (record.status === 'consumed') {
          assertCreateReceipt(sql, opId, record.expectedFence);
          if (record.incarnation === null || current.phase !== 'active'
            || current.incarnation !== record.incarnation || current.fence !== record.expectedFence + 1) {
            throw failure('STALE_AUTHORITY');
          }
          if (timestamp >= record.expiresAt) throw failure('STALE_AUTHORITY');
          return {
            ok: true,
            replayed: true,
            expectedFence: record.expectedFence,
            incarnation: record.incarnation,
            expiresAt: record.expiresAt,
          };
        }
        if (timestamp >= record.expiresAt) throw failure('STALE_AUTHORITY');
        if (current.phase === 'active' || current.phase === 'deleting'
          || current.fence !== record.expectedFence) throw failure('STALE_AUTHORITY');
        if (typeof applyCreate !== 'function') throw failure('INVALID_INPUT');
        const applied = applyCreate({ opId, expectedFence: record.expectedFence });
        if (!applied || typeof applied !== 'object' || (applied.replayed !== false && applied.replayed !== true)
          || !applied.state || applied.state.phase !== 'active'
          || applied.state.fence !== record.expectedFence + 1
          || typeof applied.state.incarnation !== 'string' || !HEX64.test(applied.state.incarnation)) {
          throw failure('STALE_AUTHORITY');
        }
        assertCreateReceipt(sql, opId, record.expectedFence);
        sql.exec(`UPDATE ${TABLE} SET status=?,incarnation=? WHERE op_id=? AND principal=? AND intent=? AND status=?`,
          'consumed', applied.state.incarnation, opId, principal, intent, 'pending');
        const after = rowByOp(sql, opId);
        if (!after || after.status !== 'consumed' || after.incarnation !== applied.state.incarnation) {
          throw corruption();
        }
        return {
          ok: true,
          replayed: false,
          expectedFence: record.expectedFence,
          incarnation: applied.state.incarnation,
          expiresAt: record.expiresAt,
        };
      });
    },
  };
}

export function validRegistrationIntent(value) {
  return typeof value === 'string' && INTENT.test(value);
}

export const REGISTRATION_INTENT_TTL_MS = INTENT_TTL_MS;
