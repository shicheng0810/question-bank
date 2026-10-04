/** Frozen AppData v2 transport and IndexedDB contract.  Runtime validation is
 * exported from index.js; these declarations deliberately do not model an ORM. */

export type UUID = `${string}-${string}-${string}-${string}-${string}`;
export type Sha256Hex = string;
export type DecimalCursor = string;
export type QuestionKey = `${UUID}/${UUID}`;
export type OptionId = `opt_${string}`;
export type ProfileState = "staged" | "ready" | "locked" | "quarantined" | "deleting" | "deleted";
export type MutationStatus = "accepted" | "duplicate" | "conflict" | "missing_dependency";
export type DeletionStatus = "pending" | "retryable_failed" | "complete";
export type ImportJobStatus = "DISCOVERING" | "RAW_SAVED" | "TRANSFORMED" | "VERIFIED" | "COMMITTED" | "QUARANTINED" | "ABANDONED";
export type MigrationJournalStatus = "DISCOVERED" | "RAW_SAVED" | "TRANSFORMED" | "VERIFIED" | "COMMITTED" | "QUARANTINED";

export interface VerificationJournal {
  jobId: UUID;
  schemaVersion: 1;
  contentDigest: Sha256Hex;
  recordCount: number;
  verifiedAt: string;
}
interface ProfileRegistryBase {
  profileId: UUID;
  dbName: string;
  schemaVersion: 1 | 2;
  importJobId?: UUID;
  lastVerifiedAt?: string;
}

type ProfileIdentity =
  | { ownerKind: "guest"; accountId?: never; accountGeneration?: never }
  | { ownerKind: "account"; accountId: string; accountGeneration: UUID };

export type ProfileRegistryRecord =
  | (ProfileRegistryBase & ProfileIdentity & { state: "ready"; verification: VerificationJournal })
  | (ProfileRegistryBase & ProfileIdentity & { state: Exclude<ProfileState, "ready">; verification?: VerificationJournal });
export interface ActiveProfilePointer { key: "activeProfile"; activeProfileId: UUID; activationRevision: number; }
export interface WriterLease { attemptId: UUID; ownerTabId: UUID; fence: number; expiresAt: number; }
export interface SessionCredentialV2 {
  version: 2;
  sub: string;
  accountGeneration: UUID;
  issuedAt: number;
  expiresAt: number;
}
export interface GenerationClaim { accountId: string; accountGeneration: UUID; status: "ACTIVE" | "DELETING" | "DELETED" | "QUARANTINED"; protocolVersion: 2; }
export interface BankMetadata { title: string; questionCount: number; visibility: "public" | "private" | "protected"; }
export interface ContentReference { contentDigest: Sha256Hex; manifestDigest: Sha256Hex; chunkCount: number; totalBytes: number; }
export type ContentManifest =
  | { kind: "public_static"; staticRef: string; contentDigest: Sha256Hex }
  | { kind: "private_chunks"; reference: ContentReference }
  | { kind: "protected_cipher"; reference: ContentReference }
  | { kind: "unavailable"; reason: string };
export interface BankRevisionRecord { bankUid: UUID; revision: Sha256Hex; metadata: BankMetadata; contentManifest: ContentManifest; }
export interface ContentChunkRecord { contentDigest: Sha256Hex; chunkIndex: number; bytes: Uint8Array; }
interface AliasFields { sourceOrigin: string; namespace: string; sourceKey: string; legacyRevision: string; legacyId: string; legacyRawId: string; legacyRuntimeId: string; }
export type QuestionAliasRecord =
  | (AliasFields & { mappingStatus: "mapped"; candidates: [QuestionKey]; newQuestionKey: QuestionKey })
  | (AliasFields & { mappingStatus: "unknown" | "quarantined"; candidates: QuestionKey[]; newQuestionKey?: never });
export interface AttemptRecord { attemptId: UUID; status: "active" | "completed"; startedAt: number; scopeDigest: Sha256Hex; scopeCount: number; position: number; effectiveElapsedMs: number; localRevision: number; actionSeq: number; writerStreamId: UUID; parentAttemptId?: UUID; }
/** Trusted containing-attempt identity used for draft inheritance binding.
 * This does not prove that the parent snapshot/content is available. */
