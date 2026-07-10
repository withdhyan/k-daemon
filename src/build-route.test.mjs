import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  BUILD_EVENTS_PATH,
  BUILD_FOUNDER_ACTION_PATH,
  BUILD_DOC_READER_PATH,
  BUILD_DIFF_PATH,
  BUILD_EVIDENCE_PATH,
  BUILD_LEARNED_DECISION_PATH,
  BUILD_LEARNED_PATH,
  BUILD_TRUST_PAIR_PATH,
  BUILD_TRUST_PATH,
  BUILD_HISTORY_PATH,
  BUILD_LANE_PATH,
  BUILD_LANE_LOG_TAIL_PATH,
  BUILD_PACKET_EVENT,
  BUILD_SNAPSHOT_EVENT,
  BUILD_CARDS_PATH,
  BUILD_CARD_ANSWER_PATH,
  BUILD_REQUEST_PATH,
  BUILD_STATE_PATH,
  BUILD_TRANSITION_PATH,
  createBuildEventEmitter,
  handleBuildRoute,
  isBuildPath,
  recordBuildCardEvent,
} from '../daemon/routes/build.mjs';
import {
  BUILD_STATE_BUILDING,
  BUILD_STATE_HELD,
  BUILD_STATE_KILLED,
  BUILD_STATE_QUEUED,
  createBuildStateStore,
} from './agent/build-state.mjs';
import {
  BUILD_CARD_KIND_DRIFT,
  BUILD_CARD_KIND_SAFETY_FLOOR,
  BUILD_CARD_KIND_SHAPING,
  BUILD_CARD_TIER_LOOPBACK,
  BUILD_CARD_TIER_TAILNET,
  createBuildCardStore,
} from './agent/build-cards.mjs';
import { createSubstrateStore } from './substrate.mjs';
import {
  buildViewPacket,
  validateViewPacket,
} from './agent/view-packet.mjs';

test('build path matcher covers state, history, mutation, lane, and event routes', () => {
  assert.equal(isBuildPath(BUILD_STATE_PATH), true);
  assert.equal(isBuildPath(BUILD_HISTORY_PATH), true);
  assert.equal(isBuildPath(BUILD_TRANSITION_PATH), true);
  assert.equal(isBuildPath(BUILD_LANE_PATH), true);
  assert.equal(isBuildPath(BUILD_LANE_LOG_TAIL_PATH), true);
  assert.equal(isBuildPath(BUILD_CARDS_PATH), true);
  assert.equal(isBuildPath(BUILD_CARD_ANSWER_PATH), true);
  assert.equal(isBuildPath(BUILD_REQUEST_PATH), true);
  assert.equal(isBuildPath(BUILD_FOUNDER_ACTION_PATH), true);
  assert.equal(isBuildPath(BUILD_EVENTS_PATH), true);
  assert.equal(isBuildPath(BUILD_DOC_READER_PATH), true);
  assert.equal(isBuildPath(BUILD_DIFF_PATH), true);
  assert.equal(isBuildPath(BUILD_EVIDENCE_PATH), true);
  assert.equal(isBuildPath(BUILD_LEARNED_PATH), true);
  assert.equal(isBuildPath(BUILD_LEARNED_DECISION_PATH), true);
  assert.equal(isBuildPath(BUILD_TRUST_PATH), true);
  assert.equal(isBuildPath(BUILD_TRUST_PAIR_PATH), true);
  assert.equal(isBuildPath('/api/build/unknown'), false);
});

test('GET /api/build/state and /history return bounded shapes', async () => {
  const dataDir = await tempDataDir();
  const store = createBuildStateStore({ dataDir, now: fixedNow });
  const events = createBuildEventEmitter();
  await store.savePlan(plan({ id: 'plan-a', title: 'Plan A' }));
  await store.savePlan(plan({ id: 'plan-b', title: 'Plan B' }));
  await store.saveLane(lane({ id: 'lane-a', unitId: 'u1' }));
  await store.saveLane(lane({ id: 'lane-b', unitId: 'u1' }));
  await recordBuildCardEvent(store, {
    kind: 'build.card.raised',
    cardId: 'card-a',
    planId: 'plan-a',
    title: 'Approve plan',
    status: 'raised',
  }, events);
  await store.appendHistory({ kind: 'build.test', seq: 1, at: '2026-07-04T00:00:01.000Z' });
  await store.appendHistory({ kind: 'build.test', seq: 2, at: '2026-07-04T00:00:02.000Z' });
  await store.appendHistory({ kind: 'build.test', seq: 3, at: '2026-07-04T00:00:03.000Z' });

  const state = await dispatchRoute({
    store,
    events,
    dataDir,
    method: 'GET',
    url: `${BUILD_STATE_PATH}?plans=1&lanes=1&cards=1&packets=1&units=1`,
  });

  assert.equal(state.status, 200);
  assert.equal(state.json.ok, true);
  assert.equal(state.json.source, 'cs-k');
  assert.equal(state.json.plans.length, 1);
  assert.equal(state.json.plans[0].units.length, 1);
  assert.equal(state.json.units.length, 1);
  assert.equal(state.json.lanes.length, 1);
  assert.equal(state.json.cards.length, 1);
  assert.equal(state.json.packets.length, 1);
  assert.equal(state.json.counts.plans, 2);
  assert.equal(state.json.counts.lanes, 2);

  const history = await dispatchRoute({
    store,
    events,
    dataDir,
    method: 'GET',
    url: `${BUILD_HISTORY_PATH}?limit=2`,
  });

  assert.equal(history.status, 200);
  assert.equal(history.json.newestFirst, true);
  assert.equal(history.json.limit, 2);
  assert.deepEqual(history.json.history.map((entry) => entry.seq), [3, 2]);
});

