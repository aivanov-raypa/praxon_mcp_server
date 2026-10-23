# praxon_mcp_server

Orquestador de **Praxon** (nombre provisional): el servidor al que se conecta la app de voz
([praxon_mobile_app](../praxon_mobile_app)). Recibe lo que dices, habla con el modelo, consulta y gestiona
los tickets de MyRAYPA mediante herramientas, lanza agentes de desarrollo y deja un log de auditoría de cada acción.

Es un único servidor con **conectores**: hoy solo MyRAYPA (módulo de tickets y proyectos de raypa-platform);
Salesforce, SAP B1 o Google Workspace serían otros conectores con las mismas reglas de riesgo,
confirmación y auditoría. Las herramientas viven en un registro neutro, así que también se podrán servir como MCP.

## Arquitectura

```
App Android --VPN/WebSocket--> servidor (este repo) --saliente--> API del modelo
                                        |--API interna--> MyRAYPA (tickets, AgentRun, auditoria)
                                        '--saliente--> GitHub (dispara el workflow del agente)
                                                         -> runner autohospedado (Claude Code: rama, tests, PR)
```

```
src/
  index.js, app.js        arranque y montaje de piezas
  server.js               WebSocket /ws + /health, token en el handshake
  orchestrator.js         bucle modelo <-> herramientas, confirmaciones, interrupciones
  confirmations.js        accion pendiente: un solo uso, misma sesion, caduca
  session.js, chunker.js  historial por sesion; respuesta frase a frase para la voz
  tools/registry.js       registro unico de herramientas y sus niveles de riesgo
  connectors/myraypa/     cliente HTTP, version simulada y herramientas (consulta, gestion, agentes)
  integrations/github.js  disparo del workflow de agentes
  model/                  anthropic.js (real) y scripted.js (pruebas, sin API)
  voice/elevenlabs.js     voz de las respuestas con ElevenLabs (opcional)
  audit/log.js            log JSONL
docs/                     protocol.md (app<->servidor), myraypa-api.md (API de MyRAYPA que consume el servidor)
mock/                     servidor de protocolo minimo
```

## Reglas de seguridad

- Leer se ejecuta siempre. Modificar datos reales exige **confirmación explícita**, controlada por el servidor, no por el modelo.
- Mergear, desplegar, borrar o tocar producción **no existen como herramienta**: el registro rechaza cualquier riesgo que no sea `read` o `write`.
- Un mensaje que no sea la confirmación anula la acción pendiente; una acción pendiente muere con la conexión.
- Una escritura no se ejecuta si no se puede registrar en la auditoría.
- Los permisos por proyecto (habilitado o no, nivel de autonomía) los aplica la API de MyRAYPA, no las instrucciones del modelo.
- Los agentes solo abren pull requests; el token de GitHub de este servidor solo necesita *Actions: write* en esos repositorios.

## Ejecutar (Windows)

Requisitos: Node.js 22.9 o superior. Móvil y PC en la misma red para las pruebas.

```powershell
powershell -ExecutionPolicy Bypass -File .\run.ps1
```

Sin `.env` arranca en modo pruebas (modelo guionizado y MyRAYPA simulado, sin gastar API), genera un token y muestra las
direcciones `ws://IP:8080/ws` para la app. Si el móvil no conecta, el script indica el comando de firewall.

Para configurarlo de verdad, copia `.env.example` a `.env`:

| Variable | Para qué |
|---|---|
| `PRAXON_TOKEN`, `PRAXON_USER` | Token de la app (mín. 12 caracteres) y nombre que aparece en la auditoría |
| `MODEL_PROVIDER=anthropic`, `ANTHROPIC_API_KEY`, `MODEL_DEFAULT` | Modelo real |
| `MYRAYPA_MODE=http`, `MYRAYPA_API_URL`, `MYRAYPA_API_TOKEN` | API real de MyRAYPA (ver `docs/myraypa-api.md`) |
| `GITHUB_MODE=http`, `GITHUB_TOKEN`, `GITHUB_WORKFLOW_FILE` | Lanzar agentes de verdad |
| `GITHUB_READ_TOKEN` | Token de grano fino solo lectura (Contents, Pull requests, Metadata) para que la revisión y la conversación consulten el código del repositorio de cada proyecto (`github_buscar_codigo`, `github_leer_codigo`, `github_commits_recientes`, `github_pull_requests`). Sin él no hay consulta de código |
| `GITHUB_MERGE_TOKEN` | Token de grano fino PROPIO (Pull requests y Contents en escritura) con el que la app fusiona los pull requests de los agentes. Sin él se puede revisar el diff pero no fusionar. La fusión va atada al SHA revisado y nunca se hace por voz |
| `GITHUB_MERGE_METHOD` | `squash` (por defecto), `merge` o `rebase` |
| `AGENTS_WATCH` / `AGENTS_WATCH_SECONDS` | Seguimiento de los agentes en GitHub (por defecto sí, cada 60 s). Necesita que `GITHUB_READ_TOKEN` tenga además Actions y Checks (y Commit statuses) en lectura |
| `AGENTS_QUEUE_TIMEOUT_MINUTES` | Minutos en cola sin que GitHub arranque el workflow antes de marcar el agente como fallido (10) |
| `TRIAGE_WATCH` (`true`), `TRIAGE_WATCH_MINUTES` (5), `TRIAGE_WATCH_SETTLE_MINUTES` (3), `TRIAGE_WATCH_BATCH` (5), `TRIAGE_WATCH_FROM`, `REVIEWED_PATH` | Vigilante de tickets nuevos (con `TRIAGE_ENABLED=true`): cada `TRIAGE_WATCH_MINUTES` pregunta a MyRAYPA por los tickets creados desde la marca de corte (por defecto, el primer arranque; `TRIAGE_WATCH_FROM` la fija) y revisa solo los que llevan `TRIAGE_WATCH_SETTLE_MINUTES` creados, en lotes de `TRIAGE_WATCH_BATCH`. Solo deja aviso si hay algo que aprobar |
| `TRIAGE_CODE_MAX_CALLS` | Consultas de código que puede hacer cada revisión (12 por defecto; 0 las desactiva) |

Con el modelo guionizado puedes probar: "¿qué hay abierto en calibraciones?" y "pasa el de los faltantes a urgente"
(pide confirmación; di "confirmo" o "cancela").

## Voz de las respuestas (ElevenLabs, opcional)

Con `VOICE_PROVIDER=elevenlabs` (más `ELEVENLABS_API_KEY` y `ELEVENLABS_VOICE_ID`) cada frase de la respuesta se sintetiza con
ElevenLabs y llega a la app como audio mp3; la app la reproduce en orden. Por defecto usa el modelo `eleven_flash_v2_5`
(baja latencia, admite español). El reconocimiento de lo que dices sigue en el móvil.

- **Respaldo:** si ElevenLabs falla o tarda, esa frase llega como texto y la app la lee con la voz de Android. Tras 3 fallos
  seguidos deja de intentarlo durante un minuto.
- **Ahorro:** las frases se sintetizan en paralelo (máx. 2 a la vez, por el límite de peticiones simultáneas de las cuentas), y si
  interrumpes la respuesta se cancelan las que quedaban por sintetizar.
- **Privacidad:** el texto de cada respuesta (títulos de tickets, nombres...) sale hacia ElevenLabs. El endpoint de residencia en la
  UE (`ELEVENLABS_BASE_URL=https://api.eu.residency.elevenlabs.io`) es solo para clientes Enterprise, con otra cuenta y otra clave, y
  su documentación indica que parte del procesamiento puede hacerse fuera de la UE salvo con Zero Retention Mode. Conviene tenerlo
  en la revisión de RGPD. En la app, la casilla "Voz de alta calidad del servidor" permite desactivarlo.
- **Coste:** ElevenLabs cobra por caracteres sintetizados, según tu plan.

## Revisión automática y propuestas

El asistente puede trabajar sin que le preguntes: revisa los tickets por su cuenta, deja un resumen y **acciones preparadas
sin ejecutar** (por ejemplo, subir de prioridad un ticket) para que solo tengas que aprobarlas o descartarlas.

- Usa el modelo `TRIAGE_MODEL` (por defecto `claude-sonnet-5-5`), independiente de `MODEL_DEFAULT` (la conversación): puedes poner un modelo más barato en la conversación y dejar Sonnet para la revisión.
- Se activa con `TRIAGE_ENABLED=true` y corre a las horas de `TRIAGE_TIMES` (hora de Madrid, por defecto `08:30`). También se
  puede lanzar a mano con `proposals_run` desde la app. Necesita el modelo real (`MODEL_PROVIDER=anthropic`); con el modelo
  guionizado hace una revisión de prueba.
- El modelo solo puede consultar y proponer. Las acciones permitidas son las de `TRIAGE_ALLOWED_TOOLS`; los agentes, los
  roadmaps y los merges quedan fuera.
