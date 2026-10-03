import { deriveContent } from "./content-identity.js";
import { isQuestionKey, isUuid } from "./index.js";
import { canonicalContentBytes, sha256Hex, utf8ByteLength } from "../app-data/canonical.js";
import { makeLegacyId, makeSourceKey, validateAlias } from "../app-data/identity.js";

const DIGEST = /^[0-9a-f]{64}$/;
const POLICIES = new Set(["public", "protected", "private"]);
const INTENTS = new Set(["create", "update", "copy", "unresolved"]);

/** @typedef {{sourceOrigin:string,namespace:string,sourceKey:string,bankUid:string,slug:string,title:string,policy:'public'|'protected'|'private'}} RegistrationBank */
/** @typedef {import('../app-data/contracts').EquivalentSourceRef} SourceRef */
/** @typedef {{sourceOrigin:string,namespace:string,sourceKey:string,legacyRevision:string,legacyId:string,legacyRawId:string,legacyRuntimeId:string,mappingStatus:'mapped'|'unknown'|'quarantined',candidates:string[],newQuestionKey?:string}} RegistrationAlias */
/** @typedef {{localId:string,questionRevision:string,optionIds:string[],provenance:SourceRef[],alias:RegistrationAlias,questionKey?:string}} RegistrationRow */
/** @typedef {{code:'LEGACY_AMBIGUOUS'|'IDENTITY_UNRESOLVED',localIds:string[],sourceKey:string,legacyRevision:string,legacyId:string,candidates:string[]}} RegistrationIssue */
/** @typedef {{questionKey:string,sourceKey:string,questionRevision:string,provenance:SourceRef[]}} RegisteredReference */
/** @typedef {{planId:string,planDigest:string,rows:RegistrationRow[],issues:RegistrationIssue[]}} RegistrationReceipt */
/** @typedef {{schemaVersion:1,scopeId:string,banks:RegistrationBank[],questions:RegisteredReference[],receipts:RegistrationReceipt[]}} RegistrationRegistry */
/** @typedef {{localId:string,legacyRevision:string,legacyRawId:string,legacyRuntimeId:string,question:Record<string,unknown>} & ({intent:'unresolved',questionUid?:never,copiedFrom?:never}|{intent:'create'|'update',questionUid:string,copiedFrom?:never}|{intent:'copy',questionUid:string,copiedFrom:SourceRef})} RegistrationItem */
/** @typedef {{planId:string,scopeId:string,bank:RegistrationBank,items:RegistrationItem[]}} RegistrationPlan */
/** @typedef {Error & {code:string,path:string}} RegistrationError */

/** @param {string} code @param {string} message @param {string} path @param {unknown} [cause] @returns {RegistrationError} */
function error(code, message, path = "$", cause) {
  const result = /** @type {RegistrationError} */(new Error(message, cause === undefined ? undefined : { cause }));
  result.code = code;
  result.path = path;
  if (cause !== undefined) result.cause = cause;
  return result;
}

/** @param {string} code @param {string} message @param {string} path @param {unknown} [cause] @returns {never} */
function fail(code, message, path = "$", cause) { throw error(code, message, path, cause); }
/** @param {object} value @param {PropertyKey} key @returns {boolean} */
function own(value, key) { return Object.prototype.hasOwnProperty.call(value, key); }
/** @param {string} a @param {string} b @returns {number} */
function compare(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
/** @param {string[]} values @returns {string[]} */
function sorted(values) { return values.slice().sort(compare); }

/** Snapshot with the product-sized canonical safety boundary. */
/** @param {unknown} value @param {string} code @returns {unknown} */
function snapshot(value, code) {
  try {
    canonicalContentBytes(value);
    return structuredClone(value);
  } catch (cause) {
    fail(code, "value is not a bounded JSON snapshot", "$", cause);
  }
}

/** @overload @param {unknown} value @param {string[]} required @param {string[]} optional @param {string} code @param {string} path @returns {asserts value is Record<string,unknown>} */
/** @param {unknown} value @param {string[]} required @param {string[]} optional @param {string} code @param {string} path @returns {Record<string,unknown>} */
function exactObject(value, required, optional, code, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(code, "expected a plain object", path);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(code, `unknown field ${key}`, `${path}.${key}`);
  for (const key of required) if (!own(value, key)) fail(code, `missing field ${key}`, `${path}.${key}`);
  return /** @type {Record<string,unknown>} */(value);
}

/** @overload @param {unknown} value @param {string} label @param {number} maximum @param {string} code @param {boolean} [allowEmpty] @returns {asserts value is string} */
/** @param {unknown} value @param {string} label @param {number} maximum @param {string} code @param {boolean} allowEmpty @returns {string} */
function text(value, label, maximum, code, allowEmpty = false) {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) fail(code, `${label} must be a ${allowEmpty ? "string" : "non-empty string"}`, label);
  try {
    if (utf8ByteLength(value) > maximum) fail(code, `${label} exceeds its UTF-8 bound`, label);
  } catch (cause) { fail(code, `${label} is not valid text`, label, cause); }
  return value;
}

