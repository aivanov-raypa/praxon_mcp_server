import { describe, expect, it } from 'vitest';
import { AgentService, branchOf } from '../src/agents/service.js';
import { FakeGithubReader } from '../src/integrations/github-read.js';
import { FakeGithubMerger } from '../src/integrations/github-merge.js';
import { MemoryAudit } from '../src/audit/log.js';
import { FakeMyraypa } from '../src/connectors/myraypa/fake.js';

const REPO = 'ejemplo/raypa-platform';
const SHA = 'a'.repeat(40);
const config = { GITHUB_WORKFLOW_FILE: 'praxon-agent.yml', AGENTS_QUEUE_TIMEOUT_MINUTES: 10, AGENTS_WATCH_SECONDS: 60 };
const OK = { total: 2, ok: 2, fallando: 0, pendientes: 0, items: [] };

async function build({ workflowRuns = [], pullRequests = [], merger = new FakeGithubMerger(), clock = Date.now() } = {}) {
  const myraypa = new FakeMyraypa();
  const run = await myraypa.createAgentRun({ ticketId: '215', tipo: 'mejora' }, 'test');
  const reader = new FakeGithubReader({ [REPO]: { workflowRuns, pullRequests } });
  const audit = new MemoryAudit();
  let changed = 0;
  const svc = new AgentService({ myraypa, reader, merger, audit, config, now: () => clock, onChange: () => changed++ });
  const state = () => myraypa.runs[0];
  return { myraypa, reader, merger, audit, svc, run, state, changed: () => changed };
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
