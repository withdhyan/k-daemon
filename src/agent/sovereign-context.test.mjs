import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { chatContext, sovereignChatContext } from '../../daemon/server.mjs';
import { backfillExposureIndex } from './exposure-index.mjs';
import { createSubstrateStore } from '../substrate.mjs';

const fixedNow = () => new Date('2026-07-02T12:00:00.000Z');

async function freshStore() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-sovereign-ctx-'));
  return createSubstrateStore({ dataDir, now: fixedNow });
}

async function seedChatExposure(store) {
  await store.writeExposure({
    type: 'observation',
    statement: 'weighing the Neurosity Crown against ambulatory EEG artifact limits',
    context: 'EEG hardware for the dhyan footprint',
    eventAt: '2026-06-30T09:00:00.000Z',
    provenance: { surface: 'claude', lane: 'deliberate' },
  });
}

test('sovereignChatContext carries chat-sourced statements the frontier-safe context strips', async () => {
  const store = await freshStore();
  await seedChatExposure(store);
  const args = { store, dataDir: store.dataDir, now: fixedNow };

  const frontier = await chatContext(args);
  const sovereign = await sovereignChatContext(args);

  // The frontier-safe endpoint must keep excluding claude-surface records…
  assert.ok(!frontier.block.includes('Neurosity Crown'));
  // …while the sovereign turn sees the founder's actual material, content-first.
  assert.ok(sovereign.block.includes('Neurosity Crown'));
  assert.ok(sovereign.block.includes('EEG hardware for the dhyan footprint'));
  assert.ok(sovereign.block.includes("## The founder's recent exposures"));
});

test('sovereignChatContext omits content-free exposures and empty sections', async () => {
  const store = await freshStore();
  const sovereign = await sovereignChatContext({ store, dataDir: store.dataDir, now: fixedNow });

  // Nothing seeded: no sections, no headers, no JSON stubs to confabulate around.
  assert.equal(sovereign.block, '');
  assert.deepEqual(sovereign.context.exposures, []);
  assert.deepEqual(sovereign.context.ideaAtoms, []);
});

test('sovereign exposure projection is bounded and content-bearing', async () => {
  const store = await freshStore();
  await store.writeExposure({
    type: 'observation',
    statement: 'x'.repeat(1000),
    eventAt: '2026-07-01T00:00:00.000Z',
    provenance: { surface: 'chatgpt', lane: 'deliberate' },
  });

  const sovereign = await sovereignChatContext({ store, dataDir: store.dataDir, now: fixedNow });
  const [exposure] = sovereign.context.exposures;

  assert.ok(exposure.statement.length <= 280);
  assert.equal(exposure.surface, 'chatgpt');
  assert.equal(exposure.eventAt, '2026-07-01');
});

