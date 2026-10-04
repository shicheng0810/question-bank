import { isOptionId, isQuestionKey, isUuid } from "../question/index.js";
import { AppDataValidationError, canonicalBytes, canonicalContentBytes, utf8ByteLength } from "./canonical.js";
import { APP_DATA_CONTENT_LIMITS, APP_DATA_LIMITS } from "./constants.js";

const DIGEST_RE = /^[0-9a-f]{64}$/;

/** @param {string} code @param {string} path @param {string} message @returns {never} */
function fail(code, path, message) {
  throw new AppDataValidationError(code, path, message);
}

/** @param {unknown} value @param {string} path @returns {Record<string, unknown>} */
function plainObject(value, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("type", path, "must be a plain object");
  if (Object.getPrototypeOf(value) !== Object.prototype) fail("prototype", path, "must use Object.prototype");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") fail("symbol", path, "symbol keys are not JSON");
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, "value")) fail("accessor", `${path}.${key}`, "accessors are not JSON");
    if (!descriptor.enumerable) fail("non_enumerable", `${path}.${key}`, "non-enumerable fields are not permitted");
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {Record<string, unknown>} value @param {readonly string[]} allowed @param {readonly string[]} required @param {string} path */
function exactFields(value, allowed, required, path) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail("unknown_field", `${path}.${key}`, "unknown field is not permitted");
  for (const key of required) if (!Object.hasOwn(value, key)) fail("required", `${path}.${key}`, "required field is missing");
}

/**
 * The binding is a small, trusted snapshot of the containing attempt. It is
 * deliberately separate from the record shape so standalone store reads can
 * still validate a DraftRecord without pretending to know its parent.
 * @param {unknown} value
 * @param {string} path
 * @returns {import("./contracts").AttemptContextBinding}
 */
export function validateAttemptBinding(value, path = "$") {
  const record = plainObject(value, path);
  exactFields(record, ["attemptId", "parentAttemptId"], ["attemptId"], path);
  const attemptId = uuid(record.attemptId, `${path}.attemptId`);
  if (Object.hasOwn(record, "parentAttemptId")) {
    const parentAttemptId = uuid(record.parentAttemptId, `${path}.parentAttemptId`);
    if (parentAttemptId === attemptId) fail("invariant", `${path}.parentAttemptId`, "parentAttemptId cannot equal attemptId");
  }
  return /** @type {import("./contracts").AttemptContextBinding} */ (value);
}

/** @param {unknown} value @param {string} path @returns {string} */
function text(value, path) {
  if (typeof value !== "string") fail("type", path, "must be a string");
  if (utf8ByteLength(value) > APP_DATA_LIMITS.maxStringUtf8Bytes) fail("utf8_limit", path, "string exceeds the configured UTF-8 limit");
  return value;
}

/** Opaque product identifiers are not path/name syntax: preserve every
 * non-empty UTF-8 string up to the fixed 128-byte field budget. */
/** @param {unknown} value @param {string} path @returns {string} */
function opaqueText(value, path) {
  if (typeof value !== "string" || value.length === 0) fail("range", path, "must be a non-empty string");
  if (utf8ByteLength(value) > 128) fail("utf8_limit", path, "opaque identifier exceeds 128 UTF-8 bytes");
  return value;
}

/** @param {unknown} value @param {string} path @returns {number} */
function safeInteger(value, path) {
  if (!Number.isSafeInteger(value)) fail("safe_integer", path, "must be a safe integer");
  return /** @type {number} */ (value);
}

/** @param {unknown} value @param {string} path @returns {number} */
function nonNegativeInteger(value, path) {
  const result = safeInteger(value, path);
  if (result < 0) fail("range", path, "must be non-negative");
  return result;
}

/** @param {unknown} value @param {string} path @returns {boolean} */
function booleanValue(value, path) {
  if (typeof value !== "boolean") fail("type", path, "must be a boolean");
  return value;
}

/** @param {unknown} value @param {string} path @returns {string} */
function uuid(value, path) {
  if (!isUuid(value)) fail("uuid", path, "must be a canonical lowercase UUID");
  return value;
}

/** @param {unknown} value @param {string} path @returns {string} */
function questionKey(value, path) {
  if (!isQuestionKey(value)) fail("question_key", path, "must be a bankUid/questionUid key");
  return value;
}

