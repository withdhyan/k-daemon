import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';

import { iso } from '../../daemon/run.mjs';
import {
  isPlainObject,
  optionalString,
  stripUndefined,
} from '../substrate.mjs';
import {
  BUILD_CARD_KIND_BOUND,
  BUILD_CARD_KIND_DRIFT,
  BUILD_CARD_KIND_INFRA,
  BUILD_CARD_KIND_LINE_STOP,
  BUILD_CARD_KIND_PLAN_APPROVAL,
  BUILD_CARD_KIND_SAFETY_FLOOR,
  BUILD_CARD_STATUS_ANSWERED,
  BUILD_CARD_STATUS_APPLIED,
  BUILD_CARD_STATUS_OBSOLETED,
  BUILD_CARD_STATUS_RE_RAISED,
  BUILD_CARD_TIER_LOOPBACK,
  createBuildCardStore,
} from './build-cards.mjs';
import { applyPlanApproval } from './build-draft.mjs';
import {
  BUILD_STATE_BUILDING,
  BUILD_STATE_CANCELLED,
  BUILD_STATE_DEPLOYED,
  BUILD_STATE_DEPLOYING,
  BUILD_STATE_FAILED,
  BUILD_STATE_HELD,
  BUILD_STATE_INTEGRATED,
  BUILD_STATE_INTEGRATING,
  BUILD_STATE_KILLED,
  BUILD_STATE_ORPHANED,
  BUILD_STATE_QUARANTINED,
  BUILD_STATE_QUEUED,
  BUILD_STATE_ROLLED_BACK,
  BUILD_STATE_VERIFYING,
  FOUNDER_ACTOR,
  canTransition,
  createBuildStateStore,
} from './build-state.mjs';
import * as alignModule from './build-align.mjs';
import * as gatesModule from './build-gates.mjs';
import {
  GIT_PATH,
  checkpoint,
  diffAgainstBase,
  integrate,
  recoverIntegration,
} from './build-git.mjs';
import * as lanesModule from './build-lanes.mjs';
import {
  applyDeployOutcome as applyBootDeployOutcome,
  readDeployOutcome as readBootDeployOutcome,
} from './build-deploy.mjs';

export const TICK_MS = 60_000;
export const LANE_CAP = 3;
export const RUNNER_ACTOR = 'runner';

const execFileAsync = promisify(execFile);
const CLOSED_CARD_STATUSES = new Set([
  BUILD_CARD_STATUS_APPLIED,
  BUILD_CARD_STATUS_OBSOLETED,
  BUILD_CARD_STATUS_RE_RAISED,
]);
const TERMINAL_UNIT_STATES = new Set([
  BUILD_STATE_INTEGRATED,
  BUILD_STATE_DEPLOYED,
  BUILD_STATE_ROLLED_BACK,
  BUILD_STATE_QUARANTINED,
  BUILD_STATE_KILLED,
  BUILD_STATE_CANCELLED,
  BUILD_STATE_FAILED,
]);
const ACTIVE_UNIT_STATES = new Set([
  BUILD_STATE_QUEUED,
  BUILD_STATE_BUILDING,
  BUILD_STATE_VERIFYING,
  BUILD_STATE_INTEGRATING,
  BUILD_STATE_DEPLOYING,
  BUILD_STATE_ORPHANED,
  BUILD_STATE_HELD,
]);
const LANE_OBSERVABLE_STATES = new Set([
  BUILD_STATE_BUILDING,
  BUILD_STATE_HELD,
]);
const LANE_PROMPT_RAW_CONTEXT_MAX_CHARS = 6_000;
const LANE_PROMPT_VALUE_MAX_CHARS = 2_000;
const PRD_LINEAGE_KEYS = Object.freeze([
  'prdLineage',
  'prd_lineage',
  'sourceLineage',
  'source_lineage',
  'lineage',
  'prd',
  'PRD',
]);

export function createBuildRunner(options = {}) {
  const deps = normalizeDeps(options.deps);
  const now = deps.now;
  const monotonicNow = deps.monotonicNow;
  const dataDir = path.resolve(options.dataDir ?? path.join(process.cwd(), 'data'));
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const actor = optionalString(options.actor) ?? RUNNER_ACTOR;
  const store = options.store ?? createBuildStateStore({ dataDir, now, monotonicNow });
  const cards = options.cards ?? createBuildCardStore({ dataDir, now, stateStore: store });
  const laneCap = positiveInteger(options.laneCap ?? deps.laneCap, LANE_CAP);
  const tickMs = positiveInteger(options.tickMs ?? deps.tickMs, TICK_MS);
  const logger = deps.logger;
  let ticking = false;
  let interval = null;

  const context = {
    actor,
    cards,
    dataDir,
    deps,
    laneCap,
    logger,
    monotonicNow,
    now,
    repoRoot,
    store,
    tickMs,
  };

  async function tick() {
    if (ticking) {
      return {
        ok: true,
        skipped: 'busy',
      };
    }

    ticking = true;
    const summary = {
      ok: true,
      actor,
      startedAt: iso(now()),
      renewed: [],
      cardsApplied: [],
      cardsFailed: [],
      takeoverCards: [],
      recovered: [],
      laneCompletions: [],
      watchdogs: [],
      dispatched: [],
      verified: [],
      integrated: [],
      held: [],
      errors: [],
    };

    try {
      await renewOwnLeases(context, summary);
      await reconcileAnsweredCards(context, summary);
      await reconcileDeadDrivers(context, summary);
      await observeLaneCompletions(context, summary);
      await reconcileRecovery(context, summary);
      await runWatchdogs(context, summary);
      await dispatchQueuedUnits(context, summary);
      await processDoneLanes(context, summary);
      await recordCompletedPlans(context, summary);
    } catch (error) {
      summary.ok = false;
      summary.errors.push(errorSummary(error));
      logError(logger, `build runner tick error: ${error.message}`, error);
    } finally {
      summary.finishedAt = iso(now());
      ticking = false;
    }

    return summary;
  }

  function start() {
    if (interval) return interval;
    interval = setInterval(() => {
      tick().catch((error) => {
        logError(logger, `build runner tick error: ${error.message}`, error);
      });
    }, tickMs);
    if (typeof interval.unref === 'function') interval.unref();
    return interval;
  }

  function stop() {
    if (!interval) return;
    clearInterval(interval);
    interval = null;
  }

  return {
    actor,
    dataDir,
    repoRoot,
    start,
    stop,
    tick,
  };
}

export function isDaemonAffectingPath(file) {
  const normalized = normalizeRelPath(file);
  return Boolean(
    normalized &&
    (normalized.startsWith('daemon/') || normalized.startsWith('src/')),
  );
}

export function isDaemonAffectingDiff(diffFiles) {
  return diffFileList(diffFiles).some(isDaemonAffectingPath);
}

async function renewOwnLeases(context, summary) {
  for (const plan of await context.store.listPlans()) {
    if (!isRunnerOwned(plan, context.actor)) continue;
    if (!planHasActiveUnits(plan)) continue;

    try {
      const result = await context.store.renewPlanLease(plan.id, leaseInput(context));
      summary.renewed.push(result.plan.id);
    } catch (error) {
      await pausePlanForInfraError(context, plan.id, error, 'lease renewal failed');
      summary.errors.push(errorSummary(error, { planId: plan.id, phase: 'renew-lease' }));
    }
  }
}

async function reconcileAnsweredCards(context, summary) {
  const answered = (await context.cards.listCards())
    .filter((card) => card.status === BUILD_CARD_STATUS_ANSWERED)
    .sort(compareUpdatedAsc);

  for (const card of answered) {
    try {
      await applyAnsweredCard(context, card, summary);
    } catch (error) {
      summary.errors.push(errorSummary(error, {
        cardId: card.id,
        planId: card.planId,
        phase: 'card-apply',
      }));
      await markCardApplyFailed(context, card, error.message);
      await pausePlanForInfraError(context, card.planId, error, 'card apply failed');
    }
  }
}

