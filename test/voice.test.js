import { describe, expect, it, vi } from 'vitest';
import { ElevenLabsVoice, FakeVoice } from '../src/voice/elevenlabs.js';
import { setup, stubModel } from './helpers.js';

const audioRes = (text = 'mp3') => new Response(Buffer.from(text), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } });
const b64 = (t) => Buffer.from(t).toString('base64');
const texts = (out) => out.filter((m) => m.type === 'assistant_chunk' || m.type === 'assistant_audio').map((m) => `${m.type}:${m.text}`);

describe('ElevenLabsVoice', () => {
  it('llama a la API con clave, voz, modelo, formato y contexto de la frase anterior', async () => {
    const fetchImpl = vi.fn(async () => audioRes('abc'));
    const v = new ElevenLabsVoice({ apiKey: 'k', voiceId: 'voz 1', fetchImpl });
    const out = await v.synthesize('Hola mundo.', { previousText: 'Antes.' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.elevenlabs.io/v1/text-to-speech/voz%201?output_format=mp3_44100_128');
    expect(init.headers['xi-api-key']).toBe('k');
    expect(JSON.parse(init.body)).toEqual({ text: 'Hola mundo.', model_id: 'eleven_flash_v2_5', previous_text: 'Antes.', language_code: 'es' });
    expect(out).toEqual({ format: 'mp3', data: b64('abc') });
  });

  it('no manda language_code con eleven_multilingual_v2 y usa el endpoint de la UE si se configura', async () => {
    const fetchImpl = vi.fn(async () => audioRes());
    const v = new ElevenLabsVoice({ apiKey: 'k', voiceId: 'v', model: 'eleven_multilingual_v2', baseUrl: 'https://api.eu.residency.elevenlabs.io/', fetchImpl });
    await v.synthesize('Hola.');
    expect(fetchImpl.mock.calls[0][0]).toMatch(/^https:\/\/api\.eu\.residency\.elevenlabs\.io\/v1\//);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).language_code).toBeUndefined();
  });

  it('solo admite formatos mp3 (es lo que reproduce la app)', () => {
    expect(() => new ElevenLabsVoice({ apiKey: 'k', voiceId: 'v', outputFormat: 'pcm_16000' })).toThrow(/mp3/);
  });

  it('rechaza respuestas con error o vacias', async () => {
    const bad = new ElevenLabsVoice({ apiKey: 'k', voiceId: 'v', fetchImpl: async () => new Response('{}', { status: 401 }) });
    await expect(bad.synthesize('Hola.')).rejects.toThrow(/401/);
    const empty = new ElevenLabsVoice({ apiKey: 'k', voiceId: 'v', fetchImpl: async () => new Response(null, { status: 200 }) });
    await expect(empty.synthesize('Hola.')).rejects.toThrow(/vacío/);
  });

  it('tras varios fallos seguidos deja de llamar a la API un rato y luego vuelve a intentarlo', async () => {
    let t = 0;
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 500 }));
    const v = new ElevenLabsVoice({ apiKey: 'k', voiceId: 'v', fetchImpl, now: () => t, breakerThreshold: 3, breakerCooldownMs: 60_000 });
    for (let i = 0; i < 3; i++) await expect(v.synthesize('x.')).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    await expect(v.synthesize('x.')).rejects.toThrow(/en pausa/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    t = 61_000;
    await expect(v.synthesize('x.')).rejects.toThrow(/500/);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('interrumpir al usuario no cuenta como fallo del servicio', async () => {
    const fetchImpl = vi.fn(
      (_u, init) =>
        new Promise((_r, rej) => {
          if (init.signal.aborted) rej(new Error('abortado')); // como hace fetch de verdad
          init.signal.addEventListener('abort', () => rej(new Error('abortado')));
        }),
    );
    const v = new ElevenLabsVoice({ apiKey: 'k', voiceId: 'v', fetchImpl, breakerThreshold: 1 });
    const c = new AbortController();
    const p = v.synthesize('x.', { signal: c.signal });
    c.abort();
    await expect(p).rejects.toThrow();
    fetchImpl.mockImplementation(async () => audioRes());
    await expect(v.synthesize('y.')).resolves.toBeTruthy();
  });

  it('limita las peticiones simultaneas', async () => {
    let active = 0;
    let max = 0;
    const fetchImpl = async () => {
      active++;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 15));
      active--;
      return audioRes();
    };
    const v = new ElevenLabsVoice({ apiKey: 'k', voiceId: 'v', fetchImpl, maxParallel: 2 });
    await Promise.all(['a.', 'b.', 'c.', 'd.', 'e.'].map((t) => v.synthesize(t)));
    expect(max).toBe(2);
  });
});

describe('audio en las respuestas', () => {
  const frases = [{ type: 'text', text: 'Primera frase de la respuesta. Segunda frase de la respuesta. Tercera frase final.' }];

  it('manda cada frase como audio, en orden, aunque la sintesis termine desordenada', async () => {
    const voice = new FakeVoice();
    const original = voice.synthesize.bind(voice);
    voice.synthesize = async (text, o) => {
      await new Promise((r) => setTimeout(r, text.startsWith('Primera') ? 30 : 1)); // la primera tarda mas
      return original(text, o);
    };
    const s = setup({ model: stubModel(frases), voice });
    await s.orchestrator.handleUserText(s.session, { text: 'hola', audio: 'mp3', requestId: 'r' }, s.emit);
    expect(texts(s.out)).toEqual([
      'assistant_audio:Primera frase de la respuesta.',
      'assistant_audio:Segunda frase de la respuesta.',
      'assistant_audio:Tercera frase final.',
    ]);
    expect(s.out.at(-1)).toEqual({ type: 'assistant_done', requestId: 'r' });
    const first = s.out[0];
    expect(Buffer.from(first.data, 'base64').toString()).toBe('audio:Primera frase de la respuesta.');
    expect(first).toMatchObject({ format: 'mp3', requestId: 'r' });
    expect(voice.calls.find((c) => c.text.startsWith('Segunda')).previousText).toBe('Primera frase de la respuesta.');
  });

  it('si falla la sintesis de una frase, esa frase va como texto para la voz de Android', async () => {
    const voice = new FakeVoice();
    voice.failWhen = (t) => t.startsWith('Segunda');
    const s = setup({ model: stubModel(frases), voice });
    await s.orchestrator.handleUserText(s.session, { text: 'hola', audio: 'mp3' }, s.emit);
    expect(texts(s.out)).toEqual([
      'assistant_audio:Primera frase de la respuesta.',
      'assistant_chunk:Segunda frase de la respuesta.',
      'assistant_audio:Tercera frase final.',
    ]);
  });

  it('sin audio pedido por la app, o sin proveedor de voz, todo va como texto', async () => {
    const voice = new FakeVoice();
    const a = setup({ model: stubModel(frases), voice });
    await a.orchestrator.handleUserText(a.session, { text: 'hola' }, a.emit);
    expect(a.out.every((m) => m.type !== 'assistant_audio')).toBe(true);
    expect(voice.calls).toHaveLength(0);
    const b = setup({ model: stubModel(frases), voice: null });
    await b.orchestrator.handleUserText(b.session, { text: 'hola', audio: 'mp3' }, b.emit);
    expect(b.out.every((m) => m.type !== 'assistant_audio')).toBe(true);
  });

  it('la pregunta de confirmacion lleva su audio, y tambien la respuesta tras confirmar', async () => {
    const voice = new FakeVoice();
    const s = setup({ voice });
    await s.orchestrator.handleUserText(s.session, { text: 'Pasa el de los faltantes a urgente', audio: 'mp3' }, s.emit);
    const req = s.last('confirm_request');
    expect(Buffer.from(req.audio.data, 'base64').toString()).toBe(`audio:${req.summary}. ¿Confirmas?`);
    await s.orchestrator.handleConfirm(s.session, { actionId: req.actionId, accepted: true }, s.emit);
    expect(s.out.some((m) => m.type === 'assistant_audio' && m.text.startsWith('Hecho'))).toBe(true);
  });

  it('si falla el audio de la pregunta, confirm_request va sin audio y la app la lee ella', async () => {
    const voice = new FakeVoice();
    voice.failWhen = (t) => t.endsWith('¿Confirmas?');
    const s = setup({ voice });
    await s.orchestrator.handleUserText(s.session, { text: 'Pasa el de los faltantes a urgente', audio: 'mp3' }, s.emit);
    expect(s.last('confirm_request').audio).toBeUndefined();
  });

  it('una interrupcion no envia audio de la respuesta anterior', async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    const voice = new FakeVoice();
    const original = voice.synthesize.bind(voice);
    voice.synthesize = async (t, o) => {
      if (t.startsWith('Primera')) await gate;
      return original(t, o);
    };
    const s = setup({ model: stubModel(frases, [{ type: 'text', text: 'Respuesta nueva y correcta.' }]), voice });
    const first = s.orchestrator.handleUserText(s.session, { text: 'uno', audio: 'mp3', requestId: 'A' }, s.emit);
    await new Promise((r) => setTimeout(r, 10));
    const second = s.orchestrator.handleUserText(s.session, { text: 'dos', audio: 'mp3', requestId: 'B' }, s.emit);
    release();
    await Promise.all([first, second]);
    expect(s.out.filter((m) => m.requestId === 'A')).toHaveLength(0);
    expect(s.out.filter((m) => m.requestId === 'B').map((m) => m.type)).toEqual(['assistant_audio', 'assistant_done']);
  });
});
