import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  COMMIT_TOOL,
  writeUniqueDataJson,
} from '../../daemon/run.mjs';
import {
  listOpenGoals,
  readGoal,
} from '../goals/goals.mjs';
import { createSubstrateStore } from '../substrate.mjs';
import { strategize } from './strategize.mjs';

const fixedNow = () => new Date('2026-06-28T03:04:05.000Z');

test('strategize produces a structured strategy artifact offline', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-strategy-data-'));
  const calls = [];

  const result = await strategize('Win a niche enterprise design partner by August.', {
    dataDir,
    now: fixedNow,
    modelCall: async (request) => {
      calls.push(request);
      assert.equal(request.label, 'cs-k:strategize');
      assert.equal(request.tool.name, COMMIT_TOOL.name);
      assert.match(request.system, /Catalyst Chain/);
      assert.match(request.system, /evidence-ledger -> goal-arithmetic/);
      assert.match(request.user, /Win a niche enterprise design partner/);
      assert.match(request.user, /## Open objectives\n\(none\)/);
      return strategyOutput();
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(result.artifact.kind, 'StrategyArtifact');
  assert.equal(result.artifact.goal, 'Win a niche enterprise design partner by August.');
  assert.deepEqual(result.artifact.degreeMap.map((entry) => entry.degree), [0, 1, 2, 3, 4]);
  assert.deepEqual(Object.keys(result.artifact.filters).sort(), [
    'asymmetry',
    'expressible',
    'notPricedIn',
  ]);
  assert.equal(result.artifact.filters.expressible.pass, true);
  assert.equal(result.artifact.filters.notPricedIn.pass, true);
  assert.equal(result.artifact.filters.asymmetry.ratio, '3.5:1');
  assert(result.artifact.antiFooling.killCriteria.includes('No buyer interview booked within 7 days.'));
  assert.equal(result.artifact.workstreams[0].name, 'Evidence');
  assert.equal(result.artifact.bets[0].deadline, '2026-08-01');

  const strategies = await dataFiles(dataDir, 'strategies');
  assert.equal(strategies.length, 1);
  assert.deepEqual(strategies[0].degreeMap.map((entry) => entry.degree), [0, 1, 2, 3, 4]);
});

test('actionable strategy routes through governNextAction to a gated LoopRecommendation', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-strategy-data-'));

  const result = await strategize('Decide whether to sign the annual vendor contract.', {
    dataDir,
    now: fixedNow,
    modelCall: async () => strategyOutput({ actionable: true, turnBudget: 2 }),
  });

  assert.equal(result.nextAction.kind, 'NextAction');
  assert.equal(result.nextAction.tag, '[gate:human]');
  assert.notEqual(result.nextAction.tag, '[auto]');
  assert.equal(result.nextAction.unattended, false);
  assert.equal(result.mutations.length, 3);
  assert.equal(result.objectiveGoal.objective, 'Stage a human review before signing the annual vendor contract.');
  assert.deepEqual(result.objectiveGoal.state, {
    source: 'strategize',
    strategyGoal: 'Decide whether to sign the annual vendor contract.',
    strategyCreatedAt: '2026-06-28T03:04:05.000Z',
    turnBudget: 2,
    turnsUsed: 0,
    turnsRemaining: 2,
  });

  const decisions = await dataFiles(dataDir, 'decisions');
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].kind, 'LoopRecommendation');
  assert.equal(decisions[0].advisoryOnly, true);
  assert.equal(decisions[0].acted, 'pending');
  assert.equal(decisions[0].risk, 'consequential');
  assert.equal(decisions[0].tag, '[gate:human]');
  assert.notEqual(decisions[0].tag, '[auto]');
  assert.deepEqual(await readGoal(result.objectiveGoal.goalId, { dataDir }), result.objectiveGoal);
});

