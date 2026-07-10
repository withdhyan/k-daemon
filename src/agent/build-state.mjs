import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  iso,
  safeDataPath,
} from '../../daemon/run.mjs';
import {
  isPlainObject,
  optionalString,
} from '../substrate.mjs';
import { atomicWriteJson } from './routines.mjs';

export const BUILD_DIR = 'build';
export const BUILD_PLANS_DIR = path.join(BUILD_DIR, 'plans');
export const BUILD_LANES_DIR = path.join(BUILD_DIR, 'lanes');
export const BUILD_HISTORY_FILE = path.join(BUILD_DIR, 'history.jsonl');
export const BUILD_HISTORY_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_LEASE_TTL_MS = 10 * 60 * 1000;

export const BUILD_STATE_QUEUED = 'queued';
export const BUILD_STATE_BUILDING = 'building';
export const BUILD_STATE_VERIFYING = 'verifying';
export const BUILD_STATE_INTEGRATING = 'integrating';
export const BUILD_STATE_INTEGRATED = 'integrated';
export const BUILD_STATE_DEPLOYING = 'deploying';
export const BUILD_STATE_DEPLOYED = 'deployed';
export const BUILD_STATE_ROLLED_BACK = 'rolled-back';
export const BUILD_STATE_HELD = 'held';
export const BUILD_STATE_QUARANTINED = 'quarantined';
export const BUILD_STATE_KILLED = 'killed';
export const BUILD_STATE_ORPHANED = 'orphaned';
export const BUILD_STATE_CANCELLED = 'cancelled';
export const BUILD_STATE_FAILED = 'failed';

export const BUILD_STATES = Object.freeze([
  BUILD_STATE_QUEUED,
  BUILD_STATE_BUILDING,
  BUILD_STATE_VERIFYING,
  BUILD_STATE_INTEGRATING,
  BUILD_STATE_INTEGRATED,
  BUILD_STATE_DEPLOYING,
  BUILD_STATE_DEPLOYED,
  BUILD_STATE_ROLLED_BACK,
  BUILD_STATE_HELD,
  BUILD_STATE_QUARANTINED,
  BUILD_STATE_KILLED,
  BUILD_STATE_ORPHANED,
  BUILD_STATE_CANCELLED,
  BUILD_STATE_FAILED,
]);

export const TRANSITIONS = freezeTransitionMap({
  [BUILD_STATE_QUEUED]: [
    BUILD_STATE_BUILDING,
    BUILD_STATE_HELD,
    BUILD_STATE_CANCELLED,
  ],
  [BUILD_STATE_BUILDING]: [
    BUILD_STATE_VERIFYING,
    BUILD_STATE_HELD,
    BUILD_STATE_KILLED,
    BUILD_STATE_ORPHANED,
    BUILD_STATE_CANCELLED,
    BUILD_STATE_FAILED,
  ],
  [BUILD_STATE_VERIFYING]: [
    BUILD_STATE_INTEGRATING,
    BUILD_STATE_HELD,
    BUILD_STATE_CANCELLED,
    BUILD_STATE_FAILED,
  ],
  [BUILD_STATE_INTEGRATING]: [
    BUILD_STATE_INTEGRATED,
    BUILD_STATE_DEPLOYING,
    BUILD_STATE_HELD,
    BUILD_STATE_FAILED,
  ],
  [BUILD_STATE_INTEGRATED]: [
    BUILD_STATE_HELD,
  ],
  [BUILD_STATE_DEPLOYING]: [
    BUILD_STATE_DEPLOYED,
    BUILD_STATE_ROLLED_BACK,
    BUILD_STATE_HELD,
    BUILD_STATE_FAILED,
  ],
  [BUILD_STATE_DEPLOYED]: [],
  [BUILD_STATE_ROLLED_BACK]: [
    BUILD_STATE_HELD,
  ],
  [BUILD_STATE_HELD]: [
    BUILD_STATE_BUILDING,
    BUILD_STATE_VERIFYING,
    BUILD_STATE_INTEGRATING,
    BUILD_STATE_ORPHANED,
    BUILD_STATE_CANCELLED,
    BUILD_STATE_QUARANTINED,
    BUILD_STATE_KILLED,
    BUILD_STATE_FAILED,
  ],
  [BUILD_STATE_QUARANTINED]: [],
  [BUILD_STATE_KILLED]: [],
  [BUILD_STATE_ORPHANED]: [
    BUILD_STATE_BUILDING,
    BUILD_STATE_HELD,
    BUILD_STATE_KILLED,
    BUILD_STATE_QUARANTINED,
    BUILD_STATE_FAILED,
  ],
  [BUILD_STATE_CANCELLED]: [],
  [BUILD_STATE_FAILED]: [
    BUILD_STATE_HELD,
    BUILD_STATE_QUARANTINED,
  ],
});