/** @overload @param {unknown} value @param {string} label @param {string} code @returns {asserts value is string} */
/** @param {unknown} value @param {string} label @param {string} code @returns {string} */
function digest(value, label, code) {
  if (typeof value !== "string" || !DIGEST.test(value)) fail(code, `${label} must be lowercase SHA-256 hex`, label);
  return value;
}

/** @overload @param {unknown} value @param {string} label @param {string} code @returns {asserts value is string} */
/** @param {unknown} value @param {string} label @param {string} code @returns {string} */
function uuid(value, label, code) {
  if (!isUuid(value)) fail(code, `${label} must be a lowercase UUID`, label);
  return value;
}

/** @param {unknown} bank @param {string} code @returns {string} */
function sourceKeyFor(bank, code) {
  exactObject(bank, ["sourceOrigin", "namespace", "sourceKey", "bankUid", "slug", "title", "policy"], [], code, "$.bank");
  uuid(bank.bankUid, "bankUid", code);
  text(bank.sourceOrigin, "sourceOrigin", 2048, code);
  text(bank.namespace, "namespace", 256, code);
  text(bank.slug, "slug", 128, code);
  text(bank.title, "title", 512, code, true);
  if (!POLICIES.has(/** @type {string} */(bank.policy))) fail(code, "invalid bank policy", "$.bank.policy");
  let expected;
  try { expected = makeSourceKey(bank.sourceOrigin, bank.namespace); } catch (cause) { fail(code, "invalid source binding", "$.bank.sourceKey", cause); }
  if (bank.sourceKey !== expected) fail(code === "INVALID_REGISTRY" ? code : "SOURCE_CONFLICT", "sourceKey does not match sourceOrigin/namespace", "$.bank.sourceKey");
  return expected;
}

/** @overload @param {unknown} value @param {string} code @param {string} path @returns {asserts value is SourceRef} */
/** @param {unknown} value @param {string} code @param {string} path @returns {Record<string,unknown>} */
function sourceRef(value, code, path) {
  exactObject(value, ["questionKey", "questionRevision"], [], code, path);
  if (!isQuestionKey(value.questionKey)) fail(code, "invalid questionKey", `${path}.questionKey`);
  digest(value.questionRevision, "questionRevision", code);
  return value;
}

/** @param {unknown} value @param {string} code @param {string} path @returns {asserts value is SourceRef[]} */
function validateProvenance(value, code, path) {
  if (!Array.isArray(value)) fail(code, "provenance must be an array", path);
  for (let index = 0; index < value.length; index += 1) sourceRef(value[index], code, `${path}[${index}]`);
  if (value.length > 1) fail(code, "provenance may contain at most one source reference", path);
}

