/**
 * Confirmación por lotes: todo lo que el modelo quiere cambiar en un mismo paso se confirma UNA vez.
 * Aquí se construye lo que se lee en voz alta (corto) y la lista completa que se ve en pantalla.
 */
export const MAX_BATCH = 25;

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const TICKET = /^Voy a cambiar el (ticket .+?): (.+)$/;

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
export const sinVoyA = (s) => cap(String(s).replace(/^Voy a /, ''));

/** "el 2026-10-23" -> "el 23 de octubre" (con el año solo si no es el actual). Solo para lo que se lee en voz alta. */
export function fechasHabladas(text, now = new Date()) {
  return text.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (_, y, m, d) => {
    const mes = MESES[Number(m) - 1];
    if (!mes) return `${y}-${m}-${d}`;
    return `${Number(d)} de ${mes}${Number(y) === now.getFullYear() ? '' : ` de ${y}`}`;
  });
}

/** Une los cambios de un mismo ticket ("fecha" y "prioridad" -> una sola línea por ticket). */
export function unirResumenes(summaries) {
  const units = [];
  const byLabel = new Map();
  for (const s of summaries) {
    const m = TICKET.exec(s);
    if (!m) {
      units.push({ text: s, label: null, changes: null });
      continue;
    }
    const [, label, changes] = m;
    const known = byLabel.get(label);
    if (known) {
      known.changes = `${known.changes} y ${changes}`;
      known.text = `Voy a cambiar el ${label}: ${known.changes}`;
    } else {
      const u = { text: s, label, changes };
      byLabel.set(label, u);
      units.push(u);
    }
  }
  return units;
}

/** Lo mismo sin lo que varía de un ticket a otro ("de media a alta" -> "a alta"). */
const firma = (changes) => changes.replace(/ de [^ ]+ a /g, ' a ');

/**
 * @param {string[]} summaries un resumen por cada acción de escritura (en orden)
 * @returns {{ summary: string, items?: string[] }} `summary` es lo que se lee; `items` la lista para la pantalla (solo con varias acciones)
 */
export function resumenDeLote(summaries, now = new Date()) {
  if (summaries.length === 1) return { summary: summaries[0] };
  const units = unirResumenes(summaries);
  const items = units.map((u) => sinVoyA(u.text));
  const n = units.length;
  const tickets = units.every((u) => u.label);
  let spoken;
  if (n === 1) {
    spoken = units[0].text;
  } else if (tickets && new Set(units.map((u) => firma(u.changes))).size === 1) {
    const nombres = units.map((u) => u.label.replace(/^ticket /, ''));
    const quien = n <= 3 ? ` (${nombres.slice(0, -1).join(', ')} y ${nombres.at(-1)})` : '';
    spoken = `Voy a cambiar ${n} tickets${quien}: ${firma(units[0].changes)}${n > 3 ? '. Tienes la lista en pantalla' : ''}`;
  } else if (n <= 3) {
    spoken = `Voy a hacer ${n} cambios: ${units.map((u) => sinVoyA(u.text).replace(/^./, (c) => c.toLowerCase())).join('; ')}`;
  } else {
    const first = units.slice(0, 2).map((u) => sinVoyA(u.text).replace(/^./, (c) => c.toLowerCase()));
    spoken = `Voy a hacer ${n} cambios, entre ellos: ${first.join('; ')}; y ${n - 2} más. Tienes la lista en pantalla`;
  }
  return { summary: fechasHabladas(spoken, now), items };
}
