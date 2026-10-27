import { describe, expect, it } from 'vitest';
import { compactar, htmlATexto } from '../src/tools/compact.js';
import { ajustar, serializeResult } from '../src/tools/result.js';
import { withCacheBreakpoint } from '../src/model/anthropic.js';
import { FakeMyraypa } from '../src/connectors/myraypa/fake.js';
import { createMyraypaConnector } from '../src/connectors/myraypa/index.js';
import { ToolRegistry } from '../src/tools/registry.js';

describe('compactar', () => {
  it('quita vacíos pero conserva false y 0', () => {
    expect(compactar({ a: null, b: '', c: [], d: {}, e: false, f: 0, g: 'x', h: undefined })).toEqual({ e: false, f: 0, g: 'x' });
  });

  it('acorta fechas ISO: sin segundos, y solo el día si es medianoche UTC', () => {
    expect(compactar({ a: '2026-10-27T13:28:50.536Z', b: '2026-10-27T00:00:00.000Z', c: '2026-10-27' })).toEqual({ a: '2026-10-27T13:28Z', b: '2026-10-27', c: '2026-10-27' });
  });

  it('convierte HTML a texto y conserva enlaces e imágenes marcadas', () => {
    expect(htmlATexto('<p>Hola &amp; adiós</p><p>Mira <a href="https://x.es/a">esto</a></p>')).toBe('Hola & adiós\nMira esto (https://x.es/a)');
    expect(compactar({ t: '<p>Texto [imagen 1]</p>' })).toEqual({ t: 'Texto [imagen 1]' });
    expect(compactar({ t: 'a < b y c > d' })).toEqual({ t: 'a < b y c > d' });
  });

  it('pasa listas de 3 o más objetos planos a columnas y filas, y deja las cortas como están', () => {
    const lista = [{ id: '1', titulo: 'A', prio: 'alta' }, { id: '2', titulo: 'B' }, { id: '3', titulo: 'C', prio: 'baja' }];
    expect(compactar({ tickets: lista })).toEqual({ tickets: { columnas: ['id', 'titulo', 'prio'], filas: [['1', 'A', 'alta'], ['2', 'B', null], ['3', 'C', 'baja']] } });
    expect(compactar({ tickets: lista.slice(0, 2) })).toEqual({ tickets: lista.slice(0, 2) });
    // un nivel de objeto anidado se aplana con punto; más profundo, la lista queda como está
    expect(compactar({ x: [{ a: { b: 1 } }, { a: { b: 2 } }, { a: { b: 3 } }] }).x).toEqual({ columnas: ['a.b'], filas: [[1], [2], [3]] });
    const hondo = [{ a: { b: { c: 1 } } }, { a: { b: { c: 2 } } }, { a: { b: { c: 3 } } }];
    expect(compactar({ x: hondo }).x).toEqual(hondo);
  });

  it('la forma compacta es más corta que la original', () => {
    const lista = Array.from({ length: 10 }, (_, i) => ({ id: String(i), titulo: `Ticket ${i}`, prioridad: 'media', estado: 'En progreso', asignado: 'alex', vencimiento: null }));
    expect(JSON.stringify(compactar({ tickets: lista })).length).toBeLessThan(JSON.stringify({ tickets: lista }).length * 0.6);
  });

  it('recorta textos largos indicando cuánto', () => {
    const r = compactar({ d: 'x'.repeat(100) }, { maxStr: 40 });
    expect(r.d).toMatch(/^x{40}… \[recortado: 60 caracteres más\]$/);
  });
});

describe('serializeResult', () => {
  it('si no cabe, produce JSON válido recortando textos y listas, no un trozo roto', () => {
    const grande = { descripcion: 'y'.repeat(20000), comentarios: Array.from({ length: 80 }, (_, i) => ({ autor: 'a', texto: `comentario ${i} ${'z'.repeat(400)}` })) };
    const s = ajustar(grande, 8000);
    expect(s.length).toBeLessThanOrEqual(8000);
    const parsed = JSON.parse(s);
    expect(parsed.recortado).toBeUndefined();
    expect(parsed.descripcion).toMatch(/recortado/);
  });

  it('un resultado imposible de reducir cae al corte con aviso, también como JSON válido', () => {
    const claves = Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`k${i}`, i + 1]));
    const parsed = JSON.parse(ajustar(claves, 1000));
    expect(parsed.recortado).toBe(true);
    expect(parsed.aviso).toMatch(/más concreto/);
  });

  it('las imágenes siguen yendo como bloque aparte', () => {
    const out = serializeResult({ _imagen: { mediaType: 'image/png', base64: 'AAAA' }, imagen: { n: 1 } });
    expect(out[0].type).toBe('image');
    expect(JSON.parse(out[1].text)).toEqual({ imagen: { n: 1 } });
  });
});

