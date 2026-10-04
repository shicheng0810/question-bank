import { sha256 } from '@noble/hashes/sha2.js';
import { validAdminItemsCommand, safeAdminItemsResult } from './native-admin-items-dto.js';
const fail = code => { throw Object.assign(new Error(code),{code}); };
const bytes = value => new TextEncoder().encode(JSON.stringify(value));
const digest = value => Array.from(sha256(bytes(value)),b=>b.toString(16).padStart(2,'0')).join('');
const rows = (sql,statement,...args) => Array.from(sql.exec(statement,...args));
const encode = value => btoa(String.fromCharCode(...bytes(value))).replace(/=/g,'').replace(/\+/g,'-').replace(/\//g,'_');
const decode = value => JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0))));
function readAttemptDiagnostic(sql,row){
    // Only scalar allowlisted metadata; never load resume content, answers or mutation payloads.
    const resumes=rows(sql,`SELECT revision,server_seq,digest FROM gen06_entities
      WHERE kind='resume_state' AND entity_key=?`,row.entity_key);
    const resume=resumes[0];
    let receiptCount=0;
    if(resume) receiptCount=rows(sql,`SELECT COUNT(*) AS n FROM gen06_mutation_receipts
      WHERE digest=? AND json_extract(receipt_json,'$.payloadDigest')=?
      AND json_extract(receipt_json,'$.status')='accepted'
      AND json_extract(receipt_json,'$.serverSeq')=?
      AND json_extract(receipt_json,'$.currentRevision')=?
      AND json_extract(receipt_json,'$.mutationId')=mutation_id
      AND json_extract(mutation_json,'$.kind')='resume_state'
      AND json_extract(mutation_json,'$.entityKey')=?
      AND json_extract(mutation_json,'$.payloadDigest')=?`,resume.digest,resume.digest,resume.server_seq,resume.revision,row.entity_key,resume.digest)[0]?.n;
    const confirmed=!!resume && resumes.length===1 && receiptCount===1;
    return {resumePayloadDigest:resume?.digest??null,resumeRevision:resume?.revision??null,serverConfirmedCut:confirmed?resume.server_seq:null,
      receiptType:confirmed?'accepted':null,receiptUpdatedAt:null,
      resumeStatus:confirmed?'receipt_verified':'unknown',
      unknownReason:confirmed?'DEVICE_PENDING_AND_RECEIPT_TIME_UNAVAILABLE':!resume?'NO_CLOUD_RESUME':'CURRENT_RESUME_RECEIPT_UNVERIFIED'};
  }

// Synchronous metadata-only observation; no payload is selected or returned.
// Fingerprint covers row metadata/digests and tombstones, including a deletion
// even if a malformed writer failed to advance highWater. No saved snapshot.
export function readNativeAdminItems(sql, command, generation) {
  if (!validAdminItemsCommand(command)) fail('INVALID_INPUT');
  if (generation!==command.expectedGeneration) fail('STALE_GENERATION');
  const meta=rows(sql,'SELECT generation,log_epoch,high_water FROM gen06_sync_meta WHERE id=1');
  if(meta.length!==1 || meta[0].generation!==generation) fail('ADMIN_ITEMS_UNAVAILABLE');
  const kind=command.kind==='private_bank'?'bank_revision':command.kind==='attempt_diagnostics'?'attempt_manifest':command.kind;
  if(command.kind==='private_bank' && rows(sql, `SELECT entity_key FROM gen06_entities WHERE kind='bank_revision'
    AND (json_extract(payload_json,'$.metadata.visibility') IS NULL OR json_extract(payload_json,'$.metadata.visibility') NOT IN ('public','private','protected')) LIMIT 1`).length) fail('ADMIN_ITEMS_UNAVAILABLE');
  const all=rows(sql,`SELECT entity_key,revision,server_seq,digest FROM gen06_entities e WHERE kind=?
    ${command.kind==='private_bank'?"AND json_extract(payload_json,'$.metadata.visibility')='private'":''}
    AND NOT EXISTS(SELECT 1 FROM gen06_entity_tombstones t WHERE t.entity_key=e.entity_key AND t.generation=?)
    ORDER BY entity_key COLLATE BINARY LIMIT 100001`,kind,generation);
  const tombstones=rows(sql,'SELECT entity_key FROM gen06_entity_tombstones WHERE generation=? ORDER BY entity_key COLLATE BINARY LIMIT 100001',generation);
  if(all.length>100000 || tombstones.length>100000) fail('ADMIN_ITEMS_LIMIT');
  const watermark={highWater:meta[0].high_water,logEpoch:meta[0].log_epoch,digest:digest([all,tombstones])};
  const scope={principal:command.principal,incarnation:command.incarnation,fence:command.expectedFence,generation,kind:command.kind,order:'entity-key-binary-v1',watermark};
  let after='';
  if(command.cursor){let cursor;try{cursor=decode(command.cursor);}catch{fail('INVALID_ADMIN_CURSOR');}
    if(!cursor || typeof cursor.after!=='string' || JSON.stringify({...cursor,after:undefined})!==JSON.stringify(scope)) fail('CURSOR_STALE');
    after=cursor.after;
    if(!all.some(row=>row.entity_key===after))fail('CURSOR_STALE');
  }
  const remaining=all.filter(row=>row.entity_key>after);
  const result={ok:true,status:'verified',principal:command.principal,incarnation:command.incarnation,fence:command.expectedFence,generation,kind:command.kind,watermark,items:[],nextCursor:null};
  for(const row of remaining.slice(0,command.limit)){
    // Only page candidates reach SQL diagnostics; bounds and cursor validation
    // precede every resume/receipt query. A byte-rejected candidate is retained
    // for the next cursor page, not skipped.
    const item={id:row.entity_key,revision:row.revision,serverSeq:row.server_seq,...(command.kind==='attempt_diagnostics'?{diagnostic:readAttemptDiagnostic(sql,row)}:{})};
    const trial={...result,items:[...result.items,item],nextCursor:encode({...scope,after:item.id})};
    if(bytes(trial).length>8192){if(!result.items.length)fail('ADMIN_ITEM_TOO_LARGE');break;}
    result.items.push(item);
  }
  if(result.items.length<remaining.length)result.nextCursor=encode({...scope,after:result.items.at(-1).id});
  const safe=safeAdminItemsResult(result,command);if(!safe)fail('ADMIN_ITEMS_UNAVAILABLE');return safe;
}
