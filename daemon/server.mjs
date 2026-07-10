import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { biosignalFootprintSampleInputs } from '../src/ingest/biosignals.mjs';
import { bodyVitalRecordInputs } from '../src/ingest/body-vitals.mjs';
import {
  bodyInterventionFeedbackRecord,
  bodyLiveCueResponse,
  createBodyLiveState,
} from '../src/ingest/body-live.mjs';
import { ingestAppleNotes } from '../src/ingest/apple-notes.mjs';
import { ingestNotes } from '../src/ingest/notes.mjs';
import { ingestContextdump } from '../src/ingest/contextdump.mjs';
import { ingestMindContent } from '../src/ingest/mind-content.mjs';
import { syncWhoop } from '../src/ingest/whoop.mjs';
import { listBodySamples } from '../src/reason/health.mjs';
import {
  handleChatStream,
} from './routes/chat.mjs';
import {
  handleAguiMessage,
  isAguiPath,
} from './routes/agui.mjs';
import { runAgentTurn } from '../src/agent/chat.mjs';
import { K_CHAT_SYSTEM_PROMPT } from '../src/agent/system-prompt.mjs';
import { loadSoulSnapshot } from '../src/agent/soul.mjs';
import { loadNotesSnapshot } from '../src/agent/notes.mjs';
import { loadSkillGrants } from '../src/agent/skill-grants.mjs';
import {
  SKILLS_RUNTIME_TOOLS,
  buildSkillsIndex,
  executeSkillsRuntimeTool,
} from '../src/agent/skills-runtime.mjs';
import {
  DEFAULT_DELIBERATION_TIMEOUT_MS,
  executeDeliberateTool,
} from '../src/agent/deliberate.mjs';
import { executeAdminTriageTool } from '../src/agent/ops-groups.mjs';
import { openRouterZdrSingleCall } from '../src/agent/sovereign-single-call.mjs';
import { executeWebSearch } from '../src/agent/web-search.mjs';
import { executeWebFetch } from '../src/agent/web-fetch.mjs';
import { executeAdminParseIntakeTool } from '../src/admin/admin.mjs';
import { strategize } from '../src/strategy/strategize.mjs';
import {
  STAGED_SKILLS_DECISION_PATH,
  handleStagedSkillsRoute,
  isStagedSkillsPath,
} from './routes/staged-skills.mjs';
import {
  buildEvents as defaultBuildEvents,
  handleBuildRoute,
  isBuildMutationPath,
  isBuildPath,
} from './routes/build.mjs';
import {
  handleAdminRoute,
  isAdminPath,
} from './routes/admin.mjs';
import {
  handleCadenceActsRoute,
  handleCadenceReviewRoute,
  handleCadenceRoute,
  isCadenceActsPath,
  isCadencePath,
  isCadenceReviewPath,
} from './routes/cadence.mjs';
import {
  PENDING_NOTES_DECISION_PATH,
  handlePendingNotesRoute,
  isPendingNotesPath,
} from '../src/agent/notes-pending.mjs';
import {
  ROUTINES_PATH,
  ROUTINES_TOGGLE_PATH,
  handleRoutinesRoute,
  isRoutinesPath,
} from './routes/routines.mjs';
import {
  handleWhoopRoute,
  isWhoopPath,
} from './routes/whoop.mjs';
import { atomicWriteJson, createRoutineStore, tick as routineTick } from '../src/agent/routines.mjs';
import {
  CADENCE_BODY_UPDATE_SIGNALS,
  recomputeCadenceNowNext,
} from '../src/agent/cadence-engine.mjs';
import { createBuildStateStore } from '../src/agent/build-state.mjs';
import { createBuildCardStore } from '../src/agent/build-cards.mjs';
import {
  TICK_MS as BUILD_RUNNER_TICK_MS,
  createBuildRunner,
} from '../src/agent/build-runner.mjs';
import {
  DEFAULT_EXPOSURE_SURFACE_CAP,
  DEFAULT_RECENT_EXPOSURE_TAIL_LIMIT,
  DEFAULT_RELEVANT_EXPOSURE_LIMIT,
  DEFAULT_SOVEREIGN_EXPOSURE_TOTAL_LIMIT,
  blendExposureRecords,
  rankedExposureRecordsForMessage,
} from '../src/agent/exposure-index.mjs';
import {
  MIND_OUTPUT_GROUPS,
  MIND_OUTPUT_DIR,
  DECISION_CARD_FIELDS,
  arrayValues,
  boundLabel,
  mindOutputPacketProvenance,
  mindOutputPacketSiblingRefs,
  mindOutputViewType,
} from '../src/mind/think.mjs';
import { boundPacketFields, buildViewPacket } from '../src/agent/view-packet.mjs';
import {
  RECORD_KINDS,
  createSubstrateStore,
  isPlainObject,
  optionalString,
  requiredString,
  stripUndefined,
} from '../src/substrate.mjs';
import {
  ROOT,
  frontierExcludedRecordIds,
  frontierSafeRecords,
  iso,
  safeDataPath,
} from './run.mjs';
import { createThroughputStore } from '../src/metrics/throughput.mjs';
import { setMetricsHook } from '../src/metrics/instrument.mjs';
import { METRICS_PATH, metricsResponse } from './routes/metrics.mjs';

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 3003;

const MAX_BODY_BYTES = 1_000_000;
export const MAX_EVENTS_PER_REQUEST = 1000;
const BASELINE_SAMPLE_LIMIT = 20;
const ROLLING_BASELINE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const ROLLING_BASELINE_WINDOW_DAYS = 30;
const RECENT_PATTERN_LIMIT = 5;
const CHAT_EXPOSURE_LIMIT = 12;
const CHAT_SELF_PATTERN_LIMIT = 8;
const CHAT_IDEA_ATOM_LIMIT = 12;
const CHAT_RECOMMENDATION_LIMIT = 8;
// Sovereign chat block: richer than the frontier-safe context (it grounds the
// actual turn), still bounded so 405B first-byte latency stays felt-alive.
const SOVEREIGN_CHAT_EXPOSURE_LIMIT = 20;
const SOVEREIGN_CHAT_IDEA_ATOM_LIMIT = 16;
const DEFAULT_STRATEGIZE_TIMEOUT_MS = DEFAULT_DELIBERATION_TIMEOUT_MS;
const STRATEGIZE_TOOL_OUTPUT_MAX_CHARS = 3500;
export const SOVEREIGN_STATEMENT_MAX_CHARS = 280;
const SOVEREIGN_CONTEXT_MAX_CHARS = 120;
const MEMORY_SEARCH_DEFAULT_LIMIT = 6;
const MEMORY_SEARCH_MAX_LIMIT = 20;
const MIND_ARTIFACT_STATEMENT_MAX_CHARS = 420;
const MIND_ARTIFACT_MAX_SIBLINGS = 6;
// Bounded well under a full raw sentence: siblings carry a short statement for
// context, but never a full private planning sentence (caps-test invariant).
const MIND_ARTIFACT_SIBLING_STATEMENT_MAX_CHARS = 80;
const MIND_ARTIFACT_MAX_NEXT_ACTION_CHARS = 120;
const MIND_ARTIFACT_OBSERVATION_MAX_CHARS = 400;
const MIND_ARTIFACT_CONSIDERATION_MAX_CHARS = 220;
const MIND_ARTIFACT_MAX_CONSIDERATIONS = 4;
const MIND_DECISION_CARD_FIELD_MAX_CHARS = 220;
const FOOTPRINT_SAMPLE_KIND = requiredString('FootprintSample', 'FootprintSample kind');
const IDEA_ATOM_KIND = requiredString('IdeaAtom', 'IdeaAtom kind');
const IDEA_ATOM_DIR = path.join('substrate', 'idea-atoms');
const DECISION_DIR = 'decisions';
const MIND_EVAL_DIR = 'eval';
const MIND_EVAL_VERDICTS = Object.freeze(['act-on', 'nod', 'junk']);
const SOURCES_FILE = 'sources.json';
const SOURCES_REGISTRY_KIND = 'SourcesRegistry';
const SOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9_.:-]{0,79}$/;
const SOURCE_KINDS = Object.freeze(['chat', 'bookmarks', 'genome', 'file', 'registered']);
const MIND_OUTPUT_LABELS = Object.freeze([
  'Build / Execute / Decide',
  'Themes & Open Loops',
  'Resurfaced Ideas',
  'New Ideas',
]);
const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '::0', '[::]']);
const MODEL_COUNT_KINDS = Object.freeze([
  ...RECORD_KINDS.filter((kind) => kind !== 'GenomicTrait'),
  IDEA_ATOM_KIND,
  'GenomicTrait',
]);
const SKILLS_RUNTIME_TOOL_IDS = new Set(SKILLS_RUNTIME_TOOLS.map((tool) => tool.id));



const HEALTH_PATHS = new Set([
  '/api/health',
  '/api/hermes/status',
  '/api/system/status',
]);

const SUMMARY_PATHS = new Set([
  '/api/body',
  '/api/body/planning-summary',
  '/api/hermes/body/summary',
  '/api/body/summary',
]);

const CUE_CONTEXT_PATHS = new Set([
  '/api/hermes/body/cue-context',
  '/api/body/cue-context',
]);

const BODY_LIVE_PATHS = new Set([
  '/api/body/live',
  '/api/hermes/body/live',
]);

const CHAT_CONTEXT_PATHS = new Set([
  '/api/chat/context',
]);

const FEEDBACK_PATHS = new Set([
  '/api/hermes/body/interventions/feedback',
  '/api/body/interventions/feedback',
]);
const BODY_INTERVENTION_FEEDBACK_DIR = path.join('body', 'interventions', 'feedback');

const BODY_POST_PATHS = new Map([
  ['/api/hermes/body/signals', { kind: 'signals', surface: 'body' }],
  ['/api/body/events/signals', { kind: 'signals', surface: 'body' }],
  ['/api/body/signals', { kind: 'signals', surface: 'body' }],
  ['/api/hermes/body/whoop/telemetry', { kind: 'signals', surface: 'whoop' }],
  ['/api/hermes/body/sleep', { kind: 'sleep', surface: 'body' }],
  ['/api/body/events/sleep', { kind: 'sleep', surface: 'body' }],
  ['/api/body/sleep', { kind: 'sleep', surface: 'body' }],
  ['/api/hermes/body/nutrition', { kind: 'nutrition', surface: 'body' }],
  ['/api/body/events/nutrition', { kind: 'nutrition', surface: 'body' }],
  ['/api/body/nutrition', { kind: 'nutrition', surface: 'body' }],
  ['/api/body/meal', { kind: 'nutrition', surface: 'body' }],
]);

export function createHermesServer(options = {}) {
  const now = options.now ?? (() => new Date());
  const dataDir = options.dataDir ?? safeDataPath(ROOT, 'data');
  const store =
    options.store ??
    createSubstrateStore({
      dataDir,
      now,
    });
  const resolvedDataDir = options.dataDir ?? store.dataDir ?? dataDir;
  // Daemon-owned throughput store (U10): shared, content-free, in-memory. The
  // model-call seams record into it; GET /api/metrics projects it.
  const metricsStore = options.metricsStore ?? createThroughputStore({ now });
  setMetricsHook(metricsStore);
  const chatHandler = options.chatHandler ?? handleChatStream;
  const bodyLiveState = options.bodyLiveState ?? createBodyLiveState();

  return http.createServer((request, response) => {
    handleRequest(request, response, {
      store,
      dataDir: resolvedDataDir,
      now,
      metricsStore,
      chatHandler,
      chatDeps: options.chatDeps,
      adminDeps: options.adminDeps,
      buildStateStore: options.buildStateStore,
      buildCardStore: options.buildCardStore,
      buildEvents: options.buildEvents,
      buildDraftDeps: options.buildDraftDeps,
      whoopDeps: options.whoopDeps,
      bodyLiveState,
      cadenceRecompute: options.cadenceRecompute ?? recomputeCadenceNowNext,
    }).catch((error) => {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }

      sendJson(response, error.statusCode ?? 500, {
        ok: false,
        error: error.expose ? error.code : 'server_error',
      });
    });
  });
}

