import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { JsonlAudit, MemoryAudit } from '../src/audit/log.js';
import { RateLimiter } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { createServer } from '../src/server.js';

let server;
afterEach(async () => server?.close());

const SHA = 'a'.repeat(40);

function fakeAgents() {
  const calls = [];
  return {
    calls,
    canMerge: true,
    canRequestChanges: true,
    list: async () => [],
    merge: async (a) => (calls.push(['merge', a]), { ok: true }),
    requestChanges: async (a) => (calls.push(['changes', a]), { ok: true }),
  };
}

async function start(env = {}, { agents = fakeAgents(), authLimiter } = {}) {
  const config = loadConfig({ PRAXON_TOKEN: 'token-largo-123456', PORT: '0', HOST: '127.0.0.1', PRAXON_USER: 'alex', ...env });
  const audit = new MemoryAudit();
  const identities = {
    maria: { kind: 'device', user: 'maria', email: 'maria@raypa.com', deviceId: 'd1', key: 'device:d1' },
    pepe: { kind: 'device', user: 'pepe', email: 'pepe@raypa.com', deviceId: 'd2', key: 'device:d2' },
  };
  const auth = { authenticate: async (h) => identities[String(h ?? '').replace('Bearer ', '')] ?? null };
  server = createServer({ config, orchestrator: {}, audit, agents, auth, authLimiter });
  return { port: await server.listen(), audit, agents };
}

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
  throw new Error(`no llego: ${JSON.stringify(ws.messages)}`);
};

describe('configuración segura por defecto', () => {
  it('el token compartido viene desactivado y MERGE_ALLOWED_USERS se normaliza', () => {
    const c = loadConfig({ PRAXON_TOKEN: 'token-largo-123456', MERGE_ALLOWED_USERS: ' Maria@Raypa.com , ,pepe@raypa.com' });
    expect(c.ALLOW_LEGACY_TOKEN).toBe(false);
    expect(c.MERGE_ALLOWED_USERS).toEqual(['maria@raypa.com', 'pepe@raypa.com']);
  });
});

describe('límite de intentos fallidos en el handshake', () => {
  it('tras N fallos la IP recibe 429, incluso con un token válido', async () => {
    const { port } = await start({}, { authLimiter: new RateLimiter({ max: 3, windowMs: 60_000 }) });
    for (let i = 0; i < 3; i++) await expect(open(port, 'malo')).rejects.toMatchObject({ status: 401 });
    await expect(open(port, 'malo')).rejects.toMatchObject({ status: 429 });
    await expect(open(port, 'maria')).rejects.toMatchObject({ status: 429 });
  });
  it('los intentos correctos no cuentan', async () => {
    const { port } = await start({}, { authLimiter: new RateLimiter({ max: 2, windowMs: 60_000 }) });
    for (let i = 0; i < 5; i++) (await open(port, 'maria')).close();
  });
});

describe('/pair', () => {
  it('sin token compartido la página de emparejamiento no existe, ni desde localhost', async () => {
    const { port } = await start({ ALLOW_LEGACY_TOKEN: 'false' });
    expect((await fetch(`http://127.0.0.1:${port}/pair`)).status).toBe(404);
  });
  it('con token compartido sí se sirve desde localhost', async () => {
    const { port } = await start({ ALLOW_LEGACY_TOKEN: 'true' });
    expect((await fetch(`http://127.0.0.1:${port}/pair`)).status).toBe(200);
  });
});

describe('quién puede fusionar o pedir cambios', () => {
  it('con MERGE_ALLOWED_USERS solo los listados; el resto recibe error, no se llama al servicio y queda auditado', async () => {
    const { port, audit, agents } = await start({ MERGE_ALLOWED_USERS: 'maria@raypa.com' });
    const pepe = await open(port, 'pepe');
    pepe.send(JSON.stringify({ type: 'agent_merge', runId: 'r1', sha: SHA, numero: 3 }));
    const r = await waitFor(pepe, (m) => m.type === 'agent_merge_result');
    expect(r).toMatchObject({ ok: false });
    pepe.send(JSON.stringify({ type: 'agent_request_changes', runId: 'r1', feedback: 'cambia esto' }));
    expect(await waitFor(pepe, (m) => m.type === 'agent_changes_result')).toMatchObject({ ok: false });
    expect(agents.calls).toEqual([]);
    expect(audit.of('approval_denied')).toHaveLength(2);
    pepe.send(JSON.stringify({ type: 'agents_list' }));
    expect(await waitFor(pepe, (m) => m.type === 'agents')).toMatchObject({ canMerge: false, canRequestChanges: false });

    const maria = await open(port, 'maria');
    maria.send(JSON.stringify({ type: 'agent_merge', runId: 'r1', sha: SHA, numero: 3 }));
    expect(await waitFor(maria, (m) => m.type === 'agent_merge_result')).toMatchObject({ ok: true });
    expect(agents.calls[0][0]).toBe('merge');
    maria.send(JSON.stringify({ type: 'agents_list' }));
    expect(await waitFor(maria, (m) => m.type === 'agents')).toMatchObject({ canMerge: true });
    pepe.close();
    maria.close();
  });
  it('sin lista, cualquier dispositivo emparejado puede (comportamiento anterior)', async () => {
    const { port, agents } = await start();
    const pepe = await open(port, 'pepe');
    pepe.send(JSON.stringify({ type: 'agent_merge', runId: 'r1', sha: SHA, numero: 3 }));
    expect(await waitFor(pepe, (m) => m.type === 'agent_merge_result')).toMatchObject({ ok: true });
    expect(agents.calls).toHaveLength(1);
    pepe.close();
  });
});

describe('log de auditoría', () => {
  it('recorta lo que dice el usuario y guarda su longitud', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'px-audit-'));
    const file = join(dir, 'audit.jsonl');
    const audit = new JsonlAudit(file, { textMax: 10 });
    await audit.record({ event: 'user_text', text: 'x'.repeat(50) });
    await audit.record({ event: 'user_text', text: 'corto' });
    const [a, b] = (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
    expect(a.text).toBe(`${'x'.repeat(10)}…`);
    expect(a.textLength).toBe(50);
    expect(b.text).toBe('corto');
  });
  it('con textMax 0 no guarda el texto', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'px-audit-'));
    const file = join(dir, 'audit.jsonl');
    await new JsonlAudit(file, { textMax: 0 }).record({ event: 'user_text', text: 'secreto' });
    const l = JSON.parse((await readFile(file, 'utf8')).trim());
    expect(l.text).toBe('[omitido]');
    expect(l.textLength).toBe(7);
  });
  it('prune elimina lo anterior a N días y conserva lo reciente', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'px-audit-'));
    const file = join(dir, 'audit.jsonl');
    const old = new Date(Date.now() - 100 * 86_400_000).toISOString();
    await writeFile(file, `${JSON.stringify({ ts: old, event: 'viejo' })}\n${JSON.stringify({ ts: new Date().toISOString(), event: 'nuevo' })}\n`);
    expect(await new JsonlAudit(file).prune(90)).toBe(1);
    const left = (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
    expect(left.map((e) => e.event)).toEqual(['nuevo']);
  });
});
