# API de MyRAYPA para el asistente

**Estado: implementada** en `raypa-platform/backend` (rutas en `routes/assistant.routes.js`, montadas en `/api/assistant`;
lógica en `services/assistant/`). Es lo que consume `src/connectors/myraypa/client.js` (todas las rutas están en `ROUTES`).

El asistente habla con MyRAYPA **solo por esta API HTTP**, nunca directamente con MongoDB.

## Autenticación

Cabecera `Authorization: Bearer <ASSISTANT_API_TOKEN>`. No usa la cookie de sesión de los usuarios.
Variables del backend (`.env` de raypa-platform):

| Variable | Para qué |
|---|---|
| `ASSISTANT_API_TOKEN` | Credencial compartida con el servidor Praxon (`MYRAYPA_API_TOKEN`). Mínimo 32 caracteres. Sin ella la API responde 503 |
| `ASSISTANT_USER_EMAIL` | Usuario de MyRAYPA que figura como autor de lo que hace el asistente. Debe existir |

## Reglas que aplica la API (no el modelo)

- Un proyecto no existe para el asistente (no sale en listados, 404 por id) salvo que esté **activo** y tenga
  `aiAssistant.enabled = true`. Se configura con `PUT /api/projects/:id/ai-assistant` (solo propietario o admin) o con
  `node --env-file=.env scripts/assistant-enable-project.js` en el backend.
- Nivel de autonomía por proyecto: `consulta` < `tickets` < `agentes`. Fuera de nivel → 403. `agentes` exige repositorio.
- `updateProject` ignora `aiAssistant`: nadie lo activa editando el proyecto por la vía normal.
- Toda escritura recibe `origin` (`{ type: "voice-assistant", user, sessionId }`) y queda en el `activityLog` del ticket
  con `origin: "voice-assistant"`. Los comentarios se publican con el prefijo "Asistente de voz (a petición de …)".

## Modelo de datos (cómo se traduce)

- **Ticket id**: el `_id` de Mongo como texto. Los tickets no tienen número.
- **Prioridad**: `ninguna | baja | media | alta`. No existe "urgente": pedirlo devuelve 400 explicando las que hay.
- **Estado**: el título (o id) de una columna del proyecto, sin importar acentos ni mayúsculas ("en progreso").
  Los estados de cada proyecto salen en `GET /projects` (`estados`). Un estado inexistente devuelve 400 con la lista.
- **Completado**: `completado` (booleano) es independiente del estado, igual que el check de MyRAYPA.
- **Reordenar**: asigna `order` 0..n-1 a los tickets indicados. No cambia la prioridad.

## Rutas (prefijo `MYRAYPA_API_URL`, p. ej. `http://localhost:4000/api`)

| Método | Ruta | Cuerpo / query | Respuesta |
|---|---|---|---|
| GET | `/assistant/projects` | | `[{ id, nombre, autonomia, repo, ramaBase, estados:[{id,titulo}] }]` |
| GET | `/assistant/tickets` | `proyecto, estado, prioridad, asignado, texto, mostrar (abiertos\|completados\|todos), limit` | `{ total, tickets:[vista] }`, más prioritarios primero |
| GET | `/assistant/tickets/:id` | | vista + `descripcion`, `proyecto:{id,nombre,autonomia,repo,ramaBase}`, `comentarios` (últimos 5) |
| POST | `/assistant/tickets` | `{ proyectoId, titulo, descripcion?, prioridad?, asignado?, origin }` | 201 vista (estado = primera columna) |
| PATCH | `/assistant/tickets/:id` | `{ estado?, prioridad?, asignado?, completado?, origin }` | vista; 409 si no cambia nada |
| POST | `/assistant/tickets/:id/comments` | `{ texto, origin }` | 201 `{ ok, ticketId }` |
| GET | `/assistant/projects/:id/summary` | | `{ proyecto, abiertos, completados, porEstado, porPrioridad, prioritarios }` |
| PUT | `/assistant/projects/:id/priorities` | `{ orden:[ids], origin }` | `{ ok, proyecto, reordenados }` |
| POST | `/assistant/agent-runs` | `{ ticketId, tipo: mejora\|error, origin }` | 201 `{ runId, ticketId, tipo, estado, repo, ramaBase, rama, pullRequest, githubRunId, bloqueo }`; 409 si ya hay uno activo |
| GET | `/assistant/agent-runs` | `runId` o `ticketId` (el más reciente) | run o `null` |
| POST | `/assistant/agent-runs/:id/cancel` | `{ origin }` | run; 409 si ya terminó |
| PATCH | `/assistant/agent-runs/:id` | `{ estado?, rama?, prUrl?, githubRunId?, pregunta? }` | run. Callback para el workflow de GitHub |

