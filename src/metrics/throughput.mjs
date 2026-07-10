// U10 — throughput metrics + spare-bandwidth scheduler (cs-k).
//
// Three parts, all daemon-owned and content-free:
//   (a) instrument — wrap every model call, record {lane, model, prompt_tok,
//       completion_tok, ttft_ms, gen_ms}; derive per-lane TTFT p50/p95 + TPS.
//   (b) metrics store — a bounded, in-memory ring per lane. NEVER holds prompt
//       or completion TEXT; only token COUNTS + timings. This is what
//       GET /api/metrics projects — safe to expose (KTD9: no content on wire).
//   (c) scheduler — live utilization = current aggregate TPS ÷ measured peak;
//       a priority admission gate (interactive HIGH always admitted; background
//       LOW admitted only when utilization < threshold, and yields the moment
//       an interactive turn arrives).
//
// KTD9: metrics are non-sensitive by CONSTRUCTION — the recorder accepts only
// numeric fields + short identifiers (lane/model). It does not read the request
// user/system text at all, so private-chat / genome text cannot leak here.

import { mean, percentile, round } from '../math.mjs';

export const MODEL_LANES = Object.freeze(['frontier', 'sovereign', 'local']);

// Default ring depth per lane. Bounded so the store never grows unboundedly and
// so p50/p95/TPS reflect recent throughput, not the whole process lifetime.
const DEFAULT_WINDOW = 256;

// Utilization above which the background (LOW) lane is refused admission — a
// spare-bandwidth threshold. Interactive (HIGH) is never gated by utilization.
export const DEFAULT_ADMISSION_THRESHOLD = 0.8;

const NUMERIC_METRIC_FIELDS = Object.freeze([
  'prompt_tok',
  'completion_tok',
  'ttft_ms',
  'gen_ms',
]);

function normalizeLane(lane) {
  return MODEL_LANES.includes(lane) ? lane : 'frontier';
}

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

// tokens-per-second for a single call. gen_ms is generation wall-time; a call
// with no completion tokens or no duration contributes no TPS sample.
function callTps(sample) {
  if (sample.completion_tok <= 0 || sample.gen_ms <= 0) return 0;
  return (sample.completion_tok / sample.gen_ms) * 1000;
}

// Build a content-free metric sample from raw fields. Deliberately ignores any
// text-bearing keys the caller might pass — only the numeric metric fields and
// the lane/model identifiers survive.
export function toMetricSample({ lane, model, ...fields } = {}) {
  const sample = {
    lane: normalizeLane(lane),
    model: typeof model === 'string' ? model.slice(0, 120) : 'unknown',
    at: Number.isFinite(fields.at) ? fields.at : Date.now(),
  };
  sample.prompt_tok = nonNegativeNumber(fields.prompt_tok);
  sample.completion_tok = nonNegativeNumber(fields.completion_tok);
  sample.ttft_ms = nonNegativeNumber(fields.ttft_ms);
  sample.gen_ms = nonNegativeNumber(fields.gen_ms);
  return sample;
}

// OpenRouter (frontier + sovereign lanes) return `usage`; Ollama returns
// eval_count/eval_duration (ns). Normalize both into {prompt_tok, completion_tok,
// gen_ms} — timings the wrapper cannot measure fall back to caller-provided
// ttft_ms/gen_ms. No text is read.
export function deriveTokenMetrics(rawResult) {
  const metrics = { prompt_tok: 0, completion_tok: 0, gen_ms: 0 };
  if (!rawResult || typeof rawResult !== 'object') return metrics;

  const usage = rawResult.usage;
  if (usage && typeof usage === 'object') {
    metrics.prompt_tok = nonNegativeNumber(usage.prompt_tokens ?? usage.input_tokens);
    metrics.completion_tok = nonNegativeNumber(usage.completion_tokens ?? usage.output_tokens);
  }

  // Ollama: eval_count = completion tokens; prompt_eval_count = prompt tokens;
  // eval_duration is in NANOSECONDS.
  if (rawResult.eval_count !== undefined || rawResult.eval_duration !== undefined) {
    metrics.completion_tok = nonNegativeNumber(rawResult.eval_count) || metrics.completion_tok;
    metrics.prompt_tok = nonNegativeNumber(rawResult.prompt_eval_count) || metrics.prompt_tok;
    const evalNs = positiveNumber(rawResult.eval_duration);
    if (evalNs > 0) metrics.gen_ms = evalNs / 1e6;
  }

  return metrics;
}

