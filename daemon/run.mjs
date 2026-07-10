#!/usr/bin/env node
// cs-k loop runner.
// Runs one station over the local substrate. The daemon owns all persistence
// and path safety; the station model call supplies only structured judgment.

import { promises as fs } from 'node:fs';
import {
  realpathSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { governNextAction } from '../src/next-action.mjs';
import { boardModelCall } from '../src/reason/board.mjs';
import {
  promptTokenEstimate,
  recordModelMetric,
} from '../src/metrics/instrument.mjs';
import {
  REVERSIBILITY_CLASSES,
  createSubstrateStore,
  isPlainObject,
  optionalString,
  requiredString,
} from '../src/substrate.mjs';
import { loadEnvLocal } from '../src/util/load-env.mjs';

export { isPlainObject } from '../src/substrate.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// loop.md names sense -> understand -> decide -> act -> verify -> learn.
// This runner implements sense; decide absorbs understand; a staged
// LoopRecommendation is the act-advisory; compound is learn.
export const STATIONS = Object.freeze(['sense', 'decide', 'verify', 'compound']);
export const RECOMMENDATION_VERDICTS = Object.freeze(['silence', 'recommend']);
const FRONTIER_EXCLUDED_SURFACES = Object.freeze([
  'claude',
  'chatgpt',
  'mind',
  'holon-notes',
  'mind-content',
  'x-bookmarks',
]);

const DEFAULT_DATA_DIR = path.join(ROOT, 'data');
const DEFAULT_MODEL = 'claude-opus-4-8';
const LOOP_SCHEMA_VERSION = 1;
const DEFAULT_CONTEXT_LIMIT = 40;
const SOURCES_FILE = 'sources.json';
const SOURCES_REGISTRY_KIND = 'SourcesRegistry';
const SOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9_.:-]{0,79}$/;
const SOURCE_KINDS = Object.freeze(['chat', 'bookmarks', 'genome', 'file', 'registered']);
const SAFE_OUTPUT_FIELDS = Object.freeze([
  'summary',
  'verdict',
  'recommendation',
  'decisionCard',
  'footprintSamples',
  'verifyNote',
  'selfPattern',
  'selfPatterns',
]);

export const COMMIT_TOOL = Object.freeze({
  name: 'commit_loop_output',
  description:
    'Return one structured station result. The daemon applies any local data mutations. ' +
    'The model must not perform external actions.',
  input_schema: {
    type: 'object',
    additionalProperties: true,
    properties: {
      summary: { type: 'string' },
      verdict: { type: 'string', enum: ['silence', 'recommend'] },
      recommendation: {
        type: 'object',
        additionalProperties: true,
        properties: {
          decision: { type: 'string' },
          recommended: { type: 'string' },
          reason: { type: 'string' },
          risk: {
            type: 'string',
            enum: ['low-stakes', 'consequential'],
          },
          reversibility: {
            type: 'string',
            enum: REVERSIBILITY_CLASSES,
          },
          undo: { type: 'string' },
          evidenceIds: { type: 'array', items: { type: 'string' } },
          confidence: { type: 'number' },
        },
      },
      footprintSamples: { type: 'array', items: { type: 'object', additionalProperties: true } },
      decisionCard: {
        type: 'object',
        additionalProperties: false,
        properties: {
          asked: { type: 'string' },
          read: {
            anyOf: [
              { type: 'array', items: { type: 'string' } },
              { type: 'string' },
            ],
          },
          assumed: {
            anyOf: [
              { type: 'array', items: { type: 'string' } },
              { type: 'string' },
            ],
          },
          missing: {
            anyOf: [
              { type: 'array', items: { type: 'string' } },
              { type: 'string' },
            ],
          },
          pick: { type: 'string' },
          why: { type: 'string' },
          whatWouldChangeIt: { type: 'string' },
          next: { type: 'string' },
        },
        required: [
          'asked',
          'read',
          'assumed',
          'missing',
          'pick',
          'why',
          'whatWouldChangeIt',
          'next',
        ],
      },
      verifyNote: { type: 'object', additionalProperties: true },
      selfPattern: { type: 'object', additionalProperties: true },
      selfPatterns: { type: 'array', items: { type: 'object', additionalProperties: true } },
    },
    required: ['summary', 'verdict'],
  },
});

export async function runStation(station, options = {}) {
  assertStation(station);

  const dataDir = path.resolve(options.dataDir ?? process.env.CS_K_DATA_DIR ?? DEFAULT_DATA_DIR);
  const now = options.now ?? (() => new Date());
  const store =
    options.store ??
    createSubstrateStore({
      dataDir,
      now,
    });
  const quiet = options.quiet ?? true;
  const singleCall = options.modelCall ?? defaultModelCall;

  const stationPrompt = await loadStationPrompt(station);
  const constitution = await readText(path.join(ROOT, 'life-constitution.md'));
  const context = await gatherContext(station, {
    store,
    dataDir,
    limit: options.contextLimit,
    threadId: options.threadId,
    threadExposureIds: options.threadExposureIds,
    threadExposureResolver: options.threadExposureResolver,
    resolveThreadExposureIds: options.resolveThreadExposureIds,
  });
  const request = buildModelRequest({
    station,
    stationPrompt,
    constitution,
    context,
    input: options.input,
    now,
  });
  const stakesSignal = station === 'decide'
    ? decisionStakesSignal({ decisionText: options.input, context })
    : { escalate: false };
  const modelCall = stakesSignal.escalate
    ? (currentRequest) => boardModelCall(currentRequest, { singleCall })
    : singleCall;

  const rawOutput = await modelCall(request);
  const output = normalizeStationOutput(station, rawOutput);
  const mutations = await commitStationOutput(station, output, { store, dataDir, now });
  const result = {
    station,
    label: request.label,
    model: request.model,
    output,
    mutations,
  };

  if (!quiet && output.verdict === 'recommend') {
    writeAdvisory(result);
  }

  return result;
}

export function buildModelRequest({
  station,
  stationPrompt,
  constitution,
  context,
  input,
  now = () => new Date(),
}) {
  const model = stationPrompt.meta.model || DEFAULT_MODEL;
  const day = today(now);
  const runtime = [
    '## Runtime',
    `Today is ${day}.`,
    'Return exactly one commit_loop_output tool call.',
    'The daemon will persist only local data artifacts under data/.',
    'No station may act on the world. The strongest DECIDE verdict is recommend.',
  ].join('\n');
  const system = [constitution.trim(), '---', stationPrompt.body.trim(), '---', runtime].join('\n\n');
  const userParts = [context];

  if (input) {
    userParts.push(`## This run input\n${input}`);
  }

  return {
    label: `cs-k:${station}`,
    station,
    model,
    maxTokens: 4096,
    system,
    user: userParts.join('\n\n'),
    tool: COMMIT_TOOL,
  };
}

