import { canonicalContentBytes, sha256Hex } from '../domain/app-data/canonical.js';
import { makeSourceKey } from '../domain/app-data/identity.js';
import { applyRegistrationPlan, finalizeRegisteredQuestions } from '../domain/question/registered-identity.js';
import { validateBankContent } from '../domain/question/bank-content.js';

/** Explicit import action only. The returned full typed body is persisted once;
 * reloads use that registered bankUid and never regenerate these identities.
 */
export async function registerImportedBank(value, { title, sourceOrigin, namespace = `import-${crypto.randomUUID()}`, legacyArchive = null, registrationIdentity = null }) {
  const bytes = canonicalContentBytes(value), questions = JSON.parse(new TextDecoder().decode(bytes));
  if (!Array.isArray(questions) || !questions.length || questions.length > 5000) throw Object.assign(new Error('IMPORT_QUESTION_COUNT'), { code: 'IMPORT_QUESTION_COUNT' });
  const scopeId = registrationIdentity?.scopeId ?? crypto.randomUUID(), bankUid = registrationIdentity?.bankUid ?? crypto.randomUUID();
  const bank = { sourceOrigin, namespace, sourceKey: makeSourceKey(sourceOrigin, namespace), bankUid, slug: namespace, title: String(title || 'Imported bank'), policy: 'private' };
  const sourceDigest = await sha256Hex(bytes);
  if(registrationIdentity && (!Array.isArray(registrationIdentity.questionUids)||registrationIdentity.questionUids.length!==questions.length))throw Object.assign(new Error('IMPORT_IDENTITY_BINDING'),{code:'IMPORT_IDENTITY_BINDING'});
  const plan = { planId: registrationIdentity?.planId ?? crypto.randomUUID(), scopeId, bank, items: questions.map((question, index) => ({ localId: `row-${index}`, legacyRevision: sourceDigest, legacyRawId: String(question.id ?? index), legacyRuntimeId: String(question.id ?? index), question, intent: 'create', questionUid: registrationIdentity?.questionUids[index] ?? crypto.randomUUID() })) };
  const result = await applyRegistrationPlan({ schemaVersion: 1, scopeId, banks: [], questions: [], receipts: [] }, plan);
  if (legacyArchive !== null && (!legacyArchive || typeof legacyArchive.sourceKey !== 'string' || !/^[0-9a-f]{64}$/.test(legacyArchive.sha256 || '') || !/^[0-9a-f]{64}$/.test(legacyArchive.metaSha256 || ''))) throw Object.assign(new Error('INVALID_LEGACY_ARCHIVE_REFERENCE'), { code: 'INVALID_LEGACY_ARCHIVE_REFERENCE' });
  const finalized = await finalizeRegisteredQuestions(plan.items.map((item, index) => ({
    ...item.question,
    bankUid,
    questionUid: item.questionUid,
    questionKey: `${bankUid}/${item.questionUid}`,
    provenance: [],
    ...(legacyArchive ? { legacyArchiveSource: { sourceKey: legacyArchive.sourceKey, questionsSha256: legacyArchive.sha256, metaSha256: legacyArchive.metaSha256, legacyRawId: result.rows[index].alias.legacyRawId } } : {}),
  })));
  const content = { format: 'qb-bank-content-v2', schemaVersion: 1, bankUid, metadata: { title: bank.title, questionCount: finalized.length, visibility: 'private' }, questions: finalized };
  await validateBankContent(content);
  return { content, aliases: result.rows.map(row => row.alias), registry: result.registry, plan };
}
