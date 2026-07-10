import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { mindArtifacts } from '../../daemon/server.mjs';
import { validateViewPacket } from '../agent/view-packet.mjs';
import { governNextAction } from '../next-action.mjs';
import { DEFAULT_EMBEDDING_MODEL } from '../research/embed.mjs';
import { OPENROUTER_CHAT_COMPLETIONS_URL } from '../reason/sensitive-model.mjs';
import { createSubstrateStore } from '../substrate.mjs';
import {
  DEFAULT_CLUSTER_RESURFACE_GAP_DAYS,
  MIND_OUTPUT_DIR,
  MAX_CONVERSATION_CHARS,
  MAX_CONVERSATION_MESSAGES,
  boundLabel,
  localOllamaModelCall,
  resolveMindSynthesisModelCall,
  think,
} from './think.mjs';

const fixedNow = () => new Date('2026-06-28T06:07:08.000Z');
const FOUNDER_QUESTION = 'How should K convert repeated chat themes into one advisory build candidate?';
const ASSISTANT_NARRATION = 'The user wants me to turn their messages into an implementation plan.';
const FOUNDER_DECISION = 'I decided the queue must stay human-gated before K builds next.';
const FOUNDER_SPATIAL_IDEA = 'A spatial memory wall could reveal blind spots during planning.';
const DECISION_CARD_KEYS = [
  'asked',
  'assumed',
  'missing',
  'next',
  'pick',
  'read',
  'whatWouldChangeIt',
  'why',
];

test('conversation extraction groups by real conversation id and drops assistant turns structurally', async () => {
  const { dataDir, store, exposures } = await seededMindStore({ includeSpatialIdea: false });
  const calls = [];

  const result = await think({
    dataDir,
    store,
    now: fixedNow,
    modelCall: conversationModelCall(calls),
    embedder: fakeEmbedder,
    logger: quietLogger(),
    segmentOptions: { similarityThreshold: 0.85 },
  });

  const extractionCalls = calls.filter((request) => request.task === 'mind.extractConversationAtoms');
  assert.equal(extractionCalls.length, 1);
  const payload = JSON.parse(extractionCalls[0].user);

  assert.equal(payload.conversation.conversationId, 'mind-conversation');
  assert.deepEqual(
    payload.conversation.founderMessages.map((message) => message.id).sort(),
    [exposures.question.id, exposures.decision.id].sort(),
  );
  assert(!extractionCalls[0].user.includes(ASSISTANT_NARRATION));
  assert.equal(result.exposureCount, 3);
  assert.equal(result.founderExposureCount, 2);
  assert.equal(result.conversationCount, 1);
  assert.equal(result.atomCount, 2);
  assert.deepEqual(result.atoms.map((atom) => atom.type).sort(), ['decision', 'question']);
  assert(result.atoms.every((atom) => atom.conversationId === 'mind-conversation'));
  assert(result.atoms.every((atom) => atom.frontierExcluded === true));
  assert(result.atoms.every((atom) => atom.provenance.surface === 'mind'));
  assert(result.atoms.every((atom) => atom.dedupeKey.startsWith('IdeaAtom::mind-conversation::')));

  const questionAtom = result.atoms.find((atom) => atom.type === 'question');
  const decisionAtom = result.atoms.find((atom) => atom.type === 'decision');
  assert.deepEqual(questionAtom.evidenceIds, [exposures.question.id]);
  assert.deepEqual(decisionAtom.evidenceIds, [exposures.decision.id]);
  assert(Array.isArray(questionAtom.evidenceIds));
  assert(Array.isArray(decisionAtom.evidenceIds));

  const persisted = await dataFiles(dataDir, path.join('substrate', 'idea-atoms'));
  assert.equal(persisted.length, 2);
  assert(persisted.every((atom) => atom.frontierExcluded === true));
});

