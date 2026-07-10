import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  CADENCE_NUDGE_DISPOSITION_PATH,
  CADENCE_NUDGE_PLACEMENT_PATH,
  handleCadenceActsRoute,
} from '../../daemon/routes/cadence.mjs';
import {
  BUILD_CARD_KIND_DRIFT,
  BUILD_CARD_KIND_PLAN_APPROVAL,
  BUILD_CARD_TIER_TAILNET,
  buildCardCadenceNudgeId,
  buildCardCadenceNudges,
  createBuildCardStore,
} from './build-cards.mjs';
import {
  CADENCE_BLOCK_ACTS,
  CADENCE_NUDGE_DISPOSITIONS,
  createCadenceActStore,
  projectCadenceBlockLifecycle,
  projectNudgesOntoBlocks,
} from './cadence-acts.mjs';
import { ATTENTION_CATEGORY_CADENCE_NUDGE } from './attention-budget.mjs';

const fixedNow = () => new Date('2026-07-05T18:30:00.000Z');

test('per-block acts normalize complete, skip, +15, and first-answer TWS', async () => {
  const dataDir = await tempDataDir();
  const store = createCadenceActStore({ dataDir, now: fixedNow });

  const complete = await store.recordBlockAct({
    blockId: 'core-0900',
    date: '2026-07-05',
    action: 'complete',
  });
  const skip = await store.recordBlockAct({
    blockId: 'outer-1100',
    date: '2026-07-05',
    action: 'skip',
  });
  const extend = await store.recordBlockAct({
    blockId: 'core-0900',
    date: '2026-07-05',
    action: '+15',
  });
  const yes = await store.recordBlockAct({
    blockId: 'core-0900',
    date: '2026-07-05',
    action: 'tws_y',
  });
  const laterNo = await store.recordBlockAct({
    blockId: 'core-0900',
    date: '2026-07-05',
    action: 'tws_no',
  });

  assert.deepEqual(CADENCE_BLOCK_ACTS, [
    'start',
    'pause',
    'complete',
    'skip',
    'extend_15',
    'tws_yes',
    'tws_no',
    'no_response',
  ]);
  assert.equal(complete.record.outcome, 'completed');
  assert.equal(skip.record.outcome, 'skipped');
  assert.equal(extend.record.action, 'extend_15');
  assert.equal(extend.record.extensionMinutes, 15);
  assert.equal(yes.record.twsAnswer, true);
  assert.equal(laterNo.created, false);
  assert.equal(laterNo.conflict, true);
  assert.equal(laterNo.record.action, 'tws_yes');

  const summary = await store.summarizeBlockTws({ date: '2026-07-05', blockIds: ['core-0900', 'outer-1100'] });
  assert.deepEqual(summary, {
    date: '2026-07-05',
    totalBlocks: 2,
    answered: 1,
    wellSpent: 1,
    notWellSpent: 0,
    noResponse: 0,
    pending: 1,
    responseRate: 0.5,
    wellSpentRate: 1,
  });
});

test('start, pause, resume, and complete acts accrue lifecycle elapsed minutes', async () => {
  const dataDir = await tempDataDir();
  const store = createCadenceActStore({ dataDir, now: fixedNow });

  const start = await store.recordBlockAct({
    blockId: 'core-0900',
    date: '2026-07-05',
    action: 'start',
    eventAt: '2026-07-05T09:00:00.000Z',
  });
  const pause = await store.recordBlockAct({
    blockId: 'core-0900',
    date: '2026-07-05',
    action: 'pause',
    eventAt: '2026-07-05T09:25:00.000Z',
  });
  const resume = await store.recordBlockAct({
    blockId: 'core-0900',
    date: '2026-07-05',
    action: 'resume',
    eventAt: '2026-07-05T09:40:00.000Z',
  });
  const complete = await store.recordBlockAct({
    blockId: 'core-0900',
    date: '2026-07-05',
    action: 'complete',
    eventAt: '2026-07-05T10:00:00.000Z',
  });

  assert.equal(start.record.action, 'start');
  assert.equal(start.record.actionState, 'started');
  assert.equal(start.record.startedAt, '2026-07-05T09:00:00.000Z');
  assert.equal(start.record.elapsedMinutes, 0);
  assert.equal(pause.record.actionState, 'available');
  assert.equal(pause.record.startedAt, undefined);
  assert.equal(pause.record.elapsedMinutes, 25);
  assert.equal(resume.record.action, 'start');
  assert.equal(resume.record.actionState, 'started');
  assert.equal(resume.record.startedAt, '2026-07-05T09:40:00.000Z');
  assert.equal(resume.record.elapsedMinutes, 25);
  assert.equal(complete.record.actionState, 'completed');
  assert.equal(complete.record.elapsedMinutes, 45);

  const projected = projectCadenceBlockLifecycle({
    date: '2026-07-05',
    blocks: [block({ id: 'core-0900' })],
    acts: await store.listBlockActs({ date: '2026-07-05' }),
    now: '2026-07-05T10:30:00.000Z',
  });

  assert.equal(projected.blocks[0].actionState, 'completed');
  assert.equal(projected.blocks[0].startedAt, undefined);
  assert.equal(projected.blocks[0].elapsedMinutes, 45);
});

