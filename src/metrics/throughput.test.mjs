import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_ADMISSION_THRESHOLD,
  MODEL_LANES,
  PRIORITY,
  createAdmissionScheduler,
  createThroughputStore,
  deriveTokenMetrics,
  instrumentModelCall,
  toMetricSample,
} from './throughput.mjs';

test('per-lane TTFT p50/p95 + TPS are computed from real call metadata', () => {
  const store = createThroughputStore();
  // gen_ms varies so TPS (completion_tok/gen_ms*1000) is a real distribution.
  const ttfts = [100, 200, 300, 400, 500];
  for (const ttft of ttfts) {
    store.record({
      lane: 'frontier',
      model: 'claude',
      prompt_tok: 50,
      completion_tok: 100,
      ttft_ms: ttft,
      gen_ms: 1000, // 100 tok / 1000ms = 100 tps
    });
  }

  const metrics = store.laneMetrics('frontier');
  assert.equal(metrics.lane, 'frontier');
  assert.equal(metrics.calls, 5);
  assert.equal(metrics.ttft_p50_ms, 300); // median of 100..500
  assert.equal(metrics.ttft_p95_ms, 480); // linear-interp p95
  assert.equal(metrics.tps, 100);
});

test('OpenRouter usage and Ollama eval_count/eval_duration both normalize to token metrics', () => {
  const openrouter = deriveTokenMetrics({
    usage: { prompt_tokens: 40, completion_tokens: 120 },
  });
  assert.equal(openrouter.prompt_tok, 40);
  assert.equal(openrouter.completion_tok, 120);

  const ollama = deriveTokenMetrics({
    prompt_eval_count: 30,
    eval_count: 90,
    eval_duration: 900_000_000, // 900ms in nanoseconds
  });
  assert.equal(ollama.prompt_tok, 30);
  assert.equal(ollama.completion_tok, 90);
  assert.equal(ollama.gen_ms, 900);
});

test('a concurrency probe records a peak and utilization = current ÷ peak', () => {
  const store = createThroughputStore();
  // Current aggregate: 100 tps per call.
  store.record({ lane: 'local', model: 'qwen', completion_tok: 100, gen_ms: 1000, ttft_ms: 50 });
  // Probe finds a plateau of 400 tps.
  store.recordPeak('local', 400);

  const metrics = store.laneMetrics('local');
  assert.equal(metrics.peak_tps, 400);
  assert.equal(metrics.tps, 100);
  assert.equal(metrics.utilization, 0.25); // 100 / 400
  assert.equal(store.utilization('local'), 0.25);
});

test('utilization is null when no peak has been probed', () => {
  const store = createThroughputStore();
  store.record({ lane: 'sovereign', model: 'hermes', completion_tok: 50, gen_ms: 500, ttft_ms: 40 });
  assert.equal(store.laneMetrics('sovereign').utilization, null);
});

test('recordPeak keeps the maximum plateau observed', () => {
  const store = createThroughputStore();
  store.recordPeak('local', 300);
  store.recordPeak('local', 500);
  store.recordPeak('local', 200); // lower — ignored
  assert.equal(store.laneMetrics('local').peak_tps, 500);
});

test('the ring is bounded to the configured window', () => {
  const store = createThroughputStore({ window: 3 });
  for (let i = 0; i < 10; i += 1) {
    store.record({ lane: 'frontier', model: 'm', completion_tok: 10, gen_ms: 100, ttft_ms: i });
  }
  assert.equal(store.laneMetrics('frontier').calls, 3);
});

test('a background loop is ADMITTED under low utilization', () => {
  const store = createThroughputStore();
  store.record({ lane: 'local', model: 'q', completion_tok: 100, gen_ms: 1000, ttft_ms: 50 });
  store.recordPeak('local', 1000); // utilization 0.1 — spare exists
  const scheduler = createAdmissionScheduler({ store });

  const decision = scheduler.admit({ priority: PRIORITY.LOW, lane: 'local' });
  assert.equal(decision.admitted, true);
  assert.equal(decision.reason, 'spare_bandwidth');
});

test('a background loop is REFUSED when utilization is at/above threshold', () => {
  const store = createThroughputStore();
  store.record({ lane: 'local', model: 'q', completion_tok: 950, gen_ms: 1000, ttft_ms: 50 });
  store.recordPeak('local', 1000); // utilization 0.95 > 0.8 threshold
  const scheduler = createAdmissionScheduler({ store });

  const decision = scheduler.admit({ priority: PRIORITY.LOW, lane: 'local' });
  assert.equal(decision.admitted, false);
  assert.equal(decision.reason, 'no_spare_bandwidth');
});

test('interactive turns are always admitted regardless of utilization', () => {
  const store = createThroughputStore();
  store.record({ lane: 'local', model: 'q', completion_tok: 999, gen_ms: 1000, ttft_ms: 50 });
  store.recordPeak('local', 1000); // saturated
  const scheduler = createAdmissionScheduler({ store });

  const decision = scheduler.admit({ priority: PRIORITY.HIGH, lane: 'local' });
  assert.equal(decision.admitted, true);
  assert.equal(decision.reason, 'interactive');
});

