import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  COMMIT_TOOL,
  runStation,
} from '../../daemon/run.mjs';
import { createSubstrateStore } from '../substrate.mjs';
import { ADVISORS } from './advisors.mjs';
import { boardModelCall } from './board.mjs';

const fixedNow = () => new Date('2026-06-28T00:00:00.000Z');
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

test('high-stakes decide escalates to 6 advisors x 2 rounds and persists a DecisionCard', async () => {
  const { store, dataDir, exposure } = await highStakesStore();
  const { calls, fake } = boardFake();

  const result = await runStation('decide', {
    store,
    dataDir,
    now: fixedNow,
    input: 'Whether to delete the external account permanently this week.',
    modelCall: fake,
  });

  const round1Labels = labels(calls, ':board:round1:');
  const round2Labels = labels(calls, ':board:round2:');
  assert.equal(calls.length, 14);
  assert.equal(round1Labels.length, 6);
  assert.equal(round2Labels.length, 6);
  assert.deepEqual(
    round1Labels.map((label) => label.split(':').at(-1)).sort(),
    ADVISORS.map((advisor) => advisor.name).sort(),
  );
  assert.deepEqual(
    round2Labels.map((label) => label.split(':').at(-1)).sort(),
    ADVISORS.map((advisor) => advisor.name).sort(),
  );

  assert.equal(result.output.verdict, 'recommend');
  assert.deepEqual(Object.keys(result.output.decisionCard).sort(), decisionCardKeys);
  assert.deepEqual(result.output.decisionCard.assumed, defaultAuditor().convergence_points);
  assert(result.output.decisionCard.read.includes(exposure.id));
  assert(!Object.hasOwn(result.output, 'autoAct'));
  assert(!Object.hasOwn(result.output, 'externalAction'));

  const decisions = await dataFiles(dataDir, 'decisions');
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].kind, 'LoopRecommendation');
  assert.equal(decisions[0].acted, 'pending');
  assert.equal(decisions[0].advisoryOnly, true);
  assert.equal(decisions[0].tag, '[gate:human]');
  assert.deepEqual(Object.keys(decisions[0].decisionCard).sort(), decisionCardKeys);
  assert.equal(decisions[0].decisionCard.pick, defaultAuditor().consider);
  assert(!Object.hasOwn(decisions[0], 'autoAct'));
  assert(!Object.hasOwn(decisions[0], 'externalAction'));
});

