// Private authority maintenance only. Never return secret
// rows, raw commands, tickets, intents, session keys or hashes to callers.
import {validateAuthority,createEmptyAuthority} from './account-incarnation.js';
const LEDGER='gen05_expired_secret_operations';
const HEX=/^[0-9a-f]{64}$/,UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail=code=>{throw Object.assign(new Error(code),{code});};
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function exact(value,keys){if(!value||Object.getPrototypeOf(value)!==Object.prototype||Reflect.ownKeys(value).length!==keys.length||keys.some(key=>{const d=Object.getOwnPropertyDescriptor(value,key);return !d||!d.enumerable||!Object.hasOwn(d,'value');}))fail('STORAGE_CORRUPT');return value;}
const integer=value=>Number.isSafeInteger(value)&&value>=0;
export function earliestAuthorityWake(dueTimes,now){
  if(!Array.isArray(dueTimes)||dueTimes.length>4||!integer(now))fail('INVALID_INPUT');
  const due=dueTimes.filter(value=>value!==null);if(due.some(value=>!integer(value)))fail('INVALID_INPUT');
  return due.length?Math.max(now+1,Math.min(...due)):null;
}
export function createAuthoritySecretRetention(ctx,env,{principal}){
  if(!HEX.test(principal)||!env?.ACCOUNT_AUTHORITY?.idFromName(principal)?.equals(ctx?.id)||typeof ctx?.storage?.transactionSync!=='function')fail('NOT_CONFIGURED');
  const storage=ctx.storage,sql=storage.sql;
  const rows=(q,...args)=>Array.from(sql.exec(q,...args),row=>({...row}));
  const exists=table=>rows("SELECT name FROM sqlite_master WHERE type='table' AND name=?",table).length===1;
  const expiryIndex=table=>sql.exec(`CREATE INDEX IF NOT EXISTS ${table}_expiry ON ${table}(expires_at,op_id)`);
  function state(){
    if(!exists('gen05_authority_state')){
      if(exists('gen05_authority_receipts'))fail('STORAGE_CORRUPT');
      return createEmptyAuthority(principal);
    }
    if(!exists('gen05_authority_receipts'))fail('STORAGE_CORRUPT');
    const found=rows('SELECT id,state_json FROM gen05_authority_state');
    if(found.length!==1||found[0].id!==1)fail('STORAGE_CORRUPT');
    const value=validateAuthority(JSON.parse(found[0].state_json));if(value.principal!==principal)fail('STORAGE_CORRUPT');return value;
  }
  function knownIncarnation(current,incarnation){return current.incarnation===incarnation||current.retired.includes(incarnation);}
  function marker(row,purpose,current){
    if(row.principal!==principal||!UUID.test(row.op_id)||!integer(row.expires_at))fail('STORAGE_CORRUPT');
    let fence,incarnation,terminal,generation=null;
    if(purpose==='registration-intent'){
      exact(row,['op_id','principal','intent','expected_fence','issued_at','expires_at','status','incarnation']);
      if(!/^ri1\.[0-9a-f]{64}$/.test(row.intent)||!integer(row.expected_fence)||!integer(row.issued_at)||row.expires_at-row.issued_at!==600000||row.expected_fence>current.fence)fail('STORAGE_CORRUPT');
      if(row.status==='pending'){if(row.incarnation!==null)fail('STORAGE_CORRUPT');terminal='expired-pending';}
      else if(row.status==='consumed'){
        if(!HEX.test(row.incarnation)||!knownIncarnation(current,row.incarnation))fail('STORAGE_CORRUPT');
        const receipt=rows('SELECT command_json,applied_fence FROM gen05_authority_receipts WHERE op_id=?',row.op_id);
        const expected=JSON.stringify({type:'create',opId:row.op_id,expectedFence:row.expected_fence});
        if(receipt.length!==1||receipt[0].command_json!==expected||receipt[0].applied_fence!==row.expected_fence+1)fail('STORAGE_CORRUPT');terminal='expired-consumed';
      }else fail('STORAGE_CORRUPT');
      fence=row.expected_fence;incarnation=row.incarnation;
    }else{
      exact(row,['ticket','principal','secret_hex','op_id','command_json','expires_at']);
      if(!HEX.test(row.secret_hex)||row.ticket!==`dt1.${principal}.${row.secret_hex}`)fail('STORAGE_CORRUPT');
      const command=exact(JSON.parse(row.command_json),['principal','incarnation','generation','expiresAt','fence','opId']);
      if(command.principal!==principal||command.opId!==row.op_id||!HEX.test(command.incarnation)||command.incarnation===principal||!UUID.test(command.generation)||!integer(command.expiresAt)||!integer(command.fence)||command.fence>current.fence||JSON.stringify(command)!==row.command_json||!knownIncarnation(current,command.incarnation))fail('STORAGE_CORRUPT');
      fence=command.fence;incarnation=command.incarnation;terminal='expired-ticket';
      generation=command.generation;
    }
    return {purpose,op_id:row.op_id,principal,original_fence:fence,incarnation,expires_at:row.expires_at,terminal,generation};
  }
  function putMarker(value){
    sql.exec(`CREATE TABLE IF NOT EXISTS ${LEDGER}(purpose TEXT NOT NULL,op_id TEXT NOT NULL,principal TEXT NOT NULL,original_fence INTEGER NOT NULL,incarnation TEXT,expires_at INTEGER NOT NULL,terminal TEXT NOT NULL,generation TEXT,PRIMARY KEY(purpose,op_id))`);
    const found=rows(`SELECT purpose,op_id,principal,original_fence,incarnation,expires_at,terminal,generation FROM ${LEDGER} WHERE purpose=? AND op_id=?`,value.purpose,value.op_id);
    if(found.length){if(found.length!==1||!equal(found[0],value))fail('STORAGE_CORRUPT');return;}
    sql.exec(`INSERT INTO ${LEDGER}(purpose,op_id,principal,original_fence,incarnation,expires_at,terminal,generation) VALUES(?,?,?,?,?,?,?,?)`,...Object.values(value));
  }
  function gc({purpose}){
    if(!['registration-intent','deletion-ticket'].includes(purpose))fail('INVALID_INPUT');
    return storage.transactionSync(()=>{
      const current=state(),now=Date.now(),table=purpose==='registration-intent'?'gen05_registration_intents':'gen05_deletion_tickets';
      if(!exists(table))return {removed:0,secretRowsReturned:false};
      expiryIndex(table);
      const keys=purpose==='registration-intent'?'op_id,principal,intent,expected_fence,issued_at,expires_at,status,incarnation':'ticket,principal,secret_hex,op_id,command_json,expires_at';
      const page=rows(`SELECT ${keys} FROM ${table} WHERE expires_at<=? ORDER BY expires_at,op_id LIMIT 100`,now);
      for(const row of page){
        putMarker(marker(row,purpose,current));
        // Original body/key CAS in the same real SQL transaction; no await.
        const fields=Object.keys(row);sql.exec(`DELETE FROM ${table} WHERE ${fields.map(key=>`${key} IS ?`).join(' AND ')}`,...fields.map(key=>row[key]));
        if(rows(`SELECT op_id FROM ${table} WHERE op_id=?`,row.op_id).length)fail('STORAGE_CORRUPT');
      }
      if(!equal(state(),current))fail('STALE_AUTHORITY');
      return {removed:page.length,secretRowsReturned:false};
    });
  }
  function assertOperationAvailable(purpose,opId,claim=null){
    if(!['registration-intent','deletion-ticket'].includes(purpose)||!UUID.test(opId))fail('INVALID_INPUT');
    const current=state();if(!exists(LEDGER))return;
    const found=rows(`SELECT purpose,op_id,principal,original_fence,incarnation,expires_at,terminal,generation FROM ${LEDGER} WHERE purpose=? AND op_id=?`,purpose,opId);
    if(found.length){
      if(found.length!==1)fail('STORAGE_CORRUPT');const row=exact(found[0],['purpose','op_id','principal','original_fence','incarnation','expires_at','terminal','generation']);
      if(row.principal!==principal||row.purpose!==purpose||row.op_id!==opId||!integer(row.original_fence)||row.original_fence>current.fence||!integer(row.expires_at)
        ||(purpose==='registration-intent'?!['expired-pending','expired-consumed'].includes(row.terminal):row.terminal!=='expired-ticket')
        ||(row.terminal==='expired-pending'?row.incarnation!==null:!HEX.test(row.incarnation)||!knownIncarnation(current,row.incarnation)))fail('STORAGE_CORRUPT');
      if(purpose==='registration-intent'?row.generation!==null:!UUID.test(row.generation))fail('STORAGE_CORRUPT');
      if(purpose==='deletion-ticket'&&claim){
        exact(claim,['principal','incarnation','generation','expiresAt','fence','opId']);
        if(claim.principal!==principal||claim.opId!==opId||claim.incarnation!==row.incarnation||claim.generation!==row.generation||claim.fence!==row.original_fence)fail('OPERATION_CONFLICT');
      }
      fail(purpose==='registration-intent'?'STALE_AUTHORITY':'INVALID_CREDENTIALS');
    }
  }
  function nextDue(purpose){const table=purpose==='registration-intent'?'gen05_registration_intents':purpose==='deletion-ticket'?'gen05_deletion_tickets':null;if(!table)fail('INVALID_INPUT');state();if(!exists(table))return null;expiryIndex(table);return rows(`SELECT MIN(expires_at) AS due FROM ${table}`)[0]?.due??null;}
  return Object.freeze({gc,assertOperationAvailable,nextDue});
}
