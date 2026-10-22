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
docs/                     protocol.md (app<->servidor), myraypa-api.md (API que debe ofrecer MyRAYPA)
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

## Tests

```powershell
npm install
npm test
```

Cubren las confirmaciones (no ejecutar sin confirmar, caducidad, un solo uso, otra sesión, corte de conexión), el registro
de riesgos, la auditoría obligatoria, las interrupciones, los agentes y el flujo completo por WebSocket.

## Pendiente

- Validar con la API real de MyRAYPA qué rutas existen y crear las que falten (`docs/myraypa-api.md`).
- Tokens por usuario en vez de uno compartido (hoy el log usa `PRAXON_USER`).
- Auditoría también en MyRAYPA (historial del ticket y AgentRun), además del fichero local.
- `wss://` con certificado interno, y desplegar como proceso gestionado (PM2) en el servidor local.
- Decidir el proveedor del modelo (API directa, Bedrock o Vertex con región UE) y la revisión de RGPD.
- Servir las herramientas también como servidor MCP (`src/mcp/`).
