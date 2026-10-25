import { describe, expect, it } from 'vitest';
import { ReminderService, ReminderStore, reminderTools } from '../src/companion/reminders.js';
import { ToolRegistry } from '../src/tools/registry.js';

const T0 = Date.UTC(2026, 9, 26, 7, 0);
const clock = { t: T0 };
const store = () => new ReminderStore(null, { now: () => clock.t });
const [crear, listar, cancelar] = reminderTools({ store: store() });

describe('recordatorios', () => {
  it('las herramientas son locales (sin confirmación) y se registran', () => {
    expect([crear, listar, cancelar].map((t) => t.risk)).toEqual(['local', 'local', 'local']);
    const reg = new ToolRegistry();
    expect(() => reg.registerConnector({ name: 'praxon', tools: reminderTools({ store: store() }) })).not.toThrow();
  });

  it('crea con enMinutos o con fecha, lista ordenado y cancela', async () => {
    clock.t = T0;
    const s = store();
    const [c, l, x] = reminderTools({ store: s });
    const ctx = { session: { email: 'maria@raypa.com', user: 'maria' } };
    const a = await c.execute(c.input.parse({ texto: 'Revisar el PR del ticket 214', enMinutos: 30 }), ctx);
    expect(a.creado).toBe(true);
    await c.execute(c.input.parse({ texto: 'Llamar a calidad', cuando: new Date(T0 + 10 * 60_000).toISOString() }), ctx);
    expect((await l.execute({}, ctx)).recordatorios.map((r) => r.texto)).toEqual(['Llamar a calidad', 'Revisar el PR del ticket 214']);
    await x.execute({ id: a.id }, ctx);
    expect((await l.execute({}, ctx)).recordatorios).toHaveLength(1);
    await expect(x.execute({ id: a.id }, ctx)).rejects.toThrow(/No encuentro/);
  });

  it('exige exactamente uno de cuando / enMinutos y rechaza horas pasadas o absurdas', async () => {
    const s = store();
    const [c] = reminderTools({ store: s });
    expect(c.input.safeParse({ texto: 'abc', enMinutos: 5, cuando: 'x' }).success).toBe(false);
    expect(c.input.safeParse({ texto: 'abc' }).success).toBe(false);
    await expect(s.add('u', { texto: 'ayer', cuando: new Date(T0 - 3_600_000).toISOString() })).rejects.toThrow(/ya ha pasado/);
    await expect(s.add('u', { texto: 'abc', cuando: 'no es fecha' })).rejects.toThrow(/no son válidas/);
  });

  it('cada usuario solo ve y cancela lo suyo', async () => {
    const s = store();
    const r = await s.add('a@x.com', { texto: 'cosa de a', enMinutos: 5 });
    expect(s.list('b@x.com')).toHaveLength(0);
    await expect(s.cancel('b@x.com', r.id)).rejects.toThrow();
  });

  it('el servicio avisa al vencer, solo una vez, y espera a que haya conexión', async () => {
    clock.t = T0;
    const s = store();
    await s.add('maria@raypa.com', { texto: 'Revisar PR', enMinutos: 5 });
    const sent = [];
    let online = false;
    const svc = new ReminderService({ store: s, deliver: (o, m) => (online ? (sent.push([o, m]), 1) : 0) });
    expect(await svc.tick()).toBe(0); // aún no vence
    clock.t = T0 + 6 * 60_000;
    expect(await svc.tick()).toBe(0); // vence pero no hay app conectada: sigue pendiente
    expect(s.list('maria@raypa.com')).toHaveLength(1);
    online = true;
    expect(await svc.tick()).toBe(1);
    expect(sent[0][1]).toMatchObject({ type: 'reminder', texto: 'Revisar PR' });
    expect(await svc.tick()).toBe(0);
    expect(s.list('maria@raypa.com')).toHaveLength(0);
  });

  it('al conectar se entrega lo vencido mientras estaba desconectada', async () => {
    clock.t = T0;
    const s = store();
    await s.add('maria@raypa.com', { texto: 'Cosa vencida', enMinutos: 1 });
    await s.add('otro@raypa.com', { texto: 'De otro', enMinutos: 1 });
    clock.t = T0 + 5 * 60_000;
    const svc = new ReminderService({ store: s, deliver: () => 0 });
    const out = [];
    await svc.flush('maria@raypa.com', (m) => out.push(m));
    expect(out.map((m) => m.texto)).toEqual(['Cosa vencida']);
    await svc.flush('maria@raypa.com', (m) => out.push(m));
    expect(out).toHaveLength(1);
  });
});
