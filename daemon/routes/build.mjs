import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  BUILD_STATE_CANCELLED,
  BUILD_STATE_HELD,
  BUILD_STATE_KILLED,
  BUILD_STATE_ORPHANED,
  BUILD_STATE_QUARANTINED,
  BuildStateError,
  FOUNDER_ACTOR,
  OwnershipError,
  TransitionError,
  canTransition,
  createBuildStateStore,
  normalizeLaneRecord,
  readHistory,
} from '../../src/agent/build-state.mjs';
import {
  BuildCardError,
  BUILD_CARD_KIND_SHAPING,
  InvalidChannelError,
  createBuildCardStore,
} from '../../src/agent/build-cards.mjs';
import {
  BuildDraftError,
  draftPlan,
  stagePlanDraft,
} from '../../src/agent/build-draft.mjs';
import {
  buildViewPacket,
  validateViewPacket,
} from '../../src/agent/view-packet.mjs';
import {
  isPlainObject,
  optionalString,
  createSubstrateStore,
  stripUndefined,
} from '../../src/substrate.mjs';
import { atomicWriteJson } from '../../src/agent/routines.mjs';
import {
  ROOT,
  iso,
  safeDataPath,
} from '../run.mjs';
import { writeSseEvent } from './agui.mjs';

export const BUILD_STATE_PATH = '/api/build/state';
export const BUILD_HISTORY_PATH = '/api/build/history';
export const BUILD_TRANSITION_PATH = '/api/build/transition';
export const BUILD_LANE_PATH = '/api/build/lane';
export const BUILD_LANE_LOG_TAIL_PATH = '/api/build/lane/log-tail';
export const BUILD_CARDS_PATH = '/api/build/cards';
export const BUILD_CARD_ANSWER_PATH = '/api/build/cards/answer';
export const BUILD_REQUEST_PATH = '/api/build/request';
export const BUILD_FOUNDER_ACTION_PATH = '/api/build/founder-action';
export const BUILD_EVENTS_PATH = '/api/build/events';
export const BUILD_DOC_READER_PATH = '/api/build/artifacts/doc';
export const BUILD_DIFF_PATH = '/api/build/artifacts/diff';
export const BUILD_EVIDENCE_PATH = '/api/build/evidence';
export const BUILD_LEARNED_PATH = '/api/build/learned';
export const BUILD_LEARNED_DECISION_PATH = '/api/build/learned/decision';
export const BUILD_TRUST_PATH = '/api/build/trust';
export const BUILD_TRUST_PAIR_PATH = '/api/build/trust/pair';
export const BUILD_SNAPSHOT_EVENT = 'build_snapshot';
export const BUILD_PACKET_EVENT = 'packet';

const DEFAULT_STATE_PLAN_LIMIT = 25;
const DEFAULT_STATE_LANE_LIMIT = 50;
const DEFAULT_STATE_CARD_LIMIT = 50;
const DEFAULT_STATE_PACKET_LIMIT = 100;
const DEFAULT_UNIT_LIMIT_PER_PLAN = 100;
const DEFAULT_HISTORY_LIMIT = 100;
const DEFAULT_SSE_KEEP_ALIVE_MS = 10_000;
const DEFAULT_LOG_TAIL_BYTES = 16 * 1024;
const MAX_LOG_TAIL_BYTES = 64 * 1024;
const MAX_HISTORY_FOLD_LIMIT = 1000;
const RECENT_PACKET_LIMIT = 512;
const LANE_LOG_ROOT = path.join('build', 'lane-logs');
const BUILD_ARTIFACTS_DIR = path.join('build', 'artifacts');
const BUILD_DIFFS_DIR = path.join(BUILD_ARTIFACTS_DIR, 'diffs');
const BUILD_EVIDENCE_DIR = path.join('build', 'evidence');
const BUILD_LEARNED_DIR = path.join('build', 'learned');
const BUILD_TRUST_DIR = path.join('build', 'trust', 'pairs');
const DOC_READER_MAX_BYTES = 256 * 1024;
const EVIDENCE_TEXT_MAX_CHARS = 40_000;
const LEARNED_TEXT_MAX_CHARS = 4_000;
const DIFF_ID_PATTERN = /^diff_[a-f0-9]{16}$/;
const EVIDENCE_ID_PATTERN = /^evi_[a-f0-9]{16}$/;
const LEARNED_ID_PATTERN = /^learn_[a-f0-9]{16}$/;
const TRUST_PAIR_ID_PATTERN = /^trust_[a-f0-9]{16}$/;
const BUILD_REF_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const DOC_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.json']);
const EVIDENCE_KINDS = new Set(['text', 'transcript', 'image', 'gate-output']);
const LEARNED_CATEGORIES = new Set(['pattern', 'fix', 'preference', 'convention']);
const LEARNED_STATUSES = new Set(['pending', 'approved', 'discarded']);
const LEARNED_DECISIONS = new Set(['approve', 'edit', 'discard']);
const CLOSED_CARD_STATUSES = new Set([
  'answered',
  'applied',
  'closed',
  'resolved',
  'obsoleted',
  'obsolete',
  'superseded',
  'cancelled',
  'canceled',
]);
const SEVERITY_RANK = new Map([
  ['safety-floor', 0],
  ['critical', 1],
  ['high', 2],
  ['medium', 3],
  ['normal', 4],
  ['low', 5],
]);

export const buildEvents = createBuildEventEmitter();

export function isBuildPath(pathname) {
  return (
    pathname === BUILD_STATE_PATH ||
    pathname === BUILD_HISTORY_PATH ||
    pathname === BUILD_TRANSITION_PATH ||
    pathname === BUILD_LANE_PATH ||
    pathname === BUILD_LANE_LOG_TAIL_PATH ||
    pathname === BUILD_CARDS_PATH ||
    pathname === BUILD_CARD_ANSWER_PATH ||
    pathname === BUILD_REQUEST_PATH ||
    pathname === BUILD_FOUNDER_ACTION_PATH ||
    pathname === BUILD_EVENTS_PATH ||
    pathname === BUILD_EVENTS_PATH ||
    pathname === BUILD_DOC_READER_PATH ||
    pathname === BUILD_DIFF_PATH ||
    pathname === BUILD_EVIDENCE_PATH ||
    pathname === BUILD_LEARNED_PATH ||
    pathname === BUILD_LEARNED_DECISION_PATH ||
    pathname === BUILD_TRUST_PATH ||
    pathname === BUILD_TRUST_PAIR_PATH
  );
}

export function isBuildMutationPath(pathname) {
  return (
    pathname === BUILD_TRANSITION_PATH ||
    pathname === BUILD_LANE_PATH ||
    pathname === BUILD_DIFF_PATH ||
    pathname === BUILD_EVIDENCE_PATH ||
    pathname === BUILD_LEARNED_PATH ||
    pathname === BUILD_TRUST_PAIR_PATH
  );
}

