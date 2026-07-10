import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  BUILD_CARD_KIND_INFRA,
  BUILD_CARD_KIND_LINE_STOP,
  BUILD_CARD_KIND_SAFETY_FLOOR,
  BUILD_CARD_STATUS_APPLIED,
  BUILD_CARD_STATUS_RE_RAISED,
  createBuildCardStore,
} from './build-cards.mjs';
import {
  BUILD_STATE_BUILDING,
  BUILD_STATE_DEPLOYING,
  BUILD_STATE_HELD,
  BUILD_STATE_INTEGRATED,
  BUILD_STATE_INTEGRATING,
  BUILD_STATE_KILLED,
  BUILD_STATE_ORPHANED,
  BUILD_STATE_QUEUED,
  BUILD_STATE_VERIFYING,
  createBuildStateStore,
  readHistory,
} from './build-state.mjs';
import {
  LANE_CAP,
  createBuildRunner,
  promptForUnit,
} from './build-runner.mjs';

test('promptForUnit hardcodes adversarial verify posture with raw PRD lineage context', () => {
  const prompt = promptForUnit(
    unit({
      id: 'u-redteam',
      goal: 'Implement the adoption lane verifier.',
      prompt: 'Adoptions verify prompts must challenge the plan before shipping.',
      scope: ['src/agent/**'],
      prdLineage: 'Unit note: use PRD-007 as historical lineage, not authority.',
    }),
    plan({
      id: 'plan-prd-lineage',
      title: 'Adoptions v1',
      prdLineage: [
        'PRD-007: agentic UI lineage',
        { path: 'docs/imported/k0-ui/PRD.md', rule: 'schema-only' },
      ],
      draftSources: {
        founderInput: 'Runner lanes need adversarial verification before integration.',
        openFlags: [
          { kind: 'prd', detail: 'Raw source packet only for red-team review.' },
        ],
      },
    }),
  );

  assert.match(prompt, /hardcoded devil's-advocate/);
  assert.match(prompt, /red-team-gets-raw-context-only/);
  assert.match(prompt, /sunk-cost stripping/);
  assert.match(prompt, /PRD lineage/);
  assert.match(prompt, /Raw verification context:/);
  assert.match(prompt, /PRD-007: agentic UI lineage/);
  assert.match(prompt, /Runner lanes need adversarial verification before integration/);
  assert.match(prompt, /Adoptions verify prompts must challenge the plan before shipping/);
});

test('happy path: two units dispatch, gate, commit, and integrate in order', async () => {
  const harness = await createHarness();
  await harness.store.savePlan(plan({
    id: 'happy',
    units: [
      unit({ id: 'u1', goal: 'first unit', scope: ['pkg/**'] }),
      unit({ id: 'u2', goal: 'second unit', scope: ['pkg/**'] }),
    ],
  }));

  const summary = await harness.runner.tick();

  assert.equal(summary.ok, true);
  assert.deepEqual(harness.calls.dispatch.map((entry) => entry.unitId), ['u1', 'u2']);
  assert.deepEqual(harness.calls.commit.map((entry) => entry.message), [
    'feat(build): first unit',
    'feat(build): second unit',
  ]);

  const loaded = await harness.store.loadPlan('happy');
  assert.deepEqual(loaded.units.map((entry) => entry.state), [
    BUILD_STATE_INTEGRATED,
    BUILD_STATE_INTEGRATED,
  ]);
  assert.equal(loaded.completedAt !== null, true);

  const history = await readHistory({ dataDir: harness.dataDir, limit: 50 });
  assert.equal(history.filter((entry) => entry.kind === 'build.unit.committed').length, 2);
  assert.equal(history.some((entry) => entry.kind === 'build.plan.completed'), true);
});

test('runner dispatch passes adversarial verify prompt into the lane', async () => {
  const harness = await createHarness();
  await harness.store.savePlan(plan({
    id: 'dispatch-prompt',
    prdLineage: 'PRD lineage: adoption plan came from the V1 product packet.',
    units: [
      unit({ id: 'u1', goal: 'Wire adoption verification prompt.', scope: ['src/agent/**'] }),
    ],
  }));

  await harness.runner.tick();

  assert.equal(harness.calls.dispatch.length, 1);
  assert.match(harness.calls.dispatch[0].prompt, /hardcoded devil's-advocate/);
  assert.match(harness.calls.dispatch[0].prompt, /red-team-gets-raw-context-only/);
  assert.match(harness.calls.dispatch[0].prompt, /sunk-cost stripping/);
  assert.match(harness.calls.dispatch[0].prompt, /PRD lineage: adoption plan came from the V1 product packet/);
  assert.match(harness.calls.dispatch[0].prompt, /Wire adoption verification prompt/);
});

test('AT-1: expired foreign lease raises takeover card; adopt answer preserves lanes', async () => {
  const clock = mutableClock();
  const harness = await createHarness({ clock });
  await harness.store.savePlan(plan({
    id: 'takeover',
    lease: lease('session-1', { ttlMs: 1_000 }),
    units: [unit({ id: 'u1', state: BUILD_STATE_BUILDING })],
  }));
  await harness.store.saveLane(lane({
    id: 'takeover-u1',
    planId: 'takeover',
    unitId: 'u1',
    state: BUILD_STATE_BUILDING,
  }));

  clock.advance(2_000);
  await harness.runner.tick();

  let cards = await harness.cards.listCards();
  const takeover = cards.find((card) => card.action === 'takeover');
  assert.equal(takeover.kind, BUILD_CARD_KIND_INFRA);
  assert.equal(harness.calls.kill.length, 0);

  await harness.cards.answerCard({
    cardId: takeover.id,
    optionId: 'adopt',
    isSameMachine: true,
  });
  await harness.runner.tick();

  const adopted = await harness.store.loadPlan('takeover');
  assert.equal(adopted.lease.owner, 'runner');
  const adoptedLane = await harness.store.loadLane('takeover-u1');
  assert.equal(adoptedLane.state, BUILD_STATE_BUILDING);
  assert.equal(adoptedLane.owner, 'runner');
  assert.equal(harness.calls.kill.length, 0);
  cards = await harness.cards.listCards();
  assert.equal(cards.find((card) => card.id === takeover.id).status, BUILD_CARD_STATUS_APPLIED);
});

test('card-first recovery applies answered kill before crashed building state can relaunch', async () => {
  const harness = await createHarness();
  await harness.store.savePlan(plan({
    id: 'card-first',
    units: [unit({ id: 'u1', state: BUILD_STATE_BUILDING, laneId: 'lane-kill' })],
  }));
  await harness.store.saveLane(lane({
    id: 'lane-kill',
    planId: 'card-first',
    unitId: 'u1',
    state: BUILD_STATE_ORPHANED,
  }));
  const raised = await harness.cards.raiseCard({
    kind: BUILD_CARD_KIND_INFRA,
    planId: 'card-first',
    unitId: 'u1',
    laneId: 'lane-kill',
    title: 'Crashed lane decision',
    body: 'Kill before recovery.',
    options: decisionOptions(),
    recommendation: 'kill',
  });
  await harness.cards.answerCard({
    cardId: raised.card.id,
    optionId: 'kill',
    isSameMachine: true,
  });

  await harness.runner.tick();

  const loaded = await harness.store.loadPlan('card-first');
  assert.equal(loaded.units[0].state, BUILD_STATE_KILLED);
  assert.deepEqual(harness.calls.dispatch, []);
  assert.deepEqual(harness.calls.kill.map((entry) => entry.laneId), ['lane-kill']);
});

test('recovery matrix handles queued, building, verifying, integrating, and deploying states', async (t) => {
  await t.test('queued: no recovery action', async () => {
    const harness = await createHarness({ laneCap: 0 });
    await harness.store.savePlan(plan({
      id: 'queued-matrix',
      units: [unit({ id: 'u1', state: BUILD_STATE_QUEUED })],
    }));

    await harness.runner.tick();

    assert.deepEqual(harness.calls.dispatch, []);
    assert.deepEqual(harness.calls.suite, []);
  });

  await t.test('building: orphaned lane resets to redispatch when retry is allowed', async () => {
    const harness = await createHarness();
    await harness.store.savePlan(plan({
      id: 'building-matrix',
      units: [unit({ id: 'u1', state: BUILD_STATE_BUILDING, laneId: 'old-lane' })],
    }));
    await harness.store.saveLane(lane({
      id: 'old-lane',
      planId: 'building-matrix',
      unitId: 'u1',
      state: BUILD_STATE_ORPHANED,
    }));

    await harness.runner.tick();

    assert.deepEqual(harness.calls.dispatch.map((entry) => entry.unitId), ['u1']);
    const loaded = await harness.store.loadPlan('building-matrix');
    assert.equal(loaded.units[0].state, BUILD_STATE_INTEGRATED);
  });

  await t.test('verifying: gates are rerun', async () => {
    const harness = await createHarness();
    await harness.store.savePlan(plan({
      id: 'verifying-matrix',
      units: [unit({ id: 'u1', state: BUILD_STATE_VERIFYING, laneId: 'verify-lane' })],
    }));
    await harness.store.saveLane(lane({
      id: 'verify-lane',
      planId: 'verifying-matrix',
      unitId: 'u1',
      state: BUILD_STATE_BUILDING,
    }));

    await harness.runner.tick();

    assert.equal(harness.calls.suite.length, 1);
    const loaded = await harness.store.loadPlan('verifying-matrix');
    assert.equal(loaded.units[0].state, BUILD_STATE_INTEGRATED);
  });

  await t.test('integrating: repo recovers to checkpoint and unit is held with flag', async () => {
    const harness = await createHarness();
    await harness.store.savePlan(plan({
      id: 'integrating-matrix',
      units: [unit({
        id: 'u1',
        state: BUILD_STATE_INTEGRATING,
        checkpointSha: 'abc1234',
      })],
    }));

    await harness.runner.tick();

    assert.deepEqual(harness.calls.recoverIntegration, [{ checkpointSha: 'abc1234' }]);
    const loaded = await harness.store.loadPlan('integrating-matrix');
    assert.equal(loaded.units[0].state, BUILD_STATE_HELD);
    assert.equal(loaded.units[0].integrationRecovered, true);
  });

  await t.test('deploying: missing boot outcome holds and raises infra card', async () => {
    const harness = await createHarness({ readDeployOutcome: async () => null });
    await harness.store.savePlan(plan({
      id: 'deploying-matrix',
      units: [unit({ id: 'u1', state: BUILD_STATE_DEPLOYING })],
    }));

    await harness.runner.tick();

    const loaded = await harness.store.loadPlan('deploying-matrix');
    assert.equal(loaded.units[0].state, BUILD_STATE_HELD);
    const cards = await harness.cards.listCards();
    assert.equal(cards.some((card) => card.kind === BUILD_CARD_KIND_INFRA), true);
  });
});

test('red foundation holds, retry redispatches with debit, and exhausted retry is refused', async () => {
  let failNextSuite = true;
  const harness = await createHarness({
    suiteGate: async (input) => {
      harness.calls.suite.push(input);
      if (failNextSuite) {
        failNextSuite = false;
        return { ok: false, reason: 'failed', fail: 1, pass: 0, attempts: input.attempts };
      }
      return { ok: true, attempts: input.attempts };
    },
  });
  await harness.store.savePlan(plan({
    id: 'red-foundation',
    units: [unit({ id: 'u1', scope: ['pkg/**'] })],
  }));

  await harness.runner.tick();

  let loaded = await harness.store.loadPlan('red-foundation');
  assert.equal(loaded.units[0].state, BUILD_STATE_HELD);
  assert.equal(loaded.units[0].attempts, 1);
  let lineStop = (await harness.cards.listCards()).find((card) => card.kind === BUILD_CARD_KIND_LINE_STOP);
  assert.equal(lineStop.answerOption, null);

  await harness.cards.answerCard({
    cardId: lineStop.id,
    optionId: 'retry',
    isSameMachine: true,
  });
  await harness.runner.tick();

  loaded = await harness.store.loadPlan('red-foundation');
  assert.equal(loaded.units[0].state, BUILD_STATE_INTEGRATED);
  assert.equal(loaded.units[0].attempts, 2);
  assert.equal((await harness.cards.loadCard(lineStop.id)).status, BUILD_CARD_STATUS_APPLIED);

  await harness.store.savePlan(plan({
    id: 'retry-refused',
    units: [unit({ id: 'u1', state: BUILD_STATE_HELD, attempts: 2 })],
  }));
  const refused = await harness.cards.raiseCard({
    kind: BUILD_CARD_KIND_LINE_STOP,
    planId: 'retry-refused',
    unitId: 'u1',
    title: 'Retry exhausted',
    body: 'Try again?',
    options: decisionOptions(),
    recommendation: 'retry',
  });
  await harness.cards.answerCard({
    cardId: refused.card.id,
    optionId: 'retry',
    isSameMachine: true,
  });
  await harness.runner.tick();

  assert.equal((await harness.cards.loadCard(refused.card.id)).status, BUILD_CARD_STATUS_RE_RAISED);
  assert.equal((await harness.store.loadPlan('retry-refused')).units[0].state, BUILD_STATE_HELD);
});

test('AE3 alignment hold catches enforcement-surface diffs before integration', async () => {
  const harness = await createHarness({
    diffFile: () => 'src/agent/build-align.mjs',
  });
  await harness.store.savePlan(plan({
    id: 'align-hold',
    units: [unit({ id: 'u1', scope: ['src/agent/**'] })],
  }));

  await harness.runner.tick();

  const loaded = await harness.store.loadPlan('align-hold');
  assert.equal(loaded.units[0].state, BUILD_STATE_HELD);
  assert.deepEqual(harness.calls.integrate, []);
  const cards = await harness.cards.listCards();
  assert.equal(cards.some((card) => card.kind === BUILD_CARD_KIND_SAFETY_FLOOR), true);
});

test('regate catches green-plus-green red before commit', async () => {
  const harness = await createHarness({
    integrate: async (input) => {
      harness.calls.integrate.push(input);
      return { ok: true, regateRequired: true, sha: 'def5678' };
    },
    suiteGate: async (input) => {
      harness.calls.suite.push(input);
      return input.regate
        ? { ok: false, reason: 'failed', outputTail: 'combined fail', attempts: input.attempts }
        : { ok: true, attempts: input.attempts };
    },
  });
  await harness.store.savePlan(plan({
    id: 'regate',
    units: [unit({ id: 'u1', scope: ['pkg/**'] })],
  }));

  await harness.runner.tick();

  const loaded = await harness.store.loadPlan('regate');
  assert.equal(loaded.units[0].state, BUILD_STATE_HELD);
  assert.equal(harness.calls.suite.length, 2);
  assert.deepEqual(harness.calls.recoverIntegration, [{ checkpointSha: 'abc1002' }]);
  assert.deepEqual(harness.calls.commit, []);
});

test('independent units continue past held work; lane cap and non-owned watchdog authority are respected', async () => {
  const suiteByUnit = new Map([
    ['u1', { ok: false, reason: 'failed', fail: 1, pass: 0 }],
    ['u2', { ok: true }],
  ]);
  const harness = await createHarness({
    laneCap: 1,
    suiteGate: async (input) => {
      harness.calls.suite.push(input);
      return {
        attempts: input.attempts,
        ...(suiteByUnit.get(input.unit?.id) ?? { ok: true }),
      };
    },
  });
  await harness.store.savePlan(plan({
    id: 'independent',
    units: [
      unit({ id: 'u1', goal: 'held unit', scope: ['pkg/**'] }),
      unit({ id: 'u2', goal: 'continuing unit', scope: ['pkg/**'] }),
    ],
  }));

  await harness.runner.tick();
  assert.deepEqual(harness.calls.dispatch.map((entry) => entry.unitId), ['u1']);

  await harness.runner.tick();
  const loaded = await harness.store.loadPlan('independent');
  assert.equal(loaded.units.find((entry) => entry.id === 'u1').state, BUILD_STATE_HELD);
  assert.equal(loaded.units.find((entry) => entry.id === 'u2').state, BUILD_STATE_INTEGRATED);
  assert.equal(harness.calls.dispatch.length, 2);
  assert.equal(LANE_CAP, 3);

  const nonOwned = await createHarness({
    watchLane: () => 'kill-stall',
  });
  await nonOwned.store.savePlan(plan({
    id: 'foreign-stall',
    lease: lease('session-1', { ttlMs: 60_000 }),
    units: [unit({ id: 'u1', state: BUILD_STATE_BUILDING, laneId: 'foreign-lane' })],
  }));
  await nonOwned.store.saveLane(lane({
    id: 'foreign-lane',
    planId: 'foreign-stall',
    unitId: 'u1',
    state: BUILD_STATE_BUILDING,
  }));

  await nonOwned.runner.tick();

  assert.deepEqual(nonOwned.calls.kill, []);
  const cards = await nonOwned.cards.listCards();
  assert.equal(cards.some((card) => card.action === 'non-owned-stall'), true);
});

test('lane completion observation runs before orphan recovery while a plan is held', async () => {
  const clock = mutableClock();
  let recoverySawDone = false;
  const harness = await createHarness({
    clock,
    isPidAlive: () => false,
    readLogInfo: () => ({
      size: 32,
      mtimeMs: clock.now().getTime() - 91_000,
    }),
    readLogTail: () => 'implementation complete\nTokens used: 12,345\n',
    recoverOrphans: async ({ store }) => {
      const observed = (await store.listLanes()).find((candidate) => candidate.id === 'held-lane');
      recoverySawDone = observed?.done === true;
      return { ok: true, recovered: [] };
    },
  });
  await harness.store.savePlan(plan({
    id: 'held-plan',
    status: BUILD_STATE_HELD,
    lease: lease('other-runner', { ttlMs: 10 * 60 * 1000 }),
    units: [unit({ id: 'u1', state: BUILD_STATE_BUILDING, laneId: 'held-lane' })],
  }));
  await harness.store.saveLane(lane({
    id: 'held-lane',
    planId: 'held-plan',
    unitId: 'u1',
    state: BUILD_STATE_BUILDING,
    lastLogSize: 32,
    lastLogChangeAt: 0,
  }));
  clock.advance(91_000);

  const summary = await harness.runner.tick();

  const saved = await harness.store.loadLane('held-lane');
  assert.equal(saved.done, true);
  assert.equal(saved.settled, true);
  assert.equal(saved.completionReason, 'codex-sentinel-dead-pid');
  assert.equal(recoverySawDone, true);
  assert.deepEqual(summary.laneCompletions, [{
    laneId: 'held-lane',
    unitId: 'u1',
    reason: 'codex-sentinel-dead-pid',
  }]);
  assert.deepEqual(harness.calls.suite, []);
});

test('same-tick lane completions integrate their own pinned harvest diffs', async () => {
  let harness;
  harness = await createHarness({
    detectLaneCompletion: ({ lane }) => ({
      done: true,
      settled: true,
      finishedAt: '2026-07-04T00:00:01.000Z',
      completionDetectedAt: '2026-07-04T00:00:01.000Z',
      completionReason: 'test-complete',
      worktreePath: path.join(harness.repoRoot, 'shared-latest-completed'),
    }),
  });
  await harness.store.savePlan(plan({
    id: 'same-tick',
    units: [
      unit({
        id: 'u1',
        state: BUILD_STATE_BUILDING,
        laneId: 'same-tick-u1',
        scope: ['pkg/u1.txt'],
      }),
      unit({
        id: 'u2',
        state: BUILD_STATE_BUILDING,
        laneId: 'same-tick-u2',
        scope: ['pkg/u2.txt'],
      }),
    ],
  }));
  await harness.store.saveLane(lane({
    id: 'same-tick-u1',
    planId: 'same-tick',
    unitId: 'u1',
    state: BUILD_STATE_BUILDING,
    worktreePath: path.join(harness.repoRoot, 'lane-u1'),
    done: false,
  }));
  await harness.store.saveLane(lane({
    id: 'same-tick-u2',
    planId: 'same-tick',
    unitId: 'u2',
    state: BUILD_STATE_BUILDING,
    worktreePath: path.join(harness.repoRoot, 'lane-u2'),
    done: false,
  }));

  await harness.runner.tick();

  assert.deepEqual(harness.calls.integrate.map((entry) => path.basename(entry.laneWorktree)), [
    'lane-u1',
    'lane-u2',
  ]);
  assert.deepEqual(harness.calls.commit.map((entry) => entry.unitId), ['u1', 'u2']);
  const lane1 = await harness.store.loadLane('same-tick-u1');
  const lane2 = await harness.store.loadLane('same-tick-u2');
  assert.equal(path.basename(lane1.harvestSource.worktreePath), 'lane-u1');
  assert.equal(path.basename(lane2.harvestSource.worktreePath), 'lane-u2');
  assert.match(lane1.harvestSource.diffDigest, /^sha256:/);
  assert.match(lane2.harvestSource.diffDigest, /^sha256:/);
});

test('empty harvested scope intersection holds with an infra card instead of integrated', async () => {
  const harness = await createHarness({
    diffFile: () => null,
  });
  await harness.store.savePlan(plan({
    id: 'empty-harvest',
    units: [unit({
      id: 'u1',
      scope: ['pkg/u1.txt'],
    })],
  }));

  await harness.runner.tick();

  const loaded = await harness.store.loadPlan('empty-harvest');
  assert.equal(loaded.units[0].state, BUILD_STATE_HELD);
  assert.deepEqual(harness.calls.integrate, []);
  assert.deepEqual(harness.calls.commit, []);
  const cards = await harness.cards.listCards();
  const mismatch = cards.find((card) => card.payload?.rawBody?.reason === 'empty_scope_intersection');
  assert.equal(mismatch.kind, BUILD_CARD_KIND_INFRA);
  assert.equal(
    mismatch.body,
    'build is held for empty scope intersection — retry the lane. local time cost.',
  );
});

test('done building lanes do not consume dispatch cap', async () => {
  const harness = await createHarness({ laneCap: 1 });
  await harness.store.savePlan(plan({
    id: 'cap-freed',
    units: [
      unit({ id: 'u1', state: BUILD_STATE_BUILDING, laneId: 'done-lane' }),
      unit({ id: 'u2', state: BUILD_STATE_QUEUED }),
    ],
  }));
  await harness.store.saveLane(lane({
    id: 'done-lane',
    planId: 'cap-freed',
    unitId: 'u1',
    state: BUILD_STATE_BUILDING,
    done: true,
    finishedAt: '2026-07-04T00:00:01.000Z',
  }));

  await harness.runner.tick();

  assert.deepEqual(harness.calls.dispatch.map((entry) => entry.unitId), ['u2']);
});

test('nonzero completed lane exits retry without running verification gates', async () => {
  const harness = await createHarness({ laneCap: 1 });
  await harness.store.savePlan(plan({
    id: 'exit-failed',
    units: [
      unit({ id: 'u1', state: BUILD_STATE_BUILDING, laneId: 'exit-failed-u1', attempts: 1 }),
    ],
  }));
  await harness.store.saveLane(lane({
    id: 'exit-failed-u1',
    planId: 'exit-failed',
    unitId: 'u1',
    state: BUILD_STATE_BUILDING,
    done: true,
    exitCode: 1,
    finishedAt: '2026-07-04T00:00:01.000Z',
  }));

  await harness.runner.tick();

  assert.deepEqual(harness.calls.suite, []);
  assert.deepEqual(harness.calls.dispatch.map((entry) => entry.unitId), ['u1']);
});

async function createHarness(options = {}) {
  const clock = options.clock ?? mutableClock();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-build-runner-data-'));
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-build-runner-repo-'));
  const store = createBuildStateStore({
    dataDir,
    now: clock.now,
    monotonicNow: clock.monotonicNow,
  });
  const cards = createBuildCardStore({
    dataDir,
    now: clock.now,
    stateStore: store,
    randomSuffix: suffixer(),
  });
  const calls = {
    commit: [],
    diff: [],
    dispatch: [],
    integrate: [],
    kill: [],
    recoverIntegration: [],
    suite: [],
  };
  let checkpointIndex = 0;
  const laneDeps = {
    dispatchLane: async (input) => {
      calls.dispatch.push({
        planId: input.planId,
        unitId: input.unitId,
        baseSha: input.baseSha,
        prompt: input.prompt,
      });
      const laneId = `${input.planId}-${input.unitId}`;
      const saved = await input.store.saveLane(lane({
        id: laneId,
        planId: input.planId,
        unitId: input.unitId,
        state: BUILD_STATE_BUILDING,
        worktreePath: path.join(repoRoot, `lane-${input.unitId}`),
        baseSha: input.baseSha,
        done: options.laneDone?.(input) ?? true,
      }));
      return { ok: true, lane: saved };
    },
    watchLane: options.watchLane ?? (() => 'continue'),
    killLane: ({ lane: killedLane }) => {
      calls.kill.push({ laneId: killedLane.id });
      return { ok: true, killed: true };
    },
    recoverOrphans: options.recoverOrphans ?? (async () => ({ ok: true, recovered: [] })),
    classifyFailure: options.classifyFailure ?? (() => 'lane'),
  };
  for (const key of ['isPidAlive', 'readLogInfo', 'readLogSize', 'readLogTail', 'detectLaneCompletion']) {
    if (options[key] !== undefined) laneDeps[key] = options[key];
  }

  const runner = createBuildRunner({
    store,
    cards,
    dataDir,
    repoRoot,
    laneCap: options.laneCap,
    deps: {
      now: clock.now,
      monotonicNow: clock.monotonicNow,
      logger: silentLogger(),
      readDeployOutcome: options.readDeployOutcome,
      lanes: laneDeps,
      gates: {
        suiteGate: options.suiteGate ?? (async (input) => {
          calls.suite.push(input);
          return { ok: true, attempts: input.attempts };
        }),
        hygieneGate: options.hygieneGate ?? (async () => ({ ok: true, violations: [] })),
      },
      git: {
        checkpoint: async () => {
          checkpointIndex += 1;
          return { ok: true, sha: `abc100${checkpointIndex}` };
        },
        diffAgainstBase: async (input) => {
          calls.diff.push(input);
          const unitId = path.basename(input.repoRoot).replace(/^lane-/, '');
          const file = typeof options.diffFile === 'function'
            ? options.diffFile(unitId, input)
            : `pkg/${unitId}.txt`;
          if (file === undefined) return { ok: true, diff: diffForFile(`pkg/${unitId}.txt`), files: [`pkg/${unitId}.txt`] };
          if (file === null) return { ok: true, diff: '', files: [] };
          return { ok: true, diff: diffForFile(file), files: [file] };
        },
        revParseHead: async (input) => ({ ok: true, sha: `head-${path.basename(input.repoRoot)}` }),
        integrate: options.integrate ?? (async (input) => {
          calls.integrate.push(input);
          return { ok: true, regateRequired: false, sha: 'def5678' };
        }),
        recoverIntegration: async (input) => {
          calls.recoverIntegration.push({ checkpointSha: input.checkpointSha });
          return { ok: true, checkpointSha: input.checkpointSha };
        },
        commit: async (input) => {
          calls.commit.push({ message: input.message, unitId: input.unit.id });
          return { ok: true, sha: `fed${calls.commit.length}678` };
        },
      },
    },
  });

  return {
    cards,
    calls,
    clock,
    dataDir,
    repoRoot,
    runner,
    store,
  };
}

function plan(overrides = {}) {
  return {
    id: 'plan-1',
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
    scope: ['pkg/**'],
    goal: 'build unit',
    createdAt: '2026-07-04T00:00:00.000Z',
    updatedAt: '2026-07-04T00:00:00.000Z',
    ...overrides,
  };
}

function lane(overrides = {}) {
  return {
    id: 'lane-1',
    planId: 'plan-1',
    unitId: 'u1',
    pid: 100,
    startTime: 'start',
    logPath: 'logs/lane-1.log',
    worktreePath: '/tmp/lane-1',
    baseSha: 'abc1000',
    state: BUILD_STATE_BUILDING,
    createdAt: '2026-07-04T00:00:00.000Z',
    updatedAt: '2026-07-04T00:00:00.000Z',
    ...overrides,
  };
}

function lease(owner, overrides = {}) {
  return {
    owner,
    acquiredAt: '2026-07-04T00:00:00.000Z',
    renewedAt: '2026-07-04T00:00:00.000Z',
    ttlMs: 60_000,
    ...overrides,
  };
}

function decisionOptions() {
  return [
    { id: 'continue', label: 'Continue', consequence: 'Resume.' },
    { id: 'retry', label: 'Retry', consequence: 'Retry.' },
    { id: 'quarantine', label: 'Quarantine', consequence: 'Quarantine.' },
    { id: 'kill', label: 'Kill', consequence: 'Kill.' },
  ];
}

function diffForFile(file) {
  return [
    `diff --git a/${file} b/${file}`,
    '--- /dev/null',
    `+++ b/${file}`,
    '@@ -0,0 +1 @@',
    '+content',
    '',
  ].join('\n');
}

function suffixer() {
  let index = 0;
  return () => {
    index += 1;
    return `r${index}`;
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

function silentLogger() {
  return {
    error() {},
  };
}

test('a unit parked in orphaned state (crash between orphan-mark and redispatch) is re-dispatched on the next tick', async () => {
  const harness = await createHarness();
  await harness.store.savePlan(plan({
    id: 'p-orph',
    units: [unit({ id: 'u1', goal: 'orphan-parked unit', scope: ['pkg/**'], state: BUILD_STATE_ORPHANED })],
  }));

  await harness.runner.tick();

  assert.equal(harness.calls.dispatch.some((entry) => entry.unitId === 'u1'), true);
});

test('resume answer on a terminal unit applies the card without regressing state', async () => {
  const harness = await createHarness();
  await harness.store.savePlan(plan({
    id: 'terminal-resume',
    units: [unit({ id: 'u1', state: BUILD_STATE_INTEGRATED })],
  }));
  const raised = await harness.cards.raiseCard({
    kind: BUILD_CARD_KIND_INFRA,
    planId: 'terminal-resume',
    unitId: 'u1',
    title: 'Retry limit reached',
    body: 'stale card from before integration',
    options: [
      { id: 'continue', label: 'Continue', consequence: 'resume' },
      { id: 'kill', label: 'Kill', consequence: 'stop' },
    ],
    recommendation: 'continue',
  });
  await harness.cards.answerCard({
    cardId: raised.card.id,
    optionId: 'continue',
    isSameMachine: true,
  });

  await harness.runner.tick();

  const loaded = await harness.store.loadPlan('terminal-resume');
  assert.equal(loaded.units[0].state, BUILD_STATE_INTEGRATED);
  const cards = await harness.cards.listCards();
  assert.equal(cards.find((card) => card.id === raised.card.id).status, BUILD_CARD_STATUS_APPLIED);
  assert.equal(harness.calls.dispatch.length, 0);
});
