import { execFile, execFileSync, spawn } from 'node:child_process';
import {
  closeSync,
  openSync,
  readSync,
  statSync,
} from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

import {
  iso,
  safeDataPath,
} from '../../daemon/run.mjs';
import {
  optionalString,
  requiredString,
} from '../substrate.mjs';
import { withTimeout } from '../ingest/apple-notes.mjs';
import {
  BUILD_DIR,
  BUILD_STATE_BUILDING,
  BUILD_STATE_ORPHANED,
  lanesNeedingRecovery,
} from './build-state.mjs';
import {
  laneWorktreeAdd,
  laneWorktreeRemove,
} from './build-git.mjs';

export const DISK_PREFLIGHT_MIN_BYTES = 2 * 1024 * 1024 * 1024;
export const STALL_MS = 420 * 1000;
// 75min: 2026-07-05 evidence — six ~50-60min lanes finished their units and were
// then ceiling-killed at the 40min boundary, wasting ~1.5M codex tokens. The
// 420s stall watchdog already catches hung lanes; the ceiling only bounds runaways.
export const CEILING_MS = 75 * 60 * 1000;
export const WATCH_TICK_INTERVAL_MS = 60 * 1000;
export const WATCH_MONOTONIC_JUMP_FACTOR = 4;
export const CODEX_COMPLETION_SENTINEL_QUIESCENT_MS = 90 * 1000;
export const CODEX_COMPLETION_LOG_TAIL_BYTES = 16 * 1024;
export const LANE_LOGS_DIR = path.join(BUILD_DIR, 'lane-logs');

export const AUTH_FAILURE_PATTERNS = Object.freeze([
  /not\s+logged\s+in/i,
  /login\s+required/i,
  /please\s+log\s+in/i,
  /not\s+authenticated/i,
  /authentication\s+(?:required|failed)/i,
  /unauthori[sz]ed/i,
  /invalid\s+(?:api\s+)?key/i,
  /\b401\b/,
]);
export const QUOTA_FAILURE_PATTERNS = Object.freeze([
  /\b429\b/,
  /too\s+many\s+requests/i,
  /rate\s*limit/i,
  /quota/i,
  /insufficient_quota/i,
  /usage\s+limit/i,
  /billing/i,
]);
export const SPAWN_FAILURE_PATTERNS = Object.freeze([
  /\bENOENT\b/,
  /spawn\s+.*\s+ENOENT/i,
  /command\s+not\s+found/i,
  /no\s+such\s+file\s+or\s+directory/i,
]);
export const INFRA_FAILURE_PATTERNS = Object.freeze([
  ...AUTH_FAILURE_PATTERNS,
  ...QUOTA_FAILURE_PATTERNS,
  ...SPAWN_FAILURE_PATTERNS,
]);

const execFileAsync = promisify(execFile);
const BASE_LANE_PATH = '/usr/bin:/bin:/usr/local/bin';
const PS_TIMEOUT_MS = 2_000;
const LANE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const CODEX_COMPLETION_SENTINEL_PATTERN = /^(?:tokens used|total tokens used)\s*:\s*\S/i;
const PS_START_TIME_PATTERN = /^[A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}$/;