export const FOUNDER_ACTOR = 'founder';
export const FOUNDER_OVERRIDE_STATES = Object.freeze([
  BUILD_STATE_HELD,
  BUILD_STATE_KILLED,
  BUILD_STATE_CANCELLED,
  BUILD_STATE_QUARANTINED,
  BUILD_STATE_ORPHANED,
  BUILD_STATE_ROLLED_BACK,
]);

const BUILD_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const CHECKPOINT_PATTERN = /^[a-f0-9]{7,64}$/i;

export class BuildStateError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = this.constructor.name;
    if (options.code) this.code = options.code;
  }
}

export class TransitionError extends BuildStateError {}

export class OwnershipError extends BuildStateError {}

export function createBuildStateStore(options = {}) {
  return new BuildStateStore(options);
}

export class BuildStateStore {
  #leaseChecks = new Map();

  constructor(options = {}) {
    this.dataDir = path.resolve(options.dataDir ?? path.join(process.cwd(), 'data'));
    this.now = options.now ?? (() => new Date());
    this.monotonicNow = options.monotonicNow ?? (() => Date.now());
    this.leaseMonotonicJumpMs = finiteNonNegative(options.leaseMonotonicJumpMs);
    this.historyMaxBytes = finitePositive(options.historyMaxBytes) ?? BUILD_HISTORY_MAX_BYTES;
    this.fsImpl = options.fsImpl ?? fs;
  }

  planPath(planId) {
    return planSnapshotPath(this.dataDir, planId);
  }

  lanePath(laneId) {
    return laneSnapshotPath(this.dataDir, laneId);
  }

  async savePlan(plan) {
    const normalized = normalizePlanRecord(plan, { now: this.now() });
    await atomicWriteJson(this.planPath(normalized.id), normalized);
    return cloneRecord(normalized);
  }

  async createPlan(input) {
    const plan = normalizePlanRecord(input, { now: this.now() });
    await this.savePlan(plan);
    return cloneRecord(plan);
  }

  async loadPlan(planId) {
    const file = this.planPath(planId);
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
      return normalizePlanRecord(parsed, { now: this.now() });
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async listPlans() {
    const dir = safeDataPath(this.dataDir, BUILD_PLANS_DIR);
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    const plans = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const id = entry.name.slice(0, -'.json'.length);
      plans.push(await this.loadPlan(id));
    }
    return plans.filter(Boolean).sort((left, right) => left.id.localeCompare(right.id));
  }

  async saveLane(lane) {
    const normalized = normalizeLaneRecord(lane, { now: this.now() });
    await atomicWriteJson(this.lanePath(normalized.id), normalized);
    return cloneRecord(normalized);
  }

  async loadLane(laneId) {
    const file = this.lanePath(laneId);
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
      return normalizeLaneRecord(parsed, { now: this.now() });
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async listLanes() {
    const dir = safeDataPath(this.dataDir, BUILD_LANES_DIR);
    let entries = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    const lanes = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const id = entry.name.slice(0, -'.json'.length);
      lanes.push(await this.loadLane(id));
    }
    return lanes.filter(Boolean).sort((left, right) => left.id.localeCompare(right.id));
  }

