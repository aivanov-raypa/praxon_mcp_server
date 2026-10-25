import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createApp } from '../src/app.js';
import { isLoopback, lanUrls, pairingUri, pairingUrls } from '../src/pairing.js';

const config = { PORT: 0, HOST: '127.0.0.1', PRAXON_TOKEN: 'token-de-prueba-123', PRAXON_USER: 'alex', ALLOW_LEGACY_TOKEN: true, PRAXON_PUBLIC_URL: 'ws://192.168.1.5:8090/ws', ASSISTANT_NAME: 'Praxon', MODEL_PROVIDER: 'scripted', MYRAYPA_MODE: 'fake', GITHUB_MODE: 'fake', VOICE_PROVIDER: 'none', AUDIT_LOG_PATH: ':memory:', CONFIRM_TTL_MS: 1000, MAX_TOOL_ITERATIONS: 3, MAX_HISTORY_MESSAGES: 10, MODEL_DEFAULT: 't', MAX_TOKENS: 100 };

describe('emparejamiento por QR', () => {
  it('el contenido del QR lleva dirección y token y se puede descodificar', () => {
    const uri = pairingUri({ url: 'ws://192.168.1.20:8090/ws', token: 'abc 123&x', name: 'Praxon' });
    const u = new URL(uri);
    expect(u.protocol).toBe('praxon:');
    expect(u.searchParams.get('u')).toBe('ws://192.168.1.20:8090/ws');
    expect(u.searchParams.get('t')).toBe('abc 123&x');
    expect(u.searchParams.get('v')).toBe('1');
  });
  it('direcciones: la pública configurada manda; si no, las IPv4 no internas', () => {
    const nets = { lo: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }], eth: [{ family: 'IPv4', internal: false, address: '192.168.1.5' }, { family: 'IPv6', internal: false, address: 'fe80::1' }] };
    expect(lanUrls(8090, nets)).toEqual(['ws://192.168.1.5:8090/ws']);
    expect(pairingUrls({ PRAXON_PUBLIC_URL: 'wss://praxon.raypa.com/ws' }, 8090)).toEqual(['wss://praxon.raypa.com/ws']);
  });
  it('solo se reconoce el bucle local', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopback('192.168.1.7')).toBe(false);
  });
  it('/pair responde en local con la página y no cuando viene reenviada', async () => {
    const { server } = createApp(config);
    const port = await server.listen();
    try {
      const ok = await fetch(`http://127.0.0.1:${port}/pair`);
      expect(ok.status).toBe(200);
      expect(ok.headers.get('cache-control')).toBe('no-store');
      expect(await ok.text()).toContain('<svg');
      const proxied = await fetch(`http://127.0.0.1:${port}/pair`, { headers: { 'x-forwarded-for': '8.8.8.8' } });
      expect(proxied.status).toBe(404);
    } finally {
      await server.close();
    }
  });
});
