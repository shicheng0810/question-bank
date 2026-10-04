import { canonicalContentBytes, sha256Hex } from '../../src/domain/app-data/canonical.js';
import { validateBankContent } from '../../src/domain/question/bank-content.js';
import { finalizeRegisteredQuestions } from '../../src/domain/question/registered-identity.js';
import { isUuid } from '../../src/domain/question/index.js';

import { frozenPublicBanks } from '../../src/domain/question/frozen-public-registry.js';
import trustedReportSources from '../../content/report-sources.json' with { type: 'json' };

const digest = /^[a-f0-9]{64}$/;
export const reportError = code => Object.assign(new Error(code), { code });
export function validateReport(body, sources) {
  if (!body || body.schema_version !== 2 || !isUuid(body.operationId) || !isUuid(body.bankUid) || !isUuid(body.questionUid)
      || body.questionKey !== `${body.bankUid}/${body.questionUid}` || !digest.test(body.revision) || !digest.test(body.questionRevision)) throw reportError('REPORT_IDENTITY_INVALID');
  const source = sources.find(row => row.bankUid === body.bankUid);
  // Visibility is decided by the trusted server mapping, never by the browser.
  if (!source || source.visibility !== 'public') throw reportError('REPORT_PUBLIC_SOURCE_REQUIRED');
  if (source.revision !== body.revision) throw reportError('REPORT_REVISION_CONFLICT');
  if(source.questionRefs && !source.questionRefs.some(row=>row.questionKey===body.questionKey && row.questionRevision===body.questionRevision))throw reportError('REPORT_QUESTION_CONFLICT');
  if (!body.corrected || typeof body.corrected.question !== 'string' || !body.corrected.question.trim() || body.corrected.question.length > 2000) throw reportError('REPORT_CORRECTION_INVALID');
  if (Object.keys(body.corrected).some(key => !['question', 'choices', 'answer', 'answers'].includes(key))) throw reportError('REPORT_CORRECTION_INVALID');
  if (body.corrected.choices && (!Array.isArray(body.corrected.choices) || body.corrected.choices.length < 2 || body.corrected.choices.length > 50 || body.corrected.choices.some(value => typeof value !== 'string' || !value.trim() || value.length > 600))) throw reportError('REPORT_CORRECTION_INVALID');
  if (Object.hasOwn(body.corrected, 'answer') && Object.hasOwn(body.corrected, 'answers')) throw reportError('REPORT_CORRECTION_INVALID');
  if (body.corrected.choices) {
    const answers = Object.hasOwn(body.corrected, 'answer') ? [body.corrected.answer] : body.corrected.answers;
    if (!Array.isArray(answers) || !answers.length || new Set(answers).size !== answers.length || answers.some(index => !Number.isInteger(index) || index < 0 || index >= body.corrected.choices.length)) throw reportError('REPORT_CORRECTION_INVALID');
  } else if (Object.hasOwn(body.corrected, 'answer') || Object.hasOwn(body.corrected, 'answers')) throw reportError('REPORT_CORRECTION_INVALID');
  if (typeof body.note !== 'string' || body.note.length > 2000) throw reportError('REPORT_NOTE_INVALID');
  return { operationId: body.operationId, bankUid: body.bankUid, revision: body.revision, questionUid: body.questionUid, questionKey: body.questionKey, questionRevision: body.questionRevision, corrected: structuredClone(body.corrected), note: body.note, question_index: Number.isInteger(body.question_index) ? body.question_index : null };
}

export function reportSources(env) {
  let sources;
  try { sources = JSON.parse(env.REPORT_SOURCES_JSON || JSON.stringify(trustedReportSources)); } catch { throw reportError('REPORT_SOURCE_CONFIGURATION_INVALID'); }
  const safePath=path=>typeof path==='string' && /^[\w./-]+\.json$/.test(path) && !path.startsWith('/') && !path.split('/').some(part=>part==='..'||part==='.'||!part);
  if (!Array.isArray(sources) || sources.some(row => !isUuid(row.bankUid) || !digest.test(row.revision) || row.visibility !== 'public' || !safePath(row.sourcePath) || !safePath(row.manifestPath) || !safePath(row.registryPath)) || new Set(sources.map(row => row.bankUid)).size !== sources.length) throw reportError('REPORT_SOURCE_CONFIGURATION_INVALID');
  return env.REPORT_SOURCES_JSON ? sources : sources.map(source=>{const trusted=frozenPublicBanks.find(bank=>bank.bankUid===source.bankUid && bank.revision===source.revision);if(!trusted)throw reportError('REPORT_SOURCE_CONFIGURATION_INVALID');return {...source,questionRefs:trusted.questionsrefs};});
}

