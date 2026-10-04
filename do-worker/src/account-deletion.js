const JOB_TABLE = 'gen05_deletion_jobs';
const HEX64 = /^[0-9a-f]{64}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const RPC_DISPOSER = Symbol.dispose;

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function exactRecord(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw failure('INVALID_INPUT');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw failure('INVALID_INPUT');
  const actual = Reflect.ownKeys(value);
  if (actual.some((key) => typeof key !== 'string')
    || actual.length !== keys.length || keys.some((key) => !actual.includes(key))) {
    throw failure('INVALID_INPUT');
  }
  const result = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) throw failure('INVALID_INPUT');
    result[key] = descriptor.value;
  }
  return result;
}

function safeFence(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function identifier(value) {
  return typeof value === 'string' && HEX64.test(value);
}

function operationId(value) {
  return typeof value === 'string' && UUID_V4.test(value);
}

function rows(cursor) {
  if (!cursor) return [];
  if (typeof cursor.toArray === 'function') return cursor.toArray();
  return Array.from(cursor);
}

function query(sql, statement, ...bindings) {
  return rows(sql.exec(statement, ...bindings));
}

function tableExists(sql) {
  return query(sql, "SELECT name FROM sqlite_master WHERE type='table' AND name=?", JOB_TABLE).length > 0;
}

function canonicalCommand(command) {
  return {
    principal: command.principal,
    incarnation: command.incarnation,
    expectedFence: command.expectedFence,
    opId: command.opId,
  };
}

function parseCommand(commandJson) {
  if (typeof commandJson !== 'string') throw failure('INVALID_INPUT');
  let parsed;
  try { parsed = JSON.parse(commandJson); } catch { throw failure('INVALID_INPUT'); }
  const command = exactRecord(parsed, ['principal', 'incarnation', 'expectedFence', 'opId']);
  if (!identifier(command.principal) || !identifier(command.incarnation)
    || command.principal === command.incarnation || !safeFence(command.expectedFence)
    || !operationId(command.opId) || JSON.stringify(command) !== commandJson) {
    throw failure('INVALID_INPUT');
  }
  return command;
}

export function validateDeleteCommand(command) {
  const fields = exactRecord(command, ['principal', 'incarnation', 'expectedFence', 'opId']);
  if (!identifier(fields.principal) || !identifier(fields.incarnation)
    || fields.principal === fields.incarnation || !safeFence(fields.expectedFence)
    || !operationId(fields.opId)) throw failure('INVALID_INPUT');
  return fields;
}

export function createDeletionSchema(sql) {
  sql.exec(`CREATE TABLE IF NOT EXISTS ${JOB_TABLE}(
    op_id TEXT PRIMARY KEY,
    command_json TEXT NOT NULL,
    old_incarnation TEXT NOT NULL,
    original_fence INTEGER NOT NULL,
    finish_op_id TEXT NOT NULL,
    status TEXT NOT NULL
  )`);
}

function parseJob(row, expectedPrincipal = null) {
  if (!row || !operationId(row.op_id) || typeof row.command_json !== 'string'
    || !identifier(row.old_incarnation) || !safeFence(row.original_fence)
    || row.original_fence > MAX_SAFE - 2 || !operationId(row.finish_op_id)
    || row.finish_op_id === row.op_id
    || (row.status !== 'pending' && row.status !== 'complete')) {
    throw failure('INVALID_INPUT');
  }
  const command = parseCommand(row.command_json);
  if (row.op_id !== command.opId || row.old_incarnation !== command.incarnation
    || row.original_fence !== command.expectedFence
    || (expectedPrincipal !== null && command.principal !== expectedPrincipal)) {
    throw failure('INVALID_INPUT');
  }
  return {
    principal: command.principal,
    incarnation: command.incarnation,
    originalFence: command.expectedFence,
    opId: command.opId,
    finishOpId: row.finish_op_id,
    status: row.status,
    commandJson: row.command_json,
  };
}

export function readDeletionJobs(sql, expectedPrincipal = null) {
  if (!tableExists(sql)) return [];
  const rowsFound = query(sql, `SELECT op_id,command_json,old_incarnation,original_fence,finish_op_id,status FROM ${JOB_TABLE}`);
  const jobs = rowsFound.map((row) => parseJob(row, expectedPrincipal));
  if (jobs.filter((job) => job.status === 'pending').length > 1) throw failure('INVALID_INPUT');
  return jobs;
}

export function findDeletionJob(jobs, opId) {
  return jobs.find((job) => job.opId === opId) || null;
}

export function pendingDeletionJob(jobs) {
  return jobs.find((job) => job.status === 'pending') || null;
}

export function sameDeleteCommand(job, command) {
  return job.principal === command.principal
    && job.incarnation === command.incarnation
    && job.originalFence === command.expectedFence
    && job.opId === command.opId;
}

export function sameDeletionJob(left, right) {
  return left.principal === right.principal
    && left.incarnation === right.incarnation
    && left.originalFence === right.originalFence
    && left.opId === right.opId;
}

export function createDeletionJob(command, finishOpId) {
  if (!operationId(finishOpId)) throw failure('INVALID_INPUT');
  return {
    principal: command.principal,
    incarnation: command.incarnation,
    originalFence: command.expectedFence,
    opId: command.opId,
    finishOpId,
    status: 'pending',
    commandJson: JSON.stringify(canonicalCommand(command)),
  };
}

export function insertDeletionJob(sql, job) {
  sql.exec(`INSERT INTO ${JOB_TABLE}(
    op_id,command_json,old_incarnation,original_fence,finish_op_id,status
  ) VALUES(?,?,?,?,?,?)`, job.opId, job.commandJson, job.incarnation, job.originalFence,
  job.finishOpId, job.status);
}

export function markDeletionComplete(sql, opId) {
  sql.exec(`UPDATE ${JOB_TABLE} SET status=? WHERE op_id=? AND status=?`, 'complete', opId, 'pending');
}

export function issueFinishOperationId() {
  const value = crypto.randomUUID();
  if (!operationId(value)) throw failure('UNAVAILABLE');
  return value;
}

export function reserveTwoFences(fence) {
  if (!safeFence(fence) || fence > MAX_SAFE - 2) throw failure('FENCE_EXHAUSTED');
}

export async function consumeRevokeOutcome(outcome) {
  let result;
  try {
    if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) throw failure('REMOTE_INVALID');
    const prototype = Object.getPrototypeOf(outcome);
    if (prototype !== Object.prototype && prototype !== null) throw failure('REMOTE_INVALID');
    const keys = Reflect.ownKeys(outcome);
    const symbols = keys.filter((key) => typeof key === 'symbol');
    if (symbols.length > 1 || (symbols.length === 1 && (RPC_DISPOSER === undefined || symbols[0] !== RPC_DISPOSER))) {
      throw failure('REMOTE_INVALID');
    }
    if (symbols.length === 1) {
      const descriptor = Object.getOwnPropertyDescriptor(outcome, RPC_DISPOSER);
      if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'function') throw failure('REMOTE_INVALID');
    }
    const ok = Object.getOwnPropertyDescriptor(outcome, 'ok');
    if (!ok || !('value' in ok) || typeof ok.value !== 'boolean') throw failure('REMOTE_INVALID');
    const expected = ok.value ? ['ok'] : ['ok', 'error'];
    const strings = keys.filter((key) => typeof key === 'string');
    if (strings.length !== expected.length || strings.some((key) => !expected.includes(key))) throw failure('REMOTE_INVALID');
    for (const key of expected) {
      const descriptor = Object.getOwnPropertyDescriptor(outcome, key);
      if (!descriptor || !('value' in descriptor)) throw failure('REMOTE_INVALID');
    }
    if (!ok.value) {
      if (typeof outcome.error !== 'string') throw failure('REMOTE_INVALID');
      result = { ok: false };
    } else {
      result = { ok: true };
    }
  } finally {
    if (outcome && typeof outcome === 'object' && RPC_DISPOSER !== undefined) {
      const descriptor = Object.getOwnPropertyDescriptor(outcome, RPC_DISPOSER);
      if (descriptor && 'value' in descriptor && typeof descriptor.value === 'function') {
        try { await descriptor.value.call(outcome); } catch { throw failure('REMOTE_INVALID'); }
      }
    }
  }
  return result;
}
