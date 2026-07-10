import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import {
  AGUI_ACTION_INVOKE_TYPE,
  AGUI_EVENTS_PATH,
  AGUI_MESSAGE_PATH,
  AGUI_PACKET_PATCH_EVENT,
  handleAguiMessage,
} from '../daemon/routes/agui.mjs';
import {
  BUILD_CARD_ANSWER_PATH,
  BUILD_CARDS_PATH,
  BUILD_EVENTS_PATH,
  BUILD_PACKET_EVENT,
  BUILD_SNAPSHOT_EVENT,
  BUILD_STATE_PATH,
  createBuildEventEmitter,
  handleBuildRoute,
} from '../daemon/routes/build.mjs';
import {
  CADENCE_DAY_PATH,
  handleCadenceReviewRoute,
  handleCadenceRoute,
} from '../daemon/routes/cadence.mjs';
import {
  createHermesServer,
  cueContext,
} from '../daemon/server.mjs';
import {
  BUILD_STATE_BUILDING,
  BUILD_STATE_QUEUED,
  createBuildStateStore,
} from '../src/agent/build-state.mjs';
import {
  BUILD_CARD_KIND_DRIFT,
  BUILD_CARD_TIER_TAILNET,
  buildCardCadenceNudges,
  createBuildCardStore,
} from '../src/agent/build-cards.mjs';
import {
  computeCadenceNowNext,
  defaultCadenceDay,
} from '../src/agent/cadence-engine.mjs';
import { createCadenceActStore } from '../src/agent/cadence-acts.mjs';
import { saveCadenceRecalibrationAnchor } from '../src/agent/cadence-recalibrate.mjs';
import {
  CADENCE_REVIEW_CARDS_PATH,
  REVIEW_CARD_TYPE_VALUE_PROBE,
  createReviewCadenceStore,
} from '../src/agent/review-cadences.mjs';
import {
  whoopStatus,
  writeWhoopCursor,
  writeWhoopTokens,
} from '../src/ingest/whoop.mjs';
import { createSubstrateStore } from '../src/substrate.mjs';

export const CONTRACT_FIXTURE_REL_PATH = path.join('contracts', 'k-contract-fixture.json');
export const IOS_VENDOR_TARGET_HINT = path.join('cs-ios', 'Tests', 'Fixtures', 'k-contract-fixture.json');

const FIXTURE_GENERATED_AT = '2026-07-09T00:00:00.000Z';
const CADENCE_DATE = '2026-07-05';
const CADENCE_NOW = '2026-07-05T09:45:00.000Z';
const BUILD_NOW = '2026-07-04T00:00:00.000Z';
const REVIEW_NOW = '2026-07-06T09:00:00.000Z';
const BODY_NOW = '2026-06-29T12:00:00.000Z';
const WHOOP_NOW = '2026-07-09T00:10:00.000Z';

export async function generateContractFixture() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-contract-fixture-'));
  try {
    const [
      cadence,
      review,
      build,
      body,
      whoop,
      agui,
    ] = await Promise.all([
      cadenceContract(path.join(tempRoot, 'cadence')),
      reviewContract(path.join(tempRoot, 'review')),
      buildContract(path.join(tempRoot, 'build')),
      bodyContract(path.join(tempRoot, 'body')),
      whoopContract(path.join(tempRoot, 'whoop')),
      aguiContract(path.join(tempRoot, 'agui')),
    ]);

    return {
      kind: 'KContractFixture',
      schemaVersion: 1,
      generatedAt: FIXTURE_GENERATED_AT,
      source: 'cs-k',
      contracts: {
        cadence,
        review,
        build,
        body,
        whoop,
        agui,
      },
    };
  } finally {
    await cleanupTempRoot(tempRoot);
  }
}

export async function syncContractFixture(options = {}) {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const fixture = await generateContractFixture();
  const fixturePath = path.join(rootDir, CONTRACT_FIXTURE_REL_PATH);
  const iosCopyPath = options.iosCopyPath ??
    path.join(os.tmpdir(), 'cs-k-contracts', 'k-contract-fixture.json');

  await writeJsonFile(fixturePath, fixture);
  await writeJsonFile(iosCopyPath, fixture);

  return {
    fixturePath,
    iosCopyPath,
    iosVendorTargetHint: IOS_VENDOR_TARGET_HINT,
    fixture,
  };
}

