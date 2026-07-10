import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_HOST,
  MAX_EVENTS_PER_REQUEST,
  agentToolExecutor,
  cueContext,
  startServer,
} from '../daemon/server.mjs';
import { createBuildEventEmitter } from '../daemon/routes/build.mjs';
import { validateViewPacket } from './agent/view-packet.mjs';
import { createSubstrateStore } from './substrate.mjs';
import { realTcpListenAvailable } from './test-support/tcp.mjs';

const fixedNow = () => new Date('2026-06-29T00:00:00.000Z');
const networkTest = realTcpListenAvailable ? test : test.skip;

networkTest('GET /api/health returns ok', async () => {
  const { server, request } = await startTestServer();
  try {
    const response = await request('GET', '/api/health');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  } finally {
    await closeServer(server);
  }
});

networkTest('POST body signals stores a FootprintSample and returns a planning summary', async () => {
  const { server, request, store } = await startTestServer();
  try {
    const response = await postJson(request, '/api/hermes/body/signals', {
      requested_output: 'planning_summary',
      source: 'healthkit',
      hrv_ms: 42,
      respiratory_rate: 14,
      timestamp: '2026-06-29T10:00:00.000Z',
    });
    const body = await response.json();
    const records = await store.listRecords('FootprintSample');

    assert.equal(response.status, 200);
    assertPlanningSummary(body);
    assert.equal(records.length, 1);
    assert.equal(records[0].kind, 'FootprintSample');
    assert.equal(records[0].provenance.surface, 'body');
    assert.equal(records[0].physiology.hrv, 42);
  } finally {
    await closeServer(server);
  }
});

networkTest('re-posting an identical body signal leaves the substrate file untouched', async () => {
  const { server, request, store } = await startTestServer();
  const payload = {
    requested_output: 'planning_summary',
    source: 'healthkit',
    hrv_ms: 42,
    respiratory_rate: 14,
    timestamp: '2026-06-29T10:00:00.000Z',
  };

  try {
    const first = await postJson(request, '/api/body/signals', payload);
    const before = await substrateSnapshot(store.dataDir);
    const second = await postJson(request, '/api/body/signals', payload);
    const after = await substrateSnapshot(store.dataDir);
    const records = await store.listRecords('FootprintSample');

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(records.length, 1);
    assert.deepEqual(after, before);
  } finally {
    await closeServer(server);
  }
});

networkTest('POST /api/body ingests consented batched vitals fail-soft', async () => {
  const { server, request, store } = await startTestServer();
  try {
    const response = await postJson(request, '/api/body', {
      off_phone_consent: true,
      consent_granted_at: '2026-06-29T08:00:00.000Z',
      source: 'healthkit',
      samples: [
        {
          kind: 'hrv',
          sample_id: 'hk-hrv-1',
          timestamp: '2026-06-29T06:05:00.000Z',
          hrv_ms: 42,
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
        { kind: 'note', text: 'skip me' },
      ],
    });
    const body = await response.json();
    const records = await store.listRecords('VitalRecord');

    assert.equal(response.status, 200);
    assertPlanningSummary(body);
    assert.equal(body.ok, true);
    assert.equal(body.receivedCount, 4);
    assert.equal(body.vitalCount, 3);
    assert.equal(body.createdCount, 3);
    assert.equal(body.duplicateCount, 0);
    assert.equal(body.skippedCount, 1);
    const recordsByKind = new Map(records.map((record) => [record.vitalKind, record]));
    assert.deepEqual([...recordsByKind.keys()].sort(), ['hrv', 'recovery', 'sleep']);
    assert(records.every((record) => record.frontierExcluded === true));
    assert(records.every((record) => record.consent.offPhone === true));
    assert.equal(recordsByKind.get('hrv').provenance.surface, 'healthkit');
    assert.deepEqual(recordsByKind.get('hrv').measurements, { hrvMs: 42 });
    assert.deepEqual(recordsByKind.get('sleep').measurements, {
      durationMinutes: 455,
      sleepEfficiency: 0.91,
    });
  } finally {
    await closeServer(server);
  }
});

networkTest('re-posting an identical body vital batch is dedup-idempotent', async () => {
  const { server, request, store } = await startTestServer();
  const payload = {
    consent: { offPhone: true, scope: 'body:vitals' },
    source: 'healthkit',
    samples: [
      {
        kind: 'hrv',
        sample_id: 'hk-hrv-1',
        timestamp: '2026-06-29T06:05:00.000Z',
        hrv_ms: 42,
      },
      {
        kind: 'sleep',
        id: 'sleep-2026-06-29',
        start_at: '2026-06-28T22:30:00.000Z',
        end_at: '2026-06-29T06:30:00.000Z',
        duration_minutes: 455,
      },
    ],
  };

  try {
    const first = await postJson(request, '/api/body', payload);
    const before = await substrateSnapshot(store.dataDir);
    const second = await postJson(request, '/api/body', payload);
    const secondBody = await second.json();
    const after = await substrateSnapshot(store.dataDir);

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(secondBody.createdCount, 0);
    assert.equal(secondBody.duplicateCount, 2);
    assert.equal(await store.countRecords('VitalRecord'), 2);
    assert.deepEqual(after, before);
  } finally {
    await closeServer(server);
  }
});

networkTest('POST /api/body requires explicit consent and otherwise writes nothing', async () => {
  const { server, request, store } = await startTestServer();
  try {
    const response = await postJson(request, '/api/body', {
      source: 'healthkit',
      samples: [{ kind: 'hrv', hrv_ms: 42 }],
    });

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { ok: false, error: 'body_consent_required' });
    assert.equal(await store.countRecords('VitalRecord'), 0);
  } finally {
    await closeServer(server);
  }
});

