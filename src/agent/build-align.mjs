import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  BUILD_CARD_KIND_INFRA,
  BUILD_CARD_KIND_PLAN_APPROVAL,
  BUILD_CARD_KIND_DRIFT,
  BUILD_CARD_KIND_SAFETY_FLOOR,
  BUILD_CARD_TIER_LOOPBACK,
} from './build-cards.mjs';
import { iso } from '../../daemon/run.mjs';
import {
  isPlainObject,
  optionalString,
} from '../substrate.mjs';

// Deterministic integration floor for the build runner.
//
// Hard holds: safetyFloorCheck (AE3) and scopeCheck (AE2). These are path-only,
// deterministic checks run during integration. trackCheck intentionally does
// not hold integration on its own; it is advisory evidence for approval-time
// reasoning and should remain separate from integrationCheck.

export const DEFAULT_TRACK_ALIGNMENT_THRESHOLD = 0.25;
export const REASONING_VERDICT_PASS = 'pass';
export const REASONING_VERDICT_HOLD = 'hold';
export const REASONING_CHECK_MAX_TOKENS = 900;

export const ENFORCEMENT_SURFACES = Object.freeze([
  // Mission and governance anchors.
  'STRATEGY.md',
  'loop.md',
  'life-constitution.md',
  'CLAUDE.md',

  // KTD9 / SEC-002 sovereignty invariants and their proving surfaces.
  'src/reason/sensitive-model.mjs',
  'src/reason/sensitive-model.test.mjs',
  'src/agent/sensitivity.mjs',
  'src/agent/sensitivity.test.mjs',
  'src/agent/chat.mjs',
  'src/agent/chat.test.mjs',
  'src/agent/chat-route.test.mjs',
  'src/agent/tool-loop.mjs',
  'src/agent/tool-loop.test.mjs',
  'src/agent/view-packet.mjs',
  'src/agent/view-packet.test.mjs',
  'src/agent/packet-emit.mjs',
  'src/agent/packet-emit.test.mjs',
  'src/agent/sovereign-single-call.mjs',
  'src/substrate.mjs',
  'src/substrate.test.mjs',
  'daemon/run.mjs',
  'daemon/server.mjs',
  'daemon/routes/chat.mjs',
  'daemon/routes/agui.mjs',
  'daemon/routes/substrate-edit.mjs',
  'src/agui-route.test.mjs',
  'src/frontier-safety.test.mjs',
  'src/server-artifacts.test.mjs',

  // Frontier-exclusion stamping/projection surfaces discovered by grep.
  'src/ingest/apple-notes.mjs',
  'src/ingest/apple-notes.test.mjs',
  'src/ingest/contextdump.mjs',
  'src/ingest/contextdump.test.mjs',
  'src/ingest/notes.mjs',
  'src/ingest/notes.test.mjs',
  'src/ingest/x-bookmarks.mjs',
  'src/ingest/x-bookmarks.test.mjs',
  'src/ingest/x-bookmarks-live.mjs',
  'src/ingest/x-bookmarks-live.test.mjs',
  'src/mind/think.mjs',
  'src/mind/think.test.mjs',
  'src/reason/health.mjs',
  'src/reason/health.test.mjs',
  'src/research/pipeline.mjs',
  'src/research/pipeline.test.mjs',
  'src/strategy/strategize.mjs',
  'src/strategy/strategize.test.mjs',
  'src/threads/orchestrator.mjs',
  'src/threads/orchestrator.test.mjs',

  // Runner enforcement surfaces.
  'src/agent/build-align.mjs',
  'src/agent/build-align.test.mjs',
  'src/agent/build-gates.mjs',
  'src/agent/build-gates.test.mjs',
  'src/agent/build-state.mjs',
  'src/agent/build-state.test.mjs',
  'src/agent/build-cards.mjs',
  'src/agent/build-cards.test.mjs',
  'src/agent/build-lanes.mjs',
  'src/agent/build-lanes.test.mjs',
  'src/agent/build-deploy.mjs',
  'src/agent/build-deploy.test.mjs',

  // Fixture and operational surfaces.
  'src/agent/fixtures/**',
  'ops/boot-shim.mjs',
  'ops/*.plist',
  'ops/**',
  '.deploy/**',
  '.claude/**',
  'data/**',
]);

