import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  ROOT,
  clampConfidence,
  commitStationOutput,
  iso,
  refuseAutoAction,
  safeDataPath,
  writeUniqueDataJson,
} from '../../daemon/run.mjs';
import { average } from '../math.mjs';
import { governNextAction } from '../next-action.mjs';
import { runDeliberation } from '../agent/deliberate.mjs';
import {
  loadSoulSnapshot,
  withSoulPromptBlock,
} from '../agent/soul.mjs';
import { boundPacketFields, buildViewPacket } from '../agent/view-packet.mjs';
import { openRouterZdrModelCall } from '../reason/sensitive-model.mjs';
import {
  promptTokenEstimate,
  recordModelMetric,
} from '../metrics/instrument.mjs';
import {
  createContradictionRegister,
  detectGlaze,
  GLAZE_SURFACE_THRESHOLD,
} from '../agent/truth.mjs';
import {
  nameMindEntity,
  relabelMindOutputs as relabelMindOutputsImpl,
} from './naming.mjs';
import {
  embed,
  sha256,
} from '../research/embed.mjs';
import { cosineSimilarity } from '../research/vrsd.mjs';
import {
  createSubstrateStore,
  isPlainObject,
  makeLogNote,
  optionalString,
  requiredString,
  stripUndefined,
} from '../substrate.mjs';
import { clusterMindAtoms as runMindClusterSidecar } from './cluster.mjs';

const DEFAULT_DATA_DIR = path.join(ROOT, 'data');
const DEFAULT_LOCAL_MODEL = 'llama3.1';
const OLLAMA_GENERATE_URL = 'http://127.0.0.1:11434/api/generate';
const IDEA_ATOM_SCHEMA_VERSION = 1;
const IDEA_ATOM_DIR = path.join('substrate', 'idea-atoms');
const DECISION_DIR = 'decisions';
const MIND_OUTPUT_SCHEMA_VERSION = 1;
export const MIND_OUTPUT_DIR = path.join('substrate', 'mind-outputs');
const DEFAULT_MIN_CLUSTER_ATOMS = 2;
const DEFAULT_CANDIDATE_LIMIT = 3;
// Per-request model timeout. The 20s default suits fast/hosted lanes; a local
// large model (qwen2.5:14b on a laptop) needs far longer on a real conversation
// prompt, so allow K_THINK_TIMEOUT_MS to raise it. Default lifted to 120s — a
// ceiling, not a wait; fast lanes still return in a few seconds.
const DEFAULT_OLLAMA_TIMEOUT_MS = Number(process.env.K_THINK_TIMEOUT_MS) > 0
  ? Math.floor(Number(process.env.K_THINK_TIMEOUT_MS))
  : 120_000;
const DEFAULT_OLLAMA_RETRY_COUNT = 1;
const DEFAULT_OLLAMA_RETRY_BACKOFF_MS = 100;
const DEFAULT_OLLAMA_RETRY_JITTER_MS = 50;
export const DEFAULT_THEME_MIN_ATOMS = 3;
export const DEFAULT_THEME_MIN_CONVERSATIONS = 2;
export const DEFAULT_THEME_SIMILARITY_THRESHOLD = 0.82;
export const DEFAULT_OPEN_LOOP_CLOSURE_THRESHOLD = 0.78;
export const DEFAULT_RESURFACE_GAP_DAYS = 30;
export const DEFAULT_RESURFACE_RECENT_DAYS = 14;
export const DEFAULT_RESURFACE_SIMILARITY_THRESHOLD = 0.82;
export const DEFAULT_CLUSTER_MIN_ATOMS = 15;
export const DEFAULT_CLUSTER_RESURFACE_GAP_DAYS = 90;
export const DEFAULT_CLUSTER_RESURFACE_RECENT_DAYS = 30;
// A leaf cluster that spans fewer than this many DISTINCT founder conversations
// is a tool-artifact, not founder thinking (e.g. "links/fetch/url", a single
// paste echoed back). Such clusters are dropped before they reach candidates,
// resurfaced ideas, or bridges — the sidecar clusters faithfully, but a cluster
// confined to one exposure is not a recurring idea. Override via
// K_MIND_CLUSTER_MIN_CONVERSATIONS.
export const DEFAULT_CLUSTER_MIN_CONVERSATIONS = 2;
export const MAX_CONVERSATION_MESSAGES = 40;
export const MAX_CONVERSATION_CHARS = 24_000;
// Conversation extractions are independent model calls; run a bounded pool
// instead of one-at-a-time (a 480-conversation pass over a hosted model is
// otherwise dominated by sequential round-trips). Override via K_THINK_CONCURRENCY.
export const DEFAULT_THINK_CONCURRENCY = 6;
export const DEFAULT_MIND_MODEL_PROVIDER = 'openrouter-zdr';
// Mind synthesis over a full conversation on a reasoning model (GLM-5.1) runs
// ~45-80s; the sovereign chat lane's 60s default is too tight and silences the
// mind. Give synthesis its own ceiling (env-tunable).
const MIND_SYNTHESIS_TIMEOUT_MS = Number(process.env.K_MIND_TIMEOUT_MS) > 0
  ? Math.floor(Number(process.env.K_MIND_TIMEOUT_MS))
  : 180_000;
export const LOCAL_MIND_MODEL_PROVIDER = 'local-ollama';
export const MIND_OUTPUT_GROUPS = Object.freeze([
  'build_decide',
  'themes_open_loops',
  'resurfaced',
  'new_ideas',
]);
const logNote = makeLogNote('think');
const NON_FOUNDER_ROLES = new Set(['assistant', 'model', 'ai', 'bot', 'system']);
const MAX_LABEL_WORDS = 8;
const MAX_LABEL_CHARS = 80;
const MAX_PROTOCOL_STATEMENT_CHARS = 420;
const MAX_SIBLINGS = 6;
const MAX_THEME_CONSIDERATIONS = 4;
const MAX_DECISION_CARD_FIELD_CHARS = 220;
const MAX_GLAZE_HITS = 4;
// GLM-5.1 is a reasoning model over a full cluster; 30s + a 700-token budget
// starved it (truncated/empty JSON → cards silently dropped). Match the mind
// synthesis ceiling.
const DEFAULT_DECISION_CARD_TIMEOUT_MS = 180_000;
const OUTPUT_CONFIDENCE_ATOM_WEIGHT = 0.7;
const OUTPUT_CONFIDENCE_COHERENCE_WEIGHT = 0.3;
const SAME_CONVERSATION_TOKEN_CLOSURE_THRESHOLD = 0.25;

const ATOM_SYSTEM_PROMPT = [
  'You extract the founder\'s salient thinking from ONE conversation and output ONLY structured atoms.',
  'Input is a JSON object whose "messages" are founder-authored (each has an "id" and a "statement"); assistant narration is already removed.',
  'Your job: name the durable founder intents, decisions, questions, ideas, and open-loops — this is analysis, NOT a summary and NOT a transcript.',
  'Each atom is a DISTILLED INTENT in the founder\'s own voice: "wants X", "deciding between Y and Z", "protocol for W", "open question: …". State the thought directly.',
  'NEVER write narration ABOUT the founder. Banned openings: "The user is asking…", "The user wants…", "The founder is…", "This conversation is about…". Write the intent itself, not a description of it.',
  'No hedging or filler: never "or something similar", "appears to be", "it seems that". If a thought is not durable founder thinking, omit it rather than padding.',
  'CRITICAL: never echo, repeat, or reformat the input messages. Output ONLY the atoms object specified below — never output the conversation back.',
  'Output STRICT JSON and nothing else: {"atoms":[{"label":"<=8 words","statement":"self-contained thought in the founder\'s voice","type":"intent|decision|question|idea|open-loop","confidence":0.0-1.0,"evidenceIds":["<id of a supporting input message>"]}]}',
  'Every evidenceIds entry MUST be an "id" copied verbatim from the input messages that supports that atom. An atom with no real supporting id is invalid — omit it.',
  'Return {"atoms":[]} only when the conversation is purely social, procedural, or has no durable founder thinking.',
  'Example input: {"messages":[{"id":"m1","statement":"do the build plan, structure it minimal-first then hand it the spec to build itself"},{"id":"m2","statement":"what are the initial steps?"}]}',
  'Example output: {"atoms":[{"label":"minimal-first self-building build","statement":"Build the most minimal version first, then give it the spec to build itself.","type":"decision","confidence":0.8,"evidenceIds":["m1"]}]}',
  'Counter-example (WRONG — narration, not intent): {"statement":"The user is asking about the build plan and initial steps."} — instead distill the intent the founder is pursuing.',
].join('\n');

// Forces the output STRUCTURE at the model layer (ollama `format`), so a small
// local model cannot drift into echoing the input or replying as an assistant.
const ATOM_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    atoms: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          statement: { type: 'string' },
          type: { type: 'string', enum: ['intent', 'decision', 'question', 'idea', 'open-loop'] },
          confidence: { type: 'number' },
          evidenceIds: { type: 'array', items: { type: 'string' } },
        },
        required: ['statement', 'type', 'evidenceIds'],
      },
    },
  },
  required: ['atoms'],
};

const DIVERGENT_SYSTEM_PROMPT = [
  'Generate one genuinely new idea by connecting the bridge atom across the two semantic clusters.',
  'Return strict JSON: {"statement":"","rationale":"","confidence":0}.',
  'The idea is advisory only: do not propose or perform external action. Do not quote the input atoms verbatim.',
  'No praise, flattery, validation, exclamation, or agreement-seeking tone.',
].join('\n');

const THEME_SUMMARY_SYSTEM_PROMPT = [
  'Synthesize one Ward parent theme from c-TF-IDF keywords and bounded member atoms.',
  'Return strict JSON: {"summary":"","observation":"","considerations":["",""],"confidence":0}.',
  'summary: one RAPTOR-style line, <=160 characters.',
  'observation: one synthesized insight in the founder\'s frame, 1-2 COMPLETE sentences (<=380 chars); do not echo keywords or quote atom statements verbatim.',
  'considerations: 2-4 mutually-exclusive, collectively-exhaustive points needed to act on this theme; each ONE complete sentence (<=200 chars), no trailing cut-offs.',
  'Do not narrate about the user/founder. Do not propose or perform external action.',
  'No praise, flattery, validation, exclamation, or agreement-seeking tone.',
].join('\n');

const DECISION_CARD_SYSTEM_PROMPT = [
  'Synthesize one decision-grade K card from one mind cluster and its bounded idea-atoms.',
  'Return strict JSON with exactly these string fields: {"asked":"","read":"","assumed":"","missing":"","pick":"","why":"","whatWouldChangeIt":"","next":""}.',
  'Each field must be ONE complete sentence, <=180 characters, mutually exclusive from the others, and collectively sufficient to decide.',
  'Use the cluster atoms as evidence, but synthesize; do not quote or lightly rephrase atom statements, labels, keywords, or private rationale.',
  'asked: the decision question this cluster raises.',
  'read: the evidence base that was read, stated as a sentence, not a list of ids.',
  'assumed: the strongest assumption needed to make the pick.',
  'missing: the most important missing angle or "No material missing angle remains."',
  'pick: the concrete advisory pick.',
  'why: the reason this pick follows from the cluster.',
  'whatWouldChangeIt: the evidence or condition that would overturn the pick.',
  'next: the smallest reversible founder-owned next step.',
  'Do not narrate about the user/founder. Do not propose or perform external action.',
  'No praise, flattery, validation, exclamation, or agreement-seeking tone.',
].join('\n');

const DECISION_CARD_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    asked: { type: 'string' },
    read: { type: 'string' },
    assumed: { type: 'string' },
    missing: { type: 'string' },
    pick: { type: 'string' },
    why: { type: 'string' },
    whatWouldChangeIt: { type: 'string' },
    next: { type: 'string' },
  },
  required: [
    'asked',
    'read',
    'assumed',
    'missing',
    'pick',
    'why',
    'whatWouldChangeIt',
    'next',
  ],
};

export const DECISION_CARD_FIELDS = Object.freeze([
  'asked',
  'read',
  'assumed',
  'missing',
  'pick',
  'why',
  'whatWouldChangeIt',
  'next',
]);

// U4 — build/decide → deliberation escalation. Low-coherence (uncertain)
// clusters can escalate from the single-call decision card to the full Board
// debate ⟷ ARGUS deliberation loop, which returns the SAME 8-field card but
// debated + missing-evidence-researched (deeper MECE). Off by default — the
// escalation runs Board rounds per cluster, so it is opt-in (the eval/founder
// turns it on) and capped per run to bound cost.
const DEFAULT_DELIBERATION_COHERENCE_THRESHOLD = 0.5;
const DEFAULT_MAX_DELIBERATIONS_PER_RUN = 3;
const DELIBERATED_CARD_FIELD_MAX_CHARS = 280;

