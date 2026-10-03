import {legacyPublicMapJson} from './legacy-public-map.generated.js';
import {historicalPublicBanks} from './historical-public-dependencies.generated.js';
import {secondHistoricalPublicBank} from './historical-public-second.generated.js';
// Frozen source code, not env/caller URL/hash configuration.
const catalog=JSON.parse(legacyPublicMapJson);
const fail=code=>{throw Object.assign(new Error(code),{code});};
export function resolveLegacyPublicScope(original,activeBanks,historicalBanks){
 const slugs=Array.isArray(original.merged_banks)?original.merged_banks.map(row=>typeof row==='string'?row:row?.slug)
  :original.bank_id==='all-banks'?activeBanks.map(bank=>bank.slug):[original.bank_id];
 if(!slugs.length||slugs.some(s=>typeof s!=='string')||new Set(slugs).size!==slugs.length)fail('HISTORY_BANK_MISSING');
 const selected=slugs.map(slug=>{const b=activeBanks.find(b=>b.slug===slug);if(!b)fail('HISTORY_BANK_MISSING');return b;});
 const activeIds=new Set(selected.flatMap(b=>b.questions.map(q=>q.legacyId)));
 if(slugs.length===1){
  const candidates=[...selected,...historicalBanks.filter(b=>b.slug===slugs[0])].filter(b=>original.scope.every(id=>b.questions.some(q=>q.legacyId===id)));
  if(!candidates.length)fail('HISTORY_MAPPING_MISSING');
  const signature=b=>JSON.stringify(original.scope.map(id=>b.questions.filter(q=>q.legacyId===id).map(q=>q.semanticsDigest)));
  if(candidates.some(b=>signature(b)!==signature(candidates[0])))fail('HISTORY_MAPPING_AMBIGUOUS');
  selected.splice(0,selected.length,candidates[0]);
 }else{
  // Actual frozen catalog order only; old selected-bank merges kept the first
  // canonical runtime question. Never mix bank versions from different releases.
  const oldSix=['239-airframe-elec','205-finishes','215-helicopter','general','201-composite','211-sheet-metal'];
  const catalogs=[selected];
  if(original.bank_id==='all-banks'&&!Array.isArray(original.merged_banks))for(const prior of historicalBanks){
   const release=oldSix.map(slug=>slug===prior.slug?prior:activeBanks.find(b=>b.slug===slug));
   if(release.every(Boolean))catalogs.push(release);
  }
  const candidates=[];
  for(const release of catalogs){
   if(release.length>8)fail('HISTORY_MAPPING_AMBIGUOUS');
   const subsets=Array.isArray(original.merged_banks)?[release]:Array.from({length:(1<<release.length)-1},(_,n)=>release.filter((_,i)=>(n+1)&(1<<i)));
   for(const banks of subsets){const map=new Map();for(const b of banks)for(const q of b.questions)if(!map.has(q.legacyId))map.set(q.legacyId,q);
    if(original.scope.every(id=>map.has(id)))candidates.push({banks,signature:JSON.stringify(original.scope.map(id=>map.get(id).semanticsDigest))});
   }
  }
  if(!candidates.length)fail('HISTORY_MAPPING_MISSING');
  if(candidates.some(c=>c.signature!==candidates[0].signature))fail('HISTORY_MAPPING_AMBIGUOUS');
  selected.splice(0,selected.length,...candidates[0].banks);
 }
 const groups=new Map();
 for(const bank of selected)for(const q of bank.questions){const group=groups.get(q.legacyId)||[];group.push({...q,bankRevision:bank.revision});groups.set(q.legacyId,group);}
 const seen=new Set(),scope=[];
 for(const legacyQuestionId of original.scope){
  if(seen.has(legacyQuestionId))fail('HISTORY_MAPPING_AMBIGUOUS');seen.add(legacyQuestionId);
  const group=groups.get(legacyQuestionId);if(!group?.length)fail('HISTORY_MAPPING_MISSING');
  if(slugs.length===1&&group.some(q=>q.semanticsDigest!==group[0].semanticsDigest))fail('HISTORY_MAPPING_AMBIGUOUS');
  const first=group[0];scope.push({legacyQuestionId,questionKey:first.questionKey,questionRevision:first.questionRevision,
   equivalentSourceRefs:group.filter(q=>q.semanticsDigest===first.semanticsDigest).map(q=>({questionKey:q.questionKey,questionRevision:q.questionRevision,bankRevision:q.bankRevision})).sort((a,b)=>a.questionKey.localeCompare(b.questionKey))});
 }
 for(const[id,input]of Object.entries(original.state)){
  if(!input||typeof input!=='object'||Array.isArray(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input)))fail('HISTORY_INPUT_INVALID');
  if(!seen.has(id))fail('HISTORY_MAPPING_MISSING');const count=groups.get(id)[0].choiceCount;
  const valid=n=>Number.isSafeInteger(n)&&n>=0&&n<count;
  if(input.selectedIndex!=null&&!valid(input.selectedIndex)||input.selectedSet!==undefined&&(!Array.isArray(input.selectedSet)||input.selectedSet.some(n=>!valid(n))))fail('HISTORY_INPUT_INVALID');
 }
 return{scope,banks:selected.map(({slug,bankUid,revision,staticRef})=>({slug,bankUid,revision,staticRef}))};
}
export function frozenLegacyPublicScope(original){return resolveLegacyPublicScope(original,catalog.banks,[...historicalPublicBanks,secondHistoricalPublicBank]);}