async function applyAnsweredCard(context, card, summary) {
  const decision = optionalString(card.answerOption);
  if (!decision) {
    await markCardApplyFailed(context, card, 'missing card answer');
    summary.cardsFailed.push(card.id);
    return;
  }

  if (card.kind === BUILD_CARD_KIND_PLAN_APPROVAL) {
    await applyPlanApproval({
      store: context.store,
      cards: context.cards,
      cardId: card.id,
      optionId: decision,
      deps: {
        actor: context.actor,
        now: context.now(),
        monotonicNow: context.monotonicNow(),
      },
    });
    summary.cardsApplied.push(card.id);
    return;
  }

  if (isTakeoverCard(card) && ['adopt', 'resume', 'continue', 'approve'].includes(decision)) {
    await applyTakeoverCard(context, card);
    summary.cardsApplied.push(card.id);
    return;
  }

  if (decision === 'kill') {
    await applyKillCard(context, card);
    summary.cardsApplied.push(card.id);
    return;
  }

  if (decision === 'quarantine') {
    await applyQuarantineCard(context, card);
    summary.cardsApplied.push(card.id);
    return;
  }

  if (decision === 'retry') {
    const applied = await applyRetryCard(context, card);
    if (applied) summary.cardsApplied.push(card.id);
    else summary.cardsFailed.push(card.id);
    return;
  }

  if (['resume', 'continue', 'approve'].includes(decision)) {
    await applyResumeCard(context, card);
    summary.cardsApplied.push(card.id);
    return;
  }

  await markCardApplyFailed(context, card, `unsupported decision: ${decision}`);
  summary.cardsFailed.push(card.id);
}

async function applyTakeoverCard(context, card) {
  const plan = await context.store.loadPlan(card.planId);
  if (!plan) throw new Error(`plan not found for takeover: ${card.planId}`);

  await context.store.adoptPlanLease(plan.id, leaseInput(context));
  const lanes = await context.store.listLanes();
  const timestamp = iso(context.now());
  for (const lane of lanes.filter((candidate) => candidate.planId === plan.id)) {
    await context.store.saveLane({
      ...lane,
      owner: context.actor,
      adoptedAt: timestamp,
      updatedAt: timestamp,
    });
  }
  await markCardApplied(context, card);
}

async function applyKillCard(context, card) {
  const plan = await context.store.loadPlan(card.planId);
  if (!plan) throw new Error(`plan not found for kill: ${card.planId}`);

  const lane = await laneForCard(context.store, card);
  if (lane) {
    context.deps.lanes.killLane({ lane });
    await context.store.saveLane({
      ...lane,
      state: BUILD_STATE_KILLED,
      killedAt: iso(context.now()),
    });
  }

  if (card.unitId) {
    await transitionUnitToward(context, card.planId, card.unitId, BUILD_STATE_KILLED, {
      actor: FOUNDER_ACTOR,
      reason: 'card kill',
    });
  } else {
    await transitionPlanTowardHeld(context, card.planId, 'card kill');
  }
  await markCardApplied(context, card);
}

async function applyQuarantineCard(context, card) {
  if (!card.unitId) throw new Error('quarantine requires unitId');
  await transitionUnitToward(context, card.planId, card.unitId, BUILD_STATE_QUARANTINED, {
    actor: FOUNDER_ACTOR,
    reason: 'card quarantine',
  });
  await markCardApplied(context, card);
}

async function applyRetryCard(context, card) {
  if (!card.unitId) throw new Error('retry requires unitId');
  const plan = await context.store.loadPlan(card.planId);
  const unit = unitById(plan, card.unitId);
  if (!unit) throw new Error(`unit not found for retry: ${card.unitId}`);
  if (!context.deps.gates.retryAllowed(unit)) {
    await markCardApplyFailed(context, card, 'retry limit reached');
    return false;
  }

  await transitionUnitToward(context, card.planId, card.unitId, BUILD_STATE_BUILDING, {
    actor: context.actor,
    reason: 'card retry',
  });
  await clearUnitLane(context.store, card.planId, card.unitId);
  await markCardApplied(context, card);
  return true;
}

async function applyResumeCard(context, card) {
  if (!card.unitId) {
    await markCardApplied(context, card);
    return;
  }

  // Resume must never regress a terminal unit: transitionUnitToward walks
  // multi-hop edges (integrated -> held -> building), so a stale card answered
  // 'continue' would un-integrate finished work (observed live 2026-07-05:
  // harvested s1/s2/b1/b2/b4/b6 knocked back to held by their old bound cards).
  const plan = await context.store.loadPlan(card.planId);
  const unit = unitById(plan, card.unitId);
  if (unit && TERMINAL_UNIT_STATES.has(unit.state)) {
    await markCardApplied(context, card);
    return;
  }

  await transitionUnitToward(context, card.planId, card.unitId, BUILD_STATE_BUILDING, {
    actor: context.actor,
    reason: 'card resume',
  });
  await markCardApplied(context, card);
}

async function reconcileDeadDrivers(context, summary) {
  const openCards = await context.cards.listCards();
  for (const plan of await context.store.listPlans()) {
    if (isRunnerOwned(plan, context.actor)) continue;
    if (!planHasActiveUnits(plan)) continue;
    if (!plan.lease?.owner) continue;

    const expired = await context.store.isLeaseExpired(plan, leaseInput(context));
    if (!expired) continue;
    if (hasOpenActionCard(openCards, plan.id, 'takeover')) continue;

    const raised = await context.cards.raiseCard({
      kind: BUILD_CARD_KIND_INFRA,
      tier: BUILD_CARD_TIER_LOOPBACK,
      planId: plan.id,
      title: 'Take over expired build lease',
      body: `Plan ${plan.id} is owned by ${plan.lease.owner}, but its lease has expired. Adopt without killing existing lanes.`,
      options: [
        { id: 'adopt', label: 'Adopt', consequence: 'Runner adopts the plan lease and preserves lanes.' },
        { id: 'kill', label: 'Kill', consequence: 'Stop this plan instead of adopting it.' },
      ],
      recommendation: 'adopt',
      action: 'takeover',
      previousOwner: plan.lease.owner,
    });
    summary.takeoverCards.push(raised.card.id);
  }
}

async function observeLaneCompletions(context, summary) {
  const detect = context.deps.lanes.detectLaneCompletion;
  if (typeof detect !== 'function') return;

  for (const lane of await context.store.listLanes()) {
    if (!LANE_OBSERVABLE_STATES.has(lane.state)) continue;
    if (laneDone(lane)) continue;

    const completion = detect({
      lane,
      now: context.now(),
      monotonicNow: context.monotonicNow(),
      isPidAlive: context.deps.lanes.isPidAlive,
      readLogInfo: context.deps.lanes.readLogInfo,
      readLogSize: context.deps.lanes.readLogSize,
      readLogTail: context.deps.lanes.readLogTail,
    });
    if (completion?.done !== true) continue;

    const updatedAt = iso(context.now());
    const harvestSource = await captureHarvestSource(context, lane, { capturedAt: updatedAt });
    const updated = await context.store.saveLane({
      ...lane,
      ...completion,
      id: lane.id,
      planId: lane.planId,
      unitId: lane.unitId,
      worktreePath: lane.worktreePath,
      baseSha: lane.baseSha,
      harvestSource,
      updatedAt,
    });
    await context.store.appendHistory({
      kind: 'build.lane.done',
      planId: updated.planId ?? null,
      unitId: updated.unitId,
      laneId: updated.id,
      reason: completion.completionReason ?? 'lane-completion',
      at: completion.finishedAt ?? updatedAt,
    });
    summary.laneCompletions.push({
      laneId: updated.id,
      unitId: updated.unitId,
      reason: completion.completionReason ?? 'lane-completion',
    });
  }
}

async function reconcileRecovery(context, summary) {
  await recoverDeadBuildingLanes(context, summary);

  const plans = await context.store.listPlans();
  const lanes = await context.store.listLanes();
  for (const plan of plans.filter((candidate) => isRunnerOwned(candidate, context.actor))) {
    if (!planHasActiveUnits(plan)) continue;

    for (const unit of plan.units) {
      try {
        await reconcileUnitRecovery(context, plan, unit, lanes, summary);
      } catch (error) {
        summary.errors.push(errorSummary(error, {
          planId: plan.id,
          unitId: unit.id,
          phase: 'recovery',
        }));
        await holdUnitWithCard(context, plan.id, unit.id, {
          kind: BUILD_CARD_KIND_INFRA,
          title: 'Recovery failed',
          body: error.message,
          reason: 'recovery failed',
        });
      }
    }
  }
}

