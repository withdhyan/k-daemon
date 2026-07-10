import { iso } from '../../daemon/run.mjs';
import {
  isPlainObject,
  optionalString,
} from '../substrate.mjs';
import {
  approvalPreCheck,
  planScopeDeclarationCheck,
} from './build-align.mjs';
import {
  BUILD_CARD_KIND_PLAN_APPROVAL,
  BUILD_CARD_STATUS_APPLIED,
  BUILD_CARD_TIER_LOOPBACK,
} from './build-cards.mjs';
import {
  BUILD_STATE_BUILDING,
  BUILD_STATE_CANCELLED,
  BUILD_STATE_QUEUED,
  FOUNDER_ACTOR,
} from './build-state.mjs';

// Deterministic plan drafting for U13.
//
// This module does not call a model to compose plans. It only turns known
// sources (strategy text, open build flags, and founder input) into small
// templated candidates, then stages them behind approval-time checks. A
// future unit can replace the composition step with a model, but approval and
// R21 scope enforcement stay outside that model boundary.

export const PLAN_APPROVAL_OPTION_APPROVE = 'approve';
export const PLAN_APPROVAL_OPTION_REJECT = 'reject';
export const DEFAULT_PLAN_APPROVAL_ACTOR = 'runner';
export const MAX_DRAFT_UNITS = 4;

export class BuildDraftError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = this.constructor.name;
    if (options.code) this.code = options.code;
    if (options.failures) this.failures = options.failures;
  }
}

export function draftPlan({ sources = {}, now = new Date(), id } = {}) {
  const normalizedSources = normalizeSources(sources);
  const timestamp = iso(now);
  const planId = optionalString(id) ?? draftId({ sources: normalizedSources, now: timestamp });
  const units = selectDraftUnits(normalizedSources)
    .slice(0, MAX_DRAFT_UNITS)
    .map((unit, index) => normalizeDraftUnit(unit, index));
  const draft = {
    id: planId,
    title: draftTitle(normalizedSources),
    status: BUILD_STATE_QUEUED,
    units,
    createdAt: timestamp,
    updatedAt: timestamp,
    draftSources: draftSourceSummary(normalizedSources),
  };

  assertDraftSpecificity(draft);
  return draft;
}

export async function stagePlanDraft({ store, cards, draft, deps = {} } = {}) {
  if (!store || typeof store.createPlan !== 'function') {
    throw new BuildDraftError('store.createPlan is required', { code: 'missing_store' });
  }
  if (!cards || typeof cards.raiseCard !== 'function') {
    throw new BuildDraftError('cards.raiseCard is required', { code: 'missing_cards' });
  }

  assertDraftSpecificity(draft);

  const timestamp = deps.now ?? new Date();
  const plan = await store.createPlan({
    ...draft,
    status: BUILD_STATE_QUEUED,
    units: draft.units,
  });
  const preCheck = await approvalPreCheck({
    plan,
    deps: {
      ...deps,
      store,
      anchors: {
        ...(isPlainObject(deps.anchors) ? deps.anchors : {}),
        strategy: optionalString(draft?.sources?.strategyText) ??
          optionalString(draft?.draftSources?.strategyText) ??
          optionalString(deps.anchors?.strategy) ??
          '',
      },
      now: timestamp,
    },
  });
  const raised = await cards.raiseCard(planApprovalCardInput({
    draft: plan,
    preCheck,
    now: timestamp,
  }));

  return {
    ok: raised.ok !== false,
    plan,
    draft: plan,
    preCheck,
    card: raised.card,
    raised,
    staged: true,
  };
}

