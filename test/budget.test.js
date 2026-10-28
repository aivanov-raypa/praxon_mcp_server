import { describe, expect, it } from 'vitest';
import { BudgetGuard, BudgetError, GuardedModel, costeEur, precios } from '../src/safety/budget.js';
import { UsageTracker } from '../src/usage/tracker.js';
import { MemoryAudit } from '../src/audit/log.js';
import { AnthropicModel } from '../src/model/anthropic.js';
import { ScriptedModel } from '../src/model/scripted.js';
import { Triage } from '../src/proposals/triage.js';
import { ProposalStore } from '../src/proposals/store.js';
import { createPanels } from '../src/panels.js';
import { loadConfig } from '../src/config.js';
import { config as baseConfig, setup, stubModel } from './helpers.js';

const cfg = loadConfig({ PRAXON_TOKEN: 'token-largo-123456' });
const MODELO = 'claude-sonnet-5-5';
// Con los precios por defecto, 1 millón de tokens de salida cuestan 10 USD x 0,9 = 9 €.
const salida = (millones) => ({ model: MODELO, output: millones * 1_000_000 });

function montar({ now = () => Date.UTC(2026, 9, 27, 10, 0), config = {} } = {}) {
  const tracker = new UsageTracker(null, { now });
  const audit = new MemoryAudit();
  const guard = new BudgetGuard({ tracker, config: { ...cfg, ...config }, audit, now });
  return { tracker, audit, guard };
}

describe('coste', () => {
  it('convierte tokens a euros con la tabla de precios', () => {
    const p = precios(cfg);
    expect(costeEur({ output: 1_000_000 }, p)).toBeCloseTo(9, 5);
    expect(costeEur({ input: 1_000_000 }, p)).toBeCloseTo(1.8, 5);
    expect(costeEur({ cacheRead: 1_000_000 }, p)).toBeCloseTo(0.18, 5);
    expect(costeEur({ cacheWrite: 1_000_000 }, p)).toBeCloseTo(2.25, 5);
  });
});

describe('escalones del tope diario (5 €)', () => {
  it('normal, aviso (70 %), recorte (90 %) y corte (100 %)', () => {
    const t = montar();
    expect(t.guard.status().nivel).toBe('normal');
    t.tracker.recordModel(salida(0.4)); // 3,60 € = 72 %
    expect(t.guard.status()).toMatchObject({ nivel: 'aviso', topeEur: 5 });
    t.tracker.recordModel(salida(0.1)); // 4,50 € = 90 %
    expect(t.guard.status().nivel).toBe('recorte');
    t.tracker.recordModel(salida(0.06)); // 5,04 € = 100 %+
    expect(t.guard.status().nivel).toBe('corte');
  });

  it('el aviso no bloquea nada', () => {
    const t = montar();
    t.tracker.recordModel(salida(0.4));
    for (const uso of ['conversacion', 'revision', 'resumen']) expect(t.guard.blocks(uso)).toBeNull();
  });

  it('el recorte para las tareas de fondo pero deja hablar', () => {
    const t = montar();
    t.tracker.recordModel({ ...salida(0.5), uso: 'conversacion' });
    expect(t.guard.blocks('conversacion')).toBeNull();
    expect(t.guard.blocks('revision')).toMatch(/tareas automáticas están paradas/);
    expect(t.guard.blocks('resumen')).toMatch(/tareas automáticas están paradas/);
  });

  it('el corte no deja llamar al modelo y dice cómo subir el tope', () => {
    const t = montar();
    t.tracker.recordModel(salida(0.6));
    expect(() => t.guard.check('conversacion')).toThrow(BudgetError);
    expect(t.guard.blocks('conversacion')).toMatch(/tope de gasto diario.*BUDGET_DAILY_EUR/);
  });

  it('con tope 0 no hay límite de gasto', () => {
    const t = montar({ config: { BUDGET_DAILY_EUR: 0 } });
    t.tracker.recordModel(salida(5));
    expect(t.guard.status().nivel).toBe('normal');
    expect(t.guard.blocks('conversacion')).toBeNull();
  });

  it('al día siguiente (Madrid) vuelve a empezar', () => {
    let ahora = Date.UTC(2026, 9, 27, 21, 0); // 22:00 en Madrid
    const t = montar({ now: () => ahora });
    t.tracker.recordModel(salida(0.6));
    expect(t.guard.status().nivel).toBe('corte');
    ahora = Date.UTC(2026, 9, 27, 23, 30); // 00:30 del 28 en Madrid
    expect(t.guard.status().nivel).toBe('normal');
    expect(t.guard.blocks('conversacion')).toBeNull();
  });
});