export async function dispatchLane(options = {}) {
  const store = requiredStore(options.store);
  const planId = assertLanePart(options.planId, 'planId');
  const unitId = assertLanePart(options.unitId, 'unitId');
  const prompt = requiredString(options.prompt, 'prompt');
  const baseSha = requiredString(options.baseSha, 'baseSha');
  const repoRoot = path.resolve(requiredString(options.repoRoot, 'repoRoot'));
  const codexPath = assertAbsolutePath(options.codexPath, 'codexPath');
  const timestampDate = normalizeNow(options.now);
  const envInput = options.env ?? {};
  const tmpDir = path.resolve(optionalString(envInput.TMPDIR) ?? os.tmpdir());
  const minDiskBytes = positiveInteger(options.minDiskBytes, DISK_PREFLIGHT_MIN_BYTES);
  const statfsImpl = options.statfsImpl ?? fs.statfs;

  const preflight = await diskPreflight({
    repoRoot,
    minBytes: minDiskBytes,
    statfsImpl,
  });
  if (!preflight.ok) return preflight;

  const laneId = optionalString(options.laneId) ?? laneIdFor(planId, unitId);
  const worktree = await (options.laneWorktreeAddImpl ?? laneWorktreeAdd)({
    repoRoot,
    laneId,
    baseSha,
    now: timestampDate,
    execFileImpl: options.execFileImpl,
    timeoutMs: options.gitTimeoutMs,
  });
  const worktreePath = path.resolve(requiredString(worktree.path, 'worktree.path'));

  const laneHome = await createLaneHome({
    homeDir: options.homeDir,
    tmpDir,
  });
  const childEnv = laneEnv({
    codexPath,
    home: laneHome,
    tmpDir,
  });
  const logPath = laneLogPath(store, laneId);
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  const logHandle = await fs.open(logPath, 'a');
  const spawnTime = iso(timestampDate);
  let child;

  try {
    child = (options.spawnImpl ?? spawn)(codexPath, [
      'exec',
      '-s',
      'workspace-write',
      '-C',
      worktreePath,
      prompt,
    ], {
      cwd: worktreePath,
      env: childEnv,
      stdio: ['ignore', logHandle.fd, logHandle.fd],
      detached: false,
    });

    attachSpawnErrorLogger(child, logPath);
    const exitObservation = observeChildExit(child);
    const startTime = await (options.startTimeImpl ?? readProcessStartTime)({
      pid: child?.pid,
      spawnTime,
      execFileImpl: options.execFileImpl,
    });
    const previous = await store.loadLane?.(laneId);
    const dispatchMonotonicAt = options.monotonicNow === undefined
      ? undefined
      : normalizeMonotonicNow(options.monotonicNow);
    const lane = await store.saveLane({
      ...(previous ?? {}),
      id: laneId,
      planId,
      unitId,
      baseSha,
      repoRoot,
      pid: normalizePid(child?.pid),
      startTime,
      // A fresh spawn NEVER inherits the previous attempt's clock — doing so made
      // the ceiling watchdog kill redispatches within seconds (observed live:
      // 76s instant kills across five waves). No monotonicNow → no startMonotonicAt;
      // the stall watchdog still covers hung lanes via log activity.
      startMonotonicAt: dispatchMonotonicAt,
      lastWatchMonotonic: dispatchMonotonicAt,
      lastLogChangeAt: dispatchMonotonicAt,
      logPath,
      worktreePath,
      homePath: laneHome,
      state: BUILD_STATE_BUILDING,
      attempts: positiveInteger(previous?.attempts, 0),
      debited: Boolean(previous?.debited),
      done: false,
      settled: false,
      exitCode: undefined,
      exitSignal: undefined,
      finishedAt: undefined,
      completionDetectedAt: undefined,
      completionLogSize: undefined,
      completionReason: undefined,
      exitObserved: undefined,
      exitObservedAt: undefined,
      exitFailureAt: undefined,
      createdAt: previous?.createdAt ?? spawnTime,
      updatedAt: spawnTime,
    });
    recordLaneExitWhenObserved({
      exitObservation,
      store,
      lane,
    }).catch(() => {});

    return {
      ok: true,
      lane,
      child,
      laneId,
      pid: child?.pid ?? null,
      startTime,
      logPath,
      worktreePath,
      homePath: laneHome,
    };
  } finally {
    await logHandle.close();
  }
}

