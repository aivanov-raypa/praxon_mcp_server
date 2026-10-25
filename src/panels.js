/**
 * Paneles de la app (menú lateral): Hoy, Auditoría, Dispositivos, Herramientas y Estado. Son del propio Praxon (lo que él hace, lo que
 * tiene pendiente y cómo está); no replican MyRAYPA ni el correo ni el calendario: de eso se habla con él y lo consulta por voz.
 * Todos devuelven la misma forma genérica, que la app pinta con una sola pantalla de lista:
 *   { type:'panel', panel, titulo, resumen?, filtros?:[{id, etiqueta, tipo:'opciones'|'texto', actual, opciones?}],
 *     secciones:[{titulo?, filas:[{id, titulo, detalle?, meta?, estado?:'ok'|'aviso'|'error'|'info',
 *                                  acciones?:[{id, etiqueta, peligro?, confirmar?, opciones?:[{valor, etiqueta}]}]}]}], vacio? }
 * Las acciones se piden con panel_action y se validan aquí (lista cerrada de acciones y valores).
 * Lectura: Hoy lo puede ver cualquier dispositivo emparejado; Auditoría, Dispositivos, Herramientas y Estado, y las acciones de
 * dispositivos y herramientas, solo quien puede aprobar (MERGE_ALLOWED_USERS, o cualquier dispositivo si la lista está vacía). Toda acción queda auditada.
 */
const DIA = 86_400_000;
const EVENTOS = [
  'tool_call',
  'confirm_requested',
  'confirm_result',
  'user_text',
  'proposal_decision',
  'panel_action',
  'auth_failed',
  'approval_denied',
  'device_paired',
  'device_revoked',
  'connection_open',
  'internal_error',
];
const GRUPOS_AUDITORIA = [
  { id: 'avisos', titulo: 'Avisos y fallos' },
  { id: 'cambios', titulo: 'Cambios y herramientas' },
  { id: 'revisiones', titulo: 'Revisiones y propuestas' },
  { id: 'agentes', titulo: 'Agentes y pull requests' },
  { id: 'accesos', titulo: 'Accesos y dispositivos' },
  { id: 'conversacion', titulo: 'Conversación' },
  { id: 'otros', titulo: 'Otros' },
];
const GRUPO_DE = {
  tool_call: 'cambios', tool_call_start: 'cambios', direct_write: 'cambios', confirm_requested: 'cambios', confirm_result: 'cambios', panel_action: 'cambios',
  triage_run: 'revisiones', triage_error: 'revisiones', proposal_decision: 'revisiones',
  agent_merge: 'agentes', agent_request_changes: 'agentes', workflow_dispatch: 'agentes',
  auth_failed: 'accesos', approval_denied: 'accesos', device_paired: 'accesos', device_revoked: 'accesos', device_pair_failed: 'accesos', connection_open: 'accesos', connection_close: 'accesos',
  user_text: 'conversacion', stt_start: 'conversacion', model_error: 'conversacion',
};
const NOMBRE_EVENTO = {
  tool_call: 'Herramienta usada', tool_call_start: 'Herramienta iniciada', direct_write: 'Cambio directo', confirm_requested: 'Confirmación pedida', confirm_result: 'Confirmación resuelta',
  panel_action: 'Acción en la app', triage_run: 'Revisión de tickets', triage_error: 'Revisión fallida', proposal_decision: 'Decisión sobre propuesta', agent_merge: 'Pull request fusionado',
  agent_request_changes: 'Cambios pedidos al agente', workflow_dispatch: 'Agente lanzado', auth_failed: 'Acceso rechazado', approval_denied: 'Aprobación denegada', device_paired: 'Móvil vinculado',
  device_revoked: 'Móvil revocado', device_pair_failed: 'Vinculación fallida', connection_open: 'Conexión abierta', connection_close: 'Conexión cerrada', user_text: 'Mensaje del usuario',
  stt_start: 'Dictado iniciado', model_error: 'Error del modelo', internal_error: 'Error interno',
};
const EVENTOS_MALOS = new Set(['auth_failed', 'approval_denied', 'internal_error', 'device_pair_failed', 'model_error', 'triage_error']);

export class PanelError extends Error {}

