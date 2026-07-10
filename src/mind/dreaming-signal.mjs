import { promises as fs } from 'node:fs';
import path from 'node:path';

import { safeDataPath } from '../../daemon/run.mjs';
import { BUILD_CARDS_DIR } from '../agent/build-cards.mjs';
import {
  isPlainObject,
  optionalString,
} from '../substrate.mjs';
import { MIND_OUTPUT_GROUPS } from './think.mjs';

const MIND_EVAL_DIR = 'eval';
const MIND_EVAL_VERDICTS = Object.freeze(['act-on', 'nod', 'junk']);
const ACTED = 'acted';
const DISMISSED = 'dismissed';
const EXPIRED = 'expired';
const PENDING = 'pending';

export const DREAMING_EDGE_DISPOSITIONS = Object.freeze([
  ACTED,
  DISMISSED,
  EXPIRED,
  PENDING,
]);
export const DREAMING_SIGNAL_BLIND_SPOT_NOTE =
  'measures captured edge cards and mind verdicts only; blind to uncaptured offline action';

const ACTED_TOKENS = new Set([
  'act',
  'acted',
  'act-on',
  'action',
  'accept',
  'accepted',
  'accept-recommendation',
  'adopt',
  'approve',
  'approved',
  'build',
  'continue',
  'keep',
  'promote',
  'retry',
  'yes',
]);
const DISMISSED_TOKENS = new Set([
  'archive',
  'archived',
  'discard',
  'discarded',
  'dismiss',
  'dismissed',
  'junk',
  'kill',
  'no',
  'reject',
  'rejected',
  'stop',
  'suppress',
  'suppressed',
]);
const EXPIRED_TOKENS = new Set([
  'expire',
  'expired',
  'obsoleted',
  'stale',
  'timed-out',
  'timeout',
]);

export function computeDreamingSignal(cards, verdicts = [], options = {}) {
  if (!Array.isArray(cards)) throw new Error('cards must be an array');
  if (!Array.isArray(verdicts)) throw new Error('verdicts must be an array');

  const window = normalizeWindow(options);
  const now = dateFrom(options.now);
  const edgeCards = cards
    .filter(isPlainObject)
    .filter(isDreamingEdgeCard)
    .map((card) => projectEdgeCard(card, { now }))
    .filter((card) => withinWindow(card.windowAt, window));
  const dispositionCounts = countDispositions(edgeCards);
  const disposed = dispositionCounts.acted + dispositionCounts.dismissed + dispositionCounts.expired;
  const refs = edgeCards.flatMap((card) => card.outputRefs);
  const linkedVerdicts = verdicts
    .map(projectMindEvalVerdict)
    .filter(Boolean)
    .filter((verdict) => verdictMatchesRefs(verdict, refs))
    .filter((verdict) => withinWindow(verdict.windowAt, window));
  const verdictCounts = countVerdicts(linkedVerdicts);

  return deepFreeze({
    kind: 'DreamingHitRateSignal',
    schemaVersion: 1,
    score: disposed === 0 ? null : dispositionCounts.acted / disposed,
    hitRate: disposed === 0 ? null : dispositionCounts.acted / disposed,
    junkRate: linkedVerdicts.length === 0 ? null : verdictCounts.junk / linkedVerdicts.length,
    counted: {
      edgeCards: edgeCards.length,
      disposed,
      acted: dispositionCounts.acted,
      dismissed: dispositionCounts.dismissed,
      expired: dispositionCounts.expired,
      pending: dispositionCounts.pending,
      mindVerdicts: linkedVerdicts.length,
      junk: verdictCounts.junk,
      nod: verdictCounts.nod,
      actOn: verdictCounts.actOn,
    },
    dispositions: dispositionCounts,
    verdicts: {
      total: linkedVerdicts.length,
      junk: verdictCounts.junk,
      nod: verdictCounts.nod,
      actOn: verdictCounts.actOn,
      junkRate: linkedVerdicts.length === 0 ? null : verdictCounts.junk / linkedVerdicts.length,
    },
    blindSpots: [{
      kind: 'coverage',
      note: DREAMING_SIGNAL_BLIND_SPOT_NOTE,
    }],
  });
}

export async function computeDreamingSignalFromDataDir(input = {}) {
  const options = typeof input === 'string' ? { dataDir: input } : input;
  const dataDir = requiredDataDir(options.dataDir);
  const [cards, verdicts] = await Promise.all([
    readBuildCardArtifacts(dataDir),
    readMindEvalVerdicts(dataDir),
  ]);
  return computeDreamingSignal(cards, verdicts, options);
}

export async function computeDreamingSignalFromDir(dataDir, options = {}) {
  return computeDreamingSignalFromDataDir({
    ...options,
    dataDir,
  });
}

