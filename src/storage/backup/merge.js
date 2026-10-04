import { APP_DATA_STORES, canonicalBytes } from '../../domain/app-data/index.js';
import { ownSnapshot, STORE_NAMES } from './snapshot.js';

const key=(name,row)=>{const path=APP_DATA_STORES[name].keyPath;return JSON.stringify(Array.isArray(path)?path.map(field=>row[field]):row[path]);};
const equal=(name,a,b)=>name==='content_chunks'?a.contentDigest===b.contentDigest&&a.chunkIndex===b.chunkIndex&&a.bytes.length===b.bytes.length&&a.bytes.every((byte,index)=>byte===b.bytes[index]):new TextDecoder().decode(canonicalBytes(a))===new TextDecoder().decode(canonicalBytes(b));
/** Ordinary guest imports merge facts, never select an arbitrary winner for
 * divergent identical entities. Caller preserves the whole imported stage.
 */
export function mergeGuestSnapshots(current,imported){
  const target=ownSnapshot(current),source=ownSnapshot(imported),snapshot={},conflicts=[];
  for(const name of STORE_NAMES){
    if(['meta','writer_leases'].includes(name)){snapshot[name]=[];continue;}
    const rows=new Map();
    for(const row of target[name])if(!(name==='import_receipts'&&row.sourceId.startsWith('qb-sync-v2:')&&row.provenance?.format!=='qb-sync-change-v1'))rows.set(key(name,row),row);
    for(const row of source[name]){const id=key(name,row),old=rows.get(id);if(old&&!equal(name,old,row))conflicts.push({store:name,key:id});else if(!old)rows.set(id,row);}
    snapshot[name]=[...rows.values()];
    for(const index of APP_DATA_STORES[name].indexes.filter(index=>index.unique)){
      const seen=new Map();for(const row of snapshot[name]){const path=index.keyPath,value=Array.isArray(path)?path.map(field=>row[field]):row[path];if(value===undefined||Array.isArray(value)&&value.some(item=>item===undefined))continue;const indexed=JSON.stringify(value),primary=key(name,row);if(seen.has(indexed)&&seen.get(indexed)!==primary)conflicts.push({store:name,key:`index:${index.name}:${indexed}`});else seen.set(indexed,primary);}
    }
  }
  return {snapshot,conflicts};
}
