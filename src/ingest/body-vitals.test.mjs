import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bodyVitalRecordInput,
  bodyVitalRecordInputs,
} from './body-vitals.mjs';

test('maps consented HealthKit sleep, HRV, and recovery batches to VitalRecord inputs', () => {
  const result = bodyVitalRecordInputs({
    off_phone_consent: true,
    consent_granted_at: '2026-06-29T08:00:00.000Z',
    source: 'healthkit',
    samples: [
      {
        type: 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN',
        uuid: 'hk-hrv-1',
        value: 42,
        unit: 'ms',
        start_date: '2026-06-29T06:00:00.000Z',
        end_date: '2026-06-29T06:05:00.000Z',
      },
      {
        kind: 'sleep',
        id: 'sleep-2026-06-29',
        start_at: '2026-06-28T22:30:00.000Z',
        end_at: '2026-06-29T06:30:00.000Z',
        duration_minutes: 455,
        sleep_efficiency: 0.91,
      },
      {
        kind: 'recovery',
        id: 'recovery-2026-06-29',
        timestamp: '2026-06-29T07:00:00.000Z',
        recovery_score: 78,
        hrv_ms: 39,
      },
      { kind: 'note', text: 'not a vital sample' },
    ],
  });

  assert.equal(result.missingConsent, false);
  assert.equal(result.tooManyEvents, false);
  assert.equal(result.eventCount, 4);
  assert.equal(result.skippedCount, 1);
  assert.equal(result.samples.length, 3);

  assert.deepEqual(result.samples.map((sample) => sample.vitalKind), ['hrv', 'sleep', 'recovery']);
  assert.equal(result.samples[0].provenance.surface, 'healthkit');
  assert.equal(result.samples[0].measurements.hrvMs, 42);
  assert.equal(result.samples[0].validFrom, '2026-06-29T06:00:00.000Z');
  assert.equal(result.samples[0].eventAt, '2026-06-29T06:05:00.000Z');
  assert.equal(result.samples[0].units.hrvMs, 'ms');
  assert.deepEqual(result.samples[0].consent, {
    offPhone: true,
    scope: 'body:vitals',
    grantedAt: '2026-06-29T08:00:00.000Z',
  });
  assert.deepEqual(result.samples[1].measurements, {
    durationMinutes: 455,
    sleepEfficiency: 0.91,
  });
  assert.deepEqual(result.samples[2].measurements, {
    recoveryScore: 78,
    hrvMs: 39,
  });
});

test('refuses to normalize body vitals without explicit off-phone consent', () => {
  const result = bodyVitalRecordInputs({
    source: 'healthkit',
    samples: [{ kind: 'hrv', hrv_ms: 42 }],
  });
  const genericConsent = bodyVitalRecordInputs({
    consent: { granted: true },
    source: 'healthkit',
    samples: [{ kind: 'hrv', hrv_ms: 42 }],
  });

  assert.deepEqual(result, {
    samples: [],
    skippedCount: 0,
    eventCount: 0,
    tooManyEvents: false,
    missingConsent: true,
  });
  assert.equal(genericConsent.missingConsent, true);
});

test('reports batches over the caller-supplied body vital event cap', () => {
  const result = bodyVitalRecordInputs(
    {
      consent: true,
      samples: [{ kind: 'hrv', hrv_ms: 1 }, { kind: 'hrv', hrv_ms: 2 }],
    },
    { maxEvents: 1 },
  );

  assert.equal(result.tooManyEvents, true);
  assert.equal(result.eventCount, 2);
  assert.equal(result.samples.length, 0);
});

test('single body vital normalization accepts structured consent objects', () => {
  const sample = bodyVitalRecordInput({
    consent: { offPhone: true, scope: 'healthkit:hrv' },
    source: 'apple-healthkit',
    kind: 'hrv',
    sample_id: 'hk-hrv-2',
    timestamp: '2026-06-29T06:05:00.000Z',
    hrv_ms: '41.5',
  });

  assert.equal(sample.vitalKind, 'hrv');
  assert.equal(sample.provenance.surface, 'healthkit');
  assert.equal(sample.sampleId, 'hk-hrv-2');
  assert.deepEqual(sample.measurements, { hrvMs: 41.5 });
  assert.deepEqual(sample.consent, {
    offPhone: true,
    scope: 'healthkit:hrv',
  });
});