test('think prepends the hashed soul artifact to mind model prompts', async () => {
  const { dataDir, store } = await seededMindStore({ includeSpatialIdea: false });
  const calls = [];

  await think({
    dataDir,
    store,
    now: fixedNow,
    modelCall: conversationModelCall(calls),
    embedder: fakeEmbedder,
    logger: quietLogger(),
    segmentOptions: { similarityThreshold: 0.85 },
  });

  const modelRequests = calls.filter((request) => request.task?.startsWith('mind.'));
  assert(modelRequests.length > 0);
  for (const request of modelRequests) {
    assert.match(request.system, /## K soul document/);
    assert.match(request.system, /artifact: substrate\/soul\.md/);
    assert.match(request.system, /sha256: [a-f0-9]{64}/);
    assert.match(request.system, /# K soul/);
    assert.match(request.system, /You are K/);
  }
});

test('thin chat conversations yield silence instead of atoms', async () => {
  const { dataDir, store } = await seededThinStore();

  const result = await think({
    dataDir,
    store,
    now: fixedNow,
    modelCall: conversationModelCall(),
    embedder: fakeEmbedder,
    logger: quietLogger(),
  });

  assert.equal(result.exposureCount, 2);
  assert.equal(result.founderExposureCount, 1);
  assert.equal(result.conversationCount, 1);
  assert.equal(result.atomCount, 0);
  assertSilentOutputs(result);
  assert.deepEqual(await dataFiles(dataDir, path.join('substrate', 'idea-atoms')), []);
});

test('model-supplied idea atom labels are bounded before persistence', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-mind-label-cap-data-'));
  const store = createSubstrateStore({ dataDir, now: fixedNow });
  const secretLabel = 'SECRET_LABEL_SENTENCE_U4FIX this model label should not persist as a complete founder sentence';
  const exposure = await writeChatExposure(store, {
    statement: 'The model may try to copy a long founder sentence into the label.',
    sourceId: 'label-cap-1',
    eventAt: '2026-06-28T07:30:00.000Z',
    conversationId: 'label-cap-conversation',
    role: 'human',
    human: true,
    turnIndex: 0,
  });

  const result = await think({
    dataDir,
    store,
    now: fixedNow,
    modelCall: async (request) => {
      if (request.task === 'mind.divergentIdea') return {};
      return {
        atoms: [{
          label: secretLabel,
          statement: 'The model may try to copy a long founder sentence into the label.',
          type: 'idea',
          confidence: 0.72,
          evidenceIds: [exposure.id],
        }],
      };
    },
    embedder: fakeEmbedder,
    segment: async () => [],
    logger: quietLogger(),
  });
  const persisted = await dataFiles(dataDir, path.join('substrate', 'idea-atoms'));

  assert.equal(result.atoms[0].label, boundLabel(secretLabel));
  assert.equal(persisted[0].label, boundLabel(secretLabel));
  assert(!persisted[0].label.includes(secretLabel));
});

test('conversation-scoped IdeaAtom keys are idempotent on re-run', async () => {
  const { dataDir, store } = await seededMindStore({ includeSpatialIdea: false });
  const options = {
    dataDir,
    store,
    now: fixedNow,
    modelCall: conversationModelCall(),
    embedder: fakeEmbedder,
    logger: quietLogger(),
    segmentOptions: { similarityThreshold: 0.85 },
  };

  const first = await think(options);
  const firstAtoms = await dataFiles(dataDir, path.join('substrate', 'idea-atoms'));
  const second = await think(options);
  const secondAtoms = await dataFiles(dataDir, path.join('substrate', 'idea-atoms'));
  const secondIdeaMutations = second.mutations.filter((mutation) => mutation.kind === 'IdeaAtom');

  assert.equal(first.createdAtomCount, 2);
  assert.equal(second.createdAtomCount, 0);
  assert.equal(second.atomCount, first.atomCount);
  assert.equal(secondAtoms.length, firstAtoms.length);
  assert.equal(new Set(secondAtoms.map((atom) => atom.id)).size, secondAtoms.length);
  assert(secondAtoms.every((atom) => /^IdeaAtom::mind-conversation::[a-f0-9]{24}$/.test(atom.dedupeKey)));
  assert.equal(secondIdeaMutations.length, 2);
  assert(secondIdeaMutations.every((mutation) => mutation.op === 'deduped'));
});

test('re-running a changed conversation supersedes stale IdeaAtoms without duplicate live accumulation', async () => {
  const { dataDir, store } = await seededMindStore({ includeSpatialIdea: false });
  let extractionPass = 0;
  const modelCall = async (request) => {
    if (request.task === 'mind.divergentIdea') {
      return {
        statement: 'Review the refreshed mind atoms before staging a build candidate.',
        rationale: 'The refreshed extraction changed the atom wording.',
        confidence: 0.65,
      };
    }

    const payload = JSON.parse(request.user);
    const messages = payload.conversation.founderMessages;
    const rephrased = extractionPass > 0;
    extractionPass += 1;
    return {
      atoms: messages.flatMap((message) => {
        const lower = String(message.statement).toLowerCase();
        if (lower.includes('how should k convert')) {
          return [{
            label: rephrased ? 'Rephrased build candidate question' : 'Convert themes into build candidate',
            statement: rephrased
              ? 'K should compress repeated chat themes into one founder-reviewed build candidate.'
              : 'K needs a way to convert repeated chat themes into one advisory build candidate.',
            type: 'question',
            confidence: 0.82,
            evidenceIds: [message.id],
          }];
        }
        if (lower.includes('human-gated')) {
          return [{
            label: rephrased ? 'Rephrased human gate decision' : 'Keep the queue human-gated',
            statement: rephrased
              ? 'K must keep the next-build queue behind an explicit founder gate.'
              : 'The next-build queue must stay human-gated before K builds anything.',
            type: 'decision',
            confidence: 0.88,
            evidenceIds: [message.id],
          }];
        }
        return [];
      }),
    };
  };

  const options = {
    dataDir,
    store,
    now: fixedNow,
    modelCall,
    embedder: fakeEmbedder,
    logger: quietLogger(),
    segmentOptions: { similarityThreshold: 0.85 },
  };

  const first = await think(options);
  const firstIds = new Set(first.atoms.map((atom) => atom.id));
  const second = await think(options);
  const persistedAtoms = await dataFiles(dataDir, path.join('substrate', 'idea-atoms'));
  const retiredAtoms = persistedAtoms.filter((atom) => atom.validTo && atom.supersededById);
  const liveAtoms = persistedAtoms.filter((atom) => !atom.validTo && !atom.supersededById);
  const liveStatements = liveAtoms.map((atom) => atom.statement).sort();

  assert.equal(first.atomCount, 2);
  assert.equal(second.atomCount, 2);
  assert.equal(persistedAtoms.length, 4);
  assert.equal(liveAtoms.length, 2);
  assert.equal(retiredAtoms.length, 2);
  assert.deepEqual(new Set(retiredAtoms.map((atom) => atom.id)), firstIds);
  assert(retiredAtoms.every((atom) => liveAtoms.some((liveAtom) => liveAtom.id === atom.supersededById)));
  assert.deepEqual(liveStatements, [
    'K must keep the next-build queue behind an explicit founder gate.',
    'K should compress repeated chat themes into one founder-reviewed build candidate.',
  ].sort());
  assert.equal(new Set(liveAtoms.map((atom) => atom.id)).size, liveAtoms.length);
  assert(second.mutations.some((mutation) => mutation.op === 'superseded'));
});

test('idea clusters stage governed build/decide candidates without auto authority', async () => {
  const { dataDir, store } = await seededMindStore();

  const result = await think({
    dataDir,
    store,
    now: fixedNow,
    modelCall: conversationModelCall(),
    embedder: fakeEmbedder,
    clusterer: fixtureSidecarClusterer(),
    clusterMinConversations: 1,
    logger: quietLogger(),
    segmentOptions: { similarityThreshold: 0.85 },
  });

  assert(result.clusters.some((cluster) => cluster.atoms.length >= 2));
  assert(result.candidates.length >= 1);
  assert.equal(result.outputs.build_decide.length, result.candidates.length);

  const candidate = result.candidates[0];
  assert.equal(candidate.kind, 'MindCandidate');
  assert.equal(candidate.advisoryOnly, true);
  assert.equal(candidate.frontierExcluded, true);
  assert.equal(candidate.provenance.surface, 'mind');
  assert.equal(candidate.criterion.governed, true);
  assert.equal(candidate.criterion.actionable, true);
  assert.match(candidate.nextAction.target, /\b(build|execute|decide|draft|review)\b/i);
  assert.equal(candidate.nextAction.kind, 'NextAction');
  assert(['[gate:human]', '[advise]'].includes(candidate.nextAction.tag));
  assert.notEqual(candidate.nextAction.tag, '[auto]');

  const decisions = await dataFiles(dataDir, 'decisions');
  assert.equal(decisions.length, result.candidates.length);
  assert(decisions.every((decision) => decision.kind === 'LoopRecommendation'));
  assert(decisions.every((decision) => decision.advisoryOnly === true));
  assert(decisions.every((decision) => decision.acted === 'pending'));
  assert(decisions.every((decision) => decision.frontierExcluded === true));
  assert(decisions.every((decision) => decision.provenance.surface === 'mind'));
  assert(decisions.every((decision) => decision.tag !== '[auto]'));
});

test('mind-candidate decisions supersede prior live mind candidates per run only', async () => {
  const { dataDir, store } = await seededMindStore();
  await seedDecisionRecord(dataDir, 'prior-mind-candidate', {
    kind: 'LoopRecommendation',
    schemaVersion: 1,
    station: 'decide',
    verdict: 'recommend',
    acted: 'pending',
    advisoryOnly: true,
    source: 'mind',
    clusterId: 'cluster_prior',
    decision: 'Retire the stale mind candidate.',
    recommended: 'Review only the latest mind candidate.',
    reason: 'Prior private mind rationale.',
    reversibility: 'internal-revertible',
    tag: '[advise]',
    evidenceIds: [],
    confidence: 0.5,
    frontierExcluded: true,
    provenance: { surface: 'mind', lane: 'deliberate' },
    createdAt: '2026-06-27T00:00:00.000Z',
  });
  await seedDecisionRecord(dataDir, 'body-protocol-candidate', {
    kind: 'LoopRecommendation',
    schemaVersion: 1,
    station: 'decide',
    verdict: 'recommend',
    acted: 'pending',
    advisoryOnly: true,
    surface: 'body',
    recommendationKind: 'body-protocol',
    decision: 'Keep the body protocol live.',
    recommended: 'Review the body protocol.',
    reason: 'Body protocol rationale.',
    reversibility: 'internal-revertible',
    tag: '[advise]',
    evidenceIds: [],
    confidence: 0.5,
    createdAt: '2026-06-27T00:00:00.000Z',
  });

  const result = await think({
    dataDir,
    store,
    now: fixedNow,
    modelCall: decisionCardModelCall(),
    embedder: fakeEmbedder,
    clusterer: fixtureSidecarClusterer(),
    clusterMinConversations: 1,
    logger: quietLogger(),
    segmentOptions: { similarityThreshold: 0.85 },
  });
  const decisions = await dataFiles(dataDir, 'decisions');
  const priorMind = decisions.find((decision) => decision.decision === 'Retire the stale mind candidate.');
  const bodyProtocol = decisions.find((decision) => decision.decision === 'Keep the body protocol live.');
  const liveMind = decisions.filter((decision) =>
    decision.kind === 'LoopRecommendation' &&
    decision.station === 'decide' &&
    decision.provenance?.surface === 'mind' &&
    !decision.validTo &&
    !decision.supersededById);
  const projected = await mindArtifacts({ dataDir, now: fixedNow });

  assert.equal(result.candidates.length, 1);
  assert(priorMind.validTo);
  assert.equal(typeof priorMind.supersededById, 'string');
  assert.equal(bodyProtocol.validTo, undefined);
  assert.equal(bodyProtocol.supersededById, undefined);
  assert.equal(liveMind.length, result.candidates.length);
  assert(liveMind.every((decision) => decision.frontierExcluded === true));
  assert(result.mutations.some((mutation) => mutation.op === 'superseded' && mutation.kind === 'LoopRecommendation'));
  assert.equal(projected.build_decide.length, result.candidates.length);
  assert(!JSON.stringify(projected).includes('Retire the stale mind candidate.'));
});

test('mind candidates carry a synthesized 8-field decision card when model synthesis succeeds', async () => {
  const { dataDir, store } = await seededMindStore();
  const calls = [];

  const result = await think({
    dataDir,
    store,
    now: fixedNow,
    modelCall: decisionCardModelCall(calls),
    embedder: fakeEmbedder,
    clusterer: fixtureSidecarClusterer(),
    clusterMinConversations: 1,
    logger: quietLogger(),
    segmentOptions: { similarityThreshold: 0.85 },
  });
  const candidate = result.candidates[0];
  const packet = result.outputs.build_decide[0];
  const decisions = await dataFiles(dataDir, 'decisions');
  const cardCalls = calls.filter((request) => request.task === 'mind.decisionCard');

  assert(candidate);
  assert.equal(validateViewPacket(packet), packet);
  assert.equal(packet.viewType, 'k0.decision');
  assert.equal(packet.frontierExcluded, true);
  assert.deepEqual(Object.keys(packet.fields.decisionCard).sort(), DECISION_CARD_KEYS);
  assert.deepEqual(
    DECISION_CARD_KEYS.map((key) => [key, packet.fields[key]]),
    DECISION_CARD_KEYS.map((key) => [key, candidate.decisionCard[key]]),
  );
  assert.deepEqual(Object.keys(candidate.decisionCard).sort(), DECISION_CARD_KEYS);
  assert.deepEqual(Object.keys(candidate.output.decisionCard).sort(), DECISION_CARD_KEYS);
  assert.deepEqual(Object.keys(decisions[0].decisionCard).sort(), DECISION_CARD_KEYS);
  assert.equal(cardCalls.length, result.candidates.length);
  assert.equal(cardCalls[0].responseFormat, 'json');
  assert(cardCalls[0].responseSchema);
  assert.equal(cardCalls[0].sensitivity, 'private-chat-or-bookmark');
  assert(!candidate.decisionCard.why.includes('K needs a way to convert repeated chat themes into one advisory build candidate.'));
  assert(decisions[0].source === 'mind');
  assert(decisions[0].clusterId);
  assert(decisions[0].atomIds.length >= 2);
});

test('mind decision-card synthesis failure degrades to the current candidate shape', async () => {
  const { dataDir, store } = await seededMindStore();

  const result = await think({
    dataDir,
    store,
    now: fixedNow,
    modelCall: decisionCardModelCall([], { failDecisionCard: true }),
    embedder: fakeEmbedder,
    clusterer: fixtureSidecarClusterer(),
    clusterMinConversations: 1,
    logger: quietLogger(),
    segmentOptions: { similarityThreshold: 0.85 },
  });
  const decisions = await dataFiles(dataDir, 'decisions');

  assert.equal(result.candidates.length, 1);
  assert(!Object.hasOwn(result.candidates[0], 'decisionCard'));
  assert(!Object.hasOwn(result.candidates[0].output, 'decisionCard'));
  assert(!Object.hasOwn(decisions[0], 'decisionCard'));
  assert(result.notes.some((note) => /mind decision card skipped/i.test(note)));
});

test('U4: low-coherence clusters escalate to the deliberation loop for the decision card', async () => {
  const { dataDir, store } = await seededMindStore();
  const calls = [];
  let deliberations = 0;

  const result = await think({
    dataDir,
    store,
    now: fixedNow,
    modelCall: decisionCardModelCall(calls),
    embedder: fakeEmbedder,
    clusterer: fixtureSidecarClusterer(),
    clusterMinConversations: 1,
    logger: quietLogger(),
    segmentOptions: { similarityThreshold: 0.85 },
    deliberateLowConfidence: true,
    deliberationCoherenceThreshold: 2, // any cluster counts as "low" → eligible
    singleCall: () => {},              // truthy fn satisfies the escalation gate
    runDeliberation: async ({ question }) => {
      deliberations += 1;
      return {
        mode: 'deliberated',
        decisionCard: {
          asked: `Deliberated: ${question}`,
          read: 'Deliberated read of the evidence.',
          assumed: 'Deliberated assumption.',
          missing: ['first gap', 'second gap'], // array → joined by the mapper
          pick: 'Deliberated pick.',
          why: 'Deliberated rationale distinct from the single-call card.',
          whatWouldChangeIt: 'Deliberated disconfirmer.',
          next: 'Deliberated next action.',
        },
      };
    },
  });

  const candidate = result.candidates[0];
  const cardCalls = calls.filter((request) => request.task === 'mind.decisionCard');

  assert(candidate);
  assert(deliberations >= 1);
  assert.deepEqual(Object.keys(candidate.decisionCard).sort(), DECISION_CARD_KEYS);
  assert.match(candidate.decisionCard.why, /Deliberated rationale/);
  assert.equal(candidate.decisionCard.missing, 'first gap; second gap');
  // The single-call decision-card synthesis was NOT used — deliberation replaced it.
  assert.equal(cardCalls.length, 0);
});

test('U4: deliberation escalation respects the per-run budget cap', async () => {
  const { dataDir, store } = await seededMindStore();
  const calls = [];
  let deliberations = 0;

  const result = await think({
    dataDir,
    store,
    now: fixedNow,
    modelCall: decisionCardModelCall(calls),
    embedder: fakeEmbedder,
    clusterer: fixtureSidecarClusterer(),
    clusterMinConversations: 1,
    logger: quietLogger(),
    segmentOptions: { similarityThreshold: 0.85 },
    deliberateLowConfidence: true,
    deliberationCoherenceThreshold: 2,
    maxDeliberations: 0, // budget exhausted before the first cluster
    singleCall: () => {},
    runDeliberation: async () => {
      deliberations += 1;
      throw new Error('deliberation must not run when the budget is zero');
    },
  });

  const cardCalls = calls.filter((request) => request.task === 'mind.decisionCard');
  assert.equal(deliberations, 0);
  // Falls back to the single-call synthesis for every candidate.
  assert.equal(cardCalls.length, result.candidates.length);
  assert(result.candidates.length >= 1);
});

test('U4: a declined deliberation falls back to the single-call decision card', async () => {
  const { dataDir, store } = await seededMindStore();
  const calls = [];

  const result = await think({
    dataDir,
    store,
    now: fixedNow,
    modelCall: decisionCardModelCall(calls),
    embedder: fakeEmbedder,
    clusterer: fixtureSidecarClusterer(),
    clusterMinConversations: 1,
    logger: quietLogger(),
    segmentOptions: { similarityThreshold: 0.85 },
    deliberateLowConfidence: true,
    deliberationCoherenceThreshold: 2,
    singleCall: () => {},
    runDeliberation: async () => ({ mode: 'single' }), // stakes gate declined
  });

  const candidate = result.candidates[0];
  const cardCalls = calls.filter((request) => request.task === 'mind.decisionCard');
  assert(candidate);
  assert.deepEqual(Object.keys(candidate.decisionCard).sort(), DECISION_CARD_KEYS);
  assert(cardCalls.length >= 1); // single-call path used after the decline
});

test('projected mind output items expose statement evidence next action and siblings', async () => {
  const { result } = await runDetectorFixture([
    {
      label: 'Cancer concern',
      statement: 'Cancer concern needs a concrete health review thread.',
      sourceId: 'protocol-cancer-a',
      eventAt: '2026-06-20T10:00:00.000Z',
      conversationId: 'protocol-cancer-a',
    },
    {
      label: 'Smoking risk',
      statement: 'Smoking risk belongs beside the cancer concern instead of a separate list item.',
      sourceId: 'protocol-smoking-b',
      eventAt: '2026-06-21T10:00:00.000Z',
      conversationId: 'protocol-smoking-b',
    },
    {
      label: 'Health review',
      statement: 'The health review should turn the risk thread into one next action.',
      sourceId: 'protocol-health-c',
      eventAt: '2026-06-22T10:00:00.000Z',
      conversationId: 'protocol-health-c',
    },
  ], {
    clusterer: async (atomDocs) => ({
      leafClusters: [{
        clusterId: 'cluster_001',
        atomIds: atomDocs.map((doc) => doc.id),
        representativeAtomId: atomDocs[0].id,
        label: 'cancer smoking health risk',
        keywords: ['cancer', 'smoking', 'health', 'risk'],
      }],
      parentThemes: [],
      resurfaced: [],
      newIdeaBridges: [],
      noiseAtomIds: [],
    }),
  });

  const item = result.outputs.build_decide[0];

  assert(item);
  assert.equal(validateViewPacket(item), item);
  assert.equal(item.viewType, 'k0.decision');
  assert.equal(typeof item.text, 'string');
  assert.equal(
    item.text,
    "cancer smoking health risk is ready for a decision — 6 pieces of evidence staged. what's the next reversible step?",
  );
  assert.doesNotMatch(item.text, /\b(?:state|context|observation|consider):/);
  assert(item.evidence.length >= 3);
  assert(item.fields.evidenceIds.length >= 3);
  assert.equal(typeof item.fields.nextAction, 'string');
  assert.match(item.fields.nextAction, /\b(build|execute|decide|draft|review)\b/i);
  assert.deepEqual(item.action, {
    kind: 'next_action',
    target: item.fields.nextAction,
  });
  assert(item.fields.siblings.length >= 2);
  assert(item.fields.siblings.every((sibling) => sibling.atomId && sibling.statement));
});

test('build/decide candidate text is bounded when atom statements contain long founder sentences', async () => {
  const secretDecision = 'SECRET_DECISION_SENTENCE founder said this entire raw planning sentence must never cross the bounded mind wire';
  const { dataDir, result } = await runDetectorFixture([
    {
      statement: secretDecision,
      atomType: 'question',
      sourceId: 'candidate-secret-a',
      eventAt: '2026-06-28T08:00:00.000Z',
      conversationId: 'candidate-secret-a',
    },
    {
      statement: 'A companion atom keeps the cluster eligible for a build decide candidate.',
      sourceId: 'candidate-secret-b',
      eventAt: '2026-06-28T08:01:00.000Z',
      conversationId: 'candidate-secret-b',
    },
  ], {
    embedder: constantDetectorEmbedder,
    segment: async (exposures) => [{
      threadId: 'candidate-secret-cluster',
      theme: 'Untitled Idea Cluster',
      exposureIds: exposures.map((exposure) => exposure.id),
      window: {},
    }],
  });
  const decisions = await dataFiles(dataDir, 'decisions');

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].output.recommendation.decision, boundLabel(secretDecision));
  assert.equal(decisions[0].decision, boundLabel(secretDecision));
  assert(decisions[0].recommended.length <= 80);
  assert(decisions[0].recommended.split(/\s+/).length <= 8);
  assert(!JSON.stringify(decisions).includes(secretDecision));
});