async function cadenceContract(dataDir) {
  await fs.mkdir(dataDir, { recursive: true });
  const now = fixedNow(CADENCE_NOW);
  const store = createSubstrateStore({ dataDir, now });
  const cadenceStore = createCadenceActStore({ dataDir, now });

  const created = await invokeJsonRoute(handleCadenceRoute, {
    method: 'POST',
    url: CADENCE_DAY_PATH,
    payload: {
      date: CADENCE_DATE,
      bandish: [
        {
          startAt: '2026-07-05T09:00:00.000Z',
          endAt: '2026-07-05T10:00:00.000Z',
          attentionMode: 'converge',
          ring: 'core',
          description: 'Core build',
          type: 'work',
          why: 'the one thing that compounds',
        },
        {
          startAt: '2026-07-05T10:00:00.000Z',
          endAt: '2026-07-05T11:00:00.000Z',
          attentionMode: 'diverge',
          ring: 'middle',
          description: 'Exploration',
          type: 'work',
          why: 'turn the middle of the day into options',
        },
        {
          startAt: '2026-07-05T11:00:00.000Z',
          endAt: '2026-07-05T11:10:00.000Z',
          attentionMode: 'operative',
          ring: 'outer',
          description: 'Ops skim',
          type: 'ops',
          why: 'contain logistics outside the core',
        },
        {
          startAt: '2026-07-05T11:10:00.000Z',
          endAt: '2026-07-05T12:00:00.000Z',
          attentionMode: 'converge',
          ring: 'core',
          description: 'Second core',
          type: 'work',
          why: 'protect a second core block',
        },
      ],
      capacityByMode: {
        converge: 120,
        diverge: 60,
        operative: 30,
      },
    },
    dataDir,
    now,
    store,
  });
  const blockId = created.body.day.blocks[0].id;

  await cadenceStore.recordBlockAct({
    date: CADENCE_DATE,
    blockId,
    action: 'start',
    eventAt: '2026-07-05T09:05:00.000Z',
    source: 'contract-fixture',
  });
  await saveCadenceRecalibrationAnchor({
    dataDir,
    date: CADENCE_DATE,
    reason: 'wake-init',
    anchorAt: CADENCE_NOW,
    trigger: {
      type: 'act',
      action: 'wake_init',
      source: 'contract-fixture',
    },
  });

  const day = await invokeJsonRoute(handleCadenceRoute, {
    method: 'GET',
    url: `${CADENCE_DAY_PATH}?date=${CADENCE_DATE}`,
    dataDir,
    now,
    store,
    cadenceActStore: cadenceStore,
  });

  const nowNext = computeCadenceNowNext({
    day: defaultCadenceDay({
      date: CADENCE_DATE,
      now: '2026-07-05T05:00:00.000Z',
    }),
    now: '2026-07-05T09:30:00.000Z',
    trigger: { type: 'act', blockId: 'deep-0900-2026-07-05', action: 'start' },
    acts: [
      {
        date: CADENCE_DATE,
        blockId: 'deep-0900-2026-07-05',
        action: 'start',
        eventAt: '2026-07-05T09:05:00.000Z',
      },
    ],
  });

  return {
    daySnapshot: day.body,
    nowNextSnapshot: nowNext,
  };
}

async function reviewContract(dataDir) {
  await fs.mkdir(path.join(dataDir, 'substrate'), { recursive: true });
  await fs.writeFile(
    path.join(dataDir, 'substrate', 'user-model.md'),
    [
      '# Contract fixture user model',
      '',
      'This week the founder is balancing local sovereignty, cadence, and instrumented loop evidence.',
      'Attention should stay free unless a decision has earned surfacing.',
    ].join('\n'),
    'utf8',
  );

  const now = fixedNow(REVIEW_NOW);
  const reviewCadenceStore = createReviewCadenceStore({ dataDir, now });
  const substrateStore = createSubstrateStore({ dataDir, now });
  await reviewCadenceStore.generateCard(REVIEW_CARD_TYPE_VALUE_PROBE, {
    dataDir,
    date: '2026-07-06',
    now: REVIEW_NOW,
    substrateStore,
  });

  const cards = await invokeJsonRoute(handleCadenceReviewRoute, {
    method: 'GET',
    url: `${CADENCE_REVIEW_CARDS_PATH}?date=2026-07-06&type=${REVIEW_CARD_TYPE_VALUE_PROBE}`,
    dataDir,
    now,
    reviewCadenceStore,
    substrateStore,
  });

  return {
    valueProbeCard: cards.body.cards[0],
  };
}

