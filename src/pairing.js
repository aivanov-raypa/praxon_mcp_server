import { networkInterfaces } from 'node:os';
import QRCode from 'qrcode';

/** Direcciones ws:// de este equipo en la red local (IPv4 no interna). */
export function lanUrls(port, nets = networkInterfaces()) {
  const out = [];
  for (const list of Object.values(nets)) {
    for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) out.push(`ws://${i.address}:${port}/ws`);
  }
  return out;
}

/** Direcciones que se ofrecen a la app: la pública configurada, o las de la red local. */
export const pairingUrls = (config, port) => (config.PRAXON_PUBLIC_URL ? [config.PRAXON_PUBLIC_URL] : lanUrls(port));

/**
 * Contenido del QR de emparejamiento: praxon://pair?v=1&u=<ws>&t=<token>[&n=<nombre>].
 * Contiene el token: quien lo vea puede usar el asistente. Se muestra solo en la consola del servidor y en /pair desde este equipo.
 */
export function pairingUri({ url, token, name }) {
  const q = new URLSearchParams({ v: '1', u: url, t: token });
  if (name) q.set('n', name);
  return `praxon://pair?${q.toString()}`;
}

export const qrTerminal = (text) => QRCode.toString(text, { type: 'terminal', small: true, errorCorrectionLevel: 'M' });
export const qrSvg = (text) => QRCode.toString(text, { type: 'svg', margin: 2, errorCorrectionLevel: 'M', color: { dark: '#0b1020', light: '#ffffff' } });

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** Página /pair: un QR por cada dirección disponible. */
export async function pairPage({ config, port }) {
  const urls = pairingUrls(config, port);
  const blocks = await Promise.all(
    urls.map(async (url) => `<section><div class="qr">${await qrSvg(pairingUri({ url, token: config.PRAXON_TOKEN, name: config.ASSISTANT_NAME }))}</div><code>${esc(url)}</code></section>`),
  );
  return `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Emparejar ${esc(config.ASSISTANT_NAME)}</title>
<style>body{font:16px system-ui;background:#0b1020;color:#e6ecff;margin:0;padding:32px;text-align:center}h1{font-weight:600}section{display:inline-block;margin:16px;padding:16px;background:#121a33;border-radius:16px}.qr svg{width:260px;height:260px;border-radius:8px}code{display:block;margin-top:8px;color:#8fa3ff}p{color:#9aa7d6;max-width:520px;margin:8px auto}</style>
<h1>Emparejar la app de ${esc(config.ASSISTANT_NAME)}</h1>
<p>Abre la app en el móvil y escanea el código que corresponda a la red a la que está conectado. Este código contiene el acceso al asistente: no lo compartas ni hagas capturas.</p>
${blocks.join('') || '<p>No se ha encontrado ninguna dirección de red. Define PRAXON_PUBLIC_URL.</p>'}</html>`;
}

export const isLoopback = (addr) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr);
