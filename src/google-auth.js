/**
 * Autoriza Praxon a LEER el calendario y el correo de Google y muestra el refresh token para el .env.
 *   npm run google:auth      (necesita GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET en el .env; ver docs/google.md)
 * Abre un servidor temporal en 127.0.0.1 (solo este equipo) para recibir la respuesta de Google. Pide solo los alcances
 * de solo lectura. El token se muestra en pantalla: no se guarda en ningún fichero ni se imprime la clave secreta.
 *
 * Modo manual (para credenciales de tipo "Aplicación web" con una URL de redirección fija que no existe en este equipo):
 *   GOOGLE_REDIRECT_URI=https://asistente.raypa.com/oauth/callback npm run google:auth
 * Se abre la dirección de Google en cualquier navegador; al aceptar, el navegador intentará ir a la URL de redirección
 * (dará error de página no encontrada: es normal) y hay que pegar aquí la dirección COMPLETA de la barra del navegador.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline/promises';
import { SCOPES } from './integrations/google.js';

const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret, GOOGLE_OWNER_EMAIL: owner } = process.env;
if (!clientId || !clientSecret) {
  console.error('Faltan GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET en el .env (docs/google.md, paso 3).');
  process.exit(1);
}

const state = randomBytes(16).toString('hex');
const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');

const manualRedirect = process.env.GOOGLE_REDIRECT_URI?.trim();
if (manualRedirect && !/^https:\/\/[^\s]+$/.test(manualRedirect)) {
  console.error('GOOGLE_REDIRECT_URI debe ser una dirección https:// idéntica a una de las registradas en el cliente de Google.');
  process.exit(1);
}

function authUrl(redirectUri) {
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...(owner && { login_hint: owner }),
  });
  return u.toString();
}

/** Cambia el código por el refresh token y muestra las líneas del .env. Devuelve true si todo fue bien. */
async function exchange(code, redirectUri) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier }),
  });
  const j = await r.json();
  if (!r.ok || !j.refresh_token) {
    console.error('Error de Google:', j.error_description ?? j.error ?? r.status, '\nSi dice que no hay refresh_token, revoca el acceso en https://myaccount.google.com/permissions y repite.');
    return false;
  }
  console.log('\nAñade esto al .env del servidor (y NO lo subas a git):\n');
  console.log(`GOOGLE_MODE=http\nGOOGLE_OWNER_EMAIL=${owner ?? 'tu.correo@raypa.com'}\nGOOGLE_REFRESH_TOKEN=${j.refresh_token}\n`);
  console.log('Alcances concedidos:', j.scope);
  return true;
}

if (manualRedirect) {
  console.log('Modo manual.\n\n1) Abre esta dirección en el navegador (en cualquier equipo) y acepta los permisos de solo lectura:\n\n' + authUrl(manualRedirect) + '\n');
  console.log(`2) Al aceptar, el navegador irá a ${manualRedirect}?... y mostrará un error de página no encontrada: es normal.`);
  console.log('   Copia la dirección COMPLETA de la barra del navegador y pégala aquí (el código dura pocos minutos y solo sirve una vez).\n');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const pasted = (await rl.question('Dirección: ')).trim();
  rl.close();
  let back;
  try { back = new URL(pasted); } catch { console.error('Eso no es una dirección completa. Vuelve a ejecutar npm run google:auth.'); process.exit(1); }
  const expected = new URL(manualRedirect);
  if (back.origin + back.pathname !== expected.origin + expected.pathname) {
    console.error('La dirección pegada no corresponde a la URL de redirección configurada. Vuelve a ejecutar npm run google:auth.');
    process.exit(1);
  }
  if (back.searchParams.get('state') !== state) { console.error('Respuesta no válida (state). Vuelve a ejecutar npm run google:auth.'); process.exit(1); }
  const code = back.searchParams.get('code');
  if (!code) { console.error(`Google no ha dado el permiso (${back.searchParams.get('error') ?? 'sin código'}).`); process.exit(1); }
  let ok = false;
  try { ok = await exchange(code, manualRedirect); } catch (err) { console.error(err.message); }
  process.exit(ok ? 0 : 1);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname !== '/callback') return res.writeHead(404).end();
  const page = (msg) => res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end(msg);
  if (url.searchParams.get('state') !== state) return page('Respuesta no válida (state). Vuelve a ejecutar npm run google:auth.');
  const code = url.searchParams.get('code');
  if (!code) return page(`Google no ha dado el permiso (${url.searchParams.get('error') ?? 'sin código'}).`);
  try {
    if (await exchange(code, redirect)) page('Listo. Ya puedes cerrar esta pestaña y volver a la terminal.');
    else page('No se ha podido obtener el token. Mira la terminal.');
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
  console.log('Abre esta dirección en el navegador y acepta los permisos de solo lectura:\n\n' + authUrl(redirect) + '\n');
  console.log('Esperando la respuesta de Google (5 minutos)…');
});
setTimeout(() => {
  console.error('Tiempo agotado. Vuelve a ejecutar npm run google:auth.');
  process.exit(1);
}, 5 * 60_000).unref();