export async function startServer(options = {}) {
  const host = normalizeHost(options.host ?? process.env.HOST ?? DEFAULT_HOST);
  const port = normalizePort(options.port ?? optionalString(process.env.PORT) ?? DEFAULT_PORT);
  assertAllowedBindHost(host);
  const server = createHermesServer(options);

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });

  server.requestTimeout = 30000;
  await assertAllowedBoundAddress(server);

  // GA-7 ticker — the tick→Routine edge's living consumer. Opt-in (the daemon
  // runtime enables it; tests don't), 60s cadence, overlap-guarded by the
  // store's file lock. Errors are logged, never fatal.
  if (options.routineTicker === true) {
    const dataDir = options.dataDir ?? safeDataPath(ROOT, 'data');
    const now = options.now ?? (() => new Date());
    const store = createRoutineStore({ dataDir });
    // The self-syncing senses: each ingest routine, when enabled, drives one of
    // these on its cadence. Adapters fail soft (skip) until access is granted.
    const senses = buildSenses(dataDir);
    // tick() assembles the governed turn input itself (sovereign floor, tools
    // off) — the engine is passed straight through.
    const interval = setInterval(() => {
      routineTick({ store, dataDir, now: now(), runTurn: runAgentTurn, senses }).catch((error) => {
        console.error(`[cs-k] routine tick error: ${error.message}`);
      });
    }, 60_000);
    if (typeof interval.unref === 'function') interval.unref();
    server.on('close', () => clearInterval(interval));
  }

  if (options.buildRunner === true) {
    const dataDir = options.dataDir ?? safeDataPath(ROOT, 'data');
    const now = options.now ?? (() => new Date());
    const monotonicNow = options.monotonicNow ?? (() => Date.now());
    const buildStateStore = options.buildStateStore ??
      createBuildStateStore({ dataDir, now, monotonicNow });
    const buildCardStore = options.buildCardStore ??
      createBuildCardStore({ dataDir, now, stateStore: buildStateStore });
    const runner = options.buildRunnerInstance ?? createBuildRunner({
      store: buildStateStore,
      cards: buildCardStore,
      dataDir,
      repoRoot: options.repoRoot ?? ROOT,
      deps: {
        ...(options.buildRunnerDeps ?? {}),
        now,
        monotonicNow,
      },
    });
    const interval = setInterval(() => {
      runner.tick().catch((error) => {
        console.error(`[cs-k] build runner tick error: ${error.message}`);
      });
    }, options.buildRunnerTickMs ?? BUILD_RUNNER_TICK_MS);
    if (typeof interval.unref === 'function') interval.unref();
    server.on('close', () => clearInterval(interval));
  }

  return server;
}