/** @param {unknown} value @param {string} path @returns {string} */
function digest(value, path) {
  if (typeof value !== "string" || !DIGEST_RE.test(value)) fail("digest", path, "must be a lowercase SHA-256 hex digest");
  return value;
}

/** @param {unknown} value @param {string} path @returns {unknown[]} */
/** @param {unknown} value @param {string} path @param {number} [maximum] @returns {unknown[]} */
function arrayValue(value, path, maximum = APP_DATA_LIMITS.maxArrayItems) {
  if (!Array.isArray(value)) fail("type", path, "must be an array");
  if (Object.getPrototypeOf(value) !== Array.prototype) fail("prototype", path, "array must use Array.prototype");
  if (value.length > maximum) fail("array_limit", path, "array exceeds the configured item limit");
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, "value")) fail("array_hole", `${path}[${index}]`, "array holes/accessors are not permitted");
    if (!descriptor.enumerable) fail("non_enumerable", `${path}[${index}]`, "non-enumerable array elements are not permitted");
  }
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) fail("array_property", path, "arrays may not have non-index properties");
  }
  return /** @type {unknown[]} */ (value);
}

/** Apply the ordinary small-DTO canonical budget to one core record. This is
 * a structure guard, not the 16 KiB transport limit. */
/** @param {unknown} value @param {string} path */
function assertSmallRecordBudget(value, path) {
  try { canonicalBytes(value); } catch (error) {
    if (error instanceof AppDataValidationError) throw new AppDataValidationError(error.code, path + error.path.slice(1), error.message);
    throw error;
  }
}

/** @param {unknown[]} values @param {string} path @param {(value: unknown, childPath: string) => unknown} validator @returns {unknown[]} */
function validatedArray(values, path, validator) {
  for (let index = 0; index < values.length; index += 1) validator(values[index], `${path}[${index}]`);
  return values;
}

/** @param {unknown} value @param {string} path @returns {string[]} */
function uniqueOptionIds(value, path) {
  const values = arrayValue(value, path);
  const seen = new Set();
  for (let index = 0; index < values.length; index += 1) {
    if (!isOptionId(values[index])) fail("option_id", `${path}[${index}]`, "must be a revision-bound opt_ identifier");
    const option = /** @type {string} */ (values[index]);
    if (seen.has(option)) fail("duplicate", `${path}[${index}]`, "optionId must be unique");
    seen.add(option);
  }
  return /** @type {string[]} */ (values);
}

/** @param {unknown} value @param {string} path @returns {import("./contracts").AnswerInput} */
export function validateAnswerInput(value, path = "$") {
  const record = plainObject(value, path);
  if (record.kind === "choice") {
    exactFields(record, ["kind", "selectedOptionIds"], ["kind", "selectedOptionIds"], path);
    uniqueOptionIds(record.selectedOptionIds, `${path}.selectedOptionIds`);
    assertSmallRecordBudget(value, path);
    return /** @type {import("./contracts").ChoiceInput} */ (value);
  }
  if (record.kind === "fill") {
    exactFields(record, ["kind", "fields"], ["kind", "fields"], path);
    const values = arrayValue(record.fields, `${path}.fields`);
    const seen = new Set();
    validatedArray(values, `${path}.fields`, (entry, entryPath) => {
      const field = plainObject(entry, entryPath);
      exactFields(field, ["fieldId", "value"], ["fieldId", "value"], entryPath);
      const fieldId = opaqueText(field.fieldId, `${entryPath}.fieldId`);
      text(field.value, `${entryPath}.value`);
      if (seen.has(fieldId)) fail("duplicate", `${entryPath}.fieldId`, "fieldId must be unique");
      seen.add(fieldId);
    });
    assertSmallRecordBudget(value, path);
    return /** @type {import("./contracts").FillInput} */ (value);
  }
  fail("enum", `${path}.kind`, "input kind must be choice or fill");
}

