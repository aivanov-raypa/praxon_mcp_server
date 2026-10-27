/**
 * Ciclo de vida de los agentes de desarrollo, visto desde Praxon.
 * - tick(): sondea GitHub (ejecucion del workflow, pull request) y refleja el avance en el AgentRun de MyRAYPA.
 *   Se sondea porque MyRAYPA y Praxon estan en la red interna y el workflow no puede avisar.
 * - list()/diff(): lo que ve la app en la pantalla Agentes (siempre en vivo desde GitHub).
 * - merge(): fusion del PR atada al SHA revisado y a que el usuario teclee el numero del PR. Solo se llama desde la app
 *   (mensaje agent_merge): no es una herramienta del modelo, asi que no puede hacerse por voz ni por conversacion.
 */
import { baseNoPermitida } from '../integrations/github-merge.js';

/** Columna de "completado" de un proyecto: la de id done o la que se llame completado/finalizado/hecho/terminado. */
const COLUMNA_FINAL = /complet|finaliz|hecho|terminad|done/i;

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

/** Marca en `pregunta` de una ejecución que se está iterando sobre un PR existente; guarda el id del workflow anterior. */
const ITERANDO = 'Aplicando los cambios pedidos';
const marcaIteracion = (anterior) => `${ITERANDO} [tras ejecución ${anterior ?? 'ninguna'}]`;
const iteracionDe = (run) => {
  const m = new RegExp(`^${ITERANDO} \\[tras ejecución (\\S+)\\]`).exec(run.bloqueo ?? '');
  return m ? { anterior: m[1] === 'ninguna' ? null : m[1] } : null;
};

const prNumero = (url) => Number(/\/pull\/(\d+)/.exec(url ?? '')?.[1]) || null;

export class AgentError extends Error {}

export class AgentService {
  #myraypa;
  #reader;
  #merger;
  #dispatcher;
  #audit;
  #config;
  #now;
  #timer = null;
  #busy = false;
  #onChange;

  #pause;