export interface AttemptContextBinding { attemptId: UUID; parentAttemptId?: UUID; }
export interface EquivalentSourceRef { questionKey: QuestionKey; questionRevision: Sha256Hex; }
export interface AttemptScopeRecord { attemptId: UUID; ordinal: number; questionKey: QuestionKey; questionRevision: Sha256Hex; displayOrdinal: number; equivalentSourceRefs: EquivalentSourceRef[]; }
export interface ChoiceInput { kind: "choice"; selectedOptionIds: OptionId[]; }
export interface FillFieldInput { fieldId: string; value: string; }
export interface FillInput { kind: "fill"; fields: FillFieldInput[]; }
export type AnswerInput = ChoiceInput | FillInput;
export interface DraftRecord { attemptId: UUID; questionKey: QuestionKey; questionRevision: Sha256Hex; input: AnswerInput; localRevision: number; dirty: boolean; submitted: boolean; showKeys: boolean; assisted: boolean; writerStreamId: UUID; fence: number; inheritedFrom?: { attemptId: UUID; resumeContentDigest: Sha256Hex }; }
export interface GradedAtTime { status: "graded"; correct: boolean; score: number; maxScore: number; }
export interface UngradedAtTime { status: "ungraded"; }
export type GradeAtTime = GradedAtTime | UngradedAtTime;
export interface AnswerEventBase { eventId: UUID; attemptId: UUID; questionKey: QuestionKey; writerStreamId: UUID; actionSeq: number; occurredAt: number; questionRevision: Sha256Hex; assisted: boolean; }
export interface SubmitAnswerEvent extends AnswerEventBase { kind: "answer_submitted"; answer: AnswerInput; gradeAtTime: GradeAtTime; graderVersion: string; gradingBasisDigest: Sha256Hex; }
export interface RedoEvent extends AnswerEventBase { kind: "redo"; redoOfEventId: UUID; }
export interface HintEvent extends AnswerEventBase { kind: "hint"; hintKind: string; assisted: true; }
export type AnswerEventRecord = SubmitAnswerEvent | RedoEvent | HintEvent;
export interface UserStatePayload { schemaVersion: 1; questionKey: QuestionKey; field: "starred"; value: boolean; baseRevision: number; }
interface UserStateRecordBase { questionKey: QuestionKey; field: "starred"; serverRevision?: number; }
export type UserStateRecord =
  | (UserStateRecordBase & { value: false; starredKey?: 0 })
  | (UserStateRecordBase & { value: true; starredKey?: 1 });
