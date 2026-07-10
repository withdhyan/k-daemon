import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { startServer } from '../../daemon/server.mjs';
import { ALLOWED_LANE_KEYS } from '../../daemon/routes/metrics.mjs';
import { createSubstrateStore } from '../substrate.mjs';
import { realTcpListenAvailable } from '../test-support/tcp.mjs';
import { createThroughputStore } from './throughput.mjs';

const fixedNow = () => new Date('2026-07-01T00:00:00.000Z');
const networkTest = realTcpListenAvailable ? test : test.skip;

networkTest('GET /api/metrics returns bounded per-lane token counts + timings', async () => {
  const metricsStore = createThroughputStore({ now: () => Date.parse('2026-07-01T00:00:00.000Z') });
  metricsStore.record({
    lane: 'frontier',
    model: 'claude',
    prompt_tok: 50,
    completion_tok: 100,
    ttft_ms: 300,
    gen_ms: 1000,
  });
  metricsStore.recordPeak('frontier', 400);

  const { server, url } = await startTestServer({ metricsStore });
  try {
    const response = await fetch(`${url}/api/metrics`);
    assert.equal(response.status, 200);
    const body = await response.json();

    assert.equal(body.ok, true);
    assert.equal(body.source, 'cs-k');
    assert.ok(Array.isArray(body.lanes));

    const frontier = body.lanes.find((l) => l.lane === 'frontier');
    assert.ok(frontier);
    assert.equal(frontier.calls, 1);
    assert.equal(frontier.ttft_p50_ms, 300);
    assert.equal(frontier.tps, 100);
    assert.equal(frontier.tokens_per_second, 100);
    assert.equal(frontier.peak_tps, 400);
    assert.equal(frontier.utilization, 0.25);

    // BOUNDED: only allow-listed keys on the wire.
    for (const lane of body.lanes) {
      for (const key of Object.keys(lane)) {
        assert.ok(ALLOWED_LANE_KEYS.includes(key), `unexpected key on wire: ${key}`);
      }
    }
  } finally {
    await closeServer(server);
  }
});

networkTest('GET /api/metrics never carries chat content on the wire (KTD9)', async () => {
  const metricsStore = createThroughputStore();
  // Simulate the recorder being handed a raw sample WITH text-bearing fields —
  // toMetricSample strips them, so nothing should survive to the wire.
  metricsStore.record({
    lane: 'sovereign',
    model: 'hermes',
    prompt_tok: 10,
    completion_tok: 20,
    ttft_ms: 100,
    gen_ms: 500,
    user: 'my private genome variant rs1234 and a secret confession',
    system: 'you are a sovereign assistant',
    response: 'here is my sensitive analysis of your DNA',
  });

  const { server, url } = await startTestServer({ metricsStore });
  try {
    const response = await fetch(`${url}/api/metrics`);
    const text = await response.text();
    assert.ok(!text.includes('genome'));
    assert.ok(!text.includes('secret'));
    assert.ok(!text.includes('DNA'));
    assert.ok(!text.includes('confession'));
    assert.ok(!text.includes('rs1234'));
  } finally {
    await closeServer(server);
  }
});

networkTest('GET /api/metrics returns all lanes even with no calls', async () => {
  const { server, url } = await startTestServer({ metricsStore: createThroughputStore() });
  try {
    const response = await fetch(`${url}/api/metrics`);
    const body = await response.json();
    assert.equal(body.ok, true);
    assert.equal(body.lanes.length, 3);
    for (const lane of body.lanes) {
      assert.equal(lane.calls, 0);
      assert.equal(lane.utilization, null);
    }
  } finally {
    await closeServer(server);
  }
});

async function startTestServer(options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-metrics-'));
  const store = createSubstrateStore({ dataDir, now: fixedNow });
  let server;
  try {
    server = await startServer({ store, port: 0, now: fixedNow, ...options });
  } catch (error) {
    if (error.code === 'EPERM') {
      throw new Error('real TCP listen blocked by environment; server tests require listen(0)', {
        cause: error,
      });
    }
    throw error;
  }
  const address = server.address();
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
