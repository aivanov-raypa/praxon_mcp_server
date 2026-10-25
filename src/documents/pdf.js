/**
 * Generador de PDF sencillo y sin dependencias para los documentos que Praxon deja en los tickets: título, párrafos,
 * encabezados (#, ##, ###), listas, citas, bloques de código y reglas. Solo texto (Helvetica y Courier, codificación
 * WinAnsi: vale para castellano). Es deliberadamente simple: lo importante es que el PDF sea válido y legible.
 */
const W = 595.28;
const H = 841.89;
const MARGEN = 56;
const ANCHO = W - 2 * MARGEN;
const PIE = 40;

// Anchos de Helvetica (por mil) para ASCII 32..126; las letras acentuadas miden igual que la base.
const HELV = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const BASE = (c) => c.normalize('NFD').replace(/[̀-ͯ]/g, '');
const WINANSI = { '€': 0x80, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97 };

function codigo(ch) {
  if (WINANSI[ch]) return WINANSI[ch];
  const n = ch.codePointAt(0);
  return n >= 32 && n <= 255 && n !== 127 ? n : 63; // "?" para lo que no se pueda representar
}

function ancho(texto, tam, fuente) {
  if (fuente === 'F3') return texto.length * 0.6 * tam;
  let w = 0;
  for (const ch of texto) {
    const b = BASE(ch);
    const n = b.length === 1 ? b.codePointAt(0) : 63;
    w += n >= 32 && n <= 126 ? HELV[n - 32] : ch === '•' ? 350 : 556;
  }
  return (w * tam * (fuente === 'F2' ? 1.07 : 1)) / 1000;
}

const hex = (texto) => [...texto].map((ch) => codigo(ch).toString(16).padStart(2, '0')).join('');

/** Parte un texto en líneas que caben en `max` puntos. */
function envolver(texto, tam, fuente, max) {
  const lineas = [];
  for (const parrafo of texto.split('\n')) {
    let actual = '';
    for (const palabra of parrafo.split(/\s+/).filter(Boolean)) {
      let p = palabra;
      while (ancho(p, tam, fuente) > max) { // palabra más larga que la línea: se corta
        let i = p.length;
        while (i > 1 && ancho(p.slice(0, i), tam, fuente) > max) i -= 1;
        if (actual) { lineas.push(actual); actual = ''; }
        lineas.push(p.slice(0, i));
        p = p.slice(i);
      }
      const prueba = actual ? `${actual} ${p}` : p;
      if (ancho(prueba, tam, fuente) <= max) actual = prueba;
      else { lineas.push(actual); actual = p; }
    }
    lineas.push(actual);
  }
  return lineas;
}

const limpiarInline = (s) => s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1').replace(/(?<![*\w])\*(?!\s)(.+?)\*(?!\w)/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');

