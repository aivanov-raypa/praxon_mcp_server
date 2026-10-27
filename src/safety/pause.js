import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { rename, rm, writeFile } from 'node:fs/promises';

/**
 * Interruptor de emergencia ("modo pausa"). Mientras está activo Praxon NO hace nada con efectos: ni cambios en MyRAYPA
 * (voz, confirmados o directos), ni deshacer, ni lanzar agentes o pedir cambios, ni fusionar, ni ejecutar propuestas, ni
 * revisiones automáticas, ni seguimiento de agentes. Siguen funcionando la conversación, las consultas y descartar propuestas,
 * para poder preguntar qué ha pasado.
 *
 * El estado es un fichero (PAUSE_PATH): existe = pausa. Se mira en cada decisión, así que también se activa con el servidor
 * en marcha desde una terminal (`npm run pausa -- on`) aunque la app no responda, y sobrevive a un reinicio.
 * Solo se activa/desactiva desde el panel de Estado (quien puede aprobar) o por esa terminal; nunca desde el modelo.
 */
export class PauseSwitch {
  #path;
  #now;
  #audit;

  constructor(path, { audit = null, now = Date.now } = {}) {
    this.#path = path;
    this.#audit = audit;
    this.#now = now;
  }

  /** Si no hay ruta (tests) se queda en memoria. */
  #mem = null;

  get active() {
    if (!this.#path) return this.#mem !== null;
    return existsSync(this.#path);
  }

  /** { desde, por, motivo } o null. Un fichero ilegible cuenta como pausa activa (falla cerrado). */
  info() {
    if (!this.active) return null;
    if (!this.#path) return this.#mem;
    try {
      const d = JSON.parse(readFileSync(this.#path, 'utf8'));
      return { desde: d.desde ?? null, por: d.por ?? null, motivo: d.motivo ?? null };
    } catch {
      return { desde: null, por: null, motivo: null };
    }
  }

  /** Mensaje para el usuario (y el modelo) cuando algo se bloquea. */
  message() {
    const i = this.info();
    const motivo = i?.motivo ? ` (${i.motivo})` : '';
    return `Praxon está en pausa${motivo}. No se hace ningún cambio hasta que se reanude desde Estado en la app o con «npm run pausa -- off» en el servidor.`;
  }

  async engage({ user = 'desconocido', motivo = null } = {}) {
    const dato = { desde: new Date(this.#now()).toISOString(), por: user, motivo: motivo ? String(motivo).slice(0, 200) : null };
    if (!this.#path) this.#mem = dato;
    else {
      mkdirSync(dirname(this.#path), { recursive: true });
      const tmp = `${this.#path}.tmp`;
      await writeFile(tmp, JSON.stringify(dato), { mode: 0o600 });
      await rename(tmp, this.#path);
    }
    await this.#audit?.record({ event: 'pause_on', user, motivo: dato.motivo }).catch(() => {});
    return dato;
  }

  async release({ user = 'desconocido' } = {}) {
    if (!this.#path) this.#mem = null;
    else await rm(this.#path, { force: true });
    await this.#audit?.record({ event: 'pause_off', user }).catch(() => {});
  }
}

export class PausedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PausedError';
  }
}
