import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  handleWhoopRoute,
} from '../../daemon/routes/whoop.mjs';
import { createSubstrateStore } from '../substrate.mjs';
import {
  WHOOP_SCOPES,
  readWhoopTokens,
  syncWhoop,
  writeWhoopTokens,
} from './whoop.mjs';

const fixedNow = () => new Date('2026-07-09T10:00:00.000Z');
const env = Object.freeze({
  WHOOP_CLIENT_ID: 'client-id',
  WHOOP_CLIENT_SECRET: 'client-secret',
  WHOOP_REDIRECT_URI: 'http://127.0.0.1:3003/api/whoop/callback',
});

test('WHOOP sync refreshes an expired token, paginates, maps vitals, and is dedup-idempotent', async () => {
  const dataDir = await tempDataDir();
  const store = createSubstrateStore({ dataDir, now: fixedNow });
  await writeWhoopTokens({
    dataDir,
    tokens: {
      accessToken: 'expired-access',
      refreshToken: 'refresh-me',
      expiresAt: '2026-07-09T09:59:00.000Z',
      tokenType: 'Bearer',
      scope: WHOOP_SCOPES,
    },
  });

  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).endsWith('/oauth/oauth2/token')) {
      assert.equal(formValue(options.body, 'grant_type'), 'refresh_token');
      assert.equal(formValue(options.body, 'refresh_token'), 'refresh-me');
      return jsonResponse({
        access_token: 'fresh-access',
        refresh_token: 'fresh-refresh',
        expires_in: 3600,
        token_type: 'Bearer',
      });
    }

    assert.equal(options.headers.authorization, 'Bearer fresh-access');
    const parsed = new URL(url);
    if (parsed.searchParams.get('nextToken') === 'recovery-page-2') {
      return jsonResponse({ records: [whoopRecovery({ cycle_id: 43, recovery_score: 61 })] });
    }
    if (parsed.pathname.endsWith('/developer/v2/recovery')) {
      return jsonResponse({
        records: [whoopRecovery()],
        nextToken: 'recovery-page-2',
      });
    }
    if (parsed.pathname.endsWith('/developer/v2/activity/sleep')) {
      return jsonResponse({ records: [whoopSleep()] });
    }
    if (parsed.pathname.endsWith('/developer/v2/cycle')) {
      return jsonResponse({ records: [whoopCycle()] });
    }
    if (parsed.pathname.endsWith('/developer/v2/activity/workout')) {
      return jsonResponse({ records: [whoopWorkout()] });
    }
    throw new Error(`unexpected WHOOP URL: ${url}`);
  };

  const first = await syncWhoop({ dataDir, store, env, now: fixedNow, fetchImpl });
  const before = await substrateSnapshot(dataDir);
  const second = await syncWhoop({ dataDir, store, env, now: fixedNow, fetchImpl });
  const after = await substrateSnapshot(dataDir);
  const records = await store.listRecords('VitalRecord');
  const refreshed = await readWhoopTokens({ dataDir });

  assert.equal(first.skipped, false);
  assert.equal(first.createdCount, 5);
  assert.equal(first.duplicateCount, 0);
  assert.equal(first.counts.recovery, 2);
  assert.equal(first.counts.sleep, 1);
  assert.equal(first.counts.cycle, 1);
  assert.equal(first.counts.workout, 1);
  assert.equal(second.createdCount, 0);
  assert.equal(second.duplicateCount, 5);
  assert.deepEqual(after, before);
  assert.equal(refreshed.accessToken, 'fresh-access');
  assert.equal(refreshed.refreshToken, 'fresh-refresh');
  assert.equal(requests.some((request) => new URL(request.url).searchParams.get('nextToken') === 'recovery-page-2'), true);

  const bySource = new Map(records.map((record) => [record.sourceId, record]));
  assert.equal(bySource.get('whoop:recovery:42').provenance.surface, 'whoop');
  assert.deepEqual(bySource.get('whoop:recovery:42').measurements, {
    recoveryScore: 78,
    hrvMs: 39.5,
    restingHeartRate: 48,
  });
  assert.deepEqual(bySource.get('whoop:cycle:42').measurements, { strain: 12.3 });
  assert.deepEqual(bySource.get('whoop:workout:9001').measurements, { strain: 8.2 });
  assert.deepEqual(bySource.get('whoop:sleep:7001').measurements, {
    durationMinutes: 435,
    sleepEfficiency: 91,
    deepSleepMinutes: 85,
    remSleepMinutes: 92,
    awakeMinutes: 30,
  });
});