async function handleRequest(request, response, {
  store,
  dataDir,
  now,
  metricsStore,
  chatHandler,
  chatDeps,
  adminDeps,
  buildStateStore,
  buildCardStore,
  buildEvents,
  buildDraftDeps,
  whoopDeps,
  bodyLiveState,
  cadenceRecompute,
}) {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname;

  if (request.method === 'GET' && path === METRICS_PATH) {
    sendJson(response, 200, metricsResponse(metricsStore));
    return;
  }

  if (request.method === 'GET' && HEALTH_PATHS.has(path)) {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (isWhoopPath(path)) {
    const handled = await handleWhoopRoute(
      request,
      response,
      {
        method: request.method,
        pathname: path,
        searchParams: url.searchParams,
        dataDir,
        now,
        whoop: whoopDeps,
      },
      { sendJson, httpError },
    );
    if (handled) return;
  }

  if (request.method === 'GET' && path === '/api/artifacts/body') {
    sendJson(response, 200, await bodyArtifacts({ store, dataDir, now }));
    return;
  }

  if (request.method === 'GET' && path === '/api/sources') {
    sendJson(response, 200, await sourceList({ store, dataDir }));
    return;
  }

  if (request.method === 'POST' && path === '/api/sources/toggle') {
    const payload = await readPlaintextJson(request);
    sendJson(response, 200, await toggleSource({ store, dataDir, now, payload }));
    return;
  }

  if (request.method === 'GET' && path === '/api/artifacts/mind') {
    sendJson(response, 200, await mindArtifacts({ dataDir, now }));
    return;
  }

  if (request.method === 'GET' && path === '/api/artifacts/eval') {
    const date = normalizeMindEvalDate(url.searchParams.get('date'), now);
    sendJson(response, 200, {
      date,
      verdicts: await mindEvalVerdicts({ dataDir, date }),
      generatedAt: iso(now),
      source: 'cs-k',
    });
    return;
  }

  if (request.method === 'POST' && path === '/api/artifacts/mind/verdict') {
    const payload = await readPlaintextJson(request);
    sendJson(response, 200, await recordMindVerdict({ dataDir, now, payload }));
    return;
  }

  if (request.method === 'GET' && path === '/api/artifacts/model') {
    sendJson(response, 200, await modelArtifacts({ store, dataDir, now }));
    return;
  }

  if (isAdminPath(path)) {
    const deps = isPlainObject(adminDeps) ? adminDeps : {};
    const handled = await handleAdminRoute(
      request,
      response,
      {
        method: request.method,
        pathname: path,
        searchParams: url.searchParams,
        store,
        dataDir,
        now,
        runTurn: deps.runTurn ?? runAgentTurn,
        deps: {
          toolExecutor: (toolId, args) =>
            agentToolExecutor(toolId, args, { dataDir, now, admin: { source: 'admin_intake' } }),
          ...stripUndefined({ ...deps, runTurn: undefined }),
        },
      },
      { sendJson, httpError, readPlaintextJson },
    );
    if (handled) return;
  }

  if (isCadencePath(path)) {
    const handled = await handleCadenceRoute(
      request,
      response,
      {
        method: request.method,
        pathname: path,
        searchParams: url.searchParams,
        store,
        dataDir,
        now,
      },
      { sendJson, httpError, readPlaintextJson },
    );
    if (handled) return;
  }

  if (isCadenceReviewPath(path)) {
    const handled = await handleCadenceReviewRoute(
      request,
      response,
      {
        method: request.method,
        pathname: path,
        searchParams: url.searchParams,
        store,
        dataDir,
        now,
      },
      { sendJson, httpError, readPlaintextJson },
    );
    if (handled) return;
  }

  if (isCadenceActsPath(path)) {
    const handled = await handleCadenceActsRoute(
      request,
      response,
      {
        method: request.method,
        pathname: path,
        searchParams: url.searchParams,
        store,
        dataDir,
        now,
        recomputeCadenceNowNext: cadenceRecompute,
      },
      { sendJson, httpError, readPlaintextJson },
    );
    if (handled) return;
  }

  if (request.method === 'POST' && path === '/api/chat') {
    // Ground every turn in the founder's own substrate. The sovereign block
    // carries real content (statements, threads); its presence — plus the
    // route-level sovereign floor — forces KTD9 sovereign routing (SEC-001),
    // so this context can never reach a non-sovereign model.
    const [toolGrants, skillsIndex, notesSnapshot, soulSnapshot] = await Promise.all([
      loadSkillGrants({ dataDir, now }),
      buildSkillsIndex({ dataDir, now }),
      loadNotesSnapshot({ dataDir }),
      loadSoulSnapshot({ dataDir }),
    ]);
    await chatHandler(request, response, {
      baseSystemPrompt: appendPromptBlocks(
        K_CHAT_SYSTEM_PROMPT,
        soulSnapshot.block,
        skillsIndex,
        notesSnapshot.block,
      ),
      buildSubstrateBlock: async (userMessage) => {
        const { block } = await sovereignChatContext({ store, dataDir, now, userMessage });
        return block;
      },
      toolGrants,
      dataDir,
      now,
      deps: {
        toolExecutor: (toolId, args) =>
          agentToolExecutor(toolId, args, { dataDir, now }),
        ...(chatDeps ?? {}),
      },
    });
    return;
  }

  // A2UI agentic surface (U3): the AG-UI transport emits ViewPackets. Same
  // grounded, KTD9-routed context as chat; loopback/Tailscale bind holds.
  if (request.method === 'GET' && isAguiPath(path)) {
    await handleAguiMessage(request, response, {
      method: request.method,
      pathname: path,
      searchParams: url.searchParams,
      buildEvents: buildEvents ?? defaultBuildEvents,
    });
    return;
  }

  if (request.method === 'POST' && isAguiPath(path)) {
    const [toolGrants, skillsIndex, notesSnapshot, soulSnapshot] = await Promise.all([
      loadSkillGrants({ dataDir, now }),
      buildSkillsIndex({ dataDir, now }),
      loadNotesSnapshot({ dataDir }),
      loadSoulSnapshot({ dataDir }),
    ]);
    await handleAguiMessage(request, response, {
      baseSystemPrompt: appendPromptBlocks(
        K_CHAT_SYSTEM_PROMPT,
        soulSnapshot.block,
        skillsIndex,
        notesSnapshot.block,
      ),
      buildSubstrateBlock: async (userMessage) => {
        const { block } = await sovereignChatContext({ store, dataDir, now, userMessage });
        return block;
      },
      toolGrants,
      dataDir,
      now,
      deps: {
        toolExecutor: (toolId, args) =>
          agentToolExecutor(toolId, args, { dataDir, now }),
        ...(chatDeps ?? {}),
      },
    });
    return;
  }

  if (request.method === 'POST' && path === STAGED_SKILLS_DECISION_PATH && !isLoopbackRequest(request)) {
    // U6 auth: approving a skill GRANTS live capability (tool egress), so the
    // decision surface is loopback-only — the founder approves from this Mac.
    // Tailnet devices may LIST and INSPECT staged skills, never decide.
    sendJson(response, 403, { ok: false, error: 'loopback_required' });
    return;
  }

  if (request.method === 'POST' && path === PENDING_NOTES_DECISION_PATH && !isLoopbackRequest(request)) {
    sendJson(response, 403, { ok: false, error: 'loopback_required' });
    return;
  }

  if (
    request.method === 'POST' &&
    (path === ROUTINES_PATH || path === ROUTINES_TOGGLE_PATH) &&
    !isLoopbackRequest(request)
  ) {
    sendJson(response, 403, { ok: false, error: 'loopback_required' });
    return;
  }

  if (request.method === 'POST' && isBuildMutationPath(path) && !isLoopbackRequest(request)) {
    sendJson(response, 403, { ok: false, error: 'loopback_required' });
    return;
  }

  if (path === '/api/chat') {
    sendJson(response, 405, { ok: false, error: 'method_not_allowed' });
    return;
  }

  if (isStagedSkillsPath(path)) {
    const handled = await handleStagedSkillsRoute(
      request,
      response,
      { method: request.method, pathname: path, dataDir, now },
      { sendJson, httpError, readPlaintextJson },
    );
    if (handled) return;
  }

  if (isPendingNotesPath(path)) {
    const handled = await handlePendingNotesRoute(
      request,
      response,
      { method: request.method, pathname: path, dataDir, now },
      { sendJson, httpError, readPlaintextJson, isSameMachine: isLoopbackRequest },
    );
    if (handled) return;
  }

  if (isRoutinesPath(path)) {
    // GA-7 first slice: HTTP store surface only. The integration lane wires the
    // 60s tick loop and governed runTurn seam.
    const handled = await handleRoutinesRoute(
      request,
      response,
      { method: request.method, pathname: path, dataDir, now },
      { sendJson, httpError, readPlaintextJson, isSameMachine: isLoopbackRequest },
    );
    if (handled) return;
  }

  if (isCadencePath(path)) {
    const handled = await handleCadenceRoute(
      request,
      response,
      {
        method: request.method,
        pathname: path,
        searchParams: url.searchParams,
        dataDir,
        now,
      },
      { sendJson, httpError, readPlaintextJson },
    );
    if (handled) return;
  }

  if (isBuildPath(path)) {
    const handled = await handleBuildRoute(
      request,
      response,
      {
        method: request.method,
        pathname: path,
        searchParams: url.searchParams,
        dataDir,
        now,
        substrateStore: store,
        buildStateStore,
        buildCardStore,
        buildEvents,
        buildDraftDeps,
      },
      { sendJson, httpError, readPlaintextJson, isSameMachine: isLoopbackRequest },
    );
    if (handled) return;
  }

  if (request.method === 'GET' && CHAT_CONTEXT_PATHS.has(path)) {
    sendJson(response, 200, await chatContext({ store, dataDir, now }));
    return;
  }

  if (CHAT_CONTEXT_PATHS.has(path)) {
    sendJson(response, 405, { ok: false, error: 'method_not_allowed' });
    return;
  }

  if (request.method === 'GET' && SUMMARY_PATHS.has(path)) {
    sendJson(response, 200, planningSummary(now));
    return;
  }

  if (request.method === 'GET' && CUE_CONTEXT_PATHS.has(path)) {
    sendJson(response, 200, await cueContext({ store, dataDir, now }));
    return;
  }

  if (request.method === 'POST' && BODY_LIVE_PATHS.has(path)) {
    const payload = await readPlaintextJson(request);
    if (!isPlainObject(payload)) throw httpError(400, 'invalid_body_live_payload');
    const baselines = await hrvBaselines(store, now);
    const body = bodyLiveCueResponse(payload, {
      dataDir,
      baselines,
      now,
      state: bodyLiveState,
    });
    if (body.silenced === false) {
      emitBodyLiveCuePackets({
        events: buildEvents ?? defaultBuildEvents,
        body,
      });
    }
    sendJson(response, 200, body);
    if (body.silenced === false) {
      scheduleCadenceRecompute({
        dataDir,
        now,
        cadenceRecompute,
        trigger: {
          type: 'body-update',
          signal: cadenceSignalForBodyLiveCue(payload, body),
        },
      });
    }
    return;
  }

  if (BODY_LIVE_PATHS.has(path)) {
    sendJson(response, 405, { ok: false, error: 'method_not_allowed' });
    return;
  }

  if (request.method === 'POST' && FEEDBACK_PATHS.has(path)) {
    const payload = await readPlaintextJson(request);
    sendJson(response, 200, await recordBodyInterventionFeedback({ dataDir, now, payload }));
    return;
  }

  if (FEEDBACK_PATHS.has(path)) {
    sendJson(response, 405, { ok: false, error: 'method_not_allowed' });
    return;
  }

  if (request.method === 'POST' && path === '/api/body') {
    const payload = await readPlaintextJson(request);
    const result = bodyVitalRecordInputs(payload, { maxEvents: MAX_EVENTS_PER_REQUEST });

    if (result.missingConsent) {
      throw httpError(403, 'body_consent_required');
    }

    if (result.tooManyEvents) {
      throw httpError(413, 'too_many_events');
    }

    let createdCount = 0;
    let duplicateCount = 0;
    for (const sample of result.samples) {
      const write = await store.writeVitalRecord(sample, { withWriteResult: true });
      if (write.created) {
        createdCount += 1;
      } else {
        duplicateCount += 1;
      }
    }

    sendJson(response, 200, {
      ok: true,
      ...planningSummary(now),
      receivedCount: result.eventCount,
      vitalCount: result.samples.length,
      createdCount,
      duplicateCount,
      skippedCount: result.skippedCount,
    });
    return;
  }

  if (request.method === 'POST' && BODY_POST_PATHS.has(path)) {
    const route = BODY_POST_PATHS.get(path);
    const payload = await readPlaintextJson(request);
    const result = biosignalFootprintSampleInputs(payload, {
      ...route,
      maxEvents: MAX_EVENTS_PER_REQUEST,
    });

    if (result.tooManyEvents) {
      throw httpError(413, 'too_many_events');
    }

    const { samples } = result;

    if (samples.length === 0) {
      throw httpError(400, 'no_valid_body_signal');
    }

    for (const sample of samples) {
      await store.writeFootprintSample(sample, { withWriteResult: true });
    }

    sendJson(response, 200, planningSummary(now));
    return;
  }

  sendJson(response, 404, { ok: false, error: 'not_found' });
}

function planningSummary(now) {
  return {
    globalBodyState: 'observed',
    generatedAt: iso(now),
    source: 'cs-k',
  };
}

function emitBodyLiveCuePackets({ events, body }) {
  if (!events || typeof events.emitPacket !== 'function' || body?.silenced !== false) return [];

  const packets = Array.isArray(body.packets)
    ? body.packets
    : isPlainObject(body.packet)
      ? [body.packet]
      : [];
  const emitted = [];

  for (const packet of packets) {
    try {
      emitted.push(events.emitPacket(packet));
    } catch (error) {
      console.error(`[cs-k] body live cue event emit failed: ${error.message}`);
    }
  }

  return emitted;
}

async function recordBodyInterventionFeedback({ dataDir, now, payload }) {
  if (!isPlainObject(payload)) throw httpError(400, 'invalid_feedback_payload');
  rejectClientPathFields(payload);

  let record;
  try {
    record = bodyInterventionFeedbackRecord(payload, { now });
  } catch (error) {
    throw httpError(400, feedbackRecordErrorCode(error));
  }

  await atomicWriteJson(bodyInterventionFeedbackFile(dataDir, record.id), record);
  return {
    ok: true,
    record,
  };
}

function feedbackRecordErrorCode(error) {
  const code = optionalString(error?.message);
  if (
    code === 'invalid_feedback_payload' ||
    code === 'invalid_feedback_action' ||
    code === 'missing_intervention_id'
  ) {
    return code;
  }
  return 'invalid_feedback_payload';
}

function bodyInterventionFeedbackFile(dataDir, id) {
  return safeDataPath(dataDir, path.join(BODY_INTERVENTION_FEEDBACK_DIR, `${id}.json`));
}

function scheduleCadenceRecompute({ dataDir, now, cadenceRecompute, trigger }) {
  const recompute = cadenceRecompute ?? recomputeCadenceNowNext;
  Promise.resolve()
    .then(() => recompute({ dataDir, now, trigger }))
    .catch((error) => {
      console.error(`[cs-k] cadence recompute trigger failed: ${error.message}`);
    });
}

function cadenceSignalForBodyLiveCue(payload, body) {
  const explicit = optionalString(
    payload.signal ??
    payload.signalId ??
    payload.bodySignal ??
    payload.body_signal ??
    payload.cadenceSignal ??
    payload.cadence_signal,
  )?.toLowerCase();
  if (CADENCE_BODY_UPDATE_SIGNALS.includes(explicit)) return explicit;

  const cueSignal = optionalString(body.cue?.signal ?? body.packet?.fields?.signal)?.toLowerCase();
  if (cueSignal === 'attention') return 'b4';
  if (cueSignal === 'hrv') return 'b1';
  return cueSignal ?? 'b1';
}

function appendPromptBlocks(...parts) {
  return parts
    .filter((part) => typeof part === 'string' && part.trim().length > 0)
    .join('\n\n');
}

async function bodyArtifacts({ store, dataDir, now }) {
  return cueContext({ store, dataDir, now });
}

export async function cueContext({ store, dataDir, now }) {
  const [vitals, protocols] = await Promise.all([
    vitalBaselines(store, now),
    stagedBodyProtocols(dataDir),
  ]);

  return {
    baselines: vitals.baselines,
    ...(Object.keys(vitals.zScores).length > 0 ? { zScores: vitals.zScores } : {}),
    protocols,
    generatedAt: iso(now),
    source: 'cs-k',
  };
}

export async function mindArtifacts({ dataDir, now }) {
  const date = normalizeMindEvalDate(undefined, now);
  const groups = await projectedMindOutputGroups(dataDir);

  return {
    ...groups,
    outputSections: MIND_OUTPUT_GROUPS.map((key, index) => ({
      key,
      label: MIND_OUTPUT_LABELS[index],
      items: groups[key],
    })),
    priorVerdicts: await mindEvalVerdicts({ dataDir, date }),
    evalDate: date,
    generatedAt: iso(now),
    source: 'cs-k',
  };
}

export async function chatContext({ store, dataDir, now }) {
  const ideaAtomDir = safeDataPath(dataDir, IDEA_ATOM_DIR);
  const decisionDir = safeDataPath(dataDir, DECISION_DIR);
  const [
    allExposureRecords,
    allSelfPatternRecords,
    ideaAtomEntries,
    decisionEntries,
  ] = await Promise.all([
    store.listRecords('Exposure'),
    store.listRecords('SelfPattern'),
    jsonDataFileEntriesFromDir(ideaAtomDir, IDEA_ATOM_DIR),
    jsonDataFileEntriesFromDir(decisionDir, DECISION_DIR),
  ]);
  const excludedExposureIds = frontierExcludedRecordIds(allExposureRecords);
  const exposureRecords = frontierSafeRecords(allExposureRecords);
  const selfPatternRecords = frontierSafeRecords(
    allSelfPatternRecords,
    { excludedEvidenceIds: excludedExposureIds },
  );
  const ideaAtomRecords = frontierSafeRecords(
    ideaAtomEntries.map((entry) => entry.data),
    { excludedEvidenceIds: excludedExposureIds },
  );
  const recommendationRecords = frontierSafeRecords(
    decisionEntries
      .map((entry) => ({ ...entry.data, relPath: entry.relPath }))
      .filter(isStagedRecommendation),
    { excludedEvidenceIds: excludedExposureIds },
  );
  const context = {
    exposures: recentLiveRecords(exposureRecords, CHAT_EXPOSURE_LIMIT)
      .map(projectChatExposure)
      .filter(hasProjectedFields),
    selfPatterns: recentLiveRecords(selfPatternRecords, CHAT_SELF_PATTERN_LIMIT)
      .map(projectChatSelfPattern)
      .filter(hasProjectedFields),
    ideaAtoms: recentLiveRecords(ideaAtomRecords.filter(isLiveIdeaAtom), CHAT_IDEA_ATOM_LIMIT)
      .map(projectChatIdeaAtom)
      .filter(hasProjectedFields),
    recommendations: recentRecords(recommendationRecords, CHAT_RECOMMENDATION_LIMIT)
      .map(projectChatRecommendation)
      .filter(hasProjectedFields),
  };

  return {
    context,
    block: formatChatContextBlock(context),
    generatedAt: iso(now),
    source: 'cs-k',
  };
}

// Substrate context for the SOVEREIGN chat turn. Unlike `chatContext` (the
// frontier-safe GET endpoint other consumers may hand to any model), this
// block carries the founder's actual material — chat-sourced exposures with
// their statements, mind idea-atoms, staged recommendations. Safe by
// construction: it is injected ONLY into POST /api/chat, whose turns are
// sovereign-floored (SEC-001; substrate presence ⇒ sensitive ⇒ Hermes-ZDR),
// so this content can never reach a non-sovereign model. Do NOT expose it as
// a GET endpoint and do NOT feed it to the frontier lane.
export async function sovereignChatContext({
  store,
  dataDir,
  now,
  userMessage,
  embeddingOptions,
  logger,
} = {}) {
  const ideaAtomDir = safeDataPath(dataDir, IDEA_ATOM_DIR);
  const decisionDir = safeDataPath(dataDir, DECISION_DIR);
  const [
    exposureRecords,
    selfPatternRecords,
    ideaAtomEntries,
    decisionEntries,
  ] = await Promise.all([
    store.listRecords('Exposure'),
    store.listRecords('SelfPattern'),
    jsonDataFileEntriesFromDir(ideaAtomDir, IDEA_ATOM_DIR),
    jsonDataFileEntriesFromDir(decisionDir, DECISION_DIR),
  ]);
  const exposureSelection = await selectSovereignExposureRecords({
    records: exposureRecords.filter(hasSovereignExposureContent),
    dataDir,
    userMessage,
    embeddingOptions,
    logger,
  });

  const context = {
    exposures: exposureSelection.records.map(projectSovereignExposure),
    exposureSections: exposureSelection.sections,
    selfPatterns: recentLiveRecords(selfPatternRecords, CHAT_SELF_PATTERN_LIMIT)
      .map(projectChatSelfPattern)
      .filter(hasProjectedFields),
    ideaAtoms: recentLiveRecords(
      ideaAtomEntries.map((entry) => entry.data).filter(isLiveIdeaAtom),
      SOVEREIGN_CHAT_IDEA_ATOM_LIMIT,
    )
      .map(projectChatIdeaAtom)
      .filter(hasProjectedFields),
    recommendations: recentRecords(
      decisionEntries
        .map((entry) => ({ ...entry.data, relPath: entry.relPath }))
        .filter(isStagedRecommendation),
      CHAT_RECOMMENDATION_LIMIT,
    )
      .map(projectChatRecommendation)
      .filter(hasProjectedFields),
  };

  return {
    context,
    block: formatSovereignChatBlock(context),
    generatedAt: iso(now),
    source: 'cs-k',
  };
}

async function selectSovereignExposureRecords({
  records,
  dataDir,
  userMessage,
  embeddingOptions,
  logger,
}) {
  const liveRecords = (Array.isArray(records) ? records : [])
    .filter((record) => isPlainObject(record) && !record.validTo && !record.supersededById);
  const recentRecords = recentRecordsAll(liveRecords);

  const fallback = (reason) => {
    if (reason && reason !== 'missing_message') {
      logSovereignContextFallback(logger, reason);
    }
    return {
      records: recentRecords.slice(0, SOVEREIGN_CHAT_EXPOSURE_LIMIT),
      sections: null,
      source: 'recency-fallback',
      reason,
    };
  };

  const message = optionalString(userMessage);
  if (!message) return fallback('missing_message');

  let ranked;
  try {
    ranked = await rankedExposureRecordsForMessage({
      records: liveRecords,
      dataDir,
      message,
      embeddingOptions,
      logger,
    });
  } catch (error) {
    return fallback(optionalString(error?.message) ?? 'retrieval_failed');
  }

  if (!ranked.ok) return fallback(ranked.reason);

  const blended = blendExposureRecords({
    relevantRecords: ranked.rankedRecords,
    recentRecords,
    relevantLimit: DEFAULT_RELEVANT_EXPOSURE_LIMIT,
    recentLimit: DEFAULT_RECENT_EXPOSURE_TAIL_LIMIT,
    surfaceCap: DEFAULT_EXPOSURE_SURFACE_CAP,
    totalLimit: DEFAULT_SOVEREIGN_EXPOSURE_TOTAL_LIMIT,
  });

  if (blended.records.length === 0) return fallback('empty_blend');

  return {
    records: blended.records,
    sections: {
      relevant: blended.relevant.map(projectSovereignExposure),
      recent: blended.recent.map(projectSovereignExposure),
    },
    source: 'retrieval',
    reason: null,
  };
}

function recentRecordsAll(records) {
  return recentRecords(records, Number.MAX_SAFE_INTEGER);
}

function logSovereignContextFallback(logger, reason) {
  const message = `[cs-k] sovereign chat context: using recency fallback (${reason})`;
  if (logger && typeof logger.warn === 'function') {
    logger.warn(message);
    return;
  }
  console.warn(message);
}

function hasSovereignExposureContent(record) {
  return isPlainObject(record) && Boolean(optionalString(record.statement));
}

function projectSovereignExposure(record) {
  const exposure = {};
  const id = optionalString(record.id);
  const statement = optionalString(record.statement);
  const context = optionalString(record.context);
  const type = optionalString(record.type);
  const eventAt = firstString(record.eventAt, record.validFrom);
  const surface = optionalString(record.provenance?.surface);

  if (id) exposure.id = id;
  if (statement) exposure.statement = statement.slice(0, SOVEREIGN_STATEMENT_MAX_CHARS);
  if (context) exposure.context = context.slice(0, SOVEREIGN_CONTEXT_MAX_CHARS);
  if (type) exposure.type = type;
  if (eventAt) exposure.eventAt = eventAt.slice(0, 10);
  if (surface) exposure.surface = surface;

  return exposure;
}

function formatSovereignChatBlock(context) {
  const sections = [];

  if (context.exposures.length > 0) {
    if (context.exposureSections) {
      const exposureParts = ["## The founder's exposures grounding this turn"];
      if (context.exposureSections.relevant.length > 0) {
        exposureParts.push(
          '### Relevant to this question',
          formatSovereignExposures(context.exposureSections.relevant),
        );
      }
      if (context.exposureSections.recent.length > 0) {
        exposureParts.push(
          '### Recent tail (most recent first)',
          formatSovereignExposures(context.exposureSections.recent),
        );
      }
      sections.push(exposureParts.join('\n\n'));
    } else {
      sections.push(
        "## The founder's recent exposures (what they attended to, most recent first)",
        formatSovereignExposures(context.exposures),
      );
    }
  }
  if (context.selfPatterns.length > 0) {
    sections.push('## Self patterns (what the derived model can defensibly say)', formatProjectedItems(context.selfPatterns));
  }
  if (context.ideaAtoms.length > 0) {
    sections.push(
      "## Open threads in the founder's mind",
      context.ideaAtoms.map((a) => `- ${a.label}`).join('\n'),
    );
  }
  if (context.recommendations.length > 0) {
    sections.push('## Staged recommendations awaiting the founder', formatProjectedItems(context.recommendations));
  }

  return sections.join('\n\n');
}

function formatSovereignExposures(exposures) {
  return exposures
    .map((e) => `- [${e.eventAt ?? '?'} · ${e.surface ?? '?'} · ${e.type ?? '?'}] ${e.statement}${e.context ? ` (${e.context})` : ''}`)
    .join('\n');
}

async function projectedMindOutputGroups(dataDir) {
  const [ideaAtoms, mindOutputs, decisions] = await Promise.all([
    ideaAtomDataFiles(dataDir),
    mindOutputDataFiles(dataDir),
    decisionDataFileEntries(dataDir),
  ]);
  const liveIdeaAtoms = ideaAtoms.filter(isLiveIdeaAtom);
  const liveMindOutputs = mindOutputs.filter(isLiveMindOutputRecord);
  const projectionContext = {
    recordsById: new Map(liveIdeaAtoms.map((record) => [record.id, record])),
  };
  const projectedIdeaAtoms = liveIdeaAtoms.map((record) => projectIdeaAtom(record, projectionContext));
  const projectedMindOutputs = liveMindOutputs.map((record) =>
    projectMindOutputRecord(record, projectionContext));
  const buildDecide = decisions
    .filter((entry) => isStagedMindDecisionCandidate(entry.data))
    .map((entry) => projectMindCandidate(entry.data, entry.relPath));

  return {
    ideaAtoms: projectedIdeaAtoms,
    candidates: buildDecide,
    build_decide: buildDecide,
    themes_open_loops: projectedMindOutputs.filter((output) =>
      mindPacketOutputType(output) === MIND_OUTPUT_GROUPS[1]),
    resurfaced: projectedMindOutputs.filter((output) =>
      mindPacketOutputType(output) === MIND_OUTPUT_GROUPS[2]),
    new_ideas: projectedMindOutputs.filter((output) =>
      mindPacketOutputType(output) === MIND_OUTPUT_GROUPS[3]),
  };
}

function recentLiveRecords(records, limit) {
  return recentRecords(
    (Array.isArray(records) ? records : [])
      .filter((record) => isPlainObject(record) && !record.validTo && !record.supersededById),
    limit,
  );
}

function recentRecords(records, limit) {
  return [...(Array.isArray(records) ? records : [])]
    .sort(compareChatContextRecords)
    .slice(-limit)
    .reverse();
}

function compareChatContextRecords(a, b) {
  return chatContextRecordTime(a).localeCompare(chatContextRecordTime(b)) ||
    String(a?.id ?? a?.outputId ?? a?.relPath ?? '').localeCompare(
      String(b?.id ?? b?.outputId ?? b?.relPath ?? ''),
    );
}

function chatContextRecordTime(record) {
  return firstString(record?.eventAt, record?.createdAt, record?.validFrom, record?.ingestedAt) ?? '';
}

function projectChatExposure(record) {
  const exposure = {};
  const id = optionalString(record.id);
  const type = optionalString(record.type);
  const eventAt = firstString(record.eventAt, record.validFrom);
  const provenance = projectProvenance(record.provenance);

  if (id) exposure.id = id;
  if (type) exposure.type = type;
  if (eventAt) exposure.eventAt = eventAt;
  if (Object.keys(provenance).length > 0) exposure.provenance = provenance;

  return exposure;
}

function projectChatSelfPattern(record) {
  const pattern = projectSelfPattern(record);
  const id = optionalString(record.id);

  if (id) pattern.id = id;
  if (pattern.label) pattern.label = boundLabel(pattern.label);

  return pattern;
}

function projectChatIdeaAtom(record) {
  const atom = {};
  const outputId = optionalString(record.id);
  const label = optionalString(record.label);

  if (outputId) atom.outputId = outputId;
  atom.label = label ? boundLabel(label) : 'Untitled idea';

  return atom;
}

function isStagedRecommendation(record) {
  return isPlainObject(record) &&
    optionalString(record.kind) === 'LoopRecommendation' &&
    optionalString(record.acted) === 'pending' &&
    optionalString(record.tag) !== '[auto]';
}

function projectChatRecommendation(record) {
  const recommendation = {};
  const outputId = firstString(record.id, record.outputId, record.decisionId, record.relPath);
  const label = firstString(record.decision, record.recommended, record.summary);
  const station = optionalString(record.station);
  const tag = optionalString(record.tag);
  const reversibility = optionalString(record.reversibility);
  const risk = optionalString(record.risk);
  const confidence = finiteConfidence(record.confidence);
  const provenance = projectProvenance(record.provenance);
  const createdAt = firstString(record.createdAt, record.eventAt);

  if (outputId) recommendation.outputId = outputId;
  if (label) recommendation.label = boundLabel(label);
  if (station) recommendation.station = station;
  if (tag) recommendation.tag = tag;
  if (reversibility) recommendation.reversibility = reversibility;
  if (risk) recommendation.risk = risk;
  if (confidence !== undefined) recommendation.confidence = confidence;
  if (createdAt) recommendation.createdAt = createdAt;
  if (Object.keys(provenance).length > 0) recommendation.provenance = provenance;

  return recommendation;
}

function projectProvenance(provenance) {
  const projected = {};
  const surface = optionalString(provenance?.surface);
  const lane = optionalString(provenance?.lane);

  if (surface) projected.surface = surface;
  if (lane) projected.lane = lane;

  return projected;
}

function hasProjectedFields(value) {
  return isPlainObject(value) && Object.keys(value).length > 0;
}

function formatChatContextBlock(context) {
  const sections = [];

  if (context.exposures.length > 0) {
    sections.push('## Recent exposures', formatProjectedItems(context.exposures));
  }
  if (context.selfPatterns.length > 0) {
    sections.push('## Self patterns', formatProjectedItems(context.selfPatterns));
  }
  if (context.ideaAtoms.length > 0) {
    sections.push('## Mind idea atoms', formatProjectedItems(context.ideaAtoms));
  }
  if (context.recommendations.length > 0) {
    sections.push('## Staged recommendations', formatProjectedItems(context.recommendations));
  }

  return sections.join('\n\n');
}

function formatProjectedItems(items) {
  return items.map((item) => JSON.stringify(item)).join('\n');
}

async function modelArtifacts({ store, dataDir, now }) {
  const [counts, recentPatterns] = await Promise.all([
    modelCounts({ store, dataDir }),
    recentSelfPatterns(store),
  ]);

  return {
    counts,
    recentPatterns,
    generatedAt: iso(now),
    source: 'cs-k',
  };
}

// The self-syncing sense registry the routine 'ingest' runner dispatches to.
// Keyed by sense id (== provenance surface); each returns the adapter's
// {createdCount, duplicateCount, skipped} result. Adapters build their own
// substrate store bound to dataDir and fail soft when access isn't granted.
function buildSenses(dataDir) {
  const storeOptions = { dataDir };
  return {
    'apple-notes': () => ingestAppleNotes({ storeOptions }),
    'holon-notes': () => ingestNotes({ storeOptions }),
    'mind-content': () => ingestMindContent({ storeOptions }),
    'whoop-sync': (context = {}) => syncWhoop({
      dataDir: context.dataDir ?? dataDir,
      now: context.now,
    }),
    // The founder's context-dump markdown notes (the dhyan synthesis corpus).
    // x-bookmarks is NOT a headless sense — it needs a logged-in browser session
    // (session-assisted, KTD-3), so it is not registered here.
    'contextdump': () => ingestContextdump({ storeOptions }),
  };
}

// The canonical senses — keyed by the `provenance.surface` each ingest adapter
// actually writes (src/ingest/*). This is the panel's spine so every known sense
// shows even at zero, and its count is the REAL number of ingested Exposure
// records for that surface — never a file-on-disk tally (which was theater: an
// export sitting in data/ingest counts nothing until it becomes exposures).
const SOURCE_SURFACE_DEFS = Object.freeze({
  'claude': { label: 'Claude chat', kind: 'chat' },
  'chatgpt': { label: 'ChatGPT chat', kind: 'chat' },
  'holon-notes': { label: 'Holon notes', kind: 'notes' },
  'apple-notes': { label: 'Apple Notes', kind: 'notes' },
  'mind-content': { label: 'Mind content', kind: 'notes' },
  'x-bookmarks': { label: 'X bookmarks', kind: 'bookmarks' },
  'contextdump': { label: 'Context-dump notes', kind: 'notes' },
  'chrome': { label: 'Browser history', kind: 'browser' },
  'genome': { label: 'Genome', kind: 'genome' },
  'hermes': { label: 'Agent transcripts', kind: 'chat' },
});

// Real ingested-exposure counts, grouped by provenance surface. Only live
// (non-superseded) records count — this is what the mind currently holds.
function exposureCountsBySurface(exposures) {
  const bySurface = new Map();
  for (const record of Array.isArray(exposures) ? exposures : []) {
    if (!record || record.supersededById || record.validTo != null) continue;
    const surface = optionalString(record.provenance?.surface);
    if (!surface) continue;
    const at = firstString(record.ingestedAt, record.eventAt, record.validFrom);
    const entry = bySurface.get(surface) ?? { count: 0, lastIngestedAt: null };
    entry.count += 1;
    if (at && (!entry.lastIngestedAt || at > entry.lastIngestedAt)) {
      entry.lastIngestedAt = at;
    }
    bySurface.set(surface, entry);
  }
  return bySurface;
}

async function sourceList({ store, dataDir }) {
  const [exposures, registry] = await Promise.all([
    store.listRecords('Exposure'),
    readSourceRegistry(dataDir),
  ]);
  const counts = exposureCountsBySurface(exposures);

  // Panel = canonical senses ∪ surfaces actually seen in the substrate ∪
  // registered surfaces. Count/lastIngestedAt are strictly real exposure facts.
  const ids = new Set([
    ...Object.keys(SOURCE_SURFACE_DEFS),
    ...counts.keys(),
    ...Object.keys(registry.sources),
  ]);

  const sources = [];
  for (const id of ids) {
    const def = SOURCE_SURFACE_DEFS[id];
    const registered = registry.sources[id];
    const seen = counts.get(id);
    sources.push({
      id,
      label: def?.label ?? registered?.label ?? sourceLabelFromSlug(id),
      kind: def?.kind ?? registered?.kind ?? 'file',
      active: registered ? registered.active : true,
      count: seen?.count ?? 0,
      lastIngestedAt: seen?.lastIngestedAt ?? null,
    });
  }

  return sources
    .map(projectSource)
    .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}

async function toggleSource({ store, dataDir, now, payload }) {
  if (!isPlainObject(payload)) throw httpError(400, 'invalid_source_toggle');
  rejectClientPathFields(payload);

  const keys = Object.keys(payload).sort();
  if (keys.length !== 2 || keys[0] !== 'active' || keys[1] !== 'id') {
    throw httpError(400, 'invalid_source_toggle');
  }

  const id = requiredSourceId(payload.id);
  if (typeof payload.active !== 'boolean') {
    throw httpError(400, 'invalid_source_active');
  }

  const [sources, registry] = await Promise.all([
    sourceList({ store, dataDir }),
    readSourceRegistry(dataDir),
  ]);
  const source = sources.find((candidate) => candidate.id === id);
  if (!source) throw httpError(400, 'unknown_source');

  const previous = registry.sources[id] ?? {};
  registry.sources[id] = {
    ...pickRegisteredSourceFields(previous),
    active: payload.active,
  };

  await writeSourceRegistry({ dataDir, now, registry });

  return {
    id,
    active: payload.active,
  };
}


function projectSource(source) {
  return {
    id: source.id,
    label: boundLabel(source.label),
    kind: source.kind,
    active: source.active,
    count: source.count,
    lastIngestedAt: source.lastIngestedAt,
  };
}

async function readSourceRegistry(dataDir) {
  const file = sourceRegistryFile(dataDir);
  let parsed;

  try {
    parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return emptySourceRegistry();
  }

  if (!isPlainObject(parsed)) return emptySourceRegistry();

  const sources = {};
  for (const [id, source] of sourceRegistryEntries(parsed.sources)) {
    const normalized = normalizeRegistrySource(id, source);
    if (normalized) sources[normalized.id] = normalized;
  }

  return {
    kind: SOURCES_REGISTRY_KIND,
    schemaVersion: 1,
    sources,
  };
}

function emptySourceRegistry() {
  return {
    kind: SOURCES_REGISTRY_KIND,
    schemaVersion: 1,
    sources: {},
  };
}

function sourceRegistryEntries(value) {
  if (Array.isArray(value)) {
    return value
      .filter(isPlainObject)
      .map((source) => [source.id, source]);
  }

  if (isPlainObject(value)) {
    return Object.entries(value);
  }

  return [];
}

function normalizeRegistrySource(rawId, rawSource) {
  const id = normalizeSourceId(rawId);
  if (!id) return null;

  const source = typeof rawSource === 'boolean'
    ? { active: rawSource }
    : rawSource;
  if (!isPlainObject(source)) return null;

  const active = typeof source.active === 'boolean' ? source.active : true;
  const label = optionalString(source.label);
  const kind = normalizeSourceKind(source.kind);

  return {
    id,
    ...(label ? { label: boundLabel(label) } : {}),
    ...(kind ? { kind } : {}),
    active,
  };
}

async function writeSourceRegistry({ dataDir, now, registry }) {
  const file = sourceRegistryFile(dataDir);
  const sources = {};

  for (const id of Object.keys(registry.sources).sort()) {
    const source = registry.sources[id];
    if (!normalizeSourceId(id) || !isPlainObject(source)) continue;

    sources[id] = {
      ...pickRegisteredSourceFields(source),
      active: source.active === true,
    };
  }

  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    `${JSON.stringify({
      kind: SOURCES_REGISTRY_KIND,
      schemaVersion: 1,
      updatedAt: iso(now),
      sources,
    }, null, 2)}\n`,
    'utf8',
  );
}

