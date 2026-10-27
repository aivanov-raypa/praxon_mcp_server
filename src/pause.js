// Interruptor de emergencia desde la terminal del servidor (funciona aunque la app no responda):
//   npm run pausa -- on "motivo opcional"   activa la pausa
//   npm run pausa -- off                    la desactiva
//   npm run pausa                           muestra el estado
import { loadConfig } from './config.js';
import { JsonlAudit } from './audit/log.js';
import { PauseSwitch } from './safety/pause.js';

const config = loadConfig();
const audit = new JsonlAudit(config.AUDIT_LOG_PATH);
const pause = new PauseSwitch(config.PAUSE_PATH, { audit });
const [accion, ...resto] = process.argv.slice(2);
const usuario = `terminal:${process.env.USER ?? 'servidor'}`;

if (accion === 'on') {
  const d = await pause.engage({ user: usuario, motivo: resto.join(' ') || null });
  console.log(`PAUSA ACTIVADA desde ${d.desde}${d.motivo ? ` (${d.motivo})` : ''}. Praxon no hará cambios hasta reanudar.`);
} else if (accion === 'off') {
  await pause.release({ user: usuario });
  console.log('Pausa desactivada: Praxon vuelve a funcionar con normalidad.');
} else {
  const i = pause.info();
  console.log(i ? `EN PAUSA desde ${i.desde} por ${i.por}${i.motivo ? ` (${i.motivo})` : ''}.` : 'Praxon NO está en pausa.');
}
