import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  CADENCE_REVIEW_CARDS_PATH,
  CADENCE_TWS_BACKFILL_PATH,
  CADENCE_TWS_NO_RESPONSE_PATH,
  REVIEW_CARD_TYPE_EVENING,
  REVIEW_CARD_TYPE_MORNING,
  REVIEW_CARD_TYPE_WEEKLY_RETRO,
  collectTwsBackfill,
  createReviewCadenceStore,
  generateEveningReflectionCard,
  generateMorningOrientationCard,
  generateWeeklyRetroCard,
  persistTwsNoResponseOutcomes,
  recordTwsBackfillAnswers,
  renderReviewCadenceRoutineReport,
} from './review-cadences.mjs';
import {
  ATTENTION_CATEGORY_BODY_CUE,
  ATTENTION_CATEGORY_DREAMING_EDGE_CARD,
  admit as admitAttentionBudget,
} from './attention-budget.mjs';
import {
  CADENCE_RETRO_PATH,
  handleCadenceReviewRoute as handleCadenceRoute,
} from '../../daemon/routes/cadence.mjs';

const fixedNow = () => new Date('2026-07-06T21:00:00.000Z');

test('morning orientation card includes overnight, priority, and decision-needed sections', async () => {
  const dataDir = await tempDataDir();
  await writeDecision(dataDir, 'pending.json', {
    decision: 'Whether to stage the review cadence slice.',
    recommended: 'Stage the review cadence slice first.',
    reason: 'It unblocks morning and evening app cards.',
  });
  await writeJson(dataDir, path.join('review-cadences', 'overnight-queue', 'queue.json'), {
    id: 'overnight-1',
    kind: 'OvernightQueueItem',
    title: 'Check dreaming edge cards',
    status: 'open',
    createdAt: '2026-07-06T18:30:00.000Z',
  });
  admitAttentionBudget({
    category: ATTENTION_CATEGORY_BODY_CUE,
    id: 'body-budget-1',
    title: 'Body cue queued by budget',
    score: 0.9,
    eventAt: '2026-07-06T18:31:00.000Z',
  }, {
    dataDir,
    caps: { [ATTENTION_CATEGORY_BODY_CUE]: 0 },
    now: () => new Date('2026-07-06T18:31:00.000Z'),
  });
  admitAttentionBudget({
    category: ATTENTION_CATEGORY_DREAMING_EDGE_CARD,
    id: 'dream-budget-1',
    title: 'Dream edge queued for later night',
    score: 0.95,
    eventAt: '2026-07-06T18:32:00.000Z',
  }, {
    dataDir,
    caps: { [ATTENTION_CATEGORY_DREAMING_EDGE_CARD]: 0 },
    now: () => new Date('2026-07-06T18:32:00.000Z'),
  });

  const result = await generateMorningOrientationCard({
    dataDir,
    now: () => new Date('2026-07-07T06:00:00.000Z'),
  });

  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(result.card.type, REVIEW_CARD_TYPE_MORNING);
  assert.equal(result.card.date, '2026-07-07');
  assert.equal(result.card.title, 'morning orientation');
  assert.equal(result.card.sections.overnightSummary.length, 2);
  assert.equal(result.card.sections.priorities.length, 3);
  assert.equal(result.card.sections.decisionsNeeded.length, 1);
  assert.match(result.card.sections.decisionsNeeded[0].title, /review cadence/);
  assert.equal(
    result.card.sections.overnightSummary.some((item) => item.kind === 'attention-budget-queued'),
    true,
  );
  assert.equal(
    result.card.sections.overnightSummary.some((item) => item.title === 'Dream edge queued for later night'),
    false,
  );

  const stored = JSON.parse(await fs.readFile(path.join(dataDir, result.path.replace(/^data\//, '')), 'utf8'));
  assert.equal(stored.kind, 'ReviewCadenceCard');
  assert.equal(stored.status, 'open');
});

test('evening reflection card carries prompts and pending TWS backfill', async () => {
  const dataDir = await tempDataDir();
  await writeTwsPrompt(dataDir, 'block-a', {
    blockTitle: 'Deep work',
    askedAt: '2026-07-06T10:00:00.000Z',
  });
  await writeTwsPrompt(dataDir, 'block-b', {
    blockTitle: 'Ops',
    askedAt: '2026-07-06T11:00:00.000Z',
    status: 'answered',
    wellSpent: true,
  });

  const result = await generateEveningReflectionCard({
    dataDir,
    now: fixedNow,
  });

  assert.equal(result.card.type, REVIEW_CARD_TYPE_EVENING);
  assert.equal(result.card.title, 'evening reflection');
  assert.deepEqual(Object.keys(result.card.sections).sort(), [
    'blockers',
    'energy',
    'overnightQueue',
    'tomorrow',
    'wins',
  ]);
  assert.equal(result.card.sections.wins.label, 'wins');
  assert.equal(result.card.sections.wins.prompt, 'what was worth keeping?');
  assert.equal(result.card.sections.blockers.label, 'blockers');
  assert.equal(result.card.sections.blockers.prompt, 'what blocked the day?');
  assert.equal(result.card.sections.tomorrow.label, 'tomorrow');
  assert.equal(result.card.sections.tomorrow.prompt, 'what should tomorrow hold?');
  assert.equal(result.card.sections.overnightQueue.label, 'overnight queue');
  assert.equal(result.card.sections.energy.label, 'energy');
  assert.equal(result.card.sections.energy.prompt, 'where did energy land? 1/5 to 5/5');
  assert.equal(result.card.sections.energy.scale.max, 5);
  assert.equal(result.card.twsBackfill.pendingCount, 1);
  assert.equal(result.card.twsBackfill.prompts[0].blockId, 'block-a');
  assert.equal(result.card.twsBackfill.answerAction.path, CADENCE_TWS_BACKFILL_PATH);
  assert.equal(result.card.twsBackfill.finalizeNoResponseAction.path, CADENCE_TWS_NO_RESPONSE_PATH);
});

test('weekly retro card persists eval health with weekly goals and lists placeholders', async () => {
  const dataDir = await tempDataDir();
  await writeTwsPrompt(dataDir, 'block-a', {
    status: 'answered',
    wellSpent: true,
  });
  await writeDecision(dataDir, 'acted.json', {
    acted: 'acted',
    actedAt: '2026-07-06T19:00:00.000Z',
    recommended: 'Act on the captured recommendation.',
  });
  await writeDecision(dataDir, 'pending.json', {
    acted: 'pending',
    recommended: 'Leave this recommendation pending.',
  });

  const result = await generateWeeklyRetroCard({
    dataDir,
    now: fixedNow,
  });

  assert.equal(result.card.type, REVIEW_CARD_TYPE_WEEKLY_RETRO);
  assert.equal(result.card.title, 'weekly retro');
  assert.equal(result.card.retro.evalHealth.tws.promptCount, 1);
  assert.equal(result.card.retro.evalHealth.decisionSignal.acted, 1);
  assert.equal(result.card.retro.evalHealth.decisionSignal.recommended, 2);
  assert.deepEqual(result.card.retro.goals, []);
  assert.deepEqual(result.card.retro.lists, []);
  assert.match(renderReviewCadenceRoutineReport(result), /## review cadence: weekly-retro/);
  assert.match(renderReviewCadenceRoutineReport(result), /tws prompts: 1\/1 answered/);
  assert.match(renderReviewCadenceRoutineReport(result), /decision signal: acted 1\/2 decisions/);
  assert.match(renderReviewCadenceRoutineReport(result), /value anchors: 0\/0 answered/);

  const stored = JSON.parse(await fs.readFile(path.join(dataDir, result.path.replace(/^data\//, '')), 'utf8'));
  assert.equal(stored.type, REVIEW_CARD_TYPE_WEEKLY_RETRO);
  assert.equal(stored.retro.evalHealth.tws.score, 1);
});

test('TWS backfill answers and no-response outcomes are durable and idempotent', async () => {
  const dataDir = await tempDataDir();
  await writeTwsPrompt(dataDir, 'block-a');
  await writeTwsPrompt(dataDir, 'block-b');

  const before = await collectTwsBackfill({ dataDir, date: '2026-07-06', now: fixedNow });
  assert.equal(before.pendingCount, 2);

  const answered = await recordTwsBackfillAnswers({
    dataDir,
    now: fixedNow,
    date: '2026-07-06',
    answers: [{ promptId: 'prompt-block-a', wellSpent: true }],
  });
  assert.equal(answered.ok, true);
  assert.equal(answered.createdCount, 1);
  assert.equal(answered.outcomes[0].outcome, 'well-spent');
  assert.equal(answered.outcomes[0].wellSpent, true);

  const afterAnswer = await collectTwsBackfill({ dataDir, date: '2026-07-06', now: fixedNow });
  assert.deepEqual(afterAnswer.prompts.map((prompt) => prompt.promptId), ['prompt-block-b']);

  const noResponse = await persistTwsNoResponseOutcomes({
    dataDir,
    now: fixedNow,
    date: '2026-07-06',
  });
  assert.equal(noResponse.createdCount, 1);
  assert.equal(noResponse.outcomes[0].outcome, 'no-response');

  const repeated = await persistTwsNoResponseOutcomes({
    dataDir,
    now: fixedNow,
    date: '2026-07-06',
  });
  assert.equal(repeated.count, 0);

  const final = await collectTwsBackfill({ dataDir, date: '2026-07-06', now: fixedNow });
  assert.equal(final.pendingCount, 0);
});

test('cadence route lists cards and records TWS backfill mutations', async () => {
  const dataDir = await tempDataDir();
  await writeTwsPrompt(dataDir, 'block-a');
  const store = createReviewCadenceStore({ dataDir, now: fixedNow });
  await store.generateCard(REVIEW_CARD_TYPE_EVENING);

  const listed = await dispatchRoute({
    dataDir,
    store,
    method: 'GET',
    pathname: CADENCE_REVIEW_CARDS_PATH,
  });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.count, 1);
  assert.equal(listed.body.cards[0].twsBackfill.pendingCount, 1);

  const answered = await dispatchRoute({
    dataDir,
    store,
    method: 'POST',
    pathname: CADENCE_TWS_BACKFILL_PATH,
    payload: {
      date: '2026-07-06',
      answers: [{ promptId: 'prompt-block-a', wellSpent: false }],
    },
  });
  assert.equal(answered.status, 200);
  assert.equal(answered.body.createdCount, 1);
  assert.equal(answered.body.outcomes[0].outcome, 'not-well-spent');

  const relisted = await dispatchRoute({
    dataDir,
    store,
    method: 'GET',
    pathname: CADENCE_REVIEW_CARDS_PATH,
  });
  assert.equal(relisted.body.cards[0].twsBackfill.pendingCount, 0);

  const bad = await dispatchRoute({
    dataDir,
    store,
    method: 'POST',
    pathname: CADENCE_TWS_NO_RESPONSE_PATH,
    payload: { date: 'not-a-date' },
  });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body, { ok: false, error: 'invalid_tws_no_response' });
});

test('cadence retro route returns computeWeeklyRetro payload with weekly goals and lists', async () => {
  const dataDir = await tempDataDir();
  await writeTwsPrompt(dataDir, 'block-a', {
    status: 'answered',
    wellSpent: false,
  });

  const listed = await dispatchRoute({
    dataDir,
    method: 'GET',
    pathname: CADENCE_RETRO_PATH,
    substrateStore: {
      listRecords: async (kind) => {
        if (kind === 'WeeklyGoals') {
          return [{ id: 'wg-1', kind, title: 'Ship cadence wiring', validTo: null }];
        }
        if (kind === 'WeeklyLists') {
          return [{ id: 'wl-1', kind, title: 'Review queue', supersededById: null }];
        }
        return [];
      },
    },
  });

  assert.equal(listed.status, 200);
  assert.equal(listed.body.retro.kind, 'WeeklyRetro');
  assert.equal(listed.body.retro.evalHealth.tws.promptCount, 1);
  assert.deepEqual(listed.body.retro.goals.map((goal) => goal.title), ['Ship cadence wiring']);
  assert.deepEqual(listed.body.retro.lists.map((list) => list.title), ['Review queue']);

  const placeholders = await dispatchRoute({
    dataDir,
    method: 'GET',
    pathname: CADENCE_RETRO_PATH,
  });
  assert.deepEqual(placeholders.body.retro.goals, []);
  assert.deepEqual(placeholders.body.retro.lists, []);
});

async function tempDataDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-review-cadences-'));
}

async function writeDecision(dataDir, name, overrides = {}) {
  await writeJson(dataDir, path.join('decisions', name), {
    kind: 'LoopRecommendation',
    schemaVersion: 1,
    station: 'decide',
    date: '2026-07-06',
    verdict: 'recommend',
    acted: 'pending',
    advisoryOnly: true,
    decision: 'Whether to count this recommendation.',
    recommended: 'Review this recommendation.',
    reason: 'It is captured.',
    reversibility: 'internal-revertible',
    undo: 'Leave it pending.',
    evidenceIds: [],
    confidence: 0.5,
    summary: 'Captured recommendation.',
    createdAt: '2026-07-06T20:00:00.000Z',
    ...overrides,
  });
}

async function writeTwsPrompt(dataDir, blockId, overrides = {}) {
  await writeJson(dataDir, path.join('cadence', 'tws', `${blockId}.json`), {
    id: `prompt-${blockId}`,
    kind: 'CadenceTwsPrompt',
    schemaVersion: 1,
    date: '2026-07-06',
    blockId,
    blockTitle: `Block ${blockId}`,
    status: 'pending',
    askedAt: '2026-07-06T12:00:00.000Z',
    ...overrides,
  });
}

async function writeJson(dataDir, relPath, value) {
  const file = path.join(dataDir, relPath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function dispatchRoute(input) {
  const response = mockResponse();
  const deps = routeDeps();
  try {
    await handleCadenceRoute(
      mockRequest(input.payload),
      response,
      {
        method: input.method,
        pathname: input.pathname,
        dataDir: input.dataDir,
        now: fixedNow,
        reviewCadenceStore: input.store,
        substrateStore: input.substrateStore,
      },
      deps,
    );
  } catch (error) {
    deps.sendJson(response, error.statusCode ?? 500, {
      ok: false,
      error: error.expose ? error.code : 'server_error',
    });
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
