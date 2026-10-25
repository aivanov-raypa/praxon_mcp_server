import { z } from 'zod';

/** Prioridades de los tickets de MyRAYPA. No existe "urgente": lo más alto es "alta". */
export const PRIORIDADES = ['ninguna', 'baja', 'media', 'alta'];

export const ticketId = z.string().min(1).describe('Identificador del ticket (campo id que devuelven listar_tickets y detalle_ticket)');
export const proyectoId = z.string().min(1).describe('Identificador del proyecto (ver listar_proyectos)');
export const estado = z.string().min(1).max(60).describe('Estado del ticket: título de una columna del proyecto, por ejemplo "En progreso" (los estados de cada proyecto salen en listar_proyectos)');

/** Quien origina el cambio, para que MyRAYPA lo registre en el historial del ticket. */
export const originOf = (session) => ({ type: 'voice-assistant', user: session.user, sessionId: session.id });

/**
 * Marca de orden explícita: el modelo la pone a true SOLO si el usuario acaba de pedir ese cambio con claridad sobre un
 * ticket concreto ("añade un comentario…", "pon la fecha…"). El servidor decide con ella (y con otras comprobaciones)
 * si lo ejecuta sin pedir confirmación; si es una propuesta suya, debe dejarla sin poner.
 */
export const ordenExplicita = z.boolean().optional().describe('true solo si el usuario ha ordenado este cambio de forma explícita en su último mensaje; no la pongas si lo propones tú');

export const recorta = (texto, n = 80) => (texto.length > n ? `${texto.slice(0, n - 1)}…` : texto);