test('unanswered TWS queues evening backfill and then records explicit no-response', async () => {
  const dataDir = await tempDataDir();
  const store = createCadenceActStore({ dataDir, now: fixedNow });
  const blocks = [
    block({ id: 'core-0900' }),
    block({ id: 'middle-1130' }),
    block({ id: 'restore-2100' }),
  ];

  await store.recordBlockAct({
    blockId: 'core-0900',
    date: '2026-07-05',
    action: 'tws_no',
  });

  const queued = await store.queueEveningBackfill({
    date: '2026-07-05',
    blocks,
  });

  assert.deepEqual(queued.queued.map((item) => item.blockId), ['middle-1130', 'restore-2100']);
  assert.equal(queued.skippedAnswered, 1);
  assert.equal(queued.queued[0].status, 'pending');
  assert.equal(queued.queued[0].prompt, 'well spent?');

  await store.recordBlockAct({
    blockId: 'middle-1130',
    date: '2026-07-05',
    action: 'tws_yes',
  });

  const closed = await store.recordNoResponseOutcomes({
    date: '2026-07-05',
  });

  assert.deepEqual(closed.records.map((record) => [record.blockId, record.action]), [
    ['restore-2100', 'no_response'],
  ]);
  assert.deepEqual(closed.skippedAnswered, ['middle-1130']);

  const queue = await store.listEveningBackfillQueue({ date: '2026-07-05' });
  assert.deepEqual(
    queue.map((item) => [item.blockId, item.status]),
    [
      ['middle-1130', 'answered'],
      ['restore-2100', 'no_response'],
    ],
  );

  const summary = await store.summarizeBlockTws({
    date: '2026-07-05',
    blockIds: blocks.map((entry) => entry.id),
  });
  assert.deepEqual(summary, {
    date: '2026-07-05',
    totalBlocks: 3,
    answered: 2,
    wellSpent: 1,
    notWellSpent: 1,
    noResponse: 1,
    pending: 0,
    responseRate: 2 / 3,
    wellSpentRate: 0.5,
  });
});

test('nudge placement uses affected block, one-slot ranking, and suppress records', async () => {
  const dataDir = await tempDataDir();
  const store = createCadenceActStore({ dataDir, now: fixedNow });
  const blocks = [
    block({ id: 'core-0900' }),
    block({ id: 'outer-1400' }),
  ];
  const nudges = [
    nudge({ id: 'n_low', blockId: 'core-0900', score: 0.2, disposition: 'watch' }),
    nudge({ id: 'n_high', targetBlockId: 'core-0900', score: 0.9, disposition: 'act' }),
    nudge({ id: 'n_suppress', affectedBlockId: 'core-0900', score: 1, disposition: 'suppress' }),
    nudge({ id: 'n_other', blockId: 'outer-1400', score: 0.5, disposition: 'act' }),
  ];

  assert.deepEqual(CADENCE_NUDGE_DISPOSITIONS, ['act', 'watch', 'suppress']);

  const projected = await store.projectNudgesOntoBlocks({
    date: '2026-07-05',
    blocks,
    nudges,
  });

  assert.equal(projected.blocks[0].nudgeSlot.id, 'n_high');
  assert.equal(projected.blocks[0].nudgeSlot.blockId, 'core-0900');
  assert.equal(projected.blocks[0].nudgeSlot.disposition, 'act');
  assert.equal(projected.blocks[1].nudgeSlot.id, 'n_other');
  assert.deepEqual(
    projected.rankedByBlock['core-0900'].map((entry) => [entry.id, entry.placement]),
    [
      ['n_high', 'slot'],
      ['n_low', 'ranked_out'],
      ['n_suppress', 'suppressed'],
    ],
  );

  const suppressed = await store.listSuppressedToday({ date: '2026-07-05' });
  assert.deepEqual(suppressed.map((record) => [record.nudgeId, record.blockId, record.reason]), [
    ['n_suppress', 'core-0900', 'disposition_suppress'],
  ]);

  await store.recordNudgeDisposition({
    date: '2026-07-05',
    nudgeId: 'n_high',
    blockId: 'core-0900',
    disposition: 'suppress',
    reason: 'too_noisy',
  });

  const afterSuppress = await store.projectNudgesOntoBlocks({
    date: '2026-07-05',
    blocks,
    nudges,
  });

  assert.equal(afterSuppress.blocks[0].nudgeSlot.id, 'n_low');
  assert.deepEqual(
    (await store.listSuppressedToday({ date: '2026-07-05' })).map((record) => record.nudgeId).sort(),
    ['n_high', 'n_suppress'],
  );
});

