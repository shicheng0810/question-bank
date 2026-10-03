import { handleAccountExport } from '../../../_shared/account-export-handler.js';
export const onRequest = context => handleAccountExport(context, 'chunk');