networkTest('POST /api/body with consent returns a soft success when every vital row is invalid', async () => {
  const { server, request, store } = await startTestServer();
  try {
    const response = await postJson(request, '/api/body', {
      consent: true,
      samples: [{ kind: 'note', text: 'not body data' }, null],
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.receivedCount, 2);
    assert.equal(body.vitalCount, 0);
    assert.equal(body.createdCount, 0);
    assert.equal(body.duplicateCount, 0);
    assert.equal(body.skippedCount, 2);
    assert.equal(await store.countRecords('VitalRecord'), 0);
  } finally {
    await closeServer(server);
  }
});

networkTest('server binds to loopback by default and sets a bounded request timeout', async () => {
  const { server, address } = await startTestServer();
  try {
    assert.equal(DEFAULT_HOST, '127.0.0.1');
    assert.equal(typeof address, 'object');
    assert.equal(address.address, '127.0.0.1');
    assert.equal(server.requestTimeout, 30000);
    assert.notEqual(address.address, '0.0.0.0');
    assert.notEqual(address.address, '::');
  } finally {
    await closeServer(server);
  }
});

test('server refuses wildcard and alternate wildcard bind hosts', async () => {
  await assertHostRefused('0.0.0.0', /refused wildcard bind host/);

  for (const host of ['0', '00.00.00.00', '::ffff:0.0.0.0', '0:0:0:0:0:0:0:0']) {
    await assertHostRefused(host, /refused non-local bind|listen EPERM/);
  }
});

test('agent tool executor routes web.fetch', async () => {
  const result = await agentToolExecutor(
    'web.fetch',
    { url: 'https://example.test/page', maxChars: 12 },
    {
      webFetch: {
        resolveHost: async () => ['93.184.216.34'],
        fetchImpl: async (url) => {
          assert.equal(url, 'https://example.test/page');
          return {
            ok: true,
            status: 200,
            text: async () => '<title>Example</title><p>Hello from the page</p>',
          };
        },
      },
    },
  );

  assert.equal(result.ok, true);
  assert.ok(result.output.includes('fetched https://example.test/page:'));
  assert.ok(result.output.includes('Hello from t'));
});

test('agent tool executor routes deliberate', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-server-deliberate-'));
  const result = await agentToolExecutor(
    'deliberate',
    { question: 'Should I review one local note today?' },
    {
      dataDir,
      now: fixedNow,
      deliberate: {
        singleCall: async () => {
          throw new Error('low-stakes deliberate route must not call the model');
        },
      },
    },
  );

  assert.equal(result.ok, true);
  assert.match(result.output, /mode=single/);
});

test('agent tool executor routes strategize through an injected singleCall', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-server-strategize-'));
  let seenRequest;

  const result = await agentToolExecutor(
    'strategize',
    { outcome: 'Win one design partner.' },
    {
      dataDir,
      now: fixedNow,
      strategize: {
        singleCall: async (request) => {
          seenRequest = request;
          return strategizeToolOutput();
        },
      },
    },
  );

  assert.equal(seenRequest.label, 'cs-k:strategize');
  assert.equal(result.ok, true);
  assert.equal(result.sensitive, true);
  assert.match(result.output, /objective: Win one design partner\./);
  assert.match(result.output, /workstreams:/);
  assert.match(result.output, /kill-criteria:/);
  assert.match(result.output, /next step: Book one workflow review\./);
  assert.deepEqual(await dataDirFiles(dataDir, 'strategies'), ['2026-06-29T00-00-00.json']);
});

test('agent tool executor fails strategize closed on timeout', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-server-strategize-timeout-'));
  const result = await agentToolExecutor(
    'strategize',
    { outcome: 'Map a slow path.' },
    {
      dataDir,
      now: fixedNow,
      strategize: {
        timeoutMs: 5,
        singleCall: async () => new Promise(() => {}),
      },
    },
  );

  assert.deepEqual(result, { ok: false, reason: 'strategize_failed' });
});

networkTest('GET /api/sources counts real exposures by provenance surface, not files', async () => {
  const { server, request, store } = await startTestServer();
  try {
    // The panel is keyed on real ingested Exposures. Export files sitting in
    // data/ingest that never became exposures must NOT inflate the count
    // (that was the theater); only what the substrate actually holds counts.
    await seedIngestFile(
      store,
      'claude/conversations.json',
      JSON.stringify([{ name: 'unprocessed export title', chat_messages: [] }]),
      '2026-06-28T00:00:00.000Z',
    );
    await store.writeExposure({
      type: 'reference',
      statement: 'private claude conversation detail',
      provenance: { surface: 'claude', lane: 'deliberate' },
    });
    await store.writeExposure({
      type: 'reference',
      statement: 'private bookmark https://private.example.test',
      provenance: { surface: 'x-bookmarks', lane: 'deliberate' },
    });
    await store.writeExposure({
      type: 'observation',
      statement: 'private genome marker rs4680 AG',
      provenance: { surface: 'genome', lane: 'deliberate' },
    });
    await writeSourcesRegistry(store, {
      'manual-source': {
        label: 'Manual source',
        kind: 'registered',
        active: false,
      },
    });

    const response = await request('GET', '/api/sources');
    const sources = await response.json();

    assert.equal(response.status, 200);
    assert(Array.isArray(sources));
    for (const source of sources) assertBoundedSource(source);

    // Real exposures → real counts, keyed on provenance surface.
    assert.deepEqual(pickSource(sourceById(sources, 'claude')), {
      id: 'claude',
      label: 'Claude chat',
      kind: 'chat',
      active: true,
      count: 1,
    });
    assert.deepEqual(pickSource(sourceById(sources, 'x-bookmarks')), {
      id: 'x-bookmarks',
      label: 'X bookmarks',
      kind: 'bookmarks',
      active: true,
      count: 1,
    });
    assert.deepEqual(pickSource(sourceById(sources, 'genome')), {
      id: 'genome',
      label: 'Genome',
      kind: 'genome',
      active: true,
      count: 1,
    });
    // A surface with real exposures reports a real ingest timestamp.
    assert.equal(typeof sourceById(sources, 'claude').lastIngestedAt, 'string');
    // The unprocessed claude export file did NOT add to the count.
    assert.equal(sourceById(sources, 'claude').count, 1);
    // Canonical senses with nothing ingested show honestly at zero, not hidden.
    assert.deepEqual(sourceById(sources, 'apple-notes'), {
      id: 'apple-notes',
      label: 'Apple Notes',
      kind: 'notes',
      active: true,
      count: 0,
      lastIngestedAt: null,
    });
    assert.deepEqual(sourceById(sources, 'manual-source'), {
      id: 'manual-source',
      label: 'Manual source',
      kind: 'registered',
      active: false,
      count: 0,
      lastIngestedAt: null,
    });

    const serialized = JSON.stringify(sources);
    assert(!serialized.includes('private claude conversation detail'));
    assert(!serialized.includes('https://private.example.test'));
    assert(!serialized.includes('rs4680'));
  } finally {
    await closeServer(server);
  }
});

networkTest('POST /api/sources/toggle persists inactive and GET reflects it', async () => {
  const { server, request, store } = await startTestServer();
  try {
    await store.writeExposure({
      type: 'reference',
      statement: 'a claude exposure',
      provenance: { surface: 'claude', lane: 'deliberate' },
    });

    const toggle = await postJson(request, '/api/sources/toggle', {
      id: 'claude',
      active: false,
    });
    assert.equal(toggle.status, 200);
    assert.deepEqual(await toggle.json(), {
      id: 'claude',
      active: false,
    });

    const registry = JSON.parse(
      await fs.readFile(path.join(store.dataDir, 'sources.json'), 'utf8'),
    );
    assert.equal(registry.kind, 'SourcesRegistry');
    assert.equal(registry.sources['claude'].active, false);

    const response = await request('GET', '/api/sources');
    const source = sourceById(await response.json(), 'claude');
    assert.equal(response.status, 200);
    assert.equal(source.active, false);
  } finally {
    await closeServer(server);
  }
});

