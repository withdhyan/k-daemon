import path from 'node:path';

import {
  ROOT,
  clampConfidence,
  commitStationOutput,
  isPlainObject,
  refuseAutoAction,
} from '../../daemon/run.mjs';
import { mean, round } from '../math.mjs';
import { localOllamaModelCall } from '../mind/think.mjs';
import { governNextAction } from '../next-action.mjs';
import {
  createSubstrateStore,
  makeLogNote,
  optionalString,
  stripUndefined,
} from '../substrate.mjs';
import { ADVISORS } from './advisors.mjs';

const DEFAULT_DATA_DIR = path.join(ROOT, 'data');
const DEFAULT_RECENT_SIGNAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_BASELINE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const BASELINE_WINDOW_DAYS = 30;
const LOW_Z_SCORE_THRESHOLD = -1;
const MAX_CONTEXT_SNPS = 12;
const MAX_RECENT_FOOTPRINTS = 12;
const MAX_NUTRITION_FOOTPRINTS = 5;
const MIN_PROTOCOL_CONFIDENCE = 0.55;
export const MAX_PROTOCOLS_PER_LOOP = 10;

const PROTOCOL_TARGETS = Object.freeze([
  'sleep',
  'recovery',
  'training',
  'nutrition',
  'supplement',
  'stress',
  'hydration',
]);

const PROTOCOL_ACTIONS = Object.freeze([
  'increase',
  'decrease',
  'maintain',
  'shift_earlier',
  'shift_later',
  'add',
  'remove',
  'reduce_load',
  'increase_load',
  'prioritize',
  'deprioritize',
]);

const INTERVENTION_VOCAB_VALUES = Object.freeze([
  'magnesium',
  'vitamin_d',
  'omega_3',
  'creatine',
  'caffeine',
  'l_theanine',
  'protein',
  'carbohydrate',
  'fiber',
  'sleep_duration',
  'wind_down_time',
  'bedtime_consistency',
  'training_volume',
  'training_intensity',
  'zone2_cardio',
  'deload',
  'sauna',
  'cold_exposure',
  'sunlight_morning',
  'screen_curfew',
  'meal_timing',
  'hydration',
  'electrolytes',
  'breathwork',
  'mobility',
  'rest_day',
  'alcohol',
]);

export const INTERVENTION_VOCAB = Object.freeze(new Set(INTERVENTION_VOCAB_VALUES));

const PROTOCOL_BASES = Object.freeze([
  'hrv_trend',
  'rhr_trend',
  'sleep_trend',
  'recovery_trend',
  'strain_trend',
  'genotype_nutrition',
  'genotype_recovery',
  'genotype_sleep',
  'genotype_caffeine',
  'genotype_metabolism',
  'nutrition_pattern',
]);

const HEALTH_SYSTEM_PROMPT = [
  'You are K body COLD loop. You reason over minimum-necessary genome, biomarker, and nutrition context.',
  'The output is advisory only. Do not diagnose, predict disease, treat disease, cure disease, or prescribe medication.',
  'Use SNPs only as rsid/genotype trait context. Check genotype context against recent biomarkers before suggesting anything.',
  'Silence is correct when confidence is low or the signal is stale.',
].join('\n');

const BODY_OUTPUT_PROMPT = [
  'Return strict JSON:',
  '{"analysis":"","confidence":0,"protocolConsiderations":[]}',
  'Keep analysis concise and advisory. Do not output a protocol or medical claim yet.',
].join('\n');

const PROTOCOL_OUTPUT_PROMPT = [
  'Return strict JSON:',
  '{"protocols":[{"target":"recovery","action":"prioritize","object":"sleep_duration","basis":"hrv_trend","confidence":0.7}]}',
  `target enum: ${PROTOCOL_TARGETS.join(', ')}.`,
  `action enum: ${PROTOCOL_ACTIONS.join(', ')}.`,
  `object vocabulary: ${INTERVENTION_VOCAB_VALUES.join(', ')}.`,
  `basis enum: ${PROTOCOL_BASES.join(', ')}.`,
  'Do not return suggestion, rationale, reason, diagnosis, disease, medication, dose, rsid, genotype, or causal prose fields.',
  'The daemon accepts only target/action/object/basis/confidence and drops every off-schema field.',
  'Optional note is discouraged; if used, it must be under 120 chars, advisory only, and contain no medical, disease, or drug terms.',
].join('\n');

const BODY_SIGNAL_SOURCE =
  String.raw`(?:hrv|heart rate variability|sleep|resting heart rate|biomarker|marker|reading|readings|snp|rs\d+|genotype|genomic|dna|allele)`;
