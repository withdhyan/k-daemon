import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  iso,
  safeDataPath,
} from '../../daemon/run.mjs';
import {
  isPlainObject,
  optionalString,
  stripUndefined,
} from '../substrate.mjs';
import { round } from '../math.mjs';
import { atomicWriteJson } from './routines.mjs';

export const DECISIONS_DIR = 'decisions';
export const DECISION_ACTED = 'acted';
export const DECISION_PENDING = 'pending';

export async function readDecisionRecords(dataDir) {
  return (await listDecisionEntries(dataDir)).map((entry) => normalizeDecisionRecord(entry.data));
}

export async function recordDecisionActed(options = {}) {
  const dataDir = requiredDataDir(options.dataDir);
  const decisionId = optionalString(options.id ?? options.decisionId);
  if (!decisionId) throw new Error('decision id is required');

  const entries = await listDecisionEntries(dataDir);
  const entry = entries.find((candidate) =>
    optionalString(candidate.data.id) === decisionId ||
    path.basename(candidate.relPath, '.json') === decisionId);
  if (!entry) throw new Error(`decision not found: ${decisionId}`);

  const decision = normalizeDecisionRecord(entry.data);
  if (isDecisionActed(decision) && optionalString(decision.actedAt)) {
    return {
      ok: true,
      changed: false,
      path: path.join('data', entry.relPath),
      decision,
    };
  }

  const actedAt = iso(options.at ?? resolveNow(options.now));
  const updated = normalizeDecisionRecord({
    ...decision,
    acted: DECISION_ACTED,
    actedAt,
  });
  await atomicWriteJson(safeDataPath(dataDir, entry.relPath), updated);
  return {
    ok: true,
    changed: true,
    path: path.join('data', entry.relPath),
    decision: updated,
  };
}

export const markDecisionActed = recordDecisionActed;

export function normalizeDecisionRecord(input) {
  if (!isPlainObject(input)) throw new Error('decision record must be an object');
  const output = { ...input };

  for (const field of ['observation', 'reasoning', 'conclusion', 'urgency']) {
    if (Object.hasOwn(input, field)) {
      const text = optionalString(input[field]);
      if (text) output[field] = text;
      else delete output[field];
    }
  }

  if (Object.hasOwn(input, 'evidence')) {
    output.evidence = normalizeStringList(input.evidence, 'evidence');
  }

  if (Object.hasOwn(input, 'evidenceIds')) {
    output.evidenceIds = normalizeStringList(input.evidenceIds, 'evidenceIds');
  }

  if (Object.hasOwn(input, 'confidence')) {
    output.confidence = normalizeConfidence(input.confidence);
  }

  if (Object.hasOwn(input, 'acted')) {
    const acted = normalizeActed(input.acted);
    if (acted) output.acted = acted;
    else delete output.acted;
  }

  if (Object.hasOwn(input, 'actedAt')) {
    const actedAt = optionalString(input.actedAt);
    if (actedAt) output.actedAt = actedAt;
    else delete output.actedAt;
  }

  return stripUndefined(output);
}

export function projectDecisionSignal(decisions, options = {}) {
  if (!Array.isArray(decisions)) throw new Error('decisions must be an array');
  const normalized = decisions
    .filter(isPlainObject)
    .map(normalizeDecisionRecord)
    .filter(isCountedDecision);

  const dates = normalized
    .map(decisionDateKey)
    .filter(Boolean)
    .sort();
  const start = options.start !== undefined || dates.length > 0
    ? dayKey(options.start ?? dates[0])
    : null;
  const end = options.end !== undefined || dates.length > 0
    ? dayKey(options.end ?? dates.at(-1))
    : null;
  const weeks = start && end ? emptyIsoWeekBuckets(start, end) : [];
  const buckets = new Map(weeks.map((bucket) => [bucket.week, bucket]));
  let recommended = 0;
  let acted = 0;

  for (const decision of normalized) {
    const date = decisionDateKey(decision);
    if (!date || (start && date < start) || (end && date > end)) continue;
    recommended += 1;
    if (isDecisionActed(decision)) acted += 1;

    const week = isoWeekKey(date);
    const bucket = buckets.get(week);
    if (!bucket) continue;
    bucket.recommended += 1;
    if (isDecisionActed(decision)) bucket.acted += 1;
  }

  return Object.freeze({
    recommended,
    acted,
    rate: ratioOrNull(acted, recommended),
    weeks: Object.freeze(weeks.map(finalizeWeekBucket)),
  });
}