networkTest('POST /api/sources/toggle rejects invalid body and ids', async () => {
  const { server, request, store } = await startTestServer();
  try {
    await seedIngestFile(store, 'claude/conversations.json', '[]');

    for (const [body, error] of [
      [{ id: 'claude-chat', active: 'false' }, 'invalid_source_active'],
      [{ id: '../secret', active: false }, 'invalid_source_id'],
      [{ id: 'missing-source', active: false }, 'unknown_source'],
      [{ id: 'claude-chat', active: false, extra: true }, 'invalid_source_toggle'],
      [[], 'invalid_source_toggle'],
    ]) {
      const response = await postJson(request, '/api/sources/toggle', body);
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { ok: false, error });
    }
  } finally {
    await closeServer(server);
  }
});

networkTest('GET /api/sources shows the canonical senses at zero when nothing is ingested', async () => {
  const { server, request } = await startTestServer();
  try {
    const response = await request('GET', '/api/sources');
    assert.equal(response.status, 200);
    const sources = await response.json();

    // Honesty means the senses are visible but empty — not a blank panel that
    // hides which senses exist. Every canonical sense reports count 0.
    assert(sources.length > 0);
    for (const source of sources) {
      assertBoundedSource(source);
      assert.equal(source.count, 0);
      assert.equal(source.lastIngestedAt, null);
      assert.equal(source.active, true);
    }
    // The known senses are all present.
    for (const id of ['claude', 'chatgpt', 'holon-notes', 'apple-notes', 'mind-content', 'x-bookmarks', 'chrome', 'genome']) {
      sourceById(sources, id);
    }
  } finally {
    await closeServer(server);
  }
});

networkTest('POST iOS nutrition shape persists macros', async () => {
  const { server, request, store } = await startTestServer();
  try {
    const response = await postJson(request, '/api/hermes/body/nutrition', {
      event_type: 'nutrition_log',
      source: 'ios',
      timestamp: '2026-06-29T11:00:00.000Z',
      requested_output: 'planning_summary',
      meal: {
        summary: 'chicken rice bowl',
        display_text: 'chicken rice bowl, 650 kcal',
        calories: 650,
        protein_grams: 42,
        carbs_grams: 72,
        fat_grams: 18,
      },
    });
    const records = await store.listRecords('FootprintSample');

    assert.equal(response.status, 200);
    assert.equal(records.length, 1);
    assert.deepEqual(records[0].outcome.measurements, {
      calories: 650,
      protein: 42,
      carbs: 72,
      fat: 18,
    });
  } finally {
    await closeServer(server);
  }
});

networkTest('POST nested WHOOP telemetry shape writes a FootprintSample', async () => {
  const { server, request, store } = await startTestServer();
  try {
    const response = await postJson(request, '/api/hermes/body/whoop/telemetry', {
      event_type: 'whoop_ble_telemetry',
      source: 'ios',
      timestamp: '2026-06-29T12:00:00.000Z',
      requested_output: 'web_telemetry_ingest',
      mobile_display: 'r20 extended optical; 72 bpm',
      telemetry: {
        source: 'realtime',
        record_type: 20,
        record_kind: 'r20_extended_optical',
        timestamp: '2026-06-29T12:00:00.000Z',
        mobile_summary: 'r20 extended optical; 72 bpm',
        raw_base64: 'AA==',
        heart_rate_bpm: 72,
      },
    });
    const records = await store.listRecords('FootprintSample');

    assert.equal(response.status, 200);
    assert.equal(records.length, 1);
    assert.equal(records[0].provenance.surface, 'whoop');
    assert.equal(records[0].outcome.measurements.heartratebpm, 72);
  } finally {
    await closeServer(server);
  }
});

networkTest('GET /api/body returns a planning summary', async () => {
  const { server, request } = await startTestServer();
  try {
    const response = await request('GET', '/api/body');
    assert.equal(response.status, 200);
    assertPlanningSummary(await response.json());
  } finally {
    await closeServer(server);
  }
});

networkTest('GET body cue context returns an HRV baseline and drift from recent FootprintSamples', async () => {
  const { server, request, store } = await startTestServer();
  try {
    await seedFootprintHrv(store, [30, 10, 20]);
    const before = await substrateSnapshot(store.dataDir);
    const response = await request('GET', '/api/body/cue-context');
    const body = await response.json();
    const after = await substrateSnapshot(store.dataDir);

    assert.equal(response.status, 200);
    assert.deepEqual(body, {
      baselines: {
        hrv: 20,
        hrvDrift: {
          latest: 20,
          baseline: 20,
          delta: 0,
          direction: 'flat',
          samples: 3,
        },
        samples: 3,
      },
      zScores: {
        hrv: {
          latest: 20,
          baselineMean: 20,
          standardDeviation: 8.2,
          zScore: 0,
          direction: 'flat',
          samples: 3,
          windowDays: 30,
        },
      },
      protocols: [],
      generatedAt: fixedNow().toISOString(),
      source: 'cs-k',
    });
    assert.deepEqual(after, before);
  } finally {
    await closeServer(server);
  }
});

networkTest('GET body cue context z-scores use a 30-day rolling personal baseline', async () => {
  const { server, request, store } = await startTestServer();
  try {
    await store.writeFootprintSample({
      sampleId: 'cue-context-old-hrv',
      eventAt: '2026-05-28T23:59:00.000Z',
      provenance: { surface: 'body', lane: 'ambient' },
      phenomenology: { report: 'Old HRV sample outside the rolling baseline.' },
      physiology: { hrv: 10 },
    });
    for (const [index, [eventAt, hrv]] of [
      ['2026-06-01T00:00:00.000Z', 70],
      ['2026-06-15T00:00:00.000Z', 70],
      ['2026-06-28T23:59:00.000Z', 50],
    ].entries()) {
      await store.writeFootprintSample({
        sampleId: `cue-context-rolling-hrv-${index}`,
        eventAt,
        provenance: { surface: 'body', lane: 'ambient' },
        phenomenology: { report: `Rolling HRV sample ${index}.` },
        physiology: { hrv },
      });
    }

    const response = await request('GET', '/api/body/cue-context');
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body.baselines.hrvDrift, {
      latest: 50,
      baseline: 70,
      delta: -20,
      direction: 'down',
      samples: 3,
    });
    assert.deepEqual(body.zScores.hrv, {
      latest: 50,
      baselineMean: 63.3,
      standardDeviation: 9.4,
      zScore: -1.41,
      direction: 'down',
      samples: 3,
      windowDays: 30,
    });
  } finally {
    await closeServer(server);
  }
});

