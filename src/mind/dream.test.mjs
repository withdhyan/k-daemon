import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createBuildCardStore } from '../agent/build-cards.mjs';
import { ATTENTION_CATEGORY_DREAMING_EDGE_CARD } from '../agent/attention-budget.mjs';
import {
  DREAMING_HIT_RATE_FILE,
  DREAMING_STATE_FILE,
  dream,
} from './dream.mjs';

const fixedNow = () => new Date('2026-07-06T03:00:00.000Z');

test('dream emits bounded build edge cards, decisions, decay state, and run telemetry', async () => {
  const dataDir = await tempDataDir();
  await seedDreamAtoms(dataDir);
  const cardStore = buildCardStore(dataDir);

  const result = await dream({
    dataDir,
    now: fixedNow,
    cardStore,
    edgeBudget: 2,
    edgeScoreThreshold: 0.01,
    attractorSimilarityThreshold: 0.18,
  });

  assert.equal(result.kind, 'DreamingResult');
  assert.equal(result.atomCount, 5);
  assert(result.attractorCount >= 1);
  assert(result.emittedCount >= 1);
  assert(result.emittedCount <= 2);
  assert.equal(result.edgeCards.length, result.emittedCount);
  assert.match(result.runPath, /^dreaming\/runs\/dream-/);

  const run = JSON.parse(await fs.readFile(path.join(dataDir, result.runPath), 'utf8'));
  assert.equal(run.kind, 'DreamingRun');
  assert.equal(run.decay.atomStates.length, 5);
  const oldAtom = run.decay.atomStates.find((entry) => entry.atomId === 'idea_dream_old');
  const freshAtom = run.decay.atomStates.find((entry) => entry.atomId === 'idea_dream_fresh');
  assert(oldAtom.decay < freshAtom.decay);

  const cards = await cardStore.listCards();
  assert.equal(cards.length, result.emittedCount);
  assert(cards.every((card) => card.kind === 'shaping'));
  // Dream cards keep their own edge-specific copy (hc1): explicit title/body win over
  // the generic composed defaults, while option labels still humanize via the normalizer (hc2).
  assert.equal(cards[0].title, 'nightly dreaming edge cards');
  assert.equal(
    cards[0].body,
    'nightly dreaming edge cards keep circling back — 3 conversations, still open.\nworth building on? · signal 0.16',
  );
  assert.equal(cards[0].recommendation, 'worth building on? · signal 0.16');
  assert.doesNotMatch(cards[0].body, /Dreaming found|Score [0-9]|convergence .* novelty .* recurring pull/);
  assert(cards.every((card) =>
    card.options.map((option) => option.label).join(',') === 'build it,nod to it,junk it'));
  assert(cards.every((card) =>
    card.options.map((option) => option.id).join(',') === 'build,nod,junk'));
  assert(cards.every((card) => card.sourceEdgeKey?.startsWith('dream-edge-')));
  assert.doesNotMatch(JSON.stringify(cards), /raw private sentence should not appear/i);

  const decisions = await decisionRecords(dataDir);
  assert.equal(decisions.length, result.emittedCount);
  assert(decisions.every((decision) => decision.kind === 'LoopRecommendation'));
  assert(decisions.every((decision) => decision.acted === 'pending'));
  assert(decisions.every((decision) => decision.source === 'dreaming'));
  assert(decisions.every((decision) => decision.recommendationKind === 'dreaming-edge-card'));
  assert(decisions.every((decision) => decision.provenance?.lane === 'dreaming'));
  assert(decisions.every((decision) => decision.decisionCard?.asked));
  assert.equal(
    decisions[0].summary,
    'nightly dreaming edge cards keep circling back — 3 conversations, still open. signal 0.16.',
  );
  assert.equal(decisions[0].decision, 'Build from nightly dreaming edge cards?');
  assert.equal(decisions[0].recommended, 'Review a reversible slice for nightly dreaming edge cards.');
  assert.equal(decisions[0].reason, '3 idea atoms across 3 conversations behind it.');
  assert.equal(decisions[0].decisionCard.why, 'the edge crossed the dreaming threshold · signal 0.16');
  assert.doesNotMatch(
    [
      decisions[0].summary,
      decisions[0].reason,
      decisions[0].decisionCard.why,
    ].join('\n'),
    /dream-edge-|scored 0\.\d+|convergence 0\.\d+|novelty 0\.\d+|recurring pull 0\.\d+/,
  );
  assert.doesNotMatch(JSON.stringify(decisions), /raw private sentence should not appear/i);

  const state = JSON.parse(await fs.readFile(path.join(dataDir, DREAMING_STATE_FILE), 'utf8'));
  assert.equal(state.kind, 'DreamingState');
  assert.equal(Object.keys(state.atomStates).length, 5);
  assert.equal(state.edgeHistory.length, result.emittedCount);

  const hitRate = JSON.parse(await fs.readFile(path.join(dataDir, DREAMING_HIT_RATE_FILE), 'utf8'));
  assert.equal(hitRate.kind, 'DreamingHitRate');
  assert.equal(hitRate.hitRate, null);
});