// Returns true if it handled the request. deps supplies { sendJson, httpError,
// readPlaintextJson, isSameMachine } so this module reuses server-owned helpers.
export async function handleBuildRoute(request, response, context, deps) {
  const { method, pathname } = context;
  const { sendJson, httpError, readPlaintextJson } = deps;
  const store = context.buildStateStore ??
    createBuildStateStore({ dataDir: context.dataDir, now: context.now });
  const cardStore = context.buildCardStore ??
    createBuildCardStore({
      dataDir: context.dataDir,
      now: context.now,
      stateStore: store,
    });
  const substrateStore = context.substrateStore ??
    createSubstrateStore({ dataDir: context.dataDir, now: context.now });
  const events = context.buildEvents ?? buildEvents;
  const searchParams = context.searchParams ?? requestSearchParams(request);
  const repoRoot = context.repoRoot ?? ROOT;

  if (method === 'GET' && pathname === BUILD_STATE_PATH) {
    sendJson(response, 200, {
      ok: true,
      ...(await buildSnapshot(store, events, {
        cardStore,
        now: context.now,
        searchParams,
      })),
    });
    return true;
  }

  if (method === 'GET' && pathname === BUILD_CARDS_PATH) {
    const limit = limitParam(searchParams, 'limit', DEFAULT_STATE_CARD_LIMIT, 200);
    const cards = (await cardStore.listOpenCards({ limit })).map(projectCardRecord);
    sendJson(response, 200, {
      ok: true,
      limit,
      count: cards.length,
      cards,
    });
    return true;
  }

  if (method === 'GET' && pathname === BUILD_LANE_LOG_TAIL_PATH) {
    const result = await routeMutation(
      () => buildLaneLogTail(store, searchParams, httpError),
      httpError,
    );
    sendJson(response, 200, result);
    return true;
  }

  if (method === 'GET' && pathname === BUILD_HISTORY_PATH) {
    const limit = limitParam(searchParams, 'limit', DEFAULT_HISTORY_LIMIT, 1000);
    const history = await readHistory({ dataDir: store.dataDir, limit });
    sendJson(response, 200, {
      ok: true,
      newestFirst: true,
      limit,
      history: history.reverse(),
    });
    return true;
  }

  if (method === 'GET' && pathname === BUILD_EVENTS_PATH) {
    await handleBuildEvents(request, response, {
      store,
      cardStore,
      events,
      now: context.now,
      searchParams,
      keepAliveIntervalMs: context.keepAliveIntervalMs,
    });
    return true;
  }

  if (method === 'POST' && pathname === BUILD_REQUEST_PATH) {
    const payload = await readPlaintextJson(request);
    const result = await routeMutation(
      () => requestBuildDraft(store, cardStore, payload, events, httpError, {
        now: context.now,
        deps: context.buildDraftDeps,
      }),
      httpError,
    );
    sendJson(response, 200, result);
    return true;
  }

  if (method === 'GET' && pathname === BUILD_DOC_READER_PATH) {
    const artifact = await routeMutation(
      () => documentReaderPayload({
        repoRoot,
        searchParams,
        now: context.now,
      }, httpError),
      httpError,
    );
    sendJson(response, 200, { ok: true, artifact });
    return true;
  }

  if (method === 'GET' && pathname === BUILD_DIFF_PATH) {
    const result = await routeMutation(
      () => readDiffArtifactRoute({
        dataDir: context.dataDir,
        searchParams,
      }, httpError),
      httpError,
    );
    sendJson(response, 200, result);
    return true;
  }

  if (method === 'POST' && pathname === BUILD_DIFF_PATH) {
    assertSameMachine(request, deps, httpError);
    const payload = await readPlaintextJson(request);
    const result = await routeMutation(
      () => attachDiffArtifact({
        store,
        dataDir: context.dataDir,
        now: context.now,
        payload,
      }, httpError),
      httpError,
    );
    sendJson(response, 200, result);
    return true;
  }

  if (method === 'GET' && pathname === BUILD_EVIDENCE_PATH) {
    const result = await routeMutation(
      () => listEvidenceRoute({
        dataDir: context.dataDir,
        searchParams,
      }, httpError),
      httpError,
    );
    sendJson(response, 200, result);
    return true;
  }

  if (method === 'POST' && pathname === BUILD_EVIDENCE_PATH) {
    assertSameMachine(request, deps, httpError);
    const payload = await readPlaintextJson(request);
    const result = await routeMutation(
      () => attachVerificationEvidence({
        store,
        dataDir: context.dataDir,
        now: context.now,
        payload,
      }, httpError),
      httpError,
    );
    sendJson(response, 200, result);
    return true;
  }

  if (method === 'GET' && pathname === BUILD_LEARNED_PATH) {
    const result = await routeMutation(
      () => listLearnedEntriesRoute({
        dataDir: context.dataDir,
        searchParams,
      }, httpError),
      httpError,
    );
    sendJson(response, 200, result);
    return true;
  }

  if (method === 'POST' && pathname === BUILD_LEARNED_PATH) {
    assertSameMachine(request, deps, httpError);
    const payload = await readPlaintextJson(request);
    const result = await routeMutation(
      () => stageLearnedEntry({
        store,
        dataDir: context.dataDir,
        now: context.now,
        payload,
      }, httpError),
      httpError,
    );
    sendJson(response, 200, result);
    return true;
  }

  if (method === 'POST' && pathname === BUILD_LEARNED_DECISION_PATH) {
    const payload = await readPlaintextJson(request);
    const result = await routeMutation(
      () => decideLearnedEntry({
        store,
        substrateStore,
        dataDir: context.dataDir,
        now: context.now,
        payload,
      }, httpError),
      httpError,
    );
    sendJson(response, 200, result);
    return true;
  }

  if (method === 'GET' && pathname === BUILD_TRUST_PATH) {
    const result = await routeMutation(
      () => trustViewRoute({
        dataDir: context.dataDir,
        searchParams,
      }, httpError),
      httpError,
    );
    sendJson(response, 200, result);
    return true;
  }

  if (method === 'POST' && pathname === BUILD_TRUST_PAIR_PATH) {
    assertSameMachine(request, deps, httpError);
    const payload = await readPlaintextJson(request);
    const result = await routeMutation(
      () => pairTrustVerdict({
        store,
        cardStore,
        dataDir: context.dataDir,
        now: context.now,
        payload,
      }, httpError),
      httpError,
    );
    sendJson(response, 200, result);
    return true;
  }

  if (method === 'POST' && pathname === BUILD_CARD_ANSWER_PATH) {
    const payload = await readPlaintextJson(request);
    const result = await routeMutation(
      () => answerBuildCard(cardStore, payload, events, httpError, {
        isSameMachine: sameMachineRequest(request, deps),
      }),
      httpError,
    );
    sendJson(response, 200, result);
    return true;
  }

  if (method === 'POST' && pathname === BUILD_FOUNDER_ACTION_PATH) {
    const payload = await readPlaintextJson(request);
    const result = await routeMutation(
      () => founderActionTransition(store, payload, events, httpError, context.now),
      httpError,
    );
    sendJson(response, 200, result);
    return true;
  }

  if (method === 'POST' && pathname === BUILD_TRANSITION_PATH) {
    assertSameMachine(request, deps, httpError);
    const payload = await readPlaintextJson(request);
    const result = await routeMutation(
      () => transitionBuildState(store, payload, events, httpError),
      httpError,
    );
    sendJson(response, 200, result);
    return true;
  }

  if (method === 'POST' && pathname === BUILD_LANE_PATH) {
    assertSameMachine(request, deps, httpError);
    const payload = await readPlaintextJson(request);
    const result = await routeMutation(
      () => updateBuildLane(store, payload, events, httpError, context.now),
      httpError,
    );
    sendJson(response, 200, result);
    return true;
  }

  if (isBuildPath(pathname)) {
    sendJson(response, 405, { ok: false, error: 'method_not_allowed' });
    return true;
  }

  return false;
}

export function createBuildEventEmitter(options = {}) {
  let seq = positiveInteger(options.startSeq, 0);
  const clients = new Set();
  const recentPackets = [];
  const openCards = new Map();
  const recentLimit = positiveInteger(options.recentLimit, RECENT_PACKET_LIMIT);

  function currentSeq() {
    return seq;
  }

  function addClient(response) {
    clients.add(response);
    return () => {
      clients.delete(response);
    };
  }

  function emitStatus(event = {}) {
    return emitPacket(buildStatusPacketInput(event, nextSeq()));
  }

  function emitCard(event = {}) {
    rememberCardEvent(openCards, event);
    return emitPacket(buildCardPacketInput(event, nextSeq()));
  }

  function emitPacket(input) {
    const packet = validateViewPacket(buildViewPacket(input));
    recentPackets.push(packet);
    while (recentPackets.length > recentLimit) recentPackets.shift();

    for (const response of [...clients]) {
      if (response.writableEnded || response.destroyed) {
        clients.delete(response);
        continue;
      }
      writeSseEvent(response, BUILD_PACKET_EVENT, packet);
    }

    return packet;
  }

  function rememberedPackets(limit = DEFAULT_STATE_PACKET_LIMIT) {
    return recentPackets.slice(-limit);
  }

  function rememberedOpenCards(limit = DEFAULT_STATE_CARD_LIMIT) {
    return sortOpenCards([...openCards.values()]).slice(0, limit);
  }

  function reset() {
    seq = 0;
    clients.clear();
    recentPackets.length = 0;
    openCards.clear();
  }

  function nextSeq() {
    seq += 1;
    return seq;
  }

  return {
    addClient,
    currentSeq,
    emitCard,
    emitPacket,
    emitStatus,
    openCards: rememberedOpenCards,
    recentPackets: rememberedPackets,
    reset,
  };
}

export async function recordBuildCardEvent(store, event = {}, events = buildEvents) {
  const history = await store.recordCardEvent(event);
  const packet = events.emitCard({
    ...event,
    at: optionalString(event.at) ?? optionalString(event.ts),
  });
  return {
    ok: history.ok,
    history,
    packet,
  };
}

async function transitionBuildState(store, payload, events, httpError) {
  const input = transitionPayload(payload, httpError);
  const from = await previousStateForTransition(store, input);
  const result = await store.transition(input);
  const packet = events.emitStatus({
    kind: 'build.transition',
    planId: input.planId,
    unitId: input.unitId,
    laneId: input.laneId,
    actor: input.actor,
    from,
    to: input.to,
    reason: input.reason,
    plan: result.plan,
  });
  return {
    ok: result.ok,
    plan: projectPlan(result.plan),
    history: result.history,
    packet,
  };
}

async function updateBuildLane(store, payload, events, httpError, now) {
  const input = lanePayload(payload, httpError, now);
  const from = await previousStateForTransition(store, input.transition);
  const transitionResult = await store.transition(input.transition);

  const lane = await store.saveLane(input.lane);
  const timestamp = iso(currentNow(now));
  const historyEvent = {
    kind: 'build.lane.updated',
    laneId: lane.id,
    unitId: lane.unitId,
    state: lane.state,
    at: timestamp,
  };
  const history = await store.appendHistory(historyEvent);
  const packet = events.emitStatus({
    ...historyEvent,
    planId: input.transition.planId,
    actor: input.transition.actor,
    from,
    to: input.transition.to,
    plan: transitionResult.plan,
  });

  return {
    ok: history.ok && transitionResult.ok,
    lane: projectLane(lane),
    plan: projectPlan(transitionResult.plan),
    transitionHistory: transitionResult.history,
    history,
    packet,
  };
}

async function answerBuildCard(cardStore, payload, events, httpError, channel) {
  const input = answerPayload(payload, httpError);
  const result = await cardStore.answerCard({
    ...input,
    isSameMachine: channel.isSameMachine,
  });
  const packets = emitCardEvents(events, result.events);

  return stripUndefined({
    ok: result.ok,
    card: projectCardRecord(result.card),
    alreadyAnswered: result.alreadyAnswered,
    packet: packets[0],
    packets,
  });
}