networkTest('GET body cue context returns a sleep trend from canonical sleep duration minutes', async () => {
  const { server, request, store } = await startTestServer();
  try {
    await seedFootprintSleepDuration(store, [420, 360, 330]);

    const response = await request('GET', '/api/body/cue-context');
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body.baselines, {
      sleepHours: 6,
      sleepTrend: {
        latestHours: 5.5,
        baselineHours: 6,
        deltaHours: -0.5,
        direction: 'down',
        samples: 3,
      },
      samples: 3,
    });
    assert.deepEqual(body.zScores, {
      sleep: {
        latestHours: 5.5,
        baselineMeanHours: 6.17,
        standardDeviationHours: 0.62,
        zScore: -1.07,
        direction: 'down',
        samples: 3,
        windowDays: 30,
      },
    });
  } finally {
    await closeServer(server);
  }
});

networkTest('GET body cue context is silent when the store is empty', async () => {
  const { server, request } = await startTestServer();
  try {
    const response = await request('GET', '/api/body/cue-context');
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body, {
      baselines: {
        samples: 0,
      },
      protocols: [],
      generatedAt: fixedNow().toISOString(),
      source: 'cs-k',
    });
    assert(!Object.hasOwn(body.baselines, 'hrv'));
  } finally {
    await closeServer(server);
  }
});

networkTest('admin bandish routes create records and sort by remind, due, then effort', async () => {
  const { server, request, store } = await startTestServer();
  try {
    const late = await postJson(request, '/api/admin/bandish', {
      type: 'TimeSensitive',
      effort: 'Quick',
      title: 'Renew visa',
      remindAt: '2026-09-01',
      dueAt: '2026-09-20',
      note: 'Keep logistics quarantined from cadence.',
    });
    const laterDue = await postJson(request, '/api/admin/bandish', {
      type: 'RegularQueue',
      effort: 'Quick',
      title: 'Book storage pickup',
      remindAt: '2026-08-01',
      dueAt: '2026-10-01',
    });
    const hours = await postJson(request, '/api/admin/bandish', {
      type: 'RegularQueue',
      effort: 'Hours',
      title: 'Prepare tax packet',
      remindAt: '2026-08-01',
      dueAt: '2026-09-15',
    });
    const quick = await postJson(request, '/api/admin/bandish', {
      type: 'RegularQueue',
      effort: 'Quick',
      title: 'Confirm tax portal login',
      remindAt: '2026-08-01',
      dueAt: '2026-09-15',
    });
    const duplicate = await postJson(request, '/api/admin/bandish', {
      type: 'TimeSensitive',
      effort: 'Quick',
      title: 'Renew visa',
      remindAt: '2026-09-01',
      dueAt: '2026-09-20',
    });

    for (const response of [late, laterDue, hours, quick, duplicate]) {
      assert.equal(response.status, 200);
    }
    assert.equal((await duplicate.json()).created, false);

    const response = await request('GET', '/api/admin/bandish');
    const body = await response.json();
    const filtered = await request('GET', '/api/admin/bandish?type=TimeSensitive');
    const filteredBody = await filtered.json();
    const records = await store.listRecords('AdminBandish');

    assert.equal(response.status, 200);
    assert.deepEqual(body.sort, ['remindAt', 'dueAt', 'effort']);
    assert.deepEqual(body.records.map((record) => record.title), [
      'Confirm tax portal login',
      'Prepare tax packet',
      'Book storage pickup',
      'Renew visa',
    ]);
    assert.deepEqual(body.records.map((record) => record.effort), [
      'Quick',
      'Hours',
      'Quick',
      'Quick',
    ]);
    assert.equal(body.records[0].remindAt, '2026-08-01T00:00:00.000Z');
    assert.equal(body.records[0].dueAt, '2026-09-15T00:00:00.000Z');
    assert.equal(body.records[3].provenance.surface, 'admin');
    assert.equal(body.records[3].note, 'Keep logistics quarantined from cadence.');
    assert.equal(filtered.status, 200);
    assert.deepEqual(filteredBody.records.map((record) => record.title), ['Renew visa']);
    assert.equal(records.length, 4);
  } finally {
    await closeServer(server);
  }
});

networkTest('admin bandish route rejects invalid payloads and unsupported methods', async () => {
  const { server, request, store } = await startTestServer();
  try {
    const invalid = await postJson(request, '/api/admin/bandish', {
      type: 'TimeSensitive',
      effort: 'Quick',
      title: 'Bad dual-date task',
      remindAt: '2026-09-20',
      dueAt: '2026-09-20',
    });
    const clientPath = await postJson(request, '/api/admin/bandish', {
      type: 'RegularQueue',
      effort: 'Hour',
      title: 'Path injection',
      remindAt: '2026-09-01',
      dueAt: '2026-09-20',
      path: '../outside',
    });
    const methodMismatch = await request('PUT', '/api/admin/bandish');

    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), { ok: false, error: 'invalid_admin_bandish' });
    assert.equal(clientPath.status, 400);
    assert.deepEqual(await clientPath.json(), { ok: false, error: 'client_path_not_allowed' });
    assert.equal(methodMismatch.status, 405);
    assert.deepEqual(await methodMismatch.json(), { ok: false, error: 'method_not_allowed' });
    assert.equal(await store.countRecords('AdminBandish'), 0);
  } finally {
    await closeServer(server);
  }
});

