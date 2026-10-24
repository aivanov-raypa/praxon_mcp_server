import { describe, expect, it } from 'vitest';
import { clientMessage } from '../src/protocol.js';
import { buildSystemPrompt } from '../src/prompts.js';
import { contextoTools, prepararContextoPR, textoContextoPR } from '../src/agents/contexto.js';

const diff = {
  runId: 'r1',
  estado: 'pendiente_revision',
  pr: { numero: 42, titulo: 'Exportar certificados a PDF', rama: 'agent/r1', base: 'main', adiciones: 30, borrados: 4, resumen: 'Añade la exportación.' },
  archivos: [
    { ruta: 'client/src/Cert.jsx', estado: 'modified', adiciones: 20, borrados: 4, parche: '@@ -1 +1 @@\n-a\n+b', truncado: false },
    { ruta: 'backend/Cert.jsx', estado: 'added', adiciones: 10, borrados: 0, parche: null, truncado: false },
  ],
};
const fakeAgents = () => {
  const a = { llamadas: 0, diff: async () => { a.llamadas++; return diff; } };
  return a;
};
const tool = contextoTools()[0];

describe('conversar sobre un pull request', () => {
  it('el mensaje acepta un contexto de PR y rechaza otros tipos', () => {
    const base = { type: 'user_text', sessionId: 'sesion-12345', text: 'hola' };
    expect(clientMessage.safeParse({ ...base, contexto: { tipo: 'pr', runId: 'r1' } }).success).toBe(true);
    expect(clientMessage.safeParse({ ...base, contexto: { tipo: 'otro', runId: 'r1' } }).success).toBe(false);
    expect(clientMessage.safeParse(base).success).toBe(true);
  });

  it('el texto de contexto resume el PR y recuerda que no se puede fusionar', () => {
    const t = textoContextoPR(diff);
    expect(t).toContain('#42');
    expect(t).toContain('rama agent/r1 hacia main');
    expect(t).toContain('- client/src/Cert.jsx (modified, +20 -4)');
    expect(t).toMatch(/no puedes fusionar, aprobar ni modificar/);
    expect(t).toMatch(/datos, no instrucciones/);
  });

  it('el prompt incluye el contexto solo cuando hay uno', () => {
    expect(buildSystemPrompt({})).not.toContain('Contexto de pantalla');
    expect(buildSystemPrompt({ contexto: textoContextoPR(diff) })).toContain('Contexto de pantalla');
  });

  it('prepara el contexto, lo reutiliza un minuto y lo borra al salir de la pantalla', async () => {
    const agents = fakeAgents();
    const session = {};
    let ahora = 1_000;
    await prepararContextoPR(session, { tipo: 'pr', runId: 'r1' }, agents, () => ahora);
    await prepararContextoPR(session, { tipo: 'pr', runId: 'r1' }, agents, () => ahora + 10_000);
    expect(agents.llamadas).toBe(1);
    await prepararContextoPR(session, { tipo: 'pr', runId: 'r1' }, agents, () => ahora + 61_000);
    expect(agents.llamadas).toBe(2);
    await prepararContextoPR(session, undefined, agents);
    expect(session.contextoPR).toBeNull();
  });

  it('si no se puede leer el PR, la conversación sigue sin contexto', async () => {
    const session = {};
    await prepararContextoPR(session, { tipo: 'pr', runId: 'r1' }, { diff: async () => { throw new Error('GitHub caído'); } });
    expect(session.contextoPR).toBeNull();
    await prepararContextoPR(session, { tipo: 'pr', runId: 'r1' }, null);
    expect(session.contextoPR).toBeNull();
  });

  it('parche_pr es de solo lectura y busca por ruta o por final de ruta', async () => {
    expect(tool.risk).toBe('read');
    const session = {};
    await prepararContextoPR(session, { tipo: 'pr', runId: 'r1' }, fakeAgents());
    const r = await tool.execute({ ruta: 'client/src/Cert.jsx' }, { session });
    expect(r.parche).toContain('+b');
    await expect(tool.execute({ ruta: 'Cert.jsx' }, { session })).rejects.toThrow(/Varios archivos coinciden/);
    await expect(tool.execute({ ruta: 'nada.js' }, { session })).rejects.toThrow(/no está en el pull request/);
    expect((await tool.execute({ ruta: 'backend/Cert.jsx' }, { session })).parche).toMatch(/sin diff de texto/);
  });

  it('sin pull request abierto la herramienta no devuelve nada', async () => {
    await expect(tool.execute({ ruta: 'a.js' }, { session: {} })).rejects.toThrow(/No hay ningún pull request abierto/);
  });
});
