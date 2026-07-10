import { promises as fs } from 'node:fs';
import path from 'node:path';

import { iso } from '../../daemon/run.mjs';
import {
  isPlainObject,
  optionalString,
} from '../substrate.mjs';
import {
  BUILD_CARD_KIND_INFRA,
  BUILD_CARD_TIER_LOOPBACK,
} from './build-cards.mjs';
import {
  BUILD_STATE_BUILDING,
  BUILD_STATE_DEPLOYED,
  BUILD_STATE_DEPLOYING,
  BUILD_STATE_HELD,
  BUILD_STATE_INTEGRATING,
  BUILD_STATE_ORPHANED,
  BUILD_STATE_ROLLED_BACK,
  BUILD_STATE_VERIFYING,
  canTransition,
} from './build-state.mjs';
import { atomicWriteJson } from './routines.mjs';

export const DEPLOY_DIR = '.deploy';
export const DEPLOY_INTENT_FILE = 'intent.json';
export const DEPLOY_OUTCOME_FILE = 'outcome.json';
export const DEPLOY_OUTCOME_CONSUMED_FILE = 'outcome.consumed.json';
export const DEPLOY_RESULT_DEPLOYED = 'deployed';
export const DEPLOY_RESULT_ROLLED_BACK = 'rolled-back';
export const RUNNER_ACTOR = 'runner';

const DEPLOY_RESULTS = Object.freeze([
  DEPLOY_RESULT_DEPLOYED,
  DEPLOY_RESULT_ROLLED_BACK,
]);
const SHA_PATTERN = /^[a-f0-9]{7,64}$/i;
const RUNNING_LANE_STATES = new Set([
  BUILD_STATE_BUILDING,
  BUILD_STATE_VERIFYING,
  BUILD_STATE_INTEGRATING,
  BUILD_STATE_DEPLOYING,
  BUILD_STATE_ORPHANED,
]);

export async function requestDeploy(options = {}) {
  const store = requiredStore(options.store);
  const installRoot = path.resolve(options.installRoot ?? options.repoRoot ?? process.cwd());
  const deployDir = deployDirectory({ installRoot, deployDir: options.deployDir });
  const planId = requiredString(options.planId, 'planId');
  const unitId = requiredString(options.unitId, 'unitId');
  const targetSha = assertSha(options.targetSha, 'targetSha');
  const actor = optionalString(options.actor) ?? RUNNER_ACTOR;
  const exitFn = options.exitFn ?? ((code = 0) => process.exit(code));

  await assertNoRunningLanes(store, { planId, unitId });
  const intent = {
    schemaVersion: 1,
    targetSha,
    planId,
    unitId,
    at: iso(options.now ?? new Date()),
  };
  const intentFile = path.join(deployDir, DEPLOY_INTENT_FILE);
  await atomicWriteJson(intentFile, intent);

  try {
    await store.transition({
      planId,
      unitId,
      to: BUILD_STATE_DEPLOYING,
      actor,
      reason: 'deploy intent written',
      now: options.now,
      monotonicNow: options.monotonicNow,
    });
  } catch (error) {
    await fs.rm(intentFile, { force: true }).catch(() => {});
    throw error;
  }

  await exitFn(0);
  return {
    ok: true,
    intent,
    intentFile,
    exited: true,
  };
}

export async function readDeployOutcome(options = {}) {
  const installRoot = path.resolve(options.installRoot ?? options.repoRoot ?? process.cwd());
  const deployDir = deployDirectory({ installRoot, deployDir: options.deployDir });
  const outcomeFile = path.join(deployDir, DEPLOY_OUTCOME_FILE);
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(outcomeFile, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }

  const outcome = normalizeDeployOutcome(parsed);
  const planId = optionalString(options.planId);
  const unitId = optionalString(options.unitId);
  if (planId && outcome.planId && outcome.planId !== planId) return null;
  if (unitId && outcome.unitId && outcome.unitId !== unitId) return null;

  const consumedFile = path.join(deployDir, DEPLOY_OUTCOME_CONSUMED_FILE);
  await fs.rm(consumedFile, { force: true }).catch(() => {});
  await fs.rename(outcomeFile, consumedFile);
  return {
    ...outcome,
    outcomeFile,
    consumedFile,
  };
}

