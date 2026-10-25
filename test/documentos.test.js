import { describe, expect, it } from 'vitest';
import { markdownToPdf } from '../src/documents/pdf.js';
import { cuerpoSinTitulo, nombreArchivo } from '../src/connectors/myraypa/tools/documentos.js';
import { setup } from './helpers.js';

describe('PDF de documentos', () => {
  it('genera un PDF válido con varias páginas y pie numerado', () => {
    const md = `# Plan\n\n## Objetivos\n\n- uno\n- dos\n\n${'Texto de relleno con acentos: camión, ñandú. '.repeat(40)}\n\n`.repeat(14);
    const pdf = markdownToPdf({ titulo: 'Plan de año', markdown: md, fecha: new Date('2026-10-25T10:00:00Z') });
    const t = pdf.toString('latin1');
    expect(t.startsWith('%PDF-1.4')).toBe(true);
    expect(t.trimEnd().endsWith('%%EOF')).toBe(true);
    const paginas = Number(/\/Count (\d+)/.exec(t)[1]);
    expect(paginas).toBeGreaterThan(1);
    expect(t).toContain(`${Buffer.from(`Página 1 de ${paginas}`, 'latin1').toString('hex')}`);
    // El xref apunta a los objetos de verdad.
    const xref = Number(/startxref\n(\d+)/.exec(t)[1]);
    expect(t.slice(xref, xref + 4)).toBe('xref');
    const primero = Number(/0000000000 65535 f \n(\d{10})/.exec(t)[1]);
    expect(t.slice(primero, primero + 7)).toBe('1 0 obj');
  });

  it('no revienta con texto vacío, caracteres raros ni palabras enormes', () => {
    expect(() => markdownToPdf({ titulo: 'x', markdown: '' })).not.toThrow();
    expect(() => markdownToPdf({ titulo: '日本語 😀', markdown: `${'a'.repeat(500)}\n\n\`\`\`\ncódigo\n\`\`\`\n> cita\n1. uno` })).not.toThrow();
  });
});

describe('guardar_documento', () => {
  const sess = { user: 'alex', id: 's1' };
  const get = (t) => t.registry.get('myraypa_guardar_documento');
  const contenido = '## Objetivo\n\nDejar listo el informe de calibraciones del trimestre.\n\n- Revisar datos\n- Emitir certificados';

  it('nombres de archivo y título duplicado', () => {
    expect(nombreArchivo('Plan: Calibración Año 2026!', 'pdf')).toBe('plan-calibracion-ano-2026.pdf');
    expect(cuerpoSinTitulo('Plan', '# Plan\n\nTexto')).toBe('Texto');
    expect(cuerpoSinTitulo('Plan', '# Otro\n\nTexto')).toBe('# Otro\n\nTexto');
  });

  it('es una escritura que pide confirmación y exige ticket o proyecto, uno solo', () => {
    const t = setup();
    const tool = get(t);
    expect(tool.risk).toBe('write');
    expect(tool.input.safeParse({ titulo: 'Plan', contenido }).success).toBe(false);
    expect(tool.input.safeParse({ ticketId: '214', proyectoId: 'mes', titulo: 'Plan', contenido }).success).toBe(false);
    expect(tool.input.safeParse({ proyectoId: 'mes', destino: 'comentario', titulo: 'Plan', contenido }).success).toBe(false);
    expect(tool.input.safeParse({ ticketId: '214', titulo: 'Plan', contenido }).success).toBe(true);
  });

  it('adjunta un PDF a un ticket', async () => {
    const t = setup();
    const tool = get(t);
    const args = tool.input.parse({ ticketId: '214', titulo: 'Plan trimestral', contenido });
    expect(await tool.summarize(args, { session: sess })).toMatch(/adjuntarlo al ticket Faltantes OF semana 43 como plan-trimestral\.pdf/);
    const r = await tool.execute(args, { session: sess });
    expect(r).toMatchObject({ ok: true, nombre: 'plan-trimestral.pdf', formato: 'pdf', destino: 'ticket' });
    const adj = t.myraypa.tickets.find((x) => x.id === '214').adjuntos.at(-1);
    expect(adj).toMatchObject({ nombre: 'plan-trimestral.pdf', tipo: 'application/pdf' });
  });

  it('en Markdown con destino comentario deja el texto y un comentario', async () => {
    const t = setup();
    const tool = get(t);
    const args = tool.input.parse({ ticketId: '214', titulo: 'Notas', contenido, formato: 'md', destino: 'comentario', comentario: 'Adjunto las notas' });
    await tool.execute(args, { session: sess });
    const tk = t.myraypa.tickets.find((x) => x.id === '214');
    expect(tk.adjuntos.at(-1).texto).toContain('# Notas');
    expect(tk.adjuntos.at(-1).texto).toContain('Revisar datos');
    expect(tk.comentarios.at(-1).texto).toBe('Adjunto las notas');
  });

  it('en un proyecto crea el ticket Documentación la primera vez y lo reutiliza después', async () => {
    const t = setup();
    const tool = get(t);
    const args = tool.input.parse({ proyectoId: 'calibraciones', titulo: 'Plan', contenido });
    expect(await tool.summarize(args, { session: sess })).toMatch(/todavía no existe: lo creo/);
    const r1 = await tool.execute(args, { session: sess });
    expect(r1.ticketDocumentacionCreado).toBe(true);
    const docs = t.myraypa.tickets.filter((x) => x.titulo === 'Documentación');
    expect(docs).toHaveLength(1);
    expect(docs[0].adjuntos).toHaveLength(1);
    expect(await tool.summarize(args, { session: sess })).not.toMatch(/lo creo/);
    const r2 = await tool.execute({ ...args, titulo: 'Plan 2' }, { session: sess });
    expect(r2.ticketDocumentacionCreado).toBeUndefined();
    expect(t.myraypa.tickets.filter((x) => x.titulo === 'Documentación')).toHaveLength(1);
    expect(docs[0].adjuntos).toHaveLength(2);
  });

  it('respeta la autonomía del proyecto', async () => {
    const t = setup();
    const tool = get(t);
    const args = tool.input.parse({ ticketId: '401', titulo: 'Plan', contenido }); // proyecto Incidencias: solo consulta
    await expect(tool.execute(args, { session: sess })).rejects.toThrow(/autonomía/);
  });
});
