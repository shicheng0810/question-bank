import {
  createEmptyAuthority,
  transitionIncarnation,
  validateAuthority,
} from './account-incarnation.js';

const STATE_TABLE = 'gen05_authority_state';
const RECEIPTS_TABLE = 'gen05_authority_receipts';
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const HEX64 = /^[0-9a-f]{64}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TYPES = Object.freeze(['create', 'begin-delete', 'finish-delete']);

function error(code, message = code) {
  const result = new Error(message);
  result.code = code;
  return result;
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readExactRecord(value, keys) {
  if (!isRecord(value)) throw error('INVALID_INPUT');
  const actual = Reflect.ownKeys(value);
  if (actual.some((key) => typeof key !== 'string')
    || actual.length !== keys.length
    || keys.some((key) => !actual.includes(key))) throw error('INVALID_INPUT');

  const fields = new Map();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) throw error('INVALID_INPUT');
    fields.set(key, descriptor.value);
  }
  return fields;
}

function identifier(value) {
  return typeof value === 'string' && HEX64.test(value);
}

function safeFence(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function opId(value) {
  return typeof value === 'string' && UUID_V4.test(value);
}

function rows(result) {
  if (!result) return [];
  if (typeof result.toArray === 'function') return result.toArray();
  return Array.from(result);
}

function query(sql, statement, ...bindings) {
  return rows(sql.exec(statement, ...bindings));
}

function requireStorage(storage) {
  if (!storage || typeof storage.transactionSync !== 'function'
    || !storage.sql || typeof storage.sql.exec !== 'function') {
    throw error('STORAGE_REQUIRED');
  }
}

function tableExists(sql, tableName) {
  return query(sql, "SELECT name FROM sqlite_master WHERE type='table' AND name=?", tableName).length > 0;
}

function schemaState(sql) {
  const hasState = tableExists(sql, STATE_TABLE);
  const hasReceipts = tableExists(sql, RECEIPTS_TABLE);
  if (hasState !== hasReceipts) throw error('INVALID_INPUT');
  return hasState;
}

function createSchema(sql) {
  sql.exec(`CREATE TABLE IF NOT EXISTS ${STATE_TABLE}(
    id INTEGER PRIMARY KEY CHECK (id=1),
    state_json TEXT NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS ${RECEIPTS_TABLE}(
    op_id TEXT PRIMARY KEY,
    command_json TEXT NOT NULL,
    applied_fence INTEGER NOT NULL
  )`);
}

function cloneState(state) {
  return {
    principal: state.principal,
    fence: state.fence,
    phase: state.phase,
    incarnation: state.incarnation,
    retired: state.retired.slice(),
  };
}

function parseState(row, principal) {
  if (!row || row.id !== 1 || typeof row.state_json !== 'string') throw error('INVALID_INPUT');
  let state;
  try {
    state = JSON.parse(row.state_json);
  } catch {
    throw error('INVALID_INPUT');
  }
  try {
    validateAuthority(state);
  } catch {
    throw error('INVALID_INPUT');
  }
  if (state.principal !== principal) throw error('PRINCIPAL_MISMATCH');
  return state;
}

function canonicalCommand(command) {
  if (command.type === 'create') {
    return { type: 'create', opId: command.opId, expectedFence: command.expectedFence };
  }
  return {
    type: command.type,
    opId: command.opId,
    expectedFence: command.expectedFence,
    expectedIncarnation: command.expectedIncarnation,
  };
}

function validateCommand(command) {
  if (!isRecord(command)) throw error('INVALID_INPUT');
  const typeDescriptor = Object.getOwnPropertyDescriptor(command, 'type');
  if (!typeDescriptor || !('value' in typeDescriptor) || !TYPES.includes(typeDescriptor.value)) {
    throw error('INVALID_INPUT');
  }
  const type = typeDescriptor.value;
  const keys = type === 'create'
    ? ['type', 'opId', 'expectedFence']
    : ['type', 'opId', 'expectedFence', 'expectedIncarnation'];
  const fields = readExactRecord(command, keys);
  const parsed = {
    type,
    opId: fields.get('opId'),
    expectedFence: fields.get('expectedFence'),
  };
  if (!opId(parsed.opId) || !safeFence(parsed.expectedFence)) throw error('INVALID_INPUT');
  if (type !== 'create') {
    parsed.expectedIncarnation = fields.get('expectedIncarnation');
    if (!identifier(parsed.expectedIncarnation)) throw error('INVALID_INPUT');
  }
  parsed.commandJson = JSON.stringify(canonicalCommand(parsed));
  return parsed;
}

function parseStoredCommand(commandJson) {
  if (typeof commandJson !== 'string') throw error('INVALID_INPUT');
  let command;
  try {
    command = JSON.parse(commandJson);
  } catch {
    throw error('INVALID_INPUT');
  }
  if (!isRecord(command)) throw error('INVALID_INPUT');
  const typeDescriptor = Object.getOwnPropertyDescriptor(command, 'type');
  if (!typeDescriptor || !('value' in typeDescriptor) || !TYPES.includes(typeDescriptor.value)) {
    throw error('INVALID_INPUT');
  }
  const type = typeDescriptor.value;
  const keys = type === 'create'
    ? ['type', 'opId', 'expectedFence']
    : ['type', 'opId', 'expectedFence', 'expectedIncarnation'];
  const fields = readExactRecord(command, keys);
  const storedOpId = fields.get('opId');
  if (!opId(storedOpId)) throw error('INVALID_INPUT');
  const expectedFence = fields.get('expectedFence');
  if (!safeFence(expectedFence)) throw error('INVALID_INPUT');
  const parsed = { type, opId: storedOpId, expectedFence };
  if (type !== 'create') {
    parsed.expectedIncarnation = fields.get('expectedIncarnation');
    if (!identifier(parsed.expectedIncarnation)) throw error('INVALID_INPUT');
  }
  if (JSON.stringify(parsed) !== commandJson) throw error('INVALID_INPUT');
  return parsed;
}

function readRows(sql) {
  const stateRows = query(sql, `SELECT id,state_json FROM ${STATE_TABLE}`);
  if (stateRows.length > 1) throw error('INVALID_INPUT');
  const receiptRows = query(sql, `SELECT op_id,command_json,applied_fence FROM ${RECEIPTS_TABLE}`);
  return { stateRows, receiptRows };
}

function readCurrent(sql, principal, tablesExist) {
  if (!tablesExist) return { state: createEmptyAuthority(principal), receipts: [] };
  const { stateRows, receiptRows } = readRows(sql);
  if (stateRows.length === 0) throw error('INVALID_INPUT');

  const state = parseState(stateRows[0], principal);
  const receipts = [];
  const seenOpIds = new Set();
  for (const row of receiptRows) {
    if (!row || !opId(row.op_id) || typeof row.command_json !== 'string'
      || !Number.isSafeInteger(row.applied_fence)
      || row.applied_fence < 1 || row.applied_fence > state.fence) throw error('INVALID_INPUT');
    if (seenOpIds.has(row.op_id)) throw error('INVALID_INPUT');
    seenOpIds.add(row.op_id);
    const parsed = parseStoredCommand(row.command_json);
    if (parsed.opId !== row.op_id) throw error('INVALID_INPUT');
    if (parsed.expectedFence + 1 !== row.applied_fence) throw error('INVALID_INPUT');
    receipts.push({ opId: row.op_id, commandJson: row.command_json, appliedFence: row.applied_fence });
  }
  return { state, receipts };
}

function currentReceipt(receipts, command) {
  return receipts.find((receipt) => receipt.opId === command.opId) || null;
}

function assertExpectedFence(state, expectedFence) {
  if (expectedFence !== state.fence) throw error('STALE_FENCE');
}

function assertPhaseAndIdentity(state, command) {
  if (command.type === 'create') {
    if (state.phase !== 'empty' && state.phase !== 'retired') throw error('INVALID_PHASE');
    return;
  }
  if (command.type === 'begin-delete') {
    if (state.phase !== 'active') throw error('INVALID_PHASE');
  } else if (state.phase !== 'deleting') {
    throw error('INVALID_PHASE');
  }
  if (command.expectedIncarnation !== state.incarnation) throw error('STALE_INCARNATION');
}

function assertIncrementable(state) {
  if (state.fence === MAX_SAFE) throw error('FENCE_EXHAUSTED');
}

function defaultIssueIncarnation() {
  const random = globalThis.crypto;
  if (!random || typeof random.getRandomValues !== 'function') throw new Error('crypto unavailable');
  const bytes = new Uint8Array(32);
  random.getRandomValues(bytes);
  let result = '';
  for (const byte of bytes) result += byte.toString(16).padStart(2, '0');
  return result;
}

function issueFresh(issueIncarnation, state) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let issued;
    try {
      issued = issueIncarnation();
    } catch {
      throw error('INCARNATION_ISSUANCE_FAILED');
    }
    if (!identifier(issued)) throw error('INCARNATION_ISSUANCE_FAILED');
    if (issued === state.principal || issued === state.incarnation || state.retired.includes(issued)) continue;
    return issued;
  }
  throw error('INCARNATION_ISSUANCE_FAILED');
}

