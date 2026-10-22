/**
 * MyRAYPA simulado en memoria, con datos de ejemplo. Implementa la misma interfaz que HttpMyraypaClient
 * e imita las reglas de la API real (backend/services/assistant): solo se ven los proyectos habilitados,
 * cada proyecto limita lo que se puede hacer (autonomia: consulta < tickets < agentes), los estados son
 * las columnas del proyecto y las prioridades son ninguna/baja/media/alta (no existe "urgente").
 */
import { MyraypaError } from './errors.js';

const NIVEL = { consulta: 0, tickets: 1, agentes: 2 };
const PRIORIDADES = ['ninguna', 'baja', 'media', 'alta'];
const RANK = { alta: 3, media: 2, baja: 1, ninguna: 0 };
const ESTADOS = [
  { id: 'todo', titulo: 'Por hacer' },
  { id: 'in-progress', titulo: 'En progreso' },
  { id: 'done', titulo: 'Completado' },
];

const norm = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();

function parsePrioridad(valor) {
  const v = norm(valor);
  if (PRIORIDADES.includes(v)) return v;
  if (v === 'urgente') {
    throw new MyraypaError('La prioridad "urgente" no existe en los tickets de MyRAYPA. Las prioridades son: ninguna, baja, media y alta.', 400);
  }
  throw new MyraypaError(`Prioridad no válida. Las prioridades son: ${PRIORIDADES.join(', ')}.`, 400);
}

export class FakeMyraypa {
  constructor() {
    this.proyectos = [
      { id: 'calibraciones', nombre: 'Calibraciones', autonomia: 'agentes', repo: 'ejemplo/raypa-platform', ramaBase: 'main', estados: ESTADOS },
      { id: 'mes', nombre: 'MES', autonomia: 'tickets', repo: 'ejemplo/raypa-platform', ramaBase: 'main', estados: ESTADOS },
      { id: 'incidencias', nombre: 'Incidencias', autonomia: 'consulta', repo: null, ramaBase: 'main', estados: ESTADOS },
    ];
    const t = (id, proyectoId, titulo, estadoId, prioridad, asignado) => ({
      id, proyectoId, titulo, descripcion: `${titulo} (dato de ejemplo)`, estadoId, prioridad, completado: false, asignado, comentarios: [],
    });
    this.tickets = [
      t('214', 'calibraciones', 'Faltantes OF semana 43', 'todo', 'media', 'producción'),
      t('215', 'calibraciones', 'Exportar certificados a PDF', 'todo', 'baja', 'calidad'),
      t('216', 'calibraciones', 'Alarma del datalogger sin leer', 'in-progress', 'alta', 'mantenimiento'),
      t('301', 'mes', 'Categoría de trabajo duplicada en fábrica', 'todo', 'baja', 'fábrica'),
      t('401', 'incidencias', 'Escalar a Problem Solving desde incidencia', 'todo', 'media', 'calidad'),
    ];
    this.runs = [];
    this.historial = []; // cambios con su origen, para comprobarlos en tests
    this.#nextTicket = 500;
    this.#nextRun = 1;
  }

  #nextTicket;
  #nextRun;