const TRACK_SECTION_PATTERN = /^##\s+(Approach|Tracks)\b[\s\S]*?(?=^##\s+|(?![\s\S]))/gim;
const TOKEN_MIN_LENGTH = 3;
const KEEP_SHORT_TOKENS = Object.freeze(['ai', 'cs', 'hrv', 'eeg', 'bio']);
const ANCHOR_KEYS = Object.freeze(['strategy', 'loop', 'constitution']);
const STOP_WORDS = Object.freeze(new Set([
  'about',
  'above',
  'against',
  'all',
  'also',
  'and',
  'any',
  'are',
  'built',
  'but',
  'can',
  'does',
  'for',
  'from',
  'has',
  'have',
  'hence',
  'into',
  'its',
  'never',
  'not',
  'one',
  'only',
  'own',
  'over',
  'per',
  'plus',
  'should',
  'that',
  'the',
  'then',
  'they',
  'this',
  'with',
  'which',
  'who',
  'whose',
]));

export class ReasoningUnavailableError extends Error {
  constructor(message = 'approval-time reasoning check unavailable', options = {}) {
    super(message, { cause: options.cause });
    this.name = this.constructor.name;
    this.code = 'reasoning_unavailable';
    if (options.model) this.model = options.model;
  }
}

export function safetyFloorCheck({ diffFiles } = {}) {
  const files = normalizeDiffFiles(diffFiles);
  const hits = [];

  for (const file of files) {
    const glob = ENFORCEMENT_SURFACES.find((candidate) => matchesGlob(file, candidate));
    if (glob) hits.push({ file, glob });
  }

  return Object.freeze({
    ok: hits.length === 0,
    hits: Object.freeze(hits),
  });
}

export function scopeCheck({ diffFiles, unitScope } = {}) {
  const scope = normalizeGlobList(unitScope);
  if (scope.length === 0) {
    return Object.freeze({
      ok: false,
      reason: 'scope_undeclared',
      outside: Object.freeze(normalizeDiffFiles(diffFiles)),
    });
  }

  const outside = normalizeDiffFiles(diffFiles)
    .filter((file) => !scope.some((glob) => matchesGlob(file, glob)));

  return Object.freeze({
    ok: outside.length === 0,
    outside: Object.freeze(outside),
  });
}

export async function trackCheck({
  planTitle = '',
  planUnits = [],
  strategyPath = 'STRATEGY.md',
  strategyText,
  threshold = DEFAULT_TRACK_ALIGNMENT_THRESHOLD,
} = {}) {
  const strategy = optionalString(strategyText) ??
    await fs.readFile(path.resolve(strategyPath), 'utf8');
  const strategyTerms = tokenizeTrackText(strategyTrackText(strategy));
  const planTerms = tokenizeTrackText(planGoalText({ planTitle, planUnits }));
  const overlap = [...planTerms].filter((term) => strategyTerms.has(term)).sort();
  const denominator = Math.max(1, Math.min(strategyTerms.size || 1, planTerms.size || 1));
  const score = Number((overlap.length / denominator).toFixed(4));
  const normalizedThreshold = finitePositive(threshold, DEFAULT_TRACK_ALIGNMENT_THRESHOLD);
  const ok = score >= normalizedThreshold;

  return Object.freeze({
    ok,
    score,
    threshold: normalizedThreshold,
    severity: ok ? 'none' : score >= normalizedThreshold * 0.75 ? 'warning' : 'critical',
    anchor: 'strategy-track',
    strategyChars: strategy.length,
    strategyTerms: strategyTerms.size,
    planTerms: planTerms.size,
    overlap: Object.freeze(overlap),
  });
}

export async function reasoningCheck({
  plan,
  anchors,
  singleCall = defaultReasoningSingleCall,
  now,
} = {}) {
  const timestamp = iso(now ?? new Date());
  const request = {
    system: reasoningSystemPrompt(),
    user: reasoningUserPrompt({ plan, anchors }),
    max_tokens: REASONING_CHECK_MAX_TOKENS,
  };

  let output;
  try {
    output = await singleCall(request);
  } catch (error) {
    throw new ReasoningUnavailableError('approval-time reasoning check unavailable', {
      cause: error,
      model: modelFromOutput(error),
    });
  }

  return Object.freeze({
    ...normalizeReasoningOutput(output),
    at: timestamp,
  });
}

