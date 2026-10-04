import { handleAccountAuth } from '../../_shared/account-auth-handler.js';

export function onRequest(context) {
  return handleAccountAuth(context.request, context.env);
}
