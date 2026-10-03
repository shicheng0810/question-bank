import { handleAccountContent } from '../../../_shared/account-content-handler.js';
export const onRequest = context => handleAccountContent(context, 'chunk');
