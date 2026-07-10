import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ATTENTION_CATEGORY_BODY_CUE,
  ATTENTION_CATEGORY_CADENCE_NUDGE,
  ATTENTION_CATEGORY_DREAMING_EDGE_CARD,
  admit,
  categoryCap,
  listQueuedAttentionBudgetItems,
  spentToday,
} from './attention-budget.mjs';

test('attention budget enforces caps independently per category', async () => {
  const dataDir = await tempDataDir();
  const caps = {
    [ATTENTION_CATEGORY_CADENCE_NUDGE]: 1,
    [ATTENTION_CATEGORY_BODY_CUE]: 2,
  };

  const firstCadence = admit(record('cadence-1', ATTENTION_CATEGORY_CADENCE_NUDGE), { dataDir, caps, now: fixedNow });
  const secondCadence = admit(record('cadence-2', ATTENTION_CATEGORY_CADENCE_NUDGE), { dataDir, caps, now: fixedNow });
  const firstBody = admit(record('body-1', ATTENTION_CATEGORY_BODY_CUE), { dataDir, caps, now: fixedNow });
  const secondBody = admit(record('body-2', ATTENTION_CATEGORY_BODY_CUE), { dataDir, caps, now: fixedNow });
  const thirdBody = admit(record('body-3', ATTENTION_CATEGORY_BODY_CUE), { dataDir, caps, now: fixedNow });

  assert.equal(firstCadence.status, 'admitted');
  assert.equal(secondCadence.status, 'queued');
  assert.equal(firstBody.status, 'admitted');
  assert.equal(secondBody.status, 'admitted');
  assert.equal(thirdBody.status, 'queued');
  assert.equal(spentToday(ATTENTION_CATEGORY_CADENCE_NUDGE, { dataDir, now: fixedNow }), 1);
  assert.equal(spentToday(ATTENTION_CATEGORY_BODY_CUE, { dataDir, now: fixedNow }), 2);
  assert.equal(categoryCap(ATTENTION_CATEGORY_DREAMING_EDGE_CARD, { env: {} }), 2);
});

test('over-cap queue is ranked within category for later admission', async () => {
  const dataDir = await tempDataDir();
  const caps = { [ATTENTION_CATEGORY_BODY_CUE]: 0 };

  admit(record('low', ATTENTION_CATEGORY_BODY_CUE, { score: 0.2 }), { dataDir, caps, now: fixedNow });
  admit(record('high', ATTENTION_CATEGORY_BODY_CUE, { score: 0.9 }), { dataDir, caps, now: fixedNow });
  admit(record('mid', ATTENTION_CATEGORY_BODY_CUE, { score: 0.5 }), { dataDir, caps, now: fixedNow });

  const queued = listQueuedAttentionBudgetItems({ dataDir });
  assert.deepEqual(queued.map((item) => item.id), ['high', 'mid', 'low']);
  assert.deepEqual(queued.map((item) => item.queuedUntil), [
    '2026-07-06T06:00:00.000Z',
    '2026-07-06T06:00:00.000Z',
    '2026-07-06T06:00:00.000Z',
  ]);
});

test('attention budget rolls over at midnight by persisted date file', async () => {
  const dataDir = await tempDataDir();
  const caps = { [ATTENTION_CATEGORY_DREAMING_EDGE_CARD]: 1 };

  const beforeMidnight = admit(record('night-1', ATTENTION_CATEGORY_DREAMING_EDGE_CARD), {
    dataDir,
    caps,
    now: () => new Date('2026-07-05T23:59:00.000Z'),
  });
  const sameNightCap = admit(record('night-2', ATTENTION_CATEGORY_DREAMING_EDGE_CARD), {
    dataDir,
    caps,
    now: () => new Date('2026-07-05T23:59:30.000Z'),
  });
  const afterMidnight = admit(record('night-3', ATTENTION_CATEGORY_DREAMING_EDGE_CARD), {
    dataDir,
    caps,
    now: () => new Date('2026-07-06T00:01:00.000Z'),
  });

  assert.equal(beforeMidnight.status, 'admitted');
  assert.equal(sameNightCap.status, 'queued');
  assert.equal(sameNightCap.queuedUntil, '2026-07-06T03:00:00.000Z');
  assert.equal(afterMidnight.status, 'admitted');
  assert.equal(spentToday(ATTENTION_CATEGORY_DREAMING_EDGE_CARD, {
    dataDir,
    date: '2026-07-05',
  }), 1);
  assert.equal(spentToday(ATTENTION_CATEGORY_DREAMING_EDGE_CARD, {
    dataDir,
    date: '2026-07-06',
  }), 1);
});

test('attention budget store errors fail soft and admit', async () => {
  const dataDir = await tempDataDir();
  await fs.writeFile(path.join(dataDir, 'attention-budget'), 'not a directory\n', 'utf8');
  const warnings = [];
  const logger = { warn: (message) => warnings.push(message) };

  const result = admit(record('cue-1', ATTENTION_CATEGORY_BODY_CUE), {
    dataDir,
    logger,
    now: fixedNow,
  });

  assert.equal(result.status, 'admitted');
  assert.equal(result.failSoft, true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /attention budget admit failed; admitting fail-soft/);
});

function record(id, category, overrides = {}) {
  return {
    id,
    category,
    title: id,
    score: 0.5,
    eventAt: '2026-07-05T12:00:00.000Z',
    ...overrides,
  };
}

function fixedNow() {
  return new Date('2026-07-05T12:00:00.000Z');
}

async function tempDataDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-attention-budget-'));
}
