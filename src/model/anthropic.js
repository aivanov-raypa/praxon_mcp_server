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
export class AnthropicModel {
  #client;
  #maxTokens;

  constructor({ apiKey, maxTokens = 1024, client }) {
    this.#client = client ?? new Anthropic({ apiKey });
    this.#maxTokens = maxTokens;
  }

  async *stream({ system, messages, tools, model, signal }) {
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
    yield { type: 'message', content: final.content, stopReason: final.stop_reason };
  }
}
