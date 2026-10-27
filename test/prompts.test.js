import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../src/prompts.js';

describe('buildSystemPrompt', () => {
  const p = buildSystemPrompt({ name: 'Praxon', user: 'alex', now: new Date('2026-10-23T09:30:00Z') });

  it('lleva la fecha actual y el usuario para resolver "el viernes" o "esta semana"', () => {
    expect(p).toContain('viernes, 23 de octubre de 2026');
    expect(p).toContain('de alex');
  });

  it('permite conversación general y limita las herramientas a lo que trate de MyRAYPA', () => {
    expect(p).toMatch(/cualquier tema/);
    expect(p).toMatch(/solo cuando lo que te piden trate de eso/);
  });

  it('exige preguntar con una sola pregunta cuando hay duda y no inventar prioridades', () => {
    expect(p).toMatch(/una sola pregunta/);
    expect(p).toMatch(/no existe "urgente"/);
  });

  it('mantiene que la confirmación la pide el sistema y que no se hace nada crítico por voz', () => {
    expect(p).toMatch(/el sistema pide la confirmación/);
    expect(p).toMatch(/no puedes mergear, desplegar, borrar/i);
  });
});

describe('qué tengo hoy: MyRAYPA primero', () => {
  it('sin Google activo el prompt no menciona agenda ni correo de Google', () => {
    const p = buildSystemPrompt({ user: 'alex' });
    expect(p).not.toMatch(/google_agenda|google_correo/);
    expect(p).toMatch(/Empieza SIEMPRE por MyRAYPA/);
  });
  it('con Google activo sigue explicando agenda y correo, pero MyRAYPA va primero', () => {
    const p = buildSystemPrompt({ user: 'alex', google: true });
    expect(p).toMatch(/google_agenda_eventos/);
    expect(p).toMatch(/solo ofrece mirar la agenda/);
    expect(p.indexOf('Empieza SIEMPRE por MyRAYPA')).toBeLessThan(p.indexOf('google_agenda_eventos'));
  });
});