function sourceRegistryFile(dataDir) {
  return safeDataPath(dataDir, SOURCES_FILE);
}

function pickRegisteredSourceFields(source) {
  const label = optionalString(source.label);
  const kind = normalizeSourceKind(source.kind);

  return {
    ...(label ? { label: boundLabel(label) } : {}),
    ...(kind ? { kind } : {}),
  };
}

function normalizeSourceId(value) {
  const id = optionalString(value)?.toLowerCase();
  return id && SOURCE_ID_PATTERN.test(id) ? id : undefined;
}

function requiredSourceId(value) {
  const id = normalizeSourceId(value);
  if (!id) throw httpError(400, 'invalid_source_id');
  return id;
}

function normalizeSourceKind(value) {
  const kind = optionalString(value)?.toLowerCase();
  return kind && SOURCE_KINDS.includes(kind) ? kind : undefined;
}


function sourceLabelFromSlug(slug) {
  return boundLabel(String(slug ?? 'ingest source').replace(/[-_.:]+/g, ' '));
}

async function hrvBaselines(store, now) {
  const records = await listBodySamples(store);
  const recent = records
    .filter(isLiveRecord)
    .filter((record) => isWithinRollingBaselineWindow(record, now))
    .sort(compareBodySampleTime)
    .slice(-BASELINE_SAMPLE_LIMIT);
  const hrvValues = recent
    .map((record) => record?.physiology?.hrv)
    .filter((value) => Number.isFinite(value));
  const baselines = {};

  if (hrvValues.length > 0) {
    baselines.hrv = median(hrvValues);
  }

  baselines.samples = hrvValues.length;
  return baselines;
}

