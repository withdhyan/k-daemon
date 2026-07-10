import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  GOAL_STATUSES,
  completeGoal,
  createGoal,
  judgeGoal,
  listGoals,
  listOpenGoals,
  readGoal,
  recordProgress,
  tickDownGoal,
} from './goals.mjs';

const fixedNow = () => new Date('2026-06-28T03:04:05.000Z');
const goalShape = [
  'createdAtMs',
  'goalId',
  'objective',
  'state',
  'status',
  'timeUsedSeconds',
  'tokenBudget',
  'tokensUsed',
  'updatedAtMs',
];

test('createGoal persists an active goal with the full thread_goals shape', async () => {
  const dataDir = await tempDataDir();

  const goal = await createGoal('Persist a multi-turn objective.', {
    tokenBudget: 100,
    dataDir,
    now: fixedNow,
  });

  assert.deepEqual(Object.keys(goal).sort(), goalShape);
  assert.equal(goal.objective, 'Persist a multi-turn objective.');
  assert.equal(goal.status, 'active');
  assert.equal(goal.tokenBudget, 100);
  assert.equal(goal.tokensUsed, 0);
  assert.equal(goal.timeUsedSeconds, 0);
  assert.deepEqual(goal.state, {});
  assert.equal(goal.createdAtMs, Date.parse('2026-06-28T03:04:05.000Z'));
  assert.equal(goal.updatedAtMs, goal.createdAtMs);

  const files = await dataFiles(dataDir, 'goals');
  assert.equal(files.length, 1);
  assert.deepEqual(files[0], goal);
  assert.deepEqual(await readGoal(goal.goalId, { dataDir }), goal);
  assert.deepEqual(await listGoals('active', { dataDir }), [goal]);
});

test('recordProgress accumulates usage, merges state, and keeps prior snapshots', async () => {
  const dataDir = await tempDataDir();
  const goal = await createGoal('Accumulate progress across turns.', {
    tokenBudget: 20,
    dataDir,
    now: fixedNow,
  });

  const first = await recordProgress(goal.goalId, {
    dataDir,
    tokens: 3,
    seconds: 1.25,
    state: { currentStep: 'read', nested: { seen: ['plan'] } },
    now: fixedNow,
  });
  const second = await recordProgress(goal.goalId, {
    dataDir,
    tokens: 4,
    seconds: 2.75,
    state: { nested: { tests: 'written' }, done: false },
    now: fixedNow,
  });

  assert.equal(first.tokensUsed, 3);
  assert.equal(first.timeUsedSeconds, 1.25);
  assert.equal(second.tokensUsed, 7);
  assert.equal(second.timeUsedSeconds, 4);
  assert.deepEqual(second.state, {
    currentStep: 'read',
    nested: { seen: ['plan'], tests: 'written' },
    done: false,
  });

  const history = await dataFiles(dataDir, 'goals');
  assert.equal(history.length, 3);
  assert.deepEqual(history.map((snapshot) => snapshot.tokensUsed), [0, 3, 7]);
  assert.deepEqual(new Set(history.map((snapshot) => snapshot.goalId)), new Set([goal.goalId]));
  assert.deepEqual(await readGoal(goal.goalId, { dataDir }), second);
});

