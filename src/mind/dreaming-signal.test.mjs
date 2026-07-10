import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BUILD_CARDS_DIR } from '../agent/build-cards.mjs';
import {
  DREAMING_SIGNAL_BLIND_SPOT_NOTE,
  computeDreamingSignal,
  computeDreamingSignalFromDataDir,
  edgeCardDisposition,
  isDreamingEdgeCard,
} from './dreaming-signal.mjs';

test('dreaming signal is empty and read-only when no card or verdict artifacts exist', async () => {
  const dataDir = await tempDataDir();

  const reading = await computeDreamingSignalFromDataDir({
    dataDir,
    now: new Date('2026-07-06T00:00:00.000Z'),
  });

  assert.deepEqual(reading, {
    kind: 'DreamingHitRateSignal',
    schemaVersion: 1,
    score: null,
    hitRate: null,
    junkRate: null,
    counted: {
      edgeCards: 0,
      disposed: 0,
      acted: 0,
      dismissed: 0,
      expired: 0,
      pending: 0,
      mindVerdicts: 0,
      junk: 0,
      nod: 0,
      actOn: 0,
    },
    dispositions: {
      acted: 0,
      dismissed: 0,
      expired: 0,
      pending: 0,
    },
    verdicts: {
      total: 0,
      junk: 0,
      nod: 0,
      actOn: 0,
      junkRate: null,
    },
    blindSpots: [{
      kind: 'coverage',
      note: DREAMING_SIGNAL_BLIND_SPOT_NOTE,
    }],
  });
  await assert.rejects(
    fs.stat(path.join(dataDir, BUILD_CARDS_DIR)),
    (error) => error.code === 'ENOENT',
  );
});

test('edge-card dispositions produce hit-rate and linked mind verdicts produce junk-rate', async () => {
  const dataDir = await tempDataDir();
  await writeCard(dataDir, 'edge-a', edgeCard({
    id: 'edge-a',
    status: 'applied',
    outputId: 'idea_edge_a',
    appliedAt: '2026-07-05T02:00:00.000Z',
  }));
  await writeCard(dataDir, 'edge-b', edgeCard({
    id: 'edge-b',
    status: 'answered',
    answerOption: 'dismiss',
    mind: {
      outputType: 'new_ideas',
      outputId: 'idea_edge_b',
    },
    answeredAt: '2026-07-05T03:00:00.000Z',
  }));
  await writeCard(dataDir, 'edge-c', edgeCard({
    id: 'edge-c',
    edgeCard: true,
    origin: undefined,
    status: 'obsoleted',
    outputRef: {
      outputType: 'new_ideas',
      outputId: 'idea_edge_c',
    },
    obsoletedAt: '2026-07-05T04:00:00.000Z',
  }));
  await writeCard(dataDir, 'edge-d', edgeCard({
    id: 'edge-d',
    status: 'notified',
    outputId: 'idea_edge_d',
    expiresAt: '2026-07-07T00:00:00.000Z',
  }));
  await writeCard(dataDir, 'ordinary', {
    id: 'ordinary',
    origin: 'manual',
    status: 'applied',
    outputType: 'new_ideas',
    outputId: 'idea_edge_a',
    raisedAt: '2026-07-05T01:00:00.000Z',
  });
  await writeMindVerdictLog(dataDir, '2026-07-05', [
    mindVerdict({ outputId: 'idea_edge_a', verdict: 'act-on' }),
    mindVerdict({ outputId: 'idea_edge_b', verdict: 'junk' }),
    mindVerdict({ outputId: 'idea_edge_c', verdict: 'nod' }),
    mindVerdict({ outputId: 'not_an_edge', verdict: 'junk' }),
  ]);

  const reading = await computeDreamingSignalFromDataDir({
    dataDir,
    now: new Date('2026-07-06T00:00:00.000Z'),
  });

  assert.equal(reading.counted.edgeCards, 4);
  assert.equal(reading.counted.disposed, 3);
  assert.equal(reading.counted.acted, 1);
  assert.equal(reading.counted.dismissed, 1);
  assert.equal(reading.counted.expired, 1);
  assert.equal(reading.counted.pending, 1);
  assert.equal(reading.hitRate, 1 / 3);
  assert.equal(reading.counted.mindVerdicts, 3);
  assert.equal(reading.counted.junk, 1);
  assert.equal(reading.counted.nod, 1);
  assert.equal(reading.counted.actOn, 1);
  assert.equal(reading.junkRate, 1 / 3);
});

