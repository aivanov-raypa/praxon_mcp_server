import { JsonlAudit } from './audit/log.js';
import { buildSystemPrompt } from './prompts.js';
import { HttpMyraypaClient } from './connectors/myraypa/client.js';
import { FakeMyraypa } from './connectors/myraypa/fake.js';
import { createMyraypaConnector } from './connectors/myraypa/index.js';
import { FakeGithub, HttpGithub } from './integrations/github.js';
import { HttpGithubReader } from './integrations/github-read.js';
import { createGithubConnector } from './connectors/github/index.js';
import { createGoogleConnector } from './connectors/google/index.js';
import { FakeGoogle, HttpGoogle } from './integrations/google.js';
import { ElevenLabsVoice } from './voice/elevenlabs.js';
import { ElevenLabsScribe } from './voice/stt.js';
import { AnthropicModel } from './model/anthropic.js';
import { ScriptedModel } from './model/scripted.js';
import { Orchestrator } from './orchestrator.js';
import { createServer } from './server.js';
import { ToolRegistry } from './tools/registry.js';
import { ToolControl } from './tools/control.js';
import { createPanels } from './panels.js';
import { PauseSwitch } from './safety/pause.js';
import { ProposalStore } from './proposals/store.js';
import { ContinuityStore, summarizeSession } from './companion/continuity.js';
import { UndoStore, installUndo, undoTools } from './companion/undo.js';
import { ReminderService, ReminderStore, reminderTools } from './companion/reminders.js';
import { screenTools } from './tools/screen.js';
import { TicketLog } from './proposals/ticketlog.js';
import { Triage } from './proposals/triage.js';
import { TriageScheduler } from './proposals/scheduler.js';
import { ReviewedStore } from './proposals/reviewed.js';
import { TicketWatcher } from './proposals/watcher.js';
import { AgentService } from './agents/service.js';
import { UsageTracker } from './usage/tracker.js';
import { UsageService } from './usage/service.js';
import { anthropicUsage, elevenLabsUsage, githubUsage } from './usage/providers.js';
import { HttpGithubMerger } from './integrations/github-merge.js';
import { proposalTools } from './proposals/tools.js';
import { ReviewScope } from './proposals/scope.js';
import { contextoTools } from './agents/contexto.js';
import { MemoryStore } from './memory/store.js';
import { memoryTools } from './memory/tools.js';

