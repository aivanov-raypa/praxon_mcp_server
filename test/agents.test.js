import { describe, expect, it } from 'vitest';
import { AgentService, branchOf, breveResumen } from '../src/agents/service.js';
import { FakeGithubReader } from '../src/integrations/github-read.js';
import { FakeGithubMerger, HttpGithubMerger } from '../src/integrations/github-merge.js';
import { MemoryAudit } from '../src/audit/log.js';
import { FakeMyraypa } from '../src/connectors/myraypa/fake.js';
import { FakeGithub } from '../src/integrations/github.js';

const REPO = 'ejemplo/raypa-platform';
const SHA = 'a'.repeat(40);
const config = { GITHUB_WORKFLOW_FILE: 'praxon-agent.yml', AGENTS_QUEUE_TIMEOUT_MINUTES: 10, AGENTS_WATCH_SECONDS: 60 };
const OK = { total: 2, ok: 2, fallando: 0, pendientes: 0, items: [] };

async function build({ workflowRuns = [], pullRequests = [], merger = new FakeGithubMerger(), clock = Date.now(), dispatcher = new FakeGithub(), pause = null } = {}) {
  const myraypa = new FakeMyraypa();
  const run = await myraypa.createAgentRun({ ticketId: '215', tipo: 'mejora' }, 'test');
  const reader = new FakeGithubReader({ [REPO]: { workflowRuns, pullRequests } });
  const audit = new MemoryAudit();
  let changed = 0;
  const svc = new AgentService({ myraypa, reader, merger, dispatcher, audit, config, pause, now: () => clock, onChange: () => changed++ });
  const state = () => myraypa.runs[0];
  return { myraypa, reader, merger, dispatcher, audit, svc, run, state, changed: () => changed, setClock: (t) => { clock = t; } };
}
const wf = (run, extra = {}) => ({ id: '777', titulo: `praxon ticket=${run.ticketId} run=${run.runId}`, estado: 'in_progress', resultado: null, url: 'https://gh/run/777', ...extra });
const pr = (run, extra = {}) => ({ numero: 12, titulo: 'Exportar PDF', estado: 'abierto', rama: branchOf(run), sha: SHA, checks: OK, files: [{ ruta: 'a.js', estado: 'modified', adiciones: 3, borrados: 1, parche: '@@' }], ...extra });

describe('seguimiento de agentes', () => {
  it('en cola -> en curso cuando el workflow arranca, y guarda el id de ejecucion', async () => {
    const b = await build({ workflowRuns: [wf({ ticketId: '215', runId: 'run-1' })] });
    await b.svc.tick();
    expect(b.state().estado).toBe('en_curso');
    expect(b.state().githubRunId).toBe('777');
    expect(b.changed()).toBe(1);
  });

  it('con PR abierto pasa a pendiente de revisión con rama y enlace', async () => {
    const r = { ticketId: '215', runId: 'run-1' };
    const b = await build({ workflowRuns: [wf(r, { estado: 'completed', resultado: 'success' })], pullRequests: [pr(r)] });
    await b.svc.tick();
    expect(b.state().estado).toBe('pendiente_revision');
    expect(b.state().rama).toBe('praxon/ticket-215-run-1');
    expect(b.state().pullRequest).toContain('/pull/12');
  });

  it('PR fusionado -> completado; PR cerrado -> fallido', async () => {
    const r = { ticketId: '215', runId: 'run-1' };
    const merged = await build({ workflowRuns: [wf(r, { estado: 'completed', resultado: 'success' })], pullRequests: [pr(r, { estado: 'fusionado' })] });
    await merged.svc.tick();
    expect(merged.state().estado).toBe('completado');
    const closed = await build({ workflowRuns: [wf(r, { estado: 'completed', resultado: 'success' })], pullRequests: [pr(r, { estado: 'cerrado' })] });
    await closed.svc.tick();
    expect(closed.state().estado).toBe('fallido');
  });

  it('workflow terminado sin PR: fallo -> fallido, éxito -> bloqueado con la pregunta', async () => {
    const r = { ticketId: '215', runId: 'run-1' };
    const fail = await build({ workflowRuns: [wf(r, { estado: 'completed', resultado: 'failure' })] });
    await fail.svc.tick();
    expect(fail.state().estado).toBe('fallido');
    const blocked = await build({ workflowRuns: [wf(r, { estado: 'completed', resultado: 'success' })] });
    await blocked.svc.tick();
    expect(blocked.state().estado).toBe('bloqueado');
    expect(blocked.state().bloqueo).toMatch(/más información/);
  });

  it('si GitHub no arranca el workflow en el plazo, el agente queda fallido', async () => {
    const b = await build({ clock: Date.now() + 11 * 60_000 });
    await b.svc.tick();
    expect(b.state().estado).toBe('fallido');
    const fresh = await build();
    await fresh.svc.tick();
    expect(fresh.state().estado).toBe('en_cola');
  });
});

