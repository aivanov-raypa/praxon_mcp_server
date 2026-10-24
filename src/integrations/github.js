/**
 * GitHub: solo el orquestador llama a GitHub, y solo para disparar (o cancelar) el workflow del agente.
 * El workflow corre en el runner autohospedado; el codigo generado por los agentes no se ejecuta aqui.
 * Token de grano fino con permiso unicamente de Actions (write) en los repositorios de los proyectos.
 */
export class GithubError extends Error {}

export class HttpGithub {
  #token;
  #workflowFile;
  #fetch;

  constructor({ token, workflowFile = 'praxon-agent.yml', fetchImpl = fetch }) {
    this.#token = token;
    this.#workflowFile = workflowFile;
    this.#fetch = fetchImpl;
  }

  async #post(path, body) {
    let res;
    try {
      res = await this.#fetch(`https://api.github.com${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.#token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      throw new GithubError(`No he podido conectar con GitHub (${err.message}).`);
    }
    if (!res.ok) throw new GithubError(`GitHub ha respondido ${res.status} al lanzar el agente.`);
  }

  /** Dispara el workflow con el ID del ticket y del AgentRun. GitHub responde 204 sin id de ejecucion. */
  dispatchAgentWorkflow({ repo, ref, ticketId, runId, tipo = 'mejora', titulo = '', descripcion = '', prBranch = '', feedback = '' }) {
    // El runner de GitHub no llega a MyRAYPA: los datos del ticket viajan en los inputs (recortados).
    return this.#post(`/repos/${repo}/actions/workflows/${encodeURIComponent(this.#workflowFile)}/dispatches`, {
      ref,
      inputs: {
        ticketId: String(ticketId),
        runId: String(runId),
        tipo: String(tipo),
        titulo: String(titulo).slice(0, 200),
        descripcion: String(descripcion).slice(0, 6000),
        baseBranch: String(ref),
        // Solo al pedir cambios sobre un PR existente (un workflow sin estos inputs rechazaría el lanzamiento con un 422).
        ...(prBranch ? { prBranch: String(prBranch), feedback: String(feedback).slice(0, 1500) } : {}),
      },
    });
  }

  cancelWorkflowRun({ repo, githubRunId }) {
    return this.#post(`/repos/${repo}/actions/runs/${githubRunId}/cancel`);
  }
}

/** No llama a GitHub: guarda las llamadas para poder comprobarlas. */
export class FakeGithub {
  dispatched = [];
  cancelled = [];
  failNext = false;

  async dispatchAgentWorkflow(args) {
    if (this.failNext) {
      this.failNext = false;
      throw new GithubError('GitHub simulado: fallo al lanzar el workflow.');
    }
    this.dispatched.push(args);
  }

  async cancelWorkflowRun(args) {
    this.cancelled.push(args);
  }
}
