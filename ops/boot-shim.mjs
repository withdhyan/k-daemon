#!/usr/bin/env node

import {
  execFile,
  fork,
} from 'node:child_process';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  fileURLToPath,
  pathToFileURL,
} from 'node:url';

const execFileAsync = promisify(execFile);

export const CHILD_ARG = '--boot-shim-child';
export const DEFAULT_CONFIG_PATH = path.join('.deploy', 'config.json');
export const DEFAULT_HEALTH_DEADLINE_MS = 30_000;
export const DEFAULT_CRASH_LOOP_LIMIT = 3;
export const DEFAULT_CRASH_LOOP_WINDOW_MS = 120_000;
export const GIT_PATH = '/usr/bin/git';

const STATE_FILE = 'state.json';
const INTENT_FILE = 'intent.json';
const CONSUMED_INTENT_FILE = 'intent.consumed.json';
const OUTCOME_FILE = 'outcome.json';
const SERVE_DIR = 'serve';
const READY_MESSAGE = 'boot-shim:ready';
const SHA_PATTERN = /^[a-f0-9]{7,64}$/i;
const SIGNAL_EXIT_BASE = 128;

export async function runShim(options = {}) {
  const configPath = path.resolve(options.configPath ?? DEFAULT_CONFIG_PATH);
  const deployDir = path.dirname(configPath);
  const config = await loadConfig(configPath);
  const paths = deployPaths(deployDir);
  await fs.mkdir(deployDir, { recursive: true });

  let state = await loadState(paths.stateFile);
  state = expireFreshDeploy(state, {
    now: new Date(),
    windowMs: config.crashLoopWindowMs,
  });

  const intent = await readIntent(paths.intentFile);
  let serveRoot = config.installRoot;
  let serveSha = null;
  let freshDeploy = null;

  if (intent) {
    const previousSha = await currentServedSha({
      config,
      serveRoot: paths.serveRoot,
      state,
    });
    await repointServeWorktree({
      config,
      deployDir,
      serveRoot: paths.serveRoot,
      sha: intent.targetSha,
    });
    await consumeIntent(paths.intentFile, paths.consumedIntentFile);

    serveRoot = paths.serveRoot;
    serveSha = await revParseHead(paths.serveRoot);
    freshDeploy = {
      targetSha: intent.targetSha,
      planId: intent.planId,
      unitId: intent.unitId,
      previousSha: previousSha && previousSha !== intent.targetSha ? previousSha : null,
    };
    state = {
      ...state,
      currentSha: serveSha,
      previousSha: freshDeploy.previousSha ?? state.previousSha ?? null,
      deploy: {
        state: 'pending-health',
        sha: serveSha,
        targetSha: intent.targetSha,
        previousSha: freshDeploy.previousSha,
        planId: intent.planId,
        unitId: intent.unitId,
        at: iso(new Date()),
      },
    };
    await saveState(paths.stateFile, state);
  } else {
    const prepared = await prepareSteadyServe({
      config,
      deployDir,
      serveRoot: paths.serveRoot,
      state,
    });
    serveRoot = prepared.serveRoot;
    serveSha = prepared.sha;
    state = prepared.state;
    if (prepared.stateChanged) await saveState(paths.stateFile, state);
  }

  serveSha ??= await maybeRevParseHead(serveRoot) ?? state.currentSha ?? 'working-tree';
  const launch = recordLaunch(state, serveSha, {
    now: new Date(),
    limit: config.crashLoopLimit,
    windowMs: config.crashLoopWindowMs,
  });
  state = launch.state;
  await saveState(paths.stateFile, state);

  const signalForwarder = createSignalForwarder();
  try {
    if (!freshDeploy && launch.crashLoop && canRollbackCrashLoop(state, serveSha, {
      now: new Date(),
      windowMs: config.crashLoopWindowMs,
    })) {
      const rollback = await rollbackToPrevious({
        config,
        deployDir,
        paths,
        state,
        failedSha: serveSha,
        reason: 'crash-loop',
        configPath,
      });
      signalForwarder.set(rollback.child);
      return await waitForChildExit(rollback.child);
    }

    const child = spawnDaemonChild({
      config,
      configPath,
      serveRoot,
      stdio: options.childStdio,
    });
    signalForwarder.set(child);

    if (freshDeploy) {
      const health = await healthCheck({
        child,
        host: config.host,
        port: config.port,
        deadlineMs: config.healthDeadlineMs,
      });
      if (health.ok) {
        const timestamp = iso(new Date());
        state = await loadState(paths.stateFile);
        state = {
          ...state,
          currentSha: serveSha,
          previousSha: freshDeploy.previousSha ?? state.previousSha ?? null,
          deploy: {
            ...(state.deploy ?? {}),
            state: 'deployed',
            sha: serveSha,
            targetSha: freshDeploy.targetSha,
            previousSha: freshDeploy.previousSha,
            planId: freshDeploy.planId,
            unitId: freshDeploy.unitId,
            acceptedAt: timestamp,
            healthPort: health.port,
          },
        };
        await saveState(paths.stateFile, state);
        await writeOutcome(paths.outcomeFile, {
          result: 'deployed',
          sha: serveSha,
          targetSha: freshDeploy.targetSha,
          previousSha: freshDeploy.previousSha,
          planId: freshDeploy.planId,
          unitId: freshDeploy.unitId,
          at: timestamp,
        });
      } else {
        await killChild(child);
        const rollback = await rollbackToPrevious({
          config,
          deployDir,
          paths,
          state: await loadState(paths.stateFile),
          failedSha: serveSha,
          freshDeploy,
          reason: health.reason ?? 'health-check-failed',
          configPath,
        });
        signalForwarder.set(rollback.child);
        return await waitForChildExit(rollback.child);
      }
    }

    return await waitForChildExit(child);
  } finally {
    signalForwarder.dispose();
  }
}

