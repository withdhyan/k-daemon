import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { listGoals } from '../goals/goals.mjs';
import { createSubstrateStore } from '../substrate.mjs';
import { orchestrate } from './orchestrator.mjs';
import { runThreadSwarm } from './swarm.mjs';

const fixedNow = () => new Date('2026-06-28T05:06:07.000Z');

test('orchestrate keeps two worker contexts disjoint and stages only advisory recommendations', async () => {
  const { dataDir, store, alpha, beta } = await seededOrchestratorStore();
  const decideRequests = [];

  const result = await orchestrate({
    dataDir,
    store,
    now: fixedNow,
    embedder: fakeEmbedder,
    segmentOptions: { similarityThreshold: 0.95 },
    research: fakeResearch,
    modelCall: async (request) => {
      if (request.station === 'decide') decideRequests.push(request);
      return fakeThreadModelCall(request);
    },
  });

  assert.equal(result.threadCount, 2);
  assert.equal(decideRequests.length, 2);

  const alphaRequest = decideRequests.find((request) => request.user.includes(alpha.id));
  const betaRequest = decideRequests.find((request) => request.user.includes(beta.id));
  assert(alphaRequest);
  assert(betaRequest);
  assert.doesNotMatch(alphaRequest.user, new RegExp(beta.id));
  assert.doesNotMatch(alphaRequest.user, /Beta orchestrator marker/);
  assert.doesNotMatch(betaRequest.user, new RegExp(alpha.id));
  assert.doesNotMatch(betaRequest.user, /Alpha orchestrator marker/);

  assert.equal(result.threads.length, 2);
  assert(result.threads.every((thread) => thread.goal.tokenBudget === 1));
  assert(result.threads.every((thread) => thread.goal.tokensUsed === 1));
  assert(result.threads.every((thread) => thread.goal.status === 'budget_limited'));

  const goals = await listGoals(undefined, { dataDir });
  assert.equal(goals.length, 2);
  assert(goals.every((goal) => goal.status === 'budget_limited'));
  assert(goals.every((goal) => goal.tokensUsed === 1));

  const alphaThread = result.threads.find((thread) => thread.thread.exposureIds.includes(alpha.id));
  const betaThread = result.threads.find((thread) => thread.thread.exposureIds.includes(beta.id));
  assert(alphaThread);
  assert(betaThread);

  const globalDecisions = await dataFiles(dataDir, 'decisions');
  assert.equal(globalDecisions.length, 1);
  assert.deepEqual(globalDecisions[0].evidenceIds.sort(), [alpha.id].sort());
  assert.equal(globalDecisions[0].kind, 'LoopRecommendation');
  assert.equal(globalDecisions[0].advisoryOnly, true);
  assert.equal(globalDecisions[0].acted, 'pending');
  assert.notEqual(globalDecisions[0].tag, '[auto]');
  assert(!Object.hasOwn(globalDecisions[0], 'act'));
  assert(!Object.hasOwn(globalDecisions[0], 'autoAct'));

  const betaScopedDecisions = await dataFiles(
    dataDir,
    path.join('threads', betaThread.thread.threadId, 'worker', 'decisions'),
  );
  assert.deepEqual(betaScopedDecisions, []);
  assert.equal(betaThread.swarm.roles.worker.output.verdict, 'silence');
  assert.deepEqual(betaThread.stagedMutations, []);

  const allDecisions = [
    ...globalDecisions,
    ...await dataFiles(dataDir, path.join('threads', alphaThread.thread.threadId, 'worker', 'decisions')),
  ];
  assert(allDecisions.every((decision) => decision.advisoryOnly === true));
  assert(allDecisions.every((decision) => decision.tag !== '[auto]'));
  assert(allDecisions.every((decision) => !Object.hasOwn(decision, 'act')));
  assert(allDecisions.every((decision) => !Object.hasOwn(decision, 'autoAct')));
});

test('orchestrate can hold a thread goal below its turn budget', async () => {
  const { dataDir, store } = await seededOrchestratorStore({ beta: false });

  const result = await orchestrate({
    dataDir,
    store,
    now: fixedNow,
    embedder: fakeEmbedder,
    segmentOptions: { similarityThreshold: 0.95 },
    research: fakeResearch,
    modelCall: fakeThreadModelCall,
    threadTurnBudget: 3,
  });

  assert.equal(result.threadCount, 1);
  assert.equal(result.threads[0].goal.tokenBudget, 3);
  assert.equal(result.threads[0].goal.tokensUsed, 1);
  assert.equal(result.threads[0].goal.status, 'active');
});

