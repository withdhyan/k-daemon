import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CADENCE_BODY_UPDATE_SIGNALS,
  CADENCE_DAY_ZERO_CAPTION,
  DEFAULT_CADENCE_CAPACITY_SEEDS,
  computeCadenceNowNext,
  createCadenceEngineStore,
  defaultCadenceDay,
  draftCadenceDay,
  shouldRecomputeCadenceNowNext,
} from './cadence-engine.mjs';

const fixedNow = () => new Date('2026-07-05T09:30:00.000Z');

test('day-zero now/next renders the default template and capacity seeds before K drafts', async () => {
  const dataDir = await tempDataDir();
  const store = createCadenceEngineStore({ dataDir, now: fixedNow });

  const snapshot = await store.recomputeNowNext({ trigger: 'tick' });
  const persisted = await store.loadSnapshot('2026-07-05');

  assert.equal(CADENCE_DAY_ZERO_CAPTION, "your usual rhythm · k hasn't drafted today");
  assert.equal(snapshot.daySource, 'default-template');
  assert.equal(snapshot.dayDrafted, false);
  assert.equal(snapshot.caption, "your usual rhythm · k hasn't drafted today");
  assert.deepEqual(snapshot.capacityByMode, DEFAULT_CADENCE_CAPACITY_SEEDS);
  assert.equal(snapshot.nowBlock.id, 'deep-0900-2026-07-05');
  assert.equal(snapshot.nowBlock.type, 'work');
  assert.equal(snapshot.nowBlock.why, 'the one thing that compounds');
  assert.equal(snapshot.nowBlock.status, 'now');
  assert.equal(snapshot.nextBlock.id, 'breakthrough-1130-2026-07-05');
  assert.equal(snapshot.nextBlock.type, 'work');
  assert.equal(snapshot.nextBlock.why, 'the one thing that compounds');
  assert(snapshot.stream.every((block) => block.type && block.why));
  assert.equal(snapshot.stream.find((block) => block.id === 'restore-0630-2026-07-05').type, 'routine');
  assert.equal(
    snapshot.stream.find((block) => block.id === 'restore-0630-2026-07-05').why,
    "set the day's shape",
  );
  assert.equal(snapshot.stream.find((block) => block.id === 'physical-0715-2026-07-05').type, 'workout');
  assert.equal(snapshot.stream.find((block) => block.id === 'diverge-1430-2026-07-05').type, 'ops');
  assert.equal(snapshot.stream.find((block) => block.id === 'restore-2100-2026-07-05').type, 'routine');
  assert.equal(persisted.caption, "your usual rhythm · k hasn't drafted today");
  assert.equal(persisted.nowBlock.type, 'work');
  assert.equal(persisted.nowBlock.why, 'the one thing that compounds');
});

test('recompute gates body updates to b1/b2/b4/b6 while tick and act always recompute', async () => {
  const dataDir = await tempDataDir();
  const store = createCadenceEngineStore({ dataDir, now: fixedNow });

  assert.deepEqual(CADENCE_BODY_UPDATE_SIGNALS, ['b1', 'b2', 'b4', 'b6']);
  assert.equal(shouldRecomputeCadenceNowNext({ type: 'tick' }), true);
  assert.equal(shouldRecomputeCadenceNowNext({ type: 'act', blockId: 'deep-0900', action: 'complete' }), true);
  assert.equal(shouldRecomputeCadenceNowNext({ type: 'body-update', signal: 'b1' }), true);
  assert.equal(shouldRecomputeCadenceNowNext({ type: 'body-update', signal: 'b3' }), false);
  assert.equal(shouldRecomputeCadenceNowNext({ type: 'body_update', bodySignal: 'b6' }), true);

  const skipped = await store.recomputeNowNext({
    now: '2026-07-05T09:31:00.000Z',
    trigger: { type: 'body-update', signal: 'b3' },
  });
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.reason, 'body_signal_not_allowed');
  assert.equal(await store.loadSnapshot('2026-07-05'), null);

  const bodySnapshot = await store.recomputeNowNext({
    now: '2026-07-05T09:32:00.000Z',
    trigger: { type: 'body-update', signal: 'b6' },
  });
  assert.equal(bodySnapshot.trigger.type, 'body-update');
  assert.equal(bodySnapshot.trigger.signal, 'b6');

  const actSnapshot = await store.recomputeNowNext({
    now: '2026-07-05T09:33:00.000Z',
    trigger: { type: 'act', blockId: 'deep-0900-2026-07-05', action: '+15' },
  });
  assert.equal(actSnapshot.trigger.type, 'act');
  assert.equal(actSnapshot.trigger.action, '+15');
  assert.equal((await store.loadSnapshot('2026-07-05')).trigger.type, 'act');
});

