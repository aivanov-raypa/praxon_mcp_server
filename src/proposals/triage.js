import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { buildTriagePrompt } from '../prompts.js';

const MAX_RESULT_CHARS = 8000;

/** Herramientas propias de la revision. El modelo NO puede ejecutar escrituras: solo proponerlas. */
const INTERNAL_TOOLS = [
  {
    name: 'proponer_accion',
    description:
      'Prepara una acción de escritura para que el usuario la apruebe después. NO la ejecuta. Indica la herramienta, sus parámetros exactos y un motivo breve que el usuario pueda leer.',
    input_schema: {
      type: 'object',
      properties: {
        herramienta: { type: 'string', description: 'Nombre exacto de la herramienta de escritura permitida' },
        parametros: { type: 'object', description: 'Parámetros de esa herramienta (los mismos que tendría al usarla)' },
        motivo: { type: 'string', description: 'Por qué se propone, en una frase' },
      },
      required: ['herramienta', 'parametros', 'motivo'],
    },
  },
  {
    name: 'entregar_resumen',
    description: 'Termina la revisión entregando el resumen para el usuario (varias frases, sin markdown, pensado para leerse en voz alta).',
    input_schema: { type: 'object', properties: { resumen: { type: 'string' } }, required: ['resumen'] },
  },
];

const proposeInput = z.object({
  herramienta: z.string().min(1),
  parametros: z.record(z.string(), z.unknown()).default({}),
  motivo: z.string().trim().min(3).max(300),
});
const summaryInput = z.object({ resumen: z.string().trim().min(1).max(2000) });

const stableArgs = (o) => JSON.stringify(o, Object.keys(o).sort());
const result = (id, content, isError = false) => ({ type: 'tool_result', tool_use_id: id, content: typeof content === 'string' ? content : JSON.stringify(content), ...(isError && { is_error: true }) });

/**
 * Revision autonoma: el modelo lee los tickets con las herramientas de consulta, analiza y deja un resumen con
 * acciones propuestas. Nada se escribe en MyRAYPA hasta que el usuario aprueba una accion (decide()), y al aprobarla
 * se vuelve a comprobar que el ticket no ha cambiado desde que se propuso.
 */
export class Triage {
  #model;
  #registry;
  #audit;
  #store;
  #config;
  #now;
  #running = false;
  #busy = new Set();

  constructor({ model, registry, audit, store, config, now = Date.now }) {
    this.#model = model;
    this.#registry = registry;
    this.#audit = audit;
    this.#store = store;
    this.#config = config;
    this.#now = now;
  }

  get running() {
    return this.#running;
  }

  #allowed() {
    return new Set(this.#config.TRIAGE_ALLOWED_TOOLS);
  }