test('a single weak cluster does not pass the build/decide criterion', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-mind-weak-data-'));
  const store = createSubstrateStore({ dataDir, now: fixedNow });

  await writeChatExposure(store, {
    statement: 'A small sidebar idea might be useful someday.',
    sourceId: 'weak-idea-1',
    eventAt: '2026-06-28T06:10:00.000Z',
    conversationId: 'weak-conversation',
    role: 'human',
    human: true,
    turnIndex: 0,
  });

  const result = await think({
    dataDir,
    store,
    now: fixedNow,
    modelCall: async (request) => {
      if (request.task === 'mind.divergentIdea') return {};
      const payload = JSON.parse(request.user);
      return {
        atoms: [{
          label: 'Small sidebar idea',
          statement: 'A small sidebar idea might be useful someday.',
          type: 'idea',
          confidence: 0.51,
          evidenceIds: [payload.conversation.founderMessages[0].id],
        }],
      };
    },
    embedder: fakeEmbedder,
    logger: quietLogger(),
    segmentOptions: { similarityThreshold: 0.85 },
  });

  assert.equal(result.atomCount, 1);
  assert.equal(result.candidateCount, 0);
  assertSilentOutputs(result);
  assert.deepEqual(await dataFiles(dataDir, 'decisions'), []);
});

test('divergent mode uses founder-only evidence through injected modelCall', async () => {
  const { dataDir, store, exposures } = await seededMindStore();
  const calls = [];

  const result = await think({
    dataDir,
    store,
    now: fixedNow,
    modelCall: conversationModelCall(calls),
    embedder: fakeEmbedder,
    clusterer: fixtureSidecarClusterer({ bridges: true }),
    clusterMinConversations: 1,
    logger: quietLogger(),
    segmentOptions: { similarityThreshold: 0.85 },
  });

  const divergentCall = calls.find((request) => request.task === 'mind.divergentIdea');
  assert(divergentCall);
  assert(!divergentCall.user.includes(ASSISTANT_NARRATION));
  assert.equal(result.divergentIdeaCount, 1);
  assert.equal(result.divergentIdeas.length, 1);
  assert.equal(result.divergentIdeas[0].kind, 'DivergentIdea');
  assert.equal(result.divergentIdeas[0].advisoryOnly, true);
  assert.equal(result.divergentIdeas[0].noveltySatisfied, true);
  assert.equal(result.divergentIdeas[0].connectsPreviouslyUnconnectedThreads, true);
  assert(result.divergentIdeas[0].sourceThreadIds.length >= 2);
  assert(result.divergentIdeas[0].connectedAtomIds.length >= 2);
  assert.equal(result.outputs.new_ideas.length, 1);
  assert.match(result.divergentIdeas[0].statement, /quiet review queue/i);
  assert(result.divergentIdeas[0].evidenceIds.includes(exposures.spatial.id));
  assert.notEqual(result.divergentIdeas[0].nextAction.tag, '[auto]');
});

test('semantic detectors fold open loops into parent themes beyond 24h segmentation', async () => {
  const { dataDir, store } = await seededU4cStore();

  const result = await think({
    dataDir,
    store,
    now: fixedNow,
    modelCall: u4cModelCall(),
    embedder: u4cEmbedder,
    clusterer: fixtureSidecarClusterer(),
    logger: quietLogger(),
    segmentOptions: { similarityThreshold: 0.95 },
  });

  const theme = result.themesOpenLoops.find((output) => output.kind === 'MindTheme');
  assert(theme);
  assert.equal(theme.outputType, 'themes_open_loops');
  assert.equal(theme.frontierExcluded, true);
  assert(theme.atomIds.length >= 3);
  assert(theme.conversationIds.length >= 2);
  assert.equal(theme.criteria.minAtoms, 3);
  assert.equal(theme.criteria.minConversations, 2);
  assert.equal(theme.openLoop, true);
  assert(Array.isArray(theme.openAtomIds));
  assert(theme.openAtomIds.length >= 1);
  assert.equal(theme.observation, 'Artifact review keeps returning as one durable operating concern.');
  assert(theme.considerations.length >= 2);
  assert(theme.considerations.every((entry) => entry.length <= 180));
  const openMemberLabels = theme.openAtomIds
    .map((id) => result.atoms.find((atom) => atom.id === id)?.label)
    .filter(Boolean);
  assert(openMemberLabels.includes('Preserve dropped idea question'));
  assert.equal(result.themesOpenLoops.filter((output) => output.kind === 'MindOpenLoop').length, 0);
  assert.equal(result.outputs.themes_open_loops.length, result.themesOpenLoops.length);
  assert.equal(result.themesOpenLoops.length, 1);
  assert(result.themesOpenLoops.length < result.atoms.length);
  const themePacket = result.outputs.themes_open_loops[0];
  assert.equal(validateViewPacket(themePacket), themePacket);
  assert.equal(themePacket.viewType, 'loop.evidence');
  assert.equal(themePacket.frontierExcluded, true);
  assert.equal(themePacket.fields.openLoop, true);
  assert.deepEqual(themePacket.fields.openAtomIds, theme.openAtomIds);
  assert.equal(themePacket.fields.observation, theme.observation.slice(0, 80));
  assert(themePacket.fields.considerations.every((entry) => entry.length <= 80));

  assert(result.clusters.some((cluster) =>
    cluster.atoms.length >= 2 &&
    cluster.atoms.every((atom) => /recurring artifact theme/i.test(atom.label))));

  const resurfaced = result.resurfacedIdeas.find((output) => output.kind === 'MindResurfacedIdea');
  assert(resurfaced);
  assert.equal(resurfaced.outputType, 'resurfaced');
  assert.equal(resurfaced.frontierExcluded, true);
  assert(resurfaced.criteria.observedQuietGapDays > DEFAULT_CLUSTER_RESURFACE_GAP_DAYS);
  assert(resurfaced.conversationIds.includes('dormant-start'));
  assert(resurfaced.conversationIds.includes('dormant-recent'));
});

test('single-conversation tool-artifact clusters are dropped before candidates and resurfaced', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-mind-convgate-'));
  const store = createSubstrateStore({ dataDir, now: fixedNow });

  // Cluster A: same statement across TWO distinct conversations — real recurring
  // founder thinking. Cluster B: two atoms confined to ONE conversation — a
  // tool-artifact (e.g. a pasted list echoed back), which must not reach outputs.
  const seed = [
    { statement: 'K should stage a durable build candidate for the review queue.', sourceId: 'gate-a1', conversationId: 'gate-conv-1', eventAt: '2026-06-20T10:00:00.000Z' },
    { statement: 'K should stage a durable build candidate for the review queue.', sourceId: 'gate-a2', conversationId: 'gate-conv-2', eventAt: '2026-06-21T10:00:00.000Z' },
    { statement: 'links fetch url supported block device artifact.', sourceId: 'gate-b1', conversationId: 'gate-conv-artifact', eventAt: '2026-06-22T10:00:00.000Z' },
    { statement: 'links fetch url supported block device artifact.', sourceId: 'gate-b2', conversationId: 'gate-conv-artifact', eventAt: '2026-06-23T10:00:00.000Z' },
  ];
  for (const [index, entry] of seed.entries()) {
    await writeChatExposure(store, { ...entry, role: 'human', human: true, turnIndex: index });
  }

  const embedder = async (prompt) => /links fetch url/i.test(prompt) ? [0, 1] : [1, 0];
  const clusterer = async (atomDocs) => {
    const groups = new Map();
    for (const doc of atomDocs) {
      const key = /links fetch url/i.test(doc.atom.statement) ? 'artifact' : 'durable';
      (groups.get(key) ?? groups.set(key, []).get(key)).push(doc);
    }
    const leafClusters = Array.from(groups.entries()).map(([key, docs], index) => ({
      clusterId: `cluster_${String(index + 1).padStart(3, '0')}`,
      atomIds: docs.map((doc) => doc.id),
      representativeAtomId: docs[0].id,
      keywords: key === 'artifact' ? ['links', 'fetch', 'url'] : ['durable', 'build', 'candidate'],
    }));
    return { leafClusters, parentThemes: [], resurfaced: [], newIdeaBridges: [], noiseAtomIds: [] };
  };

  // Emit one atom per founder message, echoing its statement (the extraction is
  // not under test here — the conversation gate is).
  const modelCall = async (request) => {
    if (request.task === 'mind.divergentIdea') return {};
    if (request.task === 'mind.themeSummary') {
      return {
        summary: 'Durable build candidate theme.',
        observation: 'The durable build lane needs one gated execution surface.',
        considerations: [
          'Separate artifact noise from durable build intent.',
          'Keep the next step reversible and founder-gated.',
        ],
        confidence: 0.7,
      };
    }
    const payload = JSON.parse(request.user);
    return {
      atoms: (payload.conversation.founderMessages ?? []).map((message) => ({
        label: 'seed atom',
        statement: message.statement,
        type: 'idea',
        confidence: 0.8,
        evidenceIds: [message.id],
      })),
    };
  };

  const result = await think({
    dataDir,
    store,
    now: fixedNow,
    modelCall,
    embedder,
    clusterer,
    segment: async () => [],
    logger: quietLogger(),
  });

  const clusterIds = result.clusters.map((cluster) => cluster.clusterId);
  const artifactCluster = result.clusters.find((cluster) =>
    cluster.atoms.some((atom) => /links fetch url/i.test(atom.statement)));
  assert.equal(artifactCluster, undefined, 'single-conversation artifact cluster must be dropped');
  assert(result.clusters.length >= 1, 'the two-conversation durable cluster survives');
  assert(result.clusters.every((cluster) => cluster.conversationIds.length >= 2));
  assert(!JSON.stringify(result.outputs).match(/links fetch url/i));
  assert(clusterIds.length >= 1);
});

