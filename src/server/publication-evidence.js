import {readFileSync,statSync,realpathSync,existsSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const unknown = reason => ({status:'unknown',reason});
const MAX = 32 * 1024 * 1024;
function boundedFile(root, relative) {
  const base=realpathSync(root), file=realpathSync(path.resolve(root,relative));
  if(!file.startsWith(base+path.sep))throw new Error('EVIDENCE_PATH_REJECTED');
  const stat=statSync(file);if(!stat.isFile() || stat.size>MAX)throw new Error('EVIDENCE_FILE_LIMIT');
  const bytes=readFileSync(file);if(bytes.length>MAX)throw new Error('EVIDENCE_FILE_LIMIT');return bytes;
}
export function readPublicationManifest(root, relative='public/banks/index.json') {
  const manifest=JSON.parse(boundedFile(root,relative).toString('utf8'));
  if(!Array.isArray(manifest) || manifest.length>10000 || manifest.some(entry=>!entry || typeof entry.id!=='string'
    || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(entry.id) || !['public','protected'].includes(entry.mode)
    || !Number.isSafeInteger(entry.question_count) || entry.question_count<0) || new Set(manifest.map(e=>e.id)).size!==manifest.length) throw new Error('EVIDENCE_MANIFEST_INVALID');
  return manifest;
}
function relativeBank(entry) {
  const relative=entry.mode==='protected'?entry.payload:entry.json;
  if(relative!==`banks/${entry.id}.${entry.mode==='protected'?'qbpack':'json'}`)throw new Error('EVIDENCE_BANK_PATH_INVALID');
  return relative;
}
export function readRecordedSitePublication(root) {
  try {
    const value=JSON.parse(boundedFile(root,'rollout/ui-deploy-receipt.json').toString('utf8'));
    if(value.exit!==0 || typeof value.completedAt!=='string' || !Number.isFinite(Date.parse(value.completedAt))
      || typeof value.deploymentURL!=='string' || !/^https:\/\/[a-f0-9]{8}\.question-bank-78u\.pages\.dev$/.test(value.deploymentURL)
      || !/^[a-f0-9]{64}$/.test(value.indexSHA256) || !/^[a-f0-9]{64}$/.test(value.dispatcherSHA256)
      || typeof value.needsReadback!=='boolean') return unknown('Existing deployment receipt shape invalid');
    return {status:'recorded',source:'rollout/ui-deploy-receipt.json',scope:'site-deployment-receipt',completedAt:value.completedAt,
      deploymentURL:value.deploymentURL,indexSha256:value.indexSHA256,dispatcherSha256:value.dispatcherSHA256,
      publisherNeedsReadback:value.needsReadback,currentProductionPointer:'unknown',bankBinding:'unknown'};
  }catch{return unknown('No readable existing site deployment receipt');}
}
// Observation proves file state now, not who saved it or a historical action.
// Build match proves bank artifact + player exist; not a successful whole-site build/deploy.
export function readBankPublicationEvidence({root,id}) {
  if(typeof id!=='string' || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(id))throw new Error('INVALID_BANK_ID');
  const entry=readPublicationManifest(root).find(entry=>entry.id===id);if(!entry)throw new Error('BANK_NOT_OBSERVED');
  const result={schemaVersion:1,id,scope:'local-publication-files',mode:entry.mode,
    sitePublication:readRecordedSitePublication(root),
    localSave:unknown('Local artifact not verified'),build:unknown('No matching local docs build artifact'),
    preview:unknown('No preview deployment receipt'),publication:unknown('No verified Cloudflare publication receipt bound to this artifact'),
    onlineReadback:unknown('No online readback digest bound to this artifact; no network request performed'),
    syncReceipt:unknown('Account mutation receipt requires owner/generation-bound private read; highWater is not a receipt'),
    report:unknown('Global Report read channel available by operationID; no verified mapping from this local bank to a Report operation/revision')};
  let relative,sourceDigest;
  try{relative=relativeBank(entry);const bytes=boundedFile(root,'public/'+relative);sourceDigest=hash(bytes);
    if(entry.mode==='public'){
      const parsed=JSON.parse(bytes.toString('utf8'));if(!Array.isArray(parsed) || parsed.length!==entry.question_count)throw new Error('EVIDENCE_COUNT_MISMATCH');
    }
    result.localSave={status:'verified',source:'current-local-file-readback',sha256:sourceDigest,questionCount:entry.question_count,
      contentValidation:entry.mode==='public'?'array-count-verified':'ciphertext-only-no-decryption',includedInLocalBuild:entry.deploy!==false};
  }catch(error){result.localSave=unknown(error.message);return result;}
  const buildRoot=path.join(root,'docs');
  try{
    if(!existsSync(buildRoot))return result;
    const built=readPublicationManifest(root,'docs/banks/index.json').find(item=>item.id===id);
    if(!built)throw new Error('BANK_NOT_IN_BUILD');
    if(relativeBank(built)!==relative || built.mode!==entry.mode || built.question_count!==entry.question_count)throw new Error('BUILD_MANIFEST_MISMATCH');
    const builtDigest=hash(boundedFile(root,'docs/'+relative));const playerDigest=hash(boundedFile(root,'docs/player.html'));
    result.build=builtDigest===sourceDigest?{status:'artifact-match',source:'current-local-docs-readback',sha256:builtDigest,playerSha256:playerDigest,
      wholeSiteBuild:'unknown'}:{status:'stale',reason:'Build bank bytes differ from current saved bank',sha256:builtDigest};
  }catch(error){result.build=unknown(error.message);}
  return result;
}

// A failed evidence observation must not relabel an already completed save as failed.
export function observeSavedPublicationEvidence(options) {
  try { return readBankPublicationEvidence(options); }
  catch { return {schemaVersion:1,id:options.id,scope:'local-publication-files',
    ...Object.fromEntries(['localSave','build','preview','publication','onlineReadback','syncReceipt','report'].map(key=>[key,unknown('Evidence read failed after local save; save action result is separate')]))}; }
}
