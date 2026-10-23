import { JsonlAudit } from './audit/log.js';
import { buildSystemPrompt } from './prompts.js';
import { HttpMyraypaClient } from './connectors/myraypa/client.js';
import { FakeMyraypa } from './connectors/myraypa/fake.js';
import { createMyraypaConnector } from './connectors/myraypa/index.js';
import { FakeGithub, HttpGithub } from './integrations/github.js';
import { ElevenLabsVoice } from './voice/elevenlabs.js';
import { ElevenLabsScribe } from './voice/stt.js';
import { AnthropicModel } from './model/anthropic.js';
import { ScriptedModel } from './model/scripted.js';
import { Orchestrator } from './orchestrator.js';
import { createServer } from './server.js';
import { ToolRegistry } from './tools/registry.js';
import { ProposalStore } from './proposals/store.js';
import { Triage } from './proposals/triage.js';
import { TriageScheduler } from './proposals/scheduler.js';
import { proposalTools } from './proposals/tools.js';

/** Monta todas las piezas segun la configuracion. Los `overrides` permiten sustituirlas en los tests. */
export function createApp(config, overrides = {}) {
  const audit = overrides.audit ?? new JsonlAudit(config.AUDIT_LOG_PATH);

  const myraypa =
    overrides.myraypa ??
    (config.MYRAYPA_MODE === 'http'
      ? new HttpMyraypaClient({ baseUrl: config.MYRAYPA_API_URL, token: config.MYRAYPA_API_TOKEN })
      : new FakeMyraypa());
  const github =
    overrides.github ??
    (config.GITHUB_MODE === 'http' ? new HttpGithub({ token: config.GITHUB_TOKEN, workflowFile: config.GITHUB_WORKFLOW_FILE }) : new FakeGithub());
  const model =
    overrides.model ??
    (config.MODEL_PROVIDER === 'anthropic'
      ? new AnthropicModel({ apiKey: config.ANTHROPIC_API_KEY, maxTokens: config.MAX_TOKENS })
      : new ScriptedModel());

  const voice =
    overrides.voice ??
    (config.VOICE_PROVIDER === 'elevenlabs'
      ? new ElevenLabsVoice({
          apiKey: config.ELEVENLABS_API_KEY,
          voiceId: config.ELEVENLABS_VOICE_ID,
          model: config.ELEVENLABS_MODEL,
          outputFormat: config.ELEVENLABS_OUTPUT_FORMAT,
          baseUrl: config.ELEVENLABS_BASE_URL,
          languageCode: config.ELEVENLABS_LANGUAGE,
        })
      : null);

  const stt =
    overrides.stt ??
    (config.STT_PROVIDER === 'elevenlabs'
      ? new ElevenLabsScribe({
          apiKey: config.ELEVENLABS_API_KEY,
          baseUrl: config.ELEVENLABS_STT_URL,
          language: config.STT_LANGUAGE,
          silenceSecs: config.STT_SILENCE_SECS,
          maxSeconds: config.STT_MAX_SECONDS,
        })
      : null);

  // Cada sistema nuevo (Salesforce, SAP B1, Google Workspace...) sera otro conector registrado aqui,
  // con las mismas reglas de riesgo, confirmacion y auditoria.
  const registry = new ToolRegistry().registerConnector(createMyraypaConnector({ client: myraypa, github }));

  // Revision automatica: el asistente analiza por su cuenta y deja propuestas; solo se ejecutan si el usuario las aprueba.
  const store = overrides.proposalStore ?? new ProposalStore(config.PROPOSALS_PATH);
  const triage = new Triage({ model, registry, audit, store, config, now: overrides.now });
  registry.registerConnector({ name: 'praxon', tools: proposalTools({ store, triage }) });

  const orchestrator = new Orchestrator({
    model,
    registry,
    audit,
    config,
    // Se reconstruye en cada llamada al modelo: lleva la fecha y el usuario actuales.
    systemPrompt: (session) => buildSystemPrompt({ name: config.ASSISTANT_NAME, user: session.user }),
    voice,
    now: overrides.now,
  });
  const server = createServer({ config, orchestrator, audit, triage, myraypa, auth: overrides.auth, stt });
  // Se arranca desde index.js (start); en los tests no se programa nada.
  const scheduler = new TriageScheduler({
    times: config.TRIAGE_TIMES,
    now: overrides.now,
    run: async () => {
      await triage.run({ user: config.PRAXON_USER, trigger: 'schedule' });
      server.broadcast(triage.view());
    },
  });
  return { server, orchestrator, registry, audit, myraypa, github, model, voice, stt, store, triage, scheduler };
}
