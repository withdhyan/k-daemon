import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  COMMIT_TOOL,
  RECOMMENDATION_VERDICTS,
  commitStationOutput,
  runStation,
  safeDataPath,
} from '../daemon/run.mjs';
import { computeTimeWellSpentFromDir } from './eval/tws.mjs';
import { ingestBookmarks } from './ingest/bookmarks.mjs';
import { createSubstrateStore } from './substrate.mjs';

const fixedNow = () => new Date('2026-06-27T00:00:00.000Z');
const BOOKMARKS_FIXTURE = Object.freeze({
  source: 'loop-test-bookmarks',
  ingested_at: '2026-06-26T12:00:00.000Z',
  count: 2,
  items: [
    {
      name: 'Attention recovery reference',
      url: 'https://example.test/attention',
      folder: 'Bookmarks Bar/K/2.0',
      added: '13395009600000000',
    },
    {
      name: 'Local loop reference',
      url: 'https://example.test/loop',
      folder: 'Bookmarks Bar/K',
      added: '13395013200000000',
    },
  ],
});

test('decide over ingested bookmark exposure can stage one advisory recommendation', async () => {
  const { store, dataDir, exposure } = await seededStore();
  const calls = [];

  const result = await runStation('decide', {
    store,
    dataDir,
    now: fixedNow,
    modelCall: async (request) => {
      calls.push(request);
      assert.equal(request.label, 'cs-k:decide');
      assert.equal(request.tool.name, COMMIT_TOOL.name);
      assert.match(request.system, /Life constitution/);
      assert.match(request.user, /Exposure: \d+/);
      assert.match(request.user, new RegExp(exposure.id));

      return {
        summary: 'Stage one local attention recommendation.',
        verdict: 'recommend',
        recommendation: {
          decision: 'Whether to review saved attention-capture bookmarks today.',
          recommended: 'Review only the bookmarks tied to current attention recovery.',
          reason: 'The substrate shows many deliberate saved references, but no authority to act.',
          reversibility: 'internal-revertible',
          undo: 'Drop the review note and leave the bookmarks untouched.',
          evidenceIds: [exposure.id],
          confidence: 0.42,
        },
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(result.output.verdict, 'recommend');
  assert.equal(result.mutations.length, 1);
  assert.equal(await store.countRecords('SelfPattern'), 0);
  assert.equal(await store.countRecords('FootprintSample'), 0);

  const decisions = await dataFiles(dataDir, 'decisions');
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].verdict, 'recommend');
  assert.equal(decisions[0].acted, 'pending');
  assert.equal(decisions[0].advisoryOnly, true);
  assert.equal(decisions[0].recommended, 'Review only the bookmarks tied to current attention recovery.');
  assert.equal(decisions[0].tag, '[advise]');
  assert.deepEqual(decisions[0].evidenceIds, [exposure.id]);
  assert(!Object.hasOwn(decisions[0], 'autoAct'));
  assert(!Object.hasOwn(decisions[0], 'externalAction'));
});

test('same-second decide recommendations persist separately and count in TWS', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-loop-data-'));

  const first = await commitStationOutput(
    'decide',
    {
      summary: 'Stage a reversible recommendation.',
      verdict: 'recommend',
      recommendation: {
        decision: 'Whether to review saved bookmarks.',
        recommended: 'Review only the attention-recovery bookmarks.',
        reason: 'It is local and reversible.',
        reversibility: 'internal-revertible',
        undo: 'Drop the note.',
        evidenceIds: [],
        confidence: 0.4,
      },
    },
    { dataDir, now: fixedNow },
  );
  const second = await commitStationOutput(
    'decide',
    {
      summary: 'Stage an irreversible recommendation.',
      verdict: 'recommend',
      recommendation: {
        decision: 'Whether to delete an external account.',
        recommended: 'Do not delete the account without a human gate.',
        reason: 'The action is irreversible.',
        reversibility: 'irreversible',
        undo: 'There is no reliable undo.',
        evidenceIds: [],
        confidence: 0.6,
      },
    },
    { dataDir, now: fixedNow },
  );

  assert.notEqual(first[0].path, second[0].path);
  const decisions = await dataFiles(dataDir, 'decisions');
  assert.equal(decisions.length, 2);
  assert.deepEqual(
    decisions.map((decision) => decision.tag).sort(),
    ['[advise]', '[gate:human]'],
  );
  assert(decisions.every((decision) => decision.tag !== '[auto]'));

  const reading = await computeTimeWellSpentFromDir(dataDir);
  assert.equal(reading.recommended, 2);
  assert.equal(reading.decisionSignal, 0);
});

test('decide can return earned silence without writing a staged decision', async () => {
  const { store, dataDir } = await seededStore();
  let callCount = 0;

  const result = await runStation('decide', {
    store,
    dataDir,
    now: fixedNow,
    modelCall: async () => {
      callCount += 1;
      return {
        summary: 'No decision earns attention.',
        verdict: 'silence',
      };
    },
  });

  assert.equal(callCount, 1);
  assert.equal(result.output.verdict, 'silence');
  assert.deepEqual(result.mutations, []);
  assert.deepEqual(await dataFiles(dataDir, 'decisions'), []);
});

test('verify writes a LoopVerification artifact for a verify note', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-loop-data-'));
  const store = createSubstrateStore({ dataDir, now: fixedNow });

  const result = await runStation('verify', {
    store,
    dataDir,
    now: fixedNow,
    modelCall: async (request) => {
      assert.equal(request.label, 'cs-k:verify');
      assert.match(request.user, /## Staged recommendations/);

      return {
        summary: 'Verify staged recommendations remain advisory.',
        verdict: 'silence',
        verifyNote: {
          reviews: [
            {
              decisionId: 'decision:test',
              outcome: 'pending',
              note: 'No external action was taken.',
            },
          ],
          note: 'The loop remains advisory only.',
        },
      };
    },
  });

  assert.equal(result.output.verdict, 'silence');
  assert.equal(result.mutations.length, 1);
  assert.equal(result.mutations[0].kind, 'LoopVerification');
  assert.equal(result.mutations[0].path, path.join('data', 'verify', '2026-06-27.json'));

  const verifyNotes = await dataFiles(dataDir, 'verify');
  assert.equal(verifyNotes.length, 1);
  assert.equal(verifyNotes[0].kind, 'LoopVerification');
  assert.equal(verifyNotes[0].summary, 'Verify staged recommendations remain advisory.');
  assert.equal(verifyNotes[0].note, 'The loop remains advisory only.');
  assert.deepEqual(verifyNotes[0].reviews, [
    {
      decisionId: 'decision:test',
      outcome: 'pending',
      note: 'No external action was taken.',
    },
  ]);
});

test('verify silence without a verify note writes no artifact', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-loop-data-'));
  const store = createSubstrateStore({ dataDir, now: fixedNow });

  const result = await runStation('verify', {
    store,
    dataDir,
    now: fixedNow,
    modelCall: async () => ({
      summary: 'No verification note earns persistence.',
      verdict: 'silence',
    }),
  });

  assert.equal(result.output.verdict, 'silence');
  assert.deepEqual(result.mutations, []);
  assert.deepEqual(await dataFiles(dataDir, 'verify'), []);
});

