import {
  cosineSimilarity,
} from './vrsd.mjs';

export const LEVY_FREQUENCY_MU = Object.freeze({
  daily: 2.5,
  weekly: 2.0,
  monthly: 1.5,
});

export function levyExplore(queryEmbedding, allDocs, selectedIds = new Set(), opts = {}) {
  if (!Array.isArray(allDocs) || allDocs.length === 0) return [];

  const nWalks = opts.nWalks ?? 2;
  const minDistance = opts.minDistance ?? 0.5;
  const random = opts.random ?? Math.random;
  const mu = frequencyToMu(opts.frequency ?? 'daily');
  const usedIds = idSet(selectedIds);
  let candidates = allDocs.filter((doc) => !usedIds.has(doc.id));
  const explored = [];

  for (let walk = 0; walk < nWalks && candidates.length > 0; walk += 1) {
    const step = levyStepSize(mu, { random });
    const targetDistance = Math.max(minDistance, Math.min(2, step * 0.1));
    let bestDoc = null;
    let bestGap = Number.POSITIVE_INFINITY;

    for (const doc of candidates) {
      const distance = 1 - cosineSimilarity(queryEmbedding, doc.embedding);
      if (distance < minDistance) continue;

      const gap = Math.abs(distance - targetDistance);
      if (gap < bestGap) {
        bestGap = gap;
        bestDoc = doc;
      }
    }

    if (!bestDoc) break;

    explored.push(bestDoc);
    usedIds.add(bestDoc.id);
    candidates = candidates.filter((doc) => !usedIds.has(doc.id));
  }

  return explored;
}

export function checkNovelty(selected, explored) {
  if (!Array.isArray(explored) || explored.length === 0) return false;

  const selectedIds = idSet(selected);
  return explored.some((doc) => !selectedIds.has(idOf(doc)));
}

export function levyStepSize(mu, opts = {}) {
  if (typeof mu !== 'number' || !Number.isFinite(mu) || mu <= 1) {
    throw new Error('mu must be a finite number greater than 1');
  }

  const random = opts.random ?? Math.random;
  const alpha = mu - 1;
  const sample = Math.max(Number.EPSILON, random());
  return sample ** (-1 / alpha);
}

export function frequencyToMu(frequency) {
  if (typeof frequency === 'number') return frequency;

  const key = String(frequency ?? 'daily').toLowerCase();
  const mu = LEVY_FREQUENCY_MU[key];
  if (!mu) {
    throw new Error(`unknown Levy frequency: ${frequency}`);
  }
  return mu;
}

function idSet(values) {
  if (values instanceof Set) return new Set([...values].map(idOf));
  if (!Array.isArray(values)) return new Set();
  return new Set(values.map(idOf));
}

function idOf(value) {
  if (value && typeof value === 'object') return value.id;
  return value;
}
