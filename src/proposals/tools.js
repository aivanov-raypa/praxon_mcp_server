import { z } from 'zod';
import { defineTool } from '../tools/registry.js';
import { ticketId } from '../connectors/myraypa/tools/shared.js';

/**
 * Herramientas de voz sobre las propuestas de la revision automatica: consultarlas y aplicar una.
 * Aplicar una pasa por la confirmacion normal de la conversacion, ademas de la comprobacion de que nada ha cambiado.
 */
export function proposalTools({ store, triage, client = null, scope = null, config = {}, onReviewed = () => {}, now = () => new Date() }) {
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
    ...(client && triage
      ? [
          defineTool({
            connector,
            name: 'revisar_tickets',
            risk: 'read',
            description:
              'Pide a la revisión automática que analice unos tickets concretos que el usuario ha nombrado (no sirve para recorrer un backlog). Se hace en segundo plano: las propuestas quedan pendientes en la pantalla Trabajo y la app avisa al terminar. Máximo unos pocos tickets por vez; cada revisión consume recursos, así que no la lances por tu cuenta. Localiza antes los ids con listar_tickets.',
            input: z.object({ ticketIds: z.array(ticketId).min(1).max(10) }),
            execute: async ({ ticketIds }, { session }) => {
              const max = config.TRIAGE_MAX_TICKETS ?? 6;
              const ids = [...new Set(ticketIds)];
              if (ids.length > max) throw new Error(`Solo puedo revisar ${max} tickets por vez. Dime cuáles son los más importantes.`);
              if (triage.running) return { iniciada: false, motivo: 'Ya hay una revisión en curso; inténtalo cuando termine.' };
              const tickets = [];
              for (const id of ids) {
                const t = await client.getTicket(id);
                tickets.push({ id: t.id, titulo: t.titulo, proyecto: t.proyecto?.nombre ?? t.proyecto });
              }
              const owner = session?.email ?? session?.user;
              triage
                .runTickets({ user: session?.user ?? config.PRAXON_USER, tickets, trigger: 'manual' })
                .then(async (b) => {
                  if (b.omitida) return;
                  await scope?.markDone(tickets);
                  onReviewed(b, owner);
                })
                .catch((err) => console.error('[revisar_tickets]', err.message));
              return { iniciada: true, tickets: tickets.map((t) => t.titulo), aviso: 'La revisión tarda un minuto o dos. Avisa al usuario de que lo hará en segundo plano.' };
            },
          }),
        ]
      : []),
    defineTool({
      connector,
      name: 'hora_actual',
      risk: 'read',
      description: 'Devuelve la fecha y la hora actuales (hora de Madrid). Úsala cuando necesites saber qué hora es o calcular un plazo respecto a ahora.',
      input: z.object({}),
      execute: async () => {
        const d = now();
        return {
          fecha: new Intl.DateTimeFormat('es-ES', { dateStyle: 'full', timeZone: 'Europe/Madrid' }).format(d),
          hora: new Intl.DateTimeFormat('es-ES', { timeStyle: 'short', timeZone: 'Europe/Madrid' }).format(d),
        };
      },
    }),
  ];
}
