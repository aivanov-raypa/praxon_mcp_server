import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const DAY = 86_400_000;
const MAX_TICKETS = 5000;
const MAX_KEYS = 40;
const KEEP_DAYS = 365;

/**
 * Memoria de lo ya propuesto por ticket, para que la revisión no insista:
 *  - una acción exacta (herramienta + parámetros) que el usuario descartó o aprobó no se vuelve a proponer;
 *  - un ticket cuya propuesta el usuario descartó entera no recibe propuestas durante `dismissDays`;
 *  - un ticket que ya tuvo una propuesta (en cualquier estado) no recibe otra durante `cooldownDays`.
 * Se guarda en JSON (si hay ruta) y no depende del límite de revisiones que conserva la bandeja.
 */
export class TicketLog {
  #path;
  #now;
  #data = {}; // ticketId -> { propuesta: ISO, descartado: ISO|null, claves: { key: ISO } }
  #queue = Promise.resolve();

  constructor(path = null, { now = Date.now } = {}) {
    this.#path = path;
    this.#now = now;
    if (path) {
      try {
        const d = JSON.parse(readFileSync(path, 'utf8'));
        if (d && typeof d === 'object' && !Array.isArray(d)) this.#data = d;
      } catch {
        /* primera vez o fichero ilegible */
      }
    }
  }

  #entry(id) {
    return (this.#data[String(id)] ??= { propuesta: null, descartado: null, claves: {} });
  }

  /** Motivo por el que NO debe proponerse esto (texto para el modelo), o null si puede. */
  blockReason(ticketId, key = null, { dismissDays = 90, cooldownDays = 14 } = {}) {
    const e = this.#data[String(ticketId)];
    if (!e) return null;
    const now = this.#now();
    if (e.descartado && dismissDays > 0 && now - Date.parse(e.descartado) < dismissDays * DAY) {
      return 'El usuario descartó la propuesta de este ticket. No propongas nada más para él y pasa al siguiente.';
    }
    if (e.propuesta && cooldownDays > 0 && now - Date.parse(e.propuesta) < cooldownDays * DAY) {
      return 'Este ticket ya recibió una propuesta hace poco. No propongas nada más para él y pasa al siguiente.';
    }
    if (key && e.claves?.[key]) return 'El usuario ya resolvió esa misma acción (la descartó o la aprobó). No la repitas.';
    return null;
  }

  noteProposed(ids) {
    const t = new Date(this.#now()).toISOString();
    for (const id of ids) if (id != null) this.#entry(id).propuesta = t;
    return this.#prune();
  }

  /** El usuario resolvió esta acción (descartada o ejecutada): esa misma acción no vuelve. */
  noteResolved(ticketId, key) {
    if (ticketId == null || !key) return Promise.resolve();
    const e = this.#entry(ticketId);
    e.claves[key] = new Date(this.#now()).toISOString();
    const keys = Object.keys(e.claves);
    if (keys.length > MAX_KEYS) for (const k of keys.sort((a, b) => e.claves[a].localeCompare(e.claves[b])).slice(0, keys.length - MAX_KEYS)) delete e.claves[k];
    return this.#prune();
  }

  /** El usuario descartó entera la propuesta del ticket. */
  noteDismissed(ticketId) {
    if (ticketId == null) return Promise.resolve();
    this.#entry(ticketId).descartado = new Date(this.#now()).toISOString();
    return this.#prune();
  }

  #prune() {
    const limit = this.#now() - KEEP_DAYS * DAY;
    const ids = Object.keys(this.#data);
    const last = (e) => Math.max(Date.parse(e.propuesta ?? 0) || 0, Date.parse(e.descartado ?? 0) || 0, ...Object.values(e.claves ?? {}).map((v) => Date.parse(v) || 0));
    for (const id of ids) if (last(this.#data[id]) < limit) delete this.#data[id];
    const rest = Object.keys(this.#data);
    if (rest.length > MAX_TICKETS) for (const id of rest.sort((a, b) => last(this.#data[a]) - last(this.#data[b])).slice(0, rest.length - MAX_TICKETS)) delete this.#data[id];
    return this.save();
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
