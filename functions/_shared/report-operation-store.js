import { DurableObject } from 'cloudflare:workers';
import { frozenPublicBanks } from '../../src/domain/question/frozen-public-registry.js';
import { ReportLedger } from './native-report.js';

export class ReportOperationStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ledger = new ReportLedger(ctx.storage);
  }
  assertId(id) {if(!this.env.REPORT_OPERATIONS?.idFromName(id).equals(this.ctx.id))throw new Error('REPORT_OPERATION_BINDING_INVALID');}
  capability() {return {schema:1,banks:frozenPublicBanks.map(bank=>({bankUid:bank.bankUid,revision:bank.revision,questions:bank.questionsrefs}))};}
  receive(pending) { this.assertId(pending.operationId);return this.ledger.receive(pending); }
  get(id) { this.assertId(id);return this.ledger.get(id); }
  transitionBound(id,from,to,result,expectedResult){this.assertId(id);return this.ledger.transition(id,from,to,result,expectedResult);}
  transition(id, from, to, result) { this.assertId(id);return this.ledger.transition(id, from, to, result); }
}
