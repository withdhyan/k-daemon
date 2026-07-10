import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  ROOT,
  buildModelRequest,
  commitStationOutput,
  decisionStakesSignal,
  gatherContext,
  parseFrontmatter,
} from '../../daemon/run.mjs';
import { research as defaultResearch } from '../research/pipeline.mjs';
import { boardModelCall } from '../reason/board.mjs';
import {
  createSubstrateStore,
  isPlainObject,
  optionalString,
} from '../substrate.mjs';

export const DEFAULT_DELIBERATION_TIMEOUT_MS = 30_000;

const DECISION_CARD_FIELDS = Object.freeze([
  'asked',
  'read',
  'assumed',
  'missing',
  'pick',
  'why',
  'whatWouldChangeIt',
  'next',
]);
const DEFAULT_RESEARCH_K = 6;
const EVIDENCE_CONTENT_MAX_CHARS = 1200;
const TOOL_OUTPUT_MAX_CHARS = 3500;

export async function runDeliberation({ question, singleCall, dataDir, opts = {} } = {}) {
  const asked = requiredText(question, 'question');
  const now = opts.now ?? (() => new Date());
  const resolvedDataDir = path.resolve(
    dataDir ?? opts.dataDir ?? process.env.CS_K_DATA_DIR ?? path.join(ROOT, 'data'),
  );
  const store = opts.store ?? createSubstrateStore({ dataDir: resolvedDataDir, now });
  const context = opts.context ?? await gatherContext('decide', {
    store,
    dataDir: resolvedDataDir,
    limit: opts.contextLimit,
  });
  const gate = typeof opts.stakesGate === 'function'
    ? opts.stakesGate({ question: asked, context })
    : opts.stakesGate ?? deliberationStakesGate({ question: asked, context });

  if (!gate.escalate) return Object.freeze({ mode: 'single' });
  if (typeof singleCall !== 'function') return Object.freeze({ mode: 'single' });

  const timeoutMs = positiveInteger(opts.timeoutMs, DEFAULT_DELIBERATION_TIMEOUT_MS);
  const baseRequest = await buildDeliberationRequest({
    question: asked,
    context,
    now,
  });
  const initial = await runBoardPass(baseRequest, { singleCall, timeoutMs });
  if (!initial) return Object.freeze({ mode: 'single' });

  let finalOutput = initial.output;
  let finalDecisionCard = initial.decisionCard;
  let evidence = [];
  let rounds = 1;

  if (finalDecisionCard.missing.length > 0) {
    evidence = await researchMissingEvidence(finalDecisionCard.missing, {
      asked,
      store,
      dataDir: resolvedDataDir,
      opts,
    });
    const evidenceRequest = appendEvidenceToRequest(baseRequest, finalDecisionCard.missing, evidence);
    const reround = await runBoardPass(evidenceRequest, { singleCall, timeoutMs });
    if (!reround) return Object.freeze({ mode: 'single' });
    finalOutput = reround.output;
    finalDecisionCard = reround.decisionCard;
    rounds += 1;
  }

  if (opts.persist !== false) {
    const commit = opts.commitStationOutput ?? commitStationOutput;
    // Lighter KTD6 path: reuse the existing decide station commit seam so the
    // record remains a native LoopRecommendation that TWS already consumes.
    await commit('decide', finalOutput, {
      store,
      dataDir: resolvedDataDir,
      now,
    });
  }

  return Object.freeze({
    mode: 'deliberated',
    decisionCard: finalDecisionCard,
    dissent: normalizeDissent(finalOutput.dissent),
    convergence_points: stringList(finalOutput.convergence_points),
    evidence: gradedEvidenceIds(evidence),
    rounds,
  });
}

