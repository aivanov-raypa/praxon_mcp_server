import { z } from 'zod';
import { defineTool } from '../../../tools/registry.js';
import { PRIORIDADES, estado, ordenExplicita, originOf, proyectoId, recorta, ticketId } from './shared.js';

// Los tickets de MyRAYPA no tienen número: se nombran por su título.
const etiqueta = (tk) => `ticket ${tk.titulo}`;

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
      description: 'Cambia el estado, la prioridad, el asignado o marca como completado (o reabre) un ticket que ya has localizado. La prioridad más alta es "alta"; no existe "urgente".',
      input: z
        .object({
          ticketId,
          estado: estado.optional(),
          prioridad: z.enum(PRIORIDADES).optional(),
          asignado: z.string().max(80).optional(),
          completado: z.boolean().optional().describe('true = marcar como completado; false = reabrir'),
          ordenExplicita,
        })
        .refine((a) => a.estado || a.prioridad || a.asignado || a.completado !== undefined, { message: 'indica al menos un cambio' }),
      summarize: async (a) => {
        const tk = await client.getTicket(a.ticketId);
        const cambios = ['estado', 'prioridad', 'asignado']
          .filter((c) => a[c] !== undefined && a[c] !== tk[c])
          .map((c) => `${c} ${tk[c] ? `de ${tk[c]} ` : ''}a ${a[c]}`);
        if (a.completado !== undefined && a.completado !== tk.completado) cambios.push(a.completado ? 'marcarlo como completado' : 'reabrirlo');
        if (!cambios.length) throw new Error(`El ticket ${tk.titulo} ya tiene esos valores; no hay nada que cambiar.`);
        return `Voy a cambiar el ${etiqueta(tk)}: ${cambios.join(' y ')}`;
      },
      execute: async ({ ticketId: id, ordenExplicita: _o, ...cambios }, { session }) => client.updateTicket(id, cambios, originOf(session)),
    }),
    defineTool({
      connector,
      name: 'editar_ticket',
      risk: 'write',
      description: 'Cambia el título de un ticket o AÑADE texto al final de su descripción. No puede borrar ni reescribir la descripción que ya tiene: solo añadir. Para cambiar estado, prioridad, asignado o completado usa actualizar_ticket.',
      input: z
        .object({
          ticketId,
          titulo: z.string().trim().min(1).max(200).optional().describe('Título nuevo completo'),
          anadirDescripcion: z.string().trim().min(1).max(2000).optional().describe('Texto que se añade al final de la descripción'),
        })
        .refine((a) => a.titulo || a.anadirDescripcion, { message: 'indica un título nuevo o el texto que quieres añadir' }),
      summarize: async (a) => {
        const tk = await client.getTicket(a.ticketId);
        const cambios = [];
        if (a.titulo && a.titulo !== tk.titulo) cambios.push(`cambiar el título de «${recorta(tk.titulo, 60)}» a «${recorta(a.titulo, 100)}»`);
        if (a.anadirDescripcion) cambios.push(`añadir a la descripción: «${recorta(a.anadirDescripcion, 160)}»`);
        if (!cambios.length) throw new Error(`El ticket ${tk.titulo} ya tiene ese título; no hay nada que cambiar.`);
        return `Voy a ${cambios.join(' y ')} en el ${etiqueta(tk)}`;
      },
      execute: async ({ ticketId: id, ...cambios }, { session }) => client.updateTicket(id, cambios, originOf(session)),
    }),
    defineTool({
      connector,
      name: 'comentar_ticket',
      risk: 'write',
      description: 'Añade un comentario a un ticket.',
      input: z.object({ ticketId, texto: z.string().min(1).max(500), ordenExplicita }),
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
      description: 'Reordena varios tickets de un proyecto: el primero de la lista queda el primero (posición en el tablero). No cambia el campo prioridad.',
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
