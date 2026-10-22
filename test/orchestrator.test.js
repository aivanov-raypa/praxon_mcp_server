import { describe, expect, it } from 'vitest';
import { Session } from '../src/session.js';
import { setup, stubModel, use } from './helpers.js';

const ticket = (s, id) => s.myraypa.tickets.find((t) => t.id === id);
const texts = (out) => out.filter((m) => m.type === 'assistant_chunk').map((m) => m.text).join(' ');

describe('consultas', () => {
  it('responde por frases y termina con assistant_done, sin pedir confirmacion', async () => {
    const s = setup();
    await s.orchestrator.handleUserText(s.session, { text: '¿Qué hay abierto en calibraciones?' }, s.emit);
    expect(s.out.some((m) => m.type === 'confirm_request')).toBe(false);
    expect(texts(s.out)).toContain('El más prioritario es Alarma del datalogger sin leer, prioridad alta');
    expect(s.out.at(-1)).toEqual({ type: 'assistant_done' });
    expect(s.audit.of('tool_call').every((e) => e.ok)).toBe(true);
  });
});

describe('escrituras con confirmacion', () => {
  const pedirUrgente = (s) => s.orchestrator.handleUserText(s.session, { text: 'Pasa el de los faltantes a alta', requestId: 'r1' }, s.emit);

  it('no cambia nada hasta que el usuario confirma', async () => {
    const s = setup();
    await pedirUrgente(s);
    const req = s.last('confirm_request');
    expect(req.summary).toBe('Voy a cambiar el ticket Faltantes OF semana 43: prioridad de media a alta');
    expect(req.requestId).toBe('r1');
    expect(ticket(s, '214').prioridad).toBe('media');
    expect(s.out.some((m) => m.type === 'assistant_done')).toBe(false);

    await s.orchestrator.handleConfirm(s.session, { actionId: req.actionId, accepted: true }, s.emit);
    expect(ticket(s, '214').prioridad).toBe('alta');
    expect(texts(s.out)).toContain('Hecho.');
    expect(s.out.at(-1)).toEqual({ type: 'assistant_done', requestId: 'r1' });
    expect(s.myraypa.historial.at(-1).origin).toEqual({ type: 'voice-assistant', user: 'alex', sessionId: 'sesion-de-prueba-1' });
  });

  it('si el usuario cancela, no se ejecuta y el asistente lo dice', async () => {
    const s = setup();
    await pedirUrgente(s);
    await s.orchestrator.handleConfirm(s.session, { actionId: s.last('confirm_request').actionId, accepted: false }, s.emit);
    expect(ticket(s, '214').prioridad).toBe('media');
    expect(texts(s.out)).toContain('Cancelado');
    expect(s.audit.of('confirm_result').at(-1).outcome).toBe('declined');
  });

  it('un mensaje que no es confirmacion anula la accion pendiente', async () => {
    const s = setup();
    await pedirUrgente(s);
    const { actionId } = s.last('confirm_request');
    await s.orchestrator.handleUserText(s.session, { text: '¿Qué proyectos hay?' }, s.emit);
    await s.orchestrator.handleConfirm(s.session, { actionId, accepted: true }, s.emit);
    expect(ticket(s, '214').prioridad).toBe('media');
    expect(s.last('error').message).toMatch(/No hay ninguna acción pendiente/);
  });

  it('rechaza un actionId distinto, uno ya usado y uno caducado', async () => {
    let t = 1_000;
    const s = setup({ now: () => t });
    await pedirUrgente(s);
    const { actionId } = s.last('confirm_request');

    await s.orchestrator.handleConfirm(s.session, { actionId: 'otro', accepted: true }, s.emit);
    expect(s.last('error').message).toMatch(/ese identificador/);
    expect(ticket(s, '214').prioridad).toBe('media');

    t += 61_000;
    await s.orchestrator.handleConfirm(s.session, { actionId, accepted: true }, s.emit);
    expect(s.last('error').message).toMatch(/caducado/);
    expect(ticket(s, '214').prioridad).toBe('media');

    await s.orchestrator.handleConfirm(s.session, { actionId, accepted: true }, s.emit);
    expect(s.last('error').message).toMatch(/No hay ninguna acción pendiente/);
  });

  it('la confirmacion no vale para otra sesion', async () => {
    const s = setup();
    await pedirUrgente(s);
    const { actionId } = s.last('confirm_request');
    await s.orchestrator.handleConfirm(new Session('otra-sesion-distinta', 'alex'), { actionId, accepted: true }, s.emit);
    expect(ticket(s, '214').prioridad).toBe('media');
  });

  it('una escritura no se ejecuta si la auditoria falla', async () => {
    const s = setup();
    await pedirUrgente(s);
    const { actionId } = s.last('confirm_request');
    s.audit.failNext = true; // lo consume el primer registro: confirm_result. Se fuerza tambien el de tool_call_start.
    const original = s.audit.record.bind(s.audit);
    s.audit.record = async (e) => {
      if (e.event === 'tool_call_start') throw new Error('auditoria no disponible');
      return original(e);
    };
    await s.orchestrator.handleConfirm(s.session, { actionId, accepted: true }, s.emit);
    expect(ticket(s, '214').prioridad).toBe('media');
    expect(texts(s.out)).toMatch(/No he podido hacerlo/);
  });

  it('dropPending (corte de conexion) descarta la accion', async () => {
    const s = setup();
    await pedirUrgente(s);
    const { actionId } = s.last('confirm_request');
    await s.orchestrator.dropPending(s.session, 'connection_closed');
    await s.orchestrator.handleConfirm(s.session, { actionId, accepted: true }, s.emit);
    expect(ticket(s, '214').prioridad).toBe('media');
    expect(s.audit.of('confirm_result').map((e) => e.outcome)).toContain('connection_closed');
  });
});

