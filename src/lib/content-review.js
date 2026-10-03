import {
  buildQuestionBank,
  validateQuestionBankRecords,
} from './testable-core.js';

const DISPOSITIONS = Object.freeze(['valid', 'review', 'rejected']);

function cloneValue(value, seen = new WeakMap()) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);

  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof RegExp) return new RegExp(value.source, value.flags);

  const copy = Array.isArray(value) ? [] : {};
  seen.set(value, copy);
  if (Array.isArray(value)) copy.length = value.length;
  for (const key of Reflect.ownKeys(value)) {
    // Array length is a non-configurable intrinsic and cannot be redefined.
    if (Array.isArray(value) && key === 'length') continue;
    // Define data properties instead of assigning __proto__, so untrusted parsed
    // content cannot change the detached report object's prototype.
    Object.defineProperty(copy, key, {
      value: cloneValue(value[key], seen),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return copy;
}

function freezeValue(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  // Object.freeze throws for typed arrays with elements. Parsed content is JSON-like,
  // but keep this helper safe for an invalid record that happens to contain one.
  if (!ArrayBuffer.isView(value) || value instanceof DataView) {
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) freezeValue(value[key], seen);
    Object.freeze(value);
  }
  return value;
}

function text(value) {
  try {
    return String(value == null ? '' : value).trim();
  } catch (_error) {
    return '';
  }
}

function addReason(reasons, reason) {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function hasFillAnswer(record) {
  // A multi-blank answer is complete only when every position has at least one
  // accepted answer. The export validator intentionally has a weaker schema
  // check (any accepted answer), so answer truth stays a separate signal here.
  return Array.isArray(record?.blanks)
    && record.blanks.length > 0
    && record.blanks.every((answers) => Array.isArray(answers)
      && answers.some((answer) => typeof answer === 'string' && answer.trim()));
}

function isDenseArray(value) {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return false;
  }
  return true;
}

function answerShapeReasons(record, kind) {
  const reasons = [];
  const invalid = (condition) => { if (condition) addReason(reasons, 'invalid_answer_shape'); };

  if (kind === 'choice') {
    invalid(!isDenseArray(record.choices));
    if (isDenseArray(record.choices)) {
      for (const choice of record.choices) {
        invalid(!choice || typeof choice !== 'object' || Array.isArray(choice)
          || typeof choice.text !== 'string'
          || typeof choice.isCorrect !== 'boolean');
      }
    }
  } else if (kind === 'fill') {
    invalid(!isDenseArray(record.blanks));
    if (isDenseArray(record.blanks)) {
      for (const answers of record.blanks) {
        invalid(!isDenseArray(answers));
        if (isDenseArray(answers)) {
          for (const answer of answers) invalid(typeof answer !== 'string');
        }
      }
    }
  } else if (kind === 'matching') {
    invalid(!isDenseArray(record.pairs));
    if (isDenseArray(record.pairs)) {
      for (const pair of record.pairs) {
        invalid(!pair || typeof pair !== 'object' || Array.isArray(pair)
          || typeof pair.left !== 'string'
          || typeof pair.right !== 'string');
      }
    }
  }
  return reasons;
}

function choiceAnswerState(record) {
  if (!Array.isArray(record?.choices)) return 'missing';
  const count = record.choices.reduce((n, choice) => n + (choice?.isCorrect ? 1 : 0), 0);
  if (!record.isMulti && count > 1) return 'ambiguous';
  return count > 0 ? 'explicit' : 'missing';
}

function matchingAnswerState(record) {
  if (!Array.isArray(record?.pairs) || !record.pairs.length) return 'missing';
  return record.pairs.every((pair) => text(pair?.right)) ? 'explicit' : 'missing';
}

function answerEvidence(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { status: 'not_applicable', source: null, flags: [] };
  }

  const source = text(record.answerSource).toLowerCase() || null;
  const flags = [];
  if (record.answerConflict === true || source === 'conflict') flags.push('conflict');
  if (record.answerDerivedFromScore === true || source === 'score') flags.push('score_inferred');
  if (record.answerDerivedFromCanvasCorrectBlock === true || source === 'canvas-correct-block') {
    flags.push('fallback');
  }

  let status = 'not_applicable';
  const kind = text(record.kind).toLowerCase()
    || (Array.isArray(record.choices) ? 'choice' : '');
  if (kind === 'choice') status = choiceAnswerState(record);
  else if (kind === 'fill') status = hasFillAnswer(record) ? 'explicit' : 'missing';
  else if (kind === 'matching') status = matchingAnswerState(record);
  else if (kind === 'essay' || kind === 'unknown') status = 'not_applicable';

  if (flags.includes('conflict')) status = 'conflict';
  else if (flags.includes('score_inferred')) status = 'score_inferred';
  else if (flags.includes('fallback') && status === 'explicit') status = 'fallback';
  if (status === 'ambiguous') flags.push('ambiguous');

  return { status, source, flags };
}

