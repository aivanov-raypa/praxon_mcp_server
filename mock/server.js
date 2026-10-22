// Servidor de protocolo minimo (sin modelo ni herramientas) para probar la app Android.
// El servidor real (src/) con MODEL_PROVIDER=scripted cubre lo mismo y mas; este queda como referencia del protocolo.
// Habla el mismo protocolo que tendrá el orquestador:
//   app → servidor: user_text {sessionId, text} | confirm {sessionId, actionId, accepted}
//   servidor → app: assistant_chunk {text} | assistant_done | confirm_request {actionId, summary} | error {message}
import { WebSocketServer } from 'ws';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';

const PORT = Number(process.env.PORT || 8080);
let TOKEN = process.env.PRAXON_TOKEN;
const tokenGenerated = !TOKEN;
if (!TOKEN) TOKEN = randomBytes(8).toString('hex'); // sin token configurado, se genera uno al azar
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Comparación en tiempo constante
const tokenOk = (header) => {
  const a = Buffer.from(String(header || ''));
  const b = Buffer.from(`Bearer ${TOKEN}`);
  return a.length === b.length && timingSafeEqual(a, b);
};

const wss = new WebSocketServer({
  port: PORT,
  path: '/ws',
  // Se rechaza en el handshake (HTTP 401): sin token válido no se llega a abrir el WebSocket
  verifyClient: (info, done) => done(tokenOk(info.req.headers.authorization), 401, 'Unauthorized'),
});

wss.on('connection', (ws, req) => {
  console.log('App conectada desde', req.socket.remoteAddress);

  const pending = new Map(); // acciones pendientes de confirmar, por conexión
  const send = (msg) => ws.send(JSON.stringify(msg));
  const say = async (sentences) => {
    for (const text of sentences) {
      send({ type: 'assistant_chunk', text });
      await sleep(300); // simula el streaming del modelo
    }
    send({ type: 'assistant_done' });
  };

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    console.log('←', msg);

    if (msg.type === 'user_text') {
      const text = String(msg.text || '').toLowerCase();

      // Simula una acción de escritura: requiere confirmación
      if (/(pasa|pon|marca|cambia)/.test(text) && text.includes('urgente')) {
        const actionId = randomUUID();
        pending.set(actionId, { ticket: 214, change: 'prioridad urgente' });
        send({
          type: 'confirm_request',
          actionId,
          summary: 'Voy a pasar el ticket 214, Faltantes OF semana 43, a prioridad urgente',
        });
        return;
      }

      // Simula una consulta
      await say([
        'En Calibraciones hay tres tickets abiertos.',
        'El más urgente es el 214, Faltantes OF semana 43, asignado a producción.',
        '¿Quieres el detalle de alguno?',
      ]);
      return;
    }

    if (msg.type === 'confirm') {
      const action = pending.get(msg.actionId);
      if (!action) {
        send({ type: 'error', message: 'No hay ninguna acción pendiente con ese identificador.' });
        return;
      }
      pending.delete(msg.actionId);
      await say(msg.accepted
        ? [`Hecho. El ticket ${action.ticket} ahora tiene ${action.change}.`]
        : ['Cancelado. No he cambiado nada.']);
    }
  });

  ws.on('close', () => console.log('App desconectada'));
});

console.log(`Servidor simulado escuchando en el puerto ${PORT}. Direcciones para la app:`);
for (const list of Object.values(networkInterfaces())) {
  for (const i of list || []) {
    if (i.family === 'IPv4' && !i.internal) console.log(`  ws://${i.address}:${PORT}/ws`);
  }
}
if (tokenGenerated) console.log(`Token generado para esta ejecución: ${TOKEN}`);
else console.log('Token: el de la variable PRAXON_TOKEN');