test('GET /api/build/cards returns bounded open and queued durable card records', async () => {
  const dataDir = await tempDataDir();
  const store = createBuildStateStore({ dataDir, now: fixedNow });
  const cardStore = createBuildCardStore({
    dataDir,
    now: fixedNow,
    randomSuffix: suffixer(),
  });
  const events = createBuildEventEmitter();
  const open = await cardStore.raiseCard(cardInput({
    kind: BUILD_CARD_KIND_DRIFT,
    tier: BUILD_CARD_TIER_TAILNET,
    planId: 'plan-cards',
  }));
  await cardStore.raiseCard(cardInput({
    kind: 'plan-approval',
    tier: BUILD_CARD_TIER_LOOPBACK,
    planId: 'plan-approval-a',
  }));
  const queued = await cardStore.raiseCard(cardInput({
    kind: 'plan-approval',
    tier: BUILD_CARD_TIER_LOOPBACK,
    planId: 'plan-approval-b',
  }));

  const response = await dispatchRoute({
    store,
    cardStore,
    events,
    dataDir,
    method: 'GET',
    url: `${BUILD_CARDS_PATH}?limit=10`,
  });

  assert.equal(response.status, 200);
  assert.equal(response.json.ok, true);
  assert.equal(response.json.cards.length, 3);
  assert(response.json.cards.some((card) => card.id === open.card.id && card.status === 'notified'));
  assert(response.json.cards.some((card) => card.id === queued.card.id && card.status === 'queued'));
  assert.equal(response.json.cards[0].options[0].id, 'continue');
  assert.equal(response.json.cards[0].options[0].label, 'continue the lane');
  assert.equal(
    response.json.cards[0].body,
    'scope moved outside the lane — continue the lane. integration risk.',
  );
});

test('POST /api/build/transition gates remote callers and updates state with SSE packet on loopback', async () => {
  const dataDir = await tempDataDir();
  const store = createBuildStateStore({ dataDir, now: fixedNow });
  const events = createBuildEventEmitter();
  await store.savePlan(plan({ id: 'plan-loopback', lease: lease('orchestrator') }));

  const remote = await dispatchRoute({
    store,
    events,
    dataDir,
    method: 'POST',
    url: BUILD_TRANSITION_PATH,
    sameMachine: false,
    payload: {
      planId: 'plan-loopback',
      unitId: 'u1',
      to: BUILD_STATE_BUILDING,
      actor: 'orchestrator',
    },
  });
  assert.equal(remote.status, 403);
  assert.deepEqual(remote.json, { ok: false, error: 'loopback_required' });
  assert.equal((await store.loadPlan('plan-loopback')).units[0].state, BUILD_STATE_QUEUED);

  const stream = await dispatchRoute({
    store,
    events,
    dataDir,
    method: 'GET',
    url: BUILD_EVENTS_PATH,
  });
  assert.equal(stream.status, 200);
  assert.equal(stream.headers['content-type'], 'text/event-stream; charset=utf-8');
  assert.equal(stream.events()[0].event, BUILD_SNAPSHOT_EVENT);

  const loopback = await dispatchRoute({
    store,
    events,
    dataDir,
    method: 'POST',
    url: BUILD_TRANSITION_PATH,
    payload: {
      planId: 'plan-loopback',
      unitId: 'u1',
      to: BUILD_STATE_BUILDING,
      actor: 'orchestrator',
      reason: 'start lane',
    },
  });

  const updated = await store.loadPlan('plan-loopback');
  const liveEvents = stream.events();
  const packet = liveEvents.find((event) => event.event === BUILD_PACKET_EVENT)?.data;
  const history = await dispatchRoute({
    store,
    events,
    dataDir,
    method: 'GET',
    url: `${BUILD_HISTORY_PATH}?limit=1`,
  });

  assert.equal(loopback.status, 200);
  assert.equal(loopback.json.ok, true);
  assert.equal(updated.units[0].state, BUILD_STATE_BUILDING);
  assert.equal(validateViewPacket(packet), packet);
  assert.equal(packet.viewType, 'build.status');
  assert.equal(packet.fields.seq, 1);
  assert.equal(packet.fields.from, BUILD_STATE_QUEUED);
  assert.equal(packet.fields.status, BUILD_STATE_BUILDING);
  assert.equal(packet.fields.reason, 'start lane');
  assert.equal(history.json.history[0].kind, 'build.transition');
  assert.equal(history.json.history[0].to, BUILD_STATE_BUILDING);
  stream.destroy();
});