test('K drafts the day from template, calendar events, and the admin queue', async () => {
  const day = draftCadenceDay({
    date: '2026-07-05',
    now: '2026-07-05T05:00:00.000Z',
    calendarEvents: [
      {
        id: 'investor-call',
        title: 'Investor call',
        startAt: '2026-07-05T09:30:00.000Z',
        endAt: '2026-07-05T10:00:00.000Z',
      },
    ],
    adminItems: [
      {
        id: 'adm_visa',
        title: 'Renew visa',
        type: 'TimeSensitive',
        effort: 'Quick',
        remindAt: '2026-07-05T08:00:00.000Z',
        dueAt: '2026-09-20T00:00:00.000Z',
      },
    ],
  });

  const calendarBlock = day.blocks.find((block) => block.source === 'calendar');
  const opsBlock = day.blocks.find((block) => block.opsBlock === true);
  const snapshot = computeCadenceNowNext({
    day,
    now: '2026-07-05T09:45:00.000Z',
    trigger: 'tick',
  });

  assert.equal(day.source, 'k-draft');
  assert.equal(day.caption, null);
  assert.deepEqual(day.inputs.sources, ['template', 'calendar', 'admin_queue']);
  assert.equal(day.inputs.calendarEventCount, 1);
  assert.equal(day.inputs.adminItemCount, 1);
  assert.equal(calendarBlock.id, 'cal-investor-call-2026-07-05');
  assert.equal(calendarBlock.attentionMode, 'operative');
  assert.equal(opsBlock.adminQueue.count, 1);
  assert.deepEqual(opsBlock.adminQueue.itemIds, ['adm_visa']);
  assert.equal(snapshot.daySource, 'k-draft');
  assert.equal(snapshot.caption, undefined);
  assert.equal(snapshot.nowBlock.id, 'cal-investor-call-2026-07-05');
});

test('recompute protects a started block as now after its scheduled window', () => {
  const day = defaultCadenceDay({
    date: '2026-07-05',
    now: '2026-07-05T05:00:00.000Z',
  });

  const snapshot = computeCadenceNowNext({
    day,
    now: '2026-07-05T11:45:00.000Z',
    trigger: { type: 'act', blockId: 'deep-0900-2026-07-05', action: 'start' },
    acts: [
      {
        date: '2026-07-05',
        blockId: 'deep-0900-2026-07-05',
        action: 'start',
        eventAt: '2026-07-05T09:05:00.000Z',
      },
    ],
  });

  assert.equal(snapshot.nowBlock.id, 'deep-0900-2026-07-05');
  assert.equal(snapshot.nowBlock.status, 'now');
  assert.equal(snapshot.nowBlock.actionState, 'started');
  assert.equal(snapshot.nowBlock.startedAt, '2026-07-05T09:05:00.000Z');
  assert.equal(snapshot.nowBlock.elapsedMinutes, 160);
  assert.equal(snapshot.nextBlock.id, 'diverge-1430-2026-07-05');
  assert.equal(
    snapshot.stream.find((block) => block.id === 'breakthrough-1130-2026-07-05').status,
    'active',
  );
});

test('drafted days are persisted and replace the day-zero fallback for recompute', async () => {
  const dataDir = await tempDataDir();
  const store = createCadenceEngineStore({
    dataDir,
    now: () => new Date('2026-07-05T16:10:00.000Z'),
  });

  const drafted = await store.draftDay({
    date: '2026-07-05',
    now: '2026-07-05T05:00:00.000Z',
    adminItems: [
      {
        id: 'adm_storage',
        title: 'Book storage pickup',
        type: 'RegularQueue',
        effort: 'Hour',
        remindAt: '2026-07-05T08:00:00.000Z',
        dueAt: '2026-08-01T00:00:00.000Z',
      },
    ],
  });
  const snapshot = await store.recomputeNowNext({ trigger: 'tick' });

  assert.equal(drafted.source, 'k-draft');
  assert.equal(snapshot.daySource, 'k-draft');
  assert.equal(snapshot.caption, undefined);
  assert.equal(snapshot.nowBlock.id, 'ops-1600-2026-07-05');
  assert.equal(snapshot.nowBlock.adminQueue.count, 1);
});

