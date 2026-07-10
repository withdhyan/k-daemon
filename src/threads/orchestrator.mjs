import path from 'node:path';

import {
  ROOT,
  commitStationOutput,
} from '../../daemon/run.mjs';
import {
  createGoal,
  judgeGoal,
  recordProgress,
} from '../goals/goals.mjs';
import {
  createSubstrateStore,
  optionalString,
  requiredString,
} from '../substrate.mjs';
import { threadContext } from './context.mjs';
import { segment } from './segment.mjs';
import {
  errorDetails,
  runThreadSwarm,
} from './swarm.mjs';

const DEFAULT_DATA_DIR = path.join(ROOT, 'data');
const ORCHESTRATION_SCHEMA_VERSION = 1;
const DEFAULT_THREAD_TURN_BUDGET = 1;

export async function orchestrate(opts = {}) {
  const dataDir = path.resolve(opts.dataDir ?? process.env.CS_K_DATA_DIR ?? DEFAULT_DATA_DIR);
  const now = opts.now ?? (() => new Date());
  const store = opts.store ?? createSubstrateStore({ dataDir, now });
  const exposures = opts.exposures ?? await store.listRecords('Exposure');
  const segmentation = opts.segmentation ?? await runSegmentation(exposures, {
    ...opts.segmentOptions,
    dataDir,
    now,
    ...(opts.embedder ? { embedder: opts.embedder } : {}),
    ...(opts.testEmbedder ? { testEmbedder: opts.testEmbedder } : {}),
  }, opts.segment);
  const threads = threadsFromSegmentation(segmentation);
  const threadResults = [];
  const mutations = [];

  for (const thread of threads) {
    const result = await safeOrchestrateThread(thread, {
      ...opts,
      dataDir,
      now,
      store,
      segmentation,
    });
    threadResults.push(result);
    mutations.push(...result.mutations);
  }

  return Object.freeze({
    kind: 'ThreadOrchestration',
    schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
    threadCount: threadResults.length,
    segmentation,
    threads: Object.freeze(threadResults),
    mutations: Object.freeze(mutations),
  });
}

async function safeOrchestrateThread(thread, opts) {
  try {
    return await orchestrateThread(thread, opts);
  } catch (error) {
    return failedThreadResult(thread, error);
  }
}

async function orchestrateThread(thread, opts) {
  const normalizedThread = normalizeThread(thread);
  const ctx = await (opts.threadContext ?? threadContext)({
    store: opts.store,
    dataDir: opts.dataDir,
    segmentation: opts.segmentation,
    threadId: normalizedThread.threadId,
    station: 'decide',
    limit: opts.contextLimit,
  });
  const goal = await (opts.createGoal ?? createGoal)(goalObjective(normalizedThread), {
    dataDir: opts.dataDir,
    now: opts.now,
    tokenBudget: opts.threadTurnBudget ?? opts.threadTokenBudget ?? DEFAULT_THREAD_TURN_BUDGET,
  });
  const swarm = await (opts.runSwarm ?? runThreadSwarm)(normalizedThread, ctx, {
    dataDir: opts.dataDir,
    store: opts.store,
    now: opts.now,
    modelCall: opts.modelCall,
    verifyModelCall: opts.verifyModelCall,
    research: opts.research,
    researchOptions: opts.researchOptions,
    embedder: opts.embedder,
    testEmbedder: opts.testEmbedder,
    dispatch: opts.dispatch,
    contextLimit: opts.contextLimit,
    workerInput: opts.workerInput,
    verifierInput: opts.verifierInput,
  });
  const stagedMutations = await stageWorkerRecommendation(normalizedThread, swarm, opts);
  const progress = await (opts.recordProgress ?? recordProgress)(goal.goalId, {
    dataDir: opts.dataDir,
    now: opts.now,
    tokens: opts.progressTokens ?? 1,
    seconds: opts.progressSeconds ?? 0,
    state: goalState(normalizedThread, swarm, stagedMutations, opts),
  });
  const status = await (opts.judgeGoal ?? judgeGoal)(goal.goalId, {
    dataDir: opts.dataDir,
    now: opts.now,
  });
  const finalGoal = {
    ...progress,
    status,
  };
  const mutations = [
    ...roleMutations(swarm),
    ...stagedMutations,
  ];

  return Object.freeze({
    thread: normalizedThread,
    context: ctx,
    goal: Object.freeze(finalGoal),
    swarm,
    stagedMutations: Object.freeze(stagedMutations),
    mutations: Object.freeze(mutations),
  });
}