test('WHOOP sync is a clean no-op when env is unconfigured or tokens are absent', async () => {
  const dataDir = await tempDataDir();
  const store = createSubstrateStore({ dataDir, now: fixedNow });

  const unconfigured = await syncWhoop({ dataDir, store, env: {}, now: fixedNow, fetchImpl: unusedFetch });
  const unconnected = await syncWhoop({ dataDir, store, env, now: fixedNow, fetchImpl: unusedFetch });

  assert.deepEqual(unconfigured, {
    skipped: true,
    reason: 'unconfigured',
    configured: false,
    connected: false,
    createdCount: 0,
    duplicateCount: 0,
    counts: { recovery: 0, sleep: 0, cycle: 0, workout: 0 },
  });
  assert.equal(unconnected.skipped, true);
  assert.equal(unconnected.reason, 'unconnected');
  assert.equal(await store.countRecords('VitalRecord'), 0);
});

test('WHOOP callback rejects a state mismatch with 400 and does not call the token endpoint', async () => {
  const dataDir = await tempDataDir();
  let fetchCalls = 0;
  const response = await dispatchWhoopRoute({
    dataDir,
    method: 'GET',
    pathname: '/api/whoop/callback',
    search: '?code=abc&state=wrong',
    env,
    fetchImpl: async () => {
      fetchCalls += 1;
      return jsonResponse({});
    },
  });

  assert.equal(response.status, 400);
  assert.match(response.body, /state mismatch/i);
  assert.equal(fetchCalls, 0);
});

function whoopRecovery(overrides = {}) {
  return {
    cycle_id: overrides.cycle_id ?? 42,
    sleep_id: 7001,
    created_at: '2026-07-09T08:00:00.000Z',
    updated_at: '2026-07-09T08:05:00.000Z',
    score: {
      recovery_score: overrides.recovery_score ?? 78,
      hrv_rmssd_milli: 39.5,
      resting_heart_rate: 48,
    },
  };
}

function whoopSleep() {
  return {
    id: 7001,
    start: '2026-07-08T22:30:00.000Z',
    end: '2026-07-09T06:15:00.000Z',
    score: {
      sleep_efficiency_percentage: 91,
      stage_summary: {
        total_light_sleep_time_milli: 258 * 60 * 1000,
        total_slow_wave_sleep_time_milli: 85 * 60 * 1000,
        total_rem_sleep_time_milli: 92 * 60 * 1000,
        total_awake_time_milli: 30 * 60 * 1000,
      },
    },
  };
}

function whoopCycle() {
  return {
    id: 42,
    start: '2026-07-08T06:00:00.000Z',
    end: '2026-07-09T06:00:00.000Z',
    score: {
      strain: 12.3,
    },
  };
}

function whoopWorkout() {
  return {
    id: 9001,
    start: '2026-07-08T17:00:00.000Z',
    end: '2026-07-08T18:00:00.000Z',
    score: {
      strain: 8.2,
    },
  };
}

function jsonResponse(body, options = {}) {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    statusText: options.statusText ?? 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function formValue(body, key) {
  return new URLSearchParams(String(body)).get(key);
}

async function dispatchWhoopRoute({ dataDir, method, pathname, search = '', env, fetchImpl }) {
  const response = captureResponse();
  const handled = await handleWhoopRoute(
    {
      method,
      url: `${pathname}${search}`,
    },
    response,
    {
      method,
      pathname,
      searchParams: new URLSearchParams(search.replace(/^\?/, '')),
      dataDir,
      now: fixedNow,
      whoop: { env, fetchImpl },
    },
    {
      sendJson: (target, status, body) => {
        target.statusCode = status;
        target.setHeader('content-type', 'application/json');
        target.end(JSON.stringify(body));
      },
      httpError: (statusCode, code) => Object.assign(new Error(code), { statusCode, code, expose: true }),
    },
  );
  assert.equal(handled, true);
  return response.result();
}

function captureResponse() {
  const chunks = [];
  return {
    statusCode: 200,
    headers: {},
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    writeHead(status, headers = {}) {
      this.statusCode = status;
      for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    },
    end(chunk = '') {
      chunks.push(Buffer.from(String(chunk)));
    },
    result() {
      return {
        status: this.statusCode,
        headers: this.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
    },
  };
}

async function tempDataDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-whoop-'));
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

async function unusedFetch() {
  throw new Error('fetch must not be called');
}
