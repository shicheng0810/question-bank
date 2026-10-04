import {validGeneration} from './generation-transition.js';
export const ACCOUNT_TOKEN_PATTERN=/^(?:v2\.[A-Za-z0-9_-]{43}|v3\.[0-9a-f]{64}\.[A-Za-z0-9_-]{43})$/;
export const SESSION_V3_FLAG='GEN05_SESSION_V3_LOCAL';
export function v3Route(token){return typeof token==='string'&&/^v3\.[0-9a-f]{64}\.[A-Za-z0-9_-]{43}$/.test(token)?token.slice(3,67):null;}
export async function sessionV3Hash(token){if(!v3Route(token))throw Error('INVALID_CREDENTIALS');const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('qb-session-v3\0'+token)));return Array.from(bytes,v=>v.toString(16).padStart(2,'0')).join('');}
const TABLE='gen05_session_hashes';
export function createSessionV3Repository(sql){
  const rows=(q,...a)=>Array.from(sql.exec(q,...a));
  const exists=()=>rows("SELECT name FROM sqlite_master WHERE type='table' AND name=?",TABLE).length===1;
  const inspect=()=>{
    const columns=rows(`PRAGMA table_info(${TABLE})`);
    if(columns.length!==3||columns.map(row=>row.name).sort().join()!=='expires_at,generation,token_hash'
      ||columns.some(row=>row.type!==(row.name==='expires_at'?'INTEGER':'TEXT')||row.pk!==(row.name==='token_hash'?1:0)||row.notnull!==(row.name==='token_hash'?0:1)))throw Error('INVALID_SESSION_SCHEMA');
  };
  const valid=row=>{if(!row||Object.keys(row).sort().join()!=='expires_at,generation,token_hash'||!/^[0-9a-f]{64}$/.test(row.token_hash)||!validGeneration(row.generation)||!Number.isSafeInteger(row.expires_at)||row.expires_at<1)throw Error('INVALID_SESSION_SCHEMA');return row;};
  return Object.freeze({
    issue(row){valid(row);sql.exec(`CREATE TABLE IF NOT EXISTS ${TABLE}(token_hash TEXT PRIMARY KEY,generation TEXT NOT NULL,expires_at INTEGER NOT NULL)`);inspect();sql.exec(`CREATE INDEX IF NOT EXISTS gen05_session_expiry ON ${TABLE}(expires_at,token_hash)`);sql.exec(`INSERT INTO ${TABLE}(token_hash,generation,expires_at) VALUES(?,?,?)`,row.token_hash,row.generation,row.expires_at);},
    read(hash){if(!/^[0-9a-f]{64}$/.test(hash))throw Error('INVALID_CREDENTIALS');if(!exists())return null;inspect();const found=rows(`SELECT token_hash,generation,expires_at FROM ${TABLE} WHERE token_hash=?`,hash);return found.length?valid(found[0]):null;},
    clear(){if(exists()){inspect();sql.exec(`DELETE FROM ${TABLE}`);}},
    gc(now){if(!Number.isSafeInteger(now)||now<1)throw Error('INVALID_INPUT');if(!exists())return;inspect();sql.exec(`DELETE FROM ${TABLE} WHERE token_hash IN (SELECT token_hash FROM ${TABLE} WHERE expires_at<=? ORDER BY expires_at,token_hash LIMIT 100)`,now);},
    nextDue(){if(!exists())return null;inspect();const row=rows(`SELECT MIN(expires_at) AS due FROM ${TABLE}`)[0];return row?.due??null;}
  });
}