export async function childMain(configPath, serveRoot) {
  const config = await loadConfig(path.resolve(configPath));
  const resolvedServeRoot = path.resolve(serveRoot);
  await loadEnvFile(config.envPath);
  process.env.CS_K_DATA_DIR = config.dataDir;

  const entryPath = assertPathUnderRoot(
    path.resolve(resolvedServeRoot, config.entry),
    resolvedServeRoot,
    'entry',
  );
  const entry = await import(pathToFileURL(entryPath).href);
  if (typeof entry.startServer !== 'function') {
    throw new Error(`entry does not export startServer: ${config.entry}`);
  }

  const server = await entry.startServer({
    ...config.flags,
    host: config.host,
    port: config.port,
    dataDir: config.dataDir,
    repoRoot: config.installRoot,
    installRoot: config.installRoot,
  });

  if (typeof process.send === 'function') {
    const address = typeof server?.address === 'function' ? server.address() : null;
    process.send({
      type: READY_MESSAGE,
      pid: process.pid,
      address: address && typeof address === 'object' ? address.address : null,
      port: address && typeof address === 'object' ? address.port : config.port,
    });
  }

  installChildSignalHandlers(server);
}

export async function loadConfig(configPath) {
  const raw = await readJsonFile(configPath);
  if (!isPlainObject(raw)) throw new Error('boot config must be an object');

  const installRoot = assertAbsolutePath(raw.installRoot, 'installRoot');
  const dataDir = assertAbsolutePath(raw.dataDir, 'dataDir');
  const envPath = assertAbsolutePath(raw.envPath, 'envPath');
  const entry = assertRelativePath(raw.entry ?? 'daemon/server.mjs', 'entry');
  const host = requiredString(raw.host, 'host');
  const port = normalizePort(raw.port);
  const flags = isPlainObject(raw.flags) ? { ...raw.flags } : {};
  const healthDeadlineMs = positiveInteger(raw.healthDeadlineMs, DEFAULT_HEALTH_DEADLINE_MS);
  const crashLoopLimit = positiveInteger(raw.crashLoopLimit, DEFAULT_CRASH_LOOP_LIMIT);
  const crashLoopWindowMs = positiveInteger(raw.crashLoopWindowMs, DEFAULT_CRASH_LOOP_WINDOW_MS);

  return Object.freeze({
    installRoot,
    host,
    port,
    dataDir,
    envPath,
    entry,
    flags,
    healthDeadlineMs,
    crashLoopLimit,
    crashLoopWindowMs,
  });
}