function imageIsMissing(record) {
  const expected = Number(record?.expectedImageCount);
  const current = [
    ...(Array.isArray(record?.images) ? record.images : []),
    ...(Array.isArray(record?.uploadedImages) ? record.uploadedImages : []),
  ].filter(Boolean).length;
  // A stale source URL is evidence, not proof that the current record still
  // lacks an image. If the expected image count is now satisfied by data/uploaded
  // images, a previous missingImageSources list no longer creates a review flag.
  if (Number.isFinite(expected) && expected >= 0) return current < expected;
  return Number(record?.missingImageCount) > 0
    || (Array.isArray(record?.missingImageSources) && record.missingImageSources.length > 0);
}

function exportReasonCode(reason) {
  const value = text(reason);
  if (/正确答案|可接受答案|answer/i.test(value)) return 'missing_answer';
  if (/题干为空|question.*empty|prompt/i.test(value)) return 'missing_prompt';
  if (/选项不足|choices/i.test(value)) return 'insufficient_choices';
  if (/缺少 id|missing id/i.test(value)) return 'missing_id';
  if (/未知题型|unknown/i.test(value)) return 'invalid_export_shape';
  if (/合法的题目对象|valid.*object/i.test(value)) return 'invalid_record';
  return 'export_schema_invalid';
}

function sourceMetadata(record, sourceId, index) {
  const read = (key, fallback = null) => {
    try {
      return record && typeof record === 'object' && !Array.isArray(record)
        ? (record[key] ?? fallback) : fallback;
    } catch (_error) {
      return fallback;
    }
  };
  return {
    sourceId,
    index,
    // num/source/domId are evidence for this import only. None is promoted to a
    // durable learning identity; the key below is deterministic only in this session.
    displayNumber: read('num'),
    sourceLabel: read('source', read('sourceLabel')),
    sourceNum: read('sourceNum'),
    importedSource: read('importedSource'),
    importedId: read('importedId'),
    idSuffix: read('idSuffix'),
    domId: read('domId'),
  };
}

function reviewKey(sourceId, index) {
  return `review:${encodeURIComponent(sourceId)}:record:${index}`;
}