export async function applyNativeCorrection(content, pending) {
  const verified = await validateBankContent(content);
  if (verified.content.bankUid !== pending.bankUid || verified.contentDigest !== pending.revision) throw reportError('REPORT_REVISION_CONFLICT');
  const matches = verified.content.questions.filter(question => question.questionKey === pending.questionKey && question.questionUid === pending.questionUid);
  if (matches.length !== 1 || matches[0].questionRevision !== pending.questionRevision) throw reportError('REPORT_QUESTION_CONFLICT');
  const before = matches[0], changed = { ...before, ...pending.corrected };
  if (Object.hasOwn(pending.corrected, 'answer')) delete changed.answers;
  if (Object.hasOwn(pending.corrected, 'answers')) delete changed.answer;
  // question_html can contain the previous stem; remove it when plain text changes.
  if (changed.question !== before.question) delete changed.question_html;
  const [after] = await finalizeRegisteredQuestions([changed]);
  if (after.questionRevision === before.questionRevision) throw reportError('REPORT_NO_CONTENT_CHANGE');
  const next = { ...verified.content, questions: verified.content.questions.map(question => question.questionKey === pending.questionKey ? after : question) };
  const result = await validateBankContent(next);
  return { before, after, content: result.content, revision: result.contentDigest, bytes: canonicalContentBytes(result.content) };
}

// One SQLite Durable Object per operation. Conditional UPDATE supplies ownership;
// KV remains an optional archive and must never claim an approval.
export class ReportLedger {
  constructor(storage) {
    this.storage = storage;
    storage.sql.exec("CREATE TABLE IF NOT EXISTS report_release_head (singleton INTEGER PRIMARY KEY CHECK(singleton=1),value TEXT NOT NULL)");
    storage.sql.exec("CREATE TABLE IF NOT EXISTS report_operation (operation_id TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL,result TEXT,updated_at INTEGER NOT NULL)");
  }
  releaseHead(bootstrap) {
    // One-time reviewed bootstrap only, never a moving/latest reference.
    if(bootstrap){if(!/^[a-f0-9]{40}$/.test(bootstrap.commit)||!['pagesDeploymentId','workerVersionId','workerDeploymentId'].every(k=>/^[a-f0-9-]{36}$/.test(bootstrap[k]||'')))throw reportError('REPORT_RELEASE_BOOTSTRAP_INVALID');
      this.storage.sql.exec('INSERT OR IGNORE INTO report_release_head(singleton,value) VALUES(1,?)',JSON.stringify({...bootstrap,generation:0,inflight:null}));}
    const row=this.storage.sql.exec('SELECT value FROM report_release_head WHERE singleton=1').toArray()[0];
    return row?JSON.parse(row.value):null;
  }
  releaseCAS(expected,next) {
    return this.storage.sql.exec('UPDATE report_release_head SET value=? WHERE singleton=1 AND value=? RETURNING singleton',JSON.stringify(next),JSON.stringify(expected)).toArray().length===1;
  }
  async receive(pending) {
    const payload = JSON.stringify(pending), hash = await sha256Hex(canonicalContentBytes(pending));
    this.storage.sql.exec("INSERT OR IGNORE INTO report_operation (operation_id,payload_hash,payload,state,updated_at) VALUES (?,?,?,'received',?)", pending.operationId, hash, payload, Date.now());
    const row = await this.get(pending.operationId);
    if (!row || row.payload_hash !== hash) throw reportError('REPORT_OPERATION_CONFLICT');
    return row;
  }
  get(id) { return this.storage.sql.exec('SELECT * FROM report_operation WHERE operation_id = ?',id).toArray()[0] || null; }
  updateBound(id,state,result,expectedResult){
    return this.storage.sql.exec('UPDATE report_operation SET result=?,updated_at=? WHERE operation_id=? AND state=? AND result IS ? RETURNING operation_id',JSON.stringify(result),Date.now(),id,state,expectedResult).toArray().length===1;
  }
  async transition(id, from, to, result = null, expectedResult = undefined) {
    const allowed={received:['delivering'],delivering:['pending_approval','delivery_unknown'],pending_approval:['creating_pr'],creating_pr:['pr_created','conflict','provider_unknown'],provider_unknown:['reconciling'],reconciling:['pr_created','conflict','provider_unknown'],pr_created:['awaiting_deployment'],awaiting_deployment:['published','deployment_unknown','readback_failed','receipt_pending','readback_pending'],readback_pending:['readback_failed','receipt_pending','reconciling_readback'],readback_failed:['reconciling_readback'],reconciling_readback:['readback_pending'],receipt_pending:['sending_receipt','reconciling_receipt'],reconciling_receipt:['receipt_pending'],sending_receipt:['receipt_pending','published','receipt_unknown']};
    if(!allowed[from]?.includes(to))throw reportError('REPORT_TRANSITION_INVALID');
    if(to==='published' && (!result || !digest.test(result.revision) || !digest.test(result.questionRevision) || !/^[a-f0-9]{40}$/.test(result.sourceCommit) || result.operationId!==id || !Number.isSafeInteger(result.prNumber) || result.prNumber<1 || !/^[a-f0-9]{40}$/.test(result.resultCommit) || result.contentHash!==result.revision || typeof result.domain!=='string' || !/^[a-z0-9.-]+$/.test(result.domain) || typeof result.deploymentId!=='string' || !result.deploymentId || result.readbackVerified!==true))throw reportError('REPORT_PUBLICATION_RECEIPT_REQUIRED');
    const values=[to,result ? JSON.stringify(result) : null,Date.now(),id,from];
    let query='UPDATE report_operation SET state=?,result=?,updated_at=? WHERE operation_id=? AND state=?';
    if(expectedResult!==undefined){query+=' AND result IS ?';values.push(expectedResult);}
    const rows=this.storage.sql.exec(query+' RETURNING operation_id',...values).toArray();
    return rows.length === 1;
  }
}
