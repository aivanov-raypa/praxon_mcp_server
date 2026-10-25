import { describe, expect, it } from 'vitest';
import { setup, stubModel, use } from './helpers.js';
import { Orchestrator } from '../src/orchestrator.js';
import { Session } from '../src/session.js';
import { config } from './helpers.js';

describe('tarjeta de resultado tras confirmar', () => {
  it('tras aceptar, la app recibe una tarjeta con lo hecho y la pista de deshacer', async () => {
    const s = setup();
    const model = stubModel(
      [use('myraypa_actualizar_ticket', { ticketId: '214', prioridad: 'alta' })],
      [{ type: 'text', text: 'Hecho.' }],
    );
    const orch = new Orchestrator({ model, registry: s.registry, audit: s.audit, config, systemPrompt: 'test' });
    const session = new Session('sesion-de-prueba-1', 'alex');
    const out = [];
    await orch.handleUserText(session, { text: 'sube el 214 a alta', requestId: 'r1' }, (m) => out.push(m));
    const req = out.find((m) => m.type === 'confirm_request');
    expect(req).toBeTruthy();
    await orch.handleConfirm(session, { actionId: req.actionId, accepted: true }, (m) => out.push(m));
    const card = out.find((m) => m.type === 'card');
    expect(card.titulo).toBe('Hecho');
    expect(card.filas[0]).toMatchObject({ estado: 'ok' });
    expect(card.filas.at(-1).etiqueta).toBe('Deshacer');
  });

  it('si rechazas, no hay tarjeta', async () => {
    const s = setup();
    const model = stubModel([use('myraypa_actualizar_ticket', { ticketId: '214', prioridad: 'alta' })], [{ type: 'text', text: 'Vale.' }]);
    const orch = new Orchestrator({ model, registry: s.registry, audit: s.audit, config, systemPrompt: 'test' });
    const session = new Session('sesion-de-prueba-1', 'alex');
    const out = [];
    await orch.handleUserText(session, { text: 'sube el 214', requestId: 'r1' }, (m) => out.push(m));
    const req = out.find((m) => m.type === 'confirm_request');
    await orch.handleConfirm(session, { actionId: req.actionId, accepted: false }, (m) => out.push(m));
    expect(out.some((m) => m.type === 'card')).toBe(false);
  });
});
