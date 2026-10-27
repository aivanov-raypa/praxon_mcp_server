import { agentesTools } from './tools/agentes.js';
import { consultaTools } from './tools/consulta.js';
import { gestionTools } from './tools/gestion.js';
import { extrasTools } from './tools/extras.js';
import { documentosTools } from './tools/documentos.js';
import { roadmapsTools } from './tools/roadmaps.js';

/** Conector de MyRAYPA: tickets y proyectos del modulo de Tickets de raypa-platform, y agentes de desarrollo. */
export function createMyraypaConnector({ client, github, config = {} }) {
  return {
    name: 'myraypa',
    tools: [...consultaTools(client, config.ATTACH_CONFIRM_KB === undefined ? undefined : { confirmarAdjuntosKb: config.ATTACH_CONFIRM_KB }), ...gestionTools(client), ...extrasTools(client), ...documentosTools(client), ...roadmapsTools(client), ...agentesTools(client, github)],
  };
}