export function watchLane(options = {}) {
  const lane = options.lane ?? {};
  const now = normalizeMonotonicNow(options.monotonicNow);
  const tickIntervalMs = positiveInteger(
    options.tickIntervalMs ?? lane.tickIntervalMs ?? lane.watchdog?.tickIntervalMs,
    WATCH_TICK_INTERVAL_MS,
  );
  const jumpMs = positiveInteger(
    options.monotonicJumpMs ?? lane.monotonicJumpMs ?? lane.watchdog?.monotonicJumpMs,
    tickIntervalMs * WATCH_MONOTONIC_JUMP_FACTOR,
  );
  const lastTick = firstFiniteNumber(
    lane.lastWatchMonotonic,
    lane.lastWatchMonotonicAt,
    lane.watchdog?.lastMonotonicNow,
    lane.watchdog?.lastTickAt,
  );

  if (lastTick !== null && now - lastTick > jumpMs) return 'reset-baseline';

  const ceilingMs = positiveInteger(options.ceilingMs ?? lane.ceilingMs, CEILING_MS);
  const startAt = firstFiniteNumber(
    lane.startMonotonicAt,
    lane.startedMonotonicAt,
    lane.watchdog?.startMonotonicAt,
    lane.watchdog?.startedAt,
  );
  if (startAt !== null && now - startAt > ceilingMs) return 'kill-ceiling';

  const size = logSizeFrom(options.readLogSize, lane);
  const previousSize = firstFiniteNumber(
    lane.lastLogSize,
    lane.watchdog?.lastLogSize,
    lane.logSize,
  );
  const lastChangedAt = firstFiniteNumber(
    lane.lastLogChangeAt,
    lane.lastLogChangedAt,
    lane.watchdog?.lastLogChangeAt,
    lane.watchdog?.lastLogChangedAt,
    lane.watchdog?.baselineAt,
    lastTick,
    startAt,
  );

  if (size !== null && previousSize !== null && lastChangedAt !== null && size === previousSize) {
    const stallMs = positiveInteger(options.stallMs ?? lane.stallMs, STALL_MS);
    if (now - lastChangedAt >= stallMs) return 'kill-stall';
  }

  return 'continue';
}

export function detectLaneCompletion(options = {}) {
  const lane = options.lane ?? {};
  if (laneCompleted(lane)) return null;

  const pid = normalizePid(lane.pid);
  if (pid === null) return null;

  const alive = (options.isPidAlive ?? isPidAlive)(pid, lane.startTime, lane) === true;
  if (alive) return null;

  const logTail = logTailFrom(options, lane);
  if (!logEndsWithCodexCompletionSentinel(logTail)) return null;

  const logInfo = logInfoFrom(options, lane);
  const quiescentMs = positiveInteger(
    options.quiescentMs ?? options.sentinelQuiescentMs,
    CODEX_COMPLETION_SENTINEL_QUIESCENT_MS,
  );
  if (!logQuiescent({
    lane,
    logInfo,
    monotonicNow: optionalFiniteNumber(options.monotonicNow),
    now: normalizeNow(options.now),
    quiescentMs,
  })) {
    return null;
  }

  const timestamp = iso(normalizeNow(options.now));
  return {
    done: true,
    settled: true,
    finishedAt: timestamp,
    completionDetectedAt: timestamp,
    completionReason: 'codex-sentinel-dead-pid',
    exitObserved: false,
    ...(Number.isFinite(Number(logInfo?.size)) ? { completionLogSize: Number(logInfo.size) } : {}),
  };
}

export function logEndsWithCodexCompletionSentinel(value) {
  const text = stripAnsi(String(value ?? '')).trimEnd();
  if (!text) return false;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const lastLine = lines.at(-1) ?? '';
  return CODEX_COMPLETION_SENTINEL_PATTERN.test(lastLine);
}

export function readLogInfo(lane) {
  const file = logPathFrom(lane);
  if (!file) return null;

  try {
    const stat = statSync(file);
    if (!stat.isFile()) return null;
    return {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };
  } catch {
    return null;
  }
}

export function readLogSize(lane) {
  return readLogInfo(lane)?.size ?? null;
}