async function recoverDeadBuildingLanes(context, summary) {
  const isPidAlive = context.deps.lanes.isPidAlive;
  if (typeof isPidAlive !== 'function') return;

  const result = await context.deps.lanes.recoverOrphans({
    store: context.store,
    isPidAlive,
    now: context.now(),
  });
  for (const entry of result?.recovered ?? []) {
    summary.recovered.push({
      laneId: entry.lane?.id,
      unitId: entry.lane?.unitId,
      action: 'orphaned',
    });
  }
}

async function reconcileUnitRecovery(context, plan, unit, lanes, summary) {
  if (unit.state === BUILD_STATE_QUEUED) return;

  const lane = laneForUnit(lanes, unit);
  if (unit.state === BUILD_STATE_BUILDING) {
    if (!needsBuildingRecovery(lane)) return;
    await transitionUnitToward(context, plan.id, unit.id, BUILD_STATE_ORPHANED, {
      actor: context.actor,
      reason: 'building lane recovery',
    });

    const current = unitById(await context.store.loadPlan(plan.id), unit.id);
    if (context.deps.gates.retryAllowed(current)) {
      await dispatchUnit(context, plan.id, unit.id, summary, { reason: 'recovery redispatch' });
    } else {
      await holdUnitWithCard(context, plan.id, unit.id, {
        kind: BUILD_CARD_KIND_BOUND,
        title: 'Retry limit reached',
        body: `Unit ${unit.id} could not be recovered because its retry limit was reached.`,
        reason: 'retry limit reached',
      });
    }
    return;
  }

  // A crash between the orphaned transition and the recovery re-dispatch
  // (e.g. a deploy restart) leaves the unit parked in `orphaned` with no live
  // lane; without this branch it is skipped forever (observed live 2026-07-05:
  // s1/s2 orphaned for hours).
  if (unit.state === BUILD_STATE_ORPHANED) {
    if (context.deps.gates.retryAllowed(unit)) {
      await dispatchUnit(context, plan.id, unit.id, summary, { reason: 'orphan recovery redispatch' });
    } else {
      await holdUnitWithCard(context, plan.id, unit.id, {
        kind: BUILD_CARD_KIND_BOUND,
        title: 'Retry limit reached',
        body: `Unit ${unit.id} stayed orphaned and its retry limit was reached.`,
        reason: 'retry limit reached',
      });
    }
    return;
  }

  if (unit.state === BUILD_STATE_VERIFYING) {
    await processUnitVerification(context, plan.id, unit.id, lane, summary, { recovery: true });
    return;
  }

  if (unit.state === BUILD_STATE_INTEGRATING) {
    await recoverIntegratingUnit(context, plan.id, unit.id, unit, summary);
    return;
  }

  if (unit.state === BUILD_STATE_DEPLOYING) {
    await recoverDeployingUnit(context, plan.id, unit.id, summary);
  }
}

async function recoverIntegratingUnit(context, planId, unitId, unit, summary) {
  const checkpointSha = optionalString(unit.checkpointSha);
  if (!checkpointSha) throw new Error('integrating unit has no checkpointSha');

  const recovery = await context.deps.git.recoverIntegration({
    repoRoot: context.repoRoot,
    checkpointSha,
    now: context.now(),
  });
  await transitionUnitToward(context, planId, unitId, BUILD_STATE_HELD, {
    actor: context.actor,
    reason: 'integration recovered to checkpoint',
  });
  await patchUnit(context.store, planId, unitId, {
    integrationRecovered: true,
    integrationRecovery: recovery,
  });
  summary.recovered.push({ planId, unitId, action: 'recover-integration' });
}

async function recoverDeployingUnit(context, planId, unitId, summary) {
  const outcome = await readDeployOutcome(context, planId, unitId);
  if (!outcome) {
    await holdUnitWithCard(context, planId, unitId, {
      kind: BUILD_CARD_KIND_INFRA,
      title: 'Deploy outcome missing',
      body: 'The boot layer did not leave a deploy outcome file. U10 owns deploy execution; U9 holds here.',
      reason: 'deploy outcome missing',
    });
    summary.recovered.push({ planId, unitId, action: 'deploy-outcome-missing' });
    return;
  }

  const applied = await context.deps.applyDeployOutcome({
    store: context.store,
    cards: context.cards,
    planId,
    unitId,
    outcome,
    actor: context.actor,
    now: context.now(),
    monotonicNow: context.monotonicNow(),
  });
  await patchUnit(context.store, planId, unitId, {
    needsDeploy: false,
    deployPending: false,
    deployOutcome: outcome,
  });
  summary.recovered.push({ planId, unitId, action: 'deploy-outcome', target: applied.target });
}

async function runWatchdogs(context, summary) {
  const plansById = new Map((await context.store.listPlans()).map((plan) => [plan.id, plan]));
  for (const lane of await context.store.listLanes()) {
    if (lane.state !== BUILD_STATE_BUILDING) continue;
    if (laneDone(lane)) continue;

    const result = context.deps.lanes.watchLane({
      lane,
      monotonicNow: context.monotonicNow(),
      readLogSize: context.deps.lanes.readLogSize,
    });
    if (result === 'continue' || result === 'reset-baseline') {
      await updateWatchBaseline(context, lane, result);
      continue;
    }
    if (result !== 'kill-stall' && result !== 'kill-ceiling') continue;

    const plan = plansById.get(lane.planId);
    if (!isRunnerOwned(plan, context.actor)) {
      await raiseCard(context, {
        kind: BUILD_CARD_KIND_INFRA,
        planId: lane.planId,
        unitId: lane.unitId,
        laneId: lane.id,
        title: 'Non-owned lane stalled',
        body: `Lane ${lane.id} reported ${result}, but the runner does not own its plan lease.`,
        action: 'non-owned-stall',
        recommendation: 'continue',
      });
      summary.watchdogs.push({ laneId: lane.id, action: 'card-only', result });
      continue;
    }

    await handleOwnedWatchdogKill(context, lane, result, summary);
  }
}

async function handleOwnedWatchdogKill(context, lane, watchdogResult, summary) {
  context.deps.lanes.killLane({ lane });
  const classification = context.deps.lanes.classifyFailure({
    lane,
    watchdogResult,
    stalledAtZeroOutput: watchdogResult === 'kill-stall' && Number(lane.lastLogSize ?? 0) === 0,
  });

  if (classification === 'infra') {
    await context.store.saveLane({
      ...lane,
      state: BUILD_STATE_FAILED,
      failureClassification: 'infra',
      watchdogResult,
      killedAt: iso(context.now()),
    });
    await holdUnitWithCard(context, lane.planId, lane.unitId, {
      kind: BUILD_CARD_KIND_INFRA,
      title: 'Lane infrastructure failure',
      body: `Lane ${lane.id} hit ${watchdogResult}; classified as infra.`,
      reason: 'lane infra failure',
    });
    await transitionPlanTowardHeld(context, lane.planId, 'lane infra failure');
    summary.watchdogs.push({ laneId: lane.id, action: 'infra-held', result: watchdogResult });
    return;
  }

  const debited = context.deps.lanes.applyFailureBudget(lane, classification);
  await context.store.saveLane({
    ...debited,
    state: BUILD_STATE_ORPHANED,
    watchdogResult,
    killedAt: iso(context.now()),
  });
  await transitionUnitToward(context, lane.planId, lane.unitId, BUILD_STATE_ORPHANED, {
    actor: context.actor,
    reason: `watchdog ${watchdogResult}`,
  });

  const unit = unitById(await context.store.loadPlan(lane.planId), lane.unitId);
  if (context.deps.gates.retryAllowed(unit)) {
    await dispatchUnit(context, lane.planId, lane.unitId, summary, { reason: 'watchdog redispatch' });
    summary.watchdogs.push({ laneId: lane.id, action: 'retry', result: watchdogResult });
  } else {
    await holdUnitWithCard(context, lane.planId, lane.unitId, {
      kind: BUILD_CARD_KIND_BOUND,
      title: 'Lane retry limit reached',
      body: `Lane ${lane.id} hit ${watchdogResult}; retry limit reached.`,
      reason: 'retry limit reached',
    });
    summary.watchdogs.push({ laneId: lane.id, action: 'held', result: watchdogResult });
  }
}

