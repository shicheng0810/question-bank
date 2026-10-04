import { applyNativeCorrection, reportError } from '../../functions/_shared/native-report.js';
import { canonicalContentBytes, sha256Hex } from '../../src/domain/app-data/canonical.js';
import { encodeContent } from '../../src/domain/attempt/commands.js';
import { loadAccountPublicRegistry } from '../../do-worker/src/account-public-registry.js';

// Run in controlled Node/CI, never inside the Pages request CPU/memory budget.
export async function correctionFiles(content,manifest,registry,pending,source,receiverEntries,extensions={entries:[],snapshots:[]},baselineBanks=receiverEntries) {
  const changed=await applyNativeCorrection(content,pending);
  const entries=manifest.banks.filter(row=>row.bankUid===pending.bankUid && row.revision===pending.revision);
  if(entries.length!==1)throw reportError('REPORT_MANIFEST_CONFLICT');
  const previous=entries[0], filename=`${previous.slug}.${changed.revision}.registered.json`;
  const directory=source.sourcePath.slice(0,source.sourcePath.lastIndexOf('/')+1);
  const entry={...previous,revision:changed.revision,contentFile:previous.contentFile.slice(0,previous.contentFile.lastIndexOf('/')+1)+filename,sha256:await sha256Hex(changed.bytes),staticRef:`banks/v2/${previous.slug}.${changed.revision}.json`};
  const refs=registry.questions.filter(row=>row.questionKey===pending.questionKey && row.questionRevision===pending.questionRevision);
  if(refs.length!==1)throw reportError('REPORT_REGISTRY_CONFLICT');
  const nextRegistry={...registry,questions:registry.questions.map(row=>row===refs[0]?{...row,questionRevision:changed.after.questionRevision}:row)};
  const retained=[...(manifest.retainedBanks||[])];
  if(!retained.some(row=>row.bankUid===previous.bankUid&&row.revision===previous.revision))retained.push(previous);
  const files=[{path:directory+filename,content:new TextDecoder().decode(changed.bytes)},{path:source.manifestPath,content:new TextDecoder().decode(canonicalContentBytes({...manifest,banks:manifest.banks.map(row=>row===previous?entry:row),retainedBanks:retained}))},{path:source.registryPath,content:new TextDecoder().decode(canonicalContentBytes(nextRegistry))}];
  if(receiverEntries){
    const old=receiverEntries.filter(row=>row.bankUid===pending.bankUid&&row.revision===pending.revision);
    if(old.length!==1)throw reportError('REPORT_RECEIVER_REGISTRY_CONFLICT');
    const encoded=await encodeContent(changed.content);
    const next={bankUid:pending.bankUid,revision:changed.revision,metadata:changed.content.metadata,contentManifest:{kind:'public_static',staticRef:entry.staticRef,contentDigest:changed.revision},publicContentReference:encoded.reference,questionsrefs:changed.content.questions.map(q=>({questionKey:q.questionKey,questionRevision:q.questionRevision}))};
    // Keep all previously accepted revisions in the receiver trust snapshot.
    const baseline=baselineBanks||receiverEntries;
    const combined=[...baseline,...extensions.entries,next],json=JSON.stringify(combined);
    loadAccountPublicRegistry({GEN06_LOCAL_FIXTURE:'1',GEN06_PUBLIC_REGISTRY_JSON:json});
    const projection=combined.map(bank=>({key:`${bank.bankUid}:${bank.revision}`,record:{bankUid:bank.bankUid,revision:bank.revision,metadata:bank.metadata,contentManifest:bank.contentManifest},reference:bank.publicContentReference})).sort((a,b)=>a.key.localeCompare(b.key));
    const snapshot={version:`report-${pending.operationId}`,digest:await sha256Hex(canonicalContentBytes(projection)),banks:combined};
    const snapshots=[...extensions.snapshots,snapshot];
    files.push({path:'do-worker/src/reviewed-report-public-registry.generated.js',content:`// Generated only by exact approved Report transformation; preserves every accepted projection.\nexport const reviewedReportPublicRegistry = ${JSON.stringify([...extensions.entries,next])};\nexport const reviewedReportPublicRegistrySnapshots = ${JSON.stringify(snapshots)};\n`});
  }
  return {revision:changed.revision,files};
}
