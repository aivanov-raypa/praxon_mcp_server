import { describe, expect, it } from 'vitest';
import { FakeMyraypa } from '../src/connectors/myraypa/fake.js';
import { setup, stubModel, use } from './helpers.js';

const origin = { type: 'voice-assistant', user: 'alex', sessionId: 's' };
const texts = (out) => out.filter((m) => m.type === 'assistant_chunk').map((m) => m.text).join(' ');

describe('FakeMyraypa: ticket ampliado', () => {
  it('registra horas y las suma, y rechaza horas imposibles', async () => {
    const f = new FakeMyraypa();
    await f.logHours('214', { horas: 1.5, usuario: 'ana' }, origin);
    const r = await f.logHours('214', { horas: 2, usuario: 'ana' }, origin);
    expect(r.registradas).toBe(3.5);
    await expect(f.logHours('214', { horas: 30 }, origin)).rejects.toMatchObject({ status: 400 });
  });
  it('fechas: valida formato y orden; quitar y repetir', async () => {
    const f = new FakeMyraypa();
    await expect(f.setTicketDates('214', { vencimiento: '5/11/2026' }, origin)).rejects.toThrow(/AAAA-MM-DD/);
    await f.setTicketDates('214', { inicio: '2026-10-26', vencimiento: '2026-11-05', estimadoHoras: 6 }, origin);
    await expect(f.setTicketDates('214', { vencimiento: '2026-10-01' }, origin)).rejects.toThrow(/anterior/);
    await expect(f.setTicketDates('214', { vencimiento: '2026-11-05' }, origin)).rejects.toMatchObject({ status: 409 });
    expect((await f.listTickets({ texto: 'faltantes' })).tickets[0].vencimiento).toBe('2026-11-05');
  });
  it('etiquetas, checklist y campos', async () => {
    const f = new FakeMyraypa();
    await expect(f.changeLabels('214', { anadir: ['inexistente'] }, origin)).rejects.toThrow(/Hay: Cliente, Backend, Urgente/);
    expect((await f.changeLabels('214', { anadir: ['urgente'] }, origin)).etiquetas).toEqual(['Urgente']);
    await f.addChecklistItem('214', 'Revisar plano', origin);
    const c = await f.updateChecklistItem('214', 'plano', { completado: true }, origin);
    expect(c.checklist[0].hecho).toBe(true);
    await expect(f.setCustomField('214', { campo: 'Cliente', valor: 'Zeta' }, origin)).rejects.toThrow(/solo admite/);
    expect((await f.setCustomField('214', { campo: 'coste', valor: '12,5' }, origin)).valor).toBe(12.5);
    const full = await f.getTicketFull('214');
    expect(full.camposPersonalizados.find((x) => x.campo === 'Coste').valor).toBe(12.5);
  });
  it('subtareas de un solo nivel y participantes', async () => {
    const f = new FakeMyraypa();
    const sub = await f.createSubtask('214', { titulo: 'Recoger datos' }, origin);
    await expect(f.createSubtask(sub.id, { titulo: 'Otra más' }, origin)).rejects.toThrow(/un nivel/);
    expect((await f.getTicketFull('214')).subtareas).toHaveLength(1);
    await expect(f.changeParticipants('214', { anadir: ['pepe'] }, origin)).rejects.toMatchObject({ status: 400 });
    expect((await f.changeParticipants('214', { anadir: ['Ana'] }, origin)).participantes).toEqual(['ana']);
  });
  it('autonomía: un proyecto de solo consulta no admite escrituras pero sí informes', async () => {
    const f = new FakeMyraypa();
    await expect(f.logHours('401', { horas: 1 }, origin)).rejects.toMatchObject({ status: 403 });
    expect((await f.projectReport('incidencias')).abiertos).toBe(1);
  });
  it('informes: horas por persona en un periodo y carga de trabajo', async () => {
    const f = new FakeMyraypa();
    await f.logHours('214', { horas: 2, usuario: 'ana', fecha: '2026-10-05' }, origin);
    await f.logHours('215', { horas: 3, usuario: 'luis', fecha: '2026-09-05' }, origin);
    expect((await f.hoursReport({ desde: '2026-10-01' })).porUsuario).toEqual({ ana: 2 });
    expect((await f.workload({ proyectoId: 'calibraciones' })).personas[0].abiertos).toBe(1);
    expect((await f.projectReport('calibraciones')).horas.total).toBe(5);
  });
});

