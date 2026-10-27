import { compactar } from './compact.js';

/**
 * Resultado de una herramienta tal y como se le devuelve al modelo. Si lleva `_imagen` ({ mediaType, base64 }) se manda como
 * bloque de imagen (el modelo la ve) seguido de un bloque de texto con el resto de campos; si no, es el JSON de siempre,
 * compactado (ver compact.js). Si aun así supera el tope, NO se corta el JSON a la mitad (el modelo recibiría un trozo roto):
 * se acortan los textos largos y se limitan las listas, con una marca de lo recortado, hasta que quepa.
 */
const PASOS = [
  { maxStr: 2500 },
  { maxStr: 1200 },
  { maxStr: 600, maxItems: 30 },
  { maxStr: 300, maxItems: 15 },
  { maxStr: 150, maxItems: 8 },
];

export function ajustar(v, maxChars) {
  const base = v ?? { ok: true };
  for (const paso of PASOS) {
    const s = JSON.stringify(compactar(base, paso));
    if (s.length <= maxChars) return s;
  }
  const ultimo = JSON.stringify(compactar(base, PASOS.at(-1)));
  return JSON.stringify({ recortado: true, aviso: 'El resultado era demasiado largo y se ha cortado; pide algo más concreto.', texto: ultimo.slice(0, Math.max(200, maxChars - 200)) });
}

export function serializeResult(out, maxChars = 8000) {
  const img = out && typeof out === 'object' ? out._imagen : null;
  if (img?.base64 && img?.mediaType) {
    const { _imagen, ...resto } = out;
    return [
      { type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } },
      { type: 'text', text: ajustar(resto, maxChars) },
    ];
  }
  return ajustar(out, maxChars);
}

/** Texto plano de un resultado serializado (para logs): las imágenes se resumen como "[imagen]". */
export function resultText(content) {
  if (typeof content === 'string') return content;
  return (content ?? []).map((b) => (b.type === 'text' ? b.text : '[imagen]')).join(' ');
}