async function prepareSteadyServe({
  config,
  deployDir,
  serveRoot,
  state,
}) {
  if (!await pathExists(serveRoot)) {
    return {
      serveRoot: config.installRoot,
      sha: await maybeRevParseHead(config.installRoot),
      state,
      stateChanged: false,
      fallback: true,
    };
  }

  const wantedSha = optionalString(state.currentSha);
  if (wantedSha) {
    const actualSha = await maybeRevParseHead(serveRoot);
    if (actualSha !== wantedSha) {
      await repointServeWorktree({
        config,
        deployDir,
        serveRoot,
        sha: wantedSha,
      });
    }
    return {
      serveRoot,
      sha: wantedSha,
      state,
      stateChanged: false,
      fallback: false,
    };
  }

  const serveSha = await maybeRevParseHead(serveRoot);
  if (!serveSha) {
    return {
      serveRoot: config.installRoot,
      sha: await maybeRevParseHead(config.installRoot),
      state,
      stateChanged: false,
      fallback: true,
    };
  }

  return {
    serveRoot,
    sha: serveSha,
    state: {
      ...state,
      currentSha: serveSha,
    },
    stateChanged: true,
    fallback: false,
  };
}

async function rollbackToPrevious({
  config,
  deployDir,
  paths,
  state,
  failedSha,
  freshDeploy,
  reason,
  configPath,
}) {
  const deploy = state.deploy ?? {};
  const previousSha = optionalString(freshDeploy?.previousSha ?? deploy.previousSha ?? state.previousSha);
  const planId = optionalString(freshDeploy?.planId ?? deploy.planId);
  const unitId = optionalString(freshDeploy?.unitId ?? deploy.unitId);
  let serveRoot = config.installRoot;
  let currentSha = await maybeRevParseHead(config.installRoot);

  if (previousSha) {
    await repointServeWorktree({
      config,
      deployDir,
      serveRoot: paths.serveRoot,
      sha: previousSha,
    });
    serveRoot = paths.serveRoot;
    currentSha = await revParseHead(paths.serveRoot);
  }

  const timestamp = iso(new Date());
  const nextState = {
    ...state,
    currentSha,
    previousSha: null,
    failedShas: uniqueStrings([
      ...(Array.isArray(state.failedShas) ? state.failedShas : []),
      failedSha,
    ]),
    deploy: {
      ...(deploy ?? {}),
      state: 'rolled-back',
      sha: failedSha,
      previousSha,
      rolledBackToSha: currentSha,
      planId,
      unitId,
      reason,
      rolledBackAt: timestamp,
    },
  };
  await saveState(paths.stateFile, nextState);
  await writeOutcome(paths.outcomeFile, {
    result: 'rolled-back',
    sha: failedSha,
    targetSha: optionalString(freshDeploy?.targetSha ?? deploy.targetSha) ?? failedSha,
    previousSha,
    rolledBackToSha: currentSha,
    planId,
    unitId,
    reason,
    at: timestamp,
  });

  return {
    child: spawnDaemonChild({
      config,
      configPath,
      serveRoot,
    }),
    serveRoot,
    sha: currentSha,
  };
}

async function repointServeWorktree({
  config,
  deployDir,
  serveRoot,
  sha,
}) {
  assertSha(sha, 'sha');
  const root = assertPathUnderRoot(path.resolve(serveRoot), path.resolve(deployDir), 'serveRoot');
  await fs.mkdir(path.dirname(root), { recursive: true });

  const current = await maybeRevParseHead(root);
  if (current === sha) return;

  if (await pathExists(root)) {
    try {
      await git(config.installRoot, ['worktree', 'remove', '--force', root]);
    } catch (error) {
      if (!isMissingWorktreeError(error)) throw error;
    }
    await fs.rm(root, { recursive: true, force: true });
  }

  await git(config.installRoot, ['worktree', 'prune']).catch(() => {});
  await git(config.installRoot, ['worktree', 'add', '--detach', root, sha]);
}