async function vitalBaselines(store, now) {
  const records = await listBodySamples(store);
  const recent = records
    .filter(isLiveRecord)
    .filter((record) => isWithinRollingBaselineWindow(record, now))
    .sort(compareBodySampleTime);
  const hrvSeries = recent
    .map((record) => ({
      value: firstFiniteNumber(
        record?.physiology?.hrv,
        record?.outcome?.measurements?.hrv,
        record?.outcome?.measurements?.hrvMs,
      ),
    }))
    .filter((entry) => Number.isFinite(entry.value));
  const sleepSeries = recent
    .map((record) => ({
      value: sleepHoursFromMeasurements(record?.outcome?.measurements),
    }))
    .filter((entry) => Number.isFinite(entry.value));
  const baselines = {};
  const zScores = {};

  if (hrvSeries.length > 0) {
    const hrvValues = hrvSeries.map((entry) => entry.value);
    baselines.hrv = median(hrvValues);
    baselines.hrvDrift = driftSummary({
      values: hrvValues,
      latestKey: 'latest',
      baselineKey: 'baseline',
      deltaKey: 'delta',
      precision: 1,
    });
    const hrvZScore = zScoreSummary({
      values: hrvValues,
      latestKey: 'latest',
      baselineMeanKey: 'baselineMean',
      standardDeviationKey: 'standardDeviation',
      precision: 1,
    });
    if (hrvZScore) zScores.hrv = hrvZScore;
  }

  if (sleepSeries.length > 0) {
    const sleepValues = sleepSeries.map((entry) => entry.value);
    baselines.sleepHours = median(sleepValues);
    baselines.sleepTrend = driftSummary({
      values: sleepValues,
      latestKey: 'latestHours',
      baselineKey: 'baselineHours',
      deltaKey: 'deltaHours',
      precision: 2,
    });
    const sleepZScore = zScoreSummary({
      values: sleepValues,
      latestKey: 'latestHours',
      baselineMeanKey: 'baselineMeanHours',
      standardDeviationKey: 'standardDeviationHours',
      precision: 2,
    });
    if (sleepZScore) zScores.sleep = sleepZScore;
  }

  baselines.samples = recent.filter((record) => {
    const hrv = firstFiniteNumber(
      record?.physiology?.hrv,
      record?.outcome?.measurements?.hrv,
      record?.outcome?.measurements?.hrvMs,
    );
    return (
      Number.isFinite(hrv) ||
      sleepHoursFromMeasurements(record?.outcome?.measurements) !== undefined
    );
  }).length;
  return { baselines, zScores };
}

function driftSummary({ values, latestKey, baselineKey, deltaKey, precision }) {
  const latest = values[values.length - 1];
  const baseline = median(values);
  const delta = roundNumber(latest - baseline, precision);

  return {
    [latestKey]: roundNumber(latest, precision),
    [baselineKey]: roundNumber(baseline, precision),
    [deltaKey]: delta,
    direction: directionForDelta(delta),
    samples: values.length,
  };
}

function directionForDelta(delta) {
  if (delta > 0) return 'up';
  if (delta < 0) return 'down';
  return 'flat';
}

function zScoreSummary({
  values,
  latestKey,
  baselineMeanKey,
  standardDeviationKey,
  precision,
}) {
  if (values.length < 2) return undefined;

  const latest = values[values.length - 1];
  const baselineMean = meanValue(values);
  const standardDeviation = populationStandardDeviation(values, baselineMean);
  if (standardDeviation === 0) return undefined;

  const zScore = roundNumber((latest - baselineMean) / standardDeviation, 2);
  return {
    [latestKey]: roundNumber(latest, precision),
    [baselineMeanKey]: roundNumber(baselineMean, precision),
    [standardDeviationKey]: roundNumber(standardDeviation, precision),
    zScore,
    direction: directionForDelta(zScore),
    samples: values.length,
    windowDays: ROLLING_BASELINE_WINDOW_DAYS,
  };
}

function populationStandardDeviation(values, baselineMean = meanValue(values)) {
  const variance = meanValue(values.map((value) => (value - baselineMean) ** 2));
  return Math.sqrt(variance);
}

function meanValue(values) {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function roundNumber(value, precision) {
  const scale = 10 ** precision;
  return Math.round(value * scale) / scale;
}

function sleepHoursFromMeasurements(measurements) {
  const hours = firstFiniteNumber(
    measurements?.sleepHours,
    measurements?.sleep_hours,
    measurements?.sleepDurationHours,
    measurements?.sleep_duration_hours,
  );
  if (hours !== undefined) return hours;

  const minutes = firstFiniteNumber(
    measurements?.sleepDuration,
    measurements?.sleep_duration,
    measurements?.sleepDurationMinutes,
    measurements?.sleep_duration_minutes,
    measurements?.durationMinutes,
    measurements?.duration_minutes,
  );
  if (minutes !== undefined) return roundNumber(minutes / 60, 2);

  const seconds = firstFiniteNumber(
    measurements?.sleepDurationSeconds,
    measurements?.sleep_duration_seconds,
    measurements?.durationSeconds,
    measurements?.duration_seconds,
  );
  if (seconds !== undefined) return roundNumber(seconds / 3600, 2);

  return undefined;
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return undefined;
}

function isLiveRecord(record) {
  return isPlainObject(record) && !record.validTo && !record.supersededById;
}

function isWithinRollingBaselineWindow(record, now) {
  const timestamp = Date.parse(bodySampleTime(record));
  if (!Number.isFinite(timestamp)) return false;

  const current = dateFromNow(now).getTime();
  const age = current - timestamp;
  return age >= 0 && age <= ROLLING_BASELINE_WINDOW_MS;
}

function dateFromNow(now) {
  if (now === undefined) return new Date();
  const value = typeof now === 'function' ? now() : now;
  return value instanceof Date ? value : new Date(value);
}

function compareBodySampleTime(a, b) {
  return (
    bodySampleTime(a).localeCompare(bodySampleTime(b)) ||
    (optionalString(a?.id) ?? '').localeCompare(optionalString(b?.id) ?? '')
  );
}

function bodySampleTime(record) {
  return firstString(record?.eventAt, record?.ingestedAt, record?.validFrom) ?? '';
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

async function stagedBodyProtocols(dataDir) {
  const decisions = await decisionDataFiles(dataDir);

  return decisions
    .filter(isStagedBodyProtocolRecommendation)
    .map(projectBodyProtocolRecommendation);
}

async function decisionDataFiles(dataDir) {
  return (await decisionDataFileEntries(dataDir)).map((entry) => entry.data);
}

async function decisionDataFileEntries(dataDir) {
  return jsonDataFileEntries(dataDir, 'decisions');
}

async function ideaAtomDataFiles(dataDir) {
  return jsonDataFiles(dataDir, IDEA_ATOM_DIR);
}

async function mindOutputDataFiles(dataDir) {
  return jsonDataFiles(dataDir, MIND_OUTPUT_DIR);
}

async function jsonDataFiles(dataDir, relPath) {
  return (await jsonDataFileEntries(dataDir, relPath)).map((entry) => entry.data);
}

async function jsonDataFileEntries(dataDir, relPath) {
  return jsonDataFileEntriesFromDir(safeDataPath(dataDir, relPath), relPath);
}

async function jsonDataFileEntriesFromDir(dir, relPath) {
  let entries = [];

  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => {
        const entryRelPath = path.join(relPath, entry.name);
        // One corrupt artifact file must skip (-> null), not 500 the whole
        // read; preserve the silence-default contract.
        return fs
          .readFile(path.join(dir, entry.name), 'utf8')
          .then((text) => ({
            data: JSON.parse(text),
            relPath: entryRelPath,
          }))
          .catch(() => null);
      }),
  );
  return files.filter((entry) => entry !== null);
}

