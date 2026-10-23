import { loadConfig } from './config.js';
import { AnthropicModel } from './model/anthropic.js';

/**
 * Comprueba la conexión con la API de Anthropic con una llamada mínima: clave, modelo y red.
 * Uso: npm run check-model
 */
let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
if (config.MODEL_PROVIDER !== 'anthropic') {
  console.error('MODEL_PROVIDER es "scripted". Pon MODEL_PROVIDER=anthropic y ANTHROPIC_API_KEY en el .env.');
  process.exit(1);
}

const model = new AnthropicModel({ apiKey: config.ANTHROPIC_API_KEY, maxTokens: 40 });
const started = Date.now();
try {
  let text = '';
  let stop = null;
  for await (const ev of model.stream({
    system: 'Responde en español, con una sola frase corta.',
    messages: [{ role: 'user', content: 'Di "listo" y tu nombre de modelo.' }],
    tools: [],
    model: config.MODEL_DEFAULT,
  })) {
    if (ev.type === 'text') text += ev.text;
    if (ev.type === 'message') stop = ev.stopReason;
  }
  console.log(`OK con ${config.MODEL_DEFAULT} en ${Date.now() - started} ms (${stop}): ${text.trim()}`);
} catch (err) {
  const status = err.status ? ` (HTTP ${err.status})` : '';
  const hint =
    err.status === 401 ? 'La clave no es válida.' :
    err.status === 404 ? `El modelo "${config.MODEL_DEFAULT}" no existe o tu cuenta no tiene acceso: cambia MODEL_DEFAULT.` :
    err.status === 429 ? 'Límite de peticiones o sin crédito en la cuenta.' :
    'Revisa la conexión a Internet y el proxy.';
  console.error(`Fallo${status}: ${hint}\n${err.message}`);
  process.exit(1);
}
