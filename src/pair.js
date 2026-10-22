import { loadConfig } from './config.js';
import { pairingUri, pairingUrls, qrTerminal } from './pairing.js';

/** npm run pair: imprime el QR de emparejamiento sin arrancar el servidor. */
let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
const urls = pairingUrls(config, config.PORT);
if (!urls.length) {
  console.error('No se ha encontrado ninguna dirección de red. Define PRAXON_PUBLIC_URL.');
  process.exit(1);
}
for (const url of urls) {
  console.log(`\n${url}`);
  console.log(await qrTerminal(pairingUri({ url, token: config.PRAXON_TOKEN, name: config.ASSISTANT_NAME })));
}
console.log('Escanéalo desde la app. Contiene el acceso al asistente: no lo compartas.');
