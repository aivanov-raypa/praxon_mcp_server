import { agentesTools } from './tools/agentes.js';
import { consultaTools } from './tools/consulta.js';
import { gestionTools } from './tools/gestion.js';

/** Conector de MyRAYPA: tickets y proyectos del modulo de Tickets de raypa-platform, y agentes de desarrollo. */
export function createMyraypaConnector({ client, github }) {
  return {
    name: 'myraypa',
    tools: [...consultaTools(client), ...gestionTools(client), ...agentesTools(client, github)],
  };
}
