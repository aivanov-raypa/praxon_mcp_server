import { z } from 'zod';
import { defineTool } from '../../../tools/registry.js';
import { ESTADOS, PRIORIDADES, proyectoId, ticketId } from './shared.js';

/** Herramientas de solo lectura: se ejecutan siempre, tambien por voz. */
export function consultaTools(client) {
  const connector = 'myraypa';
  return [
    defineTool({
      connector,
      name: 'listar_proyectos',
      risk: 'read',
      description: 'Lista los proyectos de MyRAYPA habilitados para el asistente, con su nivel de autonomía.',
      input: z.object({}),
      execute: async () => ({ proyectos: await client.listProjects() }),
    }),
    defineTool({
      connector,
      name: 'listar_tickets',
      risk: 'read',
      description:
        'Lista tickets filtrando por proyecto, estado, prioridad, asignado o texto aproximado del título. Úsala para localizar el ticket que el usuario nombra por texto antes de modificarlo. Devuelve los más prioritarios primero.',
      input: z.object({
        proyectoId: proyectoId.optional(),
        estado: z.enum(ESTADOS).optional(),
        prioridad: z.enum(PRIORIDADES).optional(),
        asignado: z.string().optional(),
        texto: z.string().max(100).optional().describe('Palabras del título o la descripción'),
        limite: z.number().int().min(1).max(10).default(5),
      }),
      execute: async ({ limite, ...filtros }) => client.listTickets({ ...filtros, limit: limite }),
    }),
    defineTool({
      connector,
      name: 'detalle_ticket',
      risk: 'read',
      description: 'Devuelve el detalle de un ticket: estado, prioridad, asignado, proyecto y últimos comentarios.',
      input: z.object({ ticketId }),
      execute: async ({ ticketId: id }) => client.getTicket(id),
    }),
    defineTool({
      connector,
      name: 'resumen_proyecto',
      risk: 'read',
      description: 'Resumen de un proyecto: tickets por estado y prioridad, y los urgentes abiertos.',
      input: z.object({ proyectoId }),
      execute: async ({ proyectoId: id }) => client.projectSummary(id),
    }),
  ];
}
