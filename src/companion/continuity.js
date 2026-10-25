import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const DAY = 86_400_000;
export const MAX_PER_OWNER = 5;
export const TTL_DAYS = 14;
const MAX_CHARS = 420;
const SECRETO = /(sk-[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9]{10,}|github_pat_\w+|xox[abprs]-[\w-]{10,}|Bearer\s+[A-Za-z0-9._~+/-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY)/;

/**
 * Continuidad entre sesiones: al cerrarse una conversación se guarda un resumen breve (lo tratado, lo decidido y lo que
 * quedó pendiente) y la siguiente conversación del mismo usuario lo recibe como contexto ("seguimos con lo de ayer").
 * Los resúmenes caducan a los 14 días y solo se conservan los últimos de cada usuario.
 */
export class ContinuityStore {
  #path;
  #now;
  #items = []; // { owner, sessionId, ts, resumen }
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

  /** Guarda (o reemplaza el de la misma sesión) el resumen. Devuelve false si no se guarda. */
  async add(owner, sessionId, resumen) {
    const r = String(resumen ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS);
    if (r.length < 15 || /^SIN_RESUMEN/i.test(r) || SECRETO.test(r)) return false;
    this.#items = this.#items.filter((x) => !(x.owner === owner && x.sessionId === sessionId));
    this.#items.push({ owner, sessionId, ts: new Date(this.#now()).toISOString(), resumen: r });
    this.#prune();
    await this.#save();
    return true;
  }

  /** Resúmenes guardados de un usuario. */
  count(owner) {
    this.#prune();
    return this.#items.filter((x) => x.owner === owner).length;
  }

  /** Resúmenes de un usuario, del más reciente al más antiguo. */
  list(owner) {
    this.#prune();
    return this.#items.filter((x) => x.owner === owner).sort((a, b) => b.ts.localeCompare(a.ts)).map((x) => ({ ts: x.ts, resumen: x.resumen }));
  }

  /** Borra todos los resúmenes de un usuario. Devuelve cuántos. */
  async clear(owner) {
    const antes = this.#items.length;
    this.#items = this.#items.filter((x) => x.owner !== owner);
    const n = antes - this.#items.length;
    if (n) await this.#save();
    return n;
  }

  #prune() {
    const limit = this.#now() - TTL_DAYS * DAY;
    this.#items = this.#items.filter((x) => Date.parse(x.ts) >= limit);
    const por = new Map();
    for (const x of [...this.#items].sort((a, b) => b.ts.localeCompare(a.ts))) {
      const n = (por.get(x.owner) ?? 0) + 1;
      por.set(x.owner, n);
      if (n > MAX_PER_OWNER) this.#items = this.#items.filter((y) => y !== x);
    }
  }

  /** Texto para el prompt: lo más reciente primero, sin la propia sesión. null si no hay nada. */
  render(owner, { excludeSessionId = null } = {}) {
    this.#prune();
    const list = this.#items
      .filter((x) => x.owner === owner && x.sessionId !== excludeSessionId)
      .sort((a, b) => b.ts.localeCompare(a.ts));
    if (!list.length) return null;
    const dia = (iso) => new Intl.DateTimeFormat('es-ES', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/Madrid' }).format(new Date(iso));
    return list.map((x) => `- ${dia(x.ts)}: ${x.resumen}`).join('\n');
  }

  #save() {
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

/** Solo el texto hablado de la conversación: sin resultados de herramientas (datos de tickets) ni llamadas. */
export function spokenTurns(history) {
  const out = [];
  for (const m of history) {
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content ?? [];
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
    if (text) out.push({ role: m.role, text });
  }
  return out;
}

const PROMPT = `Resume esta conversación entre un usuario y su asistente de voz en MÁXIMO tres frases en español: de qué trataron, qué se decidió o hizo, y qué quedó pendiente. Sin ids, sin cifras sueltas, sin datos personales ni credenciales. Si solo fue charla trivial o no hay nada que valga la pena retomar, responde exactamente SIN_RESUMEN.`;

/**
 * Pide al modelo el resumen de una sesión y lo guarda. Se llama al cerrarse la conexión. Nunca lanza: la continuidad es
 * un extra y no debe romper nada. Devuelve true si guardó un resumen.
 */
export async function summarizeSession({ model, config, store, session, owner, minUserTurns = 2, timeoutMs = 20_000 }) {
  try {
    const turns = spokenTurns(session.history);
    const userTurns = turns.filter((t) => t.role === 'user').length;
    const done = session.summarizedAtTurns ?? 0;
    if (userTurns < minUserTurns || userTurns - done < minUserTurns) return false;
    session.summarizedAtTurns = userTurns;
    const transcript = turns.map((t) => `${t.role === 'user' ? 'Usuario' : 'Asistente'}: ${t.text}`).join('\n').slice(-6000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let message;
    try {
      for await (const ev of model.stream({
        system: PROMPT,
        messages: [{ role: 'user', content: transcript }],
        tools: [],
        model: config.MODEL_DEFAULT,
        signal: controller.signal,
      })) {
        if (ev.type === 'message') message = ev;
      }
    } finally {
      clearTimeout(timer);
    }
    const text = (message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join(' ');
    return await store.add(owner, session.id, text);
  } catch (err) {
    console.error('[continuidad]', err.message);
    return false;
  }
}