export function deliberationStakesGate(input = {}) {
  const question = typeof input === 'string'
    ? input
    : String(input?.question ?? '');
  const context = typeof input === 'string'
    ? ''
    : String(input?.context ?? input?.substrateSignal ?? '');
  const base = decisionStakesSignal({ decisionText: question, context });
  const reasons = [...base.reasons];
  let score = base.score;

  const words = questionWords(question);
  if (words >= 45) {
    score += 1;
    reasons.push('complex question length');
  }
  if (words >= 80) {
    score += 1;
    reasons.push('very long question');
  }

  const markers = complexityMarkers(question);
  if (markers >= 4) {
    score += 1;
    reasons.push('multi-constraint question');
  }

  const substrateCount = substrateRecordCount(context);
  if (substrateCount >= 12 && (score > base.score || base.score > 0)) {
    score += 1;
    reasons.push('dense substrate signal');
  }

  return Object.freeze({
    escalate: score >= 2,
    score,
    reasons: Object.freeze(reasons),
  });
}

export function sovereignRecordFilter(records) {
  return Array.isArray(records) ? records : [];
}

export async function executeDeliberateTool(args = {}, context = {}) {
  const question = optionalString(args.question);
  if (!question) return Object.freeze({ ok: false, reason: 'missing_question' });

  const result = await runDeliberation({
    question,
    singleCall: context.singleCall,
    dataDir: context.dataDir,
    opts: {
      now: context.now,
      store: context.store,
      timeoutMs: context.timeoutMs,
      researchFn: context.researchFn,
      researchOptions: context.researchOptions,
      context: context.context,
      contextLimit: context.contextLimit,
      commitStationOutput: context.commitStationOutput,
      persist: context.persist,
    },
  });

  return Object.freeze({
    ok: true,
    output: renderDeliberationForTool(result),
    sensitive: result.mode === 'deliberated',
    provenance: result.mode === 'deliberated'
      ? result.evidence.map((item) => item.id).filter(Boolean)
      : [],
  });
}

export function renderDeliberationForTool(result) {
  if (!isPlainObject(result) || result.mode !== 'deliberated') {
    return 'mode=single\nfall back to a normal single-turn answer.';
  }

  const card = result.decisionCard;
  const sources = result.evidence.length === 0
    ? '(none)'
    : result.evidence
      .map((item) => `${item.id}${item.grade ? `(${item.grade}${item.source ? `:${item.source}` : ''})` : ''}`)
      .join(', ');
  const lines = [
    `pick: ${card.pick}`,
    `why: ${card.why}`,
    `dissent: ${result.dissent.contradicts ? result.dissent.on : 'no contradiction returned'}`,
    `what-would-change-it: ${card.whatWouldChangeIt}`,
    `sources: ${sources}`,
  ];

  return boundText(lines.join('\n'), TOOL_OUTPUT_MAX_CHARS);
}

async function buildDeliberationRequest({ question, context, now }) {
  const [constitution, stationSource] = await Promise.all([
    fs.readFile(path.join(ROOT, 'life-constitution.md'), 'utf8'),
    fs.readFile(path.join(ROOT, 'stations', 'decide.md'), 'utf8'),
  ]);
  const stationPrompt = parseFrontmatter(stationSource);
  return buildModelRequest({
    station: 'decide',
    stationPrompt,
    constitution,
    context,
    input: question,
    now,
  });
}

async function runBoardPass(request, { singleCall, timeoutMs }) {
  try {
    const output = await boardModelCall(request, {
      singleCall,
      timeoutMs,
      fallbackToSingle: false,
    });
    const decisionCard = normalizeDecisionCard(output?.decisionCard);
    if (!decisionCard) return null;
    return { output, decisionCard };
  } catch {
    return null;
  }
}

async function researchMissingEvidence(missing, { asked, store, dataDir, opts }) {
  const researchFn = opts.researchFn ?? defaultResearch;
  const query = [asked, ...missing].join(' ');
  const evidence = await researchFn(query, {
    ...(opts.researchOptions ?? {}),
    store,
    dataDir,
    k: positiveInteger(opts.researchOptions?.k, DEFAULT_RESEARCH_K),
    sovereignRecords: true,
    recordFilter: sovereignRecordFilter,
  });

  return Array.isArray(evidence) ? evidence : [];
}

