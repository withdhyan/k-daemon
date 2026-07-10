import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  iso,
  safeDataPath,
} from '../../daemon/run.mjs';
import { round } from '../math.mjs';
import {
  isPlainObject,
  optionalString,
  stripUndefined,
} from '../substrate.mjs';
import { projectDecisionSignal } from './decisions.mjs';

export const REVIEW_RETRO_SCHEMA_VERSION = 1;
export const REVIEW_RETRO_WINDOW_DAYS = 7;

const DECISION_DIRS = Object.freeze(['decisions', path.join('substrate', 'decisions')]);
const CADENCE_ACT_DIRS = Object.freeze(['cadence/acts', 'cadence/outcomes', 'cadence/tws']);
const WORK_ENTRY_DIRS = Object.freeze(['work/entries', 'build/work']);
const DREAMING_EDGE_CARD_DIRS = Object.freeze([
  'dreaming/edge-cards',
  'mind/dreaming/edge-cards',
  'substrate/dreaming/edge-cards',
  'build/cards',
]);

const YES_RESPONSES = new Set(['yes', 'y', 'true', 'well-spent', 'well_spent', 'spent', '1']);
const NO_RESPONSES = new Set(['no', 'n', 'false', 'not-well-spent', 'not_well_spent', '0']);
const NO_RESPONSE_VALUES = new Set([
  'no-response',
  'no_response',
  'unanswered',
  'ignored',
  'missing',
  'pending',
]);

const ACTED_EDGE_DISPOSITIONS = new Set(['acted', 'act', 'applied', 'built', 'build', 'accepted']);
const DISMISSED_EDGE_DISPOSITIONS = new Set(['dismissed', 'dismiss', 'rejected', 'junk', 'killed']);
const EXPIRED_EDGE_DISPOSITIONS = new Set(['expired', 'expire', 'timed-out', 'timed_out', 'stale', 'obsoleted']);

export async function weeklyRetroFromDataDir(options = {}) {
  const dataDir = path.resolve(options.dataDir ?? path.join(process.cwd(), 'data'));
  const [
    decisions,
    cadenceActs,
    workEntries,
    dreamingEdgeCards,
    weeklyScope,
  ] = await Promise.all([
    readJsonRecords(dataDir, DECISION_DIRS),
    readJsonRecords(dataDir, CADENCE_ACT_DIRS),
    readJsonRecords(dataDir, WORK_ENTRY_DIRS),
    readJsonRecords(dataDir, DREAMING_EDGE_CARD_DIRS),
    weeklyScopeFromSubstrateStore(options.substrateStore ?? options.store),
  ]);

  return computeWeeklyRetro({
    ...options,
    decisions: recordsData(decisions),
    cadenceActs: recordsData(cadenceActs),
    workEntries: recordsData(workEntries),
    dreamingEdgeCards: recordsData(dreamingEdgeCards).filter(isDreamingEdgeCard),
    weeklyGoals: Array.isArray(options.weeklyGoals) ? options.weeklyGoals : weeklyScope.weeklyGoals,
    weeklyLists: Array.isArray(options.weeklyLists) ? options.weeklyLists : weeklyScope.weeklyLists,
  });
}

export async function weeklyScopeFromSubstrateStore(store) {
  if (!store || typeof store.listRecords !== 'function') {
    return deepFreeze({ weeklyGoals: [], weeklyLists: [] });
  }

  const [weeklyGoals, weeklyLists] = await Promise.all([
    listOptionalWeeklyKind(store, 'WeeklyGoals'),
    listOptionalWeeklyKind(store, 'WeeklyLists'),
  ]);
  return deepFreeze({ weeklyGoals, weeklyLists });
}

export function computeWeeklyRetro(input = {}) {
  const now = dateFrom(input.now ?? new Date());
  const days = positiveInteger(input.days, REVIEW_RETRO_WINDOW_DAYS);
  const window = buildTrailingWindow(now, days);
  const cadenceActs = recordsInWindow(input.cadenceActs, window);
  const workEntries = recordsInWindow(input.workEntries, window);
  const decisions = recordsInWindow(input.decisions, window);
  const dreamingEdgeCards = recordsInWindow(input.dreamingEdgeCards, window)
    .filter(isDreamingEdgeCard);

  return deepFreeze({
    kind: 'WeeklyRetro',
    schemaVersion: REVIEW_RETRO_SCHEMA_VERSION,
    week: {
      start: window.start,
      end: window.end,
      days,
    },
    evalHealth: {
      tws: twsPanel(cadenceActs, window),
      dreaming: dreamingPanel(dreamingEdgeCards),
      decisionSignal: decisionSignalPanel(decisions, window),
      motionVsProgress: motionVsProgressPanel([...cadenceActs, ...workEntries]),
    },
    goals: weeklyRecords(input.weeklyGoals ?? input.goals),
    lists: weeklyRecords(input.weeklyLists ?? input.lists),
    generatedAt: iso(now),
    source: 'cs-k',
  });
}

