/**
 * Compactado de los resultados de herramientas ANTES de enviarlos al modelo (solo cambia la forma, no el significado):
 *  - quita campos vacíos (null, "", [], {}); false y 0 se conservan porque sí dicen algo;
 *  - acorta fechas ISO (sin segundos ni milisegundos; solo el día si es medianoche UTC);
 *  - convierte HTML a texto plano (el backend ya lo hace con tickets y comentarios; esto cubre lo que se le escape);
 *  - pasa las listas de objetos planos a { columnas, filas }, sin repetir los nombres de los campos en cada elemento;
 *  - recorta textos largos indicando cuánto se ha quitado.
 * Los consumidores internos (revisión automática, agentes...) usan el cliente directamente: esto solo afecta a lo que ve el modelo.
 */
const FECHA = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
const HTML = /<\/?[a-z][a-z0-9]*(\s[^>]*)?\/?>/i;
const MIN_FILAS = 3;
const MAX_COLUMNAS = 12;

const esObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const esEscalar = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v);

export function htmlATexto(s) {
  return String(s)
    .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, t) => {
      const txt = t.replace(/<[^>]*>/g, '').trim();
      return !txt || txt === href ? ` ${href} ` : `${txt} (${href})`;
    })
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

function cadena(s, maxStr) {
  let t = HTML.test(s) ? htmlATexto(s) : s;
  const f = FECHA.exec(t);
  if (f) t = f[2] === '00:00' && (!f[3] || f[3] === 'Z') ? f[1] : `${f[1]}T${f[2]}${f[3] ?? ''}`;
  return t.length > maxStr ? `${t.slice(0, maxStr)}… [recortado: ${t.length - maxStr} caracteres más]` : t;
}

const vacio = (v) => v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length) || (esObjeto(v) && !Object.keys(v).length);

/** Objeto con valores escalares o con objetos de un nivel de escalares (se aplanan como "a.b"); null si no es aplanable. */
function aplanar(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (esEscalar(v)) out[k] = v;
    else if (esObjeto(v) && Object.values(v).every(esEscalar)) for (const [k2, v2] of Object.entries(v)) out[`${k}.${k2}`] = v2;
    else return null;
  }
  return out;
}

function tabla(lista) {
  const items = lista.map((e) => (esObjeto(e) ? aplanar(e) : null));
  if (items.some((e) => !e)) return null;
  const columnas = [];
  for (const it of items) for (const k of Object.keys(it)) if (!columnas.includes(k)) columnas.push(k);
  if (columnas.length > MAX_COLUMNAS) return null;
  return { columnas, filas: items.map((it) => columnas.map((c) => it[c] ?? null)) };
}

/** @param {{maxStr?: number, maxItems?: number}} opts */
export function compactar(v, { maxStr = 2500, maxItems = Infinity } = {}) {
  const rec = (x) => {
    if (typeof x === 'string') return cadena(x, maxStr);
    if (Array.isArray(x)) {
      const lista = x.slice(0, maxItems).map(rec).filter((e) => !vacio(e));
      const omitidos = x.length - Math.min(x.length, maxItems);
      if (lista.length >= MIN_FILAS) {
        const t = tabla(lista);
        if (t) return omitidos ? { ...t, omitidos } : t;
      }
      return omitidos ? [...lista, { omitidos }] : lista;
    }
    if (esObjeto(x)) {
      const out = {};
      for (const [k, val] of Object.entries(x)) {
        const c = rec(val);
        if (!vacio(c)) out[k] = c;
      }
      return out;
    }
    return x;
  };
  return rec(v);
}