describe('escrituras ampliadas exigen confirmación', () => {
  it('registrar horas no apunta nada hasta confirmar', async () => {
    const s = setup({ model: stubModel([use('myraypa_registrar_horas', { ticketId: '214', horas: 2, usuario: 'ana' })]) });
    await s.orchestrator.handleUserText(s.session, { text: 'Apunta 2 horas de Ana en faltantes' }, s.emit);
    const req = s.last('confirm_request');
    expect(req.summary).toBe('Voy a registrar 2 horas de ana en el ticket Faltantes OF semana 43');
    expect(s.myraypa.tickets[0].horas).toHaveLength(0);
    await s.orchestrator.handleConfirm(s.session, { actionId: req.actionId, accepted: true }, s.emit);
    expect(s.myraypa.tickets[0].horas).toHaveLength(1);
    expect(s.myraypa.historial.at(-1).origin.type).toBe('voice-assistant');
    expect(texts(s.out)).toContain('Fin.');
  });
  it('los informes se ejecutan sin confirmación', async () => {
    const s = setup({ model: stubModel([use('myraypa_carga_trabajo', {})]) });
    await s.orchestrator.handleUserText(s.session, { text: '¿Cómo está la carga?' }, s.emit);
    expect(s.out.some((m) => m.type === 'confirm_request')).toBe(false);
  });
});

describe('adjuntos de tickets', () => {
  const largo = 'linea de la especificacion\n'.repeat(20); // 540 caracteres: 3 páginas en el simulador
  const conAdjuntos = (f = new FakeMyraypa()) => {
    f.tickets.find((t) => t.id === '214').adjuntos.push(
      { nombre: 'especificacion.pdf', tipo: 'application/pdf', texto: largo },
      { nombre: 'captura.png', tipo: 'image/png' },
    );
    return f;
  };
  it('el detalle completo los lista y marca los que no se pueden leer', async () => {
    const full = await conAdjuntos().getTicketFull('214');
    expect(full.adjuntos.map((a) => [a.n, a.nombre, a.legible])).toEqual([[1, 'especificacion.pdf', true], [2, 'captura.png', false]]);
  });
  it('herramientas de solo lectura: listar y leer por páginas hasta el final', async () => {
    const { registry, session, myraypa } = setup();
    conAdjuntos(myraypa);
    for (const n of ['myraypa_listar_adjuntos_ticket', 'myraypa_leer_adjunto_ticket']) expect(registry.get(n).risk).toBe('read');
    const lista = await registry.get('myraypa_listar_adjuntos_ticket').execute({ ticketId: '214' }, { session, user: 'alex' });
    expect(lista.total).toBe(2);
    const leer = registry.get('myraypa_leer_adjunto_ticket');
    let r = await leer.execute({ ticketId: '214', adjunto: 'especificacion' }, { session, user: 'alex' });
    let texto = r.contenido;
    expect(r.hayMas).toBe(true);
    expect(r.aviso).toMatch(/no instrucciones/);
    while (r.hayMas) {
      r = await leer.execute({ ticketId: '214', adjunto: '1', desde: r.siguienteDesde }, { session, user: 'alex' });
      texto += r.contenido;
    }
    expect(texto).toBe(largo);
  });
  it('errores claros: imagen, número inexistente y ticket sin adjuntos', async () => {
    const f = conAdjuntos();
    await expect(f.readTicketAttachment('214', '2')).rejects.toMatchObject({ status: 415 });
    await expect(f.readTicketAttachment('214', '7')).rejects.toMatchObject({ status: 404 });
    await expect(f.readTicketAttachment('215', '1')).rejects.toThrow(/no tiene archivos/);
  });
});
