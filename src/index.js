import { networkInterfaces } from 'node:os';
import { createApp } from './app.js';
import { loadConfig } from './config.js';

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const { server, registry } = createApp(config);
const port = await server.listen();

console.log(`${config.ASSISTANT_NAME}: servidor escuchando en el puerto ${port}`);
console.log(`Modelo: ${config.MODEL_PROVIDER} | MyRAYPA: ${config.MYRAYPA_MODE} | GitHub: ${config.GITHUB_MODE} | Voz: ${config.VOICE_PROVIDER}`);
if (config.VOICE_PROVIDER === 'elevenlabs') console.log('Aviso: el texto de las respuestas se envía a ElevenLabs para sintetizar la voz.');
console.log(`Herramientas registradas: ${registry.list().length}`);
console.log('Direcciones para la app:');
for (const list of Object.values(networkInterfaces())) {
  for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) console.log(`  ws://${i.address}:${port}/ws`);
}
if (config.MODEL_PROVIDER === 'scripted') console.log('Aviso: modelo guionizado (solo pruebas). Pon MODEL_PROVIDER=anthropic para el real.');

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await server.close();
    process.exit(0);
  });
}