/** @returns {Buffer} */
export function markdownToPdf({ titulo, markdown, autor = 'Praxon', fecha = new Date() }) {
  const paginas = [];
  let ops = [];
  let y = H - MARGEN;
  const nueva = () => { if (ops.length || paginas.length === 0) paginas.push((ops = [])); y = H - MARGEN; };
  nueva();
  const texto = (s, x, yy, tam, fuente, gris = 0) => ops.push(`BT /${fuente} ${tam} Tf ${gris} ${gris} ${gris} rg ${x.toFixed(2)} ${yy.toFixed(2)} Td <${hex(s)}> Tj ET`);
  const regla = (yy, gris = 0.75, grosor = 0.5) => ops.push(`${gris} G ${grosor} w ${MARGEN} ${yy.toFixed(2)} m ${W - MARGEN} ${yy.toFixed(2)} l S`);
  const bloque = (s, { tam = 11, fuente = 'F1', sangria = 0, antes = 0, despues = 4, interlineado = 1.35, gris = 0, prefijo = null } = {}) => {
    const lineas = envolver(s, tam, fuente, ANCHO - sangria - (prefijo ? 14 : 0));
    const alto = tam * interlineado;
    y -= antes;
    lineas.forEach((l, i) => {
      if (y - alto < MARGEN + PIE) { nueva(); }
      y -= alto;
      if (prefijo && i === 0) texto(prefijo, MARGEN + sangria, y, tam, fuente, gris);
      texto(l, MARGEN + sangria + (prefijo ? 14 : 0), y, tam, fuente, gris);
    });
    y -= despues;
  };

  bloque(titulo, { tam: 20, fuente: 'F2', despues: 6, interlineado: 1.25 });
  bloque(`Documento generado por ${autor} · ${fecha.toISOString().slice(0, 10)}`, { tam: 9, gris: 0.45, despues: 4 });
  regla(y);
  y -= 12;

  let codigoBloque = false;
  for (const crudo of String(markdown ?? '').replace(/\r/g, '').split('\n')) {
    const l = crudo.replace(/\t/g, '    ');
    if (/^```/.test(l.trim())) { codigoBloque = !codigoBloque; y -= 2; continue; }
    if (codigoBloque) { bloque(l || ' ', { tam: 9, fuente: 'F3', sangria: 8, despues: 0, interlineado: 1.3, gris: 0.2 }); continue; }
    const t = l.trim();
    let m;
    if (!t) { y -= 5; continue; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { y -= 4; if (y < MARGEN + PIE) nueva(); regla(y); y -= 8; continue; }
    if ((m = /^(#{1,3})\s+(.*)$/.exec(t))) {
      const nivel = m[1].length;
      bloque(limpiarInline(m[2]), { tam: [16, 13.5, 12][nivel - 1], fuente: 'F2', antes: nivel === 1 ? 12 : 8, despues: 3, interlineado: 1.25 });
      continue;
    }
    if ((m = /^[-*+]\s+(.*)$/.exec(t))) { bloque(limpiarInline(m[1]), { sangria: 6 + Math.min(3, Math.floor((l.length - l.trimStart().length) / 2)) * 12, prefijo: '•', despues: 2 }); continue; }
    if ((m = /^(\d+)[.)]\s+(.*)$/.exec(t))) { bloque(limpiarInline(m[2]), { sangria: 6, prefijo: `${m[1]}.`, despues: 2 }); continue; }
    if ((m = /^>\s?(.*)$/.exec(t))) { bloque(limpiarInline(m[1]), { sangria: 12, gris: 0.35, despues: 3 }); continue; }
    bloque(limpiarInline(t), { despues: 4 });
  }

  // Pie de página con el número de página (se conoce el total al final).
  const total = paginas.length;
  paginas.forEach((p, i) => {
    p.push(`0.75 G 0.5 w ${MARGEN} ${MARGEN + 12} m ${W - MARGEN} ${MARGEN + 12} l S`);
    p.push(`BT /F1 8 Tf 0.45 0.45 0.45 rg ${MARGEN} ${MARGEN} Td <${hex(`Praxon · ${titulo}`.slice(0, 80))}> Tj ET`);
    const num = `Página ${i + 1} de ${total}`;
    p.push(`BT /F1 8 Tf 0.45 0.45 0.45 rg ${(W - MARGEN - ancho(num, 8, 'F1')).toFixed(2)} ${MARGEN} Td <${hex(num)}> Tj ET`);
  });

  // Objetos: 1 catálogo, 2 páginas, 3-5 fuentes, 6 info, después (página, contenido) por cada página.
  const objetos = [];
  const idPagina = (i) => 7 + i * 2;
  objetos[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objetos[2] = `<< /Type /Pages /Count ${total} /Kids [${paginas.map((_, i) => `${idPagina(i)} 0 R`).join(' ')}] >>`;
  objetos[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objetos[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  objetos[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>';
  const utf16 = `FEFF${[...titulo].map((ch) => ch.codePointAt(0)).filter((n) => n < 0x10000).map((n) => n.toString(16).padStart(4, '0')).join('')}`;
  objetos[6] = `<< /Title <${utf16}> /Producer (Praxon) /CreationDate (D:${fecha.toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z) >>`;
  paginas.forEach((p, i) => {
    const flujo = p.join('\n');
    objetos[idPagina(i)] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W.toFixed(2)} ${H.toFixed(2)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents ${idPagina(i) + 1} 0 R >>`;
    objetos[idPagina(i) + 1] = `<< /Length ${flujo.length} >>\nstream\n${flujo}\nendstream`;
  });

  let out = '%PDF-1.4\n%âãÏÓ\n';
  const offsets = [];
  for (let id = 1; id < objetos.length; id++) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objetos[id]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objetos.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objetos.length; id++) out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objetos.length} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
