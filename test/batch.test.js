import { describe, expect, it } from 'vitest';
import { fechasHabladas, resumenDeLote, unirResumenes } from '../src/batch.js';
import { setup, stubModel, use } from './helpers.js';

const ticket = (s, id) => s.myraypa.tickets.find((t) => t.id === id);
const ahora = new Date('2026-10-23T10:00:00Z');

describe('resumen de lote', () => {
  it('una sola acción: el resumen se queda tal cual y no hay lista', () => {
    expect(resumenDeLote(['Voy a cambiar el ticket A: prioridad de media a alta'])).toEqual({ summary: 'Voy a cambiar el ticket A: prioridad de media a alta' });
  });

  it('une los cambios de un mismo ticket en una línea, aunque lleguen mezclados', () => {
    const units = unirResumenes([
      'Voy a cambiar el ticket A: vencimiento el 2026-10-23',
      'Voy a cambiar el ticket B: vencimiento el 2026-10-23',
      'Voy a cambiar el ticket A: prioridad de media a alta',
      'Voy a comentar algo',
    ]);
    expect(units.map((u) => u.text)).toEqual([
      'Voy a cambiar el ticket A: vencimiento el 2026-10-23 y prioridad de media a alta',
      'Voy a cambiar el ticket B: vencimiento el 2026-10-23',
      'Voy a comentar algo',
    ]);
  });

  it('el mismo cambio en varios tickets se dice una vez, con la lista en pantalla', () => {
    const r = resumenDeLote(
      [
        'Voy a cambiar el ticket A: vencimiento el 2026-10-23', 'Voy a cambiar el ticket A: prioridad de media a alta',
        'Voy a cambiar el ticket B: vencimiento el 2026-10-23', 'Voy a cambiar el ticket B: prioridad de baja a alta',
        'Voy a cambiar el ticket C: vencimiento el 2026-10-23', 'Voy a cambiar el ticket C: prioridad de media a alta',
        'Voy a cambiar el ticket D: vencimiento el 2026-10-23', 'Voy a cambiar el ticket D: prioridad de baja a alta',
      ],
      ahora,
    );
    expect(r.summary).toBe('Voy a cambiar 4 tickets: vencimiento el 23 de octubre y prioridad a alta. Tienes la lista en pantalla');
    expect(r.items).toHaveLength(4);
    expect(r.items[1]).toBe('Cambiar el ticket B: vencimiento el 2026-10-23 y prioridad de baja a alta');
  });

  it('pocos tickets con el mismo cambio: los nombra', () => {
    const r = resumenDeLote(['Voy a cambiar el ticket A: prioridad de media a alta', 'Voy a cambiar el ticket B: prioridad de baja a alta'], ahora);
    expect(r.summary).toBe('Voy a cambiar 2 tickets (A y B): prioridad a alta');
  });

  it('cambios distintos: lee solo los dos primeros y dice cuántos más', () => {
    const r = resumenDeLote(
      ['Voy a cambiar el ticket A: prioridad de media a alta', 'Voy a cambiar el ticket B: estado de todo a done', 'Voy a comentar en C', 'Voy a comentar en D'],
      ahora,
    );
    expect(r.summary).toBe('Voy a hacer 4 cambios, entre ellos: cambiar el ticket A: prioridad de media a alta; cambiar el ticket B: estado de todo a done; y 2 más. Tienes la lista en pantalla');
    expect(r.items).toHaveLength(4);
  });

  it('las fechas ISO se dicen como se hablan, con el año solo si no es el actual', () => {
    expect(fechasHabladas('vencimiento el 2026-10-23', ahora)).toBe('vencimiento el 23 de octubre');
    expect(fechasHabladas('vencimiento el 2027-01-05', ahora)).toBe('vencimiento el 5 de enero de 2027');
  });
});

