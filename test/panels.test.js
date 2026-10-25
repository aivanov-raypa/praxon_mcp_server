import { describe, expect, it } from 'vitest';
import { createPanels, PanelError } from '../src/panels.js';
import { ToolControl } from '../src/tools/control.js';
import { MemoryAudit } from '../src/audit/log.js';
import { ReminderStore } from '../src/companion/reminders.js';
import { MemoryStore } from '../src/memory/store.js';
import { runAsUser } from '../src/identity.js';
import { setup } from './helpers.js';

const owner = { kind: 'device', user: 'alex', email: 'alex@raypa.com', deviceId: 'dev1' };
const other = { kind: 'device', user: 'bea', email: 'bea@raypa.com', deviceId: 'dev2' };

function build({ ownerOnly = true } = {}) {
  const s = setup();
  const toolControl = new ToolControl(null);
  s.registry.setControl(toolControl);
  const panels = createPanels({
    config: { MODEL_PROVIDER: 'scripted', VOICE_PROVIDER: 'none', STT_PROVIDER: 'none', ALLOW_LEGACY_TOKEN: false, MERGE_ALLOWED_USERS: ['alex@raypa.com'], HOST: '127.0.0.1' },
    myraypa: s.myraypa,
    audit: s.audit,
    registry: s.registry,
    toolControl,
    reminderStore: new ReminderStore(null),
    connections: () => [{ user: 'alex', deviceId: 'dev1' }],
    isOwner: (id) => !ownerOnly || id.email === 'alex@raypa.com',
  });
  return { ...s, panels, toolControl };
}

