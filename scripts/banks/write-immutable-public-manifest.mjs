import {readFile,writeFile,realpath,lstat,rename,unlink} from 'node:fs/promises';
import path from 'node:path';
import {sha256Hex,canonicalContentBytes} from '../../src/domain/app-data/canonical.js';
import {validateBankContent} from '../../src/domain/question/bank-content.js';
// Exact reviewed registry paths only. No directory expansion or arbitrary copy.
export async function writeImmutablePublicManifest(manifest,outDirectory,{sourceRoot}){
 const out=await realpath(outDirectory),source=await realpath(sourceRoot),rows=[],seen=new Set();
 if((await lstat(outDirectory)).isSymbolicLink()||path.resolve(outDirectory)!==out||(await lstat(sourceRoot)).isSymbolicLink()||path.resolve(sourceRoot)!==source)throw Error('IMMUTABLE_PUBLIC_PATH');
 if(manifest.format!=='qb-site-registered-banks-v1'||manifest.schemaVersion!==1||!Array.isArray(manifest.banks)||manifest.retainedBanks!==undefined&&!Array.isArray(manifest.retainedBanks))throw Error('IMMUTABLE_PUBLIC_REGISTRY');
 for(const entry of [...manifest.banks,...(manifest.retainedBanks||[])]){
  const ref=entry.staticRef;if(typeof ref!=='string'||!/^banks\/v2\/[a-z0-9-]+\.[a-f0-9]{64}\.json$/.test(ref)||ref!==`banks/v2/${entry.slug}.${entry.revision}.json`||seen.has(ref))throw Error('IMMUTABLE_PUBLIC_PATH');seen.add(ref);
  if(typeof entry.contentFile!=='string'||!/^[-\w./]+\.json$/.test(entry.contentFile)||entry.contentFile.split('/').some(x=>!x||x==='.'||x==='..'))throw Error('IMMUTABLE_PUBLIC_PATH');
  const inputPath=path.join(source,entry.contentFile);if((await lstat(inputPath)).isSymbolicLink()||await realpath(inputPath)!==inputPath||path.relative(source,inputPath).startsWith('..'))throw Error('IMMUTABLE_PUBLIC_PATH');
  const input=new Uint8Array(await readFile(inputPath)),verified=await validateBankContent(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(input)));
  if(await sha256Hex(input)!==entry.sha256||verified.contentDigest!==entry.revision||verified.content.bankUid!==entry.bankUid||verified.content.metadata.visibility!=='public')throw Error('IMMUTABLE_PUBLIC_REGISTRY');
  const expectedLength=canonicalContentBytes(verified.content).byteLength;
  const file=await realpath(path.join(out,ref));if(path.relative(out,file)!==ref)throw Error('IMMUTABLE_PUBLIC_PATH');
  const bytes=new Uint8Array(await readFile(file)),sha256=await sha256Hex(bytes);if(sha256!==entry.revision||bytes.byteLength!==expectedLength)throw Error('IMMUTABLE_PUBLIC_DIGEST');rows.push({path:ref,sha256,totalBytes:bytes.byteLength});
 }
 const target=path.join(out,'immutable-public-assets.json');try{if(!(await lstat(target)).isFile()||await realpath(target)!==target)throw Error('IMMUTABLE_PUBLIC_PATH');}catch(e){if(e.code!=='ENOENT')throw e;}
 const temporary=path.join(out,'.immutable-public-assets-'+crypto.randomUUID()+'.tmp');
 try{await writeFile(temporary,JSON.stringify(rows,null,2)+'\n',{flag:'wx'});await rename(temporary,target);}finally{await unlink(temporary).catch(e=>{if(e.code!=='ENOENT')throw e;});}return rows;
}
