export function mean(values) {
  if (!values.length) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

export const average = mean;

// Linear-interpolation percentile (matches the common "p50/p95" reporting
// convention). `p` is a fraction in [0,1]. Returns 0 for an empty sample.
export function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const clamped = p < 0 ? 0 : p > 1 ? 1 : p;
  const rank = clamped * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower];
  const weight = rank - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

export function round(value, places) {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}
