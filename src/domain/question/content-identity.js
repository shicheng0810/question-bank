import { canonicalContentBytes, sha256Hex } from "../app-data/canonical.js";

// These values identify an imported record rather than its user-visible content.
// Only top-level keys are removed: a nested `source`, `id`, or provenance note is
// part of the content and must therefore remain in the revision.
const IDENTITY_KEYS = new Set([
  "id",
  "source",
  "banks",
  "bankUid",
  "questionUid",
  "questionKey",
  "questionRevision",
  "optionIds",
  "provenance",
]);

/**
 * Make a detached JSON-data snapshot after canonicalContentBytes has rejected
 * accessors, non-plain prototypes, cycles, and values outside the fixed content
 * bounds. This occurs before the first await in deriveContent.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
function snapshotContent(value) {
  canonicalContentBytes(value);
  return structuredClone(value);
}

/** @param {string} message @returns {never} */
function invalidQuestion(message) {
  throw new TypeError(`question content ${message}`);
}

/** @param {unknown} value @returns {value is string[][]} */
function isStringMatrix(value) {
  return Array.isArray(value) && value.every((row) => Array.isArray(row) && row.every((entry) => typeof entry === "string"));
}

/** @param {Record<string, unknown>} snapshot @returns {"choice" | "fill"} */
function validateQuestionSemantics(snapshot) {
  const image = snapshot.image;
  return validateQuestionSemanticFields(snapshot, Boolean(image && (typeof image === "string" || (Array.isArray(image) && image.length > 0))));
}

/** Pure semantic predicate only, never content/identity/storage admission.
 * The streaming caller must derive image presence from its genuine native leaf.
 * @param {Record<string, unknown>} snapshot @param {boolean} hasMedia
 * @returns {"choice" | "fill"} */
export function validateQuestionSemanticFields(snapshot, hasMedia) {
  if(typeof hasMedia!=="boolean")invalidQuestion("media predicate must be boolean");
  const type = snapshot.type;
  const hasAnswer = Object.hasOwn(snapshot, "answer");
  const hasAnswers = Object.hasOwn(snapshot, "answers");
  if (hasAnswer && hasAnswers) invalidQuestion("answer and answers cannot both be present");
  const hasText = typeof snapshot.question === "string" && snapshot.question.trim().length > 0;
  if (!hasText && !hasMedia) invalidQuestion("requires question text or media");
  if (type === "fill") {
    if (!isStringMatrix(snapshot.blanks) || !snapshot.blanks.some((row) => row.some((entry) => entry.trim().length > 0))) {
      invalidQuestion("fill blanks must contain a non-blank string");
    }
    if (Object.hasOwn(snapshot, "answer_sets") && !isStringMatrix(snapshot.answer_sets)) {
      invalidQuestion("fill answer_sets must be a string matrix");
    }
    return "fill";
  }
  if (type !== undefined && type !== "choice") invalidQuestion("type must be choice or fill");

  const choices = snapshot.choices;
  if (!Array.isArray(choices) || choices.length < 2 || choices.some((entry) => typeof entry !== "string")) {
    invalidQuestion("choice choices must contain at least two strings");
  }
  if (hasAnswer === hasAnswers) invalidQuestion("choice requires exactly one of answer or answers");
  /** @param {number} value @returns {boolean} */
  const isIndex = (value) => Number.isInteger(value) && value >= 0 && value < choices.length;
  if (hasAnswer && !isIndex(/** @type {number} */(snapshot.answer))) invalidQuestion("choice answer index is invalid");
  if (hasAnswers && (!Array.isArray(snapshot.answers) || snapshot.answers.length === 0 || snapshot.answers.some((entry) => !isIndex(entry)))) {
    invalidQuestion("choice answers indexes are invalid");
  }
  return "choice";
}

/**
 * @param {Record<string, unknown>} snapshot
 * @returns {Record<string, unknown>}
 */
function projectContent(snapshot) {
  /** @type {Record<string,unknown>} */
  const projection = {};
  for (const key of Object.keys(snapshot)) {
    if (!IDENTITY_KEYS.has(key)) projection[key] = snapshot[key];
  }
  return projection;
}

/**
 * Derive content-only identity without wiring it into the product question
 * boundary. The input is validated and copied before digest work begins, so an
 * asynchronous caller cannot change the returned result by mutating its object.
 *
 * `choices` is deliberately the only option-bearing field in the current public
 * A contract. All other safe fields (including unknown fields and media) remain
 * in the projection and revision rather than being discarded or reinterpreted.
 *
 * @param {unknown} question
 * @returns {Promise<{projection: Record<string, unknown>, questionRevision: string, optionIds: string[]}>}
 */
export async function deriveContent(question) {
  const captured = snapshotContent(question);
  if (captured === null || typeof captured !== "object" || Array.isArray(captured) || Object.getPrototypeOf(captured) !== Object.prototype) {
    throw new TypeError("question content must be a plain object");
  }
  const snapshot = /** @type {Record<string,unknown>} */(captured);
  const kind = validateQuestionSemantics(snapshot);

  const projection = projectContent(snapshot);
  const questionRevision = await sha256Hex(canonicalContentBytes({
    projectionVersion: 1,
    content: projection,
  }));

  const choices = kind === "choice" ? /** @type {string[]} */(snapshot.choices) : [];
  const optionIds = await Promise.all(choices.map(async (_choice, index) => {
    const digest = await sha256Hex(canonicalContentBytes({
      optionIdentityVersion: 1,
      questionRevision,
      index,
    }));
    return `opt_${digest}`;
  }));

  return { projection, questionRevision, optionIds };
}
