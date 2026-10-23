import { describe, expect, it, vi } from 'vitest';
import { AnthropicModel } from '../src/model/anthropic.js';
import { ElevenLabsVoice } from '../src/voice/elevenlabs.js';
import { UsageService } from '../src/usage/service.js';
import { anthropicUsage, elevenLabsUsage, githubUsage } from '../src/usage/providers.js';
import { UsageTracker } from '../src/usage/tracker.js';

const T0 = Date.UTC(2026, 9, 23, 12, 0);
const DAY = 86_400_000;
const json = (o, status = 200) => new Response(JSON.stringify(o), { status });

describe('contadores propios', () => {
  it('agrega tokens por dia y modelo, y rellena los dias sin actividad', () => {
    let clock = T0 - DAY;
    const t = new UsageTracker(null, { now: () => clock });
    t.recordModel({ model: 'haiku', input: 100, output: 20, cacheRead: 5 });
    clock = T0;
    t.recordModel({ model: 'haiku', input: 50, output: 10 });
    t.recordModel({ model: 'sonnet', input: 10, output: 90, cacheWrite: 7 });
    t.recordTts(120);
    t.recordStt(3.4);
    const s = t.summary(3);
    expect(s.serie.map((d) => d.fecha)).toEqual(['2026-10-21', '2026-10-22', '2026-10-23']);
    expect(s.serie[0].input).toBe(0);
    expect(s.serie[1]).toMatchObject({ input: 100, output: 20, calls: 1 });
    expect(s.serie[2]).toMatchObject({ input: 60, output: 100, ttsChars: 120, sttSeconds: 3 });
    expect(s.totales).toMatchObject({ input: 160, output: 120, cacheRead: 5, cacheWrite: 7, calls: 3, ttsChars: 120 });
    expect(s.modelos.map((m) => m.modelo)).toEqual(['haiku', 'sonnet']);
  });

  it('el modelo y la voz informan de lo que gastan sin romperse si el contador falla', async () => {
    const seen = [];
    const client = {
      messages: {
        stream: () => ({
          async *[Symbol.asyncIterator]() {},
          finalMessage: async () => ({ model: 'm1', content: [], stop_reason: 'end_turn', usage: { input_tokens: 11, output_tokens: 4, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 } }),
        }),
      },
    };
    const model = new AnthropicModel({ client, onUsage: (u) => seen.push(u) });
    for await (const _ of model.stream({ system: 's', messages: [], tools: [], model: 'm1' })) void _;
    expect(seen).toEqual([{ model: 'm1', input: 11, output: 4, cacheRead: 2, cacheWrite: 1 }]);

    const chars = [];
    const voice = new ElevenLabsVoice({ apiKey: 'k', voiceId: 'v', fetchImpl: async () => new Response(Buffer.from('mp3')), onUsage: (u) => chars.push(u.chars) });
    await voice.synthesize('Hola mundo');
    expect(chars).toEqual([10]);
    const broken = new ElevenLabsVoice({ apiKey: 'k', voiceId: 'v', fetchImpl: async () => new Response(Buffer.from('mp3')), onUsage: () => { throw new Error('x'); } });
    await expect(broken.synthesize('Hola')).resolves.toMatchObject({ format: 'mp3' });
  });
});

describe('proveedores', () => {
  it('sin credencial salen "sin configurar"', async () => {
    expect((await githubUsage({ token: undefined, org: 'o' })()).estado).toBe('sin_configurar');
    expect((await anthropicUsage({ adminKey: undefined })()).estado).toBe('sin_configurar');
    expect((await elevenLabsUsage({ apiKey: undefined })()).estado).toBe('sin_configurar');
  });

  it('ElevenLabs: caracteres usados, limite y reinicio', async () => {
    const fetchImpl = vi.fn(async () => json({ tier: 'creator', status: 'active', character_count: 1200, character_limit: 100000, next_character_count_reset_unix: 1793000000 }));
    const r = await elevenLabsUsage({ apiKey: 'k', fetchImpl })();
    expect(r).toMatchObject({ estado: 'ok', plan: 'creator', usados: 1200, limite: 100000 });
    expect(fetchImpl.mock.calls[0][0]).toContain('/v1/user/subscription');
    expect(fetchImpl.mock.calls[0][1].headers['xi-api-key']).toBe('k');
  });

  it('GitHub: agrega por producto y suma los minutos de Actions', async () => {
    const fetchImpl = async () =>
      json({ usageItems: [
        { date: '2026-10-23T00:00:00Z', product: 'actions', sku: 'Actions Linux', unitType: 'Minutes', quantity: 14, grossAmount: 0.08, netAmount: 0 },
        { date: '2026-10-24T00:00:00Z', product: 'actions', sku: 'Actions Linux', unitType: 'Minutes', quantity: 6, grossAmount: 0.04, netAmount: 0 },
      ] });
    const r = await githubUsage({ token: 't', org: 'raypa-it', fetchImpl, now: () => T0 })();
    expect(r).toMatchObject({ estado: 'ok', mes: '2026-10', minutosActions: 20, totalBruto: 0.12, totalFacturado: 0 });
    expect(r.items).toHaveLength(1);
    expect(r.serieMinutos).toHaveLength(2);
  });

  it('Anthropic: coste del mes (en centimos) y tokens por modelo', async () => {
    const fetchImpl = async (url) =>
      String(url).includes('cost_report')
        ? json({ data: [{ starting_at: '2026-10-22T00:00:00Z', results: [{ amount: '150.5' }, { amount: '49.5' }] }] })
        : json({ data: [{ starting_at: '2026-10-22T00:00:00Z', results: [{ model: 'm', uncached_input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 50, cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 5 } }] }] });
    const r = await anthropicUsage({ adminKey: 'a', fetchImpl, now: () => T0 })();
    expect(r).toMatchObject({ estado: 'ok', gastoMes: 2, serie: [{ fecha: '2026-10-22', coste: 2 }] });
    expect(r.modelos[0]).toMatchObject({ modelo: 'm', input: 1000, output: 200, cacheRead: 50, cacheWrite: 15 });
  });

  it('un error de credencial se explica sin romper', async () => {
    const r = await githubUsage({ token: 't', org: 'o', fetchImpl: async () => json({}, 403) })();
    expect(r).toMatchObject({ estado: 'error' });
    expect(r.mensaje).toMatch(/permiso/);
  });
});

describe('servicio', () => {
  it('cachea los proveedores externos y aísla sus fallos', async () => {
    let clock = T0;
    const eleven = vi.fn(async () => ({ estado: 'ok', usados: 1, limite: 2 }));
    const gh = vi.fn(async () => { throw new Error('caído'); });
    const svc = new UsageService({ tracker: new UsageTracker(null, { now: () => clock }), providers: { elevenlabs: eleven, github: gh }, cacheMs: 600_000, now: () => clock });
    const a = await svc.get();
    expect(a.elevenlabs.estado).toBe('ok');
    expect(a.github.estado).toBe('error');
    expect(a.anthropic.estado).toBe('sin_configurar');
    expect(a.praxon.serie).toHaveLength(14);
    await svc.get();
    expect(eleven).toHaveBeenCalledTimes(1);
    await svc.get({ refresh: true });
    expect(eleven).toHaveBeenCalledTimes(2);
    clock += 31_000;
    await svc.get();
    expect(gh.mock.calls.length).toBeGreaterThanOrEqual(3); // el error se reintenta pronto
  });
});