async function dispatchQueuedUnits(context, summary) {
  let active = await activeLaneCount(context.store);
  const plans = await context.store.listPlans();

  for (const plan of plans.filter((candidate) => isRunnerOwned(candidate, context.actor))) {
    if (planHasDeployPending(plan)) continue;
    if (!planHasActiveUnits(plan)) continue;

    for (const unit of plan.units) {
      if (active >= context.laneCap) return;
      if (unit.state !== BUILD_STATE_QUEUED) continue;

      try {
        const dispatched = await dispatchUnit(context, plan.id, unit.id, summary, { reason: 'queued dispatch' });
        if (dispatched) active += 1;
      } catch (error) {
        summary.errors.push(errorSummary(error, {
          planId: plan.id,
          unitId: unit.id,
          phase: 'dispatch',
        }));
        await holdUnitWithCard(context, plan.id, unit.id, {
          kind: BUILD_CARD_KIND_INFRA,
          title: 'Dispatch error',
          body: error.message,
          reason: 'dispatch error',
        });
      }
    }
  }
}

async function dispatchUnit(context, planId, unitId, summary, options = {}) {
  const plan = await context.store.loadPlan(planId);
  const unit = unitById(plan, unitId);
  if (!unit) throw new Error(`unit not found: ${unitId}`);

  if (!context.deps.gates.retryAllowed(unit)) {
    await holdUnitWithCard(context, planId, unitId, {
      kind: BUILD_CARD_KIND_BOUND,
      title: 'Unit attempt limit reached',
      body: `Unit ${unitId} reached its attempt limit before dispatch.`,
      reason: 'unit attempt limit reached',
    });
    return false;
  }

  const mark = await context.deps.git.checkpoint({
    repoRoot: context.repoRoot,
    now: context.now(),
  });
  const baseSha = requiredString(mark.sha, 'checkpoint.sha');
  const result = await context.deps.lanes.dispatchLane({
    store: context.store,
    planId,
    unitId,
    prompt: promptForUnit(unit, plan),
    baseSha,
    repoRoot: context.repoRoot,
    codexPath: context.deps.codexPath,
    now: context.now(),
    monotonicNow: context.monotonicNow(),
  });

  if (result?.ok !== true) {
    await holdUnitWithCard(context, planId, unitId, {
      kind: result?.card === 'bound' || result?.reason === 'disk'
        ? BUILD_CARD_KIND_BOUND
        : BUILD_CARD_KIND_INFRA,
      title: result?.reason === 'disk' ? 'Disk preflight failed' : 'Lane dispatch failed',
      body: result?.reason ? `Dispatch refused: ${result.reason}` : 'Lane dispatch failed.',
      reason: result?.reason ?? 'dispatch failed',
    });
    return false;
  }

  const lane = result.lane ?? {
    id: result.laneId,
    planId,
    unitId,
    state: BUILD_STATE_BUILDING,
    worktreePath: result.worktreePath,
    baseSha,
  };
  if (lane?.id) {
    await context.store.saveLane({
      ...lane,
      planId,
      unitId,
      baseSha: lane.baseSha ?? baseSha,
      repoRoot: lane.repoRoot ?? context.repoRoot,
      state: lane.state ?? BUILD_STATE_BUILDING,
    });
  }

  await transitionUnitToward(context, planId, unitId, BUILD_STATE_BUILDING, {
    actor: context.actor,
    laneId: lane.id,
    reason: options.reason ?? 'dispatch',
  });
  await patchUnit(context.store, planId, unitId, {
    attempts: positiveInteger(unit.attempts, 0) + 1,
    laneId: lane.id,
    baseShaAtDispatch: baseSha,
    lastDispatchReason: options.reason ?? 'dispatch',
  });
  await context.store.appendHistory({
    kind: 'build.unit.dispatched',
    planId,
    unitId,
    laneId: lane.id,
    baseSha,
    at: iso(context.now()),
    reason: options.reason ?? 'dispatch',
  });
  summary.dispatched.push({ planId, unitId, laneId: lane.id });
  return true;
}

async function processDoneLanes(context, summary) {
  const lanes = (await context.store.listLanes())
    .filter((lane) => lane.state === BUILD_STATE_BUILDING && laneDone(lane));

  for (const lane of lanes) {
    const plan = await context.store.loadPlan(lane.planId);
    if (!isRunnerOwned(plan, context.actor)) continue;
    try {
      if (laneExitedUnsuccessfully(lane)) {
        await handleDoneLaneExitFailure(context, lane, summary);
        continue;
      }
      await processUnitVerification(context, lane.planId, lane.unitId, lane, summary);
    } catch (error) {
      summary.errors.push(errorSummary(error, {
        planId: lane.planId,
        unitId: lane.unitId,
        laneId: lane.id,
        phase: 'process-done-lane',
      }));
      await holdUnitWithCard(context, lane.planId, lane.unitId, {
        kind: BUILD_CARD_KIND_INFRA,
        title: 'Lane processing error',
        body: error.message,
        reason: 'lane processing error',
      });
    }
  }
}

async function handleDoneLaneExitFailure(context, lane, summary) {
  const logTail = readLaneLogTail(context, lane);
  const classification = context.deps.lanes.classifyFailure({
    lane,
    exitCode: lane.exitCode,
    exitSignal: lane.exitSignal,
    logTail,
  });
  const timestamp = iso(context.now());

  if (classification === 'infra') {
    await context.store.saveLane({
      ...lane,
      state: BUILD_STATE_FAILED,
      failureClassification: 'infra',
      exitFailureAt: timestamp,
      updatedAt: timestamp,
    });
    await holdUnitWithCard(context, lane.planId, lane.unitId, {
      kind: BUILD_CARD_KIND_INFRA,
      title: 'Lane process failure',
      body: `Lane ${lane.id} exited unsuccessfully (${exitSummary(lane)}); classified as infra.`,
      reason: 'lane process failure',
    });
    await transitionPlanTowardHeld(context, lane.planId, 'lane process failure');
    summary.held.push({ planId: lane.planId, unitId: lane.unitId, reason: 'lane process failure' });
    return;
  }

  const debited = context.deps.lanes.applyFailureBudget(lane, classification);
  await context.store.saveLane({
    ...debited,
    state: BUILD_STATE_ORPHANED,
    exitFailureAt: timestamp,
    updatedAt: timestamp,
  });
  await transitionUnitToward(context, lane.planId, lane.unitId, BUILD_STATE_ORPHANED, {
    actor: context.actor,
    reason: 'lane process failure',
  });

  const unit = unitById(await context.store.loadPlan(lane.planId), lane.unitId);
  if (context.deps.gates.retryAllowed(unit)) {
    await dispatchUnit(context, lane.planId, lane.unitId, summary, { reason: 'lane process failure redispatch' });
    return;
  }

  await holdUnitWithCard(context, lane.planId, lane.unitId, {
    kind: BUILD_CARD_KIND_BOUND,
    title: 'Lane retry limit reached',
    body: `Lane ${lane.id} exited unsuccessfully (${exitSummary(lane)}); retry limit reached.`,
    reason: 'retry limit reached',
  });
}

