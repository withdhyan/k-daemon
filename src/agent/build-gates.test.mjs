import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  BUILD_CARD_KIND_LINE_STOP,
  createBuildCardStore,
} from './build-cards.mjs';
import {
  BUILD_STATE_HELD,
  BUILD_STATE_QUEUED,
  BUILD_STATE_VERIFYING,
  createBuildStateStore,
} from './build-state.mjs';
import {
  SHARED_HELPER_NAMES,
  hygieneGate,
  redFoundation,
  retryAllowed,
  suiteGate,
} from './build-gates.mjs';

test('suiteGate runs a green tmpdir suite and parses pass counts', async () => {
  const worktreePath = await fixtureWorktree(`
import assert from 'node:assert/strict';
import test from 'node:test';

test('green fixture', () => {
  assert.equal(2 + 2, 4);
});
`);

  const result = await suiteGate({ worktreePath, timeoutMs: 5_000 });

  assert.equal(result.ok, true);
  assert.equal(result.reason, null);
  assert.equal(result.pass, 1);
  assert.equal(result.fail, 0);
  assert.equal(result.attempts, 1);
  assert.match(result.output, /^# pass 1$/m);
});

test('suiteGate reports a red suite with the failing output tail', async () => {
  const worktreePath = await fixtureWorktree(`
import assert from 'node:assert/strict';
import test from 'node:test';

test('red fixture', () => {
  assert.equal('actual-red-value', 'expected-green-value');
});
`);

  const result = await suiteGate({ worktreePath, timeoutMs: 5_000, attempts: 2 });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'failed');
  assert.equal(result.pass, 0);
  assert.equal(result.fail, 1);
  assert.equal(result.attempts, 2);
  assert.match(result.output, /actual-red-value/);
  assert.match(result.output, /^# fail 1$/m);
});

test('suiteGate classifies a hung suite as timeout and preserves output tail', async () => {
  const worktreePath = await fixtureWorktree(`
import test from 'node:test';

test('hung fixture', async () => {
  process.stdout.write('# hung fixture marker\\\\n');
  await new Promise((resolve) => setTimeout(resolve, 10_000));
});
`);

  const result = await suiteGate({ worktreePath, timeoutMs: 500 });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'timeout');
  assert.equal(result.timedOut, true);
  assert.match(result.output, /hung fixture marker/);
});

test('hygieneGate catches a planted shared-helper re-copy declaration', async () => {
  const result = await hygieneGate({
    diffFiles: diffFor('src/agent/copied-helper.mjs', [
      'const atomicWriteJson = async () => {};',
      'export function localThing() {}',
    ]),
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.violations.map((violation) => ({
    file: violation.file,
    line: violation.line,
    rule: violation.rule,
  })), [
    {
      file: 'src/agent/copied-helper.mjs',
      line: 1,
      rule: 'shared-helper-recopy',
    },
  ]);
  assert(SHARED_HELPER_NAMES.includes('atomicWriteJson'));
});

test('hygieneGate accepts a clean diff that imports canonical helpers', async () => {
  const result = await hygieneGate({
    diffFiles: diffFor('src/agent/clean.mjs', [
      "import { atomicWriteJson } from './routines.mjs';",
      'const localThing = true;',
      'export { localThing };',
    ]),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.violations, []);
});

test('hygieneGate catches local VIEW_TYPES shadows outside view-packet.mjs', async () => {
  const result = await hygieneGate({
    diffFiles: diffFor('src/agent/shadow-view.mjs', [
      "const VIEW_TYPES = Object.freeze(['build.status']);",
      'export function render() {}',
    ]),
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.violations.map((violation) => ({
    file: violation.file,
    line: violation.line,
    rule: violation.rule,
  })), [
    {
      file: 'src/agent/shadow-view.mjs',
      line: 1,
      rule: 'contract-import-shadow',
    },
  ]);
});

test('redFoundation holds the unit, raises a line-stop card, and retryAllowed enforces the bound', async () => {
  const dataDir = await tempDataDir();
  const store = createBuildStateStore({ dataDir, now: fixedNow });
  const cards = createBuildCardStore({
    dataDir,
    now: fixedNow,
    stateStore: store,
    randomSuffix: () => 'red1',
  });
  await store.savePlan(plan({
    id: 'plan-red',
    units: [unit({ state: BUILD_STATE_VERIFYING })],
  }));

  const card = await redFoundation({
    store,
    cards,
    planId: 'plan-red',
    unitId: 'u1',
    actor: 'runner',
    gateResult: {
      ok: false,
      reason: 'failed',
      pass: 4,
      fail: 1,
      attempts: 1,
      output: 'not ok 5 - red fixture',
    },
  });

  const heldPlan = await store.loadPlan('plan-red');
  assert.equal(heldPlan.units[0].state, BUILD_STATE_HELD);
  assert.equal(card.kind, BUILD_CARD_KIND_LINE_STOP);
  assert.deepEqual(card.options.map((option) => option.id), ['retry', 'quarantine', 'kill']);
  assert.equal(card.recommendation, 'retry');
  assert.equal((await cards.listOpenCards()).length, 1);
  assert.equal(retryAllowed({ gateAttempts: 1 }), true);
  assert.equal(retryAllowed({ gateAttempts: 2 }), false);
});

async function fixtureWorktree(testFileText) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-build-gates-suite-'));
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.writeFile(path.join(dir, 'src', 'fixture.test.mjs'), testFileText.trimStart(), 'utf8');
  return dir;
}

async function tempDataDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-build-gates-state-'));
}

function diffFor(file, addedLines) {
  return [
    `diff --git a/${file} b/${file}`,
    'new file mode 100644',
    'index 0000000..1111111',
    '--- /dev/null',
    `+++ b/${file}`,
    `@@ -0,0 +1,${addedLines.length} @@`,
    ...addedLines.map((line) => `+${line}`),
    '',
  ].join('\n');
}

function fixedNow() {
  return new Date('2026-07-04T00:00:00.000Z');
}

function plan(overrides = {}) {
  return {
    id: 'p1',
    title: 'Plan 1',
    status: BUILD_STATE_QUEUED,
    units: [unit()],
    lease: {
      owner: 'runner',
      acquiredAt: '2026-07-04T00:00:00.000Z',
      renewedAt: '2026-07-04T00:00:00.000Z',
      ttlMs: 60_000,
    },
    createdAt: '2026-07-04T00:00:00.000Z',
    updatedAt: '2026-07-04T00:00:00.000Z',
    ...overrides,
  };
}

function unit(overrides = {}) {
  return {
    id: 'u1',
    state: BUILD_STATE_QUEUED,
    scope: { declared: ['src/agent/build-gates.mjs'] },
    goal: 'verification gates module',
    createdAt: '2026-07-04T00:00:00.000Z',
    updatedAt: '2026-07-04T00:00:00.000Z',
    ...overrides,
  };
}