test('POST /api/build/cards/answer enforces card tier and answers idempotently without a second packet', async () => {
  const dataDir = await tempDataDir();
  const store = createBuildStateStore({ dataDir, now: fixedNow });
  const cardStore = createBuildCardStore({
    dataDir,
    now: fixedNow,
    randomSuffix: suffixer(),
  });
  const events = createBuildEventEmitter();
  const raised = await cardStore.raiseCard(cardInput({
    kind: BUILD_CARD_KIND_SAFETY_FLOOR,
    tier: BUILD_CARD_TIER_LOOPBACK,
    planId: 'plan-answer',
  }));

  const remote = await dispatchRoute({
    store,
    cardStore,
    events,
    dataDir,
    method: 'POST',
    url: BUILD_CARD_ANSWER_PATH,
    sameMachine: false,
    payload: {
      cardId: raised.card.id,
      optionId: 'kill',
      surface: 'ipad',
    },
  });
  assert.equal(remote.status, 403);
  assert.deepEqual(remote.json, { ok: false, error: 'loopback_required' });
  assert.equal((await cardStore.loadCard(raised.card.id)).answeredBy, null);
  assert.equal(events.currentSeq(), 0);

  const loopback = await dispatchRoute({
    store,
    cardStore,
    events,
    dataDir,
    method: 'POST',
    url: BUILD_CARD_ANSWER_PATH,
    payload: {
      cardId: raised.card.id,
      optionId: 'kill',
      surface: 'mac',
    },
  });
  assert.equal(loopback.status, 200);
  assert.equal(loopback.json.ok, true);
  assert.equal(loopback.json.card.status, 'answered');
  assert.equal(loopback.json.card.answeredBy, 'loopback');
  assert.equal(loopback.json.packet.viewType, 'build.card');
  assert.equal(loopback.json.packet.fields.seq, 1);
  assert.equal(validateViewPacket(loopback.json.packet), loopback.json.packet);

  const retry = await dispatchRoute({
    store,
    cardStore,
    events,
    dataDir,
    method: 'POST',
    url: BUILD_CARD_ANSWER_PATH,
    sameMachine: false,
    payload: {
      cardId: raised.card.id,
      optionId: 'kill',
      surface: 'ipad',
    },
  });
  assert.equal(retry.status, 200);
  assert.equal(retry.json.ok, true);
  assert.deepEqual(retry.json.alreadyAnswered, {
    by: 'loopback',
    at: '2026-07-04T00:00:00.000Z',
    optionId: 'kill',
  });
  assert.equal(retry.json.packet, undefined);
  assert.deepEqual(retry.json.packets, []);
  assert.equal(events.currentSeq(), 1);
});

test('POST /api/build/transition rejects malformed bodies without changing state', async () => {
  const dataDir = await tempDataDir();
  const store = createBuildStateStore({ dataDir, now: fixedNow });
  const events = createBuildEventEmitter();
  await store.savePlan(plan({ id: 'plan-malformed', lease: lease('orchestrator') }));

  const response = await dispatchRoute({
    store,
    events,
    dataDir,
    method: 'POST',
    url: BUILD_TRANSITION_PATH,
    payload: {
      planId: 'plan-malformed',
      unitId: 'u1',
      to: BUILD_STATE_BUILDING,
    },
  });

  assert.equal(response.status, 400);
  assert.deepEqual(response.json, { ok: false, error: 'missing_actor' });
  assert.equal((await store.loadPlan('plan-malformed')).units[0].state, BUILD_STATE_QUEUED);
  assert.equal(events.currentSeq(), 0);
});

test('POST /api/build/transition maps OwnershipError to 409', async () => {
  const dataDir = await tempDataDir();
  const store = createBuildStateStore({ dataDir, now: fixedNow });
  const events = createBuildEventEmitter();
  await store.savePlan(plan({ id: 'plan-owned', lease: lease('runner') }));

  const response = await dispatchRoute({
    store,
    events,
    dataDir,
    method: 'POST',
    url: BUILD_TRANSITION_PATH,
    payload: {
      planId: 'plan-owned',
      unitId: 'u1',
      to: BUILD_STATE_BUILDING,
      actor: 'orchestrator',
    },
  });

  assert.equal(response.status, 409);
  assert.deepEqual(response.json, { ok: false, error: 'lease_not_owner' });
  assert.equal((await store.loadPlan('plan-owned')).units[0].state, BUILD_STATE_QUEUED);
});

test('POST /api/build/lane saves lane records through a lease-enforced transition', async () => {
  const dataDir = await tempDataDir();
  const store = createBuildStateStore({ dataDir, now: fixedNow });
  const events = createBuildEventEmitter();
  await store.savePlan(plan({ id: 'plan-lane', lease: lease('orchestrator') }));

  const response = await dispatchRoute({
    store,
    events,
    dataDir,
    method: 'POST',
    url: BUILD_LANE_PATH,
    payload: {
      planId: 'plan-lane',
      actor: 'orchestrator',
      id: 'lane-route',
      unitId: 'u1',
      state: BUILD_STATE_BUILDING,
      pid: 123,
      startTime: 'start-lane-route',
      logPath: 'logs/lane-route.log',
      worktreePath: '/tmp/lane-route',
    },
  });

  const planRecord = await store.loadPlan('plan-lane');
  const laneRecord = await store.loadLane('lane-route');

  assert.equal(response.status, 200);
  assert.equal(response.json.ok, true);
  assert.equal(planRecord.units[0].state, BUILD_STATE_BUILDING);
  assert.equal(planRecord.units[0].laneId, 'lane-route');
  assert.equal(laneRecord.state, BUILD_STATE_BUILDING);
  assert.equal(response.json.packet.viewType, 'build.status');
  assert.equal(response.json.packet.fields.seq, 1);
  assert.equal(response.json.packet.fields.laneId, 'lane-route');
  assert.equal(response.json.packet.fields.from, BUILD_STATE_QUEUED);
  assert.equal(validateViewPacket(response.json.packet), response.json.packet);
});