async function buildContract(dataDir) {
  await fs.mkdir(dataDir, { recursive: true });
  const now = fixedNow(BUILD_NOW);
  const store = createBuildStateStore({ dataDir, now });
  const cardStore = createBuildCardStore({ dataDir, now, stateStore: store });
  const events = createBuildEventEmitter();

  await store.savePlan({
    id: 'plan-contract',
    title: 'Contract fixture plan',
    status: BUILD_STATE_QUEUED,
    units: [
      {
        id: 'unit-contract',
        state: BUILD_STATE_QUEUED,
        scope: { declared: ['contracts/k-contract-fixture.json'] },
        goal: 'Keep iOS contract fixture current.',
        laneId: 'lane-contract',
        createdAt: BUILD_NOW,
        updatedAt: BUILD_NOW,
      },
    ],
    lease: {
      owner: 'contract-fixture',
      acquiredAt: BUILD_NOW,
      renewedAt: BUILD_NOW,
      ttlMs: 60000,
    },
    createdAt: BUILD_NOW,
    updatedAt: BUILD_NOW,
  });
  await store.saveLane({
    id: 'lane-contract',
    unitId: 'unit-contract',
    pid: 4242,
    startTime: BUILD_NOW,
    logPath: 'logs/lane-contract.log',
    worktreePath: '/tmp/lane-contract',
    state: BUILD_STATE_BUILDING,
    createdAt: BUILD_NOW,
    updatedAt: BUILD_NOW,
  });
  const savedCard = await cardStore.saveCard({
    id: 'card-contract',
    kind: BUILD_CARD_KIND_DRIFT,
    tier: BUILD_CARD_TIER_TAILNET,
    planId: 'plan-contract',
    unitId: 'unit-contract',
    laneId: 'lane-contract',
    title: 'Pick the lane response',
    body: 'Contract fixture card body.',
    options: [
      {
        id: 'continue',
        label: 'Continue',
        consequence: 'Proceed with the current lane.',
      },
      {
        id: 'hold',
        label: 'Hold',
        consequence: 'Pause until founder review.',
      },
    ],
    recommendation: 'continue',
    status: 'notified',
    raisedAt: BUILD_NOW,
    notifiedAt: BUILD_NOW,
    eventSeq: 1,
    createdAt: BUILD_NOW,
    updatedAt: BUILD_NOW,
    cadenceBlockId: 'core-0900-2026-07-05',
  });

  const cards = await invokeJsonRoute(handleBuildRoute, {
    method: 'GET',
    url: BUILD_CARDS_PATH,
    dataDir,
    now,
    store,
    cardStore,
    events,
  });
  const snapshot = await invokeJsonRoute(handleBuildRoute, {
    method: 'GET',
    url: `${BUILD_STATE_PATH}?plans=1&lanes=1&cards=1&packets=1&units=1`,
    dataDir,
    now,
    store,
    cardStore,
    events,
  });
  const nudges = buildCardCadenceNudges({
    date: CADENCE_DATE,
    now: '2026-07-05T09:30:00.000Z',
    blocks: [
      {
        id: 'core-0900-2026-07-05',
        startAt: '2026-07-05T09:00:00.000Z',
        endAt: '2026-07-05T10:00:00.000Z',
      },
    ],
    cards: [savedCard],
  });

  return {
    routes: {
      cards: BUILD_CARDS_PATH,
      cardAnswer: BUILD_CARD_ANSWER_PATH,
      events: BUILD_EVENTS_PATH,
      state: BUILD_STATE_PATH,
    },
    events: {
      snapshot: BUILD_SNAPSHOT_EVENT,
      packet: BUILD_PACKET_EVENT,
    },
    card: cards.body.cards[0],
    cadenceNudge: nudges[0],
    buildSnapshotEnvelope: {
      event: BUILD_SNAPSHOT_EVENT,
      data: withoutOk(snapshot.body),
    },
  };
}

