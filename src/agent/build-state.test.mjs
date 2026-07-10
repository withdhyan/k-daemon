import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  BUILD_HISTORY_FILE,
  BUILD_PLANS_DIR,
  BUILD_STATE_BUILDING,
  BUILD_STATE_CANCELLED,
  BUILD_STATE_HELD,
  BUILD_STATE_INTEGRATED,
  BUILD_STATE_INTEGRATING,
  BUILD_STATE_KILLED,
  BUILD_STATE_ORPHANED,
  BUILD_STATE_QUEUED,
  BUILD_STATE_VERIFYING,
  OwnershipError,
  TRANSITIONS,
  TransitionError,
  appendHistory,
  createBuildStateStore,
  lanesNeedingRecovery,
} from './build-state.mjs';

test('every declared legal transition is accepted and representative illegal transitions throw', async () => {
  const dataDir = await tempDataDir();
  let index = 0;

  for (const [from, targets] of Object.entries(TRANSITIONS)) {
    for (const to of targets) {
      const planId = `plan-${index}`;
      const store = createBuildStateStore({ dataDir, now: fixedNow, monotonicNow: () => index });
      await store.savePlan(plan({
        id: planId,
        units: [unit({ state: from })],
        lease: lease('runner'),
      }));

      const result = await store.transition({
        planId,
        unitId: 'u1',
        to,
        actor: 'runner',
      });

      assert.equal(result.ok, true);
      assert.equal(result.plan.units[0].state, to);
      index += 1;
    }
  }

  const illegalCases = [
    [BUILD_STATE_QUEUED, BUILD_STATE_INTEGRATING],
    [BUILD_STATE_INTEGRATED, BUILD_STATE_BUILDING],
    [BUILD_STATE_CANCELLED, BUILD_STATE_BUILDING],
    [BUILD_STATE_HELD, BUILD_STATE_QUEUED],
  ];

  for (const [from, to] of illegalCases) {
    const planId = `illegal-${from}-${to}`.replace(/[^a-zA-Z0-9_.:-]/g, '-');
    const store = createBuildStateStore({ dataDir, now: fixedNow });
    await store.savePlan(plan({
      id: planId,
      units: [unit({ state: from })],
      lease: lease('runner'),
    }));

    await assert.rejects(
      () => store.transition({ planId, unitId: 'u1', to, actor: 'runner' }),
      TransitionError,
    );
  }
});

test('plan snapshot load ignores leftover temp files from a partial write', async () => {
  const dataDir = await tempDataDir();
  const store = createBuildStateStore({ dataDir, now: fixedNow });
  await store.savePlan(plan({
    id: 'partial-plan',
    units: [unit({ state: BUILD_STATE_QUEUED })],
    lease: lease('runner'),
  }));

  const plansDir = path.join(dataDir, BUILD_PLANS_DIR);
  await fs.writeFile(
    path.join(plansDir, '.partial-plan.json.999.999-bad.tmp'),
    `${JSON.stringify(plan({
      id: 'partial-plan',
      units: [unit({ state: BUILD_STATE_BUILDING })],
      lease: lease('runner'),
    }))}\n`,
    'utf8',
  );

  const loaded = await store.loadPlan('partial-plan');
  assert.equal(loaded.units[0].state, BUILD_STATE_QUEUED);

  const listed = await store.listPlans();
  assert.deepEqual(listed.map((entry) => entry.id), ['partial-plan']);
});

test('history appends rotate at the configured cap', async () => {
  const dataDir = await tempDataDir();
  const first = await appendHistory(
    { kind: 'build.test', seq: 1, payload: 'x'.repeat(120) },
    { dataDir, now: fixedNow, maxBytes: 180 },
  );
  const second = await appendHistory(
    { kind: 'build.test', seq: 2, payload: 'y'.repeat(120) },
    { dataDir, now: fixedNow, maxBytes: 180 },
  );

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);

  const historyFile = path.join(dataDir, BUILD_HISTORY_FILE);
  const rotated = await readJsonLines(`${historyFile}.1`);
  const current = await readJsonLines(historyFile);
  assert.deepEqual(rotated.map((entry) => entry.seq), [1]);
  assert.deepEqual(current.map((entry) => entry.seq), [2]);
});

test('history append failure returns ok:false instead of throwing', async () => {
  const dataDir = await tempDataDir();
  const failingFs = {
    ...fs,
    appendFile: async () => {
      const error = new Error('no space left on device');
      error.code = 'ENOSPC';
      throw error;
    },
  };

  const result = await appendHistory(
    { kind: 'build.test', seq: 1 },
    { dataDir, now: fixedNow, fsImpl: failingFs },
  );

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'ENOSPC');
});