const DIAGNOSTIC_LINK =
  String.raw`(?:indicates?|means|shows?|proves?|confirms?|reveals?|demonstrates?|points?\s+to|diagnos(?:e|es|is|tic))`;
const MEDICAL_OR_STATUS_TARGET =
  String.raw`(?:you\s+have|you\s+are|will\s+develop|likely\s+to\s+develop|at\s+risk\s+of|risk\s+for|condition|disease|disorder|syndrome|illness|infection|deficien\w*|diabetes|hypertension|cancer|depression|anxiety|apnea|hypothyroid)`;

const CAUSAL_DISEASE_PATTERNS = Object.freeze([
  new RegExp(`${BODY_SIGNAL_SOURCE}.{0,100}${DIAGNOSTIC_LINK}.{0,120}${MEDICAL_OR_STATUS_TARGET}`, 'i'),
  new RegExp(`${DIAGNOSTIC_LINK}.{0,120}${MEDICAL_OR_STATUS_TARGET}.{0,100}${BODY_SIGNAL_SOURCE}`, 'i'),
  /\b(?:you|your)\s+(?:have|will develop|are at risk of|are likely to develop)\b.{0,100}\b(?:condition|disease|disorder|syndrome|illness|infection|deficien\w*|diabetes|hypertension|cancer|depression|anxiety|apnea|hypothyroid)\b/i,
  /\b(?:should|must|need to|have to)\s+(?:treat|cure|medicate)\b/i,
  /\b(?:treat|cure)\s+(?:your|the|this|that)?\s*.{0,80}\b(?:condition|disease|disorder|syndrome|illness|infection|deficien\w*|diabetes|hypertension|cancer|depression|anxiety|apnea|hypothyroid)\b/i,
  /\b(?:diagnosis|diagnose|diagnostic|treatment|treating|treated|treat|cure|curing|medication|prescribe|prescription)\b/i,
]);

const WORD_AVOIDING_DIAGNOSTIC = Object.freeze(new RegExp(
  `${BODY_SIGNAL_SOURCE}.{0,100}${DIAGNOSTIC_LINK}.{0,100}(?:you\\s+have|you\\s+are|will\\s+develop)`,
  'i',
));

const MEDICAL_DISEASE_DRUG_TERMS = /\b(?:metformin|levothyroxine|semaglutide|insulin|statin|ssri|snri|benzodiazepine|stimulant|antibiotic|ibuprofen|aspirin|diabetes|hypertension|cancer|depression|anxiety|apnea|hypothyroid|hyperthyroid|disease|disorder|syndrome|illness|infection|deficien\w*|diagnos\w*|treat\w*|prescrib\w*|medicat\w*)\b/i;

const logNote = makeLogNote('body-loop');

export async function bodyLoop(opts = {}) {
  const dataDir = path.resolve(opts.dataDir ?? process.env.CS_K_DATA_DIR ?? DEFAULT_DATA_DIR);
  const now = opts.now ?? (() => new Date());
  const store =
    opts.store ??
    createSubstrateStore({
      dataDir,
      now,
    });
  const logger = opts.logger ?? console;
  const notes = [];

  const [genomicTraits, footprintSamples] = await Promise.all([
    store.listRecords('GenomicTrait'),
    listBodySamples(store),
  ]);
  const context = buildHealthContext({
    genomicTraits,
    footprintSamples,
    now,
    recentSignalWindowMs: opts.recentSignalWindowMs,
  });

  if (!context.signal.actionable) {
    logNote(notes, logger, `body loop silenced: ${context.signal.reason}`);
    return bodyLoopResult({
      context,
      protocolCount: 0,
      stagedProtocols: [],
      refusedProtocols: [],
      mutations: [],
      notes,
    });
  }

  const modelCall =
    opts.modelCall ??
    ((request) => localOllamaModelCall(request, {
      fetchImpl: opts.fetchImpl,
      timeoutMs: opts.timeoutMs,
    }));

  let rawProtocols;
  try {
    rawProtocols = await reasonBodyProtocols(context, {
      modelCall,
      model: opts.model,
    });
  } catch (error) {
    logNote(notes, logger, `local model unavailable; body loop silenced (${error.message})`);
    return bodyLoopResult({
      context,
      protocolCount: 0,
      stagedProtocols: [],
      refusedProtocols: [],
      mutations: [],
      notes,
    });
  }

  const normalizedCandidates = normalizeProtocolCandidates(rawProtocols);
  const candidates = normalizedCandidates.candidates;
  if (normalizedCandidates.droppedCount > 0) {
    logNote(
      notes,
      logger,
      `body protocol cap dropped ${normalizedCandidates.droppedCount} of ${normalizedCandidates.totalCount} candidates`,
    );
  }
  const stagedProtocols = [];
  const refusedProtocols = [];
  const mutations = [];

  for (const candidate of candidates) {
    const governed = normalizeGovernedProtocol(candidate, {
      context,
      minConfidence: opts.minProtocolConfidence,
    });

    if (governed.refused) {
      refusedProtocols.push(governed);
      logNote(notes, logger, `body protocol refused: ${governed.reason}`);
      continue;
    }

    const output = decideOutputForProtocol(governed.protocol, context);
    refuseAutoAction(output);
    if (governed.protocol.nextAction.tag === '[auto]') {
      throw new Error('body protocols may not auto-act');
    }
    const staged = await commitStationOutput('decide', output, { dataDir, now });
    stagedProtocols.push(governed.protocol);
    mutations.push(...staged);
  }

  if (stagedProtocols.length === 0) {
    logNote(notes, logger, 'body loop silenced: no governed protocol survived filtering');
  }

  return bodyLoopResult({
    context,
    protocolCount: normalizedCandidates.totalCount,
    stagedProtocols,
    refusedProtocols,
    mutations,
    notes,
  });
}