export function formatDecisionSignalLine(signal = {}) {
  const acted = nonNegativeInteger(signal.acted);
  const recommended = nonNegativeInteger(signal.recommended);
  return `acted ${acted}/${recommended} decisions`;
}

export function isDecisionActed(decision) {
  if (!isPlainObject(decision)) return false;
  return (
    decision.acted === DECISION_ACTED ||
    decision.acted === true ||
    Boolean(optionalString(decision.actedAt))
  );
}

export function isoWeekKey(value) {
  const thursday = isoWeekThursday(value);
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((thursday - yearStart) / 86_400_000) + 1) / 7);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function isCountedDecision(decision) {
  if (decision.kind === 'LoopRecommendation') {
    return (
      decision.station === 'decide' &&
      decision.verdict === 'recommend' &&
      decision.advisoryOnly === true &&
      typeof decision.recommended === 'string' &&
      decision.recommended.trim().length > 0
    );
  }

  if (decision.kind === 'KDecision') {
    return Boolean(firstString(decision.conclusion, decision.recommended, decision.decision));
  }

  return false;
}

function decisionDateKey(decision) {
  const value = firstString(
    decision.actedAt,
    decision.dismissedAt,
    decision.createdAt,
    decision.eventAt,
    decision.date,
  );
  if (!value) return null;
  try {
    return dayKey(value);
  } catch {
    return null;
  }
}

async function listDecisionEntries(dataDir) {
  const root = requiredDataDir(dataDir);
  const dir = safeDataPath(root, DECISIONS_DIR);
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort();

  const records = [];
  for (const name of files) {
    const relPath = path.join(DECISIONS_DIR, name);
    records.push({
      relPath,
      data: JSON.parse(await fs.readFile(safeDataPath(root, relPath), 'utf8')),
    });
  }
  return records;
}

function emptyIsoWeekBuckets(start, end) {
  const buckets = [];
  const cursor = isoWeekStart(start);
  const last = isoWeekStart(end);
  while (cursor <= last) {
    const bucketStart = dayKey(cursor);
    const bucketEndDate = new Date(cursor);
    bucketEndDate.setUTCDate(bucketEndDate.getUTCDate() + 6);
    buckets.push({
      week: isoWeekKey(cursor),
      start: bucketStart,
      end: dayKey(bucketEndDate),
      recommended: 0,
      acted: 0,
    });
    cursor.setUTCDate(cursor.getUTCDate() + 7);
  }
  return buckets;
}

function finalizeWeekBucket(bucket) {
  return Object.freeze({
    ...bucket,
    rate: ratioOrNull(bucket.acted, bucket.recommended),
  });
}

function isoWeekStart(value) {
  const date = dateFrom(value);
  const cursor = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = cursor.getUTCDay() || 7;
  cursor.setUTCDate(cursor.getUTCDate() - day + 1);
  return cursor;
}

function isoWeekThursday(value) {
  const cursor = isoWeekStart(value);
  cursor.setUTCDate(cursor.getUTCDate() + 3);
  return cursor;
}

function dayKey(value) {
  return dateFrom(value).toISOString().slice(0, 10);
}

function dateFrom(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid date: ${value}`);
  return date;
}

function normalizeStringList(value, label) {
  const raw = Array.isArray(value) ? value : [value];
  return [...new Set(raw.map((item) => {
    const text = optionalString(item);
    if (!text) throw new Error(`${label} item is required`);
    return text;
  }))];
}

function normalizeConfidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) {
    throw new Error('confidence must be between 0 and 1');
  }
  return number;
}

function normalizeActed(value) {
  if (value === undefined || value === null) return undefined;
  if (value === true) return DECISION_ACTED;
  if (value === false) return DECISION_PENDING;
  const text = optionalString(value)?.toLowerCase();
  if (text === 'act') return DECISION_ACTED;
  if (text === 'open') return DECISION_PENDING;
  return text;
}

function ratioOrNull(numerator, denominator) {
  return denominator === 0 ? null : round(numerator / denominator, 4);
}

function nonNegativeInteger(value) {
  const number = Number(value ?? 0);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

function firstString(...values) {
  for (const value of values) {
    const text = optionalString(value);
    if (text) return text;
  }
  return undefined;
}

function resolveNow(now) {
  return typeof now === 'function' ? now() : now ?? new Date();
}

function requiredDataDir(dataDir) {
  return path.resolve(optionalString(dataDir) ?? path.join(process.cwd(), 'data'));
}