describe('seguridad del bucle de herramientas', () => {
  it('una herramienta de escritura pedida por el modelo nunca se ejecuta sin confirmar', async () => {
    const model = stubModel([use('myraypa_actualizar_ticket', { ticketId: '214', prioridad: 'baja' })]);
    const s = setup({ model });
    await s.orchestrator.handleUserText(s.session, { text: 'baja el 214' }, s.emit);
    expect(ticket(s, '214').prioridad).toBe('media');
    expect(s.audit.of('tool_call_start')).toHaveLength(0);
    expect(s.last('confirm_request')).toBeTruthy();
  });

  it('herramienta inexistente o parametros no validos vuelven al modelo como error, sin ejecutar nada', async () => {
    const model = stubModel(
      [use('myraypa_desplegar', {}, 'a'), use('myraypa_detalle_ticket', { ticketId: 'x' }, 'b')],
      [{ type: 'text', text: 'No he podido.' }],
    );
    const s = setup({ model });
    await s.orchestrator.handleUserText(s.session, { text: 'despliega' }, s.emit);
    const results = model.calls[1].messages.at(-1).content;
    expect(results.map((r) => r.is_error)).toEqual([true, true]);
    expect(results.map((r) => r.tool_use_id)).toEqual(['a', 'b']);
  });

  it('un ticket de un proyecto de solo consulta no se puede modificar (lo impone MyRAYPA)', async () => {
    const model = stubModel([use('myraypa_actualizar_ticket', { ticketId: '401', prioridad: 'alta' })]);
    const s = setup({ model });
    await s.orchestrator.handleUserText(s.session, { text: 'pon el 401 alta' }, s.emit);
    const req = s.last('confirm_request');
    await s.orchestrator.handleConfirm(s.session, { actionId: req.actionId, accepted: true }, s.emit);
    expect(ticket(s, '401').prioridad).toBe('media');
    expect(s.audit.of('tool_call').at(-1).ok).toBe(false);
  });

  it('el historial queda consistente: cada tool_use tiene su tool_result', async () => {
    const s = setup();
    await s.orchestrator.handleUserText(s.session, { text: 'Pasa el de los faltantes a alta' }, s.emit);
    await s.orchestrator.handleConfirm(s.session, { actionId: s.last('confirm_request').actionId, accepted: true }, s.emit);
    const blocks = (role, type) => s.session.history.filter((m) => m.role === role && Array.isArray(m.content)).flatMap((m) => m.content.filter((b) => b.type === type));
    expect(blocks('assistant', 'tool_use').map((b) => b.id).sort()).toEqual(blocks('user', 'tool_result').map((b) => b.tool_use_id).sort());
  });

  it('un error del modelo se comunica y no deja la sesion rota', async () => {
    const model = {
      // eslint-disable-next-line require-yield
      async *stream() {
        throw new Error('API caida');
      },
    };
    const s = setup({ model });
    await s.orchestrator.handleUserText(s.session, { text: 'hola' }, s.emit);
    expect(s.last('error').message).toMatch(/modelo/);
    expect(s.audit.of('model_error')).toHaveLength(1);
  });
});