export async function think(opts = {}) {
  const dataDir = path.resolve(opts.dataDir ?? process.env.CS_K_DATA_DIR ?? DEFAULT_DATA_DIR);
  const now = opts.now ?? (() => new Date());
  const store = opts.store ?? createSubstrateStore({ dataDir, now });
  const logger = opts.logger ?? console;
  const notes = [];
  const synthesisProvider = opts.modelCall
    ? 'injected'
    : mindModelProvider(opts.modelProvider);
  const soulSnapshot = opts.soulSnapshot === false
    ? null
    : opts.soulSnapshot ?? await loadSoulSnapshot({ dataDir });
  let model;
  const modelName = () => {
    model ??= synthesisModelName(synthesisProvider, opts.model);
    return model;
  };
  const rawModelCall = resolveMindSynthesisModelCall({
    ...opts,
    logger,
    onNote: opts.onNote ?? ((note) => logNote(notes, logger, note)),
  });
  const soulModelCall = (request) =>
    rawModelCall(soulSnapshot ? withSoulPromptBlock(request, soulSnapshot) : request);
  const modelCall = opts.timeoutMs === undefined
    ? soulModelCall
    : (request) => withOperationTimeout(
        () => soulModelCall(request),
        opts.timeoutMs,
        optionalString(request?.label ?? request?.task) ?? 'model call',
      );
  let modelAvailable = true;

  const exposures = liveExposures(
    opts.exposures ?? await store.listRecords('Exposure'),
  );
  const allConversations = extractionConversations(exposures, { notes, logger });
  // Optional slice cap (opts.conversationLimit / K_THINK_CONVERSATION_LIMIT):
  // run extraction over only the first N conversations. Deterministic order, so
  // a fixed N is a stable slice — the eval's frozen-golden-slice mechanic, and a
  // cheap way to validate extraction quality before a full multi-hour pass.
  const conversationLimit = positiveInteger(
    opts.conversationLimit ?? process.env.K_THINK_CONVERSATION_LIMIT,
    0,
  );
  // Richest-first when slicing: the most multi-turn founder conversations carry
  // the real thinking — single-exposure pseudo-conversations (bookmarks, no
  // conversationId) sort last. Deterministic (count desc, then id) so a fixed N
  // is a stable slice.
  const conversations = conversationLimit > 0
    ? [...allConversations]
        .sort((a, b) =>
          (b.messages?.length ?? 0) - (a.messages?.length ?? 0) ||
          String(a.conversationId).localeCompare(String(b.conversationId)))
        .slice(0, conversationLimit)
    : allConversations;
  const founderExposures = conversations.flatMap((conversation) => conversation.messages);
  const synthesizedAtoms = [];
  const atomMutations = [];
  const successfulConversationIds = new Set();

  // Bounded-concurrency pool over conversations. Workers pull the next index off
  // a shared cursor; the cursor is bumped synchronously so launch order == index
  // order. A per-request failure (one payload rejected) is isolated and skipped;
  // a HARD unavailability (connectivity/auth/timeout) stops launching new work.
  const concurrency = Math.max(1, positiveInteger(
    opts.concurrency ?? process.env.K_THINK_CONCURRENCY,
    DEFAULT_THINK_CONCURRENCY,
  ));
  let nextIndex = 0;
  let skippedFailures = 0;
  const worker = async () => {
    while (modelAvailable) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= conversations.length) return;
      const conversation = conversations[index];
      try {
        const extracted = await synthesizeConversationAtoms(conversation, {
          modelCall,
          model: modelName(),
        });
        synthesizedAtoms.push(...extracted);
        successfulConversationIds.add(conversation.conversationId);
      } catch (error) {
        if (isModelUnavailableError(error)) {
          modelAvailable = false;
          logNote(notes, logger, `synthesis model unavailable; mind silenced (${error.message})`);
          return;
        }
        skippedFailures += 1;
        logNote(
          notes,
          logger,
          `conversation skipped during atom synthesis: ${conversation.conversationId} (${error.message})`,
        );
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(conversations.length, 1)) }, () => worker()),
  );
  // Systemic failure — every attempt failed and nothing was extracted — silences,
  // matching the sequential guard (a lone skip with successes does NOT silence).
  if (modelAvailable && successfulConversationIds.size === 0 && skippedFailures > 0) {
    modelAvailable = false;
    logNote(notes, logger, `synthesis model unavailable after ${skippedFailures} failures; mind silenced`);
  }

  const atoms = [];
  if (modelAvailable) {
    const atomsByConversationId = groupExtractedAtomsByConversationId(synthesizedAtoms);
    for (const conversationId of successfulConversationIds) {
      const refreshedAtoms = [];
      for (const extracted of atomsByConversationId.get(conversationId) ?? []) {
        try {
          const { record, mutations } = await writeIdeaAtom({
            ...extracted,
          }, { dataDir, now });
          atoms.push(record);
          refreshedAtoms.push(record);
          atomMutations.push(...mutations);
        } catch (error) {
          logNote(
            notes,
            logger,
            `conversation skipped during atom persistence: ${optionalString(extracted.conversationId) ?? 'unknown'} (${error.message})`,
          );
        }
      }
      atomMutations.push(...await supersedeStaleConversationAtoms(conversationId, refreshedAtoms, {
        dataDir,
        now,
      }));
    }
  }

  const embeddingOpts = embeddingOptions(opts, dataDir);
  let segmentation = [];
  let clusters = [];
  const candidates = [];
  const stagedMutations = [];
  let divergentIdeas = [];
  let themes = [];
  let resurfacedIdeas = [];
  let atomDocs = [];
  let clusterResult = null;

  if (modelAvailable && atoms.length > 0) {
    try {
      atomDocs = await embeddedIdeaAtomDocs(atoms, embeddingOpts);
    } catch (error) {
      logNote(notes, logger, `mind output atom embedding skipped: ${error.message}`);
    }

    if (atomDocs.length === 0) {
      logNote(notes, logger, 'mind clustering skipped: no atom embeddings available');
    } else if (shouldRunAtomClustering(atomDocs, opts)) {
      clusterResult = await runAtomClusterer(atomDocs, {
        opts,
        now,
        notes,
        logger,
      });
      if (clusterResult) {
        clusters = sidecarLeafClusters(clusterResult, atomDocs, opts);
      }
    }
  }

  const currentMindDecisionPaths = [];
  // Per-run cap on deliberation escalations (U4) — bounds Board-round cost.
  const deliberationBudget = {
    used: 0,
    // Non-negative: 0 is a valid cap (disable escalation), so positiveInteger
    // (which rejects 0) is wrong here.
    max: Number.isInteger(opts.maxDeliberations) && opts.maxDeliberations >= 0
      ? opts.maxDeliberations
      : DEFAULT_MAX_DELIBERATIONS_PER_RUN,
  };
  const namingOpts = mindNamingOptions(opts, {
    dataDir,
    now,
    notes,
    logger,
  });
  for (const rawCluster of actionableClusters(clusters, opts)) {
    const cluster = await nameLeafCluster(rawCluster, namingOpts);
    const candidate = await candidateForCluster(cluster, {
      ...opts,
      modelCall,
      model: modelName(),
      notes,
      logger,
      dataDir,
      store,
      now,
      deliberationBudget,
    });
    if (!buildDecideCriterionSatisfied(candidate, cluster, opts)) continue;
    candidates.push(candidate);
    refuseAutoAction(candidate.output);
    if (candidate.nextAction.tag === '[auto]') {
      throw new Error('mind recommendations may not auto-act');
    }
    const mutations = await commitStationOutput(
      'decide',
      candidate.output,
      { dataDir, now },
    );
    candidate.mutations = mutations;
    stagedMutations.push(...mutations);
    currentMindDecisionPaths.push(...mutations
      .map((mutation) => decisionRelPathFromMutation(mutation))
      .filter(Boolean));
  }

  if (currentMindDecisionPaths.length > 0) {
    stagedMutations.push(...await supersedePriorMindCandidateDecisions(currentMindDecisionPaths, {
      dataDir,
      now,
    }));
  }

  if (clusterResult && atomDocs.length > 0) {
    const outputAtomDocs = nonNoiseAtomDocs(atomDocs, clusterResult);

    try {
      themes = await synthesizeParentThemes(clusterResult, outputAtomDocs, {
        modelCall,
        model: modelName(),
        opts,
        notes,
        logger,
      });
    } catch (error) {
      logNote(notes, logger, `mind themes skipped: ${error.message}`);
    }

    try {
      resurfacedIdeas = Object.freeze(sidecarResurfacedIdeas(clusterResult, outputAtomDocs, opts));
    } catch (error) {
      logNote(notes, logger, `mind resurfacing skipped: ${error.message}`);
    }

    divergentIdeas.push(...await synthesizeBridgeIdeas(clusterResult, outputAtomDocs, {
      modelCall,
      model: modelName(),
      opts,
      notes,
      logger,
    }));
  } else if (!modelAvailable && exposures.length > 0) {
    logNote(notes, logger, 'divergent idea skipped because the synthesis model path was unavailable');
  }
  themes = await nameMindOutputEntities(themes, MIND_OUTPUT_GROUPS[1], atomDocs, namingOpts);
  resurfacedIdeas = await nameMindOutputEntities(resurfacedIdeas, MIND_OUTPUT_GROUPS[2], atomDocs, namingOpts);
  divergentIdeas = await nameMindOutputEntities(divergentIdeas, MIND_OUTPUT_GROUPS[3], atomDocs, namingOpts);

  const themesOpenLoops = Object.freeze([...themes]);
  const outputMutations = await persistMindOutputs({
    themesOpenLoops,
    resurfacedIdeas,
    divergentIdeas,
    atomDocs,
    dataDir,
    now,
  });
  stagedMutations.push(...outputMutations);

  const outputProjectionContext = mindOutputProjectionContext({ atomDocs, clusters });
  const outputs = Object.freeze({
    build_decide: Object.freeze(candidates.map((output) =>
      projectMindOutput(output, MIND_OUTPUT_GROUPS[0], outputProjectionContext))),
    themes_open_loops: Object.freeze(themesOpenLoops.map((output) =>
      projectMindOutput(output, MIND_OUTPUT_GROUPS[1], outputProjectionContext))),
    resurfaced: Object.freeze(resurfacedIdeas.map((output) =>
      projectMindOutput(output, MIND_OUTPUT_GROUPS[2], outputProjectionContext))),
    new_ideas: Object.freeze(divergentIdeas.map((output) =>
      projectMindOutput(output, MIND_OUTPUT_GROUPS[3], outputProjectionContext))),
  });

  return Object.freeze({
    kind: 'MindThinkResult',
    schemaVersion: 1,
    exposureCount: exposures.length,
    founderExposureCount: founderExposures.length,
    conversationCount: conversations.length,
    createdAtomCount: atomMutations.filter((mutation) => mutation.op === 'write').length,
    atomCount: atoms.length,
    candidateCount: candidates.length,
    divergentIdeaCount: divergentIdeas.length,
    themesOpenLoopsCount: themesOpenLoops.length,
    resurfacedIdeaCount: resurfacedIdeas.length,
    atoms: Object.freeze(atoms),
    clusters: Object.freeze(clusters),
    candidates: Object.freeze(candidates),
    divergentIdeas: Object.freeze(divergentIdeas),
    themesOpenLoops,
    resurfacedIdeas,
    outputs,
    segmentation: Object.freeze(segmentation),
    mutations: Object.freeze([...atomMutations, ...stagedMutations]),
    notes: Object.freeze(notes),
  });
}

export async function relabelMindOutputs(opts = {}) {
  return relabelMindOutputsImpl({
    ...opts,
    fallbackLabel: boundLabel,
  });
}

export function resolveMindSynthesisModelCall(opts = {}) {
  if (opts.modelCall) return opts.modelCall;

  const provider = mindModelProvider(opts.modelProvider);
  if (provider === DEFAULT_MIND_MODEL_PROVIDER) {
    return (request) => openRouterZdrModelCall(request, {
      fetchImpl: opts.fetchImpl,
      timeoutMs: opts.timeoutMs ?? MIND_SYNTHESIS_TIMEOUT_MS,
      // Background batch: enable GLM chain-of-thought for synthesis quality;
      // the raised timeout + budget absorb the extra latency (unlike chat).
      reasoning: true,
    });
  }
  if (provider === LOCAL_MIND_MODEL_PROVIDER) {
    return (request) => localOllamaModelCall(request, {
      fetchImpl: opts.fetchImpl,
      timeoutMs: opts.timeoutMs,
      logger: opts.logger,
      onNote: opts.onNote,
      retryCount: opts.ollamaRetryCount,
      retryBackoffMs: opts.ollamaRetryBackoffMs,
      retryJitterMs: opts.ollamaRetryJitterMs,
    });
  }

  throw new Error(`unsupported mind model provider: ${provider}`);
}

export async function localOllamaModelCall(request, opts = {}) {
  const startedAt = Date.now();
  let payload;
  let result;
  const fetchFn = opts.fetchImpl ?? globalThis.fetch;
  if (typeof fetchFn !== 'function') {
    throw new Error('fetch is unavailable for local Ollama model call');
  }

  const model = localModelName(request.model);
  const prompt = [
    optionalString(request.system),
    optionalString(request.user),
  ].filter(Boolean).join('\n\n');

  // A full JSON schema in `format` forces the output STRUCTURE (not just valid
  // JSON); temperature 0 makes a small local model follow the extraction
  // instruction instead of reverting to chatty assistant prose.
  const format = request.responseSchema ?? (request.responseFormat === 'json' ? 'json' : undefined);
  try {
    const retryCount = nonNegativeInteger(opts.retryCount, DEFAULT_OLLAMA_RETRY_COUNT);
    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await fetchWithTimeout(fetchFn, OLLAMA_GENERATE_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model,
            prompt,
            stream: false,
            options: { temperature: Number.isFinite(request.temperature) ? request.temperature : 0 },
            ...(format ? { format } : {}),
          }),
        }, {
          timeoutMs: opts.timeoutMs,
          label: 'Ollama generate request',
        });

        if (!response?.ok) {
          throw await ollamaStatusError(response);
        }

        payload = await response.json();
        const text = requiredString(payload.response, 'Ollama response');
        result = request.responseFormat === 'json'
          ? parseJsonObject(text)
          : { response: text };
        return result;
      } catch (error) {
        if (!isRetryableOllamaError(error) || attempt >= retryCount) {
          if (isRetryableOllamaError(error)) {
            emitOllamaDegradeNote(opts, error, attempt + 1);
            throw ollamaUnavailableError(error, attempt + 1);
          }
          throw error;
        }
        await waitForOllamaRetry({ attempt, opts });
      }
    }
  } finally {
    const evalNs = Number(payload?.eval_duration);
    const genMs = Number.isFinite(evalNs) && evalNs > 0
      ? evalNs / 1e6
      : Date.now() - startedAt;
    recordModelMetric({
      seam: 'localOllamaModelCall',
      lane: 'local',
      model,
      ms: Date.now() - startedAt,
      promptTokens: payload?.prompt_eval_count ?? promptTokenEstimate(request),
      completionTokens: payload?.eval_count,
      gen_ms: genMs,
      ttft_ms: genMs,
      result,
    });
  }
}

async function synthesizeConversationAtoms(conversation, { modelCall, model }) {
  const request = stripUndefined({
    label: 'cs-k:think:atom',
    task: 'mind.extractConversationAtoms',
    model,
    responseFormat: 'json',
    responseSchema: ATOM_RESPONSE_SCHEMA,
    temperature: 0,
    sensitivity: 'private-chat-or-bookmark',
    system: ATOM_SYSTEM_PROMPT,
    user: JSON.stringify({
      conversation: conversationModelPayload(conversation),
    }),
  });
  const raw = await modelCall(request);
  return normalizeConversationAtomResponse(parseModelValue(raw), conversation);
}

function normalizeConversationAtomResponse(parsed, conversation) {
  const rawAtoms = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.atoms)
      ? parsed.atoms
      : Array.isArray(parsed?.ideaAtoms)
        ? parsed.ideaAtoms
        : hasAtomStatement(parsed)
          ? [parsed]
          : [];
  const atoms = [];

  for (const rawAtom of rawAtoms) {
    if (!rawAtom || typeof rawAtom !== 'object' || Array.isArray(rawAtom)) continue;
    const statement = optionalString(rawAtom.statement ?? rawAtom.idea ?? rawAtom.atom);
    if (!statement) continue;
    const type = normalizeAtomType(rawAtom.type);
    const evidenceIds = atomEvidenceIds(rawAtom, conversation);
    if (evidenceIds.length === 0) continue;

    atoms.push({
      conversation,
      conversationId: conversation.conversationId,
      label: boundLabel(optionalString(rawAtom.label ?? rawAtom.title) ?? statement),
      statement,
      type,
      confidence: clampConfidence(rawAtom.confidence ?? 0.55),
      evidenceIds,
      generatedBy: 'local-model',
    });
  }

  return atoms;
}

function hasAtomStatement(value) {
  return Boolean(value) &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    optionalString(value.statement ?? value.idea ?? value.atom);
}

