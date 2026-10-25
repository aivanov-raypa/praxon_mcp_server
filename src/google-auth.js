/**
 * Autoriza Praxon a LEER el calendario y el correo de Google y muestra el refresh token para el .env.
 *   npm run google:auth      (necesita GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET en el .env; ver docs/google.md)
 * Abre un servidor temporal en 127.0.0.1 (solo este equipo) para recibir la respuesta de Google. Pide solo los alcances
 * de solo lectura. El token se muestra en pantalla: no se guarda en ningún fichero ni se imprime la clave secreta.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { SCOPES } from './integrations/google.js';

const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret, GOOGLE_OWNER_EMAIL: owner } = process.env;
if (!clientId || !clientSecret) {
  console.error('Faltan GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET en el .env (docs/google.md, paso 3).');
  process.exit(1);
}

const state = randomBytes(16).toString('hex');
const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname !== '/callback') return res.writeHead(404).end();
  const page = (msg) => res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end(msg);
  if (url.searchParams.get('state') !== state) return page('Respuesta no válida (state). Vuelve a ejecutar npm run google:auth.');
  const code = url.searchParams.get('code');
  if (!code) return page(`Google no ha dado el permiso (${url.searchParams.get('error') ?? 'sin código'}).`);
  try {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirect, grant_type: 'authorization_code', code_verifier: verifier }),
    });
    const j = await r.json();
    if (!r.ok || !j.refresh_token) {
      page('No se ha podido obtener el token. Mira la terminal.');
      console.error('Error de Google:', j.error_description ?? j.error ?? r.status, '\nSi dice que no hay refresh_token, revoca el acceso en https://myaccount.google.com/permissions y repite.');
    } else {
      page('Listo. Ya puedes cerrar esta pestaña y volver a la terminal.');
      console.log('\nAñade esto al .env del servidor (y NO lo subas a git):\n');
      console.log(`GOOGLE_MODE=http\nGOOGLE_OWNER_EMAIL=${owner ?? 'tu.correo@raypa.com'}\nGOOGLE_REFRESH_TOKEN=${j.refresh_token}\n`);
      console.log('Alcances concedidos:', j.scope);
    }
  } catch (err) {
    page('Error de red. Mira la terminal.');
    console.error(err.message);
  }
  server.close();
  setTimeout(() => process.exit(0), 200);
});

let redirect;
server.listen(0, '127.0.0.1', () => {
  redirect = `http://127.0.0.1:${server.address().port}/callback`;
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...(owner && { login_hint: owner }),
  });
  console.log('Abre esta dirección en el navegador y acepta los permisos de solo lectura:\n\n' + u.toString() + '\n');
  console.log('Esperando la respuesta de Google (5 minutos)…');
});
setTimeout(() => {
  console.error('Tiempo agotado. Vuelve a ejecutar npm run google:auth.');
  process.exit(1);
}, 5 * 60_000).unref();
