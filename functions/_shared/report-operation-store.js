import {projectReportStatus} from '../../src/server/report-status-projection.js';
import { DurableObject } from 'cloudflare:workers';
import { frozenPublicBanks } from '../../src/domain/question/frozen-public-registry.js';
import {RELEASE_HEAD} from './report-release-contract.js';
import { ReportLedger } from './native-report.js';
import {IDENTITY_PREFIX, IdentityChallengeLedger} from './report-identity-challenge.js';

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
  async identityChallenge(id,command,input){
    if(!/^[a-f0-9]{32}$/.test(id))throw Error('IDENTITY_ID_INVALID');
    this.assertId(IDENTITY_PREFIX+id);
    const ledger=new IdentityChallengeLedger(this.ctx.storage);
    const result=ledger.execute(id,command,input);
    if(command==='prepare' && result.state==='prepared')await this.ctx.storage.setAlarm(result.expiresAt);
    return result;
  }
  alarm(){
    // Only challenge instances schedule this alarm; normal Report data is untouched.
    const sql=this.ctx.storage.sql;
    const tables=[...sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='report_identity_challenge'")];
    if(tables.length)for(const row of sql.exec('SELECT id FROM report_identity_challenge')){
      if(this.env.REPORT_OPERATIONS.idFromName(IDENTITY_PREFIX+row.id).equals(this.ctx.id))new IdentityChallengeLedger(this.ctx.storage).erase(row.id);
    }
  }
  // Challenge instances must not be usable as ordinary Report or release objects.
}
