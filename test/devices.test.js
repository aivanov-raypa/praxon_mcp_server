import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createApp } from '../src/app.js';
import { MemoryAudit } from '../src/audit/log.js';
import { loadConfig } from '../src/config.js';
import { FakeMyraypa } from '../src/connectors/myraypa/fake.js';
import { HttpMyraypaClient } from '../src/connectors/myraypa/client.js';
import { currentUserEmail, runAsUser } from '../src/identity.js';
import { DeviceAuth, RateLimiter } from '../src/auth.js';
import { SessionStore } from '../src/session.js';

const LEGACY = 'token-de-pruebas-1234';
let app;
afterEach(async () => app?.server.close());

/** FakeMyraypa que anota con qué usuario se hizo cada consulta. */
class SpyMyraypa extends FakeMyraypa {
  actedAs = [];
  listProjects() {
    this.actedAs.push(currentUserEmail());
    return super.listProjects();
  }
}

async function start(env = {}) {
  const myraypa = new SpyMyraypa();
  const config = loadConfig({ PRAXON_TOKEN: LEGACY, PORT: '0', HOST: '127.0.0.1', PRAXON_USER: 'alex', ALLOW_LEGACY_TOKEN: 'true', ...env });
  app = createApp(config, { audit: new MemoryAudit(), myraypa });
  return { port: await app.server.listen(), myraypa };
}

const redeem = (port, body) =>
  fetch(`http://127.0.0.1:${port}/pair/redeem`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const open = (port, token) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Authorization: `Bearer ${token}` } });
    ws.messages = [];
    ws.on('message', (m) => ws.messages.push(JSON.parse(m)));
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    ws.on('unexpected-response', (_q, res) => reject(Object.assign(new Error('rechazado'), { status: res.statusCode })));
  });
const waitFor = async (ws, pred) => {
  for (let i = 0; i < 300; i++) {
    const m = ws.messages.find(pred);
    if (m) return m;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`no llego el mensaje: ${JSON.stringify(ws.messages)}`);
};

describe('emparejamiento por código', () => {
  it('canjea el código por un token que abre el WebSocket, y el código es de un solo uso', async () => {
    const { port, myraypa } = await start();
    myraypa.issuePairingCode('maria@raypa.com', 'ABCD2345');
    const res = await redeem(port, { code: 'abcd-2345', deviceName: 'Pixel de María' });
    expect(res.status).toBe(200);
    const { token } = await res.json();
    expect(token.startsWith('pxd_')).toBe(true);
    const ws = await open(port, token);
    ws.close();
    expect((await redeem(port, { code: 'ABCD2345', deviceName: 'x' })).status).toBe(401);
  });

  it('un código inventado da 401 y demasiados intentos dan 429', async () => {
    const { port } = await start();
    for (let i = 0; i < 10; i++) expect((await redeem(port, { code: 'ZZZZ9999' })).status).toBe(401);
    expect((await redeem(port, { code: 'ZZZZ9999' })).status).toBe(429);
  });

  it('un cuerpo no válido da 400', async () => {
    const { port } = await start();
    const res = await fetch(`http://127.0.0.1:${port}/pair/redeem`, { method: 'POST', body: '{no json' });
    expect(res.status).toBe(400);
  });
});

