import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PauseSwitch } from '../src/safety/pause.js';
import { MemoryAudit } from '../src/audit/log.js';
import { ProposalStore } from '../src/proposals/store.js';
import { Triage } from '../src/proposals/triage.js';
import { AgentService, branchOf } from '../src/agents/service.js';
import { FakeGithubReader } from '../src/integrations/github-read.js';
import { FakeGithubMerger } from '../src/integrations/github-merge.js';
import { FakeMyraypa } from '../src/connectors/myraypa/fake.js';
import { FakeGithub } from '../src/integrations/github.js';
import { createPanels } from '../src/panels.js';
import { loadConfig } from '../src/config.js';
import { config as baseConfig, setup, stubModel, use } from './helpers.js';

const ticket = (s, id) => s.myraypa.tickets.find((t) => t.id === id);
const tmp = () => join(mkdtempSync(join(tmpdir(), 'pausa-')), 'data', 'pausa.json');

describe('PauseSwitch', () => {
  it('activar crea el fichero, guarda quién y por qué, y sobrevive a un reinicio', async () => {
    const path = tmp();
    const audit = new MemoryAudit();
    const a = new PauseSwitch(path, { audit });
    expect(a.active).toBe(false);
    await a.engage({ user: 'alex@raypa.com', motivo: 'prueba' });
    expect(a.active).toBe(true);
    const b = new PauseSwitch(path); // "reinicio"
    expect(b.info()).toMatchObject({ por: 'alex@raypa.com', motivo: 'prueba' });
    expect(b.message()).toMatch(/en pausa \(prueba\).*npm run pausa -- off/);
    await a.release({ user: 'alex@raypa.com' });
    expect(existsSync(path)).toBe(false);
    expect(b.active).toBe(false);
    expect(audit.events.map((e) => e.event)).toEqual(['pause_on', 'pause_off']);
  });

  it('sin ruta funciona en memoria', async () => {
    const p = new PauseSwitch(null);
    await p.engage({ user: 'x' });
    expect(p.active).toBe(true);
    await p.release();
    expect(p.active).toBe(false);
  });
});

describe('PauseSwitch: fichero ilegible', () => {
  it('falla cerrado: sigue en pausa', async () => {
    const { mkdirSync } = await import('node:fs');
    const path = tmp();
    mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true });
    writeFileSync(path, '{roto');
    const p = new PauseSwitch(path);
    expect(p.active).toBe(true);
    expect(p.info()).toEqual({ desde: null, por: null, motivo: null });
  });
});

describe('en pausa: conversación', () => {
  const pedir = (s) => s.orchestrator.handleUserText(s.session, { text: 'Pasa el de los faltantes a alta', requestId: 'r1' }, s.emit);

  it('no pide confirmación ni cambia nada, y lo explica; las consultas siguen funcionando', async () => {
    const pause = new PauseSwitch(null);
    await pause.engage({ user: 'alex' });
    const s = setup({ pause });
    await pedir(s);
    expect(s.out.some((m) => m.type === 'confirm_request')).toBe(false);
    expect(ticket(s, '214').prioridad).toBe('media');
    expect(s.audit.of('tool_call').some((e) => e.ok === false && /modo pausa/.test(e.error))).toBe(true);
    const s2 = setup({ pause });
    await s2.orchestrator.handleUserText(s2.session, { text: '¿Qué hay abierto en calibraciones?' }, s2.emit);
    expect(s2.audit.of('tool_call').every((e) => e.ok)).toBe(true);
  });

  it('una confirmación pendiente de antes de la pausa tampoco se ejecuta', async () => {
    const pause = new PauseSwitch(null);
    const s = setup({ pause });
    await pedir(s);
    const req = s.last('confirm_request');
    expect(req).toBeTruthy();
    await pause.engage({ user: 'alex' });
    await s.orchestrator.handleConfirm(s.session, { actionId: req.actionId, accepted: true }, s.emit);
    expect(ticket(s, '214').prioridad).toBe('media');
  });

  it('al reanudar vuelve a funcionar', async () => {
    const pause = new PauseSwitch(null);
    await pause.engage({ user: 'alex' });
    await pause.release();
    const s = setup({ pause });
    await pedir(s);
    expect(s.last('confirm_request')).toBeTruthy();
  });
});