export function readLogTail(lane, options = {}) {
  const file = logPathFrom(lane);
  if (!file) return '';

  const info = readLogInfo(lane);
  if (!info || info.size <= 0) return '';

  const limit = positiveInteger(options.bytes ?? options.limit, CODEX_COMPLETION_LOG_TAIL_BYTES);
  const bytes = Math.min(limit, info.size);
  const buffer = Buffer.alloc(bytes);
  let fd;
  try {
    fd = openSync(file, 'r');
    readSync(fd, buffer, 0, bytes, info.size - bytes);
    return buffer.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

export function isPidAlive(pid, startTime) {
  let normalized;
  try {
    normalized = normalizePid(pid);
  } catch {
    return false;
  }
  if (normalized === null) return false;

  try {
    process.kill(normalized, 0);
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code !== 'EPERM') return false;
  }

  const expectedStart = optionalString(startTime);
  if (!expectedStart) return true;
  if (!PS_START_TIME_PATTERN.test(expectedStart)) return true;

  try {
    const stdout = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(normalized)], {
      encoding: 'utf8',
      timeout: PS_TIMEOUT_MS,
      windowsHide: true,
    }).trim();
    const actualStart = optionalString(stdout);
    if (!actualStart) return false;
    return actualStart === expectedStart;
  } catch {
    return true;
  }
}

export function killLane(options = {}) {
  const lane = options.lane ?? {};
  const pid = normalizePid(lane.pid);
  if (pid === null) {
    return {
      ok: false,
      killed: false,
      reason: 'missing-pid',
    };
  }

  const signal = optionalString(options.signal) ?? 'SIGKILL';
  const killImpl = options.killImpl ?? process.kill;
  try {
    killImpl(pid, signal);
    return {
      ok: true,
      killed: true,
      pid,
      signal,
    };
  } catch (error) {
    if (error?.code === 'ESRCH') {
      return {
        ok: true,
        killed: false,
        pid,
        signal,
        reason: 'not-found',
      };
    }
    throw error;
  }
}

export async function recoverOrphans(options = {}) {
  const store = requiredStore(options.store);
  if (typeof options.isPidAlive !== 'function') throw new Error('isPidAlive must be a function');
  const resetWorktree = options.resetWorktree ?? defaultResetWorktree;
  const lanes = await store.listLanes();
  const recoveryCandidates = lanes.filter((lane) => !laneCompleted(lane));
  const recoveryIds = new Set(lanesNeedingRecovery(recoveryCandidates, options.isPidAlive).map((lane) => lane.id));
  const recovered = [];

  for (const lane of lanes) {
    if (lane.state !== BUILD_STATE_BUILDING) continue;
    if (laneCompleted(lane)) continue;
    if (!hasProcessIdentity(lane)) continue;

    const pidIdentityStale = recoveryIds.has(lane.id);
    const pidMatchesStart = options.isPidAlive(lane.pid, lane.startTime, lane) === true;
    const killed = pidMatchesStart
      ? killLane({
        lane,
        signal: options.signal,
        killImpl: options.killImpl,
      })
      : {
        ok: true,
        killed: false,
        pid: lane.pid,
        reason: 'pid-start-mismatch',
      };
    const reset = await resetWorktree({ lane });
    const timestamp = iso(normalizeNow(options.now));
    const updated = await store.saveLane({
      ...lane,
      state: BUILD_STATE_ORPHANED,
      orphanedAt: timestamp,
      updatedAt: timestamp,
      recovery: {
        pidIdentityStale,
        pidMatchesStart,
        killed: Boolean(killed.killed),
        reset,
      },
    });

    await store.appendHistory?.({
      kind: 'build.lane.orphaned',
      planId: lane.planId ?? null,
      unitId: lane.unitId,
      laneId: lane.id,
      pid: lane.pid,
      pidIdentityStale,
      pidMatchesStart,
      killed: Boolean(killed.killed),
      at: timestamp,
    });

    recovered.push({
      lane: updated,
      killed,
      reset,
      pidIdentityStale,
      pidMatchesStart,
    });
  }

  return {
    ok: true,
    recovered,
  };
}

export function classifyFailure(options = {}) {
  if (options.stalledAtZeroOutput === true) return 'infra';

  const code = optionalString(options.errorCode) ??
    optionalString(options.exitCode?.code) ??
    optionalString(options.exitCode);
  if (code === 'ENOENT') return 'infra';

  const text = [
    optionalString(options.logTail),
    optionalString(options.stderr),
    optionalString(options.stdout),
    optionalString(options.error?.message),
    optionalString(options.exitCode?.message),
    code,
  ].filter(Boolean).join('\n');

  return INFRA_FAILURE_PATTERNS.some((pattern) => pattern.test(text)) ? 'infra' : 'lane';
}

