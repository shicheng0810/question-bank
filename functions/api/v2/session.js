import { handleAccountSession } from '../../_shared/account-session-handler.js';

export function onRequest({ request, env }) {
  return handleAccountSession(request, env);
}