export interface AttemptManifestPayload { schemaVersion: 1; attemptId: UUID; writerStreamId: UUID; startedAt: number; scopeDigest: Sha256Hex; scopeCount: number; status: "active" | "completed"; baseRevision: number; parentAttemptId?: UUID; }
export interface AttemptScopePayload { schemaVersion: 1; attemptId: UUID; scopeDigest: Sha256Hex; reference: ContentReference; baseRevision: 0; }
export interface ResumeStatePayload { schemaVersion: 1; attemptId: UUID; writerStreamId: UUID; contentDigest: Sha256Hex; chunkManifestDigest: Sha256Hex; localRevision: number; baseRevision: number; }
export type BankRevisionMutationContentManifest = Exclude<ContentManifest, { kind: "unavailable" }>;
export interface BankRevisionPayload { schemaVersion: 1; bankUid: UUID; revision: Sha256Hex; metadata: BankMetadata; contentManifest: BankRevisionMutationContentManifest; baseRevision: number; }
export interface ContentManifestPayload { schemaVersion: 1; reference: ContentReference; }
export interface HistorySnapshotSource { namespace: 'legacy_account' | 'legacy_device'; deviceNamespace: string | null; recordId: string; digest: Sha256Hex; conversionVersion: 1; }
export interface HistorySnapshotSummary { correct: number; answered: number; total: number; }
export interface HistorySnapshotSourceRef { questionKey: QuestionKey; questionRevision: Sha256Hex; bankRevision: Sha256Hex; }
export interface ImportedHistorySnapshot { schemaVersion: 1; type: 'imported_history_snapshot'; snapshotId: UUID; accountGeneration: UUID; source: HistorySnapshotSource; recordedAt: number; summary: HistorySnapshotSummary; scope: Array<{legacyQuestionId: string; questionKey: QuestionKey; questionRevision: Sha256Hex; equivalentSourceRefs: HistorySnapshotSourceRef[]}>; answers: Array<{legacyQuestionId: string; savedInput: {selectedIndex: number | null; selectedSet: number[]; fillInputs: string[]; submitted: boolean; showKeys: boolean}}>; }
export interface HistorySnapshotPayload { schemaVersion: 1; snapshotId: UUID; accountGeneration: UUID; source: HistorySnapshotSource; recordedAt: number; summary: HistorySnapshotSummary; scopeCount: number; reference: ContentReference; baseRevision: 0; }
export interface EntityTombstonePayload { schemaVersion: 1; entityKind: "bank" | "attempt" | 'history_snapshot'; entityId: UUID; }
export type MutationKind = "attempt_manifest" | "attempt_scope" | "answer_event" | "resume_state" | "user_state" | "bank_revision" | "content_manifest" | "entity_tombstone" | 'history_snapshot';
export type ChangeLogCasKind = "attempt_manifest" | "resume_state" | "user_state" | "bank_revision";
export interface AnswerEventMutationPayload { schemaVersion: 1; event: AnswerEventRecord; }
export type MutationPayloadByKind = {
  history_snapshot: HistorySnapshotPayload;
  attempt_manifest: AttemptManifestPayload;
  attempt_scope: AttemptScopePayload;
  answer_event: AnswerEventMutationPayload;
  resume_state: ResumeStatePayload;
  user_state: UserStatePayload;
  bank_revision: BankRevisionPayload;
  content_manifest: ContentManifestPayload;
  entity_tombstone: EntityTombstonePayload;
};
export type MutationPayload = MutationPayloadByKind[MutationKind];
export interface MutationEnvelopeBase { protocolVersion: 2; mutationId: UUID; clientStreamId: UUID; clientSeq: number; payloadDigest: Sha256Hex; }
export type MutationEnvelope = MutationEnvelopeBase & (
  | { kind: "attempt_manifest"; entityKey: `attempt:${UUID}`; payload: AttemptManifestPayload }
  | { kind: "attempt_scope"; entityKey: `attempt:${UUID}`; payload: AttemptScopePayload }
  | { kind: "answer_event"; entityKey: `event:${UUID}`; payload: AnswerEventMutationPayload }
  | { kind: "resume_state"; entityKey: `attempt:${UUID}`; payload: ResumeStatePayload }
  | { kind: "user_state"; entityKey: `user_state:${QuestionKey}:starred`; payload: UserStatePayload }
  | { kind: "bank_revision"; entityKey: `bank:${UUID}`; payload: BankRevisionPayload }
  | { kind: "content_manifest"; entityKey: `content:${Sha256Hex}`; payload: ContentManifestPayload }
  | { kind: 'history_snapshot'; entityKey: `history_snapshot:${UUID}`; payload: HistorySnapshotPayload }
  | { kind: "entity_tombstone"; entityKey: `${"bank" | "attempt" | 'history_snapshot'}:${UUID}`; payload: EntityTombstonePayload }
);
export type MutationRecord = MutationEnvelope & { createdAt: number; accountGeneration?: UUID; };
export interface OutboxRecord { mutationId: UUID; nextAttemptAt: number; attemptCount: number; }
export interface ConflictRecord { conflictId: UUID; entityKey: string; status: "open" | "resolved"; mutation: MutationEnvelope; currentRevision?: number; }
export interface LegacyEvidence { sourceId: string; sourceDigest: Sha256Hex; sourceOrigin: string; namespace: string; rawFormat: string; rawBytes: number; disposition: "mapped" | "unknown" | "quarantined"; }
export interface LegacyRawRecord extends LegacyEvidence { chunkIndex: number; raw: string; }
export interface LegacyAggregateRecord extends LegacyEvidence { legacyQuestionId: string; aggregate: JsonValue; mappingStatus: "mapped" | "unknown" | "quarantined"; }
export interface MigrationJournalRecord { migrationId: UUID; status: MigrationJournalStatus; counts: JsonValue; checkpoint?: JsonValue; errors?: JsonValue; }
export interface ImportReceiptRecord { sourceId: string; sourceRecordId: string; provenance: JsonValue; importedAt: number; }
export interface CheckpointRecord { checkpointId: UUID; createdAt: number; manifest: ExportManifest; }
export type MetaRecord =
  | { key: "clientStreamId"; value: UUID }
  | { key: "clientSeq"; value: number }
  | { key: "clockHighWaterMs"; value: number }
  | { key: "appliedPullCursor"; value: string }
  | { key: "serverLogEpoch"; value: UUID }
  | { key: "schemaVersion"; value: 1 }
  | { key: "projectionVersion"; value: 1 }
  | { key: "projectionInvalidationRevision"; value: number }
  | { key: "projectionAppliedRevision"; value: number }
  | { key: "syncCoordinatorLease"; value: SyncCoordinatorLease };
