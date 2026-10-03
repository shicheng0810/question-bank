import { DurableObject } from 'cloudflare:workers';
import { createGenerationRepository } from './generation-repository.js';
import { cloneState, validGeneration, validateData } from './generation-transition.js';

const PUBLIC_ERRORS = new Set([
  'INVALID_SESSION',
  'INVALID_INPUT',
  'NOT_INITIALIZED',
  'STALE_GENERATION',
  'ACCOUNT_DELETED',
  'REVISION_EXHAUSTED',
]);

function failure(error) {
  return { ok: false, error };
}

function exactRecord(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const actual = Reflect.ownKeys(value);
  if (actual.some((key) => typeof key !== 'string')) return false;
  if (actual.length !== keys.length || keys.some((key) => !actual.includes(key))) return false;
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor;
  });
}

function validClaim(claim) {
  return exactRecord(claim, ['generation', 'expiresAt'])
    && validGeneration(claim.generation)
    && Number.isSafeInteger(claim.expiresAt)
    && claim.expiresAt > Date.now();
}

function validAction(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) return false;
  const type = Object.getOwnPropertyDescriptor(action, 'type');
  if (!type || !('value' in type) || (type.value !== 'read' && type.value !== 'write')) return false;
  const keys = type.value === 'read' ? ['type'] : ['type', 'data'];
  if (!exactRecord(action, keys)) return false;
  if (type.value === 'write') {
    try {
      validateData(action.data);
    } catch {
      return false;
    }
  }
  return true;
}

function publicFailure(cause) {
  return PUBLIC_ERRORS.has(cause?.code) ? failure(cause.code) : failure('UNAVAILABLE');
}

export class GenerationStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
  }

  execute(claim, action) {
    if (!validClaim(claim)) return failure('INVALID_SESSION');
    if (!validAction(action)) return failure('INVALID_INPUT');

    try {
      // Repeat the time check immediately before the synchronous repository
      // operation. There is deliberately no await or external call here.
      if (claim.expiresAt <= Date.now()) return failure('INVALID_SESSION');
      const repository = createGenerationRepository(this.ctx.storage);

      if (action.type === 'read') {
        const state = repository.read();
        if (!state) return failure('NOT_INITIALIZED');
        if (state.generation !== claim.generation) return failure('STALE_GENERATION');
        if (state.status === 'deleted') return failure('ACCOUNT_DELETED');
        return { ok: true, state: cloneState(state) };
      }

      const state = repository.apply({
        type: 'write',
        expectedGeneration: claim.generation,
        data: action.data,
      });
      return { ok: true, state: cloneState(state) };
    } catch (cause) {
      return publicFailure(cause);
    }
  }
}
