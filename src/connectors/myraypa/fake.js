/**
 * MyRAYPA simulado en memoria, con datos de ejemplo. Implementa la misma interfaz que HttpMyraypaClient
 * e imita las reglas de la API real: solo se ven los proyectos habilitados y cada proyecto limita
 * lo que se puede hacer (autonomia: consulta < tickets < agentes).
 */
import { MyraypaError } from './errors.js';

const NIVEL = { consulta: 0, tickets: 1, agentes: 2 };
const PRIORIDAD_ORDEN = { urgente: 0, alta: 1, media: 2, baja: 3 };

const norm = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

export class FakeMyraypa {
  constructor() {
    this.proyectos = [
      { id: 'calibraciones', nombre: 'Calibraciones', autonomia: 'agentes', repo: 'ejemplo/raypa-platform', ramaBase: 'main' },
      { id: 'mes', nombre: 'MES', autonomia: 'tickets', repo: 'ejemplo/raypa-platform', ramaBase: 'main' },
      { id: 'incidencias', nombre: 'Incidencias', autonomia: 'consulta', repo: null, ramaBase: 'main' },
    ];
    const t = (id, proyectoId, titulo, estado, prioridad, asignado) => ({
      id, proyectoId, titulo, descripcion: `${titulo} (dato de ejemplo)`, estado, prioridad, asignado, comentarios: [],
    });
    this.tickets = [
      t(214, 'calibraciones', 'Faltantes OF semana 43', 'abierto', 'alta', 'producción'),
      t(215, 'calibraciones', 'Exportar certificados a PDF', 'abierto', 'media', 'calidad'),
      t(216, 'calibraciones', 'Alarma del datalogger sin leer', 'en_curso', 'urgente', 'mantenimiento'),
      t(301, 'mes', 'Categoría de trabajo duplicada en fábrica', 'abierto', 'baja', 'fábrica'),
      t(401, 'incidencias', 'Escalar a Problem Solving desde incidencia', 'abierto', 'media', 'calidad'),
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
    const tk = this.tickets.find((x) => x.id === id);
    if (!tk) throw new MyraypaError(`No existe el ticket ${id}.`, 404);
    return tk;
  }

  #vista(tk) {
    const { comentarios, descripcion, ...resto } = tk;
    return resto;
  }

  async listProjects() {
    return this.proyectos.map(({ id, nombre, autonomia, repo }) => ({ id, nombre, autonomia, repo }));
  }