function normalizeAtomType(value) {
  const normalized = optionalString(value)?.toLowerCase().replace(/_/g, '-').replace(/\s+/g, '-');
  switch (normalized) {
    case 'intent':
    case 'decision':
    case 'question':
    case 'idea':
    case 'open-loop':
      return normalized;
    default:
      return 'idea';
  }
}

function atomEvidenceIds(rawAtom, conversation) {
  const messageIds = new Set(conversation.messages.map((message) => message.id));
  const requested = [
    ...arrayValues(rawAtom.evidenceIds),
    ...arrayValues(rawAtom.evidence),
    ...arrayValues(rawAtom.sourceExposureIds),
    ...arrayValues(rawAtom.sourceMessageIds),
    ...arrayValues(rawAtom.messageIds),
    rawAtom.evidenceId,
    rawAtom.sourceExposureId,
    rawAtom.sourceMessageId,
    rawAtom.messageId,
  ]
    .map((value) => optionalString(value))
    .filter(Boolean)
    .filter((id) => messageIds.has(id));

  return Array.from(new Set(requested));
}

export function arrayValues(value) {
  return Array.isArray(value) ? value : [];
}

async function writeIdeaAtom(input, { dataDir, now }) {
  const record = ideaAtomRecord(input, now);
  const file = safeDataPath(dataDir, path.join(IDEA_ATOM_DIR, `${record.id}.json`));
  await fs.mkdir(path.dirname(file), { recursive: true });

  try {
    await fs.writeFile(file, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    return {
      record,
      mutations: [ideaAtomMutation(record, 'write')],
    };
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = JSON.parse(await fs.readFile(file, 'utf8'));
    if (existing.supersededById) {
      const replacement = await readIdeaAtom(dataDir, existing.supersededById);
      return {
        record: replacement ?? existing,
        mutations: [ideaAtomMutation(replacement ?? existing, 'deduped')],
      };
    }
    if (shouldUpgradeIdeaAtom(existing, record)) {
      return supersedeIdeaAtom(existing, record, { dataDir, now });
    }
    return {
      record: existing,
      mutations: [ideaAtomMutation(existing, 'deduped')],
    };
  }
}

function groupExtractedAtomsByConversationId(extractedAtoms) {
  const groups = new Map();
  for (const atom of extractedAtoms) {
    const conversationId = optionalString(atom.conversationId);
    if (!conversationId) continue;
    const group = groups.get(conversationId) ?? [];
    group.push(atom);
    groups.set(conversationId, group);
  }
  return groups;
}

async function supersedeStaleConversationAtoms(conversationId, refreshedAtoms, { dataDir, now }) {
  if (refreshedAtoms.length === 0) return [];

  const refreshedIds = new Set(refreshedAtoms.map((atom) => atom.id));
  const refreshedContentHashes = new Set(refreshedAtoms.map((atom) => atom.contentHash));
  const liveAtoms = await readLiveIdeaAtomsForConversation(dataDir, conversationId);
  const staleAtoms = liveAtoms.filter((atom) =>
    !refreshedIds.has(atom.id) &&
    !refreshedContentHashes.has(atom.contentHash));
  const mutations = [];

  for (const staleAtom of staleAtoms) {
    const successor = successorIdeaAtom(staleAtom, refreshedAtoms);
    if (!successor) continue;
    mutations.push(...await retireIdeaAtom(staleAtom, successor, { dataDir, now }));
  }

  return mutations;
}

function successorIdeaAtom(staleAtom, refreshedAtoms) {
  return refreshedAtoms.find((atom) => atom.type === staleAtom.type) ?? refreshedAtoms[0];
}

async function readLiveIdeaAtomsForConversation(dataDir, conversationId) {
  const records = await readIdeaAtomRecords(dataDir);

  return records.filter((record) =>
    record?.kind === 'IdeaAtom' &&
    record.conversationId === conversationId &&
    ideaAtomGeneratedBy(record) !== 'mind-output' &&
    !record.validTo &&
    !record.supersededById);
}

async function readIdeaAtomRecords(dataDir) {
  const dir = safeDataPath(dataDir, IDEA_ATOM_DIR);
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const records = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => fs.readFile(path.join(dir, entry.name), 'utf8').then(JSON.parse)));

  return records;
}

async function retireIdeaAtom(existing, successor, { dataDir, now }) {
  const retired = {
    ...existing,
    validTo: iso(now),
    supersededById: requiredString(successor.id, 'successor.id'),
  };
  const existingFile = safeDataPath(dataDir, path.join(IDEA_ATOM_DIR, `${existing.id}.json`));
  await fs.writeFile(existingFile, `${JSON.stringify(retired, null, 2)}\n`, 'utf8');
  return [ideaAtomMutation(retired, 'superseded')];
}

function ideaAtomRecord(input, now) {
  const conversation = input.conversation;
  const conversationId = requiredString(input.conversationId ?? conversation?.conversationId, 'conversationId');
  const statement = requiredString(input.statement, 'ideaAtom.statement');
  const type = normalizeAtomType(input.type);
  const contentHash = ideaAtomContentHash({ statement, type });
  const dedupeKey = ideaAtomDedupeKey(conversationId, contentHash);
  const evidenceIds = normalizeEvidenceIds(input.evidenceIds, conversation);
  const eventAt = ideaAtomEventAt(evidenceIds, conversation);
  const createdAt = iso(now);
  const firstEvidenceId = evidenceIds[0];

  return stripUndefined({
    id: `idea_${sha256(dedupeKey).slice(0, 24)}`,
    kind: 'IdeaAtom',
    schemaVersion: IDEA_ATOM_SCHEMA_VERSION,
    dedupeKey,
    contentHash,
    validFrom: eventAt,
    validTo: null,
    eventAt,
    ingestedAt: createdAt,
    supersededById: null,
    label: requiredString(input.label, 'ideaAtom.label'),
    statement,
    type,
    confidence: clampConfidence(input.confidence),
    lifecycle: 'inbox',
    status: 'candidate',
    conversationId,
    sourceExposureId: firstEvidenceId,
    sourceExposureIds: evidenceIds,
    evidenceIds,
    frontierExcluded: true,
    provenance: {
      surface: 'mind',
      lane: 'deliberate',
    },
    source: {
      kind: 'Conversation',
      conversationId,
      exposureIds: evidenceIds,
      surfaces: conversation?.surfaces,
    },
    extraction: {
      generatedBy: optionalString(input.generatedBy) ?? 'extractive',
    },
    context: optionalString(conversation?.context),
  });
}

function shouldRunAtomClustering(atomDocs, opts) {
  if (typeof opts.clusterer === 'function') return true;
  return atomDocs.length >= positiveInteger(
    opts.clusterMinAtoms ?? opts.clusterParams?.minClusterSize,
    DEFAULT_CLUSTER_MIN_ATOMS,
  );
}

async function runAtomClusterer(atomDocs, { opts, now, notes, logger }) {
  const clusterer = opts.clusterer ?? runMindClusterSidecar;
  try {
    return await clusterer(atomDocs, {
      params: {
        ...(opts.clusterParams ?? {}),
        now: iso(now),
      },
      timeoutMs: opts.clusterTimeoutMs,
      pythonBin: opts.clusterPythonBin,
      scriptPath: opts.clusterScriptPath,
      logger,
      note: (message) => logNote(notes, logger, message),
    });
  } catch (error) {
    logNote(notes, logger, `mind clustering sidecar unavailable; semantic outputs silenced (${error.message})`);
    return null;
  }
}

function sidecarLeafClusters(clusterResult, atomDocs, opts = {}) {
  const docsById = new Map(atomDocs.map((doc) => [doc.id, doc]));
  const minConversations = positiveInteger(
    opts.clusterMinConversations ?? process.env.K_MIND_CLUSTER_MIN_CONVERSATIONS,
    DEFAULT_CLUSTER_MIN_CONVERSATIONS,
  );
  return (clusterResult?.leafClusters ?? [])
    .map((leaf) => {
      const clusterDocs = stringArray(leaf.atomIds)
        .map((id) => docsById.get(id))
        .filter(Boolean);
      const atoms = clusterDocs.map((doc) => doc.atom);
      const exposureIds = Array.from(new Set(
        atoms.flatMap((atom) => Array.isArray(atom.evidenceIds) ? atom.evidenceIds : []),
      )).sort();
      const conversationIds = conversationIdsForAtoms(atoms);
      const theme = sidecarLabel(leaf, clusterDocs);
      return Object.freeze({
        clusterId: requiredString(leaf.clusterId, 'leafCluster.clusterId'),
        theme,
        exposureIds,
        conversationIds,
        atomIds: clusterDocs.map((doc) => doc.id).sort(),
        atoms,
        representativeAtomId: optionalString(leaf.representativeAtomId),
        keywords: stringArray(leaf.keywords),
        window: eventWindow(atoms),
        coherence: clusterCoherence(clusterDocs),
      });
    })
    // Drop tool-artifact clusters confined to too few distinct conversations
    // before they reach candidates, resurfaced, or bridges.
    .filter((cluster) => cluster.atoms.length > 0 &&
      cluster.conversationIds.length >= minConversations)
    .sort((a, b) =>
      b.atoms.length - a.atoms.length ||
      b.coherence - a.coherence ||
      a.clusterId.localeCompare(b.clusterId));
}

function nonNoiseAtomDocs(atomDocs, clusterResult) {
  const noise = new Set(stringArray(clusterResult?.noiseAtomIds));
  return atomDocs.filter((doc) => !noise.has(doc.id));
}

function sidecarLabel(clusterLike, docs) {
  const representativeId = optionalString(clusterLike?.representativeAtomId);
  const representative = representativeId
    ? docs.find((doc) => doc.id === representativeId)?.atom
    : undefined;
  // Preserve the sidecar's descending c-TF-IDF rank — stringArray() alphabetizes,
  // which would discard the ranking and pick 5 arbitrary terms. A distilled
  // keyword label is preferred over any raw representative statement.
  const keywords = orderedStringList(clusterLike?.keywords);
  const keywordLabel = keywords.length > 0 ? keywords.slice(0, 5).join(' ') : undefined;
  return boundLabel(firstPresentString(
    clusterLike?.label,
    keywordLabel,
    representative?.label,
    representative?.statement,
    ...docs.map((doc) => doc.atom?.label),
    ...docs.map((doc) => doc.atom?.statement),
  ) ?? 'Recurring idea theme');
}

function boundedAtomPayload(docs) {
  return docs.slice(0, 12).map((doc) => {
    const atom = doc.atom ?? doc;
    return stripUndefined({
      id: requiredString(doc.id ?? atom.id, 'atom.id'),
      label: boundLabel(atom.label ?? atom.statement),
      type: optionalString(atom.type),
      statement: truncateForModel(atom.statement, 240),
      eventAt: optionalString(doc.eventAt ?? atom.eventAt ?? atom.validFrom),
      conversationId: optionalString(atom.conversationId),
    });
  });
}

function boundedGeneratedLine(value, docs) {
  const text = optionalString(value);
  if (!text) return undefined;
  const line = stripLabelScaffolding(text).slice(0, 180).trim();
  if (!line || echoesAtomStatement(line, docs)) return undefined;
  return line;
}

function echoesAtomStatement(line, docs) {
  const normalizedLine = normalizeComparableText(line);
  if (!normalizedLine) return false;
  return docs.some((doc) => {
    const statement = normalizeComparableText((doc.atom ?? doc)?.statement);
    return statement.length >= 40 && normalizedLine.includes(statement);
  });
}

