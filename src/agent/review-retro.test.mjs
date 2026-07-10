import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  computeWeeklyRetro,
  weeklyRetroFromDataDir,
} from './review-retro.mjs';

const fixedNow = () => new Date('2026-07-06T12:00:00.000Z');

test('weekly retro builds eval-health panel data for the trailing week', () => {
  const retro = computeWeeklyRetro({
    now: fixedNow(),
    cadenceActs: [
      cadenceAct({
        completedAt: '2026-07-01T10:00:00.000Z',
        wellSpent: true,
        motionProgress: 'progress',
      }),
      cadenceAct({
        completedAt: '2026-07-02T10:00:00.000Z',
        wellSpent: false,
        motionProgress: 'motion',
      }),
      cadenceAct({
        completedAt: '2026-07-03T10:00:00.000Z',
        twsResponse: 'no-response',
        motionProgress: 'progress',
      }),
      cadenceAct({
        completedAt: '2026-06-20T10:00:00.000Z',
        wellSpent: true,
        motionProgress: 'progress',
      }),
    ],
    workEntries: [
      workEntry({
        createdAt: '2026-07-04T10:00:00.000Z',
        motionVsProgress: 'motion',
      }),
      workEntry({
        createdAt: '2026-07-05T10:00:00.000Z',
      }),
    ],
    decisions: [
      decision({
        createdAt: '2026-07-01T09:00:00.000Z',
        acted: 'acted',
      }),
      decision({
        createdAt: '2026-07-02T09:00:00.000Z',
        acted: 'pending',
      }),
      decision({
        createdAt: '2026-06-20T09:00:00.000Z',
        acted: 'acted',
      }),
    ],
    dreamingEdgeCards: [
      dreamingCard({
        actedAt: '2026-07-01T22:00:00.000Z',
        disposition: 'acted',
      }),
      dreamingCard({
        dismissedAt: '2026-07-02T22:00:00.000Z',
        disposition: 'dismissed',
      }),
      dreamingCard({
        expiredAt: '2026-07-03T22:00:00.000Z',
        disposition: 'expired',
      }),
      dreamingCard({
        createdAt: '2026-07-04T22:00:00.000Z',
        status: 'queued',
      }),
      dreamingCard({
        actedAt: '2026-06-20T22:00:00.000Z',
        disposition: 'acted',
      }),
    ],
  });

  assert.equal(retro.kind, 'WeeklyRetro');
  assert.deepEqual(retro.week, {
    start: '2026-06-30',
    end: '2026-07-06',
    days: 7,
  });
  assert.equal(retro.generatedAt, '2026-07-06T12:00:00.000Z');

  assert.deepEqual(withoutTrend(retro.evalHealth.tws), {
    promptCount: 3,
    answeredCount: 2,
    yesCount: 1,
    noCount: 1,
    noResponseCount: 1,
    score: 0.5,
    responseRate: 0.6667,
  });
  assert.deepEqual(retro.evalHealth.tws.trend.map((bucket) => bucket.date), [
    '2026-06-30',
    '2026-07-01',
    '2026-07-02',
    '2026-07-03',
    '2026-07-04',
    '2026-07-05',
    '2026-07-06',
  ]);
  assert.deepEqual(bucket(retro, '2026-07-01'), {
    date: '2026-07-01',
    promptCount: 1,
    answeredCount: 1,
    yesCount: 1,
    noCount: 0,
    noResponseCount: 0,
    score: 1,
    responseRate: 1,
  });
  assert.deepEqual(bucket(retro, '2026-07-03'), {
    date: '2026-07-03',
    promptCount: 1,
    answeredCount: 0,
    yesCount: 0,
    noCount: 0,
    noResponseCount: 1,
    score: null,
    responseRate: 0,
  });

  assert.deepEqual(retro.evalHealth.decisionSignal, {
    recommended: 2,
    acted: 1,
    actedPerWeek: 1,
    rate: 0.5,
    weeks: [
      {
        week: '2026-W27',
        start: '2026-06-29',
        end: '2026-07-05',
        recommended: 2,
        acted: 1,
        rate: 0.5,
      },
      {
        week: '2026-W28',
        start: '2026-07-06',
        end: '2026-07-12',
        recommended: 0,
        acted: 0,
        rate: null,
      },
    ],
  });
  assert.deepEqual(retro.evalHealth.dreaming, {
    edgeCards: 4,
    dispositioned: 3,
    acted: 1,
    dismissed: 1,
    expired: 1,
    pending: 1,
    hitRate: 0.3333,
  });
  assert.deepEqual(retro.evalHealth.motionVsProgress, {
    entries: 5,
    motion: 2,
    progress: 2,
    untagged: 1,
    tagged: 4,
    progressRate: 0.5,
  });
});