  #proyecto(id) {
    const p = this.proyectos.find((x) => x.id === id);
    if (!p) throw new MyraypaError('Ese proyecto no existe o no está habilitado para el asistente.', 404);
    return p;
  }

  #requiere(proyecto, nivel) {
    if (NIVEL[proyecto.autonomia] < NIVEL[nivel]) {
      throw new MyraypaError(`El proyecto ${proyecto.nombre} no permite esa operación al asistente (autonomía: ${proyecto.autonomia}).`, 403);
    }
  }

  #ticket(id) {
    const tk = this.tickets.find((x) => x.id === String(id));
    if (!tk) throw new MyraypaError('Ticket no encontrado.', 404);
    return tk;
  }

  #estado(proyecto, valor) {
    const v = norm(valor);
    const e = proyecto.estados.find((x) => norm(x.id) === v || norm(x.titulo) === v);
    if (!e) throw new MyraypaError(`El estado "${valor}" no existe en el proyecto ${proyecto.nombre}. Estados: ${proyecto.estados.map((x) => x.titulo).join(', ')}.`, 400);
    return e;
  }

  #vista(tk) {
    const p = this.#proyecto(tk.proyectoId);
    return {
      id: tk.id,
      titulo: tk.titulo,
      estado: p.estados.find((e) => e.id === tk.estadoId)?.titulo ?? tk.estadoId,
      estadoId: tk.estadoId,
      prioridad: tk.prioridad,
      completado: tk.completado,
      asignado: tk.asignado || null,
      proyecto: p.nombre,
      proyectoId: p.id,
      vencimiento: null,
    };
  }

  async listProjects() {
    return this.proyectos.map(({ id, nombre, autonomia, repo, ramaBase, estados }) => ({ id, nombre, autonomia, repo, ramaBase, estados }));
  }

  async listTickets({ proyectoId, estado, prioridad, asignado, texto, mostrar = 'abiertos', limit = 5 } = {}) {
    if (proyectoId) this.#proyecto(proyectoId);
    if (!['abiertos', 'completados', 'todos'].includes(mostrar)) throw new MyraypaError('mostrar debe ser abiertos, completados o todos.', 400);
    const prio = prioridad ? parsePrioridad(prioridad) : null;
    const palabras = norm(texto).split(/\s+/).filter(Boolean);
    const found = this.tickets
      .filter((tk) => !proyectoId || tk.proyectoId === proyectoId)
      .filter((tk) => mostrar === 'todos' || tk.completado === (mostrar === 'completados'))
      .filter((tk) => !estado || tk.estadoId === this.#estado(this.#proyecto(tk.proyectoId), estado).id)
      .filter((tk) => !prio || tk.prioridad === prio)
      .filter((tk) => !asignado || norm(tk.asignado).includes(norm(asignado)))
      .filter((tk) => palabras.every((w) => norm(`${tk.titulo} ${tk.descripcion}`).split(/\W+/).includes(w)))
      .sort((a, b) => RANK[b.prioridad] - RANK[a.prioridad] || Number(a.id) - Number(b.id));
    return { total: found.length, tickets: found.slice(0, limit).map((tk) => this.#vista(tk)) };
  }

  async getTicket(id) {
    const tk = this.#ticket(id);
    const p = this.#proyecto(tk.proyectoId);
    return {
      ...this.#vista(tk),
      descripcion: tk.descripcion,
      proyecto: { id: p.id, nombre: p.nombre, autonomia: p.autonomia, repo: p.repo, ramaBase: p.ramaBase },
      comentarios: tk.comentarios.slice(-5).map((c) => ({ autor: 'Asistente de voz', fecha: null, texto: c.texto })),
    };
  }

  async projectSummary(proyectoId) {
    const p = this.#proyecto(proyectoId);
    const todos = this.tickets.filter((tk) => tk.proyectoId === p.id);
    const abiertos = todos.filter((tk) => !tk.completado);
    const porEstado = Object.fromEntries(p.estados.map((e) => [e.titulo, abiertos.filter((tk) => tk.estadoId === e.id).length]));
    const porPrioridad = Object.fromEntries(PRIORIDADES.map((pr) => [pr, abiertos.filter((tk) => tk.prioridad === pr).length]));
    return {
      proyecto: p.nombre,
      abiertos: abiertos.length,
      completados: todos.length - abiertos.length,
      porEstado,
      porPrioridad,
      prioritarios: abiertos.filter((tk) => tk.prioridad === 'alta').map((tk) => this.#vista(tk)),
    };
  }

  async createTicket({ proyectoId, titulo, descripcion = '', prioridad = 'media', asignado = '' }, origin) {
    const p = this.#proyecto(proyectoId);
    this.#requiere(p, 'tickets');
    const tk = { id: String(this.#nextTicket++), proyectoId, titulo, descripcion, estadoId: p.estados[0].id, prioridad: parsePrioridad(prioridad), completado: false, asignado, comentarios: [] };
    this.tickets.push(tk);
    this.historial.push({ ticketId: tk.id, accion: 'crear', origin });
    return this.#vista(tk);
  }

  async updateTicket(id, cambios, origin) {
    const tk = this.#ticket(id);
    const p = this.#proyecto(tk.proyectoId);
    this.#requiere(p, 'tickets');
    const aplicados = {};
    const set = (campo, clave, valor) => {
      if (tk[clave] !== valor) {
        aplicados[campo] = { de: tk[clave], a: valor };
        tk[clave] = valor;
      }
    };
    if (cambios.estado !== undefined) set('estado', 'estadoId', this.#estado(p, cambios.estado).id);
    if (cambios.prioridad !== undefined) set('prioridad', 'prioridad', parsePrioridad(cambios.prioridad));
    if (cambios.asignado !== undefined) set('asignado', 'asignado', cambios.asignado);
    if (cambios.completado !== undefined) set('completado', 'completado', cambios.completado);
    if (!Object.keys(aplicados).length) throw new MyraypaError('El ticket ya tiene esos valores; no hay nada que cambiar.', 409);
    this.historial.push({ ticketId: tk.id, accion: 'actualizar', cambios: aplicados, origin });
    return this.#vista(tk);
  }

  async commentTicket(id, texto, origin) {
    const tk = this.#ticket(id);
    this.#requiere(this.#proyecto(tk.proyectoId), 'tickets');
    tk.comentarios.push({ texto, origin });
    this.historial.push({ ticketId: tk.id, accion: 'comentar', origin });
    return { ok: true, ticketId: tk.id };
  }

  async reorderPriorities(proyectoId, orden, origin) {
    const p = this.#proyecto(proyectoId);
    this.#requiere(p, 'tickets');
    orden.forEach((id) => {
      if (this.#ticket(id).proyectoId !== proyectoId) throw new MyraypaError('Algún ticket no existe o no pertenece a ese proyecto.', 400);
    });
    p.orden = [...orden];
    this.historial.push({ proyectoId, accion: 'reordenar', orden, origin });
    return { ok: true, proyecto: p.nombre, reordenados: orden.length };
  }

  async createAgentRun({ ticketId, tipo }, origin) {
    const tk = this.#ticket(ticketId);
    const p = this.#proyecto(tk.proyectoId);
    this.#requiere(p, 'agentes');
    if (!p.repo) throw new MyraypaError(`El proyecto ${p.nombre} no tiene repositorio asociado.`, 400);
    if (this.runs.some((r) => r.ticketId === tk.id && ['en_cola', 'en_curso'].includes(r.estado))) {
      throw new MyraypaError('Ese ticket ya tiene un agente en marcha.', 409);
    }
    const run = { runId: `run-${this.#nextRun++}`, ticketId: tk.id, tipo, estado: 'en_cola', repo: p.repo, ramaBase: p.ramaBase, rama: null, pullRequest: null, githubRunId: null, bloqueo: null };
    this.runs.push(run);
    this.historial.push({ ticketId: tk.id, accion: 'lanzar_agente', runId: run.runId, origin });
    return { ...run };
  }

  async getAgentRun({ runId, ticketId }) {
    const run = runId
      ? this.runs.find((r) => r.runId === runId)
      : [...this.runs].reverse().find((r) => r.ticketId === String(ticketId));
    return run ? { ...run } : null;
  }

  async cancelAgentRun(runId, origin) {
    const run = this.runs.find((r) => r.runId === runId);
    if (!run) throw new MyraypaError('Agente no encontrado.', 404);
    if (!['en_cola', 'en_curso', 'bloqueado'].includes(run.estado)) throw new MyraypaError(`El agente ya está ${run.estado.replace('_', ' ')}; no se puede cancelar.`, 409);
    run.estado = 'cancelado';
    this.historial.push({ ticketId: run.ticketId, accion: 'cancelar_agente', runId, origin });
    return { ...run };
  }
}
