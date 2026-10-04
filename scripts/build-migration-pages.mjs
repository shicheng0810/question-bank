import {mkdirSync,copyFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {buildSync} from 'esbuild';
export function buildMigrationPages({site,old=null}){
 mkdirSync(path.join(site,'browser'),{recursive:true});
 copyFileSync('migration-pages/migration.html',path.join(site,'migration.html'));
 for(const file of ['local-storage-migration.js','browser-migration-receipt.js'])copyFileSync(path.join('src/browser',file),path.join(site,'browser',file));
 const entries=[['src/browser/native-migration-target.js',path.join(site,'browser/native-migration-target.js')],['src/browser/native-archive-readback.js',path.join(site,'browser/native-archive-readback.js')]];
 if(old){mkdirSync(old,{recursive:true});copyFileSync('migration-pages/old-origin.html',path.join(old,'index.html'));copyFileSync('src/browser/local-storage-migration.js',path.join(old,'local-storage-migration.js'));entries.push(['src/browser/old-origin-cutover.js',path.join(old,'old-origin-cutover.js')],['src/browser/old-origin-native-export.js',path.join(old,'old-origin-native-export.js')]);}
 for(const [entry,outfile]of entries)buildSync({entryPoints:[entry],bundle:true,format:'esm',outfile,metafile:false});
 return ['migration.html','browser/local-storage-migration.js','browser/browser-migration-receipt.js','browser/native-migration-target.js','browser/native-archive-readback.js'];
}
if(import.meta.url===pathToFileURL(process.argv[1]||'').href)buildMigrationPages({site:process.env.PAGES_OUT||'site',old:process.env.OLD_ORIGIN_OUT||'old-origin-candidate'});
