# Protocolo app ↔ servidor

JSON por WebSocket en `/ws`. Autenticación en el handshake: cabecera `Authorization: Bearer <token>`.
Un token incorrecto recibe HTTP 401 y el WebSocket no llega a abrirse.

El `sessionId` lo genera la app y se mantiene entre reconexiones: el servidor conserva el historial de la
conversación, pero **una acción pendiente de confirmar nunca sobrevive a un corte de conexión**.

## app → servidor

```json
{ "type": "user_text", "sessionId": "...", "text": "Pasa el de los faltantes a urgente", "requestId": "r1", "audio": "mp3" }
{ "type": "confirm",   "sessionId": "...", "actionId": "a91", "accepted": true }
{ "type": "cancel",    "sessionId": "..." }
```

- `requestId` es opcional. Si se envía, el servidor lo repite en todos los mensajes de ese turno.
- `audio: "mp3"` es opcional: indica que la app sabe reproducir audio del servidor. Sin él, o si el servidor no tiene
  voz configurada (`VOICE_PROVIDER=none`), todo llega como texto y la app lo lee con la voz de Android.
- `user_text` interrumpe el turno anterior: el servidor deja de emitir lo que quedaba de la respuesta vieja y
  anula cualquier acción pendiente (solo se ejecuta si el *siguiente* mensaje es una confirmación).
- `cancel` corta la respuesta en curso, descarta la acción pendiente y el servidor responde `assistant_done`.

## servidor → app

```json
{ "type": "assistant_chunk", "text": "Hay tres tickets urgentes." }
{ "type": "assistant_audio", "text": "Hay tres tickets urgentes.", "format": "mp3", "data": "<base64>" }
{ "type": "assistant_done" }
{ "type": "confirm_request", "actionId": "a91", "summary": "Voy a cambiar el ticket 214, ...: prioridad de alta a urgente", "items": ["Cambiar el ticket 214: ..."], "audio": { "format": "mp3", "data": "<base64>" } }
{ "type": "error", "message": "..." }
```

- `assistant_chunk`: una o varias frases completas, ya sin markdown, listas para leer en voz alta.
- `assistant_audio`: la misma frase que un `assistant_chunk`, pero ya sintetizada (ElevenLabs). Llega en orden, y la app
  la reproduce **en lugar de** leer el texto. Si la síntesis de una frase falla, esa frase llega como `assistant_chunk`.
- `confirm_request`: **una sola confirmación cubre todas las escrituras que el modelo pide en el mismo paso** (hasta 25). `confirm` con
  `accepted: true` las ejecuta todas (cada una se audita por separado) y `accepted: false` las cancela todas. `summary` es lo que se lee en voz
  alta (corto: "Voy a cambiar 4 tickets: vencimiento el 23 de octubre y prioridad a alta. Tienes la lista en pantalla"); `items` (solo con varias
  acciones) es la lista completa, una línea por ticket, para mostrar en pantalla y no leer. El campo `audio` (opcional) es la pregunta "`summary`. ¿Confirmas?" ya sintetizada; si falta, la app
  la lee ella. El servidor no ejecuta la acción hasta recibir `confirm` con ese `actionId`,
  en la misma sesión, antes de que caduque (`CONFIRM_TTL_MS`) y una sola vez.
- `error`: se lee en voz alta. No cierra el turno con `assistant_done`.

## Reglas que garantiza el servidor

1. Leer se ejecuta siempre. Modificar datos reales exige confirmación explícita. Lo irreversible o crítico
   (mergear, desplegar, borrar, producción) no existe como herramienta.
2. La confirmación la controla el servidor; el modelo nunca la ve ni la genera.
3. Una escritura no se ejecuta si no se puede registrar en el log de auditoría.
4. Toda acción deja una línea en el log (`AUDIT_LOG_PATH`): quién, cuándo, transcripción original,
   herramienta, parámetros y resultado.

## Propuestas de la revisión automática

El servidor puede revisar los tickets por su cuenta (a las horas de `TRIAGE_TIMES`, o cuando la app lo pide) y dejar un
resumen con acciones **preparadas pero sin ejecutar**. Estos mensajes no pertenecen a ninguna conversación: no llevan `sessionId`.

### app → servidor

```json
{ "type": "proposals_list" }
{ "type": "proposals_run" }
{ "type": "proposal_decision", "briefingId": "...", "actionId": "...", "accepted": true }
```

- `proposals_list`: pide el estado actual. `proposals_run`: lanza una revisión ahora.
- `proposal_decision`: aprueba (`accepted: true`) o descarta una acción. Es la única forma de que se ejecute.

### servidor → app