export function decisionStakesSignal({ decisionText = '', context = '' } = {}) {
  const contextText = String(context ?? '');
  const explicitDecisionText = String(decisionText ?? '');
  const stagedText = extractContextSection(contextText, '## Open staged recommendations');
  const text = [explicitDecisionText, stagedText].filter(Boolean).join('\n').toLowerCase();
  const substrateSignals = contextText.toLowerCase();
  const reasons = [];
  let score = 0;

  const highImpactMatches = matchAny(text, [
    /\birreversible\b/,
    /\bpermanent\b/,
    /\bdelete\b/,
    /\bdestroy\b/,
    /\bexternal\b/,
    /\baccount\b/,
    /\btrade\b/,
    /\btrading\b/,
    /\bbuy\b/,
    /\bsell\b/,
    /\binvest\b/,
    /\bfinancial\b/,
    /\blegal\b/,
    /\bmedical\b/,
    /\bvisa\b/,
    /\brelationship\b/,
    /\bpublish\b/,
    /\bsend\b/,
    /\bmessage\b/,
  ]);
  if (highImpactMatches.length) {
    score += 2;
    reasons.push(`high-impact terms: ${highImpactMatches.slice(0, 3).join(', ')}`);
  }

  const standingPatternMatches = matchAny(text, [
    /\bstanding\b/,
    /\bcommitment\b/,
    /\bidentity\b/,
    /\bhabit\b/,
    /\bprotocol\b/,
    /\bsleep schedule\b/,
    /\btraining load\b/,
  ]);
  if (standingPatternMatches.length) {
    score += 1;
    reasons.push(`standing-pattern terms: ${standingPatternMatches.slice(0, 3).join(', ')}`);
  }

  const conflictMatches = matchAny(substrateSignals, [
    /\bconflict(?:ing)?\b/,
    /\bcontradict(?:s|ion|ory)?\b/,
    /\bdisconfirm(?:er|ers|ing)?\b/,
    /\bunclear blast radius\b/,
  ]);
  if (conflictMatches.length) {
    score += 1;
    reasons.push(`conflict terms: ${conflictMatches.slice(0, 3).join(', ')}`);
  }

  const exposureCount = contextCount(contextText, 'Exposure');
  const selfPatternCount = contextCount(contextText, 'SelfPattern');
  if (exposureCount + selfPatternCount >= 12 && score > 0) {
    score += 1;
    reasons.push('dense substrate context');
  }

  return Object.freeze({
    escalate: score >= 2,
    score,
    reasons: Object.freeze(reasons),
  });
}

export async function defaultModelCall(request, opts = {}) {
  const startedAt = Date.now();
  let response;
  let result;

  try {
    const client = opts.client ?? await createAnthropicClient();
    response = await client.messages.create({
      model: request.model,
      max_tokens: request.maxTokens,
      system: request.system,
      tools: [request.tool],
      tool_choice: { type: 'tool', name: request.tool.name },
      messages: [{ role: 'user', content: request.user }],
    });

    const toolUse = response.content.find(
      (block) => block.type === 'tool_use' && block.name === request.tool.name,
    );
    if (!toolUse) {
      throw new Error(`model did not return ${request.tool.name}`);
    }

    result = toolUse.input;
    return result;
  } finally {
    recordModelMetric({
      seam: 'defaultModelCall',
      lane: 'frontier',
      model: request?.model,
      ms: Date.now() - startedAt,
      promptTokens: response?.usage?.input_tokens ?? promptTokenEstimate(request),
      completionTokens: response?.usage?.output_tokens,
      result,
    });
  }
}

async function createAnthropicClient() {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  return new Anthropic();
}

export async function gatherContext(station, options) {
  const limit = options.limit ?? DEFAULT_CONTEXT_LIMIT;
  const needsDecisions = station === 'decide' || station === 'verify';
  const needsVerifyNotes = station === 'compound';
  const threadScope = await resolveThreadScope(options);
  const [
    allExposureRecords,
    allSelfPatternRecords,
    allFootprintRecords,
    allDecisions,
    allVerifyNotes,
  ] = await Promise.all([
    options.store.listRecords('Exposure'),
    options.store.listRecords('SelfPattern'),
    options.store.listRecords('FootprintSample'),
    needsDecisions ? recentDataJson(options.dataDir, 'decisions', 12) : [],
    needsVerifyNotes ? recentDataJson(options.dataDir, 'verify', 6) : [],
  ]);
  const threadExposureRecords = filterRecordsForThread(allExposureRecords, threadScope);
  const excludedExposureIds = frontierExcludedRecordIds(threadExposureRecords);
  const exposureRecords = frontierSafeRecords(threadExposureRecords);
  const selfPatternRecords = frontierSafeRecords(
    filterRecordsForThread(allSelfPatternRecords, threadScope),
    { excludedEvidenceIds: excludedExposureIds },
  );
  const footprintRecords = frontierSafeRecords(
    filterRecordsForThread(allFootprintRecords, threadScope),
    { excludedEvidenceIds: excludedExposureIds },
  );
  const decisions = frontierSafeDataFiles(
    filterDataFilesForThread(allDecisions, threadScope),
    { excludedEvidenceIds: excludedExposureIds },
  );
  const verifyNotes = frontierSafeDataFiles(
    filterDataFilesForThread(allVerifyNotes, threadScope),
    { excludedEvidenceIds: excludedExposureIds },
  );
  const exposures = exposureRecords.slice(-limit);
  const selfPatterns = selfPatternRecords.slice(-20);
  const footprints = footprintRecords.slice(-20);

  const sections = [
    '## Substrate counts',
    `Exposure: ${exposureRecords.length}`,
    `SelfPattern: ${selfPatternRecords.length}`,
    `FootprintSample: ${footprintRecords.length}`,
  ];

  if (station === 'sense') {
    sections.push('## Recent exposure', formatRecords(exposures));
  } else if (station === 'decide') {
    sections.push(
      '## Recent exposure',
      formatRecords(exposures),
      '## Derived self',
      formatRecords(selfPatterns),
      '## Open staged recommendations',
      formatDataFiles(decisions.filter((entry) => entry.data.acted === 'pending')),
    );
  } else if (station === 'verify') {
    sections.push(
      '## Staged recommendations',
      formatDataFiles(decisions),
      '## Recent exposure',
      formatRecords(exposures),
      '## Footprint samples',
      formatRecords(footprints),
    );
  } else if (station === 'compound') {
    sections.push(
      '## Derived self',
      formatRecords(selfPatterns),
      '## Verification notes',
      formatDataFiles(verifyNotes),
      '## Footprint samples',
      formatRecords(footprints),
    );
  }

  return sections.join('\n\n');
}