export async function readBuildCardArtifacts(dataDir) {
  const dir = safeDataPath(requiredDataDir(dataDir), BUILD_CARDS_DIR);
  return readJsonFiles(dir);
}

export async function readMindEvalVerdicts(dataDir) {
  const dir = safeDataPath(requiredDataDir(dataDir), MIND_EVAL_DIR);
  const logs = await readJsonFiles(dir, { prefix: 'mind-', suffix: '.json' });
  return logs.flatMap((log) => Array.isArray(log.verdicts) ? log.verdicts : []);
}

export function isDreamingEdgeCard(record) {
  if (!isPlainObject(record)) return false;
  if (
    record.edgeCard === true ||
    record.dreamingEdge === true ||
    record.isDreamingEdgeCard === true ||
    record.dreaming?.edgeCard === true ||
    record.dreaming?.edge === true ||
    record.metadata?.dreaming?.edgeCard === true ||
    record.metadata?.dreaming?.edge === true
  ) {
    return true;
  }

  return markerValues(record).some((value) => {
    const marker = normalizedToken(value);
    return marker === 'dreaming' ||
      marker === 'dreaming-v1' ||
      marker === 'dreaming-edge' ||
      marker === 'dreaming-edge-card' ||
      marker === 'edge-card' ||
      marker.includes('dreaming.edge') ||
      marker.includes('dreaming-edge') ||
      marker.includes('dreaming_edge');
  });
}

export function edgeCardDisposition(card, options = {}) {
  if (!isPlainObject(card)) return PENDING;

  const explicit = dispositionFromToken(firstString(
    card.disposition,
    card.edgeDisposition,
    card.cardDisposition,
    card.dreaming?.disposition,
    card.metadata?.dreaming?.disposition,
  ));
  if (explicit) return explicit;

  const status = normalizedToken(card.status);
  const statusDisposition = dispositionFromToken(status);
  if (statusDisposition) return statusDisposition;
  if (status === 'applied') return ACTED;
  if (status === 'obsoleted') return EXPIRED;

  const answerDisposition = dispositionFromToken(firstString(
    card.answerOption,
    card.optionId,
    card.answer?.optionId,
    card.answer?.verdict,
    card.decision?.optionId,
  ));
  if (answerDisposition) return answerDisposition;

  const recommendationDisposition = dispositionFromToken(card.recommendation);
  if (
    optionalString(card.answerOption) &&
    optionalString(card.recommendation) &&
    normalizedToken(card.answerOption) === normalizedToken(card.recommendation) &&
    recommendationDisposition
  ) {
    return recommendationDisposition;
  }

  if (isExpired(card, options.now)) return EXPIRED;
  return PENDING;
}

function projectEdgeCard(card, { now } = {}) {
  const disposition = edgeCardDisposition(card, { now });
  const outputRefs = cardOutputRefs(card);
  return {
    id: optionalString(card.id ?? card.cardId),
    disposition,
    outputRefs,
    windowAt: firstDateMs(
      dispositionAt(card, disposition),
      card.raisedAt,
      card.createdAt,
      card.updatedAt,
    ),
  };
}

function countDispositions(cards) {
  const counts = {
    acted: 0,
    dismissed: 0,
    expired: 0,
    pending: 0,
  };
  for (const card of cards) {
    counts[card.disposition] += 1;
  }
  return counts;
}

function countVerdicts(verdicts) {
  const counts = {
    junk: 0,
    nod: 0,
    actOn: 0,
  };
  for (const verdict of verdicts) {
    if (verdict.verdict === 'junk') counts.junk += 1;
    if (verdict.verdict === 'nod') counts.nod += 1;
    if (verdict.verdict === 'act-on') counts.actOn += 1;
  }
  return counts;
}

function dispositionFromToken(value) {
  const token = normalizedToken(value);
  if (!token) return null;
  if (ACTED_TOKENS.has(token)) return ACTED;
  if (DISMISSED_TOKENS.has(token)) return DISMISSED;
  if (EXPIRED_TOKENS.has(token)) return EXPIRED;
  if (token === PENDING) return PENDING;
  return null;
}

function isExpired(card, nowValue) {
  const now = dateFrom(nowValue);
  if (!now) return false;
  const expiresAt = firstDateMs(card.expiredAt, card.expiresAt, card.ttlAt);
  return expiresAt !== null && expiresAt <= now.getTime();
}

function dispositionAt(card, disposition = edgeCardDisposition(card)) {
  switch (disposition) {
    case ACTED:
      return firstString(card.actedAt, card.appliedAt, card.answeredAt, card.updatedAt);
    case DISMISSED:
      return firstString(card.dismissedAt, card.answeredAt, card.updatedAt);
    case EXPIRED:
      return firstString(card.expiredAt, card.obsoletedAt, card.expiresAt, card.updatedAt);
    default:
      return null;
  }
}

