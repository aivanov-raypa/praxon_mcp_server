# API de MyRAYPA para el asistente (propuesta)

**Estado: propuesta pendiente de validar.** Es lo que espera `src/connectors/myraypa/client.js`
(todas las rutas están en `ROUTES`). Hay que comprobar cuáles existen ya en raypa-platform y crear el resto.

El asistente habla con MyRAYPA **solo por esta API HTTP**, con una credencial propia de permisos acotados
(`MYRAYPA_API_TOKEN`), nunca directamente con MongoDB.

## Reglas que debe aplicar la API (no el modelo)

- Un proyecto que no esté habilitado en su sección "Asistente IA" **no existe** para el asistente
  (no aparece en listados y devuelve 404 si se pide por id).
- El nivel de autonomía del proyecto limita lo que se puede hacer: `consulta` < `tickets` < `agentes`.
  Fuera de nivel → 403.
- Toda escritura recibe `origin` (`{ type: "voice-assistant", user, sessionId }`) y debe guardarlo en el historial
  del ticket, para distinguir cambios manuales, de la voz y de agentes.

## Rutas propuestas (prefijo `MYRAYPA_API_URL`)

| Método | Ruta | Para qué |
|---|---|---|
| GET | `/assistant/projects` | Proyectos habilitados: `[{ id, nombre, autonomia, repo }]` |
| GET | `/assistant/tickets?proyecto&estado&prioridad&asignado&texto&limit` | `{ total, tickets: [...] }`, más prioritarios primero |
| GET | `/assistant/tickets/:id` | Detalle con `proyecto: { id, nombre, autonomia, repo, ramaBase }` y últimos comentarios |
| GET | `/assistant/projects/:id/summary` | Totales por estado y prioridad, y urgentes abiertos |
| POST | `/assistant/tickets` | Crear ticket |
| PATCH | `/assistant/tickets/:id` | Cambiar `estado`, `prioridad`, `asignado` |
| POST | `/assistant/tickets/:id/comments` | Comentar |
| PUT | `/assistant/projects/:id/priorities` | Reordenar: `{ orden: [ids...] }` |
| POST | `/assistant/agent-runs` | Crear AgentRun `{ ticketId, tipo }` → `{ runId, ticketId, estado, repo, ramaBase }` |
| GET | `/assistant/agent-runs?runId&ticketId` | Estado del AgentRun (el más reciente del ticket) o `null` |
| POST | `/assistant/agent-runs/:id/cancel` | Cancelar |

Errores: `{ "message": "..." }` con 400, 401, 403 o 404; el servidor los traduce a mensajes claros para la voz.
