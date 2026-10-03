const hex=x=>typeof x==='string'&&/^[0-9a-f]{64}$/.test(x);
const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[48][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(x);
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&[Object.prototype,null].includes(Object.getPrototypeOf(x))&&Reflect.ownKeys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k)&&'value'in Object.getOwnPropertyDescriptor(x,k));
const id=x=>typeof x==='string'&&x.length>0&&new TextEncoder().encode(x).length<=64;
export function safeNativeConversionInventory(value){
 const keys=['ok','status','principal','incarnation','authorityFence','manifestSha256','generation','histories','banks'];
 if(!exact(value,keys)||value.ok!==true||value.status!=='sealed-inventory'||!hex(value.principal)||!hex(value.incarnation)||value.principal===value.incarnation||!uuid(value.generation)||!Number.isSafeInteger(value.authorityFence)||value.authorityFence<0||!hex(value.manifestSha256))return null;
 for(const [name,rowKeys]of[['histories',['recordId','sourceDigest']],['banks',['recordId','sourceDigest','metaDigest']]]){
  const list=value[name];if(!Array.isArray(list)||Object.getPrototypeOf(list)!==Array.prototype||list.length>15||Reflect.ownKeys(list).length!==list.length+1||new Set(list.map(r=>r?.recordId)).size!==list.length)return null;
  if(list.some(row=>!exact(row,rowKeys)||!id(row.recordId)||!hex(row.sourceDigest)||name==='banks'&&!hex(row.metaDigest)))return null;
 }
 return structuredClone(value);
}
export function validNativeConversionCommand(value){return exact(value,['principal','incarnation','generation','authorityFence','manifestSha256','recordId','mode'])&&hex(value.principal)&&hex(value.incarnation)&&value.principal!==value.incarnation&&uuid(value.generation)&&Number.isSafeInteger(value.authorityFence)&&value.authorityFence>=0&&hex(value.manifestSha256)&&id(value.recordId)&&['plan','execute'].includes(value.mode);}
export function safeNativeConversionResult(value,kind){const field=kind==='bank'?'bankUid':'snapshotId';return exact(value,['ok','status',field,'contentDigest','sourceDeleted'])&&value.ok===true&&['planned','accepted','duplicate','already-accepted'].includes(value.status)&&uuid(value[field])&&hex(value.contentDigest)&&value.sourceDeleted===false?structuredClone(value):null;}
