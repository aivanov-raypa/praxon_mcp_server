import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { defineTool } from '../tools/registry.js';

const MAX_PER_OWNER = 30;
const KEEP_DONE_MS = 7 * 86_400_000;
export class ReminderError extends Error {}

/**
 * Recordatorios y compromisos del usuario ("recuérdame revisar esto a las 9"). Son datos de Praxon (no tocan MyRAYPA).
 * Estados: pendiente | avisado | cancelado. Se avisan por voz en la app mientras está abierta; si no hay conexión,
 * quedan pendientes y se entregan al volver a conectar.
 */
export class ReminderStore {
  #path;
  #now;
  #items = [];
  #queue = Promise.resolve();

  constructor(path = null, { now = Date.now } = {}) {
    this.#path = path;
    this.#now = now;
    if (path) {
      try {
        const d = JSON.parse(readFileSync(path, 'utf8'));
        if (Array.isArray(d)) this.#items = d;
      } catch {
        /* primera vez o ilegible */
      }
    }
  }

  list(owner, { todos = false } = {}) {
    return this.#items.filter((r) => r.owner === owner && (todos || r.estado === 'pendiente')).sort((a, b) => a.due.localeCompare(b.due)).map((r) => ({ ...r }));
  }

  /** Valida y calcula la hora: `cuando` (ISO con zona) o `enMinutos`. */
  check({ texto, cuando, enMinutos }, owner) {
    const t = String(texto ?? '').trim();
    if (t.length < 3) throw new ReminderError('El recordatorio es demasiado corto.');
    let due;
    if (cuando) {
      const ms = Date.parse(cuando);
      if (Number.isNaN(ms)) throw new ReminderError('La fecha y hora no son válidas.');
      due = ms;
    } else if (enMinutos != null) {
      due = this.#now() + enMinutos * 60_000;
    } else throw new ReminderError('Indica cuándo: una fecha y hora, o en cuántos minutos.');
    if (due < this.#now() - 60_000) throw new ReminderError('Esa hora ya ha pasado.');
    if (due > this.#now() + 365 * 86_400_000) throw new ReminderError('Solo puedo recordar cosas de aquí a un año.');
    if (owner && this.list(owner).length >= MAX_PER_OWNER) throw new ReminderError(`Ya hay ${MAX_PER_OWNER} recordatorios pendientes. Cancela alguno antes.`);
    return { texto: t.slice(0, 200), due: new Date(Math.max(due, this.#now())).toISOString() };
  }

  async add(owner, input) {
    const v = this.check(input, owner);
    const r = { id: randomUUID().slice(0, 8), owner, texto: v.texto, due: v.due, estado: 'pendiente', creado: new Date(this.#now()).toISOString() };
    this.#items.push(r);
    await this.#save();
    return { ...r };
  }

  async cancel(owner, id) {
    const r = this.#items.find((x) => x.id === id && x.owner === owner && x.estado === 'pendiente');
    if (!r) throw new ReminderError('No encuentro ese recordatorio pendiente.');
    r.estado = 'cancelado';
    await this.#save();
    return { ...r };
  }

  /** Pendientes cuya hora ya llegó (de todos, o de un dueño). */
  due(owner = null) {
    const now = this.#now();
    return this.#items.filter((r) => r.estado === 'pendiente' && Date.parse(r.due) <= now && (owner == null || r.owner === owner)).map((r) => ({ ...r }));
  }

  async markFired(id) {
    const r = this.#items.find((x) => x.id === id);
    if (r) r.estado = 'avisado';
    await this.#save();
  }

  #save() {
    const limit = this.#now() - KEEP_DONE_MS;
    this.#items = this.#items.filter((r) => r.estado === 'pendiente' || Date.parse(r.due) > limit);
    if (!this.#path) return Promise.resolve();
    const snap = JSON.stringify(this.#items);
    const w = this.#queue.then(async () => {
      await mkdir(dirname(this.#path), { recursive: true });
      const tmp = `${this.#path}.tmp`;
      await writeFile(tmp, snap, 'utf8');
      await rename(tmp, this.#path);
    });
    this.#queue = w.catch(() => {});
    return w;
  }
}

/** Avisa de los recordatorios que vencen: a las conexiones del dueño; sin conexión, quedan para cuando vuelva. */
export class ReminderService {
  #store;
  #deliver; // (owner, mensaje) -> nº de conexiones a las que llegó
  #timer = null;

  constructor({ store, deliver, everyMs = 15_000 }) {
    this.#store = store;
    this.#deliver = deliver;
    this.everyMs = everyMs;
  }

  async tick() {
    let n = 0;
    for (const r of this.#store.due()) {
      if (this.#deliver(r.owner, { type: 'reminder', id: r.id, texto: r.texto }) > 0) {
        await this.#store.markFired(r.id);
        n++;
      }
    }
    return n;
  }

  /** Al conectar una app: entrega lo que venció mientras estaba desconectada. */
  async flush(owner, emit) {
    for (const r of this.#store.due(owner)) {
      emit({ type: 'reminder', id: r.id, texto: r.texto });
      await this.#store.markFired(r.id);
    }
  }

  start() {
    if (this.#timer) return;
    this.#timer = setInterval(() => this.tick().catch((e) => console.error('[recordatorios]', e.message)), this.everyMs);
    this.#timer.unref();
  }

  stop() {
    clearInterval(this.#timer);
    this.#timer = null;
  }
}

const ownerOf = (session) => session?.email ?? session?.user ?? 'desconocido';
const fmt = (iso) => new Intl.DateTimeFormat('es-ES', { dateStyle: 'full', timeStyle: 'short', timeZone: 'Europe/Madrid' }).format(new Date(iso));

/** Herramientas (riesgo local: solo tocan datos de Praxon, sin confirmación). */
export function reminderTools({ store }) {
  const connector = 'praxon';
  return [
    defineTool({
      connector,
      name: 'crear_recordatorio',
      risk: 'local',
      description:
        'Crea un recordatorio que Praxon dirá en voz alta a la hora indicada (con la app abierta). Usa enMinutos para "dentro de 20 minutos" y cuando para una hora concreta (ISO 8601 con zona, hora de Madrid; calcula la fecha con la de hoy y praxon_hora_actual). Indica exactamente uno de los dos. Si el usuario da solo el día ("recuérdame mañana llamar a Ana", "el viernes ...") y no la hora, NO preguntes: usa las 09:00 de ese día (si ya pasaron, la próxima hora en punto) y dile en la respuesta a qué hora lo has puesto por si quiere cambiarla. El texto del recordatorio es la tarea tal cual ("llamar a Ana"), sin "recuérdame".',
      input: z
        .object({ texto: z.string().trim().min(3).max(200), cuando: z.string().max(40).optional(), enMinutos: z.number().int().min(1).max(525_600).optional() })
        .refine((a) => (a.cuando != null) !== (a.enMinutos != null), { message: 'indica cuando o enMinutos, uno solo' }),
      execute: async (a, { session }) => {
        try {
          const r = await store.add(ownerOf(session), a);
          return { creado: true, id: r.id, para: fmt(r.due) };
        } catch (e) {
          if (e instanceof ReminderError) throw new Error(e.message);
          throw e;
        }
      },
    }),
    defineTool({
      connector,
      name: 'listar_recordatorios',
      risk: 'local',
      description: 'Lista los recordatorios pendientes del usuario (con su id).',
      input: z.object({}),
      execute: async (_a, { session }) => ({ recordatorios: store.list(ownerOf(session)).map((r) => ({ id: r.id, texto: r.texto, para: fmt(r.due) })) }),
    }),
    defineTool({
      connector,
      name: 'cancelar_recordatorio',
      risk: 'local',
      description: 'Cancela un recordatorio pendiente (usa el id de listar_recordatorios).',
      input: z.object({ id: z.string().min(1).max(20) }),
      execute: async (a, { session }) => {
        try {
          await store.cancel(ownerOf(session), a.id);
          return { cancelado: true };
        } catch (e) {
          if (e instanceof ReminderError) throw new Error(e.message);
          throw e;
        }
      },
    }),
  ];
}