export function frontierSafeRecords(records, options = {}) {
  const excludedEvidenceIds = options.excludedEvidenceIds ?? new Set();
  return (Array.isArray(records) ? records : [])
    .filter((record) =>
      !recordFrontierExcluded(record) &&
      !referencesExcludedEvidence(record, excludedEvidenceIds));
}

async function resolveThreadScope(options) {
  const threadId = optionalString(options.threadId);
  const hasExplicitExposureIds = options.threadExposureIds !== undefined;
  const resolver = options.threadExposureResolver ?? options.resolveThreadExposureIds;

  if (!threadId && !hasExplicitExposureIds) return null;

  const resolvedExposureIds = hasExplicitExposureIds
    ? options.threadExposureIds
    : typeof resolver === 'function'
      ? await resolver(threadId, options)
      : [];
  const exposureIds = normalizeStringArray(resolvedExposureIds ?? [], 'threadExposureIds');

  if (threadId && !hasExplicitExposureIds && exposureIds.length === 0) {
    throw new Error(
      `thread ${threadId} resolved no exposure ids; pass threadExposureIds: [] for an explicitly empty thread`,
    );
  }

  return {
    threadId,
    exposureIds: new Set(exposureIds),
  };
}

function filterRecordsForThread(records, threadScope) {
  if (!threadScope) return records;
  return records.filter((record) => recordBelongsToThread(record, threadScope));
}

function filterDataFilesForThread(entries, threadScope) {
  if (!threadScope) return entries;
  return entries.filter((entry) => dataBelongsToThread(entry.data, threadScope));
}

function recordBelongsToThread(record, threadScope) {
  if (record?.kind === 'Exposure') {
    return threadScope.exposureIds.has(record.id);
  }

  const exposureIds = referencedExposureIds(record);
  return exposureIds.length > 0 && exposureIds.every((id) => threadScope.exposureIds.has(id));
}

function dataBelongsToThread(data, threadScope) {
  if (!isPlainObject(data)) return false;
  if (
    threadScope.threadId &&
    (
      optionalString(data.threadId) === threadScope.threadId ||
      optionalString(data.thread?.threadId) === threadScope.threadId
    )
  ) {
    return true;
  }

  const exposureIds = referencedExposureIds(data);
  return exposureIds.length > 0 && exposureIds.every((id) => threadScope.exposureIds.has(id));
}

function referencedExposureIds(value) {
  const ids = [];

  collectExposureIds(value?.exposureId, ids);
  collectExposureIds(value?.evidence, ids);
  collectExposureIds(value?.evidenceIds, ids);
  collectExposureIds(value?.exposureIds, ids);
  collectExposureIds(value?.engagement?.exposureId, ids);
  collectExposureIds(value?.recommendation?.evidenceIds, ids);
  collectExposureIds(value?.thread?.exposureIds, ids);
  collectExposureIds(value?.metadata?.exposureIds, ids);

  return [...new Set(ids)];
}

function collectExposureIds(value, ids) {
  if (Array.isArray(value)) {
    for (const item of value) collectExposureIds(item, ids);
    return;
  }

  const id = optionalString(value);
  if (id) ids.push(id);
}

export async function commitStationOutput(station, output, options) {
  const normalizedOutput = normalizeStationOutput(station, output);
  refuseAutoAction(normalizedOutput);

  switch (station) {
    case 'decide':
      return commitDecide(normalizedOutput, options);
    case 'sense':
      return commitSense(normalizedOutput, options);
    case 'verify':
      return commitVerify(normalizedOutput, options);
    case 'compound':
      return commitCompound(normalizedOutput, options);
    default:
      assertStation(station);
  }
}

async function commitDecide(output, { dataDir, now, governNextAction: governNextActionImpl, store }) {
  if (output.verdict === 'silence') return [];

  const recommendation = normalizeRecommendation(output.recommendation);
  const decisionCard = output.decisionCard;
  const govern = governNextActionImpl ?? governNextAction;
  const nextAction = govern({
    target: recommendation.recommended,
    risk: recommendation.risk ?? riskForReversibility(recommendation.reversibility),
    reversibilityClass: recommendation.reversibility,
    authority: 'human',
  });
  if (!isPlainObject(nextAction) || nextAction.tag === '[auto]') {
    throw new Error('loop recommendations may not auto-act');
  }
  const frontierExcluded =
    recordFrontierExcluded(recommendation) ||
    await recordIdsFrontierExcluded(recommendation.evidenceIds, store);
  const record = {
    kind: 'LoopRecommendation',
    schemaVersion: LOOP_SCHEMA_VERSION,
    station: 'decide',
    date: today(now),
    verdict: 'recommend',
    acted: 'pending',
    advisoryOnly: true,
    ...recommendation,
    ...(frontierExcluded ? { frontierExcluded: true } : {}),
    ...(decisionCard ? { decisionCard } : {}),
    tag: nextAction.tag,
    summary: output.summary,
    createdAt: iso(now),
  };

  const relPath = await writeUniqueDataJson(dataDir, 'decisions', stamp(now), record);
  return [{ op: 'write', path: path.join('data', relPath), kind: record.kind }];
}

async function commitSense(output, { store }) {
  const samples = Array.isArray(output.footprintSamples) ? output.footprintSamples : [];
  const mutations = [];

  for (const sample of samples) {
    const { record, created } = normalizeWriteResult(
      await store.writeFootprintSample(
        {
          ...sample,
          provenance: {
            surface: 'loop',
            lane: 'deliberate',
            ...(sample.provenance ?? {}),
          },
        },
        { withWriteResult: true },
      ),
    );
    mutations.push({
      op: created ? 'write' : 'deduped',
      path: substratePath(record),
      kind: record.kind,
      id: record.id,
    });
  }

  return mutations;
}

async function commitVerify(output, { dataDir, now }) {
  if (!output.verifyNote) return [];

  const record = {
    kind: 'LoopVerification',
    schemaVersion: LOOP_SCHEMA_VERSION,
    date: today(now),
    summary: output.summary,
    reviews: output.verifyNote?.reviews ?? [],
    note: output.verifyNote?.note,
    createdAt: iso(now),
  };

  const relPath = await writeUniqueDataJson(dataDir, 'verify', today(now), record);
  return [{ op: 'write', path: path.join('data', relPath), kind: record.kind }];
}