networkTest('cadence day routes upsert bandish and per-mode capacity budgets', async () => {
  const { server, request, store } = await startTestServer();
  try {
    const upsert = await postJson(request, '/api/cadence/day', {
      date: '2026-07-05',
      bandish: [
        {
          startAt: '2026-07-05T13:00:00.000Z',
          endAt: '2026-07-05T13:45:00.000Z',
          attentionMode: 'operative',
          ring: 'outer',
          description: 'Ops sweep',
          type: 'ops',
          why: 'contain logistics outside the core',
        },
        {
          startAt: '2026-07-05T09:00:00.000Z',
          endAt: '2026-07-05T10:30:00.000Z',
          attentionMode: 'converge',
          ring: 'core',
          description: 'Deep work block',
          type: 'work',
          why: 'the one thing that compounds',
          detail: {
            plan: ['ship cadence model enrichment'],
          },
        },
      ],
      capacityByMode: {
        converge: 180,
        operative: 90,
        restore: 60,
      },
    });
    const upsertBody = await upsert.json();
    const day = await request('GET', '/api/cadence/day?date=2026-07-05');
    const dayBody = await day.json();

    assert.equal(upsert.status, 200);
    assert.equal(upsertBody.wrote.bandish, 2);
    assert.equal(upsertBody.wrote.capacityBudgets, 3);
    assert.equal(day.status, 200);
    assert.deepEqual(dayBody.bandish.map((record) => record.description), [
      'Deep work block',
      'Ops sweep',
    ]);
    assert.deepEqual(dayBody.capacityByMode, {
      converge: 180,
      operative: 90,
      restore: 60,
    });
    assert.deepEqual(dayBody.remainingCapacity, {
      converge: 180,
      operative: 90,
      restore: 60,
    });
    assert.equal(dayBody.bandish[0].type, 'work');
    assert.equal(dayBody.bandish[0].why, 'the one thing that compounds');
    assert.deepEqual(dayBody.bandish[0].detail, {
      plan: ['ship cadence model enrichment'],
    });
    assert.equal(dayBody.bandish[0].provenance.surface, 'cadence');
    assert.equal(dayBody.capacityBudgets[0].kind, 'CapacityBudget');

    const deepWorkId = dayBody.bandish[0].id;
    const opsId = dayBody.bandish[1].id;
    const convergeBudgetId = dayBody.capacityBudgets
      .find((record) => record.attentionMode === 'converge').id;
    const patchBandish = await patchJson(
      request,
      `/api/cadence/bandish/${encodeURIComponent(deepWorkId)}`,
      {
        endAt: '2026-07-05T10:45:00.000Z',
        description: 'Ship cadence R1.1',
      },
    );
    const patchBudget = await patchJson(
      request,
      `/api/cadence/capacity-budgets/${encodeURIComponent(convergeBudgetId)}`,
      { minutes: 210 },
    );
    const retireOps = await request(
      'DELETE',
      `/api/cadence/bandish/${encodeURIComponent(opsId)}`,
    );
    const finalDay = await request('GET', '/api/cadence/day?date=2026-07-05');
    const finalBody = await finalDay.json();
    const allBandish = await request('GET', '/api/cadence/bandish?date=2026-07-05&all=true');
    const allBandishBody = await allBandish.json();
    const bandishRecords = await store.listRecords('Bandish');
    const budgetRecords = await store.listRecords('CapacityBudget');

    assert.equal(patchBandish.status, 200);
    assert.equal((await patchBandish.json()).updated, true);
    assert.equal(patchBudget.status, 200);
    assert.equal((await patchBudget.json()).record.minutes, 210);
    assert.equal(retireOps.status, 200);
    assert.equal((await retireOps.json()).retired, true);
    assert.equal(finalDay.status, 200);
    assert.deepEqual(finalBody.bandish.map((record) => record.description), [
      'Ship cadence R1.1',
    ]);
    assert.equal(finalBody.bandish[0].endAt, '2026-07-05T10:45:00.000Z');
    assert.equal(finalBody.bandish[0].type, 'work');
    assert.equal(finalBody.bandish[0].why, 'the one thing that compounds');
    assert.deepEqual(finalBody.bandish[0].detail, {
      plan: ['ship cadence model enrichment'],
    });
    assert.equal(finalBody.capacityByMode.converge, 210);
    assert.equal(allBandish.status, 200);
    assert.equal(allBandishBody.records.length, 3);
    assert.equal(
      bandishRecords.filter((record) => !record.validTo && !record.supersededById).length,
      1,
    );
    assert.equal(
      budgetRecords.filter((record) => !record.validTo && !record.supersededById).length,
      3,
    );
  } finally {
    await closeServer(server);
  }
});

networkTest('cadence CRUD routes reject invalid payloads and unsupported methods', async () => {
  const { server, request, store } = await startTestServer();
  try {
    const invalidBandish = await postJson(request, '/api/cadence/bandish', {
      day: '2026-07-05',
      startAt: '2026-07-05T09:00:00.000Z',
      endAt: '2026-07-05T10:00:00.000Z',
      attentionMode: 'admin',
      ring: 'core',
      description: 'Invalid mode',
    });
    const invalidType = await postJson(request, '/api/cadence/bandish', {
      day: '2026-07-05',
      startAt: '2026-07-05T09:00:00.000Z',
      endAt: '2026-07-05T10:00:00.000Z',
      attentionMode: 'converge',
      ring: 'core',
      description: 'Invalid type',
      type: 'planning',
    });
    const clientPath = await postJson(request, '/api/cadence/capacity-budgets', {
      day: '2026-07-05',
      attentionMode: 'converge',
      minutes: 180,
      path: '../outside',
    });
    const methodMismatch = await request('PUT', '/api/cadence/bandish');

    assert.equal(invalidBandish.status, 400);
    assert.deepEqual(await invalidBandish.json(), { ok: false, error: 'invalid_bandish' });
    assert.equal(invalidType.status, 400);
    assert.deepEqual(await invalidType.json(), { ok: false, error: 'invalid_bandish' });
    assert.equal(clientPath.status, 400);
    assert.deepEqual(await clientPath.json(), { ok: false, error: 'client_path_not_allowed' });
    assert.equal(methodMismatch.status, 405);
    assert.deepEqual(await methodMismatch.json(), { ok: false, error: 'method_not_allowed' });
    assert.equal(await store.countRecords('Bandish'), 0);
    assert.equal(await store.countRecords('CapacityBudget'), 0);
  } finally {
    await closeServer(server);
  }
});

test('cue context projects staged body protocols through bounded fields only (no free-text leak)', async () => {
  const store = await freshStore();
  const decisionsDir = path.join(store.dataDir, 'decisions');
  await fs.mkdir(decisionsDir, { recursive: true });
  await fs.writeFile(
    path.join(decisionsDir, 'body-protocol.json'),
    JSON.stringify({
      kind: 'LoopRecommendation',
      acted: 'pending',
      surface: 'body',
      recommendationKind: 'body-protocol',
      target: 'recovery',
      action: 'prioritize',
      object: 'sleep_duration',
      basis: 'genotype_recovery',
      category: 'recovery',
      confidence: 0.74,
      recommended: 'rs4680 AG means recovery sensitivity',
      reason: 'genome-derived free text must not leave the daemon',
      tag: '[advise]',
      protocol: {
        target: 'recovery',
        action: 'prioritize',
        object: 'sleep_duration',
        basis: 'genotype_recovery',
        category: 'recovery',
        confidence: 0.74,
        tag: '[advise]',
        reason: 'nested rs4680 AG rationale',
        secretEvidenceIds: ['exposure-abc-123'],
        rawNote: 'private founder reasoning',
      },
    }),
    'utf8',
  );

  const body = await cueContext({ store, dataDir: store.dataDir, now: fixedNow });

  assert.equal(body.protocols.length, 1);
  const projected = body.protocols[0];
  assert.deepEqual(projected, {
    target: 'recovery',
    action: 'prioritize',
    object: 'sleep_duration',
    basis: 'genotype_recovery',
    category: 'recovery',
    tag: '[advise]',
    confidence: 0.74,
  });
  const serialized = JSON.stringify(projected);
  assert(!serialized.includes('recommended'));
  assert(!serialized.includes('reason'));
  assert(!serialized.includes('protocol'));
  assert(!serialized.includes('rs4680'));
  assert(!serialized.includes('AG'));
  assert(!serialized.includes('secretEvidenceIds'));
  assert(!serialized.includes('exposure-abc-123'));
  assert(!serialized.includes('rawNote'));
});

