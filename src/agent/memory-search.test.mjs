import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  SOVEREIGN_STATEMENT_MAX_CHARS,
  agentToolExecutor,
} from '../../daemon/server.mjs';
import { MIND_OUTPUT_DIR } from '../mind/think.mjs';
import { createSubstrateStore } from '../substrate.mjs';
import { backfillExposureIndex } from './exposure-index.mjs';
import { runAgentTurn } from './chat.mjs';
import { runToolLoop } from './tool-loop.mjs';

const fixedNow = () => new Date('2026-07-04T00:00:00.000Z');

test('memory.search executes through the governed loop and returns bounded sovereign results', async () => {
  const store = await freshStore();
  const relevant = await store.writeExposure({
    type: 'observation',
    statement: `ambient EEG artifact limits matter for the dhyan footprint ${'x'.repeat(500)}`,
    eventAt: '2026-07-01T00:00:00.000Z',
    provenance: { surface: 'claude', lane: 'deliberate' },
  });
  await store.writeExposure({
    type: 'observation',
    statement: 'pantry logistics are unrelated to the hardware review',
    eventAt: '2026-07-02T00:00:00.000Z',
    provenance: { surface: 'apple-notes', lane: 'deliberate' },
  });
  await seedMindOutput(store.dataDir, {
    outputId: 'mind_eeg_bridge',
    outputGroup: 'new_ideas',
    kind: 'DivergentIdea',
    label: 'EEG review bridge',
    observation: 'A narrow review bridges EEG hardware and artifact constraints.',
    evidenceIds: [relevant.id],
    source: { kind: 'MindOutput', outputGroup: 'new_ideas', outputKey: 'mind_eeg_bridge', exposureIds: [relevant.id] },
  });
  const embeddingOptions = { embedder: async (prompt) => eegVector(prompt) };
  await backfillExposureIndex({
    store,
    dataDir: store.dataDir,
    now: fixedNow,
    embeddingOptions,
  });

  const lanes = [];
  const loop = await runToolLoop({
    initialOutput: '<tool_call>{"name":"memory.search","arguments":{"query":"dhyan EEG artifacts","limit":1}}</tool_call>',
    grants: new Set(['memory.search']),
    executor: (id, args) =>
      agentToolExecutor(id, args, {
        store,
        dataDir: store.dataDir,
        now: fixedNow,
        memorySearch: {
          embeddingOptions,
          logger: silentLogger(),
        },
      }),
    reconsult: async ({ sovereign }) => {
      lanes.push(sovereign);
      return 'final from memory';
    },
  });

  assert.equal(loop.executed.length, 1);
  assert.equal(loop.executed[0].toolId, 'memory.search');
  assert.equal(loop.executed[0].ok, true);
  assert.equal(loop.executed[0].sensitive, true);
  assert.equal(loop.executed[0].sensitivity, 'sensitive');
  assert.equal(loop.executed[0].frontierExcluded, true);
  assert.deepEqual(loop.executed[0].provenance, ['substrate', 'exposure', 'mind-surface']);
  assert.equal(loop.sovereign, true);
  assert.deepEqual(lanes, [true]);

  const artifact = loop.executed[0].artifacts.memorySearch;
  assert.equal(artifact.exposures.length, 1);
  assert.equal(artifact.exposures[0].id, relevant.id);
  assert.equal(artifact.exposures[0].surface, 'claude');
  assert.equal(artifact.exposures[0].eventAt, '2026-07-01');
  assert.ok(artifact.exposures[0].statement.length <= SOVEREIGN_STATEMENT_MAX_CHARS);
  assert.equal(artifact.mindOutputs.length, 1);
  assert.equal(artifact.mindOutputs[0].viewType, 'k0.change');
  assert.equal(artifact.mindOutputs[0].fields.outputId, 'mind_eeg_bridge');
});

test('memory.search tool turn remains sovereign and never uses the frontier route', async () => {
  const calls = { frontier: 0, sovereign: 0 };
  const result = await runAgentTurn(
    {
      userMessage: 'search my memory for EEG artifacts',
      sovereignFloor: true,
      tools: true,
      toolGrants: new Set(['memory.search']),
      onToken: () => {},
    },
    {
      frontierModelCall: async () => {
        calls.frontier += 1;
        return 'FRONTIER_SHOULD_NOT_RUN';
      },
      sovereignModelCall: async () => {
        calls.sovereign += 1;
        return calls.sovereign === 1
          ? '<tool_call>{"name":"memory.search","arguments":{"query":"EEG artifacts","limit":1}}</tool_call>'
          : 'The sovereign answer uses local memory only.';
      },
      toolExecutor: async (id, args) => {
        assert.equal(id, 'memory.search');
        assert.equal(args.query, 'EEG artifacts');
        return {
          ok: true,
          output: 'memory.search results=0',
          sensitive: true,
          sensitivity: 'sensitive',
          frontierExcluded: true,
          provenance: ['substrate', 'exposure', 'mind-surface'],
          artifacts: {
            memorySearch: {
              query: args.query,
              exposures: [],
              mindOutputs: [],
            },
          },
        };
      },
    },
  );

  assert.equal(calls.frontier, 0);
  assert.equal(calls.sovereign, 2);
  assert.equal(result.lane, 'sovereign');
  assert.equal(result.sovereign, true);
  assert.equal(result.steps, 1);
  assert.equal(result.toolResults[0].toolId, 'memory.search');
});

async function freshStore() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-memory-search-'));
  return createSubstrateStore({ dataDir, now: fixedNow });
}

function eegVector(prompt) {
  return /eeg|dhyan|artifact/i.test(prompt) ? [1, 0] : [0, 1];
}

async function seedMindOutput(dataDir, overrides = {}) {
  const outputGroup = overrides.outputGroup ?? 'new_ideas';
  const outputId = overrides.outputId ?? 'mind_memory_search';
  const dir = path.join(dataDir, MIND_OUTPUT_DIR);
  const record = {
    id: outputId,
    kind: 'DivergentIdea',
    schemaVersion: 1,
    outputId,
    outputKey: outputId,
    contentHash: `fixture-${outputId}`,
    validFrom: fixedNow().toISOString(),
    validTo: null,
    eventAt: fixedNow().toISOString(),
    generatedAt: fixedNow().toISOString(),
    supersededById: null,
    label: 'Memory search mind card',
    outputGroup,
    outputType: outputGroup,
    observation: 'A local mind card matches the exposure evidence.',
    considerations: [],
    atomIds: [],
    evidenceIds: [],
    confidence: 0.7,
    frontierExcluded: true,
    provenance: { surface: 'mind', lane: 'deliberate' },
    source: {
      kind: 'MindOutput',
      outputGroup,
      outputKey: outputId,
    },
    ...overrides,
  };

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `${record.outputId}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
    'utf8',
  );
}

function silentLogger() {
  return { warn: () => {} };
}