async function processUnitVerification(context, planId, unitId, lane, summary, options = {}) {
  const plan = await context.store.loadPlan(planId);
  const unit = unitById(plan, unitId);
  if (!unit) throw new Error(`unit not found: ${unitId}`);
  if (!lane) throw new Error(`lane not found for unit: ${unitId}`);
  const harvestSource = await ensureHarvestSource(context, lane);
  const sourceWorktree = requiredString(harvestSource.worktreePath ?? lane.worktreePath, 'harvestSource.worktreePath');
  const sourceLane = {
    ...lane,
    worktreePath: sourceWorktree,
    harvestSource,
  };

  if (unit.state !== BUILD_STATE_VERIFYING) {
    await transitionUnitToward(context, planId, unitId, BUILD_STATE_VERIFYING, {
      actor: context.actor,
      reason: options.recovery ? 'recovery verify' : 'lane done',
    });
  }

  const currentUnit = unitById(await context.store.loadPlan(planId), unitId);
  const suite = await context.deps.gates.suiteGate({
    worktreePath: sourceWorktree,
    lane: sourceLane,
    plan,
    unit: currentUnit,
    attempts: currentUnit.attempts,
  });
  summary.verified.push({ planId, unitId, gate: 'suite', ok: suite.ok });
  if (suite.ok !== true) {
    await context.deps.gates.redFoundation({
      store: context.store,
      cards: context.cards,
      planId,
      unitId,
      actor: context.actor,
      gateResult: suite,
    });
    await context.store.saveLane({
      ...sourceLane,
      state: BUILD_STATE_HELD,
      heldAt: iso(context.now()),
    });
    summary.held.push({ planId, unitId, reason: 'suite gate failed' });
    return;
  }

  const baseRef = optionalString(harvestSource.baseRef ?? harvestSource.baseSha ?? lane.baseSha ?? currentUnit.baseShaAtDispatch);
  if (!baseRef) throw new Error(`lane ${lane.id} has no baseSha`);
  const diff = await diffFromHarvestSource(context, harvestSource, { baseRef, laneId: lane.id });
  const hygiene = await context.deps.gates.hygieneGate({
    worktreePath: sourceWorktree,
    baseRef,
    diff,
    diffText: diff.diff ?? diff.stdout,
  });
  summary.verified.push({ planId, unitId, gate: 'hygiene', ok: hygiene.ok });
  if (hygiene.ok !== true) {
    await holdUnitWithCard(context, planId, unitId, {
      kind: BUILD_CARD_KIND_LINE_STOP,
      title: 'Hygiene gate failed',
      body: JSON.stringify(hygiene.violations ?? hygiene, null, 2),
      reason: 'hygiene gate failed',
    });
    return;
  }

  const diffInput = diffInputFor(diff);
  const alignment = context.deps.align.integrationCheck({
    diffFiles: diffInput,
    unitScope: unitScopeGlobs(currentUnit),
  });
  if (alignment.ok !== true) {
    await holdForAlignment(context, planId, unitId, alignment);
    summary.held.push({ planId, unitId, reason: 'alignment hold' });
    return;
  }

  const harvestScope = harvestScopeIntersection({
    diffFiles: diffInput,
    unitScope: unitScopeGlobs(currentUnit),
    matchesGlob: context.deps.align.matchesGlob,
  });
  if (harvestScope.ok !== true) {
    await holdUnitWithCard(context, planId, unitId, {
      kind: BUILD_CARD_KIND_INFRA,
      title: 'Harvest scope mismatch',
      body: JSON.stringify(stripUndefined({
        reason: harvestScope.reason,
        laneId: lane.id,
        harvestSource,
        unitScope: unitScopeGlobs(currentUnit),
        harvestedFiles: harvestScope.files,
        intersection: harvestScope.intersection,
      }), null, 2),
      reason: 'harvest scope mismatch',
    });
    summary.held.push({ planId, unitId, reason: 'harvest scope mismatch' });
    return;
  }

  if (isDaemonAffectingDiff(diffInput)) {
    await markDeployPending(context, planId, unitId, diffInput);
    summary.held.push({ planId, unitId, reason: 'deploy pending' });
    return;
  }

  const headCheck = await harvestHeadCheck(context, harvestSource);
  if (headCheck.ok !== true) {
    await holdUnitWithCard(context, planId, unitId, {
      kind: BUILD_CARD_KIND_INFRA,
      title: 'Harvest source changed',
      body: JSON.stringify(stripUndefined({
        reason: headCheck.reason,
        laneId: lane.id,
        harvestSource,
        currentHeadSha: headCheck.currentHeadSha,
      }), null, 2),
      reason: 'harvest source changed',
    });
    summary.held.push({ planId, unitId, reason: 'harvest source changed' });
    return;
  }

  const mark = await context.deps.git.checkpoint({
    repoRoot: context.repoRoot,
    now: context.now(),
  });
  await transitionUnitToward(context, planId, unitId, BUILD_STATE_INTEGRATING, {
    actor: context.actor,
    checkpointSha: mark.sha,
    reason: 'pre-integrate checkpoint',
  });

  const integration = await context.deps.git.integrate({
    repoRoot: context.repoRoot,
    laneWorktree: sourceWorktree,
    baseShaAtGate: baseRef,
    checkpointSha: mark.sha,
    harvestSource,
    now: context.now(),
  });
  if (integration.ok !== true) {
    await holdUnitWithCard(context, planId, unitId, {
      kind: integration.protectedPath ? BUILD_CARD_KIND_SAFETY_FLOOR : BUILD_CARD_KIND_INFRA,
      title: integration.conflict ? 'Integration conflict' : 'Integration failed',
      body: JSON.stringify(stripIntegration(integration), null, 2),
      reason: integration.conflict ? 'integration conflict' : 'integration failed',
    });
    return;
  }

  if (integration.regateRequired === true) {
    const regate = await context.deps.gates.suiteGate({
      worktreePath: context.repoRoot,
      repoRoot: context.repoRoot,
      lane: sourceLane,
      plan,
      unit: currentUnit,
      attempts: currentUnit.attempts,
      regate: true,
    });
    summary.verified.push({ planId, unitId, gate: 'regate', ok: regate.ok });
    if (regate.ok !== true) {
      await context.deps.git.recoverIntegration({
        repoRoot: context.repoRoot,
        checkpointSha: mark.sha,
        now: context.now(),
      });
      await holdUnitWithCard(context, planId, unitId, {
        kind: BUILD_CARD_KIND_LINE_STOP,
        title: 'Combined suite gate failed',
        body: regate.outputTail ?? regate.output ?? 'The suite failed after integrating onto the advanced base.',
        reason: 'combined suite failed',
      });
      return;
    }
  }

  const commit = await context.deps.git.commit({
    repoRoot: context.repoRoot,
    message: commitMessageForUnit(currentUnit),
    plan,
    unit: currentUnit,
    lane: sourceLane,
    integration,
    harvestSource,
  });
  if (commit?.ok === false) {
    await holdUnitWithCard(context, planId, unitId, {
      kind: BUILD_CARD_KIND_INFRA,
      title: 'Commit failed',
      body: commit.error ?? 'git commit failed',
      reason: 'commit failed',
    });
    return;
  }

  await transitionUnitToward(context, planId, unitId, BUILD_STATE_INTEGRATED, {
    actor: context.actor,
    reason: 'unit integrated',
  });
  await patchUnit(context.store, planId, unitId, {
    integratedAt: iso(context.now()),
    integration,
    commit,
  });
  await context.store.saveLane({
    ...sourceLane,
    state: BUILD_STATE_INTEGRATED,
    integratedAt: iso(context.now()),
  });
  await context.store.appendHistory({
    kind: 'build.unit.committed',
    planId,
    unitId,
    laneId: lane.id,
    message: commitMessageForUnit(currentUnit),
    commitSha: commit?.sha ?? null,
    at: iso(context.now()),
  });
  summary.integrated.push({ planId, unitId, laneId: lane.id });
}

async function ensureHarvestSource(context, lane) {
  const existing = normalizeHarvestSource(lane.harvestSource, lane);
  if (existing?.worktreePath && existing?.baseRef) return existing;

  const captured = await captureHarvestSource(context, lane);
  await context.store.saveLane({
    ...lane,
    harvestSource: captured,
    updatedAt: iso(context.now()),
  });
  return captured;
}

async function captureHarvestSource(context, lane, options = {}) {
  const worktreePath = optionalString(lane.worktreePath);
  const baseRef = optionalString(lane.baseSha);
  const capturedAt = optionalString(options.capturedAt) ?? iso(context.now());
  const source = {
    laneId: lane.id,
    worktreePath,
    baseRef,
    capturedAt,
  };

  const headSha = worktreePath ? await readLaneHeadSha(context, worktreePath) : null;
  if (!worktreePath || !baseRef) {
    return stripUndefined({
      ...source,
      headSha,
      captureError: !worktreePath ? 'lane worktreePath missing' : 'lane baseSha missing',
    });
  }

  try {
    const diff = await context.deps.git.diffAgainstBase({
      repoRoot: worktreePath,
      worktreePath,
      baseRef,
      laneId: lane.id,
      headSha,
      harvestCapture: true,
    });
    const diffInput = diffInputFor(diff);
    return stripUndefined({
      ...source,
      headSha,
      diffDigest: digestHarvestDiff(diffInput),
      diffFiles: diffFileList(diffInput),
    });
  } catch (error) {
    return stripUndefined({
      ...source,
      headSha,
      captureError: optionalString(error?.message) ?? String(error),
    });
  }
}