describe('en pausa: revisión y propuestas', () => {
  const config = { ...baseConfig, ...loadConfig({ PRAXON_TOKEN: 'token-largo-123456' }) };
  const propose = use('proponer_accion', { herramienta: 'myraypa_actualizar_ticket', parametros: { ticketId: '214', prioridad: 'alta' }, motivo: 'Es lo más relevante' });
  const armar = (pause) => {
    const s = setup();
    const store = new ProposalStore(null);
    const model = stubModel([use('myraypa_listar_tickets', { mostrar: 'abiertos' })], [propose], [use('entregar_resumen', { resumen: 'ok' })]);
    const triage = new Triage({ model, registry: s.registry, audit: s.audit, store, config, now: () => Date.UTC(2026, 9, 23, 6, 30), pause });
    return { ...s, store, triage };
  };

  it('no se hacen revisiones y no se llama al modelo', async () => {
    const pause = new PauseSwitch(null);
    await pause.engage({ user: 'alex' });
    const t = armar(pause);
    const r = await t.triage.run({ user: 'alex', trigger: 'manual' });
    expect(r.omitida).toMatch(/pausa/);
    expect(t.store.list?.().length ?? 0).toBe(0);
  });

  it('aprobar una propuesta se bloquea (el ticket no cambia), descartar sigue permitido y al reanudar se puede aprobar', async () => {
    const pause = new PauseSwitch(null);
    const t = armar(pause);
    const b = await t.triage.run({ user: 'alex', trigger: 'manual' });
    const accion = b.acciones.find((a) => a.herramienta === 'myraypa_actualizar_ticket');
    await pause.engage({ user: 'alex' });
    const r = await t.triage.decide({ briefingId: b.id, actionId: accion.id, accepted: true, user: 'alex' });
    expect(r.ok).toBe(false);
    expect(r.mensaje).toMatch(/pausa/);
    expect(ticket(t, '214').prioridad).toBe('media');
    const g = await t.triage.decideGroup({ briefingId: b.id, grupo: accion.grupo ?? accion.ticketId, aprobar: [accion.id], user: 'alex' });
    expect(g.ok).toBe(false);
    expect(ticket(t, '214').prioridad).toBe('media');
    await pause.release();
    const ok = await t.triage.decide({ briefingId: b.id, actionId: accion.id, accepted: true, user: 'alex' });
    expect(ok.ok).toBe(true);
    expect(ticket(t, '214').prioridad).toBe('alta');
  });

  it('descartar en pausa está permitido', async () => {
    const pause = new PauseSwitch(null);
    const t = armar(pause);
    const b = await t.triage.run({ user: 'alex', trigger: 'manual' });
    const accion = b.acciones.find((a) => a.herramienta === 'myraypa_actualizar_ticket');
    await pause.engage({ user: 'alex' });
    const r = await t.triage.decide({ briefingId: b.id, actionId: accion.id, accepted: false, user: 'alex' });
    expect(r.ok).not.toBe(false);
  });
});