async function commitCompound(output, { store, now }) {
  const inputs = [
    ...(output.selfPattern ? [output.selfPattern] : []),
    ...(Array.isArray(output.selfPatterns) ? output.selfPatterns : []),
  ];
  const mutations = [];

  for (const input of inputs) {
    const frontierExcluded =
      recordFrontierExcluded(input) ||
      await recordIdsFrontierExcluded(referencedExposureIds(input), store);
    const { record, created } = normalizeWriteResult(
      await store.processEngagement(
        {
          action: 'learned',
          confidence: 0.4,
          eventAt: iso(now),
          provenance: { surface: 'loop', lane: 'deliberate' },
          ...input,
          ...(frontierExcluded ? { frontierExcluded: true } : {}),
        },
        { withWriteResult: true },
      ),
    );
    mutations.push({
      op: created ? 'write' : 'deduped',
      path: substratePath(record),
      kind: record.kind,
      id: record.id,
    });
  }

  return mutations;
}

function normalizeStationOutput(station, rawOutput) {
  if (!rawOutput || typeof rawOutput !== 'object' || Array.isArray(rawOutput)) {
    throw new Error('station output must be an object');
  }

  refuseAutoAction(rawOutput);

  const output = {
    summary: optionalString(rawOutput.summary) ?? `${station}: silence`,
    verdict: normalizeVerdict(rawOutput.verdict ?? 'silence'),
  };

  for (const field of SAFE_OUTPUT_FIELDS) {
    if (
      field !== 'summary' &&
      field !== 'verdict' &&
      Object.hasOwn(rawOutput, field)
    ) {
      output[field] = field === 'decisionCard'
        ? normalizeDecisionCard(rawOutput[field])
        : rawOutput[field];
    }
  }

  if (station === 'decide' && output.verdict === 'recommend') {
    if (!isPlainObject(rawOutput.recommendation)) {
      throw new Error('decide returned recommend without a recommendation object');
    }
    output.recommendation = normalizeRecommendation(rawOutput.recommendation);
  }

  return output;
}

export function normalizeVerdict(value) {
  const verdict = String(value ?? 'silence').trim();
  if (!verdict) return 'silence';
  if (RECOMMENDATION_VERDICTS.includes(verdict)) return verdict;
  throw new Error(`invalid verdict: ${value}`);
}

function normalizeRecommendation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('recommendation is required for verdict recommend');
  }

  const reversibility = requiredString(value.reversibility, 'recommendation.reversibility');
  if (!REVERSIBILITY_CLASSES.includes(reversibility)) {
    throw new Error(`invalid reversibility: ${reversibility}`);
  }

  return {
    decision: requiredString(value.decision, 'recommendation.decision'),
    recommended: requiredString(value.recommended, 'recommendation.recommended'),
    reason: requiredString(value.reason, 'recommendation.reason'),
    risk: normalizeRisk(value.risk),
    reversibility,
    undo: requiredString(value.undo, 'recommendation.undo'),
    evidenceIds: uniqueStrings(value.evidenceIds ?? value.evidence ?? []),
    confidence: clampConfidence(value.confidence ?? 0),
    ...normalizeRecommendationMetadata(value),
  };
}

function normalizeRecommendationMetadata(value) {
  const metadata = {};

  for (const [target, source] of [
    ['surface', value.surface],
    ['targetSurface', value.targetSurface],
    ['source', value.source],
    ['protocolSurface', value.protocolSurface],
    ['protocolKind', value.protocolKind],
    ['recommendationKind', value.recommendationKind],
    ['category', value.category],
    ['target', value.target],
    ['action', value.action],
    ['object', value.object],
    ['basis', value.basis],
    ['clusterId', value.clusterId],
    ['themeId', value.themeId],
    ['theme', value.theme],
  ]) {
    const text = optionalString(source);
    if (text) metadata[target] = text;
  }

  for (const [target, source] of [
    ['atomIds', value.atomIds],
    ['sourceAtomIds', value.sourceAtomIds],
    ['conversationIds', value.conversationIds],
  ]) {
    if (Array.isArray(source)) {
      metadata[target] = normalizeStringArray(source, `recommendation.${target}`);
    }
  }

  if (value.sensitive === true) metadata.sensitive = true;
  if (value.frontierExcluded === true) metadata.frontierExcluded = true;

  if (isPlainObject(value.provenance)) {
    const provenance = {};
    for (const [target, source] of [
      ['surface', value.provenance.surface],
      ['lane', value.provenance.lane],
    ]) {
      const text = optionalString(source);
      if (text) provenance[target] = text;
    }
    if (Object.keys(provenance).length > 0) metadata.provenance = provenance;
  }

  if (Array.isArray(value.advisors)) {
    metadata.advisors = normalizeStringArray(value.advisors, 'recommendation.advisors');
  }

  if (isPlainObject(value.protocol)) {
    const protocol = {};
    for (const [target, source] of [
      ['kind', value.protocol.kind],
      ['target', value.protocol.target],
      ['action', value.protocol.action],
      ['object', value.protocol.object],
      ['basis', value.protocol.basis],
      ['category', value.protocol.category],
      ['surface', value.protocol.surface],
      ['source', value.protocol.source],
      ['title', value.protocol.title],
      ['summary', value.protocol.summary],
      ['recommended', value.protocol.recommended],
      ['reason', value.protocol.reason],
      ['risk', value.protocol.risk],
      ['tag', value.protocol.tag],
    ]) {
      const text = optionalString(source);
      if (target === 'tag' && text === '[auto]') {
        throw new Error('recommendation protocol metadata may not request [auto]');
      }
      if (text) protocol[target] = text;
    }
    if (value.protocol.confidence !== undefined) {
      protocol.confidence = clampConfidence(value.protocol.confidence);
    }
    if (Object.keys(protocol).length > 0) metadata.protocol = protocol;
  }

  if (isPlainObject(value.context)) {
    const context = {};
    for (const [target, source] of [
      ['signal', value.context.signal],
      ['genomicTraitCount', value.context.genomicTraitCount],
      ['recentFootprintCount', value.context.recentFootprintCount],
    ]) {
      const text = optionalString(source);
      if (text) context[target] = text;
    }
    if (Object.keys(context).length > 0) metadata.context = context;
  }

  return metadata;
}

