import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const MAX_SEEN = 1000;
export const MAX_ATTEMPTS = 3;

/**
 * Registro del vigilante de tickets nuevos: desde cuándo mira (marca de corte) y qué tickets ya ha revisado.
 * Sin fichero previo, la marca de corte es "ahora" (o `from`): nunca se revisa el histórico de golpe.
 * Se guarda en JSON (si hay ruta) para que un reinicio no repita ni se salte tickets.
 */
export class ReviewedStore {
  #path;
  #data;
  #queue = Promise.resolve();

  constructor(path = null, { from = null, now = Date.now } = {}) {
    this.#path = path;
    let data = null;
    if (path) {
      try {
        data = JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        /* primera vez o fichero ilegible */
      }
    }
    if (data && typeof data.desde === 'string' && !Number.isNaN(Date.parse(data.desde))) {
      this.#data = { desde: data.desde, vistos: data.vistos ?? {}, intentos: data.intentos ?? {} };
    } else {
      const start = from && !Number.isNaN(Date.parse(from)) ? new Date(from).toISOString() : new Date(now()).toISOString();
      this.#data = { desde: start, vistos: {}, intentos: {} };
      if (path) {
        // Se fija ya: si el servidor se reinicia antes de la primera revisión, no se pierden los tickets creados entre medias.
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(this.#data), 'utf8');
      }
    }
  }

  get desde() {
    return this.#data.desde;
  }

  isDone(id) {
    return id in this.#data.vistos || (this.#data.intentos[id] ?? 0) >= MAX_ATTEMPTS;
  }

  markSeen(id, now = Date.now()) {
    this.#data.vistos[id] = new Date(now).toISOString();
    delete this.#data.intentos[id];
    const ids = Object.keys(this.#data.vistos);
    if (ids.length > MAX_SEEN) {
      for (const old of ids.sort((a, b) => this.#data.vistos[a].localeCompare(this.#data.vistos[b])).slice(0, ids.length - MAX_SEEN)) delete this.#data.vistos[old];
    }
  }

  /** Cuenta un fallo; devuelve los intentos acumulados. */
  fail(id) {
    this.#data.intentos[id] = (this.#data.intentos[id] ?? 0) + 1;
    return this.#data.intentos[id];
  }

  /** Adelanta la marca de corte (nunca hacia atrás). */
  advance(iso) {
    if (iso && Date.parse(iso) > Date.parse(this.#data.desde)) this.#data.desde = new Date(iso).toISOString();
  }

  save() {
    if (!this.#path) return Promise.resolve();
    const snapshot = JSON.stringify(this.#data);
    const write = this.#queue.then(async () => {
      await mkdir(dirname(this.#path), { recursive: true });
      const tmp = `${this.#path}.tmp`;
      await writeFile(tmp, snapshot, 'utf8');
      await rename(tmp, this.#path);
    });
    this.#queue = write.catch(() => {});
    return write;
  }
}
