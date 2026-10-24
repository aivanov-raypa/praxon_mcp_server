import { MyraypaError } from './errors.js';
import { currentUserEmail } from '../../identity.js';

/**
 * Cliente de la API HTTP de MyRAYPA. El asistente habla con MyRAYPA SOLO por esta API, con una credencial
 * propia de permisos acotados, nunca directamente con MongoDB. El filtro de proyectos habilitados y el
 * nivel de autonomia por proyecto los aplica la API, no el modelo.
 *
 * RUTAS: implementadas en raypa-platform (backend/routes/assistant.routes.js, montadas en /api/assistant).
 * Contrato completo en docs/myraypa-api.md. Estan todas aqui.
 */
export const ROUTES = {
  projects: () => '/assistant/projects',
  tickets: () => '/assistant/tickets',
  ticket: (id) => `/assistant/tickets/${id}`,
  comments: (id) => `/assistant/tickets/${id}/comments`,
  summary: (id) => `/assistant/projects/${id}/summary`,
  priorities: (id) => `/assistant/projects/${id}/priorities`,
  runs: () => '/assistant/agent-runs',
  runsList: () => '/assistant/agent-runs/lista',
  run: (id) => `/assistant/agent-runs/${id}`,
  cancelRun: (id) => `/assistant/agent-runs/${id}/cancel`,
  roadmaps: () => '/assistant/roadmaps',
  roadmap: (id) => `/assistant/roadmaps/${id}`,
  roadmapElements: (id) => `/assistant/roadmaps/${id}/elementos`,
  roadmapElement: (id, elementId) => `/assistant/roadmaps/${id}/elementos/${elementId}`,
  roadmapMilestones: (id) => `/assistant/roadmaps/${id}/hitos`,
  roadmapMilestone: (id, hitoId) => `/assistant/roadmaps/${id}/hitos/${hitoId}`,
  projectMilestones: (id) => `/assistant/projects/${id}/hitos`,
  projectMilestone: (id, hitoId) => `/assistant/projects/${id}/hitos/${hitoId}`,
  ticketFull: (id) => `/assistant/tickets/${id}/detalle`,
  ticketAttachments: (id) => `/assistant/tickets/${id}/adjuntos`,
  ticketAttachment: (id, ref) => `/assistant/tickets/${id}/adjuntos/${encodeURIComponent(ref)}`,
  ticketDates: (id) => `/assistant/tickets/${id}/fechas`,
  ticketHours: (id) => `/assistant/tickets/${id}/horas`,
  ticketLabels: (id) => `/assistant/tickets/${id}/etiquetas`,
  ticketChecklist: (id) => `/assistant/tickets/${id}/checklist`,
  ticketChecklistItem: (id, itemId) => `/assistant/tickets/${id}/checklist/${encodeURIComponent(itemId)}`,
  ticketFields: (id) => `/assistant/tickets/${id}/campos`,
  ticketSubtasks: (id) => `/assistant/tickets/${id}/subtareas`,
  ticketParticipants: (id) => `/assistant/tickets/${id}/participantes`,
  projectLabels: (id) => `/assistant/projects/${id}/etiquetas`,
  projectFields: (id) => `/assistant/projects/${id}/campos`,
  projectMembers: (id) => `/assistant/projects/${id}/miembros`,
  projectReport: (id) => `/assistant/projects/${id}/informe`,
  workload: () => '/assistant/informes/carga',
  hoursReport: () => '/assistant/informes/horas',
  deviceRedeem: () => '/assistant/devices/redeem',
  deviceVerify: () => '/assistant/devices/verify',
};

export class HttpMyraypaClient {
  #baseUrl;
  #token;
  #fetch;
  #timeoutMs;

  constructor({ baseUrl, token, fetchImpl = fetch, timeoutMs = 10_000 }) {
    this.#baseUrl = baseUrl.replace(/\/+$/, '');
    this.#token = token;
    this.#fetch = fetchImpl;
    this.#timeoutMs = timeoutMs;
  }