function normalizeDecisionCard(value) {
  if (!isPlainObject(value)) {
    throw new Error('decisionCard must be an object');
  }

  return {
    asked: requiredString(value.asked, 'decisionCard.asked'),
    read: normalizeDecisionCardDetail(value.read, 'decisionCard.read'),
    assumed: normalizeDecisionCardDetail(value.assumed, 'decisionCard.assumed'),
    missing: normalizeDecisionCardDetail(value.missing, 'decisionCard.missing'),
    pick: requiredString(value.pick, 'decisionCard.pick'),
    why: requiredString(value.why, 'decisionCard.why'),
    whatWouldChangeIt: requiredString(value.whatWouldChangeIt, 'decisionCard.whatWouldChangeIt'),
    next: requiredString(value.next, 'decisionCard.next'),
  };
}

function normalizeDecisionCardDetail(value, field) {
  if (Array.isArray(value)) return normalizeStringArray(value, field);
  return requiredString(value, field);
}

export function refuseAutoAction(output) {
  const forbidden = ['autoAct', 'externalAction', 'act', 'acted'];
  for (const key of forbidden) {
    if (Object.hasOwn(output, key) && output[key]) {
      throw new Error(`refused auto-action field: ${key}`);
    }
  }
}

async function loadStationPrompt(station) {
  const source = await readText(path.join(ROOT, 'stations', `${station}.md`));
  return parseFrontmatter(source);
}

export function parseFrontmatter(md) {
  const match = md.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: md };

  const meta = {};
  for (const line of match[1].split('\n')) {
    const keyValue = line.match(/^([\w-]+):\s*(.*)$/);
    if (keyValue) {
      meta[keyValue[1]] = keyValue[2].trim();
    }
  }

  return { meta, body: match[2].trim() };
}

async function recentDataJson(dataDir, dirname, limit) {
  const dir = safeDataPath(dataDir, dirname);
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort()
    .slice(-limit);

  return Promise.all(
    files.map(async (name) => ({
      path: path.join(dirname, name),
      data: JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')),
    })),
  );
}

function formatRecords(records) {
  if (!records.length) return '(none)';
  return records.map((record) => `<<< ${record.kind}:${record.id} >>>\n${JSON.stringify(record)}`).join('\n\n');
}

function formatDataFiles(entries) {
  const visibleEntries = frontierSafeDataFiles(entries);
  if (!visibleEntries.length) return '(none)';
  return visibleEntries.map((entry) => `<<< data/${entry.path} >>>\n${JSON.stringify(entry.data)}`).join('\n\n');
}

function frontierSafeDataFiles(entries, options = {}) {
  const excludedEvidenceIds = options.excludedEvidenceIds ?? new Set();
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => !dataFileFrontierExcluded(entry.data, { excludedEvidenceIds }));
}

function dataFileFrontierExcluded(data, options = {}) {
  if (!isPlainObject(data)) return false;
  const markers = surfaceMarkers(data);
  if (data.frontierExcluded === true) return true;
  if (markers.some(frontierExcludedSurface)) return true;
  if (referencesExcludedEvidence(data, options.excludedEvidenceIds ?? new Set())) return true;
  if (data.sensitive === true && markers.includes('body-protocol')) return true;
  if (markers.includes('genome')) return true;
  if (markers.includes('body-protocol')) return true;
  if (optionalString(data.source) === 'body/protocol') return true;
  if (optionalString(data.recommendationKind) === 'body-protocol') return true;
  if (optionalString(data.protocolKind)?.includes('body-protocol')) return true;
  return false;
}

function surfaceMarkers(data) {
  return [
    data.provenance?.surface,
    data.surface,
    data.targetSurface,
    data.protocol?.surface,
    data.metadata?.surface,
  ].map(normalizeSurface).filter(Boolean);
}

function recordFrontierExcluded(record) {
  return isPlainObject(record) && (
    record.frontierExcluded === true ||
    surfaceMarkers(record).some(frontierExcludedSurface)
  );
}

export function frontierExcludedRecordIds(records) {
  return new Set(
    (Array.isArray(records) ? records : [])
      .filter(recordFrontierExcluded)
      .map((record) => optionalString(record.id))
      .filter(Boolean),
  );
}

function referencesExcludedEvidence(value, excludedEvidenceIds) {
  if (!(excludedEvidenceIds instanceof Set) || excludedEvidenceIds.size === 0) return false;
  return referencedExposureIds(value).some((id) => excludedEvidenceIds.has(id));
}

async function recordIdsFrontierExcluded(ids, store) {
  if (!store || typeof store.readRecord !== 'function') return false;

  for (const id of ids) {
    const recordId = optionalString(id);
    if (!recordId) continue;
    const record = await store.readRecord(recordId);
    if (recordFrontierExcluded(record)) return true;
  }
  return false;
}

function frontierExcludedSurface(value) {
  const surface = normalizeSurface(value);
  return surface ? FRONTIER_EXCLUDED_SURFACES.includes(surface) : false;
}

function normalizeSurface(value) {
  return optionalString(value)?.trim().toLowerCase();
}

export async function writeUniqueDataJson(dataDir, dirname, baseName, value) {
  for (let index = 0; index < 1000; index += 1) {
    const suffix = index === 0 ? '' : `-${index + 1}`;
    const relPath = path.join(dirname, `${baseName}${suffix}.json`);
    const file = safeDataPath(dataDir, relPath);
    await fs.mkdir(path.dirname(file), { recursive: true });

    try {
      await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      });
      return relPath;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }

  throw new Error(`could not allocate unique data path: ${dirname}/${baseName}.json`);
}

export function safeDataPath(dataDir, relPath) {
  const root = path.resolve(dataDir);
  const rel = String(relPath ?? '');
  if (
    !rel ||
    path.isAbsolute(rel) ||
    path.win32.isAbsolute(rel) ||
    rel.split(/[\\/]+/).includes('..')
  ) {
    throw new Error(`refused unsafe data path: ${relPath}`);
  }

  const resolved = path.resolve(root, rel);
  assertPathUnderRoot(resolved, root, relPath);

  const rootReal = realpathIfExists(root);
  if (!rootReal) return resolved;

  const existingAncestor = nearestExistingAncestor(resolved);
  const existingAncestorReal = realpathSync(existingAncestor);
  assertPathUnderRoot(existingAncestorReal, rootReal, relPath);

  const dereferenced = path.resolve(
    existingAncestorReal,
    path.relative(existingAncestor, resolved),
  );
  assertPathUnderRoot(dereferenced, rootReal, relPath);

  return resolved;
}