function spawnDaemonChild({
  config,
  configPath,
  serveRoot,
  stdio,
}) {
  const modulePath = fileURLToPath(import.meta.url);
  const child = fork(modulePath, [CHILD_ARG, path.resolve(configPath), path.resolve(serveRoot)], {
    cwd: serveRoot,
    execPath: process.execPath,
    env: {
      ...process.env,
      CS_K_DATA_DIR: config.dataDir,
      CS_K_INSTALL_ROOT: config.installRoot,
      CS_K_SERVE_ROOT: serveRoot,
    },
    stdio: stdio ?? ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  return child;
}

async function healthCheck({
  child,
  host,
  port,
  deadlineMs,
}) {
  const deadline = Date.now() + deadlineMs;
  let healthPort;
  try {
    healthPort = await waitForReadyPort(child, port, Math.max(1, deadline - Date.now()));
  } catch (error) {
    return {
      ok: false,
      reason: error.message,
    };
  }

  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      return {
        ok: false,
        port: healthPort,
        reason: 'child-exited-before-health',
      };
    }

    try {
      const statusCode = await httpStatus({
        host,
        port: healthPort,
        path: '/api/health',
        timeoutMs: Math.min(1_000, Math.max(1, deadline - Date.now())),
      });
      if (statusCode >= 200 && statusCode < 300) {
        return {
          ok: true,
          port: healthPort,
        };
      }
    } catch {
      // Keep polling until the deadline; server startup races are normal here.
    }
    await delay(100);
  }

  return {
    ok: false,
    port: healthPort,
    reason: 'health-check-timeout',
  };
}

function waitForReadyPort(child, configuredPort, timeoutMs) {
  if (configuredPort !== 0) return Promise.resolve(configuredPort);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => cleanup(() => reject(new Error('ready-timeout'))), timeoutMs);
    const onMessage = (message) => {
      if (!isPlainObject(message) || message.type !== READY_MESSAGE) return;
      const port = normalizePort(message.port);
      cleanup(() => resolve(port));
    };
    const onExit = (code, signal) => {
      cleanup(() => reject(new Error(`child-exited:${code ?? signal ?? 'unknown'}`)));
    };
    const cleanup = (finish) => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
      finish();
    };
    child.on('message', onMessage);
    child.once('exit', onExit);
  });
}

function httpStatus({
  host,
  port,
  path: requestPath,
  timeoutMs,
}) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host,
      port,
      path: requestPath,
      method: 'GET',
      timeout: timeoutMs,
    }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode ?? 0));
    });
    request.on('timeout', () => {
      request.destroy(new Error('health timeout'));
    });
    request.on('error', reject);
    request.end();
  });
}

async function killChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([
    waitForChildExit(child).then(() => true),
    delay(3_000).then(() => false),
  ]);
  if (!exited && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await waitForChildExit(child);
  }
}

function waitForChildExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({
      code: child.exitCode,
      signal: child.signalCode,
    });
  }
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

function createSignalForwarder() {
  let child = null;
  const handlers = new Map();
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    const handler = () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill(signal);
      }
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  return {
    set(nextChild) {
      child = nextChild;
    },
    dispose() {
      for (const [signal, handler] of handlers.entries()) {
        process.off(signal, handler);
      }
      handlers.clear();
    },
  };
}

async function readIntent(file) {
  const value = await readJsonFile(file, { missing: null });
  if (!value) return null;
  if (!isPlainObject(value)) throw new Error('deploy intent must be an object');
  return Object.freeze({
    targetSha: assertSha(value.targetSha, 'intent.targetSha'),
    planId: requiredString(value.planId, 'intent.planId'),
    unitId: requiredString(value.unitId, 'intent.unitId'),
  });
}

