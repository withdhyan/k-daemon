import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSubstrateStore } from '../substrate.mjs';
import {
  deliberationStakesGate,
  runDeliberation,
  sovereignRecordFilter,
} from './deliberate.mjs';

const fixedNow = () => new Date('2026-07-02T00:00:00.000Z');
const decisionCardKeys = [
  'asked',
  'read',
  'assumed',
  'missing',
  'pick',
  'why',
  'whatWouldChangeIt',
  'next',
].sort();

const highComplexityQuestion = [
  'Should I choose the local weekly review format that balances attention debt,',
  'current strategy, current notes, and ongoing work, because option A creates',
  'speed but misses context, option B adds depth but costs focus, option C delays',
  'the choice, and the decision has several constraints that may matter together?',
].join(' ');

test('deliberationStakesGate is deterministic for low and high branches', () => {
  const low = deliberationStakesGate({ question: 'Should I review one local note today?' });
  assert.equal(low.escalate, false);

  const high = deliberationStakesGate({
    question: 'Should I permanently delete the external account this week?',
  });
  assert.equal(high.escalate, true);
  assert(high.reasons.some((reason) => reason.includes('high-impact terms')));
});

test('low-stakes run returns single mode without calling the model', async () => {
  const { dataDir, store } = await freshStore();
  const result = await runDeliberation({
    question: 'Should I review one local note today?',
    singleCall: async () => {
      throw new Error('low-stakes deliberation must not call the model');
    },
    dataDir,
    opts: { store, now: fixedNow },
  });

  assert.deepEqual(result, { mode: 'single' });
  assert.deepEqual(await dataFiles(dataDir, 'decisions'), []);
});

test('missing evidence triggers research and exactly one re-deliberation round', async () => {
  const { dataDir, store } = await freshStore();
  const beforeSubstrate = await substrateSnapshot(dataDir);
  const board = boardFake();
  const researchCalls = [];

  const result = await runDeliberation({
    question: highComplexityQuestion,
    singleCall: board.fake,
    dataDir,
    opts: {
      store,
      now: fixedNow,
      researchFn: async (query, options) => {
        researchCalls.push({ query, options });
        assert.equal(options.sovereignRecords, true);
        const records = [{ id: 'frontier-excluded-still-sovereign' }];
        assert.deepEqual(options.recordFilter(records), records);
        assert.equal(options.recordFilter, sovereignRecordFilter);
        return [{
          evidenceId: 'exp_research_1',
          evidenceIds: ['exp_research_1'],
          evidenceGrade: 'L4',
          source: 'vrsd',
          kind: 'Exposure',
          content: 'The local review format can stay reversible by starting as a draft.',
        }];
      },
    },
  });

  assert.equal(result.mode, 'deliberated');
  assert.equal(result.rounds, 2);
  assert.equal(researchCalls.length, 1);
  assert.equal(board.auditorCalls(), 2);
  assert.deepEqual(Object.keys(result.decisionCard).sort(), decisionCardKeys);
  assert.deepEqual(result.dissent, {
    contradicts: true,
    on: 'choose no review format yet; the complexity may be a proxy for avoiding the actual work',
  });
  assert.deepEqual(result.evidence, [{
    id: 'exp_research_1',
    grade: 'L4',
    source: 'vrsd',
  }]);
  assert(result.decisionCard.read.includes('exp_research_1'));
  assert.deepEqual(await substrateSnapshot(dataDir), beforeSubstrate);

  const decisions = await dataFiles(dataDir, 'decisions');
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].kind, 'LoopRecommendation');
  assert.equal(decisions[0].tag, '[advise]');
  assert.equal(decisions[0].advisoryOnly, true);
  assert.equal(decisions[0].acted, 'pending');
  assert.deepEqual(Object.keys(decisions[0].decisionCard).sort(), decisionCardKeys);
  assert.deepEqual(decisions[0].evidenceIds, ['exp_research_1']);
});

test('board error falls back to single mode without writing a decision', async () => {
  const { dataDir, store } = await freshStore();

  const result = await runDeliberation({
    question: highComplexityQuestion,
    singleCall: async () => {
      throw new Error('board pass failed');
    },
    dataDir,
    opts: { store, now: fixedNow },
  });

  assert.deepEqual(result, { mode: 'single' });
  assert.deepEqual(await dataFiles(dataDir, 'decisions'), []);
});

function boardFake() {
  const calls = [];
  let auditorCalls = 0;

  return {
    calls,
    auditorCalls: () => auditorCalls,
    fake: async (request) => {
      calls.push(request);

      if (request.tool.name === 'board_advisor_analysis') {
        return {
          analysis:
            'local review is reversible; keep the recommendation draft-based and compare constraints before changing anything.',
        };
      }

      if (request.tool.name === 'board_devil_advocate') {
        return {
          contradicts: true,
          on: 'choose no review format yet; the complexity may be a proxy for avoiding the actual work',
        };
      }

      if (request.tool.name === 'board_integration_auditor') {
        auditorCalls += 1;
        return {
          convergence_points: [
            'the local review choice is reversible',
            'the board prefers a draft before any broader routine change',
          ],
          tension: auditorCalls === 1
            ? 'which local review format has enough context without focus drag'
            : 'the evidence helps the context gap but future opportunity cost remains uncertain',
          da_landed: false,
          synthesis: auditorCalls === 1
            ? 'the board sees enough reversible complexity to recommend a small draft.'
            : 'the added evidence supports using a reversible draft as the first move.',
          consider:
            'Use the smaller local weekly review draft first and compare it against the constraints.',
        };
      }

      throw new Error(`unexpected tool: ${request.tool.name}`);
    },
  };
}

async function freshStore() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-deliberate-'));
  const store = createSubstrateStore({ dataDir, now: fixedNow });
  return { dataDir, store };
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

async function substrateSnapshot(dataDir) {
  const root = path.join(dataDir, 'substrate');
  const files = [];
  await collectFiles(root, root, files);
  return files.sort();
}

async function collectFiles(root, dir, files) {
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }

  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(root, file, files);
    } else if (entry.isFile()) {
      files.push(path.relative(root, file));
    }
  }
}