test('blank verdicts degrade to silence without writing', async () => {
  const { store, dataDir } = await seededStore();

  const result = await runStation('decide', {
    store,
    dataDir,
    now: fixedNow,
    modelCall: async () => ({
      summary: 'No decision earns attention.',
      verdict: '',
    }),
  });

  assert.equal(result.output.verdict, 'silence');
  assert.deepEqual(result.mutations, []);
  assert.deepEqual(await dataFiles(dataDir, 'decisions'), []);
});

test('unrecognized verdicts are rejected instead of silently swallowed', async () => {
  const { store, dataDir } = await seededStore();

  await assert.rejects(
    runStation('decide', {
      store,
      dataDir,
      now: fixedNow,
      modelCall: async () => ({
        summary: 'No decision earns attention.',
        verdict: 'approve',
      }),
    }),
    /invalid verdict: approve/,
  );

  assert.deepEqual(await dataFiles(dataDir, 'decisions'), []);
});

test('decide refuses auto-action fields', async () => {
  for (const [key, value] of [
    ['autoAct', true],
    ['externalAction', true],
    ['act', true],
    ['acted', 'acted'],
  ]) {
    const { store, dataDir } = await seededStore();

    await assert.rejects(
      runStation('decide', {
        store,
        dataDir,
        now: fixedNow,
        modelCall: async () => ({
          summary: 'Tries to act.',
          verdict: 'recommend',
          [key]: value,
          recommendation: {
            decision: 'Whether to mutate the world.',
            recommended: 'Do it automatically.',
            reason: 'Invalid under Article 2.',
            reversibility: 'internal-revertible',
            undo: 'Undo it.',
            evidenceIds: [],
            confidence: 1,
          },
        }),
      }),
      new RegExp(`refused auto-action field: ${key}`),
    );

    assert.deepEqual(await dataFiles(dataDir, 'decisions'), []);
  }

  assert.deepEqual(
    RECOMMENDATION_VERDICTS,
    ['silence', 'recommend'],
  );
});

