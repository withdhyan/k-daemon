export function vrsdSelect(queryEmbedding, candidates, k = 20) {
  if (!Array.isArray(candidates) || candidates.length === 0 || k <= 0) {
    return [];
  }

  const query = norm(queryEmbedding);
  if (query.length === 0) return [];

  const normalized = candidates.map((doc) => norm(doc.embedding));
  const remaining = normalized.map((_, index) => index);
  const selected = [];
  let sumVector = Array.from({ length: query.length }, () => 0);

  while (remaining.length > 0 && selected.length < k) {
    let bestIndex = -1;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const index of remaining) {
      const candidateSum = vecAdd(sumVector, normalized[index], query.length);
      const score = dot(query, norm(candidateSum));
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }

    selected.push(bestIndex);
    sumVector = vecAdd(sumVector, normalized[bestIndex], query.length);
    remaining.splice(remaining.indexOf(bestIndex), 1);
  }

  return selected.map((index) => candidates[index]);
}

export function cosineSimilarity(a, b) {
  const similarity = dot(norm(a), norm(b));
  return Math.max(-1, Math.min(1, similarity));
}

export function norm(vector) {
  if (!Array.isArray(vector)) return [];

  let magnitudeSquared = 0;
  for (const value of vector) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return [];
    }
    magnitudeSquared += value * value;
  }

  if (magnitudeSquared === 0) return vector.slice();

  const magnitude = Math.sqrt(magnitudeSquared);
  return vector.map((value) => value / magnitude);
}

export function dot(a, b) {
  const length = Math.min(a.length, b.length);
  let total = 0;
  for (let index = 0; index < length; index += 1) {
    total += a[index] * b[index];
  }
  return total;
}

function vecAdd(a, b, length = Math.max(a.length, b.length)) {
  const sum = [];
  for (let index = 0; index < length; index += 1) {
    sum.push((a[index] ?? 0) + (b[index] ?? 0));
  }
  return sum;
}
