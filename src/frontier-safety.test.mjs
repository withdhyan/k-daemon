import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  commitStationOutput,
  frontierSafeRecords,
  gatherContext,
  writeUniqueDataJson,
} from '../daemon/run.mjs';
import { createSubstrateStore } from './substrate.mjs';
import { orchestrate } from './threads/orchestrator.mjs';

const fixedNow = () => new Date('2026-06-29T01:02:03.000Z');
const CHAT_TEXT = 'CLAUDE_PRIVATE_FRONTIER_SECRET must never reach the default model.';
const BOOKMARK_TEXT = 'BOOKMARK_FRONTIER_SAFE_REFERENCE should remain visible.';
const SELF_PATTERN_TEXT = 'CHAT_DERIVED_SELF_PATTERN_SECRET must never reach the default model.';
const LEGACY_SELF_PATTERN_TEXT = 'LEGACY_UNSTAMPED_SELF_PATTERN_SECRET must never reach the default model.';
const MIND_CANDIDATE_TEXT = 'MIND_CANDIDATE_PRIVATE_SECRET must never reach the default model.';
const LEGACY_DECISION_TEXT = 'LEGACY_UNSTAMPED_DECISION_SECRET must never reach the default model.';
const FOOTPRINT_TEXT = 'FOOTPRINT_CHAT_DERIVED_SECRET must never reach verify or compound prompts.';
const RESEARCH_CHAT_TEXT = 'RESEARCH_CHAT_SECRET must never be embedded or persisted by explorer.';
const RESEARCH_SAFE_TEXT = 'RESEARCH_SAFE_REFERENCE should remain explorer-visible.';

test('gatherContext strips chat and mind-derived content while preserving safe bookmark exposure', async () => {
  const { dataDir, store, chat, bookmark, selfPattern } = await seededFrontierStore();

  assert.equal(selfPattern.frontierExcluded, true);

  for (const station of ['sense', 'decide', 'verify', 'compound']) {
    const context = await gatherContext(station, { dataDir, store });

    assert.doesNotMatch(context, new RegExp(CHAT_TEXT));
    assert.doesNotMatch(context, new RegExp(SELF_PATTERN_TEXT));
    assert.doesNotMatch(context, new RegExp(LEGACY_SELF_PATTERN_TEXT));
    assert.doesNotMatch(context, new RegExp(MIND_CANDIDATE_TEXT));
    assert.doesNotMatch(context, new RegExp(LEGACY_DECISION_TEXT));

    if (station !== 'compound') {
      assert.match(context, new RegExp(BOOKMARK_TEXT));
      assert.match(context, new RegExp(bookmark.id));
    }
  }

  const exposures = await store.listRecords('Exposure');
  assert(exposures.some((record) => record.id === chat.id));
  assert(exposures.some((record) => record.statement === CHAT_TEXT));
});

test('chat-derived SelfPattern and LoopRecommendation are stamped frontierExcluded at creation', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-frontier-stamps-'));
  const store = createSubstrateStore({ dataDir, now: fixedNow });
  const chat = await writeExposure(store, {
    statement: CHAT_TEXT,
    surface: 'chatgpt',
    sourceId: 'stamp-chat',
  });

  await commitStationOutput(
    'compound',
    {
      summary: 'Learn from a private chat exposure.',
      verdict: 'silence',
      selfPattern: {
        exposureId: chat.id,
        pattern: SELF_PATTERN_TEXT,
        confidence: 0.7,
      },
    },
    { dataDir, store, now: fixedNow },
  );

  const [selfPattern] = await store.listRecords('SelfPattern');
  assert.equal(selfPattern.frontierExcluded, true);
  assert.equal(selfPattern.pattern, SELF_PATTERN_TEXT);

  await commitStationOutput(
    'decide',
    {
      summary: 'Stage a recommendation derived from private chat.',
      verdict: 'recommend',
      recommendation: {
        decision: 'Whether to review the private chat-derived note.',
        recommended: 'Review the note locally.',
        reason: 'The evidence is private chat and must stay local.',
        reversibility: 'internal-revertible',
        undo: 'Drop the local note.',
        evidenceIds: [chat.id],
        confidence: 0.5,
      },
    },
    { dataDir, store, now: fixedNow },
  );

  const [decision] = await dataFiles(dataDir, 'decisions');
  assert.equal(decision.kind, 'LoopRecommendation');
  assert.equal(decision.frontierExcluded, true);

  const verifyContext = await gatherContext('verify', { dataDir, store });
  assert.doesNotMatch(verifyContext, new RegExp(SELF_PATTERN_TEXT));
  assert.doesNotMatch(verifyContext, /Review the note locally/);
});