test('strategize persists actionable objectives and reloads open goals into prompt context', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-strategy-data-'));

  const first = await strategize('Turn a strategy into one next objective.', {
    dataDir,
    now: fixedNow,
    goalTurnBudget: 3,
    modelCall: async (request) => {
      assert.match(request.user, /## Open objectives\n\(none\)/);
      return strategyOutput({ actionable: true });
    },
  });

  const openGoals = await listOpenGoals({ dataDir });
  assert.equal(openGoals.length, 1);
  assert.equal(openGoals[0].goalId, first.objectiveGoal.goalId);
  assert.equal(openGoals[0].state.turnBudget, 3);
  assert.equal(openGoals[0].state.turnsRemaining, 3);

  const calls = [];
  await strategize('Account for already-open objectives.', {
    dataDir,
    now: fixedNow,
    modelCall: async (request) => {
      calls.push(request);
      return strategyOutput();
    },
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].user, /## Open objectives/);
  assert.match(calls[0].user, /Stage a human review before signing the annual vendor contract/);
  assert.match(calls[0].user, /turnsRemaining=3/);
});

test('actionable strategy accepts internal-compensable reversibility', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-strategy-data-'));

  const result = await strategize('Change an internal protocol without losing the old one.', {
    dataDir,
    now: fixedNow,
    modelCall: async () =>
      strategyOutput({
        actionable: true,
        reversibilityClass: 'internal-compensable',
      }),
  });

  assert.equal(result.nextAction['reversibility-class'], 'internal-compensable');

  const decisions = await dataFiles(dataDir, 'decisions');
  assert.equal(decisions[0].reversibility, 'internal-compensable');
  assert.equal(decisions[0].tag, '[gate:human]');
});

test('actionable strategy stamps chat-evidence recommendations frontierExcluded at write time', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-strategy-data-'));
  const store = createSubstrateStore({ dataDir, now: fixedNow });
  const chat = await store.writeExposure({
    type: 'observation',
    statement: 'STRATEGY_CHAT_SECRET must stay out of frontier prompts.',
    sourceId: 'strategy-chat',
    eventAt: fixedNow().toISOString(),
    provenance: { surface: 'claude', lane: 'deliberate' },
  });

  await strategize('Decide whether to act on a private strategy note.', {
    dataDir,
    store,
    now: fixedNow,
    modelCall: async () =>
      strategyOutput({
        actionable: true,
        evidenceIds: [chat.id],
      }),
  });

  const decisions = await dataFiles(dataDir, 'decisions');
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].kind, 'LoopRecommendation');
  assert.deepEqual(decisions[0].evidenceIds, [chat.id]);
  assert.equal(decisions[0].frontierExcluded, true);
});

test('strategy artifacts are persisted under data with daemon-owned path allocation', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-strategy-data-'));

  const result = await strategize('Map a safe launch strategy.', {
    dataDir,
    now: fixedNow,
    modelCall: async () => strategyOutput({ maliciousPath: true }),
  });

  assert.equal(result.mutations[0].kind, 'StrategyArtifact');
  assert.equal(result.mutations[0].path, path.join('data', 'strategies', '2026-06-28T03-04-05.json'));
  assert.equal(await exists(path.join(dataDir, 'escape.json')), false);

  const strategies = await dataFiles(dataDir, 'strategies');
  assert.equal(strategies.length, 1);
  assert(!Object.hasOwn(strategies[0], 'path'));
  assert(!Object.hasOwn(strategies[0], 'dataPath'));

  await assert.rejects(
    writeUniqueDataJson(dataDir, '../escape', 'bad', { ok: false }),
    /refused unsafe data path/,
  );
});

test('non-actionable strategy persists without staging a decision action', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-strategy-data-'));

  const result = await strategize('Understand whether this goal is worth pursuing.', {
    dataDir,
    now: fixedNow,
    modelCall: async () => strategyOutput({ actionable: false }),
  });

  assert.equal(result.nextAction, undefined);
  assert.equal(result.mutations.length, 1);
  assert.equal((await dataFiles(dataDir, 'strategies')).length, 1);
  assert.deepEqual(await dataFiles(dataDir, 'decisions'), []);
});