test('background work YIELDS the moment an interactive turn arrives', () => {
  const store = createThroughputStore();
  store.recordPeak('local', 1000); // spare exists, no live calls
  const scheduler = createAdmissionScheduler({ store });

  // Spare bandwidth: background admitted while no interactive turn is in flight.
  assert.equal(scheduler.admit({ priority: PRIORITY.LOW, lane: 'local' }).admitted, true);
  assert.equal(scheduler.shouldYield(), false);

  // Interactive turn arrives → background must yield even though spare exists.
  const release = scheduler.beginInteractive();
  assert.equal(scheduler.shouldYield(), true);
  const yielded = scheduler.admit({ priority: PRIORITY.LOW, lane: 'local' });
  assert.equal(yielded.admitted, false);
  assert.equal(yielded.reason, 'yield_to_interactive');

  // Interactive turn completes → background admitted again.
  release();
  assert.equal(scheduler.shouldYield(), false);
  assert.equal(scheduler.admit({ priority: PRIORITY.LOW, lane: 'local' }).admitted, true);
});

test('concurrent interactive turns keep background yielded until all release', () => {
  const scheduler = createAdmissionScheduler({ store: createThroughputStore() });
  const releaseA = scheduler.beginInteractive();
  const releaseB = scheduler.beginInteractive();
  assert.equal(scheduler.interactiveActive(), true);
  releaseA();
  assert.equal(scheduler.interactiveActive(), true); // B still in flight
  releaseB();
  assert.equal(scheduler.interactiveActive(), false);
});

test('the default admission threshold is exposed and used', () => {
  const scheduler = createAdmissionScheduler({ store: createThroughputStore() });
  assert.equal(scheduler.threshold, DEFAULT_ADMISSION_THRESHOLD);
});

test('instrumentModelCall records a content-free sample and never blocks the call', async () => {
  const store = createThroughputStore();
  const rawResult = {
    // Simulated OpenRouter-shaped result WITH content — the recorder must not
    // capture the content, only usage counts.
    choices: [{ message: { content: 'a private secret answer about the founder genome' } }],
    usage: { prompt_tokens: 12, completion_tokens: 34 },
  };
  const modelCall = async () => rawResult;
  const instrumented = instrumentModelCall(modelCall, { store, lane: 'sovereign', model: 'hermes' });

  const result = await instrumented({ user: 'private secret prompt' });
  assert.equal(result, rawResult); // pass-through unchanged

  const ring = store.snapshot().lanes.find((l) => l.lane === 'sovereign');
  assert.equal(ring.calls, 1);
  // The recorded sample carries ONLY numeric metrics — assert no content leaked.
  const serialized = JSON.stringify(store.snapshot());
  assert.ok(!serialized.includes('secret'));
  assert.ok(!serialized.includes('genome'));
});

test('a recorder failure never breaks the model call', async () => {
  const brokenStore = { record() { throw new Error('boom'); } };
  const instrumented = instrumentModelCall(async () => ({ ok: true }), {
    store: brokenStore,
    lane: 'frontier',
    model: 'm',
  });
  const result = await instrumented({ user: 'hi' });
  assert.deepEqual(result, { ok: true });
});

test('a model-call rejection still records timing and re-throws', async () => {
  const store = createThroughputStore();
  const instrumented = instrumentModelCall(async () => { throw new Error('upstream 500'); }, {
    store,
    lane: 'frontier',
    model: 'm',
  });
  await assert.rejects(() => instrumented({ user: 'hi' }), /upstream 500/);
  // Timing was still recorded (finally block).
  assert.equal(store.laneMetrics('frontier').calls, 1);
});

test('toMetricSample strips any text-bearing fields', () => {
  const sample = toMetricSample({
    lane: 'local',
    model: 'qwen',
    prompt_tok: 5,
    completion_tok: 10,
    ttft_ms: 20,
    gen_ms: 100,
    user: 'sensitive genome text',
    system: 'system prompt',
    response: 'model output',
  });
  assert.deepEqual(Object.keys(sample).sort(), ['at', 'completion_tok', 'gen_ms', 'lane', 'model', 'prompt_tok', 'ttft_ms']);
  assert.ok(!JSON.stringify(sample).includes('genome'));
});

test('unknown lanes normalize to the frontier lane', () => {
  const store = createThroughputStore();
  store.record({ lane: 'mystery', model: 'm', completion_tok: 10, gen_ms: 100, ttft_ms: 5 });
  assert.equal(store.laneMetrics('frontier').calls, 1);
});

test('snapshot exposes every known lane', () => {
  const snapshot = createThroughputStore().snapshot();
  assert.deepEqual(snapshot.lanes.map((l) => l.lane).sort(), [...MODEL_LANES].sort());
});
