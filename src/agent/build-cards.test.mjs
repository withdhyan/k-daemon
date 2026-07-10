import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  BUILD_CARD_KIND_DRIFT,
  BUILD_CARD_KIND_PLAN_APPROVAL,
  BUILD_CARD_KIND_SAFETY_FLOOR,
  BUILD_CARD_STATUS_ANSWERED,
  BUILD_CARD_STATUS_APPLIED,
  BUILD_CARD_STATUS_NOTIFIED,
  BUILD_CARD_STATUS_OBSOLETED,
  BUILD_CARD_STATUS_QUEUED,
  BUILD_CARD_STATUS_RE_RAISED,
  BUILD_CARD_TIER_LOOPBACK,
  BUILD_CARD_TIER_TAILNET,
  InvalidChannelError,
  createBuildCardStore,
} from './build-cards.mjs';
import { readHistory } from './build-state.mjs';

test('AT-9: wrong tier does not consume answer; loopback wins; later tailnet sees alreadyAnswered; plan kill obsoletes open cards', async () => {
  const dataDir = await tempDataDir();
  const clock = mutableClock();
  const store = createBuildCardStore({
    dataDir,
    now: clock.now,
    randomSuffix: suffixer(),
  });
  const safety = await store.raiseCard(cardInput({
    kind: BUILD_CARD_KIND_SAFETY_FLOOR,
    tier: BUILD_CARD_TIER_LOOPBACK,
    planId: 'plan-at9',
  }));

  await assert.rejects(
    () => store.answerCard({
      cardId: safety.card.id,
      optionId: 'kill',
      surface: 'ipad',
      isSameMachine: false,
    }),
    InvalidChannelError,
  );
  assert.equal((await store.loadCard(safety.card.id)).answeredBy, null);
  assert.equal(
    (await readHistory({ dataDir, limit: 10 })).filter((entry) => entry.kind === 'build.card.answered').length,
    0,
  );

  clock.advance(1_000);
  const loopback = await store.answerCard({
    cardId: safety.card.id,
    optionId: 'kill',
    surface: 'mac',
    isSameMachine: true,
  });
  assert.equal(loopback.card.status, BUILD_CARD_STATUS_ANSWERED);
  assert.equal(loopback.card.answeredBy, 'loopback');

  clock.advance(1_000);
  const ipadRetry = await store.answerCard({
    cardId: safety.card.id,
    optionId: 'continue',
    surface: 'ipad',
    isSameMachine: false,
  });
  assert.deepEqual(ipadRetry.alreadyAnswered, {
    by: 'loopback',
    at: '2026-07-04T00:00:01.000Z',
    optionId: 'kill',
  });
  assert.equal(ipadRetry.changed, false);

  const open = await store.raiseCard(cardInput({
    kind: BUILD_CARD_KIND_DRIFT,
    tier: BUILD_CARD_TIER_TAILNET,
    planId: 'plan-at9',
  }));
  const obsolete = await store.obsoleteCardsFor({
    planId: 'plan-at9',
    supersededBy: 'plan-killed',
  });
  assert.deepEqual(obsolete.cards.map((card) => card.id), [open.card.id]);
  assert.equal((await store.loadCard(open.card.id)).status, BUILD_CARD_STATUS_OBSOLETED);
  assert.equal((await store.loadCard(open.card.id)).supersededBy, 'plan-killed');
  assert.equal((await store.loadCard(safety.card.id)).status, BUILD_CARD_STATUS_ANSWERED);
});

