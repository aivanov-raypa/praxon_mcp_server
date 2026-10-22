import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createApp } from '../src/app.js';
import { MemoryAudit } from '../src/audit/log.js';
import { loadConfig } from '../src/config.js';

const TOKEN = 'token-de-pruebas-1234';
let app;
afterEach(async () => app?.server.close());

async function start() {
  const config = loadConfig({ PRAXON_TOKEN: TOKEN, PORT: '0', HOST: '127.0.0.1', PRAXON_USER: 'alex' });
  app = createApp(config, { audit: new MemoryAudit() });
  return { port: await app.server.listen() };
}

const open = (port, token = TOKEN) =>
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
  throw new Error(`no llego el mensaje. Recibidos: ${JSON.stringify(ws.messages)}`);
};
const send = (ws, msg) => ws.send(JSON.stringify(msg));

describe('servidor WebSocket', () => {
  it('rechaza un token incorrecto con 401 en el handshake', async () => {
    const { port } = await start();
    await expect(open(port, 'malo')).rejects.toMatchObject({ status: 401 });
  });

  it('flujo completo: escritura con confirmacion', async () => {
    const { port } = await start();
    const ws = await open(port);
    send(ws, { type: 'user_text', sessionId: 'sesion-app-0001', text: 'Pasa el de los faltantes a urgente' });
    const req = await waitFor(ws, (m) => m.type === 'confirm_request');
    expect(req.summary).toContain('ticket 214');
    send(ws, { type: 'confirm', sessionId: 'sesion-app-0001', actionId: req.actionId, accepted: true });
    await waitFor(ws, (m) => m.type === 'assistant_done');
    expect(app.myraypa.tickets.find((t) => t.id === 214).prioridad).toBe('urgente');
    ws.close();
  });

  it('una accion pendiente muere con la conexion', async () => {
    const { port } = await start();
    const ws = await open(port);
    send(ws, { type: 'user_text', sessionId: 'sesion-app-0002', text: 'Pasa el de los faltantes a urgente' });
    const req = await waitFor(ws, (m) => m.type === 'confirm_request');
    ws.close();
    await new Promise((r) => setTimeout(r, 150));

    const ws2 = await open(port);
    send(ws2, { type: 'confirm', sessionId: 'sesion-app-0002', actionId: req.actionId, accepted: true });
    const err = await waitFor(ws2, (m) => m.type === 'error');
    expect(err.message).toMatch(/No hay ninguna acción pendiente/);
    expect(app.myraypa.tickets.find((t) => t.id === 214).prioridad).toBe('alta');
    ws2.close();
  });

  it('responde error a mensajes no validos y /health funciona sin token', async () => {
    const { port } = await start();
    const ws = await open(port);
    ws.send('esto no es json');
    send(ws, { type: 'user_text', sessionId: 'x', text: '' });
    await waitFor(ws, (m) => m.type === 'error');
    await new Promise((r) => setTimeout(r, 50));
    expect(ws.messages.filter((m) => m.type === 'error')).toHaveLength(2);
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(await res.json()).toEqual({ status: 'ok' });
    ws.close();
  });
});
