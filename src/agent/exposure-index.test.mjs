import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  EXPOSURE_INDEX_FILE,
  backfillExposureIndex,
  loadExposureIndex,
} from './exposure-index.mjs';
import { createSubstrateStore } from '../substrate.mjs';

const fixedNow = () => new Date('2026-07-02T12:00:00.000Z');

test('exposure index backfill is idempotent once statements are cached', async () => {
  const { dataDir, store } = await freshStore();
  await seedExposure(store, 'first local-only memory', '2026-07-01T00:00:00.000Z');
  await seedExposure(store, 'second local-only memory', '2026-07-01T01:00:00.000Z');
  const calls = [];

  const first = await backfillExposureIndex({
    store,
    dataDir,
    now: fixedNow,
    embeddingOptions: {
      embedder: async (prompt) => {
        calls.push(prompt);
        return vectorFor(prompt);
      },
    },
  });
  const second = await backfillExposureIndex({
    store,
    dataDir,
    now: fixedNow,
    embeddingOptions: {
      embedder: async (prompt) => {
        calls.push(prompt);
        return vectorFor(prompt);
      },
    },
  });

  assert.equal(first.indexedCount, 2);
  assert.equal(first.capReached, false);
  assert.equal(second.indexedCount, 0);
  assert.equal(second.skippedCount, 2);
  assert.equal(calls.length, 2);
  assert.equal(Object.keys((await loadExposureIndex({ dataDir })).entries).length, 2);
  assert.ok(await fileExists(path.join(dataDir, EXPOSURE_INDEX_FILE)));
});

test('exposure index backfill caps new embeddings per pass and continues later', async () => {
  const { dataDir, store } = await freshStore();
  await seedExposure(store, 'bounded pass one', '2026-07-01T00:00:00.000Z');
  await seedExposure(store, 'bounded pass two', '2026-07-01T01:00:00.000Z');
  await seedExposure(store, 'bounded pass three', '2026-07-01T02:00:00.000Z');

  const first = await backfillExposureIndex({
    store,
    dataDir,
    now: fixedNow,
    limit: 2,
    embeddingOptions: { embedder: async (prompt) => vectorFor(prompt) },
  });
  const second = await backfillExposureIndex({
    store,
    dataDir,
    now: fixedNow,
    limit: 2,
    embeddingOptions: { embedder: async (prompt) => vectorFor(prompt) },
  });

  assert.equal(first.indexedCount, 2);
  assert.equal(first.capReached, true);
  assert.equal(Object.keys((await loadExposureIndex({ dataDir })).entries).length, 3);
  assert.equal(second.indexedCount, 1);
  assert.equal(second.capReached, false);
});

test('exposure index backfill fails soft when the local embedder is unavailable', async () => {
  const { dataDir, store } = await freshStore();
  await seedExposure(store, 'ollama unavailable should not throw', '2026-07-01T00:00:00.000Z');
  const logs = [];

  const result = await backfillExposureIndex({
    store,
    dataDir,
    now: fixedNow,
    embeddingOptions: {
      embedder: async () => {
        throw new Error('Ollama down');
      },
    },
    logger: { warn: (...args) => logs.push(args) },
  });

  assert.equal(result.indexedCount, 0);
  assert.equal(result.failedCount, 1);
  assert.equal(result.ok, true);
  assert.equal(Object.keys((await loadExposureIndex({ dataDir })).entries).length, 0);
  assert.equal(logs.length, 1);
});

async function freshStore() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-exposure-index-'));
  return {
    dataDir,
    store: createSubstrateStore({ dataDir, now: fixedNow }),
  };
}

async function seedExposure(store, statement, eventAt, surface = 'claude') {
  return store.writeExposure({
    type: 'observation',
    statement,
    eventAt,
    provenance: { surface, lane: 'deliberate' },
  });
}

function vectorFor(prompt) {
  return [prompt.length, prompt.charCodeAt(0) ?? 0, 1];
}

async function fileExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
