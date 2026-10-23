import { z } from 'zod';
import { defineTool } from '../../../tools/registry.js';
import { originOf, ticketId } from './shared.js';

/**
 * Agentes de desarrollo. Cada agente trabaja en el runner interno, entrega siempre un pull request
 * y nunca mergea ni despliega. Aqui solo se lanza, se consulta y se cancela.
 */
export function agentesTools(client, github) {
  const connector = 'myraypa';
  return [
    defineTool({
      connector,
      name: 'lanzar_agente',
      risk: 'write',
      description: 'Lanza un agente que desarrolla la mejora o soluciona el error descrito en un ticket y abre un pull request para revisión.',
      input: z.object({ ticketId, tipo: z.enum(['mejora', 'error']).describe('mejora = nueva funcionalidad; error = corregir un fallo') }),
      summarize: async (a) => {
        const tk = await client.getTicket(a.ticketId);
        if (tk.proyecto.autonomia !== 'agentes') throw new Error(`El proyecto ${tk.proyecto.nombre} no permite lanzar agentes.`);
        if (!tk.proyecto.repo) throw new Error(`El proyecto ${tk.proyecto.nombre} no tiene repositorio asociado.`);
        return `Voy a lanzar un agente de ${a.tipo} sobre el ticket ${tk.titulo}, en el repositorio ${tk.proyecto.repo}`;
      },
      execute: async (a, { session }) => {
        const run = await client.createAgentRun(a, originOf(session));
        try {
          const tk = await client.getTicket(a.ticketId).catch(() => null);
          await github.dispatchAgentWorkflow({
            repo: run.repo,
            ref: run.ramaBase ?? 'main',
            ticketId: run.ticketId,
            runId: run.runId,
            tipo: a.tipo,
            titulo: tk?.titulo ?? '',
            descripcion: tk?.descripcion ?? '',
          });
        } catch (err) {
          // No dejar un AgentRun huérfano en cola si el workflow no se ha podido lanzar.
          await client.cancelAgentRun(run.runId, originOf(session)).catch(() => {});
          throw err;
        }
        return { runId: run.runId, ticketId: run.ticketId, tipo: a.tipo, estado: 'lanzado', repo: run.repo };
      },
    }),
    defineTool({
      connector,
      name: 'estado_agente',
      risk: 'read',
      description: 'Estado de un agente, por su runId o por el ticket sobre el que trabaja (el más reciente).',
      input: z
        .object({ runId: z.string().optional(), ticketId: ticketId.optional() })
        .refine((a) => a.runId || a.ticketId, { message: 'indica runId o ticketId' }),
      execute: async (a) => (await client.getAgentRun(a)) ?? { encontrado: false },
    }),
    defineTool({
      connector,
      name: 'cancelar_agente',
      risk: 'write',
      description: 'Cancela un agente en curso.',
      input: z.object({ runId: z.string().min(1) }),
      summarize: async (a) => {
        const run = await client.getAgentRun({ runId: a.runId });
        if (!run) throw new Error(`No existe el agente ${a.runId}.`);
        const tk = await client.getTicket(run.ticketId).catch(() => null);
        return `Voy a cancelar el agente ${tk ? `del ticket ${tk.titulo}` : run.runId}`;
      },
      execute: async (a, { session }) => {
        const run = await client.getAgentRun({ runId: a.runId });
        const result = await client.cancelAgentRun(a.runId, originOf(session));
        if (run?.githubRunId) await github.cancelWorkflowRun({ repo: run.repo, githubRunId: run.githubRunId }).catch(() => {});
        return result;
      },
    }),
  ];
}