test('decide requires a recommendation object for recommend verdicts', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-loop-data-'));
  const store = createSubstrateStore({ dataDir, now: fixedNow });

  await assert.rejects(
    runStation('decide', {
      store,
      dataDir,
      now: fixedNow,
      modelCall: async () => ({
        summary: 'Tries the old fallback shape.',
        verdict: 'recommend',
        decision: 'Whether to mutate the world.',
        recommended: 'Do it automatically.',
        reason: 'Invalid under Article 2.',
        reversibility: 'internal-revertible',
        undo: 'Undo it.',
        evidenceIds: [],
        confidence: 1,
      }),
    }),
    /decide returned recommend without a recommendation object/,
  );
});

test('decide strips aliased and nested auto-action fields before persistence', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-loop-data-'));
  const store = createSubstrateStore({ dataDir, now: fixedNow });

  const result = await runStation('decide', {
    store,
    dataDir,
    now: fixedNow,
    modelCall: async () => ({
      summary: 'Includes fields the daemon must ignore.',
      verdict: 'recommend',
      executeNow: true,
      metadata: { autoAct: true },
      recommendation: {
        decision: 'Whether to review saved bookmarks.',
        recommended: 'Review only the attention-recovery bookmarks.',
        reason: 'It is local and reversible.',
        reversibility: 'internal-revertible',
        undo: 'Drop the note.',
        evidenceIds: [],
        confidence: 0.4,
        executeNow: true,
        metadata: { autoAct: true },
      },
    }),
  });

  assert.equal(result.output.verdict, 'recommend');
  assert.equal(result.mutations.length, 1);
  assert(!Object.hasOwn(result.output, 'executeNow'));
  assert(!Object.hasOwn(result.output, 'metadata'));

  const decisions = await dataFiles(dataDir, 'decisions');
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].acted, 'pending');
  assert.equal(decisions[0].tag, '[advise]');
  assert(!Object.hasOwn(decisions[0], 'executeNow'));
  assert(!Object.hasOwn(decisions[0], 'metadata'));
});

test('decide rejects [auto] protocol metadata before persistence', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-loop-data-'));

  await assert.rejects(
    commitStationOutput(
      'decide',
      {
        summary: 'Protocol metadata tries to request auto authority.',
        verdict: 'recommend',
        recommendation: {
          decision: 'Whether to review a local note.',
          recommended: 'Review the local note.',
          reason: 'The action is local and reversible.',
          reversibility: 'internal-revertible',
          undo: 'Drop the review note.',
          evidenceIds: [],
          confidence: 0.4,
          protocol: {
            target: 'recovery',
            action: 'maintain',
            object: 'sleep_duration',
            basis: 'sleep_trend',
            tag: '[auto]',
          },
        },
      },
      { dataDir, now: fixedNow },
    ),
    /recommendation protocol metadata may not request \[auto\]/,
  );
  assert.deepEqual(await dataFiles(dataDir, 'decisions'), []);
});

