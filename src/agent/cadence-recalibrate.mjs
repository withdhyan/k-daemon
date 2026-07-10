import { promises as fs } from 'node:fs';
import path from 'node:path';

export const CADENCE_RECALIBRATIONS_DIR = path.join('cadence', 'recalibrations');

export const RECALIBRATION_CHANGE_TYPES = Object.freeze([
  'shift',
  'compress',
  'merge',
  'skip',
  'protect',
]);

const WAKE_INIT_ACTIONS = new Set([
  'wake_init',
  'wake',
  'day_start',
  'day_starts_now',
  'day_start_now',
  'start_day',
  'start_now',
]);
const OVERRUN_ACTIONS = new Set(['complete', 'extend_15']);
const MIN_COMPRESSED_DURATION = Object.freeze({
  middle: 30,
  outer: 15,
});
const MINUTE_MS = 60_000;

export function isWakeInitAct(input = {}) {
  if (!isPlainObject(input)) return false;
  return isWakeInitAction(input.action ?? input.act ?? input.outcome ?? input.kind);
}

export function isWakeInitAction(value) {
  return WAKE_INIT_ACTIONS.has(normalizeAction(value));
}

export function isOverrunRecalibrationAction(value) {
  return OVERRUN_ACTIONS.has(normalizeAction(value));
}

export function detectCadenceRecalibrationTrigger(input = {}) {
  const blocks = coerceBlocks(input.blocks ?? input.day?.blocks ?? []);
  const now = dateFrom(input.now ?? new Date());
  const trigger = normalizeTrigger(input.trigger ?? {});
  const forcedReason = optionalString(input.reason);

  if (forcedReason === 'wake-init') {
    const firstAffected = firstRemainingIndex(blocks, now);
    return firstAffected === -1 ? null : { reason: 'wake-init', firstAffected };
  }

  if (forcedReason === 'overrun') {
    const firstAffected = firstOverrunAffectedIndex(blocks, now, trigger);
    return firstAffected === -1 ? null : { reason: 'overrun', firstAffected };
  }

  if (trigger.type === 'act' && isWakeInitAction(trigger.action)) {
    const firstAffected = firstRemainingIndex(blocks, now);
    return firstAffected === -1 ? null : { reason: 'wake-init', firstAffected };
  }

  if (trigger.type === 'act' && isOverrunRecalibrationAction(trigger.action)) {
    const firstAffected = firstOverrunAffectedIndex(blocks, now, trigger);
    return firstAffected === -1 ? null : { reason: 'overrun', firstAffected };
  }

  return null;
}

export function recalibrateCadenceDay(input = {}) {
  if (!isPlainObject(input.day)) throw new Error('cadence day is required');
  const result = recalibrateCadenceBlocks({
    blocks: input.day.blocks,
    now: input.now,
    trigger: input.trigger,
    reason: input.reason,
  });
  if (!result.changed) {
    return deepFreeze({
      changed: false,
      reason: result.reason,
      day: input.day,
      changes: [],
      recalibration: null,
    });
  }

  const day = deepFreeze(stripUndefined({
    ...input.day,
    blocks: result.blocks,
    recalibration: result.recalibration,
    recalibrationChanges: result.changes,
  }));

  return deepFreeze({
    changed: true,
    reason: result.reason,
    day,
    changes: result.changes,
    recalibration: result.recalibration,
  });
}

