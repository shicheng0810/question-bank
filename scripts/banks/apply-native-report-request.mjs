import { readFile, writeFile, open, realpath, lstat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertPublicRequest } from '../../functions/_shared/public-report-contract.js';
import { reportSources, validateReport, reportError } from '../../functions/_shared/native-report.js';
import { correctionFiles } from './report-correction-files.mjs';
import { frozenPublicRegistrySnapshots } from '../../src/domain/question/frozen-public-registry.js';

/** Trusted source configuration must come from the pinned base commit, never PR
 * request fields. CI runs this reviewed script from its protected source base. */
export async function produceCorrection(request,sources,readBase,sourcesFile='content/report-sources.json',baselineBanks=frozenPublicRegistrySnapshots.find(row=>row.version==='final10').banks) {
  assertPublicRequest(request);
  if(request?.format!=='qb-native-report-request-v1' || !/^[a-f0-9]{40}$/.test(request.baseCommit))throw reportError('REPORT_REQUEST_INVALID');
  const pending=validateReport({...request.pending,note:'',schema_version:2},sources);
  const source=sources.find(row=>row.bankUid===pending.bankUid);
  const [content,manifest,registry,receiver,extension]=await Promise.all([source.sourcePath,source.manifestPath,source.registryPath,'do-worker/src/account-public-registry.generated.js','do-worker/src/reviewed-report-public-registry.generated.js'].map(file=>readBase(request.baseCommit,file)));
  const approved=extension||{entries:[],snapshots:[]};
  if(![...baselineBanks,...approved.entries].some(row=>row.bankUid===pending.bankUid&&row.revision===pending.revision))throw reportError('REPORT_FROZEN_BASE_PROJECTION_CONFLICT');
  const packet=await correctionFiles(content,manifest,registry,pending,source,[...receiver,...approved.entries],approved,baselineBanks);
  // Roll the trusted current mapping forward together with the immutable bank.
  // Otherwise the next report would still validate against the old revision.
  packet.files.push({path:sourcesFile,content:JSON.stringify(sources.map(row=>row.bankUid===pending.bankUid?{...row,revision:packet.revision,sourcePath:packet.files[0].path}:row))});
  return packet;
}
export async function applyRequest({requestFile,sourcesFile,root,baselineBanks}) {
  root=await realpath(root);
  const request=JSON.parse(await readFile(requestFile,'utf8'));
  if(!/^[a-f0-9]{40}$/.test(request.baseCommit))throw reportError('REPORT_REQUEST_INVALID');
  const baseJSON=file=>{
    const text=execFileSync('git',['show',`${request.baseCommit}:${file}`],{cwd:root,maxBuffer:80*1024*1024,encoding:'utf8'});
    if(file==='do-worker/src/account-public-registry.generated.js'){
      const match=text.match(/export const publicRegistryJson = ("(?:[^"\\]|\\.)*");/);
      if(!match)throw reportError('REPORT_RECEIVER_REGISTRY_INVALID');return JSON.parse(JSON.parse(match[1]));
    }
    if(file==='do-worker/src/reviewed-report-public-registry.generated.js')return parseReportExtension(text);
    return JSON.parse(text);
  };
  const sources=reportSources({REPORT_SOURCES_JSON:JSON.stringify(baseJSON(sourcesFile))});
  const packet=await produceCorrection(request,sources,async(_commit,file)=>baseJSON(file),sourcesFile,baselineBanks);
  // Preflight all paths before any write; a malicious PR symlink must not
  // redirect generated output outside the reviewed checkout.
  for(const file of packet.files){const target=path.resolve(root,file.path),parent=path.dirname(target);if(await realpath(parent)!==parent)throw reportError('REPORT_OUTPUT_SYMLINK');try{if((await lstat(target)).isSymbolicLink())throw reportError('REPORT_OUTPUT_SYMLINK');}catch(error){if(error.code!=='ENOENT')throw error;}}
  for(let index=0;index<packet.files.length;index++) {
    const file=packet.files[index],target=path.resolve(root,file.path),relative=path.relative(root,target);
    if(relative.startsWith('..') || path.isAbsolute(relative))throw reportError('REPORT_OUTPUT_OUTSIDE_ROOT');
    if(index===0){const handle=await open(target,'wx');try{await handle.writeFile(file.content);}finally{await handle.close();}}
    else await writeFile(target,file.content);
  }
  return {operationId:request.pending.operationId,revision:packet.revision,files:packet.files.map(file=>file.path)};
}
export function parseReportExtension(text){const entries=text.match(/export const reviewedReportPublicRegistry = ([^\n]+);/),snapshots=text.match(/export const reviewedReportPublicRegistrySnapshots = ([^\n]+);/);if(!entries||!snapshots)throw reportError('REPORT_EXTENSION_INVALID');return {entries:JSON.parse(entries[1]),snapshots:JSON.parse(snapshots[1])};}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href){
  const [requestFile,sourcesFile]=process.argv.slice(2);if(!requestFile||!sourcesFile)throw Error('Usage: apply-native-report-request.mjs <reviewed-request.json> <base-commit source-config.json>');
  console.log(JSON.stringify(await applyRequest({requestFile,sourcesFile,root:process.cwd()})));
}