// Best-effort backstop for optional notes only. The primary safety guarantee is
// the closed enum/vocabulary protocol schema, which makes diagnosis unexpressible
// in staged recommendation text.
export function detectCausalDiseaseClaim(value) {
  const text = protocolClaimText(value);
  if (!text) return Object.freeze({ claim: false, reasons: Object.freeze([]) });

  const reasons = [];
  for (const pattern of CAUSAL_DISEASE_PATTERNS) {
    if (pattern.test(text)) {
      reasons.push('causal-disease-or-treatment-claim');
      break;
    }
  }

  if (WORD_AVOIDING_DIAGNOSTIC.test(text)) {
    reasons.push('diagnostic-in-effect');
  }

  return Object.freeze({
    claim: reasons.length > 0,
    reasons: Object.freeze([...new Set(reasons)]),
  });
}

export function buildHealthContext({
  genomicTraits = [],
  footprintSamples = [],
  now = () => new Date(),
  recentSignalWindowMs = DEFAULT_RECENT_SIGNAL_WINDOW_MS,
  baselineWindowMs = DEFAULT_BASELINE_WINDOW_MS,
} = {}) {
  const current = dateFromNow(now);
  const liveGenomicTraits = liveRecords(genomicTraits);
  const liveFootprints = liveRecords(footprintSamples);
  const recentFootprints = liveFootprints
    .filter((record) => isRecent(record, current, recentSignalWindowMs))
    .sort((a, b) => b.eventAt.localeCompare(a.eventAt))
    .slice(0, MAX_RECENT_FOOTPRINTS);
  const projectedFootprints = recentFootprints.map(projectFootprint).filter(hasUsefulFootprintData);
  const baselineFootprints = liveFootprints
    .filter((record) => isRecent(record, current, baselineWindowMs))
    .sort((a, b) => b.eventAt.localeCompare(a.eventAt));
  const projectedBaselineFootprints = baselineFootprints
    .map(projectFootprint)
    .filter(hasUsefulFootprintData);
  const nutrition = projectedFootprints
    .filter(isNutritionFootprint)
    .slice(0, MAX_NUTRITION_FOOTPRINTS);
  const biomarkers = biomarkerBaselines(projectedBaselineFootprints);
  const signal = healthSignal({
    liveFootprints,
    recentFootprints,
    projectedFootprints,
    biomarkers,
    nutrition,
  });

  return Object.freeze({
    generatedAt: current.toISOString(),
    signal,
    snps: Object.freeze(liveGenomicTraits.slice(0, MAX_CONTEXT_SNPS).map(projectGenomicTrait)),
    biomarkers,
    nutrition: Object.freeze(nutrition),
    evidenceIds: Object.freeze(uniqueStrings([
      ...projectedFootprints.map((record) => record.id),
      ...projectedBaselineFootprints.map((record) => record.id),
      ...liveGenomicTraits.slice(0, MAX_CONTEXT_SNPS).map((record) => record.id),
    ])),
    counts: Object.freeze({
      genomicTraits: liveGenomicTraits.length,
      footprintSamples: liveFootprints.length,
      recentFootprints: recentFootprints.length,
      usableFootprints: projectedFootprints.length,
      baselineFootprints: baselineFootprints.length,
      usableBaselineFootprints: projectedBaselineFootprints.length,
      nutritionFootprints: nutrition.length,
    }),
  });
}

