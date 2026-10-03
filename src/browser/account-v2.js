import { canonicalBytes } from '../domain/app-data/canonical.js';
import { readCompletedDeletes, appendCompletedDelete, removeCompletedDelete, migrateCompletedDeleteBindings } from '../storage/profiles/completed-delete-queue.js';
import { parseLegacyAuthResponse } from './legacy-migration-client.js';

/**
 * A4c2 candidate browser account controller.
 *
 * Contract: same-origin POST /api/v2/auth, /api/v2/session and /api/v2/account;
 * strict server metadata owner; sessionStorage-only candidate token; no legacy
 * key access; no cloud history/bank access. Callers own UI and learning state.
 * `snapshot()` and subscriptions expose phase/owner metadata only, never token,
 * ticket or code. The controller is inert unless the caller explicitly opts in.
 */
const ACCOUNT_V2_TOKEN_KEY = 'qb_account_v2_session_v1';
const ACCOUNT_V2_DELETION_JOURNAL_KEY = 'qb_account_v2_delete_ticket_v1';
const ACCOUNT_V2_CLEANUP_KEY = 'qb_account_v2_local_cleanup_v1';
const DELETION_JOURNAL_VERSION = 2;
const TOKEN_RE = /^(?:v2\.[A-Za-z0-9_-]{43}|v3\.[0-9a-f]{64}\.[A-Za-z0-9_-]{43})$/;
const ACCOUNT_ID_RE = /^[0-9a-f]{64}$/;
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ACCOUNT_GENERATION_RE = UUID_V4_RE;
const DELETION_TICKET_RE = /^dt1\.[0-9a-f]{64}\.[0-9a-f]{64}$/;
const MAX_DELETE_POLLS = 8;
// Stay below the server's 20/minute auth throttle even when each bounded job
// step returns the shorter 750ms migration polling hint.
const MAX_MIGRATION_LOGIN_ATTEMPTS = 32;
const MIN_MIGRATION_LOGIN_DELAY_MS = 3_500;
const MAX_MIGRATION_LOGIN_DELAY_MS = 30_000;
const MAX_RATE_LIMIT_RETRY_SECONDS = 3600;
class AccountV2Error extends Error { constructor(code) { super(code); this.name = 'AccountV2Error'; this.code = code; } }
function failure(code) {
  return new AccountV2Error(code);
}
function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}
function validOwner(value) {
  return exactKeys(value, ['ok', 'accountId', 'accountGeneration', 'expiresAt'])
    && value.ok === true
    && ACCOUNT_ID_RE.test(value.accountId)
    && ACCOUNT_GENERATION_RE.test(value.accountGeneration)
    && Number.isSafeInteger(value.expiresAt)
    && value.expiresAt > Date.now();
}
function validToken(value) {
  return typeof value === 'string' && TOKEN_RE.test(value);
}
function newOpId() {
  if (!globalThis.crypto || typeof globalThis.crypto.randomUUID !== 'function') {
    throw failure('UNAVAILABLE');
  }
  return globalThis.crypto.randomUUID();
}
function sameOriginApiBase(value, allowMirrorApi = false) {
  const locationValue = globalThis.location;
  const base = new URL(String(value || '/api'), locationValue ? locationValue.href : 'http://localhost/');
  if (locationValue && base.origin !== locationValue.origin) {
    if (allowMirrorApi !== true || locationValue.origin !== 'https://shicheng0810.github.io'
      || base.origin !== 'https://question-bank-78u.pages.dev' || base.pathname !== '/api'
      || base.search || base.hash || base.username || base.password) throw failure('ORIGIN_NOT_ALLOWED');
    return `${base.origin}/api`;
  }
  return base.pathname.replace(/\/+$/, '') || '/';
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
/**
 * @param {{apiBase?: string, enabled?: boolean, fetchImpl?: typeof fetch}} options
 * @returns {{enabled:boolean, snapshot:Function, subscribe:Function, resume:Function,
 * login:Function, register:Function, logout:Function, deleteAccount:Function,
 * acknowledgeRecovery:Function,
 * continueDeletion:Function}}
 */
export function createAccountV2Controller(options = {}) {
  const enabled = options.enabled === true;
  const apiBase = sameOriginApiBase(options.apiBase || '/api', options.allowMirrorApi);
  const fetchImpl = options.fetchImpl || globalThis.fetch.bind(globalThis);
  const migrationDelay = options.migrationDelay || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const listeners = new Set();
  const deletionCompleteListeners = new Set();
  const requests = new Set();
  let epoch = 0;
  let token = null;
  let owner = null;
  let deletion = null;
  let phase = enabled ? 'guest' : 'off';
  let deletionRecovery = 'none';
  let deletionRecoveryError = null;
  let cleanupRequired = false;
  let resumePromise = null;
  let resumePromiseEpoch = null;
  function readCleanupReceipt() {
    let raw;
    try { raw = globalThis.sessionStorage.getItem(ACCOUNT_V2_CLEANUP_KEY); } catch { throw failure('STORAGE_UNAVAILABLE'); }
    if (raw === null) return null;
    let value;
    try { value = JSON.parse(raw); } catch { throw failure('INVALID_CLEANUP_RECEIPT'); }
    const validEntry = entry => exactKeys(entry, ['owner', 'status']) && entry.status === 'cleanup-required' && (entry.owner === null || validDeletionOwner(entry.owner));
    if (value.version === 1) {
      if (!exactKeys(value, ['version', 'owner', 'status']) || !validEntry({ owner: value.owner, status: value.status })) throw failure('INVALID_CLEANUP_RECEIPT');
    } else if (value.version !== 2 || !exactKeys(value, ['version', 'entries']) || !Array.isArray(value.entries)
      || !value.entries.length || value.entries.length > 100 || !value.entries.every(validEntry)) throw failure('INVALID_CLEANUP_RECEIPT');
    cleanupRequired = true;
    return value;
  }
  async function recoverLocalCleanup() {
    cleanupRequired=true; // storage/corrupt-queue failures remain visible
    const pending = readCleanupReceipt();
    const capturedEpoch = epoch;
    await migrateCompletedDeleteBindings();guard(capturedEpoch);
    if(pending){
      const legacy=pending.version===1?[{owner:pending.owner,status:pending.status}]:pending.entries;
      for(const entry of legacy){await appendCompletedDelete(entry.owner?{accountId:entry.owner.accountId,accountGeneration:entry.owner.accountGeneration}:null);guard(capturedEpoch);}
      if(globalThis.sessionStorage.getItem(ACCOUNT_V2_CLEANUP_KEY)!==JSON.stringify(pending))throw failure('STALE_REQUEST');
      globalThis.sessionStorage.removeItem(ACCOUNT_V2_CLEANUP_KEY);
      if(globalThis.sessionStorage.getItem(ACCOUNT_V2_CLEANUP_KEY)!==null)throw failure('STORAGE_UNAVAILABLE');
    }
    const entries=await readCompletedDeletes();guard(capturedEpoch);
    cleanupRequired=entries.length>0;
    if(!deletionCompleteListeners.size)return;
    for (const entry of entries) {
      if (!entry.owner) continue;
      try {
        for (const listener of deletionCompleteListeners) {
          await listener({ owner: { ...entry.owner }, receipt: { ok: true, status: 'complete' }, cleanupRequired: true });
          guard(capturedEpoch);
        }
        await removeCompletedDelete(entry.owner);guard(capturedEpoch);
      } catch (error) {
        guard(capturedEpoch);
        if (error?.code === 'STALE_REQUEST') throw error;
      }
    }
    const remaining=await readCompletedDeletes();guard(capturedEpoch);cleanupRequired=remaining.length>0;
  }
  function snapshot() {
    return {
      enabled,
      phase,
      epoch,
      owner: owner ? { ...owner } : null,
      pendingDeletion: !!deletion,
      deletionRecovery,
      deletionRecoveryError,
      cleanupRequired,
    };
  }
  function emit() {
    const value = snapshot();
    listeners.forEach((listener) => {
      try { listener(value); } catch { /* UI observers cannot break auth state. */ }
    });
  }
  function storedToken() {
    try {
      const value = globalThis.sessionStorage.getItem(ACCOUNT_V2_TOKEN_KEY);
      return validToken(value) ? value : null;
    } catch {
      return null;
    }
  }
  function storeToken(value) {
    try { globalThis.sessionStorage.setItem(ACCOUNT_V2_TOKEN_KEY, value); } catch { throw failure('STORAGE_UNAVAILABLE'); }
  }
  function clearStoredToken() {
    try { globalThis.sessionStorage.removeItem(ACCOUNT_V2_TOKEN_KEY); } catch { /* retain no in-memory authority */ }
  }
  function exactDeletionJournal(value) {
    return (value?.version === 1 ? exactKeys(value, ['version', 'ticket', 'expiresAt', 'deleteSent'])
      : value?.version === DELETION_JOURNAL_VERSION && exactKeys(value, ['version', 'ticket', 'expiresAt', 'deleteSent', 'owner']) && validDeletionOwner(value.owner))
      && typeof value.ticket === 'string' && DELETION_TICKET_RE.test(value.ticket)
      && Number.isSafeInteger(value.expiresAt) && value.expiresAt > 0
      && typeof value.deleteSent === 'boolean';
  }
  function validDeletionOwner(value) {
    return exactKeys(value, ['accountId', 'accountGeneration', 'expiresAt']) && ACCOUNT_ID_RE.test(value.accountId)
      && ACCOUNT_GENERATION_RE.test(value.accountGeneration) && Number.isSafeInteger(value.expiresAt) && value.expiresAt > 0;
  }
  function journalValue(value) {
    return {
      version: value.version || DELETION_JOURNAL_VERSION,
      ticket: value.ticket,
      expiresAt: value.expiresAt,
      deleteSent: value.deleteSent,
      ...((value.version || DELETION_JOURNAL_VERSION) === DELETION_JOURNAL_VERSION ? { owner: { accountId: value.owner.accountId, accountGeneration: value.owner.accountGeneration, expiresAt: value.owner.expiresAt } } : {}),
    };
  }
  function sameDeletionJournal(left, right) {
    return !!left && !!right
      && left.version === right.version
      && left.ticket === right.ticket
      && left.expiresAt === right.expiresAt
      && left.deleteSent === right.deleteSent
      && (left.version === 1 || (left.owner?.accountId === right.owner?.accountId
        && left.owner?.accountGeneration === right.owner?.accountGeneration
        && left.owner?.expiresAt === right.owner?.expiresAt));
  }
  function readDeletionJournalRaw() {
    let raw;
    try { raw = globalThis.sessionStorage.getItem(ACCOUNT_V2_DELETION_JOURNAL_KEY); } catch {
      return { state: 'storage-error', error: 'STORAGE_UNAVAILABLE' };
    }
    return raw === null ? { state: 'none', raw: null } : { state: 'raw', raw };
  }
  function parseDeletionJournalRaw(raw, now = Date.now()) {
    if (raw === null) return { state: 'none' };
    if (typeof raw !== 'string') return { state: 'invalid', error: 'INVALID_DELETION_JOURNAL' };
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return { state: 'invalid', error: 'INVALID_DELETION_JOURNAL' }; }
    if (!exactDeletionJournal(parsed) || JSON.stringify(journalValue(parsed)) !== raw) {
      return { state: 'invalid', error: 'INVALID_DELETION_JOURNAL' };
    }
    if (parsed.expiresAt <= now) return { state: 'expired', error: 'DELETION_TICKET_EXPIRED', journal: journalValue(parsed) };
    return { state: 'valid', journal: journalValue(parsed) };
  }
  function readDeletionJournal() {
    const raw = readDeletionJournalRaw();
    return raw.state === 'storage-error' ? raw : parseDeletionJournalRaw(raw.raw);
  }
  function guardDeletionJournalContext(current, capturedEpoch) {
    if (capturedEpoch === null) return;
    guard(capturedEpoch);
    if (current !== null && !currentDeletionContext(current, capturedEpoch)) throw failure('STALE_REQUEST');
  }
  function requireNoDeletionJournal(capturedEpoch) {
    guard(capturedEpoch);
    const read = readDeletionJournal();
    guard(capturedEpoch);
    if (read.state === 'none') return;
    if (read.state === 'valid') throw failure('DELETE_PENDING');
    throw failure(read.error || 'STALE_REQUEST');
  }
  function writeDeletionJournal(value, current = null, capturedEpoch = null) {
    const journal = journalValue(value);
    try { globalThis.sessionStorage.setItem(ACCOUNT_V2_DELETION_JOURNAL_KEY, JSON.stringify(journal)); } catch { throw failure('STORAGE_UNAVAILABLE'); }
    guardDeletionJournalContext(current, capturedEpoch);
    const read = readDeletionJournal();
    guardDeletionJournalContext(current, capturedEpoch);
    if (read.state !== 'valid' || !sameDeletionJournal(read.journal, journal)) throw failure('STORAGE_UNAVAILABLE');
    return journal;
  }
  function requireExactCurrentJournal(current, capturedEpoch, expected = current) {
    guard(capturedEpoch);
    if (!currentDeletionContext(current, capturedEpoch)) throw failure('STALE_REQUEST');
    const read = readDeletionJournal();
    guard(capturedEpoch);
    if (!currentDeletionContext(current, capturedEpoch)) throw failure('STALE_REQUEST');
    if (read.state === 'storage-error') throw failure('STORAGE_UNAVAILABLE');
    if (read.state === 'expired') throw failure('DELETION_TICKET_EXPIRED');
    if (read.state !== 'valid' || !sameDeletionJournal(read.journal, expected)) throw failure('STALE_REQUEST');
    return read.journal;
  }
  function synchronizeCurrentJournal(current, capturedEpoch) {
    guard(capturedEpoch);
    if (!currentDeletionContext(current, capturedEpoch)) throw failure('STALE_REQUEST');
    const read = readDeletionJournal();
    guard(capturedEpoch);
    if (!currentDeletionContext(current, capturedEpoch)) throw failure('STALE_REQUEST');
    if (read.state === 'storage-error') throw failure('STORAGE_UNAVAILABLE');
    if (read.state === 'expired') throw failure('DELETION_TICKET_EXPIRED');
    if (read.state !== 'valid' || !sameDeletionJournal(read.journal, { ...current, deleteSent: read.journal.deleteSent })) {
      throw failure('STALE_REQUEST');
    }
    if (read.journal.deleteSent !== current.deleteSent) {
      guard(capturedEpoch);
      if (!currentDeletionContext(current, capturedEpoch)) throw failure('STALE_REQUEST');
      current.deleteSent = read.journal.deleteSent;
    }
    return read.journal;
  }
  function clearCurrentJournal(current, capturedEpoch, expected) {
    requireExactCurrentJournal(current, capturedEpoch, expected);
    try { globalThis.sessionStorage.removeItem(ACCOUNT_V2_DELETION_JOURNAL_KEY); } catch { throw failure('STORAGE_UNAVAILABLE'); }
    const read = readDeletionJournal();
    guard(capturedEpoch);
    if (!currentDeletionContext(current, capturedEpoch)) throw failure('STALE_REQUEST');
    if (read.state === 'none') {
      guard(capturedEpoch);
      if (!currentDeletionContext(current, capturedEpoch)) throw failure('STALE_REQUEST');
      return;
    }
    if (read.state === 'valid' && sameDeletionJournal(read.journal, expected)) throw failure('STORAGE_UNAVAILABLE');
    if (read.state === 'storage-error') throw failure('DELETION_JOURNAL_CLEAR_UNCERTAIN');
    throw failure('STALE_REQUEST');
  }
  function setDeletionRecovery(state = 'none', error = null) {
    deletionRecovery = state;
    deletionRecoveryError = error;
  }
  function enterDeletionRecoveryError(code) {
    ++epoch;
    abortRequests();
    token = null;
    owner = null;
    clearStoredToken();
    deletion = null;
    phase = 'error';
    setDeletionRecovery('error', code);
    emit();
    return failure(code);
  }
  function installDeletionJournal(journal, nextEpoch) {
    guard(nextEpoch);
    const installed = {
      version: journal.version,
      ticket: journal.ticket,
      expiresAt: journal.expiresAt,
      deleteSent: journal.deleteSent,
      epoch: nextEpoch,
      owner: journal.version === 2 ? { ...journal.owner } : null,
    };
    deletion = installed;
    cleanupRequired = !installed.owner || deletionCompleteListeners.size === 0;
    phase = 'deleting';
    setDeletionRecovery('pending');
    emit();
    if (!currentDeletionContext(installed, nextEpoch)) throw failure('STALE_REQUEST');
    return installed;
  }
  function beginDeletionRecovery(journal) {
    const recoveryEpoch = ++epoch;
    abortRequests();
    token = null;
    owner = null;
    clearStoredToken();
    guard(recoveryEpoch);
    const reread = readDeletionJournal();
    if (reread.state !== 'valid' || !sameDeletionJournal(reread.journal, journal)) {
      guard(recoveryEpoch);
      throw enterDeletionRecoveryError(reread.error || 'STALE_REQUEST');
    }
    return installDeletionJournal(reread.journal, recoveryEpoch);
  }
  function protectPendingDeletion() {
    if (deletion) throw failure('DELETE_PENDING');
    const read = readDeletionJournal();
    if (read.state === 'none') return;
    if (read.state === 'valid') {
      beginDeletionRecovery(read.journal);
      throw failure('DELETE_PENDING');
    }
    throw enterDeletionRecoveryError(read.error);
  }
  function abortRequests() {
    requests.forEach((controller) => controller.abort());
    requests.clear();
  }
  function invalidate(nextPhase = 'guest') {
    const transitionEpoch = ++epoch;
    abortRequests();
    token = null;
    owner = null;
    clearStoredToken();
    phase = nextPhase;
    emit();
    return transitionEpoch;
  }
  function guard(capturedEpoch) {
    if (capturedEpoch !== epoch) throw failure('STALE_REQUEST');
  }
  async function request(path, init = {}, capturedEpoch = epoch) {
    guard(capturedEpoch);
    const controller = new AbortController();
    requests.add(controller);
    const headers = new Headers(init.headers || {});
    headers.set('Accept', 'application/json');
    const body = init.body;
    if (body !== undefined && body !== null && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    try {
      return await fetchImpl(`${apiBase}${path}`, {
        ...init,
        headers,
        body: body === undefined || body === null ? undefined : JSON.stringify(body),
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal,
      });
    } catch (error) {
      if (capturedEpoch !== epoch || error?.name === 'AbortError') throw failure('STALE_REQUEST');
      throw failure('UNAVAILABLE');
    } finally {
      requests.delete(controller);
    }
  }
  async function jsonResponse(response, acceptedStatuses = [200], capturedEpoch = epoch) {
    let value;
    try { value = await response.json(); } catch {
      guard(capturedEpoch);
      throw failure('UNAVAILABLE');
    }
    guard(capturedEpoch);
    if (!acceptedStatuses.includes(response.status)) {
      if (response.status === 401) throw failure('AUTH_FAILED');
      if (response.status === 429) throw failure('RATE_LIMITED');
      throw failure('UNAVAILABLE');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('UNAVAILABLE');
    return value;
  }
  async function postAuth(body, capturedEpoch) {
    const response = await request('/v2/auth', { method: 'POST', body }, capturedEpoch);
    const value = await jsonResponse(response, [200], capturedEpoch);
    guard(capturedEpoch);
    if (!exactKeys(value, ['ok', 'token']) || value.ok !== true || !validToken(value.token)) {
      throw failure('AUTH_FAILED');
    }
    return value.token;
  }
  async function validateToken(candidate, capturedEpoch) {
    const response = await request('/v2/session', {
      method: 'POST',
      headers: { Authorization: `Bearer ${candidate}` },
    }, capturedEpoch);
    const value = await jsonResponse(response, [200], capturedEpoch);
    if (!validOwner(value)) throw failure('AUTH_FAILED');
    guard(capturedEpoch);
    return {
      accountId: value.accountId,
      accountGeneration: value.accountGeneration,
      expiresAt: value.expiresAt,
    };
  }
  async function resume() {
    if (!enabled) return snapshot();
    await recoverLocalCleanup();
    if (deletion) return continueDeletion();
    if (resumePromise && resumePromiseEpoch === epoch) return resumePromise;
    const recovered = readDeletionJournal();
    if (recovered.state !== 'none') {
      if (recovered.state !== 'valid') throw enterDeletionRecoveryError(recovered.error);
      beginDeletionRecovery(recovered.journal);
      return continueDeletion();
    }
    setDeletionRecovery();
    const candidate = storedToken();
    const resumeEpoch = invalidate(candidate ? 'checking' : 'guest');
    if (!candidate) return snapshot();
    try {
      guard(resumeEpoch);
      // Keep only an unverified retry candidate in the new session slot. It is
      // never installed as authority until the session response is validated.
      storeToken(candidate);
    } catch (error) {
      if (error?.code === 'STALE_REQUEST') throw error;
      try { guard(resumeEpoch); } catch { throw error; }
      phase = 'error';
      emit();
      throw error;
    }
    const flight = validateToken(candidate, resumeEpoch)
      .then((metadata) => {
        guard(resumeEpoch);
        storeToken(candidate);
        token = candidate;
        owner = metadata;
        phase = 'ready';
        emit();
        return snapshot();
      })
      .catch((error) => {
        if (error?.code === 'STALE_REQUEST') return snapshot();
        guard(resumeEpoch);
        token = null;
        owner = null;
        if (error?.code === 'AUTH_FAILED') clearStoredToken();
        phase = error?.code === 'AUTH_FAILED' ? 'guest' : 'error';
        emit();
        throw error;
      })
      .finally(() => {
        if (resumePromise === flight) {
          resumePromise = null;
          resumePromiseEpoch = null;
        }
      });
    resumePromise = flight;
    resumePromiseEpoch = resumeEpoch;
    return flight;
  }
  async function finishAuth(candidate, capturedEpoch) {
    const metadata = await validateToken(candidate, capturedEpoch);
    guard(capturedEpoch);
    storeToken(candidate);
    token = candidate;
    owner = metadata;
    phase = 'ready';
    emit();
    return snapshot();
  }
  async function login(code, onMigrationProgress = () => {}, confirmRegistration = null) {
    if (!enabled) throw failure('DISABLED');
    protectPendingDeletion();
    const value = String(code || '').trim();
    if (value.length < 4 || value.length > 64) throw failure('INVALID_INPUT');
    const capturedEpoch = invalidate('authenticating');
    let registrationEligible = false;
    try {
      let progress = null;
      for (let attempt = 0; attempt < MAX_MIGRATION_LOGIN_ATTEMPTS; attempt += 1) {
        const response = await request('/v2/auth', { method: 'POST', body: { action: 'login', code: value } }, capturedEpoch);
        let body;
        try { body = await response.json(); } catch { guard(capturedEpoch); throw failure('UNAVAILABLE'); }
        guard(capturedEpoch);
        registrationEligible = exactKeys(body, ['ok', 'error']) && body.ok === false
          && ((response.status === 401 && body.error === 'AUTH_FAILED')
            || (response.status === 410 && body.error === 'ACCOUNT_DELETED'));
        let result;
        try { result = parseLegacyAuthResponse(response.status, body); }
        catch (error) {
          if (error?.code !== 'RATE_LIMITED') throw error;
          const header = response.headers.get('Retry-After');
          const seconds = header && /^\d{1,4}$/.test(header) ? Math.min(MAX_RATE_LIMIT_RETRY_SECONDS, Math.max(1, Number(header))) : 5;
          if (attempt === MAX_MIGRATION_LOGIN_ATTEMPTS - 1) throw failure('MIGRATION_PENDING', { migration: progress, retryAfterMs: seconds * 1000 });
          await migrationDelay(Math.max(MIN_MIGRATION_LOGIN_DELAY_MS, seconds * 1000));
          guard(capturedEpoch);
          continue;
        }
        if (result.state === 'ready') return await finishAuth(result.token, capturedEpoch);
        progress = result.migration;
        try { onMigrationProgress(structuredClone(progress)); } catch { /* presentation callbacks cannot alter authentication */ }
        if (attempt === MAX_MIGRATION_LOGIN_ATTEMPTS - 1) throw failure('MIGRATION_PENDING', { migration: progress, retryAfterMs: result.retryAfterMs });
        await migrationDelay(Math.min(MAX_MIGRATION_LOGIN_DELAY_MS, Math.max(MIN_MIGRATION_LOGIN_DELAY_MS, result.retryAfterMs)));
        guard(capturedEpoch);
      }
      throw failure('MIGRATION_PENDING', { migration: progress });
    } catch (error) {
      // AUTH_FAILED alone is never permission to create. The authority must
      // issue a fenced registration intent before presentation asks consent.
      if (registrationEligible && typeof confirmRegistration === 'function'
        && ['AUTH_FAILED', 'ACCOUNT_DELETED'].includes(error?.code)) {
        guard(capturedEpoch);
        return completeRegistration(value, confirmRegistration, capturedEpoch);
      }
      if (error?.code !== 'STALE_REQUEST') {
        try { guard(capturedEpoch); } catch { throw error; }
        phase = error?.code === 'AUTH_FAILED' ? 'guest' : 'error';
        emit();
      }
      throw error;
    }
  }
  async function register(code, confirmFn) {
    if (!enabled) throw failure('DISABLED');
    protectPendingDeletion();
    const value = String(code || '').trim();
    if (value.length < 4 || value.length > 64 || typeof confirmFn !== 'function') throw failure('INVALID_INPUT');
    const capturedEpoch = invalidate('authenticating');
    return completeRegistration(value, confirmFn, capturedEpoch);
  }
  async function completeRegistration(value, confirmFn, capturedEpoch) {
    try {
      const opId = newOpId();
      const preparedResponse = await request('/v2/auth', {
        method: 'POST',
        body: { action: 'prepare-register', code: value, opId },
      }, capturedEpoch);
      const prepared = await jsonResponse(preparedResponse, [200], capturedEpoch);
      guard(capturedEpoch);
      if (!exactKeys(prepared, ['ok', 'intent', 'expiresAt']) || prepared.ok !== true
        || typeof prepared.intent !== 'string' || !/^ri1\.[0-9a-f]{64}$/.test(prepared.intent)
        || !Number.isSafeInteger(prepared.expiresAt) || prepared.expiresAt <= Date.now()) throw failure('UNAVAILABLE');
      guard(capturedEpoch);
      const approved = await confirmFn();
      guard(capturedEpoch);
      if (!approved) { phase = 'guest'; emit(); return { ...snapshot(), cancelled: true }; }
      const candidate = await postAuth({ action: 'register', code: value, opId, intent: prepared.intent }, capturedEpoch);
      return await finishAuth(candidate, capturedEpoch);
    } catch (error) {
      if (error?.code !== 'STALE_REQUEST') {
        try { guard(capturedEpoch); } catch { throw error; }
        phase = error?.code === 'AUTH_FAILED' ? 'guest' : 'error';
        emit();
      }
      throw error;
    }
  }
  function enter(code, confirmFn, onMigrationProgress = () => {}) {
    if (typeof confirmFn !== 'function') return Promise.reject(failure('INVALID_INPUT'));
    return login(code, onMigrationProgress, confirmFn);
  }
  function logout() {
    if (!enabled) return snapshot();
    protectPendingDeletion();
    invalidate('guest');
    return snapshot();
  }
  async function deleteAccount(confirmFn) {
    if (!enabled) throw failure('AUTH_FAILED');
    protectPendingDeletion();
    if (!token || !owner || typeof confirmFn !== 'function') throw failure('AUTH_FAILED');
    const capturedEpoch = epoch;
    const capturedToken = token;
    const capturedOwner = { ...owner };
    if (!(await confirmFn())) return { ...snapshot(), cancelled: true };
    guard(capturedEpoch);
    if (token !== capturedToken || !owner
      || owner.accountId !== capturedOwner.accountId
      || owner.accountGeneration !== capturedOwner.accountGeneration) throw failure('STALE_REQUEST');
    const prepareEpoch = invalidate('deleting');
    try {
      const response = await request('/v2/account', {
        method: 'POST',
        headers: { Authorization: `Bearer ${capturedToken}` },
        body: { action: 'prepare-delete', opId: newOpId() },
      }, prepareEpoch);
      const prepared = await jsonResponse(response, [200], prepareEpoch);
      guard(prepareEpoch);
      if (!exactKeys(prepared, ['ok', 'ticket', 'expiresAt']) || prepared.ok !== true
        || typeof prepared.ticket !== 'string' || !DELETION_TICKET_RE.test(prepared.ticket)
        || !Number.isSafeInteger(prepared.expiresAt) || prepared.expiresAt <= Date.now()) throw failure('UNAVAILABLE');
      guard(prepareEpoch);
      // Do not let a delayed prepare response overwrite a journal installed while it awaited.
      requireNoDeletionJournal(prepareEpoch);
      const journal = writeDeletionJournal({
        owner: capturedOwner,
        ticket: prepared.ticket,
        expiresAt: prepared.expiresAt,
        deleteSent: false,
      }, null, prepareEpoch);
      guard(prepareEpoch);
      installDeletionJournal(journal, prepareEpoch);
      return continueDeletion();
    } catch (error) {
      if (error?.code === 'STALE_REQUEST') throw error;
      try { guard(prepareEpoch); } catch { throw error; }
      phase = 'error';
      setDeletionRecovery('error', error?.code || 'UNAVAILABLE');
      emit();
      throw error;
    }
  }
  let deletionFlight = null;
  function currentDeletionContext(current, deletionEpoch) {
    return epoch === deletionEpoch && deletion === current && current.epoch === deletionEpoch;
  }
  function acknowledgementContext(captured) {
    guard(captured.epoch);
    if (phase !== 'error' || deletionRecovery !== 'error'
      || deletionRecoveryError !== captured.code || deletion !== captured.deletion) {
      throw failure('STALE_REQUEST');
    }
    if (deletionFlight !== null) throw failure('DELETE_PENDING');
  }
  function readAcknowledgementRaw(captured) {
    acknowledgementContext(captured);
    const read = readDeletionJournalRaw();
    acknowledgementContext(captured);
    if (read.state === 'storage-error') throw failure('STORAGE_UNAVAILABLE');
    return read.raw;
  }
  function requireAcknowledgementJournal(captured, raw) {
    const parsed = parseDeletionJournalRaw(raw);
    if (parsed.state === 'valid') throw failure('DELETE_PENDING');
    const expectedState = captured.code === 'INVALID_DELETION_JOURNAL' ? 'invalid'
      : captured.code === 'DELETION_TICKET_EXPIRED' ? 'expired'
        : 'none';
    if (parsed.state !== expectedState) throw failure('STALE_REQUEST');
    return parsed;
  }
  function reportAcknowledgementError(captured, code) {
    acknowledgementContext(captured);
    phase = 'error';
    setDeletionRecovery('error', code);
    emit();
    return failure(code);
  }
  function completeAcknowledgement(captured) {
    acknowledgementContext(captured);
    const completionEpoch = ++epoch;
    abortRequests();
    token = null;
    owner = null;
    clearStoredToken();
    if (epoch !== completionEpoch) throw failure('STALE_REQUEST');
    deletion = null;
    phase = 'guest';
    setDeletionRecovery();
    emit();
    return snapshot();
  }
  function reportDeletionError(current, deletionEpoch, error) {
    if (currentDeletionContext(current, deletionEpoch)) {
      phase = 'error';
      setDeletionRecovery('error', error?.code || 'UNAVAILABLE');
      emit();
    }
    return error;
  }
  async function runDeletion(current, deletionEpoch) {
    let attempts = 0;
    while (deletion === current && current.epoch === deletionEpoch
      && attempts < MAX_DELETE_POLLS && current.expiresAt > Date.now()) {
      guard(deletionEpoch);
      let expected;
      try { expected = synchronizeCurrentJournal(current, deletionEpoch); } catch (error) {
        if (error?.code === 'STALE_REQUEST') throw error;
        throw reportDeletionError(current, deletionEpoch, error);
      }
      const action = current.deleteSent ? 'status' : 'delete';
      attempts += 1;
      let value;
      try {
        const response = await request('/v2/account', {
          method: 'POST',
          body: { action, ticket: current.ticket },
        }, deletionEpoch);
        value = await jsonResponse(response, [200, 202], deletionEpoch);
        guard(deletionEpoch);
        if (!currentDeletionContext(current, deletionEpoch)) throw failure('STALE_REQUEST');
        if (!exactKeys(value, ['ok', 'status']) || value.ok !== true
          || !['pending', 'complete'].includes(value.status)) throw failure('UNAVAILABLE');
        requireExactCurrentJournal(current, deletionEpoch, expected);
      } catch (error) {
        // A lost first response must retry the idempotent delete action, not jump to status.
        if (error?.code === 'STALE_REQUEST') throw error;
        reportDeletionError(current, deletionEpoch, error);
        if (action === 'delete' && error?.code === 'UNAVAILABLE' && attempts < MAX_DELETE_POLLS) {
          await sleep(250);
          continue;
        }
        throw error;
      }
      if (value.status === 'complete') {
        if (!currentDeletionContext(current, deletionEpoch)) throw failure('STALE_REQUEST');
        const cleanupOwner=current.owner?{accountId:current.owner.accountId,accountGeneration:current.owner.accountGeneration}:null;
        // Durable non-credential task precedes any destructive local listener.
        cleanupRequired=true;
        try{await appendCompletedDelete(cleanupOwner);guard(deletionEpoch);}
        catch(error){if(error?.code==='STALE_REQUEST'||!currentDeletionContext(current,deletionEpoch))throw failure('STALE_REQUEST');throw reportDeletionError(current,deletionEpoch,error);}
        if (!currentDeletionContext(current, deletionEpoch)) throw failure('STALE_REQUEST');
        cleanupRequired = !current.owner || deletionCompleteListeners.size === 0;
        const completion = { owner: current.owner ? { ...current.owner } : null, receipt: { ok: true, status: 'complete' }, cleanupRequired };
        try {
          for (const listener of deletionCompleteListeners) {
            await listener(structuredClone(completion));
            if (!currentDeletionContext(current, deletionEpoch)) throw failure('STALE_REQUEST');
          }
        } catch (error) {
          cleanupRequired = true;
          if (error?.code === 'STALE_REQUEST' || !currentDeletionContext(current, deletionEpoch)) throw failure('STALE_REQUEST');
          // Server deletion is already verified complete. Persist the retry
          // metadata below, then clear the credential ticket; never restore A.
        }
        if(!cleanupRequired){
          cleanupRequired=true;
          try{await removeCompletedDelete(cleanupOwner);guard(deletionEpoch);cleanupRequired=false;}
          catch(error){if(error?.code==='STALE_REQUEST'||!currentDeletionContext(current,deletionEpoch))throw failure('STALE_REQUEST');throw reportDeletionError(current,deletionEpoch,error);}
        }
        if (cleanupRequired) {
          // This non-credential receipt preserves the warning without blocking B.
          try {
            const previous = readCleanupReceipt();
            const entry = { owner: current.owner ? { ...current.owner } : null, status: 'cleanup-required' };
            const entries = previous ? previous.version === 1 ? [{ owner: previous.owner, status: previous.status }] : previous.entries : [];
            if (!entries.some(value => value.owner?.accountId === entry.owner?.accountId && value.owner?.accountGeneration === entry.owner?.accountGeneration)) entries.push(entry);
            if (entries.length > 100) throw failure('LOCAL_CLEANUP_QUEUE_FULL');
            const pending = JSON.stringify(entries.length === 1 && !previous ? { version: 1, ...entry } : { version: 2, entries });
            globalThis.sessionStorage.setItem(ACCOUNT_V2_CLEANUP_KEY, pending);
            if (globalThis.sessionStorage.getItem(ACCOUNT_V2_CLEANUP_KEY) !== pending) throw failure('STORAGE_UNAVAILABLE');
          } catch (error) { throw reportDeletionError(current, deletionEpoch, error?.code ? error : failure('STORAGE_UNAVAILABLE')); }
        }
        try { clearCurrentJournal(current, deletionEpoch, expected); } catch (error) {
          if (error?.code === 'STALE_REQUEST') throw error;
          throw reportDeletionError(current, deletionEpoch, error);
        }
        deletion = null;
        setDeletionRecovery();
        if (!owner) phase = 'deleted';
        emit();
        return snapshot();
      }
      if (!currentDeletionContext(current, deletionEpoch)) throw failure('STALE_REQUEST');
      if (!current.deleteSent) {
        try {
          requireExactCurrentJournal(current, deletionEpoch, expected);
          writeDeletionJournal({ ...current, deleteSent: true }, current, deletionEpoch);
          requireExactCurrentJournal(current, deletionEpoch, { ...expected, deleteSent: true });
        } catch (error) {
          if (error?.code === 'STALE_REQUEST') throw error;
          throw reportDeletionError(current, deletionEpoch, error);
        }
        guard(deletionEpoch);
        if (!currentDeletionContext(current, deletionEpoch)) throw failure('STALE_REQUEST');
        current.deleteSent = true;
      }
      phase = 'deleting';
      setDeletionRecovery('pending');
      emit();
      await sleep(250);
    }
    if (currentDeletionContext(current, deletionEpoch)) {
      phase = 'error';
      setDeletionRecovery('error', current.expiresAt <= Date.now() ? 'DELETION_TICKET_EXPIRED' : 'UNAVAILABLE');
      emit();
      throw failure(deletionRecoveryError);
    }
    throw failure('STALE_REQUEST');
  }
  function continueDeletion() {
    if (!deletion) return Promise.resolve(snapshot());
    if (deletion.epoch !== epoch) return Promise.reject(failure('STALE_REQUEST'));
    if (deletionFlight && deletionFlight.deletion === deletion && deletionFlight.epoch === epoch) {
      return deletionFlight.promise;
    }
    const current = deletion;
    const deletionEpoch = epoch;
    let promise;
    promise = Promise.resolve().then(() => runDeletion(current, deletionEpoch)).finally(() => {
      if (deletionFlight && deletionFlight.promise === promise) deletionFlight = null;
    });
    deletionFlight = { deletion: current, epoch: deletionEpoch, promise };
    phase = 'deleting';
    emit();
    return promise;
  }
  async function acknowledgeRecovery(confirmFn) {
    // Disabled candidates never inspect the journal slot.
    if (!enabled) return snapshot();
    if (typeof confirmFn !== 'function') throw failure('INVALID_INPUT');
    const captured = {
      epoch,
      deletion,
      code: deletionRecoveryError,
    };
    if (!['INVALID_DELETION_JOURNAL', 'DELETION_TICKET_EXPIRED', 'DELETION_JOURNAL_CLEAR_UNCERTAIN'].includes(captured.code)) {
      throw failure('STALE_REQUEST');
    }
    const raw = readAcknowledgementRaw(captured);
    requireAcknowledgementJournal(captured, raw);
    const approved = await confirmFn();
    if (!approved) return { ...snapshot(), cancelled: true };
    acknowledgementContext(captured);
    const confirmedRaw = readAcknowledgementRaw(captured);
    const confirmed = requireAcknowledgementJournal(captured, confirmedRaw);
    if (confirmedRaw !== raw) throw failure('STALE_REQUEST');
    if (captured.code === 'DELETION_JOURNAL_CLEAR_UNCERTAIN') {
      // This acknowledgement only accepts an exact, confirmed absent slot.
      if (confirmed.state !== 'none') throw failure('STALE_REQUEST');
      return completeAcknowledgement(captured);
    }
    try { globalThis.sessionStorage.removeItem(ACCOUNT_V2_DELETION_JOURNAL_KEY); } catch {
      throw failure('STORAGE_UNAVAILABLE');
    }
    acknowledgementContext(captured);
    const post = readDeletionJournalRaw();
    acknowledgementContext(captured);
    if (post.state === 'storage-error') {
      throw reportAcknowledgementError(captured, 'DELETION_JOURNAL_CLEAR_UNCERTAIN');
    }
    const postParsed = parseDeletionJournalRaw(post.raw);
    if (postParsed.state === 'none') return completeAcknowledgement(captured);
    // Never erase or reinterpret a record that arrived while removal was being verified.
    throw reportAcknowledgementError(captured, 'STALE_REQUEST');
  }
  function subscribe(listener) {
    if (typeof listener !== 'function') throw failure('INVALID_INPUT');
    listeners.add(listener);
    listener(snapshot());
    return () => listeners.delete(listener);
  }
  function subscribeDeletionComplete(listener) {
    if (typeof listener !== 'function') throw failure('INVALID_INPUT');
    deletionCompleteListeners.add(listener);
    return () => deletionCompleteListeners.delete(listener);
  }

  // Narrow authenticated data transport. It returns bounded application data,
  // never a token, arbitrary fetch capability, Response or request headers.
  async function authenticatedTransport(command) {
    if (!enabled || phase !== 'ready' || !owner || !token || owner.expiresAt <= Date.now()) throw failure('AUTH_FAILED');
    protectPendingDeletion();
    if (!command || !exactKeys(command, Object.hasOwn(command, 'body') ? ['path', 'method', 'body'] : ['path', 'method'])) throw failure('INVALID_INPUT');
    const url = new URL(String(command.path), 'http://bounded.invalid');
    if (url.origin !== 'http://bounded.invalid' || !command.path.startsWith('/v2/') || url.hash) throw failure('INVALID_INPUT');
    const rules = {
      '/v2/sync/capabilities': { methods: ['GET'], keys: [], responseMax: 1024 },
      '/v2/sync/push': { methods: ['POST'], keys: [], requestMax: 256 * 1024, responseMax: 256 * 1024 },
      '/v2/sync/pull': { methods: ['GET'], keys: ['after', 'until', 'limit'], responseMax: 512 * 1024 },
      '/v2/content/chunks': { methods: ['GET', 'PUT'], keys: ['contentDigest', 'chunkIndex'], requestMax: 512 * 1024, responseMax: 512 * 1024 },
      '/v2/content/manifests': { methods: ['POST', 'GET'], keys: ['contentDigest'], requestMax: 128 * 1024, responseMax: 129 * 1024 },
      '/v2/export/start': { methods: ['POST'], keys: [], requestMax: 2048, responseMax: 8 * 1024 },
      '/v2/export/reset': { methods: ['POST'], keys: [], requestMax: 2048, responseMax: 2048 },
      '/v2/export/page': { methods: ['GET'], keys: ['exportId', 'section', 'after', 'limit'], responseMax: 512 * 1024 },
      '/v2/export/chunk': { methods: ['GET'], keys: ['exportId', 'contentDigest', 'chunkIndex'], responseMax: 512 * 1024 },
      '/v2/legacy/history': { methods: ['GET'], keys: ['limit', 'cursor', 'id'], responseMax: 409_600 },
      '/v2/legacy/banks': { methods: ['GET'], keys: ['limit', 'cursor', 'id', 'chunkIndex', 'part'], responseMax: 256 * 1024 },
    };
    const rule = rules[url.pathname]; const keys = [...url.searchParams.keys()];
    if (!rule || !rule.methods.includes(command.method) || keys.some(key => !rule.keys.includes(key)) || new Set(keys).size !== keys.length) throw failure('INVALID_INPUT');
    if (command.method === 'GET' && Object.hasOwn(command, 'body')) throw failure('INVALID_INPUT');
    let body; const headers = new Headers({ Accept: 'application/json' });
    if (Object.hasOwn(command, 'body')) {
      if (url.pathname === '/v2/content/chunks') {
        if (!(command.body instanceof Uint8Array)) throw failure('INVALID_INPUT');
        body = new Uint8Array(command.body); headers.set('Content-Type', 'application/octet-stream');
      } else {
        try { body = canonicalBytes(command.body); } catch { throw failure('INVALID_INPUT'); }
        headers.set('Content-Type', 'application/json');
      }
      if (!rule.requestMax || body.byteLength > rule.requestMax) throw failure('BODY_TOO_LARGE');
    }
    const capturedEpoch = epoch, capturedOwner = { ...owner }, capturedToken = token;
    const current = () => {
      guard(capturedEpoch);
      if (phase !== 'ready' || token !== capturedToken || !owner || owner.accountId !== capturedOwner.accountId || owner.accountGeneration !== capturedOwner.accountGeneration) throw failure('STALE_REQUEST');
    };
    current(); headers.set('Authorization', `Bearer ${capturedToken}`);
    if(url.pathname==='/v2/sync/pull')headers.set('X-QB-Resume-Reader','2');
    const controller = new AbortController(); requests.add(controller);
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetchImpl(`${apiBase}${url.pathname}${url.search}`, { method: command.method, headers, body, credentials: 'omit', cache: 'no-store', redirect: 'error', signal: controller.signal });
      current();
      const reader = response.body?.getReader(); if (!reader) throw failure('UNAVAILABLE');
      let size = 0; const chunks = [];
      const responseLimit = Math.min(512 * 1024, rule.responseMax || 512 * 1024);
      try { for (;;) { const part = await reader.read(); current(); if (part.done) break; size += part.value.length; if (size > responseLimit) { await reader.cancel(); throw failure('RESPONSE_TOO_LARGE'); } chunks.push(part.value); } }
      finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      current();
      let value;
      const rawLegacy = response.ok && ['/v2/legacy/history', '/v2/legacy/banks'].includes(url.pathname) && url.searchParams.has('id');
      if (response.ok && (['/v2/content/chunks', '/v2/export/chunk'].includes(url.pathname) || rawLegacy) && command.method === 'GET') value = bytes;
      else { try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw failure('UNAVAILABLE'); } }
      current();
      const retry = response.headers.get('Retry-After');
      const archiveHeaders = {};
      if (rawLegacy) for (const name of ['content-type','content-length','x-legacy-source-key','x-legacy-source-sha256','x-legacy-byte-length','x-legacy-chunk-sha256','x-legacy-chunk-index','x-legacy-chunk-count']) { const header=response.headers.get(name);if(header!==null)archiveHeaders[name]=header; }
      return { status: response.status, body: value, ...(rawLegacy?{headers:archiveHeaders}:{}), retryAfter: retry && /^[1-9][0-9]{0,3}$/.test(retry) ? Number(retry) : null, epoch: capturedEpoch, owner: capturedOwner };
    } catch (error) {
      if (capturedEpoch !== epoch) throw failure('STALE_REQUEST');
      if (error instanceof AccountV2Error) throw error;
      throw failure('UNAVAILABLE');
    } finally { clearTimeout(timer); requests.delete(controller); }
  }

  return Object.freeze({
    enabled,
    snapshot,
    subscribe,
    resume,
    login,
    enter,
    register,
    logout,
    deleteAccount,
    acknowledgeRecovery,
    continueDeletion,
    authenticatedTransport,
    subscribeDeletionComplete,
  });
}

export { ACCOUNT_V2_TOKEN_KEY, ACCOUNT_V2_TOKEN_KEY as ACCOUNT_V2_SESSION_KEY, AccountV2Error };