export async function applyPlanApproval({
  store,
  cards,
  cardId,
  optionId,
  deps = {},
} = {}) {
  if (!store || typeof store.loadPlan !== 'function') {
    throw new BuildDraftError('store is required', { code: 'missing_store' });
  }
  if (!cards || typeof cards.loadCard !== 'function') {
    throw new BuildDraftError('cards is required', { code: 'missing_cards' });
  }

  const card = await cards.loadCard(cardId);
  if (!card) throw new BuildDraftError(`plan approval card not found: ${cardId}`, { code: 'card_not_found' });
  if (card.kind !== BUILD_CARD_KIND_PLAN_APPROVAL) {
    throw new BuildDraftError(`card is not a plan approval: ${card.id}`, { code: 'wrong_card_kind' });
  }
  if (card.status === BUILD_CARD_STATUS_APPLIED) {
    return { ok: true, card, changed: false };
  }

  const decision = optionalString(optionId) ?? optionalString(card.answerOption);
  if (decision === PLAN_APPROVAL_OPTION_APPROVE) {
    return applyApprovedPlan({ store, cards, card, deps });
  }
  if (decision === PLAN_APPROVAL_OPTION_REJECT || decision === 'hold' || decision === 'cancel') {
    return applyRejectedPlan({ store, cards, card, deps, decision });
  }

  throw new BuildDraftError(`unsupported plan approval option: ${decision}`, {
    code: 'unsupported_option',
  });
}

export function assertDraftSpecificity(draft) {
  const result = planScopeDeclarationCheck(draft);
  if (!result.ok) {
    throw new BuildDraftError('draft plan violates R21 unit scope specificity', {
      code: 'scope_undeclared',
      failures: result.failures,
    });
  }
  return true;
}

async function applyApprovedPlan({ store, cards, card, deps }) {
  const actor = optionalString(deps.actor) ?? DEFAULT_PLAN_APPROVAL_ACTOR;
  const now = deps.now ?? new Date();
  const monotonicNow = typeof deps.monotonicNow === 'function' ? deps.monotonicNow() : deps.monotonicNow;
  const plan = await requiredPlan(store, card.planId);

  if (!plan.lease || plan.lease.owner !== actor || await store.isLeaseExpired?.(plan, { now, monotonicNow })) {
    await store.acquirePlanLease(plan.id, {
      actor,
      now,
      monotonicNow,
      ttlMs: deps.ttlMs,
    });
  }

  const current = await requiredPlan(store, plan.id);
  let updated = current;
  if (current.status !== BUILD_STATE_BUILDING) {
    if (current.status !== BUILD_STATE_QUEUED) {
      throw new BuildDraftError(`cannot approve plan from status ${current.status}`, {
        code: 'invalid_plan_status',
      });
    }
    const transitioned = await store.transition({
      planId: current.id,
      to: BUILD_STATE_BUILDING,
      actor,
      now,
      monotonicNow,
      reason: 'plan approval',
    });
    updated = transitioned.plan;
  }

  const applied = await cards.markApplied({
    cardId: card.id,
    appliedBy: actor,
    now,
  });
  return {
    ok: applied.ok !== false,
    decision: PLAN_APPROVAL_OPTION_APPROVE,
    plan: updated,
    card: applied.card,
    events: applied.events ?? [],
  };
}

async function applyRejectedPlan({ store, cards, card, deps, decision }) {
  const actor = optionalString(deps.rejectActor) ?? FOUNDER_ACTOR;
  const appliedBy = optionalString(deps.actor) ?? DEFAULT_PLAN_APPROVAL_ACTOR;
  const now = deps.now ?? new Date();
  const monotonicNow = typeof deps.monotonicNow === 'function' ? deps.monotonicNow() : deps.monotonicNow;
  const plan = await requiredPlan(store, card.planId);

  let updated = plan;
  if (plan.status !== BUILD_STATE_CANCELLED) {
    const transitioned = await store.transition({
      planId: plan.id,
      to: BUILD_STATE_CANCELLED,
      actor,
      now,
      monotonicNow,
      reason: `plan approval ${decision}`,
    });
    updated = transitioned.plan;
  }

  const obsolete = typeof cards.obsoleteCardsFor === 'function'
    ? await cards.obsoleteCardsFor({
        planId: plan.id,
        supersededBy: 'plan-rejected',
        now,
      })
    : null;
  const applied = await cards.markApplied({
    cardId: card.id,
    appliedBy,
    now,
  });

  return {
    ok: applied.ok !== false && (obsolete?.ok ?? true),
    decision,
    plan: updated,
    card: applied.card,
    obsolete,
    events: [
      ...(obsolete?.events ?? []),
      ...(applied.events ?? []),
    ],
  };
}