export function applyFailureBudget(lane, classification) {
  const normalizedClass = classification === 'infra' ? 'infra' : 'lane';
  const attempts = positiveInteger(lane?.attempts, 0);
  return {
    ...(lane ?? {}),
    attempts: normalizedClass === 'lane' ? attempts + 1 : attempts,
    debited: normalizedClass === 'lane' ? true : Boolean(lane?.debited),
    failureClassification: normalizedClass,
  };
}

export async function readProcessStartTime(options = {}) {
  const pid = normalizePid(options.pid);
  const spawnTime = optionalString(options.spawnTime) ?? iso(new Date());
  if (pid === null) return spawnTime;

  try {
    const result = await withTimeout(
      () => (options.execFileImpl ?? execFileAsync)('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
        maxBuffer: 64 * 1024,
        windowsHide: true,
      }),
      PS_TIMEOUT_MS,
      'ps lane start time',
    );
    const stdout = String(result?.stdout ?? '').trim();
    return optionalString(stdout) ?? spawnTime;
  } catch {
    return spawnTime;
  }
}

export async function diskPreflight(options = {}) {
  const repoRoot = path.resolve(requiredString(options.repoRoot, 'repoRoot'));
  const minBytes = positiveInteger(options.minBytes, DISK_PREFLIGHT_MIN_BYTES);
  const stats = await (options.statfsImpl ?? fs.statfs)(repoRoot);
  const freeBytes = statfsFreeBytes(stats);
  if (freeBytes < minBytes) {
    return {
      ok: false,
      reason: 'disk',
      card: 'bound',
      freeBytes,
      minBytes,
    };
  }

  return {
    ok: true,
    freeBytes,
    minBytes,
  };
}

export function laneIdFor(planId, unitId) {
  const raw = `${assertLanePart(planId, 'planId')}-${assertLanePart(unitId, 'unitId')}`;
  if (LANE_ID_PATTERN.test(raw)) return raw;

  const digest = createHash('sha256').update(raw).digest('hex').slice(0, 12);
  const prefix = raw
    .replace(/[^a-zA-Z0-9_.:-]/g, '-')
    .replace(/^-+/, 'lane-')
    .slice(0, 112);
  const laneId = `${prefix}-${digest}`;
  if (!LANE_ID_PATTERN.test(laneId)) throw new Error(`invalid lane id: ${laneId}`);
  return laneId;
}

function laneLogPath(store, laneId) {
  return safeDataPath(
    store.dataDir ?? path.join(process.cwd(), 'data'),
    path.join(LANE_LOGS_DIR, `${laneIdForLog(laneId)}.log`),
  );
}

function laneIdForLog(laneId) {
  if (!LANE_ID_PATTERN.test(laneId)) throw new Error(`invalid laneId: ${laneId}`);
  return laneId;
}

async function createLaneHome(options = {}) {
  const tmpDir = path.resolve(requiredString(options.tmpDir, 'tmpDir'));
  const sourceHome = path.resolve(requiredString(options.homeDir ?? os.homedir(), 'homeDir'));
  const sourceCodex = path.join(sourceHome, '.codex');
  const laneHome = await fs.mkdtemp(path.join(tmpDir, 'cs-k-lane-home-'));
  await fs.chmod(laneHome, 0o700);
  await fs.symlink(sourceCodex, path.join(laneHome, '.codex'));
  return laneHome;
}

function laneEnv({ codexPath, home, tmpDir }) {
  const pathValue = uniquePathEntries([
    ...BASE_LANE_PATH.split(path.delimiter),
    path.dirname(process.execPath),
    path.dirname(codexPath),
  ]).join(path.delimiter);
  return {
    HOME: home,
    PATH: pathValue,
    TMPDIR: tmpDir,
  };
}

