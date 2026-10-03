// Private authority SQL journal. session_key contains a bearer secret: never
// serialize this repository in RPC, logs, exports, diagnostics or receipts.
import {validGeneration} from './generation-transition.js';
const TABLE='gen05_session_issuance';
const fail=()=>{throw Object.assign(new Error('SESSION_JOURNAL_INVALID'),{code:'UNAVAILABLE'});};
const fields=['session_key','incarnation','generation','fence','expires_at','status'];
function validate(row){
  if(!row||Object.keys(row).sort().join()!==fields.slice().sort().join()
    ||!/^g3:session:v2\.[A-Za-z0-9_-]{43}$/.test(row.session_key)
    ||! /^[0-9a-f]{64}$/.test(row.incarnation)||!validGeneration(row.generation)
    ||!Number.isSafeInteger(row.fence)||row.fence<0||!Number.isSafeInteger(row.expires_at)||row.expires_at<1
    ||!['put_pending','issued','unknown_debt'].includes(row.status))fail();
  return row;
}
export function createSessionIssuanceJournal(storage){
  if(typeof storage?.transactionSync!=='function'||typeof storage.sql?.exec!=='function')fail();
  const rows=(query,...args)=>Array.from(storage.sql.exec(query,...args));
  const exists=()=>rows("SELECT name FROM sqlite_master WHERE type='table' AND name=?",TABLE).length===1;
  const expiryIndex=()=>storage.sql.exec(`CREATE INDEX IF NOT EXISTS gen05_session_issuance_expiry ON ${TABLE}(status,expires_at,session_key)`);
  const get=key=>{if(!exists())return null;const found=rows(`SELECT ${fields.join(',')} FROM ${TABLE} WHERE session_key=?`,key);if(found.length>1)fail();return found.length?validate(found[0]):null;};
  function reserve(input){
    const row=validate({...input,status:'put_pending'});
    return storage.transactionSync(()=>{
      storage.sql.exec(`CREATE TABLE IF NOT EXISTS ${TABLE}(session_key TEXT PRIMARY KEY,incarnation TEXT NOT NULL,generation TEXT NOT NULL,fence INTEGER NOT NULL,expires_at INTEGER NOT NULL,status TEXT NOT NULL)`);
      storage.sql.exec(`CREATE INDEX IF NOT EXISTS gen05_session_issuance_owner ON ${TABLE}(incarnation,session_key)`);
      storage.sql.exec(`CREATE INDEX IF NOT EXISTS gen05_session_issuance_issued_owner ON ${TABLE}(incarnation,status,session_key)`);
      expiryIndex();
      if(get(row.session_key))fail();
      storage.sql.exec(`INSERT INTO ${TABLE}(${fields.join(',')}) VALUES(?,?,?,?,?,?)`,...fields.map(key=>row[key]));
      return row;
    });
  }
  function settle(row,status){
    validate(row);if(!['issued','unknown_debt'].includes(status))fail();
    return storage.transactionSync(()=>{
      const current=get(row.session_key);
      if(!current||fields.some(key=>current[key]!==row[key]))fail();
      storage.sql.exec(`UPDATE ${TABLE} SET status=? WHERE session_key=?`,status,row.session_key);
      return {...row,status};
    });
  }
  function remove(row){
    validate(row);if(row.status!=='issued')fail();
    return storage.transactionSync(()=>{
      const current=get(row.session_key);if(!current)return;
      if(fields.some(key=>current[key]!==row[key]))fail();
      storage.sql.exec(`DELETE FROM ${TABLE} WHERE session_key=?`,row.session_key);
    });
  }
  function page(incarnation){
    if(!/^[0-9a-f]{64}$/.test(incarnation))fail();if(!exists())return [];
    return rows(`SELECT ${fields.join(',')} FROM ${TABLE} WHERE incarnation=? ORDER BY session_key LIMIT 100`,incarnation).map(validate);
  }
  function expiredPage(now){if(!Number.isSafeInteger(now)||now<1)fail();if(!exists())return [];expiryIndex();return rows(`SELECT ${fields.join(',')} FROM ${TABLE} WHERE status='issued' AND expires_at<=? ORDER BY expires_at,session_key LIMIT 10`,now).map(validate);}
  function issuedPage(incarnation){if(!/^[0-9a-f]{64}$/.test(incarnation))fail();if(!exists())return [];storage.sql.exec(`CREATE INDEX IF NOT EXISTS gen05_session_issuance_issued_owner ON ${TABLE}(incarnation,status,session_key)`);return rows(`SELECT ${fields.join(',')} FROM ${TABLE} WHERE incarnation=? AND status='issued' ORDER BY session_key LIMIT 10`,incarnation).map(validate);}
  function nextDue(){if(!exists())return null;expiryIndex();return rows(`SELECT MIN(expires_at) AS due FROM ${TABLE} WHERE status='issued'`)[0]?.due??null;}
  return Object.freeze({reserve,settle,remove,page,issuedPage,expiredPage,nextDue});
}