async function requestBuildDraft(store, cardStore, payload, events, httpError, options = {}) {
  const input = buildRequestPayload(payload, httpError, options.now);
  const shaping = shapingForIntent(input.intent);

  if (shaping) {
    const raised = await cardStore.raiseCard(shapingCardInput({
      ...input,
      shaping,
      now: currentNow(options.now),
    }));
    const packets = emitCardEvents(events, raised.events);
    return {
      ok: raised.ok !== false,
      status: 'shaping_required',
      requestId: input.requestId,
      card: projectCardRecord(raised.card),
      packet: packets[0],
      packets,
    };
  }

  const draft = draftPlan({
    id: input.planId,
    now: currentNow(options.now),
    sources: {
      founderInput: input.intent,
      strategyText: optionalString(options.deps?.anchors?.strategy) ?? '',
      openFlags: input.openFlags,
    },
  });
  const staged = await stagePlanDraft({
    store,
    cards: cardStore,
    draft,
    deps: {
      ...(isPlainObject(options.deps) ? options.deps : {}),
      now: currentNow(options.now),
    },
  });
  const packets = emitCardEvents(events, staged.raised?.events);

  return {
    ok: staged.ok !== false,
    status: 'draft_staged',
    requestId: input.requestId,
    plan: projectPlan(staged.plan),
    draft: projectPlan(staged.draft),
    preCheck: projectPreCheck(staged.preCheck),
    card: projectCardRecord(staged.card),
    packet: packets[0],
    packets,
  };
}

async function founderActionTransition(store, payload, events, httpError, now) {
  const input = founderActionPayload(payload, httpError);
  const transitions = await transitionFounderAction(store, input, now);
  const packets = transitions.map((transition) =>
    events.emitStatus({
      kind: 'build.founder-action',
      planId: input.planId,
      unitId: input.unitId,
      actor: FOUNDER_ACTOR,
      from: transition.from,
      to: transition.to,
      reason: transition.reason,
      plan: transition.plan,
      at: transition.at,
    }));
  const final = transitions.at(-1);
  const plan = final?.plan ?? await store.loadPlan(input.planId);

  return stripUndefined({
    ok: true,
    action: input.action,
    plan: plan ? projectPlan(plan) : undefined,
    unit: input.unitId && plan
      ? projectUnitWithPlan(plan, input.unitId)
      : undefined,
    packet: packets.at(-1),
    packets,
  });
}

async function buildLaneLogTail(store, searchParams, httpError) {
  const laneId = optionalString(searchParams?.get?.('laneId') ?? searchParams?.get?.('id'));
  if (!laneId) throw httpError(400, 'missing_laneId');

  const lane = await store.loadLane(laneId);
  if (!lane) throw httpError(404, 'lane_not_found');

  const limit = limitParam(searchParams, 'bytes', DEFAULT_LOG_TAIL_BYTES, MAX_LOG_TAIL_BYTES);
  const file = laneLogPathForRead(store.dataDir, lane, httpError);
  const tail = await readLogTail(file, limit, httpError);
  return {
    ok: true,
    laneId: lane.id,
    bytes: tail.bytes,
    limit,
    logSize: tail.logSize,
    truncated: tail.truncated,
    tail: tail.text,
    updatedAt: lane.updatedAt,
  };
}

function emitCardEvents(events, cardEvents = []) {
  const packets = [];
  for (const event of cardEvents) {
    packets.push(events.emitCard(event));
  }
  return packets;
}

async function handleBuildEvents(request, response, context) {
  openSseStream(response);
  let disconnected = false;
  let removeClient = () => {};
  const stopKeepAlive = startSseKeepAlive(
    response,
    context.keepAliveIntervalMs ?? DEFAULT_SSE_KEEP_ALIVE_MS,
  );
  const stopDisconnectWatch = watchClientDisconnect(request, response, () => {
    disconnected = true;
    stopKeepAlive();
    removeClient();
  });

  const snapshot = await buildSnapshot(context.store, context.events, {
    cardStore: context.cardStore,
    now: context.now,
    searchParams: context.searchParams,
  });
  if (disconnected || response.writableEnded || response.destroyed) {
    stopKeepAlive();
    stopDisconnectWatch();
    return;
  }
  writeSseEvent(response, BUILD_SNAPSHOT_EVENT, snapshot);
  removeClient = context.events.addClient(response);

  const cleanup = () => {
    stopKeepAlive();
    stopDisconnectWatch();
    removeClient();
  };
  if (typeof response.once === 'function') response.once('close', cleanup);
}

async function buildSnapshot(store, events, options = {}) {
  const searchParams = options.searchParams ?? new URLSearchParams();
  const planLimit = limitParam(searchParams, 'plans', DEFAULT_STATE_PLAN_LIMIT, 100);
  const laneLimit = limitParam(searchParams, 'lanes', DEFAULT_STATE_LANE_LIMIT, 200);
  const cardLimit = limitParam(searchParams, 'cards', DEFAULT_STATE_CARD_LIMIT, 200);
  const packetLimit = limitParam(searchParams, 'packets', DEFAULT_STATE_PACKET_LIMIT, 500);
  const unitLimit = limitParam(searchParams, 'units', DEFAULT_UNIT_LIMIT_PER_PLAN, 500);
  const [plans, lanes, storedCards, historyCards] = await Promise.all([
    store.listPlans(),
    store.listLanes(),
    options.cardStore
      ? options.cardStore.listOpenCards({ limit: cardLimit })
      : [],
    openCardsFromHistory(store.dataDir, MAX_HISTORY_FOLD_LIMIT),
  ]);

  const projectedPlans = plans
    .sort(compareUpdatedDesc)
    .slice(0, planLimit)
    .map((plan) => projectPlan(plan, { unitLimit }));
  const projectedLanes = lanes
    .sort(compareUpdatedDesc)
    .slice(0, laneLimit)
    .map(projectLane);
  const cards = mergeOpenCards(
    historyCards,
    events.openCards(cardLimit),
    storedCards.map(projectCardRecord),
  )
    .slice(0, cardLimit);

  return {
    generatedAt: iso(currentNow(options.now)),
    source: 'cs-k',
    seq: events.currentSeq(),
    plans: projectedPlans,
    units: projectedPlans.flatMap((plan) =>
      plan.units.map((unit) => ({ ...unit, planId: plan.id }))),
    lanes: projectedLanes,
    cards,
    // Post-restart the in-memory packet ring is empty; packet-renderer clients
    // (the iOS Build tab) would connect and see nothing. Synthesize one
    // build.status packet per plan from durable state so the snapshot always
    // carries renderable truth.
    packets: snapshotPackets(events, projectedPlans, packetLimit),
    counts: {
      plans: plans.length,
      units: plans.reduce((count, plan) => count + plan.units.length, 0),
      lanes: lanes.length,
      cards: cards.length,
    },
  };
}

async function openCardsFromHistory(dataDir, limit) {
  const cards = new Map();
  const history = await readHistory({ dataDir, limit });
  for (const event of history) rememberCardEvent(cards, event);
  return sortOpenCards([...cards.values()]);
}

function mergeOpenCards(...cardLists) {
  const cards = new Map();
  for (const card of cardLists.flat()) {
    if (!card?.id) continue;
    cards.set(card.id, card);
  }
  return sortOpenCards([...cards.values()]);
}

function rememberCardEvent(cards, event) {
  const card = projectCardEvent(event);
  if (!card) return;
  if (CLOSED_CARD_STATUSES.has(card.status)) {
    cards.delete(card.id);
    return;
  }
  cards.set(card.id, {
    ...(cards.get(card.id) ?? {}),
    ...card,
  });
}

function projectCardEvent(event = {}) {
  const card = isPlainObject(event.card) ? event.card : {};
  const kind = optionalString(event.kind);
  const hasCardKind = kind?.startsWith('build.card') === true;
  const id = optionalString(card.id ?? event.cardId ?? event.id);
  if (!id || (!hasCardKind && !event.cardId && !event.card)) return null;

  const status = normalizeCardStatus(
    card.status ??
    event.status ??
    (kind === 'build.card.obsoleted' ? 'obsoleted' : undefined),
  );
  const timestamp = optionalString(event.ts ?? event.at ?? card.updatedAt ?? card.raisedAt);

  return stripUndefined({
    id,
    status,
    kind: optionalString(card.kind ?? event.cardKind),
    planId: optionalString(card.planId ?? event.planId),
    unitId: optionalString(card.unitId ?? event.unitId),
    laneId: optionalString(card.laneId ?? event.laneId),
    title: optionalString(card.title ?? event.title),
    body: optionalString(card.body ?? event.body ?? event.text ?? event.decision),
    text: optionalString(card.text ?? card.body ?? event.text ?? event.body ?? event.decision),
    options: Array.isArray(card.options) ? card.options : undefined,
    recommendation: optionalString(card.recommendation ?? event.recommendation),
    requestId: optionalString(card.requestId ?? event.requestId),
    intent: optionalString(card.intent ?? event.intent),
    action: optionalString(card.action ?? event.action),
    shaping: isPlainObject(card.shaping ?? event.shaping)
      ? card.shaping ?? event.shaping
      : undefined,
    severity: optionalString(card.severity ?? event.severity) ??
      severityForCardKind(optionalString(card.kind ?? event.cardKind)),
    tier: optionalString(card.tier ?? event.tier),
    raisedAt: optionalString(card.raisedAt ?? event.raisedAt ?? timestamp),
    queuedAt: optionalString(card.queuedAt ?? event.queuedAt),
    notifiedAt: optionalString(card.notifiedAt ?? event.notifiedAt),
    answeredBy: optionalString(card.answeredBy ?? event.answeredBy),
    answeredAt: optionalString(card.answeredAt ?? event.answeredAt),
    answerOption: optionalString(card.answerOption ?? event.answerOption ?? event.optionId),
    appliedAt: optionalString(card.appliedAt ?? event.appliedAt),
    applyFailedAt: optionalString(card.applyFailedAt ?? event.applyFailedAt),
    applyFailureReason: optionalString(card.applyFailureReason ?? event.reason),
    updatedAt: timestamp,
    supersededBy: optionalString(card.supersededBy ?? event.supersededBy),
    supersededById: optionalString(card.supersededById ?? event.supersededById ?? card.supersededBy ?? event.supersededBy),
  });
}