function transitionCommand(command, newIncarnation) {
  if (command.type === 'create') {
    return {
      type: 'create',
      expectedFence: command.expectedFence,
      newIncarnation,
    };
  }
  return {
    type: command.type,
    expectedFence: command.expectedFence,
    expectedIncarnation: command.expectedIncarnation,
  };
}

function writeState(sql, state) {
  sql.exec(`INSERT INTO ${STATE_TABLE}(id,state_json) VALUES(?,?)
    ON CONFLICT(id) DO UPDATE SET state_json=excluded.state_json`, 1, JSON.stringify(state));
}

function writeReceipt(sql, command, appliedFence) {
  sql.exec(`INSERT INTO ${RECEIPTS_TABLE}(op_id,command_json,applied_fence) VALUES(?,?,?)`,
    command.opId, command.commandJson, appliedFence);
}

function validateOptions(options) {
  if (!isRecord(options)) throw error('INVALID_INPUT');
  const actual = Reflect.ownKeys(options);
  if (actual.some((key) => typeof key !== 'string')
    || !actual.includes('principal')
    || actual.some((key) => key !== 'principal' && key !== 'issueIncarnation')) {
    throw error('INVALID_INPUT');
  }
  const descriptors = new Map();
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (!descriptor || !('value' in descriptor)) throw error('INVALID_INPUT');
    descriptors.set(key, descriptor.value);
  }
  const principal = descriptors.get('principal');
  const issueIncarnation = descriptors.get('issueIncarnation');
  if (!identifier(principal)) throw error('INVALID_INPUT');
  if (issueIncarnation !== undefined && typeof issueIncarnation !== 'function') throw error('INVALID_INPUT');
  return { principal, issueIncarnation: issueIncarnation || defaultIssueIncarnation };
}

