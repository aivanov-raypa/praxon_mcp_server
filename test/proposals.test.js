import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { ProposalStore } from '../src/proposals/store.js';
import { TriageScheduler, madridParts } from '../src/proposals/scheduler.js';
import { Triage } from '../src/proposals/triage.js';
import { proposalTools } from '../src/proposals/tools.js';
import { config as baseConfig, setup, stubModel, use } from './helpers.js';

const cfg = loadConfig({ PRAXON_TOKEN: 'token-largo-123456' });
const config = { ...baseConfig, ...cfg };

function build({ model, now = () => Date.UTC(2026, 9, 23, 6, 30) } = {}) {
  const s = setup();
  const store = new ProposalStore(null);
  const triage = new Triage({ model, registry: s.registry, audit: s.audit, store, config, now });
  return { ...s, store, triage };
}

const propose214 = (extra = {}) =>
  use('proponer_accion', { herramienta: 'myraypa_actualizar_ticket', parametros: { ticketId: '214', prioridad: 'alta' }, motivo: 'Es lo más relevante', ...extra });
const summary = (text = 'Revisión hecha.') => use('entregar_resumen', { resumen: text });

describe('revisión automática', () => {
  it('analiza, deja propuestas pendientes y no cambia nada en MyRAYPA', async () => {
    const model = stubModel([use('myraypa_listar_tickets', { mostrar: 'abiertos' })], [propose214()], [summary('Hay un ticket que subir.')]);
    const t = build({ model });
    const b = await t.triage.run({ user: 'alex', trigger: 'manual' });
    expect(b.resumen).toBe('Hay un ticket que subir.');
    expect(b.acciones).toHaveLength(1);
    expect(b.acciones[0]).toMatchObject({ estado: 'pendiente', herramienta: 'myraypa_actualizar_ticket' });
    expect(b.acciones[0].resumen).toContain('Faltantes OF semana 43');
    expect(t.store.pending()).toHaveLength(1);
    expect(t.myraypa.tickets.find((x) => x.id === '214').prioridad).toBe('media'); // nada escrito
    expect(t.audit.of('triage_run')).toHaveLength(1);
  });

  it('al modelo solo se le ofrecen herramientas de consulta y las propias de la revisión', async () => {
    const model = stubModel([summary()]);
    const t = build({ model });
    await t.triage.run({ user: 'alex' });
    const names = model.calls[0].tools.map((x) => x.name);
    expect(names).toContain('myraypa_listar_tickets');
    expect(names).toContain('proponer_accion');
    expect(names).not.toContain('myraypa_actualizar_ticket');
    expect(names.some((n) => n.startsWith('praxon_'))).toBe(false);
  });

  it('rechaza ejecutar una escritura directamente y las herramientas no permitidas para proponer', async () => {
    const model = stubModel(
      [use('myraypa_actualizar_ticket', { ticketId: '214', prioridad: 'alta' }, 'directa')],
      [use('proponer_accion', { herramienta: 'myraypa_lanzar_agente', parametros: {}, motivo: 'probar' }, 'agente')],
      [summary()],
    );
    const t = build({ model });
    const b = await t.triage.run({ user: 'alex' });
    expect(b.acciones).toHaveLength(0);
    expect(t.myraypa.tickets.find((x) => x.id === '214').prioridad).toBe('media');
    const r1 = model.calls[1].messages.at(-1).content[0];
    const r2 = model.calls[2].messages.at(-1).content[0];
    expect(r1.is_error).toBe(true);
    expect(r2.is_error).toBe(true);
    expect(r2.content).toContain('no está permitida');
  });

  it('no repite una acción ya pendiente ni pasa del máximo', async () => {
    const t1 = build({ model: stubModel([propose214()], [summary()]) });
    await t1.triage.run({ user: 'alex' });
    const model2 = stubModel([propose214()], [summary()]);
    const t2 = { ...t1, triage: new Triage({ model: model2, registry: t1.registry, audit: t1.audit, store: t1.store, config }) };
    const b2 = await t2.triage.run({ user: 'alex' });
    expect(b2.acciones).toHaveLength(0);
    expect(model2.calls[1].messages.at(-1).content[0].content).toContain('ya está propuesta');
  });

  it('una propuesta con parámetros inválidos o un ticket inexistente no se guarda', async () => {
    const model = stubModel(
      [use('proponer_accion', { herramienta: 'myraypa_actualizar_ticket', parametros: { prioridad: 'urgente' }, motivo: 'mal' }, 'a')],
      [use('proponer_accion', { herramienta: 'myraypa_actualizar_ticket', parametros: { ticketId: 'no-existe', prioridad: 'alta' }, motivo: 'mal' }, 'b')],
      [summary()],
    );
    const t = build({ model });
    const b = await t.triage.run({ user: 'alex' });
    expect(b.acciones).toHaveLength(0);
  });
});

