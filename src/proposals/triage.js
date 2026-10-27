import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { buildTriagePrompt } from '../prompts.js';
import { serializeResult } from '../tools/result.js';

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

/** Solo se ofrece si existe la herramienta de lanzar agentes. No lanza nada: deja constancia del tipo y del motivo. */
const SUGGEST_TOOL = {
  name: 'sugerir_agente',
  description:
    'Indica que un agente de desarrollo podría trabajar este ticket y de qué tipo es (mejora = nueva funcionalidad; error = corregir un fallo). NO lo lanza: el usuario lo verá como una opción desmarcada dentro de la propuesta de ese ticket.',
  input_schema: {
    type: 'object',
    properties: {
      ticketId: { type: 'string' },
      tipo: { type: 'string', enum: ['mejora', 'error'] },
      motivo: { type: 'string', description: 'Por qué un agente podría resolverlo, en una frase' },
    },
    required: ['ticketId', 'tipo', 'motivo'],
  },
};
const AGENT_TOOL = 'myraypa_lanzar_agente';
const suggestInput = z.object({ ticketId: z.string().min(1), tipo: z.enum(['mejora', 'error']), motivo: z.string().trim().min(3).max(300) });
const grupoDe = (a) => a.grupo ?? `s-${a.id}`;

const proposeInput = z.object({
  herramienta: z.string().min(1),
  parametros: z.record(z.string(), z.unknown()).default({}),
  motivo: z.string().trim().min(3).max(300),
});
const summaryInput = z.object({ resumen: z.string().trim().min(1).max(2000) });