/** @param {unknown} value @param {string} code @param {string} path @returns {asserts value is RegistrationAlias} */
function validateAliasShape(value, code, path) {
  exactObject(value, ["sourceOrigin", "namespace", "sourceKey", "legacyRevision", "legacyId", "legacyRawId", "legacyRuntimeId", "mappingStatus", "candidates"], ["newQuestionKey"], code, path);
  text(value.sourceOrigin, "sourceOrigin", 2048, code);
  text(value.namespace, "namespace", 256, code);
  text(value.legacyRevision, "legacyRevision", 512, code);
  text(value.legacyRawId, "legacyRawId", 512, code);
  text(value.legacyRuntimeId, "legacyRuntimeId", 512, code);
  try {
    if (value.sourceKey !== makeSourceKey(value.sourceOrigin, value.namespace)) fail(code, "alias sourceKey mismatch", `${path}.sourceKey`);
    if (value.legacyId !== makeLegacyId(value.legacyRawId, value.legacyRuntimeId)) fail(code, "alias legacyId mismatch", `${path}.legacyId`);
  } catch (cause) { fail(code, "invalid alias identity", path, cause); }
  if (value.legacyRevision.startsWith("unknown:") && !DIGEST.test(value.legacyRevision.slice(8))) fail(code, "unknown legacyRevision must carry a digest", `${path}.legacyRevision`);
  if (!["mapped", "unknown", "quarantined"].includes(/** @type {string} */(value.mappingStatus))) fail(code, "invalid alias mappingStatus", `${path}.mappingStatus`);
  if (!Array.isArray(value.candidates)) fail(code, "alias candidates must be an array", `${path}.candidates`);
  const seen = new Set();
  for (let index = 0; index < value.candidates.length; index += 1) {
    if (!isQuestionKey(value.candidates[index]) || seen.has(value.candidates[index])) fail(code, "invalid or duplicate alias candidate", `${path}.candidates[${index}]`);
    seen.add(value.candidates[index]);
  }
  if (value.mappingStatus === "mapped") {
    if (!own(value, "newQuestionKey") || value.candidates.length !== 1 || value.newQuestionKey !== value.candidates[0] || !isQuestionKey(value.newQuestionKey)) fail(code, "mapped alias must have one matching target", path);
  } else if (own(value, "newQuestionKey")) fail(code, "unresolved alias cannot claim a target", `${path}.newQuestionKey`);
  try { validateAlias(value); } catch (cause) { fail(code, "alias violates shared alias contract", path, cause); }
}

/** @param {unknown} value @param {string} code @param {string} path @returns {asserts value is RegistrationRow} */
function validateRow(value, code, path) {
  exactObject(value, ["localId", "questionRevision", "optionIds", "provenance", "alias"], ["questionKey"], code, path);
  text(value.localId, "localId", 128, code);
  digest(value.questionRevision, "questionRevision", code);
  if (!Array.isArray(value.optionIds)) fail(code, "optionIds must be an array", `${path}.optionIds`);
  for (const optionId of value.optionIds) if (typeof optionId !== "string" || !/^opt_[A-Za-z0-9_-]{16,128}$/.test(optionId)) fail(code, "invalid optionId", `${path}.optionIds`);
  validateProvenance(value.provenance, code, `${path}.provenance`);
  validateAliasShape(value.alias, code, `${path}.alias`);
  if (own(value, "questionKey")) {
    if (!isQuestionKey(value.questionKey)) fail(code, "invalid row questionKey", `${path}.questionKey`);
    if (value.alias.mappingStatus === "mapped" && value.alias.newQuestionKey !== value.questionKey) fail(code, "mapped row key must match alias target", path);
  } else if (value.alias.mappingStatus === "mapped") {
    fail(code, "mapped row must carry questionKey", path);
  }
}

/** @param {unknown} value @param {string} code @param {string} path @returns {asserts value is RegistrationIssue} */
function validateIssue(value, code, path) {
  exactObject(value, ["code", "localIds", "sourceKey", "legacyRevision", "legacyId", "candidates"], [], code, path);
  if (value.code !== "LEGACY_AMBIGUOUS" && value.code !== "IDENTITY_UNRESOLVED") fail(code, "invalid issue code", `${path}.code`);
  if (!Array.isArray(value.localIds) || value.localIds.length === 0) fail(code, "issue localIds must be non-empty", `${path}.localIds`);
  const localIds = new Set();
  for (let i = 0; i < value.localIds.length; i += 1) {
    text(value.localIds[i], "localId", 128, code);
    if (localIds.has(value.localIds[i])) fail(code, "issue localIds must be unique", `${path}.localIds[${i}]`);
    localIds.add(value.localIds[i]);
  }
  text(value.sourceKey, "sourceKey", 4096, code); text(value.legacyRevision, "legacyRevision", 512, code); text(value.legacyId, "legacyId", 2048, code);
  if (!Array.isArray(value.candidates)) fail(code, "invalid issue candidates", `${path}.candidates`);
  const candidates = new Set();
  for (let i = 0; i < value.candidates.length; i += 1) {
    if (!isQuestionKey(value.candidates[i]) || candidates.has(value.candidates[i])) fail(code, "issue candidates must be unique question keys", `${path}.candidates[${i}]`);
    candidates.add(value.candidates[i]);
  }
}