function truncateForModel(value, maxChars) {
  const text = optionalString(value);
  if (!text) return undefined;
  return text.replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

function normalizeComparableText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function candidateForCluster(cluster, opts = {}) {
  const action = actionForCluster(cluster);
  const topic = concreteTopicForCluster(cluster);
  const minAtoms = positiveInteger(opts.minClusterAtoms, DEFAULT_MIN_CLUSTER_ATOMS);
  const target = boundLabel(`${action} ${topic}.`);
  const nextAction = governNextAction({
    target,
    risk: 'consequential',
    reversibilityClass: 'external-cancelable',
    authority: 'human',
  });

  const output = {
    summary: `Mind cluster "${topic}" surfaced ${cluster.atoms.length} idea-atoms.`,
    verdict: 'recommend',
    recommendation: {
      decision: topic,
      recommended: target,
      reason: `The cluster connects ${cluster.atoms.length} idea-atoms from ${cluster.exposureIds.length} substrate exposures.`,
      risk: 'consequential',
      reversibility: 'external-cancelable',
      undo: 'Do not execute it; leave the staged recommendation pending or archive it after review.',
      evidenceIds: cluster.exposureIds,
      confidence: Math.max(0.35, Math.min(0.85, cluster.coherence || 0.35)),
      frontierExcluded: true,
      source: 'mind',
      clusterId: cluster.clusterId,
      theme: cluster.theme,
      atomIds: cluster.atomIds,
      conversationIds: cluster.conversationIds,
      provenance: {
        surface: 'mind',
        lane: 'deliberate',
      },
    },
  };
  refuseAutoAction(output);
  if (nextAction.tag === '[auto]') {
    throw new Error('mind recommendations may not auto-act');
  }

  const cardEligible = cluster.atoms.length >= minAtoms &&
    isGovernedNextAction(nextAction) &&
    actionableTarget(nextAction.target) &&
    concreteTopic(topic);
  const decisionCard = cardEligible
    ? await resolveDecisionCardForCluster(cluster, { topic, target, nextAction, opts })
    : null;

  if (decisionCard) output.decisionCard = decisionCard;

  return {
    kind: 'MindCandidate',
    advisoryOnly: true,
    frontierExcluded: true,
    provenance: {
      surface: 'mind',
      lane: 'deliberate',
    },
    clusterId: cluster.clusterId,
    theme: cluster.theme,
    atomIds: cluster.atomIds,
    evidenceIds: cluster.exposureIds,
    conversationIds: cluster.conversationIds,
    criterion: {
      governed: nextAction.tag === '[gate:human]' || nextAction.tag === '[advise]',
      actionable: actionableTarget(target) && concreteTopic(topic),
      minAtoms,
    },
    nextAction,
    ...(decisionCard ? { decisionCard } : {}),
    output,
    mutations: [],
  };
}

// U4 — pick the decision-card path for a cluster: escalate uncertain
// (low-coherence) clusters to the deliberation loop when opted in and under
// budget, else the single-call synthesis. A failed/declined deliberation falls
// back to the single call, so the card contract is never weakened.
async function resolveDecisionCardForCluster(cluster, { topic, target, nextAction, opts }) {
  const budget = opts.deliberationBudget;
  const threshold = Number.isFinite(opts.deliberationCoherenceThreshold)
    ? opts.deliberationCoherenceThreshold
    : DEFAULT_DELIBERATION_COHERENCE_THRESHOLD;
  const eligibleForDeliberation =
    opts.deliberateLowConfidence === true &&
    typeof opts.singleCall === 'function' &&
    (Number(cluster.coherence) || 0) < threshold &&
    budget && budget.used < budget.max;

  if (eligibleForDeliberation) {
    const deliberated = await deliberatedDecisionCardForCluster(cluster, { topic, target, nextAction, opts });
    if (deliberated) {
      budget.used += 1;
      return deliberated;
    }
  }

  return synthesizeDecisionCardForCluster(cluster, {
    topic,
    target,
    nextAction,
    modelCall: opts.modelCall,
    model: opts.model,
    notes: opts.notes,
    logger: opts.logger,
    decisionCardTimeoutMs: opts.decisionCardTimeoutMs,
  });
}

// Run the Board debate ⟷ ARGUS deliberation loop for one cluster and map its
// (debated, evidence-researched) decision card onto the mind's 8-field card.
// runDeliberation is injectable (opts.runDeliberation) for tests. persist:false
// — the mind loop already commits the decide-station output; this must not
// double-write. Returns null on any decline/failure so the caller falls back.
async function deliberatedDecisionCardForCluster(cluster, { topic, target, nextAction, opts }) {
  const deliberate = typeof opts.runDeliberation === 'function' ? opts.runDeliberation : runDeliberation;
  try {
    const question =
      `Should the founder ${optionalString(target) ?? optionalString(nextAction?.target) ?? topic}? ` +
      `(mind cluster "${topic}", ${cluster.atoms.length} idea-atoms from ${cluster.exposureIds.length} exposures)`;
    const result = await deliberate({
      question,
      singleCall: opts.singleCall,
      dataDir: opts.dataDir,
      opts: {
        now: opts.now,
        store: opts.store,
        timeoutMs: opts.deliberationTimeoutMs,
        persist: false,
      },
    });
    if (result?.mode !== 'deliberated' || !result.decisionCard) return null;
    return mapDeliberationCardToMindCard(result.decisionCard);
  } catch (error) {
    logNote(opts.notes, opts.logger, `mind deliberation escalation skipped: ${error.message}`);
    return null;
  }
}

// The deliberation card carries the identical 8 fields; `missing` may arrive as
// an array. Require all eight (same contract as the single-call card) and bound
// each field so the projection stays within wire limits.
function mapDeliberationCardToMindCard(card) {
  const out = {};
  for (const field of DECISION_CARD_FIELDS) {
    const raw = card?.[field];
    const text = Array.isArray(raw)
      ? raw.map((item) => optionalString(item)).filter(Boolean).join('; ')
      : optionalString(raw);
    if (!text) return null;
    out[field] = boundDeliberatedField(text);
  }
  return Object.freeze(out);
}

function boundDeliberatedField(value, maxChars = DELIBERATED_CARD_FIELD_MAX_CHARS) {
  const text = optionalString(String(value ?? '').replace(/\s+/g, ' '));
  if (!text) return undefined;
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

async function synthesizeDecisionCardForCluster(cluster, {
  topic,
  target,
  nextAction,
  modelCall,
  model,
  notes,
  logger,
  decisionCardTimeoutMs,
}) {
  if (typeof modelCall !== 'function') return null;
  const evidenceDocs = cluster.atoms.map((atom) => ({ id: atom.id, atom }));

  try {
    const timeoutMs = positiveInteger(
      decisionCardTimeoutMs ?? process.env.K_MIND_DECISION_CARD_TIMEOUT_MS,
      DEFAULT_DECISION_CARD_TIMEOUT_MS,
    );
    const raw = await withOperationTimeout(() => modelCall(stripUndefined({
      label: 'cs-k:think:decision-card',
      task: 'mind.decisionCard',
      model,
      responseFormat: 'json',
      responseSchema: DECISION_CARD_RESPONSE_SCHEMA,
      temperature: 0,
      maxTokens: 4096,
      sensitivity: 'private-chat-or-bookmark',
      system: DECISION_CARD_SYSTEM_PROMPT,
      user: JSON.stringify({
        clusterId: cluster.clusterId,
        theme: cluster.theme,
        topic,
        candidate: {
          decision: topic,
          recommended: target,
          nextAction: nextAction.target,
          tag: nextAction.tag,
        },
        atomCount: cluster.atoms.length,
        evidenceIds: cluster.exposureIds,
        conversationIds: cluster.conversationIds,
        atoms: boundedAtomPayload(evidenceDocs),
      }),
    })), timeoutMs, 'mind decision card synthesis');
    const parsed = parseModelObject(raw);
    refuseAutoAction(parsed);
    return normalizeDecisionCardSynthesis(parsed, evidenceDocs);
  } catch (error) {
    logNote(notes, logger, `mind decision card skipped: ${error.message}`);
    return null;
  }
}

function normalizeDecisionCardSynthesis(parsed, evidenceDocs) {
  const card = {};

  for (const field of DECISION_CARD_FIELDS) {
    const sentence = boundedDecisionCardSentence(parsed?.[field], evidenceDocs);
    if (!sentence) return null;
    card[field] = sentence;
  }

  return Object.freeze(card);
}

function boundedDecisionCardSentence(value, docs) {
  const text = optionalString(value);
  if (!text) return undefined;
  const firstSentence = firstCompleteSentence(stripLabelScaffolding(text).replace(/\s+/g, ' ').trim());
  if (!firstSentence || echoesAtomStatement(firstSentence, docs)) return undefined;
  return ensureSentenceTerminator(boundToWordBoundary(firstSentence, MAX_DECISION_CARD_FIELD_CHARS));
}

function firstCompleteSentence(value) {
  const text = optionalString(value);
  if (!text) return undefined;
  const match = text.match(/^.+?[.!?](?:\s|$)/);
  return (match ? match[0] : text).trim();
}

function ensureSentenceTerminator(value) {
  const text = optionalString(value);
  if (!text) return undefined;
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function boundToWordBoundary(value, maxChars) {
  const clean = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length <= maxChars) return clean;
  const cut = clean.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trim();
}

async function synthesizeParentThemes(clusterResult, atomDocs, {
  modelCall,
  model,
  opts,
  notes,
  logger,
}) {
  const minAtoms = positiveInteger(opts.themeMinAtoms, DEFAULT_THEME_MIN_ATOMS);
  const minConversations = positiveInteger(opts.themeMinConversations, DEFAULT_THEME_MIN_CONVERSATIONS);
  const closureThreshold = boundedNumber(
    opts.openLoopClosureThreshold,
    DEFAULT_OPEN_LOOP_CLOSURE_THRESHOLD,
  );
  const docsById = new Map(atomDocs.map((doc) => [doc.id, doc]));
  const outputs = [];

  for (const parent of clusterResult.parentThemes ?? []) {
    const themeDocs = stringArray(parent.atomIds)
      .map((id) => docsById.get(id))
      .filter(Boolean);
    const atoms = themeDocs.map((doc) => doc.atom);
    const conversationIds = conversationIdsForAtoms(atoms);
    if (themeDocs.length < minAtoms || conversationIds.length < minConversations) continue;

    const summary = await themeSummary(parent, themeDocs, {
      modelCall,
      model,
      notes,
      logger,
    });
    if (!summary) continue;
    const openAtomIds = openThemeMemberAtomIds(themeDocs, closureThreshold);

    outputs.push(Object.freeze({
      kind: 'MindTheme',
      outputType: MIND_OUTPUT_GROUPS[1],
      frontierExcluded: true,
      themeId: optionalString(parent.themeId) ??
        `theme_${sha256(themeDocs.map((doc) => doc.id).sort().join('\n')).slice(0, 16)}`,
      label: boundLabel(summary.summary),
      summary: summary.summary,
      observation: summary.observation,
      considerations: summary.considerations,
      type: 'theme',
      confidence: outputConfidence(atoms, clusterCoherence(themeDocs)),
      atomIds: themeDocs.map((doc) => doc.id).sort(),
      openLoop: openAtomIds.length > 0 ? true : undefined,
      openAtomIds: openAtomIds.length > 0 ? openAtomIds : undefined,
      conversationIds,
      criteria: {
        minAtoms,
        minConversations,
        atomCount: themeDocs.length,
        conversationCount: conversationIds.length,
        source: 'umap-hdbscan-sidecar',
        leafClusterIds: stringArray(parent.leafClusterIds),
        keywords: stringArray(parent.keywords),
      },
      window: eventWindow(atoms),
    }));
  }

  return Object.freeze(outputs);
}

function openThemeMemberAtomIds(themeDocs, closureThreshold) {
  const sortedDocs = [...themeDocs].sort(compareAtomDocs);
  return sortedDocs
    .filter((doc) => isOpenLoopCandidate(doc.atom))
    .filter((doc) => !sortedDocs.some((laterDoc) =>
      closesOpenLoop(doc, laterDoc, closureThreshold)))
    .map((doc) => doc.id)
    .sort();
}

async function themeSummary(parent, themeDocs, {
  modelCall,
  model,
  notes,
  logger,
}) {
  const fallback = sidecarLabel(parent, themeDocs);

  try {
    const raw = await modelCall(stripUndefined({
      label: 'cs-k:think:theme-summary',
      task: 'mind.themeSummary',
      model,
      responseFormat: 'json',
      sensitivity: 'private-chat-or-bookmark',
      system: THEME_SUMMARY_SYSTEM_PROMPT,
      user: JSON.stringify({
        themeId: optionalString(parent.themeId),
        leafClusterIds: stringArray(parent.leafClusterIds),
        keywords: stringArray(parent.keywords),
        atoms: boundedAtomPayload(themeDocs),
      }),
    }));
    const parsed = parseModelObject(raw);
    refuseAutoAction(parsed);
    const summary = boundedGeneratedLine(parsed.summary ?? parsed.label ?? parsed.theme, themeDocs);
    const synthesizedSummary = summary ?? fallback;
    const observation = boundedGeneratedLine(parsed.observation ?? parsed.insight, themeDocs) ??
      synthesizedSummary;
    return Object.freeze({
      summary: synthesizedSummary,
      observation,
      considerations: boundedConsiderations(parsed.considerations, themeDocs),
    });
  } catch (error) {
    logNote(notes, logger, `theme summary skipped: ${error.message}`);
    return null;
  }
}

function boundedConsiderations(value, docs) {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(value
    .map((entry) => boundedGeneratedLine(considerationText(entry), docs))
    .filter(Boolean)
    .slice(0, MAX_THEME_CONSIDERATIONS));
}

function considerationText(entry) {
  if (typeof entry === 'string') return entry;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
  return firstPresentString(
    entry.consideration,
    entry.point,
    entry.label,
    entry.summary,
    entry.text,
  );
}

function sidecarResurfacedIdeas(clusterResult, atomDocs, opts) {
  const docsById = new Map(atomDocs.map((doc) => [doc.id, doc]));
  const clusterById = new Map(sidecarLeafClusters(clusterResult, atomDocs, opts).map((cluster) => [cluster.clusterId, cluster]));
  const quietGapDays = positiveInteger(
    opts.clusterResurfaceGapDays ?? opts.clusterParams?.resurfacedGapDays,
    DEFAULT_CLUSTER_RESURFACE_GAP_DAYS,
  );
  const recentDays = positiveInteger(
    opts.clusterResurfaceRecentDays ?? opts.clusterParams?.resurfacedRecentDays,
    DEFAULT_CLUSTER_RESURFACE_RECENT_DAYS,
  );

  return (clusterResult.resurfaced ?? [])
    .map((entry) => {
      const clusterId = optionalString(entry.clusterId);
      const cluster = clusterId ? clusterById.get(clusterId) : null;
      if (!cluster) return null;
      const docs = cluster.atomIds.map((id) => docsById.get(id)).filter(Boolean);
      const atoms = docs.map((doc) => doc.atom);
      return Object.freeze({
        kind: 'MindResurfacedIdea',
        outputType: MIND_OUTPUT_GROUPS[2],
        frontierExcluded: true,
        resurfacedId: `resurfaced_${sha256([...cluster.atomIds].sort().join('\n')).slice(0, 16)}`,
        label: cluster.theme,
        type: 'resurfaced',
        confidence: outputConfidence(atoms, cluster.coherence),
        atomIds: cluster.atomIds,
        conversationIds: conversationIdsForAtoms(atoms),
        criteria: {
          quietGapDays,
          observedQuietGapDays: Math.floor(Number(entry.gapDays) || 0),
          recentDays,
          source: 'umap-hdbscan-sidecar',
          resurfacedAt: requiredString(entry.resurfacedAt, 'resurfaced.resurfacedAt'),
          previousActiveAt: requiredString(entry.previousActiveAt, 'resurfaced.previousActiveAt'),
        },
      });
    })
    .filter(Boolean);
}

async function synthesizeBridgeIdeas(clusterResult, atomDocs, {
  modelCall,
  model,
  opts,
  notes,
  logger,
}) {
  const docsById = new Map(atomDocs.map((doc) => [doc.id, doc]));
  const clustersById = new Map(sidecarLeafClusters(clusterResult, atomDocs, opts).map((cluster) => [cluster.clusterId, cluster]));
  const limit = positiveInteger(opts.newIdeaLimit, 1);
  const outputs = [];

  for (const bridge of clusterResult.newIdeaBridges ?? []) {
    if (outputs.length >= limit) break;
    const bridgeDoc = docsById.get(optionalString(bridge.atomId));
    const [leftId, rightId] = stringArray(bridge.connectsClusterIds);
    const left = clustersById.get(leftId);
    const right = clustersById.get(rightId);
    if (!bridgeDoc || !left || !right) continue;

    const idea = await synthesizeBridgeIdea(bridge, bridgeDoc, [left, right], {
      modelCall,
      model,
      notes,
      logger,
    });
    if (idea) outputs.push(idea);
  }

  return Object.freeze(outputs);
}

async function synthesizeBridgeIdea(bridge, bridgeDoc, clusters, {
  modelCall,
  model,
  notes,
  logger,
}) {
  const evidenceDocs = [
    bridgeDoc,
    ...clusters.flatMap((cluster) => cluster.atomIds).map((id) => ({ id })),
  ];

  try {
    const raw = await modelCall(stripUndefined({
      label: 'cs-k:think:divergent',
      task: 'mind.divergentIdea',
      model,
      responseFormat: 'json',
      sensitivity: 'private-chat-or-bookmark',
      system: DIVERGENT_SYSTEM_PROMPT,
      user: JSON.stringify({
        bridgeAtom: boundedAtomPayload([bridgeDoc])[0],
        connectsClusterIds: stringArray(bridge.connectsClusterIds),
        clusters: clusters.map((cluster) => ({
          clusterId: cluster.clusterId,
          keywords: stringArray(cluster.keywords),
          theme: cluster.theme,
          atoms: boundedAtomPayload(cluster.atoms.map((atom) => ({
            id: atom.id,
            atom,
            eventAt: atom.eventAt,
          })).slice(0, 6)),
        })),
      }),
    }));
    const parsed = parseModelObject(raw);
    refuseAutoAction(parsed);
    const statement = boundedGeneratedLine(parsed.statement ?? parsed.idea, [bridgeDoc]);
    if (!statement) return null;

    const nextAction = governNextAction({
      target: `Review divergent idea: ${statement}`,
      risk: 'low-stakes',
      reversibilityClass: 'internal-revertible',
      authority: 'human',
    });
    if (nextAction.tag === '[auto]') {
      throw new Error('divergent ideas may not auto-act');
    }

    return Object.freeze({
      kind: 'DivergentIdea',
      advisoryOnly: true,
      frontierExcluded: true,
      provenance: {
        surface: 'mind',
        lane: 'deliberate',
      },
      statement,
      rationale: boundedGeneratedLine(parsed.rationale ?? parsed.reason, [bridgeDoc]),
      confidence: clampConfidence(parsed.confidence ?? 0.45),
      source: 'umap-hdbscan-bridge',
      noveltySatisfied: true,
      connectsPreviouslyUnconnectedThreads: true,
      bridgeAtomId: bridgeDoc.id,
      sourceThreadIds: stringArray(bridge.connectsClusterIds),
      connectedAtomIds: Array.from(new Set(
        [bridgeDoc.id, ...clusters.flatMap((cluster) => cluster.atomIds)],
      )).sort(),
      connectedConversationIds: conversationIdsForAtoms([
        bridgeDoc.atom,
        ...clusters.flatMap((cluster) => cluster.atoms),
      ]),
      evidenceIds: Array.from(new Set(
        [bridgeDoc.atom, ...clusters.flatMap((cluster) => cluster.atoms)]
          .flatMap((atom) => Array.isArray(atom.evidenceIds) ? atom.evidenceIds : []),
      )).sort(),
      criterion: {
        connectedThreadCount: stringArray(bridge.connectsClusterIds).length,
        connectedAtomCount: evidenceDocs.length,
        betweenness: Number(bridge.betweenness) || 0,
        source: 'umap-hdbscan-sidecar',
      },
      nextAction,
    });
  } catch (error) {
    logNote(notes, logger, `divergent idea skipped: ${error.message}`);
    return null;
  }
}

async function embeddedIdeaAtomDocs(atoms, embeddingOpts) {
  const results = await Promise.allSettled(atoms.map(async (atom) => {
    const embedding = await embed(atomTextContent(atom), embeddingOpts);
    if (!Array.isArray(embedding) || embedding.length === 0) return null;
    return {
      id: atom.id,
      atom,
      embedding,
      eventAt: requiredString(atom.eventAt ?? atom.validFrom, 'IdeaAtom.eventAt'),
    };
  }));

  return results
    .filter((result) => result.status === 'fulfilled')
    .map((result) => result.value)
    .filter(Boolean);
}

async function persistMindOutputs({
  themesOpenLoops,
  resurfacedIdeas,
  divergentIdeas,
  atomDocs,
  dataDir,
  now,
}) {
  const docsById = new Map(atomDocs.map((doc) => [doc.id, doc]));
  const contradictionRegister = createContradictionRegister({ dataDir, now });
  const outputRecords = [
    ...themesOpenLoops.map((output) =>
      mindOutputRecord(output, MIND_OUTPUT_GROUPS[1], docsById, now)),
    ...resurfacedIdeas.map((output) =>
      mindOutputRecord(output, MIND_OUTPUT_GROUPS[2], docsById, now)),
    ...divergentIdeas.map((output) =>
      mindOutputRecord(output, MIND_OUTPUT_GROUPS[3], docsById, now)),
  ].filter(Boolean);
  const liveRecords = (await readMindOutputRecords(dataDir)).filter(isLiveMindOutputRecord);
  const mutations = [];
  const currentRecords = [];

  for (const candidate of outputRecords) {
    const liveMatches = liveRecords.filter((record) =>
      record.outputGroup === candidate.outputGroup &&
      record.outputKey === candidate.outputKey);
    const record = await writeMindOutputRecord(candidate, { dataDir });
    mutations.push(mindOutputMutation(record, 'write'));

    currentRecords.push(record);

    for (const existing of liveMatches.filter((entry) => entry.outputId !== record.outputId)) {
      mutations.push(...await retireMindOutput(existing, record, {
        dataDir,
        now,
        contradictionRegister,
      }));
    }
  }

  const currentIds = new Set(currentRecords.map((record) => record.outputId));
  const currentKeys = new Set(outputRecords.map((record) =>
    mindOutputRunKey(record.outputGroup, record.outputKey)));
  const defaultSuccessor = currentRecords[0];
  if (defaultSuccessor) {
    for (const stale of liveRecords) {
      if (currentIds.has(stale.outputId)) continue;
      if (currentKeys.has(mindOutputRunKey(stale.outputGroup, stale.outputKey))) continue;
      mutations.push(...await retireMindOutput(stale, defaultSuccessor, {
        dataDir,
        now,
        contradictionRegister,
      }));
    }
  }

  return mutations;
}

function mindOutputRecord(output, outputGroup, docsById, now) {
  const atomIds = mindOutputAtomIds(output);
  if (atomIds.length === 0) return null;

  const outputKey = mindOutputStableKey(output, outputGroup, atomIds);
  const type = mindOutputType(output, outputGroup);
  const label = mindOutputLabel(output, outputGroup, docsById);
  const eventAt = mindOutputEventAt(output, atomIds, docsById, now);
  const conversationIds = mindOutputConversationIds(output, atomIds, docsById);
  const evidenceDocs = atomIds.map((id) => docsById.get(id)).filter(Boolean);
  const observation = mindOutputObservation(output, outputGroup, evidenceDocs);
  const considerations = boundedConsiderations(output.considerations, evidenceDocs);
  const openAtomIds = stringArray(output.openAtomIds);
  const confidence = finiteOutputConfidence(output.confidence);
  const glaze = surfacedMindGlaze([
    label,
    observation,
    ...considerations,
    output.summary,
    output.statement,
    output.rationale,
  ]);
  const contentHash = mindOutputContentHash({
    outputGroup,
    type,
    label,
    atomIds,
    observation,
    considerations,
    openLoop: output.openLoop === true,
    openAtomIds,
    confidence,
  });
  const outputId = mindOutputId(outputGroup, outputKey, contentHash);
  const createdAt = iso(now);

  return stripUndefined({
    id: outputId,
    kind: requiredString(output.kind, 'mindOutput.kind'),
    schemaVersion: MIND_OUTPUT_SCHEMA_VERSION,
    outputId,
    outputKey,
    contentHash,
    validFrom: eventAt,
    validTo: null,
    eventAt,
    generatedAt: createdAt,
    supersededById: null,
    label,
    type,
    outputGroup,
    outputType: outputGroup,
    observation,
    considerations,
    atomIds,
    evidenceIds: mindOutputEvidenceIds(output, atomIds),
    glaze,
    openLoop: output.openLoop === true,
    openAtomIds: openAtomIds.length > 0 ? openAtomIds : undefined,
    confidence,
    conversationIds,
    frontierExcluded: true,
    provenance: {
      surface: 'mind',
      lane: 'deliberate',
    },
    source: {
      kind: 'MindOutput',
      outputGroup,
      outputKey,
      atomIds,
      conversationIds,
    },
  });
}

function mindOutputObservation(output, outputGroup, evidenceDocs) {
  return boundedGeneratedLine(firstPresentString(
    output.observation,
    outputGroup === MIND_OUTPUT_GROUPS[3] ? output.rationale : undefined,
    outputGroup === MIND_OUTPUT_GROUPS[2] ? output.label : undefined,
  ), evidenceDocs);
}

function mindOutputAtomIds(output) {
  return Array.from(new Set([
    ...arrayValues(output.atomIds),
    ...arrayValues(output.connectedAtomIds),
    ...arrayValues(output.sourceAtomIds),
    output.bridgeAtomId,
  ]
    .map((value) => optionalString(value))
    .filter(Boolean))).sort();
}

function mindOutputEvidenceIds(output, atomIds) {
  return Array.from(new Set([
    ...atomIds,
    ...arrayValues(output.evidenceIds),
  ]
    .map((value) => optionalString(value))
    .filter(Boolean))).sort();
}

function mindOutputStableKey(output, outputGroup, evidenceIds) {
  return firstPresentString(
    output.themeId,
    output.openLoopId,
    output.resurfacedId,
    output.ideaId,
    output.outputId,
    output.bridgeAtomId && `bridge_${sha256([
      output.bridgeAtomId,
      ...stringArray(output.sourceThreadIds),
    ].join('\n')).slice(0, 16)}`,
  ) ?? `${outputGroup}_${sha256(evidenceIds.join('\n')).slice(0, 16)}`;
}

function mindOutputType(output, outputGroup) {
  const type = optionalString(output.type);
  if (type) return type;
  if (outputGroup === MIND_OUTPUT_GROUPS[2]) return 'resurfaced';
  if (outputGroup === MIND_OUTPUT_GROUPS[3]) return 'idea';
  return output.kind === 'MindOpenLoop' ? 'open-loop' : 'theme';
}

function mindOutputLabel(output, outputGroup, docsById) {
  const direct = optionalString(output.label);
  if (direct) return boundLabel(direct);
  if (outputGroup === MIND_OUTPUT_GROUPS[3]) {
    return boundLabel(output.statement);
  }

  const atomIds = mindOutputAtomIds(output);
  const evidenceAtoms = atomIds
    .map((id) => docsById.get(id)?.atom)
    .filter(Boolean);
  return themeLabel(evidenceAtoms);
}

function mindOutputEventAt(output, evidenceIds, docsById, now) {
  const explicit = firstPresentString(output.window?.end, output.criteria?.resurfacedAt);
  if (explicit) return explicit;

  const eventAts = evidenceIds
    .map((id) => docsById.get(id)?.eventAt ?? docsById.get(id)?.atom?.eventAt)
    .map((value) => optionalString(value))
    .filter(Boolean)
    .sort();
  return eventAts.at(-1) ?? iso(now);
}

function mindOutputConversationIds(output, evidenceIds, docsById) {
  return Array.from(new Set([
    ...arrayValues(output.conversationIds),
    ...arrayValues(output.connectedConversationIds),
    ...evidenceIds.map((id) => docsById.get(id)?.atom?.conversationId),
  ]
    .map((value) => optionalString(value))
    .filter(Boolean))).sort();
}

function finiteOutputConfidence(value) {
  const confidence = Number(value);
  return Number.isFinite(confidence) ? clampConfidence(confidence) : undefined;
}

function surfacedMindGlaze(parts) {
  const text = (Array.isArray(parts) ? parts : [parts])
    .map((part) => optionalString(part))
    .filter(Boolean)
    .join('\n');
  if (!text) return undefined;

  const report = detectGlaze(text);
  if (report.score <= GLAZE_SURFACE_THRESHOLD) return undefined;

  return {
    score: report.score,
    hits: report.hits
      .slice(0, MAX_GLAZE_HITS)
      .map((hit) => hit.pattern),
  };
}

function mindOutputContentHash({
  outputGroup,
  type,
  label,
  atomIds,
  observation,
  considerations = [],
  openLoop,
  openAtomIds = [],
  confidence,
}) {
  return sha256([
    outputGroup,
    type,
    label,
    observation,
    openLoop ? 'open' : 'closed',
    confidence === undefined ? '' : String(confidence),
    ...considerations,
    ...openAtomIds,
    ...atomIds,
  ].join('\n')).slice(0, 24);
}

function mindOutputId(outputGroup, outputKey, contentHash) {
  return `mind_${sha256([
    outputGroup,
    requiredString(outputKey, 'mindOutput.outputKey'),
    requiredString(contentHash, 'mindOutput.contentHash'),
  ].join('\n')).slice(0, 24)}`;
}

function mindOutputRunKey(outputGroup, outputKey) {
  return `${requiredString(outputGroup, 'mindOutput.outputGroup')}::${requiredString(outputKey, 'mindOutput.outputKey')}`;
}

async function writeMindOutputRecord(candidate, { dataDir }) {
  const record = await nonCollidingMindOutputRecord(candidate, { dataDir });
  await writeUniqueDataJson(dataDir, MIND_OUTPUT_DIR, record.outputId, record);
  return record;
}

async function nonCollidingMindOutputRecord(candidate, { dataDir }) {
  let record = candidate;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const existing = await readMindOutput(dataDir, record.outputId);
    if (!existing) return record;
    const replacementId = mindOutputId(
      candidate.outputGroup,
      candidate.outputKey,
      `${candidate.contentHash}::replacement::${attempt + 1}`,
    );
    record = {
      ...candidate,
      id: replacementId,
      outputId: replacementId,
    };
  }

  throw new Error(`could not allocate mind output id for ${candidate.outputGroup}/${candidate.outputKey}`);
}

async function readMindOutput(dataDir, outputId) {
  try {
    const id = requiredString(outputId, 'mindOutput.outputId');
    const file = safeDataPath(dataDir, path.join(MIND_OUTPUT_DIR, `${id}.json`));
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function readMindOutputRecords(dataDir) {
  const dir = safeDataPath(dataDir, MIND_OUTPUT_DIR);
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  return Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => fs.readFile(path.join(dir, entry.name), 'utf8').then(JSON.parse)));
}

function isLiveMindOutputRecord(record) {
  return record &&
    MIND_OUTPUT_GROUPS.includes(record.outputGroup) &&
    record.outputGroup !== MIND_OUTPUT_GROUPS[0] &&
    !record.validTo &&
    !record.supersededById;
}

async function supersedePriorMindCandidateDecisions(currentRelPaths, { dataDir, now }) {
  const currentIds = new Set(currentRelPaths.map((relPath) => optionalString(relPath)).filter(Boolean));
  const successorId = currentRelPaths.map((relPath) => optionalString(relPath)).find(Boolean);
  if (!successorId) return [];

  const entries = await readDecisionEntries(dataDir);
  const mutations = [];

  for (const entry of entries) {
    const id = decisionRecordId(entry.data, entry.relPath);
    if (id && currentIds.has(id)) continue;
    if (currentIds.has(entry.relPath)) continue;
    if (!isLiveMindCandidateDecision(entry.data)) continue;
    mutations.push(...await retireMindCandidateDecision(entry, successorId, { dataDir, now }));
  }

  return mutations;
}

function decisionRelPathFromMutation(mutation) {
  const mutationPath = optionalString(mutation?.path);
  if (!mutationPath) return undefined;
  const dataPrefix = `data${path.sep}`;
  if (mutationPath.startsWith(dataPrefix)) return mutationPath.slice(dataPrefix.length);
  if (mutationPath.startsWith('data/')) return mutationPath.slice('data/'.length);
  return undefined;
}

function isLiveMindCandidateDecision(record) {
  if (!isPlainObject(record)) return false;
  if (optionalString(record.kind) !== 'LoopRecommendation') return false;
  if (optionalString(record.station) !== 'decide') return false;
  if (optionalString(record.acted) !== 'pending') return false;
  if (record.validTo || record.supersededById) return false;

  const marker = firstPresentString(
    record.source,
    record.surface,
    record.targetSurface,
    record.provenance?.surface,
    record.metadata?.surface,
  )?.toLowerCase();
  const summary = optionalString(record.summary)?.toLowerCase();
  const markerIsMind = Boolean(marker === 'mind' || marker?.includes('mind'));
  if (marker && !markerIsMind) return false;
  const hasClusterOrigin = Boolean(
    optionalString(record.clusterId) ||
    optionalString(record.themeId) ||
    optionalString(record.theme),
  );

  return markerIsMind ||
    hasClusterOrigin ||
    summary?.startsWith('mind cluster');
}

async function readDecisionEntries(dataDir) {
  const dir = safeDataPath(dataDir, DECISION_DIR);
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  return Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map(async (entry) => {
      const relPath = path.join(DECISION_DIR, entry.name);
      const file = safeDataPath(dataDir, relPath);
      return {
        relPath,
        data: JSON.parse(await fs.readFile(file, 'utf8')),
      };
    }));
}

