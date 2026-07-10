import assert from 'node:assert/strict';
import {
  execFile,
  spawn,
} from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { realTcpListenAvailable } from '../test-support/tcp.mjs';
import {
  BUILD_CARD_KIND_INFRA,
  createBuildCardStore,
} from './build-cards.mjs';
import {
  DEPLOY_RESULT_DEPLOYED,
  DEPLOY_RESULT_ROLLED_BACK,
  applyDeployOutcome,
  readDeployOutcome,
  requestDeploy,
} from './build-deploy.mjs';
import { GIT_PATH } from './build-git.mjs';
import {
  BUILD_STATE_DEPLOYED,
  BUILD_STATE_DEPLOYING,
  BUILD_STATE_HELD,
  BUILD_STATE_INTEGRATING,
  BUILD_STATE_ROLLED_BACK,
  createBuildStateStore,
} from './build-state.mjs';
import { createBuildRunner } from './build-runner.mjs';

const execFileAsync = promisify(execFile);
const networkTest = realTcpListenAvailable ? test : test.skip;
const BOOT_SHIM = path.resolve('ops/boot-shim.mjs');

networkTest('shim healthy fresh deploy writes deployed outcome and advances serve pointer', async () => {
  const fixture = await createShimFixture({ targetMode: 'healthy' });
  await addServeWorktree(fixture, fixture.previousSha);
  await writeState(fixture, {
    currentSha: fixture.previousSha,
    previousSha: null,
    launches: [],
  });
  await writeIntent(fixture, fixture.targetSha);

  const shim = spawnShim(fixture);
  try {
    const outcome = await waitForJson(fixture.outcomeFile);
    assert.equal(outcome.result, DEPLOY_RESULT_DEPLOYED);
    assert.equal(outcome.sha, fixture.targetSha);

    const state = await readJson(fixture.stateFile);
    assert.equal(state.currentSha, fixture.targetSha);
    assert.equal(await git(fixture.serveRoot, ['rev-parse', 'HEAD']), fixture.targetSha);

    const report = await waitForReport(fixture.reportPath, 'target');
    assert.equal(report.dataDir, fixture.dataDir);
    assert.equal(path.isAbsolute(report.dataDir), true);
    assert.equal(report.dataDir === path.join(report.cwd, 'data'), false);
    assert.equal(report.envDataDir, fixture.dataDir);
  } finally {
    await stopProcess(shim);
  }
});

networkTest('shim unhealthy fresh deploy rolls back and serves previous daemon', async () => {
  const fixture = await createShimFixture({ targetMode: 'unhealthy' });
  await addServeWorktree(fixture, fixture.previousSha);
  await writeState(fixture, {
    currentSha: fixture.previousSha,
    previousSha: null,
    launches: [],
  });
  await writeIntent(fixture, fixture.targetSha);

  const shim = spawnShim(fixture);
  try {
    const outcome = await waitForJson(fixture.outcomeFile);
    assert.equal(outcome.result, DEPLOY_RESULT_ROLLED_BACK);
    assert.equal(outcome.sha, fixture.targetSha);
    assert.equal(outcome.rolledBackToSha, fixture.previousSha);

    const report = await waitForReport(fixture.reportPath, 'previous');
    assert.equal(report.label, 'previous');
    assert.equal(await git(fixture.serveRoot, ['rev-parse', 'HEAD']), fixture.previousSha);
    const state = await readJson(fixture.stateFile);
    assert.equal(state.currentSha, fixture.previousSha);
  } finally {
    await stopProcess(shim);
  }
});

networkTest('shim crash-loop counter rolls back a fresh deployed sha', async () => {
  const fixture = await createShimFixture({ targetMode: 'crash' });
  await addServeWorktree(fixture, fixture.targetSha);
  await writeState(fixture, {
    currentSha: fixture.targetSha,
    previousSha: fixture.previousSha,
    launches: [],
    deploy: {
      state: 'deployed',
      sha: fixture.targetSha,
      targetSha: fixture.targetSha,
      previousSha: fixture.previousSha,
      planId: 'plan-u10',
      unitId: 'u10',
      acceptedAt: new Date().toISOString(),
    },
  });

  for (let index = 0; index < 2; index += 1) {
    const shim = spawnShim(fixture);
    await waitForExit(shim, 5_000);
    assert.equal(await pathExists(fixture.outcomeFile), false);
  }

  const shim = spawnShim(fixture);
  try {
    const outcome = await waitForJson(fixture.outcomeFile);
    assert.equal(outcome.result, DEPLOY_RESULT_ROLLED_BACK);
    assert.equal(outcome.reason, 'crash-loop');
    assert.equal(outcome.rolledBackToSha, fixture.previousSha);
    const report = await waitForReport(fixture.reportPath, 'previous');
    assert.equal(report.label, 'previous');
    assert.equal(await git(fixture.serveRoot, ['rev-parse', 'HEAD']), fixture.previousSha);
  } finally {
    await stopProcess(shim);
  }
});