test('POST /api/build/request raises a shaping card for underspecified founder intent', async () => {
  const dataDir = await tempDataDir();
  const store = createBuildStateStore({ dataDir, now: fixedNow });
  const cardStore = createBuildCardStore({
    dataDir,
    now: fixedNow,
    stateStore: store,
    randomSuffix: suffixer(),
  });
  const events = createBuildEventEmitter();

  const response = await dispatchRoute({
    store,
    cardStore,
    events,
    dataDir,
    method: 'POST',
    url: BUILD_REQUEST_PATH,
    sameMachine: false,
    payload: {
      intent: 'dashboard',
      surface: 'ipad',
    },
  });

  assert.equal(response.status, 200);
  assert.equal(response.json.ok, true);
  assert.equal(response.json.status, 'shaping_required');
  assert.equal(response.json.card.kind, BUILD_CARD_KIND_SHAPING);
  assert.equal(response.json.card.tier, BUILD_CARD_TIER_TAILNET);
  assert.equal(response.json.card.shaping.question.includes('What should this build change'), true);
  assert.equal(response.json.card.options[0].id, 'accept-recommendation');
  assert.equal(response.json.packet.viewType, 'build.card');
  assert.equal(events.currentSeq(), 1);
});

test('POST /api/build/request stages a scoped draft and emits its approval card', async () => {
  const dataDir = await tempDataDir();
  const store = createBuildStateStore({ dataDir, now: fixedNow });
  const cardStore = createBuildCardStore({
    dataDir,
    now: fixedNow,
    stateStore: store,
    randomSuffix: suffixer(),
  });
  const events = createBuildEventEmitter();

  const response = await dispatchRoute({
    store,
    cardStore,
    events,
    dataDir,
    method: 'POST',
    url: BUILD_REQUEST_PATH,
    sameMachine: false,
    buildDraftDeps: precheckDeps(),
    payload: {
      intent: 'add a weekly TWS summary card to chat',
      surface: 'ipad',
    },
  });

  const loaded = await store.loadPlan(response.json.plan.id);

  assert.equal(response.status, 200);
  assert.equal(response.json.ok, true);
  assert.equal(response.json.status, 'draft_staged');
  assert.equal(response.json.plan.status, BUILD_STATE_QUEUED);
  assert.equal(response.json.plan.units.length >= 1, true);
  assert.equal(response.json.card.kind, 'plan-approval');
  assert.equal(response.json.card.tier, BUILD_CARD_TIER_TAILNET);
  assert.equal(response.json.packets.some((packet) => packet.viewType === 'build.card'), true);
  assert.equal(loaded.id, response.json.plan.id);
});

test('POST /api/build/founder-action allows tailnet pause and confirmed kill transitions', async () => {
  const dataDir = await tempDataDir();
  const store = createBuildStateStore({ dataDir, now: fixedNow });
  const events = createBuildEventEmitter();
  await store.savePlan(plan({
    id: 'plan-founder-action',
    lease: lease('runner'),
    units: [unit({ id: 'u-pause', state: BUILD_STATE_BUILDING })],
  }));

  const pause = await dispatchRoute({
    store,
    events,
    dataDir,
    method: 'POST',
    url: BUILD_FOUNDER_ACTION_PATH,
    sameMachine: false,
    payload: {
      planId: 'plan-founder-action',
      unitId: 'u-pause',
      action: 'pause',
      surface: 'ipad',
    },
  });

  assert.equal(pause.status, 200);
  assert.equal(pause.json.ok, true);
  assert.equal(pause.json.unit.state, BUILD_STATE_HELD);
  assert.equal(pause.json.packet.fields.actor, 'founder');
  assert.equal((await store.loadPlan('plan-founder-action')).units[0].state, BUILD_STATE_HELD);

  const missingConfirm = await dispatchRoute({
    store,
    events,
    dataDir,
    method: 'POST',
    url: BUILD_FOUNDER_ACTION_PATH,
    sameMachine: false,
    payload: {
      planId: 'plan-founder-action',
      unitId: 'u-pause',
      action: 'kill',
      surface: 'ipad',
    },
  });
  assert.equal(missingConfirm.status, 400);
  assert.deepEqual(missingConfirm.json, { ok: false, error: 'kill_confirmation_required' });

  const kill = await dispatchRoute({
    store,
    events,
    dataDir,
    method: 'POST',
    url: BUILD_FOUNDER_ACTION_PATH,
    sameMachine: false,
    payload: {
      planId: 'plan-founder-action',
      unitId: 'u-pause',
      action: 'kill',
      confirm: true,
      surface: 'ipad',
    },
  });

  assert.equal(kill.status, 200);
  assert.equal(kill.json.ok, true);
  assert.equal(kill.json.unit.state, BUILD_STATE_KILLED);
  assert.equal((await store.loadPlan('plan-founder-action')).units[0].state, BUILD_STATE_KILLED);
});

test('POST /api/build/founder-action supports bounded retry via orphaned recovery state', async () => {
  const dataDir = await tempDataDir();
  const store = createBuildStateStore({ dataDir, now: fixedNow });
  const events = createBuildEventEmitter();
  await store.savePlan(plan({
    id: 'plan-founder-retry',
    lease: lease('runner'),
    units: [unit({ id: 'u-retry', state: BUILD_STATE_HELD })],
  }));

  const response = await dispatchRoute({
    store,
    events,
    dataDir,
    method: 'POST',
    url: BUILD_FOUNDER_ACTION_PATH,
    sameMachine: false,
    payload: {
      planId: 'plan-founder-retry',
      unitId: 'u-retry',
      action: 'retry',
      surface: 'ipad',
    },
  });

  assert.equal(response.status, 200);
  assert.equal(response.json.ok, true);
  assert.equal(response.json.unit.state, 'orphaned');
  assert.equal((await store.loadPlan('plan-founder-retry')).units[0].state, 'orphaned');
});