async function bodyContract(dataDir) {
  await fs.mkdir(dataDir, { recursive: true });
  const now = fixedNow(BODY_NOW);
  const store = createSubstrateStore({ dataDir, now });
  await store.writeFootprintSample({
    sampleId: 'contract-hrv-1',
    eventAt: '2026-06-29T07:00:00.000Z',
    provenance: { surface: 'body', lane: 'ambient' },
    phenomenology: { report: 'Contract HRV sample 1.' },
    physiology: { hrv: 30 },
  });
  await store.writeFootprintSample({
    sampleId: 'contract-hrv-2',
    eventAt: '2026-06-29T08:00:00.000Z',
    provenance: { surface: 'body', lane: 'ambient' },
    phenomenology: { report: 'Contract HRV sample 2.' },
    physiology: { hrv: 20 },
  });
  await store.writeFootprintSample({
    sampleId: 'contract-sleep-1',
    eventAt: '2026-06-29T06:00:00.000Z',
    provenance: { surface: 'body', lane: 'ambient' },
    phenomenology: { report: 'Contract sleep sample.' },
    outcome: {
      category: 'sleep',
      measurements: {
        sleepDuration: 390,
      },
    },
  });

  return {
    summary: await bodySummaryFromRoute({ dataDir, store, now }),
    cueContext: await cueContext({ store, dataDir, now }),
  };
}

async function whoopContract(dataDir) {
  await fs.mkdir(dataDir, { recursive: true });
  const env = {
    WHOOP_CLIENT_ID: 'contract-client',
    WHOOP_CLIENT_SECRET: 'contract-secret',
    WHOOP_REDIRECT_URI: 'http://127.0.0.1:3003/api/whoop/callback',
  };
  await writeWhoopTokens({
    dataDir,
    tokens: {
      accessToken: 'contract-access-token',
      refreshToken: 'contract-refresh-token',
      tokenType: 'Bearer',
      scope: 'read:recovery read:sleep',
      expiresAt: '2026-07-10T00:00:00.000Z',
      obtainedAt: '2026-07-09T00:00:00.000Z',
    },
  });
  await writeWhoopCursor({
    dataDir,
    cursor: {
      lastSyncAt: '2026-07-09T00:05:00.000Z',
      counts: {
        recovery: 1,
        sleep: 2,
        cycle: 3,
        workout: 4,
      },
    },
  });

  return {
    status: await whoopStatus({
      dataDir,
      env,
      now: fixedNow(WHOOP_NOW),
    }),
  };
}

async function aguiContract(dataDir) {
  await fs.mkdir(dataDir, { recursive: true });
  const response = new MockResponse();
  await handleAguiMessage(mockRequest({
    message: 'contract fixture',
    tools: false,
  }, {
    method: 'POST',
    url: AGUI_MESSAGE_PATH,
  }), response, {
    dataDir,
    runTurn: async ({ onToken }) => {
      onToken('fixture ');
      onToken('delta');
      return {
        content: 'fixture delta',
        lane: 'sovereign',
        sensitivity: 'sensitive',
        sovereign: true,
        steps: 0,
        held: [],
        provenance: {
          surface: 'verbatim-chat',
          lane: 'sovereign',
          plane: 'agent',
          module: 'contract-fixture',
        },
      };
    },
    keepAliveIntervalMs: 0,
  });
  const events = response.sseEvents();
  const packetEnvelopes = events.filter((event) => event.event === 'packet');
  const patchEnvelopes = events.filter((event) => event.event === AGUI_PACKET_PATCH_EVENT);

  return {
    paths: {
      message: AGUI_MESSAGE_PATH,
      events: AGUI_EVENTS_PATH,
    },
    actionInvokeType: AGUI_ACTION_INVOKE_TYPE,
    packetPatchEvent: AGUI_PACKET_PATCH_EVENT,
    packetEnvelope: packetEnvelopes.at(-1),
    packetEnvelopes,
    patchEnvelope: patchEnvelopes[0],
    patchEnvelopes,
    doneEnvelope: events.find((event) => event.event === 'done'),
  };
}

