import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  formatDecisionSignalLine,
  projectDecisionSignal,
  readDecisionRecords,
  recordDecisionActed,
} from './decisions.mjs';

test('old-shape LoopRecommendation records load without widened fields synthesized', async () => {
  const dataDir = await tempDataDir();
  const legacy = loopDecision({
    id: 'legacy-decision',
    acted: 'pending',
  });
  await writeDecision(dataDir, 'legacy-decision.json', legacy);

  const records = await readDecisionRecords(dataDir);

  assert.deepEqual(records, [legacy]);
  assert(!Object.hasOwn(records[0], 'observation'));
  assert(!Object.hasOwn(records[0], 'reasoning'));
  assert(!Object.hasOwn(records[0], 'evidence'));
  assert(!Object.hasOwn(records[0], 'conclusion'));
  assert(!Object.hasOwn(records[0], 'urgency'));
});

test('recordDecisionActed records actedAt on transition and leaves repeated calls unchanged', async () => {
  const dataDir = await tempDataDir();
  await writeDecision(dataDir, 'decision-a.json', loopDecision({
    id: 'decision-a',
    acted: 'pending',
  }));

  const acted = await recordDecisionActed({
    dataDir,
    id: 'decision-a',
    at: '2026-07-01T13:15:00.000Z',
  });
  const repeated = await recordDecisionActed({
    dataDir,
    id: 'decision-a',
    at: '2026-07-02T13:15:00.000Z',
  });
  const persisted = JSON.parse(
    await fs.readFile(path.join(dataDir, 'decisions', 'decision-a.json'), 'utf8'),
  );

  assert.equal(acted.changed, true);
  assert.equal(acted.decision.acted, 'acted');
  assert.equal(acted.decision.actedAt, '2026-07-01T13:15:00.000Z');
  assert.equal(repeated.changed, false);
  assert.equal(repeated.decision.actedAt, '2026-07-01T13:15:00.000Z');
  assert.equal(persisted.acted, 'acted');
  assert.equal(persisted.actedAt, '2026-07-01T13:15:00.000Z');
});

test('projectDecisionSignal emits ISO-week buckets including empty weeks', () => {
  const projection = projectDecisionSignal([
    loopDecision({
      id: 'week-27',
      createdAt: '2026-06-30T10:00:00.000Z',
      acted: 'acted',
      actedAt: '2026-07-01T10:00:00.000Z',
    }),
    loopDecision({
      id: 'week-29',
      createdAt: '2026-07-14T10:00:00.000Z',
      acted: 'pending',
      recommended: 'Leave this one pending.',
    }),
  ], {
    start: '2026-06-29',
    end: '2026-07-19',
  });

  assert.equal(projection.recommended, 2);
  assert.equal(projection.acted, 1);
  assert.equal(projection.rate, 0.5);
  assert.deepEqual(projection.weeks, [
    {
      week: '2026-W27',
      start: '2026-06-29',
      end: '2026-07-05',
      recommended: 1,
      acted: 1,
      rate: 1,
    },
    {
      week: '2026-W28',
      start: '2026-07-06',
      end: '2026-07-12',
      recommended: 0,
      acted: 0,
      rate: null,
    },
    {
      week: '2026-W29',
      start: '2026-07-13',
      end: '2026-07-19',
      recommended: 1,
      acted: 0,
      rate: 0,
    },
  ]);
  assert.equal(formatDecisionSignalLine(projection), 'acted 1/2 decisions');
});

function loopDecision(overrides = {}) {
  return {
    kind: 'LoopRecommendation',
    schemaVersion: 1,
    station: 'decide',
    date: '2026-07-06',
    verdict: 'recommend',
    acted: 'pending',
    advisoryOnly: true,
    decision: 'Whether to count this recommendation.',
    recommended: 'Review this recommendation.',
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

async function tempDataDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-decisions-'));
}

async function writeDecision(dataDir, name, record) {
  const file = path.join(dataDir, 'decisions', name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}