test('GET /api/build/lane/log-tail returns a bounded tail from daemon-owned lane logs only', async () => {
  const dataDir = await tempDataDir();
  const store = createBuildStateStore({ dataDir, now: fixedNow });
  const events = createBuildEventEmitter();
  const logDir = path.join(dataDir, 'build', 'lane-logs');
  await fs.mkdir(logDir, { recursive: true });
  const logPath = path.join(logDir, 'lane-tail.log');
  await fs.writeFile(logPath, 'line 1\nline 2\nline 3\n', 'utf8');
  await store.saveLane(lane({ id: 'lane-tail', logPath }));

  const response = await dispatchRoute({
    store,
    events,
    dataDir,
    method: 'GET',
    url: `${BUILD_LANE_LOG_TAIL_PATH}?laneId=lane-tail&bytes=7`,
  });

  assert.equal(response.status, 200);
  assert.equal(response.json.ok, true);
  assert.equal(response.json.laneId, 'lane-tail');
  assert.equal(response.json.tail, 'line 3\n');
  assert.equal(response.json.truncated, true);
  assert.equal(response.json.logSize, 21);

  await store.saveLane(lane({ id: 'lane-outside', logPath: '/etc/passwd' }));
  const outside = await dispatchRoute({
    store,
    events,
    dataDir,
    method: 'GET',
    url: `${BUILD_LANE_LOG_TAIL_PATH}?laneId=lane-outside`,
  });
  assert.equal(outside.status, 400);
  assert.deepEqual(outside.json, { ok: false, error: 'invalid_log_path' });
});

test('GET /api/build/events emits snapshot first and carries disconnected card changes into next snapshot', async () => {
  const dataDir = await tempDataDir();
  const store = createBuildStateStore({ dataDir, now: fixedNow });
  const events = createBuildEventEmitter();
  await store.savePlan(plan({ id: 'plan-sse', lease: lease('orchestrator') }));

  const cardResult = await recordBuildCardEvent(store, {
    kind: 'build.card.raised',
    cardId: 'card-offline',
    planId: 'plan-sse',
    title: 'Offline card',
    text: 'Raised while no client was connected.',
    severity: 'high',
    status: 'raised',
    at: '2026-07-04T00:00:01.000Z',
  }, events);
  assert.equal(validateViewPacket(cardResult.packet), cardResult.packet);
  assert.equal(cardResult.packet.viewType, 'build.card');
  assert.equal(cardResult.packet.fields.seq, 1);

  const stream = await dispatchRoute({
    store,
    events,
    dataDir,
    method: 'GET',
    url: BUILD_EVENTS_PATH,
  });
  const firstEvent = stream.events()[0];
  assert.equal(firstEvent.event, BUILD_SNAPSHOT_EVENT);
  assert.equal(firstEvent.data.cards[0].id, 'card-offline');
  assert.equal(firstEvent.data.packets[0].viewType, 'build.card');
  assert.equal(validateViewPacket(firstEvent.data.packets[0]), firstEvent.data.packets[0]);

  const transition = await dispatchRoute({
    store,
    events,
    dataDir,
    method: 'POST',
    url: BUILD_TRANSITION_PATH,
    payload: {
      planId: 'plan-sse',
      unitId: 'u1',
      to: BUILD_STATE_BUILDING,
      actor: 'orchestrator',
    },
  });
  assert.equal(transition.status, 200);

  const packets = [
    ...firstEvent.data.packets,
    ...stream.events().filter((event) => event.event === BUILD_PACKET_EVENT).map((event) => event.data),
  ];
  assert.deepEqual(packets.map((packet) => packet.fields.seq), [1, 2]);
  assert(packets.every((packet) => validateViewPacket(packet) === packet));
  stream.destroy();
});

test('GET /api/build/events snapshot includes durable open cards from build-cards store', async () => {
  const dataDir = await tempDataDir();
  const store = createBuildStateStore({ dataDir, now: fixedNow });
  const cardStore = createBuildCardStore({
    dataDir,
    now: fixedNow,
    randomSuffix: suffixer(),
  });
  const events = createBuildEventEmitter();
  const raised = await cardStore.raiseCard(cardInput({
    kind: BUILD_CARD_KIND_DRIFT,
    tier: BUILD_CARD_TIER_TAILNET,
    planId: 'plan-snapshot',
  }));

  const stream = await dispatchRoute({
    store,
    cardStore,
    events,
    dataDir,
    method: 'GET',
    url: BUILD_EVENTS_PATH,
  });
  const firstEvent = stream.events()[0];
  assert.equal(firstEvent.event, BUILD_SNAPSHOT_EVENT);
  assert.equal(firstEvent.data.cards[0].id, raised.card.id);
  assert.equal(firstEvent.data.cards[0].tier, BUILD_CARD_TIER_TAILNET);
  assert.equal(firstEvent.data.cards[0].options[0].id, 'continue');
  stream.destroy();
});

test('build.status and build.card ViewPackets validate', () => {
  const status = buildViewPacket({
    viewType: 'build.status',
    text: 'Build status',
    fields: { seq: 1, status: 'building' },
    provenance: { surface: 'build' },
    frontierExcluded: true,
  });
  const card = buildViewPacket({
    viewType: 'build.card',
    text: 'Build card',
    fields: { seq: 2, cardId: 'card-1', status: 'raised' },
    provenance: { surface: 'build' },
    frontierExcluded: true,
  });

  assert.equal(validateViewPacket(status), status);
  assert.equal(validateViewPacket(card), card);
});

