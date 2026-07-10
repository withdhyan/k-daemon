import assert from 'node:assert/strict';
import test from 'node:test';

import {
  biosignalFootprintSampleInput,
  biosignalFootprintSampleInputs,
} from './biosignals.mjs';

test('maps plaintext HRV and RR signals to a FootprintSample input', () => {
  const sample = biosignalFootprintSampleInput({
    requested_output: 'planning_summary',
    surface: 'healthkit',
    hrv_ms: 42,
    respiratory_rate: 14,
    timestamp: '2026-06-29T10:00:00.000Z',
  });

  assert.equal(sample.provenance.surface, 'healthkit');
  assert.equal(sample.provenance.lane, 'ambient');
  assert.equal(sample.context.surface, 'healthkit');
  assert.equal(sample.eventAt, '2026-06-29T10:00:00.000Z');
  assert.equal(sample.physiology.hrv, 42);
  assert.equal(sample.outcome.measurements.hrv, 42);
  assert.equal(sample.outcome.measurements.respiratoryRate, 14);
  assert.match(sample.phenomenology.report, /HRV 42ms/);
  assert.match(sample.phenomenology.report, /RR 14/);
});

test('skips malformed body events without aborting the batch', () => {
  const result = biosignalFootprintSampleInputs([
    { requested_output: 'planning_summary' },
    { hrv: 35, rr: 12, source: 'whoop' },
    null,
  ]);

  assert.equal(result.samples.length, 1);
  assert.equal(result.skippedCount, 2);
  assert.equal(result.samples[0].provenance.surface, 'whoop');
});

test('expands nested iOS nutrition payloads and maps underscore macro keys', () => {
  const result = biosignalFootprintSampleInputs(
    {
      event_type: 'nutrition_log',
      source: 'ios',
      timestamp: '2026-06-29T11:00:00.000Z',
      requested_output: 'planning_summary',
      meal: {
        calories: 650,
        protein_grams: 42,
        carbs_grams: 72,
        fat_grams: 18,
      },
    },
    { kind: 'nutrition', surface: 'body' },
  );

  assert.equal(result.samples.length, 1);
  assert.deepEqual(result.samples[0].outcome.measurements, {
    calories: 650,
    protein: 42,
    carbs: 72,
    fat: 18,
  });
  assert.equal(result.samples[0].provenance.surface, 'body');
});

test('expands nested WHOOP telemetry payloads', () => {
  const result = biosignalFootprintSampleInputs(
    {
      event_type: 'whoop_ble_telemetry',
      source: 'ios',
      timestamp: '2026-06-29T12:00:00.000Z',
      telemetry: {
        source: 'realtime',
        timestamp: '2026-06-29T12:00:00.000Z',
        heart_rate_bpm: 72,
      },
    },
    { kind: 'signals', surface: 'whoop' },
  );

  assert.equal(result.samples.length, 1);
  assert.equal(result.samples[0].provenance.surface, 'whoop');
  assert.equal(result.samples[0].outcome.measurements.heartratebpm, 72);
});

test('route options override body-supplied surfaces', () => {
  const sample = biosignalFootprintSampleInput(
    {
      source: 'healthkit',
      hrv_ms: 42,
    },
    { kind: 'signals', surface: 'body' },
  );

  assert.equal(sample.provenance.surface, 'body');
  assert.equal(sample.context.surface, 'body');
});

test('known numeric measurements coerce finite strings and drop non-finite strings', () => {
  const result = biosignalFootprintSampleInputs([
    { steps: 'NaNish' },
    { steps: '1234' },
  ]);

  assert.equal(result.samples.length, 1);
  assert.equal(result.skippedCount, 1);
  assert.equal(result.samples[0].outcome.measurements.steps, 1234);
});

test('out-of-range numeric timestamps keep otherwise valid measurements', () => {
  const sample = biosignalFootprintSampleInput({
    timestamp: 8.7e15,
    hrv_ms: 38,
  });

  assert.equal(sample.eventAt, undefined);
  assert.equal(sample.outcome.measurements.hrv, 38);
});

test('reports batches over the caller-supplied event cap without processing samples', () => {
  const result = biosignalFootprintSampleInputs(
    {
      events: [{ hrv_ms: 1 }, { hrv_ms: 2 }],
    },
    { maxEvents: 1 },
  );

  assert.equal(result.tooManyEvents, true);
  assert.equal(result.eventCount, 2);
  assert.equal(result.samples.length, 0);
});
