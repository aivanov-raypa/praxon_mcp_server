import { z } from 'zod';

const schema = z
  .object({
    PORT: z.coerce.number().int().min(0).max(65535).default(8080),
    HOST: z.string().default('0.0.0.0'),
    PRAXON_TOKEN: z.string().min(12, 'PRAXON_TOKEN debe tener al menos 12 caracteres'),
    // Token compartido de desarrollo: DESACTIVADO por defecto. Los móviles se emparejan desde MyRAYPA (token por dispositivo, revocable).
    ALLOW_LEGACY_TOKEN: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
    PRAXON_USER: z.string().min(1).default('desconocido'),
    PRAXON_PUBLIC_URL: z.string().regex(/^wss?:\/\/.+/, 'debe empezar por ws:// o wss://').optional(),
    ASSISTANT_NAME: z.string().min(1).default('Praxon'),

    MODEL_PROVIDER: z.enum(['scripted', 'anthropic']).default('scripted'),
    ANTHROPIC_API_KEY: z.string().optional(),
    MODEL_DEFAULT: z.string().default('claude-sonnet-5-5'),
    MAX_TOKENS: z.coerce.number().int().positive().default(1024),

    MYRAYPA_MODE: z.enum(['fake', 'http']).default('fake'),
    MYRAYPA_API_URL: z.string().url().optional(),
    MYRAYPA_API_TOKEN: z.string().optional(),

    GITHUB_MODE: z.enum(['fake', 'http']).default('fake'),
    // Calendario y correo de Google (solo lectura, un único usuario). off = desactivado. Ver docs/google.md.
    GOOGLE_MODE: z.enum(['off', 'fake', 'http']).default('off'),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    GOOGLE_REFRESH_TOKEN: z.string().optional(),
    GOOGLE_OWNER_EMAIL: z.string().email().optional(),
    GOOGLE_TIMEZONE: z.string().default('Europe/Madrid'),
    GOOGLE_WORK_START: z.coerce.number().int().min(0).max(23).default(9),
    GOOGLE_WORK_END: z.coerce.number().int().min(1).max(24).default(18),
    GOOGLE_MAIL_BODY_MAX: z.coerce.number().int().min(200).max(20000).default(3000),
    GITHUB_TOKEN: z.string().optional(),
    // Adjuntos legibles de más de estos KB no se leen sin que el usuario lo confirme (0 = sin límite). En la revisión automática se omiten.
    ATTACH_CONFIRM_KB: z.coerce.number().int().min(0).default(300),
    GITHUB_WORKFLOW_FILE: z.string().default('praxon-agent.yml'),
    // Lectura del código de los proyectos (revisión y conversación). Token de grano fino SOLO de lectura
    // (Contents, Pull requests, Metadata), distinto de GITHUB_TOKEN. Sin él, el asistente no consulta código.
    GITHUB_READ_TOKEN: z.string().optional(),
    // Panel de consumos (todo opcional; sin credencial, esa tarjeta sale "sin configurar").
    USAGE_PATH: z.string().default('./data/usage.json'),
    USAGE_CACHE_MINUTES: z.coerce.number().min(1).default(10),
    GITHUB_ORG: z.string().default('raypa-it'),
    // Token de grano fino con permiso de facturación de la organización (solo lectura).
    GITHUB_BILLING_TOKEN: z.string().optional(),
    // Clave de administración de Anthropic (sk-ant-admin...). Es sensible: gestiona claves y miembros de la organización.
    ANTHROPIC_ADMIN_KEY: z.string().optional(),
    // Fusión de pull requests desde la app. Token de grano fino PROPIO (Pull requests y Contents en escritura). Sin él no se puede fusionar.
    GITHUB_MERGE_TOKEN: z.string().optional(),
    // Correos (separados por comas) de quienes pueden fusionar PRs o pedir cambios al agente. Vacío = cualquier dispositivo emparejado.
    MERGE_ALLOWED_USERS: z
      .string()
      .default('')
      .transform((v) => v.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)),
    // Intentos de conexión fallidos por IP antes de bloquearla temporalmente.
    AUTH_FAIL_MAX: z.coerce.number().int().positive().default(20),
    AUTH_FAIL_WINDOW_MINUTES: z.coerce.number().positive().default(10),
    // Tope de gasto del modelo (ver safety/budget.js). Estimación en euros a partir de los tokens y de estos precios (USD por millón de
    // tokens, los de Claude Sonnet 5.5; si usas otro modelo, ajústalos). 0 desactiva cada límite.
    BUDGET_DAILY_EUR: z.coerce.number().min(0).default(5),
    BUDGET_TRIAGE_DAILY_EUR: z.coerce.number().min(0).default(1.5),
    BUDGET_WARN_PCT: z.coerce.number().min(1).max(100).default(70),
    BUDGET_TRIM_PCT: z.coerce.number().min(1).max(100).default(90),
    BUDGET_MAX_CALLS_PER_MIN: z.coerce.number().int().min(0).default(40),
    BUDGET_MAX_CALLS_PER_HOUR: z.coerce.number().int().min(0).default(600),
    COST_INPUT_USD_MTOK: z.coerce.number().min(0).default(2),
    COST_OUTPUT_USD_MTOK: z.coerce.number().min(0).default(10),
    COST_CACHE_WRITE_USD_MTOK: z.coerce.number().min(0).default(2.5),
    COST_CACHE_READ_USD_MTOK: z.coerce.number().min(0).default(0.2),
    COST_EUR_PER_USD: z.coerce.number().positive().default(0.9),
    // Fichero del interruptor de emergencia: si existe, Praxon está en pausa (ver safety/pause.js).
    PAUSE_PATH: z.string().default('./data/pausa.json'),
    GITHUB_MERGE_METHOD: z.enum(['squash', 'merge', 'rebase']).default('squash'),
    // Ramas destino en las que Praxon puede fusionar (separadas por comas). Por defecto solo develop: nunca main ni producción.
    // "*" desactiva la restricción (no recomendado). Se comprueba al listar, al fusionar y de nuevo justo antes de llamar a GitHub.
    MERGE_ALLOWED_BASES: z
      .string()
      .default('develop')
      .transform((v) => v.split(',').map((x) => x.trim()).filter(Boolean)),
    // Seguimiento de agentes: sondeo a GitHub (necesita GITHUB_READ_TOKEN con Actions y Checks en lectura).
    AGENTS_WATCH: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
    AGENTS_WATCH_SECONDS: z.coerce.number().min(15).default(60),
    AGENTS_QUEUE_TIMEOUT_MINUTES: z.coerce.number().min(2).default(10),

    VOICE_PROVIDER: z.enum(['none', 'elevenlabs']).default('none'),
    ELEVENLABS_API_KEY: z.string().optional(),
    ELEVENLABS_VOICE_ID: z.string().optional(),
    ELEVENLABS_MODEL: z.string().default('eleven_flash_v2_5'),
    ELEVENLABS_OUTPUT_FORMAT: z.string().regex(/^mp3_/, 'la app solo reproduce mp3 (mp3_*)').default('mp3_44100_128'),
    ELEVENLABS_BASE_URL: z.string().url().default('https://api.elevenlabs.io'),
    ELEVENLABS_LANGUAGE: z.string().default('es'),

    // Dictado: la app envía el audio del micrófono y el servidor lo transcribe en directo (usa ELEVENLABS_API_KEY).
    STT_PROVIDER: z.enum(['none', 'elevenlabs']).default('none'),
    STT_LANGUAGE: z.string().default('es'),
    STT_SILENCE_SECS: z.coerce.number().min(0.3).max(3).default(1.2),
    STT_MAX_SECONDS: z.coerce.number().positive().default(45),
    ELEVENLABS_STT_URL: z.string().regex(/^wss?:\/\/.+/, 'debe empezar por ws:// o wss://').default('wss://api.elevenlabs.io'),

    // Revision automatica: el asistente analiza los tickets por su cuenta y deja propuestas que el usuario aprueba.
    TRIAGE_ENABLED: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
    TRIAGE_TIMES: z
      .string()
      .default('08:30')
      .transform((v) => v.split(',').map((x) => x.trim()).filter(Boolean))
      .refine((l) => l.every((x) => /^([01]\d|2[0-3]):[0-5]\d$/.test(x)), 'horas HH:MM separadas por comas (hora de Madrid)'),
    TRIAGE_ALLOWED_TOOLS: z
      .string()
      .default('myraypa_actualizar_ticket,myraypa_comentar_ticket,myraypa_cambiar_fechas_ticket,myraypa_cambiar_etiquetas_ticket,myraypa_cambiar_participantes_ticket,myraypa_crear_subtarea')
      .transform((v) => v.split(',').map((x) => x.trim()).filter(Boolean)),
    // Modelo de la revisión automática (analiza muchos tickets: conviene el más capaz). La conversación usa MODEL_DEFAULT.
    TRIAGE_MODEL: z.string().default('claude-sonnet-5-5'),
    // Vigilante de tickets nuevos: sondea MyRAYPA y revisa solo los creados desde la última vez (con TRIAGE_ENABLED=true).
    TRIAGE_WATCH: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
    TRIAGE_WATCH_MINUTES: z.coerce.number().min(1).default(5),
    // Un ticket se revisa cuando lleva este tiempo creado (por si se edita justo después de crearlo).
    TRIAGE_WATCH_SETTLE_MINUTES: z.coerce.number().min(0).default(3),
    TRIAGE_WATCH_BATCH: z.coerce.number().int().positive().default(5),
    // Fecha ISO desde la que revisar la primera vez (si no, desde que arranca por primera vez).
    TRIAGE_WATCH_FROM: z.string().optional(),
    REVIEWED_PATH: z.string().default('./data/reviewed.json'),
    // Imágenes que puede abrir una revisión automática (cada una cuesta tokens de visión).
    TRIAGE_MAX_IMAGES: z.coerce.number().int().min(0).default(3),
    // Nuevo comentario en un ticket ya revisado: se vuelve a revisar, como mucho cada X minutos y N veces por ticket.
    TRIAGE_REREVIEW: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
    TRIAGE_REREVIEW_COOLDOWN_MINUTES: z.coerce.number().min(0).default(30),
    TRIAGE_MAX_REREVIEWS: z.coerce.number().int().min(0).default(3),
    // Tickets como máximo en una revisión manual/programada o pedida por voz (nunca se recorre el backlog entero).
    TRIAGE_MAX_TICKETS: z.coerce.number().int().positive().default(6),
    // Cambios que Praxon ejecuta sin pedir confirmación cuando le das una orden explícita sobre UN ticket (se pueden deshacer).
    DIRECT_WRITE: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
    DIRECT_WRITE_TOOLS: z
      .string()
      .default('myraypa_actualizar_ticket,myraypa_comentar_ticket,myraypa_cambiar_fechas_ticket')
      .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),
    TRIAGE_MAX_STEPS: z.coerce.number().int().positive().default(24),
    // Consultas de código (buscar, leer, commits, PRs) que puede hacer la revisión en cada pasada.
    TRIAGE_CODE_MAX_CALLS: z.coerce.number().int().min(0).default(12),
    TRIAGE_MAX_ACTIONS: z.coerce.number().int().positive().default(10),
    TRIAGE_TIMEOUT_MS: z.coerce.number().int().positive().default(180_000),
    // Memoria por ticket para no insistir: días sin proponer tras descartar la propuesta de un ticket, y tras cualquier propuesta (0 = desactivado).
    TICKETLOG_PATH: z.string().default('./data/tickets-propuestos.json'),
    TRIAGE_DISMISS_DAYS: z.coerce.number().int().min(0).default(90),
    TRIAGE_COOLDOWN_DAYS: z.coerce.number().int().min(0).default(14),
    PROPOSAL_TTL_HOURS: z.coerce.number().positive().default(48),
    PROPOSALS_PATH: z.string().default('./data/proposals.json'),
    CONTINUITY_PATH: z.string().default('./data/continuidad.json'),
    CONTINUITY_ENABLED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
    REMINDERS_PATH: z.string().default('./data/recordatorios.json'),
    MEMORY_PATH: z.string().default('./data/memoria.json'),
    TOOLS_DISABLED_PATH: z.string().default('./data/herramientas-desactivadas.json'),

    CONFIRM_TTL_MS: z.coerce.number().int().positive().default(180_000),
    MAX_TOOL_ITERATIONS: z.coerce.number().int().positive().default(6),
    MAX_HISTORY_MESSAGES: z.coerce.number().int().min(4).default(40),
    AUDIT_LOG_PATH: z.string().default('./logs/audit.jsonl'),
    // Privacidad del log: caracteres que se guardan de lo que dices (0 = no guardar el texto) y días que se conserva.
    AUDIT_TEXT_MAX_CHARS: z.coerce.number().int().min(0).default(200),
    AUDIT_RETENTION_DAYS: z.coerce.number().int().min(0).default(90),
  })
  .superRefine((c, ctx) => {
    const need = (cond, path, message) => cond || ctx.addIssue({ code: 'custom', path: [path], message });
    if (c.MODEL_PROVIDER === 'anthropic') need(c.ANTHROPIC_API_KEY, 'ANTHROPIC_API_KEY', 'obligatoria con MODEL_PROVIDER=anthropic');
    if (c.MYRAYPA_MODE === 'http') {
      need(c.MYRAYPA_API_URL, 'MYRAYPA_API_URL', 'obligatoria con MYRAYPA_MODE=http');
      need(c.MYRAYPA_API_TOKEN, 'MYRAYPA_API_TOKEN', 'obligatoria con MYRAYPA_MODE=http');
    }
    if (c.VOICE_PROVIDER === 'elevenlabs') {
      need(c.ELEVENLABS_API_KEY, 'ELEVENLABS_API_KEY', 'obligatoria con VOICE_PROVIDER=elevenlabs');
      need(c.ELEVENLABS_VOICE_ID, 'ELEVENLABS_VOICE_ID', 'obligatoria con VOICE_PROVIDER=elevenlabs');
    }
    if (c.STT_PROVIDER === 'elevenlabs') need(c.ELEVENLABS_API_KEY, 'ELEVENLABS_API_KEY', 'obligatoria con STT_PROVIDER=elevenlabs');
    if (c.GOOGLE_MODE !== 'off') need(c.GOOGLE_OWNER_EMAIL, 'GOOGLE_OWNER_EMAIL', 'obligatoria con GOOGLE_MODE: los datos de Google pertenecen a un solo usuario');
    if (c.GOOGLE_MODE === 'http') {
      need(c.GOOGLE_CLIENT_ID, 'GOOGLE_CLIENT_ID', 'obligatoria con GOOGLE_MODE=http');
      need(c.GOOGLE_CLIENT_SECRET, 'GOOGLE_CLIENT_SECRET', 'obligatoria con GOOGLE_MODE=http');
      need(c.GOOGLE_REFRESH_TOKEN, 'GOOGLE_REFRESH_TOKEN', 'obligatoria con GOOGLE_MODE=http (npm run google:auth)');
    }
    if (c.GITHUB_MODE === 'http') need(c.GITHUB_TOKEN, 'GITHUB_TOKEN', 'obligatoria con GITHUB_MODE=http');
  });

/** Valida las variables de entorno. Lanza un Error legible si falta algo. */
export function loadConfig(env = process.env) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(general)'}: ${i.message}`);
    throw new Error(`Configuracion no valida:\n${lines.join('\n')}`);
  }
  return parsed.data;
}