/** @param {unknown} value @param {string} path @returns {import("./contracts").GradeAtTime} */
export function validateGradeAtTime(value, path = "$") {
  const record = plainObject(value, path);
  if (record.status === "ungraded") {
    exactFields(record, ["status"], ["status"], path);
    return /** @type {import("./contracts").UngradedAtTime} */ (value);
  }
  if (record.status !== "graded") fail("enum", `${path}.status`, "grade status must be graded or ungraded");
  exactFields(record, ["status", "correct", "score", "maxScore"], ["status", "correct", "score", "maxScore"], path);
  const correct = booleanValue(record.correct, `${path}.correct`);
  const score = record.score;
  const maxScore = record.maxScore;
  if (typeof score !== "number" || !Number.isFinite(score)) fail("finite_number", `${path}.score`, "score must be finite");
  if (typeof maxScore !== "number" || !Number.isFinite(maxScore)) fail("finite_number", `${path}.maxScore`, "maxScore must be finite");
  if (maxScore <= 0 || score < 0 || score > maxScore) fail("range", path, "graded score must satisfy 0 <= score <= maxScore and maxScore > 0");
  void correct;
  assertSmallRecordBudget(value, path);
  return /** @type {import("./contracts").GradedAtTime} */ (value);
}

/** @param {unknown} value @param {string} path @returns {import("./contracts").EquivalentSourceRef} */
function validateEquivalentRef(value, path) {
  const record = plainObject(value, path);
  exactFields(record, ["questionKey", "questionRevision"], ["questionKey", "questionRevision"], path);
  questionKey(record.questionKey, `${path}.questionKey`);
  digest(record.questionRevision, `${path}.questionRevision`);
  return /** @type {import("./contracts").EquivalentSourceRef} */ (value);
}

/** @param {unknown} value @param {string} path @returns {import("./contracts").AttemptRecord} */
export function validateAttemptRecord(value, path = "$") {
  const record = plainObject(value, path);
  exactFields(record, ["attemptId", "status", "startedAt", "scopeDigest", "scopeCount", "position", "effectiveElapsedMs", "localRevision", "actionSeq", "writerStreamId", "parentAttemptId"], ["attemptId", "status", "startedAt", "scopeDigest", "scopeCount", "position", "effectiveElapsedMs", "localRevision", "actionSeq", "writerStreamId"], path);
  uuid(record.attemptId, `${path}.attemptId`);
  if (record.status !== "active" && record.status !== "completed") fail("enum", `${path}.status`, "attempt status must be active or completed");
  nonNegativeInteger(record.startedAt, `${path}.startedAt`);
  digest(record.scopeDigest, `${path}.scopeDigest`);
  const scopeCount = nonNegativeInteger(record.scopeCount, `${path}.scopeCount`);
  if (scopeCount < 1) fail("range", `${path}.scopeCount`, "scopeCount must be at least one");
  const position = nonNegativeInteger(record.position, `${path}.position`);
  if (position >= scopeCount) fail("range", `${path}.position`, "position must be within the scope");
  nonNegativeInteger(record.effectiveElapsedMs, `${path}.effectiveElapsedMs`);
  nonNegativeInteger(record.localRevision, `${path}.localRevision`);
  nonNegativeInteger(record.actionSeq, `${path}.actionSeq`);
  uuid(record.writerStreamId, `${path}.writerStreamId`);
  if (Object.hasOwn(record, "parentAttemptId")) {
    uuid(record.parentAttemptId, `${path}.parentAttemptId`);
    if (record.parentAttemptId === record.attemptId) fail("invariant", `${path}.parentAttemptId`, "parentAttemptId cannot equal attemptId");
  }
  assertSmallRecordBudget(value, path);
  return /** @type {import("./contracts").AttemptRecord} */ (value);
}

/** @param {unknown} value @param {string} path @returns {import("./contracts").AttemptScopeRecord} */
export function validateAttemptScopeRecord(value, path = "$") {
  const record = plainObject(value, path);
  exactFields(record, ["attemptId", "ordinal", "questionKey", "questionRevision", "displayOrdinal", "equivalentSourceRefs"], ["attemptId", "ordinal", "questionKey", "questionRevision", "displayOrdinal", "equivalentSourceRefs"], path);
  uuid(record.attemptId, `${path}.attemptId`);
  const ordinal = nonNegativeInteger(record.ordinal, `${path}.ordinal`);
  const displayOrdinal = nonNegativeInteger(record.displayOrdinal, `${path}.displayOrdinal`);
  if (displayOrdinal !== ordinal) fail("invariant", `${path}.displayOrdinal`, "displayOrdinal must equal ordinal");
  const key = questionKey(record.questionKey, `${path}.questionKey`);
  const revision = digest(record.questionRevision, `${path}.questionRevision`);
  const refs = arrayValue(record.equivalentSourceRefs, `${path}.equivalentSourceRefs`);
  if (refs.length < 1) fail("range", `${path}.equivalentSourceRefs`, "at least the representative source is required");
  const seen = new Set();
  let previous = "";
  validatedArray(refs, `${path}.equivalentSourceRefs`, (entry, entryPath) => {
    const ref = validateEquivalentRef(entry, entryPath);
    if (ref.questionKey < previous) fail("order", `${entryPath}.questionKey`, "equivalentSourceRefs must be sorted by questionKey");
    previous = ref.questionKey;
    if (seen.has(ref.questionKey)) fail("duplicate", `${entryPath}.questionKey`, "source questionKey must be unique");
    seen.add(ref.questionKey);
  });
  if (!seen.has(key) || !refs.some((entry) => {
    const ref = /** @type {import("./contracts").EquivalentSourceRef} */ (entry);
    return ref.questionKey === key && ref.questionRevision === revision;
  })) fail("invariant", `${path}.equivalentSourceRefs`, "references must include the representative question and revision");
  assertSmallRecordBudget(value, path);
  return /** @type {import("./contracts").AttemptScopeRecord} */ (value);
}