async function readLaneHeadSha(context, worktreePath) {
  const reader = context.deps.git.revParseHead;
  try {
    if (typeof reader === 'function') {
      const result = await reader({ repoRoot: worktreePath, worktreePath });
      return optionalString(result?.sha ?? result?.stdout ?? result);
    }
    const result = await execGit(worktreePath, ['rev-parse', 'HEAD']);
    return optionalString(result.stdout.trim());
  } catch {
    return null;
  }
}

function normalizeHarvestSource(value, lane) {
  if (!isPlainObject(value)) return null;
  const laneId = optionalString(value.laneId);
  if (laneId && laneId !== lane.id) return null;
  return stripUndefined({
    ...value,
    laneId: lane.id,
    worktreePath: optionalString(value.worktreePath),
    baseRef: optionalString(value.baseRef ?? value.baseSha ?? lane.baseSha),
    headSha: optionalString(value.headSha),
    diffDigest: optionalString(value.diffDigest),
    diffFiles: Array.isArray(value.diffFiles) ? diffFileList(value.diffFiles) : undefined,
  });
}

async function diffFromHarvestSource(context, harvestSource, options = {}) {
  const worktreePath = requiredString(harvestSource.worktreePath, 'harvestSource.worktreePath');
  const baseRef = requiredString(harvestSource.baseRef ?? options.baseRef, 'harvestSource.baseRef');
  const diff = await context.deps.git.diffAgainstBase({
    repoRoot: worktreePath,
    worktreePath,
    baseRef,
    laneId: harvestSource.laneId ?? options.laneId,
    headSha: harvestSource.headSha,
    diffDigest: harvestSource.diffDigest,
    harvestSource,
  });

  const diffInput = diffInputFor(diff);
  const actualDigest = digestHarvestDiff(diffInput);
  if (harvestSource.diffDigest && harvestSource.diffDigest !== actualDigest) {
    throw new Error(`harvest source diff digest changed for lane ${harvestSource.laneId ?? options.laneId}`);
  }
  return diff;
}

function digestHarvestDiff(value) {
  const input = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return `sha256:${createHash('sha256').update(input).digest('hex')}`;
}

function diffInputFor(diff) {
  if (typeof diff?.diff === 'string' && diff.diff.length > 0) return diff.diff;
  if (typeof diff?.stdout === 'string' && diff.stdout.length > 0) return diff.stdout;
  if (Array.isArray(diff?.files)) return diff.files;
  if (Array.isArray(diff?.diffFiles)) return diff.diffFiles;
  return '';
}

function harvestScopeIntersection({ diffFiles, unitScope, matchesGlob } = {}) {
  const files = diffFileList(diffFiles);
  const scope = unitScopeGlobs({ scope: unitScope });
  if (scope.length === 0) {
    return {
      ok: false,
      reason: 'scope_undeclared',
      files,
      intersection: [],
    };
  }

  const matcher = typeof matchesGlob === 'function'
    ? matchesGlob
    : () => false;
  const intersection = files.filter((file) => scope.some((glob) => matcher(file, glob)));
  return {
    ok: intersection.length > 0,
    reason: intersection.length > 0 ? null : 'empty_scope_intersection',
    files,
    intersection,
  };
}

async function harvestHeadCheck(context, harvestSource) {
  if (!harvestSource.headSha) return { ok: true };
  const currentHeadSha = await readLaneHeadSha(context, harvestSource.worktreePath);
  if (!currentHeadSha) {
    return {
      ok: false,
      reason: 'head_unreadable',
      currentHeadSha: null,
    };
  }
  return {
    ok: currentHeadSha === harvestSource.headSha,
    reason: currentHeadSha === harvestSource.headSha ? null : 'head_changed',
    currentHeadSha,
  };
}

async function markDeployPending(context, planId, unitId, diffInput) {
  const mark = await context.deps.git.checkpoint({
    repoRoot: context.repoRoot,
    now: context.now(),
  });
  await transitionUnitToward(context, planId, unitId, BUILD_STATE_INTEGRATING, {
    actor: context.actor,
    checkpointSha: mark.sha,
    reason: 'deploy pending',
  });
  await patchUnit(context.store, planId, unitId, {
    needsDeploy: true,
    deployPending: true,
    deployDiffFiles: diffFileList(diffInput),
  });
  await raiseCard(context, {
    kind: BUILD_CARD_KIND_INFRA,
    planId,
    unitId,
    title: 'Deploy pending',
    body: 'This unit changes daemon-affecting files. U10 owns deploy execution, so U9 stops it at integrating.',
    action: 'deploy-pending',
    recommendation: 'continue',
  });
}

async function holdForAlignment(context, planId, unitId, alignment) {
  const hold = alignment.holds?.[0] ?? {};
  const kind = [BUILD_CARD_KIND_SAFETY_FLOOR, BUILD_CARD_KIND_DRIFT].includes(hold.kind)
    ? hold.kind
    : BUILD_CARD_KIND_SAFETY_FLOOR;
  await holdUnitWithCard(context, planId, unitId, {
    kind,
    title: kind === BUILD_CARD_KIND_SAFETY_FLOOR ? 'Safety floor hold' : 'Scope drift hold',
    body: JSON.stringify(alignment, null, 2),
    reason: 'alignment hold',
  });
}

async function holdUnitWithCard(context, planId, unitId, card) {
  await transitionUnitToward(context, planId, unitId, BUILD_STATE_HELD, {
    actor: context.actor,
    reason: card.reason,
  });
  const lane = (await context.store.listLanes())
    .find((candidate) => candidate.planId === planId && candidate.unitId === unitId);
  if (lane && !TERMINAL_UNIT_STATES.has(lane.state)) {
    await context.store.saveLane({
      ...lane,
      state: BUILD_STATE_HELD,
      heldAt: iso(context.now()),
    });
  }
  await raiseCard(context, {
    kind: card.kind ?? BUILD_CARD_KIND_INFRA,
    planId,
    unitId,
    title: card.title ?? 'Build held',
    body: card.body ?? card.reason ?? '',
    action: card.action,
    recommendation: card.recommendation ?? 'retry',
  });
}

async function raiseCard(context, input) {
  return context.cards.raiseCard({
    tier: BUILD_CARD_TIER_LOOPBACK,
    options: decisionOptions(input.kind),
    ...input,
  });
}

async function transitionUnitToward(context, planId, unitId, target, options = {}) {
  const actor = options.actor ?? context.actor;
  let plan = await context.store.loadPlan(planId);
  let unit = unitById(plan, unitId);
  if (!unit) throw new Error(`unit not found: ${unitId}`);
  if (unit.state === target) return { plan };

  if (canTransition(unit.state, target)) {
    return context.store.transition(omitUndefined({
      planId,
      unitId,
      to: target,
      actor,
      laneId: options.laneId,
      checkpointSha: options.checkpointSha,
      reason: options.reason,
      now: context.now(),
      monotonicNow: context.monotonicNow(),
    }));
  }

  if (unit.state !== BUILD_STATE_HELD && canTransition(unit.state, BUILD_STATE_HELD)) {
    await context.store.transition({
      planId,
      unitId,
      to: BUILD_STATE_HELD,
      actor,
      reason: options.reason ?? `prepare ${target}`,
      now: context.now(),
      monotonicNow: context.monotonicNow(),
    });
    plan = await context.store.loadPlan(planId);
    unit = unitById(plan, unitId);
    if (unit.state === target) return { plan };
    if (canTransition(unit.state, target)) {
      return context.store.transition(omitUndefined({
        planId,
        unitId,
        to: target,
        actor,
        laneId: options.laneId,
        checkpointSha: options.checkpointSha,
        reason: options.reason,
        now: context.now(),
        monotonicNow: context.monotonicNow(),
      }));
    }
  }

  throw new Error(`cannot transition ${unitId} from ${unit.state} to ${target}`);
}

async function transitionPlanTowardHeld(context, planId, reason) {
  const plan = await context.store.loadPlan(planId);
  if (!plan || plan.status === BUILD_STATE_HELD) return;
  if (!canTransition(plan.status, BUILD_STATE_HELD)) return;
  await context.store.transition({
    planId,
    to: BUILD_STATE_HELD,
    actor: context.actor,
    reason,
    now: context.now(),
    monotonicNow: context.monotonicNow(),
  });
}

