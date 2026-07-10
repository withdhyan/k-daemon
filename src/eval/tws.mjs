import { promises as fs } from 'node:fs';
import path from 'node:path';

const DECISIONS_DIR = 'decisions';
const ACTED = 'acted';
export const TWS_BLIND_SPOT_NOTE = 'measures only captured decisions; blind to uncaptured life';

export function computeTimeWellSpent(decisions, options = {}) {
  if (!Array.isArray(decisions)) {
    throw new Error('decisions must be an array');
  }

  const recommendations = decisions.filter(isRecommendation);
  const recommended = recommendations.length;
  const acted = recommendations.filter((decision) => decision.acted === ACTED).length;
  const bodyRecommendations = recommendations.filter(isBodyRecommendation);

  return Object.freeze({
    recommended,
    acted,
    decisionSignal: recommended === 0 ? null : acted / recommended,
    silenceCount: normalizeCount(options.silenceCount),
    dimensions: Object.freeze({
      body: dimensionReading(bodyRecommendations),
    }),
  });
}

export async function computeTimeWellSpentFromDir(dataDir, options = {}) {
  const decisions = await readDecisionArtifacts(dataDir);
  return computeTimeWellSpent(decisions, options);
}

export async function computeTwsFromDataDir({ dataDir, now, ...options } = {}) {
  const decisions = await readDecisionArtifacts(dataDir);
  const reading = computeTimeWellSpent(decisions, options);

  return Object.freeze({
    score: reading.decisionSignal,
    counted: Object.freeze({
      recommended: reading.recommended,
      acted: reading.acted,
      silenceCount: reading.silenceCount,
    }),
    dimensions: reading.dimensions,
    blindSpots: Object.freeze([
      Object.freeze({
        kind: 'coverage',
        note: TWS_BLIND_SPOT_NOTE,
      }),
    ]),
  });
}

export async function readDecisionArtifacts(dataDir) {
  const dir = path.join(path.resolve(dataDir), DECISIONS_DIR);
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

  return Promise.all(
    files.map(async (name) => JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'))),
  );
}

function isRecommendation(decision) {
  return (
    isRecord(decision) &&
    decision.kind === 'LoopRecommendation' &&
    decision.station === 'decide' &&
    decision.verdict === 'recommend' &&
    decision.advisoryOnly === true &&
    typeof decision.recommended === 'string' &&
    decision.recommended.trim().length > 0
  );
}

function isBodyRecommendation(decision) {
  const surface = firstLowerString(
    decision.surface,
    decision.targetSurface,
    decision.protocol?.surface,
    decision.provenance?.surface,
  );
  const kind = firstLowerString(
    decision.recommendationKind,
    decision.protocolKind,
    decision.category,
    decision.protocol?.kind,
    decision.protocol?.source,
  );

  return surface === 'body' || surface === 'body-protocol' || kind === 'body-protocol';
}

function dimensionReading(recommendations) {
  const recommended = recommendations.length;
  const acted = recommendations.filter((decision) => decision.acted === ACTED).length;

  return Object.freeze({
    recommended,
    acted,
    decisionSignal: recommended === 0 ? null : acted / recommended,
  });
}

function firstLowerString(...values) {
  for (const value of values) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (text) return text.toLowerCase();
  }
  return undefined;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeCount(value) {
  if (value === undefined) return 0;
  const count = Number(value);
  if (!Number.isInteger(count) || count < 0) {
    throw new Error('silenceCount must be a non-negative integer');
  }
  return count;
}
