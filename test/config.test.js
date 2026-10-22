import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('exige un token de al menos 12 caracteres', () => {
    expect(() => loadConfig({})).toThrow(/PRAXON_TOKEN/);
    expect(() => loadConfig({ PRAXON_TOKEN: 'corto' })).toThrow(/12 caracteres/);
  });
  it('exige la clave de Anthropic y los datos de MyRAYPA cuando se usan los modos reales', () => {
    const base = { PRAXON_TOKEN: 'token-largo-123456' };
    expect(() => loadConfig({ ...base, MODEL_PROVIDER: 'anthropic' })).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => loadConfig({ ...base, MYRAYPA_MODE: 'http' })).toThrow(/MYRAYPA_API_URL/);
    expect(() => loadConfig({ ...base, GITHUB_MODE: 'http' })).toThrow(/GITHUB_TOKEN/);
    expect(loadConfig(base)).toMatchObject({ PORT: 8080, MODEL_PROVIDER: 'scripted', MYRAYPA_MODE: 'fake' });
  });
});
