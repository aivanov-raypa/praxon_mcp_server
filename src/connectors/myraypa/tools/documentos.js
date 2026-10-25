import { z } from 'zod';
import { defineTool } from '../../../tools/registry.js';
import { markdownToPdf } from '../../../documents/pdf.js';
import { originOf, proyectoId, recorta, ticketId } from './shared.js';

const TITULO_DOCS = 'Documentación';
const sinAcentos = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const MAX_CONTENIDO = 30_000;

/** Nombre de archivo a partir del título: sin acentos ni símbolos. */
export function nombreArchivo(titulo, formato) {
  const base = sinAcentos(titulo).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'documento';
  return `${base}.${formato}`;
}

/** Quita del cuerpo un primer encabezado idéntico al título (el PDF y el .md ya lo llevan arriba). */
export function cuerpoSinTitulo(titulo, contenido) {
  const m = /^\s*#\s+(.+?)\s*(?:\n|$)/.exec(contenido);
  return m && sinAcentos(m[1]) === sinAcentos(titulo) ? contenido.slice(m[0].length) : contenido;
}

/** Ticket "Documentación" de un proyecto, o null si aún no existe. */
async function ticketDocumentacion(client, proyecto) {
  const { tickets = [] } = await client.listTickets({ proyectoId: proyecto, texto: 'Documentacion', mostrar: 'todos', limit: 10 });
  return tickets.find((t) => sinAcentos(t.titulo) === sinAcentos(TITULO_DOCS)) ?? null;
}

/**
 * Crea un documento con lo que el usuario ha dictado (PDF o Markdown) y lo adjunta a un ticket o a un comentario. Para un
 * proyecto lo deja en su ticket "Documentación" (lo crea si no existe). Escribe en MyRAYPA: siempre pide confirmación.
 */
export function documentosTools(client) {
  const connector = 'myraypa';
  return [
    defineTool({
      connector,
      name: 'guardar_documento',
      risk: 'write',
      description:
        'Redacta un documento (por ejemplo una tarea o un proyecto que el usuario acaba de definir) y lo adjunta como archivo. Indica ticketId para adjuntarlo a un ticket, o proyectoId para dejarlo en el ticket "Documentación" del proyecto (se crea si no existe). destino "comentario" lo adjunta dentro de un comentario nuevo del ticket. formato "pdf" (por defecto) o "md". El contenido va en Markdown (encabezados #, listas, **negrita**) y debe ser fiel a lo que el usuario ha dicho: no inventes datos. Si faltan datos importantes, pregúntalos antes.',
      input: z
        .object({
          ticketId: ticketId.optional(),
          proyectoId: proyectoId.optional(),
          titulo: z.string().trim().min(3).max(120),
          contenido: z.string().min(20).max(MAX_CONTENIDO),
          formato: z.enum(['pdf', 'md']).default('pdf'),
          destino: z.enum(['ticket', 'comentario']).default('ticket'),
          comentario: z.string().trim().max(400).optional().describe('Texto del comentario si destino es "comentario"'),
        })
        .refine((a) => (a.ticketId != null) !== (a.proyectoId != null), { message: 'indica ticketId o proyectoId, uno solo' })
        .refine((a) => a.proyectoId == null || a.destino === 'ticket', { message: 'en un proyecto el documento va adjunto al ticket Documentación' }),
      summarize: async (a) => {
        const archivo = nombreArchivo(a.titulo, a.formato);
        const resumen = `«${a.titulo}» (${a.formato.toUpperCase()}, ${a.contenido.length} caracteres: ${recorta(cuerpoSinTitulo(a.titulo, a.contenido).replace(/\s+/g, ' ').trim(), 70)})`;
        if (a.ticketId) {
          const tk = await client.getTicket(a.ticketId);
          return `Voy a crear el documento ${resumen} y adjuntarlo ${a.destino === 'comentario' ? 'en un comentario del' : 'al'} ticket ${tk.titulo} como ${archivo}`;
        }
        const proyecto = (await client.listProjects()).find((p) => p.id === a.proyectoId);
        if (!proyecto) throw new Error('Ese proyecto no existe o no está habilitado para el asistente.');
        const existe = await ticketDocumentacion(client, a.proyectoId);
        return `Voy a crear el documento ${resumen} y adjuntarlo como ${archivo} al ticket ${TITULO_DOCS} del proyecto ${proyecto.nombre}${existe ? '' : ' (que todavía no existe: lo creo)'}`;
      },
      execute: async (a, { session }) => {
        const origin = originOf(session);
        const nombre = nombreArchivo(a.titulo, a.formato);
        const cuerpo = cuerpoSinTitulo(a.titulo, a.contenido).trim();
        const buffer = a.formato === 'pdf' ? markdownToPdf({ titulo: a.titulo, markdown: cuerpo }) : Buffer.from(`# ${a.titulo}\n\n${cuerpo}\n`, 'utf8');
        let id = a.ticketId;
        let creado = false;
        if (!id) {
          let tk = await ticketDocumentacion(client, a.proyectoId);
          if (!tk) {
            tk = await client.createTicket({ proyectoId: a.proyectoId, titulo: TITULO_DOCS, descripcion: 'Documentos del proyecto redactados con Praxon.', prioridad: 'baja' }, origin);
            creado = true;
          }
          id = tk.id;
        }
        const r = await client.attachDocument(id, { nombre, buffer, destino: a.destino, comentario: a.comentario }, origin);
        return { ...r, formato: a.formato, ...(creado && { ticketDocumentacionCreado: true }) };
      },
    }),
  ];
}