  async transition(input = {}) {
    const planId = assertBuildId(input.planId, 'planId');
    const to = assertBuildState(input.to, 'to');
    const actor = assertActor(input.actor);
    const plan = await this.#loadRequiredPlan(planId);
    const unitId = optionalString(input.unitId);
    const now = input.now ?? this.now();
    const previous = unitId ? unitById(plan, unitId) : plan;
    const from = assertBuildState(previous.state ?? previous.status, unitId ? 'unit.state' : 'plan.status');

    await this.#assertWriter(plan, {
      actor,
      to,
      now,
      monotonicNow: input.monotonicNow,
    });
    assertLegalTransition(from, to);

    const timestamp = iso(now);
    if (unitId) {
      const index = plan.units.findIndex((unit) => unit.id === unitId);
      plan.units[index] = {
        ...plan.units[index],
        state: to,
        updatedAt: timestamp,
        ...(input.laneId ? { laneId: assertBuildId(input.laneId, 'laneId') } : {}),
        ...(input.checkpointSha ? { checkpointSha: normalizeCheckpointSha(input.checkpointSha) } : {}),
      };
    } else {
      plan.status = to;
    }
    plan.updatedAt = timestamp;
    await this.savePlan(plan);

    const history = await this.appendHistory({
      kind: 'build.transition',
      planId,
      ...(unitId ? { unitId } : {}),
      actor,
      from,
      to,
      at: timestamp,
      reason: optionalString(input.reason) ?? null,
    });

    return {
      ok: history.ok,
      plan: await this.loadPlan(planId),
      history,
    };
  }

  async acquirePlanLease(planId, input = {}) {
    const plan = await this.#loadRequiredPlan(planId);
    const actor = assertActor(input.actor);
    const now = input.now ?? this.now();
    const ttlMs = normalizeTtlMs(input.ttlMs ?? plan.lease?.ttlMs ?? DEFAULT_LEASE_TTL_MS);

    if (plan.lease && !this.leaseExpired(plan, { now, monotonicNow: input.monotonicNow })) {
      if (plan.lease.owner === actor) return this.renewPlanLease(planId, { ...input, ttlMs });
      throw new OwnershipError(`plan lease is held by ${plan.lease.owner}`, { code: 'lease_held' });
    }

    const timestamp = iso(now);
    plan.lease = {
      owner: actor,
      acquiredAt: timestamp,
      renewedAt: timestamp,
      ttlMs,
    };
    plan.updatedAt = timestamp;
    this.#recordLeaseCheck(plan.id, now, input.monotonicNow);
    await this.savePlan(plan);

    const history = await this.appendHistory({
      kind: 'build.lease.acquired',
      planId: plan.id,
      actor,
      owner: actor,
      ttlMs,
      at: timestamp,
    });
    return { ok: history.ok, plan: await this.loadPlan(plan.id), history };
  }

  async renewPlanLease(planId, input = {}) {
    const plan = await this.#loadRequiredPlan(planId);
    const actor = assertActor(input.actor);
    const now = input.now ?? this.now();
    const ttlMs = input.ttlMs === undefined
      ? normalizeTtlMs(plan.lease?.ttlMs ?? DEFAULT_LEASE_TTL_MS)
      : normalizeTtlMs(input.ttlMs);

    await this.#assertWriter(plan, {
      actor,
      to: null,
      now,
      monotonicNow: input.monotonicNow,
      allowFounderOverride: false,
    });

    const timestamp = iso(now);
    plan.lease = {
      owner: actor,
      acquiredAt: plan.lease?.acquiredAt ?? timestamp,
      renewedAt: timestamp,
      ttlMs,
    };
    plan.updatedAt = timestamp;
    this.#recordLeaseCheck(plan.id, now, input.monotonicNow);
    await this.savePlan(plan);

    const history = await this.appendHistory({
      kind: 'build.lease.renewed',
      planId: plan.id,
      actor,
      owner: actor,
      ttlMs,
      at: timestamp,
    });
    return { ok: history.ok, plan: await this.loadPlan(plan.id), history };
  }

  async releasePlanLease(planId, input = {}) {
    const plan = await this.#loadRequiredPlan(planId);
    const actor = assertActor(input.actor);
    const now = input.now ?? this.now();

    await this.#assertWriter(plan, {
      actor,
      to: null,
      now,
      monotonicNow: input.monotonicNow,
      allowFounderOverride: false,
    });

    const previousOwner = plan.lease?.owner ?? null;
    const timestamp = iso(now);
    plan.lease = null;
    plan.updatedAt = timestamp;
    this.#leaseChecks.delete(plan.id);
    await this.savePlan(plan);

    const history = await this.appendHistory({
      kind: 'build.lease.released',
      planId: plan.id,
      actor,
      previousOwner,
      at: timestamp,
    });
    return { ok: history.ok, plan: await this.loadPlan(plan.id), history };
  }

  async adoptPlanLease(planId, input = {}) {
    const plan = await this.#loadRequiredPlan(planId);
    const actor = assertActor(input.actor);
    const now = input.now ?? this.now();
    const ttlMs = normalizeTtlMs(input.ttlMs ?? plan.lease?.ttlMs ?? DEFAULT_LEASE_TTL_MS);
    const previousOwner = plan.lease?.owner ?? null;

    if (plan.lease && !this.leaseExpired(plan, { now, monotonicNow: input.monotonicNow })) {
      if (plan.lease.owner === actor) return this.renewPlanLease(planId, { ...input, ttlMs });
      throw new OwnershipError(`plan lease is still live for ${plan.lease.owner}`, { code: 'lease_live' });
    }
    if (previousOwner && hasUnitInState(plan, BUILD_STATE_INTEGRATING)) {
      throw new OwnershipError('cannot adopt plan lease while a unit is integrating', {
        code: 'lease_transfer_mid_integrate',
      });
    }

    const timestamp = iso(now);
    plan.lease = {
      owner: actor,
      acquiredAt: timestamp,
      renewedAt: timestamp,
      ttlMs,
    };
    plan.updatedAt = timestamp;
    this.#recordLeaseCheck(plan.id, now, input.monotonicNow);
    await this.savePlan(plan);

    const history = await this.appendHistory({
      kind: 'build.lease.adopted',
      planId: plan.id,
      actor,
      previousOwner,
      owner: actor,
      ttlMs,
      at: timestamp,
    });
    return { ok: history.ok, plan: await this.loadPlan(plan.id), history };
  }

  async appendHistory(event) {
    return appendHistory(event, {
      dataDir: this.dataDir,
      now: this.now,
      maxBytes: this.historyMaxBytes,
      fsImpl: this.fsImpl,
    });
  }

  async recordCardEvent(event = {}) {
    return this.appendHistory({
      ...event,
      kind: optionalString(event.kind) ?? 'build.card',
    });
  }

  async isLeaseExpired(planOrId, input = {}) {
    const plan = typeof planOrId === 'string'
      ? await this.#loadRequiredPlan(planOrId)
      : normalizePlanRecord(planOrId, { now: this.now() });
    return this.leaseExpired(plan, input);
  }

  leaseExpired(plan, input = {}) {
    const lease = normalizeLease(plan?.lease);
    if (!lease) return true;

    const now = input.now ?? this.now();
    const nowMs = dateMs(now, 'now');
    const monotonicMs = normalizeMonotonicMs(input.monotonicNow, this.monotonicNow);
    const baseline = this.#leaseChecks.get(plan.id);
    const persistedRenewedAtMs = dateMs(lease.renewedAt ?? lease.acquiredAt, 'lease.renewedAt');
    let effectiveRenewedAtMs = Math.max(persistedRenewedAtMs, baseline?.renewedAtMs ?? persistedRenewedAtMs);
    if (baseline && monotonicMs !== null) {
      const delta = monotonicMs - baseline.monotonicMs;
      const jumpMs = this.leaseMonotonicJumpMs ?? Math.max(lease.ttlMs * 4, 60_000);
      if (delta > jumpMs) {
        effectiveRenewedAtMs = nowMs;
        this.#leaseChecks.set(plan.id, { wallMs: nowMs, monotonicMs, renewedAtMs: effectiveRenewedAtMs });
        return false;
      }
    }

    if (monotonicMs !== null) {
      this.#leaseChecks.set(plan.id, { wallMs: nowMs, monotonicMs, renewedAtMs: effectiveRenewedAtMs });
    }

    return nowMs - effectiveRenewedAtMs > lease.ttlMs;
  }

  async #loadRequiredPlan(planId) {
    const plan = await this.loadPlan(planId);
    if (!plan) throw new BuildStateError(`plan not found: ${planId}`, { code: 'plan_not_found' });
    return plan;
  }

  async #assertWriter(plan, input) {
    const actor = assertActor(input.actor);
    const allowFounderOverride = input.allowFounderOverride !== false;
    if (
      allowFounderOverride &&
      actor === FOUNDER_ACTOR &&
      input.to &&
      FOUNDER_OVERRIDE_STATES.includes(input.to)
    ) {
      return;
    }

    const lease = normalizeLease(plan.lease);
    if (!lease) throw new OwnershipError(`plan has no live lease: ${plan.id}`, { code: 'lease_missing' });
    if (this.leaseExpired(plan, input)) {
      throw new OwnershipError(`plan lease expired for ${lease.owner}`, { code: 'lease_expired' });
    }
    if (lease.owner !== actor) {
      throw new OwnershipError(`plan lease is held by ${lease.owner}`, { code: 'lease_not_owner' });
    }
  }

  #recordLeaseCheck(planId, now, monotonicNow) {
    const monotonicMs = normalizeMonotonicMs(monotonicNow, this.monotonicNow);
    if (monotonicMs === null) return;
    this.#leaseChecks.set(planId, {
      wallMs: dateMs(now, 'now'),
      monotonicMs,
      renewedAtMs: dateMs(now, 'now'),
    });
  }
}