async function consumeIntent(intentFile, consumedIntentFile) {
  await fs.rm(consumedIntentFile, { force: true }).catch(() => {});
  await fs.rename(intentFile, consumedIntentFile);
}

async function currentServedSha({
  config,
  serveRoot,
  state,
}) {
  const stateSha = optionalString(state.currentSha);
  if (stateSha) return stateSha;
  const serveSha = await maybeRevParseHead(serveRoot);
  if (serveSha) return serveSha;
  return maybeRevParseHead(config.installRoot);
}

function recordLaunch(state, sha, {
  now,
  limit,
  windowMs,
}) {
  const timestamp = iso(now);
  const nowMs = Date.parse(timestamp);
  const launches = (Array.isArray(state.launches) ? state.launches : [])
    .filter((entry) => isPlainObject(entry))
    .map((entry) => ({
      sha: optionalString(entry.sha) ?? 'unknown',
      at: optionalString(entry.at) ?? timestamp,
    }))
    .filter((entry) => {
      const atMs = Date.parse(entry.at);
      return Number.isFinite(atMs) && nowMs - atMs <= Math.max(windowMs * 10, windowMs);
    });
  launches.push({ sha, at: timestamp });
  const recent = launches.filter((entry) => {
    const atMs = Date.parse(entry.at);
    return entry.sha === sha && Number.isFinite(atMs) && nowMs - atMs <= windowMs;
  });

  return {
    state: {
      ...state,
      launches: launches.slice(-100),
    },
    crashLoop: recent.length >= limit,
    recentLaunches: recent.length,
  };
}

function canRollbackCrashLoop(state, sha, {
  now,
  windowMs,
}) {
  const deploy = state.deploy;
  if (!isPlainObject(deploy)) return false;
  if (deploy.sha !== sha && deploy.targetSha !== sha) return false;
  if (!optionalString(deploy.previousSha)) return false;
  if (!['pending-health', 'deployed'].includes(deploy.state)) return false;

  const reference = optionalString(deploy.acceptedAt ?? deploy.at);
  if (!reference) return true;
  const refMs = Date.parse(reference);
  if (!Number.isFinite(refMs)) return true;
  return Date.parse(iso(now)) - refMs <= windowMs;
}

function expireFreshDeploy(state, {
  now,
  windowMs,
}) {
  const deploy = state.deploy;
  if (!isPlainObject(deploy) || deploy.state !== 'deployed') return state;
  const acceptedAt = optionalString(deploy.acceptedAt);
  const acceptedMs = Date.parse(acceptedAt ?? '');
  if (!Number.isFinite(acceptedMs)) return state;
  if (Date.parse(iso(now)) - acceptedMs <= windowMs) return state;
  return {
    ...state,
    deploy: {
      ...deploy,
      state: 'steady',
      steadiedAt: iso(now),
    },
  };
}

function deployPaths(deployDir) {
  return Object.freeze({
    deployDir,
    stateFile: path.join(deployDir, STATE_FILE),
    intentFile: path.join(deployDir, INTENT_FILE),
    consumedIntentFile: path.join(deployDir, CONSUMED_INTENT_FILE),
    outcomeFile: path.join(deployDir, OUTCOME_FILE),
    serveRoot: path.join(deployDir, SERVE_DIR),
  });
}

async function loadState(file) {
  const value = await readJsonFile(file, { missing: {} });
  const state = isPlainObject(value) ? value : {};
  return {
    schemaVersion: 1,
    launches: [],
    failedShas: [],
    ...state,
  };
}

async function saveState(file, state) {
  await writeJsonFile(file, {
    schemaVersion: 1,
    ...state,
  });
}

async function writeOutcome(file, outcome) {
  await writeJsonFile(file, {
    schemaVersion: 1,
    ...outcome,
  });
}

async function readJsonFile(file, options = {}) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' && Object.hasOwn(options, 'missing')) return options.missing;
    throw error;
  }
}

