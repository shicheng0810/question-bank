import {safeNativeConversionInventory,safeNativeConversionResult} from '../../do-worker/src/native-conversion-dto.js';
const safeError=v=>typeof v==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(v)?v:'MIGRATION_PREFLIGHT_UNAVAILABLE';
export async function readManagerMigrationPreflight(query,user,withOperator){
 const binding={principal:user.sub,incarnation:query.get('incarnation'),fence:Number(query.get('fence')),generation:query.get('generation')};
 if(user.accountKind!=='native'||user.accountPhase!=='active'||binding.incarnation!==user.incarnation||binding.fence!==user.fence||binding.generation!==user.nativeStats?.generation||query.has('mode')||query.has('apply'))throw Error('STALE_OR_INVALID_PREFLIGHT');
 const result={ok:true,status:'unknown',binding,inventory:null,plan:null,reason:null,applyEnabled:false,retirement:{status:'blocked',sourceDeleted:false,observedSealedManifest:null,required:['sealed source manifest and current owner/generation/fence','complete native export/checkpoint digest','independent verified recovery receipt digest','per-record native receipts and exact old-copy scope','reviewed retirement RPC (not account deletion)']}};
 const kind=query.get('conversionKind'),recordId=query.get('recordId');if((kind||recordId)&&(!['history','bank'].includes(kind)||!recordId||new TextEncoder().encode(recordId).length>64))throw Error('INVALID_PREFLIGHT_RECORD');
 return withOperator(async call=>{
  const raw=await call('inspectNativeConversionInventory',{principal:user.sub});
  if(raw?.ok===false){result.reason=safeError(raw.error);return result;}
  const inventory=safeNativeConversionInventory(raw);if(!inventory||inventory.principal!==binding.principal||inventory.incarnation!==binding.incarnation||inventory.authorityFence!==binding.fence||inventory.generation!==binding.generation)throw Error('STALE_PREFLIGHT_INVENTORY');
  result.inventory=inventory;result.retirement.observedSealedManifest=inventory.manifestSha256;result.status='inventory-verified';
  if(recordId){const rows=kind==='history'?inventory.histories:inventory.banks;if(!rows.some(r=>r.recordId===recordId))throw Error('PREFLIGHT_RECORD_NOT_OBSERVED');
   const command={principal:binding.principal,incarnation:binding.incarnation,generation:binding.generation,authorityFence:binding.fence,manifestSha256:inventory.manifestSha256,recordId,mode:'plan'};
   const planned=await call(kind==='history'?'convertNativeHistory':'convertNativeBank',command);
   if(planned?.ok===false){result.reason=safeError(planned.error);result.status='plan-unavailable';return result;}
   const safe=safeNativeConversionResult(planned,kind);if(!safe||safe.status!=='planned')throw Error('PREFLIGHT_RESULT_INVALID');result.plan={kind,recordId,...safe};result.status='planned';
  }
  // Re-read immutable source/owner boundary after await. Never claim preflight
  // grants apply/retirement permission or a persisted confirmation ticket.
  const after=safeNativeConversionInventory(await call('inspectNativeConversionInventory',{principal:user.sub}));if(!after||JSON.stringify(after)!==JSON.stringify(inventory))throw Error('STALE_PREFLIGHT_INVENTORY');return result;
 });
}