export function recalibrateCadenceBlocks(input = {}) {
  const blocks = normalizeBlocks(input.blocks ?? []);
  const now = dateFrom(input.now ?? new Date());
  const trigger = normalizeTrigger(input.trigger ?? {});
  const detection = detectCadenceRecalibrationTrigger({
    blocks,
    now,
    trigger,
    reason: input.reason,
  });

  if (!detection) {
    return deepFreeze({
      changed: false,
      reason: null,
      blocks: blocks.map((entry) => clone(entry.block)),
      changes: [],
      recalibration: null,
    });
  }

  const first = blocks[detection.firstAffected];
  const initialDelay = Math.max(0, minuteDiff(now.getTime(), first.start));
  if (initialDelay <= 0) {
    return deepFreeze({
      changed: false,
      reason: detection.reason,
      blocks: blocks.map((entry) => clone(entry.block)),
      changes: [],
      recalibration: null,
    });
  }

  let carryDelay = initialDelay;
  let changed = false;
  let previousKept = null;
  const recalibrated = [];
  const changes = [];

  for (let index = 0; index < blocks.length; index += 1) {
    const entry = blocks[index];

    if (index < detection.firstAffected || carryDelay <= 0) {
      const block = clone(entry.block);
      recalibrated.push(block);
      if (!block.skipped) previousKept = { entry, block };
      continue;
    }

    const beforeDelay = carryDelay;
    const shiftedStart = entry.start + (beforeDelay * MINUTE_MS);
    const duration = entry.durationMinutes;
    const ring = entry.block.ring;

    if (
      ring === 'outer' &&
      shouldMergeWithPrevious({ entry, previousKept, shiftedStart, delayMinutes: beforeDelay })
    ) {
      const change = recalibrationChange('merge', entry.start, shiftedStart);
      const block = deepFreeze(stripUndefined({
        ...clone(entry.block),
        skipped: true,
        mergedIntoBlockId: previousKept.block.id,
        recalibrationChange: change,
      }));
      recalibrated.push(block);
      changes.push(changeForBlock(block, change));
      carryDelay = Math.max(0, beforeDelay - duration);
      changed = true;
      continue;
    }

    if (ring === 'outer' && shouldSkipOuterBlock({ duration, delayMinutes: beforeDelay })) {
      const change = recalibrationChange('skip', entry.start, shiftedStart);
      const block = deepFreeze(stripUndefined({
        ...clone(entry.block),
        skipped: true,
        recalibrationChange: change,
      }));
      recalibrated.push(block);
      changes.push(changeForBlock(block, change));
      carryDelay = Math.max(0, beforeDelay - duration);
      changed = true;
      continue;
    }

    const policy = blockPolicy(ring);
    const minDuration = Math.min(duration, MIN_COMPRESSED_DURATION[ring] ?? duration);
    const compression = policy === 'compress'
      ? Math.min(beforeDelay, Math.max(0, duration - minDuration))
      : 0;
    const newDuration = duration - compression;
    const newEnd = shiftedStart + (newDuration * MINUTE_MS);
    const type = policy === 'protect'
      ? 'protect'
      : compression > 0
        ? 'compress'
        : 'shift';
    const change = recalibrationChange(type, entry.start, shiftedStart);
    const block = deepFreeze(stripUndefined({
      ...clone(entry.block),
      startAt: iso(shiftedStart),
      endAt: iso(newEnd),
      recalibrationChange: change,
    }));

    recalibrated.push(block);
    changes.push(changeForBlock(block, change));
    carryDelay = Math.max(0, minuteDiff(newEnd, entry.end));
    previousKept = { entry, block };
    changed = true;
  }

  if (!changed) {
    return deepFreeze({
      changed: false,
      reason: detection.reason,
      blocks: blocks.map((entry) => clone(entry.block)),
      changes: [],
      recalibration: null,
    });
  }

  const recalibration = deepFreeze({
    reason: detection.reason,
    anchorAt: iso(now),
    trigger,
    changes,
  });

  return deepFreeze({
    changed: true,
    reason: detection.reason,
    blocks: recalibrated,
    changes,
    recalibration,
  });
}

