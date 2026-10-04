import { handleAccountDelete } from '../../_shared/account-delete-handler.js';

export function onRequest({ request, env }) {
  return handleAccountDelete(request, env);
}