async function reasonBodyProtocols(context, { modelCall, model }) {
  const bodyAdvisor = advisorNamed('body');
  const protocolAdvisor = advisorNamed('protocol');
  const payload = contextPayload(context);

  const body = await modelCall({
    label: 'cs-k:body-loop:body',
    task: 'health.body',
    model,
    responseFormat: 'json',
    route: 'local-ollama',
    sensitivity: 'genome-biomarker-crown-jewel',
    system: [
      HEALTH_SYSTEM_PROMPT,
      bodyAdvisor.promptAddendum,
      BODY_OUTPUT_PROMPT,
    ].join('\n\n'),
    user: JSON.stringify({ context: payload }),
  });
  const bodyAnalysis = isPlainObject(body) ? body : {};

  const protocol = await modelCall({
    label: 'cs-k:body-loop:protocol',
    task: 'health.protocol',
    model,
    responseFormat: 'json',
    route: 'local-ollama',
    sensitivity: 'genome-biomarker-crown-jewel',
    system: [
      HEALTH_SYSTEM_PROMPT,
      protocolAdvisor.promptAddendum,
      PROTOCOL_OUTPUT_PROMPT,
    ].join('\n\n'),
    user: JSON.stringify({
      context: payload,
      bodyAnalysis: {
        analysis: optionalString(bodyAnalysis.analysis),
        confidence: clampConfidence(bodyAnalysis.confidence ?? 0),
        protocolConsiderations: Array.isArray(bodyAnalysis.protocolConsiderations)
          ? bodyAnalysis.protocolConsiderations.slice(0, 6)
          : [],
      },
    }),
  });

  return isPlainObject(protocol) ? protocol : {};
}

function normalizeProtocolCandidates(rawProtocols) {
  const allCandidates = [];
  if (Array.isArray(rawProtocols?.protocols)) {
    allCandidates.push(...rawProtocols.protocols.filter(isPlainObject));
  } else if (isPlainObject(rawProtocols?.protocol)) {
    allCandidates.push(rawProtocols.protocol);
  }

  const candidates = allCandidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((left, right) =>
      clampConfidence(right.candidate.confidence) - clampConfidence(left.candidate.confidence) ||
      left.index - right.index)
    .slice(0, MAX_PROTOCOLS_PER_LOOP)
    .map((entry) => entry.candidate);

  return Object.freeze({
    candidates: Object.freeze(candidates),
    droppedCount: Math.max(0, allCandidates.length - candidates.length),
    totalCount: allCandidates.length,
  });
}

function normalizeGovernedProtocol(candidate, { context, minConfidence }) {
  const modelConfidence = clampConfidence(candidate.confidence);
  const target = enumToken(candidate.target, PROTOCOL_TARGETS);
  if (!target) return refusedProtocol('invalid-protocol-target', candidate, modelConfidence);

  const action = enumToken(candidate.action, PROTOCOL_ACTIONS);
  if (!action) return refusedProtocol('invalid-protocol-action', candidate, modelConfidence);

  const object = interventionToken(candidate.object);
  if (!object) return refusedProtocol('invalid-protocol-object', candidate, modelConfidence);

  const basis = enumToken(candidate.basis, PROTOCOL_BASES);
  if (!basis) return refusedProtocol('invalid-protocol-basis', candidate, modelConfidence);

  const confidence = effectiveProtocolConfidence({
    modelConfidence,
    basis,
    context,
  });
  if (confidence.evidenceCount < 1) {
    return refusedProtocol(`insufficient-evidence:${basis}`, candidate, confidence.value);
  }
  if (confidence.value < (minConfidence ?? MIN_PROTOCOL_CONFIDENCE)) {
    return refusedProtocol(confidence.reason ?? 'low-confidence', candidate, confidence.value);
  }

  // Apply the note backstop, then omit the note from staged output in this slice.
  normalizeProtocolNote(candidate.note);

  const category = target;
  const risk = riskForProtocol({ target, action });
  const reversibility = reversibilityForProtocol({ target, action });
  const recommended = protocolText({ target, action, object, basis, confidence: confidence.value });
  const nextAction = governNextAction({
    target: recommended,
    risk,
    reversibilityClass: reversibility,
    authority: 'human',
  });

  if (!isPlainObject(nextAction) || nextAction.tag === '[auto]') {
    throw new Error('body protocols may not auto-act');
  }

  return Object.freeze({
    refused: false,
    protocol: Object.freeze({
      target,
      action,
      object,
      basis,
      category,
      recommended,
      confidence: confidence.value,
      risk,
      reversibility,
      undo: defaultUndo({ target, action, object }),
      summary: protocolText({ target, action, object, basis, confidence: confidence.value }),
      nextAction,
      evidenceIds: Object.freeze(frontierSafeEvidenceIds(context)),
      source: 'body/protocol',
      surface: 'body-protocol',
      evidenceCount: confidence.evidenceCount,
      modelConfidence,
    }),
  });
}

