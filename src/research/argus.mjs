import {
  cosineSimilarity,
  norm,
} from './vrsd.mjs';

export function buildBlindSpotIndex(allDocs, opts = {}) {
  const isolationThreshold = opts.isolationThreshold ?? 0.4;
  if (!Array.isArray(allDocs) || allDocs.length === 0) return [];

  const normalized = allDocs.map((doc) => norm(doc.embedding));
  const entries = [];

  for (const [index, doc] of allDocs.entries()) {
    const current = normalized[index];
    if (current.length === 0) continue;

    const others = normalized.filter((candidate, candidateIndex) =>
      candidateIndex !== index && candidate.length > 0);
    const isolationScore = minDistanceToSet(current, others);
    if (isolationScore >= isolationThreshold) {
      entries.push({ doc, isolationScore, norm: current });
    }
  }

  return entries.sort((a, b) =>
    b.isolationScore - a.isolationScore || String(a.doc.id).localeCompare(String(b.doc.id)));
}

export function injectBlindSpots(queryEmbedding, candidates, index, opts = {}) {
  if (!Array.isArray(index) || index.length === 0) return candidates ?? [];

  const relevanceFloor = opts.relevanceFloor ?? 0.25;
  const maxInject = opts.maxInject ?? 10;
  const existingIds = new Set((candidates ?? []).map((doc) => doc.id));
  const injected = [];

  for (const entry of index) {
    if (injected.length >= maxInject) break;
    if (!entry?.doc || existingIds.has(entry.doc.id)) continue;

    const entryNorm = entry.norm ?? norm(entry.doc.embedding);
    const relevance = cosineSimilarity(queryEmbedding, entryNorm);
    if (relevance >= relevanceFloor) {
      injected.push(entry.doc);
      existingIds.add(entry.doc.id);
    }
  }

  return [...(candidates ?? []), ...injected];
}

function minDistanceToSet(docNorm, setNorms) {
  if (setNorms.length === 0) return 1;

  let nearestSimilarity = Number.NEGATIVE_INFINITY;
  for (const candidate of setNorms) {
    nearestSimilarity = Math.max(nearestSimilarity, cosineSimilarity(docNorm, candidate));
  }

  return 1 - nearestSimilarity;
}
