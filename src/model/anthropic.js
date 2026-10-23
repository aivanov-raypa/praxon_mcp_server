import Anthropic from '@anthropic-ai/sdk';

/**
 * Proveedor del modelo: API de Anthropic. Alternativas con la misma interfaz (Bedrock o Vertex en region UE)
 * quedan como decision abierta del proyecto: solo habria que cambiar este fichero.
 *
 * Interfaz de un proveedor:
 *   stream({ system, messages, tools, model, signal }) -> async iterable de
 *     { type: 'text', text }                         (texto en streaming)
 *     { type: 'message', content, stopReason }       (mensaje completo, al final)
 */
export const isThinkingBindingError = (err) =>
  err?.status === 400 && /thinking/i.test(String(err.message)) && /(signature|bound|binding)/i.test(String(err.message));

/** Copia de los mensajes sin bloques de razonamiento (y sin mensajes del asistente que se queden vacíos). */
export function withoutThinking(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      const content = m.content.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking');
      if (content.length) out.push({ ...m, content });
    } else {
      out.push(m);
    }
  }
  return out;
}

export class AnthropicModel {
  #client;
  #maxTokens;
  #onUsage;

  constructor({ apiKey, maxTokens = 1024, client, onUsage = null }) {
    this.#onUsage = onUsage;
    this.#client = client ?? new Anthropic({ apiKey });
    this.#maxTokens = maxTokens;
  }

  async *stream({ system, messages, tools, model, signal }) {
    try {
      yield* this.#run({ system, messages, tools, model, signal });
    } catch (err) {
      // Los bloques de razonamiento del historial van ligados al prompt con el que se crearon. Si ya no coincide (p. ej. cambió el
      // día en mitad de una conversación), la API los rechaza con un 400: se reintenta una vez sin ellos en vez de fallar.
      if (!isThinkingBindingError(err)) throw err;
      yield* this.#run({ system, messages: withoutThinking(messages), tools, model, signal });
    }
  }

  async *#run({ system, messages, tools, model, signal }) {
    const stream = this.#client.messages.stream(
      {
        model,
        max_tokens: this.#maxTokens,
        // Las instrucciones y las herramientas se repiten en cada llamada: se cachean.
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        tools,
        messages,
      },
      { signal },
    );
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield { type: 'text', text: event.delta.text };
      }
    }
    const final = await stream.finalMessage();
    const u = final.usage;
    if (u && this.#onUsage) {
      try {
        this.#onUsage({
          model: final.model ?? model,
          input: u.input_tokens ?? 0,
          output: u.output_tokens ?? 0,
          cacheRead: u.cache_read_input_tokens ?? 0,
          cacheWrite: u.cache_creation_input_tokens ?? 0,
        });
      } catch {
        /* el contador nunca debe romper una respuesta */
      }
    }
    yield { type: 'message', content: final.content, stopReason: final.stop_reason };
  }
}