test('boundLabel and generated lines strip narration scaffolding from wire labels', () => {
  assert.equal(boundLabel('The user is asking about the build plan'), 'the build plan');
  assert.equal(boundLabel('pocket notebook idea or something similar'), 'pocket notebook idea');
  assert.equal(boundLabel('The user wants a spatial memory wall'), 'a spatial memory wall');
  // Broadened narration family observed on real bridge labels.
  assert(!/the user is/i.test(boundLabel('The user is making a sharp observation')));
  assert(!/the user is/i.test(boundLabel('The user is pointing to something profound')));
  assert(!/the user is/i.test(boundLabel('The user is providing answers to my questions')));
  // A distilled keyword label is untouched.
  assert.equal(boundLabel('spatial memory wall planning blind-spots'), 'spatial memory wall planning blind-spots');
  // Scaffolding-only input degrades to the bounded fallback, never leaks the phrase.
  assert(!/the user is asking/i.test(boundLabel('The user is asking')));
});

test('semantic output groups persist as bi-temporal mind-output records without live duplication', async () => {
  const { dataDir, store } = await seededU4cStore();
  const calls = [];
  let pass = 0;
  const options = {
    dataDir,
    store,
    now: fixedNow,
    modelCall: semanticOutputPersistenceModelCall(calls, () => pass),
    nameModelCall: semanticOutputNameModelCall(calls),
    embedder: u4cEmbedder,
    clusterer: fixtureSidecarClusterer({ bridges: true }),
    logger: quietLogger(),
    segmentOptions: { similarityThreshold: 0.95 },
  };

  const first = await think(options);
  const firstPersistedAtoms = await dataFiles(dataDir, path.join('substrate', 'idea-atoms'));
  const firstPersistedOutputs = await dataFiles(dataDir, MIND_OUTPUT_DIR);
  const firstOutputRecords = liveMindOutputs(firstPersistedOutputs);
  const firstOutputMutationIds = new Set(first.mutations
    .filter((mutation) => ['MindTheme', 'MindResurfacedIdea', 'DivergentIdea'].includes(mutation.kind))
    .map((mutation) => mutation.id));

  assert(firstPersistedAtoms.every((atom) => !Array.isArray(atom.outputGroups) || atom.outputGroups.length === 0));
  assert(first.themesOpenLoops.some((output) => output.kind === 'MindTheme'));
  assert.equal(first.themesOpenLoops.filter((output) => output.kind === 'MindOpenLoop').length, 0);
  const firstTheme = first.themesOpenLoops.find((output) => output.kind === 'MindTheme');
  assert.equal(firstTheme.observation, 'Artifact review and review-surface design belong in one theme.');
  assert.deepEqual(firstTheme.considerations, [
    'Keep the recurring artifact theme distinct from bridge generation.',
    'Preserve resurfaced notebook evidence as supporting context.',
  ]);
  assert.equal(firstTheme.openLoop, true);
  assert(firstTheme.openAtomIds.length >= 1);
  assert(first.resurfacedIdeas.length > 0);
  assert.equal(first.divergentIdeas.length, 1);
  assert(calls.some((request) => request.task === 'mind.divergentIdea'));
  const themeSummaryCall = calls.find((request) => request.task === 'mind.themeSummary');
  assert(themeSummaryCall);
  const themeSummaryPayload = JSON.parse(themeSummaryCall.user);
  assert(Array.isArray(themeSummaryPayload.keywords));
  assert(Array.isArray(themeSummaryPayload.atoms));
  assert(themeSummaryPayload.atoms.length > 0);
  assert.equal(firstOutputRecords.themes_open_loops.filter((record) => record.kind === 'MindTheme').length, 1);
  assert.equal(firstOutputRecords.resurfaced.length, first.resurfacedIdeas.length);
  assert.equal(firstOutputRecords.new_ideas.length, first.divergentIdeas.length);
  assert([...Object.values(firstOutputRecords).flat()].every((record) => firstOutputMutationIds.has(record.outputId)));
  assert.equal(firstOutputRecords.themes_open_loops[0].outputGroup, 'themes_open_loops');
  assert.equal(firstOutputRecords.resurfaced[0].outputGroup, 'resurfaced');
  assert.equal(firstOutputRecords.new_ideas[0].outputGroup, 'new_ideas');
  assert(firstOutputRecords.themes_open_loops.every((record) => record.label === boundLabel(record.label)));
  assert.equal(first.outputs.themes_open_loops[0].fields.label, 'artifact review loop');
  assert.equal(firstOutputRecords.themes_open_loops[0].label, 'artifact review loop');
  assert.equal(firstOutputRecords.themes_open_loops[0].observation, firstTheme.observation);
  assert.deepEqual(firstOutputRecords.themes_open_loops[0].considerations, firstTheme.considerations);
  assert.equal(firstOutputRecords.themes_open_loops[0].openLoop, true);
  assert.deepEqual(firstOutputRecords.themes_open_loops[0].openAtomIds, firstTheme.openAtomIds);
  assert.deepEqual(firstOutputRecords.themes_open_loops[0].atomIds, firstTheme.atomIds);
  assert.equal(firstOutputRecords.themes_open_loops[0].frontierExcluded, true);
  assert.equal(firstOutputRecords.themes_open_loops[0].generatedAt, fixedNow().toISOString());
  assert(firstOutputRecords.resurfaced.every((record) => record.label === boundLabel(record.label)));
  assert(firstOutputRecords.new_ideas.every((record) => record.label === boundLabel(record.label)));
  assert.equal(firstOutputRecords.new_ideas[0].label, 'artifact notebook bridge');
  assert.equal(first.outputs.new_ideas[0].fields.label, 'artifact notebook bridge');
  assert.equal(firstOutputRecords.new_ideas[0].observation, 'The sidecar bridge connects a recurring theme cluster to a resurfaced dormant idea.');

  pass = 1;
  calls.length = 0;
  const second = await think(options);
  const secondPersistedOutputs = await dataFiles(dataDir, MIND_OUTPUT_DIR);
  const secondOutputRecords = liveMindOutputs(secondPersistedOutputs);
  const retiredOutputRecords = secondPersistedOutputs.filter((record) =>
    record.validTo &&
    record.supersededById);

  assert(calls.some((request) => request.task === 'mind.divergentIdea'));
  assert.equal(secondOutputRecords.themes_open_loops.filter((record) => record.kind === 'MindTheme').length, 1);
  assert.equal(secondOutputRecords.resurfaced.length, second.resurfacedIdeas.length);
  assert.equal(secondOutputRecords.new_ideas.length, second.divergentIdeas.length);
  assert(second.mutations.some((mutation) => mutation.op === 'superseded'));
  assert(retiredOutputRecords.length > 0);
  assert(retiredOutputRecords.every((record) =>
    [...Object.values(secondOutputRecords).flat()].some((liveRecord) => liveRecord.outputId === record.supersededById)));

  const contradictions = await contradictionRecords(dataDir);
  const themeChange = contradictions.find((record) =>
    record.claimId.startsWith('mind-output:themes_open_loops:') &&
    record.previous.includes('Artifact review and review-surface design') &&
    record.current.includes('refreshed review surface'));
  assert(themeChange);
  assert.equal(themeChange.changedAt, fixedNow().toISOString());
  assert.match(themeChange.reason, /K must explain/);
});

test('mind output glaze detector persists and projects sycophancy markers', async () => {
  const { dataDir, store } = await seededU4cStore();
  const calls = [];

  const result = await think({
    dataDir,
    store,
    now: fixedNow,
    modelCall: glazeOutputModelCall(calls),
    embedder: u4cEmbedder,
    clusterer: fixtureSidecarClusterer({ bridges: true }),
    logger: quietLogger(),
    segmentOptions: { similarityThreshold: 0.95 },
  });
  const persisted = await dataFiles(dataDir, MIND_OUTPUT_DIR);
  const glazedRecord = persisted.find((record) =>
    record.outputGroup === 'themes_open_loops' && record.glaze);
  const projectedTheme = result.outputs.themes_open_loops.find((packet) => packet.fields.glaze);
  const projectedArtifacts = await mindArtifacts({ dataDir, now: fixedNow });
  const artifactTheme = projectedArtifacts.themes_open_loops.find((packet) => packet.fields.glaze);

  assert(glazedRecord);
  assert(glazedRecord.glaze.score > 0.5);
  assert(glazedRecord.glaze.hits.includes('superlative praise'));
  assert(projectedTheme);
  assert(projectedTheme.fields.glaze.hits.includes('superlative praise'));
  assert(artifactTheme);
  assert.deepEqual(artifactTheme.fields.glaze, glazedRecord.glaze);
});

test('cluster sidecar null silences semantic outputs without crashing', async () => {
  const { result } = await runDetectorFixture([
    {
      label: 'Null sidecar theme',
      statement: 'A null sidecar theme starts here.',
      sourceId: 'null-sidecar-a',
      eventAt: '2026-06-20T10:00:00.000Z',
      conversationId: 'null-sidecar-a',
    },
    {
      label: 'Null sidecar theme',
      statement: 'A null sidecar theme repeats here.',
      sourceId: 'null-sidecar-b',
      eventAt: '2026-06-21T10:00:00.000Z',
      conversationId: 'null-sidecar-b',
    },
    {
      label: 'Null sidecar theme',
      statement: 'How should the null sidecar theme be handled?',
      atomType: 'question',
      sourceId: 'null-sidecar-c',
      eventAt: '2026-06-22T10:00:00.000Z',
      conversationId: 'null-sidecar-c',
    },
  ], {
    clusterer: async () => null,
  });

  assert.equal(result.atomCount, 3);
  assertSilentOutputs(result);
});

test('sidecar noise atoms are excluded from all mind outputs', async () => {
  const { result } = await runDetectorFixture([
    {
      label: 'Durable clustered theme',
      statement: 'The durable clustered theme starts here.',
      sourceId: 'noise-cluster-a',
      eventAt: '2026-06-20T10:00:00.000Z',
      conversationId: 'noise-cluster-a',
    },
    {
      label: 'Durable clustered theme',
      statement: 'The durable clustered theme repeats here.',
      sourceId: 'noise-cluster-b',
      eventAt: '2026-06-21T10:00:00.000Z',
      conversationId: 'noise-cluster-b',
    },
    {
      label: 'Durable clustered theme',
      statement: 'The durable clustered theme gets a third atom.',
      sourceId: 'noise-cluster-c',
      eventAt: '2026-06-22T10:00:00.000Z',
      conversationId: 'noise-cluster-c',
    },
    {
      label: 'Noise open loop',
      statement: 'How should a noise-only atom avoid every output?',
      atomType: 'question',
      sourceId: 'noise-sidecar-only',
      eventAt: '2026-06-23T10:00:00.000Z',
      conversationId: 'noise-sidecar-only',
    },
  ], {
    embedder: async (prompt) => prompt.toLowerCase().includes('noise-only')
      ? [0, 1, 0, 0]
      : [1, 0, 0, 0],
    clusterer: async (atomDocs) => {
      const noiseAtomIds = atomDocs
        .filter((doc) => /noise-only/i.test(doc.atom.statement))
        .map((doc) => doc.id);
      return fixtureSidecarClusterer({ noiseAtomIds })(atomDocs);
    },
  });

  const noiseAtom = result.atoms.find((atom) => /noise-only/i.test(atom.statement));
  assert(noiseAtom);
  assert(!JSON.stringify(result.outputs).includes(noiseAtom.id));
  assert(result.clusters.every((cluster) => !cluster.atomIds.includes(noiseAtom.id)));
});

