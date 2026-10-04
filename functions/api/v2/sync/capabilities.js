import {handleAccountSync} from '../../../_shared/account-sync-handler.js';
export const onRequest=context=>handleAccountSync(context,'capabilities');
