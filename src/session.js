/** Una conversacion. Se identifica por el sessionId de la app, que sobrevive a las reconexiones. */
export class Session {
  constructor(id, user) {
    this.id = id;
    this.user = user;
    /** Historial en formato de mensajes del modelo. Siempre consistente: tool_use y tool_result van juntos. */
    this.history = [];
    /** Accion de escritura pendiente de confirmar (una como maximo). */
    this.pending = null;
    /** Turno en curso, para poder interrumpirlo. */
    this.currentTurn = null;
    this.connection = null;
    this.lastSeen = Date.now();
    this.#lock = Promise.resolve();
  }

  #lock;

  /** Ejecuta fn en serie con el resto de mensajes de esta sesion. */
  runExclusive(fn) {
    const run = this.#lock.then(fn);
    this.#lock = run.catch(() => {});
    return run;
  }
}

export class SessionStore {
  #sessions = new Map();

  /** `owner` separa las conversaciones de cada dispositivo aunque coincida el sessionId. */
  get(id, user, owner = user, email = null) {
    const key = `${owner}\u0000${id}`;
    let s = this.#sessions.get(key);
    if (!s) {
      s = new Session(id, user);
      s.email = email;
      this.#sessions.set(key, s);
    }
    s.lastSeen = Date.now();
    return s;
  }

  /** Elimina las sesiones sin actividad. Devuelve cuantas ha borrado. */
  sweep(maxIdleMs, now = Date.now()) {
    let n = 0;
    for (const [key, s] of this.#sessions) {
      if (now - s.lastSeen > maxIdleMs && !s.connection) {
        this.#sessions.delete(key);
        n++;
      }
    }
    return n;
  }

  get size() {
    return this.#sessions.size;
  }
}

/**
 * Recorta el historial dejando como maximo `max` mensajes, empezando siempre en un mensaje del usuario
 * con texto (nunca entre un tool_use y su tool_result).
 */
export function trimHistory(history, max) {
  if (history.length <= max) return;
  for (let i = history.length - max; i < history.length; i++) {
    const m = history[i];
    const isUserText = m.role === 'user' && (typeof m.content === 'string' || m.content.every((b) => b.type === 'text'));
    if (isUserText) {
      history.splice(0, i);
      return;
    }
  }
}

/** Anade un mensaje del usuario sin dejar dos mensajes de usuario seguidos. */
export function appendUserText(history, text) {
  const last = history.at(-1);
  if (last?.role === 'user') {
    if (typeof last.content === 'string') last.content += `\n${text}`;
    else last.content.push({ type: 'text', text });
  } else {
    history.push({ role: 'user', content: text });
  }
}
