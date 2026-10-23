/**
 * Panel de consumos: junta los contadores propios de Praxon con lo que informan ElevenLabs, GitHub y Anthropic.
 * Los proveedores externos se consultan como mucho cada `cacheMs` (aunque haya varios moviles mirando) y cada uno
 * falla por separado: si uno no responde, el panel muestra los demas.
 */
export class UsageService {
  #tracker;
  #providers;
  #cacheMs;
  #now;
  #cache = new Map();

  constructor({ tracker, providers = {}, cacheMs = 10 * 60_000, now = Date.now }) {
    this.#tracker = tracker;
    this.#providers = providers;
    this.#cacheMs = cacheMs;
    this.#now = now;
  }

  async #provider(name) {
    const fn = this.#providers[name];
    if (!fn) return { estado: 'sin_configurar', mensaje: 'No disponible.' };
    const hit = this.#cache.get(name);
    if (hit && this.#now() - hit.at < this.#cacheMs) return hit.value;
    const value = await fn().catch((err) => ({ estado: 'error', mensaje: err.message }));
    // Los errores se cachean poco para reintentar pronto sin saturar al servicio.
    this.#cache.set(name, { at: value.estado === 'ok' ? this.#now() : this.#now() - this.#cacheMs + 30_000, value });
    return value;
  }

  async get({ refresh = false } = {}) {
    if (refresh) this.#cache.clear();
    const [elevenlabs, github, anthropic] = await Promise.all([this.#provider('elevenlabs'), this.#provider('github'), this.#provider('anthropic')]);
    return {
      generado: new Date(this.#now()).toISOString(),
      praxon: this.#tracker.summary(14),
      elevenlabs,
      github,
      anthropic,
    };
  }
}