export async function approvalPreCheck({ plan, deps = {} } = {}) {
  const now = deps.now ?? new Date();
  const append = appendHistoryFromDeps(deps);
  const scope = planScopeDeclarationCheck(plan);
  if (!scope.ok) {
    const result = precheckResult({
      plan,
      now,
      recommendation: 'hold',
      reasons: scope.reasons,
      scope,
      track: null,
      reasoning: null,
    });
    return Object.freeze(result);
  }

  const anchors = normalizeAnchors(deps.anchors);
  const track = await (deps.trackCheck ?? trackCheck)({
    strategyText: anchors.strategy,
    planTitle: optionalString(plan?.title) ?? optionalString(plan?.id) ?? '',
    planUnits: Array.isArray(plan?.units) ? plan.units : [],
    ...(isPlainObject(deps.trackOptions) ? deps.trackOptions : {}),
  });
  const trackHistory = await append?.(trackHistoryEvent({ plan, track, now }));

  let reasoning;
  let reasoningHistory;
  try {
    reasoning = await reasoningCheck({
      plan,
      anchors,
      singleCall: deps.singleCall,
      now,
    });
    reasoningHistory = await append?.(reasoningHistoryEvent({ plan, reasoning, now }));
  } catch (error) {
    if (!(error instanceof ReasoningUnavailableError)) throw error;
    return Object.freeze(precheckResult({
      plan,
      now,
      recommendation: 'hold',
      reasons: ['reasoning model unavailable'],
      scope,
      track,
      reasoning: null,
      histories: historyResults([trackHistory]),
      infraCard: infraCardInput({ plan, error, now }),
      unavailable: error,
    }));
  }

  const reasons = reasoning.verdict === REASONING_VERDICT_HOLD
    ? reasoning.reasons
    : passReasons({ track, reasoning });
  return Object.freeze(precheckResult({
    plan,
    now,
    recommendation: reasoning.verdict === REASONING_VERDICT_PASS ? 'approve' : 'hold',
    reasons,
    scope,
    track,
    reasoning,
    histories: historyResults([trackHistory, reasoningHistory]),
  }));
}

export function integrationCheck({ diffFiles, unitScope } = {}) {
  const safety = safetyFloorCheck({ diffFiles });
  const scope = scopeCheck({ diffFiles, unitScope });
  const holds = [];

  if (!safety.ok) {
    holds.push({
      kind: BUILD_CARD_KIND_SAFETY_FLOOR,
      detail: safety,
    });
  }
  if (!scope.ok) {
    holds.push({
      kind: BUILD_CARD_KIND_DRIFT,
      detail: scope,
    });
  }

  return Object.freeze({
    ok: holds.length === 0,
    holds: Object.freeze(holds),
  });
}

export function matchesGlob(file, glob) {
  const normalizedFile = normalizeRelPath(file);
  const normalizedGlob = normalizeRelPath(glob);
  if (!normalizedFile || !normalizedGlob) return false;
  return globToRegExp(normalizedGlob).test(normalizedFile);
}

export function globToRegExp(glob) {
  const normalized = normalizeRelPath(glob);
  let source = '^';

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];

    if (char === '*' && next === '*') {
      source += '.*';
      index += 1;
      continue;
    }
    if (char === '*') {
      source += '[^/]*';
      continue;
    }
    source += escapeRegExp(char);
  }

  return new RegExp(`${source}$`);
}

function reasoningSystemPrompt() {
  return [
    'You are the independent sovereign approval-time alignment judge for cs-k build plans.',
    'Judge whether the plan conflicts with any supplied anchor text.',
    'Return only strict JSON matching this exact contract:',
    '{"verdict":"pass"|"hold","reasons":["string"],"anchorRefs":["strategy"|"loop"|"constitution"]}',
    'Use "hold" for direct conflicts, attempts to weaken sovereignty/safety invariants, or missing anchor evidence.',
    'Keep reasons concise. Do not include chain-of-thought or markdown.',
  ].join('\n');
}

