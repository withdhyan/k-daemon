import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  CADENCE_ACTS_PATH,
  CADENCE_BANDISH_PATH,
  CADENCE_DAY_PATH,
  handleCadenceActsRoute,
  handleCadenceRoute,
} from '../../daemon/routes/cadence.mjs';
import { createCadenceActStore } from './cadence-acts.mjs';
import { createOpsGroupStore } from './ops-groups.mjs';
import { createSubstrateStore } from '../substrate.mjs';

const fixedNow = () => new Date('2026-07-05T09:00:00.000Z');

test('cadence day route populates ops block checklist from ops groups', async () => {
  const dataDir = await tempDataDir();
  const store = createSubstrateStore({ dataDir, now: fixedNow });
  const opsStore = createOpsGroupStore({ dataDir, now: fixedNow });
  const group = await opsStore.saveGroup({ title: 'Morning ops' });
  const item = await opsStore.saveGroupItem({
    groupId: group.id,
    title: 'Check passport renewal',
  });
  const { item: adminItem } = await opsStore.addAdminItem({
    title: 'Renew visa',
    type: 'TimeSensitive',
    effort: 'Quick',
  });

  const upsert = await dispatchDayRoute({
    dataDir,
    store,
    opsStore,
    method: 'POST',
    pathname: CADENCE_DAY_PATH,
    payload: {
      date: '2026-07-05',
      bandish: [
        {
          startAt: '2026-07-05T09:00:00.000Z',
          endAt: '2026-07-05T10:00:00.000Z',
          attentionMode: 'converge',
          ring: 'core',
          description: 'Deep work',
        },
        {
          startAt: '2026-07-05T13:00:00.000Z',
          endAt: '2026-07-05T13:45:00.000Z',
          attentionMode: 'operative',
          ring: 'outer',
          blockType: 'ops',
          description: 'Ops sweep',
        },
      ],
    },
  });
  assert.equal(upsert.status, 200);

  const day = await dispatchDayRoute({
    dataDir,
    store,
    opsStore,
    method: 'GET',
    pathname: `${CADENCE_DAY_PATH}?date=2026-07-05`,
  });
  const opsBlock = day.body.blocks.find((block) => block.description === 'Ops sweep');
  const coreBlock = day.body.blocks.find((block) => block.description === 'Deep work');

  assert.equal(day.status, 200);
  assert.equal(coreBlock.checklist, undefined);
  assert.deepEqual(opsBlock.checklist, [
    { id: item.id, title: 'Check passport renewal', done: false },
    { id: adminItem.id, title: 'Renew visa', done: false },
  ]);
  assert.equal(opsBlock.opsChecklist.groups[0].title, 'Morning ops');
});

test('cadence write path rejects admin items on a core block', async () => {
  const dataDir = await tempDataDir();
  const store = createSubstrateStore({ dataDir, now: fixedNow });

  const rejected = await dispatchDayRoute({
    dataDir,
    store,
    method: 'POST',
    pathname: CADENCE_DAY_PATH,
    payload: {
      date: '2026-07-05',
      bandish: [
        {
          startAt: '2026-07-05T09:00:00.000Z',
          endAt: '2026-07-05T10:00:00.000Z',
          attentionMode: 'converge',
          ring: 'core',
          description: 'Deep work',
          adminItems: [{ id: 'adm_bad', title: 'Should not attach here' }],
        },
      ],
    },
  });

  assert.equal(rejected.status, 400);
  assert.deepEqual(rejected.body, { ok: false, error: 'admin_ops_block_refused' });
  assert.equal(await store.countRecords('Bandish'), 0);
});

test('cadence day route serves cadence fields and remaining capacity', async () => {
  const dataDir = await tempDataDir();
  const store = createSubstrateStore({ dataDir, now: fixedNow });

  const upsert = await dispatchDayRoute({
    dataDir,
    store,
    method: 'POST',
    pathname: CADENCE_DAY_PATH,
    payload: {
      date: '2026-07-05',
      bandish: [
        {
          startAt: '2026-07-05T08:00:00.000Z',
          endAt: '2026-07-05T08:30:00.000Z',
          attentionMode: 'converge',
          ring: 'core',
          description: 'Warm the stack',
          type: 'work',
          why: 'the one thing that compounds',
          detail: {
            plan: ['read state', 'pick one task'],
          },
        },
        {
          startAt: '2026-07-05T08:30:00.000Z',
          endAt: '2026-07-05T09:30:00.000Z',
          attentionMode: 'converge',
          ring: 'core',
          description: 'Build the slice',
          type: 'work',
          why: 'the one thing that compounds',
        },
        {
          startAt: '2026-07-05T10:00:00.000Z',
          endAt: '2026-07-05T11:00:00.000Z',
          attentionMode: 'restore',
          ring: 'core',
          description: 'Reset',
          type: 'routine',
          why: 'protect the next block',
        },
      ],
      capacityByMode: {
        converge: 120,
        restore: 60,
      },
    },
  });
  assert.equal(upsert.status, 200);

  const day = await dispatchDayRoute({
    dataDir,
    store,
    method: 'GET',
    pathname: `${CADENCE_DAY_PATH}?date=2026-07-05`,
  });
  const first = day.body.blocks[0];

  assert.equal(day.status, 200);
  assert.equal(first.type, 'work');
  assert.equal(first.why, 'the one thing that compounds');
  assert.deepEqual(first.detail, {
    plan: ['read state', 'pick one task'],
  });
  assert.deepEqual(day.body.capacityByMode, {
    converge: 120,
    restore: 60,
  });
  assert.deepEqual(day.body.remainingCapacity, {
    converge: 60,
    restore: 60,
  });
});