test('low-stakes decide stays a single model call', async () => {
  const { store, dataDir } = await freshStore();
  const calls = [];

  const result = await runStation('decide', {
    store,
    dataDir,
    now: fixedNow,
    input: 'Whether to review one local note today.',
    modelCall: async (request) => {
      calls.push(request);
      assert.equal(request.tool.name, COMMIT_TOOL.name);
      return fallbackRecommendation();
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].label, 'cs-k:decide');
  assert.equal(result.output.verdict, 'recommend');
});

test('Devil Advocate empty or echoing `on` is re-prompted, then a distinct counter-position passes', async () => {
  for (const firstOn of ['', 'stage a human review before deleting account']) {
    const { calls, fake } = boardFake({
      daResponses: [
        { contradicts: true, on: firstOn },
        {
          contradicts: true,
          on: 'preserve the account and reduce exposure first; the deletion urge may be attention hygiene in disguise',
        },
      ],
    });

    const output = await boardModelCall(baseRequest(), { singleCall: fake });
    const daLabels = labels(calls, ':board:devil-advocate');

    assert.equal(output.verdict, 'recommend');
    assert.equal(daLabels.length, 2);
    assert(daLabels.at(-1).endsWith(':retry'));
    assert(
      !output.decisionCard.missing.some((item) =>
        item.includes('devil advocate did not produce a structurally distinct counter-position'),
      ),
    );
  }
});

test('Integration Auditor convergence_points structurally populate the DecisionCard assumptions', async () => {
  const auditor = {
    ...defaultAuditor(),
    convergence_points: [
      '3 advisors agree the decision has external blast radius',
      '4 advisors prefer a staged human review before any account change',
    ],
  };
  const { fake } = boardFake({ auditor });

  const output = await boardModelCall(baseRequest(), { singleCall: fake });

  assert.deepEqual(output.decisionCard.assumed, auditor.convergence_points);
  assert.match(output.recommendation.reason, /external blast radius|human review/);
});

test('boardModelCall requires an explicit singleCall dependency', async () => {
  await assert.rejects(
    boardModelCall(baseRequest()),
    /requires options\.singleCall/,
  );
});

test('Board internal errors are logged and fall back to governed plain decide silence', async () => {
  const { store, dataDir } = await highStakesStore();
  const calls = [];
  const errors = [];
  const originalError = console.error;
  const fake = async (request) => {
    calls.push(request);
    if (request.label.includes(':board:round1:body')) {
      throw new Error('round 1 failed');
    }
    if (request.tool.name === COMMIT_TOOL.name) {
      return {
        summary: 'Plain decide fallback silence.',
        verdict: 'silence',
      };
    }
    return advisorOrAuditorOutput(request);
  };

  console.error = (...args) => errors.push(args.join(' '));
  try {
    const result = await runStation('decide', {
      store,
      dataDir,
      now: fixedNow,
      input: 'Whether to delete the external account permanently this week.',
      modelCall: fake,
    });

    assert.equal(result.output.summary, 'Plain decide fallback silence.');
    assert.equal(result.output.verdict, 'silence');
    assert(!Object.hasOwn(result.output, 'autoAct'));
    assert(!Object.hasOwn(result.output, 'externalAction'));
    assert.deepEqual(result.mutations, []);
  } finally {
    console.error = originalError;
  }

  assert.match(errors.join('\n'), /Board internal pass failed/);
  assert.equal(calls.at(-1).label, 'cs-k:decide');
  assert.equal(calls.at(-1).tool.name, COMMIT_TOOL.name);
});

test('board.mjs constructs no direct model client', async () => {
  const source = await fs.readFile(new URL('./board.mjs', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /new\s+Anthropic\b/);
  assert.doesNotMatch(source, /@anthropic-ai\/sdk/);
  assert.doesNotMatch(source, /messages\.create/);
});

function boardFake(options = {}) {
  const calls = [];
  const daResponses = [...(options.daResponses ?? [
    {
      contradicts: true,
      on: 'preserve the account and reduce exposure first; deletion may be a proxy for attention hygiene',
    },
  ])];
  const auditor = options.auditor ?? defaultAuditor();

  return {
    calls,
    fake: async (request) => {
      calls.push(request);
      return advisorOrAuditorOutput(request, { daResponses, auditor });
    },
  };
}

function advisorOrAuditorOutput(request, options = {}) {
  if (request.tool.name === 'board_advisor_analysis') {
    const labelPart = request.label.split(':board:').at(-1);
    return {
      analysis:
        `${labelPart}: stage a human review before deleting account; preserve reversibility and name missing evidence.`,
    };
  }

  if (request.tool.name === 'board_devil_advocate') {
    return options.daResponses?.shift() ?? {
      contradicts: true,
      on: 'preserve the account and reduce exposure first; deletion may be a proxy for attention hygiene',
    };
  }

  if (request.tool.name === 'board_integration_auditor') {
    return options.auditor ?? defaultAuditor();
  }

  if (request.tool.name === COMMIT_TOOL.name) {
    return fallbackRecommendation();
  }

  throw new Error(`unexpected tool: ${request.tool.name}`);
}

function defaultAuditor() {
  return {
    convergence_points: [
      'deleting the external account has irreversible or external blast radius',
      'the safe pick is a staged human review before any account mutation',
    ],
    tension: 'whether delaying account deletion preserves attention or prolongs a known drain',
    da_landed: false,
    synthesis:
      'the board believes the account decision has enough blast radius to stage a recommendation, not act.',
    consider:
      'Do not delete the external account yet; stage a human review of the blast radius and evidence first.',
  };
}

function fallbackRecommendation(overrides = {}) {
  return {
    summary: 'Plain decide recommendation.',
    verdict: 'recommend',
    recommendation: {
      decision: 'Whether to review one local note today.',
      recommended: 'Review the local note only.',
      reason: 'It is local and reversible.',
      reversibility: 'internal-revertible',
      undo: 'Drop the note.',
      evidenceIds: [],
      confidence: 0.4,
    },
    ...overrides,
  };
}

function baseRequest() {
  return {
    label: 'cs-k:decide',
    station: 'decide',
    model: 'fake-model',
    maxTokens: 4096,
    system: 'Life constitution\n\nDECIDE station\n\nNo station may act on the world.',
    user: [
      '## Substrate counts',
      'Exposure: 1',
      'SelfPattern: 0',
      'FootprintSample: 0',
      '',
      '## Recent exposure',
      '<<< Exposure:exp_board_test >>>',
      '{"id":"exp_board_test","statement":"Deleting an external account is irreversible."}',
      '',
      '## This run input',
      'Whether to delete the external account permanently this week.',
    ].join('\n'),
    tool: COMMIT_TOOL,
  };
}

async function highStakesStore() {
  const { store, dataDir } = await freshStore();
  const exposure = await store.writeExposure({
    type: 'observation',
    statement: 'Deleting an external account is irreversible and should be human-gated.',
    sourceId: 'board:test',
    eventAt: '2026-06-27T12:00:00.000Z',
    provenance: { surface: 'loop', lane: 'deliberate' },
  });

  return { store, dataDir, exposure };
}

async function freshStore() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-board-data-'));
  const store = createSubstrateStore({ dataDir, now: fixedNow });
  return { store, dataDir };
}

function labels(calls, includes) {
  return calls.map((call) => call.label).filter((label) => label.includes(includes));
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