test('open-loops are suppressed only when a later closure really matches', async () => {
  const { result } = await runDetectorFixture([
    {
      label: 'Cosine closure question',
      statement: 'How should K close the cosine closure lane?',
      atomType: 'question',
      sourceId: 'closure-cosine-open',
      eventAt: '2026-06-20T10:00:00.000Z',
      conversationId: 'closure-cosine-open',
    },
    {
      label: 'Cosine closure decision',
      statement: 'I decided the cosine closure lane will be closed.',
      atomType: 'decision',
      sourceId: 'closure-cosine-decision',
      eventAt: '2026-06-20T10:01:00.000Z',
      conversationId: 'closure-cosine-decision',
    },
    {
      label: 'Atlas beacon question',
      statement: 'How should atlas beacon choose staging?',
      atomType: 'question',
      sourceId: 'closure-token-open',
      eventAt: '2026-06-20T10:02:00.000Z',
      conversationId: 'closure-token-conversation',
    },
    {
      label: 'Atlas beacon decision',
      statement: 'I decided atlas beacon choose staging now.',
      atomType: 'decision',
      sourceId: 'closure-token-decision',
      eventAt: '2026-06-20T10:03:00.000Z',
      conversationId: 'closure-token-conversation',
    },
    {
      label: 'Cedar delta question',
      statement: 'How should cedar delta epsilon move?',
      atomType: 'question',
      sourceId: 'closure-near-open',
      eventAt: '2026-06-20T10:04:00.000Z',
      conversationId: 'closure-near-conversation',
    },
    {
      label: 'Oak decision',
      statement: 'I decided cedar later maybe resolved outcome.',
      atomType: 'decision',
      sourceId: 'closure-near-decision',
      eventAt: '2026-06-20T10:05:00.000Z',
      conversationId: 'closure-near-conversation',
    },
  ], {
    embedder: openLoopClosureEmbedder,
  });

  assert.equal(result.themesOpenLoops.filter((output) => output.kind === 'MindOpenLoop').length, 0);
  const theme = result.themesOpenLoops.find((output) => output.kind === 'MindTheme');
  assert(theme);
  assert.equal(theme.openLoop, true);

  const openLabels = theme.openAtomIds
    .map((id) => result.atoms.find((atom) => atom.id === id)?.label)
    .filter(Boolean)
    .sort();

  assert(!openLabels.includes('Cosine closure question'));
  assert(!openLabels.includes('Atlas beacon question'));
  assert(openLabels.includes('Cedar delta question'));
});

test('recurring themes require the minimum number of distinct conversations', async () => {
  const { result } = await runDetectorFixture([
    {
      label: 'Single conversation recurring lane',
      statement: 'The same conversation keeps naming a recurring lane.',
      sourceId: 'single-theme-a',
      eventAt: '2026-06-20T10:00:00.000Z',
      conversationId: 'single-theme-conversation',
    },
    {
      label: 'Single conversation recurring lane',
      statement: 'The same conversation repeats the recurring lane.',
      sourceId: 'single-theme-b',
      eventAt: '2026-06-20T10:01:00.000Z',
      conversationId: 'single-theme-conversation',
    },
    {
      label: 'Single conversation recurring lane',
      statement: 'The same conversation adds a third recurring lane atom.',
      sourceId: 'single-theme-c',
      eventAt: '2026-06-20T10:02:00.000Z',
      conversationId: 'single-theme-conversation',
    },
  ], {
    embedder: constantDetectorEmbedder,
  });

  assert.equal(result.themesOpenLoops.filter((output) => output.kind === 'MindTheme').length, 0);
});

test('resurfaced ideas require the post-gap atom itself to be recent', async () => {
  const interiorGap = await runDetectorFixture([
    {
      label: 'Notebook resurfacing lane',
      statement: 'The notebook resurfacing lane started in January.',
      sourceId: 'resurface-interior-a',
      eventAt: '2026-01-01T10:00:00.000Z',
      conversationId: 'resurface-interior-start',
    },
    {
      label: 'Notebook resurfacing lane',
      statement: 'The notebook resurfacing lane returned before the recent window.',
      sourceId: 'resurface-interior-b',
      eventAt: '2026-05-20T10:00:00.000Z',
      conversationId: 'resurface-interior-old-gap',
    },
    {
      label: 'Notebook resurfacing lane',
      statement: 'The notebook resurfacing lane had a recent small follow-up.',
      sourceId: 'resurface-interior-c',
      eventAt: '2026-06-27T10:00:00.000Z',
      conversationId: 'resurface-interior-recent',
    },
  ], {
    embedder: constantDetectorEmbedder,
  });

  const genuineGap = await runDetectorFixture([
    {
      label: 'Notebook resurfacing lane',
      statement: 'The notebook resurfacing lane started in January.',
      sourceId: 'resurface-genuine-a',
      eventAt: '2026-01-01T10:00:00.000Z',
      conversationId: 'resurface-genuine-start',
    },
    {
      label: 'Notebook resurfacing lane',
      statement: 'The notebook resurfacing lane returned inside the recent window.',
      sourceId: 'resurface-genuine-b',
      eventAt: '2026-06-27T10:00:00.000Z',
      conversationId: 'resurface-genuine-recent',
    },
  ], {
    embedder: constantDetectorEmbedder,
  });

  assert.equal(interiorGap.result.resurfacedIdeas.length, 0);
  assert.equal(genuineGap.result.resurfacedIdeas.length, 1);
  assert.equal(genuineGap.result.resurfacedIdeas[0].criteria.resurfacedAt, '2026-06-27T10:00:00.000Z');
});

test('future-dated atoms do not fabricate resurfaced ideas', async () => {
  const { result } = await runDetectorFixture([
    {
      label: 'Future resurfacing lane',
      statement: 'The future resurfacing lane started in January.',
      sourceId: 'resurface-future-a',
      eventAt: '2026-01-01T10:00:00.000Z',
      conversationId: 'resurface-future-start',
    },
    {
      label: 'Future resurfacing lane',
      statement: 'The future resurfacing lane should not count before it happens.',
      sourceId: 'resurface-future-b',
      eventAt: '2026-07-01T10:00:00.000Z',
      conversationId: 'resurface-future-skewed',
    },
  ], {
    embedder: constantDetectorEmbedder,
  });

  assert.equal(result.resurfacedIdeas.length, 0);
});

test('resurfacing stays silent without a quiet gap or a recent post-gap atom', async () => {
  const noQuietGap = await runDetectorFixture([
    {
      label: 'Quiet gap boundary lane',
      statement: 'The quiet gap boundary lane appeared early this month.',
      sourceId: 'resurface-no-gap-a',
      eventAt: '2026-06-01T10:00:00.000Z',
      conversationId: 'resurface-no-gap-a',
    },
    {
      label: 'Quiet gap boundary lane',
      statement: 'The quiet gap boundary lane came back before thirty days.',
      sourceId: 'resurface-no-gap-b',
      eventAt: '2026-06-20T10:00:00.000Z',
      conversationId: 'resurface-no-gap-b',
    },
    {
      label: 'Quiet gap boundary lane',
      statement: 'The quiet gap boundary lane had another recent mention.',
      sourceId: 'resurface-no-gap-c',
      eventAt: '2026-06-27T10:00:00.000Z',
      conversationId: 'resurface-no-gap-c',
    },
  ], {
    embedder: constantDetectorEmbedder,
  });

  const stalePostGap = await runDetectorFixture([
    {
      label: 'Stale post gap lane',
      statement: 'The stale post gap lane began in January.',
      sourceId: 'resurface-stale-a',
      eventAt: '2026-01-01T10:00:00.000Z',
      conversationId: 'resurface-stale-a',
    },
    {
      label: 'Stale post gap lane',
      statement: 'The stale post gap lane returned too long ago.',
      sourceId: 'resurface-stale-b',
      eventAt: '2026-05-20T10:00:00.000Z',
      conversationId: 'resurface-stale-b',
    },
  ], {
    embedder: constantDetectorEmbedder,
  });

  assert.equal(noQuietGap.result.resurfacedIdeas.length, 0);
  assert.equal(stalePostGap.result.resurfacedIdeas.length, 0);
});

test('outputs remain advisory and governNextAction never grants auto authority', async () => {
  const { dataDir, store } = await seededMindStore();

  await think({
    dataDir,
    store,
    now: fixedNow,
    modelCall: conversationModelCall(),
    embedder: fakeEmbedder,
    clusterer: fixtureSidecarClusterer(),
    clusterMinConversations: 1,
    logger: quietLogger(),
    segmentOptions: { similarityThreshold: 0.85 },
  });

  const decisions = await dataFiles(dataDir, 'decisions');
  assert(decisions.length > 0);

  for (const decision of decisions) {
    assert.equal(decision.advisoryOnly, true);
    assert.equal(decision.acted, 'pending');
    assert.notEqual(decision.tag, '[auto]');
    assert(!Object.hasOwn(decision, 'act'));
    assert(!Object.hasOwn(decision, 'autoAct'));

    const governed = governNextAction({
      target: decision.recommended,
      risk: decision.risk,
      reversibilityClass: decision.reversibility,
      authority: 'human',
    });
    assert.equal(governed.unattended, false);
    assert.notEqual(governed.tag, '[auto]');
  }
});

test('synthesis model unavailability silences mind output without extractive atoms', async () => {
  const { dataDir, store, exposures } = await seededMindStore();
  const warnings = [];
  let calls = 0;

  const result = await think({
    dataDir,
    store,
    now: fixedNow,
    modelCall: async () => {
      calls += 1;
      throw new Error('synthesis unavailable');
    },
    embedder: fakeEmbedder,
    logger: { warn: (message) => warnings.push(String(message)) },
    segmentOptions: { similarityThreshold: 0.85 },
  });

  assert.equal(calls, 1);
  assert.equal(result.atomCount, 0);
  assert.equal(result.candidateCount, 0);
  assert.equal(result.divergentIdeaCount, 0);
  assertSilentOutputs(result);
  assert.equal(result.mutations.length, 0);
  assert.deepEqual(await dataFiles(dataDir, path.join('substrate', 'idea-atoms')), []);
  assert.deepEqual(await dataFiles(dataDir, 'decisions'), []);
  assert(result.notes.some((note) => /synthesis model unavailable/i.test(note)));
  assert(result.notes.some((note) => /divergent idea skipped/i.test(note)));
  assert(warnings.some((message) => /mind silenced/i.test(message)));
  assert.equal(Object.keys(exposures).length, 4);
});

test('one conversation synthesis failure skips that conversation and continues the run', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-mind-isolation-data-'));
  const store = createSubstrateStore({ dataDir, now: fixedNow });

  await writeChatExposure(store, {
    statement: FOUNDER_QUESTION,
    sourceId: 'isolation-a-1',
    eventAt: '2026-06-28T08:00:00.000Z',
    conversationId: 'conversation-a',
    role: 'human',
    human: true,
    turnIndex: 0,
  });
  const survivingExposure = await writeChatExposure(store, {
    type: 'directive',
    statement: FOUNDER_DECISION,
    sourceId: 'isolation-b-1',
    eventAt: '2026-06-28T08:01:00.000Z',
    conversationId: 'conversation-b',
    role: 'human',
    human: true,
    turnIndex: 0,
  });

  const extractionConversationIds = [];
  const result = await think({
    dataDir,
    store,
    now: fixedNow,
    modelCall: async (request) => {
      if (request.task === 'mind.divergentIdea') {
        return {
          statement: 'Review the surviving conversation atom.',
          rationale: 'One conversation failed but the later one produced evidence.',
          confidence: 0.6,
        };
      }

      const payload = JSON.parse(request.user);
      extractionConversationIds.push(payload.conversation.conversationId);
      if (payload.conversation.conversationId === 'conversation-a') {
        throw new Error('conversation payload was too noisy');
      }
      return { atoms: atomsForConversation(payload.conversation) };
    },
    embedder: fakeEmbedder,
    logger: quietLogger(),
    segmentOptions: { similarityThreshold: 0.85 },
  });

  assert.deepEqual(extractionConversationIds, ['conversation-a', 'conversation-b']);
  assert.equal(result.conversationCount, 2);
  assert.equal(result.atomCount, 1);
  assert.equal(result.atoms[0].conversationId, 'conversation-b');
  assert.deepEqual(result.atoms[0].evidenceIds, [survivingExposure.id]);
  assert(result.notes.some((note) => /conversation skipped during atom synthesis: conversation-a/i.test(note)));
  assert(!result.notes.some((note) => /mind silenced/i.test(note)));
});