describe('una confirmación para todo el lote', () => {
  const dosCambiosEnTres = () =>
    stubModel(
      [
        use('myraypa_cambiar_fechas_ticket', { ticketId: '214', vencimiento: '2026-10-23' }, 't1'),
        use('myraypa_actualizar_ticket', { ticketId: '214', prioridad: 'alta' }, 't2'),
        use('myraypa_cambiar_fechas_ticket', { ticketId: '215', vencimiento: '2026-10-23' }, 't3'),
        use('myraypa_actualizar_ticket', { ticketId: '215', prioridad: 'alta' }, 't4'),
      ],
      [{ type: 'text', text: 'Hecho.' }],
    );

  it('pide UNA confirmación, no cambia nada antes y lo aplica todo al confirmar', async () => {
    const model = dosCambiosEnTres();
    const s = setup({ model });
    await s.orchestrator.handleUserText(s.session, { text: 'vencidos a hoy y prioridad alta', requestId: 'r1' }, s.emit);
    expect(s.out.filter((m) => m.type === 'confirm_request')).toHaveLength(1);
    const req = s.last('confirm_request');
    expect(req.items).toHaveLength(2);
    expect(ticket(s, '214').prioridad).toBe('media');
    expect(ticket(s, '215').prioridad).toBe('baja');

    await s.orchestrator.handleConfirm(s.session, { actionId: req.actionId, accepted: true }, s.emit);
    expect(ticket(s, '214').prioridad).toBe('alta');
    expect(ticket(s, '215').prioridad).toBe('alta');
    expect(ticket(s, '214').vencimiento).toBe('2026-10-23');
    expect(ticket(s, '215').vencimiento).toBe('2026-10-23');
    expect(s.out.at(-1)).toEqual({ type: 'assistant_done', requestId: 'r1' });
    // El modelo recibe un resultado por cada llamada, en el mismo orden
    const results = model.calls[1].messages.at(-1).content;
    expect(results.map((r) => r.tool_use_id)).toEqual(['t1', 't2', 't3', 't4']);
    expect(results.every((r) => !r.is_error)).toBe(true);
    // Cada acción queda auditada por separado
    expect(s.audit.of('tool_call').filter((e) => e.ok)).toHaveLength(4);
  });

  it('si se rechaza, no se ejecuta ninguna y el modelo recibe una cancelación por cada llamada', async () => {
    const model = dosCambiosEnTres();
    const s = setup({ model });
    await s.orchestrator.handleUserText(s.session, { text: 'x' }, s.emit);
    await s.orchestrator.handleConfirm(s.session, { actionId: s.last('confirm_request').actionId, accepted: false }, s.emit);
    expect(ticket(s, '214').prioridad).toBe('media');
    const results = model.calls[1].messages.at(-1).content;
    expect(results).toHaveLength(4);
    expect(results.every((r) => JSON.parse(r.content).cancelada)).toBe(true);
    expect(s.audit.of('tool_call_start')).toHaveLength(0);
  });

  it('una acción inválida del lote no impide confirmar las demás', async () => {
    const model = stubModel(
      [
        use('myraypa_actualizar_ticket', { ticketId: '214', prioridad: 'alta' }, 't1'),
        use('myraypa_actualizar_ticket', { ticketId: '999', prioridad: 'alta' }, 't2'),
      ],
      [{ type: 'text', text: 'Listo.' }],
    );
    const s = setup({ model });
    await s.orchestrator.handleUserText(s.session, { text: 'x' }, s.emit);
    const req = s.last('confirm_request');
    expect(req.summary).toBe('Voy a cambiar el ticket Faltantes OF semana 43: prioridad de media a alta');
    expect(req.items).toBeUndefined(); // una sola acción válida
    await s.orchestrator.handleConfirm(s.session, { actionId: req.actionId, accepted: true }, s.emit);
    const results = model.calls[1].messages.at(-1).content;
    expect(results[0].is_error).toBeUndefined();
    expect(results[1].is_error).toBe(true);
    expect(ticket(s, '214').prioridad).toBe('alta');
  });

  it('las lecturas del mismo mensaje se ejecutan sin esperar y el lote respeta el límite', async () => {
    const llamadas = Array.from({ length: 27 }, (_, i) => use('myraypa_actualizar_ticket', { ticketId: i % 2 ? '214' : '215', prioridad: i % 2 ? 'alta' : 'media' }, `t${i}`));
    const model = stubModel([use('myraypa_listar_proyectos', {}, 'r0'), ...llamadas], [{ type: 'text', text: 'ok' }]);
    const s = setup({ model });
    await s.orchestrator.handleUserText(s.session, { text: 'x' }, s.emit);
    const req = s.last('confirm_request');
    expect(req).toBeTruthy();
    await s.orchestrator.handleConfirm(s.session, { actionId: req.actionId, accepted: false }, s.emit);
    const results = model.calls[1].messages.at(-1).content;
    expect(results).toHaveLength(28);
    expect(results[0].is_error).toBeUndefined();
    expect(results.filter((r) => r.is_error && /Demasiados cambios/.test(r.content))).toHaveLength(2);
  });
});