async function pausePlanForInfraError(context, planId, error, title) {
  const plan = await context.store.loadPlan(planId).catch(() => null);
  if (!plan) return;

  for (const unit of plan.units.filter((candidate) => ACTIVE_UNIT_STATES.has(candidate.state))) {
    if (unit.state === BUILD_STATE_HELD) continue;
    if (!canTransition(unit.state, BUILD_STATE_HELD)) continue;
    await transitionUnitToward(context, planId, unit.id, BUILD_STATE_HELD, {
      actor: context.actor,
      reason: title,
    });
  }
  await transitionPlanTowardHeld(context, planId, title);
  await raiseCard(context, {
    kind: BUILD_CARD_KIND_INFRA,
    planId,
    title,
    body: error.message,
    action: 'infra-error',
    recommendation: 'continue',
  });
}

async function patchUnit(store, planId, unitId, patch) {
  const plan = await store.loadPlan(planId);
  const index = plan.units.findIndex((unit) => unit.id === unitId);
  if (index === -1) throw new Error(`unit not found: ${unitId}`);
  plan.units[index] = {
    ...plan.units[index],
    ...patch,
    updatedAt: iso(new Date()),
  };
  return store.savePlan(plan);
}

async function clearUnitLane(store, planId, unitId) {
  return patchUnit(store, planId, unitId, {
    laneId: null,
  });
}

async function markCardApplied(context, card) {
  await context.cards.markApplied({
    cardId: card.id,
    appliedBy: context.actor,
    now: context.now(),
  });
}

async function markCardApplyFailed(context, card, reason) {
  if (CLOSED_CARD_STATUSES.has(card.status)) return;
  await context.cards.markApplyFailed({
    cardId: card.id,
    reason,
    now: context.now(),
  });
}

async function recordCompletedPlans(context, summary) {
  for (const plan of await context.store.listPlans()) {
    if (!plan.units.length) continue;
    if (!plan.units.every((unit) =>
      unit.state === BUILD_STATE_INTEGRATED || unit.state === BUILD_STATE_DEPLOYED)) continue;
    if (plan.completedAt) continue;

    await context.store.savePlan({
      ...plan,
      completedAt: iso(context.now()),
    });
    await context.store.appendHistory({
      kind: 'build.plan.completed',
      planId: plan.id,
      at: iso(context.now()),
    });
    summary.completed ??= [];
    summary.completed.push(plan.id);
  }
}

async function updateWatchBaseline(context, lane, result) {
  const now = context.monotonicNow();
  const next = {
    ...lane,
    lastWatchMonotonic: now,
    watchdogResult: result,
  };
  if (typeof context.deps.lanes.readLogSize === 'function') {
    const size = context.deps.lanes.readLogSize(lane);
    if (Number.isFinite(Number(size))) {
      next.lastLogSize = Number(size);
      if (Number(size) !== Number(lane.lastLogSize)) next.lastLogChangeAt = now;
    }
  }
  await context.store.saveLane(next);
}

async function readDeployOutcome(context, planId, unitId) {
  if (typeof context.deps.readDeployOutcome === 'function') {
    return context.deps.readDeployOutcome({
      planId,
      unitId,
      dataDir: context.dataDir,
      installRoot: context.repoRoot,
      repoRoot: context.repoRoot,
    });
  }

  return readBootDeployOutcome({
    planId,
    unitId,
    installRoot: context.repoRoot,
    repoRoot: context.repoRoot,
  });
}

async function defaultCommit({ repoRoot, message }) {
  const status = await execGit(repoRoot, ['status', '--porcelain']);
  if (!status.stdout.trim()) {
    return {
      ok: true,
      noop: true,
    };
  }

  await execGit(repoRoot, ['commit', '-m', message]);
  const head = await execGit(repoRoot, ['rev-parse', 'HEAD']);
  return {
    ok: true,
    sha: head.stdout.trim(),
  };
}

