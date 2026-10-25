import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ToolControl } from '../src/tools/control.js';
import { Orchestrator } from '../src/orchestrator.js';
import { Session } from '../src/session.js';
import { config, setup, stubModel, use } from './helpers.js';

describe('control de herramientas', () => {
  it('persiste lo desactivado entre reinicios', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'px-'));
    const path = join(dir, 'off.json');
    await new ToolControl(path).set('a_b', false);
    expect(new ToolControl(path).isDisabled('a_b')).toBe(true);
    const c = new ToolControl(path);
    await c.set('a_b', true);
    expect(new ToolControl(path).isDisabled('a_b')).toBe(false);
    rmSync(dir, { recursive: true });
  });

  it('un fichero ilegible deja todo activo', () => {
    expect(new ToolControl('/no/existe/off.json').list()).toEqual([]);
  });

  it('el orquestador no ejecuta una herramienta desactivada aunque el modelo la pida', async () => {
    const s = setup();
    const control = new ToolControl(null);
    s.registry.setControl(control);
    await control.set('myraypa_listar_proyectos', false);
    const model = stubModel([use('myraypa_listar_proyectos', {})], [{ type: 'text', text: 'Vale.' }]);
    const orch = new Orchestrator({ model, registry: s.registry, audit: s.audit, config, systemPrompt: 'test' });
    const session = new Session('sesion-de-prueba-1', 'alex');
    await orch.handleUserText(session, { text: 'lista los proyectos', requestId: 'r1' }, () => {});
    expect(s.audit.of('tool_call').at(-1)).toMatchObject({ ok: false, error: 'herramienta desactivada' });
  });

  it('una acción pendiente de confirmar no se ejecuta si la herramienta se apaga antes de confirmar', async () => {
    const s = setup();
    const control = new ToolControl(null);
    s.registry.setControl(control);
    const model = stubModel([use('myraypa_actualizar_ticket', { ticketId: '214', prioridad: 'alta' })], [{ type: 'text', text: 'Vale.' }]);
    const orch = new Orchestrator({ model, registry: s.registry, audit: s.audit, config, systemPrompt: 'test' });
    const session = new Session('sesion-de-prueba-1', 'alex');
    const out = [];
    await orch.handleUserText(session, { text: 'sube el 214 a alta', requestId: 'r1' }, (m) => out.push(m));
    const req = out.find((m) => m.type === 'confirm_request');
    const antes = (await s.myraypa.getTicket('214')).prioridad;
    await control.set('myraypa_actualizar_ticket', false);
    await orch.handleConfirm(session, { actionId: req.actionId, accepted: true }, (m) => out.push(m));
    expect((await s.myraypa.getTicket('214')).prioridad).toBe(antes);
  });
});