/** @param {unknown} value @param {string} code @param {string} path @returns {asserts value is RegistrationReceipt} */
function validateReceipt(value, code, path) {
  exactObject(value, ["planId", "planDigest", "rows", "issues"], [], code, path);
  text(value.planId, "planId", 128, code); digest(value.planDigest, "planDigest", code);
  if (!Array.isArray(value.rows)) fail(code, "receipt rows must be an array", `${path}.rows`);
  const rowIds = new Set();
  for (let i = 0; i < value.rows.length; i += 1) {
    validateRow(value.rows[i], code, `${path}.rows[${i}]`);
    if (rowIds.has(value.rows[i].localId)) fail(code, "receipt row localIds must be unique", `${path}.rows[${i}].localId`);
    rowIds.add(value.rows[i].localId);
  }
  if (!Array.isArray(value.issues)) fail(code, "receipt issues must be an array", `${path}.issues`);
  for (let i = 0; i < value.issues.length; i += 1) validateIssue(value.issues[i], code, `${path}.issues[${i}]`);
}

/** @overload @param {unknown} value @returns {asserts value is RegistrationRegistry} */
/** @param {unknown} value @returns {Record<string,unknown>} */
function validateRegistry(value) {
  exactObject(value, ["schemaVersion", "scopeId", "banks", "questions", "receipts"], [], "INVALID_REGISTRY", "$.registry");
  if (value.schemaVersion !== 1) fail("INVALID_REGISTRY", "unsupported registry schemaVersion", "$.registry.schemaVersion");
  text(value.scopeId, "scopeId", 128, "INVALID_REGISTRY");
  if (!Array.isArray(value.banks) || !Array.isArray(value.questions) || !Array.isArray(value.receipts)) fail("INVALID_REGISTRY", "registry arrays are required", "$.registry");
  const bankUids = new Set(); const sourceKeys = new Set();
  for (let i = 0; i < value.banks.length; i += 1) {
    const bank = value.banks[i]; const sourceKey = sourceKeyFor(bank, "INVALID_REGISTRY");
    if (bankUids.has(bank.bankUid) || sourceKeys.has(sourceKey)) fail("INVALID_REGISTRY", "duplicate bank binding", `$.registry.banks[${i}]`);
    bankUids.add(bank.bankUid); sourceKeys.add(sourceKey);
  }
  const questionKeys = new Set();
  for (let i = 0; i < value.questions.length; i += 1) {
    const question = value.questions[i]; exactObject(question, ["questionKey", "sourceKey", "questionRevision", "provenance"], [], "INVALID_REGISTRY", `$.registry.questions[${i}]`);
    if (!isQuestionKey(question.questionKey)) fail("INVALID_REGISTRY", "invalid registered question key", `$.registry.questions[${i}].questionKey`);
    digest(question.questionRevision, "questionRevision", "INVALID_REGISTRY"); validateProvenance(question.provenance, "INVALID_REGISTRY", `$.registry.questions[${i}].provenance`);
    const questionKey = question.questionKey;
    const bank = value.banks.find((entry) => entry.bankUid === questionKey.split("/")[0]);
    if (!bank || question.sourceKey !== bank.sourceKey) fail("INVALID_REGISTRY", "registered question source mismatch", `$.registry.questions[${i}]`);
    if (questionKeys.has(question.questionKey)) fail("INVALID_REGISTRY", "duplicate question key", `$.registry.questions[${i}]`);
    questionKeys.add(question.questionKey);
  }
  const planIds = new Set();
  for (let i = 0; i < value.receipts.length; i += 1) {
    validateReceipt(value.receipts[i], "INVALID_REGISTRY", `$.registry.receipts[${i}]`);
    if (planIds.has(value.receipts[i].planId)) fail("INVALID_REGISTRY", "duplicate receipt planId", `$.registry.receipts[${i}]`);
    planIds.add(value.receipts[i].planId);
  }
  return value;
}

