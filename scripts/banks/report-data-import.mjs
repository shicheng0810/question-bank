import {execFileSync} from 'node:child_process';
import {lstat,realpath,readdir,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const extension='do-worker/src/reviewed-report-public-registry.generated.js';
function relativeName(value){if(typeof value!=='string'||!value||value.includes('\\')||path.posix.isAbsolute(value)||value.split('/').some(p=>!p||p==='.'||p==='..'))throw Error('REPORT_PUBLICATION_PATH');return value;}
export async function inspectReportData(root){
 root=path.resolve(root);if((await lstat(root)).isSymbolicLink()||await realpath(root)!==root)throw Error('REPORT_PUBLICATION_SYMLINK');
 const files=[];
 async function visit(relative){relativeName(relative);const file=path.join(root,relative),stat=await lstat(file);if(stat.isSymbolicLink())throw Error('REPORT_PUBLICATION_SYMLINK');if(await realpath(file)!==file)throw Error('REPORT_PUBLICATION_PATH');if(stat.isDirectory()){for(const name of await readdir(file))await visit(relative+'/'+name);}else if(stat.isFile())files.push(relative);else throw Error('REPORT_PUBLICATION_FILE_TYPE');}
 for(const dir of ['production-inputs','content'])await visit(dir);
 await visit(extension);return files.sort();
}
export async function importReportData({trustedRoot,dataRoot,verified,requestPath,expectedCommit}){
 // Inspect BOTH trees completely before the first mutation; no follow-symlink copy.
 const trusted=await inspectReportData(trustedRoot),proposed=await inspectReportData(dataRoot);
 // The prior release base is immutable and approved. Only typed historical
 // correction assets from that exact validated base may enlarge the inventory.
 const gitBase=(...args)=>execFileSync('git',args,{cwd:dataRoot,encoding:'utf8',maxBuffer:100*1024*1024});
 const previous=[];
 if(verified.base&&/^[a-f0-9]{40}$/.test(verified.base))for(const entry of gitBase('ls-tree','-r','-z',verified.base,'content/report-requests','production-inputs').split('\0').filter(Boolean)){
  const m=entry.match(/^100644 blob [a-f0-9]{40}\t(.+)$/);if(!m)throw Error('REPORT_PUBLICATION_BASE_MODE');
  if(/^content\/report-requests\/[a-f0-9-]{36}\.json$/.test(m[1])||/^production-inputs\/(?:[\w.-]+\/)*[\w.-]+\.[a-f0-9]{64}\.registered\.json$/.test(m[1]))previous.push(m[1]);else if(m[1].startsWith('content/report-requests/'))throw Error('REPORT_PUBLICATION_BASE_CLOSURE');
 }
 const allowed=new Set([...trusted,...previous,...verified.files,relativeName(requestPath)]);
 for(const file of proposed)if(!allowed.has(file))throw Error('REPORT_PUBLICATION_DATA_CLOSURE');
 for(const file of trusted)if(!proposed.includes(file))throw Error('REPORT_PUBLICATION_DATA_MISSING');
 for(const file of verified.files)relativeName(file);
 const git=(...args)=>execFileSync('git',args,{cwd:dataRoot,maxBuffer:100*1024*1024});
 if(git('status','--porcelain','--untracked-files=all','--','production-inputs','content',extension).toString().trim())throw Error('REPORT_PUBLICATION_WORKTREE_DIRTY');
 if(git('rev-parse','HEAD').toString().trim()!==expectedCommit)throw Error('REPORT_PUBLICATION_HEAD');
 const admitted=proposed.map(file=>({file,bytes:git('show',expectedCommit+':'+file)}));
 // Copy immutable admitted Git blobs, never reread an attacker-mutated worktree.
 for(const {file,bytes} of admitted){const destination=path.join(trustedRoot,file);await mkdir(path.dirname(destination),{recursive:true});await writeFile(destination,bytes,{flag:'w'});}
 return proposed;
}
