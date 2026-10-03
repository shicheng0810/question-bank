export * from './snapshot-continuation.js';
import {
  APP_DATA_DB_SCHEMA_VERSION, APP_DATA_EXCHANGE_SCHEMA_VERSION, APP_DATA_PAYLOAD_SCHEMA_VERSION,
  APP_DATA_PROTOCOL_VERSION, APP_DATA_LIMITS, APP_DATA_CONTENT_LIMITS, CANONICAL_CONTENT_LIMITS, ALIAS_KEY_PATH, CANONICAL_FORMAT
} from "./constants.js";
export { validateHistorySnapshotPayload, validateImportedHistorySnapshot, validateHistorySnapshotSource, validateHistorySnapshotSummary, validateHistorySnapshotBinding, deriveHistorySnapshotId } from './history-snapshot-records.js';
import { validateHistorySnapshotPayload } from './history-snapshot-records.js';
import {
  AppDataValidationError, assertUtf8Within, canonicalBytes, canonicalContentBytes, canonicalDigest, sha256Hex, utf8ByteLength
} from "./canonical.js";
import { makeLegacyId, makeSourceKey, validateAlias } from "./identity.js";
import { validateExportManifest as validateStrictExportManifest } from "./export-manifest.js";
import {
  validateParentResumeDependency,
  validateResumeAttemptBinding,
  validateResumeDependencies,
  validateResumeState,
  validateResumeValidationContext
} from "./resume-dependencies.js";
import {
  validateBankMetadata,
  validateBankRevisionRecord,
  validateChunkManifest,
  validateContentManifest,
  validateContentReference,
  validateResumeReference
} from "./content-records.js";
import {
  validateAnswerEvent as validateCoreAnswerEvent,
  validateAnswerInput,
  validateAttemptRecord,
  validateAttemptScope,
  validateAttemptScopeRecord,
  validateAttemptBinding,
  validateAttempt as validateAttemptAlias,
  validateCompleteAttemptScope,
  validateDraft as validateDraftAlias,
  validateDraftForAttempt,
  validateDraftRecord,
  validateGradeAtTime,
  validateInput,
  validateResumeDraft,
  validateResumeDraftForAttempt
} from "./core-records.js";
import {
  validateActiveProfilePointer as validateLocalActiveProfilePointer,
  validateContentChunkRecord,
  validateCheckpointRecord,
  validateEntityTombstoneRecord,
  validateImportReceiptRecord,
  validateLegacyAggregateRecord,
  validateLegacyEvidence as validateLocalLegacyEvidence,
  validateLegacyRawRecord,
  validateMetaRecord,
  validateMigrationJournalRecord,
  validateOutboxRecord,
  validateProfileRegistryRecord,
  validateProjectionMeta,
  validateSyncCoordinatorLease,
  validateUserStateRecord,
  validateVerificationJournal,
  validateWriterLeaseRecord,
  validateLease as validateLocalLease
} from "./local-records.js";
import { decodeCursor, encodeCursor, validateCursor } from "./cursor.js";
import {
  computeMutationDigest,
  mutationDigestInput,
  validateConflictRecord,
  validateMutation,
  validateMutationPayload,
  validateMutationRecord,
  verifyMutationDigest
} from "./mutation-records.js";
import {
  validateChangeLogRecord,
  validateMutationReceipt,
  validatePullPage,
  validatePullRequest,
  validatePullResponse,
  validatePushAcknowledgement,
  validatePushRequest,
  validatePushResponse
} from "./sync-wire.js";
import {
  validateAccountDeleteRequest,
  validateAccountDeletionResponse,
  validateAuthBootstrapResponse,
  validateCutoverEvidence,
  validateDeletionCapabilityRequest,
  validateGenerationClaim,
  validateInternalSessionClaim,
  validateCursorReset,
  validateLegacyImportJob,
  validateLegacyImportJobIntent,
  validateSessionCredentialV2
} from "./auth-recovery.js";