test('dream does not re-emit the same open edge on the next nightly pass', async () => {
  const dataDir = await tempDataDir();
  await seedDreamAtoms(dataDir);
  const cardStore = buildCardStore(dataDir);

  const first = await dream({
    dataDir,
    now: fixedNow,
    cardStore,
    edgeBudget: 2,
    edgeScoreThreshold: 0.01,
    attractorSimilarityThreshold: 0.18,
  });
  const second = await dream({
    dataDir,
    now: () => new Date('2026-07-07T03:00:00.000Z'),
    cardStore,
    edgeBudget: 2,
    edgeScoreThreshold: 0.01,
    attractorSimilarityThreshold: 0.18,
  });

  assert(first.emittedCount > 0);
  assert.equal(second.emittedCount, 0);
  assert.equal((await cardStore.listCards()).length, first.emittedCount);
  assert.equal((await decisionRecords(dataDir)).length, first.emittedCount);
});

test('dream queues over-budget edge cards for later nights', async () => {
  const dataDir = await tempDataDir();
  await seedDreamAtoms(dataDir);
  const cardStore = buildCardStore(dataDir);

  const result = await dream({
    dataDir,
    now: fixedNow,
    cardStore,
    attentionBudgetCaps: { [ATTENTION_CATEGORY_DREAMING_EDGE_CARD]: 0 },
    edgeScoreThreshold: 0.01,
    attractorSimilarityThreshold: 0.18,
  });

  assert.equal(result.emittedCount, 0);
  assert(result.queuedCount > 0);
  assert.equal(result.queuedEdgeCards[0].queuedUntil, '2026-07-07T03:00:00.000Z');
  assert.equal((await cardStore.listCards()).length, 0);
  assert.equal((await decisionRecords(dataDir)).length, 0);
});

test('dreaming hit-rate counts build-card acted and junk dispositions', async () => {
  const dataDir = await tempDataDir();
  await seedDreamAtoms(dataDir);
  const cardStore = buildCardStore(dataDir);

  const first = await dream({
    dataDir,
    now: fixedNow,
    cardStore,
    edgeBudget: 2,
    edgeScoreThreshold: 0.01,
    attractorSimilarityThreshold: 0.18,
  });
  assert(first.emittedCount > 0);

  const cards = await cardStore.listCards();
  await cardStore.answerCard({
    cardId: cards[0].id,
    optionId: 'build',
    isSameMachine: true,
    now: new Date('2026-07-06T04:00:00.000Z'),
  });
  if (cards[1]) {
    await cardStore.answerCard({
      cardId: cards[1].id,
      optionId: 'junk',
      isSameMachine: true,
      now: new Date('2026-07-06T04:01:00.000Z'),
    });
  }

  const second = await dream({
    dataDir,
    now: () => new Date('2026-07-07T03:00:00.000Z'),
    cardStore,
    edgeBudget: 2,
    edgeScoreThreshold: 0.01,
    attractorSimilarityThreshold: 0.18,
  });

  assert.equal(second.emittedCount, 0);
  assert.equal(second.hitRate.acted, 1);
  assert.equal(second.hitRate.hitRate, cards[1] ? 0.5 : 1);
  assert.equal(second.hitRate.dismissed, cards[1] ? 1 : 0);
  assert.equal(second.hitRate.junkRate, cards[1] ? 0.5 : 0);
});