describe('decidir una propuesta', () => {
  async function withProposal(opts) {
    const t = build({ model: stubModel([propose214()], [summary()]), ...opts });
    const b = await t.triage.run({ user: 'alex' });
    return { ...t, b, a: b.acciones[0] };
  }

  it('aprobar ejecuta la acción una sola vez y deja rastro en la auditoría', async () => {
    const t = await withProposal();
    const r = await t.triage.decide({ briefingId: t.b.id, actionId: t.a.id, accepted: true, user: 'alex' });
    expect(r).toMatchObject({ ok: true, estado: 'ejecutada' });
    expect(t.myraypa.tickets.find((x) => x.id === '214').prioridad).toBe('alta');
    expect(t.audit.of('tool_call_start')[0]).toMatchObject({ via: 'proposal', tool: 'myraypa_actualizar_ticket' });
    expect(t.myraypa.historial.at(-1)).toBeDefined();
    const again = await t.triage.decide({ briefingId: t.b.id, actionId: t.a.id, accepted: true, user: 'alex' });
    expect(again.ok).toBe(false);
  });

  it('descartar no toca nada', async () => {
    const t = await withProposal();
    const r = await t.triage.decide({ briefingId: t.b.id, actionId: t.a.id, accepted: false, user: 'alex' });
    expect(r).toMatchObject({ ok: true, estado: 'descartada' });
    expect(t.myraypa.tickets.find((x) => x.id === '214').prioridad).toBe('media');
  });

  it('si el ticket ha cambiado desde la propuesta, queda obsoleta y no se ejecuta', async () => {
    const t = await withProposal();
    await t.myraypa.updateTicket('214', { prioridad: 'alta' }, { type: 'otro' }); // alguien lo cambia a mano
    const before = t.myraypa.historial.length;
    const r = await t.triage.decide({ briefingId: t.b.id, actionId: t.a.id, accepted: true, user: 'alex' });
    expect(r.estado).toBe('obsoleta');
    expect(t.myraypa.historial.length).toBe(before);
    expect(t.audit.of('tool_call_start')).toHaveLength(0);
  });

  it('si el estado actual hace que el resumen sea distinto, también es obsoleta', async () => {
    const t = await withProposal();
    await t.myraypa.updateTicket('214', { prioridad: 'baja' }, { type: 'otro' }); // el resumen diría "de baja a alta"
    const r = await t.triage.decide({ briefingId: t.b.id, actionId: t.a.id, accepted: true, user: 'alex' });
    expect(r.estado).toBe('obsoleta');
    expect(t.myraypa.tickets.find((x) => x.id === '214').prioridad).toBe('baja');
  });

  it('caduca pasadas las horas configuradas', async () => {
    let clock = Date.UTC(2026, 9, 23, 6, 30);
    const t = await withProposal({ now: () => clock });
    clock += 49 * 3_600_000;
    const r = await t.triage.decide({ briefingId: t.b.id, actionId: t.a.id, accepted: true, user: 'alex' });
    expect(r.estado).toBe('caducada');
    expect(t.myraypa.tickets.find((x) => x.id === '214').prioridad).toBe('media');
  });

  it('sin auditoría no se ejecuta y la propuesta sigue pendiente', async () => {
    const t = await withProposal();
    t.audit.failNext = true;
    const r = await t.triage.decide({ briefingId: t.b.id, actionId: t.a.id, accepted: true, user: 'alex' });
    expect(r.ok).toBe(false);
    expect(t.myraypa.tickets.find((x) => x.id === '214').prioridad).toBe('media');
    expect(t.store.pending()).toHaveLength(1);
  });

  it('la vista para la app no incluye los parámetros internos', async () => {
    const t = await withProposal();
    const v = t.triage.view();
    expect(v).toMatchObject({ type: 'proposals', pendientes: 1 });
    expect(v.briefings[0].acciones[0]).not.toHaveProperty('args');
    expect(v.briefings[0].acciones[0]).toHaveProperty('resumen');
  });
});

