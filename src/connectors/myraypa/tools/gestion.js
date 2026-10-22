import { z } from 'zod';
import { defineTool } from '../../../tools/registry.js';
import { ESTADOS, PRIORIDADES, originOf, proyectoId, recorta, ticketId } from './shared.js';

const etiqueta = (tk) => `ticket ${tk.id}, ${tk.titulo}`;

/**
 * Herramientas que modifican datos reales. El orquestador NO las ejecuta hasta que el usuario confirma;
 * summarize() genera lo que se le lee al usuario para confirmar, a partir de datos reales del ticket.
 */
export function gestionTools(client) {
  const connector = 'myraypa';
  return [
    defineTool({
      connector,
      name: 'crear_ticket',
      risk: 'write',
      description: 'Crea un ticket nuevo en un proyecto.',
      input: z.object({
        proyectoId,
        titulo: z.string().min(3).max(120),
        descripcion: z.string().max(1000).optional(),
        prioridad: z.enum(PRIORIDADES).default('media'),
        asignado: z.string().max(80).optional(),
      }),
      summarize: async (a) => {
        const proyecto = (await client.listProjects()).find((p) => p.id === a.proyectoId);
        if (!proyecto) throw new Error('Ese proyecto no existe o no está habilitado para el asistente.');
        return `Voy a crear un ticket en ${proyecto.nombre}: ${a.titulo}, con prioridad ${a.prioridad}`;
      },
      execute: async (a, { session }) => client.createTicket(a, originOf(session)),
    }),
    defineTool({
      connector,
      name: 'actualizar_ticket',
      risk: 'write',
      description: 'Cambia el estado, la prioridad o el asignado de un ticket que ya has localizado.',
      input: z
        .object({
          ticketId,
          estado: z.enum(ESTADOS).optional(),
          prioridad: z.enum(PRIORIDADES).optional(),
          asignado: z.string().max(80).optional(),
        })
        .refine((a) => a.estado || a.prioridad || a.asignado, { message: 'indica al menos un cambio' }),
      summarize: async (a) => {
        const tk = await client.getTicket(a.ticketId);
        const cambios = ['estado', 'prioridad', 'asignado']
          .filter((c) => a[c] !== undefined && a[c] !== tk[c])
          .map((c) => `${c} ${tk[c] ? `de ${tk[c]} ` : ''}a ${a[c]}`);
        if (!cambios.length) throw new Error(`El ticket ${tk.id} ya tiene esos valores; no hay nada que cambiar.`);
        return `Voy a cambiar el ${etiqueta(tk)}: ${cambios.join(' y ')}`;
      },
      execute: async ({ ticketId: id, ...cambios }, { session }) => client.updateTicket(id, cambios, originOf(session)),
    }),
    defineTool({
      connector,
      name: 'comentar_ticket',
      risk: 'write',
      description: 'Añade un comentario a un ticket.',
      input: z.object({ ticketId, texto: z.string().min(1).max(500) }),
      summarize: async (a) => {
        const tk = await client.getTicket(a.ticketId);
        return `Voy a añadir un comentario al ${etiqueta(tk)}: ${recorta(a.texto)}`;
      },
      execute: async (a, { session }) => client.commentTicket(a.ticketId, a.texto, originOf(session)),
    }),
    defineTool({
      connector,
      name: 'reordenar_prioridades',
      risk: 'write',
      description: 'Reordena la prioridad de varios tickets de un proyecto: el primero de la lista es el más prioritario.',
      input: z.object({ proyectoId, orden: z.array(ticketId).min(2).max(20) }),
      summarize: async (a) => {
        const proyecto = (await client.listProjects()).find((p) => p.id === a.proyectoId);
        if (!proyecto) throw new Error('Ese proyecto no existe o no está habilitado para el asistente.');
        const primero = await client.getTicket(a.orden[0]);
        return `Voy a reordenar ${a.orden.length} tickets de ${proyecto.nombre}, con el ${etiqueta(primero)} como el más prioritario`;
      },
      execute: async (a, { session }) => client.reorderPriorities(a.proyectoId, a.orden, originOf(session)),
    }),
  ];
}