test('gatherContext strips frontier-excluded FootprintSample content from verify and compound prompts', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-frontier-footprints-'));
  const store = createSubstrateStore({ dataDir, now: fixedNow });

  await commitStationOutput(
    'sense',
    {
      summary: 'Record a footprint that carries model-supplied chat provenance.',
      verdict: 'silence',
      footprintSamples: [
        {
          provenance: { surface: 'claude', lane: 'deliberate' },
          phenomenology: {
            rung: 'attention',
            report: FOOTPRINT_TEXT,
            ratings: {},
          },
          physiology: {},
          context: { surface: 'claude' },
          disconfirmers: [],
          outcome: {},
        },
      ],
    },
    { dataDir, store, now: fixedNow },
  );

  const [footprint] = await store.listRecords('FootprintSample');
  assert.equal(footprint.provenance.surface, 'claude');
  assert.match(JSON.stringify(footprint), new RegExp(FOOTPRINT_TEXT));

  for (const station of ['verify', 'compound']) {
    const context = await gatherContext(station, { dataDir, store });
    assert.doesNotMatch(context, new RegExp(FOOTPRINT_TEXT));
    assert.doesNotMatch(context, new RegExp(footprint.id));
  }
});

test('frontierSafeRecords excludes normalized frontier surfaces from all surface locations', () => {
  const safe = {
    kind: 'Exposure',
    id: 'safe',
    statement: 'SAFE_FRONTIER_REFERENCE',
    provenance: { surface: 'bookmark', lane: 'deliberate' },
  };
  const excluded = [
    {
      kind: 'Exposure',
      id: 'provenance',
      statement: 'PROVENANCE_SURFACE_SECRET',
      provenance: { surface: ' Claude ', lane: 'deliberate' },
    },
    {
      kind: 'Exposure',
      id: 'top-level',
      statement: 'TOP_LEVEL_SURFACE_SECRET',
      provenance: { surface: 'bookmark', lane: 'deliberate' },
      surface: 'CHATGPT',
    },
    {
      kind: 'Exposure',
      id: 'target',
      statement: 'TARGET_SURFACE_SECRET',
      provenance: { surface: 'bookmark', lane: 'deliberate' },
      targetSurface: ' claude ',
    },
    {
      kind: 'Exposure',
      id: 'protocol',
      statement: 'PROTOCOL_SURFACE_SECRET',
      provenance: { surface: 'bookmark', lane: 'deliberate' },
      protocol: { surface: 'mind' },
    },
    {
      kind: 'Exposure',
      id: 'metadata',
      statement: 'METADATA_SURFACE_SECRET',
      provenance: { surface: 'bookmark', lane: 'deliberate' },
      metadata: { surface: 'CHATGPT' },
    },
  ];

  assert.deepEqual(frontierSafeRecords([safe, ...excluded]), [safe]);
});

test('threads route reaches modelCall only after gatherContext strips chat exposure text', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-frontier-threads-'));
  const store = createSubstrateStore({ dataDir, now: fixedNow });
  const chat = await writeExposure(store, {
    statement: CHAT_TEXT,
    surface: 'claude',
    sourceId: 'thread-chat',
  });
  const modelRequests = [];
  const researchQueries = [];

  const result = await orchestrate({
    dataDir,
    store,
    now: fixedNow,
    segmentation: {
      threads: [
        {
          threadId: 'thread_private_chat',
          theme: 'Private chat thread',
          exposureIds: [chat.id],
        },
      ],
    },
    dispatch: 'serial',
    research: async (query) => {
      researchQueries.push(query);
      return [];
    },
    modelCall: async (request) => {
      modelRequests.push(request);
      return {
        summary: `${request.station}: silence`,
        verdict: 'silence',
      };
    },
  });

  assert.equal(result.threadCount, 1);
  assert.equal(modelRequests.length, 2);
  assert.deepEqual(modelRequests.map((request) => request.station), ['decide', 'verify']);
  assert(modelRequests.every((request) => !request.user.includes(CHAT_TEXT)));
  assert(researchQueries.every((query) => !query.includes(CHAT_TEXT)));
  assert(!result.threads[0].context.includes(CHAT_TEXT));
});