test('cadence day route projects lifecycle fields and act-derived elapsed capacity', async () => {
  const dataDir = await tempDataDir();
  const store = createSubstrateStore({ dataDir, now: fixedNow });
  const actStore = createCadenceActStore({ dataDir, now: fixedNow });

  const upsert = await dispatchDayRoute({
    dataDir,
    store,
    method: 'POST',
    pathname: CADENCE_DAY_PATH,
    payload: {
      date: '2026-07-05',
      bandish: [
        {
          startAt: '2026-07-05T08:00:00.000Z',
          endAt: '2026-07-05T09:00:00.000Z',
          attentionMode: 'converge',
          ring: 'core',
          description: 'Measured block',
          type: 'work',
        },
        {
          startAt: '2026-07-05T08:30:00.000Z',
          endAt: '2026-07-05T09:00:00.000Z',
          attentionMode: 'converge',
          ring: 'core',
          description: 'Skipped block',
          type: 'work',
        },
      ],
      capacityByMode: {
        converge: 120,
      },
    },
  });
  assert.equal(upsert.status, 200);
  const measuredBlockId = upsert.body.day.blocks
    .find((block) => block.description === 'Measured block').id;
  const skippedBlockId = upsert.body.day.blocks
    .find((block) => block.description === 'Skipped block').id;

  await actStore.recordBlockAct({
    date: '2026-07-05',
    blockId: measuredBlockId,
    action: 'start',
    eventAt: '2026-07-05T08:10:00.000Z',
  });
  await actStore.recordBlockAct({
    date: '2026-07-05',
    blockId: measuredBlockId,
    action: 'pause',
    eventAt: '2026-07-05T08:30:00.000Z',
  });
  await actStore.recordBlockAct({
    date: '2026-07-05',
    blockId: skippedBlockId,
    action: 'skip',
    eventAt: '2026-07-05T08:35:00.000Z',
  });

  const day = await dispatchDayRoute({
    dataDir,
    store,
    method: 'GET',
    pathname: `${CADENCE_DAY_PATH}?date=2026-07-05`,
  });

  assert.equal(day.status, 200);
  const measured = day.body.blocks.find((block) => block.id === measuredBlockId);
  const skipped = day.body.blocks.find((block) => block.id === skippedBlockId);
  assert.equal(measured.actionState, 'available');
  assert.equal(measured.elapsedMinutes, 20);
  assert.equal(measured.startedAt, undefined);
  assert.equal(skipped.actionState, 'completed');
  assert.equal(skipped.elapsedMinutes, 0);
  assert.deepEqual(day.body.remainingCapacity, {
    converge: 100,
  });
});

test('cadence bandish route rejects invalid cadence type', async () => {
  const dataDir = await tempDataDir();
  const store = createSubstrateStore({ dataDir, now: fixedNow });

  const rejected = await dispatchDayRoute({
    dataDir,
    store,
    method: 'POST',
    pathname: CADENCE_BANDISH_PATH,
    payload: {
      day: '2026-07-05',
      startAt: '2026-07-05T09:00:00.000Z',
      endAt: '2026-07-05T10:00:00.000Z',
      attentionMode: 'converge',
      ring: 'core',
      description: 'Deep work',
      type: 'planning',
    },
  });

  assert.equal(rejected.status, 400);
  assert.deepEqual(rejected.body, { ok: false, error: 'invalid_bandish' });
  assert.equal(await store.countRecords('Bandish'), 0);
});