function decideOutputForProtocol(protocol, context) {
  return {
    summary: `Body protocol (${protocol.category}): ${protocol.summary}`,
    verdict: 'recommend',
    recommendation: {
      decision: `Whether to adopt the ${protocol.category} body protocol suggested by the cold loop.`,
      recommended: protocol.recommended,
      reason: `Structured body protocol basis: ${protocol.basis}; confidence: ${protocol.confidence}.`,
      risk: protocol.risk,
      reversibility: protocol.reversibility,
      undo: protocol.undo,
      evidenceIds: protocol.evidenceIds,
      confidence: protocol.confidence,
      surface: 'body',
      targetSurface: 'body',
      source: protocol.source,
      protocolSurface: 'protocol',
      protocolKind: `${protocol.category}-protocol`,
      recommendationKind: 'body-protocol',
      category: protocol.category,
      advisors: ['body', 'protocol'],
      sensitive: true,
      frontierExcluded: true,
      provenance: {
        surface: 'body-protocol',
        lane: 'deliberate',
      },
      target: protocol.target,
      action: protocol.action,
      object: protocol.object,
      basis: protocol.basis,
      protocol: stripUndefined({
        target: protocol.target,
        action: protocol.action,
        object: protocol.object,
        basis: protocol.basis,
        category: protocol.category,
        confidence: protocol.confidence,
        surface: 'body-protocol',
        source: 'protocol',
        tag: protocol.nextAction.tag,
      }),
      context: stripUndefined({
        signal: context.signal.status,
        genomicTraitCount: String(context.counts.genomicTraits),
        recentFootprintCount: String(context.counts.recentFootprints),
      }),
    },
  };
}

function bodyLoopResult({
  context,
  protocolCount,
  stagedProtocols,
  refusedProtocols,
  mutations,
  notes,
}) {
  return Object.freeze({
    kind: 'HealthColdLoopResult',
    schemaVersion: 1,
    signalStatus: context.signal.status,
    signalReason: context.signal.reason,
    baselines: context.biomarkers,
    genomicTraitCount: context.counts.genomicTraits,
    footprintCount: context.counts.footprintSamples,
    recentFootprintCount: context.counts.recentFootprints,
    protocolCount,
    stagedCount: stagedProtocols.length,
    refusedCount: refusedProtocols.length,
    protocols: Object.freeze(stagedProtocols),
    refusedProtocols: Object.freeze(refusedProtocols),
    mutations: Object.freeze(mutations),
    notes: Object.freeze(notes),
  });
}

function biomarkerBaselines(footprints) {
  const hrvValues = footprints.map((record) => numberValue(record.physiology?.hrv)).filter(isFiniteNumber);
  const sleepHours = footprints
    .map((record) => sleepHoursFromMeasurements(record.measurements))
    .filter(isFiniteNumber);
  const latestHrv = hrvValues[0];
  const latestSleepHours = sleepHours[0];

  return Object.freeze(stripUndefined({
    hrv: hrvValues.length > 0
      ? hrvBaselineSummary(hrvValues, latestHrv)
      : undefined,
    sleep: sleepHours.length > 0
      ? sleepBaselineSummary(sleepHours, latestSleepHours)
      : undefined,
  }));
}

function hrvBaselineSummary(values, latest) {
  const recentMean = round(mean(values), 1);
  const drift = round(latest - recentMean, 1);
  const zScore = zScoreSummary({
    values,
    latest,
    precision: 1,
    baselineMeanKey: 'baselineMean',
    standardDeviationKey: 'standardDeviation',
  });
  return {
    latest,
    recentMean,
    drift,
    driftDirection: directionForDelta(drift),
    count: values.length,
    ...zScore,
    low: isLowZScore(zScore.zScore),
  };
}

function sleepBaselineSummary(values, latestHours) {
  const recentMeanHours = round(mean(values), 1);
  const trendDeltaHours = round(latestHours - recentMeanHours, 2);
  const zScore = zScoreSummary({
    values,
    latest: latestHours,
    precision: 2,
    baselineMeanKey: 'baselineMeanHours',
    standardDeviationKey: 'standardDeviationHours',
  });
  return {
    latestHours,
    recentMeanHours,
    trendDeltaHours,
    trendDirection: directionForDelta(trendDeltaHours),
    count: values.length,
    ...zScore,
    low: isLowZScore(zScore.zScore),
  };
}

