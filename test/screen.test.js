import { describe, expect, it } from 'vitest';
import { screenTools } from '../src/tools/screen.js';

const [tool] = screenTools();
const OPEN = 1;
const fakeWs = () => ({ OPEN, readyState: OPEN, sent: [], send(m) { this.sent.push(JSON.parse(m)); } });

describe('mostrar_en_pantalla', () => {
  it('es de solo lectura y se llama praxon_mostrar_en_pantalla', () => {
    expect(tool.name).toBe('praxon_mostrar_en_pantalla');
    expect(tool.risk).toBe('read');
  });

  it('envía la tarjeta a la app de la sesión', async () => {
    const ws = fakeWs();
    const args = tool.input.parse({ titulo: 'Tickets abiertos', filas: [{ etiqueta: 'Faltantes OF', valor: 'Alta', estado: 'atencion' }, { etiqueta: 'Alarmas' }] });
    expect(await tool.execute(args, { session: { connection: ws } })).toEqual({ mostrada: true });
    expect(ws.sent).toEqual([{ type: 'card', titulo: 'Tickets abiertos', filas: [{ etiqueta: 'Faltantes OF', valor: 'Alta', estado: 'atencion' }, { etiqueta: 'Alarmas', valor: '' }] }]);
  });

  it('sin pantalla conectada lo dice al modelo para que lo cuente por voz', async () => {
    const r = await tool.execute(tool.input.parse({ titulo: 't', filas: [{ etiqueta: 'a' }] }), { session: {} });
    expect(r.mostrada).toBe(false);
  });

  it('rechaza tarjetas vacías, con demasiadas filas o estados desconocidos', () => {
    expect(tool.input.safeParse({ titulo: 't', filas: [] }).success).toBe(false);
    expect(tool.input.safeParse({ titulo: 't', filas: Array.from({ length: 15 }, () => ({ etiqueta: 'x' })) }).success).toBe(false);
    expect(tool.input.safeParse({ titulo: 't', filas: [{ etiqueta: 'x', estado: 'rojo' }] }).success).toBe(false);
  });
});