export async function appendHistory(event, options = {}) {
  const dataDir = path.resolve(options.dataDir ?? path.join(process.cwd(), 'data'));
  const maxBytes = finitePositive(options.maxBytes) ?? BUILD_HISTORY_MAX_BYTES;
  const fsImpl = options.fsImpl ?? fs;
  const now = options.now ?? (() => new Date());

  try {
    const dir = safeDataPath(dataDir, BUILD_DIR);
    await fsImpl.mkdir(dir, { recursive: true });
    const line = `${JSON.stringify(normalizeHistoryEvent(event, now))}\n`;
    const file = safeDataPath(dataDir, BUILD_HISTORY_FILE);
    await rotateHistoryIfNeeded(file, Buffer.byteLength(line, 'utf8'), {
      maxBytes,
      fsImpl,
    });
    await fsImpl.appendFile(file, line, { encoding: 'utf8', flag: 'a' });
    return { ok: true, path: file };
  } catch (error) {
    return {
      ok: false,
      errorCode: optionalString(error?.code) ?? 'history_append_failed',
      error: optionalString(error?.message) ?? 'history append failed',
    };
  }
}

export async function readHistory(options = {}) {
  const dataDir = path.resolve(options.dataDir ?? path.join(process.cwd(), 'data'));
  const limit = boundedLimit(options.limit ?? 100);
  if (limit === 0) return [];

  const file = safeDataPath(dataDir, BUILD_HISTORY_FILE);
  const lines = [];
  for (const candidate of [`${file}.1`, file]) {
    const text = await readOptionalText(candidate);
    if (!text) continue;
    lines.push(...text.split('\n').filter(Boolean));
  }

  const records = [];
  for (const line of lines.slice(-limit * 2)) {
    try {
      records.push(JSON.parse(line));
    } catch {
      // Keep tailing around a corrupt or partial line.
    }
  }
  return records.slice(-limit);
}