function zScoreSummary({
  values,
  latest,
  precision,
  baselineMeanKey,
  standardDeviationKey,
}) {
  const baselineMean = mean(values);
  const base = {
    [baselineMeanKey]: round(baselineMean, precision),
    baselineWindowDays: BASELINE_WINDOW_DAYS,
    zScoreSamples: values.length,
  };
  if (values.length < 2) {
    return {
      ...base,
      zScoreUnavailableReason: 'too-few-samples',
    };
  }

  const standardDeviation = populationStandardDeviation(values, baselineMean);
  if (standardDeviation === 0) {
    return {
      ...base,
      [standardDeviationKey]: 0,
      zScoreUnavailableReason: 'zero-variance',
    };
  }

  const zScore = round((latest - baselineMean) / standardDeviation, 2);
  return {
    ...base,
    [standardDeviationKey]: round(standardDeviation, precision),
    zScore,
    zScoreDirection: directionForDelta(zScore),
  };
}

function populationStandardDeviation(values, baselineMean = mean(values)) {
  const variance = mean(values.map((value) => (value - baselineMean) ** 2));
  return Math.sqrt(variance);
}

function isLowZScore(value) {
  return Number.isFinite(value) && value <= LOW_Z_SCORE_THRESHOLD;
}

function directionForDelta(delta) {
  if (delta > 0) return 'up';
  if (delta < 0) return 'down';
  return 'flat';
}

function healthSignal({
  liveFootprints,
  recentFootprints,
  projectedFootprints,
  biomarkers,
  nutrition,
}) {
  if (liveFootprints.length === 0) {
    return signal('empty', 'no FootprintSample records');
  }

  if (recentFootprints.length === 0) {
    return signal('stale', 'no recent FootprintSample records');
  }

  if (projectedFootprints.length === 0) {
    return signal('low-quality', 'recent FootprintSample records have no usable biomarker or nutrition signal');
  }

  const reasons = [];
  if (biomarkers.hrv?.low) reasons.push('low-hrv');
  if (biomarkers.sleep?.low) reasons.push('low-sleep');
  if (nutrition.length > 0) reasons.push('nutrition-context');

  if (reasons.length === 0) {
    return signal('low-quality', 'recent signal is not actionable enough for a cold-loop protocol');
  }

  return Object.freeze({
    actionable: true,
    status: 'actionable',
    reason: reasons.join(','),
  });
}

function signal(status, reason) {
  return Object.freeze({
    actionable: false,
    status,
    reason,
  });
}

function projectGenomicTrait(record) {
  return Object.freeze(stripUndefined({
    id: optionalString(record.id),
    rsid: optionalString(record.rsid),
    genotype: optionalString(record.genotype),
    trait: optionalString(record.trait),
    category: optionalString(record.category),
  }));
}

function projectFootprint(record) {
  return Object.freeze(stripUndefined({
    id: optionalString(record.id),
    eventAt: optionalString(record.eventAt),
    surface: optionalString(record.context?.surface ?? record.provenance?.surface),
    report: optionalString(record.phenomenology?.report),
    physiology: stripUndefined({
      hrv: numberValue(record.physiology?.hrv),
      alpha: numberValue(record.physiology?.alpha),
      complexity: numberValue(record.physiology?.complexity),
      oneOverF: numberValue(record.physiology?.oneOverF ?? record.physiology?.['1/f']),
    }),
    ratings: record.phenomenology?.ratings,
    category: optionalString(record.outcome?.category),
    measurements: isPlainObject(record.outcome?.measurements)
      ? stripUndefined(record.outcome.measurements)
      : undefined,
  }));
}

function hasUsefulFootprintData(record) {
  return Boolean(
    Object.keys(record.physiology ?? {}).length > 0 ||
      isNutritionFootprint(record) ||
      numberValue(record.measurements?.sleepHours) !== undefined ||
      numberValue(record.measurements?.sleep_hours) !== undefined ||
      numberValue(record.measurements?.sleepDurationHours) !== undefined ||
      numberValue(record.measurements?.sleep_duration_hours) !== undefined ||
      sleepHoursFromMeasurements(record.measurements) !== undefined,
  );
}


// WHOOP (and future wearable) history lands as VitalRecords; the body stack's
// canonical read shape is the FootprintSample. Merge both at read so baselines,
// z-scores, and summaries see the full record without a data migration.
const BODY_SAMPLES_CACHE_TTL_MS = 30_000;
let bodySamplesCache = { at: 0, key: null, promise: null };

