export const MIN_RELEVANCE = 0.7;
export const MIN_CONFIDENCE = 0.85;
export const FOCUS_ATTENTION = 'focus';
export const MAX_SURFACED_PER_HOUR = 2;
export const RATE_WINDOW_MS = 60 * 60 * 1000;
export const RECENCY_COOLDOWN_MS = 2 * RATE_WINDOW_MS;

export const SURFACE_REASONS = Object.freeze({
  PASSED: 'passed',
  LOW_RELEVANCE: 'low_relevance',
  LOW_CONFIDENCE: 'low_confidence',
  DEEP_FOCUS: 'deep_focus',
  RATE_LIMIT: 'rate_limit',
  RECENCY_COOLDOWN: 'recency_cooldown',
  INVALID_NOW: 'invalid_now',
});

export function shouldSurface({
  relevance,
  confidence,
  attention,
  lastSurfacedAt,
  surfacedCountThisHour = 0,
  now,
  critical = false,
} = {}) {
  const nowMs = timeMs(now);
  if (!Number.isFinite(nowMs)) {
    return decision(false, SURFACE_REASONS.INVALID_NOW);
  }

  if (Number(relevance) < MIN_RELEVANCE) {
    return decision(false, SURFACE_REASONS.LOW_RELEVANCE);
  }

  if (Number(confidence) < MIN_CONFIDENCE) {
    return decision(false, SURFACE_REASONS.LOW_CONFIDENCE);
  }

  if (attention === FOCUS_ATTENTION && critical !== true) {
    return decision(false, SURFACE_REASONS.DEEP_FOCUS);
  }

  const lastMs = timeMs(lastSurfacedAt);
  const surfacedCount = Number.isFinite(Number(surfacedCountThisHour))
    ? Math.max(0, Math.floor(Number(surfacedCountThisHour)))
    : 0;
  const withinRateWindow = Number.isFinite(lastMs) && nowMs - lastMs < RATE_WINDOW_MS;
  const effectiveHourlyCount = withinRateWindow ? surfacedCount : 0;

  if (effectiveHourlyCount >= MAX_SURFACED_PER_HOUR) {
    return decision(false, SURFACE_REASONS.RATE_LIMIT);
  }

  if (Number.isFinite(lastMs) && nowMs - lastMs < RECENCY_COOLDOWN_MS) {
    return decision(false, SURFACE_REASONS.RECENCY_COOLDOWN);
  }

  return decision(true, SURFACE_REASONS.PASSED);
}

function decision(surface, reason) {
  return Object.freeze({ surface, reason });
}

function timeMs(value) {
  if (value === undefined || value === null || value === '') return Number.NaN;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return new Date(value).getTime();
  return Number.NaN;
}
