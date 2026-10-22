import { z } from 'zod';
import { defineTool } from '../../../tools/registry.js';
import { originOf, proyectoId, recorta } from './shared.js';

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'AAAA-MM-DD').describe('Fecha en formato AAAA-MM-DD (resuelve "el viernes" o "fin de mes" con la fecha de hoy)');
const roadmapId = z.string().min(1).describe('Identificador del roadmap (ver listar_roadmaps)');
const elementoId = z.string().min(1).describe('Identificador de un bloque, tarea o subtarea del roadmap (ver detalle_roadmap)');
const hitoId = z.string().min(1).describe('Identificador del hito o su título aproximado');

/** Busca un elemento del árbol del roadmap por id, para poder nombrarlo por su título en la confirmación. */
function buscar(detalle, id) {
  for (const b of detalle.bloques) {
    if (b.id === id) return { tipo: 'bloque', ...b };
    for (const t of b.tareas) {
      if (t.id === id) return { tipo: 'tarea', ...t };
      for (const s of t.subtareas) if (s.id === id) return { tipo: 'subtarea', ...s };
    }
  }
  return null;
}

/** Roadmaps (bloques, tareas y subtareas en un diagrama de Gantt) e hitos de roadmap y de proyecto. */
export function roadmapsTools(client) {
  const connector = 'myraypa';
  return [
    defineTool({
      connector,
      name: 'listar_roadmaps',
      risk: 'read',
      description: 'Lista los roadmaps vinculados a proyectos habilitados para el asistente, con sus fechas y cuántos bloques e hitos tienen. Se pueden filtrar por proyecto o por texto del título.',
      input: z.object({ proyectoId: proyectoId.optional(), texto: z.string().max(100).optional(), limite: z.number().int().min(1).max(10).default(5) }),
      execute: async ({ limite, ...f }) => client.listRoadmaps({ ...f, limit: limite }),
    }),
    defineTool({
      connector,
      name: 'detalle_roadmap',
      risk: 'read',
      description: 'Devuelve un roadmap completo: sus bloques, tareas y subtareas con fechas y si están hechas, y sus hitos. Úsala antes de modificar un elemento para conocer su id.',
      input: z.object({ roadmapId }),
      execute: async ({ roadmapId: id }) => client.getRoadmap(id),
    }),
    defineTool({
      connector,
      name: 'actualizar_elemento_roadmap',
      risk: 'write',
      description: 'Cambia el título, las fechas o el estado de hecho de un bloque, tarea o subtarea de un roadmap. Para quitar una fecha usa null.',
      input: z
        .object({ roadmapId, elementoId, titulo: z.string().min(1).max(120).optional(), inicio: fecha.nullable().optional(), fin: fecha.nullable().optional(), hecho: z.boolean().optional() })
        .refine((a) => a.titulo !== undefined || a.inicio !== undefined || a.fin !== undefined || a.hecho !== undefined, { message: 'indica al menos un cambio' }),
      summarize: async (a) => {
        const r = await client.getRoadmap(a.roadmapId);
        const el = buscar(r, a.elementoId);
        if (!el) throw new Error('No encuentro ese elemento en el roadmap.');
        const cambios = [];
        if (a.titulo !== undefined) cambios.push(`título a ${a.titulo}`);
        if (a.inicio !== undefined) cambios.push(a.inicio ? `inicio ${el.inicio ? `de ${el.inicio} ` : ''}a ${a.inicio}` : 'quitar la fecha de inicio');
        if (a.fin !== undefined) cambios.push(a.fin ? `fin ${el.fin ? `de ${el.fin} ` : ''}a ${a.fin}` : 'quitar la fecha de fin');
        if (a.hecho !== undefined) cambios.push(a.hecho ? 'marcarlo como hecho' : 'marcarlo como pendiente');
        return `Voy a cambiar en el roadmap ${r.titulo} la ${el.tipo} ${el.titulo}: ${cambios.join(' y ')}`;
      },
      execute: async ({ roadmapId: rid, elementoId: eid, ...cambios }, { session }) => client.updateRoadmapElement(rid, eid, cambios, originOf(session)),
    }),
    defineTool({
      connector,
      name: 'anadir_elemento_roadmap',
      risk: 'write',
      description: 'Añade un bloque, una tarea (dentro de un bloque) o una subtarea (dentro de una tarea) a un roadmap. Las tareas y subtareas necesitan el id del elemento padre.',
      input: z.object({ roadmapId, tipo: z.enum(['bloque', 'tarea', 'subtarea']), padreId: z.string().optional().describe('Id del bloque (para una tarea) o de la tarea (para una subtarea)'), titulo: z.string().min(1).max(120), inicio: fecha.optional(), fin: fecha.optional() }),
      summarize: async (a) => {
        const r = await client.getRoadmap(a.roadmapId);
        const padre = a.padreId ? buscar(r, a.padreId) : null;
        if (a.tipo !== 'bloque' && !padre) throw new Error(`Para añadir una ${a.tipo} indica en qué ${a.tipo === 'tarea' ? 'bloque' : 'tarea'}.`);
        const donde = padre ? ` dentro de ${padre.titulo}` : '';
        const fechas = a.inicio || a.fin ? `, ${[a.inicio && `desde ${a.inicio}`, a.fin && `hasta ${a.fin}`].filter(Boolean).join(' ')}` : '';
        return `Voy a añadir al roadmap ${r.titulo} ${a.tipo === 'bloque' ? 'el' : 'la'} ${a.tipo} ${a.titulo}${donde}${fechas}`;
      },
      execute: async ({ roadmapId: rid, ...datos }, { session }) => client.addRoadmapElement(rid, datos, originOf(session)),
    }),
    defineTool({
      connector,
      name: 'anadir_hito_roadmap',
      risk: 'write',
      description: 'Añade un hito (milestone) con una fecha a un roadmap.',
      input: z.object({ roadmapId, titulo: z.string().min(1).max(120), fecha }),
      summarize: async (a) => {
        const r = await client.getRoadmap(a.roadmapId);
        return `Voy a añadir al roadmap ${r.titulo} el hito ${a.titulo} para el ${a.fecha}`;
      },
      execute: async ({ roadmapId: rid, ...datos }, { session }) => client.addRoadmapMilestone(rid, datos, originOf(session)),
    }),
    defineTool({
      connector,
      name: 'actualizar_hito_roadmap',
      risk: 'write',
      description: 'Cambia el título o la fecha de un hito de un roadmap.',
      input: z.object({ roadmapId, hitoId, titulo: z.string().min(1).max(120).optional(), fecha: fecha.optional() }).refine((a) => a.titulo !== undefined || a.fecha !== undefined, { message: 'indica al menos un cambio' }),
      summarize: async (a) => {
        const r = await client.getRoadmap(a.roadmapId);
        const h = r.hitos.find((x) => x.id === a.hitoId) ?? r.hitos.filter((x) => x.titulo.toLowerCase().includes(a.hitoId.toLowerCase()))[0];
        if (!h) throw new Error('No encuentro ese hito en el roadmap.');
        const c = [a.titulo && `título a ${a.titulo}`, a.fecha && `fecha de ${h.fecha} a ${a.fecha}`].filter(Boolean).join(' y ');
        return `Voy a cambiar el hito ${h.titulo} del roadmap ${r.titulo}: ${c}`;
      },
      execute: async ({ roadmapId: rid, hitoId: hid, ...cambios }, { session }) => client.updateRoadmapMilestone(rid, hid, cambios, originOf(session)),
    }),
    defineTool({
      connector,
      name: 'listar_hitos_proyecto',
      risk: 'read',
      description: 'Lista los hitos (milestones) de un proyecto con sus fechas.',
      input: z.object({ proyectoId }),
      execute: async ({ proyectoId: id }) => client.listProjectMilestones(id),
    }),
    defineTool({
      connector,
      name: 'anadir_hito_proyecto',
      risk: 'write',
      description: 'Añade un hito (milestone) con una fecha a un proyecto.',
      input: z.object({ proyectoId, titulo: z.string().min(1).max(120), fecha }),
      summarize: async (a) => {
        const p = (await client.listProjects()).find((x) => x.id === a.proyectoId);
        if (!p) throw new Error('Ese proyecto no existe o no está habilitado para el asistente.');
        return `Voy a añadir al proyecto ${p.nombre} el hito ${recorta(a.titulo)} para el ${a.fecha}`;
      },
      execute: async ({ proyectoId: id, ...datos }, { session }) => client.addProjectMilestone(id, datos, originOf(session)),
    }),
    defineTool({
      connector,
      name: 'actualizar_hito_proyecto',
      risk: 'write',
      description: 'Cambia el título o la fecha de un hito de un proyecto.',
      input: z.object({ proyectoId, hitoId, titulo: z.string().min(1).max(120).optional(), fecha: fecha.optional() }).refine((a) => a.titulo !== undefined || a.fecha !== undefined, { message: 'indica al menos un cambio' }),
      summarize: async (a) => {
        const { proyecto, hitos } = await client.listProjectMilestones(a.proyectoId);
        const h = hitos.find((x) => x.id === a.hitoId) ?? hitos.filter((x) => x.titulo.toLowerCase().includes(a.hitoId.toLowerCase()))[0];
        if (!h) throw new Error('No encuentro ese hito en el proyecto.');
        const c = [a.titulo && `título a ${a.titulo}`, a.fecha && `fecha de ${h.fecha} a ${a.fecha}`].filter(Boolean).join(' y ');
        return `Voy a cambiar el hito ${h.titulo} del proyecto ${proyecto}: ${c}`;
      },
      execute: async ({ proyectoId: id, hitoId: hid, ...cambios }, { session }) => client.updateProjectMilestone(id, hid, cambios, originOf(session)),
    }),
  ];
}