describe('autenticación del WebSocket', () => {
  it('token de dispositivo revocado o inventado: 401', async () => {
    const { port, myraypa } = await start();
    myraypa.issuePairingCode('maria@raypa.com');
    const { token } = await (await redeem(port, { code: 'ABCD2345' })).json();
    await expect(open(port, 'pxd_inventado')).rejects.toMatchObject({ status: 401 });
    myraypa.revokeDevice(token);
    // la caché de verificación dura 60 s: un token nuevo no cacheado se rechaza al instante
    const other = (myraypa.issuePairingCode('maria@raypa.com', 'WXYZ6789'), await (await redeem(port, { code: 'WXYZ6789' })).json());
    myraypa.revokeDevice(other.token);
    await expect(open(port, other.token)).rejects.toMatchObject({ status: 401 });
  });

  it('el token compartido solo vale con ALLOW_LEGACY_TOKEN=true', async () => {
    const { port } = await start({ ALLOW_LEGACY_TOKEN: 'false' });
    await expect(open(port, LEGACY)).rejects.toMatchObject({ status: 401 });
  });

  it('las consultas se hacen como el usuario del dispositivo; con el token compartido, sin usuario', async () => {
    const { port, myraypa } = await start();
    myraypa.issuePairingCode('maria@raypa.com');
    const { token } = await (await redeem(port, { code: 'ABCD2345' })).json();
    const ws = await open(port, token);
    ws.send(JSON.stringify({ type: 'user_text', sessionId: 'sesion-app-0001', text: '¿Qué proyectos tengo?' }));
    await waitFor(ws, (m) => m.type === 'assistant_done');
    expect(myraypa.actedAs.length).toBeGreaterThan(0);
    expect(new Set(myraypa.actedAs)).toEqual(new Set(['maria@raypa.com']));
    ws.close();

    myraypa.actedAs.length = 0;
    const legacy = await open(port, LEGACY);
    legacy.send(JSON.stringify({ type: 'user_text', sessionId: 'sesion-app-0001', text: '¿Qué proyectos tengo?' }));
    await waitFor(legacy, (m) => m.type === 'assistant_done');
    expect(new Set(myraypa.actedAs)).toEqual(new Set([null]));
    legacy.close();
  });
});

describe('piezas', () => {
  it('el cliente HTTP envía X-Assistant-User solo dentro de un contexto de usuario', async () => {
    const seen = [];
    const fetchImpl = async (_url, init) => {
      seen.push(init.headers['X-Assistant-User']);
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const c = new HttpMyraypaClient({ baseUrl: 'http://x/api', token: 't', fetchImpl });
    await c.listProjects();
    await runAsUser('maria@raypa.com', () => c.listProjects());
    expect(seen).toEqual([undefined, 'maria@raypa.com']);
  });

  it('el contexto no se mezcla entre mensajes concurrentes', async () => {
    const read = (email, ms) => runAsUser(email, async () => (await new Promise((r) => setTimeout(r, ms)), currentUserEmail()));
    expect(await Promise.all([read('a@x.com', 20), read('b@x.com', 5)])).toEqual(['a@x.com', 'b@x.com']);
  });

  it('verificación en caché 60 s; fresh la ignora', async () => {
    let calls = 0;
    let t = 1000;
    const myraypa = { verifyDevice: async () => (calls++, { ok: true, email: 'a@x.com', username: 'a', deviceId: 'd1' }) };
    const auth = new DeviceAuth({ config: {}, myraypa, now: () => t });
    await auth.verify('pxd_1');
    await auth.verify('pxd_1');
    expect(calls).toBe(1);
    await auth.verify('pxd_1', { fresh: true });
    expect(calls).toBe(2);
    t += 61_000;
    await auth.verify('pxd_1');
    expect(calls).toBe(3);
  });

  it('límite de intentos por ventana', () => {
    let t = 0;
    const l = new RateLimiter({ max: 2, windowMs: 1000, now: () => t });
    expect([l.take('ip'), l.take('ip'), l.take('ip')]).toEqual([true, true, false]);
    t = 1500;
    expect(l.take('ip')).toBe(true);
  });

  it('las sesiones de dos dispositivos con el mismo sessionId no se mezclan', () => {
    const s = new SessionStore();
    const a = s.get('misma-sesion-1', 'maria', 'device:1', 'maria@x.com');
    const b = s.get('misma-sesion-1', 'pepe', 'device:2', 'pepe@x.com');
    expect(a).not.toBe(b);
    expect(s.get('misma-sesion-1', 'maria', 'device:1', 'maria@x.com')).toBe(a);
  });
});