describe('presupuesto propio de la revisión automática', () => {
  it('se agota aparte: bloquea revisiones aunque el total esté bajo, y la conversación sigue', () => {
    const t = montar();
    t.tracker.recordModel({ ...salida(0.17), uso: 'revision' }); // 1,53 € >= 1,5 €
    expect(t.guard.status().nivel).toBe('normal');
    expect(t.guard.blocks('revision')).toMatch(/presupuesto de hoy/);
    expect(t.guard.blocks('conversacion')).toBeNull();
  });
});

describe('límite de llamadas', () => {
  it('por minuto: bloquea al llegar al máximo y se libera con el tiempo', () => {
    let ahora = Date.UTC(2026, 9, 27, 10, 0);
    const t = montar({ now: () => ahora, config: { BUDGET_MAX_CALLS_PER_MIN: 3 } });
    for (let i = 0; i < 3; i++) t.guard.check();
    expect(() => t.guard.check()).toThrow(/último minuto/);
    ahora += 61_000;
    expect(() => t.guard.check()).not.toThrow();
  });

  it('por hora, y las llamadas bloqueadas no cuentan', () => {
    let ahora = Date.UTC(2026, 9, 27, 10, 0);
    const t = montar({ now: () => ahora, config: { BUDGET_MAX_CALLS_PER_MIN: 0, BUDGET_MAX_CALLS_PER_HOUR: 2 } });
    t.guard.check();
    t.guard.check();
    for (let i = 0; i < 5; i++) expect(() => t.guard.check()).toThrow(/última hora/);
    ahora += 3_601_000;
    expect(() => t.guard.check()).not.toThrow();
    expect(t.guard.status().llamadas.hora).toBe(1);
  });
});

describe('avisos en la auditoría', () => {
  it('anota cada escalón una sola vez al día', () => {
    const t = montar();
    t.guard.blocks();
    t.tracker.recordModel(salida(0.4));
    t.guard.blocks();
    t.guard.blocks();
    t.tracker.recordModel(salida(0.1));
    t.guard.blocks();
    t.tracker.recordModel(salida(0.1));
    t.guard.blocks();
    expect(t.audit.of('budget_level').map((e) => e.nivel)).toEqual(['aviso', 'recorte', 'corte']);
    expect(t.audit.of('budget_level')[0]).toMatchObject({ topeEur: 5 });
  });
});

describe('UsageTracker por uso y día de Madrid', () => {
  it('separa los tokens por uso y por modelo', () => {
    const t = montar();
    t.tracker.recordModel({ model: 'a', input: 10, uso: 'revision' });
    t.tracker.recordModel({ model: 'a', input: 5 });
    expect(t.tracker.todayTokens('revision').a).toMatchObject({ input: 10, calls: 1 });
    expect(t.tracker.todayTokens().a).toMatchObject({ input: 15 });
    expect(t.tracker.todayTokens('resumen')).toEqual({});
  });
});