- Al aprobar, se comprueba que el ticket no ha cambiado desde la propuesta (si cambió, queda `obsoleta`) y la ejecución se
  audita. Las propuestas caducan a las `PROPOSAL_TTL_HOURS` (48 por defecto) y se guardan en `PROPOSALS_PATH`.
- Por voz: «¿qué has detectado?» usa las propuestas pendientes y «aplica la primera» pasa por la confirmación normal.

Protocolo con la app en `docs/protocol.md`. Las notificaciones push (aviso con la app cerrada) están pendientes.

## Tests

```powershell
npm install
npm test
```

Cubren las confirmaciones (no ejecutar sin confirmar, caducidad, un solo uso, otra sesión, corte de conexión), el registro
de riesgos, la auditoría obligatoria, las interrupciones, los agentes y el flujo completo por WebSocket.

## Pendiente

- Probar contra una base de datos real con muchos proyectos y tickets (la API está implementada; ver `docs/myraypa-api.md`).
- Tokens por usuario en vez de uno compartido (hoy el log usa `PRAXON_USER`).
- Auditoría también en MyRAYPA (historial del ticket y AgentRun), además del fichero local.
- `wss://` con certificado interno, y desplegar como proceso gestionado (PM2) en el servidor local.
- Decidir el proveedor del modelo (API directa, Bedrock o Vertex con región UE) y la revisión de RGPD.
- Servir las herramientas también como servidor MCP (`src/mcp/`).

## Probar contra MyRAYPA real, todo en local

1. **Backend de MyRAYPA** (`raypa-platform/backend`): añade a su `.env`

   ```
   ASSISTANT_API_TOKEN=<cadena aleatoria de 32+ caracteres>
   ASSISTANT_USER_EMAIL=<email de un usuario existente de MyRAYPA>
   ```

   y arráncalo (puerto 4000 por defecto).
2. **Habilita un proyecto** para el asistente (desde el backend):

   ```
   node --env-file=.env scripts/assistant-enable-project.js --list
   node --env-file=.env scripts/assistant-enable-project.js <projectId> --autonomy tickets
   ```

3. **Comprueba la API** (PowerShell: usa `curl.exe`):

   ```
   curl.exe -H "Authorization: Bearer <ASSISTANT_API_TOKEN>" http://localhost:4000/api/assistant/projects
   ```

4. **Servidor Praxon**: en su `.env` pon `MYRAYPA_MODE=http`, `MYRAYPA_API_URL=http://localhost:4000/api` y
   `MYRAYPA_API_TOKEN=<el mismo token>`. Arranca con `run.ps1`.
5. **Móvil en la misma wifi**: en la app, `ws://<IP-del-PC>:8080/ws` y el `PRAXON_TOKEN`. El móvil solo habla con
   el servidor Praxon; nunca con MyRAYPA.


## Emparejar la app (QR)

`npm run pair` imprime un código QR con la dirección del servidor y el token (`praxon://pair?...`); la app lo escanea y
se vincula sin escribir nada. También arranca solo al iniciar el servidor, y `http://localhost:PUERTO/pair` muestra el
mismo código en una página (solo accesible desde el propio equipo del servidor). El QR **contiene el token**: no lo
compartas ni lo captures. Con `PRAXON_PUBLIC_URL=wss://dominio/ws` el QR usa esa dirección en lugar de la IP local.

## Cobertura del módulo de tickets

Herramientas de lectura: proyectos, tickets, detalle completo (horas, etiquetas, checklist, campos, subtareas,
participantes), roadmaps e hitos, etiquetas, campos personalizados, miembros, informes de proyecto, carga de trabajo e
informe de horas. Escritura (siempre con confirmación): crear/cambiar tickets, comentar, prioridades, fechas y
estimación, horas, etiquetas, checklist, campos personalizados, subtareas, participantes, elementos e hitos de roadmap
y agentes. Contrato en `docs/myraypa-api.md`.

## Dictado en el servidor (ElevenLabs Scribe, opcional)

Con `STT_PROVIDER=elevenlabs` (y `ELEVENLABS_API_KEY`) la app deja de usar el reconocedor de Android, que pita en cada reinicio y
no está pensado para escuchar de forma continua: captura el micrófono ella misma y el servidor transcribe en directo.
Variables: `STT_LANGUAGE` (`es`), `STT_SILENCE_SECS` (1,2), `STT_MAX_SECONDS` (45), `ELEVENLABS_STT_URL`. Protocolo en `docs/protocol.md`.
En la app, el ajuste "Conversación continua" hace que vuelva a escuchar sola tras cada respuesta hasta que haya silencio.
