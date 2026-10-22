import { z } from 'zod';

/** Prioridades de los tickets de MyRAYPA. No existe "urgente": lo más alto es "alta". */
export const PRIORIDADES = ['ninguna', 'baja', 'media', 'alta'];

export const ticketId = z.string().min(1).describe('Identificador del ticket (campo id que devuelven listar_tickets y detalle_ticket)');
export const proyectoId = z.string().min(1).describe('Identificador del proyecto (ver listar_proyectos)');
export const estado = z.string().min(1).max(60).describe('Estado del ticket: título de una columna del proyecto, por ejemplo "En progreso" (los estados de cada proyecto salen en listar_proyectos)');

/** Quien origina el cambio, para que MyRAYPA lo registre en el historial del ticket. */
export const originOf = (session) => ({ type: 'voice-assistant', user: session.user, sessionId: session.id });

export const recorta = (texto, n = 80) => (texto.length > n ? `${texto.slice(0, n - 1)}…` : texto);
