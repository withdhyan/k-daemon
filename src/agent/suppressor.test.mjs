import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_SURFACED_PER_HOUR,
  MIN_CONFIDENCE,
  MIN_RELEVANCE,
  RATE_WINDOW_MS,
  RECENCY_COOLDOWN_MS,
  shouldSurface,
  SURFACE_REASONS,
} from './suppressor.mjs';

const NOW = new Date('2026-07-02T10:00:00.000Z');

test('low relevance is suppressed', () => {
  assert.deepEqual(
    shouldSurface({ relevance: 0.5, confidence: 0.9, attention: 'neutral', now: NOW }),
    { surface: false, reason: SURFACE_REASONS.LOW_RELEVANCE },
  );
});

test('low confidence is suppressed', () => {
  assert.deepEqual(
    shouldSurface({ relevance: 0.8, confidence: 0.7, attention: 'neutral', now: NOW }),
    { surface: false, reason: SURFACE_REASONS.LOW_CONFIDENCE },
  );
});

test('focus attention suppresses non-critical pushes', () => {
  assert.deepEqual(
    shouldSurface({ relevance: 0.9, confidence: 0.9, attention: 'focus', now: NOW }),
    { surface: false, reason: SURFACE_REASONS.DEEP_FOCUS },
  );
});

test('critical pushes can pass the focus gate', () => {
  assert.deepEqual(
    shouldSurface({ relevance: 0.9, confidence: 0.9, attention: 'focus', critical: true, now: NOW }),
    { surface: true, reason: SURFACE_REASONS.PASSED },
  );
});

test('rate limit suppresses after two surfaces in the current hour', () => {
  assert.deepEqual(
    shouldSurface({
      relevance: 0.9,
      confidence: 0.9,
      attention: 'neutral',
      lastSurfacedAt: new Date(NOW.getTime() - 5 * 60 * 1000),
      surfacedCountThisHour: MAX_SURFACED_PER_HOUR,
      now: NOW,
    }),
    { surface: false, reason: SURFACE_REASONS.RATE_LIMIT },
  );
});

test('recency cooldown suppresses even below the hourly rate limit', () => {
  assert.deepEqual(
    shouldSurface({
      relevance: 0.9,
      confidence: 0.9,
      attention: 'neutral',
      lastSurfacedAt: new Date(NOW.getTime() - RATE_WINDOW_MS - 1),
      surfacedCountThisHour: 1,
      now: NOW,
    }),
    { surface: false, reason: SURFACE_REASONS.RECENCY_COOLDOWN },
  );
});

test('passes all gates with exact threshold boundaries', () => {
  assert.deepEqual(
    shouldSurface({
      relevance: MIN_RELEVANCE,
      confidence: MIN_CONFIDENCE,
      attention: 'neutral',
      surfacedCountThisHour: 0,
      now: NOW,
    }),
    { surface: true, reason: SURFACE_REASONS.PASSED },
  );
});

test('combined failures report the first failed gate deterministically', () => {
  assert.deepEqual(
    shouldSurface({
      relevance: 0.1,
      confidence: 0.1,
      attention: 'focus',
      surfacedCountThisHour: MAX_SURFACED_PER_HOUR,
      now: NOW,
    }),
    { surface: false, reason: SURFACE_REASONS.LOW_RELEVANCE },
  );
});

test('rate window rolls over when the last surface is outside the cooldown window', () => {
  assert.deepEqual(
    shouldSurface({
      relevance: 0.9,
      confidence: 0.9,
      attention: 'neutral',
      lastSurfacedAt: new Date(NOW.getTime() - RECENCY_COOLDOWN_MS - 1),
      surfacedCountThisHour: MAX_SURFACED_PER_HOUR,
      now: NOW,
    }),
    { surface: true, reason: SURFACE_REASONS.PASSED },
  );
});

test('missing now fails closed without calling Date.now', () => {
  assert.deepEqual(
    shouldSurface({ relevance: 0.9, confidence: 0.9, attention: 'neutral' }),
    { surface: false, reason: SURFACE_REASONS.INVALID_NOW },
  );
});