function isLiveIdeaAtom(record) {
  return isPlainObject(record) &&
    optionalString(record.kind) === IDEA_ATOM_KIND &&
    !record.validTo &&
    !record.supersededById;
}

function isLiveMindOutputRecord(record) {
  return isPlainObject(record) &&
    MIND_OUTPUT_GROUPS.includes(optionalString(record.outputGroup)) &&
    optionalString(record.outputGroup) !== MIND_OUTPUT_GROUPS[0] &&
    optionalString(record.outputId) &&
    !record.validTo &&
    !record.supersededById;
}

function projectIdeaAtom(record, context = {}) {
  const atom = {};
  const outputId = optionalString(record.id);
  const label = optionalString(record.label);
  const type = optionalString(record.type);
  const conversationId = firstString(record.conversationId, record.source?.conversationId);
  const confidence = finiteConfidence(record.confidence);
  const outputGroups = ideaAtomOutputGroups(record);
  const boundedLabel = label ? boundLabel(label) : 'Untitled idea';
  const evidenceIds = mindArtifactEvidenceIds(record);
  const sourceAtomIds = mindArtifactSourceAtomIds(record);
  const siblings = mindArtifactSiblings(sourceAtomIds, context.recordsById);
  const nextAction = mindArtifactNextAction(record, outputGroups, boundedLabel);
  const observation = mindArtifactObservation(record, outputGroups, boundedLabel, siblings);
  const considerations = mindArtifactConsiderations(record);
  const openAtomIds = mindArtifactOpenAtomIds(record);

  if (outputId) atom.outputId = outputId;
  atom.label = boundedLabel;
  atom.statement = mindArtifactStatement({
    label: boundedLabel,
    outputGroups,
    evidenceIds,
    sourceAtomIds,
    siblings,
    nextAction,
    observation,
  });
  if (evidenceIds.length > 0) atom.evidenceIds = evidenceIds;
  if (sourceAtomIds.length > 0) atom.sourceAtomIds = sourceAtomIds;
  atom.nextAction = nextAction;
  atom.siblings = siblings;
  if (outputGroups.includes('themes_open_loops')) {
    if (observation) atom.observation = observation;
    if (considerations.length > 0) atom.considerations = considerations;
    if (record.openLoop === true) atom.openLoop = true;
    if (openAtomIds.length > 0) atom.openAtomIds = openAtomIds;
  }
  if (type) atom.type = type;
  if (conversationId) atom.conversationId = conversationId;
  if (confidence !== undefined) atom.confidence = confidence;
  if (outputGroups.length > 0) atom.outputGroups = outputGroups;

  return atom;
}

function projectMindOutputRecord(record, context = {}) {
  const outputGroup = optionalString(record.outputGroup);
  const outputId = firstString(record.outputId, record.id);
  const label = optionalString(record.label);
  const type = optionalString(record.type);
  const kind = optionalString(record.kind);
  const boundedLabel = label ? boundLabel(label) : 'Untitled idea';
  const atomIds = mindOutputRecordAtomIds(record);
  const evidenceIds = mindArtifactEvidenceIds(record);
  const siblings = mindArtifactSiblings(atomIds, context.recordsById);
  const nextAction = mindArtifactNextAction(record, [outputGroup], boundedLabel);
  const observation = mindArtifactObservation(record, [outputGroup], boundedLabel, siblings);
  const considerations = mindArtifactConsiderations(record);
  const openAtomIds = mindArtifactOpenAtomIds(record);
  const confidence = finiteConfidence(record.confidence);
  const conversationIds = arrayValues(record.conversationIds)
    .map((value) => optionalString(value))
    .filter(Boolean)
    .sort();
  const statement = mindArtifactStatement({
    label: boundedLabel,
    outputGroups: outputGroup ? [outputGroup] : [],
    evidenceIds,
    sourceAtomIds: atomIds,
    siblings,
    nextAction,
    observation,
  });

  return buildMindArtifactPacket({
    viewType: mindOutputViewType(outputGroup),
    text: statement,
    fields: stripUndefined({
      outputId,
      outputType: outputGroup,
      kind,
      label: boundedLabel,
      evidenceIds,
      atomIds: atomIds.length > 0 ? atomIds : undefined,
      sourceAtomIds: atomIds.length > 0 ? atomIds : undefined,
      nextAction,
      siblings,
      observation,
      considerations,
      openLoop: record.openLoop === true,
      openAtomIds: openAtomIds.length > 0 ? openAtomIds : undefined,
      glaze: mindArtifactGlaze(record.glaze),
      type,
      conversationIds: conversationIds.length > 0 ? conversationIds : undefined,
    }),
    evidenceIds,
    siblings,
    nextAction,
    confidence,
  });
}

function mindOutputRecordAtomIds(record) {
  return Array.from(new Set([
    ...arrayValues(record.atomIds),
    ...arrayValues(record.sourceAtomIds),
    ...arrayValues(record.source?.atomIds),
  ]
    .map((value) => optionalString(value))
    .filter(Boolean))).sort();
}

function mindArtifactGlaze(value) {
  if (!isPlainObject(value)) return undefined;
  const score = Number(value.score);
  if (!Number.isFinite(score)) return undefined;
  const hits = arrayValues(value.hits)
    .map((hit) => optionalString(hit))
    .filter(Boolean)
    .slice(0, 4);
  return stripUndefined({
    score,
    hits: hits.length > 0 ? hits : undefined,
  });
}

function ideaAtomOutputGroups(record) {
  const groups = new Set();
  const values = [
    ...arrayValues(record.outputGroups),
    ...arrayValues(record.output_groups),
    record.outputGroup,
    record.output_group,
    record.outputType,
    record.output_type,
  ];

  for (const value of values) {
    const group = optionalString(value);
    if (MIND_OUTPUT_GROUPS.includes(group)) groups.add(group);
  }

  return Array.from(groups).sort();
}

function isStagedMindDecisionCandidate(record) {
  if (!isPlainObject(record)) return false;
  if (optionalString(record.kind) !== 'LoopRecommendation') return false;
  if (optionalString(record.station) !== 'decide') return false;
  if (optionalString(record.acted) !== 'pending') return false;
  if (record.validTo || record.supersededById) return false;
  if (isStagedBodyProtocolRecommendation(record)) return false;

  const marker = firstString(
    record.surface,
    record.targetSurface,
    record.source,
    record.recommendationKind,
    record.category,
    record.provenance?.surface,
    record.metadata?.surface,
  )?.toLowerCase();
  const summary = optionalString(record.summary)?.toLowerCase();
  const decision = firstString(record.decision, record.decisionCard?.asked)?.toLowerCase();
  const recommended = optionalString(record.recommended)?.toLowerCase();

  return Boolean(marker === 'mind' ||
    marker?.includes('mind') ||
    summary?.startsWith('mind cluster') ||
    decision?.includes('concrete build') ||
    recommended?.includes('reversible execution note'));
}

function projectMindCandidate(record, relPath) {
  const outputId = firstString(record.id, record.outputId, record.decisionId, relPath);
  const decision = firstString(record.decision, record.decisionCard?.asked, record.recommended);
  const tag = optionalString(record.tag);
  const confidence = finiteConfidence(record.confidence);
  const label = decision ? boundLabel(decision) : undefined;
  const evidenceIds = mindArtifactEvidenceIds(record);
  const rawNextAction = firstString(record.recommended, record.decisionCard?.next, label && `Review ${label}.`);
  const nextAction = rawNextAction
    ? boundMindArtifactText(rawNextAction, MIND_ARTIFACT_MAX_NEXT_ACTION_CHARS)
    : undefined;
  const decisionCard = projectMindCandidateDecisionCard(record);
  const statement = label && nextAction
    ? mindArtifactProtocolLine({
        state: label,
        context: `${evidenceIds.length} evidence ids attached to the staged decision`,
        // Public projection: NEVER echo the candidate's private rationale
        // (record.summary/reason) onto the wire — it stays server-side.
        observation: `staged for founder decision (${label})`,
        nextAction,
      })
    : undefined;

  return buildMindArtifactPacket({
    viewType: mindOutputViewType(MIND_OUTPUT_GROUPS[0]),
    text: statement,
    fields: stripUndefined({
      outputId,
      outputType: MIND_OUTPUT_GROUPS[0],
      kind: optionalString(record.kind),
      decision: label,
      label,
      evidenceIds,
      nextAction,
      siblings: [],
      decisionCard,
      ...decisionCard,
      tag,
    }),
    evidenceIds,
    siblings: [],
    nextAction,
    confidence,
  });
}

function projectMindCandidateDecisionCard(record) {
  if (!isPlainObject(record?.decisionCard)) return undefined;
  const card = {};
  const privateRationale = [
    optionalString(record.summary),
    optionalString(record.reason),
  ].filter(Boolean);

  for (const field of DECISION_CARD_FIELDS) {
    const text = decisionCardFieldText(record.decisionCard[field]);
    if (!text) return undefined;
    const bounded = boundMindArtifactText(text, MIND_DECISION_CARD_FIELD_MAX_CHARS);
    if (echoesPrivateRationale(bounded, privateRationale)) return undefined;
    card[field] = bounded;
  }

  return card;
}

function mindPacketOutputType(packet) {
  return optionalString(packet?.fields?.outputType);
}

function buildMindArtifactPacket({
  viewType,
  text,
  fields,
  evidenceIds,
  siblings,
  nextAction,
  confidence,
}) {
  return buildViewPacket({
    viewType,
    text,
    fields: boundPacketFields(fields),
    evidence: evidenceIds.length > 0 ? evidenceIds.slice(0, 40) : undefined,
    siblings: mindOutputPacketSiblingRefs(siblings),
    action: nextAction ? { kind: 'next_action', target: nextAction } : undefined,
    confidence,
    provenance: mindOutputPacketProvenance('server.artifacts'),
    frontierExcluded: true,
  });
}

function decisionCardFieldText(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => optionalString(entry))
      .filter(Boolean)
      .join('; ');
  }
  return optionalString(value);
}

function echoesPrivateRationale(value, privateRationale) {
  const normalized = normalizeProjectionText(value);
  if (!normalized) return false;
  return privateRationale.some((entry) => {
    const privateText = normalizeProjectionText(entry);
    return privateText.length >= 24 && normalized.includes(privateText);
  });
}

function normalizeProjectionText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function mindArtifactEvidenceIds(record) {
  return Array.from(new Set([
    ...arrayValues(record.atomIds),
    ...arrayValues(record.evidenceIds),
    ...arrayValues(record.evidence),
    ...arrayValues(record.sourceExposureIds),
    ...arrayValues(record.sourceAtomIds),
    ...arrayValues(record.source?.atomIds),
    ...arrayValues(record.source?.exposureIds),
  ]
    .map((value) => optionalString(value))
    .filter(Boolean))).sort();
}

function mindArtifactSourceAtomIds(record) {
  return Array.from(new Set([
    ...arrayValues(record.atomIds),
    ...arrayValues(record.sourceAtomIds),
    ...arrayValues(record.source?.atomIds),
  ]
    .map((value) => optionalString(value))
    .filter(Boolean))).sort();
}

function mindArtifactSiblings(sourceAtomIds, recordsById) {
  if (!(recordsById instanceof Map)) return [];
  return sourceAtomIds
    .map((id) => recordsById.get(id))
    .filter(Boolean)
    .slice(0, MIND_ARTIFACT_MAX_SIBLINGS)
    .map((record) => {
      // Siblings are a GROUPING REFERENCE only (id + bounded label + type) —
      // never re-expose the sibling's raw statement on the wire; the label
      // (bounded to a few words) is the sole text a sibling contributes.
      const sibling = {};
      const atomId = optionalString(record.id);
      const label = optionalString(record.label);
      const type = optionalString(record.type);
      const statement = optionalString(record.statement);

      if (atomId) sibling.atomId = atomId;
      sibling.label = label ? boundLabel(label) : 'Untitled idea';
      if (type) sibling.type = type;
      // boundLabel (not a length slice) is the defense: it strips punctuation/
      // underscores and caps words, so no raw chat substring — long OR short —
      // survives verbatim, while still yielding a non-empty reference string.
      if (statement) sibling.statement = boundLabel(statement);
      return sibling;
    });
}

