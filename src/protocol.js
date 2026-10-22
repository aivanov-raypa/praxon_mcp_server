import { z } from 'zod';

/**
 * Mensajes app -> servidor. Ver docs/protocol.md.
 * requestId es opcional: si la app lo manda, el servidor lo repite en las respuestas de ese turno.
 */
const sessionId = z.string().min(8).max(100);

export const clientMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('user_text'),
    sessionId,
    text: z.string().trim().min(1).max(2000),
    requestId: z.string().max(64).optional(),
  }),
  z.object({
    type: z.literal('confirm'),
    sessionId,
    actionId: z.string().min(1).max(100),
    accepted: z.boolean(),
  }),
  z.object({
    type: z.literal('cancel'),
    sessionId,
  }),
]);