describe('paneles de la app', () => {
  it('hoy lo puede ver cualquier dispositivo; los demás paneles solo el aprobador', async () => {
    const t = build();
    for (const p of ['hoy']) expect((await t.panels.get({ panel: p }, other)).type).toBe('panel');
    for (const p of ['audit', 'devices', 'tools', 'status']) {
      await expect(t.panels.get({ panel: p }, other)).rejects.toBeInstanceOf(PanelError);
      expect((await t.panels.get({ panel: p }, owner)).type).toBe('panel');
    }
  });

  it('herramientas: agrupadas por conector con interruptor, chips y resumen', async () => {
    const t = build();
    const name = 'myraypa_listar_tickets';
    await t.toolControl.set(name, false);
    const panel = await t.panels.get({ panel: 'tools' }, owner);
    const filas = panel.secciones.flatMap((s) => s.filas);
    const fila = filas.find((f) => f.id === name);
    expect(fila.interruptor.activo).toBe(false);
    expect(fila.acciones).toBeUndefined();
    expect(fila.titulo).not.toMatch(/^myraypa_/);
    expect(fila.chips.map((c) => c.texto)).toContain('APAGADA');
    expect(panel.secciones[0].titulo).toBe('MYRAYPA');
    expect(panel.secciones[0].resumen).toMatch(/1 desactivada/);
    const escritura = filas.find((f) => f.chips.some((c) => c.texto === 'ESCRITURA'));
    expect(escritura.interruptor.confirmarAlActivar).toBeTruthy();
    const lectura = filas.find((f) => f.chips.some((c) => c.texto === 'LECTURA'));
    expect(lectura.interruptor.confirmarAlActivar).toBeUndefined();
  });

  it('olvidar_contexto borra los resúmenes del usuario y lo deja auditado', async () => {
    const t = build();
    let borrado = null;
    const p = createPanels({
      config: {}, myraypa: t.myraypa, audit: t.audit, registry: t.registry, toolControl: t.toolControl,
      context: { count: () => 2, forget: async (o) => { borrado = o; return 2; } },
      isOwner: () => true,
    });
    const estado = await p.get({ panel: 'status' }, owner);
    const fila = estado.secciones.flatMap((s) => s.filas).find((f) => f.id === 'contexto');
    expect(fila.detalle).toMatch(/2 resúmenes/);
    expect(fila.acciones[0].confirmar).toBeTruthy();
    expect((await p.action({ panel: 'status', accion: 'olvidar_contexto', id: 'contexto' }, owner)).ok).toBe(true);
    expect(borrado).toBe('alex@raypa.com');
    expect(t.audit.of('panel_action').at(-1)).toMatchObject({ accion: 'olvidar_contexto' });
  });

  it('un panel desconocido se rechaza', async () => {
    await expect(build().panels.get({ panel: 'nada' }, owner)).rejects.toThrow(/no existe/);
  });

  it('desactivar una herramienta la quita del modelo y bloquea su ejecución; activarla la devuelve', async () => {
    const t = build();
    const name = 'myraypa_listar_tickets';
    expect(t.registry.forModel().some((x) => x.name === name)).toBe(true);
    expect((await t.panels.action({ panel: 'tools', accion: 'desactivar', id: name }, owner)).ok).toBe(true);
    expect(t.registry.forModel().some((x) => x.name === name)).toBe(false);
    expect(t.registry.isDisabled(name)).toBe(true);
    expect(t.audit.of('panel_action').at(-1)).toMatchObject({ accion: 'desactivar', target: name });
    await t.panels.action({ panel: 'tools', accion: 'activar', id: name }, owner);
    expect(t.registry.forModel().some((x) => x.name === name)).toBe(true);
  });

  it('un usuario sin permiso no puede desactivar herramientas ni revocar dispositivos, y queda auditado', async () => {
    const t = build();
    for (const [panel, accion, id] of [['tools', 'desactivar', 'myraypa_listar_tickets'], ['devices', 'revocar', 'dev1']]) {
      expect((await t.panels.action({ panel, accion, id }, other)).ok).toBe(false);
    }
    expect(t.registry.isDisabled('myraypa_listar_tickets')).toBe(false);
    expect(t.audit.of('approval_denied')).toHaveLength(2);
  });

  it('una herramienta inexistente no se puede (des)activar', async () => {
    expect((await build().panels.action({ panel: 'tools', accion: 'desactivar', id: 'inventada' }, owner)).ok).toBe(false);
  });

  it('dispositivos: lista los propios, marca este y revoca', async () => {
    const t = build();
    const code = t.myraypa.issuePairingCode('alex@raypa.com');
    const { deviceId } = await t.myraypa.redeemDevice(code, 'Xiaomi');
    const r = await runAsUser('alex@raypa.com', () => t.panels.get({ panel: 'devices' }, { ...owner, deviceId }));
    expect(r.secciones[0].filas).toHaveLength(1);
    expect(r.secciones[0].filas[0].detalle).toContain('Este dispositivo');
    const out = await runAsUser('alex@raypa.com', () => t.panels.action({ panel: 'devices', accion: 'revocar', id: deviceId }, owner));
    expect(out.ok).toBe(true);
    expect((await runAsUser('alex@raypa.com', () => t.panels.get({ panel: 'devices' }, owner))).secciones[0].filas).toHaveLength(0);
  });

  it('no se puede revocar el dispositivo de otro usuario', async () => {
    const t = build();
    const code = t.myraypa.issuePairingCode('bea@raypa.com', 'ZZZZ2222');
    const { deviceId } = await t.myraypa.redeemDevice(code, 'Movil de Bea');
    const out = await runAsUser('alex@raypa.com', () => t.panels.action({ panel: 'devices', accion: 'revocar', id: deviceId }, owner));
    expect(out.ok).toBe(false);
  });

  it('auditoría: filtra por evento y por texto, y marca los fallos', async () => {
    const t = build();
    await t.audit.record({ event: 'auth_failed', remote: '1.2.3.4' });
    await t.audit.record({ event: 'tool_call', tool: 'x', ok: true, user: 'alex' });
    await t.audit.record({ event: 'user_text', text: 'hola mundo', user: 'alex' });
    const todos = await t.panels.get({ panel: 'audit' }, owner);
    expect(todos.secciones.flatMap((s) => s.filas)).toHaveLength(3);
    // Agrupado: los fallos van primero, y cada grupo trae su resumen.
    expect(todos.secciones.map((x) => x.titulo)).toEqual(['Avisos y fallos', 'Cambios y herramientas', 'Conversación']);
    expect(todos.secciones[0].filas[0].estado).toBe('error');
    expect(todos.secciones[0].resumen).toMatch(/1 evento/);
    const solo = await t.panels.get({ panel: 'audit', filtros: { event: 'user_text' } }, owner);
    expect(solo.secciones.flatMap((s) => s.filas)).toHaveLength(1);
    const buscar = await t.panels.get({ panel: 'audit', filtros: { texto: 'mundo' } }, owner);
    expect(buscar.secciones.flatMap((s) => s.filas)).toHaveLength(1);
    const raro = await t.panels.get({ panel: 'audit', filtros: { event: 'inventado' } }, owner);
    expect(raro.filtros[0].actual).toBe('');
  });

  it('estado: informa de MyRAYPA, conexiones y seguridad', async () => {
    const r = await build().panels.get({ panel: 'status' }, owner);
    const ids = r.secciones.flatMap((s) => s.filas).map((f) => f.id);
    expect(ids).toEqual(expect.arrayContaining(['servidor', 'conexiones', 'myraypa', 'github', 'seguridad', 'accesos']));
    expect(r.secciones.flatMap((s) => s.filas).find((f) => f.id === 'myraypa').estado).toBe('ok');
  });

  it('estado: si MyRAYPA falla se marca en rojo en vez de romper', async () => {
    const t = build();
    t.myraypa.listProjects = async () => {
      throw new Error('sin red');
    };
    const r = await t.panels.get({ panel: 'status' }, owner);
    expect(r.secciones.flatMap((s) => s.filas).find((f) => f.id === 'myraypa').estado).toBe('error');
    expect(r.resumen).toMatch(/revisar/);
  });

  it('hoy: agrupa y no revienta sin datos', async () => {
    const r = await build().panels.get({ panel: 'hoy' }, owner);
    expect(r.titulo).toBe('Hoy');
    expect(typeof r.resumen).toBe('string');
  });
});

