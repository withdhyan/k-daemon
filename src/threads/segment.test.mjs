import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  cosineSim,
  segment,
} from './segment.mjs';

test('cosineSim is exposed from the shared cosine helper', () => {
  assert.equal(cosineSim([1, 0], [1, 0]), 1);
  assert.equal(cosineSim([1, 0], [0, 1]), 0);
});

test('distinct semantic themes form cohesive threads', async () => {
  const threads = await segment(
    [
      exposure('attention-1', 'Mute feeds that steal attention.', '2026-06-20T10:00:00.000Z'),
      exposure('attention-2', 'Prefer one subtraction before adding another dashboard.', '2026-06-20T10:01:00.000Z'),
      exposure('memory-1', 'Persist the remembered context for strategy work.', '2026-06-20T10:02:00.000Z'),
      exposure('memory-2', 'Use memory retrieval for longitudinal evidence.', '2026-06-20T10:03:00.000Z'),
    ],
    await segmentOpts(),
  );

  assert.equal(threads.length, 2);
  assert.deepEqual(sortedThreadIds(threads), [
    ['attention-1', 'attention-2'],
    ['memory-1', 'memory-2'],
  ]);
  assert(threads.every((thread) => thread.threadId));
  assert(threads.every((thread) => thread.theme.length > 0));
});

test('a large temporal gap splits a thread even within one theme', async () => {
  const threads = await segment(
    [
      exposure('quiet-1', 'Keep the workflow quiet by default.', '2026-06-20T10:00:00.000Z'),
      exposure('quiet-2', 'Silence should remain the default surface.', '2026-06-20T10:05:00.000Z'),
      exposure('quiet-3', 'Quiet workflow still matters after the break.', '2026-06-21T10:05:01.000Z'),
    ],
    {
      ...(await segmentOpts()),
      maxTemporalGapMs: 60 * 60 * 1000,
    },
  );

  assert.deepEqual(threads.map((thread) => thread.exposureIds), [
    ['quiet-1', 'quiet-2'],
    ['quiet-3'],
  ]);
});

test('a conversationId change starts a new thread', async () => {
  const threads = await segment(
    [
      exposure('same-theme-1', 'Advisory output stays quiet unless earned.', '2026-06-20T10:00:00.000Z', {
        conversationId: 'conversation-a',
      }),
      exposure('same-theme-2', 'Advisory silence remains the default gate.', '2026-06-20T10:01:00.000Z', {
        conversationId: 'conversation-b',
      }),
    ],
    await segmentOpts(),
  );

  assert.deepEqual(threads.map((thread) => thread.exposureIds), [
    ['same-theme-1'],
    ['same-theme-2'],
  ]);
});

test('a single-theme contiguous set becomes one thread', async () => {
  const threads = await segment(
    [
      exposure('strategy-1', 'Strategy work needs fewer dashboards.', '2026-06-20T10:00:00.000Z'),
      exposure('strategy-2', 'Strategize from outcomes instead of another board.', '2026-06-20T10:02:00.000Z'),
      exposure('strategy-3', 'Outcome strategy should stay focused.', '2026-06-20T10:03:00.000Z'),
    ],
    await segmentOpts(),
  );

  assert.equal(threads.length, 1);
  assert.deepEqual(threads[0].exposureIds, ['strategy-1', 'strategy-2', 'strategy-3']);
  assert.deepEqual(threads[0].window, {
    start: '2026-06-20T10:00:00.000Z',
    end: '2026-06-20T10:03:00.000Z',
  });
});

test('segmentation is deterministic with a fixed fake embedder', async () => {
  const exposures = [
    exposure('attention-1', 'Mute feeds that steal attention.', '2026-06-20T10:00:00.000Z'),
    exposure('memory-1', 'Use memory retrieval for evidence.', '2026-06-20T10:01:00.000Z'),
    exposure('attention-2', 'Attention should stay protected.', '2026-06-20T10:02:00.000Z'),
  ];
  const first = await segment(exposures, await segmentOpts());
  const second = await segment(exposures, await segmentOpts());

  assert.deepEqual(second, first);
});

test('empty exposure input returns no threads', async () => {
  assert.deepEqual(await segment([], await segmentOpts()), []);
});

async function segmentOpts() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-segment-data-'));
  return {
    dataDir,
    cacheDir: path.join(dataDir, 'embeddings'),
    embedder: fakeEmbedder,
    similarityThreshold: 0.8,
  };
}

function exposure(id, statement, eventAt, opts = {}) {
  return {
    id,
    kind: 'Exposure',
    type: 'observation',
    statement,
    eventAt,
    metadata: {
      conversationId: opts.conversationId ?? 'conversation-1',
      human: true,
      signalWeight: 2,
    },
    provenance: { surface: 'test', lane: 'deliberate' },
  };
}

async function fakeEmbedder(prompt) {
  const lower = prompt.toLowerCase();
  if (
    lower.includes('attention') ||
    lower.includes('dashboard') ||
    lower.includes('feed') ||
    lower.includes('subtract')
  ) {
    return [1, 0.02];
  }
  if (
    lower.includes('memory') ||
    lower.includes('remember') ||
    lower.includes('context') ||
    lower.includes('retrieval') ||
    lower.includes('evidence')
  ) {
    return [0.02, 1];
  }
  return [0.98, 0.04];
}

function sortedThreadIds(threads) {
  return threads
    .map((thread) => thread.exposureIds.slice().sort())
    .sort((a, b) => a[0].localeCompare(b[0]));
}
