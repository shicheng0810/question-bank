import { readFile,writeFile,mkdir,realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalContentBytes,sha256Hex } from '../../src/domain/app-data/canonical.js';
import { validateBankContent } from '../../src/domain/question/bank-content.js';

/** Mandatory after current catalog build: receiver trust for old revisions is
 * useful only if these exact immutable assets are also in the deployment. */
export async function retainedReportArtifacts(manifest,readContent) {
  const artifacts=[];
  for(const entry of manifest.retainedBanks||[]){
    if(!/^[\w./-]+\.json$/.test(entry.contentFile) || entry.contentFile.split('/').some(part=>!part||part==='.'||part==='..') || entry.staticRef!==`banks/v2/${entry.slug}.${entry.revision}.json`)throw Error('REPORT_RETAINED_PATH_INVALID');
    const bytes=await readContent(entry.contentFile),verified=await validateBankContent(JSON.parse(new TextDecoder().decode(bytes)));
    if(verified.contentDigest!==entry.revision || verified.content.bankUid!==entry.bankUid || await sha256Hex(bytes)!==entry.sha256)throw Error('REPORT_RETAINED_DIGEST_INVALID');
    artifacts.push({path:entry.staticRef,bytes:canonicalContentBytes(verified.content)});
  }
  return artifacts;
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href){
  const [manifestFile,outDirectory]=process.argv.slice(2);if(!manifestFile||!outDirectory)throw Error('Usage: copy-retained-report-assets.mjs <manifest> <built-output-directory>');
  const manifest=JSON.parse(await readFile(manifestFile,'utf8')),root=await realpath(path.dirname(manifestFile));
  const artifacts=await retainedReportArtifacts(manifest,async file=>{const target=await realpath(path.join(root,file));if(path.relative(root,target).startsWith('..')||path.isAbsolute(path.relative(root,target)))throw Error('REPORT_RETAINED_SOURCE_OUTSIDE_ROOT');return new Uint8Array(await readFile(target));});
  const out=await realpath(outDirectory);await mkdir(path.join(out,'banks/v2'),{recursive:true});
  for(const artifact of artifacts)await writeFile(path.join(out,artifact.path),artifact.bytes);
  console.log(JSON.stringify({retainedAssets:artifacts.map(row=>row.path)}));
}