describe('revisión y fusión', () => {
  const ready = async (extra) => {
    const r = { ticketId: '215', runId: 'run-1' };
    const b = await build({ workflowRuns: [wf(r, { estado: 'completed', resultado: 'success' })], pullRequests: [pr(r, extra)] });
    await b.svc.tick();
    return b;
  };

  it('list devuelve el PR con checks y marca si es fusionable', async () => {
    const b = await ready();
    const [item] = await b.svc.list();
    expect(item).toMatchObject({ runId: 'run-1', estado: 'pendiente_revision', ticket: expect.any(String), fusionable: true });
    expect(item.pr).toMatchObject({ numero: 12, sha: SHA });
    const failing = await ready({ checks: { total: 2, ok: 1, fallando: 1, pendientes: 0, items: [] } });
    expect((await failing.svc.list())[0]).toMatchObject({ fusionable: false, motivo: 'Hay checks fallando.' });
  });

  it('diff entrega los archivos cambiados', async () => {
    const b = await ready();
    const d = await b.svc.diff('run-1');
    expect(d.archivos[0].ruta).toBe('a.js');
  });

  it('fusiona con el SHA revisado y el número tecleado, y lo deja auditado', async () => {
    const b = await ready();
    const r = await b.svc.merge({ runId: 'run-1', sha: SHA, numero: 12, user: 'alex' });
    expect(r.ok).toBe(true);
    expect(b.merger.merged).toEqual([expect.objectContaining({ repo: REPO, number: 12, sha: SHA })]);
    expect(b.state().estado).toBe('completado');
    expect(b.audit.events.at(-1)).toMatchObject({ event: 'agent_merge', ok: true, user: 'alex', pr: 12 });
  });

  it('rechaza si la rama cambió, si el número no coincide o si fallan los checks', async () => {
    const b = await ready();
    expect((await b.svc.merge({ runId: 'run-1', sha: 'b'.repeat(40), numero: 12, user: 'alex' })).error).toMatch(/ha cambiado/);
    expect((await b.svc.merge({ runId: 'run-1', sha: SHA, numero: 13, user: 'alex' })).error).toMatch(/no coincide/);
    expect(b.merger.merged).toHaveLength(0);
    const bad = await ready({ checks: { total: 1, ok: 0, fallando: 1, pendientes: 0, items: [] } });
    expect((await bad.svc.merge({ runId: 'run-1', sha: SHA, numero: 12, user: 'alex' })).error).toBe('Hay checks fallando.');
    expect(bad.merger.merged).toHaveLength(0);
  });

  it('sin token de fusión no se puede fusionar', async () => {
    const r = { ticketId: '215', runId: 'run-1' };
    const b = await build({ merger: null, workflowRuns: [wf(r, { estado: 'completed', resultado: 'success' })], pullRequests: [pr(r)] });
    await b.svc.tick();
    expect((await b.svc.merge({ runId: 'run-1', sha: SHA, numero: 12, user: 'alex' })).ok).toBe(false);
  });

  it('un agente que no está pendiente de revisión no se puede fusionar', async () => {
    const b = await build();
    expect((await b.svc.merge({ runId: 'run-1', sha: SHA, numero: 12, user: 'alex' })).error).toMatch(/pendiente de revisión/);
  });
});