export async function registerSourceEntries({ dataDir = DEFAULT_DATA_DIR, now = () => new Date(), sources }) {
  if (!Array.isArray(sources)) throw new Error('sources must be an array');

  const file = safeDataPath(dataDir, SOURCES_FILE);
  const registry = await readSourceRegistryFile(file);
  const nextSources = { ...registry.sources };

  for (const source of sources) {
    const id = normalizeSourceRegistryId(source?.id);
    if (!id) throw new Error(`invalid source id: ${source?.id}`);

    const previous = nextSources[id];
    nextSources[id] = {
      label: requiredString(source.label, 'source.label'),
      kind: normalizeSourceRegistryKind(source.kind) ?? 'registered',
      active: typeof previous?.active === 'boolean' ? previous.active : true,
    };
  }

  const normalizedSources = {};
  for (const id of Object.keys(nextSources).sort()) {
    const source = normalizeSourceRegistryEntry(id, nextSources[id]);
    if (source) normalizedSources[source.id] = {
      ...(source.label ? { label: source.label } : {}),
      ...(source.kind ? { kind: source.kind } : {}),
      active: source.active,
    };
  }

  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    `${JSON.stringify({
      kind: SOURCES_REGISTRY_KIND,
      schemaVersion: 1,
      updatedAt: iso(now),
      sources: normalizedSources,
    }, null, 2)}\n`,
    'utf8',
  );

  return {
    kind: SOURCES_REGISTRY_KIND,
    schemaVersion: 1,
    sources: normalizedSources,
  };
}