async function requiredPlan(store, planId) {
  const plan = await store.loadPlan(planId);
  if (!plan) throw new BuildDraftError(`plan not found: ${planId}`, { code: 'plan_not_found' });
  return plan;
}

function planApprovalCardInput({ draft, preCheck, now }) {
  const recommendation = preCheck.recommendation === PLAN_APPROVAL_OPTION_APPROVE
    ? PLAN_APPROVAL_OPTION_APPROVE
    : PLAN_APPROVAL_OPTION_REJECT;
  return {
    kind: BUILD_CARD_KIND_PLAN_APPROVAL,
    // Founder decision 2026-07-04: cards answer from the tailnet (iOS-first).
    tier: undefined,
    planId: draft.id,
    title: `Plan approval: ${draft.title}`,
    body: planApprovalBody({ draft, preCheck }),
    options: [
      {
        id: PLAN_APPROVAL_OPTION_APPROVE,
        label: 'Approve',
        consequence: 'Move the staged plan to building so the runner can pick it up.',
      },
      {
        id: PLAN_APPROVAL_OPTION_REJECT,
        label: 'Reject',
        consequence: 'Cancel the staged plan and obsolete its open cards.',
      },
    ],
    recommendation,
    alignment: {
      scope: preCheck.scope ?? null,
      track: preCheck.track ?? null,
      reasoning: preCheck.reasoning ?? null,
      originalRecommendation: preCheck.recommendation,
    },
    createdAt: iso(now ?? new Date()),
  };
}

function planApprovalBody({ draft, preCheck }) {
  const lines = [
    `Draft: ${draft.title}`,
    `Plan: ${draft.id}`,
    '',
    'Units:',
    ...draft.units.map((unit) => `- ${unit.id}: ${unit.goal} [scope: ${scopeGlobs(unit).join(', ')}]`),
    '',
    `Pre-check: ${preCheck.ok ? 'pass' : 'hold'}`,
    `Recommendation: ${preCheck.recommendation}`,
    '',
    'Reasons:',
    ...reasonLines(preCheck.reasons),
  ];

  if (preCheck.track) {
    lines.push(
      '',
      `Track: ${preCheck.track.severity} (${preCheck.track.score}/${preCheck.track.threshold})`,
    );
  }
  if (preCheck.reasoning) {
    lines.push(
      '',
      `Reasoning: ${preCheck.reasoning.verdict}`,
      `Model: ${preCheck.reasoning.model}`,
    );
  }

  return lines.join('\n');
}

function reasonLines(reasons) {
  const normalized = Array.isArray(reasons)
    ? reasons.map(optionalString).filter(Boolean)
    : [];
  return normalized.length > 0
    ? normalized.map((reason) => `- ${reason}`)
    : ['- no reasons supplied'];
}

function selectDraftUnits(sources) {
  const text = sourceText(sources);
  if (/\b(codex|auth|quota|credential|login|api key|token)\b/i.test(text)) return codexAuthUnits();
  if (/\b(plan approval|approval|draft|queue|queued|r19|r21|scope)\b/i.test(text)) return planApprovalUnits();
  if (/\b(deploy|boot|shim|rollback|serve worktree)\b/i.test(text)) return deployUnits();
  if (/\b(gate|suite|hygiene|red foundation|test failure)\b/i.test(text)) return gateUnits();
  if (/\b(alignment|drift|track|reasoning|ae6|sovereign)\b/i.test(text)) return alignmentUnits();
  if (/\b(card|decision|answer|tier|loopback|tailnet)\b/i.test(text)) return cardUnits();
  if (/\b(route|api|sse|viewpacket|packet)\b/i.test(text)) return routeUnits();
  if (/\b(ui|build page|build\.html|web page)\b/i.test(text)) return webUnits();
  return genericUnits(sources);
}