export async function applyDeployOutcome(options = {}) {
  const store = requiredStore(options.store);
  const cards = requiredCards(options.cards);
  const outcome = normalizeDeployOutcome(options.outcome);
  const planId = requiredString(options.planId ?? outcome.planId, 'planId');
  const unitId = requiredString(options.unitId ?? outcome.unitId, 'unitId');
  const actor = optionalString(options.actor) ?? RUNNER_ACTOR;
  const now = options.now ?? new Date();

  if (outcome.result === DEPLOY_RESULT_DEPLOYED) {
    await store.transition({
      planId,
      unitId,
      to: BUILD_STATE_DEPLOYED,
      actor,
      reason: 'boot shim deployed',
      now,
      monotonicNow: options.monotonicNow,
    });
    return {
      ok: true,
      target: BUILD_STATE_DEPLOYED,
      outcome,
    };
  }

  await store.transition({
    planId,
    unitId,
    to: BUILD_STATE_ROLLED_BACK,
    actor,
    reason: `boot shim rolled back: ${outcome.reason ?? 'unknown'}`,
    now,
    monotonicNow: options.monotonicNow,
  });
  await holdPlanIfPossible(store, {
    planId,
    actor,
    now,
    monotonicNow: options.monotonicNow,
  });
  const raised = await cards.raiseCard({
    kind: BUILD_CARD_KIND_INFRA,
    tier: BUILD_CARD_TIER_LOOPBACK,
    planId,
    unitId,
    title: 'Deploy rolled back',
    body: deployRollbackBody(outcome),
    action: 'deploy-rolled-back',
    recommendation: 'continue',
    options: [
      {
        id: 'continue',
        label: 'Continue',
        consequence: 'Keep the plan held while the rolled-back commit is inspected.',
      },
      {
        id: 'kill',
        label: 'Kill',
        consequence: 'Stop this build plan.',
      },
    ],
  });
  return {
    ok: true,
    target: BUILD_STATE_ROLLED_BACK,
    planHeld: true,
    card: raised.card,
    outcome,
  };
}

export async function assertNoRunningLanes(store, options = {}) {
  const lanes = typeof store.listLanes === 'function' ? await store.listLanes() : [];
  const planId = optionalString(options.planId);
  const running = lanes.filter((lane) =>
    (!planId || lane.planId === planId) &&
    RUNNING_LANE_STATES.has(lane.state));
  if (running.length > 0) {
    const error = new Error(`cannot deploy while lanes are running: ${running.map((lane) => lane.id).join(', ')}`);
    error.code = 'lanes_running';
    error.lanes = running;
    throw error;
  }
  return true;
}

export function normalizeDeployOutcome(value) {
  if (!isPlainObject(value)) throw new Error('deploy outcome must be an object');
  const result = normalizeResult(value.result ?? value.outcome ?? value.status);
  return {
    ...value,
    result,
    sha: optionalString(value.sha ?? value.targetSha) ?? null,
    targetSha: optionalString(value.targetSha ?? value.sha) ?? null,
    previousSha: optionalString(value.previousSha) ?? null,
    rolledBackToSha: optionalString(value.rolledBackToSha) ?? null,
    planId: optionalString(value.planId) ?? null,
    unitId: optionalString(value.unitId) ?? null,
    reason: optionalString(value.reason) ?? null,
    at: optionalString(value.at) ?? null,
  };
}

function normalizeResult(value) {
  const text = optionalString(value);
  if (text === BUILD_STATE_DEPLOYED) return DEPLOY_RESULT_DEPLOYED;
  if (text === BUILD_STATE_ROLLED_BACK) return DEPLOY_RESULT_ROLLED_BACK;
  if (!text || !DEPLOY_RESULTS.includes(text)) {
    throw new Error(`invalid deploy result: ${value}`);
  }
  return text;
}

async function holdPlanIfPossible(store, options) {
  const plan = await store.loadPlan(options.planId);
  if (!plan || plan.status === BUILD_STATE_HELD) return false;
  if (!canTransition(plan.status, BUILD_STATE_HELD)) return false;
  await store.transition({
    planId: options.planId,
    to: BUILD_STATE_HELD,
    actor: options.actor,
    reason: 'deploy rolled back',
    now: options.now,
    monotonicNow: options.monotonicNow,
  });
  return true;
}

function deployRollbackBody(outcome) {
  const parts = [
    `The boot shim rolled back ${outcome.targetSha ?? outcome.sha ?? 'the target commit'}.`,
  ];
  if (outcome.rolledBackToSha) parts.push(`Serving ${outcome.rolledBackToSha}.`);
  if (outcome.reason) parts.push(`Reason: ${outcome.reason}.`);
  return parts.join(' ');
}

function deployDirectory({ installRoot, deployDir }) {
  const dir = path.resolve(deployDir ?? path.join(installRoot, DEPLOY_DIR));
  assertPathUnderRoot(dir, installRoot, 'deployDir');
  return dir;
}

function assertPathUnderRoot(candidate, root, label) {
  const resolved = path.resolve(candidate);
  const resolvedRoot = path.resolve(root);
  const rel = path.relative(resolvedRoot, resolved);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return resolved;
  throw new Error(`${label} escapes installRoot`);
}

function assertSha(value, label) {
  const text = requiredString(value, label);
  if (!SHA_PATTERN.test(text)) throw new Error(`invalid ${label}: ${value}`);
  return text;
}

function requiredStore(store) {
  if (!store || typeof store.transition !== 'function') {
    throw new Error('build state store is required');
  }
  return store;
}

function requiredCards(cards) {
  if (!cards || typeof cards.raiseCard !== 'function') {
    throw new Error('build card store is required');
  }
  return cards;
}

function requiredString(value, label) {
  const text = optionalString(value);
  if (!text) throw new Error(`${label} is required`);
  return text;
}