function reasoningUserPrompt({ plan, anchors }) {
  const normalizedAnchors = normalizeAnchors(anchors);
  return [
    'Anchors:',
    ...ANCHOR_KEYS.map((key) => [
      `<${key}>`,
      normalizedAnchors[key] || '[missing anchor]',
      `</${key}>`,
    ].join('\n')),
    '',
    'Plan JSON:',
    JSON.stringify(plan ?? {}, null, 2),
    '',
    'Question: does this plan conflict with the anchors?',
  ].join('\n');
}

async function defaultReasoningSingleCall(request) {
  const {
    openRouterZdrModelCall,
    openRouterZdrModelName,
  } = await import('../reason/sensitive-model.mjs');
  const model = openRouterZdrModelName(request?.model);
  const content = await openRouterZdrModelCall(request, { reasoning: true });
  return { content, model };
}

function normalizeReasoningOutput(output) {
  const model = modelFromOutput(output);
  const parsed = parseReasoningJson(output);
  if (!isPlainObject(parsed)) return malformedReasoningVerdict(model);

  const verdict = optionalString(parsed.verdict);
  const reasons = stringList(parsed.reasons);
  const anchorRefs = stringList(parsed.anchorRefs);
  if (
    ![REASONING_VERDICT_PASS, REASONING_VERDICT_HOLD].includes(verdict) ||
    !Array.isArray(parsed.reasons) ||
    !Array.isArray(parsed.anchorRefs) ||
    reasons === null ||
    anchorRefs === null
  ) {
    return malformedReasoningVerdict(model);
  }

  return Object.freeze({
    verdict,
    reasons: Object.freeze(reasons),
    anchorRefs: Object.freeze(anchorRefs),
    model,
  });
}

function malformedReasoningVerdict(model) {
  return Object.freeze({
    verdict: REASONING_VERDICT_HOLD,
    reasons: Object.freeze(['unparseable verdict']),
    anchorRefs: Object.freeze([]),
    model,
  });
}

function parseReasoningJson(output) {
  if (isPlainObject(output) && typeof output.verdict === 'string') return output;
  const text = outputText(output);
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {}

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {}
  }

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {}
  }

  return null;
}

function outputText(output) {
  if (typeof output === 'string') return output;
  if (!isPlainObject(output)) return '';
  return optionalString(output.content) ??
    optionalString(output.text) ??
    optionalString(output.message) ??
    '';
}

function modelFromOutput(output) {
  if (!isPlainObject(output)) return 'sovereign-zdr';
  return optionalString(output.model) ??
    optionalString(output.modelName) ??
    optionalString(output.providerModel) ??
    'sovereign-zdr';
}

function stringList(value) {
  if (!Array.isArray(value)) return null;
  const items = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    const text = optionalString(item);
    if (text) items.push(text);
  }
  return items;
}

function normalizeAnchors(value) {
  const anchors = isPlainObject(value) ? value : {};
  return Object.freeze(Object.fromEntries(ANCHOR_KEYS.map((key) => [
    key,
    optionalString(anchors[key]) ?? '',
  ])));
}

export function planScopeDeclarationCheck(plan) {
  const units = Array.isArray(plan?.units) ? plan.units : [];
  const failures = [];

  if (units.length === 0) {
    failures.push({ unitId: null, reason: 'plan declares no units' });
  }

  for (const unit of units) {
    const declared = declaredScope(unit);
    const result = scopeCheck({ diffFiles: [], unitScope: declared });
    if (!result.ok) {
      failures.push({
        unitId: optionalString(unit?.id) ?? null,
        reason: 'unit scope undeclared',
      });
    }
  }

  return Object.freeze({
    ok: failures.length === 0,
    failures: Object.freeze(failures),
    reasons: Object.freeze(failures.map((failure) =>
      failure.unitId
        ? `unit ${failure.unitId}: ${failure.reason}`
        : failure.reason)),
  });
}

function declaredScope(unit) {
  if (Array.isArray(unit?.scope)) return unit.scope;
  if (Array.isArray(unit?.scope?.declared)) return unit.scope.declared;
  if (Array.isArray(unit?.declaredScope)) return unit.declaredScope;
  return [];
}