describe('withCacheBreakpoint', () => {
  const marca = { cache_control: { type: 'ephemeral' } };
  it('marca el último bloque sin tocar el original', () => {
    const msgs = [{ role: 'user', content: 'hola' }];
    expect(withCacheBreakpoint(msgs)[0].content).toEqual([{ type: 'text', text: 'hola', ...marca }]);
    expect(msgs[0].content).toBe('hola');
    const tr = [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: '1' }, { type: 'tool_result', tool_use_id: 'b', content: '2' }] }];
    const out = withCacheBreakpoint(tr);
    expect(out[0].content[1]).toMatchObject({ tool_use_id: 'b', ...marca });
    expect(out[0].content[0].cache_control).toBeUndefined();
    expect(tr[0].content[1].cache_control).toBeUndefined();
  });
  it('no marca razonamiento ni texto vacío', () => {
    const a = [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'x', signature: 's' }] }];
    expect(withCacheBreakpoint(a)).toBe(a);
    const b = [{ role: 'user', content: '' }];
    expect(withCacheBreakpoint(b)).toBe(b);
    expect(withCacheBreakpoint([])).toEqual([]);
  });
});

describe('adjuntos grandes', () => {
  const montar = async (config) => {
    const myraypa = new FakeMyraypa();
    const tk = myraypa.tickets.find((t) => t.id === '215');
    tk.adjuntos = [
      { nombre: 'especificacion.pdf', tipo: 'application/pdf', texto: 'contenido corto', tamanoKB: 50 },
      { nombre: 'manual-completo.pdf', tipo: 'application/pdf', texto: 'contenido enorme', tamanoKB: 2048 },
      { nombre: 'foto.heic', tipo: 'image/heic', tamanoKB: 5000 },
    ];
    const registry = new ToolRegistry().registerConnector(createMyraypaConnector({ client: myraypa, config }));
    const run = (name, args, ctx = {}) => registry.get(`myraypa_${name}`).execute(args, { session: {}, user: 'alex', ...ctx });
    return { run };
  };

  it('el listado marca como grandes solo los legibles por encima del umbral', async () => {
    const { run } = await montar({ ATTACH_CONFIRM_KB: 300 });
    const r = await run('listar_adjuntos_ticket', { ticketId: '215' });
    expect(r.adjuntos.map((a) => a.grande ?? false)).toEqual([false, true, false]);
  });

  it('un adjunto pequeño se lee sin preguntar', async () => {
    const { run } = await montar({ ATTACH_CONFIRM_KB: 300 });
    expect((await run('leer_adjunto_ticket', { ticketId: '215', adjunto: '1' })).contenido).toBe('contenido corto');
  });

  it('uno grande pide confirmación, por número o por nombre, y no lee nada', async () => {
    const { run } = await montar({ ATTACH_CONFIRM_KB: 300 });
    for (const ref of ['2', 'manual']) {
      const r = await run('leer_adjunto_ticket', { ticketId: '215', adjunto: ref });
      expect(r).toMatchObject({ requiereConfirmacion: true, adjunto: 'manual-completo.pdf', tamano: '2,0 MB' });
      expect(r.contenido).toBeUndefined();
    }
  });

  it('con confirmado en true, o al seguir leyendo por páginas, lo lee', async () => {
    const { run } = await montar({ ATTACH_CONFIRM_KB: 300 });
    expect((await run('leer_adjunto_ticket', { ticketId: '215', adjunto: '2', confirmado: true })).contenido).toBe('contenido enorme');
    expect((await run('leer_adjunto_ticket', { ticketId: '215', adjunto: '2', desde: 5 })).contenido).toBeDefined();
  });

  it('en la revisión automática se omite y nunca se lee, aunque el modelo pase confirmado', async () => {
    const { run } = await montar({ ATTACH_CONFIRM_KB: 300 });
    for (const confirmado of [undefined, false, true]) {
      const r = await run('leer_adjunto_ticket', { ticketId: '215', adjunto: '2', confirmado }, { automatica: true });
      expect(r).toMatchObject({ omitido: true, adjunto: 'manual-completo.pdf' });
      expect(r.contenido).toBeUndefined();
    }
  });

  it('con umbral 0 no hay límite', async () => {
    const { run } = await montar({ ATTACH_CONFIRM_KB: 0 });
    expect((await run('leer_adjunto_ticket', { ticketId: '215', adjunto: '2' })).contenido).toBe('contenido enorme');
  });
});

describe('cliente HTTP', () => {
  it('envía comentadosDesde al listar tickets (la revisión por comentarios nuevos depende de ello)', async () => {
    const { HttpMyraypaClient } = await import('../src/connectors/myraypa/client.js');
    let url;
    const c = new HttpMyraypaClient({ baseUrl: 'http://x/api', token: 't', fetchImpl: async (u) => { url = String(u); return { ok: true, status: 200, json: async () => ({ tickets: [] }) }; } });
    await c.listTickets({ comentadosDesde: '2026-10-27T13:28:50.536Z', mostrar: 'abiertos' });
    expect(new URL(url).searchParams.get('comentadosDesde')).toBe('2026-10-27T13:28:50.536Z');
  });
});
