/**
 * Stable content identity helpers.  These deliberately validate identifiers
 * only; allocating identities and calculating content revisions belongs to T05.
 */

// RFC 9562 canonical lowercase form: version 1–8 and RFC 4122 variant.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const QUESTION_KEY_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

/** @param {unknown} value @returns {value is string} */
export function isUuid(value) {
  return typeof value === "string" && UUID_RE.test(value);
}

/** @param {unknown} value @returns {value is string} */
export function isQuestionKey(value) {
  return typeof value === "string" && QUESTION_KEY_RE.test(value);
}

/**
 * v2 option IDs are revision-bound opaque values.  T05 must mint and preserve
 * them with the `opt_` prefix; callers must also record questionRevision.
 * No display text, index, fuzzy matching, or Unicode normalization is used.
 *
 * @param {unknown} value
 * @returns {value is string}
 */
export function isOptionId(value) {
  return typeof value === "string" && /^opt_[A-Za-z0-9_-]{16,128}$/.test(value);
}

/** @param {unknown} value @param {string} label */
export function assertQuestionKey(value, label = "questionKey") {
  if (!isQuestionKey(value)) throw new TypeError(`${label} must be bankUid/questionUid using lowercase UUIDs`);
  return value;
}

/** @param {unknown} value @param {string} label */
export function assertOptionId(value, label = "optionId") {
  if (!isOptionId(value)) throw new TypeError(`${label} must be a revision-bound opt_ opaque identifier`);
  return value;
}
