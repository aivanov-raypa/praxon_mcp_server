import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ToolRegistry, defineTool } from '../src/tools/registry.js';

const base = { connector: 'x', description: 'd', input: z.object({}), execute: async () => ({}) };

describe('ToolRegistry', () => {
  it('rechaza herramientas criticas o irreversibles', () => {
    for (const risk of ['critical', 'irreversible', 'admin', undefined]) {
      expect(() => new ToolRegistry().register(defineTool({ ...base, name: 'desplegar', risk }))).toThrow(/no permitido por voz/);
    }
  });
  it('exige summarize en las de escritura', () => {
    expect(() => new ToolRegistry().register(defineTool({ ...base, name: 'borrar_cosas', risk: 'write' }))).toThrow(/summarize/);
  });
  it('no admite duplicados y prefija con el conector', () => {
    const r = new ToolRegistry().register(defineTool({ ...base, name: 'listar', risk: 'read' }));
    expect(r.get('x_listar')).toBeDefined();
    expect(() => r.register(defineTool({ ...base, name: 'listar', risk: 'read' }))).toThrow(/duplicada/);
  });
  it('genera el esquema para el modelo sin $schema', () => {
    const r = new ToolRegistry().register(defineTool({ ...base, name: 'listar', risk: 'read', input: z.object({ n: z.number().optional() }) }));
    const [t] = r.forModel();
    expect(t.name).toBe('x_listar');
    expect(t.input_schema.type).toBe('object');
    expect(t.input_schema.$schema).toBeUndefined();
  });
});