networkTest('shim restart without intent has no health gate and writes no outcome', async () => {
  const fixture = await createShimFixture({ targetMode: 'healthy' });
  await addServeWorktree(fixture, fixture.previousSha);
  await writeState(fixture, {
    currentSha: fixture.previousSha,
    previousSha: null,
    launches: [],
  });

  const shim = spawnShim(fixture);
  try {
    const report = await waitForReport(fixture.reportPath, 'previous');
    assert.equal(report.label, 'previous');
    await delay(300);
    assert.equal(await pathExists(fixture.outcomeFile), false);
  } finally {
    await stopProcess(shim);
  }
});

test('requestDeploy writes intent, transitions unit to deploying, and calls exit fn', async () => {
  const harness = await deployHarness();
  await harness.store.savePlan(plan({
    id: 'request-plan',
    units: [unit({ id: 'u10', state: BUILD_STATE_INTEGRATING })],
  }));

  const exits = [];
  await requestDeploy({
    store: harness.store,
    installRoot: harness.installRoot,
    planId: 'request-plan',
    unitId: 'u10',
    targetSha: 'abcdef1',
    now: fixedNow,
    exitFn: async (code) => exits.push(code),
  });

  assert.deepEqual(exits, [0]);
  const intent = await readJson(path.join(harness.installRoot, '.deploy', 'intent.json'));
  assert.equal(intent.targetSha, 'abcdef1');
  assert.equal(intent.planId, 'request-plan');
  const loaded = await harness.store.loadPlan('request-plan');
  assert.equal(loaded.units[0].state, BUILD_STATE_DEPLOYING);
});

test('readDeployOutcome consumes outcome by rename', async () => {
  const harness = await deployHarness();
  const deployDir = path.join(harness.installRoot, '.deploy');
  await fs.mkdir(deployDir, { recursive: true });
  await writeJson(path.join(deployDir, 'outcome.json'), {
    result: DEPLOY_RESULT_DEPLOYED,
    sha: 'abcdef1',
    planId: 'plan-1',
    unitId: 'u10',
  });

  const outcome = await readDeployOutcome({
    installRoot: harness.installRoot,
    planId: 'plan-1',
    unitId: 'u10',
  });

  assert.equal(outcome.result, DEPLOY_RESULT_DEPLOYED);
  assert.equal(await pathExists(path.join(deployDir, 'outcome.json')), false);
  assert.equal(await pathExists(path.join(deployDir, 'outcome.consumed.json')), true);
  assert.equal(await readDeployOutcome({ installRoot: harness.installRoot }), null);
});

test('rolled-back outcome marks unit rolled-back, holds plan, and raises card', async () => {
  const harness = await deployHarness();
  await harness.store.savePlan(plan({
    id: 'rollback-plan',
    units: [unit({ id: 'u10', state: BUILD_STATE_DEPLOYING })],
  }));

  const result = await applyDeployOutcome({
    store: harness.store,
    cards: harness.cards,
    planId: 'rollback-plan',
    unitId: 'u10',
    outcome: {
      result: DEPLOY_RESULT_ROLLED_BACK,
      sha: 'badc0de',
      rolledBackToSha: 'abcdef1',
      reason: 'health-check-timeout',
    },
    now: fixedNow,
  });

  assert.equal(result.target, BUILD_STATE_ROLLED_BACK);
  const loaded = await harness.store.loadPlan('rollback-plan');
  assert.equal(loaded.status, BUILD_STATE_HELD);
  assert.equal(loaded.units[0].state, BUILD_STATE_ROLLED_BACK);
  const cards = await harness.cards.listCards();
  assert.equal(cards.length, 1);
  assert.equal(cards[0].kind, BUILD_CARD_KIND_INFRA);
  assert.equal(cards[0].action, 'deploy-rolled-back');
});