test('GET /api/build/artifacts/doc returns a bounded reader payload for repo docs', async () => {
  const dataDir = await tempDataDir();
  const repoRoot = await tempRepoRoot();
  await fs.mkdir(path.join(repoRoot, 'docs', 'plans'), { recursive: true });
  await fs.writeFile(
    path.join(repoRoot, 'docs', 'plans', 'reader-plan.md'),
    '# Reader Plan\n\nShip the in-app artifact reader.\n',
    'utf8',
  );

  const response = await dispatchRoute({
    dataDir,
    repoRoot,
    method: 'GET',
    url: `${BUILD_DOC_READER_PATH}?path=docs/plans/reader-plan.md`,
  });

  assert.equal(response.status, 200);
  assert.equal(response.json.ok, true);
  assert.equal(response.json.artifact.kind, 'DocumentArtifact');
  assert.equal(response.json.artifact.viewType, 'preview.file');
  assert.equal(response.json.artifact.path, 'docs/plans/reader-plan.md');
  assert.equal(response.json.artifact.language, 'markdown');
  assert.deepEqual(response.json.artifact.lines.slice(0, 2), [
    { number: 1, text: '# Reader Plan' },
    { number: 2, text: '' },
  ]);

  const traversal = await dispatchRoute({
    dataDir,
    repoRoot,
    method: 'GET',
    url: `${BUILD_DOC_READER_PATH}?path=../secret.md`,
  });
  assert.equal(traversal.status, 400);
  assert.deepEqual(traversal.json, { ok: false, error: 'invalid_artifact_path' });
});

test('POST and GET /api/build/artifacts/diff stores and projects per-file unified diffs', async () => {
  const dataDir = await tempDataDir();
  const diff = [
    'diff --git a/src/example.mjs b/src/example.mjs',
    '--- a/src/example.mjs',
    '+++ b/src/example.mjs',
    '@@ -1,2 +1,3 @@',
    ' import assert from "node:assert/strict";',
    '-const oldName = "old";',
    '+const newName = "new";',
    '+export const ready = true;',
    ' assert.equal(newName, "new");',
    '',
  ].join('\n');

  const remote = await dispatchRoute({
    dataDir,
    method: 'POST',
    url: BUILD_DIFF_PATH,
    sameMachine: false,
    payload: { planId: 'plan-diff', unitId: 'u1', laneId: 'lane-diff', diff },
  });
  assert.equal(remote.status, 403);

  const posted = await dispatchRoute({
    dataDir,
    method: 'POST',
    url: BUILD_DIFF_PATH,
    payload: { planId: 'plan-diff', unitId: 'u1', laneId: 'lane-diff', diff },
  });

  assert.equal(posted.status, 200);
  assert.equal(posted.json.ok, true);
  assert.equal(posted.json.artifact.kind, 'BuildDiffArtifact');
  assert.equal(posted.json.artifact.files[0].path, 'src/example.mjs');
  assert.equal(posted.json.artifact.files[0].language, 'javascript');
  assert.equal(posted.json.artifact.files[0].additions, 2);
  assert.equal(posted.json.artifact.files[0].deletions, 1);
  assert.deepEqual(
    posted.json.artifact.files[0].hunks[0].lines.map((line) => [line.kind, line.newLine, line.oldLine]),
    [
      ['context', 1, 1],
      ['delete', null, 2],
      ['add', 2, null],
      ['add', 3, null],
      ['context', 4, 3],
    ],
  );

  const fetched = await dispatchRoute({
    dataDir,
    method: 'GET',
    url: `${BUILD_DIFF_PATH}?id=${posted.json.artifact.id}`,
  });
  assert.equal(fetched.status, 200);
  assert.equal(fetched.json.artifact.id, posted.json.artifact.id);
  assert.equal(fetched.json.artifact.files[0].path, 'src/example.mjs');
});

test('POST /api/build/evidence attaches verification evidence and lists it by unit', async () => {
  const dataDir = await tempDataDir();

  const posted = await dispatchRoute({
    dataDir,
    method: 'POST',
    url: BUILD_EVIDENCE_PATH,
    payload: {
      planId: 'plan-proof',
      unitId: 'u1',
      laneId: 'lane-proof',
      kind: 'transcript',
      label: 'curl proof',
      text: '$ curl /api/build/state\n{"ok":true}',
      acceptanceExample: 'AE4',
    },
  });

  assert.equal(posted.status, 200);
  assert.equal(posted.json.ok, true);
  assert.equal(posted.json.evidence.kind, 'transcript');
  assert.equal(posted.json.evidence.acceptanceExample, 'AE4');

  const listed = await dispatchRoute({
    dataDir,
    method: 'GET',
    url: `${BUILD_EVIDENCE_PATH}?unitId=u1`,
  });

  assert.equal(listed.status, 200);
  assert.equal(listed.json.count, 1);
  assert.equal(listed.json.evidence[0].id, posted.json.evidence.id);
  assert.equal(listed.json.evidence[0].text, '$ curl /api/build/state\n{"ok":true}');
});