async function listOptionalWeeklyKind(store, kind) {
  try {
    return weeklyRecords((await store.listRecords(kind)).filter(isLiveRecord));
  } catch (error) {
    if (/invalid record kind/.test(String(error?.message ?? ''))) return [];
    throw error;
  }
}

function weeklyRecords(records) {
  if (!Array.isArray(records)) return [];
  return records
    .filter(isPlainObject)
    .map((record) => stripUndefined({ ...record }));
}

function twsPanel(records, window) {
  const buckets = new Map(window.dates.map((date) => [date, emptyTwsBucket(date)]));

  for (const record of records) {
    const response = normalizeTwsResponse(record);
    if (!response) continue;
    const date = recordDateKey(record);
    if (!date || !buckets.has(date)) continue;
    addTwsResponse(buckets.get(date), response);
  }

  const trend = [...buckets.values()].map(finalizeTwsBucket);
  const total = trend.reduce((acc, bucket) => ({
    promptCount: acc.promptCount + bucket.promptCount,
    answeredCount: acc.answeredCount + bucket.answeredCount,
    yesCount: acc.yesCount + bucket.yesCount,
    noCount: acc.noCount + bucket.noCount,
    noResponseCount: acc.noResponseCount + bucket.noResponseCount,
  }), {
    promptCount: 0,
    answeredCount: 0,
    yesCount: 0,
    noCount: 0,
    noResponseCount: 0,
  });

  return {
    ...total,
    score: ratioOrNull(total.yesCount, total.answeredCount),
    responseRate: ratioOrNull(total.answeredCount, total.promptCount),
    trend,
  };
}

function dreamingPanel(records) {
  let acted = 0;
  let dismissed = 0;
  let expired = 0;
  let pending = 0;

  for (const record of records) {
    const disposition = normalizeDreamingDisposition(record);
    if (disposition === 'acted') acted += 1;
    else if (disposition === 'dismissed') dismissed += 1;
    else if (disposition === 'expired') expired += 1;
    else pending += 1;
  }

  const dispositioned = acted + dismissed + expired;
  return {
    edgeCards: records.length,
    dispositioned,
    acted,
    dismissed,
    expired,
    pending,
    hitRate: ratioOrNull(acted, dispositioned),
  };
}

function decisionSignalPanel(decisions, window) {
  const reading = projectDecisionSignal(decisions, {
    start: window.start,
    end: window.end,
  });
  return {
    recommended: reading.recommended,
    acted: reading.acted,
    actedPerWeek: reading.acted,
    rate: reading.rate,
    weeks: reading.weeks,
  };
}

function motionVsProgressPanel(records) {
  let motion = 0;
  let progress = 0;
  let untagged = 0;

  for (const record of records) {
    const tag = normalizeMotionProgressTag(record);
    if (tag === 'motion') motion += 1;
    else if (tag === 'progress') progress += 1;
    else untagged += 1;
  }

  const tagged = motion + progress;
  return {
    entries: records.length,
    motion,
    progress,
    untagged,
    tagged,
    progressRate: ratioOrNull(progress, tagged),
  };
}

function emptyTwsBucket(date) {
  return {
    date,
    promptCount: 0,
    answeredCount: 0,
    yesCount: 0,
    noCount: 0,
    noResponseCount: 0,
  };
}

function addTwsResponse(bucket, response) {
  bucket.promptCount += 1;
  if (response === 'yes') {
    bucket.answeredCount += 1;
    bucket.yesCount += 1;
  } else if (response === 'no') {
    bucket.answeredCount += 1;
    bucket.noCount += 1;
  } else {
    bucket.noResponseCount += 1;
  }
}

function finalizeTwsBucket(bucket) {
  return {
    ...bucket,
    score: ratioOrNull(bucket.yesCount, bucket.answeredCount),
    responseRate: ratioOrNull(bucket.answeredCount, bucket.promptCount),
  };
}

function normalizeTwsResponse(record) {
  if (!isPlainObject(record)) return null;
  if (record.twsAnswered === false || record.wellSpentAnswered === false) return 'no-response';

  const raw = firstValue(
    record.wellSpent,
    record.well_spent,
    record.twsWellSpent,
    record.tws_well_spent,
    record.twsResponse,
    record.tws_response,
    record.tws?.wellSpent,
    record.tws?.response,
    record.tws?.verdict,
  );
  if (raw === true) return 'yes';
  if (raw === false) return 'no';

  const text = lowerString(raw);
  if (!text) return null;
  if (YES_RESPONSES.has(text)) return 'yes';
  if (NO_RESPONSES.has(text)) return 'no';
  if (NO_RESPONSE_VALUES.has(text)) return 'no-response';
  return null;
}

