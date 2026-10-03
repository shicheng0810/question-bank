import {projectReportStatus} from '../../src/server/report-status-projection.js';
import { DurableObject } from 'cloudflare:workers';
import { frozenPublicBanks } from '../../src/domain/question/frozen-public-registry.js';
import {RELEASE_HEAD} from './report-release-contract.js';
import { ReportLedger } from './native-report.js';

export class ReportOperationStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ledger = new ReportLedger(ctx.storage);
  }
  assertId(id) {if(!this.env.REPORT_OPERATIONS?.idFromName(id).equals(this.ctx.id))throw new Error('REPORT_OPERATION_BINDING_INVALID');}
  assertHead(){this.assertId(RELEASE_HEAD);}
  releaseHead(){this.assertHead();let bootstrap;try{bootstrap=JSON.parse(this.env.REPORT_RELEASE_BOOTSTRAP_JSON||'null');}catch{throw Error('REPORT_RELEASE_BOOTSTRAP_INVALID');}return this.ledger.releaseHead(bootstrap);}
  releaseCAS(expected,next){this.assertHead();return this.ledger.releaseCAS(expected,next);}
  capability() {return {schema:1,banks:frozenPublicBanks.map(bank=>({bankUid:bank.bankUid,revision:bank.revision,questions:bank.questionsrefs}))};}
  receive(pending) { this.assertId(pending.operationId);return this.ledger.receive(pending); }
  inspectSummaryTrusted(id){this.assertId(id);const summary=projectReportStatus(this.ledger.get(id),id);if(new TextEncoder().encode(JSON.stringify(summary)).byteLength>16384)throw Error('REPORT_SUMMARY_LIMIT');return summary;}
  get(id) { this.assertId(id);return this.ledger.get(id); }
  updateBound(id,state,result,expectedResult){this.assertId(id);return this.ledger.updateBound(id,state,result,expectedResult);}
  transitionBound(id,from,to,result,expectedResult){this.assertId(id);return this.ledger.transition(id,from,to,result,expectedResult);}
  transition(id, from, to, result) { this.assertId(id);return this.ledger.transition(id, from, to, result); }
}
