import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { produceCorrection,parseReportExtension } from './apply-native-report-request.mjs';
import { reportSources,reportError } from '../../functions/_shared/native-report.js';

export async function validateReportPR({root,base,head,operationId,sourcesFile,stage='generated',baselineBanks}) {
  if(!/^[a-f0-9]{40}$/.test(base)||!/^[a-f0-9]{40}$/.test(head)||!/^[a-f0-9-]{36}$/.test(operationId))throw reportError('REPORT_CI_IDENTITY_INVALID');
  const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',maxBuffer:80*1024*1024});
  const read=(commit,file)=>git('show',`${commit}:${file}`);
  const requestPath=`content/report-requests/${operationId}.json`,request=JSON.parse(read(head,requestPath));
  if(request.baseCommit!==base || request.pending.operationId!==operationId)throw reportError('REPORT_CI_BASE_CONFLICT');
  const sources=reportSources({REPORT_SOURCES_JSON:read(base,sourcesFile)});
  const packet=await produceCorrection(request,sources,async(commit,file)=>{const text=read(commit,file);if(file==='do-worker/src/reviewed-report-public-registry.generated.js')return parseReportExtension(text);if(file.endsWith('.generated.js')){const match=text.match(/publicRegistryJson = ("(?:[^"\\]|\\.)*");/);if(!match)throw reportError('REPORT_RECEIVER_REGISTRY_INVALID');return JSON.parse(JSON.parse(match[1]));}return JSON.parse(text);},sourcesFile,baselineBanks);
  const changed=git('diff','--name-only',base,head).trim().split('\n').filter(Boolean).sort();
  const expected=[requestPath,...(stage==='request'?[]:packet.files.map(file=>file.path))].sort();
  if(JSON.stringify(changed)!==JSON.stringify(expected))throw reportError('REPORT_CI_FILE_CLOSURE_INVALID');
  if(stage!=='request')for(const file of packet.files)if(read(head,file.path)!==file.content)throw reportError('REPORT_CI_OUTPUT_MISMATCH');
  return {operationId,base,head,revision:packet.revision,files:packet.files.map(file=>file.path),siteManifest:packet.files[1].path,stage};
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href){const [base,head,operationId,sourcesFile,stage]=process.argv.slice(2);console.log(JSON.stringify(await validateReportPR({root:process.cwd(),base,head,operationId,sourcesFile,stage})));}