async function stageWorkerRecommendation(thread, swarm, opts) {
  const output = swarm.roles.worker?.output;
  if (!output || output.verdict !== 'recommend') return [];

  return (opts.commitStationOutput ?? commitStationOutput)(
    'decide',
    outputWithThreadEvidence(output, thread),
    {
      dataDir: opts.dataDir,
      store: opts.store,
      now: opts.now,
    },
  );
}

function outputWithThreadEvidence(output, thread) {
  return {
    ...output,
    recommendation: {
      ...output.recommendation,
      evidenceIds: uniqueStrings([
        ...(Array.isArray(output.recommendation?.evidenceIds)
          ? output.recommendation.evidenceIds
          : []),
        ...thread.exposureIds,
      ]),
    },
  };
}

function goalState(thread, swarm, stagedMutations, opts) {
  const workerVerdict = swarm.roles.worker?.output?.verdict ?? 'silence';
  return {
    threadId: thread.threadId,
    exposureIds: thread.exposureIds,
    done: opts.closeGoals === true,
    workerVerdict,
    stagedRecommendationCount: stagedMutations.length,
    roles: {
      explorer: roleState(swarm.roles.explorer),
      worker: swarm.roles.worker?.error ? 'error' : workerVerdict,
      verifier: roleState(swarm.roles.verifier),
    },
  };
}

function roleState(roleResult) {
  if (!roleResult) return 'missing';
  return roleResult.error ? 'error' : 'complete';
}

function roleMutations(swarm) {
  return ['explorer', 'worker', 'verifier']
    .flatMap((role) => swarm.roles[role]?.mutations ?? []);
}

async function runSegmentation(exposures, opts, segmentFn = segment) {
  return segmentFn(exposures, opts);
}

function threadsFromSegmentation(segmentation) {
  if (Array.isArray(segmentation)) return segmentation;
  if (Array.isArray(segmentation?.threads)) return segmentation.threads;
  return [];
}

function normalizeThread(thread) {
  if (!thread || typeof thread !== 'object' || Array.isArray(thread)) {
    throw new Error('thread must be an object');
  }
  return Object.freeze({
    ...thread,
    threadId: requiredString(thread.threadId, 'thread.threadId'),
    theme: optionalString(thread.theme) ?? '',
    exposureIds: normalizeStringArray(thread.exposureIds ?? [], 'thread.exposureIds'),
  });
}

function failedThreadResult(thread, error) {
  return Object.freeze({
    thread: fallbackThread(thread),
    error: errorDetails(error),
    context: '',
    goal: null,
    swarm: null,
    stagedMutations: Object.freeze([]),
    mutations: Object.freeze([]),
  });
}

function fallbackThread(thread) {
  try {
    return normalizeThread(thread);
  } catch {
    return Object.freeze({
      threadId: optionalString(thread?.threadId) ?? '(invalid-thread)',
      theme: optionalString(thread?.theme) ?? '',
      exposureIds: [],
    });
  }
}

function goalObjective(thread) {
  return [
    `Run disposable swarm for thread ${thread.threadId}.`,
    thread.theme ? `Theme: ${thread.theme}` : '',
    `Exposure ids: ${thread.exposureIds.join(', ') || '(none)'}.`,
  ].filter(Boolean).join(' ');
}

function normalizeStringArray(values, field) {
  if (!Array.isArray(values)) throw new Error(`${field} must be an array`);
  return uniqueStrings(values.map((value) => requiredString(value, `${field} item`)));
}

function uniqueStrings(values) {
  return [...new Set(values.map((value) => optionalString(value)).filter(Boolean))];
}