export async function saveCadenceRecalibrationAnchor(input = {}) {
  const dataDir = optionalString(input.dataDir);
  if (!dataDir) throw new Error('dataDir is required');
  const date = dateKey(input.date ?? input.anchorAt ?? input.now ?? new Date());
  const anchor = normalizeRecalibrationAnchor({
    ...input,
    date,
  });
  const file = recalibrationAnchorPath(dataDir, date);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(anchor, null, 2)}\n`, 'utf8');
  return anchor;
}

export async function loadCadenceRecalibrationAnchor(input = {}) {
  const dataDir = optionalString(input.dataDir);
  if (!dataDir) return null;
  const date = dateKey(input.date ?? input.now ?? new Date());
  try {
    const parsed = JSON.parse(await fs.readFile(recalibrationAnchorPath(dataDir, date), 'utf8'));
    return normalizeRecalibrationAnchor(parsed);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function normalizeRecalibrationAnchor(input = {}) {
  if (!isPlainObject(input)) throw new Error('recalibration anchor must be an object');
  const date = dateKey(input.date ?? input.anchorAt ?? input.eventAt);
  const anchorAt = iso(input.anchorAt ?? input.eventAt ?? input.now ?? new Date());
  const trigger = normalizeTrigger(input.trigger ?? {
    type: 'act',
    action: input.reason === 'wake-init' ? 'wake_init' : 'complete',
    blockId: input.blockId,
  });
  const reason = optionalString(input.reason) ??
    (isWakeInitAction(trigger.action) ? 'wake-init' : 'overrun');
  if (!['wake-init', 'overrun'].includes(reason)) {
    throw new Error(`invalid recalibration reason: ${reason}`);
  }
  return deepFreeze(stripUndefined({
    kind: 'CadenceRecalibrationAnchor',
    schemaVersion: 1,
    date,
    reason,
    anchorAt,
    trigger,
  }));
}

function firstRemainingIndex(blocks, now) {
  const current = now.getTime();
  return blocks.findIndex((entry) => entry.end > current);
}

function firstOverrunAffectedIndex(blocks, now, trigger) {
  const blockId = optionalString(trigger.blockId);
  if (!blockId) return -1;
  const overrunIndex = blocks.findIndex((entry) =>
    entry.block.id === blockId ||
    entry.block.blockId === blockId ||
    entry.block.templateBlockId === blockId ||
    entry.block.sourceId === blockId);
  if (overrunIndex === -1) return -1;
  const current = now.getTime();
  if (current <= blocks[overrunIndex].end) return -1;
  return blocks.findIndex((entry, index) => index > overrunIndex && entry.end > current);
}

function blockPolicy(ring) {
  if (ring === 'core') return 'protect';
  if (ring === 'middle' || ring === 'outer') return 'compress';
  return 'shift';
}

function shouldSkipOuterBlock({ duration, delayMinutes }) {
  return duration <= delayMinutes || duration <= 10;
}

function shouldMergeWithPrevious({ entry, previousKept, shiftedStart, delayMinutes }) {
  if (!previousKept || delayMinutes <= 0) return false;
  const previous = previousKept.entry;
  if (entry.block.ring !== 'outer' || previous.block.ring !== 'outer') return false;
  if (entry.block.attentionMode !== previous.block.attentionMode) return false;
  const originalGap = minuteDiff(entry.start, previous.end);
  const previousEnd = Date.parse(previousKept.block.endAt);
  return originalGap <= 15 || shiftedStart < previousEnd;
}

function recalibrationChange(type, originalStart, newStart) {
  if (!RECALIBRATION_CHANGE_TYPES.includes(type)) {
    throw new Error(`invalid recalibration change type: ${type}`);
  }
  return deepFreeze({
    type,
    originalStart: iso(originalStart),
    newStart: iso(newStart),
    deltaMinutes: minuteDiff(newStart, originalStart),
  });
}

function changeForBlock(block, change) {
  return deepFreeze({
    blockId: optionalString(block.id),
    ...change,
  });
}

function normalizeBlocks(blocks) {
  if (!Array.isArray(blocks)) throw new Error('cadence blocks must be an array');
  return blocks
    .map((block, index) => normalizeBlock(block, index))
    .sort((left, right) =>
      left.start - right.start ||
      left.end - right.end ||
      String(left.block.id ?? '').localeCompare(String(right.block.id ?? '')));
}

function coerceBlocks(blocks) {
  if (
    Array.isArray(blocks) &&
    blocks.every((entry) =>
      isPlainObject(entry) &&
      isPlainObject(entry.block) &&
      Number.isFinite(entry.start) &&
      Number.isFinite(entry.end))
  ) {
    return blocks;
  }
  return normalizeBlocks(blocks);
}

function normalizeBlock(block, index) {
  if (!isPlainObject(block)) throw new Error('cadence block must be an object');
  const start = dateFrom(block.startAt).getTime();
  const end = dateFrom(block.endAt).getTime();
  if (end <= start) throw new Error('cadence block endAt must be after startAt');
  return {
    block: clone(block),
    index,
    start,
    end,
    durationMinutes: Math.max(1, minuteDiff(end, start)),
  };
}

function normalizeTrigger(input) {
  if (typeof input === 'string') return deepFreeze({ type: normalizeTriggerType(input) });
  if (!isPlainObject(input)) return deepFreeze({ type: 'tick' });
  const type = normalizeTriggerType(input.type ?? input.kind ?? input.trigger);
  return deepFreeze(stripUndefined({
    type,
    signal: optionalString(input.signal ?? input.signalId ?? input.bodySignal),
    blockId: optionalString(input.blockId),
    action: optionalString(normalizeAction(input.action ?? input.act ?? input.outcome)),
    source: optionalString(input.source),
    eventId: optionalString(input.eventId ?? input.id),
  }));
}

function normalizeTriggerType(value) {
  const type = optionalString(value)?.toLowerCase().replace(/_/g, '-') ?? 'tick';
  if (type === 'wake-init') return 'act';
  return type;
}

function normalizeAction(value) {
  const text = optionalString(value)
    ?.toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/-/g, '_') ?? '';
  if (text === '+15' || text === 'extend15' || text === 'plus15') return 'extend_15';
  if (text === 'done' || text === 'completed') return 'complete';
  if (text === 'daystartsnow') return 'day_starts_now';
  if (text === 'start') return 'start_day';
  return text;
}

function recalibrationAnchorPath(dataDir, date) {
  return safeDataPath(dataDir, path.join(CADENCE_RECALIBRATIONS_DIR, `${date}.json`));
}

function safeDataPath(dataDir, relPath) {
  const root = path.resolve(dataDir);
  const rel = String(relPath ?? '');
  if (!rel || path.isAbsolute(rel) || path.win32.isAbsolute(rel) || rel.split(/[\\/]+/).includes('..')) {
    throw new Error(`refused unsafe data path: ${relPath}`);
  }
  const resolved = path.resolve(root, rel);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`refused unsafe data path: ${relPath}`);
  }
  return resolved;
}

function dateKey(value) {
  const date = dateFrom(value);
  return date.toISOString().slice(0, 10);
}

function dateFrom(value) {
  const raw = typeof value === 'function' ? value() : value;
  const date = raw instanceof Date ? raw : new Date(raw);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid date: ${value}`);
  return date;
}

function iso(value) {
  return dateFrom(value).toISOString();
}

function minuteDiff(left, right) {
  return Math.round((left - right) / MINUTE_MS);
}

function optionalString(value) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text.length > 0 ? text : undefined;
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stripUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object') return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
