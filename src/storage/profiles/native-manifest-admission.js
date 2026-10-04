import {ownedWriteInput} from '../idb/write-input.js';
import {validateManifest} from './control-schema.js';
import {validateNativeManifestV2} from '../cloud-recovery/final-readback.js';

/** Pure format admission only. This does not inspect facts, certify closure,
 * convert V2 digests to V1, or grant any registry activation capability. */
export function admitControlManifestCandidate(input){
  const value=ownedWriteInput(input);
  const manifest=value?.format==='qb-v2-native-manifest-v2'?validateNativeManifestV2(value):validateManifest(value);
  let recordCount=0;
  for(const row of manifest.stores){recordCount+=row.recordCount;if(!Number.isSafeInteger(recordCount))throw Object.assign(new Error('MANIFEST_COUNT_UNSAFE'),{code:'MANIFEST_COUNT_UNSAFE'});}
  return Object.freeze({manifest,recordCount,algorithm:manifest.format==='qb-v2-native-manifest-v2'?'indexeddb-primary-key-v1/canonical-ndjson-v1':'legacy-v1',admission:'format_only',ready:false});
}