/** Validate the complete scope separately from a single scope row. */
/** @param {unknown} value @param {string} [expectedAttemptId] @param {number} [expectedScopeCount] @returns {import("./contracts").AttemptScopeRecord[]} */
export function validateAttemptScope(value, expectedAttemptId, expectedScopeCount) {
  const rows = arrayValue(value, "$", APP_DATA_CONTENT_LIMITS.maxArrayItems);
  try { canonicalContentBytes(value); } catch (error) {
    if (error instanceof AppDataValidationError) throw error;
    throw error;
  }
  if (rows.length < 1) fail("range", "$", "scope must not be empty");
  if (expectedScopeCount !== undefined && rows.length !== expectedScopeCount) fail("count", "$", "scope length must equal expected scopeCount");
  const attemptId = expectedAttemptId;
  const keys = new Set();
  const sourceKeys = new Set();
  for (let index = 0; index < rows.length; index += 1) {
    const row = validateAttemptScopeRecord(rows[index], `$[${index}]`);
    if (index !== row.ordinal) fail("ordinal", `$[${index}].ordinal`, "scope ordinals must be contiguous from zero");
    if (attemptId !== undefined && row.attemptId !== attemptId) fail("attempt_id", `$[${index}].attemptId`, "scope row has the wrong attemptId");
    if (index > 0 && row.attemptId !== /** @type {import("./contracts").AttemptScopeRecord} */ (rows[0]).attemptId) fail("attempt_id", `$[${index}].attemptId`, "all scope rows must have one attemptId");
    if (keys.has(row.questionKey)) fail("duplicate", `$[${index}].questionKey`, "questionKey must be unique within scope");
    keys.add(row.questionKey);
    for (const source of row.equivalentSourceRefs) {
      if (sourceKeys.has(source.questionKey)) fail("duplicate", `$[${index}].equivalentSourceRefs`, "a source questionKey may occur only once across scope rows");
      sourceKeys.add(source.questionKey);
    }
  }
  return /** @type {import("./contracts").AttemptScopeRecord[]} */ (value);
}

/** @param {unknown} value @param {string} path @returns {import("./contracts").DraftRecord} */
function validateDraftShape(value, path) {
  const record = plainObject(value, path);
  exactFields(record, ["attemptId", "questionKey", "questionRevision", "input", "localRevision", "dirty", "submitted", "showKeys", "assisted", "writerStreamId", "fence", "inheritedFrom"], ["attemptId", "questionKey", "questionRevision", "input", "localRevision", "dirty", "submitted", "showKeys", "assisted", "writerStreamId", "fence"], path);
  uuid(record.attemptId, `${path}.attemptId`);
  questionKey(record.questionKey, `${path}.questionKey`);
  digest(record.questionRevision, `${path}.questionRevision`);
  validateAnswerInput(record.input, `${path}.input`);
  nonNegativeInteger(record.localRevision, `${path}.localRevision`);
  booleanValue(record.dirty, `${path}.dirty`);
  booleanValue(record.submitted, `${path}.submitted`);
  booleanValue(record.showKeys, `${path}.showKeys`);
  booleanValue(record.assisted, `${path}.assisted`);
  uuid(record.writerStreamId, `${path}.writerStreamId`);
  if (nonNegativeInteger(record.fence, `${path}.fence`) < 1) fail("range", `${path}.fence`, "fence must be positive");
  if (Object.hasOwn(record, "inheritedFrom")) {
    const inherited = plainObject(record.inheritedFrom, `${path}.inheritedFrom`);
    exactFields(inherited, ["attemptId", "resumeContentDigest"], ["attemptId", "resumeContentDigest"], `${path}.inheritedFrom`);
    uuid(inherited.attemptId, `${path}.inheritedFrom.attemptId`);
    digest(inherited.resumeContentDigest, `${path}.inheritedFrom.resumeContentDigest`);
    if (inherited.attemptId === record.attemptId) fail("invariant", `${path}.inheritedFrom.attemptId`, "inherited parent cannot be the current attempt");
  }
  assertSmallRecordBudget(value, path);
  return /** @type {import("./contracts").DraftRecord} */ (value);
}

