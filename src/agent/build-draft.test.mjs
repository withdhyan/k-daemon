import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  BUILD_CARD_KIND_INFRA,
  BUILD_CARD_KIND_PLAN_APPROVAL,
  BUILD_CARD_STATUS_APPLIED,
  BUILD_CARD_STATUS_NOTIFIED,
  BUILD_CARD_STATUS_OBSOLETED,
  BUILD_CARD_STATUS_QUEUED,
  BUILD_CARD_TIER_LOOPBACK,
  BUILD_CARD_TIER_TAILNET,
  createBuildCardStore,
} from './build-cards.mjs';
import {
  BUILD_STATE_BUILDING,
  BUILD_STATE_CANCELLED,
  BUILD_STATE_QUEUED,
  createBuildStateStore,
} from './build-state.mjs';
import {
  PLAN_APPROVAL_OPTION_APPROVE,
  PLAN_APPROVAL_OPTION_REJECT,
  applyPlanApproval,
  draftPlan,
  stagePlanDraft,
} from './build-draft.mjs';

test('draftPlan composes a scoped checkable plan from an infra codex auth flag', () => {
  const draft = draftPlan({
    id: 'plan-codex-auth',
    now: '2026-07-04T00:00:00.000Z',
    sources: {
      strategyText: strategyFixture(),
      openFlags: [
        {
          kind: 'infra',
          detail: 'codex auth expired during lane dispatch',
          planId: 'plan-existing',
          unitId: 'u-existing',
        },
      ],
    },
  });

  assert.equal(draft.id, 'plan-codex-auth');
  assert.equal(draft.status, BUILD_STATE_QUEUED);
  assert(draft.units.length >= 1 && draft.units.length <= 2);
  for (const unit of draft.units) {
    assert.equal(typeof unit.goal, 'string');
    assert.match(unit.goal, /\b(classified|surfaces|covered|implemented|passes|reports|records)\b/i);
    assert(Array.isArray(unit.scope), unit.id);
    assert(unit.scope.length > 0, unit.id);
  }
});

test('stagePlanDraft refuses undeclared-scope drafts before invoking singleCall', async () => {
  const harness = await createHarness();
  let called = false;

  await assert.rejects(
    () => stagePlanDraft({
      store: harness.store,
      cards: harness.cards,
      draft: {
        id: 'bad-scope',
        title: 'Bad scope',
        status: BUILD_STATE_QUEUED,
        units: [
          {
            id: 'u-bad',
            goal: 'Change the build runner without declaring scope.',
          },
        ],
      },
      deps: {
        singleCall: async () => {
          called = true;
          return passVerdict();
        },
      },
    }),
    /R21 unit scope specificity/,
  );

  assert.equal(called, false);
  assert.equal(await harness.store.loadPlan('bad-scope'), null);
  assert.deepEqual(await harness.cards.listCards(), []);
});

test('stagePlanDraft raises a tailnet approval card (founder answers from iOS) and queues the second draft behind R19', async () => {
  const harness = await createHarness();
  const first = validDraft('plan-first');
  const second = validDraft('plan-second');

  const stagedFirst = await stagePlanDraft({
    store: harness.store,
    cards: harness.cards,
    draft: first,
    deps: precheckDeps(),
  });
  const stagedSecond = await stagePlanDraft({
    store: harness.store,
    cards: harness.cards,
    draft: second,
    deps: precheckDeps(),
  });

  assert.equal(stagedFirst.card.kind, BUILD_CARD_KIND_PLAN_APPROVAL);
  assert.equal(stagedFirst.card.tier, BUILD_CARD_TIER_TAILNET);
  assert.equal(stagedFirst.card.status, BUILD_CARD_STATUS_NOTIFIED);
  assert.equal(
    stagedFirst.card.body,
    'the plan is staged — approve the plan. reversible before build starts.',
  );
  assert.match(stagedFirst.card.payload.sourceBody, /Draft: Build follow-up: codex auth retry flag/);
  assert.match(stagedFirst.card.payload.sourceBody, /Pre-check: pass/);

  assert.equal(stagedSecond.card.kind, BUILD_CARD_KIND_PLAN_APPROVAL);
  assert.equal(stagedSecond.card.status, BUILD_CARD_STATUS_QUEUED);
  assert.equal((await harness.store.loadPlan('plan-second')).status, BUILD_STATE_QUEUED);
});

