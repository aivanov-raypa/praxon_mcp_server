import { describe, expect, it } from 'vitest';
import { UndoStore, diffFields, installUndo, undoTools } from '../src/companion/undo.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { setup } from './helpers.js';

function build() {
  const s = setup();
  const undo = new UndoStore();
  expect(installUndo({ registry: s.registry, client: s.myraypa, undo })).toBe(true);
  const reg = new ToolRegistry().registerConnector({ name: 'praxon', tools: undoTools({ undo, client: s.myraypa }) });
  const deshacer = reg.get('praxon_deshacer_ultimo_cambio');
  const actualizar = s.registry.get('myraypa_actualizar_ticket');
  const ctx = { session: { id: 's1', user: 'alex', email: 'alex@raypa.com' } };
  return { ...s, undo, deshacer, actualizar, ctx };
}

describe('deshacer', () => {
  it('diffFields solo recoge lo que cambió y marca el responsable que no se puede restaurar', () => {
    const d = diffFields({ prioridad: 'alta', asignado: 'ana', estado: 'En curso' }, { prioridad: 'media', asignado: null, estado: 'En curso' }, { prioridad: 'alta', asignado: 'ana', estado: 'En curso' });
    expect(d).toEqual({ before: { prioridad: 'media' }, after: { prioridad: 'alta' }, noRestaurable: ['asignado'] });
  });

  it('es una herramienta de escritura: pide confirmación', () => {
    expect(build().deshacer.risk).toBe('write');
  });

  it('sin cambios previos no hay nada que deshacer', async () => {
    const t = build();
    await expect(t.deshacer.summarize({}, t.ctx)).rejects.toThrow(/ningún cambio reciente/);
  });

  it('cambia la prioridad, la deshace y el ticket vuelve a como estaba', async () => {
    const t = build();
    const antes = await t.myraypa.getTicket('214');
    await t.actualizar.execute({ ticketId: '214', prioridad: 'alta' }, t.ctx);
    expect((await t.myraypa.getTicket('214')).prioridad).toBe('alta');
    const resumen = await t.deshacer.summarize({}, t.ctx);
    expect(resumen).toContain('prioridad de nuevo a ' + antes.prioridad);
    await t.deshacer.execute({}, t.ctx);
    expect((await t.myraypa.getTicket('214')).prioridad).toBe(antes.prioridad);
    await expect(t.deshacer.summarize({}, t.ctx)).rejects.toThrow(/ningún cambio reciente/); // ya no hay más
  });

  it('no deshace si el ticket cambió después (no pisa cambios posteriores)', async () => {
    const t = build();
    await t.actualizar.execute({ ticketId: '214', prioridad: 'alta' }, t.ctx);
    await t.myraypa.updateTicket('214', { prioridad: 'baja' }, {});
    await expect(t.deshacer.summarize({}, t.ctx)).rejects.toThrow(/ha cambiado desde entonces/);
  });

  it('cada usuario solo deshace lo suyo', async () => {
    const t = build();
    await t.actualizar.execute({ ticketId: '214', prioridad: 'alta' }, t.ctx);
    await expect(t.deshacer.summarize({}, { session: { id: 's2', user: 'pepe', email: 'pepe@raypa.com' } })).rejects.toThrow(/ningún cambio reciente/);
  });

  it('caduca a las 24 horas', async () => {
    let now = 1_000_000;
    const undo = new UndoStore({ now: () => now });
    undo.record('a', { ticketId: '1', titulo: 't', before: { prioridad: 'baja' }, after: { prioridad: 'alta' }, noRestaurable: [] });
    expect(undo.last('a')).not.toBeNull();
    now += 25 * 3_600_000;
    expect(undo.last('a')).toBeNull();
  });
});