/** @param {unknown} value @param {string} path @returns {import("./contracts").ResumeDraft} */
function validateResumeDraftShape(value, path) {
  const record = plainObject(value, path);
  exactFields(record, ["questionKey", "questionRevision", "input", "localRevision", "submitted", "showKeys", "assisted", "inheritedFrom"], ["questionKey", "questionRevision", "input", "localRevision", "submitted", "showKeys", "assisted"], path);
  questionKey(record.questionKey, `${path}.questionKey`);
  digest(record.questionRevision, `${path}.questionRevision`);
  validateAnswerInput(record.input, `${path}.input`);
  nonNegativeInteger(record.localRevision, `${path}.localRevision`);
  booleanValue(record.submitted, `${path}.submitted`);
  booleanValue(record.showKeys, `${path}.showKeys`);
  booleanValue(record.assisted, `${path}.assisted`);
  if (Object.hasOwn(record, "inheritedFrom")) {
    const inherited = plainObject(record.inheritedFrom, `${path}.inheritedFrom`);
    exactFields(inherited, ["attemptId", "resumeContentDigest"], ["attemptId", "resumeContentDigest"], `${path}.inheritedFrom`);
    uuid(inherited.attemptId, `${path}.inheritedFrom.attemptId`);
    digest(inherited.resumeContentDigest, `${path}.inheritedFrom.resumeContentDigest`);
  }
  assertSmallRecordBudget(value, path);
  return /** @type {import("./contracts").ResumeDraft} */ (value);
}

/**
 * Standalone DraftRecord shape validation. Self-inheritance is always
 * rejected; a containing attempt binding is required to check the expected
 * parent relationship, so callers that have that context should use
 * validateDraftForAttempt.
 * @param {unknown} value @param {string} [path]
 * @param {string} [legacyExpectedAttemptId] @returns {import("./contracts").DraftRecord}
 */
export function validateDraftRecord(value, path = "$", legacyExpectedAttemptId) {
  const record = validateDraftShape(value, path);
  // Preserve the pre-repair optional argument's self-check for callers that
  // still pass the current attempt ID, while the shape validator above now
  // rejects self-inheritance unconditionally.
  const inherited = record.inheritedFrom;
  if (legacyExpectedAttemptId !== undefined && inherited !== undefined && inherited.attemptId === legacyExpectedAttemptId) {
    fail("invariant", `${path}.inheritedFrom.attemptId`, "inherited parent cannot be the current attempt");
  }
  return record;
}

/**
 * Validate a draft together with the containing attempt's trusted binding.
 * The binding is the only T02b1-level check of the expected parent relation;
 * parent snapshot/content verification remains a later recovery concern.
 * @param {unknown} value @param {import("./contracts").AttemptContextBinding} context @param {string} [path]
 * @returns {import("./contracts").DraftRecord}
 */
export function validateDraftForAttempt(value, context, path = "$") {
  const binding = validateAttemptBinding(context, `${path}.context`);
  const record = validateDraftShape(value, path);
  if (record.attemptId !== binding.attemptId) fail("attempt_id", `${path}.attemptId`, "draft has the wrong current attemptId");
  validateInheritedParentBinding(record, binding, path);
  return record;
}

/**
 * Standalone ResumeDraft shape validation. ResumeDraft has no own attempt ID,
 * so inherited parent checking is only possible through the explicit helper.
 * The optional legacy ID preserves the former self-check for existing callers;
 * new code should pass the typed binding to validateResumeDraftForAttempt.
 * @param {unknown} value @param {string} [path] @param {string} [legacyCurrentAttemptId]
 * @returns {import("./contracts").ResumeDraft}
 */