async function execGit(cwd, args) {
  const result = await execFileAsync(GIT_PATH, args, {
    cwd,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  return {
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
}

async function activeLaneCount(store) {
  return (await store.listLanes())
    .filter((lane) => lane.state === BUILD_STATE_BUILDING && !laneDone(lane))
    .length;
}

async function laneForCard(store, card) {
  if (card.laneId) return store.loadLane(card.laneId);
  if (!card.unitId) return null;
  const lanes = await store.listLanes();
  return lanes.find((lane) => lane.planId === card.planId && lane.unitId === card.unitId) ?? null;
}

function laneForUnit(lanes, unit) {
  if (!unit) return null;
  if (unit.laneId) {
    const byId = lanes.find((lane) => lane.id === unit.laneId);
    if (byId) return byId;
  }
  return lanes.find((lane) => lane.unitId === unit.id) ?? null;
}

function needsBuildingRecovery(lane) {
  return !lane ||
    lane.state === BUILD_STATE_ORPHANED ||
    lane.state === BUILD_STATE_FAILED ||
    lane.state === BUILD_STATE_KILLED ||
    lane.state === BUILD_STATE_HELD;
}

function laneDone(lane) {
  return Boolean(
    lane.done === true ||
    lane.settled === true ||
    lane.finishedAt ||
    lane.exitCode !== undefined ||
    lane.exitSignal !== undefined,
  );
}

function laneExitedUnsuccessfully(lane) {
  const code = exitCodeNumber(lane?.exitCode);
  if (code !== null) return code !== 0;
  const signal = optionalString(lane?.exitSignal);
  return Boolean(signal);
}

function exitCodeNumber(value) {
  if (value === undefined || value === null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function exitSummary(lane) {
  const code = exitCodeNumber(lane?.exitCode);
  const signal = optionalString(lane?.exitSignal);
  if (code !== null && signal) return `exit ${code}, signal ${signal}`;
  if (code !== null) return `exit ${code}`;
  if (signal) return `signal ${signal}`;
  return 'unknown exit status';
}

function readLaneLogTail(context, lane) {
  const reader = context.deps.lanes.readLogTail ?? lanesModule.readLogTail;
  if (typeof reader !== 'function') return '';

  try {
    const value = reader(lane);
    if (typeof value === 'string') return value;
    if (value && typeof value.text === 'string') return value.text;
    return '';
  } catch {
    return '';
  }
}

function planHasActiveUnits(plan) {
  return Boolean(plan?.units?.some((unit) => !TERMINAL_UNIT_STATES.has(unit.state)));
}

function planHasDeployPending(plan) {
  return Boolean(plan?.units?.some((unit) => unit.needsDeploy || unit.deployPending));
}

function isRunnerOwned(plan, actor) {
  return Boolean(plan?.lease?.owner === actor);
}

function isTakeoverCard(card) {
  return card.action === 'takeover' || /take over expired build lease/i.test(card.title ?? '');
}

function hasOpenActionCard(cards, planId, action) {
  return cards.some((card) =>
    card.planId === planId &&
    card.action === action &&
    !CLOSED_CARD_STATUSES.has(card.status));
}

function decisionOptions(kind) {
  if (kind === BUILD_CARD_KIND_LINE_STOP) {
    return [
      { id: 'retry', label: 'Retry', consequence: 'Retry the unit within its attempt limit.' },
      { id: 'quarantine', label: 'Quarantine', consequence: 'Isolate this unit and continue independent work.' },
      { id: 'kill', label: 'Kill', consequence: 'Stop this unit.' },
    ];
  }

  return [
    { id: 'continue', label: 'Continue', consequence: 'Resume runner handling when safe.' },
    { id: 'retry', label: 'Retry', consequence: 'Retry the affected unit when allowed.' },
    { id: 'kill', label: 'Kill', consequence: 'Stop the affected work.' },
  ];
}

function unitById(plan, unitId) {
  return plan?.units?.find((unit) => unit.id === unitId) ?? null;
}

function unitScopeGlobs(unit) {
  if (Array.isArray(unit?.scope?.declared)) return unit.scope.declared;
  if (Array.isArray(unit?.scope)) return unit.scope;
  if (Array.isArray(unit?.scope?.globs)) return unit.scope.globs;
  return [];
}

export function promptForUnit(unit, plan = {}) {
  const task = optionalString(unit?.prompt ?? unit?.goal ?? unit?.title) ??
    `Build unit ${optionalString(unit?.id) ?? 'unknown'}`;
  return [
    'Build lane task:',
    task,
    '',
    'Adversarial verify prompt:',
    "- hardcoded devil's-advocate: before finishing, argue the strongest case that this change should not ship.",
    '- red-team-gets-raw-context-only: during that red-team pass, use only the raw verification context below plus repo/test evidence you directly inspect. Ignore your implementation narrative, prior confidence, elapsed effort, and self-justifying summaries.',
    '- sunk-cost stripping: if the adversarial pass shows the change is wrong, oversized, or mis-scoped, remove or replace your own work instead of defending it.',
    '- PRD lineage is input evidence, not authority. If lineage conflicts with current repo invariants or tests, stop and surface the conflict.',
    "- Final response must report the devil's-advocate finding, any change made because of it, and the verification run.",
    '',
    'Raw verification context:',
    rawVerificationContext({ plan, unit, task }),
  ].join('\n');
}

function rawVerificationContext({ plan, unit, task }) {
  const rows = [
    ['Plan id', plan?.id],
    ['Plan title', plan?.title],
    ['Unit id', unit?.id],
    ['Unit goal', unit?.goal],
  ];
  const explicitPrompt = optionalString(unit?.prompt);
  if (explicitPrompt && explicitPrompt !== optionalString(unit?.goal)) {
    rows.push(['Unit prompt', explicitPrompt]);
  }
  const scope = unitScopeGlobs(unit);
  if (scope.length > 0) rows.push(['Unit scope', scope.join(', ')]);
  const lineage = prdLineageForPrompt({ plan, unit });
  rows.push(['PRD lineage', lineage.length > 0 ? lineage.join('\n\n') : '[none supplied]']);
  rows.push(['Original task', task]);

  return boundPromptValue(rows
    .map(([label, value]) => `- ${label}: ${formatPromptValue(value)}`)
    .join('\n'), LANE_PROMPT_RAW_CONTEXT_MAX_CHARS);
}

function prdLineageForPrompt({ plan, unit }) {
  const chunks = [];
  collectPrdLineage(chunks, 'plan', plan);
  collectPrdLineage(chunks, 'unit', unit);
  collectPromptChunk(chunks, 'plan.draftSources', plan?.draftSources);
  collectPromptChunk(chunks, 'unit.draftSources', unit?.draftSources);
  return chunks;
}

function collectPrdLineage(chunks, owner, record) {
  if (!isPlainObject(record)) return;
  for (const key of PRD_LINEAGE_KEYS) {
    if (record[key] !== undefined) collectPromptChunk(chunks, `${owner}.${key}`, record[key]);
  }
}

function collectPromptChunk(chunks, label, value) {
  const text = promptValueText(value);
  if (!text) return;
  chunks.push(`[${label}]\n${boundPromptValue(text, LANE_PROMPT_VALUE_MAX_CHARS)}`);
}

function formatPromptValue(value) {
  const text = promptValueText(value);
  if (!text) return '[none]';
  const bounded = boundPromptValue(text, LANE_PROMPT_VALUE_MAX_CHARS);
  return bounded.includes('\n')
    ? `\n${indentPromptBlock(bounded)}`
    : bounded;
}

function promptValueText(value) {
  if (typeof value === 'string') return value.trim();
  if (value === undefined || value === null) return '';
  if (Array.isArray(value) || isPlainObject(value)) {
    try {
      return JSON.stringify(value, null, 2).trim();
    } catch {
      return '';
    }
  }
  return String(value).trim();
}

function indentPromptBlock(value) {
  return value.split('\n').map((line) => `  ${line}`).join('\n');
}

function boundPromptValue(value, maxChars) {
  const text = optionalString(value) ?? '';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 15).trimEnd()}\n[...truncated]`;
}

function commitMessageForUnit(unit) {
  const goal = (optionalString(unit.goal ?? unit.title) ?? unit.id)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 72);
  return `feat(build): ${goal}`;
}

function stripIntegration(value) {
  if (!isPlainObject(value)) return value;
  return stripUndefined({
    ok: value.ok,
    conflict: value.conflict,
    dirty: value.dirty,
    protectedPath: value.protectedPath,
    regateRequired: value.regateRequired,
    files: value.files,
    error: value.error,
  });
}

function diffFileList(value) {
  if (Array.isArray(value)) return uniqueRelPaths(value);
  if (isPlainObject(value) && Array.isArray(value.files)) return uniqueRelPaths(value.files);
  if (isPlainObject(value) && Array.isArray(value.diffFiles)) return uniqueRelPaths(value.diffFiles);
  if (isPlainObject(value) && typeof value.diff === 'string') return diffFileList(value.diff);
  if (isPlainObject(value) && typeof value.stdout === 'string') return diffFileList(value.stdout);
  if (typeof value !== 'string') return [];
  if (!value.includes('diff --git ')) return uniqueRelPaths(value.split(/[\n,]+/));

  const files = [];
  for (const line of value.split('\n')) {
    if (!line.startsWith('+++ ')) continue;
    const file = normalizeRelPath(line.slice(4));
    if (file && file !== '/dev/null') files.push(file);
  }
  return uniqueRelPaths(files);
}

function uniqueRelPaths(values) {
  return [...new Set(values.map(normalizeRelPath).filter(Boolean))];
}

function normalizeRelPath(value) {
  const text = optionalString(value);
  if (!text) return null;
  return text
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/^[ab]\//, '');
}

function normalizeDeps(input = {}) {
  const lanes = {
    dispatchLane: lanesModule.dispatchLane,
    watchLane: lanesModule.watchLane,
    killLane: lanesModule.killLane,
    recoverOrphans: lanesModule.recoverOrphans,
    classifyFailure: lanesModule.classifyFailure,
    applyFailureBudget: lanesModule.applyFailureBudget,
    detectLaneCompletion: lanesModule.detectLaneCompletion,
    ...(input.lanes ?? {}),
  };
  for (const key of ['dispatchLane', 'watchLane', 'killLane', 'recoverOrphans', 'classifyFailure', 'applyFailureBudget', 'isPidAlive', 'readLogInfo', 'readLogSize', 'readLogTail', 'detectLaneCompletion']) {
    if (input[key] !== undefined) lanes[key] = input[key];
  }

  return {
    lanes,
    gates: {
      suiteGate: gatesModule.suiteGate,
      hygieneGate: gatesModule.hygieneGate,
      redFoundation: gatesModule.redFoundation,
      retryAllowed: gatesModule.retryAllowed,
      ...(input.gates ?? {}),
    },
    git: {
      checkpoint,
      diffAgainstBase,
      integrate,
      recoverIntegration,
      commit: defaultCommit,
      ...(input.git ?? {}),
    },
    align: {
      integrationCheck: alignModule.integrationCheck,
      matchesGlob: alignModule.matchesGlob,
      ...(input.align ?? {}),
    },
    now: input.now ?? (() => new Date()),
    monotonicNow: input.monotonicNow ?? (() => Date.now()),
    logger: input.logger ?? console,
    codexPath: optionalString(input.codexPath) ?? '/Users/mfaz/.local/bin/codex',
    laneCap: input.laneCap,
    tickMs: input.tickMs,
    readDeployOutcome: input.readDeployOutcome,
    applyDeployOutcome: input.applyDeployOutcome ?? applyBootDeployOutcome,
  };
}

function leaseInput(context) {
  return {
    actor: context.actor,
    now: context.now(),
    monotonicNow: context.monotonicNow(),
  };
}

function compareUpdatedAsc(left, right) {
  return timestamp(left.updatedAt ?? left.raisedAt) - timestamp(right.updatedAt ?? right.raisedAt) ||
    left.id.localeCompare(right.id);
}

function timestamp(value) {
  const ms = Date.parse(value ?? '');
  return Number.isFinite(ms) ? ms : 0;
}

function positiveInteger(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}

function requiredString(value, label) {
  const text = optionalString(value);
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function omitUndefined(value) {
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (child !== undefined) result[key] = child;
  }
  return result;
}

function errorSummary(error, extra = {}) {
  return {
    ...extra,
    name: optionalString(error?.name) ?? 'Error',
    message: optionalString(error?.message) ?? String(error),
    code: optionalString(error?.code),
  };
}

function logError(logger, message, error) {
  if (typeof logger?.error === 'function') {
    logger.error(`[cs-k] ${message}`, error);
  }
}
