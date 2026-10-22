const PARTS = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Madrid',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

/** Fecha y hora de Madrid de un instante: { date: '2026-10-23', time: '08:30' }. */
export function madridParts(ms) {
  const p = Object.fromEntries(PARTS.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

/** Lanza la revision a las horas indicadas (hora de Madrid, "HH:MM"), como mucho una vez por hora y dia. */
export class TriageScheduler {
  #times;
  #run;
  #now;
  #timer = null;
  #last = null;

  constructor({ times, run, now = Date.now }) {
    this.#times = new Set(times);
    this.#run = run;
    this.#now = now;
  }

  async tick() {
    const { date, time } = madridParts(this.#now());
    const slot = `${date} ${time}`;
    if (!this.#times.has(time) || slot === this.#last) return false;
    this.#last = slot;
    try {
      await this.#run();
    } catch (err) {
      console.error('[revision programada]', err.message);
    }
    return true;
  }

  start() {
    if (this.#timer) return;
    this.#timer = setInterval(() => this.tick(), 30_000);
    this.#timer.unref();
  }

  stop() {
    clearInterval(this.#timer);
    this.#timer = null;
  }
}