describe('en pausa: agentes', () => {
  const REPO = 'ejemplo/raypa-platform';
  const SHA = 'a'.repeat(40);
  const OK = { total: 2, ok: 2, fallando: 0, pendientes: 0, items: [] };
  const cfg = { GITHUB_WORKFLOW_FILE: 'praxon-agent.yml', AGENTS_QUEUE_TIMEOUT_MINUTES: 10, AGENTS_WATCH_SECONDS: 60 };
  const armar = async (pause) => {
    const myraypa = new FakeMyraypa();
    const run = await myraypa.createAgentRun({ ticketId: '215', tipo: 'mejora' }, 'test');
    const r = { ticketId: '215', runId: run.runId };
    const reader = new FakeGithubReader({ [REPO]: {
      workflowRuns: [{ id: '777', titulo: `praxon ticket=215 run=${run.runId}`, estado: 'completed', resultado: 'success', url: 'u' }],
      pullRequests: [{ numero: 12, titulo: 'x', estado: 'abierto', rama: branchOf(r), base: 'develop', sha: SHA, checks: OK, files: [] }],
    } });
    const merger = new FakeGithubMerger();
    const dispatcher = new FakeGithub();
    const audit = new MemoryAudit();
    const svc = new AgentService({ myraypa, reader, merger, dispatcher, audit, config: cfg, pause });
    await svc.tick();
    return { svc, merger, dispatcher, audit, myraypa, run };
  };

  it('no se puede fusionar ni pedir cambios, y no se toca GitHub ni MyRAYPA', async () => {
    const pause = new PauseSwitch(null);
    const a = await armar(pause);
    expect(a.myraypa.runs[0].estado).toBe('pendiente_revision');
    await pause.engage({ user: 'alex' });
    const m = await a.svc.merge({ runId: a.run.runId, sha: SHA, numero: 12, user: 'alex' });
    expect(m).toMatchObject({ ok: false });
    expect(m.error).toMatch(/pausa/);
    expect(a.merger.merged).toHaveLength(0);
    const c = await a.svc.requestChanges({ runId: a.run.runId, feedback: 'Cambia esto por favor, con más detalle', user: 'alex' });
    expect(c.ok).toBe(false);
    expect(a.myraypa.runs[0].estado).toBe('pendiente_revision');
    expect(a.audit.events.filter((e) => e.event === 'agent_merge').at(-1)).toMatchObject({ ok: false });
  });

  it('el seguimiento no hace nada en pausa y se pone al día al reanudar', async () => {
    const pause = new PauseSwitch(null);
    const a = await armar(pause);
    await pause.engage({ user: 'alex' });
    expect(await a.svc.tick()).toEqual({ omitido: true });
    await pause.release();
    expect(await a.svc.tick()).not.toEqual({ omitido: true });
  });
});

describe('panel de Estado: modo pausa', () => {
  const owner = { kind: 'device', user: 'alex', email: 'alex@raypa.com', deviceId: 'dev1' };
  const other = { kind: 'device', user: 'bea', email: 'bea@raypa.com', deviceId: 'dev2' };
  const armar = () => {
    const s = setup();
    const pause = new PauseSwitch(null, { audit: s.audit });
    const panels = createPanels({
      config: { MODEL_PROVIDER: 'scripted', VOICE_PROVIDER: 'none', STT_PROVIDER: 'none', MERGE_ALLOWED_USERS: ['alex@raypa.com'], HOST: '127.0.0.1' },
      pause, myraypa: s.myraypa, audit: s.audit, registry: s.registry, toolControl: { set() {} },
      isOwner: (id) => id.email === 'alex@raypa.com',
    });
    return { ...s, pause, panels };
  };
  const fila = async (t) => (await t.panels.get({ panel: 'status' }, owner)).secciones.flatMap((x) => x.filas).find((f) => f.id === 'pausa');

  it('muestra el interruptor, se activa sin confirmación y se reanuda con ella', async () => {
    const t = armar();
    let f = await fila(t);
    expect(f.acciones[0]).toMatchObject({ id: 'pausar', peligro: true });
    expect(f.acciones[0].confirmar).toBeUndefined();
    expect((await t.panels.action({ panel: 'status', accion: 'pausar' }, owner)).ok).toBe(true);
    expect(t.pause.active).toBe(true);
    f = await fila(t);
    expect(f).toMatchObject({ estado: 'error', chips: [{ texto: 'EN PAUSA', estado: 'error' }] });
    expect(f.acciones[0]).toMatchObject({ id: 'reanudar' });
    expect(f.acciones[0].confirmar).toBeTruthy();
    expect((await t.panels.action({ panel: 'status', accion: 'reanudar' }, owner)).ok).toBe(true);
    expect(t.pause.active).toBe(false);
    expect(t.audit.events.filter((e) => e.event === 'panel_action').map((e) => e.accion)).toEqual(['pausar', 'reanudar']);
  });

  it('quien no puede aprobar no puede pausar ni reanudar', async () => {
    const t = armar();
    const r = await t.panels.action({ panel: 'status', accion: 'pausar' }, other);
    expect(r.ok).toBe(false);
    expect(t.pause.active).toBe(false);
  });
});
