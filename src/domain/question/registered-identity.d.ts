export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

export interface Bank {
  readonly sourceOrigin: string; readonly namespace: string; readonly sourceKey: string;
  readonly bankUid: string; readonly slug: string; readonly title: string;
  readonly policy: "public" | "protected" | "private";
}
export interface SourceRef { readonly questionKey: string; readonly questionRevision: string; }
export interface Registered { readonly questionKey: string; readonly sourceKey: string; readonly questionRevision: string; readonly provenance: readonly SourceRef[]; }
export interface Alias {
  readonly sourceOrigin: string; readonly namespace: string; readonly sourceKey: string;
  readonly legacyRevision: string; readonly legacyId: string; readonly legacyRawId: string; readonly legacyRuntimeId: string;
  readonly mappingStatus: "mapped" | "unknown" | "quarantined"; readonly candidates: readonly string[]; readonly newQuestionKey?: string;
}
export interface Row { readonly localId: string; readonly questionRevision: string; readonly optionIds: readonly string[]; readonly provenance: readonly SourceRef[]; readonly alias: Alias; readonly questionKey?: string; }
export interface RegistrationIssue { readonly code: "LEGACY_AMBIGUOUS" | "IDENTITY_UNRESOLVED"; readonly localIds: readonly string[]; readonly sourceKey: string; readonly legacyRevision: string; readonly legacyId: string; readonly candidates: readonly string[]; }
export interface Receipt { readonly planId: string; readonly planDigest: string; readonly rows: readonly Row[]; readonly issues: readonly RegistrationIssue[]; }
export interface Registry { readonly schemaVersion: 1; readonly scopeId: string; readonly banks: readonly Bank[]; readonly questions: readonly Registered[]; readonly receipts: readonly Receipt[]; }
export interface RegistrationItemBase { readonly localId: string; readonly legacyRevision: string; readonly legacyRawId: string; readonly legacyRuntimeId: string; readonly question: JsonObject; }
export type RegistrationItem =
  | (RegistrationItemBase & { readonly intent: "create"; readonly questionUid: string })
  | (RegistrationItemBase & { readonly intent: "update"; readonly questionUid: string })
  | (RegistrationItemBase & { readonly intent: "copy"; readonly questionUid: string; readonly copiedFrom: SourceRef })
  | (RegistrationItemBase & { readonly intent: "unresolved" });
export interface RegistrationPlan { readonly planId: string; readonly scopeId: string; readonly bank: Bank; readonly items: readonly RegistrationItem[]; }
export interface RegistrationResult { readonly registry: Registry; readonly rows: readonly Row[]; readonly issues: readonly RegistrationIssue[]; readonly replayed: boolean; }
export type RegisteredRecord = JsonObject & { readonly bankUid: string; readonly questionUid: string; readonly questionKey: string; readonly type?: "choice" | "fill" | "matching" | "essay"; readonly questionRevision?: string; readonly optionIds?: readonly string[] };
export type FinalizedRegisteredRecord = RegisteredRecord & { readonly questionRevision: string; readonly optionIds: readonly string[] };

export function applyRegistrationPlan(registry: Registry, plan: RegistrationPlan): Promise<RegistrationResult>;
export function finalizeRegisteredQuestions(records: ReadonlyArray<RegisteredRecord>): Promise<FinalizedRegisteredRecord[]>;
