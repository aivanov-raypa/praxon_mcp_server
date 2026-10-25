import { z } from 'zod';
import { defineTool } from './registry.js';

/**
 * Detalle en pantalla: la voz dice lo esencial y las listas o cifras salen como tarjeta en la app, sin leerse en voz alta.
 * No toca ningún sistema: solo envía a la app que habla con el modelo lo que éste quiere mostrar (riesgo read).
 */
export function screenTools() {
  return [
    defineTool({
      connector: 'praxon',
      name: 'mostrar_en_pantalla',
      risk: 'read',
      description:
        'Muestra una tarjeta en la pantalla del usuario con detalle que NO se lee en voz alta: listas de tickets, cifras, fechas, comparativas. Úsala cuando haya más de tres elementos o varios datos; después di por voz solo lo esencial. Cada fila lleva una etiqueta y un valor cortos. estado (opcional) colorea la fila: ok, atencion o critico.',
      input: z.object({
        titulo: z.string().trim().min(1).max(80),
        filas: z
          .array(
            z.object({
              etiqueta: z.string().trim().min(1).max(90),
              valor: z.string().trim().max(160).default(''),
              estado: z.enum(['ok', 'atencion', 'critico']).optional(),
            }),
          )
          .min(1)
          .max(14),
      }),
      execute: async (a, { session }) => {
        const ws = session?.connection;
        if (!ws || ws.readyState !== ws.OPEN) return { mostrada: false, motivo: 'No hay pantalla conectada: cuéntalo por voz.' };
        ws.send(JSON.stringify({ type: 'card', titulo: a.titulo, filas: a.filas }));
        return { mostrada: true };
      },
    }),
  ];
}
