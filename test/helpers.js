import { MemoryAudit } from '../src/audit/log.js';
import { FakeMyraypa } from '../src/connectors/myraypa/fake.js';
import { createMyraypaConnector } from '../src/connectors/myraypa/index.js';
import { FakeGithub } from '../src/integrations/github.js';
import { ScriptedModel } from '../src/model/scripted.js';
import { Orchestrator } from '../src/orchestrator.js';
import { Session } from '../src/session.js';
import { ToolRegistry } from '../src/tools/registry.js';

export const config = { MODEL_DEFAULT: 'test', MAX_TOOL_ITERATIONS: 6, MAX_HISTORY_MESSAGES: 40, CONFIRM_TTL_MS: 60_000 };

export function setup({ model = new ScriptedModel(), now, voice = null } = {}) {
  const myraypa = new FakeMyraypa();
  const github = new FakeGithub();
  const audit = new MemoryAudit();
  const registry = new ToolRegistry().registerConnector(createMyraypaConnector({ client: myraypa, github }));
  const orchestrator = new Orchestrator({ model, registry, audit, config, systemPrompt: 'test', voice, now });
  const session = new Session('sesion-de-prueba-1', 'alex');
  const out = [];
  const emit = (m) => out.push(m);
  const last = (type) => out.filter((m) => m.type === type).at(-1);
  return { myraypa, github, audit, registry, orchestrator, session, out, emit, last };
}

/** Modelo de pruebas: devuelve mensajes preparados en orden. */
export function stubModel(...messages) {
  let i = 0;
  const calls = [];
  return {
    calls,
    async *stream(args) {
      calls.push({ ...args, messages: structuredClone(args.messages) }); // copia: el historial se sigue modificando
      const content = messages[i++] ?? [{ type: 'text', text: 'Fin.' }];
      for (const b of content) if (b.type === 'text') yield { type: 'text', text: b.text };
      yield { type: 'message', content, stopReason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn' };
    },
  };
}

export const use = (name, input, id = `t_${name}`) => ({ type: 'tool_use', id, name, input });