function normalizeCardStatus(value) {
  const status = optionalString(value);
  if (!status) return 'raised';
  return status;
}

function snapshotPackets(events, projectedPlans, limit) {
  const recent = events.recentPackets(limit);
  if (recent.length > 0) return recent;
  return projectedPlans.slice(0, limit).map((plan) =>
    validateViewPacket(buildViewPacket(buildStatusPacketInput({
      kind: 'build.snapshot-state',
      planId: plan.id,
      plan,
      state: plan.status,
    }, events.currentSeq()))));
}

function buildStatusPacketInput(event, seq) {
  const plan = isPlainObject(event.plan) ? event.plan : null;
  const unit = plan && event.unitId
    ? plan.units?.find((candidate) => candidate.id === event.unitId)
    : null;
  const status = optionalString(event.to ?? event.state ?? unit?.state ?? plan?.status);
  const from = optionalString(event.from);
  const subject = optionalString(event.unitId ?? event.laneId ?? event.planId) ?? 'build';

  return {
    viewType: 'build.status',
    text: statusText({ ...event, from, status, subject }),
    fields: stripUndefined({
      seq,
      eventKind: optionalString(event.kind) ?? 'build.status',
      planId: optionalString(event.planId ?? plan?.id),
      unitId: optionalString(event.unitId),
      laneId: optionalString(event.laneId),
      actor: optionalString(event.actor),
      from,
      status,
      reason: optionalString(event.reason),
      at: optionalString(event.at ?? event.ts),
    }),
    provenance: buildProvenance(),
    frontierExcluded: true,
  };
}

function buildCardPacketInput(event, seq) {
  const card = projectCardEvent(event) ?? {
    id: optionalString(event.cardId ?? event.id) ?? 'build-card',
    status: 'raised',
  };
  return {
    viewType: 'build.card',
    text: card.text ?? card.title ?? `Build card ${card.id} ${card.status}.`,
    fields: stripUndefined({
      seq,
      eventKind: optionalString(event.kind) ?? 'build.card',
      card,
      cardId: card.id,
      planId: card.planId,
      unitId: card.unitId,
      laneId: card.laneId,
      status: card.status,
      severity: card.severity,
      at: optionalString(event.at ?? event.ts ?? card.updatedAt),
    }),
    provenance: buildProvenance(),
    frontierExcluded: true,
  };
}

function buildProvenance() {
  return {
    surface: 'build',
    lane: 'daemon',
    plane: 'agent',
    module: 'build-route',
  };
}

async function documentReaderPayload({ repoRoot, searchParams, now }, httpError) {
  const relPath = normalizeRepoDocPath(searchParams.get('path') ?? searchParams.get('ref'), httpError);
  const root = path.resolve(repoRoot ?? ROOT);
  const file = path.resolve(root, relPath);
  if (!isPathInside(root, file)) throw httpError(400, 'invalid_artifact_path');

  let stat;
  try {
    stat = await fs.stat(file);
  } catch (error) {
    if (error.code === 'ENOENT') throw httpError(404, 'document_not_found');
    throw error;
  }
  if (!stat.isFile()) throw httpError(404, 'document_not_found');
  if (stat.size > DOC_READER_MAX_BYTES) throw httpError(413, 'document_too_large');

  const text = await fs.readFile(file, 'utf8');
  return {
    kind: 'DocumentArtifact',
    viewType: 'preview.file',
    path: relPath,
    title: path.basename(relPath),
    language: languageForPath(relPath),
    byteLength: Buffer.byteLength(text, 'utf8'),
    lines: text.split(/\r?\n/).map((line, index) => ({
      number: index + 1,
      text: line,
    })),
    generatedAt: iso(currentNow(now)),
    source: 'cs-k',
  };
}

function normalizeRepoDocPath(value, httpError) {
  const text = optionalString(value);
  if (!text) throw httpError(400, 'missing_artifact_path');
  const normalized = normalizeRelPath(text);
  if (!normalized ||
    normalized.startsWith('../') ||
    normalized.includes('/../') ||
    path.isAbsolute(text)) {
    throw httpError(400, 'invalid_artifact_path');
  }
  if (!DOC_EXTENSIONS.has(path.extname(normalized).toLowerCase())) {
    throw httpError(400, 'unsupported_document_type');
  }
  return normalized;
}

async function attachDiffArtifact({ store, dataDir, now, payload }, httpError) {
  if (!isPlainObject(payload)) throw httpError(400, 'invalid_diff_payload');
  rejectClientPathFields(payload, httpError);

  const planId = requiredBuildRef(payload.planId, 'planId', httpError);
  const unitId = requiredBuildRef(payload.unitId, 'unitId', httpError);
  const laneId = optionalBuildRef(payload.laneId, 'laneId', httpError);
  const diff = requiredRouteString(payload.diff ?? payload.diffText ?? payload.patch, 'diff', httpError);
  const createdAt = iso(currentNow(now));
  const id = `diff_${sha256([
    planId,
    unitId,
    laneId ?? '',
    diff,
  ].join('\n')).slice(0, 16)}`;
  const artifact = projectDiffArtifact({
    kind: 'BuildDiffArtifact',
    schemaVersion: 1,
    id,
    planId,
    unitId,
    laneId,
    title: optionalString(payload.title) ?? null,
    baseSha: optionalString(payload.baseSha) ?? null,
    headSha: optionalString(payload.headSha) ?? null,
    diff,
    createdAt,
    updatedAt: createdAt,
  });

  await atomicWriteJson(buildJsonFile(dataDir, BUILD_DIFFS_DIR, `${id}.json`), {
    ...artifact,
    diff,
  });
  const history = await store.appendHistory({
    kind: 'build.artifact.diff.attached',
    artifactId: id,
    planId,
    unitId,
    ...(laneId ? { laneId } : {}),
    files: artifact.files.map((file) => file.path),
    at: createdAt,
  });

  return {
    ok: history.ok,
    artifact,
    history,
  };
}

async function readDiffArtifactRoute({ dataDir, searchParams }, httpError) {
  const id = optionalString(searchParams.get('id'));
  if (id) {
    const artifact = await readDiffArtifact(dataDir, assertRouteId(id, DIFF_ID_PATTERN, 'invalid_diff_id', httpError));
    if (!artifact) throw httpError(404, 'diff_artifact_not_found');
    return { ok: true, artifact };
  }

  const laneId = optionalBuildRef(searchParams.get('laneId'), 'laneId', httpError);
  const unitId = optionalBuildRef(searchParams.get('unitId'), 'unitId', httpError);
  const artifacts = (await listBuildJsonFiles(dataDir, BUILD_DIFFS_DIR))
    .map(projectDiffArtifact)
    .filter((artifact) => (!laneId || artifact.laneId === laneId) && (!unitId || artifact.unitId === unitId))
    .sort(compareCreatedDesc);
  return {
    ok: true,
    count: artifacts.length,
    artifacts,
  };
}

