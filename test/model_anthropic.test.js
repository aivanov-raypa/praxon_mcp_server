import { describe, expect, it } from 'vitest';
import { AnthropicModel, isThinkingBindingError, withoutThinking } from '../src/model/anthropic.js';
import { buildSystemPrompt } from '../src/prompts.js';

const bindingError = Object.assign(
  new Error('400 {"error":{"message":"messages.3.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation."}}'),
  { status: 400 },
);

/** Cliente falso: devuelve lo que se le indique en cada llamada y anota los mensajes recibidos. */
function fakeClient(...results) {
  const calls = [];
  return {
    calls,
    messages: {
      stream(body) {
        calls.push(structuredClone(body));
        const r = results[calls.length - 1];
        return {
          async *[Symbol.asyncIterator]() {
            if (r instanceof Error) throw r;
            yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hola' } };
          },
          async finalMessage() {
            return { content: [{ type: 'text', text: 'hola' }], stop_reason: 'end_turn' };
          },
        };
      },
    },
  };
}

const history = [
  { role: 'user', content: 'uno' },
  { role: 'assistant', content: [{ type: 'thinking', thinking: 'x', signature: 's' }, { type: 'text', text: 'dos' }] },
  { role: 'user', content: 'tres' },
];
const collect = async (model, messages) => {
  const out = [];
  for await (const ev of model.stream({ system: 's', messages, tools: [], model: 'm' })) out.push(ev);
  return out;
};

describe('AnthropicModel', () => {
  it('reconoce el error de bloques de razonamiento y no otros 400', () => {
    expect(isThinkingBindingError(bindingError)).toBe(true);
    expect(isThinkingBindingError(Object.assign(new Error('400 invalid max_tokens'), { status: 400 }))).toBe(false);
    expect(isThinkingBindingError(Object.assign(new Error('thinking signature'), { status: 500 }))).toBe(false);
  });

  it('withoutThinking quita el razonamiento y los mensajes que se quedan vacíos, sin tocar el original', () => {
    const msgs = [...history, { role: 'assistant', content: [{ type: 'redacted_thinking', data: 'd' }] }, { role: 'user', content: 'cuatro' }];
    const out = withoutThinking(msgs);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'user']);
    expect(out[1].content).toEqual([{ type: 'text', text: 'dos' }]);
    expect(msgs[1].content).toHaveLength(2);
  });

  it('ante el error de ligadura reintenta una vez sin razonamiento', async () => {
    const client = fakeClient(bindingError, null);
    const out = await collect(new AnthropicModel({ client }), history);
    expect(client.calls).toHaveLength(2);
    expect(JSON.stringify(client.calls[0].messages)).toContain('thinking');
    expect(JSON.stringify(client.calls[1].messages)).not.toContain('"thinking"');
    expect(out.at(-1)).toMatchObject({ type: 'message', stopReason: 'end_turn' });
  });

  it('otros errores se propagan sin reintentar', async () => {
    const client = fakeClient(Object.assign(new Error('500 boom'), { status: 500 }));
    await expect(collect(new AnthropicModel({ client }), history)).rejects.toThrow('boom');
    expect(client.calls).toHaveLength(1);
  });
});

describe('prompt de sistema estable', () => {
  it('es idéntico a cualquier hora del mismo día y cambia al día siguiente', () => {
    const a = buildSystemPrompt({ user: 'alex', now: new Date('2026-10-23T09:01:00Z') });
    const b = buildSystemPrompt({ user: 'alex', now: new Date('2026-10-23T09:02:30Z') });
    const c = buildSystemPrompt({ user: 'alex', now: new Date('2026-10-24T09:01:00Z') });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
