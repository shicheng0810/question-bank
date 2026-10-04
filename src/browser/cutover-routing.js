const official='https://question-bank-78u.pages.dev';
const banks=new Set(['201-composite','205-finishes','211-sheet-metal','215-helicopter','231-fire-pos-warning','231-ice-rain','239-airframe-elec','general','all-banks']);
export function cutoverTarget(input){
 let u;try{u=new URL(input);}catch{return {action:'hold',reason:'INVALID_URL',target:official+'/'};}
 const hold=reason=>({action:'hold',reason,target:official+'/'});
 if(u.origin!=='https://shicheng0810.github.io'||u.username||u.password)return hold('SOURCE_ORIGIN');
 const match=u.pathname.match(/^\/(?:question-bank|question-bank-template)\/(index(?:\.html)?|local(?:\.html)?|player(?:\.html)?|format(?:\.html)?|format-ielts(?:\.html)?)?$/);
 if(!match)return hold('UNKNOWN_ROUTE');if(u.hash)return hold('FRAGMENT_REENTRY_REQUIRED');
 const name=(match[1]||'index').replace(/\.html$/,''),target=new URL(name==='index'?'/':'/'+name,official),seen=new Set();
 for(const [key,value]of u.searchParams){if(seen.has(key))return hold('DUPLICATE_QUERY');seen.add(key);
  if(key==='lang'&&['en','zh','es'].includes(value))target.searchParams.set(key,value);
  else if(key==='bank'&&name==='player'&&banks.has(value))target.searchParams.set(key,value);
  else if(key==='workbench'&&name==='local'&&['history','recovery'].includes(value))target.searchParams.set(key,value);
  else return hold('PRIVATE_OR_UNKNOWN_QUERY_REENTRY_REQUIRED');
 }
 return {action:'redirect',target:target.href,reason:'FIXED_PUBLIC_ROUTE'};
}