export {
  APP_DATA_DB_SCHEMA_VERSION, APP_DATA_EXCHANGE_SCHEMA_VERSION, APP_DATA_PAYLOAD_SCHEMA_VERSION,
  APP_DATA_PROTOCOL_VERSION, APP_DATA_LIMITS, APP_DATA_CONTENT_LIMITS, CANONICAL_CONTENT_LIMITS, ALIAS_KEY_PATH, CANONICAL_FORMAT,
  AppDataValidationError, assertUtf8Within, canonicalBytes, canonicalContentBytes, canonicalDigest, sha256Hex, utf8ByteLength,
  validateAnswerInput, validateAttemptBinding, validateAttemptRecord, validateAttemptScope, validateAttemptScopeRecord, validateDraftForAttempt, validateDraftRecord, validateGradeAtTime, validateResumeDraft, validateResumeDraftForAttempt,
  validateAttemptAlias as validateAttempt, validateCompleteAttemptScope, validateDraftAlias as validateDraft, validateInput,
  makeLegacyId, makeSourceKey, validateAlias,
  validateBankMetadata, validateBankRevisionRecord, validateChunkManifest, validateContentManifest, validateContentReference, validateResumeReference
  , validateParentResumeDependency, validateResumeAttemptBinding, validateResumeDependencies, validateResumeState, validateResumeValidationContext,
  mutationDigestInput, computeMutationDigest, verifyMutationDigest, validateMutation, validateMutationPayload, validateMutationRecord, validateConflictRecord,
  validateChangeLogRecord, validateMutationReceipt, validatePushRequest, validatePushResponse, validatePushAcknowledgement,
  validatePullRequest, validatePullResponse, validatePullPage
};
export { validateCoreAnswerEvent as validateAnswerEvent };
export {
  validateAccountDeleteRequest, validateAccountDeletionResponse, validateAuthBootstrapResponse,
  validateCutoverEvidence, validateDeletionCapabilityRequest, validateGenerationClaim,
  validateInternalSessionClaim, validateCursorReset, validateLegacyImportJob,
  validateLegacyImportJobIntent, validateSessionCredentialV2
};
export {
  validateMetaRecord, validateSyncCoordinatorLease, validateProjectionMeta, validateVerificationJournal,
  validateContentChunkRecord, validateUserStateRecord, validateOutboxRecord, validateLegacyRawRecord,
  validateCheckpointRecord,
  validateLegacyAggregateRecord, validateMigrationJournalRecord, validateImportReceiptRecord,
  validateEntityTombstoneRecord, validateWriterLeaseRecord
};

export { decodeCursor, encodeCursor, validateCursor };
/** @param {string} code @param {string} path @param {string} message @returns {never} */
function fail(code, path, message) { throw new AppDataValidationError(code, path, message); }
/** @param {unknown} value */
export function validateProfileRegistry(value) {
  return validateProfileRegistryRecord(value);
}
/** @param {unknown} value */
export function validateActiveProfilePointer(value) { return validateLocalActiveProfilePointer(value); }
/** @param {unknown} value */
/** @param {unknown} value */
/** @param {unknown} value */
/** @param {unknown} value @param {string} path */
/** @param {unknown} value */
export function validateLease(value) { return validateLocalLease(value); }

/** @param {unknown} value */
/** @param {unknown} value @returns {import("./contracts").ExportManifest} */
export function validateExportManifest(value) { return validateStrictExportManifest(value); }

/** @param {unknown} value */
export function validateLegacyEvidence(value) { return validateLocalLegacyEvidence(value); }

/** The single authoritative runtime dispatch table for all 19 business
 * stores.  Keeping one validator per store prevents a weak transport-shaped
 * definition from shadowing the stricter persistent-record definition. */
const STORE_RECORD_VALIDATORS = Object.freeze({
  history_snapshots: validateHistorySnapshotPayload,
  meta: validateMetaRecord,
  bank_revisions: validateBankRevisionRecord,
  content_chunks: validateContentChunkRecord,
  question_aliases: validateAlias,
  attempts: validateAttemptRecord,
  attempt_scope: validateAttemptScopeRecord,
  drafts: validateDraftRecord,
  answer_events: validateCoreAnswerEvent,
  user_state: validateUserStateRecord,
  mutations: validateMutationRecord,
  outbox: validateOutboxRecord,
  conflicts: validateConflictRecord,
  legacy_raw: validateLegacyRawRecord,
  legacy_aggregates: validateLegacyAggregateRecord,
  migration_journal: validateMigrationJournalRecord,
  import_receipts: validateImportReceiptRecord,
  checkpoints: validateCheckpointRecord,
  entity_tombstones: validateEntityTombstoneRecord,
  writer_leases: validateWriterLeaseRecord
});


