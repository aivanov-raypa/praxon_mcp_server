import { z } from 'zod';
import { defineTool } from '../tools/registry.js';

/**
 * Herramientas de voz sobre las propuestas de la revision automatica: consultarlas y aplicar una.
 * Aplicar una pasa por la confirmacion normal de la conversacion, ademas de la comprobacion de que nada ha cambiado.
 */
export function proposalTools({ store, triage }) {
  const connector = 'praxon';
  const find = (briefingId, actionId) => store.get(briefingId)?.acciones.find((a) => a.id === actionId);
  return [
    defineTool({
      connector,
      name: 'propuestas_pendientes',
      risk: 'read',
      description:
        'Devuelve la última revisión automática (su resumen) y las acciones propuestas que siguen pendientes de aprobar. Úsala cuando el usuario pregunte qué hay pendiente, qué has detectado o qué propones.',
      input: z.object({}),
      execute: async () => {
        const last = store.list()[0];
        return {
          ultimaRevision: last ? { fecha: last.createdAt, resumen: last.resumen } : null,
          pendientes: store.pending().map(({ briefing, action }) => ({ briefingId: briefing.id, actionId: action.id, accion: action.resumen, motivo: action.motivo })),
        };
      },
    }),
    defineTool({
      connector,
      name: 'aplicar_propuesta',
      risk: 'write',
      description: 'Ejecuta una acción propuesta en la revisión automática (usa los ids de propuestas_pendientes). El usuario debe confirmar.',
      input: z.object({ briefingId: z.string().min(1), actionId: z.string().min(1) }),
      summarize: async (a) => {
        const action = find(a.briefingId, a.actionId);
        if (!action || action.estado !== 'pendiente') throw new Error('Esa propuesta ya no está pendiente.');
        return action.resumen;
      },
      execute: async (a, { user }) => {
        const r = await triage.decide({ ...a, accepted: true, user });
        if (!r.ok) throw new Error(r.mensaje);
        return { hecho: true };
      },
    }),
  ];
}
