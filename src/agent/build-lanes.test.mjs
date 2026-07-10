import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  BUILD_STATE_BUILDING,
  BUILD_STATE_ORPHANED,
  createBuildStateStore,
} from './build-state.mjs';
import {
  CEILING_MS,
  CODEX_COMPLETION_SENTINEL_QUIESCENT_MS,
  DISK_PREFLIGHT_MIN_BYTES,
  STALL_MS,
  applyFailureBudget,
  classifyFailure,
  detectLaneCompletion,
  dispatchLane,
  logEndsWithCodexCompletionSentinel,
  recoverOrphans,
  watchLane,
} from './build-lanes.mjs';

test('AT-4: orphan recovery kills only matching pid/startTime and resets worktrees', async () => {
  const dataDir = await tempDataDir();
  const store = createBuildStateStore({ dataDir, now: fixedNow });
  await store.saveLane(lane({
    id: 'matching',
    pid: 12345,
    startTime: 'Sat Jul  4 00:00:00 2026',
  }));
  await store.saveLane(lane({
    id: 'recycled',
    pid: 12345,
    startTime: 'Sat Jul  4 00:01:00 2026',
  }));

  const killed = [];
  const reset = [];
  const result = await recoverOrphans({
    store,
    isPidAlive: (pid, startTime) => pid === 12345 && startTime === 'Sat Jul  4 00:00:00 2026',
    killImpl: (pid, signal) => killed.push({ pid, signal }),
    resetWorktree: async ({ lane: recoveredLane }) => {
      reset.push(recoveredLane.id);
      return { ok: true, laneId: recoveredLane.id };
    },
    now: fixedNow(),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(killed, [{ pid: 12345, signal: 'SIGKILL' }]);
  assert.deepEqual(reset.sort(), ['matching', 'recycled']);
  assert.deepEqual(result.recovered.map((entry) => entry.lane.id).sort(), ['matching', 'recycled']);

  const matching = await store.loadLane('matching');
  const recycled = await store.loadLane('recycled');
  assert.equal(matching.state, BUILD_STATE_ORPHANED);
  assert.equal(matching.recovery.killed, true);
  assert.equal(recycled.state, BUILD_STATE_ORPHANED);
  assert.equal(recycled.recovery.killed, false);
  assert.equal(recycled.recovery.pidMatchesStart, false);
});

test('AT-6: failure classification separates infra from lane failures and budget debit', async () => {
  const stub = await codexStub("console.error('error: not logged in'); process.exit(1);");
  const run = await runNode(stub);

  assert.equal(run.code, 1);
  assert.equal(classifyFailure({ exitCode: run.code, logTail: run.stderr }), 'infra');
  assert.equal(classifyFailure({ exitCode: 1, logTail: '', stalledAtZeroOutput: true }), 'infra');
  assert.equal(classifyFailure({ exitCode: { code: 'ENOENT' }, logTail: '' }), 'infra');
  assert.equal(
    classifyFailure({ exitCode: 1, logTail: 'AssertionError: expected passing tests' }),
    'lane',
  );

  const baseLane = { id: 'budget', attempts: 2, debited: false };
  assert.deepEqual(applyFailureBudget(baseLane, 'infra'), {
    id: 'budget',
    attempts: 2,
    debited: false,
    failureClassification: 'infra',
  });
  assert.deepEqual(applyFailureBudget(baseLane, 'lane'), {
    id: 'budget',
    attempts: 3,
    debited: true,
    failureClassification: 'lane',
  });
});

test('AT-8: disk preflight refuses dispatch below threshold without creating a lane', async () => {
  const dataDir = await tempDataDir();
  const store = createBuildStateStore({ dataDir, now: fixedNow });
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-build-lanes-repo-'));

  const result = await dispatchLane({
    store,
    planId: 'p1',
    unitId: 'u1',
    prompt: 'do work',
    baseSha: 'abc1234',
    repoRoot,
    codexPath: '/usr/bin/true',
    homeDir: await fixtureHome(),
    statfsImpl: async () => ({ bavail: 1, bsize: 1024 }),
    laneWorktreeAddImpl: async () => {
      throw new Error('worktree should not be created');
    },
    spawnImpl: () => {
      throw new Error('codex should not be spawned');
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'disk');
  assert.equal(result.card, 'bound');
  assert.equal(result.minBytes, DISK_PREFLIGHT_MIN_BYTES);
  assert.deepEqual(await store.listLanes(), []);
});

test('dispatch spawn shape uses minimal HOME, allowlisted env, and ignored stdin', async () => {
  const dataDir = await tempDataDir();
  const store = createBuildStateStore({ dataDir, now: fixedNow });
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-build-lanes-tmp-'));
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-build-lanes-repo-'));
  const worktreePath = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-build-lanes-worktree-'));
  const homeDir = await fixtureHome();
  const codexPath = await codexStub("process.exit(0);");
  let spawnCall;
  await store.saveLane(lane({
    id: 'plan1-unit1',
    planId: 'plan1',
    unitId: 'unit1',
    done: true,
    settled: true,
    exitCode: 0,
    finishedAt: '2026-07-04T00:00:01.000Z',
  }));

  const result = await dispatchLane({
    store,
    planId: 'plan1',
    unitId: 'unit1',
    prompt: 'implement U8',
    baseSha: 'abc1234',
    repoRoot,
    codexPath,
    homeDir,
    env: {
      TMPDIR: tmpDir,
      SECRET_TOKEN: 'must-not-leak',
      SSH_AUTH_SOCK: 'must-not-leak',
    },
    statfsImpl: async () => ({ bavail: DISK_PREFLIGHT_MIN_BYTES, bsize: 1 }),
    laneWorktreeAddImpl: async ({ laneId }) => ({ ok: true, laneId, path: worktreePath }),
    spawnImpl: (command, args, options) => {
      spawnCall = { command, args, options };
      const child = new EventEmitter();
      child.pid = 4242;
      return child;
    },
    startTimeImpl: async () => 'Sat Jul  4 00:00:00 2026',
    now: fixedNow(),
  });

  assert.equal(result.ok, true);
  assert.equal(spawnCall.command, codexPath);
  assert.deepEqual(spawnCall.args, [
    'exec',
    '-s',
    'workspace-write',
    '-C',
    worktreePath,
    'implement U8',
  ]);
  assert.equal(spawnCall.options.detached, false);
  assert.equal(spawnCall.options.stdio[0], 'ignore');
  assert.equal(typeof spawnCall.options.stdio[1], 'number');
  assert.equal(spawnCall.options.stdio[1], spawnCall.options.stdio[2]);
  assert.deepEqual(Object.keys(spawnCall.options.env).sort(), ['HOME', 'PATH', 'TMPDIR']);
  assert.equal(spawnCall.options.env.TMPDIR, tmpDir);
  assert.equal(spawnCall.options.env.HOME, result.homePath);
  const pathEntries = spawnCall.options.env.PATH.split(path.delimiter);
  assert.equal(pathEntries.includes(path.dirname(process.execPath)), true);
  assert.equal(pathEntries.includes(path.dirname(codexPath)), true);
  assert.equal(pathEntries.at(-1), path.dirname(codexPath));
  assert.equal(spawnCall.options.env.SECRET_TOKEN, undefined);
  assert.equal(spawnCall.options.env.SSH_AUTH_SOCK, undefined);

  const entries = await fs.readdir(result.homePath);
  assert.deepEqual(entries, ['.codex']);
  const codexLink = await fs.lstat(path.join(result.homePath, '.codex'));
  assert.equal(codexLink.isSymbolicLink(), true);
  assert.equal(
    path.resolve(result.homePath, await fs.readlink(path.join(result.homePath, '.codex'))),
    path.join(homeDir, '.codex'),
  );

  const saved = await store.loadLane(result.laneId);
  assert.equal(saved.pid, 4242);
  assert.equal(saved.startTime, 'Sat Jul  4 00:00:00 2026');
  assert.equal(saved.logPath, result.logPath);
  assert.equal(saved.worktreePath, worktreePath);
  assert.equal(saved.attempts, 0);
  assert.equal(saved.debited, false);
  assert.equal(saved.done, false);
  assert.equal(saved.settled, false);
  assert.equal(saved.exitCode, undefined);
  assert.equal(saved.finishedAt, undefined);
});

test('dispatch records observed child exit as lane completion', async () => {
  const dataDir = await tempDataDir();
  const store = createBuildStateStore({ dataDir, now: fixedNow });
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-build-lanes-repo-'));
  const worktreePath = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-build-lanes-worktree-'));
  const child = new EventEmitter();
  child.pid = 5151;

  const result = await dispatchLane({
    store,
    planId: 'plan-exit',
    unitId: 'unit-exit',
    prompt: 'finish and exit',
    baseSha: 'abc1234',
    repoRoot,
    codexPath: await codexStub("process.exit(0);"),
    homeDir: await fixtureHome(),
    statfsImpl: async () => ({ bavail: DISK_PREFLIGHT_MIN_BYTES, bsize: 1 }),
    laneWorktreeAddImpl: async ({ laneId }) => ({ ok: true, laneId, path: worktreePath }),
    spawnImpl: () => child,
    startTimeImpl: async () => 'Sat Jul  4 00:00:00 2026',
    now: fixedNow(),
  });

  assert.equal(result.ok, true);
  child.emit('close', 0, null);

  const saved = await waitForLane(store, result.laneId, (candidate) => candidate.done === true);
  assert.equal(saved.done, true);
  assert.equal(saved.settled, true);
  assert.equal(saved.exitCode, 0);
  assert.equal(saved.exitSignal, null);
  assert.equal(saved.completionReason, 'process-exit');
});

test('redispatch resets lane monotonic clocks so stale ceiling age cannot kill after 76 seconds', async () => {
  const dataDir = await tempDataDir();
  const store = createBuildStateStore({ dataDir, now: fixedNow });
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-build-lanes-repo-'));
  const worktreePath = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-build-lanes-worktree-'));
  const homeDir = await fixtureHome();
  const laneId = 'plan1-unit1';
  const redispatchAt = CEILING_MS + 1;
  const watchAfter76Seconds = redispatchAt + 76_000;

  await store.saveLane(lane({
    id: laneId,
    planId: 'plan1',
    unitId: 'unit1',
    startMonotonicAt: 0,
    lastWatchMonotonic: redispatchAt,
    lastLogSize: 99,
    lastLogChangeAt: redispatchAt,
  }));

  assert.equal(
    watchLane({
      lane: await store.loadLane(laneId),
      monotonicNow: watchAfter76Seconds,
      readLogSize: 99,
    }),
    'kill-ceiling',
  );

  const result = await dispatchLane({
    store,
    planId: 'plan1',
    unitId: 'unit1',
    prompt: 'retry work',
    baseSha: 'abc1234',
    repoRoot,
    codexPath: '/usr/bin/true',
    homeDir,
    statfsImpl: async () => ({ bavail: DISK_PREFLIGHT_MIN_BYTES, bsize: 1 }),
    laneWorktreeAddImpl: async ({ laneId: dispatchedLaneId }) => ({
      ok: true,
      laneId: dispatchedLaneId,
      path: worktreePath,
    }),
    spawnImpl: () => {
      const child = new EventEmitter();
      child.pid = 5151;
      return child;
    },
    startTimeImpl: async () => 'Sat Jul  4 00:01:16 2026',
    now: fixedNow(),
    monotonicNow: redispatchAt,
  });

  assert.equal(result.ok, true);
  const saved = await store.loadLane(laneId);
  assert.equal(saved.startMonotonicAt, redispatchAt);
  assert.equal(saved.lastWatchMonotonic, redispatchAt);
  assert.equal(saved.lastLogChangeAt, redispatchAt);
  assert.equal(
    watchLane({
      lane: saved,
      monotonicNow: watchAfter76Seconds,
      readLogSize: 99,
    }),
    'continue',
  );
});

test('watchLane distinguishes stall, ceiling, and monotonic jump reset', () => {
  assert.equal(
    watchLane({
      lane: {
        startMonotonicAt: 0,
        lastWatchMonotonic: STALL_MS - 10_000,
        lastLogSize: 12,
        lastLogChangeAt: 0,
      },
      monotonicNow: STALL_MS,
      readLogSize: 12,
    }),
    'kill-stall',
  );

  assert.equal(
    watchLane({
      lane: {
        startMonotonicAt: 0,
        lastWatchMonotonic: CEILING_MS - 1_000,
        lastLogSize: 12,
        lastLogChangeAt: CEILING_MS - 1_000,
      },
      monotonicNow: CEILING_MS + 1,
      readLogSize: 13,
    }),
    'kill-ceiling',
  );

  assert.equal(
    watchLane({
      lane: {
        startMonotonicAt: 0,
        lastWatchMonotonic: 0,
        lastLogSize: 0,
        lastLogChangeAt: 0,
      },
      monotonicNow: STALL_MS + 1,
      readLogSize: 0,
      tickIntervalMs: 60_000,
    }),
    'reset-baseline',
  );
});

test('detectLaneCompletion requires terminal tokens-used sentinel, dead pid, and log quiescence', () => {
  const baseLane = lane({
    pid: 4242,
    startTime: 'Sat Jul  4 00:00:00 2026',
    lastLogSize: 24,
    lastLogChangeAt: 0,
  });
  const now = new Date('2026-07-04T00:02:00.000Z');

  assert.equal(logEndsWithCodexCompletionSentinel('work finished\nTokens used: 1,234\n'), true);
  assert.equal(logEndsWithCodexCompletionSentinel('Tokens used: 1,234\nstill writing\n'), false);

  const completion = detectLaneCompletion({
    lane: baseLane,
    now,
    monotonicNow: CODEX_COMPLETION_SENTINEL_QUIESCENT_MS + 1,
    isPidAlive: () => false,
    readLogSize: 24,
    readLogTail: 'work finished\nTokens used: 1,234\n',
  });

  assert.equal(completion.done, true);
  assert.equal(completion.settled, true);
  assert.equal(completion.completionReason, 'codex-sentinel-dead-pid');
  assert.equal(completion.finishedAt, '2026-07-04T00:02:00.000Z');
  assert.equal(
    detectLaneCompletion({
      lane: baseLane,
      now,
      monotonicNow: CODEX_COMPLETION_SENTINEL_QUIESCENT_MS + 1,
      isPidAlive: () => true,
      readLogSize: 24,
      readLogTail: 'work finished\nTokens used: 1,234\n',
    }),
    null,
  );
  assert.equal(
    detectLaneCompletion({
      lane: baseLane,
      now,
      monotonicNow: CODEX_COMPLETION_SENTINEL_QUIESCENT_MS - 1,
      isPidAlive: () => false,
      readLogSize: 24,
      readLogTail: 'work finished\nTokens used: 1,234\n',
    }),
    null,
  );
  assert.equal(
    detectLaneCompletion({
      lane: baseLane,
      now,
      monotonicNow: CODEX_COMPLETION_SENTINEL_QUIESCENT_MS + 1,
      isPidAlive: () => false,
      readLogSize: 25,
      readLogTail: 'work finished\nnot the sentinel\n',
    }),
    null,
  );
});

function fixedNow() {
  return new Date('2026-07-04T00:00:00.000Z');
}

async function tempDataDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-build-lanes-data-'));
}

function lane(overrides = {}) {
  return {
    id: 'lane-1',
    planId: 'p1',
    unitId: 'u1',
    pid: 100,
    startTime: 'start',
    logPath: 'logs/lane-1.log',
    worktreePath: '/tmp/lane-1',
    state: BUILD_STATE_BUILDING,
    baseSha: 'abc1234',
    repoRoot: '/tmp/repo',
    attempts: 0,
    debited: false,
    createdAt: '2026-07-04T00:00:00.000Z',
    updatedAt: '2026-07-04T00:00:00.000Z',
    ...overrides,
  };
}

async function fixtureHome() {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-build-lanes-home-'));
  await fs.mkdir(path.join(homeDir, '.codex'), { recursive: true });
  await fs.writeFile(path.join(homeDir, '.codex', 'config.json'), '{}\n', 'utf8');
  await fs.mkdir(path.join(homeDir, '.ssh'), { recursive: true });
  await fs.writeFile(path.join(homeDir, '.ssh', 'id_ed25519'), 'secret\n', 'utf8');
  return homeDir;
}

async function codexStub(body) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-build-lanes-codex-'));
  const file = path.join(dir, 'codex-stub.mjs');
  await fs.writeFile(file, `#!/usr/bin/env node\n${body}\n`, 'utf8');
  await fs.chmod(file, 0o755);
  return file;
}

async function waitForLane(store, laneId, predicate) {
  let saved = await store.loadLane(laneId);
  for (let index = 0; index < 20 && !predicate(saved); index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    saved = await store.loadLane(laneId);
  }
  return saved;
}

function runNode(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}