test('cadence acts route schedules recompute after recording an act', async () => {
  const dataDir = await tempDataDir();
  const store = createCadenceActStore({ dataDir, now: fixedNow });
  const recomputes = [];

  const recorded = await dispatchActsRoute({
    dataDir,
    store,
    recomputeCadenceNowNext: async (input) => {
      recomputes.push(input);
    },
    method: 'POST',
    pathname: CADENCE_ACTS_PATH,
    payload: {
      date: '2026-07-05',
      blockId: 'deep-0900',
      action: 'complete',
      wellSpent: true,
    },
  });
  await flushMicrotasks();

  assert.equal(recorded.status, 200);
  assert.equal(recorded.body.ok, true);
  assert.equal(recomputes.length, 1);
  const { eventId, ...trigger } = recomputes[0].trigger;
  assert.deepEqual(trigger, {
    type: 'act',
    blockId: 'deep-0900',
    action: 'complete',
  });
  assert.match(eventId, /^cadact_/);
});

test('wake-init act anchors recalibration served on the cadence day payload', async () => {
  const dataDir = await tempDataDir();
  const substrateStore = createSubstrateStore({ dataDir, now: fixedNow });
  const actStore = createCadenceActStore({
    dataDir,
    now: () => new Date('2026-07-05T09:45:00.000Z'),
  });
  const recomputes = [];

  const upsert = await dispatchDayRoute({
    dataDir,
    store: substrateStore,
    method: 'POST',
    pathname: CADENCE_DAY_PATH,
    payload: {
      date: '2026-07-05',
      bandish: recalibrationBandish(),
      capacityByMode: {
        converge: 120,
        diverge: 60,
        operative: 30,
      },
    },
  });
  assert.equal(upsert.status, 200);

  const wake = await dispatchActsRoute({
    dataDir,
    store: actStore,
    now: () => new Date('2026-07-05T09:45:00.000Z'),
    recomputeCadenceNowNext: async (input) => {
      recomputes.push(input);
    },
    method: 'POST',
    pathname: CADENCE_ACTS_PATH,
    payload: {
      date: '2026-07-05',
      action: 'day_starts_now',
    },
  });
  await flushMicrotasks();

  const day = await dispatchDayRoute({
    dataDir,
    store: substrateStore,
    now: () => new Date('2026-07-05T09:45:00.000Z'),
    method: 'GET',
    pathname: `${CADENCE_DAY_PATH}?date=2026-07-05`,
  });
  const laterDay = await dispatchDayRoute({
    dataDir,
    store: substrateStore,
    now: () => new Date('2026-07-05T11:05:00.000Z'),
    method: 'GET',
    pathname: `${CADENCE_DAY_PATH}?date=2026-07-05`,
  });

  assert.equal(wake.status, 200);
  assert.equal(wake.body.act.action, 'wake_init');
  assert.equal(wake.body.recalibration.reason, 'wake-init');
  assert.equal(recomputes[0].date, '2026-07-05');
  assert.equal(recomputes[0].trigger.action, 'wake_init');
  assert.equal(day.status, 200);
  assert.equal(day.body.recalibration.reason, 'wake-init');
  assert.equal(day.body.blocks[0].description, 'Core build');
  assert.equal(day.body.blocks[0].startAt, '2026-07-05T09:45:00.000Z');
  assert.equal(day.body.blocks[0].recalibrationChange.type, 'protect');
  assert.equal(day.body.blocks[1].recalibrationChange.type, 'compress');
  assert.equal(day.body.blocks[2].skipped, true);
  assert.equal(day.body.blocks[2].recalibrationChange.type, 'skip');
  assert.deepEqual(day.body.recalibrationChanges.map((change) => change.type), [
    'protect',
    'compress',
    'skip',
    'protect',
  ]);
  assert.equal(laterDay.body.blocks[2].skipped, true);
  assert.equal(laterDay.body.remainingCapacity.operative, 30);
});

