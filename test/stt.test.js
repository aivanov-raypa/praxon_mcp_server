import { afterEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { createApp } from '../src/app.js';
import { MemoryAudit } from '../src/audit/log.js';
import { loadConfig } from '../src/config.js';
import { ElevenLabsScribe } from '../src/voice/stt.js';

const LEGACY = 'token-de-pruebas-1234';
const until = async (pred, what = 'condición') => {
  for (let i = 0; i < 300; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`no se cumplió: ${what}`);
};

/** Falso Scribe: un servidor WebSocket que anota lo recibido y responde como la API real. */
async function fakeScribe(onConnection) {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const seen = { urls: [], headers: [], chunks: [] };
  wss.on('connection', (ws, req) => {
    seen.urls.push(req.url);
    seen.headers.push(req.headers['xi-api-key']);
    ws.send(JSON.stringify({ message_type: 'session_started', session_id: 's1', config: {} }));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      seen.chunks.push(m);
      onConnection?.(ws, m);
    });
  });
  await new Promise((r) => wss.on('listening', r));
  return { wss, seen, url: `ws://127.0.0.1:${wss.address().port}` };
}

let toClose = [];
afterEach(async () => {
  for (const c of toClose.splice(0)) await c();
});

describe('ElevenLabsScribe', () => {
  it('abre la sesión con los parámetros y la clave correctos, y reenvía el audio en base64', async () => {
    const fake = await fakeScribe();
    toClose.push(() => new Promise((r) => fake.wss.close(r)));
    const events = [];
    const scribe = new ElevenLabsScribe({ apiKey: 'k-123', baseUrl: fake.url, language: 'es', silenceSecs: 1.5 });
    const s = scribe.open({ onPartial: (t) => events.push(['p', t]), onFinal: (t) => events.push(['f', t]), onError: (m) => events.push(['e', m]) });
    s.send(Buffer.from([1, 2, 3, 4])); // antes de abrir: se encola
    await until(() => fake.seen.chunks.length === 1, 'audio recibido');
    const u = new URL(fake.seen.urls[0], 'http://x');
    expect(u.pathname).toBe('/v1/speech-to-text/realtime');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ model_id: 'scribe_v2_realtime', audio_format: 'pcm_16000', language_code: 'es', commit_strategy: 'vad', vad_silence_threshold_secs: '1.5' });
    expect(fake.seen.headers[0]).toBe('k-123');
    expect(fake.seen.chunks[0]).toMatchObject({ message_type: 'input_audio_chunk', audio_base_64: Buffer.from([1, 2, 3, 4]).toString('base64'), commit: false, sample_rate: 16000 });
    s.close();
  });

  it('parciales y primer texto confirmado; después se cierra', async () => {
    const fake = await fakeScribe((ws, m) => {
      if (m.commit === false) {
        ws.send(JSON.stringify({ message_type: 'partial_transcript', text: 'hola' }));
        ws.send(JSON.stringify({ message_type: 'committed_transcript', text: ' hola qué tal ' }));
        ws.send(JSON.stringify({ message_type: 'committed_transcript', text: 'segundo' }));
      }
    });
    toClose.push(() => new Promise((r) => fake.wss.close(r)));
    const events = [];
    let closed = false;
    const s = new ElevenLabsScribe({ apiKey: 'k', baseUrl: fake.url }).open({
      onPartial: (t) => events.push(['p', t]),
      onFinal: (t) => events.push(['f', t]),
      onClose: () => (closed = true),
    });
    s.send(Buffer.alloc(3200));
    await until(() => closed, 'cierre');
    expect(events).toEqual([['p', 'hola'], ['f', 'hola qué tal']]);
  });

  it('finish() manda silencio con commit y entrega lo transcrito', async () => {
    const fake = await fakeScribe((ws, m) => {
      if (m.commit) ws.send(JSON.stringify({ message_type: 'committed_transcript', text: 'dicho al parar' }));
    });
    toClose.push(() => new Promise((r) => fake.wss.close(r)));
    const finals = [];
    const s = new ElevenLabsScribe({ apiKey: 'k', baseUrl: fake.url }).open({ onFinal: (t) => finals.push(t) });
    s.send(Buffer.alloc(3200));
    s.finish();
    await until(() => finals.length === 1, 'texto final');
    expect(finals).toEqual(['dicho al parar']);
    expect(fake.seen.chunks.at(-1).commit).toBe(true);
  });

  it('errores de la API: mensaje claro y sin filtrar detalles; el silencio no es un error', async () => {
    const fake = await fakeScribe((ws) => ws.send(JSON.stringify({ message_type: 'auth_error', error: 'Invalid API key sk_secreta' })));
    toClose.push(() => new Promise((r) => fake.wss.close(r)));
    const errors = [];
    new ElevenLabsScribe({ apiKey: 'mala', baseUrl: fake.url }).open({ onError: (m) => errors.push(m) }).send(Buffer.alloc(10));
    await until(() => errors.length === 1, 'error');
    expect(errors[0]).toBe('La clave de ElevenLabs no es válida.');

    const quiet = await fakeScribe((ws) => ws.send(JSON.stringify({ message_type: 'insufficient_audio_activity', error: 'sin audio' })));
    toClose.push(() => new Promise((r) => quiet.wss.close(r)));
    const errs2 = [];
    let closed = false;
    new ElevenLabsScribe({ apiKey: 'k', baseUrl: quiet.url, maxSeconds: 0.3 }).open({ onError: (m) => errs2.push(m), onClose: () => (closed = true) }).send(Buffer.alloc(10));
    await until(() => closed, 'cierre por tiempo');
    expect(errs2).toEqual([]);
  });

  it('si no se puede conectar, avisa una sola vez', async () => {
    const errors = [];
    let closes = 0;
    new ElevenLabsScribe({ apiKey: 'k', baseUrl: 'ws://127.0.0.1:1' }).open({ onError: (m) => errors.push(m), onClose: () => closes++ });
    await until(() => closes > 0, 'cierre');
    expect(errors).toEqual(['No he podido conectar con el servicio de transcripción.']);
    expect(closes).toBe(1);
  });
});