function appendHistoryFromDeps(deps) {
  if (typeof deps.appendHistory === 'function') return deps.appendHistory;
  if (typeof deps.store?.appendHistory === 'function') {
    return (event) => deps.store.appendHistory(event);
  }
  return null;
}

function trackHistoryEvent({ plan, track, now }) {
  return {
    kind: 'align.track',
    check: 'track',
    planId: optionalString(plan?.id) ?? null,
    ok: track.ok,
    score: track.score,
    threshold: track.threshold,
    severity: track.severity,
    anchor: track.anchor,
    at: iso(now ?? new Date()),
  };
}

function reasoningHistoryEvent({ plan, reasoning, now }) {
  return {
    kind: 'align.reasoning',
    check: 'reasoning',
    planId: optionalString(plan?.id) ?? null,
    verdict: reasoning.verdict,
    reasons: reasoning.reasons,
    anchorRefs: reasoning.anchorRefs,
    model: reasoning.model,
    at: iso(now ?? new Date()),
  };
}

function precheckResult({
  plan,
  now,
  recommendation,
  reasons,
  scope,
  track,
  reasoning,
  histories = [],
  infraCard,
  unavailable,
}) {
  const card = infraCard ?? planApprovalCardInput({
    plan,
    recommendation,
    reasons,
    scope,
    track,
    reasoning,
    now,
  });
  return {
    ok: recommendation === 'approve',
    status: recommendation === 'approve' ? 'ready' : 'staged',
    staged: recommendation !== 'approve',
    recommendation,
    reasons: Object.freeze([...reasons]),
    scope,
    track,
    reasoning,
    histories: Object.freeze(histories),
    card,
    cards: Object.freeze([card]),
    ...(unavailable ? { error: unavailable } : {}),
  };
}

function planApprovalCardInput({ plan, recommendation, reasons, scope, track, reasoning, now }) {
  return {
    kind: BUILD_CARD_KIND_PLAN_APPROVAL,
    tier: BUILD_CARD_TIER_LOOPBACK,
    planId: optionalString(plan?.id) ?? 'unknown-plan',
    title: `Plan approval: ${optionalString(plan?.title) ?? optionalString(plan?.id) ?? 'untitled plan'}`,
    body: approvalCardBody({ recommendation, reasons, scope, track, reasoning }),
    options: [
      {
        id: 'approve',
        label: 'Approve',
        consequence: 'Allow the staged plan to run.',
      },
      {
        id: 'hold',
        label: 'Hold',
        consequence: 'Keep the plan staged for revision.',
      },
    ],
    recommendation,
    alignment: {
      scope,
      track,
      reasoning,
    },
    createdAt: iso(now ?? new Date()),
  };
}

function infraCardInput({ plan, error, now }) {
  return {
    kind: BUILD_CARD_KIND_INFRA,
    tier: BUILD_CARD_TIER_LOOPBACK,
    planId: optionalString(plan?.id) ?? 'unknown-plan',
    title: 'Approval reasoning unavailable',
    body: [
      'Recommendation: hold',
      '',
      'Reasons:',
      `- ${optionalString(error?.message) ?? 'reasoning model unavailable'}`,
      '',
      'The plan remains staged; approval requires a successful sovereign reasoning check.',
    ].join('\n'),
    options: [
      {
        id: 'retry',
        label: 'Retry',
        consequence: 'Run the approval-time reasoning check again.',
      },
      {
        id: 'hold',
        label: 'Hold',
        consequence: 'Keep the plan staged.',
      },
    ],
    recommendation: 'retry',
    alignment: {
      unavailable: true,
      code: optionalString(error?.code) ?? 'reasoning_unavailable',
    },
    createdAt: iso(now ?? new Date()),
  };
}

function approvalCardBody({ recommendation, reasons, scope, track, reasoning }) {
  const lines = [
    `Recommendation: ${recommendation}`,
    '',
    'Reasons:',
    ...reasons.map((reason) => `- ${reason}`),
  ];

  if (scope) lines.push('', `Scope: ${scope.ok ? 'declared' : 'missing declarations'}`);
  if (track) lines.push('', `Track: ${track.severity} (${track.score}/${track.threshold})`);
  if (reasoning) {
    lines.push(
      '',
      `Reasoning: ${reasoning.verdict}`,
      `Model: ${reasoning.model}`,
    );
  }

  return lines.join('\n');
}

