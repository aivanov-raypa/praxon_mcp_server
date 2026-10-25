import { z } from 'zod';
import { defineTool } from '../tools/registry.js';
import { originOf } from '../connectors/myraypa/tools/shared.js';

const TTL_MS = 24 * 3_600_000;
const MAX_PER_OWNER = 20;
const FIELDS = ['estado', 'prioridad', 'asignado', 'completado'];
const ownerOf = (session) => session?.email ?? session?.user ?? 'desconocido';

/**
 * Deshacer para los cambios reversibles de ticket (estado, prioridad, responsable, completado). Antes de cada
 * actualizar_ticket se guarda cómo estaba; deshacer solo se aplica si el ticket sigue como lo dejó el cambio.
 * Vive en memoria (24 h, 20 cambios por usuario): es una red de seguridad inmediata, no un historial.
 */
export class UndoStore {
  #now;
  #byOwner = new Map();

  constructor({ now = Date.now } = {}) {
    this.#now = now;
  }

  record(owner, entry) {
    const list = (this.#byOwner.get(owner) ?? []).filter((e) => this.#now() - e.ts < TTL_MS);
    list.push({ ...entry, ts: this.#now() });
    this.#byOwner.set(owner, list.slice(-MAX_PER_OWNER));
  }

  last(owner) {
    return (this.#byOwner.get(owner) ?? []).filter((e) => this.#now() - e.ts < TTL_MS).at(-1) ?? null;
  }

  drop(owner, entry) {
    this.#byOwner.set(owner, (this.#byOwner.get(owner) ?? []).filter((e) => e !== entry));
  }
}

/** Lo que cambió: para cada campo pedido que de verdad cambió, su valor de antes y de después. */
export function diffFields(cambios, antes, despues) {
  const before = {};
  const after = {};
  const noRestaurable = [];
  for (const f of FIELDS) {
    if (cambios[f] === undefined || antes[f] === despues[f]) continue;
    if (f === 'asignado' && !antes[f]) {
      noRestaurable.push(f); // el ticket no tenía responsable: la API no permite quitarlo
      continue;
    }
    before[f] = antes[f];
    after[f] = despues[f];
  }
  return { before, after, noRestaurable };
}

/** Envuelve myraypa_actualizar_ticket para anotar cómo estaba el ticket antes de cada cambio. */
export function installUndo({ registry, client, undo }) {
  const tool = registry.get('myraypa_actualizar_ticket');
  if (!tool) return false;
  const original = tool.execute;
  tool.execute = async (args, ctx) => {
    const { ticketId, ...cambios } = args;
    const antes = await client.getTicket(ticketId).catch(() => null);
    const result = await original(args, ctx);
    try {
      if (antes) {
        const despues = await client.getTicket(ticketId);
        const d = diffFields(cambios, antes, despues);
        if (Object.keys(d.before).length) undo.record(ownerOf(ctx.session), { ticketId, titulo: antes.titulo, ...d });
      }
    } catch {
      /* sin deshacer para este cambio; el cambio ya se hizo */
    }
    return result;
  };
  return true;
}

const describe = (entry) =>
  Object.entries(entry.before)
    .map(([k, v]) => (k === 'completado' ? (v ? 'volver a marcarlo como completado' : 'reabrirlo') : `${k} de nuevo a ${v}`))
    .join(' y ');

export function undoTools({ undo, client }) {
  const check = async (session) => {
    const entry = undo.last(ownerOf(session));
    if (!entry) throw new Error('No tengo ningún cambio reciente que pueda deshacer.');
    const now = await client.getTicket(entry.ticketId);
    for (const [k, v] of Object.entries(entry.after)) {
      if (now[k] !== v) throw new Error(`El ticket ${entry.titulo} ha cambiado desde entonces (${k} ahora es ${now[k]}). No lo deshago para no pisar un cambio posterior.`);
    }
    return entry;
  };
  return [
    defineTool({
      connector: 'praxon',
      name: 'deshacer_ultimo_cambio',
      risk: 'write',
      description:
        'Deshace el último cambio de estado, prioridad, responsable o completado que hiciste en un ticket, siempre que el ticket no haya cambiado después. Úsala cuando el usuario diga "deshaz eso", "vuelve a como estaba" o "me he equivocado". El usuario debe confirmar.',
      input: z.object({}),
      summarize: async (_a, { session }) => {
        const e = await check(session);
        const extra = e.noRestaurable.length ? ` (el responsable anterior no se puede restaurar)` : '';
        return `Voy a deshacer el último cambio del ticket ${e.titulo}: ${describe(e)}${extra}`;
      },
      execute: async (_a, { session }) => {
        const e = await check(session);
        await client.updateTicket(e.ticketId, e.before, originOf(session));
        undo.drop(ownerOf(session), e);
        return { deshecho: true, ticket: e.titulo };
      },
    }),
  ];
}
