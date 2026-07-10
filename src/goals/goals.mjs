import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  ROOT,
  safeDataPath,
  writeUniqueDataJson,
} from '../../daemon/run.mjs';
import { requiredString } from '../substrate.mjs';

export const GOAL_STATUSES = Object.freeze([
  'active',
  'paused',
  'blocked',
  'usage_limited',
  'budget_limited',
  'complete',
]);

const DEFAULT_DATA_DIR = path.join(ROOT, 'data');
const GOALS_DIR = 'goals';
const GOAL_SHAPE = Object.freeze([
  'goalId',
  'objective',
  'status',
  'tokenBudget',
  'tokensUsed',
  'timeUsedSeconds',
  'state',
  'createdAtMs',
  'updatedAtMs',
]);

export async function createGoal(objective, options = {}) {
  const dataDir = resolveDataDir(options.dataDir);
  const nowMs = timestampMs(options.now);
  const state = initialGoalState(options);
  const goal = {
    goalId: randomUUID(),
    objective: requiredString(objective, 'objective'),
    status: 'active',
    tokenBudget: nonNegativeInteger(options.tokenBudget ?? 0, 'tokenBudget'),
    tokensUsed: 0,
    timeUsedSeconds: 0,
    state,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  };

  await writeGoalSnapshot(goal, { dataDir });
  return goal;
}

export async function recordProgress(goalId, progress = {}) {
  const dataDir = resolveGoalDataDir(goalId, progress);
  const current = await mustReadGoal(goalId, { dataDir });
  const updatedAtMs = nextTimestampMs(progress.now, current.updatedAtMs);
  const next = {
    ...current,
    tokensUsed: current.tokensUsed + nonNegativeInteger(progress.tokens ?? 0, 'tokens'),
    timeUsedSeconds: current.timeUsedSeconds + nonNegativeNumber(progress.seconds ?? 0, 'seconds'),
    state: mergeState(current.state, normalizeState(progress.state ?? {})),
    updatedAtMs,
  };

  await writeGoalSnapshot(next, { dataDir });
  return next;
}

export async function judgeGoal(goalId, options = {}) {
  const dataDir = resolveGoalDataDir(goalId, options);
  const current = await mustReadGoal(goalId, { dataDir });
  const status = judgeStatus(current);
  const next = {
    ...current,
    status,
    updatedAtMs: nextTimestampMs(options.now, current.updatedAtMs),
  };

  await writeGoalSnapshot(next, { dataDir });
  return next.status;
}

export async function tickDownGoal(goalId, options = {}) {
  const dataDir = resolveGoalDataDir(goalId, options);
  const current = await mustReadGoal(goalId, { dataDir });
  const turns = nonNegativeInteger(options.turns ?? 1, 'turns');
  const updatedAtMs = nextTimestampMs(options.now, current.updatedAtMs);
  const state = tickDownState(current.state, turns);
  const next = {
    ...current,
    state,
    status: judgeStatus({ ...current, state }),
    updatedAtMs,
  };

  await writeGoalSnapshot(next, { dataDir });
  return next;
}

export async function completeGoal(goalId, options = {}) {
  const dataDir = resolveGoalDataDir(goalId, options);
  const current = await mustReadGoal(goalId, { dataDir });
  const next = {
    ...current,
    status: 'complete',
    state: {
      ...current.state,
      done: true,
      ...(options.completedAtMs !== undefined
        ? { completedAtMs: nonNegativeInteger(options.completedAtMs, 'completedAtMs') }
        : {}),
    },
    updatedAtMs: nextTimestampMs(options.now, current.updatedAtMs),
  };

  await writeGoalSnapshot(next, { dataDir });
  return next;
}

export async function readGoal(goalId, options = {}) {
  const normalizedGoalId = requiredString(goalId, 'goalId');
  const dataDir = resolveGoalDataDir(normalizedGoalId, options);
  const snapshots = await readGoalSnapshots(dataDir);
  const latest = latestSnapshot(
    snapshots
      .filter(({ goal }) => goal.goalId === normalizedGoalId)
      .map(({ goal, fileName }) => ({ goal, fileName })),
  );
  if (!latest) return null;
  return latest.goal;
}