async function retireMindCandidateDecision(entry, successorId, { dataDir, now }) {
  const retired = {
    ...entry.data,
    validTo: iso(now),
    supersededById: requiredString(successorId, 'successorId'),
  };
  const file = safeDataPath(dataDir, entry.relPath);
  await fs.writeFile(file, `${JSON.stringify(retired, null, 2)}\n`, 'utf8');
  return [{
    op: 'superseded',
    path: path.join('data', entry.relPath),
    kind: retired.kind,
    id: decisionRecordId(retired, entry.relPath),
    supersededById: retired.supersededById,
  }];
}

function decisionRecordId(record, relPath) {
  return firstPresentString(record?.id, record?.outputId, record?.decisionId, relPath);
}

async function retireMindOutput(existing, successor, { dataDir, now, contradictionRegister }) {
  const retired = {
    ...existing,
    validTo: iso(now),
    supersededById: requiredString(successor.outputId, 'successor.outputId'),
  };
  const existingFile = safeDataPath(dataDir, path.join(MIND_OUTPUT_DIR, `${existing.outputId}.json`));
  await fs.writeFile(existingFile, `${JSON.stringify(retired, null, 2)}\n`, 'utf8');
  await recordMindOutputViewChange(existing, successor, { contradictionRegister, now });
  return [mindOutputMutation(retired, 'superseded')];
}

