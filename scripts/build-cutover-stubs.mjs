import {mkdirSync,copyFileSync} from 'node:fs';
import path from 'node:path';
// Run build-migration-pages.mjs first. No repository push or bank deletion.
for(const repo of ['question-bank','question-bank-template']){
 const out=path.resolve(process.env.CUTOVER_OUT||'fusion-cutover-candidate',repo);mkdirSync(out,{recursive:true});
 for(const name of ['index.html','local.html','player.html','format.html','format-ielts.html'])copyFileSync('migration-pages/cutover-stub.html',path.join(out,name));
 for(const name of ['local-storage-migration.js','old-origin-cutover.js','old-origin-native-export.js'])copyFileSync(path.join('old-origin-candidate',name),path.join(out,name));
}
