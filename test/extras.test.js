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