test('learned-entry store stages entries and persists only approved consent states to substrate', async () => {
  const dataDir = await tempDataDir();
  const substrateStore = createSubstrateStore({ dataDir, now: fixedNow });

  const first = await stageLearnedEntry(dataDir, substrateStore, {
    label: 'Canonical helpers',
    text: 'Import canonical helpers instead of re-copying local versions.',
  });
  const second = await stageLearnedEntry(dataDir, substrateStore, {
    label: 'Artifact proof',
    text: 'Attach verification proof before claiming a unit landed.',
  });
  const third = await stageLearnedEntry(dataDir, substrateStore, {
    label: 'Discarded noise',
    text: 'This entry should not become durable memory.',
  });

  const approve = await dispatchRoute({
    dataDir,
    substrateStore,
    method: 'POST',
    url: BUILD_LEARNED_DECISION_PATH,
    sameMachine: false,
    payload: { id: first.json.entry.id, decision: 'approve' },
  });
  const edit = await dispatchRoute({
    dataDir,
    substrateStore,
    method: 'POST',
    url: BUILD_LEARNED_DECISION_PATH,
    sameMachine: false,
    payload: {
      id: second.json.entry.id,
      decision: 'edit',
      text: 'Attach concrete verification proof before a unit can be called landed.',
    },
  });
  const discard = await dispatchRoute({
    dataDir,
    substrateStore,
    method: 'POST',
    url: BUILD_LEARNED_DECISION_PATH,
    sameMachine: false,
    payload: { id: third.json.entry.id, decision: 'discard' },
  });

  assert.equal(approve.status, 200);
  assert.equal(edit.status, 200);
  assert.equal(discard.status, 200);
  assert.equal(discard.json.entry.consent.state, 'discarded');

  const substrate = await substrateStore.listRecords('LearningRecord');
  assert.equal(substrate.length, 2);
  assert.deepEqual(substrate.map((record) => record.text).sort(), [
    'Attach concrete verification proof before a unit can be called landed.',
    'Import canonical helpers instead of re-copying local versions.',
  ]);
  assert(substrate.every((record) => record.consent.state === 'approved'));

  const pending = await dispatchRoute({
    dataDir,
    substrateStore,
    method: 'GET',
    url: `${BUILD_LEARNED_PATH}?status=pending`,
  });
  assert.equal(pending.status, 200);
  assert.equal(pending.json.count, 0);
});

test('trust pairing records alignment verdicts against founder card decisions', async () => {
  const dataDir = await tempDataDir();
  const store = createBuildStateStore({ dataDir, now: fixedNow });
  const cardStore = createBuildCardStore({
    dataDir,
    now: fixedNow,
    randomSuffix: suffixer(),
  });

  for (let index = 0; index < 5; index += 1) {
    const raised = await cardStore.raiseCard(cardInput({
      kind: BUILD_CARD_KIND_DRIFT,
      tier: BUILD_CARD_TIER_TAILNET,
      planId: 'plan-trust',
      title: `Trust card ${index}`,
    }));
    await cardStore.answerCard({
      cardId: raised.card.id,
      optionId: index === 2 ? 'kill' : 'continue',
      surface: 'ipad',
    });
    const pair = await dispatchRoute({
      store,
      cardStore,
      dataDir,
      method: 'POST',
      url: BUILD_TRUST_PAIR_PATH,
      payload: {
        cardId: raised.card.id,
        verdict: {
          verdict: index === 2 ? 'pass' : 'pass',
          recommendedOptionId: 'continue',
          reasoning: index === 2
            ? 'The checker recommended continuing, but the founder killed the work.'
            : 'The checker and founder both continued.',
          confidence: 0.8,
        },
      },
    });
    assert.equal(pair.status, 200);
  }

  const trust = await dispatchRoute({
    store,
    cardStore,
    dataDir,
    method: 'GET',
    url: BUILD_TRUST_PATH,
  });

  assert.equal(trust.status, 200);
  assert.equal(trust.json.summary.total, 5);
  assert.equal(trust.json.summary.agreements, 4);
  assert.equal(trust.json.summary.disagreements, 1);
  assert.equal(trust.json.summary.agreementRate, 0.8);
  const disagreement = trust.json.pairs.find((pair) => pair.agreement === false);
  assert.match(disagreement.verdict.reasoning, /founder killed/);
  assert.equal(disagreement.decision.optionId, 'kill');
});

async function dispatchRoute(input) {
  const url = new URL(input.url, 'http://localhost');
  const response = new MockResponse();
  const deps = routeDeps(input.sameMachine !== false);
  try {
    await handleBuildRoute(
      mockRequest(input.payload, {
        method: input.method,
        url: input.url,
      }),
      response,
      {
        method: input.method,
        pathname: url.pathname,
        searchParams: url.searchParams,
        dataDir: input.dataDir,
        repoRoot: input.repoRoot,
        now: fixedNow,
        buildStateStore: input.store,
        buildCardStore: input.cardStore,
        substrateStore: input.substrateStore,
        buildEvents: input.events,
        buildDraftDeps: input.buildDraftDeps,
        keepAliveIntervalMs: 0,
      },
      deps,
    );
  } catch (error) {
    deps.sendJson(response, error.statusCode ?? 500, {
      ok: false,
      error: error.expose ? error.code : 'server_error',
    });
  }
  if (response.headers['content-type'] !== 'text/event-stream; charset=utf-8') {
    response.json = response.body ? JSON.parse(response.body) : undefined;
  }
  return response;
}

