import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const MAX_NOTAS = 40;
export const MAX_TEXTO = 300;
const PRESUPUESTO_PROMPT = 3000; // caracteres de notas que se inyectan en el prompt

const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/\p{Mn}+/gu, '').replace(/\s+/g, ' ').trim();
// Nunca se guardan credenciales: las notas viajan en el prompt de cada llamada al modelo.
const SECRETO = /(sk-[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9]{10,}|github_pat_\w+|xox[abprs]-[\w-]{10,}|Bearer\s+[A-Za-z0-9._~+/-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY)/;

export class MemoryError extends Error {}

/**
 * Notas que el usuario le pide a Praxon que recuerde (criterios, convenciones, preferencias de trabajo). Solo las crea o
 * borra el usuario, con la confirmación normal de las herramientas de escritura; el modelo nunca las guarda por su cuenta
 * (la revisión automática no tiene permitido escribir aquí). Se inyectan en el prompt con un tope de tamaño.
 * Ámbito: "global" o el nombre de un proyecto.
 */
export class MemoryStore {
  #path;
  #items = [];
  #queue = Promise.resolve();
  #now;

  constructor(path = null, { now = () => new Date() } = {}) {
    this.#path = path;
    this.#now = now;
    if (path) {
      try {
        const data = JSON.parse(readFileSync(path, 'utf8'));
        if (Array.isArray(data)) this.#items = data;
      } catch {
        /* sin fichero todavía, o ilegible: se empieza de cero */
      }
    }
  }

  list() {
    return this.#items.map((n) => ({ ...n }));
  }

  get(id) {
    return this.#items.find((n) => n.id === id);
  }

  /** Valida sin guardar (lo usa summarize antes de pedir la confirmación). */
  check({ texto, ambito = 'global' }) {
    const t = String(texto ?? '').trim();
    if (t.length < 8) throw new MemoryError('La nota es demasiado corta para ser útil.');
    if (t.length > MAX_TEXTO) throw new MemoryError(`La nota es demasiado larga (máximo ${MAX_TEXTO} caracteres). Resúmela.`);
    if (SECRETO.test(t)) throw new MemoryError('No guardo contraseñas, claves ni tokens.');
    if (this.#items.some((n) => norm(n.texto) === norm(t) && norm(n.ambito) === norm(ambito))) throw new MemoryError('Ya tengo esa nota.');
    if (this.#items.length >= MAX_NOTAS) throw new MemoryError(`Ya hay ${MAX_NOTAS} notas guardadas. Borra alguna antes de añadir otra.`);
    return { texto: t, ambito: String(ambito || 'global').trim().slice(0, 60) || 'global' };
  }

  async add({ texto, ambito, user }) {
    const v = this.check({ texto, ambito });
    const nota = { id: randomUUID().slice(0, 8), ambito: v.ambito, texto: v.texto, creadaPor: user ?? null, creada: this.#now().toISOString() };
    this.#items.push(nota);
    await this.#save();
    return { ...nota };
  }

  async remove(id) {
    const i = this.#items.findIndex((n) => n.id === id);
    if (i < 0) throw new MemoryError('No existe esa nota.');
    const [n] = this.#items.splice(i, 1);
    await this.#save();
    return n;
  }

  /** Texto para el prompt: globales primero, luego por proyecto; las más recientes tienen prioridad si no caben. */
  render() {
    if (!this.#items.length) return null;
    const ordenadas = [...this.#items].sort((a, b) => (b.creada ?? '').localeCompare(a.creada ?? ''));
    const dentro = [];
    let usado = 0;
    for (const n of ordenadas) {
      const linea = n.ambito === 'global' ? n.texto : `[${n.ambito}] ${n.texto}`;
      if (usado + linea.length > PRESUPUESTO_PROMPT) continue;
      usado += linea.length;
      dentro.push(n);
    }
    const globales = dentro.filter((n) => n.ambito === 'global').map((n) => `- ${n.texto}`);
    const proyectos = dentro.filter((n) => n.ambito !== 'global').map((n) => `- En ${n.ambito}: ${n.texto}`);
    return [...globales, ...proyectos].join('\n');
  }

  #save() {
    if (!this.#path) return Promise.resolve();
    const snapshot = JSON.stringify(this.#items);
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