async function recordMindOutputViewChange(existing, successor, { contradictionRegister, now }) {
  if (!contradictionRegister) return;
  const previous = mindOutputViewText(existing);
  const current = mindOutputViewText(successor);
  if (previous === current) return;

  await contradictionRegister.record({
    claimId: mindOutputClaimId(existing),
    previous,
    current,
    changedAt: iso(now),
    reason: mindOutputChangeReason(existing, successor),
  });
}

function mindOutputClaimId(record) {
  return [
    'mind-output',
    requiredString(record.outputGroup, 'mindOutput.outputGroup'),
    requiredString(record.outputKey, 'mindOutput.outputKey'),
  ].join(':');
}

function mindOutputViewText(record) {
  const text = [
    firstPresentString(record.label, record.type, record.kind),
    firstPresentString(record.observation, record.summary, record.reason),
    Array.isArray(record.considerations) && record.considerations.length > 0
      ? `considerations: ${record.considerations.join('; ')}`
      : undefined,
  ]
    .map((part) => optionalString(part))
    .filter(Boolean)
    .join(' | ');
  return boundToWordBoundary(text || requiredString(record.outputId, 'mindOutput.outputId'), 600);
}

function mindOutputChangeReason(existing, successor) {
  const sameThread = existing.outputKey === successor.outputKey &&
    existing.outputGroup === successor.outputGroup;
  const reason = sameThread
    ? 'A newer mind synthesis replaced the prior view on the same output thread; K must explain the change before treating the successor as settled.'
    : 'The current mind synthesis no longer retained the prior live view; K must explain why the successor displaced it before acting on the new view.';
  return `${reason} previous=${existing.outputId}; successor=${successor.outputId}.`;
}

function mindOutputMutation(record, op) {
  return {
    op,
    path: path.join('data', MIND_OUTPUT_DIR, `${record.outputId}.json`),
    kind: record.kind,
    id: record.outputId,
    outputGroup: record.outputGroup,
    outputGroups: [record.outputGroup],
  };
}

function mindOutputProjectionContext({ atomDocs, clusters }) {
  const docsById = new Map(atomDocs.map((doc) => [doc.id, doc]));
  const clustersById = new Map(clusters.map((cluster) => [cluster.clusterId, cluster]));

  return { docsById, clustersById };
}

function mindNamingOptions(opts, { dataDir, now, notes, logger }) {
  const injectedNameModel = typeof opts.nameModelCall === 'function'
    ? opts.nameModelCall
    : opts.modelCall
      ? null
      : undefined;

  return stripUndefined({
    dataDir,
    now,
    logger,
    fallbackLabel: boundLabel,
    onNote: (note) => logNote(notes, logger, note),
    modelCall: injectedNameModel,
    timeoutMs: opts.nameTimeoutMs,
  });
}

async function nameLeafCluster(cluster, namingOpts) {
  const fallback = boundLabel(cluster.theme);
  const label = await nameMindEntity({
    ...namingOpts,
    statements: cluster.atoms.map((atom) => atom.statement),
    keywords: [
      ...stringArray(cluster.keywords),
      fallback,
      ...cluster.atoms.map((atom) => atom.label),
    ],
    fallbackLabel: () => fallback,
  });
  return Object.freeze({
    ...cluster,
    theme: label,
  });
}

async function nameMindOutputEntities(outputs, outputGroup, atomDocs, namingOpts) {
  const docsById = new Map(atomDocs.map((doc) => [doc.id, doc]));
  const named = [];

  for (const output of outputs) {
    const atomIds = mindOutputAtomIds(output);
    const evidenceDocs = atomIds.map((id) => docsById.get(id)).filter(Boolean);
    const fallback = mindOutputLabel(output, outputGroup, docsById);
    const label = await nameMindEntity({
      ...namingOpts,
      statements: mindEntityOutputStatements(output, evidenceDocs),
      keywords: mindEntityOutputKeywords(output, outputGroup, fallback),
      fallbackLabel: () => fallback,
    });
    named.push(Object.freeze({
      ...output,
      label,
    }));
  }

  return Object.freeze(named);
}

function mindEntityOutputStatements(output, evidenceDocs) {
  return [
    ...evidenceDocs.map((doc) => doc.atom?.statement),
    output.statement,
    output.summary,
    output.observation,
    output.rationale,
    ...arrayValues(output.considerations),
  ];
}

function mindEntityOutputKeywords(output, outputGroup, fallback) {
  return [
    fallback,
    output.label,
    output.type,
    outputGroup,
    ...stringArray(output.criteria?.keywords),
  ];
}

function projectMindOutput(output, outputGroup, context) {
  const label = projectedOutputLabel(output, outputGroup);
  const evidenceIds = projectedEvidenceIds(output);
  const sourceAtomIds = projectedSourceAtomIds(output);
  const nextAction = projectedNextAction(output, outputGroup, label);
  const siblings = siblingGroupForOutput(output, context);
  const confidence = finiteOutputConfidence(output.confidence ?? output.output?.recommendation?.confidence);
  const conversationIds = projectedConversationIds(output);
  const type = optionalString(output.type);
  const outputId = projectedOutputId(output, outputGroup, evidenceIds);
  const themeObservation = output.kind === 'MindTheme'
    ? projectedObservation(output, outputGroup, label)
    : undefined;
  const themeConsiderations = output.kind === 'MindTheme'
    ? projectedConsiderations(output.considerations)
    : [];
  const openAtomIds = stringArray(output.openAtomIds);
  const statement = protocolStatementForOutput({
    output,
    outputGroup,
    label,
    nextAction,
    evidenceIds,
    sourceAtomIds,
    siblings,
  });
  const decisionCard = output.kind === 'MindCandidate'
    ? decisionCardPacketFields(output.decisionCard)
    : undefined;
  const glaze = surfacedMindGlaze([
    statement,
    label,
    nextAction,
    themeObservation,
    ...themeConsiderations,
    ...Object.values(decisionCard ?? {}),
  ]);

  return buildViewPacket({
    viewType: mindOutputViewType(outputGroup),
    text: statement,
    fields: boundPacketFields(stripUndefined({
      kind: optionalString(output.kind),
      outputType: outputGroup,
      outputId,
      label,
      evidenceIds,
      sourceAtomIds,
      nextAction,
      siblings,
      type,
      observation: themeObservation,
      considerations: themeConsiderations.length > 0 ? themeConsiderations : undefined,
      openLoop: output.openLoop === true ? true : undefined,
      openAtomIds: openAtomIds.length > 0 ? openAtomIds : undefined,
      conversationIds,
      decisionCard,
      glaze,
      ...decisionCard,
    })),
    evidence: Array.isArray(evidenceIds) ? evidenceIds.slice(0, 40) : evidenceIds,
    siblings: mindOutputPacketSiblingRefs(siblings),
    action: nextAction ? { kind: 'next_action', target: nextAction } : undefined,
    confidence,
    provenance: mindOutputPacketProvenance('think'),
    frontierExcluded: true,
  });
}

export function mindOutputViewType(outputGroup) {
  if (outputGroup === MIND_OUTPUT_GROUPS[0]) return 'k0.decision';
  if (outputGroup === MIND_OUTPUT_GROUPS[1]) return 'loop.evidence';
  if (outputGroup === MIND_OUTPUT_GROUPS[2]) return 'k0.claim';
  if (outputGroup === MIND_OUTPUT_GROUPS[3]) return 'k0.change';
  return 'k0.claim';
}

export function mindOutputPacketProvenance(module) {
  return {
    surface: 'mind-surface',
    lane: 'deliberate',
    plane: 'mind',
    module,
  };
}

export function mindOutputPacketSiblingRefs(siblings) {
  return (Array.isArray(siblings) ? siblings : [])
    .map((sibling) => optionalString(sibling.atomId) ?? optionalString(sibling.label))
    .filter(Boolean);
}

function decisionCardPacketFields(card) {
  if (!isPlainObject(card)) return undefined;
  const fields = {};
  for (const field of DECISION_CARD_FIELDS) {
    const value = optionalString(card[field]);
    if (!value) return undefined;
    fields[field] = value;
  }
  return fields;
}

function projectedOutputId(output, outputGroup, evidenceIds) {
  return firstPresentString(
    output.clusterId,
    output.themeId,
    output.openLoopId,
    output.resurfacedId,
    output.ideaId,
    output.bridgeAtomId && `bridge_${sha256([
      output.bridgeAtomId,
      ...stringArray(output.sourceThreadIds),
    ].join('\n')).slice(0, 16)}`,
  ) ?? `${outputGroup}_${sha256(evidenceIds.join('\n')).slice(0, 16)}`;
}

function projectedOutputLabel(output, outputGroup) {
  if (output.kind === 'MindCandidate') {
    return boundLabel(firstPresentString(
      output.theme,
      output.output?.recommendation?.decision,
      output.output?.recommendation?.recommended,
    ) ?? 'Build decide thread');
  }
  if (outputGroup === MIND_OUTPUT_GROUPS[3]) {
    return boundLabel(firstPresentString(output.label, output.statement) ?? 'New idea bridge');
  }
  return boundLabel(firstPresentString(output.label, output.summary, output.statement) ?? 'Mind thread');
}

function projectedEvidenceIds(output) {
  return Array.from(new Set([
    ...arrayValues(output.evidenceIds),
    ...arrayValues(output.output?.recommendation?.evidenceIds),
    ...arrayValues(output.atomIds),
    ...arrayValues(output.connectedAtomIds),
    output.bridgeAtomId,
  ]
    .map((value) => optionalString(value))
    .filter(Boolean))).sort();
}

function projectedSourceAtomIds(output) {
  return Array.from(new Set([
    ...arrayValues(output.atomIds),
    ...arrayValues(output.connectedAtomIds),
    output.bridgeAtomId,
  ]
    .map((value) => optionalString(value))
    .filter(Boolean))).sort();
}

function projectedConversationIds(output) {
  return Array.from(new Set([
    ...arrayValues(output.conversationIds),
    ...arrayValues(output.connectedConversationIds),
  ]
    .map((value) => optionalString(value))
    .filter(Boolean))).sort();
}

const MAX_NEXT_ACTION_CHARS = 140;

function projectedNextAction(output, outputGroup, label) {
  // BOUND: next-action is a short imperative, never the raw (private,
  // unbounded) recommendation text — a full planning sentence must not cross
  // the bounded mind wire via this field.
  // Next-action is a GENERATED imperative from the (bounded) label — never the
  // raw recommendation/target text, which can carry a full private sentence.
  const raw = firstPresentString(
    outputGroup === MIND_OUTPUT_GROUPS[0] ? `Decide the next reversible step for ${label}.` : undefined,
    outputGroup === MIND_OUTPUT_GROUPS[1] ? `Review the open thread for ${label}.` : undefined,
    outputGroup === MIND_OUTPUT_GROUPS[2] ? `Review why ${label} resurfaced now.` : undefined,
    outputGroup === MIND_OUTPUT_GROUPS[3] ? `Review the bridge idea for ${label}.` : undefined,
    `Review ${label}.`,
  ) ?? `Review ${label}.`;
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_NEXT_ACTION_CHARS);
}

function protocolStatementForOutput({
  output,
  outputGroup,
  label,
  evidenceIds,
  sourceAtomIds,
  siblings,
}) {
  const claim = projectedEvidenceClaim(output, outputGroup);
  const support = projectedEvidenceSupport({ output, outputGroup, evidenceIds, sourceAtomIds, siblings });
  const question = projectedDecisionQuestion(output, outputGroup);
  return boundProtocolText(
    `${label} ${claim} — ${support}. ${question}`,
  );
}

function projectedEvidenceClaim(output, outputGroup) {
  if (output.kind === 'MindCandidate') return 'is ready for a decision';
  if (output.kind === 'MindOpenLoop') return 'is still open';
  if (output.kind === 'MindResurfacedIdea') return 'came back after quiet';
  if (output.kind === 'DivergentIdea') return 'bridges separate threads';
  if (output.kind === 'MindTheme') return 'keeps returning unresolved';
  if (outputGroup === MIND_OUTPUT_GROUPS[0]) return 'is ready for a decision';
  if (outputGroup === MIND_OUTPUT_GROUPS[2]) return 'came back after quiet';
  if (outputGroup === MIND_OUTPUT_GROUPS[3]) return 'bridges separate threads';
  return 'keeps returning unresolved';
}