async function readDiffArtifact(dataDir, id) {
  try {
    return projectDiffArtifact(
      JSON.parse(await fs.readFile(buildJsonFile(dataDir, BUILD_DIFFS_DIR, `${id}.json`), 'utf8')),
    );
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function projectDiffArtifact(record) {
  const files = parseUnifiedDiffForDisplay(optionalString(record.diff) ?? '');
  return stripUndefined({
    kind: 'BuildDiffArtifact',
    schemaVersion: 1,
    id: optionalString(record.id),
    planId: optionalString(record.planId),
    unitId: optionalString(record.unitId),
    laneId: optionalString(record.laneId),
    title: optionalString(record.title),
    baseSha: optionalString(record.baseSha),
    headSha: optionalString(record.headSha),
    files,
    fileCount: files.length,
    createdAt: optionalString(record.createdAt),
    updatedAt: optionalString(record.updatedAt),
    source: 'cs-k',
  });
}

async function attachVerificationEvidence({ store, dataDir, now, payload }, httpError) {
  if (!isPlainObject(payload)) throw httpError(400, 'invalid_evidence_payload');
  rejectClientPathFields(payload, httpError);

  const planId = requiredBuildRef(payload.planId, 'planId', httpError);
  const unitId = requiredBuildRef(payload.unitId, 'unitId', httpError);
  const laneId = optionalBuildRef(payload.laneId, 'laneId', httpError);
  const kind = optionalString(payload.kind) ?? 'text';
  if (!EVIDENCE_KINDS.has(kind)) throw httpError(400, 'invalid_evidence_kind');

  const label = boundRouteText(
    optionalString(payload.label ?? payload.title) ?? evidenceDefaultLabel(kind),
    120,
  );
  const text = optionalString(payload.text ?? payload.transcript ?? payload.output);
  const dataBase64 = optionalString(payload.dataBase64);
  if (!text && !dataBase64) throw httpError(400, 'missing_evidence_body');
  if (text && text.length > EVIDENCE_TEXT_MAX_CHARS) throw httpError(413, 'evidence_text_too_large');

  const createdAt = iso(currentNow(now));
  const id = `evi_${sha256([
    planId,
    unitId,
    laneId ?? '',
    kind,
    label,
    text ?? '',
    dataBase64 ?? '',
  ].join('\n')).slice(0, 16)}`;
  const evidence = stripUndefined({
    kind,
    schemaVersion: 1,
    id,
    planId,
    unitId,
    laneId,
    label,
    text,
    mediaType: optionalString(payload.mediaType),
    dataBase64,
    acceptanceExample: optionalString(payload.acceptanceExample ?? payload.ae),
    createdAt,
    updatedAt: createdAt,
    source: 'cs-k',
  });

  await atomicWriteJson(buildJsonFile(dataDir, BUILD_EVIDENCE_DIR, `${id}.json`), evidence);
  const history = await store.appendHistory({
    kind: 'build.evidence.attached',
    evidenceId: id,
    planId,
    unitId,
    ...(laneId ? { laneId } : {}),
    evidenceKind: kind,
    label,
    at: createdAt,
  });

  return {
    ok: history.ok,
    evidence,
    history,
  };
}

async function listEvidenceRoute({ dataDir, searchParams }, httpError) {
  const id = optionalString(searchParams.get('id'));
  if (id) {
    const evidence = await readEvidence(dataDir, assertRouteId(id, EVIDENCE_ID_PATTERN, 'invalid_evidence_id', httpError));
    if (!evidence) throw httpError(404, 'evidence_not_found');
    return { ok: true, evidence };
  }

  const unitId = optionalBuildRef(searchParams.get('unitId'), 'unitId', httpError);
  const planId = optionalBuildRef(searchParams.get('planId'), 'planId', httpError);
  const evidence = (await listBuildJsonFiles(dataDir, BUILD_EVIDENCE_DIR))
    .map(projectEvidence)
    .filter(Boolean)
    .filter((entry) => (!unitId || entry.unitId === unitId) && (!planId || entry.planId === planId))
    .sort(compareCreatedDesc);
  return {
    ok: true,
    count: evidence.length,
    evidence,
  };
}

async function readEvidence(dataDir, id) {
  try {
    return projectEvidence(
      JSON.parse(await fs.readFile(buildJsonFile(dataDir, BUILD_EVIDENCE_DIR, `${id}.json`), 'utf8')),
    );
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function projectEvidence(record) {
  if (!isPlainObject(record)) return null;
  return stripUndefined({
    kind: optionalString(record.kind),
    schemaVersion: 1,
    id: optionalString(record.id),
    planId: optionalString(record.planId),
    unitId: optionalString(record.unitId),
    laneId: optionalString(record.laneId),
    label: optionalString(record.label),
    text: optionalString(record.text),
    mediaType: optionalString(record.mediaType),
    dataBase64: optionalString(record.dataBase64),
    acceptanceExample: optionalString(record.acceptanceExample),
    createdAt: optionalString(record.createdAt),
    updatedAt: optionalString(record.updatedAt),
    source: 'cs-k',
  });
}

async function stageLearnedEntry({ store, dataDir, now, payload }, httpError) {
  if (!isPlainObject(payload)) throw httpError(400, 'invalid_learned_payload');
  rejectClientPathFields(payload, httpError);

  const planId = requiredBuildRef(payload.planId, 'planId', httpError);
  const unitId = optionalBuildRef(payload.unitId, 'unitId', httpError);
  const category = optionalString(payload.category) ?? 'pattern';
  if (!LEARNED_CATEGORIES.has(category)) throw httpError(400, 'invalid_learned_category');

  const text = boundRouteText(
    requiredRouteString(payload.text ?? payload.body ?? payload.statement, 'text', httpError),
    LEARNED_TEXT_MAX_CHARS,
  );
  const label = boundRouteText(optionalString(payload.label) ?? firstWords(text, 8), 120);
  const evidenceIds = routeStringArray(payload.evidenceIds ?? payload.evidence ?? []);
  const createdAt = iso(currentNow(now));
  const id = `learn_${sha256([
    planId,
    unitId ?? '',
    category,
    label,
    text,
    evidenceIds.join('|'),
  ].join('\n')).slice(0, 16)}`;
  const entry = {
    kind: 'BuildLearnedEntry',
    schemaVersion: 1,
    id,
    planId,
    unitId,
    category,
    label,
    text,
    evidenceIds,
    source: optionalString(payload.source) ?? 'build',
    consent: {
      state: 'pending',
    },
    status: 'pending',
    createdAt,
    updatedAt: createdAt,
  };

  const existing = await readLearnedEntry(dataDir, id);
  if (existing) {
    return {
      ok: true,
      entry: existing,
      changed: false,
    };
  }

  await atomicWriteJson(buildJsonFile(dataDir, BUILD_LEARNED_DIR, `${id}.json`), entry);
  const history = await store.appendHistory({
    kind: 'build.learned.staged',
    learnedEntryId: id,
    planId,
    ...(unitId ? { unitId } : {}),
    category,
    at: createdAt,
  });

  return {
    ok: history.ok,
    entry: projectLearnedEntry(entry),
    history,
  };
}

async function decideLearnedEntry({ store, substrateStore, dataDir, now, payload }, httpError) {
  if (!isPlainObject(payload)) throw httpError(400, 'invalid_learned_decision_payload');
  rejectClientPathFields(payload, httpError);

  const id = assertRouteId(
    requiredRouteString(payload.id ?? payload.entryId, 'id', httpError),
    LEARNED_ID_PATTERN,
    'invalid_learned_id',
    httpError,
  );
  const decision = requiredRouteString(payload.decision, 'decision', httpError);
  if (!LEARNED_DECISIONS.has(decision)) throw httpError(400, 'invalid_learned_decision');

  const current = await readLearnedEntry(dataDir, id);
  if (!current) throw httpError(404, 'learned_entry_not_found');
  if (current.status !== 'pending') {
    return {
      ok: true,
      entry: current,
      alreadyDecided: {
        state: current.consent.state,
        at: current.consent.decidedAt,
      },
    };
  }

  const decidedAt = iso(currentNow(now));
  const approved = decision === 'approve' || decision === 'edit';
  const text = decision === 'edit'
    ? boundRouteText(requiredRouteString(payload.text ?? payload.body ?? payload.statement, 'text', httpError), LEARNED_TEXT_MAX_CHARS)
    : current.text;
  const label = decision === 'edit' && optionalString(payload.label)
    ? boundRouteText(payload.label, 120)
    : current.label;
  let substrateRecord = null;

  if (approved) {
    substrateRecord = await substrateStore.writeLearningRecord({
      category: current.category,
      label,
      text,
      evidenceIds: current.evidenceIds,
      planId: current.planId,
      unitId: current.unitId,
      sourceEntryId: current.id,
      consent: {
        state: 'approved',
        decidedAt,
        decision,
      },
      eventAt: decidedAt,
      provenance: { surface: 'build', lane: 'deliberate' },
    });
  }

  const updated = {
    ...current,
    label,
    text,
    status: approved ? 'approved' : 'discarded',
    consent: {
      state: approved ? 'approved' : 'discarded',
      decision,
      decidedAt,
    },
    substrateRecordId: substrateRecord?.id ?? null,
    updatedAt: decidedAt,
  };

  await atomicWriteJson(buildJsonFile(dataDir, BUILD_LEARNED_DIR, `${id}.json`), updated);
  const history = await store.appendHistory({
    kind: 'build.learned.decided',
    learnedEntryId: id,
    planId: updated.planId,
    ...(updated.unitId ? { unitId: updated.unitId } : {}),
    decision,
    status: updated.status,
    substrateRecordId: updated.substrateRecordId,
    at: decidedAt,
  });

  return {
    ok: history.ok,
    entry: projectLearnedEntry(updated),
    substrateRecord: substrateRecord
      ? {
          id: substrateRecord.id,
          kind: substrateRecord.kind,
        }
      : null,
    history,
  };
}

async function listLearnedEntriesRoute({ dataDir, searchParams }, httpError) {
  const status = optionalString(searchParams.get('status'));
  if (status && !LEARNED_STATUSES.has(status)) throw httpError(400, 'invalid_learned_status');
  const entries = (await listBuildJsonFiles(dataDir, BUILD_LEARNED_DIR))
    .map(projectLearnedEntry)
    .filter(Boolean)
    .filter((entry) => !status || entry.status === status)
    .sort(compareCreatedDesc);
  return {
    ok: true,
    count: entries.length,
    entries,
  };
}

async function readLearnedEntry(dataDir, id) {
  try {
    return projectLearnedEntry(
      JSON.parse(await fs.readFile(buildJsonFile(dataDir, BUILD_LEARNED_DIR, `${id}.json`), 'utf8')),
    );
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function projectLearnedEntry(record) {
  if (!isPlainObject(record)) return null;
  const status = optionalString(record.status ?? record.consent?.state) ?? 'pending';
  if (!LEARNED_STATUSES.has(status)) return null;
  return stripUndefined({
    kind: 'BuildLearnedEntry',
    schemaVersion: 1,
    id: optionalString(record.id),
    planId: optionalString(record.planId),
    unitId: optionalString(record.unitId),
    category: optionalString(record.category),
    label: optionalString(record.label),
    text: optionalString(record.text),
    evidenceIds: routeStringArray(record.evidenceIds),
    source: optionalString(record.source),
    status,
    consent: {
      state: status,
      decision: optionalString(record.consent?.decision),
      decidedAt: optionalString(record.consent?.decidedAt),
    },
    substrateRecordId: optionalString(record.substrateRecordId),
    createdAt: optionalString(record.createdAt),
    updatedAt: optionalString(record.updatedAt),
  });
}

async function pairTrustVerdict({ store, cardStore, dataDir, now, payload }, httpError) {
  if (!isPlainObject(payload)) throw httpError(400, 'invalid_trust_pair_payload');
  rejectClientPathFields(payload, httpError);

  const cardId = requiredBuildRef(payload.cardId ?? payload.id, 'cardId', httpError);
  const card = await cardStore.loadCard(cardId);
  if (!card) throw httpError(404, 'card_not_found');
  const verdict = normalizeTrustVerdict(payload.verdict ?? payload, httpError);
  const decision = cardDecision(card);
  const agreement = decision.optionId && verdict.recommendedOptionId
    ? decision.optionId === verdict.recommendedOptionId
    : null;
  const createdAt = iso(currentNow(now));
  const id = `trust_${sha256([
    cardId,
    verdict.verdict,
    verdict.recommendedOptionId ?? '',
    decision.optionId ?? '',
    createdAt,
  ].join('\n')).slice(0, 16)}`;
  const pair = {
    kind: 'BuildTrustPair',
    schemaVersion: 1,
    id,
    cardId,
    planId: card.planId,
    unitId: card.unitId,
    laneId: card.laneId,
    verdict,
    decision,
    agreement,
    createdAt,
    updatedAt: createdAt,
  };

  await atomicWriteJson(buildJsonFile(dataDir, BUILD_TRUST_DIR, `${id}.json`), pair);
  const history = await store.appendHistory({
    kind: 'build.trust.paired',
    trustPairId: id,
    cardId,
    planId: card.planId,
    agreement,
    at: createdAt,
  });

  return {
    ok: history.ok,
    pair: projectTrustPair(pair),
    history,
  };
}

async function trustViewRoute({ dataDir, searchParams }, httpError) {
  const limit = limitParam(searchParams, 'limit', 100, 500);
  const pairs = (await listBuildJsonFiles(dataDir, BUILD_TRUST_DIR))
    .map(projectTrustPair)
    .filter(Boolean)
    .sort(compareCreatedDesc)
    .slice(0, limit);
  return {
    ok: true,
    summary: trustSummary(pairs),
    pairs,
  };
}

function normalizeTrustVerdict(value, httpError) {
  if (!isPlainObject(value)) throw httpError(400, 'invalid_trust_verdict');
  const verdict = requiredRouteString(value.verdict ?? value.label ?? value.conclusion, 'verdict', httpError);
  const recommendedOptionId = optionalString(value.recommendedOptionId ?? value.optionId ?? value.recommendation);
  if (recommendedOptionId) assertBuildRef(recommendedOptionId, 'recommendedOptionId', httpError);
  return stripUndefined({
    verdict: boundRouteText(verdict, 80),
    recommendedOptionId,
    reasoning: optionalString(value.reasoning ?? value.reason)
      ? boundRouteText(value.reasoning ?? value.reason, 2000)
      : undefined,
    confidence: finiteUnitNumber(value.confidence),
    source: optionalString(value.source),
  });
}

function cardDecision(card) {
  return stripUndefined({
    optionId: optionalString(card.answerOption ?? card.optionId),
    answeredBy: optionalString(card.answeredBy),
    answeredAt: optionalString(card.answeredAt),
    status: optionalString(card.status),
  });
}

function projectTrustPair(record) {
  if (!isPlainObject(record)) return null;
  return stripUndefined({
    kind: 'BuildTrustPair',
    schemaVersion: 1,
    id: optionalString(record.id),
    cardId: optionalString(record.cardId),
    planId: optionalString(record.planId),
    unitId: optionalString(record.unitId),
    laneId: optionalString(record.laneId),
    verdict: isPlainObject(record.verdict) ? normalizeTrustVerdictForProjection(record.verdict) : undefined,
    decision: isPlainObject(record.decision) ? cardDecision(record.decision) : undefined,
    agreement: typeof record.agreement === 'boolean' ? record.agreement : null,
    createdAt: optionalString(record.createdAt),
    updatedAt: optionalString(record.updatedAt),
  });
}

function normalizeTrustVerdictForProjection(value) {
  return stripUndefined({
    verdict: optionalString(value.verdict),
    recommendedOptionId: optionalString(value.recommendedOptionId),
    reasoning: optionalString(value.reasoning),
    confidence: finiteUnitNumber(value.confidence),
    source: optionalString(value.source),
  });
}

function trustSummary(pairs) {
  const paired = pairs.filter((pair) => typeof pair.agreement === 'boolean');
  const agreements = paired.filter((pair) => pair.agreement).length;
  const disagreements = paired.length - agreements;
  return {
    total: paired.length,
    agreements,
    disagreements,
    agreementRate: paired.length === 0 ? null : Number((agreements / paired.length).toFixed(3)),
    streak: agreementStreak(paired),
  };
}

function agreementStreak(pairs) {
  let streak = 0;
  for (const pair of pairs) {
    if (pair.agreement !== true) break;
    streak += 1;
  }
  return streak;
}

function statusText(event) {
  const kind = optionalString(event.kind) ?? 'build.status';
  const subject = optionalString(event.subject) ?? 'build';
  const status = optionalString(event.status);
  const from = optionalString(event.from);
  const reason = optionalString(event.reason);
  const transition = from && status ? `${from} -> ${status}` : status;
  return [
    kind,
    subject,
    transition,
    reason ? `reason: ${reason}` : null,
  ].filter(Boolean).join(' ');
}

function transitionPayload(payload, httpError) {
  if (!isPlainObject(payload)) throw httpError(400, 'invalid_transition_payload');
  rejectClientPathFields(payload, httpError);

  const planId = optionalString(payload.planId);
  const to = optionalString(payload.to ?? payload.state);
  const actor = optionalString(payload.actor);
  if (!planId) throw httpError(400, 'missing_planId');
  if (!to) throw httpError(400, 'missing_to');
  if (!actor) throw httpError(400, 'missing_actor');

  return stripUndefined({
    planId,
    unitId: optionalString(payload.unitId),
    to,
    actor,
    laneId: optionalString(payload.laneId),
    checkpointSha: optionalString(payload.checkpointSha),
    reason: optionalString(payload.reason),
  });
}

function lanePayload(payload, httpError, now) {
  if (!isPlainObject(payload)) throw httpError(400, 'invalid_lane_payload');
  rejectClientPathFields(payload, httpError);

  const source = isPlainObject(payload.lane) ? payload.lane : payload;
  rejectClientPathFields(source, httpError);

  const id = optionalString(source.id ?? source.laneId);
  const unitId = optionalString(source.unitId ?? payload.unitId);
  const state = optionalString(source.state ?? payload.state);
  if (!id) throw httpError(400, 'missing_laneId');
  if (!unitId) throw httpError(400, 'missing_unitId');
  if (!state) throw httpError(400, 'missing_state');

  let lane;
  try {
    lane = normalizeLaneRecord({
      ...source,
      id,
      unitId,
      state,
      updatedAt: optionalString(source.updatedAt) ?? iso(currentNow(now)),
    });
  } catch {
    throw httpError(400, 'invalid_lane_payload');
  }

  const planId = optionalString(payload.planId);
  const actor = optionalString(payload.actor);
  const to = optionalString(payload.to ?? state);
  const transition = transitionPayload({
    planId,
    unitId,
    to,
    actor,
    laneId: id,
    checkpointSha: payload.checkpointSha,
    reason: payload.reason,
  }, httpError);

  return { lane, transition };
}

function answerPayload(payload, httpError) {
  if (!isPlainObject(payload)) throw httpError(400, 'invalid_card_answer_payload');
  rejectClientPathFields(payload, httpError);

  const cardId = optionalString(payload.cardId ?? payload.id);
  const optionId = optionalString(payload.optionId);
  if (!cardId) throw httpError(400, 'missing_cardId');
  if (!optionId) throw httpError(400, 'missing_optionId');

  return stripUndefined({
    cardId,
    optionId,
    surface: optionalString(payload.surface),
  });
}

function buildRequestPayload(payload, httpError, now) {
  if (!isPlainObject(payload)) throw httpError(400, 'invalid_build_request_payload');
  rejectClientPathFields(payload, httpError);

  const intent = optionalString(payload.intent ?? payload.text ?? payload.request);
  if (!intent) throw httpError(400, 'missing_intent');
  if (intent.length > 2_000) throw httpError(413, 'intent_too_large');

  const timestamp = iso(currentNow(now));
  const requestId = optionalString(payload.requestId ?? payload.id) ??
    generatedBuildId('request', intent, timestamp);
  const planId = optionalString(payload.planId) ??
    generatedBuildId('plan', intent, timestamp);
  const openFlags = Array.isArray(payload.openFlags)
    ? payload.openFlags.filter(isPlainObject)
    : [];

  return {
    intent,
    requestId,
    planId,
    openFlags,
    surface: optionalString(payload.surface),
  };
}

function founderActionPayload(payload, httpError) {
  if (!isPlainObject(payload)) throw httpError(400, 'invalid_founder_action_payload');
  rejectClientPathFields(payload, httpError);

  const planId = optionalString(payload.planId);
  const action = normalizeFounderAction(payload.action ?? payload.intent);
  if (!planId) throw httpError(400, 'missing_planId');
  if (!action) throw httpError(400, 'invalid_founder_action');
  if (action === 'kill' && payload.confirm !== true) {
    throw httpError(400, 'kill_confirmation_required');
  }

  return stripUndefined({
    planId,
    unitId: optionalString(payload.unitId),
    laneId: optionalString(payload.laneId),
    action,
    target: targetForFounderAction(action),
    reason: optionalString(payload.reason) ?? `founder ${action}`,
    surface: optionalString(payload.surface),
  });
}

function shapingForIntent(intent) {
  const words = intentWords(intent);
  const vague = /^(?:dashboard|app|page|fix|improve|build|ship|make it better|do it|this|that)$/i
    .test(intent.trim());
  if (words.length >= 4 && !vague) return null;

  return {
    question: 'What should this build change first, and how will I know it worked?',
    recommendedAnswer: recommendedShapingAnswer(intent),
    specCountdown: {
      remaining: 1,
      total: 3,
    },
    deferredIdeas: [],
  };
}

function shapingCardInput({ requestId, intent, shaping, now }) {
  return {
    kind: BUILD_CARD_KIND_SHAPING,
    tier: undefined,
    planId: requestId,
    requestId,
    intent,
    title: 'Shape build request',
    body: [
      'One blocking question:',
      shaping.question,
      '',
      `Recommended answer: ${shaping.recommendedAnswer}`,
      `Spec countdown: ${shaping.specCountdown.remaining}/${shaping.specCountdown.total}`,
    ].join('\n'),
    options: [
      {
        id: 'accept-recommendation',
        label: 'Use recommendation',
        consequence: 'Draft from K\'s recommended answer.',
      },
      {
        id: 'answer',
        label: 'Answer',
        consequence: 'Use your answer as the next build request.',
      },
      {
        id: 'defer',
        label: 'Defer',
        consequence: 'Leave this request shaped but not drafted.',
      },
    ],
    recommendation: 'accept-recommendation',
    shaping,
    createdAt: iso(now ?? new Date()),
  };
}

async function transitionFounderAction(store, input, now) {
  const plan = await store.loadPlan(input.planId);
  if (!plan) throw new BuildStateError(`plan not found: ${input.planId}`, { code: 'plan_not_found' });

  const from = stateForFounderAction(plan, input);
  if (from === input.target) return [];

  const transitions = [];
  const run = async (source, target, reason) => {
    const result = await store.transition({
      planId: input.planId,
      unitId: input.unitId,
      to: target,
      actor: FOUNDER_ACTOR,
      laneId: input.laneId,
      reason,
      now: currentNow(now),
    });
    const transition = {
      from: source,
      to: target,
      reason,
      plan: result.plan,
      history: result.history,
      at: iso(currentNow(now)),
    };
    transitions.push(transition);
    return transition;
  };

  if (canTransition(from, input.target)) {
    await run(from, input.target, input.reason);
    return transitions;
  }

  if (input.target !== BUILD_STATE_HELD && from !== BUILD_STATE_HELD && canTransition(from, BUILD_STATE_HELD)) {
    await run(from, BUILD_STATE_HELD, `${input.reason} (hold first)`);
    if (canTransition(BUILD_STATE_HELD, input.target)) {
      await run(BUILD_STATE_HELD, input.target, input.reason);
      return transitions;
    }
  }

  throw new TransitionError(`illegal founder action transition: ${from} -> ${input.target}`, {
    code: 'illegal_action_transition',
  });
}

function stateForFounderAction(plan, input) {
  if (!input.unitId) return plan.status;
  const unit = plan.units.find((candidate) => candidate.id === input.unitId);
  if (!unit) throw new BuildStateError(`unit not found: ${input.unitId}`, { code: 'unit_not_found' });
  return unit.state;
}

function normalizeFounderAction(value) {
  const action = optionalString(value)?.toLowerCase();
  switch (action) {
    case 'pause':
    case 'hold':
      return 'pause';
    case 'kill':
      return 'kill';
    case 'cancel':
    case 'reject':
      return 'cancel';
    case 'quarantine':
      return 'quarantine';
    case 'retry':
    case 'bounded-retry':
      return 'retry';
    default:
      return null;
  }
}

function targetForFounderAction(action) {
  switch (action) {
    case 'pause':
      return BUILD_STATE_HELD;
    case 'kill':
      return BUILD_STATE_KILLED;
    case 'cancel':
      return BUILD_STATE_CANCELLED;
    case 'quarantine':
      return BUILD_STATE_QUARANTINED;
    case 'retry':
      return BUILD_STATE_ORPHANED;
    default:
      return null;
  }
}

function laneLogPathForRead(dataDir, lane, httpError) {
  const raw = optionalString(lane.logPath);
  if (!raw) throw httpError(404, 'lane_log_not_found');

  const root = path.resolve(dataDir, LANE_LOG_ROOT);
  const resolved = path.resolve(path.isAbsolute(raw) ? raw : path.join(dataDir, raw));
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw httpError(400, 'invalid_log_path');
  }
  return resolved;
}

async function readLogTail(file, limit, httpError) {
  let stat;
  try {
    stat = await fs.stat(file);
  } catch (error) {
    if (error?.code === 'ENOENT') throw httpError(404, 'lane_log_not_found');
    throw error;
  }
  if (!stat.isFile()) throw httpError(400, 'invalid_log_path');

  const logSize = stat.size;
  const bytes = Math.min(positiveInteger(limit, DEFAULT_LOG_TAIL_BYTES), logSize);
  if (bytes === 0) {
    return {
      bytes: 0,
      logSize,
      truncated: false,
      text: '',
    };
  }

  const handle = await fs.open(file, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    await handle.read(buffer, 0, bytes, logSize - bytes);
    return {
      bytes,
      logSize,
      truncated: logSize > bytes,
      text: buffer.toString('utf8'),
    };
  } finally {
    await handle.close();
  }
}

async function routeMutation(fn, httpError) {
  try {
    return await fn();
  } catch (error) {
    throw buildRouteError(error, httpError);
  }
}

function buildRouteError(error, httpError) {
  if (error?.expose === true && Number.isInteger(error.statusCode)) return error;
  if (error instanceof InvalidChannelError) {
    return httpError(403, optionalString(error.code) ?? 'loopback_required');
  }
  if (error instanceof BuildCardError) {
    const code = optionalString(error.code) ?? 'invalid_build_card';
    const status = code.endsWith('_not_found') ? 404 : 400;
    return httpError(status, code);
  }
  if (error instanceof BuildDraftError) {
    const code = optionalString(error.code) ?? 'invalid_build_draft';
    const status = code.endsWith('_not_found') ? 404 : 422;
    return httpError(status, code);
  }
  if (error instanceof OwnershipError) {
    return httpError(409, optionalString(error.code) ?? 'ownership_conflict');
  }
  if (error instanceof TransitionError) {
    return httpError(400, optionalString(error.code) ?? 'illegal_transition');
  }
  if (error instanceof BuildStateError) {
    const code = optionalString(error.code) ?? 'invalid_build_state';
    const status = code.endsWith('_not_found') ? 404 : 400;
    return httpError(status, code);
  }
  return httpError(400, 'invalid_build_payload');
}

function assertSameMachine(request, deps, httpError) {
  if (sameMachineRequest(request, deps)) return;
  throw httpError(403, 'loopback_required');
}

function sameMachineRequest(request, deps) {
  return typeof deps.isSameMachine === 'function' && deps.isSameMachine(request) === true;
}

function projectCardRecord(card) {
  return stripUndefined({
    id: card.id,
    kind: card.kind,
    planId: card.planId,
    unitId: card.unitId,
    laneId: card.laneId,
    tier: card.tier,
    title: card.title,
    body: card.body,
    text: card.body,
    options: card.options,
    recommendation: card.recommendation,
    requestId: card.requestId,
    intent: card.intent,
    action: card.action,
    shaping: card.shaping,
    status: card.status,
    severity: severityForCardKind(card.kind),
    raisedAt: card.raisedAt,
    queuedAt: card.queuedAt,
    notifiedAt: card.notifiedAt,
    answeredBy: card.answeredBy,
    answeredAt: card.answeredAt,
    answerOption: card.answerOption,
    answerSurface: card.answerSurface,
    appliedAt: card.appliedAt,
    appliedBy: card.appliedBy,
    applyFailedAt: card.applyFailedAt,
    applyFailureReason: card.applyFailureReason,
    reRaisedAt: card.reRaisedAt,
    obsoletedAt: card.obsoletedAt,
    supersededBy: card.supersededBy,
    supersededById: card.supersededById,
    eventSeq: card.eventSeq,
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
  });
}

function severityForCardKind(kind) {
  return kind === 'safety-floor' || kind === 'line-stop'
    ? 'safety-floor'
    : 'normal';
}

function projectPlan(plan, options = {}) {
  const unitLimit = positiveInteger(options.unitLimit, DEFAULT_UNIT_LIMIT_PER_PLAN);
  return {
    id: plan.id,
    title: plan.title,
    status: plan.status,
    lease: plan.lease,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    units: plan.units.slice(0, unitLimit).map(projectUnit),
  };
}

function projectPreCheck(preCheck = {}) {
  return stripUndefined({
    ok: preCheck.ok,
    status: preCheck.status,
    staged: preCheck.staged,
    recommendation: preCheck.recommendation,
    reasons: Array.isArray(preCheck.reasons) ? [...preCheck.reasons] : undefined,
    scope: preCheck.scope,
    track: preCheck.track,
    reasoning: preCheck.reasoning,
  });
}

function projectUnit(unit) {
  return {
    id: unit.id,
    state: unit.state,
    scope: unit.scope,
    goal: unit.goal,
    laneId: unit.laneId,
    checkpointSha: unit.checkpointSha,
    createdAt: unit.createdAt,
    updatedAt: unit.updatedAt,
  };
}

function projectUnitWithPlan(plan, unitId) {
  const unit = plan.units.find((candidate) => candidate.id === unitId);
  return unit ? { ...projectUnit(unit), planId: plan.id } : undefined;
}

function projectLane(lane) {
  return {
    id: lane.id,
    unitId: lane.unitId,
    pid: lane.pid,
    startTime: lane.startTime,
    logPath: lane.logPath,
    worktreePath: lane.worktreePath,
    state: lane.state,
    createdAt: lane.createdAt,
    updatedAt: lane.updatedAt,
  };
}

function openSseStream(response) {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });
}

function startSseKeepAlive(response, intervalMs) {
  const ms = Number(intervalMs);
  if (!Number.isFinite(ms) || ms <= 0) return () => {};

  const interval = setInterval(() => {
    if (response.writableEnded || response.destroyed) return;
    try {
      response.write(': ping\n\n');
    } catch {
      // A disconnect races with the close watcher.
    }
  }, Math.floor(ms));
  if (typeof interval.unref === 'function') interval.unref();

  return () => clearInterval(interval);
}

function watchClientDisconnect(request, response, onDisconnect) {
  let done = false;
  const disconnect = () => {
    if (done) return;
    done = true;
    onDisconnect();
  };
  const watchers = [
    [request, 'aborted', disconnect],
    [request, 'close', disconnect],
    [response, 'close', disconnect],
  ].filter(([emitter]) => typeof emitter?.on === 'function');

  for (const [emitter, event, handler] of watchers) {
    emitter.on(event, handler);
  }

  return () => {
    for (const [emitter, event, handler] of watchers) {
      if (typeof emitter.off === 'function') emitter.off(event, handler);
      else if (typeof emitter.removeListener === 'function') emitter.removeListener(event, handler);
    }
  };
}

function requestSearchParams(request) {
  try {
    return new URL(request?.url ?? '/', 'http://localhost').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function limitParam(searchParams, name, fallback, max) {
  const raw = searchParams?.get?.(name);
  if (raw === null || raw === undefined || raw === '') return fallback;
  const number = Number(raw);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.min(Math.floor(number), max);
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function generatedBuildId(prefix, text, timestamp) {
  const day = iso(timestamp).slice(0, 10).replaceAll('-', '');
  const suffix = slug(text).slice(0, 80) || 'request';
  return `${prefix}-${day}-${suffix}`.slice(0, 120);
}

function slug(value) {
  return (optionalString(value) ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function intentWords(intent) {
  return (optionalString(intent) ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function recommendedShapingAnswer(intent) {
  const focus = (optionalString(intent) ?? 'this request').trim();
  return `Draft the smallest scoped change for "${focus}" with one visible outcome and one regression test.`;
}

function compareUpdatedDesc(left, right) {
  return timestampMs(right.updatedAt ?? right.createdAt) - timestampMs(left.updatedAt ?? left.createdAt);
}

function sortOpenCards(cards) {
  return cards.sort((left, right) => {
    const severityDelta = severityRank(left.severity) - severityRank(right.severity);
    if (severityDelta !== 0) return severityDelta;
    return timestampMs(left.raisedAt ?? left.updatedAt) - timestampMs(right.raisedAt ?? right.updatedAt);
  });
}

function severityRank(value) {
  return SEVERITY_RANK.get(optionalString(value) ?? 'normal') ?? SEVERITY_RANK.get('normal');
}

function timestampMs(value) {
  const ms = new Date(value ?? 0).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function currentNow(now) {
  return typeof now === 'function' ? now() : now ?? new Date();
}

function buildJsonFile(dataDir, relDir, filename) {
  return safeDataPath(dataDir, path.join(relDir, filename));
}

async function listBuildJsonFiles(dataDir, relDir) {
  const dir = safeDataPath(dataDir, relDir);
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const records = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      records.push(JSON.parse(await fs.readFile(path.join(dir, entry.name), 'utf8')));
    } catch {
      // Corrupt optional build-side artifacts degrade to silence, matching the
      // artifact reader contract in the daemon server.
    }
  }
  return records;
}

function parseUnifiedDiffForDisplay(diffText) {
  const files = [];
  let current = null;
  let currentHunk = null;
  let oldLine = 0;
  let newLine = 0;

  const finishFile = () => {
    if (!current) return;
    if (currentHunk) current.hunks.push(currentHunk);
    files.push(current);
  };

  for (const rawLine of String(diffText ?? '').split('\n')) {
    if (rawLine.startsWith('diff --git ')) {
      finishFile();
      current = {
        path: null,
        language: null,
        additions: 0,
        deletions: 0,
        hunks: [],
      };
      currentHunk = null;
      oldLine = 0;
      newLine = 0;
      continue;
    }

    if (!current) {
      current = {
        path: null,
        language: null,
        additions: 0,
        deletions: 0,
        hunks: [],
      };
    }

    if (rawLine.startsWith('+++ ')) {
      current.path = normalizeDiffFile(rawLine.slice(4));
      current.language = languageForPath(current.path);
      continue;
    }

    if (rawLine.startsWith('@@ ')) {
      if (currentHunk) current.hunks.push(currentHunk);
      const match = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(rawLine);
      oldLine = match ? Number(match[1]) : 0;
      newLine = match ? Number(match[2]) : 0;
      currentHunk = {
        header: rawLine,
        oldStart: oldLine || null,
        newStart: newLine || null,
        lines: [],
      };
      continue;
    }

    if (!currentHunk) continue;

    if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
      currentHunk.lines.push({
        kind: 'add',
        oldLine: null,
        newLine: newLine || null,
        text: rawLine.slice(1),
      });
      current.additions += 1;
      newLine += 1;
      continue;
    }

    if (rawLine.startsWith('-') && !rawLine.startsWith('---')) {
      currentHunk.lines.push({
        kind: 'delete',
        oldLine: oldLine || null,
        newLine: null,
        text: rawLine.slice(1),
      });
      current.deletions += 1;
      oldLine += 1;
      continue;
    }

    if (rawLine.startsWith(' ')) {
      currentHunk.lines.push({
        kind: 'context',
        oldLine: oldLine || null,
        newLine: newLine || null,
        text: rawLine.slice(1),
      });
      oldLine += 1;
      newLine += 1;
    }
  }

  finishFile();
  return files
    .filter((file) => optionalString(file.path))
    .map((file) => ({
      ...file,
      path: file.path,
      language: file.language ?? 'text',
    }));
}

function normalizeDiffFile(value) {
  const file = optionalString(value);
  if (!file || file === '/dev/null') return null;
  return normalizeRelPath(file.replace(/^[ab]\//, ''));
}

function normalizeRelPath(value) {
  const text = optionalString(value);
  if (!text) return '';
  const normalized = path.normalize(text).replaceAll('\\', '/').replace(/^\/+/, '');
  if (normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) return '';
  return normalized;
}

function languageForPath(value) {
  const ext = path.extname(optionalString(value) ?? '').toLowerCase();
  switch (ext) {
    case '.md':
    case '.markdown':
      return 'markdown';
    case '.mjs':
    case '.js':
    case '.jsx':
    case '.ts':
    case '.tsx':
      return 'javascript';
    case '.json':
      return 'json';
    case '.css':
      return 'css';
    case '.html':
      return 'html';
    case '.swift':
      return 'swift';
    case '.py':
      return 'python';
    default:
      return 'text';
  }
}

function requiredRouteString(value, field, httpError) {
  const text = optionalString(value);
  if (!text) throw httpError(400, `missing_${field}`);
  return text;
}

function requiredBuildRef(value, field, httpError) {
  return assertBuildRef(requiredRouteString(value, field, httpError), field, httpError);
}

function optionalBuildRef(value, field, httpError) {
  const text = optionalString(value);
  return text ? assertBuildRef(text, field, httpError) : undefined;
}

function assertBuildRef(value, field, httpError) {
  const text = optionalString(value);
  if (!text || !BUILD_REF_ID_PATTERN.test(text)) {
    throw httpError(400, `invalid_${field}`);
  }
  return text;
}

function assertRouteId(value, pattern, code, httpError) {
  const text = optionalString(value);
  if (!text || !pattern.test(text)) throw httpError(400, code);
  return text;
}

function routeStringArray(value) {
  const values = Array.isArray(value) ? value : optionalString(value) ? [value] : [];
  return Array.from(new Set(values.map((entry) => optionalString(entry)).filter(Boolean))).sort();
}

function evidenceDefaultLabel(kind) {
  if (kind === 'gate-output') return 'gate output';
  if (kind === 'transcript') return 'verification transcript';
  if (kind === 'image') return 'verification image';
  return 'verification evidence';
}

function boundRouteText(value, maxChars) {
  const clean = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length <= maxChars) return clean;
  const cut = clean.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trim()}...`;
}

function firstWords(value, limit) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .slice(0, limit)
    .join(' ');
}

function finiteUnitNumber(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  return Math.min(1, Math.max(0, number));
}

function compareCreatedDesc(left, right) {
  return timestampMs(right.createdAt ?? right.updatedAt) - timestampMs(left.createdAt ?? left.updatedAt) ||
    String(right.id ?? '').localeCompare(String(left.id ?? ''));
}

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function rejectClientPathFields(payload, httpError) {
  for (const field of ['path', 'file', 'relPath', 'targetPath', 'dataDir']) {
    if (Object.hasOwn(payload, field)) {
      throw httpError(400, 'client_path_not_allowed');
    }
  }
}

async function previousStateForTransition(store, input) {
  const plan = await store.loadPlan(input.planId);
  if (!plan) return undefined;
  if (!input.unitId) return plan.status;
  return plan.units.find((unit) => unit.id === input.unitId)?.state;
}