test('cadence nudge placement queues over daily attention budget cap', async () => {
  const dataDir = await tempDataDir();
  const store = createCadenceActStore({
    dataDir,
    now: fixedNow,
    attentionBudgetCaps: { [ATTENTION_CATEGORY_CADENCE_NUDGE]: 1 },
  });
  const blocks = [
    block({ id: 'core-0900' }),
    block({ id: 'outer-1400' }),
  ];

  const projected = await store.projectNudgesOntoBlocks({
    date: '2026-07-05',
    blocks,
    nudges: [
      nudge({ id: 'n_high', blockId: 'core-0900', score: 0.9, disposition: 'act' }),
      nudge({ id: 'n_second', blockId: 'outer-1400', score: 0.8, disposition: 'act' }),
    ],
  });

  assert.equal(projected.blocks[0].nudgeSlot.id, 'n_high');
  assert.equal(Object.hasOwn(projected.blocks[1], 'nudgeSlot'), false);
  assert.equal(projected.rankedByBlock['outer-1400'][0].placement, 'queued');
  assert.equal(projected.rankedByBlock['outer-1400'][0].queuedUntil, '2026-07-06T06:00:00.000Z');
  assert.equal(projected.attentionBudget.queued.length, 1);
});

test('pure nudge projection is available without persistence', () => {
  const result = projectNudgesOntoBlocks({
    date: '2026-07-05',
    blocks: [block({ id: 'core-0900' })],
    nudges: [
      nudge({ id: 'watch', blockId: 'core-0900', score: 10, disposition: 'watch' }),
      nudge({ id: 'act', blockId: 'core-0900', score: 1, disposition: 'act' }),
    ],
  });

  assert.equal(result.blocks[0].nudgeSlot.id, 'act');
  assert.equal(result.blocks[0].nudgeSlot.rank, 1);
  assert.equal(result.blocks[0].nudgeSlot.totalCandidates, 2);
});

test('build cards project to cadence nudge candidates with explicit block and due-time relevance', async () => {
  const dataDir = await tempDataDir();
  const cardStore = createBuildCardStore({
    dataDir,
    now: fixedNow,
    randomSuffix: suffixer(),
  });
  const blocks = [
    cadenceBlock({ id: 'core-0900', startAt: '2026-07-05T09:00:00.000Z', endAt: '2026-07-05T10:00:00.000Z' }),
    cadenceBlock({ id: 'middle-1130', startAt: '2026-07-05T11:30:00.000Z', endAt: '2026-07-05T12:30:00.000Z' }),
    cadenceBlock({ id: 'outer-1400', startAt: '2026-07-05T14:00:00.000Z', endAt: '2026-07-05T15:00:00.000Z' }),
  ];

  const blockRelevant = await cardStore.raiseCard(buildCardInput({
    kind: BUILD_CARD_KIND_DRIFT,
    planId: 'plan-block',
    cadenceBlockId: 'middle-1130',
    recommendation: 'kill',
  }));
  const timeRelevant = await cardStore.raiseCard(buildCardInput({
    kind: BUILD_CARD_KIND_DRIFT,
    planId: 'plan-time',
    dueAt: '2026-07-05T14:15:00.000Z',
    recommendation: 'continue',
  }));
  await cardStore.raiseCard(buildCardInput({
    kind: BUILD_CARD_KIND_PLAN_APPROVAL,
    planId: 'plan-open-approval',
    cadenceBlockId: 'core-0900',
    recommendation: 'approve',
  }));
  const queued = await cardStore.raiseCard(buildCardInput({
    kind: BUILD_CARD_KIND_PLAN_APPROVAL,
    planId: 'plan-queued-approval',
    cadenceBlockId: 'core-0900',
    recommendation: 'approve',
  }));

  const nudges = buildCardCadenceNudges({
    cards: await cardStore.listCards(),
    blocks,
    date: '2026-07-05',
    now: '2026-07-05T10:05:00.000Z',
  });
  const byCardId = new Map(nudges.map((entry) => [entry.cardId, entry]));

  assert.equal(byCardId.get(blockRelevant.card.id).blockId, 'middle-1130');
  assert.equal(byCardId.get(blockRelevant.card.id).optionId, 'kill');
  assert.equal(byCardId.get(blockRelevant.card.id).act.path, CADENCE_NUDGE_DISPOSITION_PATH);
  assert.equal(byCardId.get(blockRelevant.card.id).act.routesTo.path, '/api/build/cards/answer');
  assert.equal(byCardId.get(timeRelevant.card.id).blockId, 'outer-1400');
  assert.equal(byCardId.has(queued.card.id), false);

  const projected = projectNudgesOntoBlocks({
    date: '2026-07-05',
    blocks,
    nudges: [
      nudge({ id: 'lower-score', blockId: 'middle-1130', score: 10, disposition: 'act' }),
      ...nudges,
    ],
  });
  assert.equal(projected.blocks[1].nudgeSlot.id, buildCardCadenceNudgeId(blockRelevant.card.id));
  assert.equal(projected.blocks[1].nudgeSlot.totalCandidates, 2);
});