export function planSnapshotPath(dataDir, planId) {
  return safeDataPath(dataDir, path.join(BUILD_PLANS_DIR, `${assertBuildId(planId, 'planId')}.json`));
}

export function laneSnapshotPath(dataDir, laneId) {
  return safeDataPath(dataDir, path.join(BUILD_LANES_DIR, `${assertBuildId(laneId, 'laneId')}.json`));
}

export function canTransition(from, to) {
  const source = assertBuildState(from, 'from');
  const target = assertBuildState(to, 'to');
  return TRANSITIONS[source].includes(target);
}

export function assertLegalTransition(from, to) {
  const source = assertBuildState(from, 'from');
  const target = assertBuildState(to, 'to');
  if (!TRANSITIONS[source].includes(target)) {
    throw new TransitionError(`illegal build-state transition: ${source} -> ${target}`, {
      code: 'illegal_transition',
    });
  }
  return true;
}

export function normalizePlanRecord(input, options = {}) {
  if (!isPlainObject(input)) throw new Error('plan must be an object');
  const now = iso(options.now ?? new Date());
  const extra = { ...input };
  for (const key of [
    'kind',
    'schemaVersion',
    'id',
    'title',
    'units',
    'lease',
    'status',
    'createdAt',
    'updatedAt',
  ]) {
    delete extra[key];
  }

  const id = assertBuildId(input.id, 'plan.id');
  const createdAt = normalizeIso(input.createdAt, 'plan.createdAt') ?? now;
  return {
    ...extra,
    kind: 'BuildPlan',
    schemaVersion: 1,
    id,
    title: optionalString(input.title) ?? id,
    units: normalizeUnits(input.units, options),
    lease: normalizeLease(input.lease),
    status: normalizeBuildState(input.status, BUILD_STATE_QUEUED, 'plan.status'),
    createdAt,
    updatedAt: normalizeIso(input.updatedAt, 'plan.updatedAt') ?? createdAt,
  };
}

