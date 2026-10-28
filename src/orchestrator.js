import { randomUUID } from 'node:crypto';
import { SentenceChunker } from './chunker.js';
import { CONFIRMATION_ERRORS, checkConfirmation, createPending } from './confirmations.js';
import { appendUserText, trimHistory } from './session.js';
import { MAX_BATCH, resumenDeLote } from './batch.js';
import { serializeResult, resultText } from './tools/result.js';

const MAX_RESULT_CHARS = 8000;

/** Un turno = una peticion del usuario (o una confirmacion) hasta que el asistente termina de responder. */
function newTurn(requestId, audio = false, byUser = false) {
  const controller = new AbortController();
  return {
    id: randomUUID(),
    requestId,
    /** La app admite audio del servidor en este turno. */
    audio,
    /** El turno nace de un mensaje del usuario (no de una confirmación): solo entonces puede haber una orden explícita. */
    byUser,
    /** Cola ordenada de mensajes hacia la app: el audio de cada frase se sintetiza en paralelo pero se envia en orden. */
    out: Promise.resolve(),
    signal: controller.signal,
    get aborted() {
      return controller.signal.aborted;
    },
    abort: () => controller.abort(),
  };
}

const serialize = (out) => serializeResult(out, MAX_RESULT_CHARS);

const toolError = (id, message) => ({ type: 'tool_result', tool_use_id: id, is_error: true, content: `Error: ${message}` });

/**
 * Bucle modelo <-> herramientas. El modelo solo llama a herramientas del registro; las de escritura
 * quedan pendientes hasta que el usuario confirma. Toda accion deja rastro en el log de auditoria.
 *
 * emit(msg) envia un mensaje a la app: assistant_chunk | assistant_done | confirm_request | error.
 */
export class Orchestrator {
  #model;
  #registry;
  #audit;
  #config;
  #system;
  #now;
  #voice;
  #pause;

  constructor({ model, registry, audit, config, systemPrompt, voice = null, pause = null, now = Date.now }) {
    this.#pause = pause;
    this.#voice = voice;
    this.#model = model;
    this.#registry = registry;
    this.#audit = audit;
    this.#config = config;
    this.#system = systemPrompt;
    this.#now = now;
  }

  // ---------- API publica ----------

  handleUserText(session, { text, requestId, audio }, emit) {
    const turn = this.#startTurn(session, requestId, audio === 'mp3', true); // interrumpe de inmediato el turno anterior
    return session.runExclusive(async () => {
      if (session.pending) {
        // "Solo se ejecuta si el siguiente mensaje es una confirmacion explicita": cualquier otro mensaje la anula.
        await this.#log({ event: 'confirm_result', sessionId: session.id, actionId: session.pending.actionId, outcome: 'discarded_new_message' });
        session.pending = null;
      }
      await this.#log({ event: 'user_text', sessionId: session.id, user: session.user, text, requestId });
      appendUserText(session.history, text);
      trimHistory(session.history, this.#config.MAX_HISTORY_MESSAGES);
      if (turn.aborted) return; // lo ha superado un mensaje mas reciente
      await this.#loop(session, turn, emit);
      await turn.out; // no termina el turno hasta haber enviado todo (incluido el audio)
    });
  }

  handleConfirm(session, { actionId, accepted }, emit) {
    return session.runExclusive(async () => {
      const check = checkConfirmation(session.pending, actionId, this.#now());
      if (!check.ok) {
        await this.#log({ event: 'confirm_result', sessionId: session.id, actionId, outcome: check.reason });
        if (check.reason === 'expired') session.pending = null;
        emit({ type: 'error', message: CONFIRMATION_ERRORS[check.reason] });
        return;
      }
      const pending = session.pending;
      session.pending = null;
      const turn = this.#startTurn(session, pending.turn.requestId, pending.turn.audio);
      const { assistantContent, toolUses, results } = pending.turn;
      await this.#log({
        event: 'confirm_result',
        sessionId: session.id,
        user: session.user,
        actionId,
        tool: pending.actions.map((a) => a.toolName).join(','),
        outcome: accepted ? 'accepted' : 'declined',
      });

      // Todas las acciones del lote se aceptan o se rechazan a la vez; cada una se ejecuta (y se audita) por separado.
      for (const a of pending.actions) {
        const tu = toolUses[a.index];
        results[a.index] = accepted
          ? await this.#exec(this.#registry.get(a.toolName), a.args, tu, session)
          : {
              type: 'tool_result',
              tool_use_id: tu.id,
              content: JSON.stringify({ cancelada: true, mensaje: 'El usuario ha cancelado la acción. No se ha ejecutado nada.' }),
            };
      }
      if (accepted) this.#resultCard(pending.actions, results, emit);
      const outcome = this.#finishTools(session, turn, assistantContent, toolUses, results);
      if (outcome === 'done') await this.#loop(session, turn, emit);
      await turn.out;
    });
  }