export interface ProjectionMeta { invalidationRevision: number; appliedRevision: number; }

export interface SyncCursor { protocolVersion: 2; accountGeneration: UUID; logEpoch: UUID; serverSeq: DecimalCursor; }
interface MutationReceiptBase { mutationId: UUID; payloadDigest: Sha256Hex; }
export type MutationReceipt =
  | (MutationReceiptBase & { status: "accepted" | "duplicate"; serverSeq: DecimalCursor; currentRevision?: number; error?: never })
  | (MutationReceiptBase & { status: "conflict"; serverSeq?: never; currentRevision?: number; error: "conflict" })
  | (MutationReceiptBase & { status: "missing_dependency"; serverSeq?: never; currentRevision?: never; error: "missing_dependency" });
export interface PushRequest { protocolVersion: 2; accountGeneration: UUID; mutations: MutationEnvelope[]; }
export interface PushResponse { protocolVersion: 2; generation: UUID; logEpoch: UUID; receipts: MutationReceipt[]; serverHighWater: DecimalCursor; }
export interface PullRequest { protocolVersion: 2; after: string; until?: string; limit: number; }
export interface CursorReset { reason: string; generation: UUID; logEpoch: UUID; earliestAvailableSeq: DecimalCursor; resetExportId: UUID; exportCut: DecimalCursor; manifestDigest: Sha256Hex; pageUrl: string; expiresAt: number; }
export interface ExportSection { path: string; count: number; utf8Bytes: number; sha256: Sha256Hex; }
export interface ExportCoverage { facts: boolean; attempts: boolean; drafts: boolean; mutations: boolean; outbox: boolean; conflicts: boolean; tombstones: boolean; legacy: boolean; content: boolean; }
export interface CompleteExportCoverage { facts: true; attempts: true; drafts: true; mutations: true; outbox: true; conflicts: true; tombstones: true; legacy: true; content: true; }
interface ExportManifestCore { format: "qb-appdata-v2"; schemaVersion: 2; storeSetVersion?: 1 | 2; exportId: UUID; appVersion: string; sourceProfileHint: string; sections: ExportSection[]; legacySourceDigests: Sha256Hex[]; }
export type CompleteExportManifestState = { complete: true; partial: false; coverage: CompleteExportCoverage; partialReasons: []; };
export type PartialExportManifestState = { complete: false; partial: true; coverage: ExportCoverage; partialReasons: [string, ...string[]]; };
export type ExportManifestState = CompleteExportManifestState | PartialExportManifestState;
export interface ExportManifestSyncFields { accountGeneration: UUID; serverLogEpoch: UUID; exportCut: DecimalCursor; throughServerSeq: DecimalCursor; }
export interface ExportManifestNoSyncFields { accountGeneration?: never; serverLogEpoch?: never; exportCut?: never; throughServerSeq?: never; }
export type ExportManifestWithSync = ExportManifestCore & ExportManifestState & ExportManifestSyncFields;
export type ExportManifestWithoutSync = ExportManifestCore & ExportManifestState & ExportManifestNoSyncFields;
export type ExportManifest = ExportManifestWithSync | ExportManifestWithoutSync;