function uniquePathEntries(entries) {
  return [...new Set(entries.filter(Boolean))];
}

function attachSpawnErrorLogger(child, logPath) {
  if (typeof child?.once !== 'function') return;
  child.once('error', (error) => {
    const message = optionalString(error?.message) ?? String(error ?? 'spawn error');
    fs.appendFile(logPath, `\n[build-lane spawn error] ${message}\n`, 'utf8').catch(() => {});
  });
}

function observeChildExit(child) {
  if (typeof child?.once !== 'function') return null;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (event, code, signal) => {
      if (settled) return;
      settled = true;
      resolve({
        event,
        code: code === undefined ? null : code,
        signal: signal === undefined ? null : signal,
        observedAt: new Date(),
      });
    };

    child.once('exit', (code, signal) => finish('exit', code, signal));
    child.once('close', (code, signal) => finish('close', code, signal));
  });
}

async function recordLaneExitWhenObserved(options = {}) {
  const observed = await options.exitObservation;
  if (!observed) return null;
  const store = options.store;
  if (!store || typeof store.loadLane !== 'function' || typeof store.saveLane !== 'function') return null;

  const original = options.lane ?? {};
  const current = await store.loadLane(original.id);
  if (!current || !sameProcessIdentity(current, original)) return null;

  const timestamp = iso(observed.observedAt ?? new Date());
  const exitSignal = optionalString(observed.signal);
  const updated = await store.saveLane({
    ...current,
    done: true,
    settled: true,
    exitCode: observed.code,
    exitSignal: exitSignal ?? null,
    finishedAt: current.finishedAt ?? timestamp,
    exitObservedAt: timestamp,
    completionReason: current.completionReason ?? 'process-exit',
    exitObserved: true,
    updatedAt: timestamp,
  });

  await store.appendHistory?.({
    kind: 'build.lane.done',
    planId: updated.planId ?? null,
    unitId: updated.unitId,
    laneId: updated.id,
    reason: 'process-exit',
    exitCode: observed.code,
    exitSignal: exitSignal ?? null,
    at: timestamp,
  });

  return updated;
}

async function defaultResetWorktree({ lane }) {
  const repoRoot = optionalString(lane?.repoRoot);
  const baseSha = optionalString(lane?.baseSha);
  if (!repoRoot || !baseSha) {
    return {
      ok: false,
      reason: 'missing-repo-root-or-base-sha',
    };
  }

  await laneWorktreeRemove({
    repoRoot,
    laneId: lane.id,
    force: true,
  });
  return laneWorktreeAdd({
    repoRoot,
    laneId: lane.id,
    baseSha,
  });
}

function statfsFreeBytes(stats) {
  const direct = firstFiniteNumber(stats?.availableBytes, stats?.freeBytes);
  if (direct !== null) return direct;

  const blockSize = firstFiniteNumber(stats?.bsize, stats?.frsize, stats?.blockSize);
  const availableBlocks = firstFiniteNumber(stats?.bavail, stats?.bfree, stats?.availableBlocks, stats?.freeBlocks);
  if (blockSize !== null && availableBlocks !== null) return blockSize * availableBlocks;

  throw new Error('statfs result did not include free byte data');
}

function logSizeFrom(readLogSize, lane) {
  if (typeof readLogSize === 'function') return normalizeNullableNumber(readLogSize(lane), 'readLogSize');
  return normalizeNullableNumber(readLogSize, 'readLogSize');
}

function logInfoFrom(options, lane) {
  if (typeof options.readLogInfo === 'function') return options.readLogInfo(lane);
  if (isPlainLogInfo(options.readLogInfo)) return options.readLogInfo;
  const size = typeof options.readLogSize === 'function'
    ? options.readLogSize(lane)
    : options.readLogSize;
  if (size !== undefined && size !== null) return { size: normalizeNullableNumber(size, 'readLogSize') };
  return readLogInfo(lane);
}