networkTest('body cue context path variants resolve and POST mismatches 404', async () => {
  const { server, request } = await startTestServer();
  try {
    for (const pathname of ['/api/hermes/body/cue-context', '/api/body/cue-context']) {
      const response = await request('GET', pathname);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        baselines: {
          samples: 0,
        },
        protocols: [],
        generatedAt: fixedNow().toISOString(),
        source: 'cs-k',
      });
    }

    const methodMismatch = await postJson(request, '/api/body/cue-context', { ok: true });
    assert.equal(methodMismatch.status, 404);
    assert.deepEqual(await methodMismatch.json(), { ok: false, error: 'not_found' });
  } finally {
    await closeServer(server);
  }
});

networkTest('POST /api/body/live routes earned instant HRV cue as an AG-UI packet without cold-loop write', async () => {
  const { server, request, store } = await startTestServer();
  try {
    await seedFootprintHrv(store, [60, 62, 64]);
    const before = await substrateSnapshot(store.dataDir);
    const response = await postJson(request, '/api/body/live', {
      source: 'healthkit',
      hrv_ms: 38,
      timestamp: '2026-06-29T10:00:00.000Z',
    });
    const body = await response.json();
    const after = await substrateSnapshot(store.dataDir);

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.silenced, false);
    assert.equal(body.source, 'cs-k');
    assert.deepEqual(body.packet, body.packets[0]);
    assert.equal(validateViewPacket(body.packet), body.packet);
    assert.equal(body.packet.viewType, 'generic.card');
    assert.equal(body.packet.frontierExcluded, true);
    assert.equal(body.packet.fields.advisoryOnly, true);
    assert.equal(body.packet.fields.status, 'interrupt');
    assert.equal(body.packet.fields.interruptionClass, 'ambient');
    assert.equal(body.packet.fields.cueKind, 'hrv_drop');
    assert.equal(body.packet.fields.hrvMs, 38);
    assert.equal(body.packet.fields.baselineHrvMs, 62);
    assert.deepEqual(after, before);
  } finally {
    await closeServer(server);
  }
});

networkTest('POST /api/body/live emits earned cue packets on the shared AG-UI build event stream', async () => {
  const buildEvents = createBuildEventEmitter();
  const { server, request, store, address } = await startTestServer({ buildEvents });
  const streamAbort = new AbortController();
  try {
    await seedFootprintHrv(store, [60, 62, 64]);
    const stream = await fetch(`http://127.0.0.1:${address.port}/api/agui/events?packets=10`, {
      signal: streamAbort.signal,
    });
    assert.equal(stream.status, 200);
    assert.equal(stream.headers.get('content-type'), 'text/event-stream; charset=utf-8');

    const response = await postJson(request, '/api/body/live', {
      source: 'healthkit',
      hrv_ms: 38,
      timestamp: '2026-06-29T10:00:00.000Z',
    });
    const body = await response.json();
    const event = await readSseEvent(stream, (candidate) =>
      candidate.event === 'packet' &&
      candidate.data?.fields?.cueKind === 'hrv_drop');

    assert.equal(response.status, 200);
    assert.equal(body.silenced, false);
    assert.deepEqual(event.data, body.packet);
    assert.equal(event.data.fields.interruptionClass, 'ambient');
    assert.equal(event.data.provenance.lane, 'ambient');
    assert.equal(validateViewPacket(event.data), event.data);
    assert.deepEqual(buildEvents.recentPackets(1), [body.packet]);
  } finally {
    streamAbort.abort();
    await closeServer(server);
  }
});

networkTest('POST /api/body/live schedules cadence recompute for surfaced cues', async () => {
  const recomputes = [];
  const { server, request, store } = await startTestServer({
    cadenceRecompute: async (input) => {
      recomputes.push(input);
    },
  });
  try {
    await seedFootprintHrv(store, [60, 62, 64]);
    const response = await postJson(request, '/api/body/live', {
      source: 'healthkit',
      hrv_ms: 38,
      timestamp: '2026-06-29T10:00:00.000Z',
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.silenced, false);
    await flushMicrotasks();
    assert.equal(recomputes.length, 1);
    assert.deepEqual(recomputes[0].trigger, {
      type: 'body-update',
      signal: 'b1',
    });
  } finally {
    await closeServer(server);
  }
});

networkTest('POST /api/body/live does not recompute for silenced cues', async () => {
  const recomputes = [];
  const { server, request, store } = await startTestServer({
    cadenceRecompute: async (input) => {
      recomputes.push(input);
    },
  });
  try {
    await seedFootprintHrv(store, [60, 62, 64]);
    const response = await postJson(request, '/api/body/live', {
      source: 'healthkit',
      hrv_ms: 55,
      timestamp: '2026-06-29T10:00:00.000Z',
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.silenced, true);
    await flushMicrotasks();
    assert.deepEqual(recomputes, []);
  } finally {
    await closeServer(server);
  }
});

networkTest('POST /api/body/live is silence-default for weak live signals', async () => {
  const { server, request, store } = await startTestServer();
  try {
    await seedFootprintHrv(store, [60, 62, 64]);
    const response = await postJson(request, '/api/hermes/body/live', {
      source: 'healthkit',
      hrv_ms: 55,
      timestamp: '2026-06-29T10:00:00.000Z',
    });
    const body = await response.json();
    const methodMismatch = await request('GET', '/api/body/live');

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.silenced, true);
    assert.equal(body.reason, 'no_cue_earned');
    assert.deepEqual(body.packets, []);
    assert.equal(Object.hasOwn(body, 'packet'), false);
    assert.equal(methodMismatch.status, 405);
    assert.deepEqual(await methodMismatch.json(), { ok: false, error: 'method_not_allowed' });
  } finally {
    await closeServer(server);
  }
});

networkTest('body routes accept sleep, nutrition, summary, and feedback traffic', async () => {
  const { server, request, store } = await startTestServer();
  try {
    const sleep = await postJson(request, '/api/hermes/body/sleep', {
      event_type: 'sleep_summary',
      source: 'ios',
      timestamp: '2026-06-29T13:00:00.000Z',
      requested_output: 'planning_summary',
      sleep: {
        id: 'sleep-2026-06-29',
        source: 'healthkit',
        sleep_efficiency: 0.89,
        disturbance_count: 2,
      },
    });
    const nutrition = await postJson(request, '/api/body/meal', {
      event_type: 'nutrition_log',
      source: 'ios',
      timestamp: '2026-06-29T14:00:00.000Z',
      requested_output: 'planning_summary',
      meal: {
        calories: 420,
        protein_grams: 31,
      },
    });
    const records = await store.listRecords('FootprintSample');

    assert.equal(sleep.status, 200);
    assert.equal(nutrition.status, 200);
    assert.equal(records.length, 2);

    for (const pathname of [
      '/api/hermes/body/summary',
      '/api/body/planning-summary',
      '/api/body/summary',
      '/api/body',
    ]) {
      const summary = await request('GET', pathname);
      assert.equal(summary.status, 200);
      assertPlanningSummary(await summary.json());
    }

    const feedback = await postJson(request, '/api/hermes/body/interventions/feedback', {
      intervention_id: 'add_protein_anchor_next_meal',
      feedback: 'accepted',
      timestamp: '2026-06-29T15:00:00.000Z',
    });
    const feedbackBody = await feedback.json();
    assert.equal(feedback.status, 200);
    assert.equal(feedbackBody.ok, true);
    assert.equal(feedbackBody.record.action, 'accept');
  } finally {
    await closeServer(server);
  }
});

networkTest('POST /api/body/interventions/feedback persists accept dismiss and cooldown records', async () => {
  const { server, request, store } = await startTestServer();
  try {
    const accept = await postJson(request, '/api/body/interventions/feedback', {
      interventionId: 'cue-accept',
      action: 'accept',
      packetId: 'packet-accept',
      timestamp: '2026-06-29T15:00:00.000Z',
    });
    const dismiss = await postJson(request, '/api/body/interventions/feedback', {
      intervention_id: 'cue-dismiss',
      feedback: 'dismissed',
      reason: 'not useful now',
      timestamp: '2026-06-29T15:01:00.000Z',
    });
    const cooldown = await postJson(request, '/api/body/interventions/feedback', {
      cue_id: 'cue-cooldown',
      feedback: 'cooldown',
      cooldown_minutes: 45,
      cooldown_until: '2026-06-29T16:00:00.000Z',
      timestamp: '2026-06-29T15:02:00.000Z',
    });
    const invalid = await postJson(request, '/api/body/interventions/feedback', {
      interventionId: 'cue-invalid',
      feedback: 'maybe',
    });
    const methodMismatch = await request('GET', '/api/body/interventions/feedback');

    assert.equal(accept.status, 200);
    assert.equal(dismiss.status, 200);
    assert.equal(cooldown.status, 200);
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), { ok: false, error: 'invalid_feedback_action' });
    assert.equal(methodMismatch.status, 405);
    assert.deepEqual(await methodMismatch.json(), { ok: false, error: 'method_not_allowed' });

    const files = await dataDirFiles(store.dataDir, path.join('body', 'interventions', 'feedback'));
    assert.equal(files.length, 3);
    const records = await Promise.all(files.map((file) =>
      fs.readFile(path.join(store.dataDir, 'body', 'interventions', 'feedback', file), 'utf8')
        .then(JSON.parse)));
    assert.deepEqual(records.map((record) => record.action).sort(), ['accept', 'cooldown', 'dismiss']);
    assert(records.every((record) => record.kind === 'BodyInterventionFeedbackRecord'));
    assert(records.every((record) => record.schemaVersion === 1));
    assert.equal(records.find((record) => record.action === 'cooldown').cooldownMinutes, 45);
  } finally {
    await closeServer(server);
  }
});