test('orchestrate stamps staged worker recommendations when thread evidence is chat', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-orchestrator-chat-'));
  const store = createSubstrateStore({ dataDir, now: fixedNow });
  const chat = await store.writeExposure({
    type: 'observation',
    statement: 'ORCHESTRATOR_CHAT_SECRET must not be exposed to frontier prompts.',
    sourceId: 'orchestrator-chat',
    eventAt: '2026-06-28T05:02:00.000Z',
    metadata: {
      conversationId: 'conversation-chat',
      human: true,
      signalWeight: 2,
    },
    provenance: { surface: 'chatgpt', lane: 'deliberate' },
  });

  await orchestrate({
    dataDir,
    store,
    now: fixedNow,
    segmentation: {
      threads: [
        {
          threadId: 'thread_private_chat_recommendation',
          theme: 'Private chat recommendation.',
          exposureIds: [chat.id],
        },
      ],
    },
    dispatch: 'serial',
    research: async () => [],
    modelCall: async (request) => {
      if (request.station === 'decide') {
        return {
          summary: 'Private chat thread earns an advisory.',
          verdict: 'recommend',
          recommendation: {
            decision: 'Whether to review the private chat locally.',
            recommended: 'Review the private chat locally.',
            reason: 'The evidence is private chat and must stay local.',
            reversibility: 'internal-revertible',
            undo: 'Drop the local review note.',
            evidenceIds: [],
            confidence: 0.61,
          },
        };
      }

      return {
        summary: `${request.station}: silence`,
        verdict: 'silence',
      };
    },
  });

  const decisions = await dataFiles(dataDir, 'decisions');
  assert.equal(decisions.length, 1);
  assert.deepEqual(decisions[0].evidenceIds, [chat.id]);
  assert.equal(decisions[0].frontierExcluded, true);
});

test('orchestrate records one failed thread and continues remaining threads', async () => {
  const { dataDir, store, alpha, beta } = await seededOrchestratorStore();

  const result = await orchestrate({
    dataDir,
    store,
    now: fixedNow,
    embedder: fakeEmbedder,
    segmentOptions: { similarityThreshold: 0.95 },
    research: fakeResearch,
    modelCall: fakeThreadModelCall,
    runSwarm: async (thread, ctx, deps) => {
      if (thread.exposureIds.includes(alpha.id)) {
        throw new Error('injected alpha thread failure');
      }
      return runThreadSwarm(thread, ctx, deps);
    },
  });

  assert.equal(result.threadCount, 2);
  const alphaThread = result.threads.find((thread) => thread.thread.exposureIds.includes(alpha.id));
  const betaThread = result.threads.find((thread) => thread.thread.exposureIds.includes(beta.id));

  assert(alphaThread);
  assert(betaThread);
  assert.equal(alphaThread.error.message, 'injected alpha thread failure');
  assert.deepEqual(alphaThread.mutations, []);
  assert.equal(betaThread.swarm.roles.worker.output.verdict, 'silence');
  assert.equal(betaThread.goal.status, 'budget_limited');
});

async function seededOrchestratorStore({ beta = true } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-orchestrator-data-'));
  const store = createSubstrateStore({ dataDir, now: fixedNow });
  const alpha = await store.writeExposure({
    type: 'observation',
    statement: 'Alpha orchestrator marker asks for a reversible local review.',
    sourceId: 'orchestrator-alpha',
    eventAt: '2026-06-28T05:00:00.000Z',
    metadata: {
      conversationId: 'conversation-alpha',
      human: true,
      signalWeight: 2,
    },
    provenance: { surface: 'test', lane: 'deliberate' },
  });
  const betaExposure = beta
    ? await store.writeExposure({
        type: 'observation',
        statement: 'Beta orchestrator marker earns silence and should not stage.',
        sourceId: 'orchestrator-beta',
        eventAt: '2026-06-28T05:01:00.000Z',
        metadata: {
          conversationId: 'conversation-beta',
          human: true,
          signalWeight: 2,
        },
        provenance: { surface: 'test', lane: 'deliberate' },
      })
    : null;

  return {
    dataDir,
    store,
    alpha,
    beta: betaExposure,
  };
}

async function fakeThreadModelCall(request) {
  if (request.station === 'decide') {
    if (request.user.includes('Beta orchestrator marker')) {
      return {
        summary: 'Beta thread earns silence.',
        verdict: 'silence',
      };
    }

    const evidenceIds = exposureIdsFromText(request.user);
    return {
      summary: 'Alpha thread earns an advisory.',
      verdict: 'recommend',
      recommendation: {
        decision: 'Whether the alpha thread should surface a local review.',
        recommended: 'Review the alpha thread locally before changing anything.',
        reason: 'The evidence is reversible and local to this thread.',
        reversibility: 'internal-revertible',
        undo: 'Drop the staged review note.',
        evidenceIds,
        confidence: 0.66,
        tag: '[auto]',
      },
    };
  }

  if (request.station === 'verify') {
    return {
      summary: 'Verifier remains advisory-only.',
      verdict: 'silence',
    };
  }

  throw new Error(`unexpected station: ${request.station}`);
}

async function fakeResearch(query) {
  return exposureIdsFromText(query).map((id) => ({
    evidenceId: id,
    evidenceIds: [id],
    evidenceGrade: 'L4',
    source: 'fake-research',
    relevanceScore: 0.97,
    noveltySatisfied: true,
    kind: 'Exposure',
    content: `research evidence ${id}`,
  }));
}

async function fakeEmbedder(prompt) {
  const lower = prompt.toLowerCase();
  if (lower.includes('beta')) return [0, 1];
  return [1, 0];
}

function exposureIdsFromText(text) {
  return [...new Set(String(text).match(/exp_[a-f0-9]{24}/g) ?? [])];
}

async function dataFiles(dataDir, dirname) {
  const dir = path.join(dataDir, dirname);
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  return Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(async (entry) => JSON.parse(await fs.readFile(path.join(dir, entry.name), 'utf8'))),
  );
}