function mindArtifactNextAction(record, outputGroups, label) {
  // BOUND every projected field: chat-derived text (recommended/nextAction) must
  // never reach the wire unbounded — it can carry the full private statement.
  const direct = firstString(record.nextAction, record.nextActionText, record.recommended);
  if (direct) return boundMindArtifactText(direct, MIND_ARTIFACT_MAX_NEXT_ACTION_CHARS);
  if (outputGroups.includes('build_decide')) return `Decide the next reversible step for ${label}.`;
  if (outputGroups.includes('resurfaced')) return `Review why ${label} resurfaced now.`;
  if (outputGroups.includes('new_ideas')) return `Review the bridge idea for ${label}.`;
  if (outputGroups.includes('themes_open_loops')) return `Review the open thread for ${label}.`;
  return `Review ${label}.`;
}

function mindArtifactObservation(record, outputGroups, label, siblings) {
  const direct = firstString(record.observation, record.themeObservation, record.insight);
  if (direct) return boundMindArtifactText(direct, MIND_ARTIFACT_OBSERVATION_MAX_CHARS);
  if (outputGroups.includes('themes_open_loops')) return undefined;
  const group = outputGroups[0] ?? 'mind';
  return siblings.length > 0
    ? `${siblings.length} sibling source items carry the thread`
    : `${label} is present in ${group}`;
}

function mindArtifactConsiderations(record) {
  if (!Array.isArray(record.considerations)) return [];
  return record.considerations
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      if (!isPlainObject(entry)) return undefined;
      return firstString(entry.consideration, entry.point, entry.label, entry.summary, entry.text);
    })
    .filter(Boolean)
    .map((entry) => boundMindArtifactText(entry, MIND_ARTIFACT_CONSIDERATION_MAX_CHARS))
    .filter(Boolean)
    .slice(0, MIND_ARTIFACT_MAX_CONSIDERATIONS);
}

function mindArtifactOpenAtomIds(record) {
  return Array.from(new Set([
    ...arrayValues(record.openAtomIds),
    ...arrayValues(record.open_atom_ids),
  ]
    .map((value) => optionalString(value))
    .filter(Boolean))).sort();
}

function mindArtifactStatement({
  label,
  outputGroups,
  evidenceIds,
  sourceAtomIds,
  siblings,
  nextAction,
  observation,
}) {
  const group = outputGroups[0] ?? 'mind';
  const context = sourceAtomIds.length > 0
    ? `${sourceAtomIds.length} source atoms and ${evidenceIds.length} evidence ids`
    : `${evidenceIds.length} evidence ids`;
  return mindArtifactProtocolLine({
    state: label,
    context,
    observation: observation ?? `${group} synthesis pending`,
    nextAction,
  });
}

function mindArtifactProtocolLine({
  state,
  context,
  observation,
  nextAction,
}) {
  // K's voice (see .claude/skills/k-copy): entity leads, a situation verb phrase,
  // the evidence support, then the ask — never the pipeline "state:/context:/…" scaffold.
  const entity = String(state ?? 'this').replace(/\s+/g, ' ').trim();
  const situation = humanizeMindSituation(observation);
  const support = humanizeMindSupport(context);
  const ask = humanizeMindAsk(nextAction);

  const head = situation ? `${entity} ${situation}` : entity;
  const line = [
    support ? `${head} — ${support}` : head,
    ask,
  ].filter(Boolean).join(' · ');
  return boundMindArtifactText(line, MIND_ARTIFACT_STATEMENT_MAX_CHARS);
}

function humanizeMindSituation(observation) {
  const text = String(observation ?? '').toLowerCase();
  if (!text) return '';
  if (text.includes('staged for founder decision')) return 'is ready for a decision';
  if (text.includes('synthesis pending')) return 'is still taking shape';
  if (text.includes('is present in mind')) return '';
  if (text.includes('resurfaced') || text.includes('return')) return 'came back after quiet';
  return '';
}

function humanizeMindSupport(context) {
  const text = String(context ?? '');
  const atoms = Number((text.match(/(\d+)\s+source atoms/) ?? [])[1]);
  const evidence = Number((text.match(/(\d+)\s+evidence ids/) ?? [])[1]);
  if (Number.isFinite(atoms) && atoms > 0 && Number.isFinite(evidence) && evidence !== atoms) {
    return `${atoms} ${atoms === 1 ? 'atom' : 'atoms'} across ${evidence} ${evidence === 1 ? 'piece' : 'pieces'} of evidence`;
  }
  if (Number.isFinite(evidence) && evidence >= 0) {
    return `${evidence} ${evidence === 1 ? 'piece' : 'pieces'} of evidence`;
  }
  return text.replace(/\s+/g, ' ').trim();
}

function humanizeMindAsk(nextAction) {
  const text = String(nextAction ?? '').replace(/\s+/g, ' ').trim().replace(/\.$/, '');
  if (!text) return '';
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function boundMindArtifactText(value, maxChars) {
  const clean = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length <= maxChars) return clean;
  // Trim to a word boundary (never mid-word) and mark the elision.
  const cut = clean.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

async function recordMindVerdict({ dataDir, now, payload }) {
  if (!isPlainObject(payload)) throw httpError(400, 'invalid_verdict_payload');
  rejectClientPathFields(payload);

  const date = normalizeMindEvalDate(
    optionalString(payload.date) ??
      (isMindEvalDate(payload.passId) ? optionalString(payload.passId) : undefined),
    now,
  );
  const passId = normalizeMindPassId(payload.passId, date);
  const outputType = normalizeMindOutputType(payload.outputType);
  const outputId = requiredPayloadString(payload.outputId, 'outputId');
  const verdict = normalizeMindEvalVerdict(payload.verdict);
  const outputRef = await currentMindOutputRef({ dataDir, outputType, outputId });
  const record = {
    passId,
    date,
    outputType,
    outputId,
    label: outputRef.label,
    verdict,
  };
  const log = await readMindEvalLog({ dataDir, date });
  const verdicts = log.verdicts.filter((entry) =>
    !(entry.passId === passId &&
      entry.outputType === outputType &&
      entry.outputId === outputId));
  verdicts.push(record);

  await writeMindEvalLog({
    dataDir,
    date,
    now,
    verdicts,
  });

  return {
    ok: true,
    verdict: record,
  };
}

async function currentMindOutputRef({ dataDir, outputType, outputId }) {
  const groups = await projectedMindOutputGroups(dataDir);
  const output = groups[outputType].find((item) => item.fields?.outputId === outputId);
  if (!output) throw httpError(404, 'mind_output_not_found');

  return {
    outputType,
    outputId,
    label: boundLabel(firstString(
      output.fields?.label,
      output.fields?.decision,
      'Untitled mind output',
    )),
  };
}

async function mindEvalVerdicts({ dataDir, date }) {
  return (await readMindEvalLog({ dataDir, date })).verdicts;
}

function emptyMindEvalLog(date) {
  return {
    kind: 'MindEvalVerdictLog',
    schemaVersion: 1,
    date,
    verdicts: [],
  };
}

async function readMindEvalLog({ dataDir, date }) {
  const file = mindEvalFile(dataDir, date);
  let parsed;

  try {
    parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    // A missing OR corrupt/unreadable eval log degrades to "no prior verdicts"
    // — never 500 the whole /mind + /eval read. This advisory log is
    // non-critical; preserving the silence-default contract (see the artifact
    // directory reader above) matters more than surfacing a parse error.
    return emptyMindEvalLog(date);
  }

  const verdicts = Array.isArray(parsed.verdicts)
    ? parsed.verdicts.map(projectMindEvalVerdict).filter(Boolean)
    : [];

  return {
    kind: 'MindEvalVerdictLog',
    schemaVersion: 1,
    date,
    verdicts,
  };
}

async function writeMindEvalLog({ dataDir, date, now, verdicts }) {
  const file = mindEvalFile(dataDir, date);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    `${JSON.stringify({
      kind: 'MindEvalVerdictLog',
      schemaVersion: 1,
      date,
      updatedAt: iso(now),
      verdicts,
    }, null, 2)}\n`,
    'utf8',
  );
}

function mindEvalFile(dataDir, date) {
  return safeDataPath(dataDir, path.join(MIND_EVAL_DIR, `mind-${date}.json`));
}

function projectMindEvalVerdict(record) {
  if (!isPlainObject(record)) return null;
  const passId = optionalString(record.passId);
  const date = optionalString(record.date);
  const outputType = optionalString(record.outputType);
  const outputId = optionalString(record.outputId);
  const label = optionalString(record.label);
  const verdict = optionalString(record.verdict);

  if (!passId ||
    !isMindEvalDate(date) ||
    !MIND_OUTPUT_GROUPS.includes(outputType) ||
    !outputId ||
    !label ||
    !MIND_EVAL_VERDICTS.includes(verdict)) {
    return null;
  }

  return {
    passId,
    date,
    outputType,
    outputId,
    label: boundLabel(label),
    verdict,
  };
}

function rejectClientPathFields(payload) {
  for (const field of ['path', 'file', 'relPath', 'targetPath', 'evalPath']) {
    if (Object.hasOwn(payload, field)) {
      throw httpError(400, 'client_path_not_allowed');
    }
  }
}

function normalizeMindEvalDate(value, now) {
  const date = optionalString(value) ?? iso(now).slice(0, 10);
  if (!isMindEvalDate(date)) throw httpError(400, 'invalid_eval_date');
  return date;
}

function isMindEvalDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function normalizeMindPassId(value, date) {
  const passId = optionalString(value) ?? date;
  if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(passId)) {
    throw httpError(400, 'invalid_pass_id');
  }
  return passId;
}

function normalizeMindOutputType(value) {
  const outputType = requiredPayloadString(value, 'outputType');
  if (!MIND_OUTPUT_GROUPS.includes(outputType)) throw httpError(400, 'invalid_output_type');
  return outputType;
}

function normalizeMindEvalVerdict(value) {
  const verdict = requiredPayloadString(value, 'verdict');
  if (!MIND_EVAL_VERDICTS.includes(verdict)) throw httpError(400, 'invalid_verdict');
  return verdict;
}

function requiredPayloadString(value, code) {
  const text = optionalString(value);
  if (!text) throw httpError(400, `missing_${code}`);
  return text;
}

async function modelCounts({ store, dataDir }) {
  const entries = await Promise.all(
    MODEL_COUNT_KINDS.map(async (kind) => [
      kind,
      kind === IDEA_ATOM_KIND
        ? (await ideaAtomDataFiles(dataDir)).length
        : (await store.listRecords(kind)).length,
    ]),
  );
  return Object.fromEntries(entries);
}

async function recentSelfPatterns(store) {
  const records = await store.listRecords('SelfPattern');

  return records
    .filter((record) => !record.validTo && !record.supersededById)
    .slice(-RECENT_PATTERN_LIMIT)
    .reverse()
    .map(projectSelfPattern);
}

function projectSelfPattern(record) {
  const pattern = {};
  const label = firstString(record.label, record.pattern);
  const createdAt = firstString(record.createdAt, record.ingestedAt, record.eventAt, record.validFrom);
  const confidence = finiteConfidence(record.confidence);

  if (label) pattern.label = label;
  if (confidence !== undefined) pattern.confidence = confidence;
  if (createdAt) pattern.createdAt = createdAt;

  return pattern;
}

function isStagedBodyProtocolRecommendation(record) {
  if (!isPlainObject(record)) return false;
  if (optionalString(record.kind) !== 'LoopRecommendation') return false;
  if (optionalString(record.acted) !== 'pending') return false;

  const surface = firstString(
    record.surface,
    record.targetSurface,
    record.protocol?.surface,
    record.metadata?.surface,
  )?.toLowerCase();
  const kind = firstString(
    record.protocolKind,
    record.recommendationKind,
    record.category,
    record.protocol?.kind,
    record.metadata?.kind,
  )?.toLowerCase();
  const hasBodyMarker = surface === 'body' || kind?.includes('body');
  const hasProtocolMarker = kind?.includes('protocol') || isPlainObject(record.protocol);

  return Boolean(hasBodyMarker && hasProtocolMarker);
}

function projectBodyProtocolRecommendation(record) {
  const protocol = {};

  for (const [key, value] of boundedProtocolFields(record, record.protocol)) {
    const text = optionalString(value);
    if (text) protocol[key] = text;
  }

  const confidence = finiteConfidence(record.protocol?.confidence ?? record.confidence);
  if (confidence !== undefined) {
    protocol.confidence = confidence;
  }

  return protocol;
}

function boundedProtocolFields(record, nested) {
  return [
    ['target', nested?.target ?? record.target],
    ['action', nested?.action ?? record.action],
    ['object', nested?.object ?? record.object],
    ['basis', nested?.basis ?? record.basis],
    ['category', nested?.category ?? record.category],
    ['tag', nested?.tag ?? record.tag],
  ];
}

function finiteConfidence(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : undefined;
}

function firstString(...values) {
  for (const value of values) {
    const text = optionalString(value);
    if (text) return text;
  }
  return undefined;
}

