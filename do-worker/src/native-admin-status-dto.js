const keys=['ok','status','principal','incarnation','fence','generation','highWater','historySnapshotCount','attemptCount','activePrivateBankCount','tombstoneCount','coverageStatus'];
export function safeNativeAdminStatus(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Reflect.ownKeys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k)||!('value'in Object.getOwnPropertyDescriptor(value,k))))return null;
 if(value.ok!==true||!['verified','unknown'].includes(value.status)||![value.principal,value.incarnation].every(s=>typeof s==='string'&&/^[0-9a-f]{64}$/.test(s))||value.principal===value.incarnation||!Number.isSafeInteger(value.fence)||value.fence<0||typeof value.generation!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.generation)||value.coverageStatus!=='unknown')return null;
 const counts=['historySnapshotCount','attemptCount','activePrivateBankCount','tombstoneCount'];
 if(value.status==='unknown'?(value.highWater!==null||counts.some(k=>value[k]!==null)):(typeof value.highWater!=='string'||!/^(0|[1-9][0-9]{0,19})$/.test(value.highWater)||counts.some(k=>!Number.isSafeInteger(value[k])||value[k]<0)))return null;
 return structuredClone(value);
}