export async function listGoals(status, options = {}) {
  let statusFilter = status;
  let listOptions = options;
  if (isPlainObject(status) && !GOAL_STATUSES.includes(status.status)) {
    statusFilter = undefined;
    listOptions = status;
  }

  const normalizedStatus =
    statusFilter === undefined || statusFilter === null ? undefined : assertStatus(statusFilter);
  const dataDir = resolveDataDir(listOptions.dataDir);
  const snapshots = await readGoalSnapshots(dataDir);
  const byGoalId = new Map();

  for (const snapshot of snapshots) {
    const current = byGoalId.get(snapshot.goal.goalId);
    if (!current || compareSnapshots(snapshot, current) > 0) {
      byGoalId.set(snapshot.goal.goalId, snapshot);
    }
  }

  return [...byGoalId.values()]
    .map(({ goal }) => goal)
    .filter((goal) => !normalizedStatus || goal.status === normalizedStatus)
    .sort(compareGoals);
}

export async function listOpenGoals(options = {}) {
  const limit = positiveInteger(options.limit ?? 8, 'limit');
  const goals = await listGoals(undefined, options);
  return goals
    .filter((goal) => goal.status !== 'complete')
    .slice(0, limit);
}

function judgeStatus(goal) {
  if (goal.state.done === true) return 'complete';
  if (hasBlockSignal(goal.state)) return 'blocked';
  if (goal.tokenBudget > 0 && goal.tokensUsed >= goal.tokenBudget) return 'budget_limited';
  if (goal.state.turnBudget > 0 && goal.state.turnsRemaining <= 0) return 'budget_limited';
  return 'active';
}

function hasBlockSignal(state) {
  return (
    state.blocked === true ||
    state.block === true ||
    state.blockSignal === true ||
    Boolean(state.blockedReason) ||
    Boolean(state.blockReason)
  );
}

async function mustReadGoal(goalId, options) {
  const goal = await readGoal(goalId, options);
  if (!goal) throw new Error(`goal not found: ${goalId}`);
  return goal;
}

async function writeGoalSnapshot(goal, { dataDir }) {
  const normalized = normalizeGoal(goal);
  const baseName = `${normalized.updatedAtMs}-${normalized.goalId}`;
  await writeUniqueDataJson(dataDir, GOALS_DIR, baseName, normalized);
  return normalized;
}

async function readGoalSnapshots(dataDir) {
  const dir = safeDataPath(dataDir, GOALS_DIR);
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const snapshots = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = safeDataPath(dataDir, path.join(GOALS_DIR, entry.name));
    const goal = normalizeGoal(JSON.parse(await fs.readFile(file, 'utf8')));
    snapshots.push({ goal, fileName: entry.name });
  }
  return snapshots;
}

function normalizeGoal(value) {
  if (!isPlainObject(value)) {
    throw new Error('goal must be an object');
  }

  const extraKeys = Object.keys(value).filter((key) => !GOAL_SHAPE.includes(key));
  if (extraKeys.length) {
    throw new Error(`invalid goal fields: ${extraKeys.join(', ')}`);
  }

  return {
    goalId: requiredString(value.goalId, 'goalId'),
    objective: requiredString(value.objective, 'objective'),
    status: assertStatus(value.status),
    tokenBudget: nonNegativeInteger(value.tokenBudget ?? 0, 'tokenBudget'),
    tokensUsed: nonNegativeInteger(value.tokensUsed, 'tokensUsed'),
    timeUsedSeconds: nonNegativeNumber(value.timeUsedSeconds, 'timeUsedSeconds'),
    state: normalizeState(value.state),
    createdAtMs: nonNegativeInteger(value.createdAtMs, 'createdAtMs'),
    updatedAtMs: nonNegativeInteger(value.updatedAtMs, 'updatedAtMs'),
  };
}

