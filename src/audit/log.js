import { appendFile, mkdir, readFile, writeFile, } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Log de auditoria en JSONL: una linea por evento (quien, cuando, transcripcion original,
 * herramienta y parametros, resultado). Permite ver si fallo la transcripcion o la interpretacion.
 * record() lanza si no puede escribir: el orquestador no ejecuta escrituras sin auditoria.
 */
export class JsonlAudit {
  #path;
  #queue = Promise.resolve();
  #ready = false;

  #textMax;

  /** textMax: caracteres que se guardan del campo `text` (lo que dice el usuario); 0 = solo su longitud. */
  constructor(path, { textMax = 200 } = {}) {
    this.#path = path;
    this.#textMax = textMax;
  }

  #minimize(event) {
    if (typeof event.text !== 'string') return event;
    if (this.#textMax === 0) return { ...event, text: '[omitido]', textLength: event.text.length };
    if (event.text.length <= this.#textMax) return event;
    return { ...event, text: `${event.text.slice(0, this.#textMax)}…`, textLength: event.text.length };
  }

  /** Borra las líneas más antiguas que `days` días (0 = conservar todo). */
  async prune(days) {
    if (!days) return 0;
    let raw;
    try {
      raw = await readFile(this.#path, 'utf8');
    } catch {
      return 0;
    }
    const limit = Date.now() - days * 86_400_000;
    const lines = raw.split('\n').filter(Boolean);
    const keep = lines.filter((l) => {
      try {
        return Date.parse(JSON.parse(l).ts) >= limit;
      } catch {
        return true;
      }
    });
    if (keep.length !== lines.length) await writeFile(this.#path, keep.length ? `${keep.join('\n')}\n` : '', { mode: 0o600 });
    return lines.length - keep.length;
  }

  /**
   * Últimos eventos (más recientes primero). Filtros: `event` (tipo exacto), `texto` (aparece en la línea),
   * `desde` (ISO). Lee el fichero entero, que está acotado por la retención.
   */
  async tail({ limit = 50, event, texto, desde } = {}) {
    let raw;
    try {
      raw = await readFile(this.#path, 'utf8');
    } catch {
      return [];
    }
    return filterEvents(
      raw.split('\n').filter(Boolean).map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      }),
      { limit, event, texto, desde },
    );
  }

  record(event) {
    const line = `${JSON.stringify({ ts: new Date().toISOString(), ...this.#minimize(event) })}\n`;
    const write = this.#queue.then(async () => {
      if (!this.#ready) {
        await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
        this.#ready = true;
      }
      await appendFile(this.#path, line, { encoding: 'utf8', mode: 0o600 });
    });
    this.#queue = write.catch(() => {});
    return write;
  }
}

/** Filtra y ordena (recientes primero) una lista de eventos ya parseados. */
export function filterEvents(events, { limit = 50, event, texto, desde } = {}) {
  const needle = texto ? String(texto).toLowerCase() : null;
  const from = desde ? Date.parse(desde) : null;
  const out = [];
  for (let i = events.length - 1; i >= 0 && out.length < limit; i--) {
    const e = events[i];
    if (!e) continue;
    if (event && e.event !== event) continue;
    if (from && !(Date.parse(e.ts) >= from)) continue;
    if (needle && !JSON.stringify(e).toLowerCase().includes(needle)) continue;
    out.push(e);
  }
  return out;
}

/** Para tests. */
export class MemoryAudit {
  events = [];
  failNext = false;

  async record(event) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('auditoria no disponible');
    }
    this.events.push({ ts: new Date().toISOString(), ...event });
  }

  async tail(opts) {
    return filterEvents(this.events, opts);
  }

  of(type) {
    return this.events.filter((e) => e.event === type);
  }
}
