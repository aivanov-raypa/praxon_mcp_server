import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Contadores propios de consumo de Praxon: lo que este servidor gasta en Anthropic (tokens por modelo) y en ElevenLabs
 * (caracteres de voz y segundos de dictado), agregado por dia. Se alimenta con lo que devuelven las propias llamadas, asi
 * que no necesita credenciales de administracion. No incluye lo que gastan los agentes de GitHub (otra clave).
 * Se guarda en disco (path) y conserva KEEP_DAYS dias.
 */
const KEEP_DAYS = 90;
// Día de Madrid (en-CA da AAAA-MM-DD): el tope diario se reinicia a medianoche de Madrid, no de UTC.
const FECHA_MADRID = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' });
const dayOf = (ms) => FECHA_MADRID.format(new Date(ms));

export class UsageTracker {
  #path;
  #now;
  #days = {};
  #timer = null;

  constructor(path = null, { now = Date.now } = {}) {
    this.#path = path;
    this.#now = now;
    if (path && existsSync(path)) {
      try {
        const data = JSON.parse(readFileSync(path, 'utf8'));
        if (data && typeof data.days === 'object') this.#days = data.days;
      } catch (err) {
        console.error('[consumo] no se ha podido leer el historial:', err.message);
      }
    }
  }

  #today() {
    const k = dayOf(this.#now());
    return (this.#days[k] ??= { anthropic: {}, elevenlabs: { ttsChars: 0, ttsCalls: 0, sttSeconds: 0, sttCalls: 0 } });
  }

  /** Tokens de hoy por modelo ({ modelo: {input, output, cacheRead, cacheWrite} }), de todo o solo de un uso ('revision', 'resumen'...). */
  todayTokens(uso = null) {
    const d = this.#days[dayOf(this.#now())];
    if (!d) return {};
    return uso ? { ...(d.uso?.[uso] ?? {}) } : { ...d.anthropic };
  }

  /** Una llamada al modelo: tokens de entrada, salida y de cache. `uso` dice para qué fue (conversacion, revision, resumen). */
  recordModel({ model, input = 0, output = 0, cacheRead = 0, cacheWrite = 0, uso = 'conversacion' }) {
    const u = (((this.#today().uso ??= {})[uso] ??= {})[model || 'desconocido'] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 });
    u.input += input;
    u.output += output;
    u.cacheRead += cacheRead;
    u.cacheWrite += cacheWrite;
    u.calls += 1;
    const m = ((this.#today().anthropic[model || 'desconocido'] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 }));
    m.input += input;
    m.output += output;
    m.cacheRead += cacheRead;
    m.cacheWrite += cacheWrite;
    m.calls += 1;
    this.#schedule();
  }

  recordTts(chars) {
    const e = this.#today().elevenlabs;
    e.ttsChars += chars;
    e.ttsCalls += 1;
    this.#schedule();
  }

  recordStt(seconds) {
    const e = this.#today().elevenlabs;
    e.sttSeconds += seconds;
    e.sttCalls += 1;
    this.#schedule();
  }

  /** Serie diaria de los ultimos `days` dias (los dias sin actividad salen a cero) y totales del periodo. */
  summary(days = 14) {
    const now = this.#now();
    const serie = [];
    const modelos = {};
    const tot = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, ttsChars: 0, ttsCalls: 0, sttSeconds: 0, sttCalls: 0 };
    for (let i = days - 1; i >= 0; i--) {
      const fecha = dayOf(now - i * 86_400_000);
      const d = this.#days[fecha];
      const dia = { fecha, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0, ttsChars: 0, sttSeconds: 0 };
      if (d) {
        for (const [model, m] of Object.entries(d.anthropic)) {
          for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'calls']) {
            dia[k] += m[k];
            tot[k] += m[k];
          }
          const acc = (modelos[model] ??= { modelo: model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 });
          for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'calls']) acc[k] += m[k];
        }
        dia.ttsChars = d.elevenlabs.ttsChars;
        dia.sttSeconds = Math.round(d.elevenlabs.sttSeconds);
        tot.ttsChars += d.elevenlabs.ttsChars;
        tot.ttsCalls += d.elevenlabs.ttsCalls;
        tot.sttSeconds += d.elevenlabs.sttSeconds;
        tot.sttCalls += d.elevenlabs.sttCalls;
      }
      serie.push(dia);
    }
    tot.sttSeconds = Math.round(tot.sttSeconds);
    return {
      dias: days,
      serie,
      totales: tot,
      modelos: Object.values(modelos).sort((a, b) => b.input + b.output - (a.input + a.output)),
    };
  }

  #schedule() {
    if (!this.#path || this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.save().catch((err) => console.error('[consumo]', err.message));
    }, 5_000);
    this.#timer.unref?.();
  }

  async save() {
    if (!this.#path) return;
    const limit = dayOf(this.#now() - KEEP_DAYS * 86_400_000);
    for (const k of Object.keys(this.#days)) if (k < limit) delete this.#days[k];
    await mkdir(dirname(this.#path), { recursive: true });
    const tmp = `${this.#path}.tmp`;
    await writeFile(tmp, JSON.stringify({ days: this.#days }), 'utf8');
    await rename(tmp, this.#path);
  }
}