describe('comentario tras fusionar', () => {
  const merged = async (extra = {}) => {
    const r = { ticketId: '215', runId: 'run-1' };
    const b = await build({ workflowRuns: [wf(r, { estado: 'completed', resultado: 'success' })], pullRequests: [pr(r, { adiciones: 20, borrados: 5, resumen: 'Ticket MyRAYPA: 215\nRun de Praxon: run-1\n\nSe ha añadido la exportación a PDF de los certificados. Falta probarlo con certificados grandes.\n\nGenerado por el agente de Praxon. Requiere revisión humana antes de fusionar.', ...extra })] });
    await b.svc.tick();
    return b;
  };

  it('deja un comentario breve en el ticket con el PR y lo que se ha cambiado', async () => {
    const b = await merged();
    const r = await b.svc.merge({ runId: 'run-1', sha: SHA, numero: 12, user: 'alex' });
    expect(r).toMatchObject({ ok: true, comentado: true });
    const c = b.myraypa.tickets.find((t) => t.id === '215').comentarios.at(-1);
    expect(c.texto).toContain('PR #12');
    expect(c.texto).toContain('+20 −5');
    expect(c.texto).toContain('exportación a PDF');
    expect(c.texto).not.toContain('Run de Praxon');
    expect(c.texto).not.toContain('Generado por');
    expect(c.texto.length).toBeLessThanOrEqual(480);
    expect(c.origin).toMatchObject({ type: 'voice-assistant', user: 'alex' });
    expect(b.audit.of('agent_merge')[0]).toMatchObject({ ok: true, comentado: true });
  });

  it('si el comentario falla, la fusión sigue siendo correcta', async () => {
    const b = await merged();
    b.myraypa.commentTicket = async () => { throw new Error('MyRAYPA no responde'); };
    const r = await b.svc.merge({ runId: 'run-1', sha: SHA, numero: 12, user: 'alex' });
    expect(r).toMatchObject({ ok: true, comentado: false });
    expect(b.state().estado).toBe('completado');
  });

  it('recorta el resumen sin pasar de la longitud máxima', () => {
    const largo = `${'Cambio importante en el módulo. '.repeat(30)}`;
    expect(breveResumen(largo, 120).length).toBeLessThanOrEqual(121);
    expect(breveResumen('')).toBe('');
  });
});

describe('historial', () => {
  it('lista los agentes terminados y no los abiertos, del más reciente al más antiguo', async () => {
    const r = { ticketId: '215', runId: 'run-1' };
    const b = await build({ workflowRuns: [wf(r, { estado: 'completed', resultado: 'success' })], pullRequests: [pr(r)] });
    await b.svc.tick();
    expect(await b.svc.history()).toEqual([]);
    await b.svc.merge({ runId: 'run-1', sha: SHA, numero: 12, user: 'alex' });
    const otro = await b.myraypa.createAgentRun({ ticketId: '216', tipo: 'error' }, 'test');
    await b.myraypa.patchAgentRun(otro.runId, { estado: 'en_curso' });
    await b.myraypa.patchAgentRun(otro.runId, { estado: 'fallido', pregunta: 'El agente ha terminado con error.' });
    const h = await b.svc.history();
    expect(h.map((x) => x.runId)).toEqual([otro.runId, 'run-1']);
    expect(h[0]).toMatchObject({ estado: 'fallido', motivo: 'El agente ha terminado con error.' });
    expect(h[1]).toMatchObject({ estado: 'completado', motivo: null, ticket: expect.any(String) });
  });

  it('el diff de un agente fusionado sigue disponible, pero no se puede volver a fusionar', async () => {
    const r = { ticketId: '215', runId: 'run-1' };
    const b = await build({ workflowRuns: [wf(r, { estado: 'completed', resultado: 'success' })], pullRequests: [pr(r)] });
    await b.svc.tick();
    await b.svc.merge({ runId: 'run-1', sha: SHA, numero: 12, user: 'alex' });
    const d = await b.svc.diff('run-1');
    expect(d).toMatchObject({ estado: 'completado' });
    expect(d.archivos[0].ruta).toBe('a.js');
    const again = await b.svc.merge({ runId: 'run-1', sha: SHA, numero: 12, user: 'alex' });
    expect(again.ok).toBe(false);
  });
});