  /** Tarjeta con lo que se acaba de hacer (plan visible): qué se ha ejecutado y qué ha fallado. No se lee en voz alta. */
  #resultCard(actions, results, emit) {
    const MAX = 12;
    const clip = (s) => String(s).replace(/^Voy a /, '').replace(/^./, (c) => c.toUpperCase()).slice(0, 90);
    const filas = actions.slice(0, MAX).map((a) => {
      const fallo = results[a.index]?.is_error;
      return { etiqueta: clip(a.summary), valor: fallo ? 'No se ha hecho' : '', estado: fallo ? 'critico' : 'ok' };
    });
    if (actions.length > MAX) filas.push({ etiqueta: `y ${actions.length - MAX} más`, valor: '' });
    if (actions.some((a, i) => a.toolName === 'myraypa_actualizar_ticket' && !results[a.index]?.is_error)) {
      filas.push({ etiqueta: 'Deshacer', valor: 'di «deshaz eso»' });
    }
    emit({ type: 'card', titulo: actions.length === 1 ? 'Hecho' : `Hecho · ${actions.length} cambios`, filas });
  }

  /** El usuario pide parar: corta la respuesta en curso y descarta la accion pendiente. */
  async cancel(session, emit) {
    this.abortTurn(session);
    await this.dropPending(session, 'cancelled_by_user');
    emit({ type: 'assistant_done' });
  }

  abortTurn(session) {
    session.currentTurn?.abort();
  }

  async dropPending(session, outcome) {
    if (!session.pending) return;
    const { actionId } = session.pending;
    session.pending = null;
    await this.#log({ event: 'confirm_result', sessionId: session.id, actionId, outcome });
  }

  // ---------- Internos ----------

  #startTurn(session, requestId, audio = false, byUser = false) {
    session.currentTurn?.abort();
    const turn = newTurn(requestId, audio, byUser);
    session.currentTurn = turn;
    return turn;
  }

  /** Encola un mensaje para la app, manteniendo el orden. No se envia si el turno se ha interrumpido. */
  #say(turn, emit, msg) {
    turn.out = turn.out.then(() => this.#deliver(turn, emit, msg));
  }

  /** Una frase de la respuesta: con audio de ElevenLabs si la app lo admite; si falla, solo texto (voz de Android). */
  #sayChunk(turn, emit, text, previousText) {
    if (!turn.audio || !this.#voice) {
      this.#say(turn, emit, { type: 'assistant_chunk', text });
      return;
    }
    const audio = this.#voice.synthesize(text, { signal: turn.signal, previousText }).catch(() => null); // empieza ya, en paralelo
    turn.out = turn.out.then(async () => {
      const a = await audio;
      this.#deliver(turn, emit, a ? { type: 'assistant_audio', text, format: a.format, data: a.data } : { type: 'assistant_chunk', text });
    });
  }

  #deliver(turn, emit, msg) {
    if (turn.aborted) return;
    try {
      emit(turn.requestId ? { ...msg, requestId: turn.requestId } : msg);
    } catch (err) {
      console.error('[envio]', err.message);
    }
  }

  async #loop(session, turn, emit) {
    for (let step = 0; step < this.#config.MAX_TOOL_ITERATIONS; step++) {
      let previous = '';
      const chunker = new SentenceChunker((text) => {
        this.#sayChunk(turn, emit, text, previous);
        previous = text;
      });
      let message;
      try {
        for await (const ev of this.#model.stream({
          system: typeof this.#system === 'function' ? this.#system(session) : this.#system,
          messages: session.history,
          tools: this.#registry.forModel(),
          model: this.#config.MODEL_DEFAULT,
          signal: turn.signal,
        })) {
          if (turn.aborted) return;
          if (ev.type === 'text') chunker.push(ev.text);
          else if (ev.type === 'message') message = ev;
        }
        if (!message) throw new Error('el modelo no devolvió ningún mensaje');
      } catch (err) {
        if (turn.aborted) return;
        console.error('[modelo]', String(err.message).slice(0, 500));
        await this.#log({ event: 'model_error', sessionId: session.id, message: err.message });
        this.#say(turn, emit, { type: 'error', message: err.name === 'BudgetError' ? err.message : 'No he podido consultar el modelo. Inténtalo de nuevo.' });
        return;
      }
      if (turn.aborted) return;
      chunker.flush();

      const toolUses = message.content.filter((b) => b.type === 'tool_use');
      if (toolUses.length === 0) {
        if (message.content.length) session.history.push({ role: 'assistant', content: message.content });
        this.#say(turn, emit, { type: 'assistant_done' });
        return;
      }
      const outcome = await this.#runTools(session, turn, message.content, toolUses, emit);
      if (outcome !== 'done') return;
    }
    await this.#log({ event: 'model_error', sessionId: session.id, message: 'demasiadas iteraciones de herramientas' });
    this.#say(turn, emit, { type: 'error', message: 'Me he liado con demasiados pasos. ¿Me lo puedes pedir de otra forma?' });
  }

  /**
   * Ejecuta las lecturas del mensaje del modelo y reúne las escrituras en UN solo lote pendiente de confirmar:
   * "pon todos con fecha de hoy y prioridad alta" es una única pregunta, no una por ticket y por cambio.
   * @returns {'done'|'paused'|'aborted'}
   */
  async #runTools(session, turn, assistantContent, toolUses, emit) {
    const results = new Array(toolUses.length);
    const batch = [];
    for (let k = 0; k < toolUses.length; k++) {
      const tu = toolUses[k];
      const tool = this.#registry.get(tu.name);
      if (!tool) {
        await this.#log({ event: 'tool_call', sessionId: session.id, tool: tu.name, ok: false, error: 'herramienta desconocida' });
        results[k] = toolError(tu.id, `La herramienta ${tu.name} no existe.`);
        continue;
      }
      if (this.#registry.isDisabled(tool.name)) {
        await this.#log({ event: 'tool_call', sessionId: session.id, tool: tool.name, ok: false, error: 'herramienta desactivada' });
        results[k] = toolError(tu.id, `La herramienta ${tool.name} está desactivada por el usuario.`);
        continue;
      }
      const parsed = tool.input.safeParse(tu.input ?? {});
      if (!parsed.success) {
        const detail = parsed.error.issues.map((i) => `${i.path.join('.') || 'entrada'}: ${i.message}`).join('; ');
        await this.#log({ event: 'tool_call', sessionId: session.id, tool: tool.name, ok: false, error: `parámetros no válidos: ${detail}` });
        results[k] = toolError(tu.id, `Parámetros no válidos (${detail}).`);
        continue;
      }
      if (tool.risk === 'write' && this.#pause?.active) {
        await this.#log({ event: 'tool_call', sessionId: session.id, tool: tool.name, ok: false, error: 'bloqueada: modo pausa' });
        results[k] = toolError(tu.id, this.#pause.message());
        continue;
      }

      if (tool.risk === 'write' && this.#isDirect(tool, parsed.data, toolUses, turn, session)) {
        results[k] = await this.#execDirect(tool, parsed.data, tu, session, emit);
        continue;
      }

      if (tool.risk === 'write') {
        if (batch.length >= MAX_BATCH) {
          results[k] = toolError(tu.id, `Demasiados cambios a la vez (máximo ${MAX_BATCH} por confirmación). Este no se ha hecho: propónlo en el siguiente paso.`);
          continue;
        }
        try {
          batch.push({ index: k, toolName: tool.name, args: parsed.data, summary: await tool.summarize(parsed.data, { session, user: session.user }) });
        } catch (err) {
          await this.#log({ event: 'tool_call', sessionId: session.id, tool: tool.name, ok: false, error: err.message });
          results[k] = toolError(tu.id, err.message);
        }
        continue;
      }

      results[k] = await this.#exec(tool, parsed.data, tu, session);
    }
    if (turn.aborted) return 'aborted';

    if (batch.length) {
      const { summary, items } = resumenDeLote(batch.map((a) => a.summary), new Date(this.#now()));
      const pending = createPending({
        actions: batch,
        summary,
        items,
        ttlMs: this.#config.CONFIRM_TTL_MS,
        now: this.#now(),
        turn: { assistantContent, toolUses, results, requestId: turn.requestId, audio: turn.audio },
      });
      session.pending = pending;
      await this.#log({
        event: 'confirm_requested',
        sessionId: session.id,
        user: session.user,
        actionId: pending.actionId,
        tool: batch.map((a) => a.toolName).join(','),
        args: batch.length === 1 ? batch[0].args : undefined,
        actions: batch.length > 1 ? batch.map((a) => ({ tool: a.toolName, args: a.args, summary: a.summary })) : undefined,
        summary,
      });
      // La pregunta se lee con la misma voz que el resto; si no hay audio, la app la lee con la de Android.
      const spoken = turn.audio && this.#voice ? await this.#voice.synthesize(`${summary}. ¿Confirmas?`, { signal: turn.signal }).catch(() => null) : null;
      this.#say(turn, emit, {
        type: 'confirm_request',
        actionId: pending.actionId,
        summary,
        ...(items && { items }),
        ...(spoken && { audio: { format: spoken.format, data: spoken.data } }),
      });
      return 'paused';
    }
    return this.#finishTools(session, turn, assistantContent, toolUses, results);
  }

  /** Todas las herramientas del mensaje tienen resultado: el historial se actualiza de una vez, en el orden de las llamadas. */
  #finishTools(session, turn, assistantContent, toolUses, results) {
    session.history.push({ role: 'assistant', content: assistantContent }, { role: 'user', content: toolUses.map((_, i) => results[i]) });
    return turn.aborted ? 'aborted' : 'done';
  }

  /**
   * ¿Se ejecuta sin pedir confirmación? Solo si el usuario lo ha ordenado de forma explícita: herramienta de la lista
   * permitida (cambios que se pueden deshacer o añadir), marca ordenExplicita, UN solo cambio en el mensaje (un ticket),
   * turno nacido de un mensaje suyo y nada pendiente. Todo lo demás (lotes, borrados, horas...) sigue pidiendo confirmación.
   */
  #isDirect(tool, args, toolUses, turn, session) {
    if (!this.#config.DIRECT_WRITE || !turn.byUser || session.pending) return false;
    if (!(this.#config.DIRECT_WRITE_TOOLS ?? []).includes(tool.name) || args.ordenExplicita !== true) return false;
    return toolUses.filter((u) => this.#registry.get(u.name)?.risk === 'write').length === 1;
  }

  async #execDirect(tool, args, tu, session, emit) {
    let summary;
    try {
      summary = await tool.summarize(args, { session, user: session.user });
    } catch (err) {
      await this.#log({ event: 'tool_call', sessionId: session.id, tool: tool.name, ok: false, error: err.message });
      return toolError(tu.id, err.message);
    }
    await this.#log({ event: 'direct_write', sessionId: session.id, user: session.user, tool: tool.name, args, summary });
    const res = await this.#exec(tool, args, tu, session);
    this.#resultCard([{ index: 0, toolName: tool.name, summary }], [res], emit);
    return res;
  }

  async #exec(tool, args, tu, session) {
    // Última barrera: una confirmación pendiente de antes de la pausa tampoco se ejecuta.
    if (tool.risk === 'write' && this.#pause?.active) {
      await this.#log({ event: 'tool_call', sessionId: session.id, tool: tool.name, ok: false, error: 'bloqueada: modo pausa' });
      return toolError(tu.id, this.#pause.message());
    }
    if (this.#registry.isDisabled(tool.name)) return toolError(tu.id, `La herramienta ${tool.name} está desactivada por el usuario. No se ha hecho nada.`);
    const base = { sessionId: session.id, user: session.user, tool: tool.name, risk: tool.risk, args };
    if (tool.risk === 'write') {
      try {
        await this.#audit.record({ event: 'tool_call_start', ...base });
      } catch {
        return toolError(tu.id, 'No se ha podido registrar la auditoría, así que la acción no se ha ejecutado.');
      }
    }
    const started = this.#now();
    try {
      const content = serialize(await tool.execute(args, { session, user: session.user }));
      await this.#log({ event: 'tool_call', ...base, ok: true, durationMs: this.#now() - started, result: resultText(content).slice(0, 500) });
      return { type: 'tool_result', tool_use_id: tu.id, content };
    } catch (err) {
      await this.#log({ event: 'tool_call', ...base, ok: false, durationMs: this.#now() - started, error: err.message });
      return toolError(tu.id, err.message);
    }
  }

  async #log(event) {
    try {
      await this.#audit.record(event);
    } catch (err) {
      console.error('[auditoria] no se pudo registrar el evento', event.event, err.message);
    }
  }
}
