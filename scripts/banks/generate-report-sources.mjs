import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { frozenPublicBanks } from '../../src/domain/question/frozen-public-registry.js';
import { validateBankContent } from '../../src/domain/question/bank-content.js';
const manifest=JSON.parse(await readFile('production-inputs/registered-banks.json','utf8')),sources=[];
await mkdir('content',{recursive:true});
for(const entry of manifest.banks){
 const sourcePath='production-inputs/'+entry.contentFile,content=JSON.parse(await readFile(sourcePath,'utf8')),verified=await validateBankContent(content);
 const trusted=frozenPublicBanks.find(row=>row.bankUid===entry.bankUid&&row.revision===entry.revision);
 if(!trusted||trusted.metadata.visibility!=='public'||verified.contentDigest!==entry.revision)throw Error('REPORT_TRUSTED_SOURCE_INVALID');
 const registryPath=`content/${entry.bankUid}.questions.json`;
 await writeFile(registryPath,JSON.stringify({questions:trusted.questionsrefs}));
 sources.push({bankUid:entry.bankUid,revision:entry.revision,visibility:'public',sourcePath,manifestPath:'production-inputs/registered-banks.json',registryPath});
}
await writeFile('content/report-sources.json',JSON.stringify(sources));