Vista de ticket: `{ id, titulo, estado, estadoId, prioridad, completado, asignado, proyecto, proyectoId, vencimiento }`.

Errores: `{ "message": "..." }` con 400, 401, 403, 404, 409 o 503; el servidor Praxon los traduce a frases claras para la voz.

## Límites conocidos (v1)

- Los cambios hechos por el asistente emiten los eventos de socket de tickets (el tablero se actualiza en vivo) pero **no**
  generan notificaciones in-app ni emails.
- El autor en el historial es el usuario de `ASSISTANT_USER_EMAIL`; no hay un usuario "Agente IA" propio.
- El `AgentRun` se crea en MyRAYPA, pero el disparo del workflow de GitHub sigue en modo `fake` hasta que exista
  `praxon-agent.yml` en el repositorio (ver `GITHUB_MODE`).

## Roadmaps e hitos

Un roadmap es visible para el asistente solo si algún proyecto vinculado (`linkedProjectId` en bloque, tarea o subtarea) está habilitado. Modificarlo exige autonomía `tickets` o superior en alguno de esos proyectos. Las fechas son siempre `AAAA-MM-DD`.

| Método | Ruta | Uso |
|---|---|---|
| GET | `/api/assistant/roadmaps?proyecto=&texto=&limit=` | Lista de roadmaps visibles |
| GET | `/api/assistant/roadmaps/:id` | Detalle: bloques > tareas > subtareas e hitos |
| POST | `/api/assistant/roadmaps/:id/elementos` | Añadir bloque, tarea o subtarea (`tipo`, `padreId`, `titulo`, `inicio`, `fin`) |
| PATCH | `/api/assistant/roadmaps/:id/elementos/:elementId` | Cambiar título, fechas o `hecho` |
| POST/PATCH | `/api/assistant/roadmaps/:id/hitos[/:hitoId]` | Hitos del roadmap |
| GET/POST/PATCH | `/api/assistant/projects/:id/hitos[/:hitoId]` | Hitos del proyecto |

Herramientas: `listar_roadmaps`, `detalle_roadmap`, `listar_hitos_proyecto` (lectura); `actualizar_elemento_roadmap`, `anadir_elemento_roadmap`, `anadir_hito_roadmap`, `actualizar_hito_roadmap`, `anadir_hito_proyecto`, `actualizar_hito_proyecto` (escritura, con confirmación).

## Detalle ampliado, horas, etiquetas, checklist, campos, subtareas, participantes e informes

Escrituras: autonomía `tickets` o superior; todo queda en el `activityLog` con origen `voice-assistant`. Fechas `AAAA-MM-DD`.

| Método | Ruta | Cuerpo / query |
|---|---|---|
| GET | `/assistant/tickets/:id/detalle` | Todo el ticket: horas, etiquetas, checklist, campos, participantes, subtareas |
| PATCH | `/assistant/tickets/:id/fechas` | `{ inicio?, vencimiento?, estimadoHoras? }` (`null` borra) |
| POST | `/assistant/tickets/:id/horas` | `{ horas (0-24], nota?, fecha?, usuario? }` |
| PATCH | `/assistant/tickets/:id/etiquetas` | `{ anadir?: [nombre], quitar?: [nombre] }` (deben existir en el proyecto) |
| POST | `/assistant/tickets/:id/checklist` | `{ texto }` |
| PATCH | `/assistant/tickets/:id/checklist/:itemId` | `{ completado?, texto? }`; `itemId` = id, número o parte del texto |
| PUT | `/assistant/tickets/:id/campos` | `{ campo, valor }` validado según el tipo del campo |
| POST | `/assistant/tickets/:id/subtareas` | `{ titulo, prioridad?, asignado?, vencimiento? }` (un solo nivel) |
| PATCH | `/assistant/tickets/:id/participantes` | `{ anadir?, quitar? }` |
| GET | `/assistant/projects/:id/etiquetas` · `/campos` · `/miembros` | Catálogos del proyecto |
| GET | `/assistant/projects/:id/informe?desde=&hasta=` | Abiertos/completados, por estado y prioridad, vencidos, horas por persona, desviaciones |
| GET | `/assistant/informes/carga?proyecto=` | Carga por persona |
| GET | `/assistant/informes/horas?proyecto=&usuario=&desde=&hasta=` | Horas por persona y proyecto |

Las horas se atribuyen a `usuario` si se indica; si no, al usuario técnico del asistente (con la nota "apuntado por el asistente").
