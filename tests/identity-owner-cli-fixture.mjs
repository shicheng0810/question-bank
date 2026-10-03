// External child-process fixture for the concrete Wrangler CLI wiring. Synthetic
// metadata only; never reads an auth file or connects to any network.
import {readFile,writeFile} from 'node:fs/promises';
const args=process.argv.slice(2),target='defda68cdf274d2cad85b40066232daf';
const stateFile=new URL('../.identity-owner-runtime/local-fixture-metadata.json',import.meta.url);
const config=JSON.parse(await readFile(args[args.indexOf('--config')+1],'utf8'));
if(config.account_id!=='1cb5e6e63a6b3c3ea0ad9bb01dac30e9' || process.env.CI!=='true' || process.env.CLOUDFLARE_ACCOUNT_ID!==config.account_id)throw Error('fixture target');
if(args[0]==='whoami'){process.stdout.write(JSON.stringify({loggedIn:true,authType:'OAuth Token',accounts:[{id:config.account_id}],tokenPermissions:['workers_kv:write']}));}
else if(args.slice(0,3).join(' ')==='kv namespace list'){process.stdout.write(JSON.stringify([{id:target,title:'synthetic EDITS'}]));}
else if(args.slice(0,3).join(' ')==='kv key put'){
 if(args[args.indexOf('--namespace-id')+1]!==target || !args.includes('--remote') || !args.includes('--expiration'))throw Error('fixture scoped write');
 const seed=JSON.parse(await readFile(args[args.indexOf('--path')+1],'utf8'));
 if(args[3]!=='report-identity-seed:'+seed.challengeId || seed.chatId!=='configured-report-chat' || Object.keys(seed).length!==7 || args.includes('--ttl'))throw Error('fixture scoped seed');
 await writeFile(stateFile,JSON.stringify(seed));process.stdout.write('synthetic put output captured; no secret printed');
}else if(args.slice(0,3).join(' ')==='kv key get'){
 if(args[args.indexOf('--namespace-id')+1]!==target || !args.includes('--remote'))throw Error('fixture scoped read');
 process.stdout.write(await readFile(stateFile,'utf8'));
}else throw Error('fixture unknown command');