test('late complete act anchors overrun recalibration on the day payload', async () => {
  const dataDir = await tempDataDir();
  const substrateStore = createSubstrateStore({ dataDir, now: fixedNow });
  const actStore = createCadenceActStore({
    dataDir,
    now: () => new Date('2026-07-05T10:20:00.000Z'),
  });

  const upsert = await dispatchDayRoute({
    dataDir,
    store: substrateStore,
    method: 'POST',
    pathname: CADENCE_DAY_PATH,
    payload: {
      date: '2026-07-05',
      bandish: [
        {
          startAt: '2026-07-05T09:00:00.000Z',
          endAt: '2026-07-05T10:00:00.000Z',
          attentionMode: 'converge',
          ring: 'core',
          description: 'Core build',
        },
        {
          startAt: '2026-07-05T10:00:00.000Z',
          endAt: '2026-07-05T11:00:00.000Z',
          attentionMode: 'diverge',
          ring: 'middle',
          description: 'Exploration',
        },
      ],
    },
  });
  const coreId = upsert.body.day.blocks[0].id;

  const complete = await dispatchActsRoute({
    dataDir,
    store: actStore,
    substrateStore,
    now: () => new Date('2026-07-05T10:20:00.000Z'),
    recomputeCadenceNowNext: async () => {},
    method: 'POST',
    pathname: CADENCE_ACTS_PATH,
    payload: {
      date: '2026-07-05',
      blockId: coreId,
      action: 'complete',
      eventAt: '2026-07-05T10:20:00.000Z',
    },
  });
  const day = await dispatchDayRoute({
    dataDir,
    store: substrateStore,
    now: () => new Date('2026-07-05T10:20:00.000Z'),
    method: 'GET',
    pathname: `${CADENCE_DAY_PATH}?date=2026-07-05`,
  });

  assert.equal(complete.status, 200);
  assert.equal(complete.body.recalibration.reason, 'overrun');
  assert.equal(day.body.recalibration.reason, 'overrun');
  assert.equal(day.body.blocks[0].recalibrationChange, undefined);
  assert.equal(day.body.blocks[1].startAt, '2026-07-05T10:20:00.000Z');
  assert.equal(day.body.blocks[1].endAt, '2026-07-05T11:00:00.000Z');
  assert.equal(day.body.blocks[1].recalibrationChange.type, 'compress');
});

async function dispatchDayRoute(input) {
  const url = new URL(input.pathname, 'http://127.0.0.1');
  const response = mockResponse();
  const deps = routeDeps();
  try {
    await handleCadenceRoute(
      mockRequest(input.payload),
      response,
      {
        method: input.method,
        pathname: url.pathname,
        searchParams: url.searchParams,
        dataDir: input.dataDir,
        now: input.now ?? fixedNow,
        store: input.store,
        opsStore: input.opsStore,
      },
      deps,
    );
  } catch (error) {
    deps.sendJson(response, error.statusCode ?? 500, {
      ok: false,
      error: error.expose ? error.code : 'server_error',
    });
  }
  return parsedResponse(response);
}

async function dispatchActsRoute(input) {
  const response = mockResponse();
  const deps = routeDeps();
  try {
    await handleCadenceActsRoute(
      mockRequest(input.payload),
      response,
      {
        method: input.method,
        pathname: input.pathname,
        dataDir: input.dataDir,
        now: input.now ?? fixedNow,
        store: input.substrateStore,
        cadenceStore: input.store,
        recomputeCadenceNowNext: input.recomputeCadenceNowNext,
      },
      deps,
    );
  } catch (error) {
    deps.sendJson(response, error.statusCode ?? 500, {
      ok: false,
      error: error.expose ? error.code : 'server_error',
    });
  }
  return parsedResponse(response);
}

function routeDeps() {
  return {
    sendJson(response, statusCode, body) {
      response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
      response.end(`${JSON.stringify(body)}\n`);
    },
    httpError(statusCode, code) {
      const error = new Error(code);
      error.statusCode = statusCode;
      error.code = code;
      error.expose = true;
      return error;
    },
    readPlaintextJson: async (request) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    },
  };
}

function mockRequest(payload) {
  if (payload === undefined) return Readable.from([]);
  return Readable.from([Buffer.from(JSON.stringify(payload), 'utf8')]);
}

function mockResponse() {
  return {
    statusCode: null,
    body: '',
    writeHead(statusCode) {
      this.statusCode = statusCode;
    },
    end(chunk) {
      if (chunk) this.body += String(chunk);
    },
  };
}

function parsedResponse(response) {
  return {
    status: response.statusCode,
    body: JSON.parse(response.body),
  };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

async function tempDataDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-cadence-route-'));
}

function recalibrationBandish() {
  return [
    {
      startAt: '2026-07-05T09:00:00.000Z',
      endAt: '2026-07-05T10:00:00.000Z',
      attentionMode: 'converge',
      ring: 'core',
      description: 'Core build',
    },
    {
      startAt: '2026-07-05T10:00:00.000Z',
      endAt: '2026-07-05T11:00:00.000Z',
      attentionMode: 'diverge',
      ring: 'middle',
      description: 'Exploration',
    },
    {
      startAt: '2026-07-05T11:00:00.000Z',
      endAt: '2026-07-05T11:10:00.000Z',
      attentionMode: 'operative',
      ring: 'outer',
      description: 'Ops skim',
    },
    {
      startAt: '2026-07-05T11:10:00.000Z',
      endAt: '2026-07-05T12:00:00.000Z',
      attentionMode: 'converge',
      ring: 'core',
      description: 'Second core',
    },
  ];
}