function routeDeps(sameMachine) {
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
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        const error = new Error('empty_json_body');
        error.statusCode = 400;
        error.code = 'empty_json_body';
        error.expose = true;
        throw error;
      }
      try {
        return JSON.parse(raw);
      } catch {
        const error = new Error('invalid_json');
        error.statusCode = 400;
        error.code = 'invalid_json';
        error.expose = true;
        throw error;
      }
    },
    isSameMachine: () => sameMachine,
  };
}

function mockRequest(payload, options = {}) {
  const request = payload === undefined
    ? Readable.from([])
    : Readable.from([Buffer.from(JSON.stringify(payload), 'utf8')]);
  request.method = options.method;
  request.url = options.url;
  return request;
}

class MockResponse extends EventEmitter {
  constructor() {
    super();
    this.status = null;
    this.statusCode = null;
    this.headers = {};
    this.body = '';
    this.writableEnded = false;
    this.destroyed = false;
  }

  writeHead(statusCode, headers = {}) {
    this.status = statusCode;
    this.statusCode = statusCode;
    this.headers = headers;
  }

  write(chunk) {
    this.body += String(chunk);
    return true;
  }

  end(chunk) {
    if (chunk) this.body += String(chunk);
    this.writableEnded = true;
  }

  destroy() {
    this.destroyed = true;
    this.emit('close');
  }

  events() {
    return this.body
      .split('\n\n')
      .filter(Boolean)
      .filter((block) => !block.startsWith(': '))
      .map((block) => {
        const lines = block.split('\n');
        const event = lines.find((line) => line.startsWith('event: '))?.slice(7);
        const data = lines.find((line) => line.startsWith('data: '))?.slice(6);
        return { event, data: data ? JSON.parse(data) : null };
      });
  }
}

async function tempDataDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-build-route-'));
}

async function tempRepoRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-build-repo-'));
}

async function stageLearnedEntry(dataDir, substrateStore, overrides = {}) {
  return dispatchRoute({
    dataDir,
    substrateStore,
    method: 'POST',
    url: BUILD_LEARNED_PATH,
    payload: {
      planId: 'plan-learn',
      unitId: 'u1',
      category: 'pattern',
      label: 'Learned entry',
      text: 'A useful thing K should remember.',
      evidenceIds: ['history:1'],
      ...overrides,
    },
  });
}

function fixedNow() {
  return new Date('2026-07-04T00:00:00.000Z');
}

function plan(overrides = {}) {
  return {
    id: 'plan-1',
    title: 'Plan 1',
    status: BUILD_STATE_QUEUED,
    units: [unit()],
    lease: lease('runner'),
    createdAt: '2026-07-04T00:00:00.000Z',
    updatedAt: '2026-07-04T00:00:00.000Z',
    ...overrides,
  };
}

function unit(overrides = {}) {
  return {
    id: 'u1',
    state: BUILD_STATE_QUEUED,
    scope: { declared: ['src/agent/build-state.mjs'] },
    goal: 'Build route unit',
    createdAt: '2026-07-04T00:00:00.000Z',
    updatedAt: '2026-07-04T00:00:00.000Z',
    ...overrides,
  };
}

function lane(overrides = {}) {
  return {
    id: 'lane-1',
    unitId: 'u1',
    pid: 100,
    startTime: 'start',
    logPath: 'logs/lane-1.log',
    worktreePath: '/tmp/lane-1',
    state: BUILD_STATE_BUILDING,
    createdAt: '2026-07-04T00:00:00.000Z',
    updatedAt: '2026-07-04T00:00:00.000Z',
    ...overrides,
  };
}

function cardInput(overrides = {}) {
  return {
    kind: BUILD_CARD_KIND_DRIFT,
    tier: BUILD_CARD_TIER_TAILNET,
    planId: 'plan-1',
    title: 'Build decision',
    body: 'Pick the next build action.',
    options: [
      {
        id: 'continue',
        label: 'Continue',
        consequence: 'Proceed with the current lane.',
      },
      {
        id: 'kill',
        label: 'Kill',
        consequence: 'Stop the affected work.',
      },
      {
        id: 'approve',
        label: 'Approve',
        consequence: 'Allow the plan to run.',
      },
    ],
    recommendation: 'continue',
    ...overrides,
  };
}

function suffixer() {
  let index = 0;
  return () => {
    index += 1;
    return `r${index}`;
  };
}

function lease(owner) {
  return {
    owner,
    acquiredAt: '2026-07-04T00:00:00.000Z',
    renewedAt: '2026-07-04T00:00:00.000Z',
    ttlMs: 60_000,
  };
}

function precheckDeps() {
  return {
    anchors: {
      strategy: strategyFixture(),
      loop: 'The build runner preserves local-first auditability.',
      constitution: 'Sovereign checks fail closed and never weaken safety floors.',
    },
    trackCheck: async () => ({
      ok: true,
      score: 1,
      threshold: 0.25,
      severity: 'none',
      anchor: 'strategy-track',
      strategyChars: 100,
      strategyTerms: 10,
      planTerms: 10,
      overlap: ['build'],
    }),
    singleCall: async () => ({
      model: 'stub-sovereign',
      content: JSON.stringify({
        verdict: 'pass',
        reasons: ['draft preserves the runner approval boundary'],
        anchorRefs: ['constitution'],
      }),
    }),
  };
}

function strategyFixture() {
  return `
# cs-k Strategy

## Approach

K is a local-first human AI holon that frees attention while preserving
sovereign safety floors.

## Tracks

/bio /neuro /cognitive /coordination /k with build-runner evidence gates.
`;
}