/** @param {unknown} value @param {RegistrationRegistry} registry @returns {string} */
function validatePlan(value, registry) {
  exactObject(value, ["planId", "scopeId", "bank", "items"], [], "INVALID_PLAN", "$.plan");
  text(value.planId, "planId", 128, "INVALID_PLAN"); text(value.scopeId, "scopeId", 128, "INVALID_PLAN");
  if (registry.scopeId && registry.scopeId !== value.scopeId) fail("SCOPE_MISMATCH", "plan scope does not match registry scope", "$.plan.scopeId");
  const sourceKey = sourceKeyFor(value.bank, "INVALID_PLAN");
  if (!Array.isArray(value.items) || value.items.length === 0) fail("INVALID_PLAN", "plan items must be a non-empty array", "$.plan.items");
  const localIds = new Set();
  for (let i = 0; i < value.items.length; i += 1) {
    const item = value.items[i];
    exactObject(item, ["localId", "legacyRevision", "legacyRawId", "legacyRuntimeId", "question", "intent"], ["questionUid", "copiedFrom"], "INVALID_PLAN", `$.plan.items[${i}]`);
    text(item.localId, "localId", 128, "INVALID_PLAN");
    if (localIds.has(item.localId)) fail("IDENTITY_CONFLICT", "duplicate localId", `$.plan.items[${i}].localId`); localIds.add(item.localId);
    text(item.legacyRevision, "legacyRevision", 512, "INVALID_PLAN"); text(item.legacyRawId, "legacyRawId", 512, "INVALID_PLAN"); text(item.legacyRuntimeId, "legacyRuntimeId", 512, "INVALID_PLAN");
    if (item.question === null || typeof item.question !== "object" || Array.isArray(item.question) || Object.getPrototypeOf(item.question) !== Object.prototype) fail("INVALID_PLAN", "question must be a plain object", `$.plan.items[${i}].question`);
    if (!INTENTS.has(/** @type {string} */(item.intent))) fail("INVALID_PLAN", "invalid registration intent", `$.plan.items[${i}].intent`);
    if (item.intent === "unresolved") {
      if (own(item, "questionUid") || own(item, "copiedFrom")) fail("IDENTITY_CONFLICT", "unresolved item cannot carry identity", `$.plan.items[${i}]`);
    } else {
      uuid(item.questionUid, "questionUid", "INVALID_PLAN");
      if (item.intent === "copy") sourceRef(item.copiedFrom, "INVALID_PLAN", `$.plan.items[${i}].copiedFrom`);
      else if (own(item, "copiedFrom")) fail("INVALID_PLAN", "only copy items may carry copiedFrom", `$.plan.items[${i}].copiedFrom`);
    }
  }
  return sourceKey;
}

/** @param {unknown} value @returns {Promise<string>} */
async function digestValue(value) { return sha256Hex(canonicalContentBytes(value)); }
/** @param {string} bankUid @param {string} questionUid @returns {string} */
function keyFor(bankUid, questionUid) { return `${bankUid}/${questionUid}`; }
/** @template T @param {T} value @returns {T} */
function clone(value) { return structuredClone(value); }
/** @param {Map<string,RegisteredReference>} questionMap @param {string} sourceKey @param {string} revision @returns {string[]} */
function candidateList(questionMap, sourceKey, revision) { return sorted([...questionMap.values()].filter((q) => q.sourceKey === sourceKey && q.questionRevision === revision).map((q) => q.questionKey)); }

/** Register explicit identities and preserve legacy aliases without storing body content.
 * @param {unknown} registry @param {unknown} plan */