async function writeJsonFile(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`,
  );
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, file);
}

async function git(cwd, args) {
  try {
    const result = await execFileAsync(GIT_PATH, args, {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    return {
      stdout: String(result.stdout ?? ''),
      stderr: String(result.stderr ?? ''),
    };
  } catch (error) {
    error.stdout = String(error.stdout ?? '');
    error.stderr = String(error.stderr ?? '');
    throw error;
  }
}

async function revParseHead(repoRoot) {
  const result = await git(repoRoot, ['rev-parse', 'HEAD']);
  return assertSha(result.stdout.trim(), 'HEAD');
}

async function maybeRevParseHead(repoRoot) {
  try {
    if (!await pathExists(repoRoot)) return null;
    return await revParseHead(repoRoot);
  } catch {
    return null;
  }
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

function isMissingWorktreeError(error) {
  const text = `${error?.stdout ?? ''}\n${error?.stderr ?? ''}\n${error?.message ?? ''}`;
  return /not a working tree|is not a working tree|No such file|does not exist/i.test(text);
}

async function loadEnvFile(envPath) {
  const file = path.extname(envPath) ? envPath : path.join(envPath, '.env.local');
  let source;
  try {
    source = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { loaded: false, assignedCount: 0 };
    throw error;
  }

  let assignedCount = 0;
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || Object.hasOwn(process.env, key)) continue;
    process.env[key] = trimmed.slice(separator + 1);
    assignedCount += 1;
  }
  return { loaded: true, assignedCount };
}

function installChildSignalHandlers(server) {
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    if (typeof server?.close !== 'function') {
      process.exit(0);
      return;
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3_000).unref();
  };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
}

function assertAbsolutePath(value, label) {
  const text = requiredString(value, label);
  if (!path.isAbsolute(text)) throw new Error(`${label} must be absolute`);
  return path.resolve(text);
}

function assertRelativePath(value, label) {
  const text = requiredString(value, label).replaceAll('\\', '/');
  if (
    path.isAbsolute(text) ||
    path.win32.isAbsolute(text) ||
    text.split('/').includes('..')
  ) {
    throw new Error(`${label} must be a relative path inside the serve root`);
  }
  return text;
}

function assertPathUnderRoot(candidate, root, label) {
  const resolved = path.resolve(candidate);
  const resolvedRoot = path.resolve(root);
  const rel = path.relative(resolvedRoot, resolved);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return resolved;
  throw new Error(`${label} escapes root`);
}

function assertSha(value, label) {
  const text = requiredString(value, label);
  if (!SHA_PATTERN.test(text)) throw new Error(`invalid ${label}: ${value}`);
  return text;
}

function normalizePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`invalid port: ${value}`);
  }
  return port;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function requiredString(value, label) {
  const text = optionalString(value);
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function uniqueStrings(values) {
  return [...new Set(values.map(optionalString).filter(Boolean))];
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function iso(value) {
  return new Date(value).toISOString();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function exitCodeFor(result) {
  if (Number.isInteger(result?.code)) return result.code;
  if (result?.signal) return SIGNAL_EXIT_BASE + signalNumber(result.signal);
  return 0;
}

function signalNumber(signal) {
  switch (signal) {
    case 'SIGHUP': return 1;
    case 'SIGINT': return 2;
    case 'SIGTERM': return 15;
    case 'SIGKILL': return 9;
    default: return 1;
  }
}

function parseConfigArg(argv) {
  const index = argv.indexOf('--config');
  if (index !== -1) return argv[index + 1];
  return DEFAULT_CONFIG_PATH;
}

async function main() {
  if (process.argv[2] === CHILD_ARG) {
    await childMain(process.argv[3], process.argv[4]);
    return;
  }
  const result = await runShim({ configPath: parseConfigArg(process.argv.slice(2)) });
  process.exit(exitCodeFor(result));
}

const isMain = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  main().catch((error) => {
    console.error(`[boot-shim] ${error.stack ?? error.message}`);
    process.exit(1);
  });
}
