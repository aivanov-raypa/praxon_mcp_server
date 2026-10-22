import { z } from 'zod';

const schema = z
  .object({
    PORT: z.coerce.number().int().min(0).max(65535).default(8080),
    HOST: z.string().default('0.0.0.0'),
    PRAXON_TOKEN: z.string().min(12, 'PRAXON_TOKEN debe tener al menos 12 caracteres'),
    PRAXON_USER: z.string().min(1).default('desconocido'),
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
