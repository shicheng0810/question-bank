const fail = code => Object.assign(new Error(code), { code });

/**
 * Bounded native-only cloud sync coordinator. It owns no data and never reads
 * legacy archives: callers provide the normal account sync operation and an
 * exact owner/session predicate. A successful state requires both a positive
 * cloud acknowledgement and an empty native outbox after that acknowledgement.
 */
export function createNativeHistorySyncCoordinator({
  runOnce,
  readPending,
  isCurrent,
  onStatus = () => {},
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  maxRounds = 3,
  maxRateLimitRetries = 2,
} = {}) {
  if (typeof runOnce !== 'function' || typeof readPending !== 'function' || typeof isCurrent !== 'function') {
    throw fail('NATIVE_SYNC_DEPENDENCIES_REQUIRED');
  }
  if (!Number.isSafeInteger(maxRounds) || maxRounds < 1 || maxRounds > 5 ||
      !Number.isSafeInteger(maxRateLimitRetries) || maxRateLimitRetries < 0 || maxRateLimitRetries > 3) {
    throw fail('NATIVE_SYNC_BOUNDS_INVALID');
  }

  let flight = null;
  const guard = () => { if (!isCurrent()) throw fail('STALE_OWNER'); };
  const status = state => { guard(); onStatus(state); };
  const waitCurrent = async milliseconds => {
    let remaining = milliseconds;
    while (remaining > 0) {
      guard();
      const slice = Math.min(remaining, 250);
      await wait(slice);
      remaining -= slice;
    }
    guard();
  };

  return Object.freeze({
    run() {
      guard();
      if (flight) return flight;
      const task = (async () => {
        let rateLimitRetries = 0;
        for (let round = 1; round <= maxRounds; round++) {
          guard();
          status({ state: 'syncing', round });
          const result = await runOnce();
          guard();

          if (result?.paused && result.reason === 'RATE_LIMITED') {
            const seconds = result.retryAfter;
            if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 120 || rateLimitRetries >= maxRateLimitRetries) {
              status({ state: 'pending', reason: 'RATE_LIMITED', retryAfter: Number.isSafeInteger(seconds) ? seconds : null });
              return { synced: false, reason: 'RATE_LIMITED', retryAfter: Number.isSafeInteger(seconds) ? seconds : null };
            }
            rateLimitRetries++;
            status({ state: 'retry-wait', reason: 'RATE_LIMITED', retryAfter: seconds });
            await waitCurrent(seconds * 1000);
            round--;
            continue;
          }

          const pending = await readPending();
          guard();
          if (!Array.isArray(pending)) throw fail('NATIVE_OUTBOX_UNAVAILABLE');
          if (result?.synced === true && pending.length === 0) {
            status({ state: 'synced', round });
            return { synced: true, round, pending: 0 };
          }

          if (pending.length > 0 && round < maxRounds) continue;
          const reason = result?.reason || (pending.length ? 'LOCAL_CHANGES_PENDING' : 'SYNC_NOT_CONFIRMED');
          status({ state: 'pending', reason, pending: pending.length });
          return { synced: false, reason, pending: pending.length, retryAfter: result?.retryAfter ?? null };
        }
        status({ state: 'pending', reason: 'NATIVE_SYNC_ROUND_LIMIT' });
        return { synced: false, reason: 'NATIVE_SYNC_ROUND_LIMIT' };
      })().catch(error => {
        if (isCurrent()) onStatus({ state: error?.code === 'STALE_OWNER' ? 'idle' : 'error', reason: error?.code || 'NATIVE_SYNC_FAILED' });
        throw error;
      }).finally(() => { if (flight === task) flight = null; });
      flight = task;
      return task;
    },
    cancel() { flight = null; },
    snapshot() { return { inFlight: !!flight }; },
  });
}
