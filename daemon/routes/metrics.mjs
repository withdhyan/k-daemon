// GET /api/metrics — bounded throughput surface (U10).
//
// KTD9/single-seam invariants: this projects the daemon-owned throughput store,
// which by construction holds ONLY token counts + timings per lane. NO chat
// content, no prompt/completion TEXT, no substrate/genome ever reaches this
// wire. The route asserts the shape defensively so a future store change can't
// silently leak content through here.

export const METRICS_PATH = '/api/metrics';

// Keys allowed on the wire. Anything not in this set is stripped before send —
// a fail-closed guard against a content-bearing field creeping into the store.
const ALLOWED_LANE_KEYS = Object.freeze([
  'lane',
  'calls',
  'ttft_p50_ms',
  'ttft_p95_ms',
  'tps',
  'tokens_per_second',
  'peak_tps',
  'utilization',
]);

function projectLane(lane) {
  const out = {};
  for (const key of ALLOWED_LANE_KEYS) {
    if (lane && Object.prototype.hasOwnProperty.call(lane, key)) {
      out[key] = lane[key];
    }
  }
  if (
    lane &&
    Object.prototype.hasOwnProperty.call(lane, 'tps') &&
    !Object.prototype.hasOwnProperty.call(out, 'tokens_per_second')
  ) {
    out.tokens_per_second = lane.tps;
  }
  return out;
}

// Build the bounded response body from a throughput store snapshot.
export function metricsResponse(metricsStore) {
  const snapshot = metricsStore?.snapshot?.() ?? { lanes: [] };
  return {
    ok: true,
    generatedAt: snapshot.generatedAt ?? new Date().toISOString(),
    lanes: (snapshot.lanes ?? []).map(projectLane),
    source: 'cs-k',
  };
}

export { ALLOWED_LANE_KEYS };