test('cadence nudge placement injects build cards and act answers the card', async () => {
  const dataDir = await tempDataDir();
  const cadenceStore = createCadenceActStore({ dataDir, now: fixedNow });
  const cardStore = createBuildCardStore({
    dataDir,
    now: fixedNow,
    randomSuffix: suffixer(),
  });
  const blocks = [
    cadenceBlock({ id: 'core-0900', startAt: '2026-07-05T09:00:00.000Z', endAt: '2026-07-05T10:00:00.000Z' }),
  ];
  const raised = await cardStore.raiseCard(buildCardInput({
    kind: BUILD_CARD_KIND_DRIFT,
    planId: 'plan-cadence-answer',
    cadenceBlockId: 'core-0900',
    recommendation: 'kill',
  }));

  const placed = await dispatchCadenceActsRoute({
    dataDir,
    cadenceStore,
    buildCardStore: cardStore,
    method: 'POST',
    pathname: CADENCE_NUDGE_PLACEMENT_PATH,
    payload: {
      date: '2026-07-05',
      blocks,
    },
  });

  assert.equal(placed.status, 200);
  const slot = placed.body.blocks[0].nudgeSlot;
  assert.equal(slot.cardId, raised.card.id);
  assert.equal(slot.optionId, 'kill');
  assert.equal(slot.category, 'build-card');
  assert.equal(slot.act.body.disposition, 'act');
  assert.equal(slot.act.body.cardId, raised.card.id);

  const acted = await dispatchCadenceActsRoute({
    dataDir,
    cadenceStore,
    buildCardStore: cardStore,
    method: 'POST',
    pathname: CADENCE_NUDGE_DISPOSITION_PATH,
    payload: slot.act.body,
  });

  assert.equal(acted.status, 200);
  assert.equal(acted.body.record.disposition, 'act');
  assert.equal(acted.body.buildCardAnswer.card.id, raised.card.id);
  assert.equal(acted.body.buildCardAnswer.card.status, 'answered');
  assert.equal(acted.body.buildCardAnswer.card.answerOption, 'kill');
  assert.equal(acted.body.buildCardAnswer.card.answerSurface, 'cadence');
  assert.equal((await cardStore.loadCard(raised.card.id)).answerOption, 'kill');
  assert.deepEqual(
    (await cadenceStore.listNudgeDispositions({ date: '2026-07-05' })).map((record) => [
      record.nudgeId,
      record.disposition,
    ]),
    [[slot.id, 'act']],
  );
});

function block(input) {
  return {
    id: input.id,
    title: `${input.id} block`,
  };
}

function cadenceBlock(input) {
  return {
    ...block(input),
    startAt: input.startAt,
    endAt: input.endAt,
  };
}

function nudge(input) {
  return {
    id: input.id,
    title: input.id,
    score: input.score,
    disposition: input.disposition,
    blockId: input.blockId,
    targetBlockId: input.targetBlockId,
    affectedBlockId: input.affectedBlockId,
    createdAt: input.createdAt ?? '2026-07-05T08:00:00.000Z',
  };
}

function buildCardInput(overrides = {}) {
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

async function dispatchCadenceActsRoute(input) {
  const response = mockResponse();
  const deps = routeDeps(input);
  try {
    await handleCadenceActsRoute(
      mockRequest(input.payload),
      response,
      {
        method: input.method,
        pathname: input.pathname,
        dataDir: input.dataDir,
        now: fixedNow,
        cadenceStore: input.cadenceStore,
        buildCardStore: input.buildCardStore,
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

function routeDeps(input = {}) {
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
    isSameMachine: () => input.sameMachine === true,
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

function suffixer() {
  let index = 0;
  return () => {
    index += 1;
    return `r${index}`;
  };
}

async function tempDataDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-cadence-acts-'));
}