export function validateResumeDraft(value, path = "$", legacyCurrentAttemptId) {
  const record = validateResumeDraftShape(value, path);
  const inherited = record.inheritedFrom;
  if (legacyCurrentAttemptId !== undefined && inherited !== undefined && inherited.attemptId === legacyCurrentAttemptId) {
    fail("invariant", `${path}.inheritedFrom.attemptId`, "inherited parent cannot be the current attempt");
  }
  return record;
}

/** @param {import("./contracts").DraftRecord|import("./contracts").ResumeDraft} record @param {import("./contracts").AttemptContextBinding} binding @param {string} path */
function validateInheritedParentBinding(record, binding, path) {
  const inherited = record.inheritedFrom;
  if (inherited === undefined) return;
  const parent = inherited.attemptId;
  if (binding.parentAttemptId === undefined) fail("invariant", `${path}.inheritedFrom.attemptId`, "inherited parent requires the containing attempt's parentAttemptId");
  if (parent !== binding.parentAttemptId) fail("invariant", `${path}.inheritedFrom.attemptId`, "inherited parent does not match the containing attempt's parentAttemptId");
}

/**
 * Validate a resume draft with its containing current-attempt binding.
 * @param {unknown} value @param {import("./contracts").AttemptContextBinding} context @param {string} [path]
 * @returns {import("./contracts").ResumeDraft}
 */
export function validateResumeDraftForAttempt(value, context, path = "$") {
  const binding = validateAttemptBinding(context, `${path}.context`);
  const record = validateResumeDraftShape(value, path);
  validateInheritedParentBinding(record, binding, path);
  return record;
}

/** @param {unknown} value @param {string} path @returns {import("./contracts").AnswerEventRecord} */
export function validateAnswerEvent(value, path = "$") {
  const record = plainObject(value, path);
  const base = ["eventId", "attemptId", "questionKey", "writerStreamId", "actionSeq", "kind", "occurredAt", "questionRevision", "assisted"];
  for (const key of ["eventId", "attemptId", "writerStreamId"]) uuid(record[key], `${path}.${key}`);
  questionKey(record.questionKey, `${path}.questionKey`);
  if (nonNegativeInteger(record.actionSeq, `${path}.actionSeq`) < 1) fail("range", `${path}.actionSeq`, "actionSeq must be positive");
  nonNegativeInteger(record.occurredAt, `${path}.occurredAt`);
  digest(record.questionRevision, `${path}.questionRevision`);
  const assisted = booleanValue(record.assisted, `${path}.assisted`);
  if (record.kind === "answer_submitted") {
    exactFields(record, [...base, "answer", "gradeAtTime", "graderVersion", "gradingBasisDigest"], [...base, "answer", "gradeAtTime", "graderVersion", "gradingBasisDigest"], path);
    validateAnswerInput(record.answer, `${path}.answer`);
    validateGradeAtTime(record.gradeAtTime, `${path}.gradeAtTime`);
    opaqueText(record.graderVersion, `${path}.graderVersion`);
    digest(record.gradingBasisDigest, `${path}.gradingBasisDigest`);
    void assisted;
    assertSmallRecordBudget(value, path);
    return /** @type {import("./contracts").SubmitAnswerEvent} */ (value);
  }
  if (record.kind === "redo") {
    exactFields(record, [...base, "redoOfEventId"], [...base, "redoOfEventId"], path);
    uuid(record.redoOfEventId, `${path}.redoOfEventId`);
    assertSmallRecordBudget(value, path);
    return /** @type {import("./contracts").RedoEvent} */ (value);
  }
  if (record.kind === "hint") {
    exactFields(record, [...base, "hintKind"], [...base, "hintKind"], path);
    opaqueText(record.hintKind, `${path}.hintKind`);
    if (assisted !== true) fail("invariant", `${path}.assisted`, "hint events must have assisted=true");
    assertSmallRecordBudget(value, path);
    return /** @type {import("./contracts").HintEvent} */ (value);
  }
  fail("enum", `${path}.kind`, "event kind must be answer_submitted, redo, or hint");
}

// Stable descriptive aliases keep the public entry readable for store users
// while each implementation remains in this one module.
export const validateAttempt = validateAttemptRecord;
export const validateScopeRecord = validateAttemptScopeRecord;
export const validateCompleteAttemptScope = validateAttemptScope;
export const validateInput = validateAnswerInput;
export const validateDraft = validateDraftRecord;