test('conversation extraction prompt is capped for many long founder messages', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-mind-cap-data-'));
  const store = createSubstrateStore({ dataDir, now: fixedNow });
  const start = Date.parse('2026-06-28T09:00:00.000Z');

  for (let index = 0; index < 90; index += 1) {
    await writeChatExposure(store, {
      statement: `Long founder note ${index}: ${'x'.repeat(2_000)}`,
      sourceId: `cap-${index}`,
      eventAt: new Date(start + index * 1_000).toISOString(),
      conversationId: 'cap-conversation',
      role: 'human',
      human: true,
      turnIndex: index,
    });
  }

  const calls = [];
  await think({
    dataDir,
    store,
    now: fixedNow,
    modelCall: async (request) => {
      calls.push(request);
      return { atoms: [] };
    },
    embedder: fakeEmbedder,
    logger: quietLogger(),
    segmentOptions: { similarityThreshold: 0.85 },
  });

  const extractionCall = calls.find((request) => request.task === 'mind.extractConversationAtoms');
  assert(extractionCall);
  assert(extractionCall.user.length <= MAX_CONVERSATION_CHARS);
  const payload = JSON.parse(extractionCall.user);
  assert(payload.conversation.founderMessages.length <= MAX_CONVERSATION_MESSAGES);
  assert(payload.conversation.omittedOlderMessageCount > 0);
});

test('atoms with no matching founder-message evidence are dropped instead of backfilled', async () => {
  const { dataDir, store } = await seededMindStore({ includeSpatialIdea: false });

  const result = await think({
    dataDir,
    store,
    now: fixedNow,
    modelCall: async (request) => {
      if (request.task === 'mind.divergentIdea') return {};
      return {
        atoms: [{
          label: 'Unsupported atom',
          statement: 'This atom cites no real founder message.',
          type: 'idea',
          confidence: 0.7,
          evidenceIds: ['missing-message-id'],
        }],
      };
    },
    embedder: fakeEmbedder,
    logger: quietLogger(),
    segmentOptions: { similarityThreshold: 0.85 },
  });

  assert.equal(result.atomCount, 0);
  assert.deepEqual(await dataFiles(dataDir, path.join('substrate', 'idea-atoms')), []);
});

test('chat authorship fails closed for model roles and missing human flags', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-mind-authorship-data-'));
  const store = createSubstrateStore({ dataDir, now: fixedNow });
  const inputs = [
    { role: 'Model', human: true, sourceId: 'auth-model' },
    { role: 'AI', human: true, sourceId: 'auth-ai' },
    { role: 'assistant', human: true, sourceId: 'auth-assistant' },
    { role: 'user', human: undefined, sourceId: 'auth-missing-human' },
  ];

  for (const [index, input] of inputs.entries()) {
    await writeChatExposure(store, {
      statement: `Variant chat author ${index} should not become founder evidence.`,
      sourceId: input.sourceId,
      eventAt: new Date(Date.parse('2026-06-28T10:00:00.000Z') + index * 1_000).toISOString(),
      conversationId: 'authorship-conversation',
      role: input.role,
      human: input.human,
      turnIndex: index,
    });
  }

  let calls = 0;
  const result = await think({
    dataDir,
    store,
    now: fixedNow,
    modelCall: async () => {
      calls += 1;
      return { atoms: [] };
    },
    embedder: fakeEmbedder,
    logger: quietLogger(),
    segmentOptions: { similarityThreshold: 0.85 },
  });

  assert.equal(calls, 0);
  assert.equal(result.founderExposureCount, 0);
  assert.equal(result.conversationCount, 0);
  assert.equal(result.atomCount, 0);
  assert.deepEqual(await dataFiles(dataDir, path.join('substrate', 'idea-atoms')), []);
});

test('default mind synthesis provider uses OpenRouter ZDR and keeps embeddings local', async () => {
  const { dataDir, store } = await seededMindStore();
  const requests = [];
  const embeddingCalls = [];

  await withEnv({
    OPENROUTER_API_KEY: 'test-openrouter-key',
    K_MIND_MODEL_PROVIDER: undefined,
    K_MIND_MODEL: 'test/zdr-model',
  }, async () => {
    const result = await think({
      dataDir,
      store,
      now: fixedNow,
      fetchImpl: fakeOpenRouterFetch(requests),
      embedder: async (prompt, context) => {
        embeddingCalls.push({ prompt, context });
        return fakeEmbedder(prompt);
      },
      logger: quietLogger(),
      segmentOptions: { similarityThreshold: 0.85 },
    });

    assert.equal(result.atomCount, 3);
  });

  assert(requests.length > 0);
  assert(requests.every((request) => request.url === OPENROUTER_CHAT_COMPLETIONS_URL));
  assert(requests.every((request) => request.body.provider.data_collection === 'deny'));
  assert(requests.every((request) => request.body.model === 'test/zdr-model'));
  assert(requests.every((request) => request.headers.Authorization === 'Bearer test-openrouter-key'));
  assert(embeddingCalls.length > 0);
  assert(embeddingCalls.every((call) => call.context.model === DEFAULT_EMBEDDING_MODEL));
  assert(requests.every((request) => !JSON.stringify(request.body).includes(ASSISTANT_NARRATION)));
});

test('configured local-ollama provider only fetches localhost Ollama synthesis URLs', async () => {
  const { dataDir, store } = await seededMindStore();
  const requests = [];

  await withEnv({ K_MIND_MODEL_PROVIDER: 'local-ollama' }, async () => {
    await think({
      dataDir,
      store,
      now: fixedNow,
      fetchImpl: fakeOllamaFetch(requests),
      embedder: fakeEmbedder,
      logger: quietLogger(),
      segmentOptions: { similarityThreshold: 0.85 },
    });
  });

  assert(requests.length > 0);
  assert(requests.every((request) => request.url === 'http://127.0.0.1:11434/api/generate'));
});

test('local Ollama timeout silences without writing extractive atoms', async () => {
  const { dataDir, store } = await seededMindStore();

  const result = await withEnv({ K_MIND_MODEL_PROVIDER: 'local-ollama' }, () =>
    think({
      dataDir,
      store,
      now: fixedNow,
      fetchImpl: () => new Promise(() => {}),
      timeoutMs: 5,
      embedder: fakeEmbedder,
      logger: quietLogger(),
      segmentOptions: { similarityThreshold: 0.85 },
    }));

  assert.equal(result.atomCount, 0);
  assert.equal(result.candidateCount, 0);
  assert.equal(result.divergentIdeaCount, 0);
  assertSilentOutputs(result);
  assert(result.notes.some((note) => /timed out/i.test(note)));
  assert.deepEqual(await dataFiles(dataDir, path.join('substrate', 'idea-atoms')), []);
  assert.deepEqual(await dataFiles(dataDir, 'decisions'), []);
});

test('local Ollama retries ECONNREFUSED once before succeeding', async () => {
  const requests = [];
  const result = await localOllamaModelCall({
    system: 'system',
    user: 'prompt',
    responseFormat: 'json',
  }, {
    retryBackoffMs: 0,
    retryJitterMs: 0,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      if (requests.length === 1) {
        const error = new Error('connect ECONNREFUSED 127.0.0.1:11434');
        error.code = 'ECONNREFUSED';
        throw error;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ response: JSON.stringify({ atoms: [] }) }),
      };
    },
  });

  assert.deepEqual(result, { atoms: [] });
  assert.equal(requests.length, 2);
});

test('local Ollama 503 retries once then degrades the mind run with a structured note', async () => {
  const { dataDir, store } = await seededMindStore({ includeSpatialIdea: false });
  const warnings = [];
  let calls = 0;

  const result = await withEnv({ K_MIND_MODEL_PROVIDER: 'local-ollama' }, () =>
    think({
      dataDir,
      store,
      now: fixedNow,
      fetchImpl: async () => {
        calls += 1;
        return {
          ok: false,
          status: 503,
          text: async () => 'Ollama is loading a model',
        };
      },
      ollamaRetryBackoffMs: 0,
      ollamaRetryJitterMs: 0,
      concurrency: 1,
      embedder: fakeEmbedder,
      logger: { warn: (message) => warnings.push(message) },
      segmentOptions: { similarityThreshold: 0.85 },
    }));

  assert.equal(calls, 2);
  assert.equal(result.atomCount, 0);
  assert.equal(result.candidateCount, 0);
  assertSilentOutputs(result);
  assert(result.notes.some((note) => note.includes('"event":"local_ollama_degraded"')));
  assert(result.notes.some((note) => note.includes('"reason":"http_503"')));
  assert(warnings.some((line) => line.includes('local_ollama_degraded')));
});

test('embedding failures skip clustering without crashing synthesized atoms', async () => {
  const { dataDir, store } = await seededMindStore();
  const warnings = [];

  const result = await think({
    dataDir,
    store,
    now: fixedNow,
    modelCall: conversationModelCall(),
    embedder: async () => {
      throw new Error('embedding service down');
    },
    logger: { warn: (message) => warnings.push(String(message)) },
    segmentOptions: { similarityThreshold: 0.85 },
  });

  assert.equal(result.atomCount, 3);
  assert.equal(result.candidateCount, 0);
  assert(result.atoms.every((atom) => atom.extraction.generatedBy === 'local-model'));
  assert(result.notes.some((note) => /clustering skipped/i.test(note)));
  assert(warnings.some((message) => /clustering skipped/i.test(message)));
});

test('empty exposure statements are isolated and do not abort the batch', async () => {
  const { dataDir, store, exposures } = await seededMindStore({ includeSpatialIdea: false });
  const badExposure = {
    ...exposures.decision,
    id: 'exp_empty_statement',
    statement: '   ',
  };

  const result = await think({
    dataDir,
    store,
    exposures: [exposures.question, badExposure, exposures.assistant],
    now: fixedNow,
    modelCall: conversationModelCall(),
    embedder: fakeEmbedder,
    logger: quietLogger(),
    segmentOptions: { similarityThreshold: 0.85 },
  });

  assert.equal(result.exposureCount, 3);
  assert.equal(result.founderExposureCount, 1);
  assert.equal(result.atomCount, 1);
  assert.deepEqual(result.atoms[0].evidenceIds, [exposures.question.id]);
  assert(result.notes.some((note) => /exposure skipped/i.test(note)));
});

test('successful synthesis after prior silence writes model atoms without stale extractive records', async () => {
  const { dataDir, store } = await seededMindStore();

  const silenced = await think({
    dataDir,
    store,
    now: fixedNow,
    modelCall: async () => {
      throw new Error('synthesis unavailable');
    },
    embedder: fakeEmbedder,
    logger: quietLogger(),
    segmentOptions: { similarityThreshold: 0.85 },
  });
  assert.equal(silenced.atomCount, 0);
  assert.deepEqual(await dataFiles(dataDir, path.join('substrate', 'idea-atoms')), []);

  const upgraded = await think({
    dataDir,
    store,
    now: fixedNow,
    modelCall: conversationModelCall(),
    embedder: fakeEmbedder,
    logger: quietLogger(),
    segmentOptions: { similarityThreshold: 0.85 },
  });
  const persistedAtoms = await dataFiles(dataDir, path.join('substrate', 'idea-atoms'));
  const retiredAtoms = persistedAtoms.filter((atom) => atom.validTo && atom.supersededById);
  const activeAtoms = persistedAtoms.filter((atom) => !atom.validTo && !atom.supersededById);

  assert.equal(upgraded.atomCount, 3);
  assert(upgraded.atoms.every((atom) => atom.extraction.generatedBy === 'local-model'));
  assert.equal(retiredAtoms.length, 0);
  assert.equal(activeAtoms.length, 3);
  assert(activeAtoms.every((atom) => atom.extraction.generatedBy === 'local-model'));
  assert(upgraded.mutations.every((mutation) => mutation.op !== 'superseded'));
});