describe('la app no replica MyRAYPA ni el correo', () => {
  it('no existen paneles de tickets, agenda ni correo', async () => {
    const t = build();
    for (const p of ['tickets', 'agenda', 'correo']) await expect(t.panels.get({ panel: p }, owner)).rejects.toThrow(/no existe/);
  });
  it('no se puede editar un ticket desde un panel', async () => {
    const t = build();
    const out = await t.panels.action({ panel: 'tickets', accion: 'prioridad', id: '214', valor: 'alta' }, owner);
    expect(out.ok).toBe(false);
    expect((await t.myraypa.getTicket('214')).prioridad).toBe('media');
  });
  it('Hoy solo habla de lo que tiene pendiente Praxon: no lista tickets', async () => {
    const r = await build().panels.get({ panel: 'hoy' }, owner);
    expect(JSON.stringify(r)).not.toMatch(/Faltantes OF|Alarma del datalogger/);
  });

  it('memoria: lista notas, recordatorios y resúmenes y permite borrarlos', async () => {
    const t = build();
    const memory = new MemoryStore(null);
    const nota = await memory.add({ texto: 'Los informes van siempre en PDF', ambito: 'global', user: 'alex' });
    const reminderStore = new ReminderStore(null);
    const rec = await reminderStore.add('alex@raypa.com', { texto: 'llamar a Ana', enMinutos: 60 });
    let olvidado = false;
    const p = createPanels({
      config: {}, myraypa: t.myraypa, audit: t.audit, registry: t.registry, toolControl: t.toolControl, memory, reminderStore,
      context: { count: () => 1, list: () => [{ ts: '2026-10-24T10:00:00Z', resumen: 'Se habló de tickets vencidos' }], forget: async () => { olvidado = true; return 1; } },
      isOwner: (id) => id.email === 'alex@raypa.com',
    });
    await expect(p.get({ panel: 'memoria' }, other)).rejects.toBeInstanceOf(PanelError);
    const panel = await p.get({ panel: 'memoria' }, owner);
    expect(panel.resumen).toBe('1 notas · 1 recordatorios · 1 resúmenes');
    expect(panel.secciones.map((s) => s.filas.length)).toEqual([1, 1, 2]);
    expect((await p.action({ panel: 'memoria', accion: 'borrar_nota', id: nota.id }, owner)).ok).toBe(true);
    expect(memory.list()).toHaveLength(0);
    expect((await p.action({ panel: 'memoria', accion: 'cancelar_recordatorio', id: rec.id }, owner)).ok).toBe(true);
    expect(reminderStore.list('alex@raypa.com')).toHaveLength(0);
    expect((await p.action({ panel: 'memoria', accion: 'olvidar_contexto', id: 'olvidar_todo' }, owner)).ok).toBe(true);
    expect(olvidado).toBe(true);
    expect((await p.action({ panel: 'memoria', accion: 'borrar_nota', id: 'nope' }, owner)).ok).toBe(false);
    expect((await p.action({ panel: 'memoria', accion: 'borrar_nota', id: 'x' }, other)).ok).toBe(false);
  });
});
