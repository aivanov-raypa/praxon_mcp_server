import { z } from 'zod';

const schema = z
  .object({
    PORT: z.coerce.number().int().min(0).max(65535).default(8080),
    HOST: z.string().default('0.0.0.0'),
    PRAXON_TOKEN: z.string().min(12, 'PRAXON_TOKEN debe tener al menos 12 caracteres'),
    // Token compartido de desarrollo. En producción, empareja los móviles desde MyRAYPA y pon ALLOW_LEGACY_TOKEN=false.
    ALLOW_LEGACY_TOKEN: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
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
    GITHUB_TOKEN: z.string().optional(),
    GITHUB_WORKFLOW_FILE: z.string().default('praxon-agent.yml'),

    VOICE_PROVIDER: z.enum(['none', 'elevenlabs']).default('none'),
    ELEVENLABS_API_KEY: z.string().optional(),
    ELEVENLABS_VOICE_ID: z.string().optional(),
    ELEVENLABS_MODEL: z.string().default('eleven_flash_v2_5'),
    ELEVENLABS_OUTPUT_FORMAT: z.string().regex(/^mp3_/, 'la app solo reproduce mp3 (mp3_*)').default('mp3_44100_128'),
    ELEVENLABS_BASE_URL: z.string().url().default('https://api.elevenlabs.io'),
    ELEVENLABS_LANGUAGE: z.string().default('es'),

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
    TRIAGE_MAX_STEPS: z.coerce.number().int().positive().default(14),
    TRIAGE_MAX_ACTIONS: z.coerce.number().int().positive().default(10),
    TRIAGE_TIMEOUT_MS: z.coerce.number().int().positive().default(180_000),
    PROPOSAL_TTL_HOURS: z.coerce.number().positive().default(48),
    PROPOSALS_PATH: z.string().default('./data/proposals.json'),

    CONFIRM_TTL_MS: z.coerce.number().int().positive().default(60_000),
    MAX_TOOL_ITERATIONS: z.coerce.number().int().positive().default(6),
    MAX_HISTORY_MESSAGES: z.coerce.number().int().min(4).default(40),
    AUDIT_LOG_PATH: z.string().default('./logs/audit.jsonl'),
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
