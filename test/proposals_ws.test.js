import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createApp } from '../src/app.js';
import { MemoryAudit } from '../src/audit/log.js';
import { loadConfig } from '../src/config.js';
import { ProposalStore } from '../src/proposals/store.js';

const TOKEN = 'token-de-pruebas-1234';
let app;
afterEach(async () => app?.server.close());

async function start() {
  const config = loadConfig({ PRAXON_TOKEN: TOKEN, PORT: '0', HOST: '127.0.0.1', PRAXON_USER: 'alex' });
  app = createApp(config, { audit: new MemoryAudit(), proposalStore: new ProposalStore(null) });
  return app.server.listen();
}
const open = (port) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    ws.messages = [];
    ws.on('message', (m) => ws.messages.push(JSON.parse(m)));
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
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

describe('propuestas por WebSocket', () => {
  it('lanzar revisión, ver propuestas y aprobar una', async () => {
    const port = await start();
    const ws = await open(port);
    send(ws, { type: 'proposals_list' });
    expect(await waitFor(ws, (m) => m.type === 'proposals')).toMatchObject({ pendientes: 0 });

    ws.messages.length = 0;
    send(ws, { type: 'proposals_run' });
    const v = await waitFor(ws, (m) => m.type === 'proposals' && m.pendientes === 1 && !m.running);
    const accion = v.briefings[0].acciones[0];
    expect(accion.resumen).toContain('Faltantes OF semana 43');
    expect(app.myraypa.tickets.find((t) => t.id === '214').prioridad).toBe('media');

    send(ws, { type: 'proposal_decision', briefingId: v.briefings[0].id, actionId: accion.id, accepted: true });
    const r = await waitFor(ws, (m) => m.type === 'proposal_result');
    expect(r).toMatchObject({ ok: true, estado: 'ejecutada' });
    expect(app.myraypa.tickets.find((t) => t.id === '214').prioridad).toBe('alta');
    ws.close();
  });

  it('una decisión sobre una propuesta que no existe devuelve error, no revienta', async () => {
    const port = await start();
    const ws = await open(port);
    send(ws, { type: 'proposal_decision', briefingId: 'x', actionId: 'y', accepted: true });
    expect(await waitFor(ws, (m) => m.type === 'proposal_result')).toMatchObject({ ok: false });
    ws.close();
  });
});