export async function applyRegistrationPlan(registry, plan) {
  const r = snapshot(registry, "INVALID_REGISTRY");
  const planSnapshot = snapshot(plan, "INVALID_PLAN");
  validateRegistry(r);
  const sourceKey = validatePlan(planSnapshot, r);
  const p = /** @type {RegistrationPlan} */(planSnapshot);
  const existingBank = r.banks.find((bank) => bank.sourceKey === sourceKey || bank.bankUid === p.bank.bankUid);
  if (existingBank && (existingBank.sourceKey !== sourceKey || existingBank.bankUid !== p.bank.bankUid)) fail("SOURCE_CONFLICT", "sourceKey and bankUid are already bound differently", "$.plan.bank");
  const planDigest = await digestValue(p);
  const old = r.receipts.find((receipt) => receipt.planId === p.planId);
  if (old) {
    if (old.planDigest !== planDigest) fail("PLAN_CONFLICT", "planId is already bound to a different plan", "$.plan.planId");
    const replay = { registry: clone(r), rows: clone(old.rows), issues: clone(old.issues), replayed: true };
    try { canonicalContentBytes(replay.registry); canonicalContentBytes(replay); } catch (cause) { fail("INVALID_REGISTRY", "replay output exceeds product bounds", "$", cause); }
    return replay;
  }
  const existingKeys = new Set(r.questions.map((question) => question.questionKey));
  const targets = new Set();
  for (let i = 0; i < p.items.length; i += 1) {
    const item = /** @type {RegistrationItem} */(p.items[i]);
    if (item.intent === "unresolved") continue;
    const target = keyFor(p.bank.bankUid, item.questionUid);
    if (targets.has(target)) fail("IDENTITY_CONFLICT", "duplicate question target in plan", `$.plan.items[${i}].questionUid`);
    targets.add(target);
    const prior = r.questions.find((question) => question.questionKey === target);
    if (item.intent === "update" && (!prior || prior.sourceKey !== sourceKey)) fail("IDENTITY_CONFLICT", "update target is not an existing question in this bank", `$.plan.items[${i}].questionUid`);
    if (item.intent !== "update" && existingKeys.has(target)) fail("IDENTITY_CONFLICT", "question target already exists", `$.plan.items[${i}].questionUid`);
    if (item.intent === "copy") {
      const copiedFrom = item.copiedFrom;
      const source = r.questions.find((question) => question.questionKey === copiedFrom.questionKey && question.questionRevision === copiedFrom.questionRevision);
      if (!source || source.sourceKey === sourceKey || source.questionKey.split("/")[1] === item.questionUid) fail("IDENTITY_CONFLICT", "copy source is not an eligible different-bank current reference", `$.plan.items[${i}].copiedFrom`);
    }
  }

  /** @type {RegisteredReference[]} */ const newQuestions = [];
  /** @type {RegistrationRow[]} */ const rows = [];
  for (const item of p.items) {
    let derived;
    try { derived = await deriveContent(item.question); }
    catch (cause) { fail("INVALID_PLAN", "plan question content is invalid", "$.plan.items.question", cause); }
    const questionKey = item.intent === "unresolved" ? undefined : keyFor(p.bank.bankUid, item.questionUid);
    const prior = questionKey ? r.questions.find((question) => question.questionKey === questionKey) : undefined;
    const provenance = item.intent === "copy" ? [clone(item.copiedFrom)] : (prior ? clone(prior.provenance) : []);
    if (questionKey) newQuestions.push({ questionKey, sourceKey, questionRevision: derived.questionRevision, provenance });
    const legacyId = makeLegacyId(item.legacyRawId, item.legacyRuntimeId);
    /** @type {RegistrationRow} */
    const row = { localId: item.localId, questionRevision: derived.questionRevision, optionIds: clone(derived.optionIds), provenance: clone(provenance), alias: { sourceOrigin: p.bank.sourceOrigin, namespace: p.bank.namespace, sourceKey, legacyRevision: item.legacyRevision, legacyId, legacyRawId: item.legacyRawId, legacyRuntimeId: item.legacyRuntimeId, mappingStatus: questionKey ? "mapped" : "unknown", candidates: questionKey ? [questionKey] : [] } };
    if (questionKey) { row.questionKey = questionKey; row.alias.newQuestionKey = questionKey; }
    rows.push(row);
  }

  // Candidate lookup is deliberately built from the final key-indexed map: updates replace old revisions.
  const questionMap = new Map(r.questions.map((question) => [question.questionKey, question]));
  for (const question of newQuestions) questionMap.set(question.questionKey, question);
  for (const row of rows) if (row.alias.mappingStatus === "unknown") row.alias.candidates = candidateList(questionMap, row.alias.sourceKey, row.questionRevision);
  /** @type {Map<string,RegistrationRow[]>} */ const groups = new Map();
  for (const row of rows) { const tuple = JSON.stringify([row.alias.sourceKey, row.alias.legacyRevision, row.alias.legacyId]); const group = groups.get(tuple) || []; group.push(row); groups.set(tuple, group); }
  /** @type {RegistrationIssue[]} */ const issues = [];
  for (const group of groups.values()) {
    const first = /** @type {RegistrationRow} */(group[0]);
    const tupleCandidates = sorted([...new Set(group.flatMap((row) => candidateList(questionMap, row.alias.sourceKey, row.questionRevision).concat(row.questionKey ? [row.questionKey] : [])))]);
    const competing = group.length > 1;
    const unresolvedAmbiguous = group.some((row) => !row.questionKey) && tupleCandidates.length > 1;
    if (competing || unresolvedAmbiguous) {
      for (const row of group) { delete row.alias.newQuestionKey; row.alias.mappingStatus = "quarantined"; row.alias.candidates = tupleCandidates; }
      issues.push({ code: "LEGACY_AMBIGUOUS", localIds: sorted(group.map((row) => row.localId)), sourceKey: first.alias.sourceKey, legacyRevision: first.alias.legacyRevision, legacyId: first.alias.legacyId, candidates: tupleCandidates });
    } else if (!first.questionKey) {
      issues.push({ code: "IDENTITY_UNRESOLVED", localIds: [first.localId], sourceKey: first.alias.sourceKey, legacyRevision: first.alias.legacyRevision, legacyId: first.alias.legacyId, candidates: first.alias.candidates });
    }
  }
  issues.sort((a, b) => compare(a.sourceKey, b.sourceKey) || compare(a.legacyRevision, b.legacyRevision) || compare(a.legacyId, b.legacyId));
  for (const row of rows) validateRow(row, "INVALID_PLAN", "$.result.rows");

  const bank = clone(p.bank);
  r.banks = [...r.banks.filter((entry) => entry.sourceKey !== sourceKey), bank].sort((a, b) => compare(a.sourceKey, b.sourceKey));
  r.questions = [...questionMap.values()].sort((a, b) => compare(a.questionKey, b.questionKey));
  const receipt = { planId: p.planId, planDigest, rows: rows.slice().sort((a, b) => compare(a.localId, b.localId)), issues };
  r.receipts = [...r.receipts, receipt].sort((a, b) => compare(a.planId, b.planId));
  const result = { registry: clone(r), rows: clone(receipt.rows), issues: clone(receipt.issues), replayed: false };
  try { canonicalContentBytes(result.registry); canonicalContentBytes(result); } catch (cause) { fail("INVALID_PLAN", "registration output exceeds product bounds", "$.result", cause); }
  return result;
}