function normalizeState(value) {
  if (!isPlainObject(value)) {
    throw new Error('state must be an object');
  }
  return jsonClone(value, 'state');
}

function initialGoalState(options) {
  const base = normalizeState(options.state ?? {});
  const turnBudget = nonNegativeInteger(options.turnBudget ?? base.turnBudget ?? 0, 'turnBudget');
  if (turnBudget <= 0) return base;

  const turnsUsed = nonNegativeInteger(base.turnsUsed ?? 0, 'turnsUsed');
  const turnsRemaining = nonNegativeInteger(
    base.turnsRemaining ?? Math.max(0, turnBudget - turnsUsed),
    'turnsRemaining',
  );
  return {
    ...base,
    turnBudget,
    turnsUsed,
    turnsRemaining,
  };
}

function tickDownState(currentState, turns) {
  const state = normalizeState(currentState);
  const turnBudget = nonNegativeInteger(state.turnBudget ?? 0, 'turnBudget');
  const turnsUsed = nonNegativeInteger(state.turnsUsed ?? 0, 'turnsUsed') + turns;

  if (turnBudget <= 0) {
    return {
      ...state,
      turnsUsed,
    };
  }

  const currentRemaining = nonNegativeInteger(
    state.turnsRemaining ?? Math.max(0, turnBudget - nonNegativeInteger(state.turnsUsed ?? 0, 'turnsUsed')),
    'turnsRemaining',
  );
  const turnsRemaining = Math.max(0, currentRemaining - turns);
  return {
    ...state,
    turnBudget,
    turnsUsed,
    turnsRemaining,
  };
}

function mergeState(current, incoming) {
  const merged = { ...current };
  for (const [key, value] of Object.entries(incoming)) {
    if (isPlainObject(value) && isPlainObject(merged[key])) {
      merged[key] = mergeState(merged[key], value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function latestSnapshot(snapshots) {
  return snapshots.reduce((latest, candidate) => {
    if (!latest || compareSnapshots(candidate, latest) > 0) return candidate;
    return latest;
  }, null);
}

function compareSnapshots(a, b) {
  return (
    a.goal.updatedAtMs - b.goal.updatedAtMs ||
    a.goal.createdAtMs - b.goal.createdAtMs ||
    a.fileName.localeCompare(b.fileName)
  );
}

function compareGoals(a, b) {
  return a.createdAtMs - b.createdAtMs || a.goalId.localeCompare(b.goalId);
}

function resolveGoalDataDir(goalId, options = {}) {
  if (options.dataDir) return resolveDataDir(options.dataDir);
  requiredString(goalId, 'goalId');
  return resolveDataDir();
}

function resolveDataDir(dataDir) {
  return path.resolve(dataDir ?? process.env.CS_K_DATA_DIR ?? DEFAULT_DATA_DIR);
}

function nextTimestampMs(now, previousMs) {
  const current = timestampMs(now);
  return current > previousMs ? current : previousMs + 1;
}

function timestampMs(now) {
  const value = typeof now === 'function' ? now() : now;
  const date = value === undefined ? new Date() : value instanceof Date ? value : new Date(value);
  const ms = date.getTime();
  if (!Number.isFinite(ms)) throw new Error('now must be a valid date');
  return ms;
}

function nonNegativeInteger(value, field) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return number;
}

function positiveInteger(value, field) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return number;
}

function nonNegativeNumber(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`${field} must be a non-negative number`);
  }
  return number;
}

function assertStatus(value) {
  const status = requiredString(value, 'status');
  if (!GOAL_STATUSES.includes(status)) {
    throw new Error(`invalid goal status: ${value}`);
  }
  return status;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function jsonClone(value, field) {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error('not serializable');
    return JSON.parse(serialized);
  } catch {
    throw new Error(`${field} must be JSON-serializable`);
  }
}
