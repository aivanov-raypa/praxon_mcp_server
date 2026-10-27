import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { ProposalStore } from '../src/proposals/store.js';
import { TriageScheduler, madridParts } from '../src/proposals/scheduler.js';
import { Triage } from '../src/proposals/triage.js';
import { proposalTools } from '../src/proposals/tools.js';
import { config as baseConfig, setup, stubModel, use } from './helpers.js';

const cfg = loadConfig({ PRAXON_TOKEN: 'token-largo-123456' });
const config = { ...baseConfig, ...cfg };

function build({ model, now = () => Date.UTC(2026, 9, 23, 6, 30), pause = null } = {}) {
  const s = setup();
  const store = new ProposalStore(null);
  const triage = new Triage({ model, registry: s.registry, audit: s.audit, store, config, now, pause });
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
    expect(b.acciones).toHaveLength(2); // el cambio y la opción de agente, desmarcada
    expect(b.acciones[0]).toMatchObject({ estado: 'pendiente', herramienta: 'myraypa_actualizar_ticket' });
    expect(b.acciones[0].resumen).toContain('Faltantes OF semana 43');
    expect(b.acciones[1]).toMatchObject({ herramienta: 'myraypa_lanzar_agente', opcional: true, estado: 'pendiente' });
    expect(t.store.pending()).toHaveLength(2);
    expect(t.myraypa.runs).toHaveLength(0); // el agente no se ha lanzado
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

  it('usa el modelo de la revisión, distinto del de la conversación', async () => {
    const model = stubModel([summary()]);
    const s = setup();
    const triage = new Triage({ model, registry: s.registry, audit: s.audit, store: new ProposalStore(null), config: { ...config, MODEL_DEFAULT: 'claude-haiku-5-5', TRIAGE_MODEL: 'claude-sonnet-5-5' }, now: () => Date.UTC(2026, 9, 23, 6, 30) });
    await triage.run({ user: 'alex' });
    expect(model.calls[0].model).toBe('claude-sonnet-5-5');
    expect(loadConfig({ PRAXON_TOKEN: 'token-largo-123456' }).TRIAGE_MODEL).toBe('claude-sonnet-5-5');
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
    expect(t.store.pending().filter((x) => !x.action.opcional)).toHaveLength(1);
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
    expect(info.pendientes).toHaveLength(2); // el cambio y la opción de agente
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

describe('una propuesta por ticket', () => {
  const comment = (ticketId, id) => use('proponer_accion', { herramienta: 'myraypa_comentar_ticket', parametros: { ticketId, texto: 'Falta detalle del alcance' }, motivo: 'Pedir datos' }, id);
  const suggest = () => use('sugerir_agente', { ticketId: '214', tipo: 'error', motivo: 'Es reproducible' });
  async function grouped() {
    const t = build({ model: stubModel([propose214(), comment('214', 'c214'), comment('301', 'c301'), suggest()], [summary()]) });
    const b = await t.triage.run({ user: 'alex' });
    const g = b.acciones.filter((a) => a.grupo === 'g-214');
    return { ...t, b, g, update: g.find((a) => a.herramienta === 'myraypa_actualizar_ticket'), note: g.find((a) => a.herramienta === 'myraypa_comentar_ticket'), agent: g.find((a) => a.opcional) };
  }

  it('reúne las acciones de cada ticket y ofrece el agente, desmarcado, solo donde el proyecto lo permite', async () => {
    const t = await grouped();
    expect(t.g).toHaveLength(3);
    expect(t.g[0].ticket).toBe('Faltantes OF semana 43');
    expect(t.agent).toMatchObject({ args: { ticketId: '214', tipo: 'error' }, motivo: 'Es reproducible', origen: 'servidor' });
    expect(t.b.acciones.filter((a) => a.grupo === 'g-301')).toHaveLength(1); // el proyecto MES no admite agentes
    const v = t.triage.view();
    expect(v.pendientes).toBe(2); // una propuesta por ticket
    const agent = v.briefings[0].acciones.find((a) => a.opcional);
    expect(agent).toMatchObject({ defecto: false, grupo: 'g-214' });
    expect(v.briefings[0].acciones.find((a) => !a.opcional)).toMatchObject({ defecto: true });
    expect(agent).not.toHaveProperty('args');
  });

  it('aplica solo lo marcado y descarta el resto sin lanzar el agente', async () => {
    const t = await grouped();
    const r = await t.triage.decideGroup({ briefingId: t.b.id, grupo: 'g-214', aprobar: [t.update.id], user: 'alex' });
    expect(r.ok).toBe(true);
    expect(t.myraypa.tickets.find((x) => x.id === '214').prioridad).toBe('alta');
    expect(t.myraypa.runs).toHaveLength(0);
    expect(t.update.estado).toBe('ejecutada');
    expect(t.note.estado).toBe('descartada');
    expect(t.agent.estado).toBe('descartada');
    expect(t.audit.of('tool_call_start')).toHaveLength(1);
    expect(t.triage.view().pendientes).toBe(1); // queda la del otro ticket
  });

  it('con el agente marcado, ejecuta primero los cambios y después lanza el agente', async () => {
    const t = await grouped();
    const r = await t.triage.decideGroup({ briefingId: t.b.id, grupo: 'g-214', aprobar: [t.agent.id, t.update.id, t.note.id], user: 'alex' });
    expect(r).toMatchObject({ ok: true, mensaje: 'Hecho: 3 acciones.' });
    expect(t.audit.of('tool_call_start').map((e) => e.tool)).toEqual(['myraypa_actualizar_ticket', 'myraypa_comentar_ticket', 'myraypa_lanzar_agente']);
    expect(t.myraypa.runs).toHaveLength(1);
    expect(t.myraypa.runs[0]).toMatchObject({ ticketId: '214', tipo: 'error' });
  });

  it('si un cambio está obsoleto no se lanza el agente y su opción sigue pendiente', async () => {
    const t = await grouped();
    await t.myraypa.updateTicket('214', { prioridad: 'alta' }, { type: 'otro' }); // alguien lo cambia a mano
    const r = await t.triage.decideGroup({ briefingId: t.b.id, grupo: 'g-214', aprobar: [t.update.id, t.note.id, t.agent.id], user: 'alex' });
    expect(r.ok).toBe(false);
    expect(t.update.estado).toBe('obsoleta');
    expect(t.note.estado).toBe('ejecutada');
    expect(t.agent.estado).toBe('pendiente');
    expect(t.myraypa.runs).toHaveLength(0);
  });

  it('sin nada marcado descarta la propuesta entera, y no se puede resolver dos veces', async () => {
    const t = await grouped();
    const r = await t.triage.decideGroup({ briefingId: t.b.id, grupo: 'g-214', aprobar: [], user: 'alex' });
    expect(r).toMatchObject({ ok: true, mensaje: 'Propuesta descartada.' });
    expect(t.g.every((a) => a.estado === 'descartada')).toBe(true);
    expect(t.audit.of('tool_call_start')).toHaveLength(0);
    const again = await t.triage.decideGroup({ briefingId: t.b.id, grupo: 'g-214', aprobar: [t.update.id], user: 'alex' });
    expect(again.ok).toBe(false);
  });

  it('ignora ids de otras propuestas y grupos inexistentes', async () => {
    const t = await grouped();
    const other = t.b.acciones.find((a) => a.grupo === 'g-301');
    const r = await t.triage.decideGroup({ briefingId: t.b.id, grupo: 'g-214', aprobar: [other.id], user: 'alex' });
    expect(r.ok).toBe(true);
    expect(other.estado).toBe('pendiente');
    expect(await t.triage.decideGroup({ briefingId: t.b.id, grupo: 'g-999', aprobar: [], user: 'alex' })).toMatchObject({ ok: false });
  });

  it('el agente solo lo crea el servidor: el modelo no puede proponerlo', async () => {
    const model = stubModel([use('proponer_accion', { herramienta: 'myraypa_lanzar_agente', parametros: { ticketId: '214', tipo: 'mejora' }, motivo: 'probar' })], [summary()]);
    const t = build({ model });
    const b = await t.triage.run({ user: 'alex' });
    expect(b.acciones).toHaveLength(0);
  });
});
