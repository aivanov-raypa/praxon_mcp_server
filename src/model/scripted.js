/**
 * Modelo guionizado para desarrollo y pruebas: no llama a ninguna API. Entiende unas pocas frases
 * (consultas de tickets, "pasa el de los faltantes a alta") para poder probar el flujo completo
 * app -> servidor -> herramientas -> confirmacion sin gastar tokens. No es un modelo de verdad.
 */
const PROYECTOS = ['calibraciones', 'mes', 'incidencias'];
const STOP = new Set(
  'el la los las de del a al pasa pon marca cambia ticket tickets alta que hay en un una y por favor prioridad con lo para es'.split(' '),
);

const norm = (s) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
const words = (s) => norm(s).replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);

let counter = 0;
const toolUse = (name, input) => ({ type: 'tool_use', id: `toolu_scripted_${++counter}`, name, input });
const text = (t) => ({ type: 'text', text: t });

function latestUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    const t = m.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
    if (t) return t;
  }
  return '';
}

const isWriteIntent = (t) => /\b(pasa|pon|marca|cambia)\b/.test(norm(t)) && /\balta\b/.test(norm(t));
const projectIn = (t) => PROYECTOS.find((p) => words(t).includes(p));

function plan(userText) {
  const t = norm(userText);
  const proyectoId = projectIn(userText);
  if (isWriteIntent(userText)) {
    const texto = words(userText).filter((w) => !STOP.has(w) && w !== proyectoId).join(' ');
    return [text('Busco ese ticket.'), toolUse('myraypa_listar_tickets', { ...(proyectoId && { proyectoId }), texto, limite: 5 })];
  }
  if (t.includes('proyectos')) return [toolUse('myraypa_listar_proyectos', {})];
  if (t.includes('resumen')) return [toolUse('myraypa_resumen_proyecto', { proyectoId: proyectoId ?? 'calibraciones' })];
  if (/(que hay|abierto|abiertos|tickets|prioritario|pendiente)/.test(t)) {
    return [toolUse('myraypa_listar_tickets', { ...(proyectoId && { proyectoId }), mostrar: 'abiertos', limite: 5 })];
  }
  return [text('No te he entendido. Puedes preguntarme por tickets o proyectos.')];
}

function afterTools(messages, userText) {
  const results = messages.at(-1).content.filter((b) => b.type === 'tool_result');
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  const name = lastAssistant.content.find((b) => b.type === 'tool_use')?.name;
  const first = results[0];
  let data = {};
  try {
    data = JSON.parse(first.content);
  } catch {
    /* el resultado no es JSON: se trata como error */
  }
  if (first.is_error) return [text(`No he podido hacerlo. ${String(first.content).replace(/^Error: /, '')}`)];

  switch (name) {
    case 'myraypa_listar_proyectos':
      return [text(`Hay ${data.proyectos.length} proyectos: ${data.proyectos.map((p) => p.nombre).join(', ')}.`)];
    case 'myraypa_listar_tickets': {
      const list = data.tickets ?? [];
      if (isWriteIntent(userText)) {
        if (list.length === 0) return [text('No encuentro ningún ticket con eso.')];
        if (list.length === 1) return [toolUse('myraypa_actualizar_ticket', { ticketId: list[0].id, prioridad: 'alta' })];
        return [text(`He encontrado ${list.length} tickets parecidos: ${list.map((tk) => tk.titulo).join('; ')}. ¿Cuál quieres?`)];
      }
      if (list.length === 0) return [text('No hay tickets que coincidan.')];
      const top = list[0];
      return [text(`Hay ${data.total} tickets abiertos. El más prioritario es ${top.titulo}, prioridad ${top.prioridad}. ¿Quieres el detalle de alguno?`)];
    }
    case 'myraypa_resumen_proyecto':
      return [text(`El proyecto ${data.proyecto} tiene ${data.abiertos} tickets abiertos y ${data.prioritarios.length} de prioridad alta.`)];
    case 'myraypa_actualizar_ticket':
      if (data.cancelada) return [text('Cancelado. No he cambiado nada.')];
      return [text(`Hecho. El ticket ${data.titulo} ya está actualizado.`)];
    default:
      return [text(data.cancelada ? 'Cancelado. No he cambiado nada.' : 'Hecho.')];
  }
}

/** Revision automatica de prueba: lista tickets abiertos, propone subir a alta el primero de prioridad media y resume. */
function triagePlan(messages) {
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  const used = lastAssistant?.content.filter((b) => b.type === 'tool_use').map((b) => b.name) ?? [];
  const lastResults = messages.at(-1).content?.filter?.((b) => b.type === 'tool_result') ?? [];
  if (!lastAssistant) return [toolUse('myraypa_listar_tickets', { mostrar: 'abiertos', limite: 10 })];
  if (used.includes('myraypa_listar_tickets')) {
    let tickets = [];
    try {
      tickets = JSON.parse(lastResults[0].content).tickets ?? [];
    } catch {
      /* sin datos */
    }
    const media = tickets.find((tk) => tk.prioridad === 'media');
    if (media) {
      return [toolUse('proponer_accion', { herramienta: 'myraypa_actualizar_ticket', parametros: { ticketId: media.id, prioridad: 'alta' }, motivo: 'Es lo más relevante de los tickets abiertos y sigue en prioridad media.' })];
    }
  }
  const n = tickets_count(messages);
  return [toolUse('entregar_resumen', { resumen: n ? `He revisado los tickets abiertos y te dejo una propuesta para aprobar.` : 'He revisado los tickets y no hay nada que requiera acción ahora.' })];
}
const tickets_count = (messages) => JSON.stringify(messages).includes('proponer_accion') ? 1 : 0;

export class ScriptedModel {
  async *stream({ system = '', messages }) {
    if (String(system).includes('[[REVISION_AUTOMATICA]]')) {
      const content = triagePlan(messages);
      yield { type: 'message', content, stopReason: 'tool_use' };
      return;
    }
    const last = messages.at(-1);
    const userText = latestUserText(messages);
    const afterToolResults = last.role === 'user' && Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_result');
    const content = afterToolResults ? afterTools(messages, userText) : plan(userText);

    for (const block of content) {
      if (block.type === 'text') {
        for (const part of block.text.match(/\S+\s*/g) ?? []) yield { type: 'text', text: part }; // simula el streaming
      }
    }
    yield { type: 'message', content, stopReason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn' };
  }
}