test('plan-approval cards queue behind one open approval and promote FIFO on resolve', async () => {
  const dataDir = await tempDataDir();
  const clock = mutableClock();
  const store = createBuildCardStore({
    dataDir,
    now: clock.now,
    randomSuffix: suffixer(),
  });

  const first = await store.raiseCard(cardInput({
    kind: BUILD_CARD_KIND_PLAN_APPROVAL,
    tier: BUILD_CARD_TIER_LOOPBACK,
    planId: 'plan-a',
  }));
  clock.advance(1_000);
  const second = await store.raiseCard(cardInput({
    kind: BUILD_CARD_KIND_PLAN_APPROVAL,
    tier: BUILD_CARD_TIER_LOOPBACK,
    planId: 'plan-b',
  }));
  clock.advance(1_000);
  const third = await store.raiseCard(cardInput({
    kind: BUILD_CARD_KIND_PLAN_APPROVAL,
    tier: BUILD_CARD_TIER_LOOPBACK,
    planId: 'plan-c',
  }));

  assert.equal(first.card.status, BUILD_CARD_STATUS_NOTIFIED);
  assert.equal(second.card.status, BUILD_CARD_STATUS_QUEUED);
  assert.equal(third.card.status, BUILD_CARD_STATUS_QUEUED);

  clock.advance(1_000);
  const resolvedFirst = await store.answerCard({
    cardId: first.card.id,
    optionId: 'approve',
    isSameMachine: true,
  });
  assert.equal(resolvedFirst.promoted.id, second.card.id);
  assert.equal((await store.loadCard(second.card.id)).status, BUILD_CARD_STATUS_NOTIFIED);
  assert.equal((await store.loadCard(third.card.id)).status, BUILD_CARD_STATUS_QUEUED);

  clock.advance(1_000);
  const resolvedSecond = await store.answerCard({
    cardId: second.card.id,
    optionId: 'approve',
    isSameMachine: true,
  });
  assert.equal(resolvedSecond.promoted.id, third.card.id);
  assert.equal((await store.loadCard(third.card.id)).status, BUILD_CARD_STATUS_NOTIFIED);
});

test('apply-failed re-raises with reason; dailyReRaise only re-notifies due safety-floor cards', async () => {
  const dataDir = await tempDataDir();
  const clock = mutableClock();
  const store = createBuildCardStore({
    dataDir,
    now: clock.now,
    randomSuffix: suffixer(),
  });

  const drift = await store.raiseCard(cardInput({
    kind: BUILD_CARD_KIND_DRIFT,
    tier: BUILD_CARD_TIER_TAILNET,
    planId: 'plan-drift',
  }));
  await store.answerCard({
    cardId: drift.card.id,
    optionId: 'continue',
    surface: 'ipad',
    isSameMachine: false,
  });
  clock.advance(1_000);
  const failed = await store.markApplyFailed({
    cardId: drift.card.id,
    reason: 'lane vanished before apply',
  });
  assert.equal(failed.card.status, BUILD_CARD_STATUS_RE_RAISED);
  assert.equal(failed.card.applyFailureReason, 'lane vanished before apply');
  assert.equal(failed.card.notifiedAt, '2026-07-04T00:00:01.000Z');
  assert.equal(failed.card.answeredBy, null);
  assert.equal(failed.card.answerHistory.length, 1);

  const safety = await store.raiseCard(cardInput({
    kind: BUILD_CARD_KIND_SAFETY_FLOOR,
    tier: BUILD_CARD_TIER_LOOPBACK,
    planId: 'plan-safety',
  }));
  const nonSafety = await store.raiseCard(cardInput({
    kind: BUILD_CARD_KIND_DRIFT,
    tier: BUILD_CARD_TIER_TAILNET,
    planId: 'plan-other',
  }));

  clock.advance((23 * 60 * 60 * 1000) + 59 * 60 * 1000);
  assert.deepEqual(await store.dailyReRaise(clock.now()), []);

  clock.advance(2 * 60 * 1000);
  const due = await store.dailyReRaise(clock.now());
  assert.deepEqual(due.map((card) => card.id), [safety.card.id]);
  assert.equal(due[0].status, BUILD_CARD_STATUS_NOTIFIED);
  assert.notEqual(due[0].notifiedAt, safety.card.notifiedAt);
  assert.equal((await store.loadCard(nonSafety.card.id)).notifiedAt, nonSafety.card.notifiedAt);
});

