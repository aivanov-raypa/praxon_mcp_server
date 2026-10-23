import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Usuario de MyRAYPA en nombre del cual se está trabajando. Se fija una vez por mensaje (server.js) y lo lee
 * el cliente HTTP de MyRAYPA para enviar X-Assistant-User, sin pasar el usuario por cada herramienta.
 * Sin contexto (token heredado, revisión automática) el cliente actúa como el usuario de servicio.
 */
const store = new AsyncLocalStorage();

export const runAsUser = (email, fn) => store.run({ email: email ?? null }, fn);
export const currentUserEmail = () => store.getStore()?.email ?? null;