function passReasons({ track, reasoning }) {
  const reasons = [...reasoning.reasons];
  if (reasons.length === 0) reasons.push('reasoning check passed');
  if (track && !track.ok) {
    reasons.push(`strategy-track advisory is ${track.severity} at ${track.score}/${track.threshold}`);
  }
  return reasons;
}

function historyResults(values) {
  return values.filter(Boolean);
}

function normalizeDiffFiles(value) {
  if (Array.isArray(value)) return uniqueRelPaths(value);
  if (isPlainObject(value) && Array.isArray(value.files)) return uniqueRelPaths(value.files);
  if (isPlainObject(value) && Array.isArray(value.diffFiles)) return uniqueRelPaths(value.diffFiles);
  if (isPlainObject(value) && typeof value.diff === 'string') return parseDiffTextFiles(value.diff);
  if (isPlainObject(value) && typeof value.stdout === 'string') return parseDiffTextFiles(value.stdout);
  if (typeof value === 'string') {
    return value.includes('diff --git ')
      ? parseDiffTextFiles(value)
      : uniqueRelPaths(value.split(/[\n,]+/));
  }
  return Object.freeze([]);
}

function parseDiffTextFiles(diffText) {
  const files = [];
  for (const line of String(diffText).split('\n')) {
    if (line.startsWith('+++ ')) {
      const file = normalizeDiffFile(line.slice(4));
      if (file) files.push(file);
    }
  }
  return uniqueRelPaths(files);
}

function normalizeDiffFile(value) {
  const file = optionalString(value);
  if (!file || file === '/dev/null') return null;
  return normalizeRelPath(file);
}

function uniqueRelPaths(values) {
  return Object.freeze([...new Set(values.map(normalizeRelPath).filter(Boolean))]);
}

function normalizeGlobList(value) {
  if (Array.isArray(value)) return uniqueRelPaths(value);
  if (isPlainObject(value) && Array.isArray(value.scope)) return uniqueRelPaths(value.scope);
  if (isPlainObject(value) && Array.isArray(value.globs)) return uniqueRelPaths(value.globs);
  if (typeof value === 'string') return uniqueRelPaths(value.split(/[\n,]+/));
  return Object.freeze([]);
}

function normalizeRelPath(value) {
  const text = optionalString(value);
  if (!text) return null;
  return text
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/^[ab]\//, '');
}

function strategyTrackText(text) {
  const sections = [];
  for (const match of text.matchAll(TRACK_SECTION_PATTERN)) {
    sections.push(match[0]);
  }
  return sections.length > 0 ? sections.join('\n') : text;
}

function planGoalText({ planTitle, planUnits }) {
  return [
    planTitle,
    ...normalizePlanUnits(planUnits).flatMap((unit) => [
      unit.title,
      unit.goal,
      unit.goals,
      unit.summary,
      unit.description,
      unit.approach,
      unit.requirements,
    ]),
  ].map(textFromValue).filter(Boolean).join('\n');
}

function normalizePlanUnits(value) {
  if (!Array.isArray(value)) return [];
  return value.map((unit) => isPlainObject(unit) ? unit : { goal: unit });
}

function textFromValue(value) {
  if (Array.isArray(value)) return value.map(textFromValue).filter(Boolean).join(' ');
  if (isPlainObject(value)) return Object.values(value).map(textFromValue).filter(Boolean).join(' ');
  return optionalString(value) ?? '';
}

function tokenizeTrackText(text) {
  const terms = new Set();
  const normalized = String(text ?? '')
    .toLowerCase()
    .replace(/[`*_()[\]{}>"'.:,;!?|]+/g, ' ')
    .replace(/[-/]+/g, ' ');

  for (const token of normalized.split(/\s+/)) {
    const term = token.replace(/[^a-z0-9]/g, '');
    if (!term) continue;
    if (STOP_WORDS.has(term)) continue;
    if (term.length < TOKEN_MIN_LENGTH && !KEEP_SHORT_TOKENS.includes(term)) continue;
    terms.add(term);
  }
  return terms;
}

function finitePositive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
