import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  TWS_BLIND_SPOT_NOTE,
  computeTwsFromDataDir,
  computeTimeWellSpent,
  computeTimeWellSpentFromDir,
} from './tws.mjs';

test('acted-on recommendations increment decision-signal', () => {
  const reading = computeTimeWellSpent([
    stagedDecision({ acted: 'acted' }),
  ]);

  assert.equal(reading.recommended, 1);
  assert.equal(reading.acted, 1);
  assert.equal(reading.decisionSignal, 1);
});

test('pending recommendations are reasoned but not revealed acted-on signal', () => {
  const reading = computeTimeWellSpent([
    stagedDecision({ acted: 'acted' }),
    stagedDecision({
      acted: 'pending',
      recommended: 'Leave this staged.',
      surface: 'body',
      recommendationKind: 'body-protocol',
    }),
  ]);

  assert.equal(reading.recommended, 2);
  assert.equal(reading.acted, 1);
  assert.equal(reading.decisionSignal, 0.5);
  assert.deepEqual(reading.dimensions.body, {
    recommended: 1,
    acted: 0,
    decisionSignal: 0,
  });
});

test('earned silence is counted separately and does not lower the signal', () => {
  const withoutSilence = computeTimeWellSpent([
    stagedDecision({ acted: 'acted' }),
  ]);
  const withSilence = computeTimeWellSpent([
    stagedDecision({ acted: 'acted' }),
  ], {
    silenceCount: 4,
  });

  assert.equal(withSilence.silenceCount, 4);
  assert.equal(withSilence.decisionSignal, withoutSilence.decisionSignal);
});

test('non-advisory records are excluded from recommendation signal', () => {
  const advisoryAbsent = stagedDecision({
    acted: 'acted',
    recommended: 'This missing advisory flag must not count.',
  });
  delete advisoryAbsent.advisoryOnly;

  const reading = computeTimeWellSpent([
    stagedDecision({
      acted: 'pending',
      recommended: 'Keep this valid recommendation pending.',
    }),
    stagedDecision({
      acted: 'pending',
      recommended: 'Keep this second valid recommendation pending.',
    }),
    stagedDecision({
      acted: 'acted',
      advisoryOnly: false,
      recommended: 'This non-advisory record must not count.',
    }),
    advisoryAbsent,
  ]);

  assert.equal(reading.recommended, 2);
  assert.equal(reading.acted, 0);
  assert.equal(reading.decisionSignal, 0);
});

test('shadow-mode directory read does not create or mutate decision artifacts', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-tws-data-'));
  const decisionsDir = path.join(dataDir, 'decisions');
  const decisionPath = path.join(decisionsDir, '2026-06-27T00-00-00.json');
  const record = stagedDecision({ acted: 'acted' });

  await fs.mkdir(decisionsDir, { recursive: true });
  await fs.writeFile(decisionPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  const beforeEntries = await sortedFiles(decisionsDir);
  const beforeContent = await fs.readFile(decisionPath, 'utf8');

  const reading = await computeTimeWellSpentFromDir(dataDir);

  assert.equal(reading.decisionSignal, 1);
  assert.deepEqual(await sortedFiles(decisionsDir), beforeEntries);
  assert.equal(await fs.readFile(decisionPath, 'utf8'), beforeContent);
});

test('shadow-mode directory read does not create a missing decisions directory', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-tws-data-'));

  const reading = await computeTimeWellSpentFromDir(dataDir, { silenceCount: 2 });

  assert.deepEqual(reading, {
    recommended: 0,
    acted: 0,
    decisionSignal: null,
    silenceCount: 2,
    dimensions: {
      body: {
        recommended: 0,
        acted: 0,
        decisionSignal: null,
      },
    },
  });
  await assert.rejects(
    fs.stat(path.join(dataDir, 'decisions')),
    (error) => error.code === 'ENOENT',
  );
});

test('computeTwsFromDataDir reports captured decisions and explicit blind spots', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-tws-data-'));
  const decisionsDir = path.join(dataDir, 'decisions');
  await fs.mkdir(decisionsDir, { recursive: true });
  await fs.writeFile(
    path.join(decisionsDir, '2026-07-02T00-00-00.json'),
    `${JSON.stringify(stagedDecision({ acted: 'acted' }), null, 2)}\n`,
    'utf8',
  );
  await fs.writeFile(
    path.join(decisionsDir, '2026-07-02T00-01-00.json'),
    `${JSON.stringify(stagedDecision({
      tag: '[advise]',
      decisionCard: {
        asked: 'Should this deliberation recommendation count?',
        read: ['exp_research_1'],
        assumed: [],
        missing: [],
        pick: 'Count it.',
        why: 'It is a captured LoopRecommendation.',
        whatWouldChangeIt: 'No persisted recommendation.',
        next: 'Review later.',
      },
    }), null, 2)}\n`,
    'utf8',
  );

  const report = await computeTwsFromDataDir({
    dataDir,
    now: () => new Date('2026-07-02T00:05:00.000Z'),
  });

  assert.equal(report.score, 0.5);
  assert.deepEqual(report.counted, {
    recommended: 2,
    acted: 1,
    silenceCount: 0,
  });
  assert.deepEqual(report.dimensions.body, {
    recommended: 0,
    acted: 0,
    decisionSignal: null,
  });
  assert.deepEqual(report.blindSpots, [{
    kind: 'coverage',
    note: TWS_BLIND_SPOT_NOTE,
  }]);
});

function stagedDecision(overrides = {}) {
  return {
    kind: 'LoopRecommendation',
    schemaVersion: 1,
    station: 'decide',
    date: '2026-06-27',
    verdict: 'recommend',
    acted: 'pending',
    advisoryOnly: true,
    decision: 'Whether to review attention-capture bookmarks today.',
    recommended: 'Review only the bookmarks tied to current attention recovery.',
    reason: 'The substrate shows saved references, but no authority to act.',
    reversibility: 'internal-revertible',
    undo: 'Drop the review note and leave the bookmarks untouched.',
    evidenceIds: ['exp_test'],
    confidence: 0.42,
    summary: 'Stage one local attention recommendation.',
    createdAt: '2026-06-27T00:00:00.000Z',
    ...overrides,
  };
}

async function sortedFiles(dir) {
  return (await fs.readdir(dir)).sort();
}