export async function listBodySamples(store) {
  // The wearable history is thousands of small JSON files; body endpoints are
  // polled by clients. Uncached, concurrent polls starve the fs threadpool and
  // wedge the daemon (seen live 2026-07-10). One in-flight read, 30s reuse.
  const key = store;
  const nowMs = Date.now();
  if (bodySamplesCache.promise && bodySamplesCache.key === key &&
      nowMs - bodySamplesCache.at < BODY_SAMPLES_CACHE_TTL_MS) {
    return bodySamplesCache.promise;
  }
  const promise = (async () => {
    const [footprints, vitals] = await Promise.all([
      store.listRecords('FootprintSample'),
      store.listRecords('VitalRecord').catch(() => []),
    ]);
    return [...footprints, ...vitals.map(vitalAsBodySample)];
  })();
  bodySamplesCache = { at: nowMs, key, promise };
  promise.catch(() => { bodySamplesCache = { at: 0, key: null, promise: null }; });
  return promise;
}

function vitalAsBodySample(record) {
  const hrv = numberValue(record?.measurements?.hrvMs ?? record?.measurements?.hrv ?? record?.physiology?.hrv);
  if (hrv === undefined) return record;
  return { ...record, physiology: { ...(record.physiology ?? {}), hrv } };
}

function sleepHoursFromMeasurements(measurements) {
  const hours = numberValue(
    measurements?.sleepHours ??
      measurements?.sleep_hours ??
      measurements?.sleepDurationHours ??
      measurements?.sleep_duration_hours,
  );
  if (hours !== undefined) return hours;

  const minutes = numberValue(
    measurements?.sleepDuration ??
      measurements?.sleep_duration ??
      measurements?.sleepDurationMinutes ??
      measurements?.sleep_duration_minutes ??
      measurements?.durationMinutes ??
      measurements?.duration_minutes,
  );
  if (minutes !== undefined) return round(minutes / 60, 2);

  const seconds = numberValue(
    measurements?.sleepDurationSeconds ??
      measurements?.sleep_duration_seconds ??
      measurements?.durationSeconds ??
      measurements?.duration_seconds,
  );
  if (seconds !== undefined) return round(seconds / 3600, 2);

  return undefined;
}

function isNutritionFootprint(record) {
  const surface = optionalString(record.surface)?.toLowerCase();
  const category = optionalString(record.category)?.toLowerCase();
  const report = optionalString(record.report)?.toLowerCase();

  return (
    surface === 'nutrition' ||
    category === 'nutrition' ||
    /\b(?:nutrition|meal|caffeine|alcohol|protein|supplement|fasting|carb|glucose)\b/.test(report ?? '')
  );
}

function contextPayload(context) {
  return stripUndefined({
    generatedAt: context.generatedAt,
    signal: context.signal,
    genomic: {
      snps: context.snps,
    },
    biomarkers: context.biomarkers,
    nutrition: context.nutrition,
  });
}

function protocolClaimText(value) {
  const values = Array.isArray(value) ? value : [value];
  return values
    .flatMap((item) => {
      if (typeof item === 'string') return [item];
      if (!isPlainObject(item)) return [];
      return [
        item.suggestion,
        item.recommended,
        item.recommendation,
        item.rationale,
        item.reason,
        item.summary,
        item.title,
        item.note,
      ];
    })
    .map(optionalString)
    .filter(Boolean)
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
}

function enumToken(value, allowed) {
  const token = tokenValue(value);
  return allowed.includes(token) ? token : undefined;
}

function interventionToken(value) {
  const token = tokenValue(value);
  return INTERVENTION_VOCAB.has(token) ? token : undefined;
}