test('lease acquire, renew, expiry, adoption, and stale-owner rejection', async () => {
  const clock = mutableClock();
  const dataDir = await tempDataDir();
  const store = createBuildStateStore({
    dataDir,
    now: clock.now,
    monotonicNow: clock.monotonicNow,
    leaseMonotonicJumpMs: 10_000,
  });
  await store.savePlan(plan({ id: 'lease-plan', units: [unit()], lease: null }));

  let acquired = await store.acquirePlanLease('lease-plan', { actor: 'orchestrator', ttlMs: 1_000 });
  assert.equal(acquired.plan.lease.owner, 'orchestrator');
  assert.equal(await store.isLeaseExpired('lease-plan'), false);

  clock.advance(500);
  let renewed = await store.renewPlanLease('lease-plan', { actor: 'orchestrator' });
  assert.equal(renewed.plan.lease.renewedAt, '2026-07-04T00:00:00.500Z');

  clock.advance(900);
  assert.equal(await store.isLeaseExpired('lease-plan'), false);
  clock.advance(101);
  assert.equal(await store.isLeaseExpired('lease-plan'), true);

  const adopted = await store.adoptPlanLease('lease-plan', { actor: 'runner' });
  assert.equal(adopted.plan.lease.owner, 'runner');

  await assert.rejects(
    () => store.transition({
      planId: 'lease-plan',
      unitId: 'u1',
      to: BUILD_STATE_BUILDING,
      actor: 'orchestrator',
    }),
    OwnershipError,
  );

  const transitioned = await store.transition({
    planId: 'lease-plan',
    unitId: 'u1',
    to: BUILD_STATE_BUILDING,
    actor: 'runner',
  });
  assert.equal(transitioned.plan.units[0].state, BUILD_STATE_BUILDING);
});

test('founder override is allowed for kill-class transitions and rejected for ordinary transitions', async () => {
  const dataDir = await tempDataDir();
  const store = createBuildStateStore({ dataDir, now: fixedNow });

  await store.savePlan(plan({
    id: 'founder-kill',
    units: [unit({ state: BUILD_STATE_BUILDING })],
    lease: lease('runner'),
  }));
  const killed = await store.transition({
    planId: 'founder-kill',
    unitId: 'u1',
    to: BUILD_STATE_KILLED,
    actor: 'founder',
  });
  assert.equal(killed.plan.units[0].state, BUILD_STATE_KILLED);

  await store.savePlan(plan({
    id: 'founder-build',
    units: [unit({ state: BUILD_STATE_QUEUED })],
    lease: lease('runner'),
  }));
  await assert.rejects(
    () => store.transition({
      planId: 'founder-build',
      unitId: 'u1',
      to: BUILD_STATE_BUILDING,
      actor: 'founder',
    }),
    OwnershipError,
  );
});

test('monotonic jump guard resets lease expiry evaluation instead of firing takeover', async () => {
  const clock = mutableClock();
  const dataDir = await tempDataDir();
  const store = createBuildStateStore({
    dataDir,
    now: clock.now,
    monotonicNow: clock.monotonicNow,
    leaseMonotonicJumpMs: 2_000,
  });
  await store.savePlan(plan({ id: 'sleep-plan', units: [unit()], lease: null }));
  await store.acquirePlanLease('sleep-plan', { actor: 'orchestrator', ttlMs: 1_000 });

  clock.advance(60_000);
  assert.equal(await store.isLeaseExpired('sleep-plan'), false);

  await assert.rejects(
    () => store.adoptPlanLease('sleep-plan', { actor: 'runner' }),
    OwnershipError,
  );
});

test('lanesNeedingRecovery flags dead and recycled pid/startTime pairs as orphaned', () => {
  const lanes = [
    lane({ id: 'live', pid: 101, startTime: 'start-a' }),
    lane({ id: 'dead', pid: 202, startTime: 'start-b' }),
    lane({ id: 'recycled', pid: 303, startTime: 'old-start' }),
  ];
  const liveProcesses = new Set([
    '101:start-a',
    '303:new-start',
  ]);

  const orphaned = lanesNeedingRecovery({ lanes }, (pid, startTime) =>
    liveProcesses.has(`${pid}:${startTime}`));

  assert.deepEqual(orphaned.map((entry) => entry.id), ['dead', 'recycled']);
  assert(orphaned.every((entry) => entry.state === BUILD_STATE_ORPHANED));
});

function fixedNow() {
  return new Date('2026-07-04T00:00:00.000Z');
}

async function tempDataDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-build-state-'));
}

function plan(overrides = {}) {
  return {
    id: 'p1',
    title: 'Plan 1',
    status: BUILD_STATE_QUEUED,
    units: [unit()],
    lease: lease('runner'),
    createdAt: '2026-07-04T00:00:00.000Z',
    updatedAt: '2026-07-04T00:00:00.000Z',
    ...overrides,
  };
}

function unit(overrides = {}) {
  return {
    id: 'u1',
    state: BUILD_STATE_QUEUED,
    scope: { declared: ['src/agent/build-state.mjs'] },
    goal: 'build state module',
    createdAt: '2026-07-04T00:00:00.000Z',
    updatedAt: '2026-07-04T00:00:00.000Z',
    ...overrides,
  };
}

function lane(overrides = {}) {
  return {
    id: 'lane-1',
    unitId: 'u1',
    pid: 100,
    startTime: 'start',
    logPath: 'logs/lane-1.log',
    worktreePath: '/tmp/lane-1',
    state: BUILD_STATE_BUILDING,
    createdAt: '2026-07-04T00:00:00.000Z',
    updatedAt: '2026-07-04T00:00:00.000Z',
    ...overrides,
  };
}

function lease(owner) {
  return {
    owner,
    acquiredAt: '2026-07-04T00:00:00.000Z',
    renewedAt: '2026-07-04T00:00:00.000Z',
    ttlMs: 60_000,
  };
}

function mutableClock() {
  let ms = Date.UTC(2026, 6, 4, 0, 0, 0, 0);
  let monotonicMs = 0;
  return {
    now: () => new Date(ms),
    monotonicNow: () => monotonicMs,
    advance(deltaMs) {
      ms += deltaMs;
      monotonicMs += deltaMs;
    },
  };
}

async function readJsonLines(file) {
  const text = await fs.readFile(file, 'utf8');
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}
