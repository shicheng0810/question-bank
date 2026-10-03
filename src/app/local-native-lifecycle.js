import { createLearningSession } from '../player/learning-session.js';
import { registerImportedBank } from '../player/register-import.js';

/** The extractor has no trusted account session. It manages only this origin's
 * native guest profile, selected by the existing bootstrap, never a typed owner. */
export function createLocalNativeLifecycle({ openSession = createLearningSession } = {}) {
  let session, flight, closed = false;
  async function current() {
    if (closed) throw new Error('CLOSED');
    if (!session) {
      flight ||= openSession({ isCurrent: () => !closed });
      try { session = await flight; } finally { flight = null; }
    }
    if (session.owner.ownerKind !== 'guest') throw new Error('LOCAL_GUEST_REQUIRED');
    return session;
  }
  return Object.freeze({
    async inspect() {
      const s = await current();
      const [banks, history, outbox, conflicts, mutations] = await Promise.all([
        s.storedBanks(), s.history(), s.repository.readRecords('outbox'),
        s.repository.readRecords('conflicts'), s.repository.readRecords('mutations'),
      ]);
      const pending = new Set(outbox.map(row => row.mutationId));
      return { source: 'native IndexedDB / current browser origin', observedAt: new Date().toISOString(), owner: s.owner,
        banks: banks.map(row => ({ bankUid: row.bankUid, revision: row.revision, title: row.metadata.title,
          questionCount: row.metadata.questionCount, visibility: row.metadata.visibility })),
        history: history.map(row => ({ attemptId: row.attempt.attemptId, status: row.attempt.status,
          startedAt: row.attempt.startedAt, device: row.device, scopeCount: row.scope.length,
          syncPending: row.syncPending })),
        sync: { source: 'native outbox/conflicts/mutations', mode: 'guest-local-only', pendingCount: outbox.length,
          conflictCount: conflicts.length, mutationCount: mutations.length,
          queued: outbox.map(row => ({ mutationId: row.mutationId, state: 'queued', attemptCount: row.attemptCount, nextAttemptAt: row.nextAttemptAt })),
          localCommittedCount: mutations.filter(row => !pending.has(row.mutationId)).length,
          cloudReceipt: 'not-applicable-to-guest' } };
    },
    async importQuestions(questions, title) {
      const s = await current();
      const { content } = await registerImportedBank(questions, { title, sourceOrigin: location.origin });
      await s.storeRegisteredBank(content);
      return { bankUid: content.bankUid, questionCount: content.metadata.questionCount };
    },
    async exportBank(bankUid, revision) { return (await (await current()).readStoredBank(bankUid, revision)).content; },
    async startBank(bankUid, revision) {
      const s = await current(); return s.startBank((await s.readStoredBank(bankUid, revision)).content);
    },
    async continueHistory(attemptId) { return (await current()).continueHistory(attemptId); },
    async exportBackup() { return (await current()).exportBackup(); },
    async restoreBackup(bytes) {
      const s = await current();
      try { return await s.importBackup(bytes); } finally { session = null; }
    },
    async close() { closed = true; (session || await flight)?.close(); session = null; },
  });
}