test('sovereignChatContext retrieves a relevant old exposure over newer irrelevant ones', async () => {
  const store = await freshStore();
  await seedVectorExposure(store, {
    statement: 'ambient EEG artifact limits matter for the dhyan footprint',
    eventAt: '2026-01-01T00:00:00.000Z',
    surface: 'claude',
  });
  await seedVectorExposure(store, {
    statement: 'new bookmark about unrelated launch pricing',
    eventAt: '2026-07-01T00:00:00.000Z',
    surface: 'x-bookmarks',
  });
  await seedVectorExposure(store, {
    statement: 'new note about pantry logistics',
    eventAt: '2026-07-02T00:00:00.000Z',
    surface: 'apple-notes',
  });
  const embeddingOptions = {
    embedder: async (prompt) => vectorMap({
      'ambient EEG artifact limits matter for the dhyan footprint': [1, 0],
      'new bookmark about unrelated launch pricing': [0, 1],
      'new note about pantry logistics': [0, 1],
      'what do I know about EEG artifacts?': [1, 0],
    }, prompt),
  };
  await backfillExposureIndex({ store, dataDir: store.dataDir, now: fixedNow, embeddingOptions });

  const sovereign = await sovereignChatContext({
    store,
    dataDir: store.dataDir,
    now: fixedNow,
    userMessage: 'what do I know about EEG artifacts?',
    embeddingOptions,
    logger: silentLogger(),
  });

  assert.equal(sovereign.context.exposureSections.relevant[0].statement, 'ambient EEG artifact limits matter for the dhyan footprint');
  assert.match(sovereign.block, /### Relevant to this question/);
  assert.ok(sovereign.block.indexOf('ambient EEG artifact') < sovereign.block.indexOf('new note about pantry'));
});

test('sovereignChatContext enforces a per-surface cap on relevant exposure flooding', async () => {
  const store = await freshStore();
  const vectors = {};
  for (let index = 0; index < 12; index += 1) {
    const statement = `claude near-duplicate retrieval item ${index}`;
    vectors[statement] = [1, 0];
    await seedVectorExposure(store, {
      statement,
      eventAt: `2026-06-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
      surface: 'claude',
    });
  }
  for (let index = 0; index < 4; index += 1) {
    const statement = `apple notes relevant retrieval item ${index}`;
    vectors[statement] = [0.9, 0.1];
    await seedVectorExposure(store, {
      statement,
      eventAt: `2026-05-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
      surface: 'apple-notes',
    });
  }
  vectors['retrieve the near duplicate cluster'] = [1, 0];
  const embeddingOptions = { embedder: async (prompt) => vectorMap(vectors, prompt) };
  await backfillExposureIndex({ store, dataDir: store.dataDir, now: fixedNow, embeddingOptions });

  const sovereign = await sovereignChatContext({
    store,
    dataDir: store.dataDir,
    now: fixedNow,
    userMessage: 'retrieve the near duplicate cluster',
    embeddingOptions,
    logger: silentLogger(),
  });

  const surfaces = sovereign.context.exposures.map((entry) => entry.surface);
  assert.equal(surfaces.filter((surface) => surface === 'claude').length, 8);
  assert.ok(surfaces.includes('apple-notes'));
});

test('sovereignChatContext keeps a recency tail alongside relevant picks and dedups overlap', async () => {
  const store = await freshStore();
  const vectors = {};
  for (let index = 0; index < 14; index += 1) {
    const statement = `old relevant sovereign memory ${index}`;
    vectors[statement] = [1, 0];
    await seedVectorExposure(store, {
      statement,
      eventAt: `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
      surface: index % 2 === 0 ? 'claude' : 'apple-notes',
    });
  }
  for (let index = 0; index < 8; index += 1) {
    const statement = `recent irrelevant tail item ${index}`;
    vectors[statement] = [0, 1];
    await seedVectorExposure(store, {
      statement,
      eventAt: `2026-07-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
      surface: index % 2 === 0 ? 'chrome' : 'x-bookmarks',
    });
  }
  vectors['surface the old sovereign memories'] = [1, 0];
  const embeddingOptions = { embedder: async (prompt) => vectorMap(vectors, prompt) };
  await backfillExposureIndex({ store, dataDir: store.dataDir, now: fixedNow, embeddingOptions });

  const sovereign = await sovereignChatContext({
    store,
    dataDir: store.dataDir,
    now: fixedNow,
    userMessage: 'surface the old sovereign memories',
    embeddingOptions,
    logger: silentLogger(),
  });

  assert.equal(sovereign.context.exposureSections.relevant.length, 14);
  assert.equal(sovereign.context.exposureSections.recent.length, 6);
  assert.match(sovereign.block, /### Recent tail \(most recent first\)/);
  const statements = sovereign.context.exposures.map((entry) => entry.statement);
  assert.equal(new Set(statements).size, statements.length);
  assert.ok(sovereign.context.exposureSections.recent.every((entry) =>
    entry.statement.startsWith('recent irrelevant tail item')));
});

test('sovereignChatContext falls back to exact recency behavior when the index is empty', async () => {
  const store = await freshStore();
  await seedVectorExposure(store, {
    statement: 'old context that would be relevant if indexed',
    eventAt: '2026-01-01T00:00:00.000Z',
    surface: 'claude',
  });
  await seedVectorExposure(store, {
    statement: 'newest x bookmark should win recency fallback',
    eventAt: '2026-07-02T00:00:00.000Z',
    surface: 'x-bookmarks',
  });
  const logs = [];

  const sovereign = await sovereignChatContext({
    store,
    dataDir: store.dataDir,
    now: fixedNow,
    userMessage: 'old context',
    logger: { warn: (message) => logs.push(message) },
  });

  assert.deepEqual(sovereign.context.exposures.map((entry) => entry.statement), [
    'newest x bookmark should win recency fallback',
    'old context that would be relevant if indexed',
  ]);
  assert.equal(sovereign.context.exposureSections, null);
  assert.match(sovereign.block, /## The founder's recent exposures/);
  assert.doesNotMatch(sovereign.block, /Relevant to this question/);
  assert.equal(logs.length, 1);
});

test('sovereignChatContext falls back to recency without throwing when query embedding fails', async () => {
  const store = await freshStore();
  await seedVectorExposure(store, {
    statement: 'old indexed relevant local memory',
    eventAt: '2026-01-01T00:00:00.000Z',
    surface: 'claude',
  });
  await seedVectorExposure(store, {
    statement: 'new recency fallback memory',
    eventAt: '2026-07-02T00:00:00.000Z',
    surface: 'x-bookmarks',
  });
  await backfillExposureIndex({
    store,
    dataDir: store.dataDir,
    now: fixedNow,
    embeddingOptions: { embedder: async (prompt) => vectorMap({
      'old indexed relevant local memory': [1, 0],
      'new recency fallback memory': [0, 1],
    }, prompt) },
  });
  const logs = [];

  const sovereign = await sovereignChatContext({
    store,
    dataDir: store.dataDir,
    now: fixedNow,
    userMessage: 'uncached query that makes embedder fail',
    embeddingOptions: {
      embedder: async () => {
        throw new Error('local Ollama unavailable');
      },
    },
    logger: { warn: (message) => logs.push(message) },
  });

  assert.deepEqual(sovereign.context.exposures.map((entry) => entry.statement), [
    'new recency fallback memory',
    'old indexed relevant local memory',
  ]);
  assert.equal(sovereign.context.exposureSections, null);
  assert.ok(logs.some((message) => message.includes('recency fallback')));
});

async function seedVectorExposure(store, { statement, eventAt, surface }) {
  await store.writeExposure({
    type: 'observation',
    statement,
    eventAt,
    provenance: { surface, lane: 'deliberate' },
  });
}

function vectorMap(vectors, prompt) {
  const vector = vectors[prompt];
  if (!vector) throw new Error(`missing vector for prompt: ${prompt}`);
  return vector;
}

function silentLogger() {
  return { warn: () => {} };
}
