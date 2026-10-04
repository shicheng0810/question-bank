const HEX = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ITEM_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SEQ = /^(0|[1-9][0-9]{0,19})$/;
export const ADMIN_ITEM_KINDS = ['history_snapshot','attempt_manifest','private_bank','attempt_diagnostics'];
export function exactAdminRecord(value, keys) {
  if (!value || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) return false;
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && own.every(key => typeof key === 'string' && keys.includes(key))
    && keys.every(key => { const descriptor=Object.getOwnPropertyDescriptor(value,key);return descriptor && 'value' in descriptor; });
}
export function validAdminItemsCommand(command) {
  return exactAdminRecord(command,['principal','incarnation','expectedFence','expectedGeneration','kind','limit','cursor'])
    && typeof command.principal === 'string' && HEX.test(command.principal) && typeof command.incarnation === 'string' && HEX.test(command.incarnation)
    && typeof command.expectedGeneration === 'string' && UUID.test(command.expectedGeneration)
    && Number.isSafeInteger(command.expectedFence) && command.expectedFence >= 1
    && ADMIN_ITEM_KINDS.includes(command.kind) && Number.isSafeInteger(command.limit) && command.limit >= 1 && command.limit <= 100
    && (command.cursor === null || typeof command.cursor === 'string' && command.cursor.length <= 2048 && /^[A-Za-z0-9_-]+$/.test(command.cursor));
}
export function safeAdminItemsResult(value, command) {
  if (exactAdminRecord(value,['ok','error']) && value.ok===false && /^[A-Z][A-Z0-9_]{0,63}$/.test(value.error)) return {...value};
  if (!validAdminItemsCommand(command) || !exactAdminRecord(value,['ok','status','principal','incarnation','fence','generation','kind','watermark','items','nextCursor'])
    || value.ok!==true || value.status!=='verified' || value.principal!==command.principal || value.incarnation!==command.incarnation
    || value.fence!==command.expectedFence || value.generation!==command.expectedGeneration || value.kind!==command.kind
    || !exactAdminRecord(value.watermark,['highWater','logEpoch','digest']) || typeof value.watermark.highWater !== 'string' || !SEQ.test(value.watermark.highWater)
    || typeof value.watermark.logEpoch !== 'string' || !UUID.test(value.watermark.logEpoch)
    || typeof value.watermark.digest !== 'string' || !HEX.test(value.watermark.digest) || !Array.isArray(value.items) || value.items.length>command.limit
    || !(value.nextCursor===null || typeof value.nextCursor==='string' && value.nextCursor.length<=2048 && /^[A-Za-z0-9_-]+$/.test(value.nextCursor))) return null;
  let previous='';
  for (const item of value.items) {
    const prefix=command.kind==='private_bank'?'bank':['attempt_manifest','attempt_diagnostics'].includes(command.kind)?'attempt':'history_snapshot';
    if (!exactAdminRecord(item,command.kind==='attempt_diagnostics'?['id','revision','serverSeq','diagnostic']:['id','revision','serverSeq']) || typeof item.id!=='string' || !item.id.startsWith(prefix+':')
      || !ITEM_UUID.test(item.id.slice(prefix.length+1)) || item.id<=previous || !Number.isSafeInteger(item.revision) || item.revision<0 || typeof item.serverSeq !== 'string' || !SEQ.test(item.serverSeq) || BigInt(item.serverSeq)>BigInt(value.watermark.highWater)) return null;
    if(command.kind==='attempt_diagnostics') {
      const d=item.diagnostic;
      if(!exactAdminRecord(d,['resumePayloadDigest','resumeRevision','serverConfirmedCut','receiptType','receiptUpdatedAt','resumeStatus','unknownReason'])
        || !(d.resumeRevision===null || Number.isSafeInteger(d.resumeRevision)&&d.resumeRevision>=1)
        || !(d.resumePayloadDigest===null || typeof d.resumePayloadDigest==='string'&&HEX.test(d.resumePayloadDigest)) || d.receiptUpdatedAt!==null) return null;
      if(d.resumeStatus==='receipt_verified') {
        if(d.resumePayloadDigest===null || d.resumeRevision===null || d.receiptType!=='accepted' || typeof d.serverConfirmedCut!=='string'
          || !SEQ.test(d.serverConfirmedCut) || BigInt(d.serverConfirmedCut)>BigInt(value.watermark.highWater)
          || d.unknownReason!=='DEVICE_PENDING_AND_RECEIPT_TIME_UNAVAILABLE')return null;
      } else if(d.resumeStatus!=='unknown' || d.serverConfirmedCut!==null || d.receiptType!==null
        || !['NO_CLOUD_RESUME','CURRENT_RESUME_RECEIPT_UNVERIFIED'].includes(d.unknownReason)) return null;
    }
    previous=item.id;
  }
  if (value.nextCursor!==null && !value.items.length || new TextEncoder().encode(JSON.stringify(value)).length>16384) return null;
  return structuredClone(value);
}
