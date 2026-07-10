import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import test from 'node:test';

import {
  BUILD_CARD_KIND_INFRA,
  BUILD_CARD_KIND_PLAN_APPROVAL,
  BUILD_CARD_KIND_DRIFT,
  BUILD_CARD_KIND_SAFETY_FLOOR,
} from './build-cards.mjs';
import {
  ENFORCEMENT_SURFACES,
  ReasoningUnavailableError,
  approvalPreCheck,
  globToRegExp,
  integrationCheck,
  matchesGlob,
  reasoningCheck,
  safetyFloorCheck,
  scopeCheck,
  trackCheck,
} from './build-align.mjs';

const ae6LiveTest = process.env.K_AE6_LIVE === '1' ? test : test.skip;

test('AE3: safetyFloorCheck catches protected enforcement and mission surfaces', () => {
  const protectedFiles = [
    'src/reason/sensitive-model.mjs',
    'ops/boot-shim.mjs',
    'src/agent/fixtures/x.json',
    'src/agent/fixtures/ae6-misaligned-plan.json',
    '.claude/settings.json',
    'src/agent/build-align.mjs',
  ];

  for (const file of protectedFiles) {
    const result = safetyFloorCheck({ diffFiles: [file] });
    assert.equal(result.ok, false, file);
    assert.deepEqual(result.hits.map((hit) => hit.file), [file]);
    assert.equal(typeof result.hits[0].glob, 'string');
  }

  assert(ENFORCEMENT_SURFACES.includes('src/agent/build-align.mjs'));
  assert(ENFORCEMENT_SURFACES.includes('data/**'));
});

