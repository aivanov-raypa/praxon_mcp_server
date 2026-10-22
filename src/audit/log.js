import { appendFile, mkdir } from 'node:fs/promises';
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

  constructor(path) {
    this.#path = path;
  }

  record(event) {
    const line = `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`;
    const write = this.#queue.then(async () => {
      if (!this.#ready) {
        await mkdir(dirname(this.#path), { recursive: true });
        this.#ready = true;
      }
      await appendFile(this.#path, line, 'utf8');
    });
    this.#queue = write.catch(() => {});
    return write;
  }
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

  of(type) {
    return this.events.filter((e) => e.event === type);
  }
}
