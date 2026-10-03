import { mkdtemp,symlink,lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export async function verifyNativeReportSite({root,manifestPath}) {
  const trustedRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
  const dependencyPath=path.join(root,'node_modules');
  try{await lstat(dependencyPath);}catch(error){if(error.code!=='ENOENT')throw error;await symlink(path.join(trustedRoot,'node_modules'),dependencyPath,'dir');}
  const output=await mkdtemp(path.join(tmpdir(),'qb-report-site-'));
  execFileSync(process.execPath,[path.join(trustedRoot,'scripts/build-pages.mjs')],{cwd:root,env:{...process.env,QB_BUILD_ENV:'preview',QB_ACCOUNT_V2_UI:'1',QB_NATIVE_ONLY:'1',QB_NATIVE_HISTORY_SNAPSHOTS:'1',QB_V2_BANK_CONTENT_MANIFEST:path.resolve(root,manifestPath),PAGES_OUT:output},stdio:'pipe',maxBuffer:10*1024*1024});
  execFileSync(process.execPath,[path.join(trustedRoot,'scripts/banks/copy-retained-report-assets.mjs'),path.resolve(root,manifestPath),output],{cwd:root,stdio:'pipe',maxBuffer:1024*1024});
  return {siteBuildVerified:true,retainedAssetsVerified:true};
}