function realpathIfExists(file) {
  try {
    return realpathSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function nearestExistingAncestor(file) {
  let current = file;

  while (true) {
    try {
      statSync(current);
      return current;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

function assertPathUnderRoot(candidate, root, relPath) {
  const relative = path.relative(root, candidate);
  if (relative && (relative.startsWith('..') || path.isAbsolute(relative))) {
    throw new Error(`refused unsafe data path: ${relPath}`);
  }
}

export async function readText(file) {
  return fs.readFile(file, 'utf8');
}

async function readSourceRegistryFile(file) {
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return emptySourceRegistry();
  }

  if (!isPlainObject(parsed)) return emptySourceRegistry();

  const sources = {};
  const rawSources = parsed.sources;
  const entries = Array.isArray(rawSources)
    ? rawSources.filter(isPlainObject).map((source) => [source.id, source])
    : isPlainObject(rawSources)
      ? Object.entries(rawSources)
      : [];

  for (const [id, source] of entries) {
    const normalized = normalizeSourceRegistryEntry(id, source);
    if (normalized) sources[normalized.id] = normalized;
  }

  return {
    kind: SOURCES_REGISTRY_KIND,
    schemaVersion: 1,
    sources,
  };
}

function emptySourceRegistry() {
  return {
    kind: SOURCES_REGISTRY_KIND,
    schemaVersion: 1,
    sources: {},
  };
}

function normalizeSourceRegistryEntry(rawId, rawSource) {
  const id = normalizeSourceRegistryId(rawId);
  if (!id) return null;

  const source = typeof rawSource === 'boolean'
    ? { active: rawSource }
    : rawSource;
  if (!isPlainObject(source)) return null;

  const label = optionalString(source.label);
  const kind = normalizeSourceRegistryKind(source.kind);
  const active = typeof source.active === 'boolean' ? source.active : true;

  return {
    id,
    ...(label ? { label } : {}),
    ...(kind ? { kind } : {}),
    active,
  };
}

function normalizeSourceRegistryId(value) {
  const id = optionalString(value)?.toLowerCase();
  return id && SOURCE_ID_PATTERN.test(id) ? id : undefined;
}

function normalizeSourceRegistryKind(value) {
  const kind = optionalString(value)?.toLowerCase();
  return kind && SOURCE_KINDS.includes(kind) ? kind : undefined;
}

function substratePath(record) {
  const dir = {
    Exposure: 'exposures',
    SelfPattern: 'self-patterns',
    LearningRecord: 'learning-records',
    FootprintSample: 'footprint-samples',
    VitalRecord: 'vital-records',
  }[record.kind];
  return path.join('data', 'substrate', dir, `${record.id}.json`);
}

function normalizeWriteResult(value) {
  if (
    value &&
    typeof value === 'object' &&
    value.record &&
    typeof value.created === 'boolean'
  ) {
    return value;
  }

  return { record: value, created: true };
}

function assertStation(station) {
  if (!STATIONS.includes(station)) {
    throw new Error(`unknown station: ${station}`);
  }
}

function riskForReversibility(reversibility) {
  return reversibility === 'internal-revertible' ? 'low-stakes' : 'consequential';
}

export function normalizeRisk(value) {
  const text = optionalString(value);
  if (!text) return undefined;
  const normalized = text.toLowerCase().replace(/_/g, '-');
  if (normalized === 'low' || normalized === 'low-stakes') return 'low-stakes';
  if (normalized === 'consequential') return 'consequential';
  throw new Error(`invalid recommendation.risk: ${value}`);
}

function writeAdvisory(result) {
  const recommendation = result.output.recommendation;
  console.log(`${recommendation.recommended}\n${recommendation.reason}`);
  for (const mutation of result.mutations) {
    console.log(`staged: ${mutation.path}`);
  }
}

export function today(now) {
  return iso(now).slice(0, 10);
}

export function stamp(now) {
  return iso(now).replace(/[:.]/g, '-').slice(0, 19);
}

export function iso(now) {
  const value = typeof now === 'function' ? now() : now;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function uniqueStrings(values) {
  if (!Array.isArray(values)) throw new Error('evidenceIds must be an array');
  return [...new Set(values.map((value) => requiredString(value, 'evidenceIds item')))];
}

function normalizeStringArray(values, field) {
  if (!Array.isArray(values)) throw new Error(`${field} must be an array`);
  return [...new Set(values.map((value) => requiredString(value, `${field} item`)))];
}

export function clampConfidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(1, Math.max(0, number));
}

function matchAny(text, patterns) {
  const matches = [];
  for (const pattern of patterns) {
    if (pattern.test(text)) {
      matches.push(pattern.source.replace(/\\b/g, '').replace(/[()?:\\]/g, ''));
    }
  }
  return matches;
}

function contextCount(context, label) {
  const match = String(context ?? '').match(new RegExp(`^${label}:\\s*(\\d+)`, 'm'));
  return match ? Number(match[1]) : 0;
}

function extractContextSection(context, heading) {
  const source = String(context ?? '');
  const start = source.indexOf(heading);
  if (start === -1) return '';

  const rest = source.slice(start + heading.length);
  const nextHeading = rest.search(/\n## /);
  return (nextHeading === -1 ? rest : rest.slice(0, nextHeading)).trim();
}

async function ingestWithStagedPaths({ store, ingest }) {
  const knownIds = new Set(
    (await store.listRecords('Exposure')).map((record) => record.id),
  );
  const result = await ingest();
  const staged = [];

  for (const exposure of result.exposures ?? []) {
    if (!exposure?.id || knownIds.has(exposure.id)) continue;
    knownIds.add(exposure.id);
    staged.push(substratePath(exposure));
  }

  return { result, staged };
}

async function main(argv) {
  await loadEnvLocal(ROOT);

  const verb = argv[2];
  const ingestDataDir = path.resolve(process.env.CS_K_DATA_DIR ?? DEFAULT_DATA_DIR);

  if (verb === 'strategize') {
    const goal = argv.slice(3).join(' ').trim();
    if (!goal) {
      console.error('usage: node daemon/run.mjs strategize <goal text>');
      process.exitCode = 1;
      return;
    }

    try {
      const { strategize } = await import('../src/strategy/strategize.mjs');
      const result = await strategize(goal);
      console.log(`strategy: ${result.mutations[0].path}`);
      for (const mutation of result.mutations.slice(1)) {
        console.log(`staged: ${mutation.path}`);
      }
    } catch (error) {
      console.error(`[cs-k] error: ${error.message}`);
      process.exitCode = 1;
    }
    return;
  }

  if (verb === 'threads') {
    try {
      const { orchestrate } = await import('../src/threads/orchestrator.mjs');
      const result = await orchestrate({ quiet: false });
      console.log(`threads: ${result.threadCount}`);
      for (const mutation of result.mutations) {
        console.log(`staged: ${mutation.path}`);
      }
    } catch (error) {
      console.error(`[cs-k] error: ${error.message}`);
      process.exitCode = 1;
    }
    return;
  }

  if (verb === 'serve') {
    try {
      const { startServer } = await import('./server.mjs');
      const server = await startServer();
      const address = server.address();
      const host = typeof address === 'object' && address ? address.address : '127.0.0.1';
      const port = typeof address === 'object' && address ? address.port : 3003;
      console.log(`serving on http://${host}:${port}`);
      await new Promise(() => {});
    } catch (error) {
      console.error(`[cs-k] error: ${error.message}`);
      process.exitCode = 1;
    }
    return;
  }

  if (verb === 'think') {
    try {
      const { think } = await import('../src/mind/think.mjs');
      const result = await think();
      console.log(`think: ${result.atomCount} atoms`);
      // Surface every semantic output group, not just candidates. A zero here
      // (e.g. themes/resurfaced silently dropped because the clustering sidecar
      // timed out) is otherwise invisible; printing the four counts makes the
      // synthesis outcome legible on the wire without inspecting the daemon.
      console.log(`think: ${result.candidateCount} build/decide candidates`);
      console.log(`think: ${result.themesOpenLoopsCount} themes+open-loops`);
      console.log(`think: ${result.resurfacedIdeaCount} resurfaced ideas`);
      console.log(`think: ${result.divergentIdeaCount} new (divergent) ideas`);
      // Clustering notes carry the "sidecar unavailable / timed out" signal that
      // silences semantic outputs — echo them so a fallback is not mistaken for
      // an empty mind.
      for (const note of result.notes) {
        if (/cluster|sidecar|silenced/i.test(note)) {
          console.log(`note: ${note}`);
        }
      }
      for (const mutation of result.mutations) {
        console.log(`staged: ${mutation.path}`);
      }
    } catch (error) {
      console.error(`[cs-k] error: ${error.message}`);
      process.exitCode = 1;
    }
    return;
  }

  if (verb === 'relabel-mind-outputs') {
    try {
      const { relabelMindOutputs } = await import('../src/mind/think.mjs');
      const { relabelDecisionRecords } = await import('../src/mind/naming.mjs');
      const { boundLabel } = await import('../src/mind/think.mjs');
      const result = await relabelMindOutputs();
      const decisions = await relabelDecisionRecords({ fallbackLabel: boundLabel });
      console.log(`relabel-mind-outputs: ${result.updatedCount} records, decisions: ${decisions.updatedCount}`);
      for (const mutation of result.mutations) {
        console.log(`staged: ${mutation.path}`);
      }
    } catch (error) {
      console.error(`[cs-k] error: ${error.message}`);
      process.exitCode = 1;
    }
    return;
  }

  if (verb === 'body-loop') {
    try {
      const { bodyLoop } = await import('../src/reason/health.mjs');
      const result = await bodyLoop();
      if (result.baselines?.hrv) {
        console.log(
          `body-loop: HRV drift ${result.baselines.hrv.drift}ms ` +
            `(${result.baselines.hrv.driftDirection})`,
        );
      }
      if (result.baselines?.sleep) {
        console.log(
          `body-loop: sleep trend ${result.baselines.sleep.trendDeltaHours}h ` +
            `(${result.baselines.sleep.trendDirection})`,
        );
      }
      console.log(`body-loop: ${result.protocolCount} protocols`);
      console.log(`body-loop: ${result.stagedCount} staged protocols`);
      if (result.refusedCount) {
        console.log(`body-loop: ${result.refusedCount} refused protocols`);
      }
      for (const mutation of result.mutations) {
        console.log(`staged: ${mutation.path}`);
      }
    } catch (error) {
      console.error(`[cs-k] error: ${error.message}`);
      process.exitCode = 1;
    }
    return;
  }

  if (verb === 'dream') {
    try {
      const { dream } = await import('../src/mind/dream.mjs');
      const result = await dream();
      console.log(`dream: ${result.atomCount} atoms`);
      console.log(`dream: ${result.attractorCount} attractors`);
      console.log(`dream: ${result.remLinkCount} rem links`);
      console.log(`dream: ${result.emittedCount} edge cards`);
      console.log(`staged: data/${result.runPath}`);
      for (const mutation of result.mutations) {
        if (mutation.path !== path.join('data', result.runPath)) {
          console.log(`staged: ${mutation.path}`);
        }
      }
    } catch (error) {
      console.error(`[cs-k] error: ${error.message}`);
      process.exitCode = 1;
    }
    return;
  }

  if (verb === 'ingest-notes') {
    try {
      const { NOTES_SURFACE, ingestNotes } = await import('../src/ingest/notes.mjs');
      const store = createSubstrateStore({ dataDir: ingestDataDir });
      await registerSourceEntries({
        dataDir: ingestDataDir,
        sources: [
          {
            id: NOTES_SURFACE,
            label: 'Holon notes',
            kind: 'file',
          },
        ],
      });
      const { result, staged } = await ingestWithStagedPaths({
        store,
        ingest: () => ingestNotes({ store, dir: argv[3] }),
      });

      if (result.skipped) {
        console.log(result.message);
      } else {
        console.log(`ingest-notes: ${result.createdCount} exposures`);
        for (const stagedPath of staged) console.log(`staged: ${stagedPath}`);
      }
    } catch (error) {
      console.error(`[cs-k] error: ${error.message}`);
      process.exitCode = 1;
    }
    return;
  }

  if (verb === 'ingest-bookmarks-x') {
    try {
      const { X_BOOKMARKS_SURFACE, ingestXBookmarks } = await import('../src/ingest/x-bookmarks.mjs');
      const store = createSubstrateStore({ dataDir: ingestDataDir });
      await registerSourceEntries({
        dataDir: ingestDataDir,
        sources: [
          {
            id: X_BOOKMARKS_SURFACE,
            label: 'X bookmarks',
            kind: 'bookmarks',
          },
        ],
      });
      const { result, staged } = await ingestWithStagedPaths({
        store,
        ingest: () => ingestXBookmarks({ store, file: argv[3] }),
      });

      if (result.skipped) {
        console.log(result.message);
      } else {
        console.log(`ingest-bookmarks-x: ${result.createdCount} exposures`);
        for (const stagedPath of staged) console.log(`staged: ${stagedPath}`);
      }
    } catch (error) {
      console.error(`[cs-k] error: ${error.message}`);
      process.exitCode = 1;
    }
    return;
  }

  if (verb === 'ingest-mind-content') {
    try {
      const { MIND_CONTENT_SURFACE, ingestMindContent } = await import('../src/ingest/mind-content.mjs');
      const store = createSubstrateStore({ dataDir: ingestDataDir });
      await registerSourceEntries({
        dataDir: ingestDataDir,
        sources: [
          {
            id: MIND_CONTENT_SURFACE,
            label: 'Mind content',
            kind: 'file',
          },
        ],
      });
      const { result, staged } = await ingestWithStagedPaths({
        store,
        ingest: () => ingestMindContent({ store }),
      });

      if (result.skipped) {
        console.log(result.message);
      } else {
        console.log(`ingest-mind-content: ${result.createdCount} exposures`);
        console.log(`ingest-mind-content: ${result.duplicateCount} duplicate`);
        console.log(`ingest-mind-content: ${result.excludedCount} excluded by R4.3`);
        if (result.failedCount) console.log(`ingest-mind-content: ${result.failedCount} failed soft`);
        for (const stagedPath of staged) console.log(`staged: ${stagedPath}`);
      }
    } catch (error) {
      console.error(`[cs-k] error: ${error.message}`);
      process.exitCode = 1;
    }
    return;
  }

  if (verb === 'ingest-chatbot') {
    try {
      const { ingestChatbot } = await import('../src/ingest/chatbot.mjs');
      const result = await ingestChatbot();
      const bothSkipped = result.skipped.claude && result.skipped.chatgpt;
      if (bothSkipped) {
        console.log('chatbot: no exports found — drop your Claude/ChatGPT export (conversations.json) in data/ingest/ and re-run');
      } else {
        for (const r of result.results) {
          console.log(`chatbot ${r.surface}: ingested ${r.createdCount} new, ${r.duplicateCount} duplicate`);
        }
        if (result.skipped.claude) console.log('chatbot claude: skipped (no export in data/ingest/)');
        if (result.skipped.chatgpt) console.log('chatbot chatgpt: skipped (no export in data/ingest/)');
        console.log(`chatbot: ${result.createdCount} new exposures total`);
      }
    } catch (error) {
      console.error(`[cs-k] error: ${error.message}`);
      process.exitCode = 1;
    }
    return;
  }

  if (verb === 'ingest-dna') {
    try {
      const { ingestDna } = await import('../src/ingest/dna.mjs');
      const result = await ingestDna();
      if (result.skipped) {
        console.log(result.message);
      } else {
        console.log(`dna: ingested ${result.createdCount} new, ${result.duplicateCount} duplicate`);
        console.log(`dna: ${result.storedCount} allowlisted SNPs stored`);
        console.log(`dna: skipped ${result.nonAllowlistedLineCount} non-allowlisted, ${result.malformedLineCount} malformed, ${result.noCallLineCount} no-call`);
      }
    } catch (error) {
      console.error(`[cs-k] error: ${error.message}`);
      process.exitCode = 1;
    }
    return;
  }

  if (verb === 'ingest-hermes') {
    try {
      const { ingestHermes } = await import('../src/ingest/hermes-ingest.mjs');
      const result = await ingestHermes();
      console.log(`hermes: ${result.repo}@${result.ref}`);
      console.log(
        `hermes: staged ${result.createdCount} new, ` +
          `${result.supersededCount} superseded, ${result.duplicateCount} duplicate, ` +
          `${result.quarantinedCount} quarantined`,
      );
      console.log(`hermes: ${result.noteCreatedCount} capability notes`);
      if (result.flagged.length > 0) {
        console.log(`hermes: ${result.flagged.length} skills flagged for review (tool-threat)`);
      }
      for (const entry of result.staged) {
        if (entry.outcome === 'created' || entry.outcome === 'superseded') {
          console.log(`staged: staged-skills/skills/${entry.record.skillId}.json`);
        }
      }
    } catch (error) {
      console.error(`[cs-k] error: ${error.message}`);
      process.exitCode = 1;
    }
    return;
  }

  const station = verb;
  if (!STATIONS.includes(station)) {
    console.error(`usage: node daemon/run.mjs <${STATIONS.join('|')}|strategize|threads|serve|think|relabel-mind-outputs|body-loop|dream|ingest-notes|ingest-mind-content|ingest-bookmarks-x|ingest-chatbot|ingest-dna|ingest-hermes> [input]`);
    process.exitCode = 1;
    return;
  }

  try {
    await runStation(station, {
      input: argv.slice(3).join(' '),
      quiet: false,
    });
  } catch (error) {
    console.error(`[cs-k] error: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv).catch((error) => {
    console.error(`[cs-k] error: ${error.message}`);
    process.exitCode = 1;
  });
}