export function normalizeUnitRecord(input, options = {}) {
  if (!isPlainObject(input)) throw new Error('unit must be an object');
  const now = iso(options.now ?? new Date());
  const extra = { ...input };
  for (const key of [
    'kind',
    'schemaVersion',
    'id',
    'state',
    'scope',
    'goal',
    'laneId',
    'checkpointSha',
    'createdAt',
    'updatedAt',
  ]) {
    delete extra[key];
  }

  const id = assertBuildId(input.id, 'unit.id');
  const createdAt = normalizeIso(input.createdAt, 'unit.createdAt') ?? now;
  return {
    ...extra,
    kind: 'BuildUnit',
    schemaVersion: 1,
    id,
    state: normalizeBuildState(input.state, BUILD_STATE_QUEUED, 'unit.state'),
    scope: normalizeScope(input.scope),
    goal: optionalString(input.goal) ?? '',
    laneId: input.laneId === undefined || input.laneId === null
      ? null
      : assertBuildId(input.laneId, 'unit.laneId'),
    checkpointSha: normalizeCheckpointSha(input.checkpointSha),
    createdAt,
    updatedAt: normalizeIso(input.updatedAt, 'unit.updatedAt') ?? createdAt,
  };
}

export function normalizeLaneRecord(input, options = {}) {
  if (!isPlainObject(input)) throw new Error('lane must be an object');
  const now = iso(options.now ?? new Date());
  const extra = { ...input };
  for (const key of [
    'kind',
    'schemaVersion',
    'id',
    'unitId',
    'pid',
    'startTime',
    'logPath',
    'worktreePath',
    'state',
    'createdAt',
    'updatedAt',
  ]) {
    delete extra[key];
  }

  const id = assertBuildId(input.id, 'lane.id');
  const createdAt = normalizeIso(input.createdAt, 'lane.createdAt') ?? now;
  return {
    ...extra,
    kind: 'BuildLane',
    schemaVersion: 1,
    id,
    unitId: assertBuildId(input.unitId, 'lane.unitId'),
    pid: normalizePid(input.pid),
    startTime: normalizeStartTime(input.startTime),
    logPath: optionalString(input.logPath) ?? null,
    worktreePath: optionalString(input.worktreePath) ?? null,
    state: normalizeBuildState(input.state, BUILD_STATE_BUILDING, 'lane.state'),
    createdAt,
    updatedAt: normalizeIso(input.updatedAt, 'lane.updatedAt') ?? createdAt,
  };
}

export function lanesNeedingRecovery(records, isPidAlive) {
  if (typeof isPidAlive !== 'function') throw new Error('isPidAlive must be a function');
  const lanes = Array.isArray(records)
    ? records
    : Array.isArray(records?.lanes)
      ? records.lanes
      : [];

  return lanes
    .map((lane) => normalizeLaneRecord(lane))
    .filter((lane) => laneHasProcess(lane) && isPidAlive(lane.pid, lane.startTime, lane) !== true)
    .map((lane) => ({
      ...lane,
      state: BUILD_STATE_ORPHANED,
    }));
}

function freezeTransitionMap(source) {
  const normalized = {};
  for (const state of BUILD_STATES) {
    normalized[state] = Object.freeze([...(source[state] ?? [])]);
  }
  return Object.freeze(normalized);
}

function normalizeHistoryEvent(event, now) {
  const record = isPlainObject(event) ? { ...event } : { value: event };
  return {
    ts: optionalString(record.ts) ?? optionalString(record.at) ?? iso(now),
    ...record,
  };
}