networkTest('body request errors return stable status codes', async () => {
  const { server, request } = await startTestServer();
  try {
    const oversized = await request(
      'POST',
      '/api/hermes/body/signals',
      '{"hrv_ms":42,'.padEnd(1_000_001, ' ') + '}',
      { 'content-type': 'application/json' },
    );
    assert.equal(oversized.status, 413);
    assert.deepEqual(await oversized.json(), { ok: false, error: 'body_too_large' });

    const empty = await request('POST', '/api/hermes/body/signals', '   \n\t', {
      'content-type': 'application/json',
    });
    assert.equal(empty.status, 400);
    assert.deepEqual(await empty.json(), { ok: false, error: 'empty_json_body' });

    const unknown = await request('GET', '/api/not-found');
    assert.equal(unknown.status, 404);

    const methodMismatch = await postJson(request, '/api/health', { ok: true });
    assert.equal(methodMismatch.status, 404);

    const noMeasurement = await postJson(request, '/api/hermes/body/signals', {
      requested_output: 'planning_summary',
      source: 'ios',
    });
    assert.equal(noMeasurement.status, 400);
    assert.deepEqual(await noMeasurement.json(), { ok: false, error: 'no_valid_body_signal' });
  } finally {
    await closeServer(server);
  }
});

networkTest('body event batches over the per-request cap are rejected', async () => {
  const { server, request, store } = await startTestServer();
  try {
    const response = await postJson(request, '/api/hermes/body/signals', {
      events: Array.from({ length: MAX_EVENTS_PER_REQUEST + 1 }, (_, index) => ({
        hrv_ms: index + 1,
      })),
    });

    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { ok: false, error: 'too_many_events' });
    assert.equal(await store.countRecords('FootprintSample'), 0);
  } finally {
    await closeServer(server);
  }
});

networkTest('out-of-range numeric timestamps do not drop otherwise valid measurements', async () => {
  const { server, request, store } = await startTestServer();
  try {
    const response = await postJson(request, '/api/hermes/body/signals', {
      timestamp: 8.7e15,
      hrv_ms: 38,
    });
    const records = await store.listRecords('FootprintSample');

    assert.equal(response.status, 200);
    assert.equal(records.length, 1);
    assert.equal(records[0].eventAt, fixedNow().toISOString());
    assert.equal(records[0].outcome.measurements.hrv, 38);
  } finally {
    await closeServer(server);
  }
});

async function startTestServer(options = {}) {
  const store = await freshStore();
  let server;
  try {
    server = await startServer({ ...options, store, port: 0, now: fixedNow });
  } catch (error) {
    if (error.code === 'EPERM') {
      throw new Error('real TCP listen blocked by environment; server tests require listen(0)', {
        cause: error,
      });
    }
    throw error;
  }

  const address = server.address();
  assert.equal(typeof address, 'object');

  return {
    server,
    store,
    address,
    request: (method, pathname, body, headers) =>
      networkRequest(`http://127.0.0.1:${address.port}`, method, pathname, body, headers),
  };
}

async function freshStore() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-server-data-'));
  return createSubstrateStore({ dataDir, now: fixedNow });
}

async function assertHostRefused(host, pattern) {
  const store = await freshStore();

  await assert.rejects(
    () => startServer({ store, host, port: 0, now: fixedNow }),
    (error) => pattern.test(error.message),
  );
}

async function postJson(request, pathname, body) {
  return request('POST', pathname, JSON.stringify(body), {
    'content-type': 'application/json',
  });
}

async function patchJson(request, pathname, body) {
  return request('PATCH', pathname, JSON.stringify(body), {
    'content-type': 'application/json',
  });
}