  async listTickets({ proyectoId, estado, prioridad, asignado, texto, limit = 5 } = {}) {
    if (proyectoId) this.#proyecto(proyectoId);
    const palabras = norm(texto).split(/\s+/).filter(Boolean);
    const found = this.tickets
      .filter((tk) => !proyectoId || tk.proyectoId === proyectoId)
      .filter((tk) => !estado || tk.estado === estado)
      .filter((tk) => !prioridad || tk.prioridad === prioridad)
      .filter((tk) => !asignado || norm(tk.asignado).includes(norm(asignado)))
      .filter((tk) => palabras.every((w) => norm(`${tk.titulo} ${tk.descripcion}`).split(/\W+/).includes(w)))
      .sort((a, b) => PRIORIDAD_ORDEN[a.prioridad] - PRIORIDAD_ORDEN[b.prioridad] || a.id - b.id);
    return { total: found.length, tickets: found.slice(0, limit).map((tk) => this.#vista(tk)) };
  }

  async getTicket(id) {
    const tk = this.#ticket(id);
    const proyecto = this.#proyecto(tk.proyectoId);
    return { ...tk, comentarios: tk.comentarios.slice(-5), proyecto: { id: proyecto.id, nombre: proyecto.nombre, autonomia: proyecto.autonomia, repo: proyecto.repo, ramaBase: proyecto.ramaBase } };
  }

  async projectSummary(proyectoId) {
    const p = this.#proyecto(proyectoId);
    const lista = this.tickets.filter((tk) => tk.proyectoId === p.id);
    const por = (campo) => lista.reduce((acc, tk) => ({ ...acc, [tk[campo]]: (acc[tk[campo]] ?? 0) + 1 }), {});
    return {
      proyecto: p.nombre,
      total: lista.length,
      porEstado: por('estado'),
      porPrioridad: por('prioridad'),
      urgentes: lista.filter((tk) => tk.prioridad === 'urgente' && tk.estado !== 'cerrado').map((tk) => ({ id: tk.id, titulo: tk.titulo })),
    };
  }

  async createTicket({ proyectoId, titulo, descripcion = '', prioridad = 'media', asignado = '' }, origin) {
    this.#requiere(this.#proyecto(proyectoId), 'tickets');
    const tk = { id: this.#nextTicket++, proyectoId, titulo, descripcion, estado: 'abierto', prioridad, asignado, comentarios: [] };
    this.tickets.push(tk);
    this.historial.push({ ticketId: tk.id, accion: 'crear', origin });
    return this.#vista(tk);
  }

  async updateTicket(id, cambios, origin) {
    const tk = this.#ticket(id);
    this.#requiere(this.#proyecto(tk.proyectoId), 'tickets');
    const aplicados = {};
    for (const [campo, valor] of Object.entries(cambios)) {
      if (valor !== undefined && tk[campo] !== valor) {
        aplicados[campo] = { de: tk[campo], a: valor };
        tk[campo] = valor;
      }
    }
    this.historial.push({ ticketId: id, accion: 'actualizar', cambios: aplicados, origin });
    return { ticketId: id, titulo: tk.titulo, cambios: aplicados };
  }

  async commentTicket(id, texto, origin) {
    const tk = this.#ticket(id);
    this.#requiere(this.#proyecto(tk.proyectoId), 'tickets');
    tk.comentarios.push({ texto, origin });
    this.historial.push({ ticketId: id, accion: 'comentar', origin });
    return { ticketId: id, comentarios: tk.comentarios.length };
  }

  async reorderPriorities(proyectoId, orden, origin) {
    this.#requiere(this.#proyecto(proyectoId), 'tickets');
    const niveles = ['urgente', 'alta', 'media', 'baja'];
    orden.forEach((id, i) => {
      const tk = this.#ticket(id);
      if (tk.proyectoId !== proyectoId) throw new MyraypaError(`El ticket ${id} no pertenece a ese proyecto.`, 400);
      tk.prioridad = niveles[Math.min(niveles.length - 1, Math.floor((i * niveles.length) / orden.length))];
    });
    this.historial.push({ proyectoId, accion: 'reordenar', orden, origin });
    return { proyectoId, reordenados: orden.length };
  }

  async createAgentRun({ ticketId, tipo }, origin) {
    const tk = this.#ticket(ticketId);
    const p = this.#proyecto(tk.proyectoId);
    this.#requiere(p, 'agentes');
    if (!p.repo) throw new MyraypaError(`El proyecto ${p.nombre} no tiene repositorio asociado.`, 400);
    const run = { runId: `run-${this.#nextRun++}`, ticketId, tipo, estado: 'en_cola', repo: p.repo, ramaBase: p.ramaBase, githubRunId: null };
    this.runs.push(run);
    this.historial.push({ ticketId, accion: 'lanzar_agente', runId: run.runId, origin });
    return { ...run };
  }

  async getAgentRun({ runId, ticketId }) {
    const run = runId
      ? this.runs.find((r) => r.runId === runId)
      : [...this.runs].reverse().find((r) => r.ticketId === ticketId);
    return run ? { ...run } : null;
  }

  async cancelAgentRun(runId, origin) {
    const run = this.runs.find((r) => r.runId === runId);
    if (!run) throw new MyraypaError(`No existe el agente ${runId}.`, 404);
    run.estado = 'cancelado';
    this.historial.push({ ticketId: run.ticketId, accion: 'cancelar_agente', runId, origin });
    return { ...run };
  }
}
