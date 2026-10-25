import { describe, expect, it } from 'vitest';
import { FakeMyraypa } from '../src/connectors/myraypa/fake.js';
import { ReviewedStore } from '../src/proposals/reviewed.js';
import { ReviewScope } from '../src/proposals/scope.js';
import { serializeResult, resultText } from '../src/tools/result.js';

const T0 = Date.UTC(2026, 9, 23, 8, 0);
const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();

function build() {
  const myraypa = new FakeMyraypa();
  let clock = T0;
  const reviewed = new ReviewedStore(null, { now: () => T0 });
  const config = { TRIAGE_MAX_TICKETS: 6, TRIAGE_WATCH_SETTLE_MINUTES: 3, TRIAGE_REREVIEW: true, TRIAGE_REREVIEW_COOLDOWN_MINUTES: 30, TRIAGE_MAX_REREVIEWS: 3 };
  const scope = new ReviewScope({ myraypa, reviewed, config, now: () => clock });
  return { myraypa, reviewed, scope, at: (ms) => { clock = ms; } };
}

describe('ReviewScope', () => {
  it('nunca incluye el backlog: sin tickets nuevos ni comentarios no hay nada pendiente', async () => {
    const t = build();
    t.at(T0 + 60 * MIN);
    const p = await t.scope.pending({});
    expect(p.batch).toEqual([]);
    expect(p.total).toBe(0);
  });

  it('un ticket nuevo ya asentado entra, y respeta el tope', async () => {
    const t = build();
    for (let i = 0; i < 9; i++) await t.myraypa.createTicket({ proyectoId: 'mes', titulo: `nuevo ${i}` }, 'test');
    for (const x of t.myraypa.tickets.filter((x) => x.titulo.startsWith('nuevo'))) x.creado = iso(T0 + MIN);
    t.at(T0 + 10 * MIN);
    const p = await t.scope.pending({ limit: 6 });
    expect(p.batch).toHaveLength(6);
    expect(p.total).toBe(9);
  });

  it('un comentario nuevo de otra persona reabre un ticket ya revisado, con enfriamiento', async () => {
    const t = build();
    t.at(T0 + 60 * MIN);
    t.reviewed.markSeen('214', T0 + 5 * MIN);
    t.myraypa.tickets.find((x) => x.id === '214').comentarios.push({ texto: 'Mirad esto', autor: 'Ana', fecha: iso(T0 + 20 * MIN) });
    const p = await t.scope.pending({});
    expect(p.batch.map((x) => x.id)).toEqual(['214']);
    expect(p.batch[0].motivo).toBe('comentario nuevo');
    await t.scope.markDone(p.batch);
    expect((await t.scope.pending({})).batch).toEqual([]);
  });

  it('un comentario del propio asistente no provoca re-revisión', async () => {
    const t = build();
    t.at(T0 + 60 * MIN);
    t.reviewed.markSeen('214', T0 + 5 * MIN);
    await t.myraypa.addComment?.('214', 'nota', 'test');
    const tk = t.myraypa.tickets.find((x) => x.id === '214');
    if (!tk.comentarios.length) tk.comentarios.push({ texto: 'nota', origin: 'x', fecha: iso(T0 + 20 * MIN) });
    expect((await t.scope.pending({})).batch).toEqual([]);
  });
});

describe('serializeResult', () => {
  it('JSON normal si no hay imagen', () => {
    expect(serializeResult({ a: 1 })).toBe('{"a":1}');
  });
  it('bloque de imagen + texto si hay _imagen', () => {
    const r = serializeResult({ _imagen: { mediaType: 'image/png', base64: 'AAAA' }, nombre: 'x' });
    expect(r[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
    expect(JSON.parse(r[1].text)).toEqual({ nombre: 'x' });
    expect(resultText(r)).toContain('[imagen]');
  });
});
