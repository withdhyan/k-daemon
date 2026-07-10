import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DIAGNOSTICS_MAX_BYTES,
  appendDiagnostic,
  readRecentDiagnostics,
} from './diagnostics.mjs';

test('appendDiagnostic writes one bounded JSONL turn shape', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-diagnostics-shape-'));

  await appendDiagnostic({
    turn: {
      dataDir,
      ts: '2026-07-03T01:02:03.000Z',
      lane: 'sovereign',
      sensitivity: 'sensitive',
      sovereign: true,
      steps: 2,
      held: [{ id: 'a' }, { id: 'b' }],
      glazeScore: 0.42,
      ttftMs: 12.4,
      totalMs: 45.6,
      ok: true,
    },
  });

  const recent = await readRecentDiagnostics({ dataDir, limit: 10 });
  assert.deepEqual(recent, [{
    ts: '2026-07-03T01:02:03.000Z',
    lane: 'sovereign',
    sensitivity: 'sensitive',
    sovereign: true,
    steps: 2,
    held: 2,
    ttftMs: 12,
    totalMs: 46,
    ok: true,
    glazeScore: 0.42,
  }]);
});

test('appendDiagnostic rotates at 5MB and keeps current plus .1', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-diagnostics-rotate-'));
  const dir = path.join(dataDir, 'diagnostics');
  const file = path.join(dir, 'k-diagnostics.log');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, `${JSON.stringify({ ts: 'old' })}\n`, 'utf8');
  await fs.truncate(file, DIAGNOSTICS_MAX_BYTES);

  await appendDiagnostic({
    turn: {
      dataDir,
      ts: '2026-07-03T02:00:00.000Z',
      lane: 'sovereign',
      sensitivity: 'sensitive',
      sovereign: true,
      steps: 0,
      held: 0,
      ttftMs: null,
      totalMs: 5,
      ok: false,
      errorCode: 'sovereign_lane_unavailable',
    },
  });

  const rotated = await fs.stat(`${file}.1`);
  const current = await fs.readFile(file, 'utf8');
  const recent = await readRecentDiagnostics({ dataDir, limit: 1 });

  assert.equal(rotated.size, DIAGNOSTICS_MAX_BYTES);
  assert.equal(await exists(`${file}.2`), false);
  assert.equal(JSON.parse(current).errorCode, 'sovereign_lane_unavailable');
  assert.equal(recent.length, 1);
  assert.equal(recent[0].ts, '2026-07-03T02:00:00.000Z');
});

test('appendDiagnostic never throws into the caller path', async () => {
  const dataDir = path.join(os.tmpdir(), `cs-k-diagnostics-file-${process.pid}-${Date.now()}`);
  await fs.writeFile(dataDir, 'not a directory', 'utf8');

  await assert.doesNotReject(() =>
    appendDiagnostic({
      turn: {
        dataDir,
        lane: 'unknown',
        sensitivity: 'unknown',
        sovereign: false,
        steps: 0,
        held: 0,
        ttftMs: null,
        totalMs: 1,
        ok: false,
        errorCode: 'chat_failed',
      },
    }));
});

async function exists(file) {
  try {
    await fs.stat(file);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}
