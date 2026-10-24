import { describe, expect, it, vi } from 'vitest';
import { HttpMyraypaClient } from '../src/connectors/myraypa/client.js';
import { HttpGithub } from '../src/integrations/github.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('HttpMyraypaClient', () => {
  it('construye la URL con filtros, manda el token y el origen de los cambios', async () => {
    const fetchImpl = vi.fn(async () => json({ total: 0, tickets: [] }));
    const c = new HttpMyraypaClient({ baseUrl: 'http://srv/api/', token: 'tok', fetchImpl });
    await c.listTickets({ proyectoId: 'mes', texto: 'faltantes de la OF', estado: undefined, limit: 3 });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe('http://srv/api/assistant/tickets?proyecto=mes&texto=faltantes+de+la+OF&limit=3');
    expect(init.headers.Authorization).toBe('Bearer tok');

    await c.updateTicket(214, { prioridad: 'urgente' }, { type: 'voice-assistant', user: 'alex' });
    const [, put] = fetchImpl.mock.calls[1];
    expect(put.method).toBe('PATCH');
    expect(JSON.parse(put.body)).toEqual({ prioridad: 'urgente', origin: { type: 'voice-assistant', user: 'alex' } });
  });

  it('traduce los errores de la API a mensajes claros', async () => {
    const mk = (status) => new HttpMyraypaClient({ baseUrl: 'http://srv', token: 't', fetchImpl: async () => json({ message: 'detalle' }, status) });
    await expect(mk(403).getTicket(1)).rejects.toMatchObject({ status: 403, message: expect.stringContaining('No permitido') });
    await expect(mk(404).getTicket(1)).rejects.toMatchObject({ status: 404 });
    const down = new HttpMyraypaClient({ baseUrl: 'http://srv', token: 't', fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
    await expect(down.listProjects()).rejects.toMatchObject({ status: 503 });
  });
});

describe('HttpGithub', () => {
  it('dispara el workflow con ticketId y runId como cadenas', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    await new HttpGithub({ token: 'gh', workflowFile: 'praxon-agent.yml', fetchImpl }).dispatchAgentWorkflow({ repo: 'org/repo', ref: 'main', ticketId: 214, runId: 'run-1' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/org/repo/actions/workflows/praxon-agent.yml/dispatches');
    expect(init.headers.Authorization).toBe('Bearer gh');
    expect(JSON.parse(init.body)).toEqual({
      ref: 'main',
      inputs: { ticketId: '214', runId: 'run-1', tipo: 'mejora', titulo: '', descripcion: '', baseBranch: 'main' },
    });
  });
  it('al pedir cambios envía también la rama del PR y el comentario; sin ellos, los inputs de siempre', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const gh = new HttpGithub({ token: 'gh', fetchImpl });
    await gh.dispatchAgentWorkflow({ repo: 'org/repo', ref: 'main', ticketId: 1, runId: 'r', prBranch: 'praxon/ticket-1-r', feedback: 'Cambia X' });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).inputs).toMatchObject({ prBranch: 'praxon/ticket-1-r', feedback: 'Cambia X' });
    await gh.dispatchAgentWorkflow({ repo: 'org/repo', ref: 'main', ticketId: 1, runId: 'r' });
    expect(Object.keys(JSON.parse(fetchImpl.mock.calls[1][1].body).inputs)).not.toContain('feedback');
  });
  it('falla con un mensaje claro si GitHub rechaza', async () => {
    const gh = new HttpGithub({ token: 'x', fetchImpl: async () => new Response('{}', { status: 404 }) });
    await expect(gh.dispatchAgentWorkflow({ repo: 'a/b', ref: 'main', ticketId: 1, runId: 'r' })).rejects.toThrow(/404/);
  });
});
