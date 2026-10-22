import { createServer as createHttpServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { clientMessage } from './protocol.js';
import { SessionStore } from './session.js';

const SESSION_MAX_IDLE_MS = 12 * 60 * 60 * 1000;

function tokenOk(header, token) {
  const a = Buffer.from(String(header ?? ''));
  const b = Buffer.from(`Bearer ${token}`);
  return a.length === b.length && timingSafeEqual(a, b); // tiempo constante
}

/**
 * Servidor WebSocket (/ws) + /health. La autenticacion se hace en el handshake (HTTP 401):
 * sin token valido no se llega a abrir el WebSocket.
 */
export function createServer({ config, orchestrator, audit, sessions = new SessionStore() }) {
  const http = createHttpServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"status":"ok"}');
    } else {
      res.writeHead(404).end();
    }
  });

  const wss = new WebSocketServer({
    server: http,
    path: '/ws',
    maxPayload: 16 * 1024,
    verifyClient: (info, done) => done(tokenOk(info.req.headers.authorization, config.PRAXON_TOKEN), 401, 'Unauthorized'),
  });

  const log = (event) => audit.record(event).catch((err) => console.error('[auditoria]', err.message));

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    const bound = new Set();
    const emit = (msg) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    };
    log({ event: 'connection_open', user: config.PRAXON_USER, remote: req.socket.remoteAddress });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = clientMessage.parse(JSON.parse(raw));
      } catch {
        emit({ type: 'error', message: 'Mensaje no válido.' });
        return;
      }
      const session = sessions.get(msg.sessionId, config.PRAXON_USER);
      session.connection = ws;
      bound.add(session);

      let work;
      if (msg.type === 'user_text') work = orchestrator.handleUserText(session, msg, emit);
      else if (msg.type === 'confirm') work = orchestrator.handleConfirm(session, msg, emit);
      else work = orchestrator.cancel(session, emit);
      work.catch((err) => {
        console.error('[error]', err);
        log({ event: 'internal_error', sessionId: session.id, message: err.message });
        emit({ type: 'error', message: 'Ha ocurrido un error interno.' });
      });
    });

    ws.on('close', () => {
      // Una accion pendiente nunca sobrevive a un corte de conexion, y no se sigue gastando en una respuesta que nadie oye.
      for (const session of bound) {
        if (session.connection !== ws) continue; // la app ya se ha reconectado con otro socket
        session.connection = null;
        orchestrator.abortTurn(session);
        orchestrator.dropPending(session, 'connection_closed');
      }
      log({ event: 'connection_close', user: config.PRAXON_USER });
    });
  });

  const timers = [
    setInterval(() => {
      for (const ws of wss.clients) {
        if (!ws.isAlive) ws.terminate();
        else {
          ws.isAlive = false;
          ws.ping();
        }
      }
    }, 30_000),
    setInterval(() => sessions.sweep(SESSION_MAX_IDLE_MS), 10 * 60 * 1000),
  ];
  timers.forEach((t) => t.unref());

  return {
    http,
    wss,
    sessions,
    listen: () =>
      new Promise((resolve) => {
        http.listen(config.PORT, config.HOST, () => resolve(http.address().port));
      }),
    close: () =>
      new Promise((resolve) => {
        timers.forEach(clearInterval);
        for (const ws of wss.clients) ws.terminate();
        wss.close(() => http.close(() => resolve()));
      }),
  };
}