test('decide rejects mocked governor [auto] tags before persistence', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-loop-data-'));

  await assert.rejects(
    commitStationOutput(
      'decide',
      {
        summary: 'Governor tries to auto-act.',
        verdict: 'recommend',
        recommendation: {
          decision: 'Whether to review a local note.',
          recommended: 'Review the local note.',
          reason: 'The action is local and reversible.',
          reversibility: 'internal-revertible',
          undo: 'Drop the review note.',
          evidenceIds: [],
          confidence: 0.4,
        },
      },
      {
        dataDir,
        now: fixedNow,
        governNextAction: () => ({
          kind: 'NextAction',
          tag: '[auto]',
        }),
      },
    ),
    /loop recommendations may not auto-act/,
  );
  assert.deepEqual(await dataFiles(dataDir, 'decisions'), []);
});

test('sense and compound idempotent reruns report deduped ledger entries', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-loop-data-'));
  const store = createSubstrateStore({ dataDir, now: fixedNow });
  const senseOutput = {
    summary: 'Capture one footprint sample.',
    verdict: 'silence',
    footprintSamples: [
      {
        eventAt: '2026-06-26T06:30:00.000Z',
        phenomenology: {
          rung: 'free',
          report: 'A repeatable sample.',
          ratings: { clarity: 3 },
        },
        physiology: { hrv: 52 },
        context: { inMotion: true },
      },
    ],
  };

  const firstSense = await commitStationOutput('sense', senseOutput, { store, dataDir, now: fixedNow });
  const secondSense = await commitStationOutput('sense', senseOutput, { store, dataDir, now: fixedNow });

  assert.deepEqual(firstSense.map((mutation) => mutation.op), ['write']);
  assert.deepEqual(secondSense.map((mutation) => mutation.op), ['deduped']);

  const exposure = await store.writeExposure({
    type: 'directive',
    statement: 'Use prior engagement as self-pattern evidence.',
    sourceId: 'loop:test',
    eventAt: '2026-06-24T09:00:00.000Z',
    provenance: { surface: 'loop', lane: 'deliberate' },
  });
  const compoundOutput = {
    summary: 'Learn one pattern.',
    verdict: 'silence',
    selfPattern: {
      exposureId: exposure.id,
      pattern: 'Prefers idempotent learning contracts.',
      confidence: 0.5,
    },
  };

  const firstCompound = await commitStationOutput(
    'compound',
    compoundOutput,
    { store, dataDir, now: fixedNow },
  );
  const secondCompound = await commitStationOutput(
    'compound',
    compoundOutput,
    { store, dataDir, now: fixedNow },
  );

  assert.deepEqual(firstCompound.map((mutation) => mutation.op), ['write']);
  assert.deepEqual(secondCompound.map((mutation) => mutation.op), ['deduped']);
});

test('safeDataPath rejects traversal and absolute relative paths', () => {
  for (const relPath of ['../x', '/etc/x', 'a/../../b']) {
    assert.throws(
      () => safeDataPath(path.join(os.tmpdir(), 'cs-k-safe-data'), relPath),
      /refused unsafe data path/,
    );
  }
});

test('safeDataPath rejects symlinks that escape the data root', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-safe-data-'));
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-safe-outside-'));
  await fs.symlink(outsideDir, path.join(dataDir, 'escape'), 'dir');

  assert.throws(
    () => safeDataPath(dataDir, path.join('escape', 'x.json')),
    /refused unsafe data path/,
  );
});

async function seededStore() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-loop-data-'));
  const store = createSubstrateStore({ dataDir, now: fixedNow });
  const bookmarksFile = path.join(dataDir, 'bookmarks.json');
  await fs.writeFile(bookmarksFile, `${JSON.stringify(BOOKMARKS_FIXTURE, null, 2)}\n`, 'utf8');
  await ingestBookmarks({ store, file: bookmarksFile });
  const exposures = await store.listRecords('Exposure');
  return {
    store,
    dataDir,
    exposure: exposures.at(-1),
  };
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