describe('interrupciones', () => {
  it('un mensaje nuevo interrumpe la respuesta en curso sin mezclar textos', async () => {
    let release;
    const gate = new Promise((r) => (release = r));
    let n = 0;
    const model = {
      async *stream() {
        if (n++ === 0) {
          yield { type: 'text', text: 'Primera respuesta larga que no debe oirse. ' };
          await gate;
          yield { type: 'text', text: 'Resto de la primera respuesta. ' };
          yield { type: 'message', content: [{ type: 'text', text: 'x' }], stopReason: 'end_turn' };
        } else {
          yield { type: 'text', text: 'Segunda respuesta correcta.' };
          yield { type: 'message', content: [{ type: 'text', text: 'Segunda respuesta correcta.' }], stopReason: 'end_turn' };
        }
      },
    };
    const s = setup({ model });
    const first = s.orchestrator.handleUserText(s.session, { text: 'uno', requestId: 'A' }, s.emit);
    await new Promise((r) => setTimeout(r, 10));
    const second = s.orchestrator.handleUserText(s.session, { text: 'dos', requestId: 'B' }, s.emit);
    release();
    await Promise.all([first, second]);
    expect(s.out.filter((m) => m.requestId === 'A' && m.type === 'assistant_done')).toHaveLength(0);
    expect(s.out.filter((m) => m.requestId === 'B').map((m) => m.type)).toEqual(['assistant_chunk', 'assistant_done']);
    const h = s.session.history;
    expect(h.filter((m, i) => i && m.role === 'user' && h[i - 1].role === 'user')).toHaveLength(0);
  });

  it('cancel corta la respuesta y descarta la accion pendiente', async () => {
    const s = setup();
    await s.orchestrator.handleUserText(s.session, { text: 'Pasa el de los faltantes a alta' }, s.emit);
    const { actionId } = s.last('confirm_request');
    await s.orchestrator.cancel(s.session, s.emit);
    await s.orchestrator.handleConfirm(s.session, { actionId, accepted: true }, s.emit);
    expect(ticket(s, '214').prioridad).toBe('media');
  });
});

describe('agentes', () => {
  it('lanza el workflow con el ticket y el runId solo tras confirmar', async () => {
    const model = stubModel([use('myraypa_lanzar_agente', { ticketId: '215', tipo: 'mejora' })]);
    const s = setup({ model });
    await s.orchestrator.handleUserText(s.session, { text: 'lanza un agente en el 215' }, s.emit);
    expect(s.last('confirm_request').summary).toBe(
      'Voy a lanzar un agente de mejora sobre el ticket Exportar certificados a PDF, en el repositorio ejemplo/raypa-platform',
    );
    expect(s.github.dispatched).toHaveLength(0);
    await s.orchestrator.handleConfirm(s.session, { actionId: s.last('confirm_request').actionId, accepted: true }, s.emit);
    expect(s.github.dispatched).toEqual([{ repo: 'ejemplo/raypa-platform', ref: 'main', ticketId: '215', runId: 'run-1' }]);
  });

  it('si GitHub falla, el AgentRun queda cancelado y no huerfano', async () => {
    const model = stubModel([use('myraypa_lanzar_agente', { ticketId: '215', tipo: 'error' })]);
    const s = setup({ model });
    s.github.failNext = true;
    await s.orchestrator.handleUserText(s.session, { text: 'lanza' }, s.emit);
    await s.orchestrator.handleConfirm(s.session, { actionId: s.last('confirm_request').actionId, accepted: true }, s.emit);
    expect(s.myraypa.runs[0].estado).toBe('cancelado');
  });

  it('no deja lanzar agentes en proyectos que no los permiten', async () => {
    const model = stubModel([use('myraypa_lanzar_agente', { ticketId: '301', tipo: 'error' })], [{ type: 'text', text: 'No se puede.' }]);
    const s = setup({ model });
    await s.orchestrator.handleUserText(s.session, { text: 'lanza en el 301' }, s.emit);
    expect(s.out.some((m) => m.type === 'confirm_request')).toBe(false);
    expect(s.github.dispatched).toHaveLength(0);
  });
});