export interface AuthBootstrapResponse { ok: true; accountId: string; accountGeneration: UUID; status: "ACTIVE"; protocolVersion: 2; legacyImportState: "pending" | "sealed" | "quarantined"; }
export interface AccountDeleteRequest { operationId: UUID; statusReceipt: string; }
export interface AccountDeletionCapabilityRequest { accountId: string; operationId: UUID; statusReceipt: string; }
export type DeletionCapabilityRequest = AccountDeletionCapabilityRequest;
export type AccountDeletionResponse =
  | { operationId: UUID; status: "pending"; retryAfter?: number; failedSourceCategory?: never }
  | { operationId: UUID; status: "retryable_failed"; failedSourceCategory: string; retryAfter: number }
  | { operationId: UUID; status: "complete"; failedSourceCategory?: never; retryAfter?: never };
interface LegacyImportJobIntentBase { jobId: UUID; targetGeneration: UUID; sourceId: string; leaseFence: number; }
export type LegacyImportJobIntent =
  | (LegacyImportJobIntentBase & { status: "DISCOVERING" | "QUARANTINED" | "ABANDONED"; sourceManifestDigest?: Sha256Hex })
  | (LegacyImportJobIntentBase & { status: "RAW_SAVED" | "TRANSFORMED" | "VERIFIED" | "COMMITTED"; sourceManifestDigest: Sha256Hex });

/** Records by v1 business-store name. The type exists so IDB schema/index
 * implementation can keep the precise fields declared here. */