describe('pedir cambios sobre un pull request', () => {
  const R = { ticketId: '215', runId: 'run-1' };
  const FEEDBACK = 'Usa el componente Button existente y añade un test del caso vacío';
  const ready = async (opts = {}) => {
    const b = await build({ workflowRuns: [wf(R, { estado: 'completed', resultado: 'success' })], pullRequests: [pr(R, { base: 'main' })], ...opts });
    await b.svc.tick();
    return b;
  };

  it('relanza el agente sobre la misma rama con el comentario y lo deja auditado', async () => {
    const b = await ready();
    const r = await b.svc.requestChanges({ runId: 'run-1', feedback: FEEDBACK, user: 'alex' });
    expect(r).toEqual({ ok: true });
    expect(b.state().estado).toBe('en_curso');
    expect(b.state().bloqueo).toMatch(/^Aplicando los cambios pedidos \[tras ejecución 777\]/);
    expect(b.dispatcher.dispatched).toHaveLength(1);
    expect(b.dispatcher.dispatched[0]).toMatchObject({ repo: REPO, ref: 'main', runId: 'run-1', prBranch: 'praxon/ticket-215-run-1', feedback: FEEDBACK });
    expect(b.audit.of('agent_request_changes')[0]).toMatchObject({ ok: true, user: 'alex', pr: 12, comentario: FEEDBACK });
    expect(b.changed()).toBeGreaterThan(1);
  });

  it('rechaza comentarios vacíos o enormes, PR no pendiente, PR cerrado y servidor sin lanzador', async () => {
    const b = await ready();
    expect((await b.svc.requestChanges({ runId: 'run-1', feedback: 'corto' })).error).toMatch(/con algo más de detalle/);
    expect((await b.svc.requestChanges({ runId: 'run-1', feedback: 'x'.repeat(1501) })).error).toMatch(/demasiado largo/);
    expect(b.dispatcher.dispatched).toHaveLength(0);
    const closed = await ready({ pullRequests: [pr(R, { estado: 'cerrado' })] });
    expect((await closed.svc.requestChanges({ runId: 'run-1', feedback: FEEDBACK })).ok).toBe(false);
    const queued = await build();
    expect((await queued.svc.requestChanges({ runId: 'run-1', feedback: FEEDBACK })).error).toMatch(/pendiente de revisión/);
    const sin = await ready({ dispatcher: null });
    expect((await sin.svc.requestChanges({ runId: 'run-1', feedback: FEEDBACK })).error).toMatch(/no está disponible/);
  });

  it('si GitHub no lanza el workflow, el PR vuelve a quedar pendiente de revisión', async () => {
    const b = await ready();
    b.dispatcher.failNext = true;
    const r = await b.svc.requestChanges({ runId: 'run-1', feedback: FEEDBACK });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/No he podido lanzar el agente/);
    expect(b.state().estado).toBe('pendiente_revision');
    expect(b.state().bloqueo).toBeNull();
  });

  const iterando = async () => {
    const runs = [wf(R, { estado: 'completed', resultado: 'success' })];
    const b = await build({ workflowRuns: runs, pullRequests: [pr(R, { base: 'main' })] });
    await b.svc.tick();
    await b.svc.requestChanges({ runId: 'run-1', feedback: FEEDBACK });
    return { ...b, runs };
  };

  it('seguimiento: sigue en curso mientras solo se ve la ejecución anterior o la nueva no ha terminado', async () => {
    const b = await iterando();
    await b.svc.tick(); // solo se ve la ejecución anterior, ya terminada: no se vuelve a pendiente de revisión
    expect(b.state().estado).toBe('en_curso');
    b.runs.unshift(wf(R, { id: '888', estado: 'in_progress' }));
    await b.svc.tick();
    expect(b.state().estado).toBe('en_curso');
  });

  it('seguimiento: al terminar la ejecución nueva vuelve a pendiente de revisión, para revisar de nuevo', async () => {
    const b = await iterando();
    b.runs.unshift(wf(R, { id: '888', estado: 'completed', resultado: 'success' }));
    await b.svc.tick();
    expect(b.state()).toMatchObject({ estado: 'pendiente_revision', githubRunId: '888', bloqueo: null });
    await b.svc.tick();
    expect(b.state().estado).toBe('pendiente_revision');
  });

  it('seguimiento: si la ejecución nueva falla, el PR queda como estaba y se avisa', async () => {
    const b = await iterando();
    b.runs.unshift(wf(R, { id: '888', estado: 'completed', resultado: 'failure' }));
    await b.svc.tick();
    expect(b.state().estado).toBe('pendiente_revision');
    expect(b.state().bloqueo).toMatch(/terminaron con error \(failure\).*sigue como estaba/);
  });

  it('seguimiento: si GitHub no arranca la ejecución en el plazo, vuelve a pendiente de revisión', async () => {
    const b = await iterando();
    b.state().actualizado = new Date(Date.now() - 11 * 60_000).toISOString();
    b.setClock(Date.now());
    await b.svc.tick();
    expect(b.state().estado).toBe('pendiente_revision');
    expect(b.state().bloqueo).toMatch(/no ha iniciado/);
  });
});