test('weekly retro reads known data dirs and skips corrupt optional artifacts', async () => {
  const dataDir = await tempDataDir();
  await writeJson(dataDir, 'cadence/acts/2026-07-06/act.json', cadenceAct({
    completedAt: '2026-07-06T08:00:00.000Z',
    wellSpent: true,
    motionProgress: 'progress',
  }));
  await writeText(dataDir, 'cadence/acts/broken.json', '{not json');
  await writeJson(dataDir, 'work/entries/work.json', workEntry({
    createdAt: '2026-07-06T09:00:00.000Z',
    motionVsProgress: 'motion',
  }));
  await writeJson(dataDir, 'decisions/decision.json', decision({
    createdAt: '2026-07-06T09:30:00.000Z',
    acted: 'acted',
  }));
  await writeJson(dataDir, 'dreaming/edge-cards/edge.json', dreamingCard({
    actedAt: '2026-07-06T10:00:00.000Z',
    status: 'acted',
  }));
  await writeJson(dataDir, 'build/cards/not-dreaming.json', {
    kind: 'drift',
    status: 'applied',
    createdAt: '2026-07-06T10:00:00.000Z',
  });

  const retro = await weeklyRetroFromDataDir({ dataDir, now: fixedNow() });

  assert.equal(retro.evalHealth.tws.promptCount, 1);
  assert.equal(retro.evalHealth.tws.score, 1);
  assert.equal(retro.evalHealth.decisionSignal.actedPerWeek, 1);
  assert.equal(retro.evalHealth.dreaming.edgeCards, 1);
  assert.equal(retro.evalHealth.dreaming.hitRate, 1);
  assert.deepEqual(retro.evalHealth.motionVsProgress, {
    entries: 2,
    motion: 1,
    progress: 1,
    untagged: 0,
    tagged: 2,
    progressRate: 0.5,
  });
});

test('weekly retro includes substrate KDecision records in decision signal', async () => {
  const dataDir = await tempDataDir();
  await writeJson(dataDir, 'substrate/decisions/kdecision.json', {
    kind: 'KDecision',
    schemaVersion: 1,
    observation: 'The founder accepted the recommendation.',
    conclusion: 'Count the acted KDecision.',
    acted: 'acted',
    actedAt: '2026-07-06T10:00:00.000Z',
    createdAt: '2026-07-06T09:00:00.000Z',
  });

  const retro = await weeklyRetroFromDataDir({ dataDir, now: fixedNow() });

  assert.equal(retro.evalHealth.decisionSignal.recommended, 1);
  assert.equal(retro.evalHealth.decisionSignal.acted, 1);
  assert.deepEqual(retro.evalHealth.decisionSignal.weeks.at(-1), {
    week: '2026-W28',
    start: '2026-07-06',
    end: '2026-07-12',
    recommended: 1,
    acted: 1,
    rate: 1,
  });
});

test('weekly retro renders empty eval-health panel without imputing silence', () => {
  const retro = computeWeeklyRetro({ now: fixedNow() });

  assert.deepEqual(withoutTrend(retro.evalHealth.tws), {
    promptCount: 0,
    answeredCount: 0,
    yesCount: 0,
    noCount: 0,
    noResponseCount: 0,
    score: null,
    responseRate: null,
  });
  assert.equal(retro.evalHealth.tws.trend.length, 7);
  assert(retro.evalHealth.tws.trend.every((day) => day.score === null));
  assert.deepEqual(retro.evalHealth.decisionSignal, {
    recommended: 0,
    acted: 0,
    actedPerWeek: 0,
    rate: null,
    weeks: [
      {
        week: '2026-W27',
        start: '2026-06-29',
        end: '2026-07-05',
        recommended: 0,
        acted: 0,
        rate: null,
      },
      {
        week: '2026-W28',
        start: '2026-07-06',
        end: '2026-07-12',
        recommended: 0,
        acted: 0,
        rate: null,
      },
    ],
  });
  assert.deepEqual(retro.evalHealth.dreaming, {
    edgeCards: 0,
    dispositioned: 0,
    acted: 0,
    dismissed: 0,
    expired: 0,
    pending: 0,
    hitRate: null,
  });
  assert.deepEqual(retro.evalHealth.motionVsProgress, {
    entries: 0,
    motion: 0,
    progress: 0,
    untagged: 0,
    tagged: 0,
    progressRate: null,
  });
});

function cadenceAct(overrides = {}) {
  return {
    kind: 'CadenceAct',
    blockId: 'block-1',
    action: 'complete',
    completedAt: '2026-07-06T10:00:00.000Z',
    ...overrides,
  };
}

function workEntry(overrides = {}) {
  return {
    kind: 'WorkEntry',
    id: 'work-1',
    title: 'Advance the build',
    createdAt: '2026-07-06T10:00:00.000Z',
    ...overrides,
  };
}

function decision(overrides = {}) {
  return {
    kind: 'LoopRecommendation',
    schemaVersion: 1,
    station: 'decide',
    date: '2026-07-06',
    verdict: 'recommend',
    acted: 'pending',
    advisoryOnly: true,
    decision: 'Whether to count this recommendation.',
    recommended: 'Review the recommendation.',
    reason: 'It is captured.',
    reversibility: 'internal-revertible',
    undo: 'Leave it pending.',
    evidenceIds: [],
    confidence: 0.5,
    summary: 'Captured recommendation.',
    createdAt: '2026-07-06T09:00:00.000Z',
    ...overrides,
  };
}

function dreamingCard(overrides = {}) {
  return {
    kind: 'DreamingEdgeCard',
    id: 'edge-1',
    title: 'Something real here?',
    createdAt: '2026-07-06T22:00:00.000Z',
    ...overrides,
  };
}

function withoutTrend(tws) {
  const { trend, ...rest } = tws;
  return rest;
}

function bucket(retro, date) {
  return retro.evalHealth.tws.trend.find((candidate) => candidate.date === date);
}

async function tempDataDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-review-retro-'));
}

async function writeJson(dataDir, relPath, value) {
  await writeText(dataDir, relPath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeText(dataDir, relPath, text) {
  const file = path.join(dataDir, relPath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, 'utf8');
}
