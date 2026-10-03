const STATE_KEYS = ['generation', 'status', 'revision', 'data'];
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function invalid() {
  const error = new Error('INVALID_INPUT');
  error.code = 'INVALID_INPUT';
  return error;
}

function rejected(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function stringKeys(value) {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) throw invalid();
  return keys;
}

function record(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalid();
  return value;
}

function exactRecord(value, keys) {
  record(value);
  const actual = stringKeys(value);
  if (actual.length !== keys.length || keys.some((key) => !actual.includes(key))) throw invalid();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) throw invalid();
  }
}

function validJSON(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalid();
    return;
  }
  if (typeof value !== 'object' || ancestors.has(value)) throw invalid();
  ancestors.add(value);
  if (Array.isArray(value)) {
    const length = value.length;
    if (!Number.isSafeInteger(length) || length < 0) throw invalid();
    for (const key of stringKeys(value)) {
      if (key === 'length') continue;
      if (!/^\d+$/.test(key) || Number(key) >= length || String(Number(key)) !== key) throw invalid();
    }
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !('value' in descriptor)) throw invalid();
      validJSON(descriptor.value, ancestors);
    }
  } else {
    record(value);
    for (const key of stringKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) throw invalid();
      validJSON(descriptor.value, ancestors);
    }
  }
  ancestors.delete(value);
}

export function validGeneration(value) {
  return typeof value === 'string' && UUID_V4.test(value);
}

export function validateData(data) {
  record(data);
  validJSON(data);
  return data;
}

export function validateState(state) {
  exactRecord(state, STATE_KEYS);
  if (!validGeneration(state.generation)) throw invalid();
  if (state.status !== 'active' && state.status !== 'deleted') throw invalid();
  if (!Number.isSafeInteger(state.revision) || state.revision < 0) throw invalid();
  validateData(state.data);
  if (state.status === 'deleted' && Reflect.ownKeys(state.data).length !== 0) throw invalid();
  return state;
}

export function validateCommand(command) {
  record(command);
  const type = Object.getOwnPropertyDescriptor(command, 'type');
  if (!type || !('value' in type) || typeof type.value !== 'string') throw invalid();
  const keys = type.value === 'write'
    ? ['type', 'expectedGeneration', 'data']
    : type.value === 'rotate' || type.value === 'delete'
      ? ['type', 'expectedGeneration', 'newGeneration']
      : null;
  if (!keys) throw invalid();
  exactRecord(command, keys);
  if (!validGeneration(command.expectedGeneration)) throw invalid();
  if (type.value === 'write') validateData(command.data);
  else if (!validGeneration(command.newGeneration)) throw invalid();
  return command;
}

function clone(value, ancestors = new Set()) {
  if (value === null || typeof value !== 'object') return value;
  if (ancestors.has(value)) throw invalid();
  ancestors.add(value);
  if (Array.isArray(value)) {
    const result = new Array(value.length);
    for (let index = 0; index < value.length; index += 1) {
      Object.defineProperty(result, String(index), { value: clone(value[index], ancestors), enumerable: true, writable: true, configurable: true });
    }
    ancestors.delete(value);
    return result;
  }
  const result = Object.create(Object.getPrototypeOf(value));
  for (const key of stringKeys(value)) {
    Object.defineProperty(result, key, { value: clone(value[key], ancestors), enumerable: true, writable: true, configurable: true });
  }
  ancestors.delete(value);
  return result;
}

export function cloneState(state) {
  validateState(state);
  return {
    generation: state.generation,
    status: state.status,
    revision: state.revision,
    data: clone(state.data),
  };
}

export function transition(state, command) {
  validateState(state);
  validateCommand(command);

  if (command.expectedGeneration !== state.generation) throw rejected('STALE_GENERATION');
  if (state.status === 'deleted') throw rejected('ACCOUNT_DELETED');
  if (command.type !== 'write' && command.newGeneration === state.generation) throw rejected('GENERATION_REUSE');
  if (state.revision === Number.MAX_SAFE_INTEGER) throw rejected('REVISION_EXHAUSTED');

  return {
    generation: command.type === 'write' ? state.generation : command.newGeneration,
    status: command.type === 'delete' ? 'deleted' : state.status,
    revision: state.revision + 1,
    data: command.type === 'delete' ? {} : clone(command.type === 'write' ? command.data : state.data),
  };
}