test('late wake-init recompute recalibrates and persists the remaining day', async () => {
  const dataDir = await tempDataDir();
  const store = createCadenceEngineStore({
    dataDir,
    now: () => new Date('2026-07-05T09:45:00.000Z'),
  });
  const day = draftCadenceDay({
    date: '2026-07-05',
    now: '2026-07-05T05:00:00.000Z',
    adminItems: [],
    template: {
      id: 'recalibration-test',
      capacityByMode: DEFAULT_CADENCE_CAPACITY_SEEDS,
      blocks: [
        templateBlock({
          id: 'core-0900',
          startTime: '09:00',
          endTime: '10:00',
          ring: 'core',
        }),
        templateBlock({
          id: 'middle-1000',
          startTime: '10:00',
          endTime: '11:00',
          ring: 'middle',
        }),
        templateBlock({
          id: 'outer-1100',
          startTime: '11:00',
          endTime: '11:10',
          ring: 'outer',
          attentionMode: 'operative',
        }),
        templateBlock({
          id: 'core-1110',
          startTime: '11:10',
          endTime: '12:00',
          ring: 'core',
        }),
      ],
    },
  });
  await store.saveDay(day);

  const snapshot = await store.recomputeNowNext({
    now: '2026-07-05T09:45:00.000Z',
    trigger: { type: 'act', action: 'wake_init' },
  });
  const persisted = await store.loadDay('2026-07-05');
  const first = persisted.blocks.find((block) => block.templateBlockId === 'core-0900');
  const skipped = persisted.blocks.find((block) => block.templateBlockId === 'outer-1100');

  assert.equal(persisted.recalibration.reason, 'wake-init');
  assert.deepEqual(persisted.recalibrationChanges.map((change) => [change.blockId, change.type]), [
    ['core-0900-2026-07-05', 'protect'],
    ['middle-1000-2026-07-05', 'compress'],
    ['outer-1100-2026-07-05', 'skip'],
    ['core-1110-2026-07-05', 'protect'],
  ]);
  assert.equal(first.startAt, '2026-07-05T09:45:00.000Z');
  assert.equal(first.recalibrationChange.type, 'protect');
  assert.equal(skipped.skipped, true);
  assert.equal(snapshot.recalibration.reason, 'wake-init');
  assert.equal(snapshot.nowBlock.id, 'core-0900-2026-07-05');
  assert.equal(snapshot.stream.find((block) => block.id === skipped.id).status, 'skipped');
});

test('store draft pulls the existing admin queue when explicit admin items are absent', async () => {
  const dataDir = await tempDataDir();
  const store = createCadenceEngineStore({
    dataDir,
    now: fixedNow,
    opsStore: {
      listAdminItems: async () => [
        {
          id: 'adm_passport',
          title: 'Renew passport',
          status: 'open',
          type: 'TimeSensitive',
          effort: 'Quick',
          remindAt: '2026-07-05T08:00:00.000Z',
          dueAt: '2026-09-20T00:00:00.000Z',
        },
      ],
    },
    substrateStore: {
      listRecords: async () => [],
    },
  });

  const day = await store.draftDay({ date: '2026-07-05' });
  const opsBlock = day.blocks.find((block) => block.opsBlock === true);

  assert.equal(day.inputs.adminItemCount, 1);
  assert.deepEqual(opsBlock.adminQueue.itemIds, ['adm_passport']);
});

async function tempDataDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-cadence-engine-'));
}

function templateBlock(input) {
  return {
    id: input.id,
    startTime: input.startTime,
    endTime: input.endTime,
    ring: input.ring,
    attentionMode: input.attentionMode ?? 'converge',
    description: `${input.id} block`,
    type: input.type ?? 'work',
    why: input.why ?? 'test recalibration',
  };
}