  async #request(method, path, { query, body } = {}) {
    const url = new URL(this.#baseUrl + path);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    let res;
    const actingAs = currentUserEmail();
    try {
      res = await this.#fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.#token}`,
          Accept: 'application/json',
          ...(actingAs ? { 'X-Assistant-User': actingAs } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      throw new MyraypaError(`No he podido conectar con MyRAYPA (${err.name === 'TimeoutError' ? 'tiempo agotado' : err.message}).`, 503);
    }
    if (!res.ok) {
      const detail = await res.json().then((j) => j?.message).catch(() => undefined);
      const base = { 400: 'Petición no válida', 401: 'Credencial del asistente no válida', 403: 'No permitido para el asistente en ese proyecto', 404: 'No encontrado' }[res.status] ?? `Error de MyRAYPA (${res.status})`;
      throw new MyraypaError(detail ? `${base}: ${detail}` : base, res.status);
    }
    return res.status === 204 ? null : res.json();
  }

  /** Canjea un código de emparejamiento: { token, deviceId, name }. Lanza MyraypaError (400/401) si no es válido. */
  redeemDevice(code, deviceName) {
    return this.#request('POST', ROUTES.deviceRedeem(), { body: { code, deviceName } });
  }
  /** Comprueba un token de dispositivo: { ok, email, username, deviceId } o { ok:false }. */
  verifyDevice(token) {
    return this.#request('POST', ROUTES.deviceVerify(), { body: { token } });
  }
  listProjects() {
    return this.#request('GET', ROUTES.projects());
  }
  listTickets({ proyectoId, estado, prioridad, asignado, texto, mostrar, limit, creadosDesde } = {}) {
    return this.#request('GET', ROUTES.tickets(), { query: { proyecto: proyectoId, estado, prioridad, asignado, texto, mostrar, limit, creadosDesde } });
  }
  getTicket(id) {
    return this.#request('GET', ROUTES.ticket(id));
  }
  projectSummary(proyectoId) {
    return this.#request('GET', ROUTES.summary(proyectoId));
  }
  createTicket(datos, origin) {
    return this.#request('POST', ROUTES.tickets(), { body: { ...datos, origin } });
  }
  updateTicket(id, cambios, origin) {
    return this.#request('PATCH', ROUTES.ticket(id), { body: { ...cambios, origin } });
  }
  commentTicket(id, texto, origin) {
    return this.#request('POST', ROUTES.comments(id), { body: { texto, origin } });
  }
  reorderPriorities(proyectoId, orden, origin) {
    return this.#request('PUT', ROUTES.priorities(proyectoId), { body: { orden, origin } });
  }
  createAgentRun({ ticketId, tipo }, origin) {
    return this.#request('POST', ROUTES.runs(), { body: { ticketId, tipo, origin } });
  }
  async getAgentRun({ runId, ticketId }) {
    const r = await this.#request('GET', ROUTES.runs(), { query: { runId, ticketId } });
    return r ?? null;
  }
  // ── Detalle ampliado, horas, etiquetas, checklist, campos, subtareas, participantes e informes ──
  getTicketFull(id) {
    return this.#request('GET', ROUTES.ticketFull(id));
  }
  listTicketAttachments(id) {
    return this.#request('GET', ROUTES.ticketAttachments(id));
  }
  readTicketAttachment(id, ref, desde) {
    return this.#request('GET', ROUTES.ticketAttachment(id, ref), { query: { desde } });
  }
  setTicketDates(id, cambios, origin) {
    return this.#request('PATCH', ROUTES.ticketDates(id), { body: { ...cambios, origin } });
  }
  logHours(id, datos, origin) {
    return this.#request('POST', ROUTES.ticketHours(id), { body: { ...datos, origin } });
  }
  changeLabels(id, cambios, origin) {
    return this.#request('PATCH', ROUTES.ticketLabels(id), { body: { ...cambios, origin } });
  }
  addChecklistItem(id, texto, origin) {
    return this.#request('POST', ROUTES.ticketChecklist(id), { body: { texto, origin } });
  }
  updateChecklistItem(id, itemId, cambios, origin) {
    return this.#request('PATCH', ROUTES.ticketChecklistItem(id, itemId), { body: { ...cambios, origin } });
  }
  setCustomField(id, datos, origin) {
    return this.#request('PUT', ROUTES.ticketFields(id), { body: { ...datos, origin } });
  }
  createSubtask(id, datos, origin) {
    return this.#request('POST', ROUTES.ticketSubtasks(id), { body: { ...datos, origin } });
  }
  changeParticipants(id, cambios, origin) {
    return this.#request('PATCH', ROUTES.ticketParticipants(id), { body: { ...cambios, origin } });
  }
  listLabels(proyectoId) {
    return this.#request('GET', ROUTES.projectLabels(proyectoId));
  }
  listCustomFields(proyectoId) {
    return this.#request('GET', ROUTES.projectFields(proyectoId));
  }
  listMembers(proyectoId) {
    return this.#request('GET', ROUTES.projectMembers(proyectoId));
  }
  projectReport(proyectoId, { desde, hasta } = {}) {
    return this.#request('GET', ROUTES.projectReport(proyectoId), { query: { desde, hasta } });
  }
  workload({ proyectoId } = {}) {
    return this.#request('GET', ROUTES.workload(), { query: { proyecto: proyectoId } });
  }
  hoursReport({ proyectoId, usuario, desde, hasta } = {}) {
    return this.#request('GET', ROUTES.hoursReport(), { query: { proyecto: proyectoId, usuario, desde, hasta } });
  }
  // ── Roadmaps e hitos ──
  listRoadmaps({ proyectoId, texto, limit } = {}) {
    return this.#request('GET', ROUTES.roadmaps(), { query: { proyecto: proyectoId, texto, limit } });
  }
  getRoadmap(id) {
    return this.#request('GET', ROUTES.roadmap(id));
  }
  addRoadmapElement(roadmapId, datos, origin) {
    return this.#request('POST', ROUTES.roadmapElements(roadmapId), { body: { ...datos, origin } });
  }
  updateRoadmapElement(roadmapId, elementId, cambios, origin) {
    return this.#request('PATCH', ROUTES.roadmapElement(roadmapId, elementId), { body: { ...cambios, origin } });
  }
  addRoadmapMilestone(roadmapId, datos, origin) {
    return this.#request('POST', ROUTES.roadmapMilestones(roadmapId), { body: { ...datos, origin } });
  }
  updateRoadmapMilestone(roadmapId, hitoId, cambios, origin) {
    return this.#request('PATCH', ROUTES.roadmapMilestone(roadmapId, hitoId), { body: { ...cambios, origin } });
  }
  listProjectMilestones(proyectoId) {
    return this.#request('GET', ROUTES.projectMilestones(proyectoId));
  }
  addProjectMilestone(proyectoId, datos, origin) {
    return this.#request('POST', ROUTES.projectMilestones(proyectoId), { body: { ...datos, origin } });
  }
  updateProjectMilestone(proyectoId, hitoId, cambios, origin) {
    return this.#request('PATCH', ROUTES.projectMilestone(proyectoId, hitoId), { body: { ...cambios, origin } });
  }
  /** Agentes abiertos (en cola, en curso, bloqueados o pendientes de revision) o los estados indicados. */
  async listAgentRuns({ estados, limit } = {}) {
    const r = await this.#request('GET', ROUTES.runsList(), { query: { estados: estados?.join(','), limit } });
    return Array.isArray(r) ? r : [];
  }
  /** Avance del agente: estado, rama, prUrl, githubRunId, pregunta. */
  patchAgentRun(runId, cambios) {
    return this.#request('PATCH', ROUTES.run(runId), { body: cambios });
  }
  cancelAgentRun(runId, origin) {
    return this.#request('POST', ROUTES.cancelRun(runId), { body: { origin } });
  }
}