  constructor({ myraypa, reader, merger = null, dispatcher = null, audit, config, now = Date.now, onChange = () => {}, pause = null }) {
    this.#pause = pause;
    this.#dispatcher = dispatcher;
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

  get canRequestChanges() {
    return Boolean(this.#dispatcher);
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


  /**
   * El pull request se ha fusionado (desde la app o directamente en GitHub): el ticket pasa a la columna de completados y se
   * marca como finalizado. Si el proyecto no tiene una columna reconocible, solo se marca como finalizado. Un fallo aquí no
   * deshace la fusión: queda en el registro de auditoría.
   */
  async #completarTicket(run, user) {
    const evento = { event: 'agent_ticket_completado', user, runId: run.runId, ticketId: run.ticketId };
    try {
      const tk = await this.#myraypa.getTicket(run.ticketId);
      const proyectos = await this.#myraypa.listProjects();
      const estados = proyectos.find((p) => String(p.id) === String(tk.proyectoId))?.estados ?? [];
      const final = estados.find((e) => e.id === 'done') ?? estados.find((e) => COLUMNA_FINAL.test(e.titulo ?? '') || COLUMNA_FINAL.test(e.id ?? ''));
      const cambios = {};
      if (final && tk.estadoId !== final.id) cambios.estado = final.id;
      if (tk.completado !== true) cambios.completado = true;
      if (Object.keys(cambios).length) {
        await this.#myraypa.updateTicket(run.ticketId, cambios, { type: 'voice-assistant', user, sessionId: `fusion-${run.runId}` });
      }
      await this.#audit.record({ ...evento, ok: true, estado: final?.titulo ?? null, cambios: Object.keys(cambios) });
      return true;
    } catch (err) {
      console.error('[agentes]', `no se ha podido completar el ticket ${run.ticketId}:`, err.message);
      await this.#audit.record({ ...evento, ok: false, error: err.message }).catch(() => {});
      return false;
    }
  }

  /** Una pasada de seguimiento. Devuelve cuantos agentes han cambiado de estado. */
  async tick() {
    // En pausa no se escribe nada en MyRAYPA: al reanudar, el siguiente sondeo se pone al día con GitHub.
    if (this.#busy || this.#pause?.active) return { omitido: true };
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

    const it = pr?.estado === 'abierto' && run.estado === 'en_curso' ? iteracionDe(run) : null;
    if (it) return this.#syncIteracion(run, pr, wf, it, base);

    if (pr) {
      if (pr.estado === 'fusionado') {
        const ok = await this.#patch(run, { ...base, estado: 'completado', rama: branch, prUrl: pr.url });
        if (ok) await this.#completarTicket(run, this.#config.PRAXON_USER ?? 'praxon');
        return ok;
      }
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

  /**
   * Seguimiento de una iteración sobre un PR que ya existe ("pedir cambios"). Aunque el PR esté abierto, el agente sigue
   * trabajando hasta que termine una ejecución del workflow distinta de la anterior; hasta entonces no está listo para revisar.
   */
  async #syncIteracion(run, pr, wf, { anterior }, base) {
    const nueva = wf && String(wf.id) !== String(anterior);
    if (!nueva) {
      const desde = Date.parse(run.actualizado ?? '');
      if (Number.isFinite(desde) && this.#now() - desde > this.#config.AGENTS_QUEUE_TIMEOUT_MINUTES * 60_000) {
        return this.#patch(run, { estado: 'pendiente_revision', pregunta: 'GitHub no ha iniciado los cambios pedidos. El pull request sigue como estaba.' });
      }
      return false;
    }
    if (wf.estado !== 'completed') return false;
    const fallo = wf.resultado === 'success' ? null : `Los cambios pedidos terminaron con error (${wf.resultado ?? 'desconocido'}). El pull request sigue como estaba. Detalle en ${wf.url}`;
    return this.#patch(run, { ...base, githubRunId: wf.id, estado: 'pendiente_revision', rama: branchOf(run), prUrl: pr.url, pregunta: fallo });
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

  /** Ramas destino permitidas (por defecto solo develop). Si falta la configuración se aplica el valor seguro, nunca "todas". */
  #basesPermitidas() {
    const l = this.#config.MERGE_ALLOWED_BASES;
    return Array.isArray(l) && l.length ? l : ['develop'];
  }

  #fusionable(pr, checks) {
    let motivo = null;
    const bases = this.#basesPermitidas();
    if (!this.#merger) motivo = 'La fusión no está configurada en el servidor.';
    else if (pr.estado !== 'abierto') motivo = 'El pull request ya no está abierto.';
    else if (!bases.includes('*') && !bases.includes(pr.base)) motivo = baseNoPermitida(pr.base, bases);
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

  /**
   * "Pedir cambios": relanza el agente sobre la MISMA rama del pull request con el comentario del usuario. Sigue siendo un
   * pull request que el usuario debe revisar y fusionar él (la fusión va atada al SHA, que cambiará). Solo desde la app.
   */
  async requestChanges({ runId, feedback, user }) {
    const evento = { event: 'agent_request_changes', user, runId };
    try {
      if (this.#pause?.active) throw new AgentError(this.#pause.message());
      if (!this.#dispatcher) throw new AgentError('Pedir cambios no está disponible en el servidor.');
      const texto = String(feedback ?? '').trim();
      if (texto.length < 10) throw new AgentError('Explica con algo más de detalle qué hay que cambiar.');
      if (texto.length > 1500) throw new AgentError('El comentario es demasiado largo (máximo 1500 caracteres).');
      const { run, pr } = await this.#runAndPr(runId);
      Object.assign(evento, { repo: run.repo, pr: pr.numero, sha: pr.sha, comentario: texto.slice(0, 500) });
      if (pr.estado !== 'abierto') throw new AgentError('El pull request ya no está abierto.');
      const ticket = await this.#myraypa.getTicket(run.ticketId).catch(() => null);
      const anterior = run.githubRunId ?? null;
      if (!(await this.#patch(run, { estado: 'en_curso', pregunta: marcaIteracion(anterior) }))) {
        throw new AgentError('No he podido actualizar el estado del agente en MyRAYPA.');
      }
      try {
        await this.#dispatcher.dispatchAgentWorkflow({
          repo: run.repo,
          ref: pr.base ?? run.ramaBase ?? 'main',
          ticketId: run.ticketId,
          runId: run.runId,
          tipo: run.tipo,
          titulo: ticket?.titulo ?? '',
          descripcion: ticket?.descripcion ?? '',
          prBranch: pr.rama ?? branchOf(run),
          feedback: texto,
        });
      } catch (err) {
        await this.#patch(run, { estado: 'pendiente_revision', pregunta: null }); // el PR sigue como estaba
        throw new AgentError(`No he podido lanzar el agente (${err.message}).`);
      }
      await this.#audit.record({ ...evento, ok: true });
      this.#onChange();
      return { ok: true };
    } catch (err) {
      await this.#audit.record({ ...evento, ok: false, error: err.message });
      if (err instanceof AgentError) return { ok: false, error: err.message };
      throw err;
    }
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
      if (this.#pause?.active) throw new AgentError(this.#pause.message());
      const { run, pr } = await this.#runAndPr(runId);
      Object.assign(evento, { repo: run.repo, pr: pr.numero, sha });
      if (numero !== pr.numero) throw new AgentError('El número del pull request no coincide.');
      if (pr.sha !== sha) throw new AgentError('La rama ha cambiado desde que la revisaste. Vuelve a abrir el diff.');
      const checks = await this.#checks(run, pr);
      const f = this.#fusionable(pr, checks);
      if (!f.fusionable) throw new AgentError(f.motivo);
      await this.#merger.mergePull({ repo: run.repo, number: pr.numero, sha: pr.sha, titulo: pr.titulo, allowedBases: this.#basesPermitidas() });
      await this.#patch(run, { estado: 'completado' });
      const ticketCompletado = await this.#completarTicket(run, user);
      // Dejar constancia en el ticket. La confirmación de la fusión ya cubre este comentario; si falla, la fusión sigue siendo válida.
      const comentado = await this.#comentar(run, pr, user);
      await this.#audit.record({ ...evento, ok: true, comentado, ticketCompletado });
      this.#onChange();
      return { ok: true, pr: pr.numero, comentado, ticketCompletado };
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