function strategyOutput({
  actionable = false,
  evidenceIds = ['exposure:goal'],
  maliciousPath = false,
  reversibilityClass = 'external-cancelable',
  turnBudget,
} = {}) {
  return {
    summary: 'Use evidence before committing effort.',
    verdict: actionable ? 'recommend' : 'silence',
    ...(maliciousPath ? { path: '../escape.json', dataPath: '../escape.json' } : {}),
    strategy: {
      ...(maliciousPath ? { path: '../escape.json', dataPath: '../escape.json' } : {}),
      degreeMap: [
        {
          degree: 0,
          answer: 'The named goal is acquiring one enterprise design partner.',
          evidenceIds: ['exposure:goal'],
        },
        {
          degree: 1,
          answer: 'The immediate beneficiary is a specific buyer team with an urgent workflow.',
          evidenceIds: ['exposure:buyer'],
        },
        {
          degree: 2,
          answer: 'Displaced effort moves from broad pitching to one painful workflow wedge.',
          evidenceIds: [],
        },
        {
          degree: 3,
          answer: 'The reflexive story is credibility from solving a narrow painful job.',
          evidenceIds: [],
        },
        {
          degree: 4,
          answer: 'The thesis breaks if interviews show the pain is mild or already solved.',
          evidenceIds: [],
        },
      ],
      filters: {
        expressible: {
          pass: true,
          rationale: 'The expression is a seven-day interview and prototype sprint.',
          expression: 'buyer interview sprint',
        },
        notPricedIn: {
          pass: true,
          rationale: 'No commitment has been made; learning is still cheap.',
        },
        asymmetry: {
          pass: true,
          rationale: 'One week can unlock a design partner or cheaply kill the path.',
          ratio: '3.5:1',
        },
      },
      evidenceLedger: [
        {
          claim: 'A narrow buyer pain is more useful than a broad launch.',
          supports: ['Prior inbound comments mention this workflow.'],
          counters: ['No buyer has committed to a live workflow review yet.'],
          confidence: 0.62,
        },
      ],
      goalArithmetic: {
        currentState: 'No committed design partner.',
        desiredState: 'One buyer agrees to a workflow review and prototype feedback loop.',
        gap: 'A named buyer, a painful workflow, and a dated review.',
        deadline: '2026-08-01',
        constraints: ['No broad launch until pain is verified.'],
        forcingFunction: 'Book one interview within seven days.',
      },
      bets: [
        {
          claim: 'A workflow-specific interview will reveal a design-partner-grade pain.',
          direction: 'yes',
          magnitude: 'one qualified workflow',
          deadline: '2026-08-01',
          expression: 'interview sprint',
          carry: 'one week of focus',
          resolutionRisk: 'Buyer may be polite but not committed.',
          asymmetry: '3.5:1',
          status: 'draft',
        },
      ],
      antiFooling: {
        disconfirmers: ['Buyer will not share current workflow artifacts.'],
        failureModes: ['Mistaking politeness for urgency.'],
        killCriteria: [
          'No buyer interview booked within 7 days.',
          'Two interviews show the pain is already solved.',
        ],
      },
      workstreams: [
        {
          name: 'Evidence',
          objective: 'Verify pain before building.',
          nextSteps: ['Ask for one workflow artifact.', 'Schedule a 30 minute review.'],
          dependencies: ['Named buyer contact'],
          stopCondition: 'No artifact or review slot after two asks.',
        },
      ],
      ...(actionable
        ? {
            actionableNextStep: {
              target: 'Stage a human review before signing the annual vendor contract.',
              ...(turnBudget !== undefined ? { turnBudget } : {}),
              risk: 'consequential',
              reversibilityClass,
              authority: 'human',
              reason: 'The contract changes external obligations and should be gated.',
              undo: 'Do not sign; leave the current contract unchanged.',
              evidenceIds,
              confidence: 0.71,
              tag: '[auto]',
            },
          }
        : {}),
    },
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

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
