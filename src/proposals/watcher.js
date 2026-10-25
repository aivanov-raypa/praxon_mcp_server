import { ReviewScope } from './scope.js';

/**
 * Vigilante de tickets nuevos: cada pocos minutos pregunta a MyRAYPA qué tickets se han creado desde la marca de corte
 * y revisa solo los nuevos que ya "se han asentado" (llevan unos minutos creados, por si se edita justo después).
 * No necesita que MyRAYPA avise a Praxon, y al arrancar recoge lo que se creó mientras estaba apagado.
 * También vuelve a mirar un ticket ya revisado si alguien lo comenta después (con enfriamiento y máximo de veces).
 * La revisión de cada lote es la misma de siempre: solo consulta y propone, nada se ejecuta sin aprobación.
 */
export class TicketWatcher {
  #myraypa;
  #triage;
  #reviewed;
  #config;
  #now;
  #scope;
  #onBriefing;
  #timer = null;
  #first = null;
  #busy = false;

  constructor({ myraypa, triage, reviewed, config, scope = null, now = Date.now, onBriefing = () => {} }) {
    this.#scope = scope ?? new ReviewScope({ myraypa, reviewed, config, now });
    this.#myraypa = myraypa;
    this.#triage = triage;
    this.#reviewed = reviewed;
    this.#config = config;
    this.#now = now;
    this.#onBriefing = onBriefing;
  }

  /** Última fecha de creación de la parte inicial ya resuelta (los más antiguos primero). */
  #resolvedUntil(tickets) {
    let last = null;
    for (const t of tickets) {
      if (!this.#reviewed.isDone(t.id)) break;
      last = t.creado;
    }
    return last;
  }

  /** Una pasada. Devuelve un resumen de lo hecho (para logs y tests). */
  async tick() {
    if (this.#busy || this.#triage.running) return { omitido: true };
    this.#busy = true;
    try {
      const now = this.#now();
      const settleMs = this.#config.TRIAGE_WATCH_SETTLE_MINUTES * 60_000;
      const { tickets: all } = await this.#myraypa.listTickets({ creadosDesde: this.#reviewed.desde, mostrar: 'abiertos', limit: 50 });
      const tickets = all.filter((t) => t.creado);

      const ready = tickets.filter((t) => !this.#reviewed.isDone(t.id) && now - Date.parse(t.creado) >= settleMs);
      // Los nuevos primero; después, los ya revisados con un comentario nuevo. Todo en un lote acotado.
      const comentados = await this.#scope.commented().catch((err) => (console.error('[vigilante]', 'comentarios:', err.message), []));
      const batch = [...ready.map((t) => ({ id: t.id, titulo: t.titulo, proyecto: t.proyecto })), ...comentados].slice(0, this.#config.TRIAGE_WATCH_BATCH);
      let revisados = 0;
      if (batch.length) {
        try {
          const b = await this.#triage.runTickets({
            user: this.#config.PRAXON_USER,
            tickets: batch,
            trigger: batch.every((t) => t.motivo === 'comentario nuevo') ? 'comentario' : 'nuevo',
          });
          if (b.omitida) return { omitido: true };
          await this.#scope.markDone(batch);
          revisados = batch.length;
          if (b.acciones?.length) this.#onBriefing(b);
        } catch (err) {
          for (const t of batch) this.#reviewed.fail(t.id);
          console.error('[vigilante]', `no se han podido revisar ${batch.map((t) => t.id).join(', ')}:`, err.message);
        }
      }
      this.#reviewed.advance(this.#resolvedUntil(tickets));
      await this.#reviewed.save();
      return { nuevos: ready.length, comentados: comentados.length, revisados };
    } finally {
      this.#busy = false;
    }
  }

  start() {
    if (this.#timer) return;
    const run = () => this.tick().catch((err) => console.error('[vigilante]', err.message));
    this.#timer = setInterval(run, this.#config.TRIAGE_WATCH_MINUTES * 60_000);
    this.#timer.unref();
    this.#first = setTimeout(run, 5_000); // al arrancar, recoge lo creado mientras estaba apagado
    this.#first.unref();
  }

  stop() {
    clearInterval(this.#timer);
    clearTimeout(this.#first);
    this.#timer = null;
    this.#first = null;
  }
}
