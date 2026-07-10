import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSubstrateStore } from '../substrate.mjs';
import { research } from './pipeline.mjs';

const fixedNow = () => new Date('2026-06-28T00:00:00.000Z');

test('research returns k graded evidence items over substrate records', async () => {
  const { store, dataDir, cacheDir } = await researchFixture();

  const results = await research('alpha query', {
    store,
    dataDir,
    cacheDir,
    testEmbedder: fakeEmbedder,
    k: 3,
    vrsdIntermediate: 3,
    levyWalks: 1,
    minDistance: 0.8,
    random: () => 0.5,
  });

  assert.equal(results.length, 3);
  assert(results.every((item) => /^L[1-4]$/.test(item.evidenceGrade)));
  assert(results.every((item) => item.evidenceIds.length === 1));
  assert(results.every((item) => item.attentionState === 'neutral'));
  assert.deepEqual(results.map((item) => item.kind), [
    'Exposure',
    'Exposure',
    'Exposure',
  ]);
});

test('research surfaces evidenceIds and writes no substrate records', async () => {
  const { store, dataDir, cacheDir } = await researchFixture();
  const beforeCount = await store.countRecords();
  store.writeExposure = async () => {
    throw new Error('research must not write Exposure records');
  };

  const results = await research('alpha query', {
    store,
    dataDir,
    cacheDir,
    testEmbedder: fakeEmbedder,
    k: 2,
    levy: false,
  });

  assert.equal(await store.countRecords(), beforeCount);
  assert.equal(results.length, 2);
  assert(results.every((item) => item.evidenceId));
  assert.deepEqual(
    results.map((item) => item.evidenceIds),
    results.map((item) => [item.evidenceId]),
  );
});

test('recordFilter seam can opt into sovereign records without changing the default', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-research-filter-'));
  const cacheDir = path.join(dataDir, 'embeddings');
  const store = createSubstrateStore({ dataDir, now: fixedNow });
  const privateRecord = await store.writeExposure({
    type: 'reference',
    statement: 'private alpha evidence',
    sourceId: 'private:1',
    eventAt: '2026-07-02T00:00:00.000Z',
    provenance: { surface: 'chatgpt', lane: 'deliberate' },
  });
  const publicRecord = await store.writeExposure({
    type: 'reference',
    statement: 'public beta evidence',
    sourceId: 'public:1',
    eventAt: '2026-07-02T00:00:00.000Z',
    provenance: { surface: 'test', lane: 'deliberate' },
  });

  const defaultResults = await research('private query', {
    store,
    dataDir,
    cacheDir,
    testEmbedder: filterEmbedder,
    k: 2,
    levy: false,
    argus: false,
  });
  const sovereignResults = await research('private query', {
    store,
    dataDir,
    cacheDir,
    testEmbedder: filterEmbedder,
    k: 2,
    levy: false,
    argus: false,
    recordFilter: (records) => records,
  });

  assert(!defaultResults.some((item) => item.evidenceId === privateRecord.id));
  assert(defaultResults.some((item) => item.evidenceId === publicRecord.id));
  assert(sovereignResults.some((item) => item.evidenceId === privateRecord.id));
});

test('research does not forward arbitrary embedder options in the pipeline path', async () => {
  const { store, dataDir, cacheDir } = await researchFixture();
  let embedderCalls = 0;
  let fetchCalls = 0;

  const results = await research('alpha query', {
    store,
    dataDir,
    cacheDir,
    k: 1,
    levy: false,
    argus: false,
    vrsdIntermediate: 1,
    embedder: async () => {
      embedderCalls += 1;
      throw new Error('pipeline must not forward opts.embedder');
    },
    fetchImpl: async (_url, init) => {
      fetchCalls += 1;
      const { prompt } = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({ embedding: await fakeEmbedder(prompt) }),
      };
    },
  });

  assert.equal(results.length, 1);
  assert.equal(embedderCalls, 0);
  assert(fetchCalls > 0);
});

test('research returns empty gracefully when the substrate has no embedding index', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-research-empty-'));
  const cacheDir = path.join(dataDir, 'embeddings');
  const store = createSubstrateStore({ dataDir, now: fixedNow });
  let calls = 0;

  const results = await research('alpha query', {
    store,
    dataDir,
    cacheDir,
    testEmbedder: async () => {
      calls += 1;
      throw new Error('empty substrate should not request embeddings');
    },
  });

  assert.deepEqual(results, []);
  assert.equal(calls, 0);
});

async function researchFixture() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-research-'));
  const cacheDir = path.join(dataDir, 'embeddings');
  const store = createSubstrateStore({ dataDir, now: fixedNow });

  for (const [sourceId, statement] of [
    ['alpha:1', 'alpha exact evidence'],
    ['alpha:2', 'alpha upper evidence'],
    ['alpha:3', 'alpha lower evidence'],
    ['alpha:4', 'distant monthly leap'],
  ]) {
    await store.writeExposure({
      type: 'reference',
      statement,
      sourceId,
      eventAt: '2026-06-27T00:00:00.000Z',
      provenance: { surface: 'test', lane: 'deliberate' },
    });
  }

  return { store, dataDir, cacheDir };
}

async function fakeEmbedder(prompt) {
  const vectors = new Map([
    ['alpha query', [1, 0]],
    ['alpha exact evidence', [1, 0]],
    ['alpha upper evidence', [0.8, 0.6]],
    ['alpha lower evidence', [0.8, -0.6]],
    ['distant monthly leap', [0, 1]],
  ]);

  const vector = vectors.get(prompt);
  if (!vector) throw new Error(`missing fake vector for: ${prompt}`);
  return vector;
}

async function filterEmbedder(prompt) {
  if (prompt === 'private query') return [1, 0];
  if (prompt === 'private alpha evidence') return [1, 0];
  if (prompt === 'public beta evidence') return [0, 1];
  throw new Error(`missing fake vector for: ${prompt}`);
}
