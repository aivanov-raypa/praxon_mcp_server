import { describe, expect, it } from 'vitest';
import { setup } from './helpers.js';

const ctx = { session: { id: 's1', user: 'alex', email: 'alex@raypa.com' } };

describe('editar_ticket', () => {
  it('es una herramienta de escritura: pide confirmación y no es de las directas', () => {
    const { registry } = setup();
    expect(registry.get('myraypa_editar_ticket').risk).toBe('write');
  });

  it('exige un título nuevo o texto que añadir', () => {
    const t = setup().registry.get('myraypa_editar_ticket');
    expect(t.input.safeParse({ ticketId: '214' }).success).toBe(false);
    expect(t.input.safeParse({ ticketId: '214', titulo: 'Nuevo título' }).success).toBe(true);
  });

  it('cambia el título y lo cuenta antes de ejecutarlo', async () => {
    const { registry, myraypa } = setup();
    const t = registry.get('myraypa_editar_ticket');
    const resumen = await t.summarize({ ticketId: '214', titulo: 'Título corregido' }, ctx);
    expect(resumen).toContain('cambiar el título');
    expect(resumen).toContain('Título corregido');
    await t.execute({ ticketId: '214', titulo: 'Título corregido' }, ctx);
    expect((await myraypa.getTicket('214')).titulo).toBe('Título corregido');
  });

  it('añade a la descripción sin borrar lo que había', async () => {
    const { registry, myraypa } = setup();
    const t = registry.get('myraypa_editar_ticket');
    const antes = (await myraypa.getTicket('214')).descripcion ?? '';
    await t.execute({ ticketId: '214', anadirDescripcion: 'Criterio de aceptación: debe exportar a PDF.' }, ctx);
    const despues = (await myraypa.getTicket('214')).descripcion;
    expect(despues.startsWith(antes)).toBe(true);
    expect(despues).toContain('Criterio de aceptación');
  });

  it('si el título ya es ese y no se añade nada, avisa de que no hay cambios', async () => {
    const { registry, myraypa } = setup();
    const t = registry.get('myraypa_editar_ticket');
    const tk = await myraypa.getTicket('214');
    await expect(t.summarize({ ticketId: '214', titulo: tk.titulo }, ctx)).rejects.toThrow(/nada que cambiar/);
  });
});