/** @param {string} name @param {string|string[]} keyPath @param {boolean} [unique] */
const ix = (name, keyPath, unique = false) => ({ name, keyPath, unique });
/** @param {any} value @returns {any} */
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Reflect.ownKeys(value)) deepFreeze(value[key]);
  }
  return value;
}
export const APP_DATA_STORES = deepFreeze({
  history_snapshots: { keyPath: 'snapshotId', indexes: [ix('recordedAt', 'recordedAt'), ix('accountGeneration', 'accountGeneration')] },
  meta: { keyPath: "key", indexes: [] }, bank_revisions: { keyPath: ["bankUid", "revision"], indexes: [ix("bankUid", "bankUid")] }, content_chunks: { keyPath: ["contentDigest", "chunkIndex"], indexes: [ix("contentDigest", "contentDigest")] }, question_aliases: { keyPath: ALIAS_KEY_PATH, indexes: [ix("sourceKey", "sourceKey"), ix("mappingStatus", "mappingStatus"), ix("newQuestionKey", "newQuestionKey")] }, attempts: { keyPath: "attemptId", indexes: [ix("status", "status"), ix("startedAt", "startedAt")] }, attempt_scope: { keyPath: ["attemptId", "ordinal"], indexes: [ix("attemptId", "attemptId")] }, drafts: { keyPath: ["attemptId", "questionKey"], indexes: [ix("attemptId", "attemptId")] }, answer_events: { keyPath: "eventId", indexes: [ix("attemptId", "attemptId"), ix("questionKey", "questionKey"), ix("attemptAction", ["attemptId", "writerStreamId", "actionSeq"], true)] }, user_state: { keyPath: ["questionKey", "field"], indexes: [ix("starredKey", "starredKey"), ix("serverRevision", "serverRevision")] }, mutations: { keyPath: "mutationId", indexes: [ix("streamSequence", ["clientStreamId", "clientSeq"], true)] }, outbox: { keyPath: "mutationId", indexes: [ix("nextAttemptAt", "nextAttemptAt")] }, conflicts: { keyPath: "conflictId", indexes: [ix("entityKey", "entityKey"), ix("status", "status")] }, legacy_raw: { keyPath: ["sourceId", "sourceDigest", "chunkIndex"], indexes: [ix("sourceId", "sourceId")] }, legacy_aggregates: { keyPath: ["sourceId", "namespace", "legacyQuestionId"], indexes: [ix("mappingStatus", "mappingStatus")] }, migration_journal: { keyPath: "migrationId", indexes: [ix("status", "status")] }, import_receipts: { keyPath: ["sourceId", "sourceRecordId"], indexes: [] }, checkpoints: { keyPath: "checkpointId", indexes: [ix("createdAt", "createdAt")] }, entity_tombstones: { keyPath: "entityKey", indexes: [ix("entityKind", "entityKind"), ix("accountGeneration", "accountGeneration")] }, writer_leases: { keyPath: "attemptId", indexes: [ix("expiresAt", "expiresAt")] }
});
/**
 * @template {keyof import("./contracts").AppDataStoreRecords} K
 * @param {K} storeName
 * @param {unknown} value
 * @param {import("./contracts").AttemptContextBinding} [context]
 * @returns {import("./contracts").AppDataStoreRecords[K]}
 */
export function validateStoreRecord(storeName, value, context) {
  if (typeof storeName !== "string" || !Object.hasOwn(STORE_RECORD_VALIDATORS, storeName)) fail("store", "$.store", "unknown AppData store");
  if (storeName === "drafts" && context !== undefined) {
    const draftValidator = /** @type {(value: unknown, context: import("./contracts").AttemptContextBinding) => import("./contracts").AppDataStoreRecords[K]} */ (validateDraftForAttempt);
    return draftValidator(value, context);
  }
  const validator = /** @type {(value: unknown) => import("./contracts").AppDataStoreRecords[K]} */ (STORE_RECORD_VALIDATORS[/** @type {keyof typeof STORE_RECORD_VALIDATORS} */ (storeName)]);
  return validator(value);
}