async function rotateHistoryIfNeeded(file, nextBytes, options) {
  const stats = await optionalStat(file, options.fsImpl);
  if (!stats || stats.size + nextBytes <= options.maxBytes) return;

  await options.fsImpl.rm(`${file}.1`, { force: true }).catch(() => {});
  try {
    await options.fsImpl.rename(file, `${file}.1`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function optionalStat(file, fsImpl) {
  try {
    return await fsImpl.stat(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function readOptionalText(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

function boundedLimit(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.min(Math.floor(number), 1000);
}

function normalizeUnits(value, options) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('plan.units must be an array');
  const seen = new Set();
  return value.map((unit) => {
    const normalized = normalizeUnitRecord(unit, options);
    if (seen.has(normalized.id)) throw new Error(`duplicate unit id: ${normalized.id}`);
    seen.add(normalized.id);
    return normalized;
  });
}

function normalizeScope(value) {
  const declared = Array.isArray(value)
    ? value
    : Array.isArray(value?.declared)
      ? value.declared
      : [];
  return {
    declared: uniqueStrings(declared, 'unit.scope.declared'),
  };
}

function uniqueStrings(values, label) {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array`);
  return [...new Set(values.map((value) => {
    const text = optionalString(value);
    if (!text) throw new Error(`${label} item is required`);
    return text;
  }))];
}

function normalizeLease(value) {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) throw new Error('lease must be an object');
  const owner = assertActor(value.owner);
  const acquiredAt = normalizeIso(value.acquiredAt, 'lease.acquiredAt');
  const renewedAt = normalizeIso(value.renewedAt, 'lease.renewedAt') ?? acquiredAt;
  if (!acquiredAt) throw new Error('lease.acquiredAt is required');
  return {
    owner,
    acquiredAt,
    renewedAt,
    ttlMs: normalizeTtlMs(value.ttlMs ?? DEFAULT_LEASE_TTL_MS),
  };
}

function normalizeBuildState(value, fallback, label) {
  if (value === undefined || value === null) return fallback;
  return assertBuildState(value, label);
}

function assertBuildState(value, label) {
  const state = optionalString(value);
  if (!state || !BUILD_STATES.includes(state)) {
    throw new Error(`invalid build state for ${label}: ${value}`);
  }
  return state;
}

function assertBuildId(value, label) {
  const id = optionalString(value);
  if (!id || !BUILD_ID_PATTERN.test(id)) throw new Error(`invalid build id for ${label}: ${value}`);
  return id;
}

function assertActor(value) {
  const actor = optionalString(value);
  if (!actor) throw new OwnershipError('actor is required', { code: 'actor_required' });
  return actor;
}

function normalizeCheckpointSha(value) {
  if (value === undefined || value === null) return null;
  const sha = optionalString(value);
  if (!sha) return null;
  if (!CHECKPOINT_PATTERN.test(sha)) throw new Error(`invalid checkpoint SHA: ${value}`);
  return sha;
}

function normalizePid(value) {
  if (value === undefined || value === null) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`invalid lane pid: ${value}`);
  return number;
}

function normalizeStartTime(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) throw new Error(`invalid lane startTime: ${value}`);
    return value;
  }
  return optionalString(value) ?? null;
}

function normalizeIso(value, label) {
  if (value === undefined || value === null) return null;
  const text = optionalString(value);
  if (!text) throw new Error(`${label} is required`);
  return iso(text);
}

function normalizeTtlMs(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`invalid lease ttlMs: ${value}`);
  return Math.floor(number);
}

function normalizeMonotonicMs(value, defaultFn) {
  const raw = value === undefined
    ? typeof defaultFn === 'function'
      ? defaultFn()
      : null
    : typeof value === 'function'
      ? value()
      : value;
  if (raw === null || raw === undefined) return null;
  const number = Number(raw);
  return Number.isFinite(number) ? number : null;
}

function finitePositive(value) {
  if (value === undefined || value === null) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}

function finiteNonNegative(value) {
  if (value === undefined || value === null) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : undefined;
}

function dateMs(value, label) {
  const ms = new Date(typeof value === 'function' ? value() : value).getTime();
  if (!Number.isFinite(ms)) throw new Error(`invalid date for ${label}: ${value}`);
  return ms;
}

function unitById(plan, unitId) {
  const id = assertBuildId(unitId, 'unitId');
  const unit = plan.units.find((candidate) => candidate.id === id);
  if (!unit) throw new BuildStateError(`unit not found: ${id}`, { code: 'unit_not_found' });
  return unit;
}

function hasUnitInState(plan, state) {
  return plan.units.some((unit) => unit.state === state);
}

function laneHasProcess(lane) {
  return Number.isSafeInteger(lane.pid) && lane.pid > 0 && lane.startTime !== null;
}

function cloneRecord(value) {
  return JSON.parse(JSON.stringify(value));
}