describe('GuardedModel', () => {
  it('delega si se puede y pasa el uso; si no, lanza antes de llamar', async () => {
    const t = montar();
    const model = stubModel([{ type: 'text', text: 'hola' }]);
    const g = new GuardedModel(model, t.guard);
    const out = [];
    for await (const ev of g.stream({ messages: [], uso: 'revision' })) out.push(ev);
    expect(out.at(-1).type).toBe('message');
    expect(model.calls[0].uso).toBe('revision');
    t.tracker.recordModel(salida(0.6));
    const bloqueado = stubModel([{ type: 'text', text: 'no debe salir' }]);
    await expect((async () => { for await (const _ of new GuardedModel(bloqueado, t.guard).stream({ messages: [] })); })()).rejects.toBeInstanceOf(BudgetError);
    expect(bloqueado.calls).toHaveLength(0);
  });

  it('AnthropicModel apunta el uso en el contador', async () => {
    const usos = [];
    const client = {
      messages: {
        stream: () => ({
          async *[Symbol.asyncIterator]() {},
          async finalMessage() { return { model: MODELO, content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn', usage: { input_tokens: 7, output_tokens: 3 } }; },
        }),
      },
    };
    const m = new AnthropicModel({ client, onUsage: (u) => usos.push(u) });
    for await (const _ of m.stream({ system: 's', messages: [{ role: 'user', content: 'hola' }], tools: [], model: MODELO, uso: 'revision' }));
    expect(usos[0]).toMatchObject({ input: 7, output: 3, uso: 'revision' });
  });
});

describe('quién deja de funcionar', () => {
  it('la revisión automática no se lanza (ni se llama al modelo) y devuelve el motivo', async () => {
    const s = setup();
    const model = stubModel([{ type: 'text', text: 'no' }]);
    const triage = new Triage({ model, registry: s.registry, audit: s.audit, store: new ProposalStore(null), config: { ...baseConfig, ...cfg }, budget: { blocks: (uso) => (uso === 'revision' ? 'Presupuesto agotado' : null) } });
    const r = await triage.run({ user: 'alex', trigger: 'manual' });
    expect(r.omitida).toBe('Presupuesto agotado');
    expect(model.calls).toHaveLength(0);
  });

  it('en una conversación, el usuario oye el motivo y no un error genérico', async () => {
    const t = montar();
    t.tracker.recordModel(salida(0.6));
    const s = setup({ model: new GuardedModel(new ScriptedModel(), t.guard) });
    await s.orchestrator.handleUserText(s.session, { text: '¿Qué hay abierto en calibraciones?' }, s.emit);
    const err = s.last('error');
    expect(err.message).toMatch(/tope de gasto diario/);
  });
});

describe('panel de Estado', () => {
  const owner = { kind: 'device', user: 'alex', email: 'alex@raypa.com', deviceId: 'd1' };
  const fila = async (tracker, extra = {}) => {
    const t = montar();
    const s = setup();
    const panels = createPanels({
      config: { MODEL_PROVIDER: 'scripted', VOICE_PROVIDER: 'none', STT_PROVIDER: 'none', MERGE_ALLOWED_USERS: ['alex@raypa.com'], HOST: '127.0.0.1' },
      budget: t.guard, myraypa: s.myraypa, audit: s.audit, registry: s.registry, toolControl: { set() {} }, isOwner: () => true,
    });
    tracker?.(t.tracker);
    return (await panels.get({ panel: 'status' }, owner)).secciones.flatMap((x) => x.filas).find((f) => f.id === 'presupuesto');
  };

  it('muestra gasto, tope, revisiones y llamadas, con el estado del escalón', async () => {
    const normal = await fila();
    expect(normal.titulo).toBe('Tope de gasto diario');
    expect(normal.detalle).toMatch(/0,00 € de 5,00 € hoy \(0 %\).*revisiones 0,00 € de 1,50 €.*llamadas 0\/40.*0\/600/);
    expect(normal.chips[0]).toMatchObject({ texto: 'NORMAL', estado: 'ok' });
    const corte = await fila((tr) => tr.recordModel(salida(0.6)));
    expect(corte.chips[0]).toMatchObject({ texto: 'CORTADO', estado: 'error' });
  });
});
