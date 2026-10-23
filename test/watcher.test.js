import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { ProposalStore } from '../src/proposals/store.js';
import { ReviewedStore } from '../src/proposals/reviewed.js';
import { Triage } from '../src/proposals/triage.js';
import { TicketWatcher } from '../src/proposals/watcher.js';
import { config as baseConfig, setup, stubModel, use } from './helpers.js';

const config = { ...baseConfig, ...loadConfig({ PRAXON_TOKEN: 'token-largo-123456' }), PRAXON_USER: 'alex' };
const T0 = Date.UTC(2026, 9, 23, 8, 0);
const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();

const ticket = (id, createdMs, extra = {}) => ({
  id, proyectoId: 'mes', titulo: `Ticket nuevo ${id}`, descripcion: 'Descripción', estadoId: 'todo', prioridad: 'media', completado: false, asignado: '', comentarios: [], creado: iso(createdMs), ...extra,
});
const propose = (id) => use('proponer_accion', { herramienta: 'myraypa_actualizar_ticket', parametros: { ticketId: id, prioridad: 'alta' }, motivo: 'Afecta a producción' });
const summary = use('entregar_resumen', { resumen: 'Revisado.' });

function build(model, { reviewed } = {}) {
  let clock = T0;
  const now = () => clock;
  const s = setup();
  const store = new ProposalStore(null);
  const triage = new Triage({ model, registry: s.registry, audit: s.audit, store, config, now });
  const rev = reviewed ?? new ReviewedStore(null, { now });
  const broadcasts = [];
  const watcher = new TicketWatcher({ myraypa: s.myraypa, triage, reviewed: rev, config, now, onBriefing: (b) => broadcasts.push(b) });
  return { ...s, store, triage, rev, watcher, broadcasts, at: (ms) => { clock = ms; } };
}

afterEach(() => vi.restoreAllMocks());

describe('vigilante de tickets nuevos', () => {
  it('revisa solo los creados desde la marca de corte, cuando ya se han asentado', async () => {
    const model = stubModel([use('myraypa_detalle_ticket', { ticketId: '900' })], [propose('900')], [summary]);
    const t = build(model);
    t.myraypa.tickets.push(ticket('899', T0 - 10 * MIN), ticket('900', T0 + MIN)); // 899 es anterior al arranque
    t.at(T0 + 10 * MIN);
    const r = await t.watcher.tick();
    expect(r).toEqual({ nuevos: 1, revisados: 1 });
    expect(model.calls[0].system).toContain('SOLO de tickets recién creados');
    expect(model.calls[0].system).toContain('id 900');
    expect(model.calls[0].system).not.toContain('id 899');
    expect(t.store.pending()).toHaveLength(1);
    expect(t.broadcasts).toHaveLength(1);
    expect(t.audit.of('triage_run')[0]).toMatchObject({ trigger: 'nuevo', tickets: ['900'] });
    expect(t.myraypa.tickets.find((x) => x.id === '900').prioridad).toBe('media'); // nada escrito
  });

  it('espera a que el ticket se asiente y no lo revisa dos veces', async () => {
    const model = stubModel([propose('900')], [summary]);
    const t = build(model);
    t.myraypa.tickets.push(ticket('900', T0 + MIN));
    t.at(T0 + 2 * MIN); // lleva 1 min: aún no
    expect(await t.watcher.tick()).toEqual({ nuevos: 0, revisados: 0 });
    expect(model.calls).toHaveLength(0);
    t.at(T0 + 5 * MIN);
    expect((await t.watcher.tick()).revisados).toBe(1);
    t.at(T0 + 10 * MIN);
    expect(await t.watcher.tick()).toEqual({ nuevos: 0, revisados: 0 });
    expect(model.calls).toHaveLength(2); // solo la primera revisión (dos pasos del modelo)
  });

  it('adelanta la marca de corte y no guarda avisos si no hay nada que aprobar', async () => {
    const model = stubModel([summary]);
    const t = build(model);
    t.myraypa.tickets.push(ticket('900', T0 + MIN));
    t.at(T0 + 10 * MIN);
    await t.watcher.tick();
    expect(t.store.list()).toHaveLength(0);
    expect(t.broadcasts).toHaveLength(0);
    expect(t.rev.isDone('900')).toBe(true);
    expect(t.rev.desde).toBe(iso(T0 + MIN));
  });

  it('revisa por lotes y deja el resto para la siguiente pasada', async () => {
    const model = stubModel([summary], [summary]);
    const t = build(model);
    for (let i = 1; i <= 7; i++) t.myraypa.tickets.push(ticket(String(900 + i), T0 + i * 1000));
    t.at(T0 + 10 * MIN);
    expect((await t.watcher.tick()).revisados).toBe(5);
    expect((await t.watcher.tick()).revisados).toBe(2);
    expect(model.calls[0].system).toContain('id 901');
    expect(model.calls[1].system).toContain('id 906');
  });

  it('si falla la revisión reintenta y se rinde tras 3 intentos', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const model = { calls: [], async *stream() { throw new Error('boom'); } };
    const t = build(model);
    t.myraypa.tickets.push(ticket('900', T0 + MIN));
    t.at(T0 + 10 * MIN);
    for (let i = 0; i < 3; i++) {
      expect((await t.watcher.tick()).revisados).toBe(0);
      expect(t.rev.isDone('900')).toBe(i === 2);
    }
    expect(await t.watcher.tick()).toEqual({ nuevos: 0, revisados: 0 });
  });

  it('no hace nada si ya hay una revisión en curso', async () => {
    const t = build(stubModel());
    vi.spyOn(t.triage, 'running', 'get').mockReturnValue(true);
    expect(await t.watcher.tick()).toEqual({ omitido: true });
  });
});

describe('registro de tickets revisados', () => {
  it('fija la marca de corte al crearse y sobrevive a un reinicio', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'px-rev-'));
    const path = join(dir, 'data', 'reviewed.json');
    const a = new ReviewedStore(path, { now: () => T0 });
    expect(existsSync(path)).toBe(true);
    expect(a.desde).toBe(iso(T0));
    a.markSeen('7', T0);
    a.advance(iso(T0 + MIN));
    a.advance(iso(T0 - MIN)); // nunca hacia atrás
    await a.save();
    const b = new ReviewedStore(path, { now: () => T0 + 99 * MIN });
    expect(b.desde).toBe(iso(T0 + MIN));
    expect(b.isDone('7')).toBe(true);
    expect(b.isDone('8')).toBe(false);
  });

  it('TRIAGE_WATCH_FROM fija el inicio la primera vez', () => {
    expect(new ReviewedStore(null, { from: '2026-10-01T00:00:00Z', now: () => T0 }).desde).toBe('2026-10-01T00:00:00.000Z');
    expect(new ReviewedStore(null, { from: 'basura', now: () => T0 }).desde).toBe(iso(T0));
  });
});
