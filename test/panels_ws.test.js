import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createApp } from '../src/app.js';
import { MemoryAudit } from '../src/audit/log.js';
import { ToolControl } from '../src/tools/control.js';

const config = { PORT: 0, HOST: '127.0.0.1', PRAXON_TOKEN: 'token-de-prueba-123', PRAXON_USER: 'alex', ALLOW_LEGACY_TOKEN: true, PRAXON_PUBLIC_URL: 'ws://192.168.1.5:8090/ws', ASSISTANT_NAME: 'Praxon', MODEL_PROVIDER: 'scripted', MYRAYPA_MODE: 'fake', GITHUB_MODE: 'fake', VOICE_PROVIDER: 'none', AUDIT_LOG_PATH: ':memory:', CONFIRM_TTL_MS: 1000, MAX_TOOL_ITERATIONS: 3, MAX_HISTORY_MESSAGES: 10, MODEL_DEFAULT: 't', MAX_TOKENS: 100 };

async function open(overrides = {}) {
  const app = createApp(config, { audit: new MemoryAudit(), toolControl: new ToolControl(null), ...overrides });
  const port = await app.server.listen();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Authorization: 'Bearer token-de-prueba-123' } });
  const msgs = [];
  ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
  await new Promise((r) => ws.once('open', r));
  const next = async (type) => {
    for (let i = 0; i < 100; i++) {
      const m = msgs.find((x) => x.type === type);
      if (m) return m;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`no llegó ${type}: ${JSON.stringify(msgs.map((m) => m.type))}`);
  };
  return { app, ws, msgs, next, close: async () => { ws.close(); await app.server.close(); } };
}

describe('paneles por WebSocket', () => {
  it('panel_get devuelve el panel pedido', async () => {
    const t = await open();
    try {
      t.ws.send(JSON.stringify({ type: 'panel_get', panel: 'status' }));
      const p = await t.next('panel');
      expect(p.panel).toBe('status');
      expect(p.secciones.flatMap((s) => s.filas).some((f) => f.id === 'myraypa')).toBe(true);
    } finally {
      await t.close();
    }
  });

  it('los paneles de tickets, agenda y correo no existen en el protocolo', async () => {
    const t = await open();
    try {
      t.ws.send(JSON.stringify({ type: 'panel_get', panel: 'tickets' }));
      expect((await t.next('error')).message).toMatch(/no válido/);
    } finally {
      await t.close();
    }
  });

  it('desactivar una herramienta por panel_action la quita del registro en vivo y deja rastro', async () => {
    const t = await open();
    try {
      t.ws.send(JSON.stringify({ type: 'panel_action', panel: 'tools', accion: 'desactivar', id: 'myraypa_listar_tickets' }));
      const r = await t.next('panel_action_result');
      expect(r).toMatchObject({ ok: true, accion: 'desactivar' });
      expect(t.app.registry.isDisabled('myraypa_listar_tickets')).toBe(true);
      expect(t.app.audit.of('panel_action')).toHaveLength(1);
    } finally {
      await t.close();
    }
  });

});
