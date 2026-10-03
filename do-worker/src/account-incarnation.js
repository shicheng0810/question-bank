const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const HEX64 = /^[0-9a-f]{64}$/;
const STATE_KEYS = Object.freeze(['principal', 'fence', 'phase', 'incarnation', 'retired']);
const EMPTY = 'empty';
const ACTIVE = 'active';
const DELETING = 'deleting';
const RETIRED = 'retired';

function invalid() {
  const error = new Error('INVALID_INPUT');
  error.code = 'INVALID_INPUT';
  return error;
}

function reject(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readExactRecord(value, keys) {
  if (!isRecord(value)) throw invalid();
  const actual = Reflect.ownKeys(value);
  if (actual.some((key) => typeof key !== 'string')
    || actual.length !== keys.length
    || keys.some((key) => !actual.includes(key))) throw invalid();

  const descriptors = new Map();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) throw invalid();
    descriptors.set(key, descriptor.value);
  }
  return descriptors;
}

function identifier(value) {
  return typeof value === 'string' && HEX64.test(value);
}

function safeFence(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validateRetired(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) throw invalid();
  const keySet = new Set(keys);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (!lengthDescriptor || !('value' in lengthDescriptor)
    || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) throw invalid();
  const length = lengthDescriptor.value;
  if (keys.length !== length + 1 || !keySet.has('length')) throw invalid();

  const seen = new Set();
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    if (!keySet.has(key)) throw invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !identifier(descriptor.value)) throw invalid();
    if (seen.has(descriptor.value)) throw invalid();
    seen.add(descriptor.value);
  }
  for (const key of keys) {
    if (key !== 'length' && (!/^\d+$/.test(key) || Number(key) >= length || String(Number(key)) !== key)) {
      throw invalid();
    }
  }
  return seen;
}

function phase(value) {
  return value === EMPTY || value === ACTIVE || value === DELETING || value === RETIRED;
}

function cloneRetired(retired) {
  return retired.slice();
}

export function validateAuthority(state) {
  const fields = readExactRecord(state, STATE_KEYS);
  const principal = fields.get('principal');
  const fence = fields.get('fence');
  const currentPhase = fields.get('phase');
  const incarnation = fields.get('incarnation');
  const retired = fields.get('retired');

  if (!identifier(principal) || !safeFence(fence) || !phase(currentPhase)) throw invalid();
  if (incarnation !== null && !identifier(incarnation)) throw invalid();
  const retiredIds = validateRetired(retired);
  if (incarnation === principal || retiredIds.has(principal)) throw invalid();

  if (currentPhase === EMPTY) {
    if (fence !== 0 || incarnation !== null || retiredIds.size !== 0) throw invalid();
  } else {
    if (fence < 1 || incarnation === null) throw invalid();
  }
  if ((currentPhase === ACTIVE || currentPhase === DELETING) && retiredIds.has(incarnation)) throw invalid();
  if (currentPhase === RETIRED && !retiredIds.has(incarnation)) throw invalid();
  return state;
}

export function createEmptyAuthority(principal) {
  if (!identifier(principal)) throw invalid();
  return { principal, fence: 0, phase: EMPTY, incarnation: null, retired: [] };
}

function validateCommand(command) {
  if (!isRecord(command)) throw invalid();
  const typeDescriptor = Object.getOwnPropertyDescriptor(command, 'type');
  if (!typeDescriptor || !('value' in typeDescriptor) || typeof typeDescriptor.value !== 'string') throw invalid();
  const type = typeDescriptor.value;
  const keys = type === 'create'
    ? ['type', 'expectedFence', 'newIncarnation']
    : type === 'begin-delete' || type === 'finish-delete'
      ? ['type', 'expectedFence', 'expectedIncarnation']
      : null;
  if (!keys) throw invalid();
  const fields = readExactRecord(command, keys);
  const expectedFence = fields.get('expectedFence');
  if (!safeFence(expectedFence)) throw invalid();
  if (type === 'create') {
    const newIncarnation = fields.get('newIncarnation');
    if (!identifier(newIncarnation)) throw invalid();
    return { type, expectedFence, newIncarnation };
  }
  const expectedIncarnation = fields.get('expectedIncarnation');
  if (!identifier(expectedIncarnation)) throw invalid();
  return { type, expectedFence, expectedIncarnation };
}

function assertFence(state, command) {
  if (command.expectedFence !== state.fence) throw reject('STALE_FENCE');
}

function assertIncrementable(state) {
  if (state.fence === MAX_SAFE) throw reject('FENCE_EXHAUSTED');
}

export function transitionIncarnation(state, command) {
  validateAuthority(state);
  const parsed = validateCommand(command);
  assertFence(state, parsed);

  if (parsed.type === 'create') {
    if (state.phase !== EMPTY && state.phase !== RETIRED) throw reject('INVALID_PHASE');
    if (parsed.newIncarnation === state.principal
      || parsed.newIncarnation === state.incarnation
      || state.retired.includes(parsed.newIncarnation)) throw reject('INCARNATION_REUSE');
    assertIncrementable(state);
    return {
      principal: state.principal,
      fence: state.fence + 1,
      phase: ACTIVE,
      incarnation: parsed.newIncarnation,
      retired: cloneRetired(state.retired),
    };
  }

  if (parsed.type === 'begin-delete') {
    if (state.phase !== ACTIVE) throw reject('INVALID_PHASE');
    if (parsed.expectedIncarnation !== state.incarnation) throw reject('STALE_INCARNATION');
    assertIncrementable(state);
    return {
      principal: state.principal,
      fence: state.fence + 1,
      phase: DELETING,
      incarnation: state.incarnation,
      retired: cloneRetired(state.retired),
    };
  }

  if (state.phase !== DELETING) throw reject('INVALID_PHASE');
  if (parsed.expectedIncarnation !== state.incarnation) throw reject('STALE_INCARNATION');
  assertIncrementable(state);
  return {
    principal: state.principal,
    fence: state.fence + 1,
    phase: RETIRED,
    incarnation: state.incarnation,
    retired: [...state.retired, state.incarnation],
  };
}

export function assertCurrentIncarnation(state, claim) {
  validateAuthority(state);
  const fields = readExactRecord(claim, ['principal', 'incarnation', 'fence']);
  const principal = fields.get('principal');
  const incarnation = fields.get('incarnation');
  const fence = fields.get('fence');
  if (!identifier(principal) || !identifier(incarnation) || !safeFence(fence)) throw invalid();
  if (state.phase !== ACTIVE
    || principal !== state.principal
    || incarnation !== state.incarnation
    || fence !== state.fence) throw reject('NOT_CURRENT');
  return true;
}
