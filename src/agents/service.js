/**
 * Ciclo de vida de los agentes de desarrollo, visto desde Praxon.
 * - tick(): sondea GitHub (ejecucion del workflow, pull request) y refleja el avance en el AgentRun de MyRAYPA.
 *   Se sondea porque MyRAYPA y Praxon estan en la red interna y el workflow no puede avisar.
 * - list()/diff(): lo que ve la app en la pantalla Agentes (siempre en vivo desde GitHub).
 * - merge(): fusion del PR atada al SHA revisado y a que el usuario teclee el numero del PR. Solo se llama desde la app
 *   (mensaje agent_merge): no es una herramienta del modelo, asi que no puede hacerse por voz ni por conversacion.
 */
export const branchOf = (run) => `praxon/ticket-${run.ticketId}-${run.runId}`;

const ABIERTOS = ['en_cola', 'en_curso', 'bloqueado', 'pendiente_revision'];
const HISTORICOS = ['completado', 'fallido'];
/** Resumen del agente sin las líneas que añade el workflow, en una sola línea y recortado en un límite de frase. */
export function breveResumen(texto, max = 260) {
  const limpio = String(texto ?? '')
    .split('\n')
    .filter((l) => !/^(Ticket MyRAYPA:|Run de Praxon:|Generado por el agente de Praxon)/.test(l))
    .join(' ')
    .replace(/[#*`>_]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (limpio.length <= max) return limpio;
  const corte = limpio.slice(0, max);
  const punto = corte.lastIndexOf('. ');
  return punto > max * 0.5 ? corte.slice(0, punto + 1) : `${corte.slice(0, corte.lastIndexOf(' ') > 0 ? corte.lastIndexOf(' ') : max)}…`;
}

const prNumero = (url) => Number(/\/pull\/(\d+)/.exec(url ?? '')?.[1]) || null;

export class AgentError extends Error {}

export class AgentService {
  #myraypa;
  #reader;
  #merger;
  #audit;
  #config;
  #now;
  #timer = null;
  #busy = false;
  #onChange;

  constructor({ myraypa, reader, merger = null, audit, config, now = Date.now, onChange = () => {} }) {
    this.#myraypa = myraypa;
    this.#reader = reader;
    this.#merger = merger;
    this.#audit = audit;
    this.#config = config;
    this.#now = now;
    this.#onChange = onChange;
  }

  get canMerge() {
    return Boolean(this.#merger);
  }

  async #patch(run, cambios) {
    try {
      await this.#myraypa.patchAgentRun(run.runId, cambios);
      Object.assign(run, { estado: cambios.estado ?? run.estado });
      return true;
    } catch (err) {
      console.error('[agentes]', `no se ha podido actualizar ${run.runId}:`, err.message);
      return false;
    }
  }

  /** Una pasada de seguimiento. Devuelve cuantos agentes han cambiado de estado. */
  async tick() {
    if (this.#busy) return { omitido: true };
    this.#busy = true;
    let cambios = 0;
    try {
      const runs = (await this.#myraypa.listAgentRuns({ estados: ABIERTOS })).filter((r) => r.repo);
      const porRepo = new Map();
      for (const run of runs) {
        try {
          if (!porRepo.has(run.repo)) {
            porRepo.set(run.repo, await this.#reader.listWorkflowRuns({ repo: run.repo, workflowFile: this.#config.GITHUB_WORKFLOW_FILE }));
          }
          if (await this.#sync(run, porRepo.get(run.repo))) cambios++;
        } catch (err) {
          console.error('[agentes]', `${run.runId}:`, err.message);
        }
      }
      if (cambios) this.#onChange();
      return { revisados: runs.length, cambios };
    } finally {
      this.#busy = false;
    }
  }

  async #sync(run, workflowRuns) {
    const branch = branchOf(run);
    const wf = workflowRuns.find((w) => new RegExp(`\\brun=${run.runId}$`).test(w.titulo));
    const base = { ...(wf && String(run.githubRunId) !== wf.id ? { githubRunId: wf.id } : {}) };
    const pr = wf || run.estado === 'pendiente_revision' ? await this.#reader.findPull({ repo: run.repo, branch }) : null;

    if (pr) {
      if (pr.estado === 'fusionado') return this.#patch(run, { ...base, estado: 'completado', rama: branch, prUrl: pr.url });
      if (pr.estado === 'cerrado') return this.#patch(run, { ...base, estado: 'fallido', rama: branch, prUrl: pr.url, pregunta: 'El pull request se cerró sin fusionar.' });
      if (run.estado !== 'pendiente_revision' || base.githubRunId) {
        return this.#patch(run, { ...base, estado: 'pendiente_revision', rama: branch, prUrl: pr.url, pregunta: null });
      }
      return false;
    }
    if (!wf) {
      const age = this.#now() - Date.parse(run.creado ?? 0);
      if (run.estado === 'en_cola' && age > this.#config.AGENTS_QUEUE_TIMEOUT_MINUTES * 60_000) {
        return this.#patch(run, { estado: 'fallido', pregunta: 'GitHub no ha iniciado el agente. Revisa que el workflow exista en el repositorio y que Actions esté activado.' });
      }
      return false;
    }
    if (wf.estado !== 'completed') {
      if (run.estado !== 'en_curso') return this.#patch(run, { ...base, estado: 'en_curso' });
      return base.githubRunId ? this.#patch(run, base) : false;
    }
    if (run.estado === 'bloqueado') return false;
    if (wf.resultado === 'success') {
      return this.#patch(run, { ...base, estado: 'bloqueado', pregunta: `El agente ha terminado sin pull request: necesita más información. Detalle en ${wf.url}` });
    }
    return this.#patch(run, { ...base, estado: 'fallido', pregunta: `El agente ha terminado con error (${wf.resultado ?? 'desconocido'}). Detalle en ${wf.url}` });
  }

  async #titulo(ticketId) {
    try {
      return (await this.#myraypa.getTicket(ticketId)).titulo;
    } catch {
      return null;
    }
  }

  async #checks(run, pr) {
    try {
      return await this.#reader.checksFor({ repo: run.repo, sha: pr.sha });
    } catch {
      return null;
    }
  }

  /** Agentes abiertos con su pull request y checks en vivo. */
  async list() {
    const runs = await this.#myraypa.listAgentRuns({ estados: ABIERTOS });
    return Promise.all(
      runs.map(async (run) => {
        const out = { runId: run.runId, ticketId: run.ticketId, tipo: run.tipo, estado: run.estado, repo: run.repo, bloqueo: run.bloqueo ?? null };
        out.ticket = await this.#titulo(run.ticketId);
        if (run.estado === 'pendiente_revision') {
          const pr = await this.#reader.findPull({ repo: run.repo, branch: branchOf(run) }).catch(() => null);
          if (pr) {
            const checks = await this.#checks(run, pr);
            Object.assign(out, { pr, checks, ...this.#fusionable(pr, checks) });
          }
        }
        return out;
      }),
    );
  }

  #fusionable(pr, checks) {
    let motivo = null;
    if (!this.#merger) motivo = 'La fusión no está configurada en el servidor.';
    else if (pr.estado !== 'abierto') motivo = 'El pull request ya no está abierto.';
    else if (pr.mergeable === false) motivo = 'El pull request tiene conflictos con la rama base.';
    else if (!checks) motivo = 'No he podido comprobar los checks.';
    else if (checks.fallando > 0) motivo = 'Hay checks fallando.';
    else if (checks.pendientes > 0) motivo = 'Hay checks en curso.';
    return { fusionable: motivo === null, motivo, sinChecks: checks?.total === 0 };
  }

  async #runAndPr(runId, { historico = false } = {}) {
    const run = await this.#myraypa.getAgentRun({ runId });
    if (!run) throw new AgentError('No existe ese agente.');
    if (!historico && run.estado !== 'pendiente_revision') throw new AgentError('Ese agente no tiene un pull request pendiente de revisión.');
    if (historico && ![...HISTORICOS, 'pendiente_revision'].includes(run.estado)) throw new AgentError('Ese agente aún no ha terminado.');
    const pr = await this.#reader.findPull({ repo: run.repo, branch: branchOf(run) });
    if (!pr) throw new AgentError('No encuentro el pull request de ese agente.');
    return { run, pr };
  }

  async diff(runId) {
    const { run, pr } = await this.#runAndPr(runId, { historico: true });
    const archivos = await this.#reader.pullFiles({ repo: run.repo, number: pr.numero });
    return { runId, pr, archivos, estado: run.estado };
  }

  /** Historial: agentes terminados (fusionados o fallidos), del más reciente al más antiguo. Solo datos de MyRAYPA; el PR se consulta en el detalle. */
  async history({ limit = 30 } = {}) {
    const n = Math.min(Math.max(Number(limit) || 30, 1), 100);
    const runs = await this.#myraypa.listAgentRuns({ estados: HISTORICOS, limit: n });
    return Promise.all(
      runs.slice(0, n).map(async (run) => ({
        runId: run.runId,
        ticketId: run.ticketId,
        ticket: await this.#titulo(run.ticketId),
        tipo: run.tipo,
        estado: run.estado,
        repo: run.repo,
        motivo: run.estado === 'fallido' ? (run.bloqueo ?? null) : null,
        prNumero: prNumero(run.pullRequest),
        prUrl: run.pullRequest ?? null,
        creado: run.creado ?? null,
        actualizado: run.actualizado ?? null,
      })),
    );
  }

  /** Fusiona. `sha` es el que la app mostro al usuario y `numero` el numero de PR que el usuario ha tecleado. */
  async merge({ runId, sha, numero, user }) {
    const evento = { event: 'agent_merge', user, runId };
    try {
      const { run, pr } = await this.#runAndPr(runId);
      Object.assign(evento, { repo: run.repo, pr: pr.numero, sha });
      if (numero !== pr.numero) throw new AgentError('El número del pull request no coincide.');
      if (pr.sha !== sha) throw new AgentError('La rama ha cambiado desde que la revisaste. Vuelve a abrir el diff.');
      const checks = await this.#checks(run, pr);
      const f = this.#fusionable(pr, checks);
      if (!f.fusionable) throw new AgentError(f.motivo);
      await this.#merger.mergePull({ repo: run.repo, number: pr.numero, sha: pr.sha, titulo: pr.titulo });
      await this.#patch(run, { estado: 'completado' });
      // Dejar constancia en el ticket. La confirmación de la fusión ya cubre este comentario; si falla, la fusión sigue siendo válida.
      const comentado = await this.#comentar(run, pr, user);
      await this.#audit.record({ ...evento, ok: true, comentado });
      this.#onChange();
      return { ok: true, pr: pr.numero, comentado };
    } catch (err) {
      await this.#audit.record({ ...evento, ok: false, error: err.message });
      return { ok: false, error: err.message };
    }
  }

  /** Comentario breve en el ticket tras fusionar: qué se ha cambiado y en qué PR. */
  async #comentar(run, pr, user) {
    const cambios = `${pr.archivos} archivo${pr.archivos === 1 ? '' : 's'}, +${pr.adiciones} −${pr.borrados}`;
    const cabecera = `Cambio fusionado por el agente de desarrollo (PR #${pr.numero}, ${cambios}): ${pr.titulo}.`;
    const detalle = breveResumen(pr.resumen);
    const texto = (detalle ? `${cabecera} ${detalle}` : cabecera).slice(0, 480);
    try {
      await this.#myraypa.commentTicket(run.ticketId, texto, { type: 'voice-assistant', user, sessionId: `fusion-${run.runId}` });
      return true;
    } catch (err) {
      console.error('[agentes]', `no se ha podido comentar el ticket ${run.ticketId}:`, err.message);
      return false;
    }
  }

  start() {
    if (this.#timer) return;
    const run = () => this.tick().catch((err) => console.error('[agentes]', err.message));
    this.#timer = setInterval(run, this.#config.AGENTS_WATCH_SECONDS * 1000);
    this.#timer.unref();
  }

  stop() {
    clearInterval(this.#timer);
    this.#timer = null;
  }
}
