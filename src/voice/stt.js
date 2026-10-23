import WebSocket from 'ws';

/**
 * Transcripción en directo con ElevenLabs Scribe (realtime). La app envía audio PCM de 16 kHz al servidor y el servidor
 * lo reenvía a Scribe; la clave vive solo aquí. Cada "stream" transcribe UNA intervención del usuario: termina al
 * llegar el primer texto confirmado (Scribe detecta el silencio con su VAD) o al llamar a finish()/close().
 *
 * Interfaz de un proveedor de transcripción:
 *   open({ onPartial(text), onFinal(text), onError(message), onClose() }) -> { send(pcm: Buffer), finish(), close() }
 *
 * API: wss://api.elevenlabs.io/v1/speech-to-text/realtime (cabecera xi-api-key). Mensajes: input_audio_chunk
 * {audio_base_64, commit, sample_rate} y, de vuelta, partial_transcript / committed_transcript {text}.
 * Privacidad: el audio de lo que dices sale hacia ElevenLabs mientras la app está escuchando.
 */
export const SAMPLE_RATE = 16_000;

const ERROR_TEXT = {
  auth_error: 'La clave de ElevenLabs no es válida.',
  quota_exceeded: 'Se ha agotado la cuota de transcripción de ElevenLabs.',
  rate_limited: 'ElevenLabs está limitando las peticiones.',
  insufficient_audio_activity: null, // silencio prolongado: no es un fallo
};

export class ElevenLabsScribe {
  #cfg;

  constructor({ apiKey, baseUrl = 'wss://api.elevenlabs.io', language = 'es', silenceSecs = 1.2, maxSeconds = 45, WebSocketImpl = WebSocket }) {
    this.#cfg = { apiKey, baseUrl: baseUrl.replace(/\/+$/, ''), language, silenceSecs, maxSeconds, WebSocketImpl };
  }

  open({ onPartial = () => {}, onFinal = () => {}, onError = () => {}, onClose = () => {} }) {
    const { apiKey, baseUrl, language, silenceSecs, maxSeconds, WebSocketImpl } = this.#cfg;
    const q = new URLSearchParams({
      model_id: 'scribe_v2_realtime',
      audio_format: `pcm_${SAMPLE_RATE}`,
      language_code: language,
      commit_strategy: 'vad',
      vad_silence_threshold_secs: String(silenceSecs),
    });
    const ws = new WebSocketImpl(`${baseUrl}/v1/speech-to-text/realtime?${q}`, { headers: { 'xi-api-key': apiKey } });
    let opened = false;
    let closed = false;
    let delivered = false;
    const queue = [];

    const chunk = (pcm, commit) =>
      JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: pcm.toString('base64'), commit, sample_rate: SAMPLE_RATE });

    const end = () => {
      if (closed) return;
      closed = true;
      clearTimeout(cap);
      try {
        ws.close();
      } catch {
        /* ya cerrado */
      }
      onClose();
    };
    const cap = setTimeout(end, maxSeconds * 1000);
    cap.unref?.();

    ws.on('open', () => {
      opened = true;
      for (const m of queue.splice(0)) ws.send(m);
    });
    ws.on('message', (raw) => {
      let m;
      try {
        m = JSON.parse(raw);
      } catch {
        return;
      }
      const type = m.message_type;
      if (type === 'partial_transcript') {
        if (m.text) onPartial(m.text);
      } else if (type === 'committed_transcript') {
        const text = String(m.text ?? '').trim();
        if (text && !delivered) {
          delivered = true;
          onFinal(text);
          end();
        }
      } else if (type && type !== 'session_started' && (m.error || m.warning)) {
        if (type === 'warning') return;
        const known = ERROR_TEXT[type];
        if (known === null) return;
        console.error('[stt]', type, m.error);
        onError(known ?? 'No he podido transcribir el audio.');
        end();
      }
    });
    ws.on('error', (err) => {
      if (closed) return;
      console.error('[stt]', err.message);
      onError('No he podido conectar con el servicio de transcripción.');
      end();
    });
    ws.on('close', end);

    const push = (m) => (opened ? ws.send(m) : queue.push(m));
    return {
      send(pcm) {
        if (!closed && pcm.length) push(chunk(pcm, false));
      },
      /** Fin de lo que el usuario quería decir (tocó para parar): confirma lo transcrito hasta ahora. */
      finish() {
        if (closed) return;
        push(chunk(Buffer.alloc(SAMPLE_RATE * 0.2 * 2), true)); // 200 ms de silencio con commit
        const t = setTimeout(end, 3000); // si no llega texto, se cierra
        t.unref?.();
      },
      close: end,
    };
  }
}
