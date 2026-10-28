/**
 * Tope de gasto del modelo, dentro de Praxon (segunda barrera detrás del límite del workspace de Anthropic).
 *
 * Gasto = tokens del día (los cuenta UsageTracker con lo que devuelve cada llamada) x una tabla de precios configurable, en euros.
 * Es una ESTIMACIÓN: la cifra exacta es la de la consola de Anthropic. Escalones sobre el tope diario (BUDGET_DAILY_EUR):
 *   aviso   (BUDGET_WARN_PCT, 70 %)  solo queda en la auditoría y en Estado;
 *   recorte (BUDGET_TRIM_PCT, 90 %)  se paran las tareas de fondo (revisión automática y resúmenes); la conversación sigue;
 *   corte   (100 %)                  no se llama más al modelo hasta el día siguiente.
 * Además: presupuesto propio de la revisión automática (BUDGET_TRIAGE_DAILY_EUR) y límite de llamadas por minuto y por hora
 * (frena bucles y usos anómalos aunque no lleguen al tope diario). 0 desactiva cada límite. El día es el de Madrid.
 */
export class BudgetError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BudgetError';
  }
}

const NIVELES = ['normal', 'aviso', 'recorte', 'corte'];
const FONDO = new Set(['revision', 'resumen']);
const r2 = (n) => Math.round(n * 100) / 100;
const eur = (n) => `${r2(n).toFixed(2).replace('.', ',')} €`;

export function precios(config) {
  return {
    input: config.COST_INPUT_USD_MTOK ?? 2,
    output: config.COST_OUTPUT_USD_MTOK ?? 10,
    cacheWrite: config.COST_CACHE_WRITE_USD_MTOK ?? 2.5,
    cacheRead: config.COST_CACHE_READ_USD_MTOK ?? 0.2,
    eurPorUsd: config.COST_EUR_PER_USD ?? 0.9,
  };
}

/** Euros que cuestan unos tokens con esos precios. */
export function costeEur(t, p) {
  const usd = ((t.input ?? 0) * p.input + (t.output ?? 0) * p.output + (t.cacheWrite ?? 0) * p.cacheWrite + (t.cacheRead ?? 0) * p.cacheRead) / 1_000_000;
  return usd * p.eurPorUsd;
}

export class BudgetGuard {
  #tracker;
  #config;
  #audit;
  #now;
  #onLevel;
  #calls = [];
  #dia = null;
  #nivelAvisado = 0;

  constructor({ tracker, config, audit = null, now = Date.now, onLevel = null }) {
    this.#tracker = tracker;
    this.#config = config;
    this.#audit = audit;
    this.#now = now;
    this.#onLevel = onLevel;
  }

  #gasto(uso) {
    const p = precios(this.#config);
    const porModelo = this.#tracker.todayTokens(uso);
    return Object.values(porModelo).reduce((s, t) => s + costeEur(t, p), 0);
  }

  #nivelDe(gasto, tope) {
    if (!(tope > 0)) return 'normal';
    const pct = (gasto / tope) * 100;
    if (pct >= 100) return 'corte';
    if (pct >= (this.#config.BUDGET_TRIM_PCT ?? 90)) return 'recorte';
    if (pct >= (this.#config.BUDGET_WARN_PCT ?? 70)) return 'aviso';
    return 'normal';
  }

  #llamadas() {
    const t = this.#now();
    this.#calls = this.#calls.filter((x) => t - x < 3_600_000);
    return { minuto: this.#calls.filter((x) => t - x < 60_000).length, hora: this.#calls.length };
  }

  /** Foto del estado para el panel y para decidir. */
  status() {
    const tope = this.#config.BUDGET_DAILY_EUR ?? 0;
    const gasto = this.#gasto();
    const topeRev = this.#config.BUDGET_TRIAGE_DAILY_EUR ?? 0;
    return {
      topeEur: tope,
      gastoEur: gasto,
      pct: tope > 0 ? (gasto / tope) * 100 : null,
      nivel: this.#nivelDe(gasto, tope),
      revision: { gastoEur: this.#gasto('revision'), topeEur: topeRev },
      llamadas: { ...this.#llamadas(), maxMinuto: this.#config.BUDGET_MAX_CALLS_PER_MIN ?? 0, maxHora: this.#config.BUDGET_MAX_CALLS_PER_HOUR ?? 0 },
    };
  }

  /** Texto para quien intenta usar el modelo; null si puede. No cuenta la llamada. */
  blocks(uso = 'conversacion') {
    const s = this.status();
    this.#anotarNivel(s);
    if (s.nivel === 'corte') {
      return `He llegado al tope de gasto diario (${eur(s.gastoEur)} de ${eur(s.topeEur)}). El modelo vuelve a estar disponible mañana; si hace falta antes, se sube BUDGET_DAILY_EUR en el servidor.`;
    }
    if (s.nivel === 'recorte' && FONDO.has(uso)) {
      return `Las tareas automáticas están paradas hoy: llevo el ${Math.round(s.pct)} % del tope diario (${eur(s.gastoEur)} de ${eur(s.topeEur)}). La conversación sigue funcionando.`;
    }
    if (uso === 'revision' && s.revision.topeEur > 0 && s.revision.gastoEur >= s.revision.topeEur) {
      return `La revisión automática ha agotado su presupuesto de hoy (${eur(s.revision.gastoEur)} de ${eur(s.revision.topeEur)}). Se reanuda mañana.`;
    }
    const { minuto, hora, maxMinuto, maxHora } = s.llamadas;
    if (maxMinuto > 0 && minuto >= maxMinuto) return `Demasiadas llamadas al modelo en el último minuto (${minuto}). Espera un momento.`;
    if (maxHora > 0 && hora >= maxHora) return `Demasiadas llamadas al modelo en la última hora (${hora}). Espera un rato o sube BUDGET_MAX_CALLS_PER_HOUR.`;
    return null;
  }

  /** Antes de cada llamada al modelo: lanza BudgetError si no se puede, y cuenta la llamada. */
  check(uso = 'conversacion') {
    const motivo = this.blocks(uso);
    if (motivo) throw new BudgetError(motivo);
    this.#calls.push(this.#now());
  }

  #anotarNivel(s) {
    const dia = new Date(this.#now()).toISOString().slice(0, 10);
    if (dia !== this.#dia) {
      this.#dia = dia;
      this.#nivelAvisado = 0;
    }
    const n = NIVELES.indexOf(s.nivel);
    if (n <= this.#nivelAvisado) return;
    this.#nivelAvisado = n;
    const evento = { event: 'budget_level', nivel: s.nivel, gastoEur: r2(s.gastoEur), topeEur: s.topeEur };
    this.#audit?.record(evento).catch?.(() => {});
    try {
      this.#onLevel?.(evento);
    } catch {
      /* un aviso nunca debe romper una llamada */
    }
  }
}

/** Envuelve un modelo: antes de cada llamada pasa por el guardián. `uso` ('conversacion' por defecto, 'revision', 'resumen') lo pone quien llama. */
export class GuardedModel {
  #model;
  #guard;

  constructor(model, guard) {
    this.#model = model;
    this.#guard = guard;
  }

  async *stream(args) {
    this.#guard.check(args.uso ?? 'conversacion');
    yield* this.#model.stream(args);
  }
}
