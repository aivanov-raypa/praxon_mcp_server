import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const MAX_BRIEFINGS = 30;

/**
 * Revisiones del asistente y sus propuestas. Cada revision ("briefing") lleva un resumen y una lista de acciones
 * preparadas que NO se han ejecutado: el usuario las aprueba o las descarta una a una.
 * Se guarda en un fichero JSON (si hay ruta) para que sobrevivan a un reinicio del servidor.
 *
 * Estados de una accion: pendiente | ejecutada | descartada | fallida | obsoleta | caducada
 */
export class ProposalStore {
  #path;
  #items = [];
  #queue = Promise.resolve();

  constructor(path = null) {
    this.#path = path;
    if (path) {
      try {
        const data = JSON.parse(readFileSync(path, 'utf8'));
        if (Array.isArray(data)) this.#items = data;
      } catch {
        /* sin fichero todavia, o ilegible: se empieza de cero */
      }
    }
  }

  /** Mas recientes primero. */
  list() {
    return this.#items;
  }

  get(id) {
    return this.#items.find((b) => b.id === id);
  }

  async add(briefing) {
    this.#items.unshift(briefing);
    this.#items.length = Math.min(this.#items.length, MAX_BRIEFINGS);
    await this.save();
  }

  /** Acciones pendientes de todas las revisiones, con su revision. */
  pending() {
    return this.#items.flatMap((b) => b.acciones.filter((a) => a.estado === 'pendiente').map((a) => ({ briefing: b, action: a })));
  }

  save() {
    if (!this.#path) return Promise.resolve();
    const snapshot = JSON.stringify(this.#items);
    const write = this.#queue.then(async () => {
      await mkdir(dirname(this.#path), { recursive: true });
      const tmp = `${this.#path}.tmp`;
      await writeFile(tmp, snapshot, 'utf8');
      await rename(tmp, this.#path); // escritura atomica: nunca queda un fichero a medias
    });
    this.#queue = write.catch(() => {});
    return write;
  }
}
