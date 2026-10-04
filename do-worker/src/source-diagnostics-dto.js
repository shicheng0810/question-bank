const stages = new Set(['OK','BANK_ID','BANK_DUPLICATE','QUESTION_BYTES','QUESTIONS_JSON','QUESTIONS_COUNT','META_JSON','META_ID','META_COUNT','META_BYTES','META_CHUNK_BOUND']);
const flags = ['questionsWithinBounds','questionsBytesWithinBounds','metaIdMatches','countMatches','bytesMatch','legacyCodeUnitLengthMatches','metaWithinChunkBound'];
function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype,null].includes(Object.getPrototypeOf(value))
    && Reflect.ownKeys(value).filter(key=>key!==Symbol.dispose).length === keys.length
    && keys.every(key => Object.hasOwn(value,key) && 'value' in Object.getOwnPropertyDescriptor(value,key));
}
export function safeSourceDiagnostics(value) {
  if (exact(value,['ok','error']) && value.ok === false && ['INVALID_INPUT','NOT_CONFIGURED','UNAVAILABLE'].includes(value.error)) return {ok:false,error:value.error};
  const keys=['ok','imported','frozen','deleted','historyCount','bankCount','truncated','banks'];
  if (!exact(value,keys) || value.ok !== true || !['imported','frozen','deleted','truncated'].every(key=>typeof value[key]==='boolean')
    || !['historyCount','bankCount'].every(key=>Number.isSafeInteger(value[key])&&value[key]>=0)
    || value.truncated !== (value.bankCount>15)
    || !Array.isArray(value.banks) || value.banks.length>15 || value.banks.length!==Math.min(15,value.bankCount)) return null;
  const banks=[];
  for (const row of value.banks) {
    if (!exact(row,['ordinal','stage','idValid','duplicateId',...flags]) || row.ordinal !== banks.length || !stages.has(row.stage)
      || typeof row.idValid!=='boolean' || typeof row.duplicateId!=='boolean'
      || !flags.every(key=>row[key]===null||typeof row[key]==='boolean')) return null;
    banks.push(Object.fromEntries(['ordinal','stage','idValid','duplicateId',...flags].map(key=>[key,row[key]])));
  }
  return {ok:true,imported:value.imported,frozen:value.frozen,deleted:value.deleted,historyCount:value.historyCount,bankCount:value.bankCount,truncated:value.truncated,banks};
}