function cardOutputRefs(card) {
  const candidates = [
    outputRef(card),
    outputRef(card.mind, { allowIdFallback: true }),
    outputRef(card.dreaming, { allowIdFallback: true }),
    outputRef(card.outputRef, { allowIdFallback: true }),
    outputRef(card.mindOutput, { allowIdFallback: true }),
    outputRef(card.provenance),
    outputRef(card.shaping),
    outputRef({
      outputType: card.mindOutputType,
      outputId: card.mindOutputId,
    }),
    outputRef({
      outputType: card.dreamingOutputType,
      outputId: card.dreamingOutputId,
    }),
  ].filter(Boolean);
  const seen = new Set();
  const refs = [];
  for (const ref of candidates) {
    const key = `${ref.outputType ?? '*'}:${ref.outputId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }
  return refs;
}

function outputRef(value, options = {}) {
  if (!isPlainObject(value)) return null;
  const outputId = optionalString(
    value.outputId ??
      value.mindOutputId ??
      value.dreamingOutputId ??
      (options.allowIdFallback ? value.id : undefined),
  );
  if (!outputId) return null;
  const outputType = normalizeOutputType(value.outputType ?? value.type ?? value.group);
  return {
    outputType,
    outputId,
  };
}

function projectMindEvalVerdict(record) {
  if (!isPlainObject(record)) return null;
  const outputId = optionalString(record.outputId);
  const outputType = normalizeOutputType(record.outputType);
  const verdict = optionalString(record.verdict);
  if (!outputId || !outputType || !MIND_EVAL_VERDICTS.includes(verdict)) return null;
  return {
    passId: optionalString(record.passId) ?? null,
    date: optionalString(record.date) ?? null,
    outputType,
    outputId,
    verdict,
    windowAt: firstDateMs(record.date, record.passId),
  };
}

function verdictMatchesRefs(verdict, refs) {
  if (refs.length === 0) return false;
  return refs.some((ref) =>
    ref.outputId === verdict.outputId &&
    (!ref.outputType || ref.outputType === verdict.outputType));
}

function normalizeOutputType(value) {
  const type = optionalString(value);
  if (!type) return null;
  return MIND_OUTPUT_GROUPS.includes(type) ? type : null;
}

function markerValues(record) {
  return [
    record.origin,
    record.source,
    record.category,
    record.type,
    record.cardType,
    record.action,
    record.signal,
    record.routine,
    record.generatedBy,
    record.provenance?.origin,
    record.provenance?.source,
    record.provenance?.kind,
    record.dreaming?.origin,
    record.dreaming?.source,
    record.dreaming?.kind,
    record.metadata?.origin,
    record.metadata?.source,
    record.metadata?.category,
  ].filter((value) => optionalString(value));
}

function normalizedToken(value) {
  const text = optionalString(value);
  return text ? text.toLowerCase() : '';
}

function firstString(...values) {
  for (const value of values) {
    const text = optionalString(value);
    if (text) return text;
  }
  return null;
}

function firstDateMs(...values) {
  for (const value of values) {
    const ms = dateMs(value);
    if (ms !== null) return ms;
  }
  return null;
}

function dateMs(value) {
  const text = optionalString(value);
  if (!text) return null;
  const ms = new Date(text).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function dateFrom(value) {
  if (value === undefined || value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeWindow(options = {}) {
  const since = dateFrom(options.since);
  const until = dateFrom(options.until);
  return {
    sinceMs: since ? since.getTime() : null,
    untilMs: until ? until.getTime() : null,
  };
}

function withinWindow(ms, window) {
  if (ms === null) return true;
  if (window.sinceMs !== null && ms < window.sinceMs) return false;
  if (window.untilMs !== null && ms > window.untilMs) return false;
  return true;
}

async function readJsonFiles(dir, options = {}) {
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const files = entries
    .filter((entry) =>
      entry.isFile() &&
      entry.name.endsWith(options.suffix ?? '.json') &&
      (!options.prefix || entry.name.startsWith(options.prefix)))
    .map((entry) => entry.name)
    .sort();
  const records = [];
  for (const file of files) {
    try {
      records.push(JSON.parse(await fs.readFile(path.join(dir, file), 'utf8')));
    } catch {
      // Advisory signal only: corrupt card/verdict artifacts should remove that
      // sample from the reading, not fail the whole weekly retro.
    }
  }
  return records;
}

function requiredDataDir(value) {
  const dataDir = optionalString(value);
  if (!dataDir) throw new Error('dataDir is required');
  return dataDir;
}

function deepFreeze(value) {
  if (!isPlainObject(value) && !Array.isArray(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if ((isPlainObject(child) || Array.isArray(child)) && !Object.isFrozen(child)) {
      deepFreeze(child);
    }
  }
  return value;
}
