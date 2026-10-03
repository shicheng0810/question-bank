// Pure field/string components are also usable by Worker readers without IDB.
export {streamRegisteredBankContent,streamRegisteredBankFields} from './bank-content-stream-core.js';
import {streamRegisteredBankFieldsWithStringStore} from './bank-content-stream-core.js';
import {createNativeCanonicalStringStore,createSourceCanonicalStringStore} from './canonical-string-stream.js';
export async function createNativeRegisteredBankStreamer(database,workspace){const strings=await createNativeCanonicalStringStore(database,workspace);return Object.freeze({stream:input=>streamRegisteredBankFieldsWithStringStore(input,strings),close:()=>strings.close(),ready:false});}
export async function createSourceRegisteredBankStreamer(database,workspace){const strings=await createSourceCanonicalStringStore(database,workspace);return Object.freeze({stream:input=>streamRegisteredBankFieldsWithStringStore(input,strings),close:()=>strings.close(),ready:false});}