export interface AppDataStoreRecords {
  meta: MetaRecord; bank_revisions: BankRevisionRecord; content_chunks: ContentChunkRecord; question_aliases: QuestionAliasRecord;
  attempts: AttemptRecord; attempt_scope: AttemptScopeRecord; drafts: DraftRecord; answer_events: AnswerEventRecord;
  user_state: UserStateRecord; mutations: MutationRecord; outbox: OutboxRecord; conflicts: ConflictRecord;
  legacy_raw: LegacyRawRecord; legacy_aggregates: LegacyAggregateRecord; migration_journal: MigrationJournalRecord;
  import_receipts: ImportReceiptRecord; checkpoints: CheckpointRecord;
  entity_tombstones: EntityTombstoneRecord; writer_leases: WriterLeaseRecord;
  history_snapshots: HistorySnapshotPayload;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

interface EntityTombstoneBase { entityKey: `bank:${UUID}` | `attempt:${UUID}` | `history_snapshot:${UUID}`; entityKind: "bank" | "attempt" | 'history_snapshot'; entityId: UUID; sourceMutationId?: UUID; }
export type EntityTombstoneRecord =
  | (EntityTombstoneBase & { status: "pending"; accountGeneration?: UUID; serverSeq?: never })
  | (EntityTombstoneBase & { status: "confirmed"; accountGeneration: UUID; serverSeq: DecimalCursor });
export interface WriterLeaseRecord extends WriterLease { exportExcluded: true; }
export interface SyncCoordinatorLease { ownerTabId: UUID; fence: number; expiresAt: number; }
export interface ResumeDraft { questionKey: QuestionKey; questionRevision: Sha256Hex; input: AnswerInput; localRevision: number; submitted: boolean; showKeys: boolean; assisted: boolean; inheritedFrom?: { attemptId: UUID; resumeContentDigest: Sha256Hex }; }
interface ResumeStateCore { attemptId: UUID; writerStreamId: UUID; localRevision: number; baseRevision: number; scopeDigest: Sha256Hex; questionDrafts: ResumeDraft[]; submittedEventIds: UUID[]; position: number; effectiveElapsedMs: number; scope: AttemptScopeRecord[]; }
export interface SnapshotContinuationBaseline { format: "qb-snapshot-baseline-v1"; accountGeneration: UUID; snapshotId: UUID; snapshotReference: ContentReference; continuationKey: Sha256Hex; }
export type SnapshotContinuationReceipt = Omit<ImportReceiptRecord, "sourceId" | "provenance"> & { sourceId: "qb-snapshot-continuation-receipt-v1"; provenance: { format: "qb-snapshot-continuation-receipt-v1"; generation: UUID; snapshotId: UUID; snapshotContentDigest: Sha256Hex; attemptId: UUID; commandId: UUID; }; };
export type ResumeState = (ResumeStateCore & {schemaVersion: 1; snapshotBaseline?: never}) | (ResumeStateCore & {schemaVersion: 2; snapshotBaseline: SnapshotContinuationBaseline});
export interface ChunkManifest { schemaVersion: 1; contentDigest: Sha256Hex; chunkCount: number; totalBytes: number; chunks: Array<{ chunkIndex: number; byteLength: number; sha256: Sha256Hex }>; }
export interface ResumeReference { schemaVersion: 1; attemptId: UUID; writerStreamId: UUID; contentDigest: Sha256Hex; chunkManifestDigest: Sha256Hex; localRevision: number; baseRevision: number; }
export interface ResumeAttemptBinding { attemptId: UUID; writerStreamId: UUID; scopeDigest: Sha256Hex; scopeCount: number; parentAttemptId?: UUID; }
export interface ParentResumeDependency { state: ResumeState; reference: ResumeReference; manifest?: ChunkManifest; events: AnswerEventRecord[]; expectedAttempt: ResumeAttemptBinding; }
export interface ResumeValidationContext { parents: ParentResumeDependency[]; snapshotProofs?: object[]; }
export type ResumeMissingDependency = { kind: "manifest"; digest: Sha256Hex } | { kind: "submit_event"; eventId: UUID } | { kind: "parent_resume"; digest: Sha256Hex } | { kind: "snapshot_baseline"; digest: Sha256Hex };
export type ResumeValidationResult = { status: "payload_verified"; state: ResumeState } | { status: "missing_dependency"; missing: ResumeMissingDependency[] };
type ChangeLogRecordFor<K extends MutationKind> = {
  serverSeq: DecimalCursor;
  accountGeneration: UUID;
  kind: K;
  entityKey: Extract<MutationEnvelope, { kind: K }>['entityKey'];
  payloadDigest: Sha256Hex;
  payload: MutationPayloadByKind[K];
} & (K extends ChangeLogCasKind ? { serverRevision: number } : { serverRevision?: never });
export type ChangeLogRecord = { [K in MutationKind]: ChangeLogRecordFor<K> }[MutationKind];
export interface PullResponse { protocolVersion: 2; changes: ChangeLogRecord[]; nextCursor: string; highWater: DecimalCursor; hasMore: boolean; generation: UUID; logEpoch: UUID; }
export interface InternalSessionClaim { sub: string; accountGeneration: UUID; sessionExpiresAt: number; requestId: UUID; }
export type OldEpoch = { status: "absent" } | { status: "present"; value: number } | { status: "unverified" };
export type DeletionSources = { status: "clear" | "deleted"; sourceManifestDigest: Sha256Hex } | { status: "unverified" };
type CutoverEvidenceBase = { sub: string; cutoverId: string; evidenceDigest: Sha256Hex; };
export type CutoverEvidence =
  | (CutoverEvidenceBase & { outcome: "new_after_verified_cutover"; oldEpoch: { status: "absent" }; deletionSources: { status: "clear"; sourceManifestDigest: Sha256Hex } })
  | (CutoverEvidenceBase & { outcome: "legacy_verified"; oldEpoch: { status: "absent" } | { status: "present"; value: number }; deletionSources: { status: "clear"; sourceManifestDigest: Sha256Hex } })
  | (CutoverEvidenceBase & { outcome: "quarantined"; oldEpoch: OldEpoch; deletionSources: DeletionSources });