test('markApplied closes an answered card idempotently', async () => {
  const dataDir = await tempDataDir();
  const store = createBuildCardStore({
    dataDir,
    now: fixedNow,
    randomSuffix: suffixer(),
  });
  const raised = await store.raiseCard(cardInput({
    kind: BUILD_CARD_KIND_DRIFT,
    tier: BUILD_CARD_TIER_TAILNET,
    planId: 'plan-applied',
  }));
  await store.answerCard({
    cardId: raised.card.id,
    optionId: 'continue',
    surface: 'ipad',
    isSameMachine: false,
  });

  const applied = await store.markApplied({
    cardId: raised.card.id,
    appliedBy: 'runner',
  });
  assert.equal(applied.card.status, BUILD_CARD_STATUS_APPLIED);
  assert.equal(applied.card.appliedBy, 'runner');
  assert.deepEqual(await store.listOpenCards(), []);

  const retry = await store.markApplied({ cardId: raised.card.id });
  assert.equal(retry.changed, false);
  assert.equal(retry.card.status, BUILD_CARD_STATUS_APPLIED);
});

test('answered-while-daemon-down retry is idempotent and does not append a second answer event', async () => {
  const dataDir = await tempDataDir();
  const clock = mutableClock();
  const firstStore = createBuildCardStore({
    dataDir,
    now: clock.now,
    randomSuffix: suffixer(),
  });

  const raised = await firstStore.raiseCard(cardInput({
    kind: BUILD_CARD_KIND_DRIFT,
    tier: BUILD_CARD_TIER_TAILNET,
    planId: 'plan-retry',
  }));
  const answered = await firstStore.answerCard({
    cardId: raised.card.id,
    optionId: 'continue',
    surface: 'ipad',
    isSameMachine: false,
  });
  assert.equal(answered.changed, true);

  const restartedStore = createBuildCardStore({
    dataDir,
    now: clock.now,
  });
  const retry = await restartedStore.answerCard({
    cardId: raised.card.id,
    optionId: 'continue',
    surface: 'ipad',
    isSameMachine: false,
  });
  assert.equal(retry.changed, false);
  assert.deepEqual(retry.events, []);
  assert.deepEqual(retry.alreadyAnswered, {
    by: 'ipad',
    at: '2026-07-04T00:00:00.000Z',
    optionId: 'continue',
  });

  const history = await readHistory({ dataDir, limit: 20 });
  assert.equal(history.filter((entry) => entry.kind === 'build.card.answered').length, 1);
});

test('build card copy uses k-copy patterns and keeps raw JSON in payload', async () => {
  const dataDir = await tempDataDir();
  const store = createBuildCardStore({
    dataDir,
    now: fixedNow,
    randomSuffix: suffixer(),
  });
  const rawBody = {
    reason: 'empty_scope_intersection',
    laneId: 'lane-raw',
    harvestedFiles: ['src/outside.mjs'],
  };

  const raised = await store.raiseCard(cardInput({
    kind: BUILD_CARD_KIND_SAFETY_FLOOR,
    title: 'Safety floor hold',
    body: JSON.stringify(rawBody, null, 2),
    options: [
      {
        id: 'retry',
        label: 'Retry',
        consequence: 'Retry later.',
      },
      {
        id: 'hold',
        label: 'Hold',
        consequence: 'Keep this staged.',
      },
    ],
    recommendation: 'retry',
  }));

  assert.equal(raised.card.title, 'safety floor hold');
  assert.equal(
    raised.card.body,
    'build is held for empty scope intersection — retry the lane. protected path risk.',
  );
  assert.deepEqual(raised.card.options.map((option) => option.label), [
    'retry the lane',
    'hold for review',
  ]);
  assert.deepEqual(raised.card.options.map((option) => option.consequence), [
    'spend one more attempt.',
    'keep it staged for review.',
  ]);
  assert.deepEqual(raised.card.payload.rawBody, rawBody);
});

async function tempDataDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-build-cards-'));
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

function mutableClock() {
  let ms = Date.UTC(2026, 6, 4, 0, 0, 0, 0);
  return {
    now: () => new Date(ms),
    advance(deltaMs) {
      ms += deltaMs;
    },
  };
}

function fixedNow() {
  return new Date('2026-07-04T00:00:00.000Z');
}
