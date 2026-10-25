import { z } from 'zod';
import { defineTool } from '../../../tools/registry.js';
import { ordenExplicita, originOf, proyectoId, recorta, ticketId } from './shared.js';

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'AAAA-MM-DD').describe('Fecha AAAA-MM-DD (resuelve "el viernes" o "fin de mes" con la fecha de hoy)');
const nombres = z.array(z.string().min(1).max(60)).max(10);
const titulo = async (client, id) => (await client.getTicket(id)).titulo;

/** Detalle ampliado, fechas, horas, etiquetas, checklist, campos personalizados, subtareas, participantes e informes. */
export function extrasTools(client) {
  const connector = 'myraypa';
  return [
    // ── Lectura ──
    defineTool({
      connector, name: 'detalle_completo_ticket', risk: 'read',
      description: 'Devuelve TODO de un ticket: fechas, horas estimadas y registradas, etiquetas, checklist, campos personalizados, participantes y subtareas. Úsala para preguntas como "cuántas horas lleva" o "qué le falta del checklist".',
      input: z.object({ ticketId }),
      execute: async ({ ticketId: id }) => client.getTicketFull(id),
    }),
    defineTool({
      connector, name: 'listar_etiquetas', risk: 'read',
      description: 'Lista las etiquetas disponibles en un proyecto.',
      input: z.object({ proyectoId }),
      execute: async ({ proyectoId: id }) => client.listLabels(id),
    }),
    defineTool({
      connector, name: 'listar_campos_personalizados', risk: 'read',
      description: 'Lista los campos personalizados de un proyecto con su tipo y opciones.',
      input: z.object({ proyectoId }),
      execute: async ({ proyectoId: id }) => client.listCustomFields(id),
    }),
    defineTool({
      connector, name: 'listar_miembros', risk: 'read',
      description: 'Lista el propietario, los miembros y los equipos de un proyecto. Úsala antes de asignar o añadir participantes si no estás seguro del nombre.',
      input: z.object({ proyectoId }),
      execute: async ({ proyectoId: id }) => client.listMembers(id),
    }),
    defineTool({
      connector, name: 'informe_proyecto', risk: 'read',
      description: 'Informe de un proyecto: tickets abiertos y completados, por estado y prioridad, vencidos, sin asignar, horas por persona y tickets que superan su estimación. Opcionalmente para un periodo (desde/hasta).',
      input: z.object({ proyectoId, desde: fecha.optional(), hasta: fecha.optional() }),
      execute: async ({ proyectoId: id, ...rango }) => client.projectReport(id, rango),
    }),
    defineTool({
      connector, name: 'carga_trabajo', risk: 'read',
      description: 'Carga de trabajo por persona: tickets abiertos, vencidos, de prioridad alta y horas estimadas pendientes. De un proyecto o de todos los habilitados.',
      input: z.object({ proyectoId: proyectoId.optional() }),
      execute: async ({ proyectoId: id }) => client.workload({ proyectoId: id }),
    }),
    defineTool({
      connector, name: 'informe_horas', risk: 'read',
      description: 'Horas registradas por persona y proyecto en un periodo, con los tickets que más horas suman. Filtrable por proyecto y por usuario.',
      input: z.object({ proyectoId: proyectoId.optional(), usuario: z.string().max(80).optional(), desde: fecha.optional(), hasta: fecha.optional() }),
      execute: async ({ proyectoId: id, ...f }) => client.hoursReport({ proyectoId: id, ...f }),
    }),

    // ── Escritura (siempre con confirmación) ──
    defineTool({
      connector, name: 'cambiar_fechas_ticket', risk: 'write',
      description: 'Cambia la fecha de inicio, la de vencimiento y/o las horas estimadas de un ticket. Usa null para quitar un valor.',
      input: z
        .object({ ticketId, inicio: fecha.nullable().optional(), vencimiento: fecha.nullable().optional(), estimadoHoras: z.number().min(0).max(10000).nullable().optional(), ordenExplicita })
        .refine((a) => a.inicio !== undefined || a.vencimiento !== undefined || a.estimadoHoras !== undefined, { message: 'indica al menos un cambio' }),
      summarize: async (a) => {
        const c = [];
        if (a.inicio !== undefined) c.push(a.inicio ? `inicio el ${a.inicio}` : 'quitar el inicio');
        if (a.vencimiento !== undefined) c.push(a.vencimiento ? `vencimiento el ${a.vencimiento}` : 'quitar el vencimiento');
        if (a.estimadoHoras !== undefined) c.push(a.estimadoHoras ? `estimación de ${a.estimadoHoras} horas` : 'quitar la estimación');
        return `Voy a cambiar el ticket ${await titulo(client, a.ticketId)}: ${c.join(' y ')}`;
      },
      execute: async ({ ticketId: id, ordenExplicita: _o, ...cambios }, { session }) => client.setTicketDates(id, cambios, originOf(session)),
    }),
    defineTool({
      connector, name: 'registrar_horas', risk: 'write',
      description: 'Registra horas trabajadas en un ticket. Si el usuario no dice de quién son las horas, pregúntalo antes de llamar a esta herramienta.',
      input: z.object({ ticketId, horas: z.number().positive().max(24), nota: z.string().max(200).optional(), fecha: fecha.optional().describe('Si no se indica, hoy'), usuario: z.string().max(80).optional().describe('De quién son las horas') }),
      summarize: async (a) => `Voy a registrar ${a.horas} horas${a.usuario ? ` de ${a.usuario}` : ''} en el ticket ${await titulo(client, a.ticketId)}${a.fecha ? ` con fecha ${a.fecha}` : ''}${a.nota ? `: ${recorta(a.nota, 60)}` : ''}`,
      execute: async ({ ticketId: id, ...datos }, { session }) => client.logHours(id, datos, originOf(session)),
    }),
    defineTool({
      connector, name: 'cambiar_etiquetas_ticket', risk: 'write',
      description: 'Añade y/o quita etiquetas de un ticket por su nombre. Las etiquetas deben existir en el proyecto (ver listar_etiquetas).',
      input: z.object({ ticketId, anadir: nombres.optional(), quitar: nombres.optional() }).refine((a) => (a.anadir?.length ?? 0) + (a.quitar?.length ?? 0) > 0, { message: 'indica qué etiquetas añadir o quitar' }),
      summarize: async (a) => {
        const c = [a.anadir?.length && `añadir ${a.anadir.join(', ')}`, a.quitar?.length && `quitar ${a.quitar.join(', ')}`].filter(Boolean).join(' y ');
        return `Voy a cambiar las etiquetas del ticket ${await titulo(client, a.ticketId)}: ${c}`;
      },
      execute: async ({ ticketId: id, ...cambios }, { session }) => client.changeLabels(id, cambios, originOf(session)),
    }),
    defineTool({
      connector, name: 'anadir_elemento_checklist', risk: 'write',
      description: 'Añade un elemento al checklist de un ticket.',
      input: z.object({ ticketId, texto: z.string().min(1).max(200) }),
      summarize: async (a) => `Voy a añadir al checklist del ticket ${await titulo(client, a.ticketId)}: ${recorta(a.texto, 80)}`,
      execute: async ({ ticketId: id, texto }, { session }) => client.addChecklistItem(id, texto, originOf(session)),
    }),
    defineTool({
      connector, name: 'actualizar_elemento_checklist', risk: 'write',
      description: 'Marca o desmarca un elemento del checklist, o cambia su texto. El elemento se indica por su número (1, 2...), por parte de su texto o por su id (ver detalle_completo_ticket).',
      input: z.object({ ticketId, elemento: z.string().min(1).max(200), completado: z.boolean().optional(), texto: z.string().min(1).max(200).optional() }).refine((a) => a.completado !== undefined || a.texto !== undefined, { message: 'indica al menos un cambio' }),
      summarize: async (a) => {
        const accion = [a.completado !== undefined && (a.completado ? 'marcar como hecho' : 'desmarcar'), a.texto && `renombrar a ${a.texto}`].filter(Boolean).join(' y ');
        return `Voy a ${accion} el elemento ${a.elemento} del checklist del ticket ${await titulo(client, a.ticketId)}`;
      },
      execute: async ({ ticketId: id, elemento, ...cambios }, { session }) => client.updateChecklistItem(id, elemento, cambios, originOf(session)),
    }),
    defineTool({
      connector, name: 'cambiar_campo_personalizado', risk: 'write',
      description: 'Da valor a un campo personalizado de un ticket (ver listar_campos_personalizados para nombres, tipos y opciones). Las fechas van en AAAA-MM-DD; los multiselect como lista. Usa null para vaciarlo.',
      input: z.object({ ticketId, campo: z.string().min(1).max(60), valor: z.union([z.string().max(500), z.number(), z.boolean(), z.array(z.string().max(60)).max(20), z.null()]) }),
      summarize: async (a) => `Voy a poner el campo ${a.campo} del ticket ${await titulo(client, a.ticketId)} a ${a.valor === null ? 'vacío' : Array.isArray(a.valor) ? a.valor.join(', ') : String(a.valor)}`,
      execute: async ({ ticketId: id, ...datos }, { session }) => client.setCustomField(id, datos, originOf(session)),
    }),
    defineTool({
      connector, name: 'crear_subtarea', risk: 'write',
      description: 'Crea una subtarea dentro de un ticket (solo un nivel: una subtarea no puede tener subtareas).',
      input: z.object({ ticketId, titulo: z.string().min(3).max(120), prioridad: z.enum(['ninguna', 'baja', 'media', 'alta']).optional(), asignado: z.string().max(80).optional(), vencimiento: fecha.optional() }),
      summarize: async (a) => `Voy a crear la subtarea ${recorta(a.titulo)} dentro del ticket ${await titulo(client, a.ticketId)}${a.asignado ? `, asignada a ${a.asignado}` : ''}${a.vencimiento ? `, para el ${a.vencimiento}` : ''}`,
      execute: async ({ ticketId: id, ...datos }, { session }) => client.createSubtask(id, datos, originOf(session)),
    }),
    defineTool({
      connector, name: 'cambiar_participantes_ticket', risk: 'write',
      description: 'Añade y/o quita participantes de un ticket por nombre de usuario.',
      input: z.object({ ticketId, anadir: nombres.optional(), quitar: nombres.optional() }).refine((a) => (a.anadir?.length ?? 0) + (a.quitar?.length ?? 0) > 0, { message: 'indica a quién añadir o quitar' }),
      summarize: async (a) => {
        const c = [a.anadir?.length && `añadir a ${a.anadir.join(', ')}`, a.quitar?.length && `quitar a ${a.quitar.join(', ')}`].filter(Boolean).join(' y ');
        return `Voy a cambiar los participantes del ticket ${await titulo(client, a.ticketId)}: ${c}`;
      },
      execute: async ({ ticketId: id, ...cambios }, { session }) => client.changeParticipants(id, cambios, originOf(session)),
    }),
  ];
}