function projectedEvidenceSupport({ output, outputGroup, evidenceIds, sourceAtomIds, siblings }) {
  if (output.kind === 'MindCandidate') {
    return `${founderCountPhrase(evidenceIds.length, 'piece', 'pieces')} of evidence staged`;
  }
  if (output.kind === 'MindTheme') {
    const atomCount = output.criteria?.atomCount ?? sourceAtomIds.length;
    const conversationCount = output.criteria?.conversationCount ?? projectedConversationIds(output).length;
    return `${founderCountPhrase(atomCount, 'atom')} across ${founderCountPhrase(conversationCount, 'conversation')} behind it`;
  }
  if (output.kind === 'MindResurfacedIdea') {
    const gapDays = output.criteria?.observedQuietGapDays ?? 0;
    return `${founderCountPhrase(gapDays, 'quiet-gap day')} behind it`;
  }
  if (output.kind === 'DivergentIdea') {
    const sourceClusters = stringArray(output.sourceThreadIds).length;
    return `${founderCountPhrase(sourceClusters, 'source cluster')} and ${founderCountPhrase(sourceAtomIds.length, 'atom')} behind it`;
  }
  if (output.kind === 'MindOpenLoop') {
    return `${founderCountPhrase(sourceAtomIds.length || 1, 'unresolved source atom')} with ${founderCountPhrase(siblings.length, 'nearby sibling')} behind it`;
  }
  return `${founderCountPhrase(sourceAtomIds.length || evidenceIds.length, 'source')} behind it`;
}

function projectedDecisionQuestion(output, outputGroup) {
  if (output.kind === 'MindCandidate' || outputGroup === MIND_OUTPUT_GROUPS[0]) {
    return "what's the next reversible step?";
  }
  if (output.kind === 'MindResurfacedIdea' || outputGroup === MIND_OUTPUT_GROUPS[2]) return 'why now?';
  if (output.kind === 'DivergentIdea' || outputGroup === MIND_OUTPUT_GROUPS[3]) return 'is the bridge useful?';
  if (output.kind === 'MindOpenLoop') return 'what closes it?';
  return 'what needs review?';
}

function founderCountPhrase(value, singular, plural = `${singular}s`) {
  const count = Math.max(0, Math.floor(Number(value) || 0));
  return `${founderCount(count)} ${count === 1 ? singular : plural}`;
}

function founderCount(count) {
  if (count < 100) return String(count);
  if (count < 1000) return String(Math.round(count / 10) * 10);
  return `${(Math.round(count / 100) / 10).toFixed(1)}k`;
}

const MAX_OBSERVATION_CHARS = 80;

function projectedObservation(output, outputGroup, label) {
  // BOUND every observation: raw chat-derived text (summary/reason/rationale/
  // statement of a frontierExcluded record) must not cross the wire in full.
  return String(rawProjectedObservation(output, outputGroup, label) ?? '')
    .replace(/\s+/g, ' ').trim().slice(0, MAX_OBSERVATION_CHARS);
}

function rawProjectedObservation(output, outputGroup, label) {
  if (output.kind === 'MindCandidate') {
    return firstPresentString(output.output?.summary, output.output?.recommendation?.reason) ??
      `${label} is actionable enough to stage as a human-gated decision`;
  }
  if (output.kind === 'MindTheme') return firstPresentString(output.observation, output.summary);
  if (output.kind === 'MindResurfacedIdea') {
    return `the thread returned after a long quiet gap`;
  }
  if (output.kind === 'DivergentIdea') {
    return firstPresentString(output.rationale, output.statement) ??
      `the bridge links previously separate source threads`;
  }
  if (output.kind === 'MindOpenLoop') return `${label} remains unresolved by later decisions`;
  return `${label} is present in ${outputGroup}`;
}

function projectedConsiderations(value) {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(value
    .map((entry) => optionalString(entry))
    .filter(Boolean)
    .map((entry) => entry.replace(/\s+/g, ' ').trim().slice(0, MAX_OBSERVATION_CHARS))
    .filter(Boolean)
    .slice(0, MAX_THEME_CONSIDERATIONS));
}

function siblingGroupForOutput(output, { docsById, clustersById }) {
  const cluster = optionalString(output.clusterId)
    ? clustersById.get(output.clusterId)
    : undefined;
  const atomIds = projectedSourceAtomIds(output);
  const ids = atomIds.length > 0
    ? atomIds
    : stringArray(cluster?.atomIds);
  return ids
    .map((id) => docsById.get(id))
    .filter(Boolean)
    .slice(0, MAX_SIBLINGS)
    .map((doc) => {
      const atom = doc.atom ?? doc;
      return stripUndefined({
        atomId: requiredString(doc.id ?? atom.id, 'sibling.atomId'),
        label: boundLabel(atom.label ?? atom.statement),
        type: optionalString(atom.type),
        statement: truncateForModel(atom.statement, 180),
      });
    });
}

function boundProtocolText(value) {
  const text = stripLabelScaffolding(value)
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, MAX_PROTOCOL_STATEMENT_CHARS);
}

function extractionConversations(exposures, { notes, logger }) {
  const groups = new Map();

  for (const exposure of exposures) {
    if (!isFounderAuthoredExposure(exposure)) continue;
    if (!optionalString(exposure.statement)) {
      logNote(
        notes,
        logger,
        `exposure skipped during atom synthesis: ${optionalString(exposure?.id) ?? 'unknown'} (statement is required)`,
      );
      continue;
    }
    const conversationId = conversationIdForExposure(exposure);
    if (!conversationId) {
      if (isChatExposure(exposure)) {
        logNote(
          notes,
          logger,
          `chat exposure skipped during atom synthesis: missing conversationId (${optionalString(exposure.id) ?? 'unknown'})`,
        );
      }
      continue;
    }

    const group = groups.get(conversationId) ?? {
      conversationId,
      messages: [],
      surfaces: [],
      context: optionalString(exposure.metadata?.conversationName ?? exposure.context) ?? conversationId,
    };
    group.messages.push(exposure);
    group.surfaces.push(optionalString(exposure.provenance?.surface));
    if (!groups.has(conversationId)) groups.set(conversationId, group);
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      surfaces: Array.from(new Set(group.surfaces.filter(Boolean))),
      messages: group.messages.sort(compareExposureRecords),
    }))
    .filter((group) => group.messages.length > 0)
    .sort((a, b) =>
      requiredString(a.messages[0].eventAt, 'conversation.eventAt')
        .localeCompare(requiredString(b.messages[0].eventAt, 'conversation.eventAt')) ||
      a.conversationId.localeCompare(b.conversationId));
}

function isFounderAuthoredExposure(exposure) {
  if (isAssistantExposure(exposure)) return false;
  const role = exposureRole(exposure);
  const human = exposureHumanFlag(exposure);
  if (isChatExposure(exposure)) return human === true;
  if (role === 'human' || role === 'user') return true;
  if (human === true) return true;
  if (human === false) return false;
  return true;
}

function isAssistantExposure(exposure) {
  if (NON_FOUNDER_ROLES.has(exposureRole(exposure))) return true;
  return exposureHumanFlag(exposure) === false;
}

function exposureRole(exposure) {
  return optionalString(
    exposure?.metadata?.role ??
      exposure?.role ??
      exposure?.author?.role,
  )?.toLowerCase();
}

function exposureHumanFlag(exposure) {
  const value = exposure?.metadata?.human ?? exposure?.human;
  return typeof value === 'boolean' ? value : undefined;
}

function conversationIdForExposure(exposure) {
  const realConversationId = optionalString(
    exposure?.metadata?.conversationId ??
      exposure?.conversationId ??
      exposure?.conversation?.id,
  );
  if (realConversationId) return realConversationId;
  if (isChatExposure(exposure)) return undefined;
  const exposureId = optionalString(exposure?.id);
  return exposureId ? `Exposure:${exposureId}` : undefined;
}

function isChatExposure(exposure) {
  const surface = optionalString(exposure?.provenance?.surface)?.toLowerCase();
  return surface === 'claude' || surface === 'chatgpt';
}

function liveExposures(exposures) {
  return (Array.isArray(exposures) ? exposures : [])
    .filter((record) =>
      record?.kind === 'Exposure' &&
      !record.validTo &&
      !record.supersededById)
    .sort(compareExposureRecords);
}

function compareExposureRecords(a, b) {
  return requiredString(a.eventAt, 'Exposure.eventAt').localeCompare(requiredString(b.eventAt, 'Exposure.eventAt')) ||
    requiredString(a.id, 'Exposure.id').localeCompare(requiredString(b.id, 'Exposure.id'));
}

function actionableClusters(clusters, opts) {
  const minAtoms = positiveInteger(opts.minClusterAtoms, DEFAULT_MIN_CLUSTER_ATOMS);
  const limit = positiveInteger(opts.candidateLimit, DEFAULT_CANDIDATE_LIMIT);
  return clusters
    .filter((cluster) => cluster.atoms.length >= minAtoms)
    .slice(0, limit);
}

function buildDecideCriterionSatisfied(candidate, cluster, opts) {
  const minAtoms = positiveInteger(opts.minClusterAtoms, DEFAULT_MIN_CLUSTER_ATOMS);
  return cluster.atoms.length >= minAtoms &&
    isGovernedNextAction(candidate.nextAction) &&
    actionableTarget(candidate.nextAction.target) &&
    concreteTopic(concreteTopicForCluster(cluster));
}

function isGovernedNextAction(nextAction) {
  return nextAction?.kind === 'NextAction' &&
    nextAction.unattended === false &&
    (nextAction.tag === '[gate:human]' || nextAction.tag === '[advise]');
}

function actionForCluster(cluster) {
  const text = clusterText(cluster);
  if (/\b(execute|run|ship|launch|deploy)\b/i.test(text)) {
    return 'Execute a reversible review for';
  }
  if (/\b(decide|decision|choose|pick|whether|should)\b/i.test(text) ||
      cluster.atoms.some((atom) => atom.type === 'decision' || atom.type === 'question')) {
    return 'Decide the next reversible step for';
  }
  return 'Build a reversible execution note for';
}

function concreteTopicForCluster(cluster) {
  const topic = firstPresentString(
    concreteTheme(cluster.theme),
    ...cluster.atoms.map((atom) => concreteTheme(atom.label)),
    ...cluster.atoms.map((atom) => concreteTheme(labelFromStatement(atom.statement))),
  );
  return topic ? boundLabel(topic) : 'this idea cluster';
}

function concreteTheme(value) {
  const text = optionalString(value);
  if (!text || /^untitled\b/i.test(text) || /^this idea cluster$/i.test(text)) return undefined;
  return text.replace(/\s+/g, ' ').trim();
}

function actionableTarget(value) {
  const text = optionalString(value);
  return Boolean(text && /\b(build|execute|decide|draft|review|choose|stage|implement|convert)\b/i.test(text));
}

function concreteTopic(value) {
  const text = optionalString(value);
  return Boolean(text && /[a-z0-9]/i.test(text) && !/^untitled\b/i.test(text));
}

function clusterText(cluster) {
  return [
    cluster.theme,
    ...cluster.atoms.flatMap((atom) => [atom.label, atom.statement, atom.type]),
  ].map((value) => optionalString(value)).filter(Boolean).join('\n');
}

function clusterCoherence(docs) {
  if (docs.length <= 1) return docs.length;
  const similarities = [];
  for (let outer = 0; outer < docs.length; outer += 1) {
    for (let inner = outer + 1; inner < docs.length; inner += 1) {
      similarities.push(cosineSimilarity(docs[outer].embedding, docs[inner].embedding));
    }
  }
  return average(similarities);
}

function atomTextContent(atom) {
  return [
    atom.label,
    atom.statement,
    atom.type,
  ].map((value) => optionalString(value)).filter(Boolean).join('\n');
}

function compareAtomDocs(a, b) {
  return requiredString(a.eventAt, 'IdeaAtom.eventAt').localeCompare(requiredString(b.eventAt, 'IdeaAtom.eventAt')) ||
    requiredString(a.id, 'IdeaAtom.id').localeCompare(requiredString(b.id, 'IdeaAtom.id'));
}

function conversationIdsForAtoms(atoms) {
  return Array.from(new Set(
    atoms
      .map((atom) => optionalString(atom.conversationId))
      .filter(Boolean),
  )).sort();
}

function themeLabel(atoms) {
  const label = firstPresentString(
    ...atoms.map((atom) => concreteTheme(atom.label)),
    ...atoms.map((atom) => concreteTheme(labelFromStatement(atom.statement))),
  );
  return label ? boundLabel(label) : 'Recurring idea theme';
}

function outputConfidence(atoms, coherence) {
  const atomConfidence = average(
    atoms
      .map((atom) => Number(atom.confidence))
      .filter((value) => Number.isFinite(value)),
  );
  return clampConfidence(
    (atomConfidence * OUTPUT_CONFIDENCE_ATOM_WEIGHT) +
    (clampConfidence(coherence) * OUTPUT_CONFIDENCE_COHERENCE_WEIGHT),
  );
}

function eventWindow(atoms) {
  const eventAts = atoms
    .map((atom) => optionalString(atom.eventAt ?? atom.validFrom))
    .filter(Boolean)
    .sort();
  return eventAts.length > 0
    ? { start: eventAts[0], end: eventAts.at(-1) }
    : {};
}

function isOpenLoopCandidate(atom) {
  const type = normalizeAtomType(atom.type);
  const text = atomTextContent(atom);
  if (closureText(text) && type === 'decision') return false;
  return type === 'question' ||
    type === 'open-loop' ||
    type === 'intent' ||
    /\b(how should|what should|should k|should i|whether|open loop|unresolved|need to decide|decide whether)\b/i.test(text);
}

function closesOpenLoop(openDoc, laterDoc, threshold) {
  if (openDoc.id === laterDoc.id) return false;
  if (compareAtomDocs(openDoc, laterDoc) >= 0) return false;
  if (!closureAtom(laterDoc.atom)) return false;
  const similarity = cosineSimilarity(openDoc.embedding, laterDoc.embedding);
  return similarity >= threshold || (
    openDoc.atom.conversationId === laterDoc.atom.conversationId &&
    tokenOverlap(atomTextContent(openDoc.atom), atomTextContent(laterDoc.atom)) >=
      SAME_CONVERSATION_TOKEN_CLOSURE_THRESHOLD
  );
}

function closureAtom(atom) {
  return normalizeAtomType(atom.type) === 'decision' || closureText(atomTextContent(atom));
}

function closureText(text) {
  return /\b(decided|decision|resolved|closed|settled|picked|chosen|implemented|shipped|must|will)\b/i.test(text);
}

function tokenOverlap(left, right) {
  const leftTokens = tokenSet(left);
  const rightTokens = tokenSet(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let shared = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) shared += 1;
  }
  return shared / Math.min(leftTokens.size, rightTokens.size);
}

function tokenSet(value) {
  return new Set(
    String(value ?? '')
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .filter((token) => token.length >= 3),
  );
}

function conversationModelPayload(conversation) {
  const messages = conversation.messages.map((message) => stripUndefined({
    id: message.id,
    type: message.type,
    statement: message.statement,
    context: message.context,
    eventAt: message.eventAt,
    turnIndex: message.metadata?.turnIndex,
    role: message.metadata?.role,
    human: message.metadata?.human,
  }));

  return boundedConversationPayload({
    conversationId: conversation.conversationId,
    context: conversation.context,
    surfaces: conversation.surfaces,
  }, messages);
}