async function seedDreamAtoms(dataDir) {
  await seedIdeaAtom(dataDir, {
    id: 'idea_dream_old',
    label: 'dreaming edge routine',
    statement: 'Dreaming routine should bunch recurring edge cards nightly.',
    eventAt: '2026-06-01T10:00:00.000Z',
    conversationId: 'conversation-dream-a',
  });
  await seedIdeaAtom(dataDir, {
    id: 'idea_dream_mid',
    label: 'nightly dreaming edge cards',
    statement: 'Nightly dreaming should emit edge cards only when recurrence converges.',
    eventAt: '2026-07-04T10:00:00.000Z',
    conversationId: 'conversation-dream-b',
  });
  await seedIdeaAtom(dataDir, {
    id: 'idea_dream_fresh',
    label: 'dreaming recurrence budget',
    statement: 'Recurring dreaming edge cards need budget and hit rate.',
    eventAt: '2026-07-06T01:00:00.000Z',
    conversationId: 'conversation-dream-c',
  });
  await seedIdeaAtom(dataDir, {
    id: 'idea_build_a',
    label: 'build shaping cards',
    statement: 'Build shaping cards need build nod junk answer options.',
    eventAt: '2026-07-05T09:00:00.000Z',
    conversationId: 'conversation-build-a',
  });
  await seedIdeaAtom(dataDir, {
    id: 'idea_build_b',
    label: 'build card verdict stack',
    statement: 'A raw private sentence should not appear in the build card body.',
    eventAt: '2026-07-05T09:30:00.000Z',
    conversationId: 'conversation-build-b',
  });
}

async function seedIdeaAtom(dataDir, overrides) {
  const dir = path.join(dataDir, 'substrate', 'idea-atoms');
  await fs.mkdir(dir, { recursive: true });
  const record = {
    kind: 'IdeaAtom',
    schemaVersion: 1,
    id: overrides.id,
    dedupeKey: `IdeaAtom::${overrides.id}`,
    contentHash: overrides.id,
    validFrom: overrides.eventAt,
    validTo: null,
    eventAt: overrides.eventAt,
    ingestedAt: overrides.ingestedAt ?? overrides.eventAt,
    supersededById: null,
    label: overrides.label,
    statement: overrides.statement,
    type: overrides.type ?? 'idea',
    confidence: overrides.confidence ?? 0.8,
    lifecycle: 'inbox',
    status: 'candidate',
    conversationId: overrides.conversationId,
    sourceExposureId: `${overrides.id}_exp`,
    sourceExposureIds: [`${overrides.id}_exp`],
    evidenceIds: [`${overrides.id}_exp`],
    frontierExcluded: true,
    provenance: {
      surface: 'mind',
      lane: 'deliberate',
    },
  };
  await fs.writeFile(path.join(dir, `${record.id}.json`), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return record;
}

function buildCardStore(dataDir) {
  let index = 0;
  return createBuildCardStore({
    dataDir,
    now: fixedNow,
    randomSuffix: () => {
      index += 1;
      return `dreamtest${index}`;
    },
  });
}

async function decisionRecords(dataDir) {
  const dir = path.join(dataDir, 'decisions');
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const records = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    records.push(JSON.parse(await fs.readFile(path.join(dir, entry.name), 'utf8')));
  }
  return records;
}

async function tempDataDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-dream-'));
}