/** Finalize only complete explicit identities; body remains caller-owned content, never registry data.
 * @param {unknown} records */
export async function finalizeRegisteredQuestions(records) {
  const input = snapshot(records, "INVALID_REGISTERED_IDENTITY");
  if (!Array.isArray(input)) fail("INVALID_REGISTERED_IDENTITY", "records must be an array");
  const output = [];
  for (const captured of input) {
    if (captured === null || typeof captured !== "object" || Array.isArray(captured) || Object.getPrototypeOf(captured) !== Object.prototype) fail("INVALID_REGISTERED_IDENTITY", "registered record must be a plain object");
    const record = /** @type {Record<string,unknown>} */(captured);
    const complete = own(record, "bankUid") && own(record, "questionUid") && own(record, "questionKey");
    if (!complete || !isUuid(record.bankUid) || !isUuid(record.questionUid) || !isQuestionKey(record.questionKey) || record.questionKey !== `${record.bankUid}/${record.questionUid}`) fail("INVALID_REGISTERED_IDENTITY", "registered identity must be a complete consistent triplet");
    if (record.type === "matching" || record.type === "essay") fail("UNSUPPORTED_REGISTERED_TYPE", "registered matching/essay records are unsupported");
    let derived;
    try { derived = await deriveContent(record); }
    catch (cause) { fail("INVALID_CONTENT", "registered question content is invalid", "$.records", cause); }
    const finished = clone(record); finished.questionRevision = derived.questionRevision; finished.optionIds = clone(derived.optionIds); output.push(finished);
  }
  try { canonicalContentBytes(output); } catch (cause) { fail("INVALID_CONTENT", "finalized output exceeds product bounds", "$.records", cause); }
  return output;
}