function appendEvidenceToRequest(request, missing, evidence) {
  return {
    ...request,
    label: `${request.label}:deliberation:evidence-reround`,
    user: [
      request.user,
      '',
      '## Graded evidence for missing Board gaps',
      `missing: ${missing.join('; ')}`,
      formatEvidence(evidence),
      '',
      'Use this sovereign-lane evidence once. Do not request another research pass in this call.',
    ].join('\n'),
  };
}

function formatEvidence(evidence) {
  if (!evidence.length) return '(research returned no matching evidence)';

  return evidence
    .map((item) => {
      const id = optionalString(item.evidenceId) ?? optionalString(item.id) ?? 'unknown';
      const kind = optionalString(item.kind) ?? 'Exposure';
      const payload = {
        id,
        evidenceGrade: optionalString(item.evidenceGrade) ?? 'L1',
        source: optionalString(item.source) ?? 'research',
        content: boundText(optionalString(item.content) ?? recordContent(item.record), EVIDENCE_CONTENT_MAX_CHARS),
      };
      return `<<< ${kind}:${id} >>>\n${JSON.stringify(payload)}`;
    })
    .join('\n\n');
}

function recordContent(record) {
  if (!isPlainObject(record)) return '';
  return optionalString(record.statement) ?? optionalString(record.pattern) ?? '';
}

function normalizeDecisionCard(value) {
  if (!isPlainObject(value)) return null;

  const card = {
    asked: optionalString(value.asked) ?? '',
    read: stringList(value.read),
    assumed: stringList(value.assumed),
    missing: stringList(value.missing),
    pick: optionalString(value.pick) ?? '',
    why: optionalString(value.why) ?? '',
    whatWouldChangeIt: optionalString(value.whatWouldChangeIt) ?? '',
    next: optionalString(value.next) ?? '',
  };

  for (const field of DECISION_CARD_FIELDS) {
    if (!Object.hasOwn(card, field)) return null;
  }
  return Object.freeze(card);
}

function normalizeDissent(value) {
  return Object.freeze({
    contradicts: value?.contradicts === true,
    on: optionalString(value?.on) ?? '',
  });
}

function gradedEvidenceIds(evidence) {
  const seen = new Set();
  const graded = [];

  for (const item of evidence) {
    const ids = Array.isArray(item?.evidenceIds) && item.evidenceIds.length > 0
      ? item.evidenceIds
      : [item?.evidenceId ?? item?.id];
    for (const rawId of ids) {
      const id = optionalString(rawId);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      graded.push(Object.freeze({
        id,
        grade: optionalString(item.evidenceGrade) ?? 'L1',
        source: optionalString(item.source) ?? 'research',
      }));
    }
  }

  return Object.freeze(graded);
}

function stringList(value) {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(
    value.map((item) => optionalString(item)?.trim()).filter(Boolean),
  );
}

function questionWords(value) {
  const matches = String(value ?? '').match(/[a-z0-9]+(?:[-'][a-z0-9]+)?/gi);
  return matches ? matches.length : 0;
}

function complexityMarkers(value) {
  const text = String(value ?? '').toLowerCase();
  const markerMatches = text.match(/[?;:]|\b(?:versus|tradeoff|trade-off|option|scenario|constraint|because|if|unless|while|but|however|therefore)\b/g);
  return markerMatches ? markerMatches.length : 0;
}

function substrateRecordCount(context) {
  let total = 0;
  for (const kind of ['Exposure', 'SelfPattern', 'FootprintSample']) {
    const match = String(context ?? '').match(new RegExp(`${kind}:\\s*(\\d+)`, 'i'));
    if (match) total += Number(match[1]) || 0;
  }
  return total;
}

function requiredText(value, label) {
  const text = optionalString(value)?.trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function positiveInteger(value, fallback) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.floor(number);
}

function boundText(value, maxChars) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1).trim()}...`;
}