async function readPlaintextJson(request) {
  // BodyBridgeService posts plaintext JSON; Tailscale WireGuard is the transport-security floor.
  const raw = await readBody(request);
  if (!raw.trim()) throw httpError(400, 'empty_json_body');

  try {
    return JSON.parse(raw);
  } catch {
    throw httpError(400, 'invalid_json');
  }
}

async function readBody(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw httpError(413, 'body_too_large');
    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(`${JSON.stringify(body)}\n`);
}

function normalizeHost(value) {
  const host = optionalString(value) ?? DEFAULT_HOST;
  if (WILDCARD_HOSTS.has(host)) {
    throw new Error(`refused wildcard bind host: ${host}`);
  }
  return host;
}

// Governed tool executor for the chat route. Only tools the loop ALLOWED reach
// here (grant-gated in decideToolCall); anything unmapped fails closed.
export async function agentToolExecutor(toolId, args, context = {}) {
  if (toolId === 'admin.parse_intake') {
    return executeAdminParseIntakeTool(args, context);
  }
  if (toolId === 'deliberate') {
    const deliberate = isPlainObject(context.deliberate) ? context.deliberate : {};
    const timeoutMs = deliberate.timeoutMs ?? context.timeoutMs ?? DEFAULT_DELIBERATION_TIMEOUT_MS;
    return executeDeliberateTool(args, {
      dataDir: context.dataDir,
      now: context.now,
      store: context.store,
      timeoutMs,
      singleCall:
        deliberate.singleCall ??
        ((request) => openRouterZdrSingleCall(request, {
          timeoutMs,
          ...(isPlainObject(deliberate.openRouter) ? deliberate.openRouter : {}),
        })),
      researchFn: deliberate.researchFn,
      researchOptions: deliberate.researchOptions,
      context: deliberate.context,
      contextLimit: deliberate.contextLimit,
      commitStationOutput: deliberate.commitStationOutput,
      persist: deliberate.persist,
    });
  }
  if (toolId === 'strategize') {
    return executeStrategizeTool(args, context);
  }
  if (toolId === 'admin.add' || toolId === 'admin.reschedule' || toolId === 'admin.complete') {
    return executeAdminTriageTool(toolId, args, context);
  }
  if (toolId === 'web.search') {
    return executeWebSearch(args, context.webSearch);
  }
  if (toolId === 'web.fetch') {
    return executeWebFetch(args, context.webFetch);
  }
  if (toolId === 'memory.search') {
    return executeMemorySearchTool(args, context);
  }
  // TODO(GA integration): merge SKILLS_RUNTIME_TOOLS into tools.mjs registry
  // when that lane owns the advertised tool inventory.
  if (SKILLS_RUNTIME_TOOL_IDS.has(toolId)) {
    return executeSkillsRuntimeTool(toolId, args, context);
  }
  return { ok: false, reason: 'not_implemented' };
}

export async function executeMemorySearchTool(args = {}, context = {}) {
  const query = optionalString(args.query);
  const baseResult = {
    sensitive: true,
    sensitivity: 'sensitive',
    frontierExcluded: true,
    provenance: ['substrate', 'exposure', 'mind-surface'],
  };
  if (!query) return Object.freeze({ ok: false, reason: 'missing_query', ...baseResult });

  const dataDir = path.resolve(context.dataDir ?? context.store?.dataDir ?? path.join(process.cwd(), 'data'));
  const now = context.now ?? (() => new Date());
  const store = context.store ?? createSubstrateStore({ dataDir, now });
  const memorySearch = isPlainObject(context.memorySearch) ? context.memorySearch : {};
  const limit = memorySearchLimit(args.limit);
  const embeddingOptions = memorySearch.embeddingOptions ?? context.embeddingOptions;
  const logger = memorySearch.logger ?? context.logger;

  try {
    const liveExposureRecords = (await store.listRecords('Exposure'))
      .filter((record) =>
        isPlainObject(record) &&
        !record.validTo &&
        !record.supersededById &&
        hasSovereignExposureContent(record));
    const ranked = await rankedExposureRecordsForMessage({
      records: liveExposureRecords,
      dataDir,
      message: query,
      embeddingOptions,
      logger,
    });
    const scoredById = new Map((Array.isArray(ranked.scored) ? ranked.scored : [])
      .map((entry) => [optionalString(entry?.record?.id), entry?.score])
      .filter(([id]) => Boolean(id)));
    const selected = ranked.ok ? ranked.rankedRecords.slice(0, limit) : [];
    const exposures = selected.map((record) =>
      projectMemorySearchExposure(record, scoredById.get(optionalString(record.id))));
    const mindOutputs = await matchingMindOutputPackets({
      dataDir,
      exposureIds: exposures.map((entry) => entry.id).filter(Boolean),
    });
    const artifact = stripUndefined({
      kind: 'memory.search',
      query,
      limit,
      reason: ranked.ok ? undefined : optionalString(ranked.reason),
      exposures,
      mindOutputs,
    });

    return Object.freeze({
      ok: true,
      output: formatMemorySearchToolOutput(artifact),
      ...baseResult,
      artifacts: Object.freeze({ memorySearch: artifact }),
    });
  } catch (error) {
    logger?.warn?.('[cs-k] memory.search failed', {
      error: optionalString(error?.message) ?? 'memory_search_failed',
    });
    return Object.freeze({
      ok: false,
      reason: 'memory_search_failed',
      ...baseResult,
    });
  }
}

function memorySearchLimit(value) {
  const number = Number(value ?? MEMORY_SEARCH_DEFAULT_LIMIT);
  if (!Number.isSafeInteger(number) || number <= 0) return MEMORY_SEARCH_DEFAULT_LIMIT;
  return Math.min(number, MEMORY_SEARCH_MAX_LIMIT);
}

function projectMemorySearchExposure(record, score) {
  const exposure = projectSovereignExposure(record);
  return stripUndefined({
    id: exposure.id,
    statement: exposure.statement,
    surface: exposure.surface,
    eventAt: exposure.eventAt,
    score: Number.isFinite(score) ? Number(score.toFixed(6)) : undefined,
  });
}

async function matchingMindOutputPackets({ dataDir, exposureIds }) {
  const exposureIdSet = new Set((Array.isArray(exposureIds) ? exposureIds : [])
    .map((value) => optionalString(value))
    .filter(Boolean));
  if (exposureIdSet.size === 0) return [];

  const [ideaAtoms, mindOutputs] = await Promise.all([
    ideaAtomDataFiles(dataDir),
    mindOutputDataFiles(dataDir),
  ]);
  const recordsById = new Map(
    ideaAtoms
      .filter(isLiveIdeaAtom)
      .map((record) => [record.id, record]),
  );
  return mindOutputs
    .filter(isLiveMindOutputRecord)
    .filter((record) => mindArtifactEvidenceIds(record)
      .some((id) => exposureIdSet.has(id)))
    .map((record) => projectMindOutputRecord(record, { recordsById }));
}

function formatMemorySearchToolOutput(artifact) {
  const lines = [];
  const exposures = Array.isArray(artifact.exposures) ? artifact.exposures : [];
  const mindOutputs = Array.isArray(artifact.mindOutputs) ? artifact.mindOutputs : [];
  const reason = optionalString(artifact.reason);

  if (reason) lines.push(`memory.search fallback=${reason}`);
  lines.push(`memory.search results=${exposures.length}`);
  exposures.forEach((entry, index) => {
    lines.push(`${index + 1}. [${entry.id ?? '?'} | ${entry.eventAt ?? '?'} | ${entry.surface ?? '?'}] ${entry.statement ?? ''}`);
  });
  if (mindOutputs.length > 0) {
    lines.push(`mind cards=${mindOutputs.length}`);
    mindOutputs.forEach((packet, index) => {
      lines.push(`K${index + 1}. [${packet.viewType}] ${packet.text ?? packet.fields?.label ?? packet.id}`);
    });
  }
  return lines.join('\n');
}

async function executeStrategizeTool(args = {}, context = {}) {
  const outcome = optionalString(args.outcome);
  if (!outcome) return Object.freeze({ ok: false, reason: 'missing_outcome' });

  const strategy = isPlainObject(context.strategize) ? context.strategize : {};
  const timeoutMs = positiveMs(
    strategy.timeoutMs ?? context.timeoutMs,
    DEFAULT_STRATEGIZE_TIMEOUT_MS,
  );
  const baseSingleCall =
    strategy.singleCall ??
    strategy.modelCall ??
    ((request) => openRouterZdrSingleCall(request, {
      timeoutMs,
      ...(isPlainObject(strategy.openRouter) ? strategy.openRouter : {}),
    }));

  try {
    const result = await strategize(outcome, {
      dataDir: context.dataDir,
      now: context.now,
      store: context.store,
      openGoalLimit: strategy.openGoalLimit,
      goalTurnBudget: strategy.goalTurnBudget,
      promptPath: strategy.promptPath,
      modelCall: (request) =>
        withStrategizeTimeout(() => baseSingleCall(request), timeoutMs),
    });

    return Object.freeze({
      ok: true,
      output: renderStrategizeForTool(result),
      sensitive: true,
      provenance: ['strategize'],
    });
  } catch {
    return Object.freeze({ ok: false, reason: 'strategize_failed' });
  }
}

function renderStrategizeForTool(result) {
  const artifact = isPlainObject(result?.artifact) ? result.artifact : {};
  const workstreams = Array.isArray(artifact.workstreams) ? artifact.workstreams : [];
  const killCriteria = Array.isArray(artifact.antiFooling?.killCriteria)
    ? artifact.antiFooling.killCriteria
    : [];
  const nextStep =
    optionalString(artifact.actionableNextStep?.target) ??
    optionalString(result?.nextAction?.target) ??
    'none staged';

  const lines = [
    `objective: ${optionalString(artifact.goal) ?? '(unknown)'}`,
    'workstreams:',
    ...renderStrategyWorkstreams(workstreams),
    'kill-criteria:',
    ...renderStrategyList(killCriteria),
    `next step: ${nextStep}`,
  ];

  return boundToolText(lines.join('\n'), STRATEGIZE_TOOL_OUTPUT_MAX_CHARS);
}

function renderStrategyWorkstreams(workstreams) {
  if (workstreams.length === 0) return ['- (none)'];
  return workstreams.slice(0, 4).map((item) => {
    const name = optionalString(item?.name) ?? 'unnamed';
    const objective = optionalString(item?.objective) ?? 'no objective';
    const next = Array.isArray(item?.nextSteps) && item.nextSteps.length > 0
      ? ` next=${item.nextSteps.slice(0, 2).join(' / ')}`
      : '';
    const stop = optionalString(item?.stopCondition);
    return `- ${name}: ${objective}${next}${stop ? `; stop=${stop}` : ''}`;
  });
}

function renderStrategyList(items) {
  const strings = items
    .map((item) => optionalString(item))
    .filter(Boolean)
    .slice(0, 5);
  return strings.length > 0 ? strings.map((item) => `- ${item}`) : ['- (none)'];
}

async function withStrategizeTimeout(operation, timeoutMs) {
  let timeout;
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('strategize timed out')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function positiveMs(value, fallback) {
  const number = Number(value ?? fallback);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function boundToolText(value, maxChars) {
  const text = String(value ?? '');
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 24)}\n[tool output truncated]`;
}

function isLoopbackRequest(request) {
  const remote = optionalString(request?.socket?.remoteAddress) ?? '';
  if (remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1') return true;
  // The daemon may bind ONLY the tailnet address, making true loopback
  // unreachable. A connection whose source IS the bound address can only
  // originate on this machine (the iPad's connections arrive with its own
  // tailnet IP as remote) — treat self-connections as local.
  const local = optionalString(request?.socket?.localAddress) ?? '';
  return Boolean(remote) && remote === local;
}

function normalizePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid port: ${value}`);
  }
  return port;
}

function assertAllowedBindHost(host) {
  if (isAllowedBindAddress(host)) return;
  throw new Error(`refused non-local bind: ${host || 'unknown'}`);
}

async function assertAllowedBoundAddress(server) {
  const address = server.address();
  const host = address && typeof address === 'object' ? address.address : String(address ?? '');

  if (isAllowedBindAddress(host)) return;

  await closeServer(server);
  throw new Error(`refused non-local bind: ${host || 'unknown'}`);
}

export function isAllowedBindAddress(address) {
  if (address === '127.0.0.1' || address === '::1') return true;

  const octets = String(address).split('.');
  if (octets.length !== 4) return false;

  const [first, second, third, fourth] = octets.map((part) => Number(part));
  if (![first, second, third, fourth].every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    return false;
  }

  return first === 100 && second >= 64 && second <= 127;
}

async function closeServer(server) {
  if (!server.listening) return;

  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function httpError(statusCode, code) {
  const error = new Error(code);
  error.statusCode = statusCode;
  error.code = code;
  error.expose = true;
  return error;
}