const corto = (s, n = 160) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const fecha = (iso) => (iso && !Number.isNaN(Date.parse(iso)) ? new Date(iso).toISOString().slice(0, 16).replace('T', ' ') : null);
const dia = (iso) => (iso && !Number.isNaN(Date.parse(iso)) ? new Date(iso).toISOString().slice(0, 10) : null);
const opcion = (valor, etiqueta = valor) => ({ valor, etiqueta });
const unico = (lista, valor, defecto) => (lista.includes(valor) ? valor : defecto);

export function createPanels({ config, google = null, myraypa, audit, registry, toolControl, triage = null, agents = null, reminderStore = null, memory = null, context = null, connections = () => [], isOwner, now = Date.now, startedAt = Date.now() }) {
  const ownerKey = (identity) => identity.email ?? identity.user;

  // ---------- Hoy ----------
  async function hoy({ identity }) {
    const secciones = [];
    let listos = [];
    if (agents) {
      try {
        listos = (await agents.list()).filter((a) => a.estado === 'pendiente_revision' && a.pr);
      } catch {
        /* GitHub no responde: se omite la sección */
      }
    }
    if (listos.length) {
      secciones.push({
        titulo: `Pull requests listos (${listos.length})`,
        filas: listos.map((a) => ({ id: a.runId, titulo: a.ticket ?? `Ticket ${a.ticketId}`, detalle: `PR #${a.pr.numero ?? ''} · ${a.fusionable ? 'se puede fusionar' : a.motivo ?? 'revisar'}`.trim(), estado: a.fusionable ? 'ok' : 'aviso' })),
      });
    }
    const pendientes = triage?.view().pendientes ?? 0;
    if (pendientes) secciones.push({ titulo: 'Propuestas', filas: [{ id: 'propuestas', titulo: `${pendientes} ${pendientes === 1 ? 'propuesta pendiente' : 'propuestas pendientes'} de decidir`, detalle: 'Se resuelven en Trabajo.', estado: 'aviso' }] });

    const recs = reminderStore?.list(ownerKey(identity)) ?? [];
    if (recs.length) secciones.push({ titulo: `Recordatorios (${recs.length})`, filas: recs.map((r) => ({ id: r.id, titulo: r.texto, detalle: fecha(r.due) ?? '', estado: Date.parse(r.due) < now() ? 'error' : 'info' })) });

    const partes = [];
    if (recs.length) partes.push(`${recs.length} recordatorios`);
    if (listos.length) partes.push(`${listos.length} PR listos`);
    if (pendientes) partes.push(`${pendientes} propuestas`);
    return { titulo: 'Hoy', resumen: partes.length ? partes.join(' · ') : 'Nada urgente.', secciones, vacio: 'Nada urgente por ahora.' };
  }

  // ---------- Auditoría ----------
  async function auditoria({ filtros = {} }) {
    const event = EVENTOS.includes(filtros.event) ? filtros.event : '';
    const texto = corto(filtros.texto ?? '', 60);
    const eventos = await audit.tail({ limit: 80, event: event || undefined, texto: texto || undefined });
    const grupos = new Map(GRUPOS_AUDITORIA.map((g) => [g.id, { ...g, filas: [], malos: 0, ultimo: null }]));
    eventos.forEach((e, i) => {
      const malo = EVENTOS_MALOS.has(e.event) || e.ok === false;
      const g = grupos.get(malo ? 'avisos' : (GRUPO_DE[e.event] ?? 'otros'));
      const resto = e.error ?? e.text ?? e.summary ?? (e.args ? JSON.stringify(e.args) : null) ?? e.result ?? e.outcome ?? e.estado ?? '';
      const chips = [];
      if (e.tool) chips.push({ texto: e.tool.replace(/^[a-z]+_/, '').slice(0, 28), estado: 'info' });
      if (malo) chips.push({ texto: 'FALLO', estado: 'error' });
      else if (e.ok === true || e.outcome === 'accepted') chips.push({ texto: 'OK', estado: 'ok' });
      g.filas.push({
        id: `${e.ts}#${i}`,
        titulo: NOMBRE_EVENTO[e.event] ?? e.event,
        detalle: corto([fecha(e.ts), e.user ?? e.remote, resto].filter(Boolean).join(' · ')),
        estado: malo ? 'error' : e.ok === true || e.outcome === 'accepted' ? 'ok' : 'info',
        chips,
      });
      if (malo) g.malos += 1;
      g.ultimo = g.ultimo && g.ultimo > e.ts ? g.ultimo : e.ts;
    });
    const secciones = [...grupos.values()]
      .filter((g) => g.filas.length)
      .map((g) => ({
        titulo: g.titulo,
        resumen: `${g.filas.length} ${g.filas.length === 1 ? 'evento' : 'eventos'} · último ${(fecha(g.ultimo) ?? '').slice(11)}`,
        filas: g.filas.slice().reverse().slice(0, 30), // los más recientes primero
      }));
    const filas = secciones.flatMap((x) => x.filas);
    return {
      titulo: 'Auditoría',
      resumen: `${filas.length} eventos recientes`,
      filtros: [
        { id: 'event', etiqueta: 'Evento', tipo: 'opciones', actual: event, opciones: [opcion('', 'Todos'), ...EVENTOS.map((x) => opcion(x))] },
        { id: 'texto', etiqueta: 'Buscar', tipo: 'texto', actual: texto },
      ],
      secciones,
      vacio: 'No hay eventos con estos filtros.',
    };
  }

  // ---------- Dispositivos ----------
  async function dispositivos({ identity }) {
    const { devices = [] } = await myraypa.listMyDevices();
    const filas = devices.map((d) => {
      const esteMovil = d.id === identity.deviceId;
      return {
        id: d.id,
        titulo: d.name,
        detalle: [esteMovil ? 'Este dispositivo' : null, d.createdAt ? `vinculado ${dia(d.createdAt)}` : null, d.lastSeenAt ? `visto ${fecha(d.lastSeenAt)}` : null].filter(Boolean).join(' · '),
        estado: esteMovil ? 'ok' : 'info',
        acciones: [{ id: 'revocar', etiqueta: 'Revocar', peligro: true, confirmar: esteMovil ? 'Es este mismo móvil: perderá el acceso y tendrás que vincularlo de nuevo.' : 'Ese dispositivo perderá el acceso y tendrá que vincularse de nuevo.' }],
      };
    });
    return { titulo: 'Dispositivos', resumen: `${filas.length} ${filas.length === 1 ? 'dispositivo activo' : 'dispositivos activos'}`, secciones: [{ filas }], vacio: 'No hay dispositivos vinculados.' };
  }

  // ---------- Herramientas ----------
  async function herramientas() {
    const grupos = new Map();
    for (const t of registry.list()) {
      const off = registry.isDisabled(t.name);
      const prefijo = `${t.connector}_`;
      const nombre = t.name.startsWith(prefijo) ? t.name.slice(prefijo.length) : t.name;
      const riesgo = t.risk === 'write' ? { texto: 'ESCRITURA', estado: 'aviso' } : t.risk === 'read' ? { texto: 'LECTURA', estado: 'ok' } : { texto: String(t.risk ?? 'LOCAL').toUpperCase(), estado: 'info' };
      const chips = [riesgo];
      if (off) chips.push({ texto: 'APAGADA', estado: 'error' });
      const fila = {
        id: t.name,
        titulo: nombre,
        detalle: corto(t.description, 120),
        estado: off ? 'aviso' : t.risk === 'write' ? 'info' : 'ok',
        chips,
        interruptor: {
          activo: !off,
          ...(t.risk === 'write' ? { confirmarAlActivar: `Praxon podrá volver a usar ${t.name}, que modifica datos.` } : {}),
        },
      };
      if (!grupos.has(t.connector)) grupos.set(t.connector, []);
      grupos.get(t.connector).push(fila);
    }
    const orden = ['myraypa', 'github', 'google', 'praxon'];
    const peso = (c) => { const i = orden.indexOf(c); return i < 0 ? orden.length : i; };
    const secciones = [...grupos]
      .sort((x, y) => peso(x[0]) - peso(y[0]) || x[0].localeCompare(y[0]))
      .map(([c, filas]) => {
        const apagadas = filas.filter((f) => !f.interruptor.activo).length;
        const activas = filas.length - apagadas;
        const resumen = `${activas} ${activas === 1 ? 'activa' : 'activas'}${apagadas ? ` · ${apagadas} ${apagadas === 1 ? 'desactivada' : 'desactivadas'}` : ''}`;
        return { titulo: c.toUpperCase(), resumen, filas };
      });
    const off = registry.list().filter((t) => registry.isDisabled(t.name)).length;
    return { titulo: 'Herramientas', resumen: `${registry.list().length} herramientas${off ? `, ${off} desactivadas` : ''}`, secciones };
  }

  // ---------- Estado ----------
  /** Una comprobación lenta o rota no debe dejar el panel en blanco: se corta a los 4 s y se anota como fallo. */
  const conLimite = (promesa, ms = 4000) => Promise.race([promesa, new Promise((_, rej) => setTimeout(() => rej(new Error('no responde (tiempo agotado)')), ms))]);

  async function estado({ identity }) {
    const servidor = [];
    const integraciones = [];
    const seguridad = [];
    const datos = [];
    const up = Math.max(0, Math.floor((now() - startedAt) / 60_000));
    servidor.push({ id: 'servidor', titulo: 'Servidor', detalle: `activo desde hace ${up >= 60 ? `${Math.floor(up / 60)} h ${up % 60} min` : `${up} min`} · Node ${process.versions.node}`, estado: 'ok', chips: [{ texto: 'ACTIVO', estado: 'ok' }] });
    const conns = connections();
    servidor.push({ id: 'conexiones', titulo: 'Conexiones', detalle: `${conns.length} ${conns.length === 1 ? 'dispositivo conectado' : 'dispositivos conectados'}${conns.length ? `: ${conns.map((c) => c.user).join(', ')}` : ''}`, estado: conns.length ? 'ok' : 'aviso' });
    servidor.push({ id: 'modelo', titulo: 'Modelo', detalle: config.MODEL_PROVIDER ?? 'desconocido', estado: 'info' });
    servidor.push({ id: 'voz', titulo: 'Voz y dictado', detalle: `voz ${config.VOICE_PROVIDER ?? 'none'} · dictado ${config.STT_PROVIDER ?? 'none'}`, estado: 'info' });

    const t0 = now();
    try {
      await conLimite(myraypa.listProjects());
      integraciones.push({ id: 'myraypa', titulo: 'MyRAYPA', detalle: `responde (${Math.max(0, now() - t0)} ms)`, estado: 'ok', chips: [{ texto: 'CONECTADO', estado: 'ok' }] });
    } catch (err) {
      integraciones.push({ id: 'myraypa', titulo: 'MyRAYPA', detalle: `no responde: ${corto(err.message, 100)}`, estado: 'error', chips: [{ texto: 'FALLO', estado: 'error' }] });
    }
    integraciones.push({ id: 'github', titulo: 'GitHub', detalle: `lectura ${agents ? 'configurada' : 'NO configurada'} · fusión ${agents?.canMerge ? 'configurada' : 'no configurada'}`, estado: agents ? 'ok' : 'aviso' });
    if (config.GOOGLE_MODE && config.GOOGLE_MODE !== 'off') {
      try {
        const sinLeer = await conLimite(google.unreadCount());
        integraciones.push({ id: 'google', titulo: 'Google', detalle: `${config.GOOGLE_MODE} · responde · ${sinLeer} sin leer · cuenta ${config.GOOGLE_OWNER_EMAIL}`, estado: 'ok' });
      } catch (err) {
        integraciones.push({ id: 'google', titulo: 'Google', detalle: `no responde: ${corto(err.message, 100)}`, estado: 'error' });
      }
    } else {
      integraciones.push({ id: 'google', titulo: 'Google', detalle: 'sin conectar (GOOGLE_MODE=off)', estado: 'info' });
    }

    const aprobadores = (config.MERGE_ALLOWED_USERS ?? []).length;
    seguridad.push({ id: 'seguridad', titulo: 'Acceso y aprobaciones', detalle: `token compartido ${config.ALLOW_LEGACY_TOKEN ? 'ACTIVADO' : 'desactivado'} · aprobadores ${aprobadores || 'cualquier dispositivo emparejado'} · host ${config.HOST}`, estado: config.ALLOW_LEGACY_TOKEN || !aprobadores ? 'aviso' : 'ok' });
    const desde = new Date(now() - DIA).toISOString();
    const fallos = (await audit.tail({ limit: 500, event: 'auth_failed', desde }).catch(() => [])).length;
    seguridad.push({ id: 'accesos', titulo: 'Accesos rechazados (24 h)', detalle: `${fallos}`, estado: fallos > 5 ? 'error' : fallos ? 'aviso' : 'ok' });
    const off = registry.list().filter((t) => registry.isDisabled(t.name)).length;
    seguridad.push({ id: 'desactivadas', titulo: 'Herramientas desactivadas', detalle: off ? `${off} apagadas desde Herramientas` : 'ninguna', estado: off ? 'aviso' : 'ok' });

    if (context) {
      const n = context.count(ownerKey(identity));
      datos.push({
        id: 'contexto',
        titulo: 'Contexto de conversaciones',
        detalle: `${n} ${n === 1 ? 'resumen guardado' : 'resúmenes guardados'} de sesiones anteriores`,
        estado: 'info',
        acciones: [{ id: 'olvidar_contexto', etiqueta: 'Olvidar contexto', peligro: true, confirmar: 'Se borran los resúmenes guardados y se vacían tus conversaciones abiertas. La siguiente conversación empieza de cero.' }],
      });
    }
    const rec = reminderStore?.list(ownerKey(identity)).length ?? 0;
    datos.push({ id: 'recordatorios', titulo: 'Recordatorios pendientes', detalle: `${rec}`, estado: 'info' });
    const notas = memory?.list().length ?? 0;
    datos.push({ id: 'notas', titulo: 'Notas permanentes', detalle: `${notas}`, estado: 'info' });

    const grupo = (titulo, filas) => ({ titulo, resumen: filas.some((f) => f.estado === 'error') ? 'hay algo que revisar' : filas.some((f) => f.estado === 'aviso') ? 'con avisos' : 'todo en orden', filas });
    const secciones = [grupo('Servidor', servidor), grupo('Integraciones', integraciones), grupo('Seguridad', seguridad), grupo('Datos de Praxon', datos)];
    const todas = secciones.flatMap((x) => x.filas);
    return { titulo: 'Estado', resumen: todas.some((f) => f.estado === 'error') ? 'Hay algo que revisar' : 'Todo en orden', secciones };
  }

  // ---------- Memoria ----------
  async function memoriaPanel({ identity }) {
    const dueno = ownerKey(identity);
    const secciones = [];
    const notas = memory?.list() ?? [];
    secciones.push({
      titulo: `Notas permanentes (${notas.length})`,
      filas: notas.map((n) => ({
        id: n.id,
        titulo: n.texto,
        detalle: [n.ambito === 'global' ? 'global' : `proyecto ${n.ambito}`, n.creada ? dia(n.creada) : null].filter(Boolean).join(' · '),
        estado: 'info',
        acciones: [{ id: 'borrar_nota', etiqueta: 'Borrar', peligro: true, confirmar: 'Praxon dejará de recordar esta nota.' }],
      })),
    });
    const recs = reminderStore?.list(dueno) ?? [];
    secciones.push({
      titulo: `Recordatorios pendientes (${recs.length})`,
      filas: recs.map((r) => ({
        id: r.id,
        titulo: r.texto,
        detalle: fecha(r.due) ?? '',
        estado: Date.parse(r.due) < now() ? 'error' : 'info',
        acciones: [{ id: 'cancelar_recordatorio', etiqueta: 'Cancelar', peligro: true, confirmar: 'Se cancela el recordatorio y no te avisará.' }],
      })),
    });
    const resumenes = context?.list?.(dueno) ?? [];
    const filasCtx = resumenes.map((r, i) => ({ id: `ctx${i}`, titulo: corto(r.resumen, 220), detalle: fecha(r.ts) ?? '', estado: 'info' }));
    if (resumenes.length) {
      filasCtx.unshift({
        id: 'olvidar_todo',
        titulo: 'Olvidar todos los resúmenes',
        detalle: 'La siguiente conversación empieza de cero.',
        estado: 'aviso',
        acciones: [{ id: 'olvidar_contexto', etiqueta: 'Olvidar', peligro: true, confirmar: 'Se borran los resúmenes guardados y se vacían tus conversaciones abiertas.' }],
      });
    }
    secciones.push({ titulo: `Resúmenes de conversaciones (${resumenes.length})`, filas: filasCtx });
    const total = notas.length + recs.length + resumenes.length;
    return { titulo: 'Memoria', resumen: `${notas.length} notas · ${recs.length} recordatorios · ${resumenes.length} resúmenes`, secciones, vacio: total ? undefined : 'Praxon no tiene nada guardado.' };
  }

  const PANELS = {
    hoy: { run: hoy, owner: false },
    audit: { run: auditoria, owner: true },
    devices: { run: dispositivos, owner: true },
    tools: { run: herramientas, owner: true },
    status: { run: estado, owner: true },
    memoria: { run: memoriaPanel, owner: true },
  };

  /** @returns {Promise<object>} el mensaje `panel` listo para enviar. Lanza PanelError con un texto para el usuario. */
  async function get({ panel, filtros }, identity) {
    const p = PANELS[panel];
    if (!p) throw new PanelError('Ese panel no existe.');
    if (p.owner && !isOwner(identity)) throw new PanelError('Tu usuario no tiene permiso para ver este panel.');
    return { type: 'panel', panel, ...(await p.run({ identity, filtros: filtros ?? {} })) };
  }

  // ---------- Acciones ----------
  /** @returns {Promise<{ok:boolean, mensaje:string}>} */
  async function action({ panel, accion, id, valor }, identity) {
    try {
      if (!isOwner(identity)) {
        await audit.record({ event: 'approval_denied', type: `panel_action:${panel}`, user: identity.user, deviceId: identity.deviceId }).catch(() => {});
        throw new PanelError('Tu usuario no tiene permiso para esta acción.');
      }
      if (panel === 'devices' && accion === 'revocar') {
        await myraypa.revokeMyDevice(String(id));
        await audit.record({ event: 'panel_action', panel, accion, user: identity.user, deviceId: identity.deviceId, target: String(id) });
        return { ok: true, mensaje: 'Dispositivo revocado.' };
      }
      if (panel === 'tools' && (accion === 'activar' || accion === 'desactivar')) {
        const tool = registry.get(String(id));
        if (!tool) throw new PanelError('Esa herramienta no existe.');
        await toolControl.set(tool.name, accion === 'activar');
        await audit.record({ event: 'panel_action', panel, accion, user: identity.user, deviceId: identity.deviceId, target: tool.name });
        return { ok: true, mensaje: accion === 'activar' ? 'Herramienta activada.' : 'Herramienta desactivada.' };
      }
      if (panel === 'status' && accion === 'olvidar_contexto' && context) {
        const dueno = ownerKey(identity);
        const n = await context.forget(dueno);
        await audit.record({ event: 'panel_action', panel, accion, user: identity.user, deviceId: identity.deviceId, target: `${n} resúmenes` });
        return { ok: true, mensaje: 'Contexto olvidado. Empieza una conversación nueva.' };
      }
      if (panel === 'memoria' && accion === 'borrar_nota' && memory) {
        await memory.remove(String(id));
        await audit.record({ event: 'panel_action', panel, accion, user: identity.user, deviceId: identity.deviceId, target: String(id) });
        return { ok: true, mensaje: 'Nota borrada.' };
      }
      if (panel === 'memoria' && accion === 'cancelar_recordatorio' && reminderStore) {
        await reminderStore.cancel(ownerKey(identity), String(id));
        await audit.record({ event: 'panel_action', panel, accion, user: identity.user, deviceId: identity.deviceId, target: String(id) });
        return { ok: true, mensaje: 'Recordatorio cancelado.' };
      }
      if (panel === 'memoria' && accion === 'olvidar_contexto' && context) {
        const n = await context.forget(ownerKey(identity));
        await audit.record({ event: 'panel_action', panel, accion, user: identity.user, deviceId: identity.deviceId, target: `${n} resúmenes` });
        return { ok: true, mensaje: 'Contexto olvidado. Empieza una conversación nueva.' };
      }
      throw new PanelError('Acción no válida.');
    } catch (err) {
      if (err instanceof PanelError) return { ok: false, mensaje: err.message };
      return { ok: false, mensaje: corto(err.message, 200) || 'No se ha podido hacer.' };
    }
  }

  return { get, action };
}