describe('ticket completado al fusionar', () => {
  const ready = async (prExtra = {}) => {
    const r = { ticketId: '215', runId: 'run-1' };
    const b = await build({ workflowRuns: [wf(r, { estado: 'completed', resultado: 'success' })], pullRequests: [pr(r, prExtra)] });
    await b.svc.tick();
    return b;
  };
  const ticket = (b) => b.myraypa.tickets.find((t) => t.id === '215');

  it('fusionar desde la app mueve el ticket a Completado y lo marca finalizado', async () => {
    const b = await ready();
    expect(ticket(b).completado).toBe(false);
    const r = await b.svc.merge({ runId: 'run-1', sha: SHA, numero: 12, user: 'alex' });
    expect(r.ticketCompletado).toBe(true);
    expect(ticket(b).estadoId).toBe('done');
    expect(ticket(b).completado).toBe(true);
    expect(b.audit.events.some((e) => e.event === 'agent_ticket_completado' && e.ok)).toBe(true);
  });

  it('PR fusionado fuera de la app (detectado en tick) también completa el ticket', async () => {
    const b = await ready({ estado: 'fusionado' });
    expect(b.state().estado).toBe('completado');
    expect(ticket(b).estadoId).toBe('done');
    expect(ticket(b).completado).toBe(true);
  });

  it('un ticket ya completado no se vuelve a tocar', async () => {
    const b = await ready();
    await b.svc.merge({ runId: 'run-1', sha: SHA, numero: 12, user: 'alex' });
    const llamadas = [];
    const orig = b.myraypa.updateTicket.bind(b.myraypa);
    b.myraypa.updateTicket = async (...a) => { llamadas.push(a); return orig(...a); };
    await b.svc.tick();
    expect(llamadas).toHaveLength(0);
  });

  it('si MyRAYPA falla al completar, la fusión sigue siendo correcta', async () => {
    const b = await ready();
    b.myraypa.updateTicket = async () => { throw new Error('caído'); };
    const r = await b.svc.merge({ runId: 'run-1', sha: SHA, numero: 12, user: 'alex' });
    expect(r.ok).toBe(true);
    expect(r.ticketCompletado).toBe(false);
    expect(b.state().estado).toBe('completado');
    expect(b.audit.events.some((e) => e.event === 'agent_ticket_completado' && e.ok === false)).toBe(true);
  });
});