test('research explorer excludes raw chat statements from persisted model-facing evidence', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-frontier-research-'));
  const store = createSubstrateStore({ dataDir, now: fixedNow });
  const chat = await writeExposure(store, {
    statement: RESEARCH_CHAT_TEXT,
    surface: 'CHATGPT',
    sourceId: 'research-chat',
  });
  const safe = await writeExposure(store, {
    statement: RESEARCH_SAFE_TEXT,
    surface: 'bookmark',
    sourceId: 'research-safe',
  });

  const result = await orchestrate({
    dataDir,
    store,
    now: fixedNow,
    segmentation: {
      threads: [
        {
          threadId: 'thread_research_chat_free',
          theme: 'Research must stay chat-free.',
          exposureIds: [chat.id, safe.id],
        },
      ],
    },
    dispatch: 'serial',
    testEmbedder: noChatResearchEmbedder,
    researchOptions: {
      cacheDir: path.join(dataDir, 'embeddings'),
      k: 2,
      levy: false,
      argus: false,
      vrsdIntermediate: 1,
    },
    modelCall: async (request) => ({
      summary: `${request.station}: silence`,
      verdict: 'silence',
    }),
  });

  assert.equal(result.threadCount, 1);
  const explorerRecord = result.threads[0].swarm.roles.explorer.record;
  assert.doesNotMatch(JSON.stringify(explorerRecord), new RegExp(RESEARCH_CHAT_TEXT));
  assert.match(JSON.stringify(explorerRecord), new RegExp(RESEARCH_SAFE_TEXT));

  const persistedExplorer = await dataFiles(
    dataDir,
    path.join('threads', 'thread_research_chat_free', 'explorer'),
  );
  assert.equal(persistedExplorer.length, 1);
  assert.doesNotMatch(JSON.stringify(persistedExplorer), new RegExp(RESEARCH_CHAT_TEXT));
  assert.match(JSON.stringify(persistedExplorer), new RegExp(RESEARCH_SAFE_TEXT));

  const localExposures = await store.listRecords('Exposure');
  assert(localExposures.some((record) => record.statement === RESEARCH_CHAT_TEXT));
});

async function seededFrontierStore() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-frontier-context-'));
  const store = createSubstrateStore({ dataDir, now: fixedNow });
  const chat = await writeExposure(store, {
    statement: CHAT_TEXT,
    surface: 'claude',
    sourceId: 'context-chat',
  });
  const bookmark = await writeExposure(store, {
    statement: BOOKMARK_TEXT,
    surface: 'bookmark',
    sourceId: 'context-bookmark',
  });

  await commitStationOutput(
    'compound',
    {
      summary: 'Learn from private chat locally.',
      verdict: 'silence',
      selfPattern: {
        exposureId: chat.id,
        pattern: SELF_PATTERN_TEXT,
        confidence: 0.6,
      },
    },
    { dataDir, store, now: fixedNow },
  );

  const [selfPattern] = await store.listRecords('SelfPattern');

  await store.processEngagement({
    exposureId: chat.id,
    pattern: LEGACY_SELF_PATTERN_TEXT,
    confidence: 0.4,
    action: 'learned',
    eventAt: fixedNow().toISOString(),
    provenance: { surface: 'loop', lane: 'deliberate' },
  });

  await writeUniqueDataJson(dataDir, 'decisions', 'mind-private', {
    kind: 'MindCandidate',
    schemaVersion: 1,
    acted: 'pending',
    frontierExcluded: true,
    provenance: { surface: 'mind', lane: 'deliberate' },
    statement: MIND_CANDIDATE_TEXT,
    recommended: MIND_CANDIDATE_TEXT,
    evidenceIds: [chat.id],
    createdAt: fixedNow().toISOString(),
  });
  await writeUniqueDataJson(dataDir, 'decisions', 'legacy-private', {
    kind: 'LoopRecommendation',
    schemaVersion: 1,
    station: 'decide',
    acted: 'pending',
    advisoryOnly: true,
    decision: LEGACY_DECISION_TEXT,
    recommended: LEGACY_DECISION_TEXT,
    reason: LEGACY_DECISION_TEXT,
    reversibility: 'internal-revertible',
    tag: '[advise]',
    evidenceIds: [chat.id],
    confidence: 0.5,
    createdAt: fixedNow().toISOString(),
  });

  return {
    dataDir,
    store,
    chat,
    bookmark,
    selfPattern,
  };
}

async function writeExposure(store, { statement, surface, sourceId }) {
  return store.writeExposure({
    type: 'observation',
    statement,
    sourceId,
    eventAt: fixedNow().toISOString(),
    provenance: { surface, lane: 'deliberate' },
  });
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
      .map((entry) => fs.readFile(path.join(dir, entry.name), 'utf8').then(JSON.parse)),
  );
}

async function noChatResearchEmbedder(prompt) {
  const text = String(prompt);
  assert.doesNotMatch(text, new RegExp(RESEARCH_CHAT_TEXT));
  return [1, text.includes(RESEARCH_SAFE_TEXT) ? 0 : 0.25];
}
