import { timingSafeEqual } from 'node:crypto';

const VERIFY_CACHE_MS = 60_000;
export const DEVICE_PREFIX = 'pxd_';

const bearer = (header) => (String(header ?? '').startsWith('Bearer ') ? String(header).slice(7).trim() : '');

function sameToken(given, expected) {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b); // tiempo constante
}

/**
 * Identifica quién se conecta. Dos tipos de credencial:
 *  - token de dispositivo (pxd_…): emitido por MyRAYPA al emparejar, uno por móvil y revocable. Se verifica en MyRAYPA.
 *  - PRAXON_TOKEN compartido (solo desarrollo; se desactiva con ALLOW_LEGACY_TOKEN=false).
 */
export class DeviceAuth {
  #config;
  #myraypa;
  #now;
  #cache = new Map(); // token -> { at, identity|null }

  constructor({ config, myraypa, now = Date.now }) {
    this.#config = config;
    this.#myraypa = myraypa;
    this.#now = now;
  }

  /** @returns {Promise<null | {kind:'legacy'|'device', user:string, email:string|null, deviceId:string|null, key:string, token?:string}>} */
  async authenticate(header) {
    const token = bearer(header);
    if (!token) return null;
    if (token.startsWith(DEVICE_PREFIX)) return this.verify(token);
    if (this.#config.ALLOW_LEGACY_TOKEN && sameToken(token, this.#config.PRAXON_TOKEN)) {
      return { kind: 'legacy', user: this.#config.PRAXON_USER, email: null, deviceId: null, key: 'legacy' };
    }
    return null;
  }

  /** Verifica un token de dispositivo. `fresh` ignora la caché (revocaciones). Lanza si MyRAYPA no responde. */
  async verify(token, { fresh = false } = {}) {
    const hit = this.#cache.get(token);
    if (!fresh && hit && this.#now() - hit.at < VERIFY_CACHE_MS) return hit.identity;
    const r = await this.#myraypa.verifyDevice(token);
    const identity = r?.ok
      ? { kind: 'device', user: r.username || r.email, email: r.email, deviceId: r.deviceId, key: `device:${r.deviceId}`, token }
      : null;
    this.#cache.set(token, { at: this.#now(), identity });
    if (this.#cache.size > 500) for (const [k, v] of this.#cache) if (this.#now() - v.at > VERIFY_CACHE_MS) this.#cache.delete(k);
    return identity;
  }
}

/** Límite de intentos por clave (IP) en una ventana. En memoria; suficiente para frenar adivinar códigos. */
export class RateLimiter {
  #max;
  #windowMs;
  #now;
  #hits = new Map();

  constructor({ max = 10, windowMs = 10 * 60 * 1000, now = Date.now } = {}) {
    this.#max = max;
    this.#windowMs = windowMs;
    this.#now = now;
  }

  /** true si se permite el intento (y lo cuenta). */
  take(key) {
    const t = this.#now();
    const list = (this.#hits.get(key) ?? []).filter((x) => t - x < this.#windowMs);
    if (list.length >= this.#max) {
      this.#hits.set(key, list);
      return false;
    }
    list.push(t);
    this.#hits.set(key, list);
    if (this.#hits.size > 1000) for (const [k, v] of this.#hits) if (v.every((x) => t - x >= this.#windowMs)) this.#hits.delete(k);
    return true;
  }
}
