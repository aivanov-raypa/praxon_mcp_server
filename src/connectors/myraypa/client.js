import { MyraypaError } from './errors.js';

/**
 * Cliente de la API HTTP de MyRAYPA. El asistente habla con MyRAYPA SOLO por esta API, con una credencial
 * propia de permisos acotados, nunca directamente con MongoDB. El filtro de proyectos habilitados y el
 * nivel de autonomia por proyecto los aplica la API, no el modelo.
 *
 * RUTAS: propuesta pendiente de validar con la API real (ver docs/myraypa-api.md). Estan todas aqui.
 */
export const ROUTES = {
  projects: () => '/assistant/projects',
  tickets: () => '/assistant/tickets',
  ticket: (id) => `/assistant/tickets/${id}`,
  comments: (id) => `/assistant/tickets/${id}/comments`,
  summary: (id) => `/assistant/projects/${id}/summary`,
  priorities: (id) => `/assistant/projects/${id}/priorities`,
  runs: () => '/assistant/agent-runs',
  cancelRun: (id) => `/assistant/agent-runs/${id}/cancel`,
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
    try {
      res = await this.#fetch(url, {
        method,
        headers: { Authorization: `Bearer ${this.#token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
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

  listProjects() {
    return this.#request('GET', ROUTES.projects());
  }
  listTickets({ proyectoId, estado, prioridad, asignado, texto, limit } = {}) {
    return this.#request('GET', ROUTES.tickets(), { query: { proyecto: proyectoId, estado, prioridad, asignado, texto, limit } });
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
  cancelAgentRun(runId, origin) {
    return this.#request('POST', ROUTES.cancelRun(runId), { body: { origin } });
  }
}