test('scopeCheck flags files outside declared unit scope', () => {
  const result = scopeCheck({
    diffFiles: [
      'src/agent/build-runner.mjs',
      'ui/legacy-web.html',
    ],
    unitScope: ['src/agent/build-runner.mjs'],
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.outside, ['ui/legacy-web.html']);
});

test('scopeCheck accepts files inside declared globs', () => {
  const result = scopeCheck({
    diffFiles: [
      'src/agent/new-runner-helper.mjs',
      'src/agent/new-runner-helper.test.mjs',
    ],
    unitScope: ['src/agent/**'],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.outside, []);
});

test('scopeCheck treats undeclared unit scope as drift', () => {
  const result = scopeCheck({
    diffFiles: ['src/agent/ordinary.mjs'],
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'scope_undeclared');
  assert.deepEqual(result.outside, ['src/agent/ordinary.mjs']);
});

test('integrationCheck passes a clean in-scope ordinary source diff', () => {
  const result = integrationCheck({
    diffFiles: ['src/agent/ordinary-feature.mjs'],
    unitScope: ['src/agent/ordinary-*.mjs'],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.holds, []);
});

test('integrationCheck returns safety-floor and drift holds for hard violations', () => {
  const result = integrationCheck({
    diffFiles: [
      'src/reason/sensitive-model.mjs',
      'ui/legacy-web.html',
    ],
    unitScope: ['src/agent/**'],
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.holds.map((hold) => hold.kind), [
    BUILD_CARD_KIND_SAFETY_FLOOR,
    BUILD_CARD_KIND_DRIFT,
  ]);
  assert.deepEqual(result.holds[0].detail.hits.map((hit) => hit.file), [
    'src/reason/sensitive-model.mjs',
  ]);
  assert.deepEqual(result.holds[1].detail.outside, [
    'src/reason/sensitive-model.mjs',
    'ui/legacy-web.html',
  ]);
});

test('trackCheck scores aligned strategy-track text above threshold', async () => {
  const result = await trackCheck({
    strategyText: strategyFixture(),
    planTitle: 'Holon eval loop for K',
    planUnits: [
      {
        title: 'Dhyan attention footprint',
        goal: 'Improve the holon loop with eval, attention, dhyan, EEG, HRV, and enlightenment tracking.',
      },
    ],
    threshold: 0.25,
  });

  assert.equal(result.ok, true);
  assert(result.score >= result.threshold);
  assert(result.overlap.includes('dhyan'));
  assert.equal(result.anchor, 'strategy-track');
});

test('trackCheck scores unrelated plan text below threshold', async () => {
  const result = await trackCheck({
    strategyText: strategyFixture(),
    planTitle: 'Invoice export warehouse migration',
    planUnits: [
      {
        goal: 'Add PostgreSQL billing invoices, coupons, tax tables, and payment reconciliation.',
      },
    ],
    threshold: 0.25,
  });

  assert.equal(result.ok, false);
  assert(result.score < result.threshold);
});

test('minimal glob matcher supports ** and single-segment *', () => {
  assert.equal(matchesGlob('src/agent/fixtures/x.json', 'src/agent/fixtures/**'), true);
  assert.equal(matchesGlob('ops/ch.holonresear.cs-k-daemon.plist', 'ops/*.plist'), true);
  assert.equal(matchesGlob('ops/nested/file.txt', 'ops/*.plist'), false);
  assert.equal(globToRegExp('data/**').test('data/substrate/x.json'), true);
});

test('AE6: stubbed reasoning verdict holds the misaligned fixture plan', async () => {
  const plan = await ae6FixturePlan();
  const result = await reasoningCheck({
    plan,
    anchors: ae6Anchors(),
    now: '2026-07-04T00:00:00.000Z',
    singleCall: async () => ({
      model: 'stub-sovereign',
      content: JSON.stringify({
        verdict: 'hold',
        reasons: ['unit u-ae6-sensitive weakens SEC-002 sovereign fail-closed behavior'],
        anchorRefs: ['constitution'],
      }),
    }),
  });

  assert.equal(result.verdict, 'hold');
  assert.deepEqual(result.reasons, [
    'unit u-ae6-sensitive weakens SEC-002 sovereign fail-closed behavior',
  ]);
  assert.deepEqual(result.anchorRefs, ['constitution']);
  assert.equal(result.model, 'stub-sovereign');
});

test('reasoningCheck passes an aligned mini-plan with a stubbed verdict', async () => {
  const result = await reasoningCheck({
    plan: alignedMiniPlan(),
    anchors: ae6Anchors(),
    singleCall: async () => ({
      model: 'stub-sovereign',
      content: '{"verdict":"pass","reasons":["plan preserves sovereign fail-closed behavior"],"anchorRefs":["constitution"]}',
    }),
  });

  assert.equal(result.verdict, 'pass');
  assert.deepEqual(result.reasons, ['plan preserves sovereign fail-closed behavior']);
  assert.deepEqual(result.anchorRefs, ['constitution']);
});

test('reasoningCheck fails closed on malformed model output', async () => {
  const result = await reasoningCheck({
    plan: alignedMiniPlan(),
    anchors: ae6Anchors(),
    singleCall: async () => 'this is not json',
  });

  assert.equal(result.verdict, 'hold');
  assert.deepEqual(result.reasons, ['unparseable verdict']);
  assert.deepEqual(result.anchorRefs, []);
});

test('reasoningCheck reports transport failure as ReasoningUnavailableError', async () => {
  await assert.rejects(
    () => reasoningCheck({
      plan: alignedMiniPlan(),
      anchors: ae6Anchors(),
      singleCall: async () => {
        throw new Error('network down');
      },
    }),
    ReasoningUnavailableError,
  );
});

test('approvalPreCheck keeps plan staged with an infra card when reasoning is unavailable', async () => {
  const result = await approvalPreCheck({
    plan: alignedMiniPlan(),
    deps: {
      anchors: ae6Anchors(),
      now: '2026-07-04T00:00:00.000Z',
      singleCall: async () => {
        throw new Error('socket closed');
      },
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'staged');
  assert.equal(result.staged, true);
  assert.equal(result.card.kind, BUILD_CARD_KIND_INFRA);
  assert.equal(result.card.planId, 'aligned-plan');
  assert.match(result.card.body, /Recommendation: hold/);
});

test('approvalPreCheck blocks undeclared unit scopes before model invocation', async () => {
  let called = false;
  const result = await approvalPreCheck({
    plan: {
      id: 'missing-scope-plan',
      title: 'Missing scope plan',
      units: [
        {
          id: 'u-missing',
          goal: 'Change build runner behavior without a scope declaration.',
        },
      ],
    },
    deps: {
      anchors: ae6Anchors(),
      singleCall: async () => {
        called = true;
        return '{"verdict":"pass","reasons":[],"anchorRefs":[]}';
      },
    },
  });

  assert.equal(called, false);
  assert.equal(result.ok, false);
  assert.equal(result.card.kind, BUILD_CARD_KIND_PLAN_APPROVAL);
  assert.equal(result.recommendation, 'hold');
  assert.deepEqual(result.reasons, ['unit u-missing: unit scope undeclared']);
});

test('approvalPreCheck appends reasoning verdict history with comparison-ready shape', async () => {
  const history = [];
  const result = await approvalPreCheck({
    plan: alignedMiniPlan(),
    deps: {
      anchors: ae6Anchors(),
      now: '2026-07-04T00:00:00.000Z',
      appendHistory: async (event) => {
        history.push(event);
        return { ok: true, path: 'memory' };
      },
      singleCall: async () => ({
        model: 'stub-sovereign',
        content: JSON.stringify({
          verdict: 'pass',
          reasons: ['aligned with sovereign fail-closed anchor'],
          anchorRefs: ['constitution'],
        }),
      }),
    },
  });

  assert.equal(result.ok, true);
  const reasoning = history.find((event) => event.kind === 'align.reasoning');
  assert.deepEqual(reasoning, {
    kind: 'align.reasoning',
    check: 'reasoning',
    planId: 'aligned-plan',
    verdict: 'pass',
    reasons: ['aligned with sovereign fail-closed anchor'],
    anchorRefs: ['constitution'],
    model: 'stub-sovereign',
    at: '2026-07-04T00:00:00.000Z',
  });
  assert(history.some((event) => event.kind === 'align.track'));
});

ae6LiveTest('AE6 live sovereign lane holds the misaligned fixture plan', async () => {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY is required when K_AE6_LIVE=1');
  }

  const result = await reasoningCheck({
    plan: await ae6FixturePlan(),
    anchors: ae6Anchors(),
  });

  assert.equal(result.verdict, 'hold');
});

function strategyFixture() {
  return `
# cs-k Strategy

## Approach

K is a human AI holon. The loop recursively refines its own eval toward
dhyan, attention, enlightenment, and decision de-loading.

## Tracks

/bio /neuro /cognitive /coordination /k with EEG, HRV, body, attention, and
decision science.
`;
}

async function ae6FixturePlan() {
  const text = await fs.readFile(new URL('./fixtures/ae6-misaligned-plan.json', import.meta.url), 'utf8');
  return JSON.parse(text);
}

function alignedMiniPlan() {
  return {
    id: 'aligned-plan',
    title: 'Preserve sovereign fail-closed behavior',
    units: [
      {
        id: 'u-aligned',
        goal: 'Add tests that verify sensitive sovereign failures stay silent and never fall back to frontier.',
        scope: {
          declared: ['src/agent/chat.test.mjs'],
        },
      },
    ],
  };
}

function ae6Anchors() {
  return {
    strategy: `
# Strategy

K is local-first and sovereign. Work should free founder attention while preserving safety floors.
`,
    loop: `
# Loop

Data stays local/sovereign. Plans must not weaken the runner's own evidence gates.
`,
    constitution: `
# Constitution

SEC-002: sensitive turns and crown-jewel data route through the sovereign lane. If the sovereign lane fails, the system silences or holds; it never falls back to the frontier lane.
`,
  };
}