describe('rama destino de la fusión', () => {
  const R = { ticketId: '215', runId: 'run-1' };
  const ready = async (prExtra = {}, cfg = {}) => {
    const b = await build({ workflowRuns: [wf(R, { estado: 'completed', resultado: 'success' })], pullRequests: [pr(R, prExtra)] });
    Object.assign(config, cfg);
    await b.svc.tick();
    return b;
  };
  const sinBases = () => { delete config.MERGE_ALLOWED_BASES; };
  const pedir = (b) => b.svc.merge({ runId: 'run-1', sha: SHA, numero: 12, user: 'alex' });

  it('por defecto solo fusiona en develop: un PR contra main no es fusionable y no se llama a GitHub', async () => {
    sinBases();
    const b = await ready({ base: 'main' });
    const [item] = await b.svc.list();
    expect(item).toMatchObject({ fusionable: false });
    expect(item.motivo).toMatch(/«main».*solo fusiona en: develop/);
    const r = await pedir(b);
    expect(r.ok).toBe(false);
    expect(b.merger.merged).toHaveLength(0);
    expect(b.audit.events.at(-1)).toMatchObject({ event: 'agent_merge', ok: false });
    expect(b.state().estado).toBe('pendiente_revision');
  });

  it('un PR contra develop se fusiona', async () => {
    sinBases();
    const b = await ready({ base: 'develop' });
    expect((await pedir(b)).ok).toBe(true);
    expect(b.merger.merged[0]).toMatchObject({ allowedBases: ['develop'] });
  });

  it('si no se conoce la rama destino no se fusiona (falla cerrado)', async () => {
    sinBases();
    const b = await ready({ base: undefined });
    expect((await pedir(b)).ok).toBe(false);
    expect(b.merger.merged).toHaveLength(0);
  });

  it('la lista configurada admite varias ramas y "*" quita la restricción', async () => {
    const dos = await ready({ base: 'staging' }, { MERGE_ALLOWED_BASES: ['develop', 'staging'] });
    expect((await pedir(dos)).ok).toBe(true);
    const todas = await ready({ base: 'main' }, { MERGE_ALLOWED_BASES: ['*'] });
    expect((await pedir(todas)).ok).toBe(true);
    sinBases();
  });

  it('si la rama destino cambia a main justo antes de fusionar, el fusionador lo rechaza', async () => {
    sinBases();
    const b = await ready({ base: 'develop' });
    b.merger.base = 'main';
    const r = await pedir(b);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/«main»/);
    expect(b.merger.merged).toHaveLength(0);
  });
});

describe('HttpGithubMerger: comprobación de la rama destino', () => {
  const SHA40 = 'c'.repeat(40);
  const montar = (baseActual) => {
    const llamadas = [];
    const fetchImpl = async (url, opts = {}) => {
      llamadas.push(`${opts.method ?? 'GET'} ${String(url).replace('https://api.github.com', '')}`);
      if (!opts.method) return { ok: true, status: 200, json: async () => ({ base: { ref: baseActual } }) };
      return { ok: true, status: 200, json: async () => ({ merged: true, sha: SHA40 }) };
    };
    return { llamadas, merger: new HttpGithubMerger({ token: 't', fetchImpl }) };
  };
  const args = { repo: 'o/r', number: 7, sha: SHA40, titulo: 'x' };

  it('rechaza sin llegar a hacer el PUT si el PR apunta a otra rama', async () => {
    const { llamadas, merger } = montar('main');
    await expect(merger.mergePull({ ...args, allowedBases: ['develop'] })).rejects.toThrow(/«main»/);
    expect(llamadas).toEqual(['GET /repos/o/r/pulls/7']);
  });

  it('fusiona si la rama es la permitida, y con "*" no consulta la rama', async () => {
    const ok = montar('develop');
    expect((await ok.merger.mergePull({ ...args, allowedBases: ['develop'] })).fusionado).toBe(true);
    expect(ok.llamadas).toEqual(['GET /repos/o/r/pulls/7', 'PUT /repos/o/r/pulls/7/merge']);
    const todas = montar('main');
    await todas.merger.mergePull({ ...args, allowedBases: ['*'] });
    expect(todas.llamadas).toEqual(['PUT /repos/o/r/pulls/7/merge']);
  });

  it('si no puede comprobar la rama, no fusiona', async () => {
    const merger = new HttpGithubMerger({ token: 't', fetchImpl: async () => ({ ok: false, status: 502, json: async () => ({}) }) });
    await expect(merger.mergePull({ ...args, allowedBases: ['develop'] })).rejects.toThrow(/No he podido comprobar la rama destino/);
  });
});