const stableArgs = (o) => JSON.stringify(o, Object.keys(o).sort());
const result = (id, content, isError = false) => ({ type: 'tool_result', tool_use_id: id, content: typeof content === 'string' || Array.isArray(content) ? content : JSON.stringify(content), ...(isError && { is_error: true }) });

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

  #memory;
  #ticketLog;

  #scope;

  #pause;

  constructor({ model, registry, audit, store, config, now = Date.now, memory = null, ticketLog = null, scope = null, pause = null }) {
    this.#pause = pause;
    this.#scope = scope;
    this.#memory = memory;
    this.#ticketLog = ticketLog;
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

  /** Motivo por el que no se debe proponer esto para el ticket (ya descartado, ya propuesto hace poco...), o null. */
  #bloqueo(ticketId, key = null) {
    if (!this.#ticketLog || ticketId == null) return null;
    return this.#ticketLog.blockReason(String(ticketId), key, { dismissDays: this.#config.TRIAGE_DISMISS_DAYS ?? 90, cooldownDays: this.#config.TRIAGE_COOLDOWN_DAYS ?? 14 });
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
  async run({ user, trigger = 'manual', focus = null }) {
    if (this.#pause?.active) return { omitida: 'Praxon está en pausa: no se hacen revisiones.' };
    if (this.#running) return { omitida: 'Ya hay una revisión en curso.' };
    this.#running = true;
    const id = randomUUID();
    const started = this.#now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#config.TRIAGE_TIMEOUT_MS);
    try {
      // Sin tickets indicados, una revisión manual o programada se limita a lo nuevo (tickets creados o comentados desde la
      // última revisión), con tope. Nunca recorre el backlog; si no hay nada nuevo, ni siquiera llama al modelo.
      let scoped = null;
      if (!focus && this.#scope) {
        const p = await this.#scope.pending({ limit: this.#config.TRIAGE_MAX_TICKETS, settle: false });
        if (!p.batch.length) {
          const vacio = { id, createdAt: new Date(started).toISOString(), trigger, resumen: 'No hay tickets nuevos ni comentarios nuevos que revisar desde la última revisión.', acciones: [] };
          if (trigger === 'manual') await this.#store.add(vacio);
          await this.#log({ event: 'triage_run', briefingId: id, trigger, acciones: 0, tickets: [], ms: this.#now() - started });
          return vacio;
        }
        scoped = p.batch;
        focus = p.batch;
      }
      const reads = (t) => t.risk === 'read' && (t.connector === 'myraypa' || t.connector === 'github');
      const maxCode = this.#config.TRIAGE_CODE_MAX_CALLS ?? 12;
      const code = maxCode > 0 && this.#registry.list().some((t) => t.connector === 'github');
      const offered = (t) => reads(t) && (code || t.connector !== 'github');
      const canAgent = Boolean(this.#registry.get(AGENT_TOOL));
      const tools = [...this.#registry.forModel(offered), ...INTERNAL_TOOLS, ...(canAgent ? [SUGGEST_TOOL] : [])];
      const sugerencias = new Map();
      let codeCalls = 0;
      let imageCalls = 0;
      const maxImages = this.#config.TRIAGE_MAX_IMAGES ?? 3;
      const messages = [{ role: 'user', content: focus ? 'Revisa ahora los tickets nuevos indicados.' : 'Haz la revisión ahora.' }];
      const session = { id: `revision-${id}`, user };
      const acciones = [];
      let resumen = '';
      let finished = false;

      for (let step = 0; step < this.#config.TRIAGE_MAX_STEPS && !finished; step++) {
        let message;
        for await (const ev of this.#model.stream({
          system: buildTriagePrompt({ name: this.#config.ASSISTANT_NAME, user, now: new Date(this.#now()), maxActions: this.#config.TRIAGE_MAX_ACTIONS, allowed: [...this.#allowed()], code: code ? maxCode : 0, focus, memoria: this.#memory?.render() }),
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
          } else if (tu.name === 'sugerir_agente' && canAgent) {
            const p = suggestInput.safeParse(tu.input ?? {});
            if (p.success) {
              sugerencias.set(p.data.ticketId, { tipo: p.data.tipo, motivo: p.data.motivo });
              results.push(result(tu.id, { ok: true }));
            } else results.push(result(tu.id, 'Faltan datos: ticketId, tipo (mejora o error) y motivo.', true));
          } else if (tu.name === 'proponer_accion') {
            results.push(result(tu.id, ...(await this.#propose(tu.input, acciones, session))));
          } else {
            const tool = this.#registry.get(tu.name);
            if (!tool || !offered(tool)) {
              results.push(result(tu.id, 'Esa herramienta no está disponible en la revisión. Solo puedes consultar y proponer acciones.', true));
              continue;
            }
            const parsed = tool.input.safeParse(tu.input ?? {});
            if (!parsed.success) {
              results.push(result(tu.id, `Parámetros no válidos (${parsed.error.issues.map((i) => i.message).join('; ')}).`, true));
              continue;
            }
            if (tool.name === 'myraypa_ver_imagen_ticket' && ++imageCalls > maxImages) {
              results.push(result(tu.id, `Has llegado al límite de ${maxImages} imágenes en esta revisión. Continúa con lo que ya has visto.`, true));
              continue;
            }
            if (tool.connector === 'github' && ++codeCalls > maxCode) {
              results.push(result(tu.id, `Has llegado al límite de ${maxCode} consultas de código en esta revisión. Continúa solo con los datos que ya tienes.`, true));
              continue;
            }
            try {
              results.push(result(tu.id, serializeResult(await tool.execute(parsed.data, { session, user, automatica: true }), MAX_RESULT_CHARS)));
            } catch (err) {
              results.push(result(tu.id, err.message, true));
            }
          }
        }
        messages.push({ role: 'user', content: results });
      }

      await this.#agrupar(acciones, sugerencias, session, user);
      const briefing = { id, createdAt: new Date(started).toISOString(), trigger, resumen, acciones };
      // En la revisión de tickets nuevos solo se guarda si hay algo que aprobar: así no se llena la bandeja de avisos vacíos.
      if (focus && !scoped ? acciones.length : resumen || acciones.length) await this.#store.add(briefing);
      if (scoped) await this.#scope.markDone(scoped);
      await this.#ticketLog?.noteProposed(acciones.map((a) => a.ticketId));
      await this.#log({ event: 'triage_run', briefingId: id, trigger, acciones: acciones.length, ...(focus && { tickets: focus.map((f) => f.id) }), ms: this.#now() - started });
      return briefing;
    } catch (err) {
      await this.#log({ event: 'triage_error', trigger, message: err.message });
      throw err;
    } finally {
      clearTimeout(timer);
      this.#running = false;
    }
  }

  /** Revisa solo estos tickets recién creados: [{ id, titulo, proyecto }]. */
  runTickets({ user, tickets, trigger = 'nuevo' }) {
    return this.run({ user, trigger, focus: tickets });
  }

  /** Valida y guarda una propuesta. Devuelve [mensaje para el modelo, esError]. */
  async #propose(input, acciones, session) {
    const p = proposeInput.safeParse(input ?? {});
    if (!p.success) return ['Faltan datos: herramienta, parametros y motivo.', true];
    const { herramienta, parametros, motivo } = p.data;
    if (acciones.length >= this.#config.TRIAGE_MAX_ACTIONS) return [`Ya has propuesto el máximo (${this.#config.TRIAGE_MAX_ACTIONS}). Termina con el resumen.`, true];
    const tool = this.#registry.get(herramienta);
    if (!tool || tool.risk !== 'write' || this.#registry.isDisabled(herramienta) || !this.#allowed().has(herramienta)) {
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
    const ticketId = parsed.data.ticketId != null ? String(parsed.data.ticketId) : null;
    // Un ticket que ya se propuso en esta misma revisión puede recibir más acciones; el bloqueo cuenta lo anterior.
    const bloqueo = this.#bloqueo(ticketId, key);
    if (bloqueo) return [bloqueo, true];
    acciones.push({ id: randomUUID(), herramienta, args: parsed.data, resumen, motivo, estado: 'pendiente', key, ticketId });
    return [{ ok: true, propuesta: resumen }, false];
  }

  /**
   * Una propuesta por ticket: reune las acciones de cada ticket en un grupo (lo que el usuario ve como una sola propuesta)
   * y, si el proyecto lo permite, añade la opción de lanzar un agente de desarrollo. Esa opción nace desmarcada y solo la
   * crea el servidor: el modelo no puede proponer agentes.
   */
  async #agrupar(acciones, sugerencias, session, user) {
    const detalle = this.#registry.get('myraypa_detalle_ticket');
    const lanzar = this.#registry.get(AGENT_TOOL);
    const ids = [];
    for (const a of acciones) if (a.ticketId && !ids.includes(a.ticketId)) ids.push(a.ticketId);
    for (const id of sugerencias.keys()) if (!ids.includes(id) && !this.#bloqueo(id)) ids.push(id);
    const titulos = new Map();
    for (const id of ids) {
      let titulo = null;
      try {
        titulo = (await detalle?.execute({ ticketId: id }, { session, user }))?.titulo ?? null;
      } catch {
        /* sin título: la app mostrará el ticket por su id */
      }
      titulos.set(id, titulo);
    }
    for (const a of acciones) {
      if (a.ticketId) Object.assign(a, { ticket: titulos.get(a.ticketId), grupo: `g-${a.ticketId}` });
      else a.grupo = `s-${a.id}`;
    }
    if (!lanzar) return;
    for (const id of ids) {
      const sug = sugerencias.get(id);
      const parsed = lanzar.input.safeParse({ ticketId: id, tipo: sug?.tipo ?? 'mejora' });
      if (!parsed.success) continue;
      const repetida = [...this.#store.pending().map((x) => x.action), ...acciones].some((a) => a.herramienta === AGENT_TOOL && stableArgs(a.args) === stableArgs(parsed.data));
      if (repetida) continue;
      // Sin acciones propias en esta revisión (solo sugerencia), un ticket ya resuelto antes no recibe la opción de agente.
      if (this.#ticketLog?.blockReason(id, `${AGENT_TOOL}|${stableArgs(parsed.data)}`, { dismissDays: this.#config.TRIAGE_DISMISS_DAYS ?? 90, cooldownDays: 0 })) continue;
      let resumen;
      try {
        resumen = await lanzar.summarize(parsed.data, { session, user });
      } catch {
        continue; // el proyecto no permite agentes o no tiene repositorio: no se ofrece
      }
      acciones.push({
        id: randomUUID(),
        herramienta: AGENT_TOOL,
        args: parsed.data,
        resumen,
        motivo: sug?.motivo ?? 'Que un agente de desarrollo lo trabaje y abra un pull request para tu revisión.',
        estado: 'pendiente',
        key: `${AGENT_TOOL}|${stableArgs(parsed.data)}`,
        ticketId: id,
        ticket: titulos.get(id),
        grupo: `g-${id}`,
        opcional: true,
        origen: 'servidor',
      });
    }
  }

  #permitida(action) {
    const tool = this.#registry.get(action.herramienta);
    if (!tool || tool.risk !== 'write' || this.#registry.isDisabled(tool.name)) return false;
    return action.origen === 'servidor' || this.#allowed().has(action.herramienta);
  }

  async #settle(briefing, action, estado, mensaje, user) {
    Object.assign(action, { estado, mensaje, decididaEn: new Date(this.#now()).toISOString() });
    await this.#store.save();
    if (estado === 'descartada' || estado === 'ejecutada') await this.#ticketLog?.noteResolved(action.ticketId, action.key);
    await this.#log({ event: 'proposal_decision', user, briefingId: briefing.id, actionId: action.id, tool: action.herramienta, estado });
    return { ok: estado === 'ejecutada' || estado === 'descartada', estado, mensaje };
  }

  /** Comprobaciones previas a ejecutar. Devuelve { fail } (ya resuelta) o lo necesario para ejecutar. */
  async #prepare(briefing, action, user) {
    const ageMs = this.#now() - Date.parse(briefing.createdAt);
    if (ageMs > this.#config.PROPOSAL_TTL_HOURS * 3_600_000) return { fail: await this.#settle(briefing, action, 'caducada', 'La propuesta ha caducado. Pide una revisión nueva.', user) };
    const tool = this.#registry.get(action.herramienta);
    if (!tool || !this.#permitida(action)) return { fail: await this.#settle(briefing, action, 'fallida', 'Esa acción ya no está permitida.', user) };
    const parsed = tool.input.safeParse(action.args);
    if (!parsed.success) return { fail: await this.#settle(briefing, action, 'fallida', 'Los datos de la propuesta ya no son válidos.', user) };
    const session = { id: `propuesta-${briefing.id}`, user };
    // Comprobacion de que nada ha cambiado: el resumen se calcula con los datos de ahora y debe coincidir con el aprobado.
    let fresh;
    try {
      fresh = await tool.summarize(parsed.data, { session, user });
    } catch (err) {
      return { fail: await this.#settle(briefing, action, 'obsoleta', `Ha cambiado desde la propuesta: ${err.message}`, user) };
    }
    if (fresh !== action.resumen) return { fail: await this.#settle(briefing, action, 'obsoleta', `Ha cambiado desde la propuesta. Ahora sería: ${fresh}`, user) };
    return { tool, parsed, session };
  }

  async #execute(briefing, action, { tool, parsed, session }, user) {
    const base = { sessionId: session.id, user, tool: tool.name, risk: 'write', args: parsed.data, via: 'proposal', briefingId: briefing.id, actionId: action.id, ...(action.grupo && { grupo: action.grupo }) };
    try {
      await this.#audit.record({ event: 'tool_call_start', ...base });
    } catch {
      return { ok: false, estado: 'pendiente', mensaje: 'No se ha podido registrar la auditoría, así que no se ha ejecutado.' };
    }
    try {
      await tool.execute(parsed.data, { session, user });
      await this.#log({ event: 'tool_call', ...base, ok: true });
      return this.#settle(briefing, action, 'ejecutada', 'Hecho.', user);
    } catch (err) {
      await this.#log({ event: 'tool_call', ...base, ok: false, error: err.message });
      return this.#settle(briefing, action, 'fallida', `No se ha podido ejecutar: ${err.message}`, user);
    }
  }

  /** El usuario aprueba o descarta una accion. */
  async decide({ briefingId, actionId, accepted, user }) {
    if (accepted && this.#pause?.active) return { ok: false, mensaje: this.#pause.message() };
    const briefing = this.#store.get(briefingId);
    const action = briefing?.acciones.find((a) => a.id === actionId);
    if (!action) return { ok: false, mensaje: 'No existe esa propuesta.' };
    if (action.estado !== 'pendiente' || this.#busy.has(actionId)) return { ok: false, estado: action.estado, mensaje: 'Esa propuesta ya se ha resuelto.' };
    const ageMs = this.#now() - Date.parse(briefing.createdAt);
    if (ageMs > this.#config.PROPOSAL_TTL_HOURS * 3_600_000) return this.#settle(briefing, action, 'caducada', 'La propuesta ha caducado. Pide una revisión nueva.', user);
    if (!accepted) {
      await this.#ticketLog?.noteDismissed(action.ticketId);
      return this.#settle(briefing, action, 'descartada', 'Descartada.', user);
    }

    this.#busy.add(actionId);
    try {
      const prep = await this.#prepare(briefing, action, user);
      if (prep.fail) return prep.fail;
      return await this.#execute(briefing, action, prep, user);
    } finally {
      this.#busy.delete(actionId);
    }
  }

  /**
   * El usuario resuelve la propuesta de un ticket entera: `aprobar` son las acciones que marcó; el resto del grupo se
   * descarta. Primero se comprueba que todas las marcadas siguen vigentes y después se ejecutan, los cambios antes que el
   * agente. Si un cambio falla o está obsoleto, el agente no se lanza y su opción sigue pendiente.
   */
  async decideGroup({ briefingId, grupo, aprobar = [], user }) {
    if (aprobar.length && this.#pause?.active) return { ok: false, mensaje: this.#pause.message(), resultados: [] };
    const briefing = this.#store.get(briefingId);
    const miembros = briefing?.acciones.filter((a) => grupoDe(a) === grupo) ?? [];
    if (!miembros.length) return { ok: false, mensaje: 'No existe esa propuesta.', resultados: [] };
    const pendientes = miembros.filter((a) => a.estado === 'pendiente');
    if (!pendientes.length) return { ok: false, mensaje: 'Esa propuesta ya se ha resuelto.', resultados: [] };
    if (pendientes.some((a) => this.#busy.has(a.id))) return { ok: false, mensaje: 'Esa propuesta se está procesando.', resultados: [] };

    const elegidas = pendientes.filter((a) => aprobar.includes(a.id));
    // Descartar la propuesta entera (no marcar nada) es el "no" del usuario sobre ese ticket.
    if (!elegidas.length) await this.#ticketLog?.noteDismissed(pendientes[0].ticketId);
    const resultados = [];
    for (const a of pendientes.filter((x) => !elegidas.includes(x))) resultados.push({ actionId: a.id, ...(await this.#settle(briefing, a, 'descartada', 'No seleccionada.', user)) });
    for (const a of elegidas) this.#busy.add(a.id);
    try {
      const orden = [...elegidas.filter((a) => !a.opcional), ...elegidas.filter((a) => a.opcional)];
      const listas = [];
      let fallo = false;
      for (const a of orden) {
        const prep = await this.#prepare(briefing, a, user);
        if (prep.fail) {
          resultados.push({ actionId: a.id, ...prep.fail });
          if (!a.opcional) fallo = true;
        } else listas.push({ a, prep });
      }
      for (const { a, prep } of listas) {
        if (a.opcional && fallo) {
          resultados.push({ actionId: a.id, ok: false, estado: 'pendiente', mensaje: 'No se ha lanzado el agente porque falló un cambio anterior.' });
          continue;
        }
        const r = await this.#execute(briefing, a, prep, user);
        resultados.push({ actionId: a.id, ...r });
        if (!r.ok && !a.opcional) fallo = true;
      }
    } finally {
      for (const a of elegidas) this.#busy.delete(a.id);
    }
    const hechas = resultados.filter((r) => r.estado === 'ejecutada').length;
    const mal = resultados.find((r) => !r.ok);
    const mensaje = !elegidas.length ? 'Propuesta descartada.' : mal ? `${hechas} de ${elegidas.length} acciones hechas. ${mal.mensaje}` : hechas === 1 ? 'Hecho.' : `Hecho: ${hechas} acciones.`;
    return { ok: !mal, mensaje, resultados };
  }

  /** Vista para la app: sin los parametros internos de las acciones. `pendientes` cuenta propuestas (una por ticket). */
  view({ limit = 10 } = {}) {
    const briefings = this.#store.list().slice(0, limit).map((b) => ({
      id: b.id,
      createdAt: b.createdAt,
      trigger: b.trigger,
      resumen: b.resumen,
      acciones: b.acciones.map((a) => ({
        id: a.id,
        herramienta: a.herramienta,
        resumen: a.resumen,
        motivo: a.motivo,
        estado: a.estado,
        mensaje: a.mensaje,
        ticketId: a.ticketId ?? null,
        ticket: a.ticket ?? null,
        grupo: grupoDe(a),
        opcional: Boolean(a.opcional),
        defecto: !a.opcional,
      })),
    }));
    const pendientes = new Set(this.#store.pending().map(({ briefing, action }) => `${briefing.id}|${grupoDe(action)}`)).size;
    return { type: 'proposals', pendientes, running: this.#running, briefings };
  }
}
