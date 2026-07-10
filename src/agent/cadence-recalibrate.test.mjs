import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  loadCadenceRecalibrationAnchor,
  recalibrateCadenceBlocks,
  saveCadenceRecalibrationAnchor,
} from './cadence-recalibrate.mjs';

test('late wake-init protects core, compresses middle, skips small outer blocks', () => {
  const result = recalibrateCadenceBlocks({
    now: '2026-07-05T09:45:00.000Z',
    trigger: { type: 'act', action: 'wake_init' },
    blocks: [
      block({
        id: 'core-0900',
        startAt: '2026-07-05T09:00:00.000Z',
        endAt: '2026-07-05T10:00:00.000Z',
        ring: 'core',
      }),
      block({
        id: 'middle-1000',
        startAt: '2026-07-05T10:00:00.000Z',
        endAt: '2026-07-05T11:00:00.000Z',
        ring: 'middle',
      }),
      block({
        id: 'outer-1100',
        startAt: '2026-07-05T11:00:00.000Z',
        endAt: '2026-07-05T11:10:00.000Z',
        ring: 'outer',
      }),
      block({
        id: 'core-1110',
        startAt: '2026-07-05T11:10:00.000Z',
        endAt: '2026-07-05T12:00:00.000Z',
        ring: 'core',
      }),
    ],
  });

  assert.equal(result.changed, true);
  assert.equal(result.reason, 'wake-init');
  assert.equal(result.blocks[0].startAt, '2026-07-05T09:45:00.000Z');
  assert.equal(result.blocks[0].endAt, '2026-07-05T10:45:00.000Z');
  assert.deepEqual(result.blocks[0].recalibrationChange, {
    type: 'protect',
    originalStart: '2026-07-05T09:00:00.000Z',
    newStart: '2026-07-05T09:45:00.000Z',
    deltaMinutes: 45,
  });
  assert.equal(result.blocks[1].startAt, '2026-07-05T10:45:00.000Z');
  assert.equal(result.blocks[1].endAt, '2026-07-05T11:15:00.000Z');
  assert.equal(result.blocks[1].recalibrationChange.type, 'compress');
  assert.equal(result.blocks[2].skipped, true);
  assert.equal(result.blocks[2].recalibrationChange.type, 'skip');
  assert.equal(result.blocks[3].recalibrationChange.type, 'protect');
  assert.equal(result.blocks[3].recalibrationChange.deltaMinutes, 5);
  assert.deepEqual(result.changes.map((change) => [change.blockId, change.type]), [
    ['core-0900', 'protect'],
    ['middle-1000', 'compress'],
    ['outer-1100', 'skip'],
    ['core-1110', 'protect'],
  ]);
});

test('overrun act reshapes only blocks after the late block', () => {
  const result = recalibrateCadenceBlocks({
    now: '2026-07-05T10:20:00.000Z',
    trigger: { type: 'act', blockId: 'core-0900', action: 'complete' },
    blocks: [
      block({
        id: 'core-0900',
        startAt: '2026-07-05T09:00:00.000Z',
        endAt: '2026-07-05T10:00:00.000Z',
        ring: 'core',
      }),
      block({
        id: 'middle-1000',
        startAt: '2026-07-05T10:00:00.000Z',
        endAt: '2026-07-05T11:00:00.000Z',
        ring: 'middle',
      }),
      block({
        id: 'core-1100',
        startAt: '2026-07-05T11:00:00.000Z',
        endAt: '2026-07-05T12:00:00.000Z',
        ring: 'core',
      }),
    ],
  });

  assert.equal(result.changed, true);
  assert.equal(result.reason, 'overrun');
  assert.equal(result.blocks[0].recalibrationChange, undefined);
  assert.equal(result.blocks[1].startAt, '2026-07-05T10:20:00.000Z');
  assert.equal(result.blocks[1].endAt, '2026-07-05T11:00:00.000Z');
  assert.deepEqual(result.blocks[1].recalibrationChange, {
    type: 'compress',
    originalStart: '2026-07-05T10:00:00.000Z',
    newStart: '2026-07-05T10:20:00.000Z',
    deltaMinutes: 20,
  });
  assert.equal(result.blocks[2].recalibrationChange, undefined);
});

test('adjacent outer blocks merge to absorb remaining delay', () => {
  const result = recalibrateCadenceBlocks({
    now: '2026-07-05T09:15:00.000Z',
    trigger: { type: 'act', action: 'wake_init' },
    blocks: [
      block({
        id: 'outer-a',
        startAt: '2026-07-05T09:00:00.000Z',
        endAt: '2026-07-05T09:20:00.000Z',
        ring: 'outer',
        attentionMode: 'operative',
      }),
      block({
        id: 'outer-b',
        startAt: '2026-07-05T09:20:00.000Z',
        endAt: '2026-07-05T09:40:00.000Z',
        ring: 'outer',
        attentionMode: 'operative',
      }),
      block({
        id: 'core-0940',
        startAt: '2026-07-05T09:40:00.000Z',
        endAt: '2026-07-05T10:40:00.000Z',
        ring: 'core',
      }),
    ],
  });

  assert.equal(result.blocks[0].recalibrationChange.type, 'compress');
  assert.equal(result.blocks[1].skipped, true);
  assert.equal(result.blocks[1].mergedIntoBlockId, 'outer-a');
  assert.equal(result.blocks[1].recalibrationChange.type, 'merge');
  assert.equal(result.blocks[2].recalibrationChange, undefined);
});

test('recalibration anchors round-trip through the data directory', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-cadence-recalibrate-'));
  const saved = await saveCadenceRecalibrationAnchor({
    dataDir,
    date: '2026-07-05',
    reason: 'wake-init',
    anchorAt: '2026-07-05T09:45:00.000Z',
    trigger: { type: 'act', action: 'wake_init', source: 'cadence-home' },
  });
  const loaded = await loadCadenceRecalibrationAnchor({ dataDir, date: '2026-07-05' });

  assert.deepEqual(loaded, saved);
  assert.equal(loaded.kind, 'CadenceRecalibrationAnchor');
  assert.equal(loaded.reason, 'wake-init');
});

function block(input) {
  return {
    id: input.id,
    startAt: input.startAt,
    endAt: input.endAt,
    ring: input.ring,
    attentionMode: input.attentionMode ?? 'converge',
    description: `${input.id} block`,
  };
}