/** Monta todas las piezas segun la configuracion. Los `overrides` permiten sustituirlas en los tests. */
export function createApp(config, overrides = {}) {
  const audit = overrides.audit ?? new JsonlAudit(config.AUDIT_LOG_PATH, { textMax: config.AUDIT_TEXT_MAX_CHARS ?? 200 });
  // Interruptor de emergencia: en pausa no se hace ningún cambio (ver safety/pause.js).
  const pause = overrides.pause ?? new PauseSwitch(config.PAUSE_PATH, { audit, now: overrides.now });

  const myraypa =
    overrides.myraypa ??
    (config.MYRAYPA_MODE === 'http'
      ? new HttpMyraypaClient({ baseUrl: config.MYRAYPA_API_URL, token: config.MYRAYPA_API_TOKEN })
      : new FakeMyraypa());
  const github =
    overrides.github ??
    (config.GITHUB_MODE === 'http' ? new HttpGithub({ token: config.GITHUB_TOKEN, workflowFile: config.GITHUB_WORKFLOW_FILE }) : new FakeGithub());
  const githubReader = overrides.githubReader ?? (config.GITHUB_READ_TOKEN ? new HttpGithubReader({ token: config.GITHUB_READ_TOKEN }) : null);
  const merger = overrides.merger ?? (config.GITHUB_MERGE_TOKEN ? new HttpGithubMerger({ token: config.GITHUB_MERGE_TOKEN, method: config.GITHUB_MERGE_METHOD }) : null);
  const tracker = overrides.usageTracker ?? new UsageTracker(config.USAGE_PATH, { now: overrides.now });
  const model =
    overrides.model ??
    (config.MODEL_PROVIDER === 'anthropic'
      ? new AnthropicModel({ apiKey: config.ANTHROPIC_API_KEY, maxTokens: config.MAX_TOKENS, onUsage: (u) => tracker.recordModel(u) })
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
          onUsage: ({ chars }) => tracker.recordTts(chars),
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
          onUsage: ({ seconds }) => tracker.recordStt(seconds),
        })
      : null);

  // Cada sistema nuevo (Salesforce, SAP B1, Google Workspace...) sera otro conector registrado aqui,
  // con las mismas reglas de riesgo, confirmacion y auditoria.
  const toolControl = overrides.toolControl ?? new ToolControl(config.TOOLS_DISABLED_PATH);
  const registry = new ToolRegistry().setControl(toolControl).registerConnector(createMyraypaConnector({ client: myraypa, github, config }));
  if (githubReader) registry.registerConnector(createGithubConnector({ client: myraypa, reader: githubReader }));
  // Google (calendario y correo): solo lectura y solo para GOOGLE_OWNER_EMAIL. Nunca se ofrece a la revisión automática.
  const google =
    overrides.google ??
    (config.GOOGLE_MODE === 'http'
      ? new HttpGoogle({ clientId: config.GOOGLE_CLIENT_ID, clientSecret: config.GOOGLE_CLIENT_SECRET, refreshToken: config.GOOGLE_REFRESH_TOKEN, timeZone: config.GOOGLE_TIMEZONE, bodyMax: config.GOOGLE_MAIL_BODY_MAX })
      : config.GOOGLE_MODE === 'fake'
        ? new FakeGoogle({ now: overrides.now })
        : null);
  if (google) registry.registerConnector(createGoogleConnector({ client: google, config, now: overrides.now }));

  // Revision automatica: el asistente analiza por su cuenta y deja propuestas; solo se ejecutan si el usuario las aprueba.
  const store = overrides.proposalStore ?? new ProposalStore(config.PROPOSALS_PATH);
  const memory = overrides.memory ?? new MemoryStore(config.MEMORY_PATH);
  const ticketLog = overrides.ticketLog ?? new TicketLog(config.TICKETLOG_PATH, { now: overrides.now });
  const continuity = overrides.continuity ?? new ContinuityStore(config.CONTINUITY_PATH, { now: overrides.now });
  const undo = overrides.undo ?? new UndoStore({ now: overrides.now });
  const reminderStore = overrides.reminderStore ?? new ReminderStore(config.REMINDERS_PATH, { now: overrides.now });
  const reviewed = overrides.reviewed ?? new ReviewedStore(config.REVIEWED_PATH, { from: config.TRIAGE_WATCH_FROM, now: overrides.now });
  const scope = new ReviewScope({ myraypa, reviewed, config, now: overrides.now });
  const triage = new Triage({ model, registry, audit, store, config, pause, now: overrides.now, memory, ticketLog, scope });
  registry.registerConnector({ name: 'praxon', tools: [...proposalTools({ store, triage, client: myraypa, scope, config, onReviewed: (b, owner) => { server?.broadcast(triage.view()); if (owner) server?.notify(owner, { type: 'reminder', id: `revision-${b.id}`, texto: b.acciones?.length ? `Revisión terminada. Tienes ${b.acciones.length} ${b.acciones.length === 1 ? 'propuesta' : 'propuestas'} pendientes en Trabajo.` : 'Revisión terminada. No propongo ningún cambio.' }); } }), ...contextoTools(), ...screenTools(), ...reminderTools({ store: reminderStore }), ...memoryTools({ memory })] });
  installUndo({ registry, client: myraypa, undo });
  registry.registerConnector({ name: 'praxon', tools: undoTools({ undo, client: myraypa }) });

  const orchestrator = new Orchestrator({
    model,
    pause,
    registry,
    audit,
    config,
    // Se reconstruye en cada llamada al modelo: lleva la fecha y el usuario actuales.
    // La continuidad se fija al empezar la sesión: cambiar el prompt a mitad de conversación invalidaría la caché y el razonamiento previo.
    systemPrompt: (session) => {
      if (session.continuidad === undefined) session.continuidad = config.CONTINUITY_ENABLED ? continuity.render(session.email ?? session.user, { excludeSessionId: session.id }) : null;
      return buildSystemPrompt({ name: config.ASSISTANT_NAME, user: session.user, contexto: session.contextoPR?.texto, memoria: memory.render(), continuidad: session.continuidad, google: config.GOOGLE_MODE !== 'off' });
    },
    voice,
    now: overrides.now,
  });
  const usage =
    overrides.usage ??
    new UsageService({
      tracker,
      cacheMs: config.USAGE_CACHE_MINUTES * 60_000,
      now: overrides.now,
      providers: {
        elevenlabs: elevenLabsUsage({ apiKey: config.ELEVENLABS_API_KEY, baseUrl: config.ELEVENLABS_BASE_URL }),
        github: githubUsage({ token: config.GITHUB_BILLING_TOKEN, org: config.GITHUB_ORG, now: overrides.now }),
        anthropic: anthropicUsage({ adminKey: config.ANTHROPIC_ADMIN_KEY, now: overrides.now }),
      },
    });
  let server;
  let reminders = null;
  const agents = githubReader
    ? new AgentService({ myraypa, reader: githubReader, merger, dispatcher: github, audit, config, pause, now: overrides.now, onChange: () => { server?.broadcast({ type: 'agents_changed' }); server?.broadcast(triage.view()); } })
    : null;
  const panels = createPanels({ config, pause, google, myraypa, audit, registry, toolControl, triage, agents, reminderStore, memory, context: { count: (owner) => continuity.count(owner), list: (owner) => continuity.list(owner), forget: async (owner) => { const n = await continuity.clear(owner); server.sessions.forget(owner); return n; } }, connections: () => server?.connections() ?? [], isOwner: (identity) => server.canApprove(identity), now: overrides.now });
  server = createServer({ config, orchestrator, audit, triage, myraypa, auth: overrides.auth, stt, voice, agents, usage, panels, onSessionEnd: (session) => config.CONTINUITY_ENABLED && summarizeSession({ model, config, store: continuity, session, owner: session.email ?? session.user }), onConnection: (identity, emit) => reminders?.flush(identity.email ?? identity.user, emit) });
  reminders = new ReminderService({ store: reminderStore, deliver: (owner, msg) => server.notify(owner, msg) });
  // Se arranca desde index.js (start); en los tests no se programa nada.
  const scheduler = new TriageScheduler({
    times: config.TRIAGE_TIMES,
    now: overrides.now,
    run: async () => {
      await triage.run({ user: config.PRAXON_USER, trigger: 'schedule' });
      server.broadcast(triage.view());
    },
  });
  // Tickets nuevos: sondeo periódico a MyRAYPA (se arranca desde index.js). La marca de corte se crea al construirlo.
  const watcher = new TicketWatcher({ myraypa, triage, reviewed, scope, config, now: overrides.now, onBriefing: () => server.broadcast(triage.view()) });
  return { server, pause, google, panels, toolControl, memory, continuity, reminders, reminderStore, orchestrator, registry, audit, myraypa, github, githubReader, model, voice, stt, store, triage, scheduler, watcher, reviewed, agents, merger, usage, tracker };
}
