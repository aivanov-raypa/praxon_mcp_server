import { z } from 'zod';

export const ESTADOS = ['abierto', 'en_curso', 'pendiente_revision', 'bloqueado', 'cerrado'];
export const PRIORIDADES = ['baja', 'media', 'alta', 'urgente'];

export const ticketId = z.number().int().positive().describe('Número del ticket');
export const proyectoId = z.string().min(1).describe('Identificador del proyecto (ver listar_proyectos)');

/** Quien origina el cambio, para que MyRAYPA lo registre en el historial del ticket. */
export const originOf = (session) => ({ type: 'voice-assistant', user: session.user, sessionId: session.id });

export const recorta = (texto, n = 80) => (texto.length > n ? `${texto.slice(0, n - 1)}…` : texto);
