import { accountPreflight } from '../../../_shared/account-http-origin.js';
import { handleAccountLegacy } from '../../../_shared/account-legacy-handler.js';

export const onRequestOptions = ({ request, env }) => accountPreflight(request, env);
export const onRequest = context => handleAccountLegacy(context, 'banks');