  async #log(event) {
    try {
      await this.#audit.record(event);
    } catch (err) {
      console.error('[auditoria]', event.event, err.message);
    }
  }

  /** @returns {Promise<object>} la revision creada, o { omitida } si ya habia una en curso. */
  async run({ user, trigger = 'manual' }) {
    if (this.#running) return { omitida: 'Ya hay una revisión en curso.' };
    this.#running = true;
    const id = randomUUID();
    const started = this.#now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#config.TRIAGE_TIMEOUT_MS);
    try {
      const reads = (t) => t.risk === 'read' && t.connector === 'myraypa';
      const tools = [...this.#registry.forModel(reads), ...INTERNAL_TOOLS];
      const messages = [{ role: 'user', content: 'Haz la revisión ahora.' }];
      const session = { id: `revision-${id}`, user };
      const acciones = [];
      let resumen = '';
      let finished = false;

      for (let step = 0; step < this.#config.TRIAGE_MAX_STEPS && !finished; step++) {
        let message;
        for await (const ev of this.#model.stream({
          system: buildTriagePrompt({ name: this.#config.ASSISTANT_NAME, user, now: new Date(this.#now()), maxActions: this.#config.TRIAGE_MAX_ACTIONS, allowed: [...this.#allowed()] }),
          messages,
          tools,
          model: this.#config.TRIAGE_MODEL ?? this.#config.MODEL_DEFAULT,
          signal: controller.signal,
        })) {
          if (ev.type === 'message') message = ev;
        }
        if (!message) throw new Error('el modelo no devolvió ningún mensaje');
        messages.push({ role: 'assistant', content: message.content });
        const toolUses = message.content.filter((b) => b.type === 'tool_use');
        if (!toolUses.length) {
          resumen = resumen || message.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
          break;
        }
        const results = [];
        for (const tu of toolUses) {
          if (tu.name === 'entregar_resumen') {
            const p = summaryInput.safeParse(tu.input ?? {});
            if (p.success) {
              resumen = p.data.resumen;
              finished = true;
              results.push(result(tu.id, { ok: true }));
            } else results.push(result(tu.id, 'Falta el resumen.', true));
          } else if (tu.name === 'proponer_accion') {
            results.push(result(tu.id, ...(await this.#propose(tu.input, acciones, session))));
          } else {
            const tool = this.#registry.get(tu.name);
            if (!tool || !reads(tool)) {
              results.push(result(tu.id, 'Esa herramienta no está disponible en la revisión. Solo puedes consultar y proponer acciones.', true));
              continue;
            }
            const parsed = tool.input.safeParse(tu.input ?? {});
            if (!parsed.success) {
              results.push(result(tu.id, `Parámetros no válidos (${parsed.error.issues.map((i) => i.message).join('; ')}).`, true));
              continue;
            }
            try {
              const s = JSON.stringify((await tool.execute(parsed.data, { session, user })) ?? { ok: true });
              results.push(result(tu.id, s.length <= MAX_RESULT_CHARS ? s : JSON.stringify({ recortado: true, texto: s.slice(0, MAX_RESULT_CHARS) })));
            } catch (err) {
              results.push(result(tu.id, err.message, true));
            }
          }
        }
        messages.push({ role: 'user', content: results });
      }

      const briefing = { id, createdAt: new Date(started).toISOString(), trigger, resumen, acciones };
      if (resumen || acciones.length) await this.#store.add(briefing);
      await this.#log({ event: 'triage_run', briefingId: id, trigger, acciones: acciones.length, ms: this.#now() - started });
      return briefing;
    } catch (err) {
      await this.#log({ event: 'triage_error', trigger, message: err.message });
      throw err;
    } finally {
      clearTimeout(timer);
      this.#running = false;
    }
  }

  /** Valida y guarda una propuesta. Devuelve [mensaje para el modelo, esError]. */
  async #propose(input, acciones, session) {
    const p = proposeInput.safeParse(input ?? {});
    if (!p.success) return ['Faltan datos: herramienta, parametros y motivo.', true];
    const { herramienta, parametros, motivo } = p.data;
    if (acciones.length >= this.#config.TRIAGE_MAX_ACTIONS) return [`Ya has propuesto el máximo (${this.#config.TRIAGE_MAX_ACTIONS}). Termina con el resumen.`, true];
    const tool = this.#registry.get(herramienta);
    if (!tool || tool.risk !== 'write' || !this.#allowed().has(herramienta)) {
      return [`La herramienta ${herramienta} no está permitida para propuestas. Permitidas: ${[...this.#allowed()].join(', ')}.`, true];
    }
    const parsed = tool.input.safeParse(parametros);
    if (!parsed.success) return [`Parámetros no válidos (${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}).`, true];
    let resumen;
    try {
      resumen = await tool.summarize(parsed.data, { session, user: session.user });
    } catch (err) {
      return [`No se puede proponer: ${err.message}`, true];
    }
    const key = `${herramienta}|${stableArgs(parsed.data)}`;
    const repetida = [...this.#store.pending().map((x) => x.action), ...acciones].some((a) => a.herramienta === herramienta && stableArgs(a.args) === stableArgs(parsed.data));
    if (repetida) return ['Esa acción ya está propuesta y pendiente. No la repitas.', true];
    acciones.push({ id: randomUUID(), herramienta, args: parsed.data, resumen, motivo, estado: 'pendiente', key });
    return [{ ok: true, propuesta: resumen }, false];
  }

  /** El usuario aprueba o descarta una accion. */
  async decide({ briefingId, actionId, accepted, user }) {
    const briefing = this.#store.get(briefingId);
    const action = briefing?.acciones.find((a) => a.id === actionId);
    if (!action) return { ok: false, mensaje: 'No existe esa propuesta.' };
    if (action.estado !== 'pendiente' || this.#busy.has(actionId)) return { ok: false, estado: action.estado, mensaje: 'Esa propuesta ya se ha resuelto.' };
    const finish = async (estado, mensaje, extra = {}) => {
      Object.assign(action, { estado, mensaje, decididaEn: new Date(this.#now()).toISOString() }, extra);
      await this.#store.save();
      await this.#log({ event: 'proposal_decision', user, briefingId, actionId, tool: action.herramienta, estado });
      return { ok: estado === 'ejecutada' || estado === 'descartada', estado, mensaje };
    };

    const ageMs = this.#now() - Date.parse(briefing.createdAt);
    if (ageMs > this.#config.PROPOSAL_TTL_HOURS * 3_600_000) return finish('caducada', 'La propuesta ha caducado. Pide una revisión nueva.');
    if (!accepted) return finish('descartada', 'Descartada.');

    this.#busy.add(actionId);
    try {
      const tool = this.#registry.get(action.herramienta);
      if (!tool || tool.risk !== 'write' || !this.#allowed().has(action.herramienta)) return finish('fallida', 'Esa acción ya no está permitida.');
      const parsed = tool.input.safeParse(action.args);
      if (!parsed.success) return finish('fallida', 'Los datos de la propuesta ya no son válidos.');
      const session = { id: `propuesta-${briefingId}`, user };
      // Comprobacion de que nada ha cambiado: el resumen se calcula con los datos de ahora y debe coincidir con el aprobado.
      let fresh;
      try {
        fresh = await tool.summarize(parsed.data, { session, user });
      } catch (err) {
        return finish('obsoleta', `Ha cambiado desde la propuesta: ${err.message}`);
      }
      if (fresh !== action.resumen) return finish('obsoleta', `Ha cambiado desde la propuesta. Ahora sería: ${fresh}`);

      const base = { sessionId: session.id, user, tool: tool.name, risk: 'write', args: parsed.data, via: 'proposal', briefingId, actionId };
      try {
        await this.#audit.record({ event: 'tool_call_start', ...base });
      } catch {
        return { ok: false, estado: 'pendiente', mensaje: 'No se ha podido registrar la auditoría, así que no se ha ejecutado.' };
      }
      try {
        await tool.execute(parsed.data, { session, user });
        await this.#log({ event: 'tool_call', ...base, ok: true });
        return finish('ejecutada', 'Hecho.');
      } catch (err) {
        await this.#log({ event: 'tool_call', ...base, ok: false, error: err.message });
        return finish('fallida', `No se ha podido ejecutar: ${err.message}`);
      }
    } finally {
      this.#busy.delete(actionId);
    }
  }

  /** Vista para la app: sin los parametros internos de las acciones. */
  view({ limit = 10 } = {}) {
    const briefings = this.#store.list().slice(0, limit).map((b) => ({
      id: b.id,
      createdAt: b.createdAt,
      trigger: b.trigger,
      resumen: b.resumen,
      acciones: b.acciones.map(({ id, herramienta, resumen, motivo, estado, mensaje }) => ({ id, herramienta, resumen, motivo, estado, mensaje })),
    }));
    return { type: 'proposals', pendientes: this.#store.pending().length, running: this.#running, briefings };
  }
}
