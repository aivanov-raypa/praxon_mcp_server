/**
 * Sintesis de voz con ElevenLabs (solo la voz de las respuestas; el reconocimiento sigue en el movil).
 * La clave vive solo en el servidor. Cada frase se sintetiza por separado y la app las reproduce en orden.
 *
 * Interfaz de un proveedor de voz:
 *   synthesize(text, { signal, previousText }) -> Promise<{ format: 'mp3', data: <base64> }>
 * Si falla, el orquestador manda el texto y la app lo lee con la voz de Android.
 *
 * API: POST {baseUrl}/v1/text-to-speech/{voice_id}?output_format=...  (cabecera xi-api-key)
 * Privacidad: el texto de cada frase sale hacia ElevenLabs. Hay endpoint de residencia en la UE
 * (api.eu.residency.elevenlabs.io), pero es solo para clientes Enterprise y con otra cuenta y otra clave.
 */
export class VoiceError extends Error {}

/** Motivo que da ElevenLabs en el cuerpo del error (nunca incluye la clave). Vacío si no hay. */
async function errorDetail(res) {
  try {
    const raw = (await res.text()).slice(0, 2000);
    let detail;
    try {
      const j = JSON.parse(raw);
      detail = typeof j.detail === 'string' ? j.detail : [j.detail?.status, j.detail?.message].filter(Boolean).join(': ') || undefined;
      if (!detail && Array.isArray(j.detail)) detail = j.detail.map((d) => d.msg).filter(Boolean).join('; ');
    } catch {
      detail = raw;
    }
    detail = String(detail ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    return detail ? ` (${detail})` : '';
  } catch {
    return '';
  }
}

export class ElevenLabsVoice {
  #apiKey;
  #voiceId;
  #model;
  #outputFormat;
  #baseUrl;
  #languageCode;
  #fetch;
  #timeoutMs;
  #maxParallel;
  #now;
  #breakerThreshold;
  #breakerCooldownMs;
  #onUsage;

  #active = 0;
  #waiters = [];
  #failures = 0;
  #openUntil = 0;

  constructor({
    apiKey,
    voiceId,
    model = 'eleven_flash_v2_5',
    outputFormat = 'mp3_44100_128',
    baseUrl = 'https://api.elevenlabs.io',
    languageCode = 'es',
    fetchImpl = fetch,
    timeoutMs = 8000,
    maxParallel = 2, // las cuentas tienen limite de peticiones simultaneas
    now = Date.now,
    breakerThreshold = 3,
    breakerCooldownMs = 60_000,
    onUsage = null,
  }) {
    this.#onUsage = onUsage;
    if (!outputFormat.startsWith('mp3_')) throw new VoiceError('La app solo reproduce mp3 (output_format mp3_*).');
    this.#apiKey = apiKey;
    this.#voiceId = voiceId;
    this.#model = model;
    this.#outputFormat = outputFormat;
    this.#baseUrl = baseUrl.replace(/\/+$/, '');
    this.#languageCode = languageCode;
    this.#fetch = fetchImpl;
    this.#timeoutMs = timeoutMs;
    this.#maxParallel = maxParallel;
    this.#now = now;
    this.#breakerThreshold = breakerThreshold;
    this.#breakerCooldownMs = breakerCooldownMs;
  }

  async synthesize(text, { signal, previousText } = {}) {
    // Tras varios fallos seguidos se deja de intentar un rato: es mejor la voz de Android que esperar cada frase.
    if (this.#now() < this.#openUntil) throw new VoiceError('Voz de ElevenLabs en pausa tras varios fallos seguidos.');
    await this.#acquire(signal);
    try {
      return await this.#request(text, { signal, previousText });
    } finally {
      this.#release();
    }
  }

  async #request(text, { signal, previousText }) {
    const body = { text, model_id: this.#model };
    if (previousText) body.previous_text = previousText;
    if (this.#languageCode && this.#model !== 'eleven_multilingual_v2') body.language_code = this.#languageCode;

    const timeout = AbortSignal.timeout(this.#timeoutMs);
    let res;
    try {
      res = await this.#fetch(`${this.#baseUrl}/v1/text-to-speech/${encodeURIComponent(this.#voiceId)}?output_format=${this.#outputFormat}`, {
        method: 'POST',
        headers: { 'xi-api-key': this.#apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!res.ok) throw new VoiceError(`ElevenLabs ha respondido ${res.status}${await errorDetail(res)}.`);
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length === 0) throw new VoiceError('ElevenLabs ha devuelto un audio vacío.');
      this.#failures = 0;
      try {
        this.#onUsage?.({ chars: text.length });
      } catch {
        /* el contador nunca debe romper la voz */
      }
      return { format: 'mp3', data: bytes.toString('base64') };
    } catch (err) {
      if (!signal?.aborted) this.#registerFailure(err); // interrumpir al usuario no es un fallo del servicio
      throw err;
    }
  }

  #registerFailure(err) {
    this.#failures++;
    if (this.#failures === 1) console.warn(`[voz] ElevenLabs: ${err.message}`);
    if (this.#failures >= this.#breakerThreshold) {
      this.#openUntil = this.#now() + this.#breakerCooldownMs;
      this.#failures = 0;
      console.warn(`[voz] ElevenLabs falla (${err.message}). Se usa la voz de Android durante ${this.#breakerCooldownMs / 1000} s.`);
    }
  }

  async #acquire(signal) {
    if (this.#active < this.#maxParallel) {
      this.#active++;
      return;
    }
    await new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      this.#waiters.push(waiter);
      signal?.addEventListener(
        'abort',
        () => {
          const i = this.#waiters.indexOf(waiter);
          if (i >= 0) {
            this.#waiters.splice(i, 1);
            reject(new VoiceError('interrumpido'));
          }
        },
        { once: true },
      );
    });
  }

  #release() {
    const next = this.#waiters.shift();
    if (next) next.resolve();
    else this.#active--;
  }
}

/** Para tests: no llama a ningun servicio. */
export class FakeVoice {
  calls = [];
  failWhen = () => false;

  async synthesize(text, opts = {}) {
    this.calls.push({ text, previousText: opts.previousText });
    if (this.failWhen(text)) throw new VoiceError('voz simulada: fallo');
    return { format: 'mp3', data: Buffer.from(`audio:${text}`).toString('base64') };
  }
}
