import { describe, expect, it } from 'vitest';
import { SentenceChunker, cleanForSpeech } from '../src/chunker.js';

const run = (parts, opts) => {
  const out = [];
  const c = new SentenceChunker((s) => out.push(s), opts);
  parts.forEach((p) => c.push(p));
  c.flush();
  return out;
};

describe('SentenceChunker', () => {
  it('emite frases completas segun llegan', () => {
    expect(run(['Hay tres tickets urgentes. ', 'El primero es el 214. ', '¿Quieres el detalle?'])).toEqual([
      'Hay tres tickets urgentes.',
      'El primero es el 214.',
      '¿Quieres el detalle?',
    ]);
  });
  it('junta las frases muy cortas con la siguiente', () => {
    expect(run(['Hecho. ', 'El ticket 214 ya es urgente.'])).toEqual(['Hecho. El ticket 214 ya es urgente.']);
  });
  it('no corta decimales ni cifras', () => {
    expect(run(['Son 3.5 horas de trabajo en el módulo. ', 'Fin de la lista de tareas.'])).toEqual([
      'Son 3.5 horas de trabajo en el módulo.',
      'Fin de la lista de tareas.',
    ]);
  });
  it('hace flush del resto y funciona con trozos partidos por la mitad', () => {
    expect(run(['Hay tres tick', 'ets abiertos', ' en total'])).toEqual(['Hay tres tickets abiertos en total']);
  });
  it('quita el markdown', () => {
    expect(cleanForSpeech('**Hola** `mundo`\n- uno\n- dos')).toBe('Hola mundo uno dos');
  });
});