function codexAuthUnits() {
  return [
    {
      id: 'u-codex-auth-infra',
      goal: 'Codex lane auth and quota failures are classified as infra before retry budget is debited.',
      scope: ['src/agent/build-lanes.mjs', 'src/agent/build-lanes.test.mjs'],
    },
    {
      id: 'u-codex-auth-card',
      goal: 'The runner surfaces codex auth infra failures as a loopback card while the plan remains recoverable.',
      scope: ['src/agent/build-runner.mjs', 'src/agent/build-runner.test.mjs'],
      dependencies: ['u-codex-auth-infra'],
    },
  ];
}

function planApprovalUnits() {
  return [
    {
      id: 'u-plan-approval-flow',
      goal: 'Plan drafts with declared scopes stage behind one open loopback approval card at a time.',
      scope: ['src/agent/build-draft.mjs', 'src/agent/build-draft.test.mjs', 'src/agent/build-cards.mjs'],
    },
    {
      id: 'u-plan-approval-apply',
      goal: 'Approved plan-approval cards move plans to building and rejected cards cancel plans.',
      scope: ['src/agent/build-draft.mjs', 'src/agent/build-runner.mjs', 'src/agent/build-draft.test.mjs'],
      dependencies: ['u-plan-approval-flow'],
    },
  ];
}

function deployUnits() {
  return [
    {
      id: 'u-deploy-recovery',
      goal: 'Deploy recovery records accept or rollback outcomes without losing build-state continuity.',
      scope: ['src/agent/build-deploy.mjs', 'src/agent/build-deploy.test.mjs', 'ops/boot-shim.mjs'],
    },
  ];
}

function gateUnits() {
  return [
    {
      id: 'u-gate-regression',
      goal: 'Verification gates preserve the failing output tail and hold the unit on suite or hygiene failure.',
      scope: ['src/agent/build-gates.mjs', 'src/agent/build-gates.test.mjs', 'src/agent/build-runner.mjs'],
    },
  ];
}

function alignmentUnits() {
  return [
    {
      id: 'u-alignment-evidence',
      goal: 'Approval and integration alignment checks report scope, track, and reasoning evidence in card bodies.',
      scope: ['src/agent/build-align.mjs', 'src/agent/build-align.test.mjs', 'src/agent/build-draft.mjs'],
    },
  ];
}

function cardUnits() {
  return [
    {
      id: 'u-card-lifecycle',
      goal: 'Decision cards preserve tier validation, idempotent answers, FIFO plan-approval queueing, and obsolescence.',
      scope: ['src/agent/build-cards.mjs', 'src/agent/build-cards.test.mjs'],
    },
  ];
}

function routeUnits() {
  return [
    {
      id: 'u-build-route-events',
      goal: 'Build API routes expose state, history, and reconnect-safe card snapshots over loopback-gated endpoints.',
      scope: ['daemon/routes/build.mjs', 'src/build-route.test.mjs', 'src/agent/view-packet.mjs'],
    },
  ];
}

function webUnits() {
  return [
    {
      id: 'u-build-page-status',
      goal: 'The build page renders open cards, plan status, lanes, and history from the build event stream.',
      scope: ['src/agent/**'],
    },
  ];
}

function genericUnits(sources) {
  const focus = conciseText(sources.founderInput) ||
    conciseText(sources.openFlags[0]?.detail) ||
    'the flagged build-runner follow-up';
  return [
    {
      id: 'u-build-followup',
      goal: `The build runner follow-up is implemented and covered for: ${focus}.`,
      scope: ['src/agent/**', 'src/agent/*.test.mjs', 'docs/**'],
    },
  ];
}