test('build runner deploying recovery consumes boot outcome and applies rollback hold', async () => {
  const harness = await deployHarness();
  await harness.store.savePlan(plan({
    id: 'runner-rollback',
    units: [unit({ id: 'u10', state: BUILD_STATE_DEPLOYING })],
  }));
  await fs.mkdir(path.join(harness.installRoot, '.deploy'), { recursive: true });
  await writeJson(path.join(harness.installRoot, '.deploy', 'outcome.json'), {
    result: DEPLOY_RESULT_ROLLED_BACK,
    sha: 'badc0de',
    rolledBackToSha: 'abcdef1',
    planId: 'runner-rollback',
    unitId: 'u10',
    reason: 'health-check-timeout',
  });

  const runner = createBuildRunner({
    store: harness.store,
    cards: harness.cards,
    dataDir: harness.dataDir,
    repoRoot: harness.installRoot,
    laneCap: 0,
    deps: {
      now: () => fixedNow,
      monotonicNow: () => 0,
      logger: silentLogger(),
    },
  });
  const summary = await runner.tick();

  assert.equal(summary.ok, true);
  assert.deepEqual(summary.recovered.map((entry) => entry.target), [BUILD_STATE_ROLLED_BACK]);
  const loaded = await harness.store.loadPlan('runner-rollback');
  assert.equal(loaded.status, BUILD_STATE_HELD);
  assert.equal(loaded.units[0].state, BUILD_STATE_ROLLED_BACK);
  assert.equal(await pathExists(path.join(harness.installRoot, '.deploy', 'outcome.json')), false);
  assert.equal((await harness.cards.listCards()).some((card) => card.action === 'deploy-rolled-back'), true);
});

test('build runner deploying recovery marks deployed outcome deployed', async () => {
  const harness = await deployHarness();
  await harness.store.savePlan(plan({
    id: 'runner-deployed',
    units: [unit({ id: 'u10', state: BUILD_STATE_DEPLOYING })],
  }));
  await fs.mkdir(path.join(harness.installRoot, '.deploy'), { recursive: true });
  await writeJson(path.join(harness.installRoot, '.deploy', 'outcome.json'), {
    result: DEPLOY_RESULT_DEPLOYED,
    sha: 'abcdef1',
    planId: 'runner-deployed',
    unitId: 'u10',
  });

  const runner = createBuildRunner({
    store: harness.store,
    cards: harness.cards,
    dataDir: harness.dataDir,
    repoRoot: harness.installRoot,
    laneCap: 0,
    deps: {
      now: () => fixedNow,
      monotonicNow: () => 0,
      logger: silentLogger(),
    },
  });
  await runner.tick();

  const loaded = await harness.store.loadPlan('runner-deployed');
  assert.equal(loaded.units[0].state, BUILD_STATE_DEPLOYED);
  assert.equal(loaded.completedAt, fixedNow.toISOString());
});

async function createShimFixture({ targetMode }) {
  const installRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-boot-shim-repo-'));
  await git(installRoot, ['init']);
  await git(installRoot, ['config', 'user.email', 'builder@example.test']);
  await git(installRoot, ['config', 'user.name', 'Build Runner']);
  await writeFile(path.join(installRoot, '.gitignore'), '/.deploy/\n/data/\n.env.local\nreports.jsonl\n');
  await writeStubServer(installRoot, { mode: 'healthy', label: 'previous' });
  await git(installRoot, ['add', '.gitignore', 'daemon/server.mjs']);
  await git(installRoot, ['commit', '-m', 'previous healthy daemon']);
  const previousSha = await git(installRoot, ['rev-parse', 'HEAD']);

  await writeStubServer(installRoot, { mode: targetMode, label: 'target' });
  await git(installRoot, ['add', 'daemon/server.mjs']);
  await git(installRoot, ['commit', '-m', `target ${targetMode} daemon`]);
  const targetSha = await git(installRoot, ['rev-parse', 'HEAD']);

  const deployDir = path.join(installRoot, '.deploy');
  const serveRoot = path.join(deployDir, 'serve');
  const reportPath = path.join(installRoot, 'reports.jsonl');
  const dataDir = path.join(installRoot, 'data');
  await fs.mkdir(deployDir, { recursive: true });
  await writeFile(path.join(installRoot, '.env.local'), 'STUB_ENV=loaded\nCS_K_DATA_DIR=/tmp/wrong-data\n');
  await writeJson(path.join(deployDir, 'config.json'), {
    installRoot,
    host: '127.0.0.1',
    port: 0,
    dataDir,
    envPath: path.join(installRoot, '.env.local'),
    entry: 'daemon/server.mjs',
    flags: {
      routineTicker: false,
      buildRunner: false,
      reportPath,
    },
    healthDeadlineMs: 5_000,
    crashLoopLimit: 3,
    crashLoopWindowMs: 120_000,
  });

  return {
    installRoot,
    deployDir,
    serveRoot,
    reportPath,
    dataDir,
    stateFile: path.join(deployDir, 'state.json'),
    intentFile: path.join(deployDir, 'intent.json'),
    outcomeFile: path.join(deployDir, 'outcome.json'),
    configPath: path.join(deployDir, 'config.json'),
    previousSha,
    targetSha,
  };
}

