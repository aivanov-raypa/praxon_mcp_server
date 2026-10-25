/**
 * Qué tickets revisa Praxon por su cuenta. NUNCA el backlog: solo (1) los tickets creados desde la marca de corte (el
 * arranque del servidor) que aún no se han revisado y (2) los ya revisados que han recibido un comentario nuevo
 * (con enfriamiento y un máximo de re-revisiones). Lo demás se revisa solo si el usuario lo pide de forma explícita.
 * Siempre con un tope por revisión para acotar el gasto.
 */
export class ReviewScope {
  #myraypa;
  #reviewed;
  #config;
  #now;

  constructor({ myraypa, reviewed, config, now = Date.now }) {
    this.#myraypa = myraypa;
    this.#reviewed = reviewed;
    this.#config = config;
    this.#now = now;
  }

  get reviewed() {
    return this.#reviewed;
  }

  /** Tickets con comentario nuevo en un ticket ya revisado, listos para otra revisión. */
  async commented() {
    if (!this.#config.TRIAGE_REREVIEW) return [];
    const now = this.#now();
    const { tickets = [] } = await this.#myraypa.listTickets({ comentadosDesde: this.#reviewed.desde, mostrar: 'abiertos', limit: 50 });
    const opts = { cooldownMs: (this.#config.TRIAGE_REREVIEW_COOLDOWN_MINUTES ?? 30) * 60_000, max: this.#config.TRIAGE_MAX_REREVIEWS ?? 3 };
    return tickets
      .filter((t) => this.#reviewed.canRereview(t.id, t.ultimoComentario, now, opts))
      .map((t) => ({ id: t.id, titulo: t.titulo, proyecto: t.proyecto, motivo: 'comentario nuevo' }));
  }

  /**
   * Lo pendiente de revisar, como mucho `limit`. `settle`: los tickets nuevos esperan unos minutos por si se editan justo
   * después de crearlos (el vigilante); una revisión pedida a mano no espera.
   */
  async pending({ limit, settle = true } = {}) {
    const now = this.#now();
    const settleMs = settle ? this.#config.TRIAGE_WATCH_SETTLE_MINUTES * 60_000 : 0;
    const { tickets = [] } = await this.#myraypa.listTickets({ creadosDesde: this.#reviewed.desde, mostrar: 'abiertos', limit: 50 });
    const nuevos = tickets
      .filter((t) => t.creado && !this.#reviewed.isDone(t.id) && now - Date.parse(t.creado) >= settleMs)
      .map((t) => ({ id: t.id, titulo: t.titulo, proyecto: t.proyecto }));
    const comentados = await this.commented();
    const todos = [...nuevos, ...comentados.filter((c) => !nuevos.some((n) => n.id === c.id))];
    return { batch: todos.slice(0, limit ?? this.#config.TRIAGE_MAX_TICKETS), total: todos.length, nuevos: nuevos.length, comentados: comentados.length };
  }

  /** Revisados con éxito: se anotan (y las re-revisiones cuentan). */
  async markDone(tickets) {
    const now = this.#now();
    for (const t of tickets) {
      this.#reviewed.markSeen(t.id, now);
      if (t.motivo === 'comentario nuevo') this.#reviewed.noteRereview(t.id);
    }
    await this.#reviewed.save();
  }
}
