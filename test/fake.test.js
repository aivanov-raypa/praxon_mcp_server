import { describe, it, expect } from 'vitest';
import { FakeMyraypa } from '../src/connectors/myraypa/fake.js';

const origin = { type: 'voice-assistant', user: 'alex', sessionId: 's' };

describe('FakeMyraypa respeta el contrato real', () => {
  it('rechaza la prioridad "urgente" explicando las que existen', async () => {
    await expect(new FakeMyraypa().updateTicket('214', { prioridad: 'urgente' }, origin)).rejects.toThrow(/ninguna, baja, media y alta/);
  });

  it('los estados son columnas del proyecto y se aceptan sin acentos ni mayúsculas', async () => {
    const f = new FakeMyraypa();
    const r = await f.updateTicket('214', { estado: 'en progreso' }, origin);
    expect(r).toMatchObject({ estado: 'En progreso', estadoId: 'in-progress' });
    await expect(f.updateTicket('214', { estado: 'bloqueado' }, origin)).rejects.toThrow(/Estados: Por hacer, En progreso, Completado/);
  });

  it('completar un ticket lo saca de la lista de abiertos', async () => {
    const f = new FakeMyraypa();
    await f.updateTicket('215', { completado: true }, origin);
    const abiertos = await f.listTickets({ proyectoId: 'calibraciones' });
    expect(abiertos.tickets.map((t) => t.id)).not.toContain('215');
    expect((await f.listTickets({ proyectoId: 'calibraciones', mostrar: 'completados' })).tickets.map((t) => t.id)).toEqual(['215']);
  });

  it('un cambio sin efecto es un conflicto, no un éxito silencioso', async () => {
    await expect(new FakeMyraypa().updateTicket('214', { prioridad: 'media' }, origin)).rejects.toMatchObject({ status: 409 });
  });

  it('no permite dos agentes activos sobre el mismo ticket', async () => {
    const f = new FakeMyraypa();
    await f.createAgentRun({ ticketId: '215', tipo: 'mejora' }, origin);
    await expect(f.createAgentRun({ ticketId: '215', tipo: 'error' }, origin)).rejects.toMatchObject({ status: 409 });
  });
});