async function addServeWorktree(fixture, sha) {
  await git(fixture.installRoot, ['worktree', 'add', '--detach', fixture.serveRoot, sha]);
}

async function writeState(fixture, state) {
  await writeJson(fixture.stateFile, {
    schemaVersion: 1,
    ...state,
  });
}

async function writeIntent(fixture, targetSha) {
  await writeJson(fixture.intentFile, {
    targetSha,
    planId: 'plan-u10',
    unitId: 'u10',
  });
}

function spawnShim(fixture) {
  const child = spawn(process.execPath, [BOOT_SHIM, '--config', fixture.configPath], {
    cwd: fixture.installRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.output = '';
  child.stdout.on('data', (chunk) => {
    child.output += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    child.output += String(chunk);
  });
  return child;
}

async function writeStubServer(repoRoot, { mode, label }) {
  await writeFile(path.join(repoRoot, 'daemon', 'server.mjs'), `
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const MODE = ${JSON.stringify(mode)};
const LABEL = ${JSON.stringify(label)};

export async function startServer(options = {}) {
  if (MODE === 'unhealthy') {
    process.exit(1);
  }

  const server = http.createServer((request, response) => {
    if (request.url === '/api/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, label: LABEL }));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end(LABEL);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve);
  });

  const address = server.address();
  if (options.reportPath) {
    await fs.mkdir(path.dirname(options.reportPath), { recursive: true });
    await fs.appendFile(options.reportPath, JSON.stringify({
      mode: MODE,
      label: LABEL,
      pid: process.pid,
      port: address.port,
      dataDir: options.dataDir,
      envDataDir: process.env.CS_K_DATA_DIR,
      repoRoot: options.repoRoot,
      cwd: process.cwd()
    }) + '\\n');
  }

  if (MODE === 'crash') {
    setTimeout(() => process.exit(1), 150).unref();
  }

  return server;
}
`);
}

async function deployHarness() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-build-deploy-data-'));
  const installRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-build-deploy-root-'));
  const store = createBuildStateStore({
    dataDir,
    now: () => fixedNow,
    monotonicNow: () => 0,
  });
  const cards = createBuildCardStore({
    dataDir,
    now: () => fixedNow,
    stateStore: store,
    randomSuffix: suffixer(),
  });
  return {
    cards,
    dataDir,
    installRoot,
    store,
  };
}

function plan(overrides = {}) {
  return {
    id: 'plan-1',
    title: 'Plan 1',
    status: 'queued',
    units: [unit()],
    lease: {
      owner: 'runner',
      acquiredAt: fixedNow.toISOString(),
      renewedAt: fixedNow.toISOString(),
      ttlMs: 60_000,
    },
    createdAt: fixedNow.toISOString(),
    updatedAt: fixedNow.toISOString(),
    ...overrides,
  };
}

function unit(overrides = {}) {
  return {
    id: 'u1',
    state: BUILD_STATE_INTEGRATING,
    scope: ['src/**'],
    goal: 'self deploy',
    createdAt: fixedNow.toISOString(),
    updatedAt: fixedNow.toISOString(),
    ...overrides,
  };
}

async function waitForJson(file, timeoutMs = 5_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pathExists(file)) return readJson(file);
    await delay(50);
  }
  throw new Error(`timed out waiting for ${file}`);
}

async function waitForReport(file, label, timeoutMs = 5_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pathExists(file)) {
      const lines = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean);
      for (const line of lines.reverse()) {
        const parsed = JSON.parse(line);
        if (!label || parsed.label === label) return parsed;
      }
    }
    await delay(50);
  }
  throw new Error(`timed out waiting for report ${label}`);
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    waitForExit(child, 5_000),
    delay(5_000).then(() => {
      child.kill('SIGKILL');
    }),
  ]);
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`process did not exit:\n${child.output ?? ''}`));
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function git(cwd, args) {
  const result = await execFileAsync(GIT_PATH, args, {
    cwd,
    maxBuffer: 16 * 1024 * 1024,
  });
  return String(result.stdout ?? '').trim();
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function writeFile(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, 'utf8');
}

async function pathExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function suffixer() {
  let index = 0;
  return () => {
    index += 1;
    return `r${index}`;
  };
}

function silentLogger() {
  return {
    error() {},
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const fixedNow = new Date('2026-07-04T00:00:00.000Z');
