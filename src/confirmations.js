import { randomUUID } from 'node:crypto';

/**
 * Confirmacion controlada por el servidor. Una accion de escritura (o varias del mismo paso, en lote) queda pendiente y solo se
 * ejecuta si llega un `confirm` con el actionId correcto, de la misma sesion, sin caducar y una sola vez.
 * El modelo nunca ve ni genera la confirmacion.
 */
export function createPending({ actions, summary, items, ttlMs, now = Date.now(), turn }) {
  // `actions`: lo que se ejecuta si el usuario confirma ({ index, toolName, args, summary }). Una o varias: se confirman juntas.
  return { actionId: randomUUID(), actions, summary, items, expiresAt: now + ttlMs, turn };
}

/** @returns {{ok: true} | {ok: false, reason: 'none'|'mismatch'|'expired'}} */
export function checkConfirmation(pending, actionId, now = Date.now()) {
  if (!pending) return { ok: false, reason: 'none' };
  if (pending.actionId !== actionId) return { ok: false, reason: 'mismatch' };
  if (now > pending.expiresAt) return { ok: false, reason: 'expired' };
  return { ok: true };
}

export const CONFIRMATION_ERRORS = {
  none: 'No hay ninguna acción pendiente de confirmar.',
  mismatch: 'No hay ninguna acción pendiente con ese identificador.',
  expired: 'La confirmación ha caducado. No se ha hecho ningún cambio; vuelve a pedirlo.',
};