export function createThroughputStore(options = {}) {
  const window = Number.isInteger(options.window) && options.window > 0
    ? options.window
    : DEFAULT_WINDOW;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  // Aggregate-TPS peak (plateau) per lane — set by the concurrency probe. Live
  // utilization is measured against this. 0 ⇒ unmeasured (utilization unknown).
  const peakTps = new Map(MODEL_LANES.map((lane) => [lane, 0]));
  const lanes = new Map(MODEL_LANES.map((lane) => [lane, []]));

  function laneRing(lane) {
    const key = normalizeLane(lane);
    return lanes.get(key);
  }

  // Non-blocking record: pure array push, no I/O, no await. Metrics logging must
  // never block a model call, so callers fire-and-forget this.
  function record(rawSample) {
    const sample = toMetricSample(rawSample);
    const ring = laneRing(sample.lane);
    ring.push(sample);
    if (ring.length > window) ring.splice(0, ring.length - window);
    return sample;
  }

  function laneMetrics(lane) {
    const ring = laneRing(lane);
    const ttfts = ring.filter((s) => s.ttft_ms > 0).map((s) => s.ttft_ms);
    const tpsSamples = ring.map(callTps).filter((v) => v > 0);
    const currentTps = round(mean(tpsSamples), 2);
    const peak = round(peakTps.get(normalizeLane(lane)) ?? 0, 2);
    return {
      lane: normalizeLane(lane),
      calls: ring.length,
      ttft_p50_ms: round(percentile(ttfts, 0.5), 2),
      ttft_p95_ms: round(percentile(ttfts, 0.95), 2),
      tps: currentTps,
      peak_tps: peak,
      utilization: peak > 0 ? round(currentTps / peak, 4) : null,
    };
  }

  // Record a probe-measured peak (aggregate-TPS plateau) for a lane. The probe
  // itself lives outside this store; it hands the plateau in here.
  function recordPeak(lane, tps) {
    const value = nonNegativeNumber(tps);
    const key = normalizeLane(lane);
    if (value > (peakTps.get(key) ?? 0)) peakTps.set(key, value);
    return peakTps.get(key);
  }

  function utilization(lane) {
    return laneMetrics(lane).utilization;
  }

  // Bounded snapshot for GET /api/metrics — token COUNTS + timings only, no text.
  function snapshot() {
    return {
      generatedAt: new Date(now()).toISOString(),
      lanes: MODEL_LANES.map(laneMetrics),
    };
  }

  return {
    record,
    recordPeak,
    laneMetrics,
    utilization,
    snapshot,
    get window() {
      return window;
    },
  };
}

// (a) instrument — wrap a model-call function so every invocation records a
// content-free metric sample. ttft is measured at the boundary when the seam
// does not stream (single completion ⇒ ttft ≈ gen_ms); when usage/eval fields
// are present they refine the token counts. Recording is best-effort and MUST
// NOT throw into the model-call path.
export function instrumentModelCall(modelCall, { store, lane, model, now } = {}) {
  const clock = typeof now === 'function' ? now : () => Date.now();
  return async function instrumentedModelCall(request) {
    const start = clock();
    let result;
    try {
      result = await modelCall(request);
      return result;
    } finally {
      const gen_ms = Math.max(0, clock() - start);
      try {
        const derived = deriveTokenMetrics(result);
        store?.record?.({
          lane: lane ?? request?.lane,
          model: model ?? request?.model,
          prompt_tok: derived.prompt_tok,
          completion_tok: derived.completion_tok,
          ttft_ms: derived.gen_ms > 0 ? derived.gen_ms : gen_ms,
          gen_ms: derived.gen_ms > 0 ? derived.gen_ms : gen_ms,
        });
      } catch {
        // Metrics are advisory; a recorder failure never breaks the model call.
      }
    }
  };
}

// (c) priority admission gate. Interactive turns (founder chat) = HIGH: always
// admitted, and they signal that background work should yield. Background loops
// = LOW: admitted only when spare bandwidth exists (utilization below threshold)
// AND no interactive turn is currently in flight.
export const PRIORITY = Object.freeze({ HIGH: 'interactive', LOW: 'background' });

export function createAdmissionScheduler(options = {}) {
  const store = options.store;
  const threshold = Number.isFinite(options.threshold)
    ? options.threshold
    : DEFAULT_ADMISSION_THRESHOLD;
  // Count of interactive turns in flight. While > 0, background work yields.
  let interactiveInFlight = 0;
  const yieldWaiters = new Set();

  function interactiveActive() {
    return interactiveInFlight > 0;
  }

  // Utilization gate for a lane: admitted iff utilization is unknown (unmeasured
  // peak ⇒ assume spare) or strictly below threshold.
  function hasSpare(lane) {
    const util = store?.utilization?.(lane);
    return util === null || util === undefined || util < threshold;
  }

  // Decide admission for a unit of work.
  function admit({ priority, lane } = {}) {
    if (priority === PRIORITY.HIGH) return { admitted: true, reason: 'interactive' };
    if (interactiveActive()) return { admitted: false, reason: 'yield_to_interactive' };
    if (!hasSpare(lane)) return { admitted: false, reason: 'no_spare_bandwidth' };
    return { admitted: true, reason: 'spare_bandwidth' };
  }

  // Mark an interactive turn as started; returns a release fn. While any
  // interactive turn is in flight, background admission is denied (yield).
  function beginInteractive() {
    interactiveInFlight += 1;
    let released = false;
    return function release() {
      if (released) return;
      released = true;
      interactiveInFlight = Math.max(0, interactiveInFlight - 1);
    };
  }

  // A background loop can await this to be preempted the moment an interactive
  // turn arrives. Resolves immediately if one is already in flight.
  function shouldYield() {
    return interactiveActive();
  }

  return {
    admit,
    beginInteractive,
    shouldYield,
    interactiveActive,
    hasSpare,
    get threshold() {
      return threshold;
    },
  };
}

export { NUMERIC_METRIC_FIELDS };
