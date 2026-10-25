# Calendario y correo de Google (solo lectura)

Praxon puede leer el calendario y el correo de **una** cuenta de Google Workspace. Es solo lectura: se piden los alcances
`calendar.readonly` y `gmail.readonly`, así que aunque el modelo lo intentara no puede enviar, borrar ni crear nada.

## Qué se activa

- Herramientas de voz: `google_agenda_eventos`, `google_agenda_huecos`, `google_correo_buscar` y `google_correo_leer`.
- Una fila **Google** en **Estado**.
- No hay pantallas de calendario ni de correo en la app: Praxon los consulta cuando se lo pides y los integra en la conversación.

## Reglas de seguridad

- Los datos son de un solo usuario (`GOOGLE_OWNER_EMAIL`). Cualquier otro móvil emparejado recibe "no conectado para tu usuario".
- El contenido de un correo es texto de terceros y puede intentar dar órdenes al asistente. Las herramientas lo marcan como
  datos y el prompt prohíbe seguir instrucciones que aparezcan dentro de un correo o un evento. Además, sobre Google no
  existe ninguna herramienta de escritura, y las de MyRAYPA que modifican datos siempre piden tu confirmación.
- La revisión automática de tickets nunca ve estas herramientas (solo ve las de lectura de MyRAYPA y GitHub).
- El texto de los correos que Praxon lee se envía a Anthropic para que pueda resumirlo. Incluye esto en el análisis de
  protección de datos (RGPD) y en el contrato de tratamiento con Anthropic antes de activarlo con correo real.
- El log de auditoría guarda un extracto (500 caracteres) del resultado de cada herramienta. Si no quieres extractos de correo
  en el log, deja `AUDIT_TEXT_MAX_CHARS` bajo y valora reducir la retención (`AUDIT_RETENTION_DAYS`).

## Puesta en marcha

1. En <https://console.cloud.google.com> crea un proyecto (por ejemplo "Praxon") con la cuenta de Workspace de RAYPA.
2. **APIs y servicios → Biblioteca**: activa **Google Calendar API** y **Gmail API**.
3. **Pantalla de consentimiento OAuth**: tipo de usuario **Interno** (así el token no caduca a los 7 días y solo pueden
   autorizar cuentas de RAYPA). Añade los alcances `.../auth/calendar.readonly` y `.../auth/gmail.readonly`.
4. **Credenciales → Crear credenciales → ID de cliente de OAuth**, tipo **Aplicación de escritorio**. Copia el ID y el secreto.
5. En el `.env` del servidor:

   ```
   GOOGLE_CLIENT_ID=...
   GOOGLE_CLIENT_SECRET=...
   GOOGLE_OWNER_EMAIL=tu.correo@raypa.com
   ```

6. En el equipo del servidor ejecuta `npm run google:auth`, abre la dirección que imprime, acepta los permisos y copia al `.env`
   las líneas que muestra (`GOOGLE_MODE=http`, `GOOGLE_REFRESH_TOKEN=...`). No subas el `.env` a git.
7. Reinicia Praxon y mira **Estado → Google**: debe poner "responde".

Para probar la app sin credenciales: `GOOGLE_MODE=fake` y `GOOGLE_OWNER_EMAIL=tu.correo@raypa.com` usan datos de ejemplo.

## Otras variables

`GOOGLE_TIMEZONE` (por defecto `Europe/Madrid`), `GOOGLE_WORK_START` y `GOOGLE_WORK_END` (jornada para buscar huecos, 9 y 18) y
`GOOGLE_MAIL_BODY_MAX` (caracteres del cuerpo que se leen, 3000).

## Revocar

Quitar el acceso en <https://myaccount.google.com/permissions> invalida el token al instante; el panel Estado pasará a rojo.
Para cambiar de cuenta, repite el paso 6 con otro `GOOGLE_OWNER_EMAIL`.