```json
{ "type": "proposals", "pendientes": 2, "running": false,
  "briefings": [ { "id": "...", "createdAt": "2026-10-23T06:30:00.000Z", "trigger": "schedule", "resumen": "...",
    "acciones": [ { "id": "...", "herramienta": "myraypa_actualizar_ticket", "resumen": "Voy a cambiar el ticket ...: prioridad de media a alta", "motivo": "...", "estado": "pendiente" } ] } ] }
{ "type": "proposal_result", "briefingId": "...", "actionId": "...", "ok": true, "estado": "ejecutada", "mensaje": "Hecho." }
```

- `proposals` se envía como respuesta a `proposals_list` y a **todos los clientes conectados** cuando cambia algo (revisión
  nueva o decisión). Lleva las 10 revisiones más recientes; los parámetros internos de las acciones no se envían.
- Estados de una acción: `pendiente`, `ejecutada`, `descartada`, `fallida`, `obsoleta` (el ticket ha cambiado desde la
  propuesta: no se ejecuta) y `caducada` (pasadas `PROPOSAL_TTL_HOURS`).

### Garantías

- El modelo de la revisión solo puede **consultar** y **proponer**; nunca ejecuta. Solo se pueden proponer las herramientas de
  `TRIAGE_ALLOWED_TOOLS` (por defecto, cambios de ticket, comentarios, fechas, etiquetas, participantes y subtareas;
  nada de agentes, roadmaps ni merges).
- Al aprobar, el servidor vuelve a calcular el resumen con los datos de ese momento: si no coincide con el que viste,
  la acción queda `obsoleta`. La ejecución se audita (`via: "proposal"`) y no se hace si la auditoría falla.
- Por voz también se pueden consultar (`praxon_propuestas_pendientes`) y aplicar (`praxon_aplicar_propuesta`, con la
  confirmación normal de la conversación).

## Dictado (transcripción en el servidor)

Con `STT_PROVIDER=elevenlabs` el servidor transcribe el audio del micrófono con ElevenLabs Scribe (usa `ELEVENLABS_API_KEY`).
Al conectar el servidor envía `{type:'capabilities', stt:true|false}`; si es `false` (o no llega), la app usa el reconocedor de Android.

- app → servidor: `stt_start`, mensajes **binarios** con audio PCM (16 kHz, 16 bits, little-endian, mono; unos 100 ms cada uno), `stt_stop` (termina y entrega lo dicho hasta ahora) y `stt_cancel` (descarta). Solo hay un dictado activo por conexión; `stt_start` sustituye al anterior.
- servidor → app: `stt_partial {text}`, `stt_final {text}` (primer texto confirmado; el servidor cierra el dictado), `stt_error {message}`, `stt_ended` (cerrado sin texto).
- El servidor detecta el final de la frase por silencio (`STT_SILENCE_SECS`, 1,2 s por defecto) y corta el dictado a los `STT_MAX_SECONDS` (45). Tras `stt_final` la app envía `user_text` con el texto, como siempre.
- Privacidad: mientras la app escucha, el audio sale hacia ElevenLabs. No se guarda audio en el servidor.


## Frases propias de la app (`speak`)

Para que los avisos y frases que genera la propia app ("No te he entendido…", "Tienes 2 propuestas pendientes…") suenen con la misma voz que las respuestas, la app las pide al servidor:

```json
{ "type": "speak", "id": "uuid", "text": "No te he entendido. Di confirmo o cancela." }
```

El servidor responde `{ "type": "speech", "id", "text", "format": "mp3", "data": "<base64>" }`. Si no hay voz configurada, falla la síntesis o la conexión supera 20 frases por minuto, responde sin `format` ni `data` y la app usa la voz de Android. `capabilities` incluye `voice: true|false`. Las frases fijas se guardan en memoria en el servidor para no sintetizarlas cada vez.


## Agentes de desarrollo

App → servidor:

- `{ "type": "agents_list" }`: agentes abiertos con su PR y checks en vivo.
- `{ "type": "agent_diff", "runId" }`: archivos cambiados del PR (parche acotado).
- `{ "type": "agent_merge", "runId", "sha", "numero" }`: fusiona el PR. `sha` es el que mostró la app y `numero` el número de PR que el usuario ha tecleado. Solo existe aquí: no es una herramienta del modelo.

Servidor → app: `agents { canMerge, items[] }` (cada item: runId, ticketId, ticket, tipo, estado, repo, bloqueo, y si hay PR: `pr {numero,url,sha,titulo,archivos,adiciones,borrados,mergeable}`, `checks {total,ok,fallando,pendientes,items}`, `fusionable`, `motivo`, `sinChecks`), `agent_diff { runId, pr, archivos[] | error }`, `agent_merge_result { runId, ok, error? , pr? }`, y `agents_changed` (difusión: la app vuelve a pedir la lista).
