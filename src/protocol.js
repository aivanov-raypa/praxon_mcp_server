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
    /** La app sabe reproducir audio del servidor en este formato. */
    audio: z.literal('mp3').optional(),
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
  // Propuestas de la revision automatica (no pertenecen a ninguna conversacion: no llevan sessionId).
  z.object({ type: z.literal('proposals_list') }),
  z.object({ type: z.literal('proposals_run') }),
  z.object({
    type: z.literal('proposal_decision'),
    briefingId: z.string().min(1).max(100),
    actionId: z.string().min(1).max(100),
    accepted: z.boolean(),
  }),
]);