test('applyPlanApproval approves to building and rejects to cancelled with obsolete open cards', async () => {
  const harness = await createHarness();

  await harness.store.createPlan(validDraft('approve-plan'));
  const approveCard = await harness.cards.raiseCard(approvalCardInput({ planId: 'approve-plan' }));
  await harness.cards.answerCard({
    cardId: approveCard.card.id,
    optionId: PLAN_APPROVAL_OPTION_APPROVE,
    isSameMachine: true,
  });
  const approved = await applyPlanApproval({
    store: harness.store,
    cards: harness.cards,
    cardId: approveCard.card.id,
    optionId: PLAN_APPROVAL_OPTION_APPROVE,
    deps: {
      actor: 'runner',
      now: harness.clock.now(),
      monotonicNow: harness.clock.monotonicNow(),
    },
  });

  assert.equal(approved.plan.status, BUILD_STATE_BUILDING);
  assert.equal((await harness.store.loadPlan('approve-plan')).lease.owner, 'runner');
  assert.equal((await harness.cards.loadCard(approveCard.card.id)).status, BUILD_CARD_STATUS_APPLIED);

  await harness.store.createPlan(validDraft('reject-plan'));
  const rejectCard = await harness.cards.raiseCard(approvalCardInput({ planId: 'reject-plan' }));
  const openFlag = await harness.cards.raiseCard({
    kind: BUILD_CARD_KIND_INFRA,
    tier: BUILD_CARD_TIER_LOOPBACK,
    planId: 'reject-plan',
    title: 'Open infra flag',
    body: 'This should be obsoleted when the plan is rejected.',
    options: [
      { id: 'retry', label: 'Retry', consequence: 'Retry later.' },
      { id: 'kill', label: 'Kill', consequence: 'Stop.' },
    ],
    recommendation: 'retry',
  });

  await harness.cards.answerCard({
    cardId: rejectCard.card.id,
    optionId: PLAN_APPROVAL_OPTION_REJECT,
    isSameMachine: true,
  });
  const rejected = await applyPlanApproval({
    store: harness.store,
    cards: harness.cards,
    cardId: rejectCard.card.id,
    optionId: PLAN_APPROVAL_OPTION_REJECT,
    deps: {
      actor: 'runner',
      now: harness.clock.now(),
      monotonicNow: harness.clock.monotonicNow(),
    },
  });

  assert.equal(rejected.plan.status, BUILD_STATE_CANCELLED);
  assert.equal((await harness.store.loadPlan('reject-plan')).status, BUILD_STATE_CANCELLED);
  assert.equal((await harness.cards.loadCard(rejectCard.card.id)).status, BUILD_CARD_STATUS_APPLIED);
  assert.equal((await harness.cards.loadCard(openFlag.card.id)).status, BUILD_CARD_STATUS_OBSOLETED);
});

test('reasoning hold verdict is carried in the approval body while the plan stays queued', async () => {
  const harness = await createHarness();
  const staged = await stagePlanDraft({
    store: harness.store,
    cards: harness.cards,
    draft: validDraft('hold-plan'),
    deps: {
      ...precheckDeps(),
      singleCall: async () => ({
        model: 'stub-sovereign',
        content: JSON.stringify({
          verdict: 'hold',
          reasons: ['plan weakens the stated sovereignty boundary'],
          anchorRefs: ['constitution'],
        }),
      }),
    },
  });

  assert.equal(staged.preCheck.ok, false);
  assert.equal((await harness.store.loadPlan('hold-plan')).status, BUILD_STATE_QUEUED);
  assert.equal(staged.card.kind, BUILD_CARD_KIND_PLAN_APPROVAL);
  assert.equal(
    staged.card.body,
    'the plan is staged — reject the plan. reversible before build starts.',
  );
  assert.match(staged.card.payload.sourceBody, /Pre-check: hold/);
  assert.match(staged.card.payload.sourceBody, /plan weakens the stated sovereignty boundary/);
  assert.match(staged.card.payload.sourceBody, /Reasoning: hold/);
});

async function createHarness() {
  const clock = mutableClock();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cs-k-build-draft-'));
  const store = createBuildStateStore({
    dataDir,
    now: clock.now,
    monotonicNow: clock.monotonicNow,
  });
  const cards = createBuildCardStore({
    dataDir,
    now: clock.now,
    stateStore: store,
    randomSuffix: suffixer(),
  });
  return { cards, clock, dataDir, store };
}

function validDraft(id) {
  return draftPlan({
    id,
    now: '2026-07-04T00:00:00.000Z',
    sources: {
      strategyText: strategyFixture(),
      openFlags: [
        {
          kind: 'infra',
          detail: 'codex auth retry flag',
        },
      ],
    },
  });
}

function approvalCardInput({ planId }) {
  return {
    kind: BUILD_CARD_KIND_PLAN_APPROVAL,
    tier: BUILD_CARD_TIER_LOOPBACK,
    planId,
    title: `Plan approval: ${planId}`,
    body: 'Approve or reject the staged plan.',
    options: [
      {
        id: PLAN_APPROVAL_OPTION_APPROVE,
        label: 'Approve',
        consequence: 'Build the plan.',
      },
      {
        id: PLAN_APPROVAL_OPTION_REJECT,
        label: 'Reject',
        consequence: 'Cancel the plan.',
      },
    ],
    recommendation: PLAN_APPROVAL_OPTION_APPROVE,
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
    singleCall: async () => passVerdict(),
  };
}

function passVerdict() {
  return {
    model: 'stub-sovereign',
    content: JSON.stringify({
      verdict: 'pass',
      reasons: ['draft preserves the runner approval boundary'],
      anchorRefs: ['constitution'],
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

function suffixer() {
  let index = 0;
  return () => {
    index += 1;
    return `r${index}`;
  };
}

function mutableClock() {
  let ms = Date.UTC(2026, 6, 4, 0, 0, 0, 0);
  let monotonicMs = 0;
  return {
    now: () => new Date(ms),
    monotonicNow: () => monotonicMs,
    advance(deltaMs) {
      ms += deltaMs;
      monotonicMs += deltaMs;
    },
  };
}