describe('dictado por el WebSocket del servidor', () => {
  let app;
  afterEach(async () => app?.server.close());

  /** Proveedor de transcripción de pruebas. */
  const fakeStt = () => {
    const streams = [];
    return {
      streams,
      open(handlers) {
        const st = { handlers, audio: [], finished: false, closed: false };
        st.send = (b) => st.audio.push(b);
        st.finish = () => (st.finished = true);
        st.close = () => {
          if (!st.closed) {
            st.closed = true;
            handlers.onClose();
          }
        };
        streams.push(st);
        return st;
      },
    };
  };

  async function start(stt) {
    const config = loadConfig({ PRAXON_TOKEN: LEGACY, PORT: '0', HOST: '127.0.0.1', PRAXON_USER: 'alex', ALLOW_LEGACY_TOKEN: 'true' });
    app = createApp(config, { audit: new MemoryAudit(), ...(stt ? { stt } : {}) });
    const port = await app.server.listen();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Authorization: `Bearer ${LEGACY}` } });
    ws.messages = [];
    ws.on('message', (m, bin) => !bin && ws.messages.push(JSON.parse(m)));
    await new Promise((r) => ws.on('open', r));
    toClose.push(async () => ws.close());
    return ws;
  }
  const has = (ws, type) => ws.messages.find((m) => m.type === type);

  it('anuncia si hay transcripción disponible', async () => {
    expect((await start(null).then((ws) => (until(() => has(ws, 'capabilities')).then(() => has(ws, 'capabilities')))))).toMatchObject({ stt: false });
  });

  it('con transcripción: audio binario al proveedor y texto de vuelta a la app', async () => {
    const stt = fakeStt();
    const ws = await start(stt);
    await until(() => has(ws, 'capabilities'));
    expect(has(ws, 'capabilities').stt).toBe(true);
    ws.send(JSON.stringify({ type: 'stt_start' }));
    await until(() => stt.streams.length === 1, 'stream abierto');
    ws.send(Buffer.from([9, 9, 9]), { binary: true });
    await until(() => stt.streams[0].audio.length === 1, 'audio recibido');
    expect([...stt.streams[0].audio[0]]).toEqual([9, 9, 9]);
    stt.streams[0].handlers.onPartial('hola');
    stt.streams[0].handlers.onFinal('hola mundo');
    await until(() => has(ws, 'stt_final'), 'texto final');
    expect(has(ws, 'stt_partial').text).toBe('hola');
    expect(has(ws, 'stt_final').text).toBe('hola mundo');
    ws.send(JSON.stringify({ type: 'stt_stop' }));
    await until(() => stt.streams[0].finished, 'finish');
  });

  it('sin proveedor, stt_start da un error legible; el audio suelto se ignora', async () => {
    const ws = await start(null);
    ws.send(JSON.stringify({ type: 'stt_start' }));
    ws.send(Buffer.from([1]), { binary: true });
    await until(() => has(ws, 'stt_error'), 'error');
    expect(has(ws, 'stt_error').message).toMatch(/no está configurada/);
  });

  it('empezar otro dictado cierra el anterior sin avisar de un cierre falso; cerrar la conexión corta el stream', async () => {
    const stt = fakeStt();
    const ws = await start(stt);
    ws.send(JSON.stringify({ type: 'stt_start' }));
    await until(() => stt.streams.length === 1);
    ws.send(JSON.stringify({ type: 'stt_start' }));
    await until(() => stt.streams.length === 2);
    expect(stt.streams[0].closed).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(has(ws, 'stt_ended')).toBeUndefined();
    ws.close();
    await until(() => stt.streams[1].closed, 'stream cerrado con la conexión');
  });

  it('stt_cancel cierra el dictado sin entregar nada', async () => {
    const stt = fakeStt();
    const ws = await start(stt);
    ws.send(JSON.stringify({ type: 'stt_start' }));
    await until(() => stt.streams.length === 1);
    ws.send(JSON.stringify({ type: 'stt_cancel' }));
    await until(() => stt.streams[0].closed, 'stream cerrado');
    stt.streams[0].handlers.onFinal('tarde');
    await new Promise((r) => setTimeout(r, 50));
    expect(has(ws, 'stt_final')).toBeUndefined();
    expect(has(ws, 'stt_ended')).toBeUndefined();
  });

  it('config: STT_PROVIDER=elevenlabs exige la clave', () => {
    expect(() => loadConfig({ PRAXON_TOKEN: LEGACY, STT_PROVIDER: 'elevenlabs' })).toThrow(/ELEVENLABS_API_KEY/);
    expect(loadConfig({ PRAXON_TOKEN: LEGACY, STT_PROVIDER: 'elevenlabs', ELEVENLABS_API_KEY: 'k' }).STT_SILENCE_SECS).toBe(1.2);
  });
});
