import { randomUUID } from 'node:crypto';

/**
 * Confirmacion controlada por el servidor. Una accion de escritura queda pendiente y solo se
 * ejecuta si llega un `confirm` con el actionId correcto, de la misma sesion, sin caducar y una sola vez.
 * El modelo nunca ve ni genera la confirmacion.
 */
export function createPending({ toolName, args, summary, ttlMs, now = Date.now(), turn }) {
  return { actionId: randomUUID(), toolName, args, summary, expiresAt: now + ttlMs, turn };
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