test('mind synthesis resolver defaults to OpenRouter ZDR and flips to local Ollama by env config', async () => {
  await withEnv({
    OPENROUTER_API_KEY: 'test-openrouter-key',
    K_MIND_MODEL_PROVIDER: undefined,
    K_MIND_MODEL: 'test/zdr-model',
  }, async () => {
    const requests = [];
    const modelCall = resolveMindSynthesisModelCall({ fetchImpl: fakeOpenRouterFetch(requests) });
    const text = await modelCall({ system: 'system', user: 'prompt' });

    assert.match(text, /resolver probe/i);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, OPENROUTER_CHAT_COMPLETIONS_URL);
    assert.equal(requests[0].body.provider.data_collection, 'deny');
  });

  await withEnv({ K_MIND_MODEL_PROVIDER: 'openrouter-zdr', OPENROUTER_API_KEY: 'test-openrouter-key' }, async () => {
    const requests = [];
    const modelCall = resolveMindSynthesisModelCall({ fetchImpl: fakeOpenRouterFetch(requests) });
    await modelCall({ system: 'system', user: 'prompt' });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, OPENROUTER_CHAT_COMPLETIONS_URL);
  });

  await withEnv({ K_MIND_MODEL_PROVIDER: 'local-ollama', OPENROUTER_API_KEY: undefined }, async () => {
    const requests = [];
    const modelCall = resolveMindSynthesisModelCall({ fetchImpl: fakeOllamaFetch(requests) });
    await modelCall({ system: 'system', user: 'prompt' });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'http://127.0.0.1:11434/api/generate');
  });
});

async function runDetectorFixture(entries, {
  embedder,
  segment: segmentImpl = async () => [],
  clusterer = fixtureSidecarClusterer(),
} = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-mind-detector-data-'));
  const store = createSubstrateStore({ dataDir, now: fixedNow });
  const atomsByExposureId = new Map();

  for (const [index, entry] of entries.entries()) {
    const exposure = await writeChatExposure(store, {
      type: entry.exposureType ?? 'observation',
      statement: entry.statement,
      sourceId: entry.sourceId,
      eventAt: entry.eventAt,
      conversationId: entry.conversationId,
      role: 'human',
      human: true,
      turnIndex: index,
    });
    atomsByExposureId.set(exposure.id, {
      label: entry.label,
      statement: entry.atomStatement ?? entry.statement,
      type: entry.atomType ?? 'idea',
      confidence: entry.confidence ?? 0.78,
    });
  }

  const result = await think({
    dataDir,
    store,
    now: fixedNow,
    modelCall: detectorModelCall(atomsByExposureId),
    embedder: embedder ?? constantDetectorEmbedder,
    clusterer,
    segment: segmentImpl,
    // Detector-mechanics harness: single-conversation micro-fixtures exercise the
    // candidate/resurfaced/bridge paths, not the >=2-conversation quality gate.
    clusterMinConversations: 1,
    logger: quietLogger(),
  });

  return { dataDir, store, result };
}

function detectorModelCall(atomsByExposureId) {
  return async (request) => {
    if (request.task === 'mind.divergentIdea') return {};
    if (request.task === 'mind.themeSummary') {
      return {
        summary: 'Recurring fixture theme across founder conversations.',
        observation: 'The recurring fixture points to one reviewable founder thread.',
        considerations: [
          'Keep unresolved questions attached to the parent thread.',
          'Separate later decisions that actually close the question.',
        ],
        confidence: 0.7,
      };
    }

    const payload = JSON.parse(request.user);
    return {
      atoms: (payload.conversation.founderMessages ?? [])
        .map((message) => {
          const atom = atomsByExposureId.get(message.id);
          if (!atom) return null;
          return {
            ...atom,
            evidenceIds: [message.id],
          };
        })
        .filter(Boolean),
    };
  };
}

function fixtureSidecarClusterer({
  bridges = false,
  noiseAtomIds = [],
} = {}) {
  return async (atomDocs) => {
    const noise = new Set(noiseAtomIds);
    const groups = new Map();
    for (const doc of atomDocs.filter((entry) => !noise.has(entry.id)).sort(compareFixtureDocs)) {
      const key = fixtureEmbeddingKey(doc.embedding);
      const docs = groups.get(key) ?? [];
      docs.push(doc);
      groups.set(key, docs);
    }

    const leafClusters = Array.from(groups.values()).map((docs, index) => ({
      clusterId: `cluster_${String(index + 1).padStart(3, '0')}`,
      atomIds: docs.map((doc) => doc.id),
      representativeAtomId: docs[0].id,
      keywords: [],
    }));
    const clusteredAtomIds = leafClusters.flatMap((cluster) => cluster.atomIds);
    const parentThemes = clusteredAtomIds.length > 0
      ? [{
          themeId: 'theme_001',
          leafClusterIds: leafClusters.map((cluster) => cluster.clusterId),
          atomIds: clusteredAtomIds,
          representativeAtomId: clusteredAtomIds[0],
          keywords: [],
        }]
      : [];
    const resurfaced = leafClusters
      .map((cluster) => fixtureResurfacedCluster(cluster, atomDocs))
      .filter(Boolean);
    const newIdeaBridges = bridges && leafClusters.length >= 2
      ? [{
          atomId: leafClusters[1].representativeAtomId,
          connectsClusterIds: [leafClusters[0].clusterId, leafClusters[1].clusterId],
          betweenness: 0.42,
        }]
      : [];

    return {
      leafClusters,
      parentThemes,
      resurfaced,
      newIdeaBridges,
      noiseAtomIds: [...noise].sort(),
    };
  };
}

function fixtureEmbeddingKey(embedding) {
  return (Array.isArray(embedding) ? embedding : [])
    .map((value) => Number(value).toFixed(3))
    .join(',');
}

function fixtureResurfacedCluster(cluster, atomDocs) {
  const docsById = new Map(atomDocs.map((doc) => [doc.id, doc]));
  const docs = cluster.atomIds
    .map((id) => docsById.get(id))
    .filter(Boolean)
    .sort(compareFixtureDocs);
  const nowMs = fixedNow().getTime();
  const recentWindowMs = 30 * 86_400_000;
  for (let index = 1; index < docs.length; index += 1) {
    const previousMs = Date.parse(docs[index - 1].eventAt);
    const currentMs = Date.parse(docs[index].eventAt);
    if (!Number.isFinite(previousMs) || !Number.isFinite(currentMs) || currentMs > nowMs) continue;
    const gapDays = (currentMs - previousMs) / 86_400_000;
    const recent = nowMs - currentMs <= recentWindowMs;
    if (gapDays > 90 && recent) {
      return {
        clusterId: cluster.clusterId,
        previousActiveAt: docs[index - 1].eventAt,
        resurfacedAt: docs[index].eventAt,
        gapDays: Math.floor(gapDays),
      };
    }
  }
  return null;
}

function compareFixtureDocs(a, b) {
  return String(a.eventAt).localeCompare(String(b.eventAt)) ||
    String(a.id).localeCompare(String(b.id));
}

async function constantDetectorEmbedder() {
  return [1, 0, 0, 0];
}

async function openLoopClosureEmbedder(prompt) {
  const lower = prompt.toLowerCase();
  if (lower.includes('cosine closure')) return [1, 0, 0, 0];
  if (lower.includes('atlas beacon question')) return [0, 1, 0, 0];
  if (lower.includes('atlas beacon decision')) return [0, 0, 1, 0];
  if (lower.includes('cedar delta question')) return [0, 0, 0, 1];
  if (lower.includes('oak decision')) return [0, 0, 1, 0];
  return [0.1, 0.2, 0.3, 0.4];
}

async function seededMindStore({ includeSpatialIdea = true } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-mind-data-'));
  const store = createSubstrateStore({ dataDir, now: fixedNow });
  const exposures = {};

  exposures.question = await writeChatExposure(store, {
    type: 'question',
    statement: FOUNDER_QUESTION,
    sourceId: 'mind-alpha-1',
    eventAt: '2026-06-28T06:00:00.000Z',
    role: 'human',
    human: true,
    turnIndex: 0,
  });
  exposures.assistant = await writeChatExposure(store, {
    type: 'observation',
    statement: ASSISTANT_NARRATION,
    sourceId: 'mind-alpha-assistant',
    eventAt: '2026-06-28T06:00:30.000Z',
    role: 'assistant',
    human: false,
    turnIndex: 1,
  });
  exposures.decision = await writeChatExposure(store, {
    type: 'directive',
    statement: FOUNDER_DECISION,
    sourceId: 'mind-alpha-2',
    eventAt: '2026-06-28T06:01:00.000Z',
    role: 'human',
    human: true,
    turnIndex: 2,
  });

  if (includeSpatialIdea) {
    exposures.spatial = await writeChatExposure(store, {
      type: 'hypothesis',
      statement: FOUNDER_SPATIAL_IDEA,
      sourceId: 'mind-beta-1',
      eventAt: '2026-06-28T06:02:00.000Z',
      role: 'human',
      human: true,
      turnIndex: 3,
    });
  }

  return { dataDir, store, exposures };
}

async function seededThinStore() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-mind-thin-data-'));
  const store = createSubstrateStore({ dataDir, now: fixedNow });

  await writeChatExposure(store, {
    statement: 'thanks!',
    sourceId: 'thin-1',
    eventAt: '2026-06-28T07:00:00.000Z',
    conversationId: 'thin-conversation',
    role: 'human',
    human: true,
    turnIndex: 0,
  });
  await writeChatExposure(store, {
    statement: 'Happy to help.',
    sourceId: 'thin-assistant',
    eventAt: '2026-06-28T07:00:10.000Z',
    conversationId: 'thin-conversation',
    role: 'assistant',
    human: false,
    turnIndex: 1,
  });

  return { dataDir, store };
}

async function seededU4cStore() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-mind-u4c-data-'));
  const store = createSubstrateStore({ dataDir, now: fixedNow });

  await writeChatExposure(store, {
    statement: 'K should surface recurring artifact themes across conversations.',
    sourceId: 'theme-jan',
    eventAt: '2026-01-02T10:00:00.000Z',
    conversationId: 'theme-january',
    role: 'human',
    human: true,
    turnIndex: 0,
  });
  await writeChatExposure(store, {
    statement: 'The recurring artifact theme keeps coming back in the review loop.',
    sourceId: 'theme-feb',
    eventAt: '2026-02-10T10:00:00.000Z',
    conversationId: 'theme-february',
    role: 'human',
    human: true,
    turnIndex: 0,
  });
  await writeChatExposure(store, {
    statement: 'Recurring artifact themes need a stable output group.',
    sourceId: 'theme-mar',
    eventAt: '2026-03-20T10:00:00.000Z',
    conversationId: 'theme-march',
    role: 'human',
    human: true,
    turnIndex: 0,
  });
  await writeChatExposure(store, {
    statement: 'How should K preserve a dropped idea without forcing it into the queue?',
    sourceId: 'open-jun',
    eventAt: '2026-06-20T10:00:00.000Z',
    conversationId: 'open-loop-conversation',
    role: 'human',
    human: true,
    turnIndex: 0,
  });
  await writeChatExposure(store, {
    statement: 'The pocket notebook idea could help dropped ideas stay visible.',
    sourceId: 'dormant-jan',
    eventAt: '2026-01-04T10:00:00.000Z',
    conversationId: 'dormant-start',
    role: 'human',
    human: true,
    turnIndex: 0,
  });
  await writeChatExposure(store, {
    statement: 'The pocket notebook idea resurfaced as a review surface this week.',
    sourceId: 'dormant-recent',
    eventAt: '2026-06-27T10:00:00.000Z',
    conversationId: 'dormant-recent',
    role: 'human',
    human: true,
    turnIndex: 0,
  });

  return { dataDir, store };
}

async function writeChatExposure(store, {
  type = 'observation',
  statement,
  sourceId,
  eventAt,
  conversationId = 'mind-conversation',
  role,
  human,
  turnIndex,
}) {
  return store.writeExposure({
    type,
    statement,
    sourceId,
    eventAt,
    context: conversationId,
    metadata: {
      conversationId,
      conversationName: 'Mind fixture conversation',
      role,
      human,
      signalWeight: human ? 2 : 1,
      turnIndex,
      messageId: sourceId,
    },
    provenance: { surface: 'claude', lane: 'deliberate' },
  });
}