function boundedConversationPayload(basePayload, messages) {
  let founderMessages = messages.slice(-MAX_CONVERSATION_MESSAGES);
  let omittedOlderMessageCount = Math.max(0, messages.length - founderMessages.length);
  let payload = buildConversationPayload(basePayload, founderMessages, omittedOlderMessageCount);

  while (founderMessages.length > 1 && conversationPayloadLength(payload) > MAX_CONVERSATION_CHARS) {
    founderMessages = founderMessages.slice(1);
    omittedOlderMessageCount += 1;
    payload = buildConversationPayload(basePayload, founderMessages, omittedOlderMessageCount);
  }

  if (conversationPayloadLength(payload) <= MAX_CONVERSATION_CHARS || founderMessages.length === 0) {
    return payload;
  }

  return truncateSingleMessagePayload(basePayload, founderMessages[0], omittedOlderMessageCount);
}

function buildConversationPayload(basePayload, founderMessages, omittedOlderMessageCount) {
  return stripUndefined({
    ...basePayload,
    omittedOlderMessageCount: omittedOlderMessageCount > 0 ? omittedOlderMessageCount : undefined,
    founderMessages,
  });
}

function truncateSingleMessagePayload(basePayload, message, omittedOlderMessageCount) {
  const statement = optionalString(message.statement) ?? '';
  let low = 0;
  let high = statement.length;
  let best = buildConversationPayload(basePayload, [{
    ...message,
    statement: '',
    truncated: statement.length > 0,
    omittedStatementChars: statement.length,
  }], omittedOlderMessageCount);

  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const candidate = buildConversationPayload(basePayload, [{
      ...message,
      statement: statement.slice(0, midpoint),
      truncated: midpoint < statement.length,
      omittedStatementChars: statement.length - midpoint,
    }], omittedOlderMessageCount);

    if (conversationPayloadLength(candidate) <= MAX_CONVERSATION_CHARS) {
      best = candidate;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }

  return best;
}

function conversationPayloadLength(payload) {
  return JSON.stringify({ conversation: payload }).length;
}

function parseModelObject(raw) {
  const parsed = parseModelValue(raw);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function parseModelValue(raw) {
  if (typeof raw === 'string') return parseJsonValue(raw);
  if (!raw || typeof raw !== 'object') return {};
  if (typeof raw.response === 'string') return parseJsonValue(raw.response);
  if (typeof raw.content === 'string') return parseJsonValue(raw.content);
  return raw;
}

function parseJsonObject(text) {
  const parsed = parseJsonValue(text);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function parseJsonValue(text) {
  const source = requiredString(text, 'json text');
  const trimmed = source.trim();
  const objectStart = trimmed.indexOf('{');
  const arrayStart = trimmed.indexOf('[');
  const starts = [objectStart, arrayStart].filter((index) => index >= 0);
  const start = starts.length > 0 ? Math.min(...starts) : -1;
  if (start < 0) return JSON.parse(trimmed);

  const endChar = trimmed[start] === '[' ? ']' : '}';
  const end = trimmed.lastIndexOf(endChar);
  const json = end > start ? trimmed.slice(start, end + 1) : trimmed;
  return JSON.parse(json);
}

// Extraction/summary scaffolding that must never reach a wire label. These are
// narration artifacts ("The user is asking…") and filler hedges ("or something
// similar") that leak in when a label falls back to a raw atom statement rather
// than a distilled keyword label. Stripped before word-bounding.
const LABEL_SCAFFOLDING_PATTERNS = [
  // "The user/founder/assistant is <gerund> …" narration — the dominant leak.
  /\bthe (?:user|founder|assistant) is (?:asking|wondering|trying to|requesting|saying|making|pointing(?:\s+(?:to|out))?|providing|sharing|proposing|suggesting|describing|looking(?:\s+for)?|referring to|responding|noting|thinking|considering)(?:\s+(?:about|for|whether|if|how|to|that|several|two|a|an|the|more|answers|research))?\b/gi,
  // "The user <verb> …" (non-gerund).
  /\bthe (?:user|founder) (?:wants|asks|asked|said|needs|means|prefers|decided|is)(?:\s+(?:for|to|about|more|several|research))?\b/gi,
  /\bthis conversation is about\b/gi,
  /\bor something similar\b/gi,
  /\bappears to be\b/gi,
  /\bit (?:seems|appears) (?:that|like)\b/gi,
];

function stripLabelScaffolding(text) {
  let stripped = String(text ?? '');
  for (const pattern of LABEL_SCAFFOLDING_PATTERNS) {
    stripped = stripped.replace(pattern, ' ');
  }
  return stripped.replace(/\s+/g, ' ').trim();
}

export function boundLabel(text) {
  const words = stripLabelScaffolding(text)
    .replace(/https?:\/\/\S+/g, '')
    .split(/\s+/)
    .map((word) => word.replace(/[^a-z0-9'-]/gi, ''))
    .filter(Boolean)
    .slice(0, MAX_LABEL_WORDS);
  const label = words.join(' ').slice(0, MAX_LABEL_CHARS).trim();
  return label || 'Untitled idea';
}

function labelFromStatement(statement) {
  const label = boundLabel(statement);
  const words = label.split(/\s+/).filter(Boolean);
  return words.length > 0 ? words.join(' ') : 'Untitled idea';
}

function embeddingOptions(opts, dataDir) {
  return {
    dataDir,
    ...(opts.cacheDir ? { cacheDir: opts.cacheDir } : {}),
    ...(opts.embedder ? { embedder: opts.embedder } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  };
}

function stringArray(values) {
  return Array.isArray(values)
    ? values.map((value) => optionalString(value)).filter(Boolean).sort()
    : [];
}

// Like stringArray but preserves source order (and de-dupes). Used for
// rank-ordered lists such as c-TF-IDF keywords, where sorting would destroy the
// ranking the sidecar computed.
function orderedStringList(values) {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const text = optionalString(value);
    if (text && !seen.has(text)) {
      seen.add(text);
      out.push(text);
    }
  }
  return out;
}

function firstPresentString(...values) {
  for (const value of values) {
    const text = optionalString(value);
    if (text) return text;
  }
  return undefined;
}

function positiveInteger(value, fallback) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.floor(number);
}

function nonNegativeInteger(value, fallback) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.floor(number);
}

function boundedNumber(value, fallback) {
  const number = Number(value ?? fallback);
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : fallback;
}

function normalizeEvidenceIds(values, conversation) {
  if (!Array.isArray(values)) throw new Error('ideaAtom.evidenceIds must be an array');
  const allowed = new Set((conversation?.messages ?? []).map((message) => message.id));
  const evidenceIds = values
    .map((value) => requiredString(value, 'ideaAtom.evidenceIds item'))
    .filter((id) => allowed.has(id));
  if (evidenceIds.length === 0) {
    throw new Error('ideaAtom.evidenceIds must include at least one founder message id');
  }
  return Array.from(new Set(evidenceIds));
}

function ideaAtomEventAt(evidenceIds, conversation) {
  const messagesById = new Map((conversation?.messages ?? []).map((message) => [message.id, message]));
  const eventAts = evidenceIds
    .map((id) => optionalString(messagesById.get(id)?.eventAt))
    .filter(Boolean)
    .sort();
  return requiredString(eventAts.at(-1), 'ideaAtom.eventAt');
}

function ideaAtomContentHash({ statement, type }) {
  return sha256(`${normalizeAtomType(type)}\n${requiredString(statement, 'ideaAtom.statement').replace(/\s+/g, ' ').trim()}`).slice(0, 24);
}

function ideaAtomDedupeKey(conversationId, contentHash) {
  return `IdeaAtom::${requiredString(conversationId, 'conversationId')}::${requiredString(contentHash, 'contentHash')}`;
}

function ideaAtomMutation(record, op) {
  return stripUndefined({
    op,
    path: path.join('data', IDEA_ATOM_DIR, `${record.id}.json`),
    kind: record.kind,
    id: record.id,
    outputGroups: Array.isArray(record.outputGroups) && record.outputGroups.length > 0
      ? record.outputGroups
      : undefined,
  });
}

function shouldUpgradeIdeaAtom(existing, candidate) {
  return !existing.validTo &&
    !existing.supersededById &&
    ideaAtomGeneratedBy(existing) === 'extractive' &&
    ideaAtomGeneratedBy(candidate) !== 'extractive';
}

async function supersedeIdeaAtom(existing, candidate, { dataDir, now }) {
  const replacement = {
    ...candidate,
    id: replacementIdeaAtomId(candidate),
  };
  const replacementFile = safeDataPath(dataDir, path.join(IDEA_ATOM_DIR, `${replacement.id}.json`));
  let replacementRecord = replacement;
  let replacementCreated = false;

  try {
    await fs.writeFile(replacementFile, `${JSON.stringify(replacement, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    replacementCreated = true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    replacementRecord = JSON.parse(await fs.readFile(replacementFile, 'utf8'));
  }

  const retired = {
    ...existing,
    validTo: iso(now),
    supersededById: replacementRecord.id,
  };
  const existingFile = safeDataPath(dataDir, path.join(IDEA_ATOM_DIR, `${existing.id}.json`));
  await fs.writeFile(existingFile, `${JSON.stringify(retired, null, 2)}\n`, 'utf8');

  return {
    record: replacementRecord,
    mutations: [
      ...(replacementCreated ? [ideaAtomMutation(replacementRecord, 'write')] : []),
      ideaAtomMutation(retired, 'superseded'),
    ],
  };
}

async function readIdeaAtom(dataDir, id) {
  try {
    const file = safeDataPath(dataDir, path.join(IDEA_ATOM_DIR, `${requiredString(id, 'ideaAtom.id')}.json`));
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function replacementIdeaAtomId(record) {
  return `idea_${sha256(`${record.dedupeKey}::${ideaAtomGeneratedBy(record)}`).slice(0, 24)}`;
}

function ideaAtomGeneratedBy(record) {
  return optionalString(record.extraction?.generatedBy) ?? 'extractive';
}

function isModelUnavailableError(error) {
  // HARD unavailability — the lane is down / misconfigured / too slow, so stop
  // the run and silence. A per-request HTTP rejection ("... model call failed
  // 400/429/5xx", "... assistant message content is required") is NOT this: it
  // is skipped per-conversation and only escalates via the consecutive-failure
  // cap. Tests rely on 'unavailable' and 'timed out' silencing the run.
  const message = String(error?.message ?? error).toLowerCase();
  return message.includes('unavailable') ||
    message.includes('econnrefused') ||
    message.includes('connection refused') ||
    message.includes('fetch failed') ||
    message.includes('fetch is unavailable') ||
    message.includes('timed out') ||
    message.includes('api key') ||
    message.includes('api_key');
}

async function ollamaStatusError(response) {
  const status = Number(response?.status);
  const error = new Error(`Ollama generate request failed${Number.isFinite(status) ? ` ${status}` : ''}`);
  error.statusCode = status;
  error.code = status === 503 ? 'OLLAMA_503' : 'OLLAMA_HTTP';
  return error;
}

function isRetryableOllamaError(error) {
  if (Number(error?.statusCode ?? error?.status) === 503) return true;
  const code = errorCode(error);
  if (code === 'ECONNREFUSED') return true;
  const message = String(error?.message ?? error).toLowerCase();
  return message.includes('econnrefused') || message.includes('connection refused');
}

function emitOllamaDegradeNote(opts, error, attempts) {
  const note = {
    event: 'local_ollama_degraded',
    provider: LOCAL_MIND_MODEL_PROVIDER,
    reason: ollamaRetryReason(error),
    attempts,
  };
  const message = JSON.stringify(note);
  if (typeof opts.onNote === 'function') {
    opts.onNote(message);
    return;
  }
  opts.logger?.warn?.(`[cs-k] think: ${message}`);
}

function ollamaUnavailableError(error, attempts) {
  const wrapped = new Error(`local Ollama unavailable after ${attempts} attempt${attempts === 1 ? '' : 's'} (${ollamaRetryReason(error)})`);
  wrapped.code = 'OLLAMA_UNAVAILABLE';
  wrapped.cause = error;
  return wrapped;
}

function ollamaRetryReason(error) {
  if (Number(error?.statusCode ?? error?.status) === 503) return 'http_503';
  return errorCode(error) ?? 'connection_refused';
}

async function waitForOllamaRetry({ attempt, opts }) {
  const ms = ollamaRetryBackoffMs({ attempt, opts });
  if (ms <= 0) return;
  await delay(ms);
}

function ollamaRetryBackoffMs({ attempt, opts }) {
  if (typeof opts.retryBackoffMs === 'function') {
    return nonNegativeInteger(
      opts.retryBackoffMs({
        attempt,
        retry: attempt + 1,
      }),
      0,
    );
  }
  const base = nonNegativeInteger(opts.retryBackoffMs, DEFAULT_OLLAMA_RETRY_BACKOFF_MS);
  const jitter = nonNegativeInteger(opts.retryJitterMs, DEFAULT_OLLAMA_RETRY_JITTER_MS);
  return (base * (2 ** attempt)) + (jitter > 0 ? Math.floor(Math.random() * jitter) : 0);
}

function errorCode(error) {
  return optionalString(
    error?.code ??
    error?.cause?.code ??
    error?.cause?.cause?.code,
  );
}

function mindModelProvider(value) {
  const provider = optionalString(value ?? process.env.K_MIND_MODEL_PROVIDER) ?? DEFAULT_MIND_MODEL_PROVIDER;
  if (provider === DEFAULT_MIND_MODEL_PROVIDER || provider === LOCAL_MIND_MODEL_PROVIDER) {
    return provider;
  }
  throw new Error(`unsupported mind model provider: ${provider}`);
}

function synthesisModelName(provider, value) {
  if (value !== undefined) return requiredString(value, 'model');
  if (provider === LOCAL_MIND_MODEL_PROVIDER) return localModelName();
  return undefined;
}

function localModelName(value) {
  return requiredString(
    value ??
      process.env.K_THINK_MODEL ??
      process.env.OLLAMA_MODEL ??
      DEFAULT_LOCAL_MODEL,
    'model',
  );
}

async function withOperationTimeout(operation, timeoutMs, label) {
  const timeout = normalizeTimeoutMs(timeoutMs);
  let timeoutId;

  try {
    return await new Promise((resolve, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`${label} timed out after ${timeout}ms`));
      }, timeout);

      Promise.resolve(operation()).then(resolve, reject);
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchWithTimeout(fetchFn, url, init, { timeoutMs, label }) {
  const controller = new AbortController();
  const timeout = normalizeTimeoutMs(timeoutMs);
  let timeoutId;

  try {
    return await new Promise((resolve, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        reject(new Error(`${label} timed out after ${timeout}ms`));
      }, timeout);

      Promise.resolve(fetchFn(url, {
        ...init,
        signal: controller.signal,
      })).then(resolve, reject);
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeTimeoutMs(value) {
  const number = Number(value ?? DEFAULT_OLLAMA_TIMEOUT_MS);
  return Number.isFinite(number) && number >= 0
    ? Math.floor(number)
    : DEFAULT_OLLAMA_TIMEOUT_MS;
}
