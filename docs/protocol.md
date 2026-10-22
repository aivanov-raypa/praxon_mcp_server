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
{ "type": "confirm_request", "actionId": "a91", "summary": "Voy a cambiar el ticket 214, ...: prioridad de alta a urgente", "audio": { "format": "mp3", "data": "<base64>" } }
{ "type": "error", "message": "..." }
```

- `assistant_chunk`: una o varias frases completas, ya sin markdown, listas para leer en voz alta.
- `assistant_audio`: la misma frase que un `assistant_chunk`, pero ya sintetizada (ElevenLabs). Llega en orden, y la app
  la reproduce **en lugar de** leer el texto. Si la síntesis de una frase falla, esa frase llega como `assistant_chunk`.
- `confirm_request`: el campo `audio` (opcional) es la pregunta "`summary`. ¿Confirmas?" ya sintetizada; si falta, la app
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
