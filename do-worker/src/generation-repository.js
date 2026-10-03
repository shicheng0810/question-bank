import {
  cloneState,
  transition,
  validGeneration,
  validateData,
  validateState,
} from './generation-transition.js';

const STATE_TABLE = 'gen02_generation_state';
const HISTORY_TABLE = 'gen02_generation_history';

function error(code) {
  const result = new Error(code);
  result.code = code;
  return result;
}

function rows(cursor) {
  if (!cursor) return [];
  if (typeof cursor.toArray === 'function') return cursor.toArray();
  return Array.from(cursor);
}

function query(sql, statement, ...bindings) {
  return rows(sql.exec(statement, ...bindings));
}

function requireStorage(storage) {
  if (!storage || typeof storage.transactionSync !== 'function' || !storage.sql || typeof storage.sql.exec !== 'function') {
    throw error('STORAGE_REQUIRED');
  }
}

function tableExists(sql, tableName) {
  return query(sql, "SELECT name FROM sqlite_master WHERE type='table' AND name=?", tableName).length > 0;
}

function createTables(sql) {
  sql.exec(`CREATE TABLE IF NOT EXISTS ${STATE_TABLE}(
    id INTEGER PRIMARY KEY CHECK (id=1),
    state_json TEXT NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS ${HISTORY_TABLE}(
    generation TEXT PRIMARY KEY
  )`);
}

function storedState(sql) {
  const result = query(sql, `SELECT state_json FROM ${STATE_TABLE} WHERE id=?`, 1);
  if (result.length === 0) return null;
  if (result.length !== 1 || typeof result[0].state_json !== 'string') throw error('INVALID_INPUT');
  let state;
  try {
    state = JSON.parse(result[0].state_json);
  } catch {
    throw error('INVALID_INPUT');
  }
  try {
    validateState(state);
  } catch (cause) {
    if (cause?.code === 'INVALID_INPUT') throw cause;
    throw error('INVALID_INPUT');
  }
  return state;
}

function historyContains(sql, generation) {
  return query(sql, `SELECT generation FROM ${HISTORY_TABLE} WHERE generation=?`, generation).length > 0;
}

function writeState(sql, state) {
  const json = JSON.stringify(state);
  sql.exec(`INSERT INTO ${STATE_TABLE}(id,state_json) VALUES(?,?)
    ON CONFLICT(id) DO UPDATE SET state_json=excluded.state_json`, 1, json);
}

function issueFresh(sql, issueGeneration, currentGeneration) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const issued = issueGeneration();
    if (!validGeneration(issued)) throw error('GENERATION_ISSUANCE_FAILED');
    if (issued === currentGeneration || historyContains(sql, issued)) continue;
    return issued;
  }
  throw error('GENERATION_ISSUANCE_FAILED');
}

function validateRepositoryCommand(command) {
  if (command === null || typeof command !== 'object' || Array.isArray(command)) throw error('INVALID_INPUT');
  const keys = Reflect.ownKeys(command);
  if (keys.some((key) => typeof key !== 'string')) throw error('INVALID_INPUT');
  const type = Object.getOwnPropertyDescriptor(command, 'type');
  if (!type || !('value' in type) || !['write', 'rotate', 'delete'].includes(type.value)) throw error('INVALID_INPUT');
  const expected = type.value === 'write'
    ? ['type', 'expectedGeneration', 'data']
    : ['type', 'expectedGeneration'];
  if (keys.length !== expected.length || expected.some((key) => !keys.includes(key))) throw error('INVALID_INPUT');
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(command, key);
    if (!descriptor || !('value' in descriptor)) throw error('INVALID_INPUT');
  }
  if (!validGeneration(command.expectedGeneration)) throw error('INVALID_INPUT');
  if (type.value === 'write') {
    try { validateData(command.data); } catch { throw error('INVALID_INPUT'); }
  }
}

function checkAuthorization(state, command) {
  if (command.expectedGeneration !== state.generation) throw error('STALE_GENERATION');
  if (state.status === 'deleted') throw error('ACCOUNT_DELETED');
  if (state.revision === Number.MAX_SAFE_INTEGER) throw error('REVISION_EXHAUSTED');
}

export function createGenerationRepository(storage, { issueGeneration = () => crypto.randomUUID() } = {}) {
  requireStorage(storage);
  if (typeof issueGeneration !== 'function') throw error('INVALID_INPUT');
  const sql = storage.sql;

  return {
    initialize() {
      return storage.transactionSync(() => {
        createTables(sql);
        const current = storedState(sql);
        if (current) {
          if (!historyContains(sql, current.generation)) throw error('INVALID_INPUT');
          return cloneState(current);
        }
        const generation = issueFresh(sql, issueGeneration, null);
        const initial = { generation, status: 'active', revision: 0, data: {} };
        sql.exec(`INSERT INTO ${HISTORY_TABLE}(generation) VALUES(?)`, generation);
        writeState(sql, initial);
        return cloneState(initial);
      });
    },

    read() {
      if (!tableExists(sql, STATE_TABLE)) return null;
      const current = storedState(sql);
      return current ? cloneState(current) : null;
    },

    apply(command) {
      validateRepositoryCommand(command);
      return storage.transactionSync(() => {
        if (!tableExists(sql, STATE_TABLE) || !tableExists(sql, HISTORY_TABLE)) throw error('NOT_INITIALIZED');
        const current = storedState(sql);
        if (!current) throw error('NOT_INITIALIZED');
        if (!historyContains(sql, current.generation)) throw error('INVALID_INPUT');
        checkAuthorization(current, command);

        if (command.type === 'write') {
          const next = transition(current, command);
          writeState(sql, next);
          return cloneState(next);
        }

        const generation = issueFresh(sql, issueGeneration, current.generation);
        const next = transition(current, { ...command, newGeneration: generation });
        sql.exec(`INSERT INTO ${HISTORY_TABLE}(generation) VALUES(?)`, generation);
        writeState(sql, next);
        return cloneState(next);
      });
    },
  };
}