test('junk-rate starts at the first linked mind verdict even before disposition', () => {
  const reading = computeDreamingSignal([
    edgeCard({
      id: 'edge-first',
      status: 'notified',
      outputId: 'idea_first_edge',
    }),
  ], [
    mindVerdict({
      outputId: 'idea_first_edge',
      verdict: 'junk',
    }),
  ]);

  assert.equal(reading.counted.edgeCards, 1);
  assert.equal(reading.counted.pending, 1);
  assert.equal(reading.hitRate, null);
  assert.equal(reading.counted.mindVerdicts, 1);
  assert.equal(reading.junkRate, 1);
});

test('expired edge cards can be inferred from expiresAt without mutating artifacts', async () => {
  const dataDir = await tempDataDir();
  await writeCard(dataDir, 'expired-by-time', edgeCard({
    id: 'expired-by-time',
    status: 'notified',
    outputId: 'idea_expired_edge',
    expiresAt: '2026-07-05T00:00:00.000Z',
  }));
  await writeCorruptMindLog(dataDir, '2026-07-04');
  await writeMindVerdictLog(dataDir, '2026-07-05', [
    mindVerdict({ outputId: 'idea_expired_edge', verdict: 'junk' }),
  ]);

  const before = await fs.readFile(path.join(dataDir, BUILD_CARDS_DIR, 'expired-by-time.json'), 'utf8');
  const reading = await computeDreamingSignalFromDataDir({
    dataDir,
    now: new Date('2026-07-06T00:00:00.000Z'),
  });

  assert.equal(reading.counted.expired, 1);
  assert.equal(reading.hitRate, 0);
  assert.equal(reading.junkRate, 1);
  assert.equal(
    await fs.readFile(path.join(dataDir, BUILD_CARDS_DIR, 'expired-by-time.json'), 'utf8'),
    before,
  );
});

test('edge-card detection and disposition projection tolerate future field shapes', () => {
  assert.equal(isDreamingEdgeCard({ metadata: { dreaming: { edge: true } } }), true);
  assert.equal(isDreamingEdgeCard({ provenance: { source: 'dreaming-edge-detector' } }), true);
  assert.equal(isDreamingEdgeCard({ origin: 'manual' }), false);

  assert.equal(edgeCardDisposition({ disposition: 'acted' }), 'acted');
  assert.equal(edgeCardDisposition({ status: 'answered', answerOption: 'junk' }), 'dismissed');
  assert.equal(edgeCardDisposition({ status: 'obsoleted' }), 'expired');
  assert.equal(edgeCardDisposition({
    status: 'notified',
    expiresAt: '2026-07-05T00:00:00.000Z',
  }, {
    now: new Date('2026-07-06T00:00:00.000Z'),
  }), 'expired');
});

async function tempDataDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-dreaming-signal-'));
}

async function writeCard(dataDir, id, record) {
  const dir = path.join(dataDir, BUILD_CARDS_DIR);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

async function writeMindVerdictLog(dataDir, date, verdicts) {
  const dir = path.join(dataDir, 'eval');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, `mind-${date}.json`),
    `${JSON.stringify({
      kind: 'MindEvalVerdictLog',
      schemaVersion: 1,
      date,
      verdicts,
    }, null, 2)}\n`,
    'utf8',
  );
}

async function writeCorruptMindLog(dataDir, date) {
  const dir = path.join(dataDir, 'eval');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `mind-${date}.json`), '{ "verdicts": [', 'utf8');
}

function edgeCard(overrides = {}) {
  return {
    id: 'edge',
    origin: 'dreaming',
    status: 'notified',
    outputType: 'new_ideas',
    outputId: 'idea_edge',
    raisedAt: '2026-07-05T01:00:00.000Z',
    createdAt: '2026-07-05T01:00:00.000Z',
    updatedAt: '2026-07-05T01:00:00.000Z',
    ...overrides,
  };
}

function mindVerdict(overrides = {}) {
  return {
    passId: '2026-07-05',
    date: '2026-07-05',
    outputType: 'new_ideas',
    outputId: 'idea_edge',
    label: 'Dreaming edge',
    verdict: 'act-on',
    ...overrides,
  };
}