describe('herramientas de voz sobre propuestas', () => {
  it('consultar y aplicar una propuesta', async () => {
    const t = build({ model: stubModel([propose214()], [summary('Resumen de hoy.')]) });
    const b = await t.triage.run({ user: 'alex' });
    const [pend, aplicar] = proposalTools({ store: t.store, triage: t.triage });
    const info = await pend.execute({}, {});
    expect(info.ultimaRevision.resumen).toBe('Resumen de hoy.');
    expect(info.pendientes).toHaveLength(1);
    const ids = { briefingId: b.id, actionId: b.acciones[0].id };
    expect(await aplicar.summarize(ids, {})).toContain('Faltantes OF semana 43');
    await aplicar.execute(ids, { user: 'alex' });
    expect(t.myraypa.tickets.find((x) => x.id === '214').prioridad).toBe('alta');
    await expect(aplicar.summarize(ids, {})).rejects.toThrow(/ya no está pendiente/);
  });
});

describe('programador', () => {
  it('lanza la revisión una vez a la hora indicada (hora de Madrid)', async () => {
    let runs = 0;
    let clock = Date.UTC(2026, 9, 23, 6, 30); // 08:30 en Madrid (horario de verano)
    const s = new TriageScheduler({ times: ['08:30'], run: async () => void runs++, now: () => clock });
    expect(madridParts(clock)).toEqual({ date: '2026-10-23', time: '08:30' });
    expect(await s.tick()).toBe(true);
    expect(await s.tick()).toBe(false); // mismo minuto
    clock += 60_000;
    expect(await s.tick()).toBe(false); // 08:31
    clock += 24 * 3_600_000 - 60_000;
    expect(await s.tick()).toBe(true); // al día siguiente
    expect(runs).toBe(2);
  });

  it('un fallo en la revisión no rompe el programador', async () => {
    const s = new TriageScheduler({ times: ['08:30'], run: async () => { throw new Error('boom'); }, now: () => Date.UTC(2026, 9, 23, 6, 30) });
    await expect(s.tick()).resolves.toBe(true);
  });
});

describe('configuración de la revisión', () => {
  it('valida las horas y trae valores por defecto seguros', () => {
    expect(() => loadConfig({ PRAXON_TOKEN: 'token-largo-123456', TRIAGE_TIMES: '25:00' })).toThrow(/HH:MM/);
    const c = loadConfig({ PRAXON_TOKEN: 'token-largo-123456', TRIAGE_TIMES: '08:30, 14:00', TRIAGE_ENABLED: 'true' });
    expect(c.TRIAGE_TIMES).toEqual(['08:30', '14:00']);
    expect(c.TRIAGE_ENABLED).toBe(true);
    expect(loadConfig({ PRAXON_TOKEN: 'token-largo-123456' }).TRIAGE_ENABLED).toBe(false);
    expect(cfg.TRIAGE_ALLOWED_TOOLS).not.toContain('myraypa_lanzar_agente');
  });
});