function classifyRecord(raw, index, options, inputReadError = null) {
  let original;
  let cloneError = inputReadError ? (text(inputReadError) || 'input read failed') : null;
  if (!cloneError) {
    try {
      original = cloneValue(raw);
    } catch (error) {
      cloneError = text(error?.message) || 'record snapshot failed';
    }
  }
  if (cloneError) {
    // Preserve a bounded diagnostic entry for the offending input instead of
    // allowing one hostile getter/cyclic exotic value to abort the whole batch.
    original = { reviewSnapshotError: cloneError };
  }
  const reasons = [];
  const exportReasons = [];
  let candidateRecords = [];
  let validatorReasons = [];
  let exportStatus = 'not_applicable';
  let invalidInput = !raw || typeof raw !== 'object' || Array.isArray(raw) || !!cloneError;
  let evidence;
  try {
    evidence = answerEvidence(original);
  } catch (error) {
    evidence = { status: 'not_applicable', source: null, flags: [] };
    cloneError = cloneError || text(error?.message) || 'answer evidence failed';
    invalidInput = true;
  }

  if (invalidInput) addReason(reasons, 'invalid_record');
  if (cloneError) addReason(reasons, 'record_snapshot_failed');

  const sourceRecord = original;
  const kind = !invalidInput
    ? (text(sourceRecord.kind).toLowerCase() || (Array.isArray(sourceRecord.choices) ? 'choice' : null))
    : null;
  if (kind === 'essay' || kind === 'unknown') addReason(reasons, 'unsupported_kind');
  for (const reason of answerShapeReasons(sourceRecord, kind)) addReason(reasons, reason);
  if (reasons.includes('invalid_answer_shape')) addReason(reasons, 'invalid_record');
  if (!invalidInput && imageIsMissing(sourceRecord)) addReason(reasons, 'missing_image');
  if (evidence.status === 'missing') addReason(reasons, 'missing_answer');
  if (evidence.flags.includes('score_inferred')) addReason(reasons, 'answer_inferred_from_score');
  if (evidence.flags.includes('conflict')) addReason(reasons, 'answer_conflict');
  if (evidence.flags.includes('fallback')) addReason(reasons, 'answer_from_fallback_source');
  if (evidence.flags.includes('ambiguous')) addReason(reasons, 'multiple_correct_answers');

  if (!invalidInput && !reasons.includes('invalid_answer_shape') && kind !== 'essay' && kind !== 'unknown') {
    try {
      // buildQuestionBank currently normalizes choice shape in place. Always pass a
      // detached clone so the caller's parsed records remain byte-for-byte unchanged.
      candidateRecords = buildQuestionBank(
        [cloneValue(sourceRecord)],
        options.exportPrefix,
        options.sourcePrefix,
      );
      if (candidateRecords.length === 0) {
        exportStatus = 'invalid';
        addReason(exportReasons, 'no_export_record');
      } else {
        const checked = validateQuestionBankRecords(candidateRecords);
        validatorReasons = checked.rejected.flatMap((entry) => entry.reasons || []);
        if (checked.rejected.length) {
          exportStatus = 'invalid';
          for (const reason of validatorReasons) addReason(exportReasons, exportReasonCode(reason));
        } else {
          exportStatus = 'valid';
        }
      }
    } catch (error) {
      exportStatus = 'invalid';
      addReason(exportReasons, 'export_schema_invalid');
      validatorReasons = [text(error?.message) || 'export projection failed'];
    }
  }

  for (const reason of exportReasons) addReason(reasons, reason);

  let disposition = 'valid';
  if (invalidInput || reasons.includes('unsupported_kind') || reasons.includes('invalid_answer_shape')) {
    disposition = 'rejected';
  } else if (exportStatus === 'invalid' && exportReasons.some((reason) => !['missing_answer', 'no_export_record'].includes(reason))) {
    disposition = 'rejected';
  } else if (reasons.length) {
    // Missing answer/image and uncertain answer provenance are review work, even
    // when the export validator also says the answer is not yet publishable.
    disposition = 'review';
  }

  return {
    key: reviewKey(options.sourceId, index),
    index,
    source: sourceMetadata(sourceRecord, options.sourceId, index),
    disposition,
    reasons: Object.freeze([...reasons]),
    answerEvidence: Object.freeze({
      status: evidence.status,
      source: evidence.source,
      flags: Object.freeze([...(evidence.flags || [])]),
    }),
    exportability: Object.freeze({
      status: exportStatus,
      candidateCount: candidateRecords.length,
      reasons: Object.freeze([...exportReasons]),
      validatorReasons: Object.freeze([...validatorReasons]),
    }),
    // `record` is a detached snapshot. It is not a durable identity or a mutable
    // editor model; D2 may create a separate revision after human confirmation.
    record: original,
  };
}

/**
 * Classify one parser session without persistence, networking, AI acceptance, or
 * deduplication. `options.sourceId` is required because the index-based key is
 * stable only within this explicit source/session scope.
 */
export function buildReviewReport(parsed, options = {}) {
  const sourceId = text(options.sourceId);
  if (!sourceId) throw new TypeError('buildReviewReport requires an explicit options.sourceId');

  const input = Array.isArray(parsed) ? parsed : [parsed];
  const resolved = {
    sourceId,
    sourcePrefix: text(options.sourcePrefix) || sourceId,
    exportPrefix: text(options.exportPrefix) || `review-${sourceId}`,
  };
  // Array#map skips sparse holes. Array.from makes every source position an
  // explicit invalid entry, preserving the conservation invariant.
  const records = Array.from({ length: input.length }, (_, index) => {
    try {
      return classifyRecord(input[index], index, resolved);
    } catch (error) {
      // Reading an accessor-backed array slot can itself throw. Keep that slot
      // represented and let the normal per-record rejection path explain it.
      return classifyRecord(undefined, index, resolved, error?.message || 'input read failed');
    }
  });
  const summary = records.reduce((counts, entry) => {
    counts[entry.disposition] += 1;
    counts.total += 1;
    return counts;
  }, { total: 0, valid: 0, review: 0, rejected: 0 });

  return freezeValue({
    schemaVersion: 1,
    sourceId,
    records,
    summary,
  });
}

export { DISPOSITIONS };