async function dataDirFiles(dataDir, dirname) {
  const dir = path.join(dataDir, dirname);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function strategizeToolOutput() {
  return {
    summary: 'Narrow to one verified workflow.',
    verdict: 'recommend',
    strategy: {
      degreeMap: [0, 1, 2, 3, 4].map((degree) => ({
        degree,
        answer: `Degree ${degree} answer.`,
        evidenceIds: [],
      })),
      filters: {
        expressible: {
          pass: true,
          rationale: 'A workflow review is executable this week.',
        },
        notPricedIn: {
          pass: true,
          rationale: 'No buyer commitment is priced in yet.',
        },
        asymmetry: {
          pass: true,
          rationale: 'One review can cheaply validate or kill the wedge.',
        },
      },
      evidenceLedger: [
        {
          claim: 'The workflow wedge is the narrowest useful proof.',
          supports: ['Prior conversations mention the workflow.'],
          counters: ['No buyer has shared artifacts yet.'],
          confidence: 0.6,
        },
      ],
      goalArithmetic: {
        currentState: 'No committed design partner.',
        desiredState: 'One buyer agrees to review a workflow.',
        gap: 'A named buyer and dated review slot.',
        deadline: '2026-07-15',
        constraints: ['No build before review.'],
        forcingFunction: 'Ask one buyer this week.',
      },
      bets: [],
      antiFooling: {
        disconfirmers: ['Buyer will not share a workflow artifact.'],
        failureModes: ['Mistaking politeness for urgency.'],
        killCriteria: ['No review booked within 7 days.'],
      },
      workstreams: [
        {
          name: 'Evidence',
          objective: 'Verify the workflow pain before building.',
          nextSteps: ['Ask for one workflow artifact.'],
          dependencies: [],
          stopCondition: 'No review slot after two asks.',
        },
      ],
      actionableNextStep: {
        target: 'Book one workflow review.',
        risk: 'consequential',
        reversibilityClass: 'external-cancelable',
        authority: 'human',
        reason: 'The next commitment touches an external buyer.',
        undo: 'Do not schedule the review.',
        evidenceIds: [],
        confidence: 0.7,
      },
    },
  };
}

async function seedFootprintHrv(store, values) {
  for (const [index, hrv] of values.entries()) {
    await store.writeFootprintSample({
      sampleId: `cue-context-${index}`,
      eventAt: `2026-06-28T23:5${index}:00.000Z`,
      provenance: { surface: 'body', lane: 'ambient' },
      phenomenology: {
        report: `HRV cue context sample ${index}.`,
      },
      physiology: {
        hrv,
      },
    });
  }
}

async function seedFootprintSleepDuration(store, values) {
  for (const [index, sleepDuration] of values.entries()) {
    await store.writeFootprintSample({
      sampleId: `cue-context-sleep-${index}`,
      eventAt: `2026-06-28T23:4${index}:00.000Z`,
      provenance: { surface: 'body', lane: 'ambient' },
      phenomenology: {
        report: `Sleep cue context sample ${index}.`,
      },
      outcome: {
        category: 'sleep',
        measurements: {
          sleepDuration,
        },
      },
    });
  }
}

async function seedIngestFile(store, relPath, content, mtime = '2026-06-28T00:00:00.000Z') {
  const file = path.join(store.dataDir, 'ingest', ...relPath.split('/'));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, 'utf8');

  const date = new Date(mtime);
  await fs.utimes(file, date, date);
}

async function writeSourcesRegistry(store, sources) {
  await fs.writeFile(
    path.join(store.dataDir, 'sources.json'),
    `${JSON.stringify({
      kind: 'SourcesRegistry',
      schemaVersion: 1,
      sources,
    }, null, 2)}\n`,
    'utf8',
  );
}

function sourceById(sources, id) {
  const source = sources.find((candidate) => candidate.id === id);
  assert(source, `expected source ${id}`);
  return source;
}

function assertBoundedSource(source) {
  assert.deepEqual(Object.keys(source), [
    'id',
    'label',
    'kind',
    'active',
    'count',
    'lastIngestedAt',
  ]);
  assert.equal(typeof source.id, 'string');
  assert.equal(typeof source.label, 'string');
  assert.equal(typeof source.kind, 'string');
  assert.equal(typeof source.active, 'boolean');
  assert.equal(typeof source.count, 'number');
  if (source.lastIngestedAt !== null) {
    assert.equal(new Date(source.lastIngestedAt).toISOString(), source.lastIngestedAt);
  }
}

function pickSource(source) {
  return {
    id: source.id,
    label: source.label,
    kind: source.kind,
    active: source.active,
    count: source.count,
  };
}

async function networkRequest(baseUrl, method, pathname, body, headers = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body,
  });
}

async function readSseEvent(response, predicate, options = {}) {
  const timeoutMs = options.timeoutMs ?? 1500;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + timeoutMs;
  let cancelled = false;
  const cancelReader = async () => {
    if (cancelled) return;
    cancelled = true;
    await reader.cancel();
  };

  try {
    while (Date.now() < deadline) {
      const event = takeSseEvent(buffer, predicate);
      if (event.match) {
        await cancelReader();
        return event.value;
      }
      buffer = event.buffer;

      const remaining = deadline - Date.now();
      const read = await Promise.race([
        reader.read(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('sse_timeout')), remaining)),
      ]);
      if (read.done) break;
      buffer += decoder.decode(read.value, { stream: true });
    }

    throw new Error('sse_timeout');
  } finally {
    await cancelReader();
  }
}

function takeSseEvent(buffer, predicate) {
  let current = buffer;
  while (true) {
    const separator = current.indexOf('\n\n');
    if (separator === -1) return { match: false, buffer: current };
    const block = current.slice(0, separator);
    current = current.slice(separator + 2);
    if (!block || block.startsWith(': ')) continue;

    const parsed = parseSseBlock(block);
    if (predicate(parsed)) return { match: true, value: parsed, buffer: current };
  }
}

function parseSseBlock(block) {
  const lines = block.split('\n');
  const event = lines.find((line) => line.startsWith('event: '))?.slice(7);
  const data = lines.find((line) => line.startsWith('data: '))?.slice(6);
  return {
    event,
    data: data ? JSON.parse(data) : null,
  };
}

function assertPlanningSummary(body) {
  assert.equal(typeof body.globalBodyState, 'string');
  assert.notEqual(body.globalBodyState, '');
  assert.equal(body.generatedAt, fixedNow().toISOString());
  assert.equal(new Date(body.generatedAt).toISOString(), body.generatedAt);
  assert.equal(body.source, 'cs-k');
}

async function substrateSnapshot(dataDir) {
  const root = path.join(dataDir, 'substrate');
  const files = [];
  await walk(root, root, files);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function walk(root, dir, files) {
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(root, entryPath, files);
    } else if (entry.isFile()) {
      const content = await fs.readFile(entryPath);
      const stat = await fs.stat(entryPath);
      files.push({
        path: path.relative(root, entryPath),
        mtimeMs: stat.mtimeMs,
        hash: createHash('sha256').update(content).digest('hex'),
      });
    }
  }
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

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}