function conversationModelCall(calls = []) {
  return async (request) => {
    calls.push(request);
    assert.match(request.label, /^cs-k:think:/);
    assert.equal(request.sensitivity, 'private-chat-or-bookmark');

    if (request.task === 'mind.divergentIdea') {
      return {
        statement: 'Build a quiet review queue that turns idea clusters into one human-gated next step.',
        rationale: 'The focal cluster wants execution pressure while the divergent evidence asks for blind-spot review.',
        confidence: 0.72,
      };
    }

    assert.equal(request.task, 'mind.extractConversationAtoms');
    const payload = JSON.parse(request.user);
    return { atoms: atomsForConversation(payload.conversation) };
  };
}

function decisionCardModelCall(calls = [], { failDecisionCard = false } = {}) {
  return async (request) => {
    calls.push(request);
    assert.match(request.label, /^cs-k:think:/);
    assert.equal(request.sensitivity, 'private-chat-or-bookmark');

    if (request.task === 'mind.decisionCard') {
      if (failDecisionCard) throw new Error('decision card model unavailable');
      return {
        asked: 'Should K convert the repeated build queue cluster into one founder-gated candidate?',
        read: 'The cluster combines the build-candidate question with the human-gated queue decision.',
        assumed: 'A single founder-gated candidate is safer than several competing build prompts.',
        missing: 'No material missing angle remains before staging a reversible review.',
        pick: 'Stage one reversible build-candidate review for the founder.',
        why: 'The cluster points to queue pressure and explicitly keeps execution behind human approval.',
        whatWouldChangeIt: 'A newer cluster showing separate unrelated decisions would split the card.',
        next: 'Review the staged candidate and either accept it or archive it.',
      };
    }
    if (request.task === 'mind.divergentIdea') {
      return {
        statement: 'Build a quiet review queue that turns idea clusters into one human-gated next step.',
        rationale: 'The focal cluster wants execution pressure while the divergent evidence asks for blind-spot review.',
        confidence: 0.72,
      };
    }
    if (request.task === 'mind.themeSummary') {
      return {
        summary: 'Repeated build queue decisions belong in one reviewable theme.',
        observation: 'The build queue and human gate keep recurring as one operating concern.',
        considerations: [
          'Keep the queue decision separate from execution.',
          'Review one candidate before creating multiple build prompts.',
        ],
        confidence: 0.74,
      };
    }

    assert.equal(request.task, 'mind.extractConversationAtoms');
    const payload = JSON.parse(request.user);
    return { atoms: atomsForConversation(payload.conversation) };
  };
}

function u4cModelCall(calls = []) {
  return async (request) => {
    calls.push(request);
    if (request.task === 'mind.divergentIdea') return {};
    if (request.task === 'mind.themeSummary') {
      return {
        summary: 'Recurring artifact themes keep returning across review conversations.',
        observation: 'Artifact review keeps returning as one durable operating concern.',
        considerations: [
          'Distinguish recurring artifact review from pocket-notebook resurfacing.',
          'Keep dropped-idea preservation visible without forcing queue action.',
          'Choose the smallest review surface that can hold both concerns.',
          'Bound this intentionally long consideration so the projected K-card cannot carry an unbounded private planning paragraph even when the model returns too much detail about review surfaces and dropped-idea handling across conversations.',
        ],
        confidence: 0.74,
      };
    }

    const payload = JSON.parse(request.user);
    return { atoms: atomsForU4cConversation(payload.conversation) };
  };
}

function semanticOutputPersistenceModelCall(calls, passValue) {
  return async (request) => {
    calls.push(request);
    if (request.task === 'mind.divergentIdea') {
      return {
        statement: passValue() > 0
          ? 'Stage a refreshed bridge between recurring artifact themes and the pocket notebook review lane.'
          : 'Stage a bridge between recurring artifact themes and the pocket notebook review lane.',
        rationale: 'The sidecar bridge connects a recurring theme cluster to a resurfaced dormant idea.',
        confidence: 0.73,
      };
    }
    if (request.task === 'mind.themeSummary') {
      return {
        summary: passValue() > 0
          ? 'Recurring artifact themes stay linked to refreshed review surfaces.'
          : 'Recurring artifact themes stay linked to review surfaces.',
        observation: passValue() > 0
          ? 'The refreshed review surface still carries the same artifact concern.'
          : 'Artifact review and review-surface design belong in one theme.',
        considerations: [
          'Keep the recurring artifact theme distinct from bridge generation.',
          'Preserve resurfaced notebook evidence as supporting context.',
        ],
        confidence: 0.74,
      };
    }

    const payload = JSON.parse(request.user);
    return { atoms: atomsForU4cConversation(payload.conversation) };
  };
}

function semanticOutputNameModelCall(calls) {
  return async (request) => {
    calls.push(request);
    assert.equal(request.task, 'mind.nameEntity');
    assert.equal(request.tool?.name, 'name_mind_entity');
    const payload = JSON.parse(request.user);
    const text = [
      ...(payload.statements ?? []),
      ...(payload.keywords ?? []),
    ].join('\n').toLowerCase();
    if (text.includes('themes_open_loops')) return { label: 'artifact review loop' };
    if (text.includes('new_ideas')) return { label: 'artifact notebook bridge' };
    if (text.includes('resurfaced')) return { label: 'pocket notebook review' };
    if (text.includes('bridge')) return { label: 'artifact notebook bridge' };
    if (text.includes('pocket notebook')) return { label: 'pocket notebook review' };
    if (text.includes('dropped idea')) return { label: 'dropped idea preservation' };
    return { label: 'artifact review loop' };
  };
}

function glazeOutputModelCall(calls) {
  return async (request) => {
    calls.push(request);
    if (request.task === 'mind.divergentIdea') {
      return {
        statement: 'Stage a bridge between recurring artifact themes and the pocket notebook review lane.',
        rationale: 'Excellent, this is a brilliant point! The bridge links the two review surfaces.',
        confidence: 0.73,
      };
    }
    if (request.task === 'mind.themeSummary') {
      return {
        summary: 'Recurring artifact themes stay linked to review surfaces.',
        observation: 'Excellent, this is a brilliant point! Artifact review belongs with the review surface.',
        considerations: [
          'Keep the recurring artifact theme distinct from bridge generation.',
          'Preserve resurfaced notebook evidence as supporting context.',
        ],
        confidence: 0.74,
      };
    }

    const payload = JSON.parse(request.user);
    return { atoms: atomsForU4cConversation(payload.conversation) };
  };
}

function atomsForConversation(conversation) {
  const messages = conversation.founderMessages ?? [];
  if (messages.every((message) => /^thanks!?$/i.test(String(message.statement).trim()))) {
    return [];
  }

  return messages.flatMap((message) => {
    const lower = String(message.statement).toLowerCase();
    if (lower.includes('how should k convert')) {
      return [{
        label: 'Convert themes into build candidate',
        statement: 'K needs a way to convert repeated chat themes into one advisory build candidate.',
        type: 'question',
        confidence: 0.82,
        evidenceIds: [message.id],
      }];
    }
    if (lower.includes('human-gated')) {
      return [{
        label: 'Keep the queue human-gated',
        statement: 'The next-build queue must stay human-gated before K builds anything.',
        type: 'decision',
        confidence: 0.88,
        evidenceIds: [message.id],
      }];
    }
    if (lower.includes('spatial memory wall')) {
      return [{
        label: 'Spatial memory wall',
        statement: 'A spatial memory wall could reveal planning blind spots.',
        type: 'idea',
        confidence: 0.72,
        evidenceIds: [message.id],
      }];
    }
    return [];
  });
}

function atomsForU4cConversation(conversation) {
  return (conversation.founderMessages ?? []).flatMap((message) => {
    const lower = String(message.statement).toLowerCase();
    if (lower.includes('recurring artifact theme') || lower.includes('recurring artifact themes')) {
      return [{
        label: 'Recurring artifact theme',
        statement: 'K keeps returning to recurring artifact themes across review conversations.',
        type: 'idea',
        confidence: 0.78,
        evidenceIds: [message.id],
      }];
    }
    if (lower.includes('how should k preserve a dropped idea')) {
      return [{
        label: 'Preserve dropped idea question',
        statement: 'How should K preserve a dropped idea without forcing it into the queue?',
        type: 'question',
        confidence: 0.84,
        evidenceIds: [message.id],
      }];
    }
    if (lower.includes('pocket notebook idea')) {
      return [{
        label: 'Pocket notebook resurfacing',
        statement: 'The pocket notebook idea can keep dropped ideas visible for review.',
        type: 'idea',
        confidence: 0.76,
        evidenceIds: [message.id],
      }];
    }
    return [];
  });
}

async function fakeEmbedder(prompt) {
  const lower = prompt.toLowerCase();
  if (
    lower.includes('how should k convert') ||
    lower.includes('human-gated') ||
    lower.includes('advisory') ||
    lower.includes('builds next') ||
    lower.includes('build candidate')
  ) {
    return [1, 0.02];
  }
  if (
    lower.includes('spatial') ||
    lower.includes('blind spot') ||
    lower.includes('planning')
  ) {
    return [0.02, 1];
  }
  return [0.8, 0.2];
}

async function u4cEmbedder(prompt) {
  const lower = prompt.toLowerCase();
  if (lower.includes('recurring artifact theme')) return [1, 0, 0];
  if (lower.includes('pocket notebook')) return [0, 1, 0];
  if (lower.includes('preserve dropped idea')) return [0, 0, 1];
  return [0.2, 0.2, 0.2];
}

function fakeOpenRouterFetch(requests = []) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({
      url: String(url),
      headers: init.headers,
      body,
    });

    const system = body.messages?.[0]?.content ?? '';
    const user = body.messages?.[1]?.content ?? '';
    let content = 'resolver probe';

    if (/Extract the founder's salient thinking/i.test(system)) {
      const payload = JSON.parse(user);
      content = JSON.stringify({ atoms: atomsForConversation(payload.conversation) });
    } else if (/Generate one genuinely new idea/i.test(system)) {
      content = JSON.stringify({
        statement: 'Build a quiet review queue that turns idea clusters into one human-gated next step.',
        rationale: 'The focal cluster wants execution pressure while the divergent evidence asks for blind-spot review.',
        confidence: 0.72,
      });
    }

    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content } }],
      }),
    };
  };
}

function fakeOllamaFetch(requests = []) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url: String(url), body });

    if (String(url).endsWith('/api/embeddings')) {
      return {
        ok: true,
        json: async () => ({ embedding: await fakeEmbedder(body.prompt) }),
      };
    }

    return {
      ok: true,
      json: async () => ({
        response: JSON.stringify({
          atoms: [{
            label: 'Local atom',
            statement: 'Local Ollama produced a private advisory idea atom.',
            type: 'idea',
            confidence: 0.76,
          }],
        }),
      }),
    };
  };
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
      .map((entry) => entry.name)
      .sort()
      .map((name) => fs.readFile(path.join(dir, name), 'utf8').then(JSON.parse)),
  );
}

async function contradictionRecords(dataDir) {
  const file = path.join(dataDir, 'truth', 'contradictions.jsonl');
  let text;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function seedDecisionRecord(dataDir, name, record) {
  const dir = path.join(dataDir, 'decisions');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${name}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
    'utf8',
  );
}

function liveMindOutputs(records) {
  const groups = {
    themes_open_loops: [],
    resurfaced: [],
    new_ideas: [],
  };

  for (const record of records) {
    if (record.validTo || record.supersededById) continue;
    for (const group of Object.keys(groups)) {
      if (record.outputGroup === group) {
        groups[group].push(record);
      }
    }
  }

  return groups;
}

function quietLogger() {
  return { warn: () => {} };
}

function assertSilentOutputs(result) {
  assert.deepEqual(result.outputs, {
    build_decide: [],
    themes_open_loops: [],
    resurfaced: [],
    new_ideas: [],
  });
}

async function withEnv(values, operation) {
  const previous = new Map();
  for (const key of Object.keys(values)) {
    previous.set(key, {
      had: Object.hasOwn(process.env, key),
      value: process.env[key],
    });
    if (values[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = String(values[key]);
    }
  }

  try {
    return await operation();
  } finally {
    for (const [key, state] of previous) {
      if (state.had) {
        process.env[key] = state.value;
      } else {
        delete process.env[key];
      }
    }
  }
}