function normalizeDraftUnit(unit, index) {
  const id = optionalString(unit.id) ?? `u-${index + 1}`;
  return {
    id: normalizeId(id),
    goal: checkableGoal(unit.goal, id),
    scope: scopeGlobs(unit),
    ...(Array.isArray(unit.dependencies) && unit.dependencies.length > 0
      ? { dependencies: unit.dependencies.map(normalizeId) }
      : {}),
  };
}

function checkableGoal(value, id) {
  const goal = optionalString(value);
  if (goal) return goal.endsWith('.') ? goal : `${goal}.`;
  return `Unit ${id} has passing regression coverage.`;
}

function scopeGlobs(unit) {
  const source = Array.isArray(unit?.scope)
    ? unit.scope
    : Array.isArray(unit?.scope?.declared)
      ? unit.scope.declared
      : Array.isArray(unit?.declaredScope)
        ? unit.declaredScope
        : [];
  return [...new Set(source.map(normalizeScopeGlob).filter(Boolean))];
}

function normalizeScopeGlob(value) {
  const text = optionalString(value);
  if (!text) return null;
  return text.replaceAll('\\', '/').replace(/^\.\//, '');
}

function normalizeSources(sources) {
  const input = isPlainObject(sources) ? sources : {};
  const openFlags = Array.isArray(input.openFlags)
    ? input.openFlags.filter(isPlainObject).map((flag, index) => ({
        kind: optionalString(flag.kind) ?? 'flag',
        detail: flag.detail,
        planId: optionalString(flag.planId) ?? null,
        unitId: optionalString(flag.unitId) ?? null,
        index,
      }))
    : [];

  return {
    strategyText: optionalString(input.strategyText) ?? '',
    openFlags,
    founderInput: optionalString(input.founderInput) ?? '',
  };
}

function sourceText(sources) {
  return [
    sources.founderInput,
    ...sources.openFlags.flatMap((flag) => [
      flag.kind,
      textFromValue(flag.detail),
      flag.planId,
      flag.unitId,
    ]),
    sources.strategyText,
  ].map(optionalString).filter(Boolean).join('\n');
}

function draftTitle(sources) {
  const flag = sources.openFlags[0];
  const focus = conciseText(flag?.detail) || conciseText(sources.founderInput);
  if (focus) return `Build follow-up: ${focus}`;
  return 'Build follow-up plan';
}

function draftId({ sources, now }) {
  const seed = conciseText(sources.openFlags[0]?.detail) ||
    conciseText(sources.founderInput) ||
    'build-followup';
  const day = now.slice(0, 10).replaceAll('-', '');
  return normalizeId(`plan-${day}-${slug(seed)}`);
}

function draftSourceSummary(sources) {
  return {
    strategyText: sources.strategyText,
    founderInput: sources.founderInput,
    openFlags: sources.openFlags.map((flag) => ({
      kind: flag.kind,
      detail: textFromValue(flag.detail),
      planId: flag.planId,
      unitId: flag.unitId,
    })),
  };
}

function conciseText(value) {
  const text = textFromValue(value)
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  return text.length > 80 ? `${text.slice(0, 77).trim()}...` : text;
}

function textFromValue(value) {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.map(textFromValue).filter(Boolean).join(' ');
  if (isPlainObject(value)) return Object.values(value).map(textFromValue).filter(Boolean).join(' ');
  return String(value);
}

function slug(value) {
  const text = optionalString(value) ?? 'draft';
  const slugged = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slugged || 'draft';
}

function normalizeId(value) {
  const text = optionalString(value) ?? 'draft';
  return text
    .replace(/[^a-zA-Z0-9_.:-]+/g, '-')
    .replace(/^-+/, 'u-')
    .slice(0, 120);
}