export function createIncarnationRepository(storage, options = {}) {
  requireStorage(storage);
  const { principal, issueIncarnation } = validateOptions(options);
  const sql = storage.sql;

  return {
    read() {
      const tablesExist = schemaState(sql);
      const current = readCurrent(sql, principal, tablesExist);
      return cloneState(current.state);
    },

    apply(command) {
      const parsed = validateCommand(command);
      return storage.transactionSync(() => {
        const fresh = !schemaState(sql);
        const current = fresh
          ? { state: createEmptyAuthority(principal), receipts: [] }
          : readCurrent(sql, principal, true);
        const receipt = currentReceipt(current.receipts, parsed);
        if (receipt) {
          if (receipt.commandJson !== parsed.commandJson) throw error('OPERATION_CONFLICT');
          return {
            replayed: true,
            appliedFence: receipt.appliedFence,
            state: cloneState(current.state),
          };
        }

        assertExpectedFence(current.state, parsed.expectedFence);
        assertPhaseAndIdentity(current.state, parsed);
        assertIncrementable(current.state);

        const newIncarnation = parsed.type === 'create'
          ? issueFresh(issueIncarnation, current.state)
          : undefined;
        const next = transitionIncarnation(
          current.state,
          transitionCommand(parsed, newIncarnation),
        );
        if (fresh) createSchema(sql);
        writeState(sql, next);
        writeReceipt(sql, parsed, next.fence);
        return {
          replayed: false,
          appliedFence: next.fence,
          state: cloneState(next),
        };
      });
    },

    applySequence(commands, finalize = null) {
      if (!Array.isArray(commands) || commands.length < 1 || commands.length > 4
        || (finalize !== null && typeof finalize !== 'function')) throw error('INVALID_INPUT');
      const parsedCommands = commands.map(validateCommand);
      return storage.transactionSync(() => {
        const fresh = !schemaState(sql);
        let current = fresh
          ? { state: createEmptyAuthority(principal), receipts: [] }
          : readCurrent(sql, principal, true);
        const results = [];
        if (fresh) createSchema(sql);
        for (const parsed of parsedCommands) {
          const receipt = currentReceipt(current.receipts, parsed);
          if (receipt) {
            if (receipt.commandJson !== parsed.commandJson) throw error('OPERATION_CONFLICT');
            results.push({ replayed: true, appliedFence: receipt.appliedFence, state: cloneState(current.state) });
            continue;
          }
          assertExpectedFence(current.state, parsed.expectedFence);
          assertPhaseAndIdentity(current.state, parsed);
          assertIncrementable(current.state);
          const newIncarnation = parsed.type === 'create' ? issueFresh(issueIncarnation, current.state) : undefined;
          const next = transitionIncarnation(current.state, transitionCommand(parsed, newIncarnation));
          writeState(sql, next);
          writeReceipt(sql, parsed, next.fence);
          current = { state: next, receipts: [...current.receipts, {
            opId: parsed.opId, commandJson: parsed.commandJson, appliedFence: next.fence,
          }] };
          results.push({ replayed: false, appliedFence: next.fence, state: cloneState(next) });
        }
          if (finalize) finalize(sql, results);
          return results;
      });
    },
  };
}