test('judgeGoal applies budget, done, blocked, and active rules', async () => {
  const dataDir = await tempDataDir();

  const budgeted = await createGoal('Stop when over budget.', {
    tokenBudget: 5,
    dataDir,
    now: fixedNow,
  });
  await recordProgress(budgeted.goalId, { dataDir, tokens: 5, seconds: 1, now: fixedNow });
  assert.equal(await judgeGoal(budgeted.goalId, { dataDir, now: fixedNow }), 'budget_limited');
  assert.equal((await readGoal(budgeted.goalId, { dataDir })).status, 'budget_limited');

  const done = await createGoal('Close when done.', {
    tokenBudget: 50,
    dataDir,
    now: fixedNow,
  });
  await recordProgress(done.goalId, { dataDir, state: { done: true }, now: fixedNow });
  assert.equal(await judgeGoal(done.goalId, { dataDir, now: fixedNow }), 'complete');

  const unbudgetedDone = await createGoal('A zero budget is unbudgeted when done.', {
    tokenBudget: 0,
    dataDir,
    now: fixedNow,
  });
  await recordProgress(unbudgetedDone.goalId, {
    dataDir,
    state: { done: true },
    now: fixedNow,
  });
  assert.equal(await judgeGoal(unbudgetedDone.goalId, { dataDir, now: fixedNow }), 'complete');

  const blocked = await createGoal('Surface explicit blockers.', {
    tokenBudget: 50,
    dataDir,
    now: fixedNow,
  });
  await recordProgress(blocked.goalId, { dataDir, state: { blocked: true }, now: fixedNow });
  assert.equal(await judgeGoal(blocked.goalId, { dataDir, now: fixedNow }), 'blocked');

  const active = await createGoal('Stay active without terminal signals.', {
    tokenBudget: 50,
    dataDir,
    now: fixedNow,
  });
  await recordProgress(active.goalId, { dataDir, tokens: 4, seconds: 2, now: fixedNow });
  assert.equal(await judgeGoal(active.goalId, { dataDir, now: fixedNow }), 'active');
});

test('status enum is exactly the six allowed goal statuses', () => {
  assert.deepEqual(GOAL_STATUSES, [
    'active',
    'paused',
    'blocked',
    'usage_limited',
    'budget_limited',
    'complete',
  ]);
});

test('open-goal listing, turn tick-down, and completion helpers round-trip snapshots', async () => {
  const dataDir = await tempDataDir();
  const goal = await createGoal('Use a short turn budget.', {
    dataDir,
    now: fixedNow,
    turnBudget: 2,
  });

  assert.deepEqual(goal.state, {
    turnBudget: 2,
    turnsUsed: 0,
    turnsRemaining: 2,
  });
  assert.deepEqual(await listOpenGoals({ dataDir }), [goal]);

  const ticked = await tickDownGoal(goal.goalId, {
    dataDir,
    turns: 1,
    now: fixedNow,
  });
  assert.equal(ticked.status, 'active');
  assert.equal(ticked.state.turnsUsed, 1);
  assert.equal(ticked.state.turnsRemaining, 1);

  const exhausted = await tickDownGoal(goal.goalId, {
    dataDir,
    turns: 1,
    now: fixedNow,
  });
  assert.equal(exhausted.status, 'budget_limited');
  assert.equal(exhausted.state.turnsUsed, 2);
  assert.equal(exhausted.state.turnsRemaining, 0);

  const completed = await completeGoal(goal.goalId, {
    dataDir,
    now: fixedNow,
  });
  assert.equal(completed.status, 'complete');
  assert.equal(completed.state.done, true);
  assert.deepEqual(await listOpenGoals({ dataDir }), []);
  assert.equal((await readGoal(goal.goalId, { dataDir })).status, 'complete');
});

test('daemon-owned goal writes ignore caller-supplied artifact paths', async () => {
  const dataDir = await tempDataDir();

  const goal = await createGoal('Do not trust model-provided paths.', {
    tokenBudget: 10,
    dataDir,
    path: '../escape.json',
    dataPath: '../escape.json',
    now: fixedNow,
  });
  await recordProgress(goal.goalId, {
    dataDir,
    tokens: 1,
    seconds: 1,
    path: '../escape.json',
    dataPath: '../escape.json',
    now: fixedNow,
  });

  assert.equal(await exists(path.join(dataDir, 'escape.json')), false);
  assert.equal(await exists(path.join(dataDir, '..', 'escape.json')), false);

  const files = await dataFileEntries(dataDir, 'goals');
  assert.equal(files.length, 2);
  for (const { name, data } of files) {
    assert.match(name, /^[0-9]+-[0-9a-f-]+(?:-\d+)?\.json$/);
    assert(!Object.hasOwn(data, 'path'));
    assert(!Object.hasOwn(data, 'dataPath'));
  }
});

async function tempDataDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-goals-data-'));
}

async function dataFiles(dataDir, dirname) {
  return (await dataFileEntries(dataDir, dirname)).map(({ data }) => data);
}

async function dataFileEntries(dataDir, dirname) {
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
      .map((entry) =>
        fs.readFile(path.join(dir, entry.name), 'utf8').then((source) => ({
          name: entry.name,
          data: JSON.parse(source),
        })),
      ),
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
