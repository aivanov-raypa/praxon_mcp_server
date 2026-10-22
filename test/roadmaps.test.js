import { describe, expect, it } from 'vitest';
import { FakeMyraypa } from '../src/connectors/myraypa/fake.js';
import { setup, stubModel, use } from './helpers.js';

const origin = { type: 'voice-assistant', user: 'alex', sessionId: 's' };

describe('FakeMyraypa: roadmaps e hitos', () => {
  it('lista y detalla roadmaps', async () => {
    const f = new FakeMyraypa();
    expect((await f.listRoadmaps({ texto: 'calibraciones' })).roadmaps).toHaveLength(1);
    const d = await f.getRoadmap('rm1');
    expect(d.bloques[0].tareas[0].subtareas[0].titulo).toBe('Plantilla');
    expect(d.hitos[0].fecha).toBe('2026-11-15');
  });
  it('valida fechas y rangos', async () => {
    const f = new FakeMyraypa();
    await expect(f.updateRoadmapElement('rm1', 't1', { fin: '30/09/2026' }, origin)).rejects.toThrow(/AAAA-MM-DD/);
    await expect(f.updateRoadmapElement('rm1', 't1', { fin: '2026-08-01' }, origin)).rejects.toThrow(/anterior/);
    await f.updateRoadmapElement('rm1', 't1', { fin: '2026-10-10', hecho: true }, origin);
    expect((await f.getRoadmap('rm1')).bloques[0].tareas[0]).toMatchObject({ fin: '2026-10-10', hecho: true });
  });
  it('añade elementos solo bajo el padre correcto', async () => {
    const f = new FakeMyraypa();
    await expect(f.addRoadmapElement('rm1', { tipo: 'tarea', titulo: 'x' }, origin)).rejects.toThrow(/indica a qué bloque/);
    await expect(f.addRoadmapElement('rm1', { tipo: 'subtarea', padreId: 'b1', titulo: 'x' }, origin)).rejects.toThrow(/debe ser una tarea/);
    const r = await f.addRoadmapElement('rm1', { tipo: 'subtarea', padreId: 't2', titulo: 'Pruebas' }, origin);
    expect(r.bloques[0].tareas[1].subtareas[0].titulo).toBe('Pruebas');
  });
  it('respeta la autonomía del proyecto', async () => {
    const f = new FakeMyraypa();
    await expect(f.addRoadmapMilestone('rm2', { titulo: 'x', fecha: '2026-12-01' }, origin)).rejects.toMatchObject({ status: 403 });
    await expect(f.addProjectMilestone('incidencias', { titulo: 'x', fecha: '2026-12-01' }, origin)).rejects.toMatchObject({ status: 403 });
  });
  it('encuentra hitos por título aproximado', async () => {
    const f = new FakeMyraypa();
    const r = await f.updateRoadmapMilestone('rm1', 'entrega', { fecha: '2026-11-20' }, origin);
    expect(r.hitos[0].fecha).toBe('2026-11-20');
    await expect(f.updateProjectMilestone('calibraciones', 'nada', { fecha: '2026-12-02' }, origin)).rejects.toMatchObject({ status: 404 });
  });
});

describe('mover un elemento del roadmap exige confirmación', () => {
  it('no cambia nada hasta confirmar', async () => {
    const s = setup({ model: stubModel([use('myraypa_actualizar_elemento_roadmap', { roadmapId: 'rm1', elementoId: 't2', fin: '2026-11-13' })]) });
    await s.orchestrator.handleUserText(s.session, { text: 'Retrasa la firma digital al 13 de noviembre' }, s.emit);
    const req = s.last('confirm_request');
    expect(req.summary).toBe('Voy a cambiar en el roadmap Roadmap Calibraciones 2026 la tarea Firma digital: fin de 2026-10-30 a 2026-11-13');
    expect(s.myraypa.roadmaps[0].bloques[0].items[1].fin).toBe('2026-10-30');
    await s.orchestrator.handleConfirm(s.session, { actionId: req.actionId, accepted: true }, s.emit);
    expect(s.myraypa.roadmaps[0].bloques[0].items[1].fin).toBe('2026-11-13');
    expect(s.myraypa.historial.at(-1).origin.type).toBe('voice-assistant');
  });
});