function normalizeDreamingDisposition(record) {
  const raw = lowerString(firstValue(
    record.edgeDisposition,
    record.edge_disposition,
    record.disposition,
    record.outcome,
    record.status,
    record.answerOption,
  ));
  if (raw && ACTED_EDGE_DISPOSITIONS.has(raw)) return 'acted';
  if (raw && DISMISSED_EDGE_DISPOSITIONS.has(raw)) return 'dismissed';
  if (raw && EXPIRED_EDGE_DISPOSITIONS.has(raw)) return 'expired';

  if (optionalString(record.actedAt) || optionalString(record.appliedAt)) return 'acted';
  if (optionalString(record.dismissedAt)) return 'dismissed';
  if (optionalString(record.expiredAt) || optionalString(record.obsoletedAt)) return 'expired';
  return 'pending';
}

function normalizeMotionProgressTag(record) {
  const raw = lowerString(firstValue(
    record.motionProgressTag,
    record.motionVsProgress,
    record.motion_vs_progress,
    record.motionProgress,
    record.motion_progress,
    record.progressTag,
    record.progress_tag,
    record.workTag,
    record.work_tag,
    exactMotionProgressTag(record.tag),
  ));
  if (raw === 'motion' || raw === 'progress') return raw;

  const tags = Array.isArray(record.tags) ? record.tags.map(lowerString) : [];
  if (tags.includes('progress')) return 'progress';
  if (tags.includes('motion')) return 'motion';
  return null;
}

function exactMotionProgressTag(value) {
  const tag = lowerString(value);
  return tag === 'motion' || tag === 'progress' ? tag : undefined;
}

function isDreamingEdgeCard(record) {
  if (!isPlainObject(record)) return false;
  if (record.edgeCard === true || record.dreamingEdgeCard === true) return true;
  const kind = lowerString(firstValue(record.kind, record.cardKind, record.type, record.category));
  const source = lowerString(firstValue(
    record.source,
    record.origin,
    record.provenance?.source,
    record.provenance?.routine,
    record.provenance?.surface,
  ));
  return (
    (kind.includes('dream') && (kind.includes('edge') || kind.includes('card'))) ||
    (kind.includes('edge') && source.includes('dream')) ||
    source.includes('dreaming')
  );
}

function recordsInWindow(records, window) {
  if (!Array.isArray(records)) return [];
  return records.filter((record) => {
    const date = recordDateKey(record);
    return date !== null && date >= window.start && date <= window.end;
  });
}

function recordDateKey(record) {
  if (!isPlainObject(record)) return null;
  const value = firstValue(
    record.actedAt,
    record.dismissedAt,
    record.expiredAt,
    record.appliedAt,
    record.answeredAt,
    record.completedAt,
    record.recordedAt,
    record.occurredAt,
    record.startedAt,
    record.updatedAt,
    record.createdAt,
    record.eventAt,
    record.date,
    record.day,
  );
  return dateKey(value);
}

function isLiveRecord(record) {
  return isPlainObject(record) && !record.validTo && !record.supersededById;
}

function buildTrailingWindow(now, days) {
  const endDate = utcDateOnly(now);
  const startDate = addUtcDays(endDate, 1 - days);
  return {
    start: toDateKey(startDate),
    end: toDateKey(endDate),
    dates: Array.from({ length: days }, (_, index) => toDateKey(addUtcDays(startDate, index))),
  };
}

function dateKey(value) {
  const text = optionalString(value);
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return null;
  return toDateKey(date);
}

function utcDateOnly(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addUtcDays(date, days) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function toDateKey(date) {
  return date.toISOString().slice(0, 10);
}

function ratioOrNull(numerator, denominator) {
  return denominator > 0 ? round(numerator / denominator, 4) : null;
}

async function readJsonRecords(dataDir, relPaths) {
  const groups = await Promise.all(relPaths.map((relPath) => readJsonRecordsFromDir(dataDir, relPath)));
  const records = groups.flat();
  const seen = new Set();
  return records.filter((entry) => {
    if (seen.has(entry.relPath)) return false;
    seen.add(entry.relPath);
    return true;
  });
}

async function readJsonRecordsFromDir(dataDir, relPath) {
  const root = safeDataPath(dataDir, relPath);
  return readJsonRecordsRecursive(root, relPath);
}

async function readJsonRecordsRecursive(dir, relPath) {
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const records = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(dir, entry.name);
    const childRelPath = path.join(relPath, entry.name);
    if (entry.isDirectory()) {
      records.push(...await readJsonRecordsRecursive(file, childRelPath));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const record = await readJsonFile(file);
    if (record !== null) records.push({ data: record, relPath: childRelPath });
  }
  return records;
}

async function readJsonFile(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

function recordsData(entries) {
  return entries.map((entry) => entry.data);
}

function firstValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function lowerString(value) {
  return optionalString(value)?.toLowerCase() ?? '';
}

function positiveInteger(value, fallback) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error('days must be a positive integer');
  return number;
}

function dateFrom(value) {
  if (typeof value === 'function') return dateFrom(value());
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid date: ${value}`);
  return date;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object') return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
