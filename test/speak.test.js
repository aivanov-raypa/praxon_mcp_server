import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createApp } from '../src/app.js';
import { MemoryAudit } from '../src/audit/log.js';
import { loadConfig } from '../src/config.js';
import { FakeVoice } from '../src/voice/elevenlabs.js';

const TOKEN = 'token-de-pruebas-1234';
let app;
afterEach(async () => app?.server.close());

async function start(voice) {
  const config = loadConfig({ PRAXON_TOKEN: TOKEN, PORT: '0', HOST: '127.0.0.1', PRAXON_USER: 'alex' });
  app = createApp(config, { audit: new MemoryAudit(), voice });
  const port = await app.server.listen();
  const ws = await new Promise((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    s.messages = [];
    s.on('message', (m) => s.messages.push(JSON.parse(m)));
    s.on('open', () => resolve(s));
    s.on('error', reject);
  });
  return ws;
}
const waitFor = async (ws, pred) => {
  for (let i = 0; i < 300; i++) {
    const m = ws.messages.find(pred);
    if (m) return m;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`no llego. Recibidos: ${JSON.stringify(ws.messages)}`);
};
const speak = (ws, id, text) => ws.send(JSON.stringify({ type: 'speak', id, text }));

describe('frases propias de la app con voz de ElevenLabs', () => {
  it('anuncia si hay voz y devuelve el audio de la frase', async () => {
    const voice = new FakeVoice();
    const ws = await start(voice);
    expect((await waitFor(ws, (m) => m.type === 'capabilities')).voice).toBe(true);
    speak(ws, 'a1', 'No te he entendido. Di confirmo o cancela.');
    const r = await waitFor(ws, (m) => m.type === 'speech' && m.id === 'a1');
    expect(r).toMatchObject({ text: 'No te he entendido. Di confirmo o cancela.', format: 'mp3' });
    expect(Buffer.from(r.data, 'base64').toString()).toContain('audio:No te he entendido');
    ws.close();
  });

  it('las frases repetidas no vuelven a sintetizarse', async () => {
    const voice = new FakeVoice();
    const ws = await start(voice);
    speak(ws, 'a1', 'Frase fija.');
    await waitFor(ws, (m) => m.id === 'a1');
    speak(ws, 'a2', 'Frase fija.');
    await waitFor(ws, (m) => m.id === 'a2');
    expect(voice.calls).toHaveLength(1);
    ws.close();
  });

  it('si la síntesis falla, responde sin audio para que la app use la voz de Android', async () => {
    const voice = new FakeVoice();
    voice.failWhen = () => true;
    const ws = await start(voice);
    speak(ws, 'a1', 'Algo que falla.');
    const r = await waitFor(ws, (m) => m.id === 'a1');
    expect(r).toEqual({ type: 'speech', id: 'a1', text: 'Algo que falla.' });
    ws.close();
  });

  it('sin voz configurada lo dice en capabilities y responde sin audio', async () => {
    const ws = await start(null);
    expect((await waitFor(ws, (m) => m.type === 'capabilities')).voice).toBe(false);
    speak(ws, 'a1', 'Hola.');
    expect(await waitFor(ws, (m) => m.id === 'a1')).toEqual({ type: 'speech', id: 'a1', text: 'Hola.' });
    ws.close();
  });

  it('limita las frases por minuto de cada conexión', async () => {
    const voice = new FakeVoice();
    const ws = await start(voice);
    for (let i = 0; i < 25; i++) speak(ws, `s${i}`, `Frase número ${i}.`);
    await waitFor(ws, (m) => m.id === 's24');
    expect(voice.calls.length).toBe(20);
    ws.close();
  });
});