async function bodySummaryFromRoute({ dataDir, store, now }) {
  const server = createHermesServer({
    dataDir,
    store,
    now,
  });
  const requestListener = server.listeners('request')[0];
  const response = new MockResponse();
  requestListener(mockRequest(undefined, {
    method: 'GET',
    url: '/api/body/summary',
  }), response);
  await response.waitForEnd();
  return JSON.parse(response.body);
}

async function invokeJsonRoute(handler, input) {
  const url = new URL(input.url, 'http://127.0.0.1');
  const response = new MockResponse();
  const handled = await handler(
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
      now: input.now,
      store: input.store,
      substrateStore: input.substrateStore,
      cadenceStore: input.cadenceStore,
      cadenceActStore: input.cadenceActStore,
      reviewCadenceStore: input.reviewCadenceStore,
      buildStateStore: input.store,
      buildCardStore: input.cardStore,
      buildEvents: input.events,
      keepAliveIntervalMs: 0,
      recomputeCadenceNowNext: async () => {},
    },
    routeDeps(),
  );
  if (handled !== true) throw new Error(`route did not handle ${input.method} ${input.url}`);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`route failed ${input.method} ${input.url}: ${response.statusCode} ${response.body}`);
  }
  return {
    status: response.statusCode,
    body: JSON.parse(response.body),
  };
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
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) throw httpError(400, 'empty_json_body');
      try {
        return JSON.parse(raw);
      } catch {
        throw httpError(400, 'invalid_json');
      }
    },
    isSameMachine: () => true,
  };
}

function mockRequest(payload, options = {}) {
  const chunks = payload === undefined ? [] : [Buffer.from(JSON.stringify(payload), 'utf8')];
  const request = Readable.from(chunks);
  request.method = options.method ?? 'GET';
  request.url = options.url ?? '/';
  request.socket = { remoteAddress: '127.0.0.1' };
  return request;
}

class MockResponse {
  constructor() {
    this.statusCode = 200;
    this.headers = {};
    this.chunks = [];
    this.writableEnded = false;
    this.destroyed = false;
    this.headersSent = false;
    this.endPromise = new Promise((resolve) => {
      this.resolveEnd = resolve;
    });
  }

  setHeader(name, value) {
    this.headers[name.toLowerCase()] = value;
  }

  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    this.headersSent = true;
  }

  write(chunk = '') {
    this.chunks.push(Buffer.from(String(chunk), 'utf8'));
    return true;
  }

  end(chunk = '') {
    if (chunk) this.write(chunk);
    this.writableEnded = true;
    this.resolveEnd();
  }

  once() {}

  destroy() {
    this.destroyed = true;
    this.resolveEnd();
  }

  waitForEnd() {
    return this.endPromise;
  }

  get body() {
    return Buffer.concat(this.chunks).toString('utf8');
  }

  sseEvents() {
    return this.body
      .split('\n\n')
      .filter(Boolean)
      .filter((block) => !block.startsWith(': '))
      .map((block) => {
        const lines = block.split('\n');
        const event = lines.find((line) => line.startsWith('event: '))?.slice(7);
        const data = lines.find((line) => line.startsWith('data: '))?.slice(6);
        return {
          event,
          data: data ? JSON.parse(data) : null,
        };
      });
  }
}

async function writeJsonFile(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function cleanupTempRoot(tempRoot) {
  await fs.rm(tempRoot, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  }).catch(() => {});
}

function fixedNow(isoString) {
  return () => new Date(isoString);
}

function withoutOk(value) {
  const { ok: _ok, ...rest } = value;
  return rest;
}

function httpError(statusCode, code) {
  const error = new Error(code);
  error.statusCode = statusCode;
  error.code = code;
  error.expose = true;
  return error;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  syncContractFixture()
    .then((result) => {
      console.log(`contract fixture: ${result.fixturePath}`);
      console.log(`ios vendor copy: ${result.iosCopyPath}`);
      console.log(`ios vendor target hint (not written): ${result.iosVendorTargetHint}`);
    })
    .catch((error) => {
      console.error(`[cs-k] error: ${error.message}`);
      process.exitCode = 1;
    });
}