function logTailFrom(options, lane) {
  const tailOptions = {
    bytes: positiveInteger(options.logTailBytes ?? options.tailBytes, CODEX_COMPLETION_LOG_TAIL_BYTES),
  };
  const value = typeof options.readLogTail === 'function'
    ? options.readLogTail(lane, tailOptions)
    : options.readLogTail;
  if (typeof value === 'string') return value;
  if (value && typeof value.text === 'string') return value.text;
  return readLogTail(lane, tailOptions);
}

function logQuiescent({ lane, logInfo, monotonicNow, now, quiescentMs }) {
  const mtimeMs = firstFiniteNumber(logInfo?.mtimeMs, logInfo?.mtime);
  if (mtimeMs !== null && now.getTime() - mtimeMs > quiescentMs) return true;

  const size = firstFiniteNumber(logInfo?.size);
  const previousSize = firstFiniteNumber(
    lane.lastLogSize,
    lane.watchdog?.lastLogSize,
    lane.logSize,
  );
  const lastChangedAt = firstFiniteNumber(
    lane.lastLogChangeAt,
    lane.lastLogChangedAt,
    lane.watchdog?.lastLogChangeAt,
    lane.watchdog?.lastLogChangedAt,
    lane.watchdog?.baselineAt,
  );

  return size !== null &&
    previousSize !== null &&
    size === previousSize &&
    lastChangedAt !== null &&
    monotonicNow !== null &&
    monotonicNow - lastChangedAt > quiescentMs;
}

function logPathFrom(lane) {
  if (typeof lane === 'string') return path.resolve(lane);
  const raw = optionalString(lane?.logPath);
  return raw ? path.resolve(raw) : null;
}

function isPlainLogInfo(value) {
  return value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value.size !== undefined || value.mtimeMs !== undefined || value.mtime !== undefined);
}

function sameProcessIdentity(current, original) {
  try {
    if (normalizePid(current.pid) !== normalizePid(original.pid)) return false;
  } catch {
    return false;
  }
  if (original.startTime !== null && original.startTime !== undefined) {
    return current.startTime === original.startTime;
  }
  return true;
}

function laneCompleted(lane) {
  return Boolean(
    lane?.done === true ||
    lane?.settled === true ||
    lane?.finishedAt ||
    lane?.exitCode !== undefined ||
    lane?.exitSignal !== undefined,
  );
}

function stripAnsi(value) {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function hasProcessIdentity(lane) {
  return normalizePid(lane.pid) !== null && lane.startTime !== null && lane.startTime !== undefined;
}

function requiredStore(store) {
  if (!store || typeof store.saveLane !== 'function') throw new Error('store with saveLane is required');
  if (typeof store.listLanes !== 'function' && typeof store.loadLane !== 'function') {
    throw new Error('store with lane APIs is required');
  }
  return store;
}

function assertLanePart(value, label) {
  const text = requiredString(value, label);
  if (!LANE_ID_PATTERN.test(text)) throw new Error(`invalid ${label}: ${value}`);
  return text;
}

function assertAbsolutePath(value, label) {
  const text = requiredString(value, label);
  if (!path.isAbsolute(text)) throw new Error(`${label} must be absolute`);
  return path.resolve(text);
}

function normalizeNow(value) {
  if (typeof value === 'function') return normalizeNow(value());
  if (value === undefined || value === null) return new Date();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`invalid now: ${value}`);
  return date;
}

function normalizePid(value) {
  if (value === undefined || value === null) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`invalid pid: ${value}`);
  return number;
}

function normalizeMonotonicNow(value) {
  const raw = typeof value === 'function' ? value() : value;
  const number = Number(raw);
  if (!Number.isFinite(number)) throw new Error(`invalid monotonicNow: ${value}`);
  return number;
}

function normalizeNullableNumber(value, label) {
  if (value === undefined || value === null) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`invalid ${label}: ${value}`);
  return number;
}

function optionalFiniteNumber(value) {
  if (value === undefined || value === null) return null;
  const raw = typeof value === 'function' ? value() : value;
  const number = Number(raw);
  return Number.isFinite(number) ? number : null;
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function positiveInteger(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}
