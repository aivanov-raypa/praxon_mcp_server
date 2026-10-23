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
  // Dictado: la app envia audio PCM (16 kHz, 16 bits, mono) en mensajes binarios entre stt_start y stt_stop.
  z.object({ type: z.literal('stt_start') }),
  z.object({ type: z.literal('stt_stop') }), // termina y entrega lo dicho hasta ahora
  z.object({ type: z.literal('stt_cancel') }), // descarta el dictado sin entregar nada
  // Frases propias de la app ("No te he entendido…", avisos): el servidor las sintetiza con la voz de ElevenLabs.
  z.object({ type: z.literal('speak'), id: z.string().min(1).max(64), text: z.string().trim().min(1).max(300) }),
  // Propuestas de la revision automatica (no pertenecen a ninguna conversacion: no llevan sessionId).
  z.object({ type: z.literal('proposals_list') }),
  z.object({ type: z.literal('proposals_run') }),
  z.object({
    type: z.literal('proposal_decision'),
    briefingId: z.string().min(1).max(100),
    actionId: z.string().min(1).max(100),
    accepted: z.boolean(),
  }),
  // Panel de consumos (solo lectura). refresh=true ignora la cache.
  z.object({ type: z.literal('usage_get'), refresh: z.boolean().optional() }),
  // Agentes de desarrollo. La fusion solo existe aqui (nunca como herramienta del modelo): va atada al SHA revisado
  // y al numero de PR que el usuario teclea en la app.
  z.object({ type: z.literal('agents_list') }),
  z.object({ type: z.literal('agent_diff'), runId: z.string().min(1).max(64) }),
  z.object({
    type: z.literal('agent_merge'),
    runId: z.string().min(1).max(64),
    sha: z.string().regex(/^[0-9a-f]{40}$/),
    numero: z.number().int().positive(),
  }),
]);
