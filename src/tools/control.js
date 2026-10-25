import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Herramientas desactivadas desde la app (panel Herramientas). Solo sirve para RESTRINGIR: una herramienta desactivada
 * deja de ofrecerse al modelo y de ejecutarse (también las propuestas y confirmaciones pendientes). Volver a activarla
 * solo recupera lo que ya estaba registrado; no se puede crear ni elevar el riesgo de ninguna.
 * Persistente en un JSON para que un reinicio no vuelva a activar lo que se apagó.
 */
export class ToolControl {
  #path;
  #off = new Set();
  #queue = Promise.resolve();

  constructor(path = null) {
    this.#path = path;
    if (path) {
      try {
        const d = JSON.parse(readFileSync(path, 'utf8'));
        if (Array.isArray(d)) this.#off = new Set(d.filter((x) => typeof x === 'string'));
      } catch {
        /* primera vez o ilegible: todo activo */
      }
    }
  }

  isDisabled(name) {
    return this.#off.has(name);
  }

  list() {
    return [...this.#off];
  }

  async set(name, enabled) {
    if (enabled) this.#off.delete(name);
    else this.#off.add(name);
    if (!this.#path) return;
    const write = this.#queue.then(async () => {
      await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
      const tmp = `${this.#path}.tmp`;
      await writeFile(tmp, JSON.stringify([...this.#off]), { mode: 0o600 });
      await rename(tmp, this.#path);
    });
    this.#queue = write.catch(() => {});
    await write;
  }
}
