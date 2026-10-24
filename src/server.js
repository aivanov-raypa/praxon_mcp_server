import { createServer as createHttpServer } from 'node:http';
import { prepararContextoPR } from './agents/contexto.js';
import { WebSocketServer } from 'ws';
import { clientMessage } from './protocol.js';
import { SessionStore } from './session.js';
import { isLoopback, pairPage } from './pairing.js';
import { DeviceAuth, RateLimiter } from './auth.js';
import { runAsUser } from './identity.js';

const SESSION_MAX_IDLE_MS = 12 * 60 * 60 * 1000;

const REVERIFY_MS = 60_000;

/** Lee un cuerpo JSON pequeño (máx. 2 KB). */
function readJson(req, max = 2048) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        reject(new Error('demasiado grande'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

/**
 * Servidor WebSocket (/ws) + /health. La autenticacion se hace en el handshake (HTTP 401):
 * sin token valido no se llega a abrir el WebSocket.
 */
export function createServer({
  config,
  orchestrator,
  audit,
  triage = null,
  agents = null,
  usage = null,
  sessions = new SessionStore(),
  myraypa = null,
  auth = new DeviceAuth({ config, myraypa }),
  redeemLimiter = new RateLimiter(),
  stt = null,
  voice = null,
}) {
  // Las frases fijas de la app se repiten (p. ej. "No te he entendido. Di confirmo o cancela."): se guardan para no pagar la síntesis cada vez.
  const phrases = new Map();
  async function synthesizePhrase(text) {
    const hit = phrases.get(text);
    if (hit) return hit;
    const audio = await voice.synthesize(text).catch(() => null);
    if (audio && text.length <= 160) {
      phrases.set(text, audio);
      if (phrases.size > 60) phrases.delete(phrases.keys().next().value);
    }
    return audio;
  }

  const sendJson = (res, status, body) => res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));

  /** POST /pair/redeem { code, deviceName }: canjea el código del QR de MyRAYPA por el token del dispositivo. */
  async function redeem(req, res) {
    if (!redeemLimiter.take(req.socket.remoteAddress ?? '?')) return sendJson(res, 429, { message: 'Demasiados intentos. Espera unos minutos.' });
    let body;
    try {
      body = await readJson(req);
    } catch {
      return sendJson(res, 400, { message: 'Petición no válida.' });
    }
    try {
      const out = await myraypa.redeemDevice(String(body.code ?? ''), String(body.deviceName ?? '').slice(0, 80));
      log({ event: 'device_paired', deviceId: out.deviceId, name: out.name, remote: req.socket.remoteAddress });
      return sendJson(res, 200, { token: out.token, deviceId: out.deviceId, name: config.ASSISTANT_NAME });
    } catch (err) {
      const status = err.status === 400 || err.status === 401 ? err.status : 502;
      if (status === 502) console.error('[emparejar]', err.message);
      log({ event: 'device_pair_failed', status, remote: req.socket.remoteAddress });
      return sendJson(res, status, { message: status === 502 ? 'No he podido contactar con MyRAYPA.' : 'El código no es válido o ha caducado.' });
    }
  }

  const http = createHttpServer((req, res) => {
    if (req.method === 'POST' && req.url === '/pair/redeem' && myraypa) {
      redeem(req, res).catch(() => res.headersSent || sendJson(res, 500, { message: 'Error interno.' }));
    } else if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"status":"ok"}');
    } else if (req.url === '/pair' && isLoopback(req.socket.remoteAddress) && !req.headers['x-forwarded-for']) {
      // Solo desde el propio equipo del servidor: la página contiene el token.
      pairPage({ config, port: http.address()?.port ?? config.PORT })
        .then((html) => res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(html))
        .catch(() => res.writeHead(500).end());
    } else {
      res.writeHead(404).end();
    }
  });

  const wss = new WebSocketServer({
    server: http,
    path: '/ws',
    maxPayload: 16 * 1024,
    verifyClient: (info, done) => {
      auth
        .authenticate(info.req.headers.authorization)
        .then((identity) => {
          info.req.praxonIdentity = identity;
          done(Boolean(identity), 401, 'Unauthorized');
        })
        .catch((err) => {
          console.error('[auth]', err.message);
          done(false, 503, 'Auth unavailable');
        });
    },
  });

  const broadcast = (msg) => {
    for (const client of wss.clients) if (client.readyState === client.OPEN) client.send(JSON.stringify(msg));
  };

  async function handleProposals(msg, emit, broadcast) {
    if (!triage) {
      emit({ type: 'error', message: 'La revisión automática no está disponible.' });
    } else if (msg.type === 'proposals_list') {
      emit(triage.view());
    } else if (msg.type === 'proposals_run') {
      const r0 = triage.running;
      broadcast({ ...triage.view(), running: true });
      const r = await triage.run({ user: config.PRAXON_USER, trigger: 'manual' }).catch((err) => {
        console.error('[revision]', err.message);
        emit({ type: 'error', message: 'No he podido hacer la revisión. Inténtalo de nuevo.' });
        return null;
      });
      if (r || r0) broadcast(triage.view());
    } else if (msg.type === 'proposal_group_decision') {
      const r = await triage.decideGroup({ briefingId: msg.briefingId, grupo: msg.grupo, aprobar: msg.aprobar, user: config.PRAXON_USER });
      emit({ type: 'proposal_group_result', briefingId: msg.briefingId, grupo: msg.grupo, ...r });
      broadcast(triage.view());
    } else {
      const r = await triage.decide({ briefingId: msg.briefingId, actionId: msg.actionId, accepted: msg.accepted, user: config.PRAXON_USER });
      emit({ type: 'proposal_result', briefingId: msg.briefingId, actionId: msg.actionId, ...r });
      broadcast(triage.view());
    }
  }

  async function handleUsage(msg, emit) {
    if (!usage) {
      emit({ type: 'error', message: 'El panel de consumos no está disponible.' });
      return;
    }
    emit({ type: 'usage', ...(await usage.get({ refresh: msg.refresh === true })) });
  }

  async function handleAgents(msg, emit, identity) {
    if (!agents) {
      emit({ type: 'error', message: 'El seguimiento de agentes no está configurado (falta GITHUB_READ_TOKEN).' });
    } else if (msg.type === 'agents_list') {
      emit({ type: 'agents', canMerge: agents.canMerge, canRequestChanges: agents.canRequestChanges, items: await agents.list() });
    } else if (msg.type === 'agents_history') {
      emit({ type: 'agents_history', items: await agents.history({ limit: msg.limit }) });
    } else if (msg.type === 'agent_diff') {
      const d = await agents.diff(msg.runId).catch((err) => ({ error: err.message }));
      emit({ type: 'agent_diff', runId: msg.runId, ...d });
    } else if (msg.type === 'agent_request_changes') {
      const r = await agents.requestChanges({ runId: msg.runId, feedback: msg.feedback, user: identity.user });
      emit({ type: 'agent_changes_result', runId: msg.runId, ...r });
      broadcast({ type: 'agents_changed' });
    } else {
      const r = await agents.merge({ runId: msg.runId, sha: msg.sha, numero: msg.numero, user: identity.user });
      emit({ type: 'agent_merge_result', runId: msg.runId, ...r });
      broadcast({ type: 'agents_changed' });
    }
  }

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
    const identity = req.praxonIdentity;
    ws.identity = identity;
    let dictation = null; // transcripción en curso de esta conexión
    let speakTimes = []; // límite de frases por minuto de esta conexión
    const stopDictation = () => {
      const d = dictation;
      dictation = null; // antes de cerrar: así onClose no avisa a la app de un cierre que provocamos nosotros
      d?.close();
    };
    emit({ type: 'capabilities', stt: Boolean(stt), voice: Boolean(voice) });
    log({ event: 'connection_open', user: identity.user, deviceId: identity.deviceId, remote: req.socket.remoteAddress });

    ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        // Audio del dictado. Sin dictado activo se descarta.
        if (dictation) dictation.send(Buffer.isBuffer(raw) ? raw : Buffer.concat([].concat(raw)));
        return;
      }
      let msg;
      try {
        msg = clientMessage.parse(JSON.parse(raw));
      } catch {
        emit({ type: 'error', message: 'Mensaje no válido.' });
        return;
      }
      if (msg.type === 'stt_start' || msg.type === 'stt_stop' || msg.type === 'stt_cancel') {
        if (msg.type === 'stt_cancel') {
          stopDictation();
        } else if (msg.type === 'stt_stop') {
          dictation?.finish();
        } else if (!stt) {
          emit({ type: 'stt_error', message: 'La transcripción no está configurada en el servidor.' });
        } else {
          stopDictation();
          log({ event: 'stt_start', user: identity.user, deviceId: identity.deviceId });
          const mine = (dictation = stt.open({
            onPartial: (text) => dictation === mine && emit({ type: 'stt_partial', text }),
            onFinal: (text) => dictation === mine && emit({ type: 'stt_final', text }),
            onError: (message) => dictation === mine && emit({ type: 'stt_error', message }),
            onClose: () => {
              if (dictation === mine) {
                dictation = null;
                emit({ type: 'stt_ended' });
              }
            },
          }));
        }
        return;
      }
      if (msg.type === 'speak') {
        const now = Date.now();
        speakTimes = speakTimes.filter((t) => now - t < 60_000);
        // Sin voz, o pasado el límite: se responde sin audio y la app usa la voz de Android.
        if (!voice || speakTimes.length >= 20) {
          emit({ type: 'speech', id: msg.id, text: msg.text });
          return;
        }
        speakTimes.push(now);
        synthesizePhrase(msg.text).then((a) => {
          if (ws.readyState === ws.OPEN) emit({ type: 'speech', id: msg.id, text: msg.text, ...(a && { format: a.format, data: a.data }) });
        });
        return;
      }
      if (msg.type === 'usage_get') {
        handleUsage(msg, emit).catch((err) => {
          console.error('[consumos]', err);
          emit({ type: 'error', message: 'No he podido obtener los consumos.' });
        });
        return;
      }
      if (msg.type.startsWith('agent')) {
        handleAgents(msg, emit, identity).catch((err) => {
          console.error('[agentes]', err);
          emit({ type: 'error', message: 'No he podido gestionar los agentes.' });
        });
        return;
      }
      if (msg.type.startsWith('proposal')) {
        handleProposals(msg, emit, broadcast).catch((err) => {
          console.error('[propuestas]', err);
          emit({ type: 'error', message: 'No he podido gestionar las propuestas.' });
        });
        return;
      }
      const session = sessions.get(msg.sessionId, identity.user, identity.key, identity.email);
      session.connection = ws;
      bound.add(session);

      let work;
      // Todo lo que haga este mensaje contra MyRAYPA se hace como el usuario del dispositivo.
      work = runAsUser(identity.email, () => {
        if (msg.type === 'user_text') {
          return prepararContextoPR(session, msg.contexto, agents).then(() => orchestrator.handleUserText(session, msg, emit));
        }
        if (msg.type === 'confirm') return orchestrator.handleConfirm(session, msg, emit);
        return orchestrator.cancel(session, emit);
      });
      work.catch((err) => {
        console.error('[error]', err);
        log({ event: 'internal_error', sessionId: session.id, message: err.message });
        emit({ type: 'error', message: 'Ha ocurrido un error interno.' });
      });
    });

    ws.on('close', () => {
      stopDictation();
      // Una accion pendiente nunca sobrevive a un corte de conexion, y no se sigue gastando en una respuesta que nadie oye.
      for (const session of bound) {
        if (session.connection !== ws) continue; // la app ya se ha reconectado con otro socket
        session.connection = null;
        orchestrator.abortTurn(session);
        orchestrator.dropPending(session, 'connection_closed');
      }
      log({ event: 'connection_close', user: identity.user, deviceId: identity.deviceId });
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
    // Un dispositivo revocado en MyRAYPA pierde la conexión en cuanto se detecta.
    setInterval(() => {
      for (const ws of wss.clients) {
        if (ws.identity?.kind !== 'device') continue;
        auth
          .verify(ws.identity.token, { fresh: true })
          .then((id) => id || (log({ event: 'device_revoked', deviceId: ws.identity.deviceId }), ws.close(4401, 'revoked')))
          .catch(() => {}); // si MyRAYPA no responde se mantiene la conexión y se reintenta
      }
    }, REVERIFY_MS),
  ];
  timers.forEach((t) => t.unref());

  return {
    http,
    wss,
    sessions,
    broadcast,
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
