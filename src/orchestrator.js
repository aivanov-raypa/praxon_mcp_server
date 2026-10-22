import { randomUUID } from 'node:crypto';
import { SentenceChunker } from './chunker.js';
import { CONFIRMATION_ERRORS, checkConfirmation, createPending } from './confirmations.js';
import { appendUserText, trimHistory } from './session.js';

const MAX_RESULT_CHARS = 8000;

/** Un turno = una peticion del usuario (o una confirmacion) hasta que el asistente termina de responder. */
function newTurn(requestId, audio = false) {
  const controller = new AbortController();
  return {
    id: randomUUID(),
    requestId,
    /** La app admite audio del servidor en este turno. */
    audio,
    /** Cola ordenada de mensajes hacia la app: el audio de cada frase se sintetiza en paralelo pero se envia en orden. */
    out: Promise.resolve(),
    signal: controller.signal,
    get aborted() {
      return controller.signal.aborted;
    },
    abort: () => controller.abort(),
  };
}

function serialize(out) {
  const s = JSON.stringify(out ?? { ok: true });
  return s.length <= MAX_RESULT_CHARS ? s : JSON.stringify({ recortado: true, texto: s.slice(0, MAX_RESULT_CHARS) });
}

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

  constructor({ model, registry, audit, config, systemPrompt, voice = null, now = Date.now }) {
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
    const turn = this.#startTurn(session, requestId, audio === 'mp3'); // interrumpe de inmediato el turno anterior
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
      const { assistantContent, toolUses, index, results } = pending.turn;
      const tu = toolUses[index];
      await this.#log({ event: 'confirm_result', sessionId: session.id, user: session.user, actionId, tool: pending.toolName, outcome: accepted ? 'accepted' : 'declined' });

      if (accepted) {
        results.push(await this.#exec(this.#registry.get(pending.toolName), pending.args, tu, session));
      } else {
        results.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: JSON.stringify({ cancelada: true, mensaje: 'El usuario ha cancelado la acción. No se ha ejecutado nada.' }),
        });
      }
      const outcome = await this.#runTools(session, turn, assistantContent, toolUses, index + 1, results, emit);
      if (outcome === 'done') await this.#loop(session, turn, emit);
      await turn.out;
    });
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

  #startTurn(session, requestId, audio = false) {
    session.currentTurn?.abort();
    const turn = newTurn(requestId, audio);
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
        await this.#log({ event: 'model_error', sessionId: session.id, message: err.message });
        this.#say(turn, emit, { type: 'error', message: 'No he podido consultar el modelo. Inténtalo de nuevo.' });
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
      const outcome = await this.#runTools(session, turn, message.content, toolUses, 0, [], emit);
      if (outcome !== 'done') return;
    }
    await this.#log({ event: 'model_error', sessionId: session.id, message: 'demasiadas iteraciones de herramientas' });
    this.#say(turn, emit, { type: 'error', message: 'Me he liado con demasiados pasos. ¿Me lo puedes pedir de otra forma?' });
  }

  /** @returns {'done'|'paused'|'aborted'} */
  async #runTools(session, turn, assistantContent, toolUses, start, results, emit) {
    for (let k = start; k < toolUses.length; k++) {
      const tu = toolUses[k];
      const tool = this.#registry.get(tu.name);
      if (!tool) {
        await this.#log({ event: 'tool_call', sessionId: session.id, tool: tu.name, ok: false, error: 'herramienta desconocida' });
        results.push(toolError(tu.id, `La herramienta ${tu.name} no existe.`));
        continue;
      }
      const parsed = tool.input.safeParse(tu.input ?? {});
      if (!parsed.success) {
        const detail = parsed.error.issues.map((i) => `${i.path.join('.') || 'entrada'}: ${i.message}`).join('; ');
        await this.#log({ event: 'tool_call', sessionId: session.id, tool: tool.name, ok: false, error: `parámetros no válidos: ${detail}` });
        results.push(toolError(tu.id, `Parámetros no válidos (${detail}).`));
        continue;
      }

      if (tool.risk === 'write') {
        let summary;
        try {
          summary = await tool.summarize(parsed.data, { session, user: session.user });
        } catch (err) {
          await this.#log({ event: 'tool_call', sessionId: session.id, tool: tool.name, ok: false, error: err.message });
          results.push(toolError(tu.id, err.message));
          continue;
        }
        if (turn.aborted) return 'aborted';
        const pending = createPending({
          toolName: tool.name,
          args: parsed.data,
          summary,
          ttlMs: this.#config.CONFIRM_TTL_MS,
          now: this.#now(),
          turn: { assistantContent, toolUses, index: k, results, requestId: turn.requestId, audio: turn.audio },
        });
        session.pending = pending;
        await this.#log({ event: 'confirm_requested', sessionId: session.id, user: session.user, actionId: pending.actionId, tool: tool.name, args: parsed.data, summary });
        // La pregunta se lee con la misma voz que el resto; si no hay audio, la app la lee con la de Android.
        const spoken = turn.audio && this.#voice ? await this.#voice.synthesize(`${summary}. ¿Confirmas?`, { signal: turn.signal }).catch(() => null) : null;
        this.#say(turn, emit, {
          type: 'confirm_request',
          actionId: pending.actionId,
          summary,
          ...(spoken && { audio: { format: spoken.format, data: spoken.data } }),
        });
        return 'paused';
      }

      results.push(await this.#exec(tool, parsed.data, tu, session));
    }
    // Todas las herramientas del mensaje tienen resultado: el historial se actualiza de una vez.
    session.history.push({ role: 'assistant', content: assistantContent }, { role: 'user', content: results });
    return turn.aborted ? 'aborted' : 'done';
  }

  async #exec(tool, args, tu, session) {
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
      await this.#log({ event: 'tool_call', ...base, ok: true, durationMs: this.#now() - started, result: content.slice(0, 500) });
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
