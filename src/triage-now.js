import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { AnthropicModel } from './model/anthropic.js';
import { ProposalStore } from './proposals/store.js';

/**
 * Ejecuta UNA revisión automática ahora y muestra qué ha consultado y qué propone. No guarda las propuestas
 * (no aparecen en la app) y no ejecuta ningún cambio. Uso: npm run triage-now
 */
let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
if (config.MODEL_PROVIDER !== 'anthropic' || config.MYRAYPA_MODE !== 'http') {
  console.error('Hace falta MODEL_PROVIDER=anthropic y MYRAYPA_MODE=http para una revisión real.');
  process.exit(1);
}

const real = new AnthropicModel({ apiKey: config.ANTHROPIC_API_KEY, maxTokens: config.MAX_TOKENS });
const used = [];
const model = {
  async *stream(args) {
    for await (const ev of real.stream(args)) {
      if (ev.type === 'message') for (const b of ev.content) if (b.type === 'tool_use') used.push(`${b.name} ${JSON.stringify(b.input)}`);
      yield ev;
    }
  },
};

const app = createApp(config, { model, proposalStore: new ProposalStore(null) });
const code = app.registry.list().filter((t) => t.connector === 'github').length;
console.log(`Modelo: ${config.TRIAGE_MODEL} | herramientas de código: ${code ? 'sí' : 'NO (falta GITHUB_READ_TOKEN)'} | máx. consultas de código: ${config.TRIAGE_CODE_MAX_CALLS}`);
const started = Date.now();
try {
  const b = await app.triage.run({ user: config.PRAXON_USER, trigger: 'manual' });
  console.log(`\nConsultas del modelo (${used.length}):`);
  for (const u of used) console.log(`  - ${u.slice(0, 160)}`);
  console.log(`\nResumen:\n${b.resumen || b.omitida || '(vacío)'}`);
  console.log(`\nPropuestas (${b.acciones?.length ?? 0}):`);
  for (const a of b.acciones ?? []) console.log(`  - ${a.resumen}\n    motivo: ${a.motivo}`);
  console.log(`\n${((Date.now() - started) / 1000).toFixed(1)} s`);
} catch (err) {
  console.error('La revisión ha fallado:', err.message);
  process.exit(1);
}