function tokenValue(value) {
  return optionalString(value)
    ?.toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function normalizeProtocolNote(value) {
  const note = optionalString(value);
  if (!note || note.length > 120) return undefined;
  if (detectCausalDiseaseClaim(note).claim) return undefined;
  if (MEDICAL_DISEASE_DRUG_TERMS.test(note)) return undefined;
  return note;
}

function protocolText({ target, action, object, basis, confidence }) {
  return `${action} ${object} for ${target} (basis: ${basis}, confidence: ${confidence})`;
}

function riskForProtocol({ target, action }) {
  if (target === 'supplement' && (action === 'add' || action === 'remove')) return 'consequential';
  if (target === 'training' && action === 'increase_load') return 'consequential';
  return 'low-stakes';
}

function reversibilityForProtocol({ target, action }) {
  if (target === 'supplement' && (action === 'add' || action === 'remove')) return 'external-cancelable';
  if (target === 'training' && action === 'increase_load') return 'external-cancelable';
  return 'internal-revertible';
}

function defaultUndo({ target, action, object }) {
  if (target === 'supplement' && action === 'add') return `Do not add ${object}; leave the current routine unchanged.`;
  if (target === 'supplement' && action === 'remove') return `Do not remove ${object}; leave the current routine unchanged.`;
  if (target === 'training') return `Return ${object} to the prior training plan.`;
  return `Leave ${object} unchanged.`;
}

// Model confidence is self-reported and untrusted. The evidence cap is a
// conservative runtime guard: it cannot prove causality, but it prevents a thin
// context or fabricated 999 confidence from crossing the staging threshold.
function effectiveProtocolConfidence({ modelConfidence, basis, context }) {
  const evidence = basisEvidence({ basis, context });
  if (evidence.count < 1) {
    return Object.freeze({
      value: 0,
      evidenceCount: 0,
      reason: `insufficient-evidence:${basis}`,
    });
  }

  const thinCap = evidence.thin ? Math.min(MIN_PROTOCOL_CONFIDENCE - 0.01, 0.5) : 1;
  const capped = Math.min(modelConfidence, thinCap);
  return Object.freeze({
    value: round(capped, 2),
    evidenceCount: evidence.count,
    reason: capped < modelConfidence ? `low-confidence:evidence-cap:${basis}` : undefined,
  });
}

function basisEvidence({ basis, context }) {
  switch (basis) {
    case 'hrv_trend':
      return evidenceCount(context.biomarkers.hrv?.count ?? 0, 2);
    case 'sleep_trend':
      return evidenceCount(context.biomarkers.sleep?.count ?? 0, 2);
    case 'nutrition_pattern':
      return evidenceCount(context.counts.nutritionFootprints ?? 0, 2);
    case 'recovery_trend':
      return evidenceCount(
        (context.biomarkers.hrv?.count ?? 0) + (context.biomarkers.sleep?.count ?? 0),
        2,
      );
    case 'rhr_trend':
    case 'strain_trend':
      return evidenceCount(context.counts.usableFootprints ?? 0, 2);
    case 'genotype_nutrition':
      return genotypeEvidence(context, 'nutrition');
    case 'genotype_recovery':
      return genotypeEvidence(context, 'recovery');
    case 'genotype_sleep':
      return genotypeEvidence(context, 'sleep');
    case 'genotype_caffeine':
      return genotypeEvidence(context, 'caffeine');
    case 'genotype_metabolism':
      return genotypeEvidence(context, 'metabolism');
    default:
      return evidenceCount(0, 1);
  }
}

function genotypeEvidence(context, category) {
  const snpCount = context.snps.filter((snp) =>
    optionalString(snp.category)?.toLowerCase() === category ||
    optionalString(snp.trait)?.toLowerCase().includes(category)).length;
  const footprintCount = context.counts.usableFootprints ?? 0;
  const count = Math.min(snpCount, footprintCount);
  return evidenceCount(count, 1, footprintCount < 2);
}

function evidenceCount(count, thinThreshold, forceThin = false) {
  return Object.freeze({
    count,
    thin: forceThin || count < thinThreshold,
  });
}

function frontierSafeEvidenceIds(context) {
  return context.evidenceIds.filter((id) => !String(id).startsWith('gene_'));
}

function uniqueStrings(values) {
  return [...new Set(values.map(optionalString).filter(Boolean))];
}

function refusedProtocol(reason, candidate, confidence) {
  return Object.freeze({
    refused: true,
    reason,
    confidence,
    candidateTarget: optionalString(candidate?.target),
    candidateAction: optionalString(candidate?.action),
    candidateObject: optionalString(candidate?.object),
    candidateBasis: optionalString(candidate?.basis),
  });
}

function advisorNamed(name) {
  const advisor = ADVISORS.find((candidate) => candidate.name === name);
  if (!advisor) throw new Error(`missing Board advisor: ${name}`);
  return advisor;
}

function liveRecords(records) {
  return records.filter((record) => !record.validTo && !record.supersededById);
}

function isRecent(record, current, recentSignalWindowMs) {
  const eventAt = Date.parse(record.eventAt);
  if (!Number.isFinite(eventAt)) return false;
  const age = current.getTime() - eventAt;
  return age >= 0 && age <= (recentSignalWindowMs ?? DEFAULT_RECENT_SIGNAL_WINDOW_MS);
}

function dateFromNow(now) {
  const value = typeof now === 'function' ? now() : now;
  return value instanceof Date ? value : new Date(value);
}

function numberValue(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function isFiniteNumber(value) {
  return Number.isFinite(value);
}
