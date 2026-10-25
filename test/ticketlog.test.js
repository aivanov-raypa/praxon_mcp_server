import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { ProposalStore } from '../src/proposals/store.js';
import { TicketLog } from '../src/proposals/ticketlog.js';
import { Triage } from '../src/proposals/triage.js';
import { config as baseConfig, setup, stubModel, use } from './helpers.js';

const config = { ...baseConfig, ...loadConfig({ PRAXON_TOKEN: 'token-largo-123456' }) };
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 23, 6, 30);

const propose = (extra = {}) =>
  use('proponer_accion', { herramienta: 'myraypa_actualizar_ticket', parametros: { ticketId: '214', prioridad: 'alta' }, motivo: 'Es lo más relevante', ...extra });
const summary = () => use('entregar_resumen', { resumen: 'Hecho.' });

function build(clock, ticketLog = new TicketLog(null, { now: () => clock.t })) {
  const s = setup();
  const store = new ProposalStore(null);
  const run = (model) => new Triage({ model, registry: s.registry, audit: s.audit, store, config, now: () => clock.t, ticketLog }).run({ user: 'alex' });
  const triage = (model) => new Triage({ model, registry: s.registry, audit: s.audit, store, config, now: () => clock.t, ticketLog });
  return { ...s, store, ticketLog, run, triage };
}

describe('TicketLog', () => {
  it('bloquea por acción resuelta, por descarte del ticket y por propuesta reciente, y caduca', async () => {
    let t = T0;
    const log = new TicketLog(null, { now: () => t });
    expect(log.blockReason('1', 'k')).toBeNull();
    await log.noteResolved('1', 'k');
    expect(log.blockReason('1', 'k')).toContain('misma acción');
    expect(log.blockReason('1', 'otra')).toBeNull();
    await log.noteDismissed('2');
    expect(log.blockReason('2', 'x')).toContain('descartó');
    t += 91 * DAY;
    expect(log.blockReason('2', 'x')).toBeNull();
    await log.noteProposed(['3']);
    expect(log.blockReason('3')).toContain('hace poco');
    t += 15 * DAY;
    expect(log.blockReason('3')).toBeNull();
  });
});

describe('la revisión no insiste', () => {
  it('descartada la propuesta de un ticket, la siguiente revisión no vuelve a proponerle nada', async () => {
    const clock = { t: T0 };
    const t = build(clock);
    const b1 = await t.run(stubModel([propose()], [summary()]));
    expect(b1.acciones.length).toBeGreaterThan(0);
    const g = b1.acciones[0].grupo;
    await t.triage(stubModel()).decideGroup({ briefingId: b1.id, grupo: g, aprobar: [], user: 'alex' });
    clock.t += 30 * DAY; // pasa el enfriamiento, no el descarte
    const model2 = stubModel([propose()], [summary()]);
    const b2 = await t.run(model2);
    expect(b2.acciones).toHaveLength(0);
    expect(model2.calls[1].messages.at(-1).content[0].content).toContain('descartó la propuesta de este ticket');
  });

  it('descartar una acción suelta tampoco permite repetirla', async () => {
    const clock = { t: T0 };
    const t = build(clock);
    const b1 = await t.run(stubModel([propose()], [summary()]));
    await t.triage(stubModel()).decide({ briefingId: b1.id, actionId: b1.acciones[0].id, accepted: false, user: 'alex' });
    clock.t += 100 * DAY; // ya no hay descarte vigente: queda la acción exacta
    const model = stubModel([propose()], [summary()]);
    const b2 = await t.run(model);
    expect(b2.acciones).toHaveLength(0);
    expect(model.calls[1].messages.at(-1).content[0].content).toContain('misma acción');
  });

  it('un ticket con propuesta reciente (aunque se ignorara) no recibe otra hasta que pase el enfriamiento', async () => {
    const clock = { t: T0 };
    const t = build(clock);
    await t.run(stubModel([propose()], [summary()]));
    clock.t += 3 * DAY;
    const b2 = await t.run(stubModel([propose({ parametros: { ticketId: '214', prioridad: 'baja' } })], [summary()]));
    expect(b2.acciones).toHaveLength(0);
    clock.t += 20 * DAY;
    const b3 = await t.run(stubModel([propose({ parametros: { ticketId: '214', prioridad: 'baja' } })], [summary()]));
    expect(b3.acciones.length).toBeGreaterThan(0);
  });

  it('aprobar algo y dejar el resto sin marcar no bloquea el ticket por descarte', async () => {
    const clock = { t: T0 };
    const t = build(clock);
    const b1 = await t.run(stubModel([propose()], [summary()]));
    const principal = b1.acciones.find((a) => !a.opcional);
    await t.triage(stubModel()).decideGroup({ briefingId: b1.id, grupo: principal.grupo, aprobar: [principal.id], user: 'alex' });
    expect(t.ticketLog.blockReason('214', null, { dismissDays: 90, cooldownDays: 0 })).toBeNull();
  });
});
