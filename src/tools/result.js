/**
 * Resultado de una herramienta tal y como se le devuelve al modelo. Si lleva `_imagen` ({ mediaType, base64 }) se manda como
 * bloque de imagen (el modelo la ve) seguido de un bloque de texto con el resto de campos; si no, es el JSON de siempre.
 */
export function serializeResult(out, maxChars = 8000) {
  const texto = (v) => {
    const s = JSON.stringify(v ?? { ok: true });
    return s.length <= maxChars ? s : JSON.stringify({ recortado: true, texto: s.slice(0, maxChars) });
  };
  const img = out && typeof out === 'object' ? out._imagen : null;
  if (img?.base64 && img?.mediaType) {
    const { _imagen, ...resto } = out;
    return [
      { type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.base64 } },
      { type: 'text', text: texto(resto) },
    ];
  }
  return texto(out);
}

/** Texto plano de un resultado serializado (para logs): las imágenes se resumen como "[imagen]". */
export function resultText(content) {
  if (typeof content === 'string') return content;
  return (content ?? []).map((b) => (b.type === 'text' ? b.text : '[imagen]')).join(' ');
}
